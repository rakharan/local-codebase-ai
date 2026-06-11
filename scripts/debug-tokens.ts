import { extractQuestionHints } from "../src/ask/question.js"
import { isIdentifierQuery, bm25Search } from "../src/lib/bm25-index.js"

const question = "what does UploadKYCAsync do in ims-tf2?"
const hints = extractQuestionHints(question)
console.log("hints:", hints)

const identifierTokens = hints.filter(t => isIdentifierQuery(t))
console.log("identifierTokens:", identifierTokens)

const bm25Query = identifierTokens.length > 0 ? identifierTokens.join(" ") : question
console.log("bm25Query:", bm25Query)

const results = await bm25Search(bm25Query, 10)
console.log("BM25 results:")
for (const r of results) {
  console.log(`  [${r.chunkType}] ${r.symbolName} — ${r.filePath}:${r.startLine}-${r.endLine} score=${r.score.toFixed(2)}`)
}
