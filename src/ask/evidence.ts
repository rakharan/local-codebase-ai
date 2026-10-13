// Evidence
// Refactored from ask.ts — uses ctx for shared state

import { config } from "../lib/config.js"
import type { RetrievedPayload } from "./types.js"
import path from "node:path"
import { ctx } from "./context.js"
import { questionAsksAboutDatabase, questionAsksAboutServicesOrFlow, unique } from "./question.js"

export function extractSqlTableNamesFromContent(content: string): string[] {
  return [
    ...[...content.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+[`"']?([A-Za-z_][\w.]*)[`"']?/gi)].map(match => match[1] ?? ""),
    ...[...content.matchAll(/\b(?:INSERT\s+INTO|DELETE\s+FROM)\s+[`"']?([A-Za-z_][\w.]*)[`"']?/gi)].map(match => match[1] ?? ""),
    ...[...content.matchAll(/\bsqlstr\.(?:insertObject|updateObject)\(\s*["'`]([A-Za-z_][\w.]*)["'`]/g)].map(match => match[1] ?? ""),
    // Doctor markdown table rows: first column is table name
    ...[...content.matchAll(/\|\s*`([a-z_]\w+)`\s*\|\s*(?:table|entity|repository)\s*\|/g)].map(match => match[1] ?? ""),
  ]
}


export function sanitizeTableNames(values: string[], max = 24): string[] {
  const stopWords = new Set([
    "and",
    "as",
    "by",
    "desc",
    "false",
    "from",
    "group",
    "having",
    "join",
    "ctx.limit",
    "null",
    "on",
    "or",
    "order",
    "select",
    "set",
    "status",
    "true",
    "where",
  ])

  return unique(
    values
      .map(value => value.trim().replace(/^[`"']|[`"']$/g, ""))
      .filter(value => value.length > 1)
      .filter(value => !stopWords.has(value.toLowerCase())),
    max,
  )
}


export function buildEvidenceInventory(chunks: RetrievedPayload[], question: string): string {
  const repos = unique(
    chunks.map(chunk => {
      return `${chunk.repoName ?? "unknown"}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}]`
    }),
    16,
  )
  const evidenceTypes = unique(chunks.flatMap(chunk => chunk.evidenceTypes ?? []), 16)
  const confidenceLabels = unique(chunks.map(evidenceConfidenceLabel), 16)
  const routes = unique(chunks.flatMap(chunk => chunk.routes ?? []), 16)
  const symbols = unique(chunks.flatMap(chunk => chunk.symbols ?? []), 24)
  const messageNames = unique(chunks.flatMap(chunk => chunk.messageNames ?? []), 16)
  const queueNames = unique(chunks.flatMap(chunk => chunk.queueNames ?? []), 16)
  const exchangeNames = unique(chunks.flatMap(chunk => chunk.exchangeNames ?? []), 16)
  const dbTables = sanitizeTableNames(
    [
      ...chunks.flatMap(chunk => chunk.dbTables ?? []),
      ...chunks.flatMap(chunk => extractSqlTableNamesFromContent(chunk.content ?? "")),
    ],
    24,
  )
  const asksDb = questionAsksAboutDatabase(question)
  const asksFlow = questionAsksAboutServicesOrFlow(question)
  const derivedFacts = extractCodeDerivedFacts(chunks, 14)
  const dbEvidencePresent = dbTables.length > 0 || evidenceTypes.some(type => type === "raw_sql" || type === "db_model")
  const flowEvidencePresent =
    routes.length > 0 ||
    messageNames.length > 0 ||
    queueNames.length > 0 ||
    exchangeNames.length > 0 ||
    symbols.length > 0 ||
    repos.length > 1

  return [
    `Confirmed repos/services: ${repos.join(", ") || "none"}`,
    `Confirmed evidence types: ${evidenceTypes.join(", ") || "none"}`,
    `Evidence confidence labels: ${confidenceLabels.join(", ") || "none"}`,
    `Confirmed routes: ${routes.join(", ") || "none"}`,
    `Confirmed symbols/functions: ${symbols.join(", ") || "none"}`,
    `Confirmed message/RPC names: ${messageNames.join(", ") || "none"}`,
    `Confirmed queues: ${queueNames.join(", ") || "none"}`,
    `Confirmed exchanges: ${exchangeNames.join(", ") || "none"}`,
    `Confirmed database tables from metadata or SQL: ${dbTables.join(", ") || "none"}`,
    `Database/table evidence requested: ${asksDb ? "yes" : "no"}`,
    `Database/table evidence present: ${dbEvidencePresent ? "yes" : "no"}`,
    `Service/flow evidence requested: ${asksFlow ? "yes" : "no"}`,
    `Service/flow evidence present: ${flowEvidencePresent ? "yes" : "no"}`,
    `Code-derived facts from retrieved lines: ${derivedFacts.length > 0 ? derivedFacts.join(" | ") : "none"}`,
  ].join("\n")
}


export function extractCodeDerivedFacts(chunks: RetrievedPayload[], maxFacts: number): string[] {
  const storedFacts = unique(
    chunks.flatMap(chunk => {
      return (chunk.structuredFacts ?? []).map(fact => {
        return `${fact.category}/${fact.confidence}: ${fact.text} (${chunk.repoName ?? "unknown"}@${chunk.branchName ?? "unknown"} ${chunk.filePath}:${fact.line})`
      })
    }),
    maxFacts,
  )

  if (storedFacts.length > 0) return storedFacts

  const facts: string[] = []
  const factLinePattern = /validationError|request\.body|request\.query|request\.params|req\.body|req\.query|Joi\.|check\(|throw new|return\s+|module\.exports|exports\.\w+|const\s+[A-Z0-9_]{3,}|let\s+[A-Z0-9_]{3,}|var\s+[A-Z0-9_]{3,}|>=|<=|===|!==|\*\s*[a-zA-Z_][\w.]*/i

  for (const chunk of chunks) {
    const content = chunk.content ?? ""
    const lines = content.split(/\r?\n/)

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]?.trim().replace(/\s+/g, " ") ?? ""
      if (line.length < 12 || line.length > 180) continue
      if (!factLinePattern.test(line)) continue
      if (/console\.log|describe\(|it\(|expect\(/i.test(line)) continue

      const lineNumber = (chunk.startLine ?? 1) + index
      facts.push(`${line} (${chunk.repoName ?? "unknown"}@${chunk.branchName ?? "unknown"} ${chunk.filePath}:${lineNumber})`)

      if (facts.length >= maxFacts * 3) break
    }

    if (facts.length >= maxFacts * 3) break
  }

  return unique(facts, maxFacts)
}


export function buildStructuralEvidenceAnswer(chunks: RetrievedPayload[], question: string): string {
  const asksDb = questionAsksAboutDatabase(question)
  const asksFlow = questionAsksAboutServicesOrFlow(question)
  const repos = unique(
    chunks.map(chunk => `${chunk.repoName ?? "unknown"}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}]`),
    16,
  )
  const routes = unique(chunks.flatMap(chunk => chunk.routes ?? []), 16)
  const messages = unique(chunks.flatMap(chunk => chunk.messageNames ?? []), 16)
  const queues = unique(chunks.flatMap(chunk => chunk.queueNames ?? []), 16)
  const exchanges = unique(chunks.flatMap(chunk => chunk.exchangeNames ?? []), 16)
  const tables = sanitizeTableNames(
    [
      ...chunks.flatMap(chunk => chunk.dbTables ?? []),
      ...chunks.flatMap(chunk => extractSqlTableNamesFromContent(chunk.content ?? "")),
    ],
    24,
  )
  const tableSources = chunks
    .filter(chunk => {
      return (chunk.dbTables?.length ?? 0) > 0 || extractSqlTableNamesFromContent(chunk.content ?? "").length > 0
    })
    .slice(0, 10)
    .map(chunk => {
      const sourceTables = sanitizeTableNames([
        ...(chunk.dbTables ?? []),
        ...extractSqlTableNamesFromContent(chunk.content ?? ""),
      ], 12)

      return `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} ${chunk.filePath}:${chunk.startLine}-${chunk.endLine}; tables: ${sourceTables.join(", ")}`
    })
  const evidenceFiles = chunks.slice(0, 12).map(chunk => {
    return `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`
  })

  return [
    "I do not have an exact route/function anchor for this question, so this is an evidence-only retrieval summary, not a confirmed end-to-end flow.",
    "",
    asksFlow ? "Retrieved repos/services with matching evidence:" : undefined,
    asksFlow ? (repos.length > 0 ? repos.map(repo => `- ${repo}`).join("\n") : "- NOT_FOUND_IN_INDEXED_CODEBASE") : undefined,
    asksFlow ? "" : undefined,
    routes.length > 0 ? "Confirmed routes in retrieved evidence:" : undefined,
    routes.length > 0 ? routes.map(route => `- ${route}`).join("\n") : undefined,
    routes.length > 0 ? "" : undefined,
    messages.length > 0 || queues.length > 0 || exchanges.length > 0 ? "Confirmed message/queue evidence:" : undefined,
    messages.length > 0 ? `- messages/RPC names: ${messages.join(", ")}` : undefined,
    queues.length > 0 ? `- queues: ${queues.join(", ")}` : undefined,
    exchanges.length > 0 ? `- exchanges: ${exchanges.join(", ")}` : undefined,
    messages.length > 0 || queues.length > 0 || exchanges.length > 0 ? "" : undefined,
    asksDb ? "Database/table evidence:" : undefined,
    asksDb
      ? tables.length > 0
        ? tables.map(table => `- ${table}`).join("\n")
        : "- NOT_FOUND_IN_INDEXED_CODEBASE: no table names were found in retrieved metadata or SQL"
      : undefined,
    asksDb && tableSources.length > 0 ? "" : undefined,
    asksDb && tableSources.length > 0 ? "Table evidence sources:" : undefined,
    asksDb && tableSources.length > 0 ? tableSources.join("\n") : undefined,
    "",
    "What is still missing:",
    "- An exact endpoint, function name, queue name, or RPC func is needed to confirm a full service-to-service flow.",
    "- Retrieved repos/files alone are not proof that every listed repo participates in the same runtime path.",
    "",
    "Retrieved source set:",
    evidenceFiles.length > 0 ? evidenceFiles.join("\n") : "- NOT_FOUND_IN_INDEXED_CODEBASE",
  ]
    .filter(line => line !== undefined)
    .join("\n")
}


export function payloadSource(chunk: RetrievedPayload): string {
  return `${chunk.repoName}@${chunk.branchName ?? "unknown"} ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} [${evidenceConfidenceLabel(chunk)}]`
}


export function evidenceConfidenceLabel(chunk: RetrievedPayload): string {
  const evidenceTypes = new Set(chunk.evidenceTypes ?? [])
  const filePath = chunk.filePath ?? ""

  if (filePath.startsWith("knowledge-notes://")) {
    if (chunk.noteStatus === "proposal") return "proposal note"
    if (chunk.noteStatus === "deprecated") return "deprecated note"
    return "confirmed note"
  }

  if (filePath.startsWith("decision://")) {
    return chunk.chunk_type === "implicit_rule" ? "implicit rule" : "approved decision"
  }

  if ((chunk.routes?.length ?? 0) > 0 || evidenceTypes.has("api_route")) return "confirmed route"
  if (evidenceTypes.has("controller")) return "confirmed handler code"
  if (evidenceTypes.has("raw_sql")) return "confirmed SQL"
  if (evidenceTypes.has("db_model")) return "confirmed DB model"
  if (evidenceTypes.has("rabbitmq_consumer")) return "confirmed queue consumer"
  if (evidenceTypes.has("rabbitmq_publisher")) return "confirmed queue publisher"
  if (evidenceTypes.has("env_config")) return "confirmed config"
  if (filePath.startsWith("vocabulary://")) return "derived config vocabulary"
  if (evidenceTypes.has("documentation")) return "indexed documentation"
  if (evidenceTypes.has("test")) return "test evidence"

  return "retrieved code"
}
