import { createEmbedding } from "../src/lib/ollama.js"
import { qdrant } from "../src/lib/qdrant.js"
import { config } from "../src/lib/config.js"
import { bm25Search, isIdentifierQuery } from "../src/lib/bm25-index.js"
import type { RetrievedPayload } from "../src/ask/types.js"

const question = "what services touch dsc_signals table?"
const vec = await createEmbedding(question)
const results = await qdrant.query(config.collectionName, { query: vec, limit: 24, with_payload: true })

console.log("Top 15 vector results:")
for (const p of results.points.slice(0, 15)) {
  const pay = p.payload as RetrievedPayload
  console.log(`  ${pay.repoName} ${pay.filePath?.slice(0, 60)} (${pay.evidenceTypes?.join(",")})`)
}

console.log("\nBM25 results for 'dsc_signals':")
const bm25 = await bm25Search("dsc_signals", 10)
for (const r of bm25) {
  console.log(`  [${r.chunkType}] ${r.repoName} ${r.filePath}:${r.startLine} score=${r.score.toFixed(1)}`)
}
