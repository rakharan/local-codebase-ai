import { bm25Search, isIdentifierQuery, getBM25Index } from "../src/lib/bm25-index.js"

console.log("isIdentifierQuery test:")
console.log("  UploadKYCAsync:", isIdentifierQuery("what does UploadKYCAsync do in ims-tf2?"))

console.log("\nBuilding BM25 index...")
const index = await getBM25Index()
console.log("Index built.")

console.log("\nSearching for UploadKYCAsync...")
const results = await bm25Search("UploadKYCAsync", 10)
if (results.length === 0) {
  console.log("No results found!")
} else {
  for (const r of results) {
    console.log(`  [${r.chunkType}] ${r.symbolName || "(unnamed)"} — ${r.repoName} ${r.filePath}:${r.startLine}-${r.endLine} (score=${r.score.toFixed(2)})`)
  }
}
