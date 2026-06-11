import { bm25Search, isIdentifierQuery } from "../src/lib/bm25-index.js"
import { createEmbedding } from "../src/lib/ollama.js"
import { qdrant } from "../src/lib/qdrant.js"
import { config } from "../src/lib/config.js"
import type { RetrievedPayload } from "../src/ask/types.js"

const question = "what does UploadKYCAsync do in ims-tf2?"

console.log("isIdentifierQuery:", isIdentifierQuery(question))

// Step 1: BM25
console.log("\n--- BM25 results ---")
const bm25Results = await bm25Search("UploadKYCAsync", 10)
console.log(`Found ${bm25Results.length} BM25 hits:`)
for (const r of bm25Results) {
  console.log(`  [${r.chunkType}] ${r.symbolName} — ${r.filePath}:${r.startLine}-${r.endLine} score=${r.score.toFixed(2)}`)
}

// Step 2: vector search
console.log("\n--- Vector search results (top 12) ---")
const vec = await createEmbedding(question)
const results = await qdrant.query(config.collectionName, { query: vec, limit: 24, with_payload: true })
const chunks = results.points.map(p => ({ id: String(p.id), payload: p.payload as RetrievedPayload })).filter(c => c.payload.content)
console.log(`Found ${chunks.length} vector hits. Top 12:`)
for (const c of chunks.slice(0, 12)) {
  const p = c.payload
  console.log(`  ${p.repoName} ${p.filePath}:${p.startLine}-${p.endLine} symbolName=${(p as Record<string,unknown>).symbolName ?? "-"}`)
}

// Step 3: check if uploadava is in vector results at all
const uploadavaInVector = chunks.find(c => c.payload.filePath?.includes("uploadava"))
console.log("\nuploadava.js in vector results:", uploadavaInVector ? "YES" : "NO")
