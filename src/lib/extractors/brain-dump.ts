import { runExtraction } from "./shared.js"
import type { ExtractedDecision, KnowledgeContext } from "./types.js"

export async function extractBrainDump(input: string, context: KnowledgeContext): Promise<ExtractedDecision> {
  const trimmed = input.trim()

  if (trimmed.length === 0) {
    throw new Error("BRAIN_DUMP_EMPTY: no input text to digest.")
  }

  return runExtraction(trimmed, context)
}
