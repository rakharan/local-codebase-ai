import { QdrantClient } from "@qdrant/js-client-rest"

const q = new QdrantClient({ url: "http://localhost:6333" })
const result = await q.scroll("code_chunks", {
  filter: { must: [{ key: "branchName", match: { value: "doctor" } }] },
  with_payload: true,
  limit: 500,
  with_vector: false,
})

const byRepo = new Map<string, number>()
let offset = result.next_page_offset
for (const p of result.points) {
  const repo = (p.payload as Record<string, unknown>).repoName as string ?? "unknown"
  byRepo.set(repo, (byRepo.get(repo) ?? 0) + 1)
}

// paginate
let nextOffset: unknown = offset
while (nextOffset) {
  const page = await q.scroll("code_chunks", {
    filter: { must: [{ key: "branchName", match: { value: "doctor" } }] },
    with_payload: true,
    limit: 500,
    with_vector: false,
    offset: nextOffset as string,
  })
  for (const p of page.points) {
    const repo = (p.payload as Record<string, unknown>).repoName as string ?? "unknown"
    byRepo.set(repo, (byRepo.get(repo) ?? 0) + 1)
  }
  nextOffset = page.next_page_offset
}

console.log("Doctor chunks in Qdrant by repo:")
for (const [repo, count] of [...byRepo.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${repo}: ${count}`)
}
