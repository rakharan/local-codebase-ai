import path from "node:path"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import express from "express"
import { config } from "./lib/config.js"
import { ensureCollection, qdrant } from "./lib/qdrant.js"
import { deleteRelationshipGraphForScope, readRelationshipGraph } from "./lib/graph.js"
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
  dateFrom?: string
  dateTo?: string
  search?: string
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

async function runIndexer(script: "src/index-repo.ts" | "src/index-docs.ts", args: string[]): Promise<{ raw: string }> {
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
      timeout: body.deep ? 360_000 : 180_000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    })

    const output = [stdout, stderr].filter(Boolean).join("\n")
    const result = parseAskOutput(output)

    response.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const stdout = (error as { stdout?: string }).stdout ?? ""
    const stderr = (error as { stderr?: string }).stderr ?? ""

    console.error("Ask process failed:", message)

    response.status(500).json({
      error: message,
      raw: [stdout, stderr].filter(Boolean).join("\n"),
    })
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

app.get("/api/decisions", async (request, response) => {
  try {
    const approvedDir = approvedDirectory()
    const entries = await fs.readdir(approvedDir)
    const decisions: Array<DraftSummary & { affectedServices: string[] }> = []

    for (const fileName of entries.filter(name => name.endsWith(".md")).sort()) {
      const content = await fs.readFile(path.join(approvedDir, fileName), "utf8")
      const frontmatter = parseDraftFrontmatter(content)

      decisions.push({
        fileName,
        date: frontmatter.date,
        type: frontmatter.type,
        decision: extractDecisionTitle(content),
        affectedServices: frontmatter.affectedServices,
      })
    }

    // Apply filters from query params
    const filter = request.query as DecisionFilter
    let filtered = decisions

    if (filter.type) {
      filtered = filtered.filter(d => d.type === filter.type)
    }

    if (filter.affectedService) {
      filtered = filtered.filter(d =>
        d.affectedServices.some(s => s.toLowerCase().includes(filter.affectedService!.toLowerCase()))
      )
    }

    if (filter.dateFrom) {
      filtered = filtered.filter(d => d.date >= filter.dateFrom!)
    }

    if (filter.dateTo) {
      filtered = filtered.filter(d => d.date <= filter.dateTo!)
    }

    if (filter.search) {
      const searchLower = filter.search.toLowerCase()
      filtered = filtered.filter(d => d.decision.toLowerCase().includes(searchLower))
    }

    response.json({ decisions: filtered })
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

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok" })
})

const port = Number(process.env.PORT ?? 3456)

app.listen(port, () => {
  console.log(`Local Codebase AI server running at http://localhost:${port}`)
})
