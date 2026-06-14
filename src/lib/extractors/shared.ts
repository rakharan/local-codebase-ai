import { chatJson } from "../ollama.js"
import type { DecisionType, ExtractedDecision, KnowledgeContext } from "./types.js"

const SYSTEM_PROMPT = "You are a technical documentation assistant for a microservice codebase."

// Membatasi daftar agar prompt tidak meledak ukurannya saat service/table sangat banyak.
const MAX_CONTEXT_ITEMS = 200

function clampList(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].slice(0, MAX_CONTEXT_ITEMS)
}

export function buildExtractionPrompt(input: string, context: KnowledgeContext, forceType?: DecisionType): string {
  const serviceList = clampList(context.serviceNames).join(", ") || "(none provided)"
  const tableList = clampList(context.tableNames).join(", ") || "(none provided)"
  const typeInstruction = forceType
    ? `The "type" field MUST be "${forceType}".`
    : `Set "type" to "decision" when something was actively decided, or "implicit_rule" when existing behaviour was discovered.`

  return [
    "Extract structured information from the following input.",
    `Known services: ${serviceList}`,
    `Known tables: ${tableList}`,
    "",
    "Return ONLY valid JSON with these exact fields:",
    "{",
    '  "decision": "one sentence — what was decided or what rule was discovered",',
    '  "context": "what situation or problem led to this",',
    '  "rationale": "why this choice — null if not mentioned",',
    '  "alternatives_rejected": "what else was considered — null if not mentioned",',
    '  "affected_services": ["array", "of", "service names from the known list"],',
    '  "affected_tables": ["array", "of", "table names from the known list"],',
    '  "decision_maker": "person name or null",',
    '  "open_questions": ["array", "of", "questions or gaps in the input"],',
    '  "type": "decision or implicit_rule"',
    "}",
    "",
    "If a field cannot be determined, use null. Do not guess.",
    "Do not add fields not listed above.",
    "Only include services and tables that appear in the known lists above.",
    typeInstruction,
    "",
    "Input:",
    input,
  ].join("\n")
}

function asNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null

  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  if (["null", "unknown", "n/a", "none"].includes(trimmed.toLowerCase())) return null

  return trimmed
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  return [...new Set(
    value
      .map(item => (typeof item === "string" ? item.trim() : ""))
      .filter(item => item.length > 0 && item.toLowerCase() !== "null"),
  )]
}

// Hanya pertahankan service/table yang benar-benar dikenal agar tidak mengarang entitas.
function filterToKnown(values: string[], known: string[]): string[] {
  const knownLookup = new Map(known.map(name => [name.toLowerCase(), name]))

  return [...new Set(
    values
      .map(value => knownLookup.get(value.trim().toLowerCase()))
      .filter((value): value is string => Boolean(value)),
  )]
}

function normalizeType(value: unknown, forceType?: DecisionType): DecisionType {
  if (forceType) return forceType

  return value === "implicit_rule" ? "implicit_rule" : "decision"
}

export function parseExtractionResponse(raw: string, context: KnowledgeContext, forceType?: DecisionType): ExtractedDecision {
  let parsed: Record<string, unknown>

  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw new Error(`EXTRACTION_INVALID_JSON: model did not return valid JSON.\n${raw.slice(0, 500)}`)
  }

  const decision = asNullableString(parsed.decision)

  if (!decision) {
    throw new Error("EXTRACTION_MISSING_DECISION: could not determine a decision from the input.")
  }

  const type = normalizeType(parsed.type, forceType)
  const affectedServices = filterToKnown(asStringArray(parsed.affected_services), context.serviceNames)
  const affectedTables = filterToKnown(asStringArray(parsed.affected_tables), context.tableNames)

  return {
    decision,
    context: asNullableString(parsed.context),
    rationale: type === "implicit_rule" ? null : asNullableString(parsed.rationale),
    alternatives_rejected: type === "implicit_rule" ? null : asNullableString(parsed.alternatives_rejected),
    affected_services: affectedServices,
    affected_tables: affectedTables,
    decision_maker: asNullableString(parsed.decision_maker),
    open_questions: asStringArray(parsed.open_questions),
    type,
  }
}

export async function runExtraction(input: string, context: KnowledgeContext, forceType?: DecisionType): Promise<ExtractedDecision> {
  const prompt = buildExtractionPrompt(input, context, forceType)
  const raw = await chatJson(SYSTEM_PROMPT, prompt)

  return parseExtractionResponse(raw, context, forceType)
}
