import path from "node:path"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import express from "express"
import { config } from "./lib/config.js"
import { ensureCollection, qdrant } from "./lib/qdrant.js"
import { prewarmBM25Index } from "./lib/bm25-index.js"
import { deleteRelationshipGraphForScope, readRelationshipGraph } from "./lib/graph.js"
import {
  saveVersion,
  listVersions,
  getVersion,
  rollbackVersion,
} from "./lib/decision-versions.js"
import {
  createKnowledgeNote,
  deleteKnowledgeNote,
  readKnowledgeNotes,
  updateKnowledgeNote,
  type KnowledgeNoteInput,
} from "./lib/knowledge-notes.js"
import {
  createAnswerFeedback,
  deleteAnswerFeedback,
  readAnswerFeedback,
  type AnswerFeedbackInput,
} from "./lib/answer-feedback.js"
import {
  listDrafts,
  readDraft,
  saveDraft,
  approveDraft,
  discardDraft,
  approvedDirectory,
  parseDraftFrontmatter,
  extractDecisionTitle,
  reindexApprovedDecision,
  type DraftSummary,
} from "./lib/draft-manager.js"
import fs from "node:fs/promises"
import {
  affectedReposForRegistryEntry,
  deleteServiceRegistryEntry,
  findServiceRegistryEntry,
  readServiceRegistryFile,
  repoPathConfigsForEntry,
  upsertServiceRegistryEntry,
  writeServiceRegistryFile,
  type ServiceRegistryInput,
} from "./lib/service-registry.js"
import type { ServiceType } from "./lib/chunker.js"

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, "..")
const publicDir = path.join(rootDir, "public")

const app = express()
app.use(express.json())
app.use(express.static(publicDir))

// --- Rate limiting (simple in-memory, no external package) ---
// 60 requests per minute per IP on all /api/* routes
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
app.use("/api/", (request, response, next) => {
  const ip = request.ip ?? "unknown"
  const now = Date.now()
  const window = 60_000
  const max = 60
  let entry = rateLimitMap.get(ip)
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + window }
    rateLimitMap.set(ip, entry)
  }
  entry.count++
  if (entry.count > max) {
    response.status(429).json({ error: "Too many requests — please slow down." })
    return
  }
  next()
})

// --- API key authentication ---
// Set APP_API_KEY in .env to enable. Leave unset to allow all (dev mode).
const APP_API_KEY = process.env.APP_API_KEY?.trim()
if (APP_API_KEY) {
  app.use("/api/", (request, response, next) => {
    const authHeader = request.headers["authorization"] ?? ""
    const provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader
    if (provided !== APP_API_KEY) {
      response.status(401).json({ error: "Unauthorized — provide a valid APP_API_KEY in Authorization header." })
      return
    }
    next()
  })
  console.log("🔒 API key authentication enabled.")
} else {
  console.log("⚠️  No APP_API_KEY set — running in open mode (dev/internal only).")
}

type HistoryMessage = {
  role: "user" | "assistant"
  content: string
}

type AskBody = {
  question: string
  limit?: number
  deep?: boolean
  chatModel?: string
  repoName?: string
  project?: string
  branch?: string
  serviceType?: string
  history?: HistoryMessage[]
}

type AskResult = {
  answer: string
  sources: string[]
  raw: string
}

type IndexPointPayload = {
  repoName?: string
  projectIds?: string[]
  projectTagSources?: string[]
  serviceType?: ServiceType
  branchName?: string
  commitSha?: string
  docLocale?: string
  filePath?: string
  evidenceTypes?: string[]
  contentHash?: string
}

type IndexSummaryItem = {
  projectIds: string[]
  repoName: string
  branchName: string
  serviceType: string
  docLocale: string
  commitSha: string
  chunkCount: number
  unassignedChunkCount: number
  ambiguousChunkCount: number
  documentationCount: number
  vocabularyCount: number
  relationshipEdgeCount: number
  graphProjectEdgeCount: number
  graphUnassignedEdgeCount: number
  graphAmbiguousEdgeCount: number
  evidenceTypes: Record<string, number>
}

type IndexRepoBody = {
  repoPath: string
  project?: string
  repoName?: string
  serviceType?: string
  include?: string[]
  exclude?: string[]
  maxChunks?: number
  replaceRepo?: boolean
  indexCommits?: boolean
  indexComments?: boolean
}

type IndexDocsBody = {
  docsPath: string
  project?: string
  repoName?: string
  serviceType?: string
  branch?: string
  locale?: string
  replaceRepo?: boolean
}

type DeleteIndexBody = {
  repoName: string
  branchName?: string
}

type EvalBody = {
  suite?: "baseline" | "edge"
}

type RegistryReindexBody = {
  maxChunks?: number
  indexComments?: boolean
  indexCommits?: boolean
}

type CreateDraftBody = {
  fileName: string
  content: string
}

type UpdateDraftBody = {
  content: string
}

type DecisionFilter = {
  type?: "adr" | "implicit_rule"
  affectedService?: string
  affectedTable?: string
  decisionMaker?: string
  dateFrom?: string
  dateTo?: string
  search?: string
  fullText?: string
}

function parseAskOutput(stdout: string): AskResult {
  const answerMatch = stdout.match(/\nANSWER\n\n([\s\S]*?)(?:\nSOURCES\n|$)/)
  const sourcesMatch = stdout.match(/\nSOURCES\n\n([\s\S]*)/)

  const answer = answerMatch?.[1]?.trim() ?? stdout.trim()
  const sourcesText = sourcesMatch?.[1]?.trim() ?? ""
  const sources = sourcesText
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.startsWith("- "))
    .map(line => line.slice(2).trim())

  return { answer, sources, raw: stdout }
}

function indexScopeFilter(repoName: string, branchName?: string) {
  const must: Array<{ key: string; match: { value: string } }> = [
    {
      key: "repoName",
      match: {
        value: repoName,
      },
    },
  ]

  if (branchName) {
    must.push({
      key: "branchName",
      match: {
        value: branchName,
      },
    })
  }

  return { must }
}

async function summarizeIndex(): Promise<IndexSummaryItem[]> {
  await ensureCollection()

  const byScope = new Map<string, IndexSummaryItem>()
  let offset: string | number | Record<string, unknown> | null | undefined

  do {
    const page = await qdrant.scroll(config.collectionName, {
      limit: 256,
      with_payload: true,
      with_vector: false,
      ...(offset ? { offset } : {}),
    })

    for (const point of page.points) {
      const payload = point.payload as IndexPointPayload | null | undefined
      const repoName = payload?.repoName ?? "unknown"
      const projectIds = payload?.projectIds?.length ? payload.projectIds : []
      const branchName = payload?.branchName ?? "unknown"
      const serviceType = payload?.serviceType ?? "unknown"
      const docLocale = payload?.docLocale ?? "default"
      const key = `${repoName}\u0000${branchName}\u0000${serviceType}\u0000${docLocale}`
      const item = byScope.get(key) ?? {
        projectIds,
        repoName,
        branchName,
        serviceType,
        docLocale,
        commitSha: payload?.commitSha ?? "unknown",
        chunkCount: 0,
        unassignedChunkCount: 0,
        ambiguousChunkCount: 0,
        documentationCount: 0,
        vocabularyCount: 0,
        relationshipEdgeCount: 0,
        graphProjectEdgeCount: 0,
        graphUnassignedEdgeCount: 0,
        graphAmbiguousEdgeCount: 0,
        evidenceTypes: {},
      }

      item.chunkCount++
      item.projectIds = [...new Set([...item.projectIds, ...projectIds])].sort()
      if (projectIds.length === 0) item.unassignedChunkCount++
      if ((payload?.projectTagSources ?? []).some(source => source.startsWith("repo:ambiguous:"))) item.ambiguousChunkCount++
      if (payload?.commitSha && payload.commitSha !== "docs") {
        item.commitSha = payload.commitSha
      } else if (item.commitSha === "unknown" && payload?.commitSha) {
        item.commitSha = payload.commitSha
      }

      if (payload?.evidenceTypes?.includes("documentation")) item.documentationCount++
      if (payload?.filePath?.startsWith("vocabulary://")) item.vocabularyCount++

      for (const evidenceType of payload?.evidenceTypes ?? ["unknown"]) {
        item.evidenceTypes[evidenceType] = (item.evidenceTypes[evidenceType] ?? 0) + 1
      }

      byScope.set(key, item)
    }

    offset = page.next_page_offset
  } while (offset)

  const graph = await readRelationshipGraph()
  const graphCounts = new Map<string, {
    total: number
    projectTagged: number
    unassigned: number
    ambiguous: number
  }>()

  for (const edge of graph) {
    const key = `${edge.repoName}\u0000${edge.branchName}`
    const current = graphCounts.get(key) ?? {
      total: 0,
      projectTagged: 0,
      unassigned: 0,
      ambiguous: 0,
    }
    const edgeProjectIds = edge.projectIds ?? []

    current.total++
    if (edgeProjectIds.length > 0) current.projectTagged++
    if (edgeProjectIds.length === 0) current.unassigned++
    if ((edge.projectTagSources ?? []).some(source => source.startsWith("repo:ambiguous:"))) current.ambiguous++

    graphCounts.set(key, current)
  }

  for (const item of byScope.values()) {
    const graphStats = graphCounts.get(`${item.repoName}\u0000${item.branchName}`)

    item.relationshipEdgeCount = graphStats?.total ?? 0
    item.graphProjectEdgeCount = graphStats?.projectTagged ?? 0
    item.graphUnassignedEdgeCount = graphStats?.unassigned ?? 0
    item.graphAmbiguousEdgeCount = graphStats?.ambiguous ?? 0
  }

  return [...byScope.values()].sort((left, right) => {
    const repoCompare = left.repoName.localeCompare(right.repoName)
    if (repoCompare !== 0) return repoCompare

    return left.branchName.localeCompare(right.branchName)
  })
}

async function runIndexer(script: "src/index-repo.ts" | "src/index-docs.ts" | "src/index-doctor.ts", args: string[]): Promise<{ raw: string }> {
  const { stdout, stderr } = await execFileAsync(process.execPath, ["--import", "./register-ts-node.mjs", script, ...args], {
    cwd: rootDir,
    timeout: 30 * 60_000,
    maxBuffer: 30 * 1024 * 1024,
    windowsHide: true,
  })

  return {
    raw: [stdout, stderr].filter(Boolean).join("\n"),
  }
}

async function runEvaluationSuite(suite: "baseline" | "edge"): Promise<{ raw: string }> {
  const script = suite === "edge" ? "src/edge-case-regression.ts" : "src/answer-regression.ts"
  const { stdout, stderr } = await execFileAsync(process.execPath, ["--import", "./register-ts-node.mjs", script], {
    cwd: rootDir,
    timeout: 15 * 60_000,
    maxBuffer: 30 * 1024 * 1024,
    windowsHide: true,
  })

  return {
    raw: [stdout, stderr].filter(Boolean).join("\n"),
  }
}

app.post("/api/ask", async (request, response) => {
  const body = request.body as AskBody
  const question = body.question?.trim()

  if (!question) {
    response.status(400).json({ error: "Missing required field: question" })
    return
  }

  const requestId = Math.random().toString(36).slice(2, 10)
  const reqStart = Date.now()
  console.log(`[ask][${requestId}] start q=${question.slice(0, 80)}${question.length > 80 ? "…" : ""} deep=${!!body.deep} limit=${body.limit ?? "-"}`)

  const args = ["--import", "./register-ts-node.mjs", "src/ask.ts", question]

  if (body.limit) {
    args.push("--limit", String(body.limit))
  }

  if (body.deep) {
    args.push("--deep")
  }

  if (body.chatModel?.trim()) {
    args.push("--chat-model", body.chatModel.trim())
  }

  if (body.repoName) {
    args.push("--repo-name", body.repoName)
  }

  if (body.project) {
    args.push("--project", body.project)
  }

  if (body.branch) {
    args.push("--branch", body.branch)
  }

  if (body.serviceType) {
    args.push("--service-type", body.serviceType)
  }

  if (body.history && body.history.length > 0) {
    args.push("--history", JSON.stringify(body.history))
  }

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd: rootDir,
      timeout: body.deep ? 900_000 : 600_000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, ASK_REQUEST_ID: requestId, ASK_DEBUG: process.env.ASK_DEBUG ?? "1" },
    })

    const output = [stdout, stderr].filter(Boolean).join("\n")
    const result = parseAskOutput(output)

    console.log(`[ask][${requestId}] done ms=${Date.now() - reqStart}`)
    response.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const stdout = (error as { stdout?: string }).stdout ?? ""
    const stderr = (error as { stderr?: string }).stderr ?? ""

    console.error(`[ask][${requestId}] failed ms=${Date.now() - reqStart}:`, message)

    response.status(500).json({
      error: message,
      raw: [stdout, stderr].filter(Boolean).join("\n"),
    })
  }
})

// SSE streaming endpoint — sends progress events while ask.ts runs
app.post("/api/ask/stream", (request, response) => {
  const body = request.body as AskBody
  const question = body.question?.trim()

  if (!question) {
    response.status(400).json({ error: "Missing required field: question" })
    return
  }

  const requestId = Math.random().toString(36).slice(2, 10)
  const reqStart = Date.now()
  console.log(`[ask][${requestId}] stream-start q=${question.slice(0, 80)}${question.length > 80 ? "…" : ""} deep=${!!body.deep} limit=${body.limit ?? "-"}`)

  // Set up SSE headers
  response.setHeader("Content-Type", "text/event-stream")
  response.setHeader("Cache-Control", "no-cache")
  response.setHeader("Connection", "keep-alive")
  response.flushHeaders()

  const sendEvent = (data: object) => {
    response.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  sendEvent({ type: "thinking" })

  const args = ["--import", "./register-ts-node.mjs", "src/ask.ts", question]
  if (body.limit) args.push("--limit", String(body.limit))
  if (body.deep) args.push("--deep")
  if (body.chatModel?.trim()) args.push("--chat-model", body.chatModel.trim())
  if (body.repoName) args.push("--repo-name", body.repoName)
  if (body.project) args.push("--project", body.project)
  if (body.branch) args.push("--branch", body.branch)
  if (body.serviceType) args.push("--service-type", body.serviceType)
  if (body.history && body.history.length > 0) args.push("--history", JSON.stringify(body.history))

  let stdout = ""
  let stderr = ""

  const child = execFile(process.execPath, args, {
    cwd: rootDir,
    timeout: body.deep ? 900_000 : 600_000,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, ASK_REQUEST_ID: requestId, ASK_DEBUG: process.env.ASK_DEBUG ?? "1" },
  }, (error, out, err) => {
    stdout = out ?? ""
    stderr = err ?? ""

    console.log(`[ask][${requestId}] stream-done ms=${Date.now() - reqStart}`)

    if (error) {
      sendEvent({ type: "error", error: error.message, raw: [out, err].filter(Boolean).join("\n") })
    } else {
      const result = parseAskOutput([stdout, stderr].filter(Boolean).join("\n"))
      sendEvent({ type: "answer", ...result })
    }
    response.end()
  })

  // Stream stdout lines as progress events
  child.stdout?.on("data", (chunk: Buffer) => {
    const lines = chunk.toString().split("\n").filter(l => l.trim())
    for (const line of lines) {
      if (line.startsWith("BM25") || line.startsWith("◇")) continue // skip internal logs
      sendEvent({ type: "progress", text: line })
    }
  })

  request.on("close", () => {
    if (!child.killed) child.kill()
  })
})

// Coverage map — compares config/services.json repos against indexed source code repos
app.get("/api/index/coverage", async (_request, response) => {
  try {
    const registry = await readServiceRegistryFile()
    const allRegistryRepos = new Set(
      registry.entries.flatMap(entry => affectedReposForRegistryEntry(entry))
    )

    const indexItems = await summarizeIndex()
    // Only count branches that represent real source code (not docs, doctor, decisions, git-history)
    const indexedSourceRepos = new Set(
      indexItems
        .filter(item =>
          !item.branchName.startsWith("docs") &&
          !["doctor", "decisions", "git-history"].includes(item.branchName)
        )
        .map(item => item.repoName)
    )

    const covered: Array<{ repo: string; chunks: number; branch: string; serviceType: string; evidenceTypes: Record<string, number> }> = []
    const missing: Array<{ repo: string; registryEntries: string[] }> = []
    const extra: string[] = []

    // Repos in registry — check if indexed
    for (const repo of [...allRegistryRepos].sort()) {
      const repoItems = indexItems.filter(
        item => item.repoName === repo &&
          !item.branchName.startsWith("docs") &&
          !["doctor", "decisions", "git-history"].includes(item.branchName)
      )

      if (repoItems.length > 0) {
        for (const item of repoItems) {
          covered.push({
            repo: item.repoName,
            chunks: item.chunkCount,
            branch: item.branchName,
            serviceType: item.serviceType,
            evidenceTypes: item.evidenceTypes,
          })
        }
      } else {
        const registryEntries = registry.entries
          .filter(entry => affectedReposForRegistryEntry(entry).includes(repo))
          .map(entry => entry.name)
        missing.push({ repo, registryEntries })
      }
    }

    // Indexed repos not in registry
    for (const repo of indexedSourceRepos) {
      if (!allRegistryRepos.has(repo) && repo !== "local-codebase-ai") {
        extra.push(repo)
      }
    }

    // Migration repos specifically
    const migrationRepos = ["mrg-migrations", "tf2-migrations"]
    const migrationStatus = migrationRepos.map(repo => ({
      repo,
      indexed: indexedSourceRepos.has(repo),
      doctorIndexed: indexItems.some(item => item.repoName === `${repo}-docs` && item.branchName === "doctor"),
    }))

    response.json({
      summary: {
        totalRegistryRepos: allRegistryRepos.size,
        coveredRepos: new Set(covered.map(c => c.repo)).size,
        missingRepos: missing.length,
        coveragePercent: Math.round(new Set(covered.map(c => c.repo)).size / allRegistryRepos.size * 100),
      },
      covered,
      missing,
      extra,
      migrationStatus,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    response.status(500).json({ error: message })
  }
})

app.get("/api/index/summary", async (_request, response) => {
  try {
    response.json({
      collection: config.collectionName,
      qdrantUrl: config.qdrantUrl,
      items: await summarizeIndex(),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    response.status(500).json({ error: message })
  }
})

app.delete("/api/index/repo", async (request, response) => {
  const body = request.body as DeleteIndexBody
  const repoName = body.repoName?.trim()
  const branchName = body.branchName?.trim() || undefined

  if (!repoName) {
    response.status(400).json({ error: "Missing required field: repoName" })
    return
  }

  try {
    await ensureCollection()

    await qdrant.delete(config.collectionName, {
      wait: true,
      filter: indexScopeFilter(repoName, branchName),
    })

    const deletedRelationshipEdges = await deleteRelationshipGraphForScope(repoName, branchName)

    response.json({
      ok: true,
      repoName,
      branchName,
      deletedRelationshipEdges,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    response.status(500).json({ error: message })
  }
})

app.post("/api/index/repo", async (request, response) => {
  const body = request.body as IndexRepoBody
  const repoPath = body.repoPath?.trim()

  if (!repoPath) {
    response.status(400).json({ error: "Missing required field: repoPath" })
    return
  }

  const args = [repoPath]

  if (body.project?.trim()) args.push("--project", body.project.trim())
  if (body.repoName?.trim()) args.push("--repo-name", body.repoName.trim())
  if (body.serviceType?.trim()) args.push("--service-type", body.serviceType.trim())
  if (body.maxChunks) args.push("--max-chunks", String(body.maxChunks))
  if (body.replaceRepo) args.push("--replace-repo")
  if (body.indexCommits) args.push("--index-commits")
  if (body.indexComments) args.push("--index-comments")

  for (const include of body.include ?? []) {
    if (include.trim()) args.push("--include", include.trim())
  }

  for (const exclude of body.exclude ?? []) {
    if (exclude.trim()) args.push("--exclude", exclude.trim())
  }

  try {
    const result = await runIndexer("src/index-repo.ts", args)

    response.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const stdout = (error as { stdout?: string }).stdout ?? ""
    const stderr = (error as { stderr?: string }).stderr ?? ""

    response.status(500).json({
      error: message,
      raw: [stdout, stderr].filter(Boolean).join("\n"),
    })
  }
})

app.post("/api/index/docs", async (request, response) => {
  const body = request.body as IndexDocsBody
  const docsPath = body.docsPath?.trim()

  if (!docsPath) {
    response.status(400).json({ error: "Missing required field: docsPath" })
    return
  }

  const args = [docsPath]

  if (body.project?.trim()) args.push("--project", body.project.trim())
  if (body.repoName?.trim()) args.push("--repo-name", body.repoName.trim())
  if (body.serviceType?.trim()) args.push("--service-type", body.serviceType.trim())
  if (body.branch?.trim()) args.push("--branch", body.branch.trim())
  if (body.locale?.trim()) args.push("--locale", body.locale.trim())
  if (body.replaceRepo) args.push("--replace-repo")

  try {
    const result = await runIndexer("src/index-docs.ts", args)

    response.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const stdout = (error as { stdout?: string }).stdout ?? ""
    const stderr = (error as { stderr?: string }).stderr ?? ""

    response.status(500).json({
      error: message,
      raw: [stdout, stderr].filter(Boolean).join("\n"),
    })
  }
})

app.post("/api/doctor/run", async (request, response) => {
  const body = request.body as { repoPath?: string; repoName?: string; serviceType?: string }
  const repoPath = body.repoPath?.trim()

  if (!repoPath) {
    response.status(400).json({ error: "Missing required field: repoPath" })
    return
  }

  const repoName = body.repoName?.trim() ?? path.basename(repoPath)
  const outputPath = path.resolve(`./repo-docs-work/${repoName}`)

  try {
    // Step 1: Run doctor to generate markdown reports
    const { runDoctor } = await import("./doctor/doctor.js")
    const report = await runDoctor({
      rootFolder: repoPath,
      outputFolder: outputPath,
      json: true,
      maxFiles: 5000,
      silent: false,
      repoName,
      ...(body.serviceType ? { serviceType: body.serviceType } : {}),
    })

    // Step 2: Index the generated doctor reports into Qdrant
    const indexArgs = [outputPath, "--repo-name", repoName]
    if (body.serviceType) indexArgs.push("--service-type", body.serviceType)
    const indexResult = await runIndexer("src/index-doctor.ts", indexArgs)

    response.json({
      report: {
        serviceCount: report.summary.serviceCount,
        apiRouteCount: report.summary.apiRouteCount,
        databaseCount: report.summary.databaseCount,
        rabbitMqCount: report.summary.rabbitMqCount,
        envVarCount: report.summary.envVarCount,
        filesScanned: report.summary.filesScanned,
      },
      indexResult,
      outputPath,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const stdout = (error as { stdout?: string }).stdout ?? ""
    const stderr = (error as { stderr?: string }).stderr ?? ""

    response.status(500).json({
      error: message,
      raw: [stdout, stderr].filter(Boolean).join("\n"),
    })
  }
})

app.get("/api/registry", async (_request, response) => {
  try {
    const registry = await readServiceRegistryFile()

    response.json({
      entries: registry.entries,
      affectedRepos: [...new Set(registry.entries.flatMap(affectedReposForRegistryEntry))].sort(),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    response.status(500).json({ error: message })
  }
})

app.put("/api/registry", async (request, response) => {
  try {
    const registry = await writeServiceRegistryFile(request.body as ServiceRegistryInput)

    response.json({
      entries: registry.entries,
      affectedRepos: [...new Set(registry.entries.flatMap(affectedReposForRegistryEntry))].sort(),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    response.status(400).json({ error: message })
  }
})

app.post("/api/registry/entries", async (request, response) => {
  try {
    const result = await upsertServiceRegistryEntry(request.body)

    response.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    response.status(400).json({ error: message })
  }
})

app.delete("/api/registry/entries/:entryName", async (request, response) => {
  try {
    const result = await deleteServiceRegistryEntry(request.params.entryName)

    response.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = message.startsWith("Registry entry not found:") ? 404 : 400

    response.status(status).json({ error: message })
  }
})

app.post("/api/registry/entries/:entryName/reindex", async (request, response) => {
  const body = request.body as RegistryReindexBody

  try {
    const registry = await readServiceRegistryFile()
    const entry = findServiceRegistryEntry(request.params.entryName, registry.entries)

    if (!entry) {
      response.status(404).json({ error: `Registry entry not found: ${request.params.entryName}` })
      return
    }

    const affectedRepos = affectedReposForRegistryEntry(entry)
    const repoPathConfigs = repoPathConfigsForEntry(entry, registry.entries)
    const knownRepoNames = new Set(repoPathConfigs.map(repoPath => repoPath.repo.toLowerCase()))
    const missingRepos = affectedRepos.filter(repoName => !knownRepoNames.has(repoName.toLowerCase()))
    const results: Array<{ repo: string; path: string; serviceType: string; raw: string }> = []

    for (const repoPathConfig of repoPathConfigs) {
      const args = [
        repoPathConfig.path,
        "--repo-name",
        repoPathConfig.repo,
        "--service-type",
        repoPathConfig.serviceType,
        "--replace-repo",
      ]

      if (body.maxChunks) args.push("--max-chunks", String(body.maxChunks))
      if (body.indexComments) args.push("--index-comments")
      if (body.indexCommits) args.push("--index-commits")

      const result = await runIndexer("src/index-repo.ts", args)

      results.push({
        repo: repoPathConfig.repo,
        path: repoPathConfig.path,
        serviceType: repoPathConfig.serviceType,
        raw: result.raw,
      })
    }

    response.json({
      ok: true,
      entryName: entry.name,
      affectedRepos,
      missingRepos,
      results,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const stdout = (error as { stdout?: string }).stdout ?? ""
    const stderr = (error as { stderr?: string }).stderr ?? ""

    response.status(500).json({
      error: message,
      raw: [stdout, stderr].filter(Boolean).join("\n"),
    })
  }
})

app.get("/api/knowledge/notes", async (_request, response) => {
  try {
    response.json({
      notes: await readKnowledgeNotes(),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    response.status(500).json({ error: message })
  }
})

app.post("/api/knowledge/notes", async (request, response) => {
  try {
    const note = await createKnowledgeNote(request.body as KnowledgeNoteInput)

    response.status(201).json({ note })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    response.status(400).json({ error: message })
  }
})

app.put("/api/knowledge/notes/:id", async (request, response) => {
  try {
    const note = await updateKnowledgeNote(request.params.id, request.body as KnowledgeNoteInput)

    response.json({ note })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = message.startsWith("Knowledge note not found:") ? 404 : 400

    response.status(status).json({ error: message })
  }
})

app.delete("/api/knowledge/notes/:id", async (request, response) => {
  try {
    const deleted = await deleteKnowledgeNote(request.params.id)

    if (!deleted) {
      response.status(404).json({ error: `Knowledge note not found: ${request.params.id}` })
      return
    }

    response.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    response.status(500).json({ error: message })
  }
})

app.post("/api/eval/run", async (request, response) => {
  const body = request.body as EvalBody
  const suite = body.suite === "edge" ? "edge" : "baseline"

  try {
    const result = await runEvaluationSuite(suite)

    response.json({
      ok: true,
      suite,
      ...result,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const stdout = (error as { stdout?: string }).stdout ?? ""
    const stderr = (error as { stderr?: string }).stderr ?? ""

    response.status(500).json({
      ok: false,
      suite,
      error: message,
      raw: [stdout, stderr].filter(Boolean).join("\n"),
    })
  }
})

app.get("/api/feedback", async (_request, response) => {
  try {
    response.json({
      items: await readAnswerFeedback(),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    response.status(500).json({ error: message })
  }
})

app.post("/api/feedback", async (request, response) => {
  try {
    const item = await createAnswerFeedback(request.body as AnswerFeedbackInput)

    response.status(201).json({ item })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    response.status(400).json({ error: message })
  }
})

app.delete("/api/feedback/:id", async (request, response) => {
  try {
    const deleted = await deleteAnswerFeedback(request.params.id)

    if (!deleted) {
      response.status(404).json({ error: `Feedback item not found: ${request.params.id}` })
      return
    }

    response.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    response.status(500).json({ error: message })
  }
})

app.get("/api/drafts", async (_request, response) => {
  try {
    const drafts = await listDrafts()

    response.json({ drafts })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    response.status(500).json({ error: message })
  }
})

app.get("/api/drafts/:filename", async (request, response) => {
  try {
    const content = await readDraft(request.params.filename)

    response.json({ content })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = message.includes("ENOENT") ? 404 : 500

    response.status(status).json({ error: message })
  }
})

app.post("/api/drafts", async (request, response) => {
  const body = request.body as CreateDraftBody

  if (!body.fileName?.trim()) {
    response.status(400).json({ error: "Missing required field: fileName" })
    return
  }

  if (!body.content?.trim()) {
    response.status(400).json({ error: "Missing required field: content" })
    return
  }

  try {
    const fullPath = await saveDraft(body.fileName, body.content)

    response.status(201).json({ fileName: body.fileName, fullPath })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    response.status(400).json({ error: message })
  }
})

app.put("/api/drafts/:filename", async (request, response) => {
  const body = request.body as UpdateDraftBody

  if (!body.content?.trim()) {
    response.status(400).json({ error: "Missing required field: content" })
    return
  }

  try {
    const fullPath = await saveDraft(request.params.filename, body.content)

    response.json({ fileName: request.params.filename, fullPath })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    response.status(400).json({ error: message })
  }
})

app.post("/api/drafts/:filename/approve", async (request, response) => {
  try {
    const result = await approveDraft(request.params.filename)

    response.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = message.includes("ENOENT") ? 404 : 500

    response.status(status).json({ error: message })
  }
})

app.delete("/api/drafts/:filename", async (request, response) => {
  try {
    await discardDraft(request.params.filename)

    response.json({ ok: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    response.status(500).json({ error: message })
  }
})

app.get("/api/decisions/analytics", async (_request, response) => {
  try {
    const approvedDir = approvedDirectory()
    let entries: string[]

    try {
      entries = await fs.readdir(approvedDir)
    } catch {
      entries = []
    }

    const mdFiles = entries.filter(name => name.endsWith(".md")).sort()
    const byType: Record<string, number> = {}
    const byMonth: Record<string, number> = {}
    const byService: Record<string, number> = {}
    const decisionMakers: Record<string, number> = {}
    const recentDecisions: Array<{ fileName: string; date: string; type: string; decision: string; affectedServices: string[] }> = []

    for (const fileName of mdFiles) {
      const content = await fs.readFile(path.join(approvedDir, fileName), "utf8")
      const frontmatter = parseDraftFrontmatter(content)
      const title = extractDecisionTitle(content)
      const month = frontmatter.date.slice(0, 7)
      const maker = frontmatter.decisionMaker ?? "unknown"

      byType[frontmatter.type] = (byType[frontmatter.type] ?? 0) + 1
      byMonth[month] = (byMonth[month] ?? 0) + 1
      for (const svc of frontmatter.affectedServices) {
        byService[svc] = (byService[svc] ?? 0) + 1
      }
      decisionMakers[maker] = (decisionMakers[maker] ?? 0) + 1
      recentDecisions.push({ fileName, date: frontmatter.date, type: frontmatter.type, decision: title, affectedServices: frontmatter.affectedServices })
    }

    const thisMonth = new Date().toISOString().slice(0, 7)

    response.json({
      total: mdFiles.length,
      byType,
      byMonth,
      byService,
      decisionMakers,
      thisMonth: byMonth[thisMonth] ?? 0,
      recentDecisions: recentDecisions.slice(-5).reverse(),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    response.status(500).json({ error: message })
  }
})

app.get("/api/decisions", async (request, response) => {
  try {
    const approvedDir = approvedDirectory()
    let entries: string[]
    try {
      entries = await fs.readdir(approvedDir)
    } catch {
      entries = []
    }

    type DecisionItem = DraftSummary & {
      affectedServices: string[]
      affectedTables: string[]
      decisionMaker: string | null
      content?: string
    }
    const decisions: DecisionItem[] = []

    for (const fileName of entries.filter(name => name.endsWith(".md")).sort()) {
      const content = await fs.readFile(path.join(approvedDir, fileName), "utf8")
      const frontmatter = parseDraftFrontmatter(content)

      decisions.push({
        fileName,
        date: frontmatter.date,
        type: frontmatter.type,
        decision: extractDecisionTitle(content),
        affectedServices: frontmatter.affectedServices,
        affectedTables: frontmatter.affectedTables,
        decisionMaker: frontmatter.decisionMaker,
        content,
      })
    }

    const filter = request.query as DecisionFilter
    let filtered = decisions

    if (filter.type) filtered = filtered.filter(d => d.type === filter.type)

    if (filter.affectedService) {
      const svcLower = filter.affectedService.toLowerCase()
      filtered = filtered.filter(d => d.affectedServices.some(s => s.toLowerCase().includes(svcLower)))
    }

    if (filter.affectedTable) {
      const tblLower = filter.affectedTable.toLowerCase()
      filtered = filtered.filter(d => d.affectedTables.some(t => t.toLowerCase().includes(tblLower)))
    }

    if (filter.decisionMaker) {
      const makerLower = filter.decisionMaker.toLowerCase()
      filtered = filtered.filter(d => (d.decisionMaker ?? "").toLowerCase().includes(makerLower))
    }

    if (filter.dateFrom) filtered = filtered.filter(d => d.date >= filter.dateFrom!)
    if (filter.dateTo) filtered = filtered.filter(d => d.date <= filter.dateTo!)

    if (filter.search) {
      const searchLower = filter.search.toLowerCase()
      if (filter.fullText === "true") {
        filtered = filtered.filter(d =>
          d.decision.toLowerCase().includes(searchLower) ||
          (d.content ?? "").toLowerCase().includes(searchLower)
        )
      } else {
        filtered = filtered.filter(d => d.decision.toLowerCase().includes(searchLower))
      }
    }

    // Strip full content from response — only needed for full-text filtering
    response.json({ decisions: filtered.map(({ content: _content, ...rest }) => rest) })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    response.status(500).json({ error: message })
  }
})

app.get("/api/decisions/:filename", async (request, response) => {
  try {
    const approvedDir = approvedDirectory()
    const content = await fs.readFile(path.join(approvedDir, request.params.filename), "utf8")

    response.json({ content })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = message.includes("ENOENT") ? 404 : 500

    response.status(status).json({ error: message })
  }
})

// C: Related decisions — decisions sharing affected_services or affected_tables
app.get("/api/decisions/:filename/related", async (request, response) => {
  try {
    const approvedDir = approvedDirectory()
    const targetContent = await fs.readFile(path.join(approvedDir, request.params.filename), "utf8")
    const targetFm = parseDraftFrontmatter(targetContent)
    const targetServices = new Set(targetFm.affectedServices.map(s => s.toLowerCase()))
    const targetTables = new Set(targetFm.affectedTables.map(t => t.toLowerCase()))

    let entries: string[]
    try { entries = await fs.readdir(approvedDir) } catch { entries = [] }

    const related: Array<{ fileName: string; date: string; type: string; decision: string; sharedServices: string[]; sharedTables: string[] }> = []

    for (const fileName of entries.filter(n => n.endsWith(".md") && n !== request.params.filename).sort()) {
      const content = await fs.readFile(path.join(approvedDir, fileName), "utf8")
      const fm = parseDraftFrontmatter(content)
      const sharedServices = fm.affectedServices.filter(s => targetServices.has(s.toLowerCase()))
      const sharedTables = fm.affectedTables.filter(t => targetTables.has(t.toLowerCase()))

      if (sharedServices.length > 0 || sharedTables.length > 0) {
        related.push({ fileName, date: fm.date, type: fm.type, decision: extractDecisionTitle(content), sharedServices, sharedTables })
      }
    }

    response.json({ related: related.slice(0, 5) })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    response.status(500).json({ error: message })
  }
})

// E: Versioning endpoints
app.get("/api/decisions/:filename/history", async (request, response) => {
  try {
    const versions = await listVersions(request.params.filename)
    response.json({ versions })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    response.status(500).json({ error: message })
  }
})

app.post("/api/decisions/:filename/snapshot", async (request, response) => {
  try {
    const approvedDir = approvedDirectory()
    const content = await fs.readFile(path.join(approvedDir, request.params.filename), "utf8")
    const version = await saveVersion(request.params.filename, content)
    response.json({ version })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = message.includes("ENOENT") ? 404 : 500
    response.status(status).json({ error: message })
  }
})

// Reindex an already-approved decision after editing it directly in approved/
app.post("/api/decisions/:filename/reindex", async (request, response) => {
  try {
    const result = await reindexApprovedDecision(request.params.filename)
    response.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = message.includes("ENOENT") ? 404 : 500
    response.status(status).json({ error: message })
  }
})

app.get("/api/decisions/:filename/history/:versionId", async (request, response) => {
  try {
    const content = await getVersion(request.params.filename, request.params.versionId)
    if (!content) {
      response.status(404).json({ error: `Version not found: ${request.params.versionId}` })
      return
    }
    response.json({ content })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    response.status(500).json({ error: message })
  }
})

app.post("/api/decisions/:filename/rollback/:versionId", async (request, response) => {
  try {
    const result = await rollbackVersion(request.params.filename, request.params.versionId, approvedDirectory())
    response.json({ ok: true, savedVersion: result.savedVersion })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = message.includes("not found") ? 404 : 500
    response.status(status).json({ error: message })
  }
})

// --- Health checks ---
// Liveness (/api/health): process is alive. Always 200 if the server can respond.
// Readiness (/api/ready): upstream dependencies (Qdrant + Ollama) are reachable.
// Readiness is cached briefly so a flood of probes does not hammer the upstreams.
// BM25 prewarm status is included for observability but does not affect the HTTP
// status code — queries degrade gracefully without BM25 (vector-only results).

let bm25PrewarmStatus: "warming" | "ready" | "failed" | "skipped" = "skipped"

type ReadinessState = {
  qdrant: "ok" | "down"
  ollama: "ok" | "down"
  bm25: "warming" | "ready" | "failed" | "skipped"
  qdrantDetail: string | undefined
  ollamaDetail: string | undefined
}

type CachedReadiness = {
  checkedAt: number
  ready: boolean
  state: ReadinessState
}

const READINESS_CACHE_TTL_MS = 5_000
let cachedReadiness: CachedReadiness | null = null

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(id)
  }
}

async function probeReadiness(): Promise<ReadinessState> {
  let qdrantStatus: ReadinessState["qdrant"] = "ok"
  let ollamaStatus: ReadinessState["ollama"] = "ok"
  let qdrantDetail: string | undefined
  let ollamaDetail: string | undefined

  try {
    await qdrant.getCollections()
  } catch (err) {
    qdrantStatus = "down"
    qdrantDetail = err instanceof Error ? err.message : String(err)
  }

  try {
    const res = await fetchWithTimeout(`${config.ollamaUrl}/api/tags`, 2_000)
    if (!res.ok) {
      ollamaStatus = "down"
      ollamaDetail = `HTTP ${res.status}`
    }
  } catch (err) {
    ollamaStatus = "down"
    ollamaDetail = err instanceof Error ? err.message : String(err)
  }

  return { qdrant: qdrantStatus, ollama: ollamaStatus, bm25: bm25PrewarmStatus, qdrantDetail, ollamaDetail }
}

async function getReadiness(): Promise<CachedReadiness> {
  if (cachedReadiness && Date.now() - cachedReadiness.checkedAt < READINESS_CACHE_TTL_MS) {
    return cachedReadiness
  }
  const state = await probeReadiness()
  const ready = state.qdrant === "ok" && state.ollama === "ok"
  cachedReadiness = { checkedAt: Date.now(), ready, state }
  return cachedReadiness
}

app.get("/api/health", (_request, response) => {
  // Liveness: process is up.
  response.json({ status: "ok" })
})

app.get("/api/ready", async (_request, response) => {
  const result = await getReadiness()
  response.status(result.ready ? 200 : 503).json({
    ready: result.ready,
    checkedAt: new Date(result.checkedAt).toISOString(),
    dependencies: result.state,
  })
})

app.get("/api/auth-required", (_request, response) => {
  response.json({ required: Boolean(APP_API_KEY) })
})

const port = Number(process.env.PORT ?? 9191)

app.listen(port, () => {
  console.log(`Local Codebase AI server running at http://localhost:${port}`)

  // Prewarm BM25 disk cache in the background so the first /api/ask request
  // does not pay the ~2-3 min cold-build cost. Non-blocking — errors are logged.
  bm25PrewarmStatus = "warming"
  prewarmBM25Index()
    .then(() => { bm25PrewarmStatus = "ready" })
    .catch(() => { bm25PrewarmStatus = "failed" })
})
