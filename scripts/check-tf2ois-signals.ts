import { QdrantClient } from "@qdrant/js-client-rest"

const q = new QdrantClient({ url: "http://localhost:6333" })
const result = await q.scroll("code_chunks", {
  filter: {
    must: [
      { key: "repoName", match: { value: "tf2-ois" } },
    ]
  },
  with_payload: true,
  limit: 5,
})

console.log(`tf2-ois chunks in Qdrant: checking dbTables...`)
let found = 0
let offset: unknown = undefined
do {
  const page = await q.scroll("code_chunks", {
    filter: { must: [{ key: "repoName", match: { value: "tf2-ois" } }] },
    with_payload: true,
    limit: 256,
    ...(offset ? { offset } : {}),
  })
  for (const p of page.points) {
    const pay = p.payload as Record<string, unknown>
    const tables = pay.dbTables as string[] ?? []
    if (tables.includes("dsc_signals")) {
      found++
      if (found <= 5) console.log(`  ${pay.filePath}:${pay.startLine}-${pay.endLine} tables=${tables.join(",")}`)
    }
  }
  offset = page.next_page_offset
} while (offset)
console.log(`Total tf2-ois chunks with dsc_signals: ${found}`)
