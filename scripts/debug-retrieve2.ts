import { bm25Search, isIdentifierQuery } from "../src/lib/bm25-index.js"
import { createEmbedding } from "../src/lib/ollama.js"
import { qdrant } from "../src/lib/qdrant.js"
import { config } from "../src/lib/config.js"
import type { RetrievedPayload } from "../src/ask/types.js"

const question = "what does UploadKYCAsync do in ims-tf2?"

// Simulate exactly what retrieve() does now
const questionVector = await createEmbedding(question)
const results = await qdrant.query(config.collectionName, { query: questionVector, limit: 24, with_payload: true })
const chunks = results.points.map(p => ({ id: String(p.id), payload: p.payload as RetrievedPayload })).filter(c => c.payload.content)

console.log(`Vector chunks: ${chunks.length}`)

const bm25Results = await bm25Search(question, 16)
const vectorIds = new Set(chunks.map(c => c.id))
const bm25Ids = new Set(bm25Results.map(r => r.id))
const missingIds = bm25Results.map(r => r.id).filter(id => !vectorIds.has(id))

console.log(`BM25 results: ${bm25Results.length}`)
console.log(`Missing from vector: ${missingIds.length}`)

const extra = await qdrant.retrieve(config.collectionName, { ids: missingIds, with_payload: true })
for (const point of extra) {
  const p = point.payload as RetrievedPayload
  chunks.push({ id: String(point.id), payload: p })
}

const bm25Chunks = chunks.filter(c => bm25Ids.has(c.id))
const nonBm25Chunks = chunks.filter(c => !bm25Ids.has(c.id))
const merged = [...bm25Chunks, ...nonBm25Chunks]

console.log(`\nFinal merged top 8:`)
for (const c of merged.slice(0, 8)) {
  const p = c.payload
  console.log(`  ${p.repoName} ${p.filePath}:${p.startLine}-${p.endLine} symbolName=${p.symbolName ?? "-"} bm25=${bm25Ids.has(c.id)}`)
}
