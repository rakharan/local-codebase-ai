// Metadata Answers
// Refactored from ask.ts — uses ctx for shared state

import { config } from "../lib/config.js"
import type { RelationshipEdge } from "../lib/graph.js"
import { qdrant } from "../lib/qdrant.js"
import type { RetrievedPayload } from "./types.js"
import { ctx } from "./context.js"
import { localized } from "../ask.js"
import { payloadSource } from "./evidence.js"
import { buildFilter } from "./filter.js"
import { edgeSource, edgeTextForConceptSearch, graphScopeAllows } from "./graph-flow.js"
import { extractConceptTokens, extractQuestionHints, unique } from "./question.js"

export function questionAsksForRouteListing(question: string): boolean {
  return /\b(api\s+)?routes?|endpoints?|paths?\b/i.test(question)
}


export function questionAsksNegativeRepoConstraint(question: string): boolean {
  return /\b(repos?|services?)\b/i.test(question) &&
    /\b(do\s+not|does\s+not|don't|not|without)\b/i.test(question) &&
    /\bmt[45]\b/i.test(question)
}


export async function buildNegativeRepoEvidenceAnswer(question: string): Promise<MetadataAnswer | undefined> {
  if (!questionAsksNegativeRepoConstraint(question)) return undefined

  const term = /\bmt4\b/i.test(question) ? "MT4" : "MT5"
  const termPattern = new RegExp(`(?:^|[^a-zA-Z0-9])${term}(?:[^a-zA-Z0-9]|$)|platform_type\\s*[:=]+\\s*${term === "MT4" ? "0" : "(3|5)"}\\b|${term === "MT5" ? "ENABLE_MT5" : "VOLUME_MULTIPLIER\\.MT4"}`, "i")
  const repoStats = new Map<string, { total: number; matching: RetrievedPayload[] }>()
  const filter = buildFilter()
  let offset: string | number | Record<string, unknown> | null | undefined

  do {
    const page = await qdrant.scroll(config.collectionName, {
      limit: 256,
      with_payload: true,
      with_vector: false,
      ...(filter ? { filter } : {}),
      ...(offset ? { offset } : {}),
    })

    for (const point of page.points) {
      const payload = point.payload as RetrievedPayload | null | undefined

      if (!payload?.content || !payload.repoName) continue
      if (!ctx.repoName && payload.repoName === "local-codebase-ai") continue

      const current = repoStats.get(payload.repoName) ?? { total: 0, matching: [] }
      current.total += 1

      const text = [
        payload.filePath ?? "",
        ...(payload.symbols ?? []),
        ...(payload.dbTables ?? []),
        payload.content,
      ].join("\n")

      if (termPattern.test(text) && current.matching.length < 8) {
        current.matching.push(payload)
      }

      repoStats.set(payload.repoName, current)
    }

    offset = page.next_page_offset
  } while (offset)

  if (repoStats.size === 0) return undefined

  const reposWithEvidence = [...repoStats.entries()]
    .filter(([, stats]) => stats.matching.length > 0)
    .sort((left, right) => right[1].matching.length - left[1].matching.length)
  const reposWithoutEvidence = [...repoStats.entries()]
    .filter(([, stats]) => stats.matching.length === 0)
    .sort((left, right) => left[0].localeCompare(right[0]))
  const sources = unique(
    reposWithEvidence.flatMap(([, stats]) =>
      stats.matching.slice(0, 3).map(chunk => `- ${payloadSource(chunk)} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`),
    ),
    20,
  )

  return {
    answer: [
      localized(`Inventory evidence untuk ${term}:`, `${term} evidence inventory:`),
      "",
      localized(
        `Repo dengan evidence ${term}:`,
        `Repos with ${term} evidence:`,
      ),
      reposWithEvidence.length > 0
        ? reposWithEvidence.map(([repoName, stats]) => `- ${repoName} (${stats.matching.length} matching source sample${stats.matching.length === 1 ? "" : "s"})`).join("\n")
        : "- none",
      "",
      localized(
        `Repo tanpa evidence ${term} yang ditemukan di index:`,
        `Repos with no ${term} evidence found in the index:`,
      ),
      reposWithoutEvidence.length > 0
        ? reposWithoutEvidence.slice(0, 50).map(([repoName, stats]) => `- ${repoName} (${stats.total} indexed chunks scanned)`).join("\n")
        : "- none",
      reposWithoutEvidence.length > 50 ? `- ... ${reposWithoutEvidence.length - 50} more repos omitted` : undefined,
      "",
      localized(
        "Catatan: 'tanpa evidence' berarti term tidak muncul di chunk ter-index; itu bukan bukti absolut bahwa repo tidak pernah memakai fitur tersebut.",
        "'No evidence' means the term was not found in indexed chunks; it is not absolute proof that the repo never uses that feature.",
      ),
    ].filter((line): line is string => typeof line === "string").join("\n"),
    sources,
  }
}


export function routeDiscoveryTerms(question: string): string[] {
  const noise = new Set([
    "api",
    "route",
    "routes",
    "endpoint",
    "endpoints",
    "exist",
    "exists",
    "managing",
    "manage",
    "list",
    "show",
    "which",
  ])
  const aliases = new Map([
    ["subscriptions", "subscribe"],
    ["subscription", "subscribe"],
    ["subscribes", "subscribe"],
    ["subscribed", "subscribe"],
  ])

  return unique(
    extractConceptTokens(question)
      .map(term => aliases.get(term) ?? term)
      .filter(term => term.length >= 3)
      .filter(term => !noise.has(term)),
    12,
  )
}


export function buildRouteDiscoveryAnswer(question: string, graph: RelationshipEdge[]): MetadataAnswer | undefined {
  if (!questionAsksForRouteListing(question)) return undefined

  const terms = routeDiscoveryTerms(question)

  if (terms.length === 0) return undefined

  const candidates = graph
    .filter(edge => edge.type === "HANDLES_HTTP_ENDPOINT" && graphScopeAllows(edge) && edge.toRoute)
    .map(edge => {
      const text = edgeTextForConceptSearch(edge)
      const route = edge.toRoute?.toLowerCase() ?? ""
      const matchedTerms = terms.filter(term => {
        return route.includes(term) || text.includes(term)
      })
      let score = matchedTerms.length * 20

      if (matchedTerms.length === 0) return undefined
      if (edge.filePath.toLowerCase().includes("route")) score += 12
      if (route.includes("/ois/")) score += terms.includes("subscribe") ? 12 : 0
      if (terms.every(term => route.includes(term) || text.includes(term))) score += 35

      return { edge, score }
    })
    .filter((candidate): candidate is { edge: RelationshipEdge; score: number } => Boolean(candidate))
    .sort((left, right) => right.score - left.score)
    .slice(0, 24)

  if (candidates.length === 0) return undefined

  const routeLines = unique(
    candidates.map(({ edge }) => {
      return `- ${edge.toRoute}${edge.httpMethod ? ` (${edge.httpMethod})` : ""}${edge.alias ? `; alias: ${edge.alias}` : ""}${edge.handler ? `; handler: ${edge.handler}` : ""}; ${edge.repoName}@${edge.branchName || "unknown"}`
    }),
    24,
  )
  const sources = unique(candidates.map(({ edge }) => `- ${edgeSource(edge)} (${edge.type})`), 24)

  return {
    answer: [
      localized("Route API yang ditemukan dari relationship index:", "API routes found from the relationship index:"),
      routeLines.join("\n"),
      "",
      localized(
        "Catatan: daftar ini berasal dari route handler yang berhasil diekstrak dari kode ter-index.",
        "Note: this list comes from route handlers extracted from indexed code.",
      ),
    ].join("\n"),
    sources,
  }
}


export function questionAsksForCronListing(question: string): boolean {
  return /\b(cron|crons|cron jobs?|jobs?|scheduled|scheduler)\b/i.test(question)
}


export async function buildCronDiscoveryAnswer(question: string, graph: RelationshipEdge[]): Promise<MetadataAnswer | undefined> {
  if (!questionAsksForCronListing(question)) return undefined

  const mentionedRepos = mentionedReposFromQuestion(question, graph)
  const matches: Array<RetrievedPayload & { score: number }> = []
  const filter = buildFilter()
  let offset: string | number | Record<string, unknown> | null | undefined

  do {
    const page = await qdrant.scroll(config.collectionName, {
      limit: 256,
      with_payload: true,
      with_vector: false,
      ...(filter ? { filter } : {}),
      ...(offset ? { offset } : {}),
    })

    for (const point of page.points) {
      const payload = point.payload as RetrievedPayload | null | undefined

      if (!payload?.content) continue

      const text = [
        payload.repoName ?? "",
        payload.filePath ?? "",
        ...(payload.symbols ?? []),
        payload.content,
      ].join("\n")
      const hasCron = /\bCron[A-Z][A-Za-z0-9_]*|cron job|schedule|Every \d+|setInterval|node-cron/i.test(text)

      if (!hasCron) continue

      let score = 20

      if (payload.serviceType === "cron") score += 30
      if (mentionedRepos.includes(payload.repoName ?? "")) score += 50
      if (/cron-jobs/i.test(payload.filePath ?? "")) score += 35
      if (/\bCronCheckAutoCopyTrade\b/.test(text)) score += 25
      if (payload.evidenceTypes?.includes("documentation")) score += 10

      matches.push({ ...payload, score })
    }

    offset = page.next_page_offset
  } while (offset)

  const best = matches.sort((left, right) => right.score - left.score).slice(0, 14)

  if (best.length === 0) return undefined

  const cronNames = unique(
    best.flatMap(chunk => [
      ...(chunk.symbols ?? []).filter(symbol => /^Cron[A-Z]/.test(symbol)),
      ...[...(chunk.content ?? "").matchAll(/\b(Cron[A-Z][A-Za-z0-9_]*)\b/g)].map(match => match[1] ?? ""),
    ]),
    30,
  )
  const repos = unique([
    ...mentionedRepos,
    ...best.map(chunk => chunk.repoName ?? ""),
  ], 16)

  return {
    answer: [
      localized("Cron/job yang ditemukan dari index:", "Cron/jobs found from the index:"),
      repos.length > 0 ? `${localized("Repo terkait:", "Related repos:")} ${repos.join(", ")}` : undefined,
      cronNames.length > 0 ? cronNames.map(name => `- ${name}`).join("\n") : localized("- Nama cron tidak berhasil diekstrak, tetapi ada evidence cron/job pada sources.", "- Cron names were not extracted, but cron/job evidence exists in the sources."),
    ].filter((line): line is string => typeof line === "string").join("\n"),
    sources: unique(best.map(chunk => `- ${payloadSource(chunk)} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`), 14),
  }
}


export function questionAsksFunctionExistence(question: string): boolean {
  return /\b(function|method|symbol)\b/i.test(question) && /\b(does|do|have|exist|exists|ada|punya)\b/i.test(question)
}


export async function buildFunctionExistenceAnswer(question: string, graph: RelationshipEdge[]): Promise<MetadataAnswer | undefined> {
  if (!questionAsksFunctionExistence(question)) return undefined

  const mentionedRepos = mentionedReposFromQuestion(question, graph)
  const noise = new Set(["does", "have", "function", "method", "symbol", "exist", "exists"])
  const terms = unique(
    extractConceptTokens(question)
      .filter(term => !noise.has(term))
      .filter(term => !mentionedRepos.some(repo => repo.toLowerCase().includes(term) || term.includes(repo.toLowerCase()))),
    8,
  )

  if (terms.length === 0) return undefined

  const matches: Array<RetrievedPayload & { score: number }> = []
  const filter = buildFilter()
  let offset: string | number | Record<string, unknown> | null | undefined

  do {
    const page = await qdrant.scroll(config.collectionName, {
      limit: 256,
      with_payload: true,
      with_vector: false,
      ...(filter ? { filter } : {}),
      ...(offset ? { offset } : {}),
    })

    for (const point of page.points) {
      const payload = point.payload as RetrievedPayload | null | undefined

      if (!payload?.content) continue
      if (mentionedRepos.length > 0 && !mentionedRepos.includes(payload.repoName ?? "")) continue

      const text = [
        payload.repoName ?? "",
        payload.filePath ?? "",
        ...(payload.symbols ?? []),
        payload.content ?? "",
      ].join("\n").toLowerCase()

      if (!terms.every(term => text.includes(term.toLowerCase()))) continue

      let score = terms.length * 25

      if (mentionedRepos.includes(payload.repoName ?? "")) score += 40
      if ((payload.symbols?.length ?? 0) > 0) score += 20
      if (/function|=>|async|calculate/i.test(payload.content ?? "")) score += 15

      matches.push({ ...payload, score })
    }

    offset = page.next_page_offset
  } while (offset)

  const best = matches.sort((left, right) => right.score - left.score).slice(0, 10)

  if (best.length === 0) return undefined

  const symbols = unique(best.flatMap(chunk => chunk.symbols ?? []), 20)
  const repos = unique(best.map(chunk => `${chunk.repoName}@${chunk.branchName ?? "unknown"}`), 10)

  return {
    answer: [
      localized("Function/method evidence ditemukan:", "Function/method evidence found:"),
      `${localized("Term:", "Terms:")} ${terms.join(", ")}`,
      `${localized("Repo:", "Repos:")} ${repos.join(", ")}`,
      symbols.length > 0 ? `${localized("Symbols:", "Symbols:")} ${symbols.join(", ")}` : undefined,
      "",
      best.slice(0, 5).map(chunk => `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} ${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`).join("\n"),
    ].filter((line): line is string => typeof line === "string").join("\n"),
    sources: unique(best.map(chunk => `- ${payloadSource(chunk)} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`), 10),
  }
}


export function questionAsksForQueueLookup(question: string): boolean {
  return /\b(queues?|rabbitmq|amqp|pubsub|consumer|consume|consumes|listen|listener|publish|publisher)\b/i.test(question)
}


export function queueTermsFromQuestion(question: string): string[] {
  return unique(
    extractQuestionHints(question)
      .filter(term => /-|queue|pubsub|amqp|rabbit|rpc/i.test(term))
      .filter(term => !/^fa-trade-publisher$/i.test(term)),
    12,
  )
}


export function queueLikeStringsFromContent(content: string): string[] {
  return unique(
    [...content.matchAll(/["'`]([A-Za-z][A-Za-z0-9_.:-]*-[A-Za-z0-9_.:-]+)["'`]/g)]
      .map(match => match[1] ?? "")
      .filter(value => /queue|pubsub|signal|copy|rpc|amqp|trade/i.test(value)),
    20,
  )
}


export function mentionedReposFromQuestion(question: string, graph: RelationshipEdge[]): string[] {
  const lower = question.toLowerCase()
  const graphRepos = unique(graph.map(edge => edge.repoName), 200)
  const registryRepos = unique(ctx.registryExpansion.matchedEntries.flatMap(entry => entry.repos), 200)

  return unique(
    [...graphRepos, ...registryRepos].filter(repo => lower.includes(repo.toLowerCase())),
    50,
  )
}


export async function buildQueueMetadataAnswer(question: string, graph: RelationshipEdge[]): Promise<MetadataAnswer | undefined> {
  if (!questionAsksForQueueLookup(question)) return undefined

  const queueTerms = queueTermsFromQuestion(question)
  const mentionedRepos = mentionedReposFromQuestion(question, graph)

  if (queueTerms.length === 0 && mentionedRepos.length === 0 && !ctx.repoName) return undefined

  const matches: Array<RetrievedPayload & { score: number }> = []
  const filter = buildFilter()
  let offset: string | number | Record<string, unknown> | null | undefined

  do {
    const page = await qdrant.scroll(config.collectionName, {
      limit: 256,
      with_payload: true,
      with_vector: false,
      ...(filter ? { filter } : {}),
      ...(offset ? { offset } : {}),
    })

    for (const point of page.points) {
      const payload = point.payload as RetrievedPayload | null | undefined

      if (!payload?.content) continue
      if (mentionedRepos.length > 0 && !mentionedRepos.includes(payload.repoName ?? "")) continue

      const content = payload.content ?? ""
      const text = [
        payload.repoName ?? "",
        payload.serviceType ?? "",
        payload.filePath ?? "",
        ...(payload.queueNames ?? []),
        ...(payload.messageNames ?? []),
        ...(payload.exchangeNames ?? []),
        content,
      ].join("\n").toLowerCase()
      const hasQueueMetadata = (payload.queueNames?.length ?? 0) > 0 || /queue|consume|consumer|listen|publish|pubsub|amqp|rabbit/i.test(text)
      const queueTermMatch = queueTerms.length > 0 && queueTerms.some(term => text.includes(term.toLowerCase()))
      const repoQueueMatch = queueTerms.length === 0 && mentionedRepos.length > 0 && hasQueueMetadata

      if (!queueTermMatch && !repoQueueMatch) continue

      let score = 0

      if (queueTermMatch) score += 80
      if ((payload.queueNames?.length ?? 0) > 0) score += 30
      if (/(consume|consumer|listen|subscribe)/i.test(content)) score += 24
      if (/(publish|sendToQueue|pubsub|broadcast)/i.test(content)) score += 12
      if (payload.serviceType === "worker") score += 10
      if (mentionedRepos.includes(payload.repoName ?? "")) score += 25
      if (payload.evidenceTypes?.includes("documentation")) score -= queueTermMatch ? 5 : 20

      matches.push({ ...payload, score })
    }

    offset = page.next_page_offset
  } while (offset)

  const best = matches.sort((left, right) => right.score - left.score).slice(0, 16)

  if (best.length === 0) return undefined

  const queues = unique([
    ...queueTerms,
    ...best.flatMap(chunk => chunk.queueNames ?? []),
    ...best.flatMap(chunk => queueLikeStringsFromContent(chunk.content ?? "")),
  ], 24)
  const repos = unique(best.map(chunk => `${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}]`), 16)
  const consumerEvidence = best
    .filter(chunk => /(consume|consumer|listen|subscribe|handler|worker)/i.test(`${chunk.filePath ?? ""}\n${chunk.content ?? ""}`))
    .slice(0, 8)
    .map(chunk => `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} ${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`)
  const publisherEvidence = best
    .filter(chunk => /(publish|publisher|sendToQueue|pubsub|broadcast)/i.test(`${chunk.filePath ?? ""}\n${chunk.content ?? ""}`))
    .slice(0, 8)
    .map(chunk => `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} ${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`)

  return {
    answer: [
      localized("Evidence queue/message yang ditemukan:", "Queue/message evidence found:"),
      queues.length > 0 ? `${localized("Queue/message:", "Queue/message:")} ${queues.join(", ")}` : undefined,
      "",
      localized("Repo/service dengan evidence yang cocok:", "Repos/services with matching evidence:"),
      repos.map(repo => `- ${repo}`).join("\n"),
      "",
      consumerEvidence.length > 0 ? localized("Consumer/listener evidence:", "Consumer/listener evidence:") : undefined,
      consumerEvidence.length > 0 ? unique(consumerEvidence, 8).join("\n") : undefined,
      publisherEvidence.length > 0 ? "" : undefined,
      publisherEvidence.length > 0 ? localized("Publisher evidence:", "Publisher evidence:") : undefined,
      publisherEvidence.length > 0 ? unique(publisherEvidence, 8).join("\n") : undefined,
      "",
      localized(
        "Catatan: ini berdasarkan queue/message metadata dan exact string matches dari kode ter-index.",
        "Note: this is based on queue/message metadata and exact string matches from indexed code.",
      ),
    ].filter((line): line is string => typeof line === "string").join("\n"),
    sources: unique(best.map(chunk => `- ${payloadSource(chunk)} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`), 16),
  }
}


export type MetadataAnswer = {
  answer: string
  sources: string[]
}
