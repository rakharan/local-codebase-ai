import path from "node:path"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import express from "express"
import { config } from "./lib/config.js"
import { ensureCollection, qdrant } from "./lib/qdrant.js"
import { deleteRelationshipGraphForScope, readRelationshipGraph } from "./lib/graph.js"
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
  documentationCount: number
  vocabularyCount: number
  relationshipEdgeCount: number
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
        documentationCount: 0,
        vocabularyCount: 0,
        relationshipEdgeCount: 0,
        evidenceTypes: {},
      }

      item.chunkCount++
      item.projectIds = [...new Set([...item.projectIds, ...projectIds])].sort()
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
  const graphCounts = new Map<string, number>()

  for (const edge of graph) {
    const key = `${edge.repoName}\u0000${edge.branchName}`
    graphCounts.set(key, (graphCounts.get(key) ?? 0) + 1)
  }

  for (const item of byScope.values()) {
    item.relationshipEdgeCount = graphCounts.get(`${item.repoName}\u0000${item.branchName}`) ?? 0
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
      timeout: 180_000,
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

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok" })
})

const port = Number(process.env.PORT ?? 3456)

app.listen(port, () => {
  console.log(`Local Codebase AI server running at http://localhost:${port}`)
})
