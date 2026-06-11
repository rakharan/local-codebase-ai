import { QdrantClient } from "@qdrant/js-client-rest"

const q = new QdrantClient({ url: "http://localhost:6333" })
const result = await q.scroll("code_chunks", {
  filter: { must: [{ key: "filePath", match: { value: "components/traders/controllers/uploadava.js" } }] },
  with_payload: true,
  limit: 20,
})

if (result.points.length === 0) {
  console.log("No chunks found for uploadava.js")
} else {
  for (const p of result.points) {
    const pay = p.payload as Record<string, unknown>
    console.log(`[${pay.chunkType}] ${pay.symbolName ?? "(unnamed)"} lines ${pay.startLine}-${pay.endLine}`)
  }
}
