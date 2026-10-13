/**
 * Model routing: classify query complexity and route to appropriate model.
 *
 * Simple queries (glossary, short definitions, inventory lists) go to a fast
 * local model. Complex queries (how-works, cross-service flow, deep mode)
 * go to the full cloud model.
 *
 * Routing only activates when config.simpleModel is set AND the user did NOT
 * explicitly override --chat-model. Otherwise all queries use config.chatModel.
 */

import { config, setChatModel } from "../lib/config.js"
import { dlog } from "../lib/debug-log.js"

// Simple query patterns: short, factual, no multi-service flow
const SIMPLE_PATTERNS = [
  /^\b(apa\s+itu|what\s+is|what\s+does|apa\s+saja|list|berikan\s+list)\b/i,
  /\b(tipe\s+akun|account\s+types?)\b/i,
  /\b(mt4|mt5)\b/i,
  /\b(apa\s+itu\s+\w{2,4})\b/i, // short acronym definitions
]

// Complex query patterns: multi-hop reasoning, flow tracing, deep analysis
const COMPLEX_PATTERNS = [
  /\b(how\s+(does|do|is)\b.*\b(work|flow|function))/i,
  /\b(bagaimana\s+(alur|cara|flow))/i,
  /\b(cross.?service|flow\s+from|endpoint\s+to)/i,
  /\b(why|kenapa|mengapa|rationale|alasan)/i,
  /\b(trace|investigate|deep\s+dive)/i,
]

/**
 * Classify query complexity and route to appropriate model.
 * Sets config.chatModel via setChatModel().
 *
 * @param question - The user's question
 * @param isDeepMode - Whether --deep flag was passed
 * @param modelOverride - Whether user explicitly set --chat-model (skip routing)
 */
export function routeModel(question: string, isDeepMode: boolean, modelOverride: boolean = false): void {
  // If user explicitly set --chat-model, respect it — no routing
  if (modelOverride) {
    dlog("model-route", { route: "explicit-override", model: config.chatModel })
    return
  }

  // Deep mode always uses the deep model if configured
  if (isDeepMode && config.deepModel) {
    setChatModel(config.deepModel)
    dlog("model-route", { route: "deep", model: config.deepModel })
    return
  }

  // No simple model configured — use default
  if (!config.simpleModel) {
    return
  }

  // Check if query is complex
  const isComplex = COMPLEX_PATTERNS.some(p => p.test(question))
  if (isComplex) {
    dlog("model-route", { route: "complex", model: config.chatModel })
    return // keep default chatModel (the full model)
  }

  // Check if query is simple
  const isSimple = SIMPLE_PATTERNS.some(p => p.test(question))
  if (isSimple) {
    setChatModel(config.simpleModel)
    dlog("model-route", { route: "simple", model: config.simpleModel })
    return
  }

  // Default: keep current model
  dlog("model-route", { route: "default", model: config.chatModel })
}
