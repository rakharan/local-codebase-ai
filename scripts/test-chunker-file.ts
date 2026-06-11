import { chunkFile } from "../src/lib/chunker.js"
import { readFileSync } from "fs"

const filePath = process.argv[2]
if (!filePath) { console.error("Usage: test-chunker-file.ts <path>"); process.exit(1) }

const content = readFileSync(filePath, "utf8")
const rel = filePath.replace(/\\/g, "/").split("GIT/work/").pop() ?? filePath
const chunks = chunkFile(
  { absolutePath: filePath, relativePath: rel, content },
  "test", "api", "main", "abc123"
)

const lineSpans = chunks.map(c => c.endLine - c.startLine + 1)
const avg = Math.round(lineSpans.reduce((a, b) => a + b, 0) / lineSpans.length)
const max = Math.max(...lineSpans)
const min = Math.min(...lineSpans)

console.log(`File: ${rel}`)
console.log(`Total chunks: ${chunks.length} | avg lines: ${avg} | min: ${min} | max: ${max}\n`)

for (const c of chunks) {
  console.log(`[${c.chunkType}] ${c.symbolName ?? "(unnamed)"} — lines ${c.startLine}-${c.endLine} (${c.endLine - c.startLine + 1} lines, overlap=${c.hasOverlap})`)
}
