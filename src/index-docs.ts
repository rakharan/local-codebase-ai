import path from "node:path"
import fs from "node:fs/promises"
import { Command } from "commander"
import { ensureCollection, qdrant } from "./lib/qdrant.js"
import { config } from "./lib/config.js"
import { sha256, uuidFromHash } from "./lib/hash.js"
import { inferRelationshipHints } from "./lib/relationships.js"
import { extractStructuredFacts } from "./lib/facts.js"
import { createEmbedding } from "./lib/ollama.js"
import type { CodeChunk } from "./lib/chunker.js"
import { inferProjectIdsForRepo, inferProjectTagForChunk, normalizeProjectIds } from "./lib/service-registry.js"

const program = new Command()

program
  .argument("<docsPath>", "Path to Docusaurus docs folder (e.g. my-website/docs)")
  .option("--repo-name <repoName>", "Fallback repo name if no mapping matches", "tf-documentation")
  .option("--project <projectId>", "Project/product/domain id. Can be repeated or comma-separated.", collectOption, [])
  .option("--service-type <serviceType>", "Service type for doc chunks", "unknown")
  .option("--branch <branchName>", "Branch name for doc chunks", "docs")
  .option("--locale <locale>", "Documentation locale, or auto to infer Docusaurus i18n locale from path", "auto")
  .option("--dry-run", "Read and chunk files without touching Qdrant/Ollama.", false)
  .option("--replace-repo", "Delete all existing doc chunks for mapped repos.", false)
  .parse()

const docsPathArg = program.args[0]

if (!docsPathArg) {
  throw new Error("Missing required argument: docsPath")
}

const docsPath = path.resolve(docsPathArg)

const options = program.opts<{
  repoName: string
  project: string[]
  serviceType: string
  branch: string
  locale: string
  dryRun: boolean
  replaceRepo: boolean
}>()

const serviceType = options.serviceType as "api" | "worker" | "cron" | "library" | "unknown"

function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value]
}

function inferDocsLocale(dir: string): string {
  const normalized = dir.replace(/\\/g, "/")
  const match = normalized.match(/\/i18n\/([^/]+)\/docusaurus-plugin-content-docs\/current\/?$/)

  return match?.[1] ?? "default"
}

const docLocale = options.locale === "auto" ? inferDocsLocale(docsPath) : options.locale
const docsBranchName = docLocale === "default" ? options.branch : `${options.branch}:${docLocale}`

function normalizeRepoName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, "")
}

function mapDocFolderToRepoNames(folderName: string): string[] {
  const mapping: Record<string, string[]> = {
    "ims-docs": ["ims-mrg", "ims-askap", "ims-tf2"],
    "isignal-docs": ["tf2-ois", "fa-trade-publisher", "ims-tf2"],
    "wallet-docs": ["tf2-ois"],
    "fa-porto-docs": ["tf2-porto-service"],
    "analyst-docs": ["tf2-ois"],
    "channel-subs-docs": ["tf2-ois"],
    "keteng-docs": ["tf2-ois"],
    "devops-docs": ["tf2-ois", "ims-tf2", "mrg-accounts", "tf2-porto-service", "tf2-sinyo"],
    "product-knowledge": ["tf2-ois", "ims-tf2", "mrg-accounts"],
  }

  const normalized = normalizeRepoName(folderName)

  for (const [key, repos] of Object.entries(mapping)) {
    if (normalized === normalizeRepoName(key)) {
      return repos
    }
  }

  return [options.repoName]
}

type DocFile = {
  relativePath: string
  content: string
}

async function readDocFiles(dir: string): Promise<DocFile[]> {
  const files: DocFile[] = []

  async function walk(currentDir: string, prefix: string) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name)
      const relativePath = path.join(prefix, entry.name)

      if (entry.isDirectory()) {
        await walk(fullPath, relativePath)
      } else if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".mdx"))) {
        const content = await fs.readFile(fullPath, "utf8")
        files.push({ relativePath, content })
      }
    }
  }

  await walk(dir, "")
  return files
}

function extractFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)

  if (!match) {
    return { frontmatter: {}, body: content }
  }

  const frontmatterText = match[1] ?? ""
  const body = match[2] ?? ""
  const frontmatter: Record<string, string> = {}

  for (const line of frontmatterText.split("\n")) {
    const colonIndex = line.indexOf(":")

    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim()
      const value = line.slice(colonIndex + 1).trim().replace(/^["']|["']$/g, "")
      frontmatter[key] = value
    }
  }

  return { frontmatter, body }
}

function extractReposFromFrontmatter(frontmatter: Record<string, string>): string[] | undefined {
  const raw = frontmatter.repos ?? frontmatter.relatedRepos ?? frontmatter.repo

  if (!raw) return undefined

  // Try YAML array: [a, b, c]
  const arrayMatch = raw.match(/^\[(.*)\]$/)
  if (arrayMatch?.[1]) {
    return arrayMatch[1]
      .split(",")
      .map(s => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean)
  }

  // Single value
  return [raw]
}

const MAX_DOC_CHUNK_CHARS = 1_500

function projectHashKey(projectIds: string[]): string {
  return projectIds.length > 0 ? projectIds.join(",") : "unassigned"
}

function chunkMarkdown(file: DocFile, repoName: string, branchName: string, projectIds: string[]): CodeChunk[] {
  const { frontmatter, body } = extractFrontmatter(file.content)
  const lines = body.split("\n")
  const chunks: CodeChunk[] = []
  const baseMetadata = [
    `title: ${frontmatter.title ?? ""}`,
    `description: ${frontmatter.description ?? ""}`,
    `file: ${file.relativePath}`,
  ].join("\n")

  let currentLines: string[] = []
  let currentStart = 1
  let currentHeader = frontmatter.title ?? file.relativePath

  function flushChunk(endLine: number) {
    const content = currentLines.join("\n").trim()

    if (content.length === 0) return

    function pushSubChunk(subLines: string[], subStart: number, subEnd: number) {
      const subContent = subLines.join("\n").trim()

      if (subContent.length === 0) return

      const chunkContent = [
        `Documentation: ${currentHeader}`,
        `Source: ${file.relativePath}`,
        `Locale: ${docLocale}`,
        baseMetadata,
        "",
        subContent,
      ].join("\n")
      const projectTag = inferProjectTagForChunk({
        repoName,
        filePath: file.relativePath,
        content: chunkContent,
        fallbackProjectIds: projectIds,
      })

      const contentHash = sha256(
        `docs-v1:${repoName}:${projectHashKey(projectTag.projectIds)}:${branchName}:${file.relativePath}:${subStart}:${subEnd}:${subContent}`,
      )

      chunks.push({
        id: uuidFromHash(contentHash),
        repoName,
        projectIds: projectTag.projectIds,
        projectTagSources: projectTag.sources,
        serviceType,
        branchName,
        commitSha: "docs",
        docLocale,
        filePath: `docs:${file.relativePath}`,
        startLine: subStart,
        endLine: subEnd,
        content: chunkContent,
        contentHash,
        evidenceTypes: ["documentation"],
        relationshipHints: inferRelationshipHints(chunkContent),
        structuredFacts: extractStructuredFacts(chunkContent, subStart),
      })
    }

    if (content.length <= MAX_DOC_CHUNK_CHARS) {
      pushSubChunk(currentLines, currentStart, endLine)
      return
    }

    let subLines: string[] = []
    let subStart = currentStart

    for (let index = 0; index < currentLines.length; index++) {
      const line = currentLines[index] ?? ""
      const candidate = [...subLines, line].join("\n")

      if (candidate.length > MAX_DOC_CHUNK_CHARS && subLines.length > 0) {
        pushSubChunk(subLines, subStart, subStart + subLines.length - 1)
        subLines = [line]
        subStart = currentStart + index
      } else {
        subLines.push(line)
      }
    }

    if (subLines.length > 0) {
      pushSubChunk(subLines, subStart, endLine)
    }
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ""
    const isHeader = /^#{1,3}\s+/.test(line)

    if (isHeader && currentLines.length > 0) {
      flushChunk(index)
      currentLines = []
      currentStart = index + 1
      currentHeader = line.replace(/^#{1,3}\s+/, "").trim()
    }

    currentLines.push(line)
  }

  if (currentLines.length > 0) {
    flushChunk(lines.length)
  }

  return chunks
}

type ExistingPoint = {
  id: string | number
  payload?: {
    contentHash?: string
    repoName?: string
    branchName?: string
  } | null
}

type ExistingIndex = {
  ids: Set<string | number>
  hashes: Set<string>
}

function repoBranchFilter(repoName: string, branchName: string) {
  return {
    must: [
      { key: "repoName", match: { value: repoName } },
      { key: "branchName", match: { value: branchName } },
    ],
  }
}

async function fetchExistingIndex(repoName: string, branchName: string): Promise<ExistingIndex> {
  const ids = new Set<string | number>()
  const hashes = new Set<string>()
  let offset: string | number | Record<string, unknown> | null | undefined

  do {
    const scrollRequest = {
      filter: repoBranchFilter(repoName, branchName),
      limit: 256,
      with_payload: true,
      with_vector: false,
      ...(offset ? { offset } : {}),
    }
    const page = await qdrant.scroll(config.collectionName, scrollRequest)
    const points = page.points as ExistingPoint[]

    for (const point of points) {
      ids.add(point.id)

      if (point.payload?.contentHash) {
        hashes.add(point.payload.contentHash)
      }
    }

    offset = page.next_page_offset
  } while (offset)

  return { ids, hashes }
}

async function deleteStaleChunks(staleIds: Array<string | number>): Promise<void> {
  if (staleIds.length === 0) return
  await qdrant.delete(config.collectionName, { wait: true, points: staleIds })
}

async function upsertChunk(chunk: CodeChunk): Promise<void> {
  const embeddingInput = [
    `Repository: ${chunk.repoName}`,
    `Projects: ${chunk.projectIds.join(", ") || "unassigned"}`,
    `Branch: ${chunk.branchName}`,
    `Documentation locale: ${chunk.docLocale ?? "default"}`,
    `Service type: ${chunk.serviceType}`,
    `Evidence types: ${chunk.evidenceTypes.join(", ")}`,
    `Routes: ${chunk.relationshipHints.routes.join(", ")}`,
    `Symbols: ${chunk.relationshipHints.symbols.join(", ")}`,
    `Message names: ${chunk.relationshipHints.messageNames.join(", ")}`,
    `Database tables: ${chunk.relationshipHints.dbTables.join(", ")}`,
    `Structured facts: ${chunk.structuredFacts.map(fact => `${fact.category}:${fact.text}`).join(" | ")}`,
    `File: ${chunk.filePath}`,
    `Lines: ${chunk.startLine}-${chunk.endLine}`,
    "",
    chunk.content,
  ].join("\n")

  const vector = await createEmbedding(embeddingInput)

  await qdrant.upsert(config.collectionName, {
    points: [
      {
        id: chunk.id,
        vector,
        payload: {
          repoName: chunk.repoName,
          projectIds: chunk.projectIds,
          projectTagSources: chunk.projectTagSources,
          serviceType: chunk.serviceType,
          branchName: chunk.branchName,
          commitSha: chunk.commitSha,
          docLocale: chunk.docLocale,
          evidenceTypes: chunk.evidenceTypes,
          routes: chunk.relationshipHints.routes,
          symbols: chunk.relationshipHints.symbols,
          messageNames: chunk.relationshipHints.messageNames,
          queueNames: chunk.relationshipHints.queueNames,
          exchangeNames: chunk.relationshipHints.exchangeNames,
          dbTables: chunk.relationshipHints.dbTables,
          structuredFacts: chunk.structuredFacts,
          filePath: chunk.filePath,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          content: chunk.content,
          contentHash: chunk.contentHash,
        },
      },
    ],
  })
}

async function main() {
  console.log(`Reading docs: ${docsPath}`)
  console.log(`Mode: ${options.dryRun ? "dry-run" : "index"}`)
  console.log(`Locale: ${docLocale}`)
  console.log(`Docs branch: ${docsBranchName}`)
  console.log(`Explicit projects: ${options.project.length > 0 ? normalizeProjectIds(options.project).join(", ") : "none"}`)
  console.log(`Replace repo: ${options.replaceRepo ? "yes" : "no"}`)

  const files = await readDocFiles(docsPath)
  console.log(`Found ${files.length} doc files`)

  const chunksByRepo = new Map<string, CodeChunk[]>()
  const repoNames = new Set<string>()

  for (const file of files) {
    const { frontmatter } = extractFrontmatter(file.content)
    const fileRepos = extractReposFromFrontmatter(frontmatter)
    const folderName = file.relativePath.split(/[\\/]/)[0] ?? ""
    const targetRepos = fileRepos ?? mapDocFolderToRepoNames(folderName)

    for (const repoName of targetRepos) {
      repoNames.add(repoName)
      const projectIds = normalizeProjectIds([
        ...options.project,
        ...inferProjectIdsForRepo(repoName),
      ])
      const chunks = chunkMarkdown(file, repoName, docsBranchName, projectIds)

      if (!chunksByRepo.has(repoName)) {
        chunksByRepo.set(repoName, [])
      }

      chunksByRepo.get(repoName)?.push(...chunks)
    }
  }

  const totalChunks = [...chunksByRepo.values()].flat().length
  console.log(`Mapped to ${repoNames.size} repos: ${[...repoNames].join(", ")}`)
  console.log(`Total doc chunks: ${totalChunks}`)

  for (const [repoName, chunks] of chunksByRepo.entries()) {
    console.log(`  ${repoName}: ${chunks.length} chunks`)
  }

  if (options.dryRun) {
    console.log("Dry run complete. No Qdrant collection was changed.")
    return
  }

  await ensureCollection()

  for (const repoName of repoNames) {
    if (options.replaceRepo) {
      console.log(`Deleting existing doc chunks for ${repoName}@${docsBranchName}`)
      const existing = await fetchExistingIndex(repoName, docsBranchName)
      await deleteStaleChunks([...existing.ids])
    }
  }

  for (const [repoName, chunks] of chunksByRepo.entries()) {
    const existing = await fetchExistingIndex(repoName, docsBranchName)
    const currentIds = new Set(chunks.map(chunk => chunk.id))
    const staleIds = [...existing.ids].filter(id => !currentIds.has(String(id)))
    const chunksToIndex = chunks.filter(chunk => !existing.hashes.has(chunk.contentHash))

    console.log(`Repo ${repoName}: skipping ${chunks.length - chunksToIndex.length} unchanged, indexing ${chunksToIndex.length}, deleting ${staleIds.length} stale`)

    await deleteStaleChunks(staleIds)

    let indexed = 0

    for (const chunk of chunksToIndex) {
      await upsertChunk(chunk)
      indexed++

      if (indexed % 10 === 0) {
        console.log(`  Indexed ${indexed} chunks for ${repoName}...`)
      }
    }

    console.log(`Done ${repoName}. Indexed ${indexed}, skipped ${chunks.length - chunksToIndex.length}.`)
  }

  console.log(`All docs indexed. Total repos: ${repoNames.size}`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
