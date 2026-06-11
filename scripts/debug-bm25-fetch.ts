import { bm25Search } from "../src/lib/bm25-index.js"
import { qdrant } from "../src/lib/qdrant.js"
import { config } from "../src/lib/config.js"
import type { RetrievedPayload } from "../src/ask/types.js"

const bm25Results = await bm25Search("UploadKYCAsync", 10)
console.log("BM25 ids:", bm25Results.map(r => r.id))

// simulate what retrieve() does — fetch missing ids
const missingIds = bm25Results.map(r => r.id)
const extra = await qdrant.retrieve(config.collectionName, {
  ids: missingIds,
  with_payload: true,
})

console.log(`\nFetched ${extra.length} chunks via qdrant.retrieve()`)
for (const point of extra) {
  const p = point.payload as RetrievedPayload
  console.log(`  ${p.repoName} ${p.filePath}:${p.startLine}-${p.endLine} symbolName=${p.symbolName ?? "-"}`)
}
