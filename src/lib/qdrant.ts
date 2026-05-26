import { QdrantClient } from "@qdrant/js-client-rest"
import { config } from "./config.js"

export const qdrant = new QdrantClient({
  url: config.qdrantUrl,
})

export async function ensureCollection(): Promise<void> {
  let collections

  try {
    collections = await qdrant.getCollections()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    throw new Error(
      `Qdrant is not reachable at ${config.qdrantUrl}. Start it with: docker compose up -d\n${message}`,
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
