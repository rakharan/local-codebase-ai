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

program
  .argument("<repoPath>", "Path to local repository")
  .option("--repo-name <repoName>", "Repository name")
  .option("--service-type <serviceType>", "Service type: api, worker, cron, library, unknown", "unknown")
  .parse()

const repoPathArg = program.args[0]

if (!repoPathArg) {
  throw new Error("Missing required argument: repoPath")
}

const repoPath = path.resolve(repoPathArg)
const options = program.opts<{ repoName?: string; serviceType: string }>()
const repoName = options.repoName ?? path.basename(repoPath)
const serviceType = serviceTypes.has(options.serviceType as ServiceType)
  ? (options.serviceType as ServiceType)
  : "unknown"

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
  await ensureCollection()

  console.log(`Reading repo: ${repoPath}`)
  console.log(`Repo name: ${repoName}`)
  console.log(`Service type: ${serviceType}`)

  const gitInfo = await getGitInfo(repoPath)
  console.log(`Branch: ${gitInfo.branchName}`)
  console.log(`Commit: ${gitInfo.commitSha}`)

  const files = await readRepoFiles(repoPath)

  console.log(`Found ${files.length} files`)

  const chunks = files.flatMap(file => chunkFile(file, repoName, serviceType, gitInfo.branchName, gitInfo.commitSha))
  const existing = await fetchExistingIndex(repoName, gitInfo.branchName)
  const legacyIds = await fetchLegacyUnbranchedIds(repoName)
  const currentIds = new Set(chunks.map(chunk => chunk.id))
  const staleIds = [...existing.ids].filter(id => !currentIds.has(String(id)))
  const chunksToIndex = chunks.filter(chunk => !existing.hashes.has(chunk.contentHash))

  let indexed = 0
  let skipped = 0

  console.log(`Found ${chunks.length} chunks`)
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
