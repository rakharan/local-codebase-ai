import path from "node:path"
import fs from "node:fs/promises"
import { sha256, uuidFromHash } from "./lib/hash.js"
import { inferRelationshipHints } from "./lib/relationships.js"
import { extractStructuredFacts } from "./lib/facts.js"
import type { CodeChunk } from "./lib/chunker.js"
import { buildReportChunks } from "./lib/doctor-report-chunks.js"
import type { DoctorReport } from "./lib/doctor-report-chunks.js"

const BRANCH = "doctor"

/** Known Doctor output files and their docType */
const DOC_TYPE_MAP: Record<string, string> = {
  "overview.md": "overview",
  "services.md": "services",
  "env.md": "env",
  "api.md": "api",
  "rabbitmq.md": "rabbitmq",
  "database.md": "database",
  "architecture.md": "architecture",
}

export type DoctorDocFile = {
  relativePath: string
  docType: string
  content: string
}

export async function readDoctorFiles(dir: string): Promise<DoctorDocFile[]> {
  const files: DoctorDocFile[] = []
  const entries = await fs.readdir(dir)

  for (const name of entries) {
    const docType = DOC_TYPE_MAP[name]
    if (!docType) continue
    const fullPath = path.join(dir, name)
    const stat = await fs.stat(fullPath)
    if (!stat.isFile()) continue
    const content = await fs.readFile(fullPath, "utf8")
    if (!content.trim()) continue
    files.push({ relativePath: name, docType, content })
  }

  return files
}

const MAX_CHUNK_CHARS = 1_500

export function chunkDoctorMarkdown(file: DoctorDocFile, repo: string): CodeChunk[] {
  const lines = file.content.split("\n")
  const chunks: CodeChunk[] = []
  let currentLines: string[] = []
  let currentStart = 1
  let currentHeader = file.docType

  function flush(endLine: number): void {
    const content = currentLines.join("\n").trim()
    if (content.length === 0) return

    function pushChunk(subLines: string[], subStart: number, subEnd: number): void {
      const text = subLines.join("\n").trim()
      if (text.length === 0) return

      const chunkContent = [
        `Repo Doctor: ${currentHeader}`,
        `Source: ${file.relativePath}`,
        `DocType: ${file.docType}`,
        "",
        text,
      ].join("\n")

      const contentHash = sha256(
        `doctor-v1:${repo}:${BRANCH}:${file.relativePath}:${subStart}:${subEnd}:${text}`,
      )

      chunks.push({
        id: uuidFromHash(contentHash),
        repoName: repo,
        projectIds: [],
        projectTagSources: [],
        serviceType: "unknown",
        branchName: BRANCH,
        commitSha: "doctor",
        filePath: `doctor:${file.relativePath}`,
        startLine: subStart,
        endLine: subEnd,
        content: chunkContent,
        contentHash,
        evidenceTypes: ["documentation"],
        relationshipHints: inferRelationshipHints(chunkContent),
        structuredFacts: extractStructuredFacts(chunkContent, subStart),
      })
    }

    if (content.length <= MAX_CHUNK_CHARS) {
      pushChunk(currentLines, currentStart, endLine)
      return
    }

    let subLines: string[] = []
    let subStart = currentStart
    for (let i = 0; i < currentLines.length; i++) {
      const line = currentLines[i] ?? ""
      if ([...subLines, line].join("\n").length > MAX_CHUNK_CHARS && subLines.length > 0) {
        pushChunk(subLines, subStart, subStart + subLines.length - 1)
        subLines = [line]
        subStart = currentStart + i
      } else {
        subLines.push(line)
      }
    }
    if (subLines.length > 0) pushChunk(subLines, subStart, endLine)
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    if (/^#{1,3}\s+/.test(line) && currentLines.length > 0) {
      flush(i)
      currentLines = []
      currentStart = i + 1
      currentHeader = line.replace(/^#{1,3}\s+/, "").trim()
    }
    currentLines.push(line)
  }

  if (currentLines.length > 0) flush(lines.length)
  return chunks
}

// --- CLI execution (only when run directly) ---

const isMainModule = process.argv[1]?.replace(/\\/g, "/").endsWith("index-doctor.ts") ||
  process.argv[1]?.replace(/\\/g, "/").endsWith("index-doctor.js")

if (isMainModule) {
  const { Command } = await import("commander")
  const { ensureCollection, qdrant } = await import("./lib/qdrant.js")
  const { config } = await import("./lib/config.js")
  const { createEmbedding } = await import("./lib/ollama.js")

  const program = new Command()
  program
    .argument("<doctorOutput>", "Path to Repo Doctor output folder")
    .requiredOption("--repo-name <repoName>", "Repository name for these doctor docs")
    .option("--dry-run", "Read and chunk files without touching Qdrant/Ollama.", false)
    .parse()

  const doctorPath = path.resolve(program.args[0]!)
  const opts = program.opts<{ repoName: string; dryRun: boolean }>()
  const repoName = opts.repoName

  type ExistingPoint = { id: string | number; payload?: { contentHash?: string } | null }

  async function fetchExistingIndex(repo: string, branch: string) {
    const ids = new Set<string | number>()
    const hashes = new Set<string>()
    let offset: string | number | Record<string, unknown> | null | undefined
    do {
      const page = await qdrant.scroll(config.collectionName, {
        filter: { must: [{ key: "repoName", match: { value: repo } }, { key: "branchName", match: { value: branch } }] },
        limit: 256, with_payload: true, with_vector: false,
        ...(offset ? { offset } : {}),
      })
      for (const point of page.points as ExistingPoint[]) {
        ids.add(point.id)
        if (point.payload?.contentHash) hashes.add(point.payload.contentHash)
      }
      offset = page.next_page_offset
    } while (offset)
    return { ids, hashes }
  }

  async function upsertChunk(chunk: CodeChunk): Promise<void> {
    const embeddingInput = [
      `Repository: ${chunk.repoName}`,
      `Branch: ${chunk.branchName}`,
      `Evidence types: ${chunk.evidenceTypes.join(", ")}`,
      `Routes: ${chunk.relationshipHints.routes.join(", ")}`,
      `Queues: ${chunk.relationshipHints.queueNames.join(", ")}`,
      `Database tables: ${chunk.relationshipHints.dbTables.join(", ")}`,
      `File: ${chunk.filePath}`,
      "",
      chunk.content,
    ].join("\n")
    const vector = await createEmbedding(embeddingInput)
    await qdrant.upsert(config.collectionName, {
      points: [{
        id: chunk.id, vector,
        payload: {
          repoName: chunk.repoName, projectIds: chunk.projectIds, projectTagSources: chunk.projectTagSources,
          serviceType: chunk.serviceType, branchName: chunk.branchName, commitSha: chunk.commitSha,
          evidenceTypes: chunk.evidenceTypes, routes: chunk.relationshipHints.routes,
          symbols: chunk.relationshipHints.symbols, messageNames: chunk.relationshipHints.messageNames,
          queueNames: chunk.relationshipHints.queueNames, exchangeNames: chunk.relationshipHints.exchangeNames,
          dbTables: chunk.relationshipHints.dbTables, structuredFacts: chunk.structuredFacts,
          filePath: chunk.filePath, startLine: chunk.startLine, endLine: chunk.endLine,
          content: chunk.content, contentHash: chunk.contentHash,
        },
      }],
    })
  }

  console.log(`Reading doctor output: ${doctorPath}`)
  console.log(`Repo: ${repoName}, Branch: ${BRANCH}`)

  const files = await readDoctorFiles(doctorPath)
  console.log(`Found ${files.length} doctor doc files`)

  const allChunks: CodeChunk[] = []
  for (const file of files) {
    allChunks.push(...chunkDoctorMarkdown(file, repoName))
  }

  // Auto-detect report.json
  const reportPath = path.join(doctorPath, "report.json")
  try {
    const reportContent = await fs.readFile(reportPath, "utf8")
    const report: DoctorReport = JSON.parse(reportContent)
    const factChunks = buildReportChunks(report, repoName)
    allChunks.push(...factChunks)
    console.log(`Found report.json: ${factChunks.length} fact chunks`)
  } catch { /* no report.json */ }

  console.log(`Total chunks: ${allChunks.length}`)

  if (opts.dryRun) {
    for (const file of files) {
      const count = allChunks.filter(c => c.filePath === `doctor:${file.relativePath}`).length
      console.log(`  ${file.relativePath} (${file.docType}): ${count} chunks`)
    }
    console.log("Dry run complete.")
    process.exit(0)
  }

  await ensureCollection()
  const existing = await fetchExistingIndex(repoName, BRANCH)
  const currentIds = new Set(allChunks.map(c => c.id))
  const staleIds = [...existing.ids].filter(id => !currentIds.has(String(id)))
  const toIndex = allChunks.filter(c => !existing.hashes.has(c.contentHash))

  console.log(`Skipping ${allChunks.length - toIndex.length} unchanged, indexing ${toIndex.length}, deleting ${staleIds.length} stale`)

  if (staleIds.length > 0) {
    await qdrant.delete(config.collectionName, { wait: true, points: staleIds })
  }

  let indexed = 0
  for (const chunk of toIndex) {
    await upsertChunk(chunk)
    indexed++
    if (indexed % 10 === 0) console.log(`  Indexed ${indexed}...`)
  }

  console.log(`Done. Indexed ${indexed}, skipped ${allChunks.length - toIndex.length}, deleted ${staleIds.length} stale.`)
}
