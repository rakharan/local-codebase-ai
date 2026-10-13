// Expansion
// Refactored from ask.ts — uses ctx for shared state

import type { RelationshipHints } from "../lib/relationships.js"
import { compactRetrievedChunks } from "./compaction.js"
import type { RetrievedChunk } from "./types.js"
import { ctx } from "./context.js"
import { extractQuestionHints, unique } from "./question.js"

export function shouldExpandRetrieval(question: string, hints: RelationshipHints): boolean {
  const lower = question.toLowerCase()
  const asksRelationshipQuestion = [
    "flow",
    "endpoint",
    "route",
    "rpc",
    "amqp",
    "rabbit",
    "queue",
    "exchange",
    "publish",
    "consume",
    "consumer",
    "handler",
    "call",
    "database",
    "table",
    "migration",
    "service",
  ].some(keyword => lower.includes(keyword))

  return (
    asksRelationshipQuestion ||
    extractQuestionHints(question).length > 0 ||
    hints.routes.length > 0 ||
    hints.messageNames.length > 0 ||
    hints.queueNames.length > 0 ||
    hints.exchangeNames.length > 0 ||
    hints.dbTables.length > 0
  )
}


export function shouldExpandExactRouteQuestion(question: string): boolean {
  const lower = question.toLowerCase()

  return ["flow", "rpc", "amqp", "rabbit", "queue", "exchange", "publish", "consume", "consumer", "handler", "call"].some(
    keyword => lower.includes(keyword),
  )
}


export function shouldInspectExactEndpointDetails(question: string): boolean {
  const lower = question.toLowerCase()

  return [
    "body",
    "validation",
    "validate",
    "return",
    "response",
    "payload",
    "service",
    "services",
    "database",
    "table",
    "tables",
    "affected",
    "involved",
    "flow",
  ].some(keyword => lower.includes(keyword)) ||
    /\bwhat does\b.*\bdo\b/i.test(question)
}


export function buildExpansionQueries(question: string, hints: RelationshipHints): string[] {
  const names = unique([
    ...extractQuestionHints(question),
    ...hints.routes,
    ...hints.symbols,
    ...hints.messageNames,
    ...hints.queueNames,
    ...hints.exchangeNames,
    ...hints.dbTables,
  ], 16)

  return unique(
    names.flatMap(name => [
      `${question} ${name}`,
      `${name} route controller handler publisher consumer rpc amqp queue exchange`,
      `${name} database table migration entity sql`,
    ]),
    12,
  )
}


export function mergeChunks(chunks: RetrievedChunk[], maxResults = Math.max(ctx.limit, 12)): RetrievedChunk[] {
  return compactRetrievedChunks(chunks, maxResults)
}
