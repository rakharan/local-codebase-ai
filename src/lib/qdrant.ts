import { QdrantClient } from "@qdrant/js-client-rest"
import { config } from "./config.js"

export const qdrant = new QdrantClient({
  url: config.qdrantUrl,
})

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Bidang yang dipakai sebagai filter di scroll/query — harus diindeks agar tidak full-scan.
const PAYLOAD_INDEXES: Array<{ field: string; schema: "keyword" | "integer" }> = [
  { field: "repoName",       schema: "keyword" },
  { field: "branchName",     schema: "keyword" },
  { field: "filePath",       schema: "keyword" },
  { field: "serviceType",    schema: "keyword" },
  { field: "projectIds",     schema: "keyword" },
  { field: "source_type",    schema: "keyword" },
  { field: "evidenceTypes",  schema: "keyword" },
]

// Qdrant returns HTTP 409 (or a body containing "Index already exists for field")
// when a payload index already exists. Only that case is safe to swallow — every
// other error (connection refused, auth, schema mismatch, server error) must
// propagate so startup fails loudly instead of silently running unindexed.
function isIndexAlreadyExistsError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status
    if (status === 409) return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return /already exists/i.test(message)
}

async function ensurePayloadIndexes(): Promise<void> {
  for (const { field, schema } of PAYLOAD_INDEXES) {
    try {
      await qdrant.createPayloadIndex(config.collectionName, {
        field_name: field,
        field_schema: schema,
      })
    } catch (error) {
      if (isIndexAlreadyExistsError(error)) {
        // Idempotent: index already created. Safe to ignore.
        continue
      }
      // Unexpected error — propagate so it is visible, not silently unindexed.
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to ensure payload index for "${field}": ${message}`)
    }
  }
}

export async function ensureCollection(): Promise<void> {
  let collections
  let lastError: unknown

  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      collections = await qdrant.getCollections()
      break
    } catch (error) {
      lastError = error

      if (attempt < 10) {
        await delay(1_000)
      }
    }
  }

  if (!collections) {
    const message = lastError instanceof Error ? lastError.message : String(lastError)

    throw new Error(
      `Qdrant is not reachable at ${config.qdrantUrl}. Start it with: docker compose up -d and wait until docker compose ps shows qdrant as Up.\n${message}`,
    )
  }

  const exists = collections.collections.some(
    collection => collection.name === config.collectionName,
  )

  if (!exists) {
    await qdrant.createCollection(config.collectionName, {
      vectors: {
        size: config.vectorSize,
        distance: "Cosine",
      },
    })
  }

  // Buat payload index untuk semua bidang filter — idempoten, aman dijalankan berulang.
  await ensurePayloadIndexes()
}
