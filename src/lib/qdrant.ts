import { QdrantClient } from "@qdrant/js-client-rest"
import { config } from "./config.js"

export const qdrant = new QdrantClient({
  url: config.qdrantUrl,
})

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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

  if (exists) return

  await qdrant.createCollection(config.collectionName, {
    vectors: {
      size: config.vectorSize,
      distance: "Cosine",
    },
  })
}
