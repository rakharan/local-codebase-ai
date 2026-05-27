import path from "node:path"
import fs from "node:fs/promises"
import { Command } from "commander"
import { ensureCollection, qdrant } from "./lib/qdrant.js"
import { config } from "./lib/config.js"
import { readRepoFiles } from "./lib/files.js"
import { getGitInfo } from "./lib/git.js"
import { chunkFile } from "./lib/chunker.js"
import type { CodeChunk, ServiceType } from "./lib/chunker.js"
import { createEmbedding } from "./lib/ollama.js"

const serviceTypes = new Set<ServiceType>(["api", "worker", "cron", "library", "unknown"])

const program = new Command()

function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value]
}

program
  .argument("<repoPath>", "Path to local repository")
  .option("--repo-name <repoName>", "Repository name")
  .option("--service-type <serviceType>", "Service type: api, worker, cron, library, unknown", "unknown")
  .option("--include <glob>", "Include glob relative to repo root. Can be repeated.", collectOption, [])
  .option("--exclude <glob>", "Exclude glob relative to repo root. Can be repeated.", collectOption, [])
  .option("--dry-run", "Read and chunk files, then print a summary without touching Qdrant/Ollama.", false)
  .option("--max-chunks <count>", "Abort before embedding if the selected scope exceeds this chunk count.")
  .option("--replace-repo", "Delete all existing chunks for this repo name before indexing the selected scope.", false)
  .parse()

const repoPathArg = program.args[0]

if (!repoPathArg) {
  throw new Error("Missing required argument: repoPath")
}

const repoPath = path.resolve(repoPathArg)
const options = program.opts<{
  repoName?: string
  serviceType: string
  include: string[]
  exclude: string[]
  dryRun: boolean
  maxChunks?: string
  replaceRepo: boolean
}>()
const repoName = options.repoName ?? path.basename(repoPath)
const serviceType = serviceTypes.has(options.serviceType as ServiceType)
  ? (options.serviceType as ServiceType)
  : "unknown"
const maxChunks = options.maxChunks ? Number(options.maxChunks) : undefined

if (maxChunks !== undefined && (!Number.isInteger(maxChunks) || maxChunks < 1)) {
  throw new Error("--max-chunks must be a positive integer")
}

async function assertRepoPathExists(): Promise<void> {
  try {
    const stat = await fs.stat(repoPath)

    if (!stat.isDirectory()) {
      throw new Error(`Repo path is not a directory: ${repoPath}`)
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Repo path is not a directory")) {
      throw error
    }

    throw new Error(`Repo path does not exist or cannot be read: ${repoPath}`)
  }
}

function withUpsertHint(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)

  if (message.includes("expected dim") || message.includes("dimension") || message.includes("Bad Request")) {
    return new Error(
      `${message}\nHint: if this mentions vector size, recreate the Qdrant collection or set VECTOR_SIZE to match ${config.embeddingModel}.`,
    )
  }

  return error instanceof Error ? error : new Error(message)
}

type ExistingPoint = {
  id: string | number
  payload?: {
    contentHash?: string
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
      {
        key: "repoName",
        match: {
          value: repoName,
        },
      },
      {
        key: "branchName",
        match: {
          value: branchName,
        },
      },
    ],
  }
}

function repoOnlyFilter(repoName: string) {
  return {
    must: [
      {
        key: "repoName",
        match: {
          value: repoName,
        },
      },
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

async function fetchLegacyUnbranchedIds(repoName: string): Promise<Array<string | number>> {
  const ids: Array<string | number> = []
  let offset: string | number | Record<string, unknown> | null | undefined

  do {
    const scrollRequest = {
      filter: repoOnlyFilter(repoName),
      limit: 256,
      with_payload: true,
      with_vector: false,
      ...(offset ? { offset } : {}),
    }
    const page = await qdrant.scroll(config.collectionName, scrollRequest)
    const points = page.points as ExistingPoint[]

    for (const point of points) {
      if (!point.payload?.branchName) {
        ids.push(point.id)
      }
    }

    offset = page.next_page_offset
  } while (offset)

  return ids
}

async function deleteStaleChunks(staleIds: Array<string | number>): Promise<void> {
  if (staleIds.length === 0) return

  await qdrant.delete(config.collectionName, {
    wait: true,
    points: staleIds,
  })
}

async function deleteRepoChunks(repoName: string): Promise<void> {
  await qdrant.delete(config.collectionName, {
    wait: true,
    filter: repoOnlyFilter(repoName),
  })
}

async function upsertChunk(chunk: CodeChunk): Promise<void> {
  const embeddingInput = [
    `Repository: ${chunk.repoName}`,
    `Branch: ${chunk.branchName}`,
    `Commit: ${chunk.commitSha}`,
    `Service type: ${chunk.serviceType}`,
    `Evidence types: ${chunk.evidenceTypes.join(", ")}`,
    `Routes: ${chunk.relationshipHints.routes.join(", ")}`,
    `Symbols: ${chunk.relationshipHints.symbols.join(", ")}`,
    `Message names: ${chunk.relationshipHints.messageNames.join(", ")}`,
    `Queues: ${chunk.relationshipHints.queueNames.join(", ")}`,
    `Exchanges: ${chunk.relationshipHints.exchangeNames.join(", ")}`,
    `Database tables: ${chunk.relationshipHints.dbTables.join(", ")}`,
    `File: ${chunk.filePath}`,
    `Lines: ${chunk.startLine}-${chunk.endLine}`,
    "",
    chunk.content,
  ].join("\n")

  const vector = await createEmbedding(embeddingInput)

  try {
    await qdrant.upsert(config.collectionName, {
      points: [
        {
          id: chunk.id,
          vector,
          payload: {
            repoName: chunk.repoName,
            serviceType: chunk.serviceType,
            branchName: chunk.branchName,
            commitSha: chunk.commitSha,
            evidenceTypes: chunk.evidenceTypes,
            routes: chunk.relationshipHints.routes,
            symbols: chunk.relationshipHints.symbols,
            messageNames: chunk.relationshipHints.messageNames,
            queueNames: chunk.relationshipHints.queueNames,
            exchangeNames: chunk.relationshipHints.exchangeNames,
            dbTables: chunk.relationshipHints.dbTables,
            filePath: chunk.filePath,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            content: chunk.content,
            contentHash: chunk.contentHash,
          },
        },
      ],
    })
  } catch (error) {
    throw withUpsertHint(error)
  }
}

async function main() {
  await assertRepoPathExists()

  console.log(`Reading repo: ${repoPath}`)
  console.log(`Repo name: ${repoName}`)
  console.log(`Service type: ${serviceType}`)
  console.log(`Mode: ${options.dryRun ? "dry-run" : "index"}`)
  console.log(`Replace repo: ${options.replaceRepo ? "yes" : "no"}`)
  console.log(`Include globs: ${options.include.length > 0 ? options.include.join(", ") : "**/*"}`)
  console.log(`Exclude globs: ${options.exclude.length > 0 ? options.exclude.join(", ") : "none"}`)
  if (maxChunks) {
    console.log(`Max chunks: ${maxChunks}`)
  }

  const gitInfo = await getGitInfo(repoPath)
  console.log(`Branch: ${gitInfo.branchName}`)
  console.log(`Commit: ${gitInfo.commitSha}`)

  const files = await readRepoFiles(repoPath, {
    include: options.include,
    exclude: options.exclude,
  })

  console.log(`Found ${files.length} files`)

  const chunks = files.flatMap(file => chunkFile(file, repoName, serviceType, gitInfo.branchName, gitInfo.commitSha))

  console.log(`Found ${chunks.length} chunks`)

  const chunksByTopFolder = new Map<string, number>()
  const chunksByEvidenceType = new Map<string, number>()

  for (const chunk of chunks) {
    const topFolder = chunk.filePath.split(/[\\/]/)[0] ?? "(root)"
    chunksByTopFolder.set(topFolder, (chunksByTopFolder.get(topFolder) ?? 0) + 1)

    for (const evidenceType of chunk.evidenceTypes) {
      chunksByEvidenceType.set(evidenceType, (chunksByEvidenceType.get(evidenceType) ?? 0) + 1)
    }
  }

  console.log("Top chunk folders:")
  for (const [folder, count] of [...chunksByTopFolder.entries()].sort((left, right) => right[1] - left[1]).slice(0, 12)) {
    console.log(`- ${folder}: ${count}`)
  }

  console.log("Evidence type counts:")
  for (const [evidenceType, count] of [...chunksByEvidenceType.entries()].sort((left, right) => right[1] - left[1]).slice(0, 12)) {
    console.log(`- ${evidenceType}: ${count}`)
  }

  if (options.dryRun) {
    console.log("Dry run complete. No Qdrant collection was changed and no embeddings were generated.")
    return
  }

  if (maxChunks && chunks.length > maxChunks) {
    throw new Error(
      `Selected scope produced ${chunks.length} chunks, which exceeds --max-chunks ${maxChunks}. Narrow --include/--exclude or raise the limit.`,
    )
  }

  await ensureCollection()

  if (options.replaceRepo) {
    console.log(`Deleting all existing chunks for repo ${repoName}`)
    await deleteRepoChunks(repoName)
  }

  const existing = await fetchExistingIndex(repoName, gitInfo.branchName)
  const legacyIds = await fetchLegacyUnbranchedIds(repoName)
  const currentIds = new Set(chunks.map(chunk => chunk.id))
  const staleIds = [...existing.ids].filter(id => !currentIds.has(String(id)))
  const chunksToIndex = chunks.filter(chunk => !existing.hashes.has(chunk.contentHash))

  let indexed = 0
  let skipped = 0

  console.log(`Skipping ${chunks.length - chunksToIndex.length} unchanged chunks`)
  console.log(`Indexing ${chunksToIndex.length} new or changed chunks`)
  console.log(`Deleting ${staleIds.length} stale chunks`)
  console.log(`Deleting ${legacyIds.length} legacy unbranched chunks`)

  await deleteStaleChunks(staleIds)
  await deleteStaleChunks(legacyIds)

  skipped = chunks.length - chunksToIndex.length

  for (const chunk of chunksToIndex) {
    await upsertChunk(chunk)

    indexed++

    if (indexed % 10 === 0) {
      console.log(`Indexed ${indexed} chunks...`)
    }
  }

  console.log(
    `Done. Indexed ${indexed} chunks, skipped ${skipped}, deleted ${staleIds.length} stale chunks and ${legacyIds.length} legacy chunks.`,
  )
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
