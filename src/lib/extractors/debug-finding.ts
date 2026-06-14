import { runExtraction } from "./shared.js"
import type { ExtractedDecision, KnowledgeContext } from "./types.js"

export type DebugFindingInput = {
  text: string
  // Petunjuk lokasi "file:line" tempat perilaku ditemukan, biasanya dari flag --service.
  discoveredIn?: string
}

// Coba temukan lokasi "file:line" dari teks finding lalu beri prefix nama service bila ada.
export function inferDiscoveredIn(text: string, service?: string): string | null {
  const match = text.match(/([\w./-]+\.(?:php|ts|tsx|js|jsx|go|py|java|rb|cs|sql))(?:[:\s]+(?:line\s+)?(\d+))?/i)

  if (match) {
    const file = match[1] ?? ""
    const line = match[2] ? `:${match[2]}` : ""
    const prefix = service && !file.toLowerCase().includes(service.toLowerCase()) ? `${service}/` : ""

    return `${prefix}${file}${line}`
  }

  return service ? service.trim() || null : null
}

export async function extractDebugFinding(input: DebugFindingInput, context: KnowledgeContext): Promise<ExtractedDecision> {
  const trimmed = input.text.trim()

  if (trimmed.length === 0) {
    throw new Error("DEBUG_FINDING_EMPTY: no finding text to digest.")
  }

  // Debug finding adalah penemuan perilaku yang sudah ada, jadi selalu bertipe implicit_rule.
  return runExtraction(trimmed, context, "implicit_rule")
}
