import fs from "node:fs/promises"
import path from "node:path"
import { spawn } from "node:child_process"
import { config } from "./config.js"
import { sha256, uuidFromHash } from "./hash.js"
import { createEmbedding } from "./ollama.js"
import { ensureCollection, qdrant } from "./qdrant.js"
import { appendRelationshipEdges, createDecisionEdge } from "./graph.js"
import { loadKnownServiceNames } from "./extractors/knowledge-context.js"
import { saveVersion } from "./decision-versions.js"

export type DraftFrontmatter = {
  date: string
  status: string
  type: "adr" | "implicit_rule"
  decisionMaker: string | null
  affectedServices: string[]
  affectedTables: string[]
  source: string
  discoveredIn: string | null
}

export type DraftSummary = {
  fileName: string
  date: string
  type: "adr" | "implicit_rule"
  decision: string
}

export type ApproveResult = {
  fileName: string
  approvedPath: string
  chunkType: "adr" | "implicit_rule"
  affectedServices: string[]
  documentedEdges: number
}

const decisionsDir = path.join(process.cwd(), "docs", "decisions")
const draftsDir = path.join(decisionsDir, "drafts")
const approvedDir = path.join(decisionsDir, "approved")

export function draftsDirectory(): string {
  return draftsDir
}

export function approvedDirectory(): string {
  return approvedDir
}

export async function ensureDecisionDirs(): Promise<void> {
  await fs.mkdir(draftsDir, { recursive: true })
  await fs.mkdir(approvedDir, { recursive: true })
}

export async function saveDraft(fileName: string, content: string): Promise<string> {
  await fs.mkdir(draftsDir, { recursive: true })
  const fullPath = path.join(draftsDir, fileName)
  await fs.writeFile(fullPath, content, "utf8")

  return fullPath
}

function parseFrontmatterValue(raw: string): string | string[] {
  const trimmed = raw.trim()
  const arrayMatch = trimmed.match(/^\[(.*)\]$/)

  if (arrayMatch) {
    return (arrayMatch[1] ?? "")
      .split(",")
      .map(item => item.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean)
  }

  return trimmed.replace(/^["']|["']$/g, "")
}

// Pisahkan frontmatter dari body; logika ini murni string agar mudah diuji.
export function splitFrontmatter(content: string): { fields: Record<string, string | string[]>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)

  if (!match) {
    return { fields: {}, body: content }
  }

  const fields: Record<string, string | string[]> = {}

  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const colonIndex = line.indexOf(":")
    if (colonIndex <= 0) continue

    const key = line.slice(0, colonIndex).trim()
    fields[key] = parseFrontmatterValue(line.slice(colonIndex + 1))
  }

  return { fields, body: match[2] ?? "" }
}

function asScalar(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? ""
  return value ?? ""
}

function asArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value
  if (typeof value === "string" && value.trim().length > 0) return [value.trim()]
  return []
}

function nullableScalar(value: string | string[] | undefined): string | null {
  const scalar = asScalar(value).trim()
  if (!scalar || scalar.toLowerCase() === "unknown") return null
  return scalar
}

export function parseDraftFrontmatter(content: string): DraftFrontmatter {
  const { fields } = splitFrontmatter(content)
  const isImplicit = asScalar(fields.type) === "implicit_rule"

  return {
    date: asScalar(fields.date) || new Date().toISOString().slice(0, 10),
    status: asScalar(fields.status) || "draft",
    type: isImplicit ? "implicit_rule" : "adr",
    decisionMaker: nullableScalar(fields.decision_maker),
    affectedServices: asArray(fields.affected_services),
    affectedTables: asArray(fields.affected_tables),
    source: asScalar(fields.source) || "brain_dump",
    discoveredIn: nullableScalar(fields.discovered_in),
  }
}

export function extractDecisionTitle(content: string): string {
  const match = content.match(/^#\s+(?:ADR|Implicit Rule):\s*(.+)$/m)
  if (match?.[1]) return match[1].trim()

  const heading = content.match(/^#\s+(.+)$/m)
  return heading?.[1]?.trim() ?? "(untitled decision)"
}

export async function listDrafts(): Promise<DraftSummary[]> {
  let entries: string[]

  try {
    entries = await fs.readdir(draftsDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }

  const summaries: DraftSummary[] = []

  for (const fileName of entries.filter(name => name.endsWith(".md")).sort()) {
    const content = await fs.readFile(path.join(draftsDir, fileName), "utf8")
    const frontmatter = parseDraftFrontmatter(content)

    summaries.push({
      fileName,
      date: frontmatter.date,
      type: frontmatter.type,
      decision: extractDecisionTitle(content),
    })
  }

  return summaries
}

export async function readDraft(fileName: string): Promise<string> {
  return fs.readFile(path.join(draftsDir, fileName), "utf8")
}

export async function discardDraft(fileName: string): Promise<void> {
  await fs.rm(path.join(draftsDir, fileName), { force: true })
}

export async function editDraft(fileName: string): Promise<void> {
  const fullPath = path.join(draftsDir, fileName)
  const editor = process.env.EDITOR || process.env.VISUAL || (process.platform === "win32" ? "notepad" : "vi")

  await new Promise<void>((resolve, reject) => {
    const child = spawn(editor, [fullPath], { stdio: "inherit", shell: true })
    child.on("error", reject)
    child.on("exit", () => resolve())
  })
}

function decisionPointId(fileName: string): string {
  return uuidFromHash(sha256(`decision:${fileName}`))
}

// Index dokumen keputusan yang sudah disetujui ke Qdrant dengan prioritas retrieval tinggi.
async function indexApprovedDecision(fileName: string, content: string, frontmatter: DraftFrontmatter): Promise<void> {
  await ensureCollection()

  const chunkType = frontmatter.type
  const title = extractDecisionTitle(content)
  const filePath = `decision://${fileName}`
  const contentHash = sha256(content)
  const embeddingInput = [
    "Repository: tf-documentation",
    `Decision: ${title}`,
    `Decision maker: ${frontmatter.decisionMaker ?? "unknown"}`,
    `Affected services: ${frontmatter.affectedServices.join(", ") || "unassigned"}`,
    `Affected tables: ${frontmatter.affectedTables.join(", ") || "none"}`,
    `Date: ${frontmatter.date}`,
    "",
    content,
  ].join("\n")

  const vector = await createEmbedding(embeddingInput)

  await qdrant.upsert(config.collectionName, {
    points: [
      {
        id: decisionPointId(fileName),
        vector,
        payload: {
          repoName: "tf-documentation",
          projectIds: [],
          serviceType: "unknown",
          branchName: "decisions",
          commitSha: frontmatter.date,
          docLocale: "default",
          evidenceTypes: ["documentation"],
          symbols: [title],
          dbTables: frontmatter.affectedTables,
          filePath,
          startLine: 1,
          endLine: content.split(/\r?\n/).length,
          content,
          contentHash,
          source_type: "decision",
          chunk_type: chunkType,
          decision_maker: frontmatter.decisionMaker,
          affected_services: frontmatter.affectedServices,
          affected_tables: frontmatter.affectedTables,
          date: frontmatter.date,
          retrieval_priority: 10,
        },
      },
    ],
  })
}

async function writeDocumentsDecisionEdges(fileName: string, content: string, frontmatter: DraftFrontmatter): Promise<number> {
  const knownServices = new Set(loadKnownServiceNames().map(name => name.toLowerCase()))
  const linkedServices = frontmatter.affectedServices.filter(service => knownServices.has(service.toLowerCase()))

  if (linkedServices.length === 0) return 0

  const title = extractDecisionTitle(content)
  const edges = linkedServices.map(service =>
    createDecisionEdge({
      type: "DOCUMENTS_DECISION",
      repoName: service,
      serviceType: "unknown",
      branchName: "decisions",
      commitSha: frontmatter.date,
      filePath: `docs:decisions/approved/${fileName}`,
      startLine: 1,
      endLine: 1,
      fromSymbol: service,
      symbol: title,
      evidence: title,
    }),
  )

  await appendRelationshipEdges(edges)

  return edges.length
}

export async function approveDraft(fileName: string): Promise<ApproveResult> {
  const draftPath = path.join(draftsDir, fileName)
  const content = await fs.readFile(draftPath, "utf8")
  const frontmatter = parseDraftFrontmatter(content)

  // Tandai status approved di frontmatter sebelum dipindahkan dan diindeks.
  const approvedContent = content.replace(/^status:\s*draft\s*$/m, "status: approved")

  await fs.mkdir(approvedDir, { recursive: true })
  const approvedPath = path.join(approvedDir, fileName)
  await fs.writeFile(approvedPath, approvedContent, "utf8")
  await fs.rm(draftPath, { force: true })

  await indexApprovedDecision(fileName, approvedContent, frontmatter)
  const documentedEdges = await writeDocumentsDecisionEdges(fileName, approvedContent, frontmatter)

  // Auto-snapshot the approved content for version history.
  await saveVersion(fileName, approvedContent).catch(() => undefined)

  return {
    fileName,
    approvedPath,
    chunkType: frontmatter.type,
    affectedServices: frontmatter.affectedServices,
    documentedEdges,
  }
}

// Re-index an already-approved decision (e.g. after editing it directly in approved/).
export async function reindexApprovedDecision(fileName: string): Promise<ApproveResult> {
  const approvedPath = path.join(approvedDir, fileName)
  const content = await fs.readFile(approvedPath, "utf8")
  const frontmatter = parseDraftFrontmatter(content)

  await indexApprovedDecision(fileName, content, frontmatter)
  const documentedEdges = await writeDocumentsDecisionEdges(fileName, content, frontmatter)
  await saveVersion(fileName, content).catch(() => undefined)

  return {
    fileName,
    approvedPath,
    chunkType: frontmatter.type,
    affectedServices: frontmatter.affectedServices,
    documentedEdges,
  }
}

export async function approveAllDrafts(): Promise<ApproveResult[]> {
  const drafts = await listDrafts()
  const results: ApproveResult[] = []

  for (const draft of drafts) {
    results.push(await approveDraft(draft.fileName))
  }

  return results
}
