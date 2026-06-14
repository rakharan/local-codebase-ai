import { extractQuestionHints } from "../src/ask/question.js"
import { extractQuestionTerms as extractVocabTerms } from "../src/lib/vocabulary.js"

const question = "what does UploadKYCAsync do in ims-tf2?"

console.log("extractQuestionHints:", extractQuestionHints(question))
console.log("extractVocabTerms:", extractVocabTerms(question))
