import { chunkFile } from "../src/lib/chunker.js"
import { readFileSync } from "fs"

const content = readFileSync("./src/lib/chunker.ts", "utf8")
const chunks = chunkFile(
  { absolutePath: "", relativePath: "src/lib/chunker.ts", content },
  "test", "unknown", "main", "abc123"
)

for (const c of chunks) {
  console.log(`[${c.chunkType}] ${c.symbolName ?? "(unnamed)"} — lines ${c.startLine}-${c.endLine} (overlap=${c.hasOverlap})`)
}
console.log(`\nTotal chunks: ${chunks.length}`)
