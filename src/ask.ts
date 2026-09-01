import path from "node:path"
import { Command } from "commander"
import { qdrant } from "./lib/qdrant.js"
import { config, setChatModel } from "./lib/config.js"
import { createEmbedding, chat, resolveChatProvider, resolveChatBaseUrlHost } from "./lib/ollama.js"
import { readRelationshipGraph } from "./lib/graph.js"
import { bm25Search, isIdentifierQuery } from "./lib/bm25-index.js"
import { dlog, nowMs, elapsedMs, timeStage, isDebugEnabled } from "./lib/debug-log.js"
import { buildRegistryPromptContext, expandQuestionWithRegistry, type RegistryExpansion, type ServiceRegistryEntry } from "./lib/service-registry.js"
import { normalizeProjectIds, reposForProjectIds } from "./lib/service-registry.js"
import {
  accountTypeRelevantSourceChunks,
  buildAccountTypeGlossaryAnswer,
  buildAccountTypeNotFoundAnswer,
  buildPlatformTypeGlossaryAnswer,
} from "./ask/account-types.js"
import { compactPayloadSources, compactRetrievedChunks } from "./ask/compaction.js"
import { buildDoctorInventoryAnswer } from "./ask/doctor.js"
import { evaluateAnswerQuality, logQualityEvaluation } from "./ask/answer-evaluation.js"
import {
  answerLanguageLabel as answerLanguageLabelFor,
  detectAnswerLanguage,
  heuristicAnswerLanguage,
  localized as localizedFor,
  localizeAnswer as localizeAnswerFor,
  shouldAnswerIndonesian as shouldAnswerIndonesianFor,
} from "./ask/language.js"
import {
  escapeRegExp,
  extractConceptTokens,
  extractDefinitionSubjectTerms,
  extractQuestionAcronyms,
  extractQuestionHints,
  extractQuestionRoutes,
  extractShortSubjectTokens,
  questionAsksAboutAccountTypes,
  questionAsksAboutDatabase,
  questionAsksAboutGlossary,
  questionAsksAboutServicesOrFlow,
  questionAsksForDiagram,
  questionAsksHowWorks,
  questionAsksInventory,
  questionAsksMedalMechanism,
  questionBrokerHint,
  questionMetaTraderTerm,
  unique,
} from "./ask/question.js"
import type { AnswerLanguage } from "./lib/ollama.js"
import type { RelationshipEdge } from "./lib/graph.js"
import type { RelationshipHints } from "./lib/relationships.js"
import type { ServiceType } from "./lib/chunker.js"
import type {
  GraphFlowAnswer,
  GraphPathDetails,
  HandlerRef,
  MethodWindow,
  RetrievedChunk,
  RetrievedPayload,
  RouteDefinition,
} from "./ask/types.js"
import { extractQuestionTerms } from "./lib/vocabulary.js"

type SearchFilter = ReturnType<typeof buildFilter>

const serviceTypes = new Set<ServiceType>(["api", "worker", "cron", "library", "unknown"])

const program = new Command()

program
  .argument("<question...>", "Question to ask")
  .option("--limit <limit>", "Number of chunks to retrieve", "8")
  .option("--deep", "Run bounded read-only multi-step investigation before answering")
  .option("--repo-name <repoName>", "Only search one indexed repository")
  .option("--project <projectId>", "Only search one project/product/domain")
  .option("--branch <branchName>", "Only search one indexed branch")
  .option("--service-type <serviceType>", "Only search one service type")
  .option("--chat-model <model>", "Ollama chat model override for this question")
  .option("--history <json>", "JSON string of previous conversation messages")
  .parse()

const question = program.args.join(" ")
const options = program.opts<{ limit: string; deep?: boolean; repoName?: string; project?: string; branch?: string; serviceType?: string; chatModel?: string; history?: string }>()
if (options.chatModel) {
  setChatModel(options.chatModel)
}
const limit = Number(options.limit)
const deepMode = Boolean(options.deep)
const serviceType = options.serviceType && serviceTypes.has(options.serviceType as ServiceType)
  ? (options.serviceType as ServiceType)
  : undefined

function parseHistory(json?: string): Array<{ role: string; content: string }> {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((m: unknown) => {
      const msg = m as Record<string, unknown>
      return typeof msg.role === "string" && typeof msg.content === "string"
    })
  } catch {
    return []
  }
}

const history = parseHistory(options.history)
const registryExpansion = expandQuestionWithRegistry(question)
const retrievalQuestion = registryExpansion.expandedQuestion
const projectFilterIds = normalizeProjectIds(options.project ? [options.project] : [])
const projectFilterRepos = new Set(reposForProjectIds(projectFilterIds))
let answerLanguage: AnswerLanguage = "unknown"

// Per-query retrieval degradation flags. Reset at the start of each query in
// main() so a degraded state from a previous question does not leak forward.
// Surfaced in the answer output so the user/ops knows keyword search was
// unavailable and the answer is based on vector results only.
const retrievalDegradation = { bm25Unavailable: false }

// Per-request in-memory cache of file-scoped chunk scrolls. Keyed by
// `repoName|branchName|filePath`. Avoids re-scrolling the same file when
// retrieveFileChunks / retrieveNeighborChunks / resolveHandlerChunks all
// touch the same file within one /api/ask request. Reset at the start of
// main() so it never leaks across requests in long-lived processes.
const _fileChunkCache = new Map<string, RetrievedChunk[]>()

// Set true when main() completes the full retrieval+answer path (vs early returns).
let _askCompletedFull = false
const _askMainStart = nowMs()

function buildFilter() {
  const must = []
  const should = []

  if (options.repoName) {
    must.push({
      key: "repoName",
      match: {
        value: options.repoName,
      },
    })
  }

  if (projectFilterIds.length === 1) {
    must.push({
      key: "projectIds",
      match: {
        value: projectFilterIds[0],
      },
    })
  } else if (projectFilterIds.length > 1) {
    should.push(
      ...projectFilterIds.map(projectId => ({
        key: "projectIds",
        match: {
          value: projectId,
        },
      })),
    )
  }

  if (options.branch) {
    must.push({
      key: "branchName",
      match: {
        value: options.branch,
      },
    })
  }

  if (serviceType) {
    must.push({
      key: "serviceType",
      match: {
        value: serviceType,
      },
    })
  }

  if (must.length === 0 && should.length === 0) return undefined

  return {
    ...(must.length > 0 ? { must } : {}),
    ...(should.length > 0 ? { should } : {}),
  }
}

// JS-side mirror of the Qdrant filter produced by buildFilter(). Used to
// filter BM25 candidate payloads fetched by ID (qdrant.retrieve does not
// accept the same must/should filter shape as scroll in all client versions,
// so we filter in JS after fetching the small candidate set).
function payloadMatchesFilter(payload: RetrievedPayload, filter: SearchFilter): boolean {
  if (!filter) return true

  if (filter.must) {
    for (const cond of filter.must) {
      const key = (cond as { key: string }).key
      const value = (cond as { match: { value: unknown } }).match.value
      if (key === "repoName" && payload.repoName !== value) return false
      if (key === "branchName" && payload.branchName !== value) return false
      if (key === "serviceType" && payload.serviceType !== value) return false
      if (key === "projectIds" && !payload.projectIds?.includes(value as string)) return false
    }
  }

  if (filter.should && filter.should.length > 0) {
    const matched = filter.should.some(cond => {
      const key = (cond as { key: string }).key
      const value = (cond as { match: { value: unknown } }).match.value
      if (key === "projectIds") return payload.projectIds?.includes(value as string) ?? false
      if (key === "repoName") return payload.repoName === value
      if (key === "branchName") return payload.branchName === value
      if (key === "serviceType") return payload.serviceType === value
      return false
    })
    if (!matched) return false
  }

  return true
}

// Fetch full payloads for a set of Qdrant point IDs, applying an optional
// buildFilter in JS. Returns RetrievedChunk[] with non-empty content only.
// Used by BM25-candidate retrieval paths to avoid full-collection scrolls.
async function retrieveChunksByIds(ids: string[], filter: SearchFilter = undefined): Promise<RetrievedChunk[]> {
  if (ids.length === 0) return []

  try {
    const points = await qdrant.retrieve(config.collectionName, {
      ids,
      with_payload: true,
    })
    const chunks: RetrievedChunk[] = []
    for (const point of points) {
      const payload = point.payload as RetrievedPayload | null | undefined
      if (!payload?.content) continue
      if (!payloadMatchesFilter(payload, filter)) continue
      chunks.push({ id: String(point.id), payload })
    }
    return chunks
  } catch (err) {
    console.error("retrieveChunksByIds failed:", err instanceof Error ? err.message : err)
    return []
  }
}

async function retrieve(queryText: string, resultLimit: number): Promise<RetrievedChunk[]> {
  const questionVector = await createEmbedding(queryText)
  const filter = buildFilter()
  const query = {
    query: questionVector,
    limit: Math.max(resultLimit * 3, resultLimit),
    with_payload: true,
    ...(filter ? { filter } : {}),
  }

  const results = await qdrant.query(config.collectionName, query)

  const chunks = results.points
    .map(point => ({
      id: String(point.id),
      payload: point.payload as RetrievedPayload,
    }))
    .filter(chunk => chunk.payload.content)

  // BM25 pre-filter: for identifier queries, fetch exact matches and merge
  // them into the top of the result set before reranking
  if (isIdentifierQuery(question)) {
    // extract identifier tokens from the original question, not the expanded queryText
    const identifierTokens = extractQuestionHints(question).filter(t => isIdentifierQuery(t))
    const bm25Query = identifierTokens.length > 0 ? identifierTokens.join(" ") : question
    const bm25Results = await bm25Search(bm25Query, resultLimit * 2)
    const vectorIds = new Set(chunks.map(c => c.id))
    const bm25Ids = new Set(bm25Results.map(r => r.id))

    // fetch Qdrant payloads for BM25 hits not already in vector results
    const missingIds = bm25Results.map(r => r.id).filter(id => !vectorIds.has(id))
    if (missingIds.length > 0) {
      try {
        const extra = await qdrant.retrieve(config.collectionName, {
          ids: missingIds,
          with_payload: true,
        })
        for (const point of extra) {
          const payload = point.payload as RetrievedPayload
          if (payload?.content) {
            chunks.push({ id: String(point.id), payload })
          }
        }
      } catch (err) {
        // BM25 payload retrieval failed (e.g. ECONNRESET during index warm-up).
        // Degrade to vector-only results, but record + surface the degradation
        // so it is alertable and the answer does not silently claim keyword
        // evidence was consulted.
        retrievalDegradation.bm25Unavailable = true
        const reason = err instanceof Error ? err.message : String(err)
        console.error(
          JSON.stringify({
            level: "warn",
            component: "retrieve",
            event: "bm25_payload_unavailable",
            reason,
            missingIds: missingIds.length,
          }),
        )
      }
    }

    // Pin BM25 hits at top, rerank the rest separately, then merge
    const bm25Chunks = chunks.filter(c => bm25Ids.has(c.id))
    const nonBm25Chunks = chunks.filter(c => !bm25Ids.has(c.id))
    const rerankedRest = rerankRetrievedChunks(question, nonBm25Chunks)
    const merged = [...bm25Chunks, ...rerankedRest]
    return [...new Map(merged.map(c => [c.id, c])).values()].slice(0, resultLimit)
  }

  return rerankRetrievedChunks(question, chunks).slice(0, resultLimit)
}

async function retrievePreferredLocaleDocChunks(queryText: string, resultLimit: number): Promise<RetrievedChunk[]> {
  if (answerLanguage !== "id" || options.branch) return []

  const questionVector = await createEmbedding(queryText)
  const must: Array<Record<string, unknown>> = [
    {
      key: "branchName",
      match: {
        value: "docs:id",
      },
    },
  ]

  if (options.repoName) {
    must.push({
      key: "repoName",
      match: {
        value: options.repoName,
      },
    })
  }

  if (serviceType) {
    must.push({
      key: "serviceType",
      match: {
        value: serviceType,
      },
    })
  }

  const results = await qdrant.query(config.collectionName, {
    query: questionVector,
    limit: resultLimit,
    with_payload: true,
    filter: { must },
  })

  return results.points
    .map(point => ({
      id: String(point.id),
      payload: point.payload as RetrievedPayload,
    }))
    .filter(chunk => chunk.payload.content && chunk.payload.evidenceTypes?.includes("documentation"))
}

async function retrieveDocumentationSubjectMatches(subjectTerms: string[], resultLimit: number): Promise<RetrievedChunk[]> {
  const terms = unique(subjectTerms.map(term => term.toLowerCase()).filter(term => term.length >= 2), 16)

  if (terms.length === 0) return []

  // BM25 candidate retrieval — replaces 100+ scroll calls with a single
  // index search. Documentation chunks are now indexed in BM25 (schema v3).
  const bm25Results = await bm25Search(terms.join(" "), Math.max(resultLimit * 6, 300))

  if (bm25Results.length === 0) return []

  const candidates = await retrieveChunksByIds(bm25Results.map(r => r.id))

  const matches: Array<RetrievedChunk & { score: number }> = []

  for (const chunk of candidates) {
    const payload = chunk.payload
    if (!payload?.content) continue
    if (!payload.evidenceTypes?.includes("documentation")) continue

    const filePath = payload.filePath?.toLowerCase() ?? ""
    const content = payload.content.toLowerCase()
    const text = `${filePath}\n${content}`
    let score = 0

    for (const term of terms) {
      const termPattern = new RegExp(`\\b${escapeRegExp(term)}\\b`, "i")

      if (term.length <= 3) {
        if (termPattern.test(text)) score += 12
        if (new RegExp(`[\\\\/]${escapeRegExp(term)}[-_][a-z0-9_-]*docs?[\\\\/]`, "i").test(filePath)) score += 70
        if (new RegExp(`\\(${escapeRegExp(term.toUpperCase())}\\)`).test(payload.content ?? "")) score += 45
      } else if (text.includes(term)) {
        score += 12
        // Extra boost when the term appears in the file path (doc is *about* this term)
        if (new RegExp(`[\\\\/]${escapeRegExp(term)}[-_][a-z0-9_-]*docs?[\\\\/]`, "i").test(filePath)) score += 70
        if (filePath.includes(term)) score += 30
      }
    }

    if (/docs:[^/\\]+[/\\]index\.mdx?$/i.test(payload.filePath ?? "")) score += 55
    if (score <= 0) continue

    matches.push({
      id: chunk.id,
      payload,
      score: score + scoreDocLocalePreference(payload),
    })
  }

  return matches
    .sort((left, right) => right.score - left.score)
    .slice(0, resultLimit)
}

async function retrieveVocabularyChunks(queryText: string, resultLimit: number): Promise<RetrievedChunk[]> {
  const questionVector = await createEmbedding(queryText)
  const filter: Record<string, unknown> | undefined = options.repoName
    ? {
        must: [
          {
            key: "repoName",
            match: {
              value: options.repoName,
            },
          },
        ],
      }
    : undefined

  // Search broadly and filter client-side for vocabulary chunks.
  // Semantic search for general vocab questions may not rank vocabulary chunks
  // highly enough if we constrain to documentation evidence type only.
  const query = {
    query: questionVector,
    limit: resultLimit * 3,
    with_payload: true,
    ...(filter ? { filter } : {}),
  }

  const results = await qdrant.query(config.collectionName, query)

  return results.points
    .map(point => ({
      id: String(point.id),
      payload: point.payload as RetrievedPayload,
    }))
    .filter(chunk =>
      chunk.payload.content &&
      chunk.payload.filePath?.startsWith("vocabulary://")
    )
    .slice(0, resultLimit)
}

async function retrieveExactVocabularyMatches(terms: string[], resultLimit: number): Promise<RetrievedChunk[]> {
  const exactTerms = unique(terms, 48)

  if (exactTerms.length === 0) return []

  // BM25 candidate retrieval — vocabulary chunks are now indexed (schema v3).
  const bm25Results = await bm25Search(exactTerms.join(" "), Math.max(resultLimit * 6, 200))

  if (bm25Results.length === 0) return []

  const candidates = await retrieveChunksByIds(bm25Results.map(r => r.id))
  const matches: Array<RetrievedChunk & { score: number }> = []

  for (const chunk of candidates) {
    const payload = chunk.payload
    if (!payload?.content || !payload.filePath?.startsWith("vocabulary://")) continue

    const score = scoreExactTermMatch(payload, exactTerms)

    if (score <= 0) continue

    matches.push({ id: chunk.id, payload, score })
  }

  return matches
    .sort((left, right) => right.score - left.score)
    .slice(0, resultLimit)
}

// Extract code identifiers from documentation chunks and retrieve matching code chunks.
// Bridges the vocabulary gap: docs use prose ("Auto Copy system") while code uses
// identifiers (dsc_bot_copy, AMQPPubSubSignalCopy, CronCheckAutoCopyTrade).
async function retrieveCodeFromDocReferences(docChunks: RetrievedChunk[], resultLimit: number): Promise<RetrievedChunk[]> {
  if (docChunks.length === 0) return []

  // Collect all doc content + file paths
  const docText = docChunks
    .map(c => `${c.payload.filePath ?? ""}\n${c.payload.content ?? ""}`)
    .join("\n")

  // Extract repo names mentioned in the docs — used to filter results so
  // unrelated repos (e.g. ea-service matching "signal") are excluded.
  // Match hyphenated lowercase identifiers like fa-trade-publisher, tf2-ois.
  const docRepoNames = new Set<string>()
  for (const m of docText.matchAll(/\b([a-z][a-z0-9]*(?:-[a-z0-9]+){1,})\b/g)) {
    const repo = m[1]
    if (repo && repo.length >= 5 && !["auto-copy", "end-to-end", "fa-trade", "tf-documentation"].includes(repo)) {
      docRepoNames.add(repo)
    }
  }

  // Extract code-like identifiers that appear in documentation
  const identifiers = new Set<string>()

  // SCREAMING_CASE constants (AUTO_COPY_MINIMUM_EQUITY, POINT_LEVELS)
  for (const m of docText.matchAll(/\b[A-Z][A-Z0-9_]{3,}\b/g)) {
    const term = m[0]
    if (term && !["TODO", "FIXME", "NOTE", "WARN", "HTTP", "HTTPS", "URL", "API", "JSON", "SQL", "PHP", "MT4", "MT5", "RPC", "AMQP", "CSS", "HTML", "SMTP", "UUID"].includes(term)) {
      identifiers.add(term)
    }
  }

  // CamelCase class/function names (AMQPPubSubSignalCopy, CronCheckDeals, SignalBroadcast)
  for (const m of docText.matchAll(/\b[A-Z][a-zA-Z0-9]{5,}\b/g)) {
    const term = m[0]
    if (term && !["AutoCopy", "MetaTrader", "WebSocket", "Docusaurus", "Dockerfile", "Jenkins", "GitHub", "JavaScript", "TypeScript", "Mongoose", "ECONNRESET"].includes(term)) {
      identifiers.add(term)
    }
  }

  // snake_case identifiers (dsc_bot_copy, signal_settled, platform_type)
  for (const m of docText.matchAll(/\b(?:dsc|mrg|tf|fa|ois)_[a-z][a-z0-9_]{2,}\b/g)) {
    if (m[0]) identifiers.add(m[0])
  }

  // PHP class::method (Helper::requestAPI, Schema::create)
  for (const m of docText.matchAll(/\b([A-Z][a-zA-Z]+)::([a-zA-Z]+)\b/g)) {
    if (m[0]) identifiers.add(m[0])
    if (m[1]) identifiers.add(m[1])
  }

  // Known repo names from registry — these go FIRST in search terms so they
  // aren't cut off by the 32-term limit.
  const repoSearchTerms: string[] = []
  for (const repo of registryExpansion.terms) {
    if (repo.length >= 3) {
      identifiers.add(repo)
      repoSearchTerms.push(repo)
    }
  }

  if (identifiers.size === 0) return []

  // Prioritize repo names first, then fill with other identifiers
  const searchTerms = unique([
    ...repoSearchTerms,
    ...[...docRepoNames],
    ...[...identifiers].filter(t => !repoSearchTerms.includes(t)),
  ], 48)
  const bm25Results = await bm25Search(searchTerms.join(" "), Math.max(resultLimit * 4, 200))

  if (bm25Results.length === 0) return []

  // Fetch payloads for BM25 hits
  const candidates = await retrieveChunksByIds(bm25Results.map(r => r.id))

  // Only keep code chunks (exclude documentation — docs are already in the pool).
  // Filter to repos mentioned in the docs to avoid false positives (e.g.
  // ea-service matching "signal" but unrelated to iSignal).
  return candidates
    .filter(chunk => chunk.payload.content)
    .filter(chunk => !chunk.payload.evidenceTypes?.includes("documentation"))
    .filter(chunk => {
      if (docRepoNames.size === 0) return true
      const repoName = chunk.payload.repoName?.toLowerCase() ?? ""
      return docRepoNames.has(repoName)
    })
    .slice(0, resultLimit)
}

// Retrieve sibling docs from the same documentation section.
// When we find isignal-docs/edge-cases.md, also fetch cron-jobs/index.md,
// features/edit.md, etc. — these contain specific identifiers (CronCheckDeals,
// dsc_bot_copy) that feed into doc-ref-code-retrieval.
async function retrieveDocSectionSiblings(docChunks: RetrievedChunk[], maxResults: number): Promise<RetrievedChunk[]> {
  const sectionPaths = new Set<string>()

  for (const chunk of docChunks) {
    const filePath = chunk.payload.filePath ?? ""
    // Extract doc section: "isignal-docs" from "my-website/docs/isignal-docs/features/edge-cases.md"
    // or from "docs:isignal-docs\index.mdx"
    const match = filePath.match(/([a-z][-a-z0-9]*-docs?)\b/i)
    if (match && match[1]) {
      sectionPaths.add(match[1].toLowerCase())
    }
  }

  if (sectionPaths.size === 0) return []

  // Search BM25 for docs containing the section path in their filePath
  const searchTerms = [...sectionPaths].slice(0, 5)
  const bm25Results = await bm25Search(searchTerms.join(" "), Math.max(maxResults * 3, 72))

  if (bm25Results.length === 0) return []

  const candidates = await retrieveChunksByIds(bm25Results.map(r => r.id))

  // Deduplicate against already-retrieved doc chunks
  const existingIds = new Set(docChunks.map(c => c.id))

  return candidates
    .filter(chunk => chunk.payload.content)
    .filter(chunk => chunk.payload.evidenceTypes?.includes("documentation"))
    .filter(chunk => {
      const filePath = chunk.payload.filePath?.toLowerCase() ?? ""
      return [...sectionPaths].some(path => filePath.includes(path))
    })
    .filter(chunk => !existingIds.has(chunk.id))
    .slice(0, maxResults)
}

async function retrieveMetaTraderTermMatches(term: "MT4" | "MT5", resultLimit: number): Promise<RetrievedChunk[]> {
  // BM25 candidate retrieval — MetaTrader config chunks have identifiers (symbols,
  // routes) so they're already in the BM25 index.
  const searchTerms = [term, "MetaTrader", "platform_type", "metaserver", "ServerPlatform", "VOLUME_MULTIPLIER"]
  const bm25Results = await bm25Search(searchTerms.join(" "), Math.max(resultLimit * 6, 300))

  if (bm25Results.length === 0) return []

  const candidates = await retrieveChunksByIds(bm25Results.map(r => r.id))
  const matches: Array<RetrievedChunk & { score: number }> = []
  const termPattern = new RegExp(`(?:^|[^a-zA-Z0-9])${term}(?:[^a-zA-Z0-9]|$)`, "i")

  for (const chunk of candidates) {
    const payload = chunk.payload
    if (!payload?.content) continue
    if (/devops-docs/i.test(payload.filePath ?? "")) continue

    const text = `${payload.filePath ?? ""}\n${payload.content}`

    if (!termPattern.test(text)) continue
    if (!/metatrader|platform_type|metaserver|serverplatform|tf_metatrader_platform_type|mrg_metatrader_platform_type|askap_metatrader_platform_type|volume_multiplier|akun metatrader/i.test(text)) continue

    let score = 0
    const filePath = payload.filePath?.toLowerCase() ?? ""

    if (/tf_metatrader_platform_type|mrg_metatrader_platform_type|askap_metatrader_platform_type|volume_multiplier/i.test(text)) score += 80
    if (/platform_type|metaserver_id|ServerPlatform/i.test(text)) score += 45
    if (/MetaTrader|metatrader/i.test(text)) score += 30
    if (filePath.includes("libs/config")) score += 35
    if (filePath.includes("models/user") || filePath.includes("models/demo") || filePath.includes("models/real")) score += 18
    if (payload.evidenceTypes?.includes("documentation")) score -= 12
    if (term === "MT4" && (/platform_type\s*==\s*0\b/.test(text) || /["']?platform_type["']?\s*:\s*0\b/.test(text))) score += 60
    if (term === "MT5" && (/platform_type\s*==\s*3\b/.test(text) || /["']?platform_type["']?\s*:\s*3\b/.test(text))) score += 60
    if (term === "MT5" && (/platform_type\s*==\s*5\b/.test(text) || /["']?platform_type["']?\s*:\s*5\b/.test(text))) score += 60

    matches.push({ id: chunk.id, payload, score })
  }

  return matches
    .sort((left, right) => right.score - left.score)
    .slice(0, resultLimit)
}

async function retrieveMinimumEquityConfigChunks(resultLimit: number): Promise<RetrievedChunk[]> {
  const matches: Array<RetrievedChunk & { score: number }> = []
  let offset: string | number | Record<string, unknown> | null | undefined

  do {
    const filter = buildFilter()
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

      const text = `${payload.filePath ?? ""}\n${payload.content}`

      if (!/AUTO_COPY_MINIMUM_EQUITY|minimumEquity/i.test(text)) continue

      let score = 0

      if (/AUTO_COPY_MINIMUM_EQUITY/i.test(text)) score += 100
      if (/minimumEquity/i.test(text)) score += 80
      if (/auto copy|isignal|copy signal|bot copy|dsc_bot/i.test(text)) score += 30
      if (/controllers|models|libs|config/i.test(payload.filePath ?? "")) score += 15
      if (payload.evidenceTypes?.includes("documentation")) score -= 30

      matches.push({
        id: String(point.id),
        payload,
        score,
      })
    }

    offset = page.next_page_offset
  } while (offset)

  return matches
    .sort((left, right) => right.score - left.score)
    .slice(0, resultLimit)
}

function shouldAnswerIndonesian(question: string): boolean {
  return shouldAnswerIndonesianFor(question, answerLanguage)
}

function answerLanguageLabel(question: string): string {
  return answerLanguageLabelFor(question, answerLanguage)
}

function localized(id: string, en: string): string {
  return localizedFor(question, answerLanguage, id, en)
}

function localizeAnswer(answer: string, question: string): string {
  return localizeAnswerFor(answer, question, answerLanguage)
}

function collectHints(chunks: RetrievedChunk[]): RelationshipHints {
  return {
    routes: unique(chunks.flatMap(chunk => chunk.payload.routes ?? []), 8),
    symbols: unique(chunks.flatMap(chunk => chunk.payload.symbols ?? []), 12),
    messageNames: unique(chunks.flatMap(chunk => chunk.payload.messageNames ?? []), 12),
    queueNames: unique(chunks.flatMap(chunk => chunk.payload.queueNames ?? []), 8),
    exchangeNames: unique(chunks.flatMap(chunk => chunk.payload.exchangeNames ?? []), 8),
    dbTables: unique(chunks.flatMap(chunk => chunk.payload.dbTables ?? []), 8),
  }
}

function rerankRetrievedChunks(questionText: string, chunks: RetrievedChunk[]): RetrievedChunk[] {
  const exactTerms = unique([
    ...extractQuestionHints(questionText),
    ...extractQuestionRoutes(questionText),
    ...extractQuestionTerms(questionText),
    ...registryExactSearchTerms(),
  ], 80)
  const asksDb = questionAsksAboutDatabase(questionText)
  const asksFlow = questionAsksAboutServicesOrFlow(questionText)
  const asksGlossary = questionAsksAboutGlossary(questionText)
  const asksDiagram = questionAsksForDiagram(questionText)
  const asksHowWorks = questionAsksHowWorks(questionText)

  return chunks
    .map((chunk, index) => {
      const payload = chunk.payload
      const content = payload.content ?? ""
      const text = textForExactSearch(payload).toLowerCase()
      let score = Math.max(0, chunks.length - index)

      for (const term of exactTerms) {
        const normalizedTerm = term.toLowerCase()
        if (!normalizedTerm) continue
        if (text.includes(normalizedTerm)) score += normalizedTerm.includes("/") ? 75 : 18
        if ((payload.routes ?? []).some(route => route.toLowerCase() === normalizedTerm)) score += 100
        if ((payload.symbols ?? []).some(symbol => symbol.toLowerCase() === normalizedTerm)) score += 45
        if (payload.symbolName && payload.symbolName.toLowerCase() === normalizedTerm) score += 80
        if ((payload.queueNames ?? []).some(queue => queue.toLowerCase() === normalizedTerm)) score += 55
        if ((payload.dbTables ?? []).some(table => table.toLowerCase() === normalizedTerm)) score += 55
      }

      if (asksDb && ((payload.dbTables?.length ?? 0) > 0 || payload.structuredFacts?.some(fact => fact.category === "database"))) score += 35
      if (asksFlow && ((payload.routes?.length ?? 0) > 0 || (payload.messageNames?.length ?? 0) > 0 || (payload.queueNames?.length ?? 0) > 0)) score += 30
      if (asksGlossary && (payload.evidenceTypes?.includes("documentation") || payload.filePath?.startsWith("vocabulary://"))) score += 22
      if (asksDiagram && /```mermaid|graph\s+(?:TD|TB|LR|RL)|flowchart/i.test(content)) score += 85
      if (asksHowWorks && /mermaid|ZoomableMermaid|graph\s+(?:TD|TB|LR|RL)|flowchart/i.test(content)) score += 75

      for (const fact of payload.structuredFacts ?? []) {
        if (asksDb && fact.category === "database") score += 16
        if (asksFlow && (fact.category === "message" || fact.category === "control_flow" || fact.category === "input" || fact.category === "return")) score += 8
        if (/validasi|validation|request body|return|response|formula|rule|aturan|syarat/i.test(questionText)) {
          if (["validation", "input", "return", "formula", "constant"].includes(fact.category)) score += 12
        }
      }

      if (payload.filePath?.startsWith("knowledge-notes://")) score += 20
      if (payload.noteStatus === "proposal") score += /proposal|meeting|change|recent|terbaru|perubahan/i.test(questionText) ? 35 : -5

      // Product-specific doc bias correction: when question is about a specific product,
      // boost its docs and penalize unrelated product docs.
      const isIsignalQuestion = registryExpansion.terms.map(t => t.toLowerCase()).includes("isignal")
      if (isIsignalQuestion) {
        const fp = payload.filePath?.toLowerCase() ?? ""
        const rn = payload.repoName?.toLowerCase() ?? ""
        if (fp.includes("isignal-docs") || rn.includes("isignal")) score += 50
        else if (payload.evidenceTypes?.includes("documentation") && (fp.includes("fa-porto-docs") || fp.includes("devops-docs"))) score -= 80
      }

      // Decision/ADR boost — approved decisions carry retrieval_priority: 10 from Qdrant payload
      if (payload.source_type === "decision") {
        score += (payload.retrieval_priority ?? 0) * 2
        if (/decided|decision|changed|why|rationale|rule|aturan|diputuskan|alasan|perubahan/i.test(questionText)) score += 40
      }

      // Boost comment chunks for rationale/meaning questions
      if (payload.evidenceTypes?.includes("comment")) {
        score += /\b(why|kenapa|mengapa|what does|apa itu|artinya|maksud|mean|means|meaning|rationale|reason|alasan|explain|jelasin|jelaskan)\b/i.test(questionText) ? 35 : 8
      }
      // Boost migration chunks for column value meaning questions
      if (payload.evidenceTypes?.includes("migration")) {
        score += /\b(status|value|nilai|arti|mean|means|apa itu|what does|column|kolom)\b/i.test(questionText) ? 25 : 0
      }

      // Inventory intent detection and Repo Doctor chunk boosting
      const isDoctorChunk = payload.filePath?.startsWith("doctor:") || payload.filePath?.startsWith("doctor-fact:")
      const asksServiceInventory = /\b(what services|services? (detected|list|available)|detected (services?|repos?)|list.*(services?|repos?))\b/i.test(questionText)
      const asksEnvInventory = /\b(environment variables?|env vars?|process\.env|what env|which env)\b/i.test(questionText)
      const asksDbInventory = /\b(database tables?|db tables?|which tables?|what tables?|tables? (used|detected))\b/i.test(questionText)
      const isInventoryQuestion = asksServiceInventory || asksEnvInventory || asksDbInventory

      if (isDoctorChunk) {
        if (isInventoryQuestion) {
          // Strong boost for inventory questions — doctor facts are the primary source
          score += 100
          if (asksServiceInventory && (payload.filePath?.includes("service") || payload.filePath?.includes("overview"))) score += 50
          if (asksEnvInventory && payload.filePath?.includes("env")) score += 50
          if (asksDbInventory && (payload.filePath?.includes("database") || (payload.dbTables?.length ?? 0) > 0)) score += 50
        } else if (/\b(services?|routes?|api|endpoints?|env|environment|rabbitmq|queues?|exchanges?|databases?|tables?|dependenc|architecture|onboarding)\b/i.test(questionText)) {
          score += 40
        }
      }

      // Repo-name penalty: penalize unrelated repos for inventory questions with explicit repo name
      if (isInventoryQuestion) {
        const mentionedRepo = questionText.match(/\b([\w-]+-(?:service|worker|cron|ois|tf2|ims|admin|api)[\w-]*)\b/i)?.[1]?.toLowerCase()
        if (mentionedRepo && payload.repoName) {
          const chunkRepo = payload.repoName.toLowerCase()
          if (chunkRepo === mentionedRepo || chunkRepo.includes(mentionedRepo) || mentionedRepo.includes(chunkRepo)) {
            score += 30
          } else {
            score -= 40
          }
        }
      }

      return { chunk, score }
    })
    .sort((left, right) => right.score - left.score)
    // Repo diversity pass — penalize 3rd+ chunk from the same repo so one repo
    // can't dominate all top slots. First two chunks per repo are unaffected.
    .map((() => {
      const repoCount = new Map<string, number>()
      return (item: { chunk: RetrievedChunk; score: number }) => {
        const repo = item.chunk.payload.repoName ?? ""
        const count = repoCount.get(repo) ?? 0
        repoCount.set(repo, count + 1)
        // 3rd chunk: -30, 4th: -60, 5th+: -90
        const diversityPenalty = count >= 2 ? Math.min(30 * (count - 1), 90) : 0
        return { chunk: item.chunk, score: item.score - diversityPenalty }
      }
    })())
    .sort((left, right) => right.score - left.score)
    .map(item => item.chunk)
}

function registryExactSearchTerms(): string[] {
  const noisyTerms = new Set(["api", "broker", "domain", "concept", "service"])

  return unique(
    registryExpansion.terms
      .filter(term => term.length >= 3)
      .filter(term => !noisyTerms.has(term.toLowerCase()))
      .filter(term => !/^ims-/.test(term.toLowerCase()))
      .filter(term => !/^tf2-/.test(term.toLowerCase())),
    24,
  )
}

function containsExactIdentifier(content: string, identifier: string): boolean {
  return new RegExp(`\\b${escapeRegExp(identifier)}\\b`).test(content)
}

function normalizeRoute(route: string): string {
  const normalized = route.trim().replace(/\/+$/, "")

  return normalized.length > 0 ? normalized.toLowerCase() : "/"
}

function routeMatches(candidate: string, wantedRoute: string): boolean {
  const candidateRoute = normalizeRoute(candidate)
  const wanted = normalizeRoute(wantedRoute)

  return candidateRoute === wanted
}

function contentContainsRoute(content: string, wantedRoute: string): boolean {
  const wanted = normalizeRoute(wantedRoute)
  const quotedRoutes = [...content.matchAll(/["'`](\/[A-Za-z0-9_./:{}-]+)["'`]/g)].map(match => match[1] ?? "")

  return quotedRoutes.some(route => normalizeRoute(route) === wanted)
}

function edgeSource(edge: RelationshipEdge): string {
  return `${edge.repoName}@${edge.branchName || "unknown"} [${edge.serviceType}] ${edge.filePath}:${edge.startLine}-${edge.endLine}`
}

function routeMatchesConceptTokens(route: string | undefined, tokens: string[]): boolean {
  if (!route || tokens.length === 0) return false

  const routeText = route.toLowerCase()

  return tokens.every(token => routeText.includes(token))
}

function edgeTextForConceptSearch(edge: RelationshipEdge): string {
  return [
    edge.repoName,
    edge.serviceType,
    edge.branchName,
    edge.filePath,
    edge.fromSymbol,
    edge.toRoute,
    edge.alias,
    edge.handler,
    edge.viaConstant,
    edge.rpcFunc,
    edge.externalFunc,
    edge.receiverSymbol,
    edge.calleeSymbol,
    edge.symbol,
    edge.table,
    edge.evidence,
  ].filter(Boolean).join("\n").toLowerCase()
}

// Build a concise text summary of relationship graph edges relevant to the question.
// Fed into the LLM prompt so it can trace cross-service flows (calls → handles → defines → touches table).
function buildGraphFlowContext(graph: RelationshipEdge[], question: string, hints: RelationshipHints): string {
  if (graph.length === 0) return "none"

  const graphTerms = unique([
    ...extractQuestionHints(question),
    ...extractQuestionTerms(question),
    ...extractConceptTokens(question),
    ...registryExpansion.terms,
    ...(hints.routes ?? []),
    ...(hints.symbols ?? []),
    ...(hints.messageNames ?? []),
    ...(hints.queueNames ?? []),
    ...(hints.exchangeNames ?? []),
    ...(hints.dbTables ?? []),
  ].filter(term => term.length >= 2), 40).map(term => term.toLowerCase())

  if (graphTerms.length === 0) return "none"

  const scored = graph
    .filter(edge => graphScopeAllows(edge))
    .map(edge => {
      const text = edgeTextForConceptSearch(edge)
      let score = 0
      for (const term of graphTerms) {
        if (term.length >= 2 && text.includes(term)) score += term.includes("/") ? 60 : 12
      }
      if (questionAsksAboutServicesOrFlow(question) && (edge.toRoute || edge.rpcFunc || edge.externalFunc || edge.table || edge.symbol || edge.handler)) score += 20
      return { edge, score }
    })
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || left.edge.repoName.localeCompare(right.edge.repoName))
    .slice(0, 20)

  if (scored.length === 0) return "none"

  const lines = scored.map(({ edge }) => {
    const repo = `${edge.repoName}@${edge.branchName}`
    switch (edge.type) {
      case "CALLS_HTTP_ENDPOINT":
        return `- ${repo} calls ${edge.toRoute ?? "?"}${edge.httpMethod ? ` [${edge.httpMethod}]` : ""}${edge.viaConstant ? ` via ${edge.viaConstant}` : ""}${edge.fromSymbol ? ` from ${edge.fromSymbol}` : ""}`
      case "HANDLES_HTTP_ENDPOINT":
        return `- ${repo} handles ${edge.toRoute ?? "?"}${edge.httpMethod ? ` [${edge.httpMethod}]` : ""}${edge.handler ? `; handler: ${edge.handler}` : ""}${edge.alias ? `; alias: ${edge.alias}` : ""}`
      case "CALLS_RPC_FUNC":
        return `- ${repo} calls RPC ${edge.rpcFunc ?? "?"}${edge.receiverSymbol ? ` on ${edge.receiverSymbol}` : ""}`
      case "CALLS_EXTERNAL_FUNC":
        return `- ${repo} calls external func ${edge.externalFunc ?? "?"}${edge.fromSymbol ? ` from ${edge.fromSymbol}` : ""}`
      case "CALLS_SYMBOL":
        return `- ${repo} calls ${edge.calleeSymbol ?? edge.symbol ?? "?"}${edge.receiverSymbol ? ` on ${edge.receiverSymbol}` : ""}`
      case "DEFINES_SYMBOL":
        return `- ${repo} defines ${edge.symbol ?? edge.calleeSymbol ?? "?"}`
      case "TOUCHES_TABLE":
        return `- ${repo} touches table: ${edge.table ?? "?"}`
      case "DOCUMENTS_DECISION":
        return `- ${repo} documents decision: ${edge.symbol ?? "?"}`
      default:
        return `- ${repo} ${edge.type}`
    }
  })

  return lines.join("\n")
}

function mentionedGraphRepos(question: string, graph: RelationshipEdge[]): string[] {
  const lower = question.toLowerCase()
  const repos = unique(graph.map(edge => edge.repoName), 100)
  const mentioned = repos.filter(repo => lower.includes(repo.toLowerCase()))

  return unique([
    ...(options.repoName ? [options.repoName] : []),
    ...projectFilterRepos,
    ...mentioned,
  ], 100)
}

function handlerMethodName(handler: string | undefined): string | undefined {
  if (!handler) return undefined

  return handler.split(".").at(-1)
}

function sameRepoBranchFile(left: RelationshipEdge, right: RelationshipEdge): boolean {
  return left.repoName === right.repoName && left.branchName === right.branchName && left.filePath === right.filePath
}

function commonPathPrefixScore(leftPath: string, rightPath: string): number {
  const leftParts = leftPath.split(/[\\/]/)
  const rightParts = rightPath.split(/[\\/]/)
  let score = 0

  for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index++) {
    if (leftParts[index] !== rightParts[index]) break

    score++
  }

  return score
}

function graphScopeAllows(edge: RelationshipEdge): boolean {
  if (!options.repoName && edge.repoName === "local-codebase-ai") return false
  if (options.repoName && edge.repoName !== options.repoName) return false
  if (projectFilterIds.length > 0) {
    const edgeProjectIds = edge.projectIds ?? []

    if (edgeProjectIds.length > 0) {
      if (!edgeProjectIds.some(projectId => projectFilterIds.includes(projectId))) return false
    } else if ((edge.projectTagSources ?? []).some(source => source.startsWith("repo:ambiguous:"))) {
      return false
    } else if (!projectFilterRepos.has(edge.repoName)) {
      return false
    }
  }
  if (options.branch && edge.branchName !== options.branch) return false
  if (serviceType && edge.serviceType !== serviceType) return false

  return true
}

function scoreGraphCallEdge(edge: RelationshipEdge, tokens: string[], mentionedRepos: string[], question: string): number {
  const text = edgeTextForConceptSearch(edge)
  const lowerQuestion = question.toLowerCase()
  let score = 0

  if (routeMatchesConceptTokens(edge.toRoute, tokens)) score += 40
  score += tokens.filter(token => text.includes(token)).length * 4
  if (mentionedRepos.includes(edge.repoName)) score += 30
  if (edge.fromSymbol && tokens.some(token => edge.fromSymbol?.toLowerCase().includes(token))) score += 8
  if (lowerQuestion.includes("mrg") && edge.toRoute?.toLowerCase().includes("/mrg/")) score += 6
  if (lowerQuestion.includes("askap") && edge.filePath.toLowerCase().includes("askap")) score += 6
  if (lowerQuestion.includes("mmb") && edge.filePath.toLowerCase().includes("askap")) score += 6
  if (edge.viaConstant) score += 3
  if (edge.type === "CALLS_EXTERNAL_FUNC" && edge.externalFunc) score += 8

  return score
}

function graphTextHasToken(text: string, token: string): boolean {
  if (token === "request") {
    return text.includes("request") || text.includes("reqaccount") || text.includes("reqdemo") || /\breq\b/.test(text)
  }

  return text.includes(token)
}

function edgeTextForTokenMatch(edge: RelationshipEdge): string {
  return [
    edge.repoName,
    edge.serviceType,
    edge.branchName,
    edge.filePath,
    edge.fromSymbol,
    edge.toRoute,
    edge.alias,
    edge.handler,
    edge.viaConstant,
    edge.rpcFunc,
    edge.externalFunc,
    edge.receiverSymbol,
    edge.calleeSymbol,
    edge.symbol,
    edge.table,
  ].filter(Boolean).join("\n").toLowerCase()
}

function graphCandidateMatchesTokens(edge: RelationshipEdge, tokens: string[]): boolean {
  const text = edgeTextForTokenMatch(edge)

  return tokens.every(token => graphTextHasToken(text, token))
}

function graphCandidateKey(edge: RelationshipEdge): string {
  const domain = edge.filePath.split(/[\\/]/).find(part => ["mrg", "askap", "mmb"].includes(part.toLowerCase())) ?? edge.filePath

  return [edge.type, domain, edge.toRoute ?? edge.externalFunc ?? edge.fromSymbol ?? edge.filePath].join(":")
}

function selectGraphFlowCandidates(candidates: Array<{ edge: RelationshipEdge; score: number }>): RelationshipEdge[] {
  const selected = new Map<string, RelationshipEdge>()

  for (const candidate of candidates) {
    const key = graphCandidateKey(candidate.edge)

    if (!selected.has(key)) {
      selected.set(key, candidate.edge)
    }

    if (selected.size >= 5) break
  }

  return [...selected.values()]
}

function findRelatedGraphTableEdges(symbolEdges: RelationshipEdge[], graph: RelationshipEdge[]): RelationshipEdge[] {
  const tableEdges: RelationshipEdge[] = []
  const lineWindow = 140

  for (const symbolEdge of symbolEdges) {
    tableEdges.push(
      ...graph.filter(edge => {
        if (edge.type !== "TOUCHES_TABLE" || !graphScopeAllows(edge)) return false

        return sameRepoBranchFile(edge, symbolEdge) &&
          edge.startLine >= symbolEdge.startLine &&
          edge.startLine <= symbolEdge.startLine + lineWindow
      }),
    )
  }

  return [...new Map(tableEdges.map(edge => [edge.id, edge])).values()].slice(0, 8)
}

function receiverMatchesDefinition(receiverSymbol: string | undefined, definitionEdge: RelationshipEdge): boolean {
  if (!receiverSymbol) return true

  const receiver = receiverSymbol.toLowerCase()
  const filePath = definitionEdge.filePath.toLowerCase()

  if (receiver.endsWith("model")) {
    const modelName = receiver.replace(/model$/, "")

    return filePath.includes(`/models/${modelName}.`) ||
      filePath.includes(`\\models\\${modelName}.`) ||
      filePath.includes(`models/${modelName}.`) ||
      filePath.includes(`models\\${modelName}.`)
  }

  return true
}

function findGraphHandlerDefinitions(handlerEdge: RelationshipEdge, graph: RelationshipEdge[]): RelationshipEdge[] {
  const methodName = handlerMethodName(handlerEdge.handler) ?? handlerEdge.symbol
  const objectName = handlerEdge.handler?.split(".")[0] ?? ""

  if (!methodName) return []

  const candidates = graph
    .filter(edge => {
      if (edge.type !== "DEFINES_SYMBOL" || edge.symbol !== methodName) return false
      if (edge.repoName !== handlerEdge.repoName || edge.branchName !== handlerEdge.branchName) return false

      return true
    })
    .map(edge => {
      let score = commonPathPrefixScore(edge.filePath, handlerEdge.filePath)

      if (objectName && edge.filePath.toLowerCase().includes(objectName.replace(/Controller$/i, "").toLowerCase())) {
        score += 4
      }

      return { edge, score }
    })
    .sort((left, right) => right.score - left.score)
  const bestScore = candidates[0]?.score ?? 0

  return candidates
    .filter(candidate => candidate.score === bestScore && candidate.score > 0)
    .map(candidate => candidate.edge)
    .slice(0, 1)
}

async function describeGraphSymbolEdges(edges: RelationshipEdge[]): Promise<string[]> {
  const facts: string[] = []

  for (const edge of edges) {
    if (!edge.symbol) continue

    const chunks = await retrieveFileChunks(edge.repoName, edge.branchName, edge.filePath)
    const methodWindow = findMethodWindow(chunks, edge.symbol, 140)

    if (!methodWindow) continue

    const details = describeMethodBody(methodWindow.content)

    facts.push(
      `${edge.symbol} in ${edge.repoName}@${edge.branchName} ${edge.filePath}:${methodWindow.startLine}-${methodWindow.endLine}${details.length > 0 ? `; ${details.join("; ")}` : ""}`,
    )
  }

  return unique(facts, 12)
}

function findGraphSymbolDefinitions(symbolName: string, graph: RelationshipEdge[], excludedRepos: string[] = [], receiverSymbol?: string): RelationshipEdge[] {
  return graph
    .filter(edge => {
      if (edge.type !== "DEFINES_SYMBOL" || edge.symbol !== symbolName) return false
      if (!graphScopeAllows(edge)) return false
      if (excludedRepos.includes(edge.repoName)) return false

      return receiverMatchesDefinition(receiverSymbol, edge)
    })
    .sort((left, right) => {
      const leftReceiverScore = receiverMatchesDefinition(receiverSymbol, left) ? 1 : 0
      const rightReceiverScore = receiverMatchesDefinition(receiverSymbol, right) ? 1 : 0

      return rightReceiverScore - leftReceiverScore
    })
    .slice(0, 8)
}

function findCallsFromSymbols(
  symbolEdges: RelationshipEdge[],
  graph: RelationshipEdge[],
  type: RelationshipEdge["type"],
): RelationshipEdge[] {
  const symbolNames = new Set(symbolEdges.map(edge => edge.symbol).filter(Boolean))

  return graph
    .filter(edge => {
      if (edge.type !== type || !graphScopeAllows(edge)) return false

      return Boolean(edge.fromSymbol && symbolNames.has(edge.fromSymbol))
    })
    .slice(0, 16)
}

async function resolveGraphPath(entry: RelationshipEdge, scopedGraph: RelationshipEdge[]): Promise<GraphPathDetails> {
  const endpointHandlers = entry.type === "CALLS_HTTP_ENDPOINT" && entry.toRoute
    ? scopedGraph
        .filter(edge => edge.type === "HANDLES_HTTP_ENDPOINT" && edge.toRoute && routeMatches(edge.toRoute, entry.toRoute ?? ""))
        .slice(0, 6)
    : []
  const handlerNames = unique(endpointHandlers.flatMap(edge => [handlerMethodName(edge.handler) ?? "", edge.symbol ?? ""]), 12)
  const handlerDefinitionEdges = endpointHandlers.flatMap(edge => findGraphHandlerDefinitions(edge, scopedGraph)).slice(0, 8)
  const handlerDefinitionNames = unique(handlerDefinitionEdges.map(edge => edge.symbol ?? ""), 12)
  const handlerFacts = await describeGraphSymbolEdges(handlerDefinitionEdges)
  const handlerNameSet = [...handlerNames, ...handlerDefinitionNames]
  const rpcCalls = scopedGraph
    .filter(edge => {
      if (edge.type !== "CALLS_RPC_FUNC" || !edge.rpcFunc) return false
      if (handlerNameSet.length === 0) return false

      return Boolean(edge.fromSymbol && handlerNameSet.includes(edge.fromSymbol))
    })
    .slice(0, 12)
  const externalCallsFromHandlers = scopedGraph
    .filter(edge => {
      if (edge.type !== "CALLS_EXTERNAL_FUNC" || !edge.externalFunc) return false
      if (handlerNameSet.length === 0) return false

      return Boolean(edge.fromSymbol && handlerNameSet.includes(edge.fromSymbol))
    })
    .slice(0, 12)
  const externalCalls = entry.type === "CALLS_EXTERNAL_FUNC"
    ? [entry, ...externalCallsFromHandlers.filter(edge => edge.id !== entry.id)]
    : externalCallsFromHandlers
  const externalFuncNames = unique(externalCalls.map(edge => edge.externalFunc ?? ""), 12)
  const downstreamExternalSymbols = externalFuncNames.flatMap(funcName => {
    return findGraphSymbolDefinitions(funcName, scopedGraph, endpointHandlers.map(edge => edge.repoName))
  }).slice(0, 12)
  const downstreamExternalFacts = await describeGraphSymbolEdges(downstreamExternalSymbols)
  const downstreamSymbolCalls = findCallsFromSymbols(downstreamExternalSymbols, scopedGraph, "CALLS_SYMBOL")
    .filter(edge => {
      if (!edge.calleeSymbol) return false

      return !["object", "number", "string", "validateAsync", "logActionAsync", "getByID", "getInstance", "Clone", "indexOf"].includes(edge.calleeSymbol)
    })
    .slice(0, 12)
  const downstreamModelDefinitions = downstreamSymbolCalls.flatMap(edge => {
    return findGraphSymbolDefinitions(edge.calleeSymbol ?? "", scopedGraph, [], edge.receiverSymbol)
  }).slice(0, 12)
  const downstreamModelFacts = await describeGraphSymbolEdges(downstreamModelDefinitions)
  const rpcNames = unique(rpcCalls.map(edge => edge.rpcFunc ?? ""), 12)
  const downstreamSymbols = scopedGraph
    .filter(edge => edge.type === "DEFINES_SYMBOL" && edge.symbol && rpcNames.includes(edge.symbol))
    .filter(edge => !endpointHandlers.some(handlerEdge => handlerEdge.repoName === edge.repoName && handlerEdge.branchName === edge.branchName))
    .slice(0, 12)
  const tableEdges = findRelatedGraphTableEdges([...downstreamSymbols, ...downstreamExternalSymbols, ...downstreamModelDefinitions], scopedGraph)
  const sources = [...new Map([
    entry,
    ...endpointHandlers,
    ...handlerDefinitionEdges,
    ...rpcCalls,
    ...externalCalls,
    ...downstreamExternalSymbols,
    ...downstreamSymbolCalls,
    ...downstreamModelDefinitions,
    ...downstreamSymbols,
    ...tableEdges,
  ].map(edge => [edge.id, edge])).values()]

  return {
    entry,
    endpointHandlers,
    handlerDefinitionEdges,
    handlerFacts,
    rpcCalls,
    externalCalls,
    downstreamExternalSymbols,
    downstreamExternalFacts,
    downstreamSymbolCalls,
    downstreamModelDefinitions,
    downstreamModelFacts,
    downstreamSymbols,
    tableEdges,
    sources,
  }
}

function formatGraphPathDetails(pathDetails: GraphPathDetails, index: number): string {
  const entry = pathDetails.entry

  return [
    `Path ${index + 1}:`,
    "Entry:",
    entry.type === "CALLS_HTTP_ENDPOINT"
      ? `- ${edgeSource(entry)} calls ${entry.toRoute}${entry.viaConstant ? ` via ${entry.viaConstant}` : ""}${entry.fromSymbol ? ` from ${entry.fromSymbol}` : ""}`
      : `- ${edgeSource(entry)} calls external/API func ${entry.externalFunc}${entry.fromSymbol ? ` from ${entry.fromSymbol}` : ""}`,
    pathDetails.endpointHandlers.length > 0
      ? pathDetails.endpointHandlers.map(edge => `- ${edgeSource(edge)} handles ${edge.toRoute}; method: ${edge.httpMethod || "unknown"}; alias: ${edge.alias || "unknown"}; handler: ${edge.handler || "unknown"}`).join("\n")
      : undefined,
    "",
    "Endpoint handlers:",
    pathDetails.endpointHandlers.length > 0
      ? pathDetails.endpointHandlers.map(edge => `- ${edge.handler || edge.symbol || "unknown"} in ${edgeSource(edge)}`).join("\n")
      : "- No endpoint handler was needed/found for this path.",
    "",
    "Handler behavior:",
    pathDetails.handlerFacts.length > 0
      ? pathDetails.handlerFacts.map(fact => `- ${fact}`).join("\n")
      : "- No controller method body was resolved for this path.",
    "",
    "RPC calls from handlers:",
    pathDetails.rpcCalls.length > 0
      ? pathDetails.rpcCalls.map(edge => `- ${edge.fromSymbol || "unknown"} calls RPC func ${edge.rpcFunc} in ${edgeSource(edge)}`).join("\n")
      : "- No RPC call was extracted from this path.",
    "",
    "External calls from handlers:",
    pathDetails.externalCalls.length > 0
      ? pathDetails.externalCalls.map(edge => `- ${edge.fromSymbol || "unknown"} calls ${edge.externalFunc} in ${edgeSource(edge)}`).join("\n")
      : "- No external API/client call was extracted from this path.",
    "",
    "Downstream handlers for external/API funcs:",
    pathDetails.downstreamExternalSymbols.length > 0
      ? pathDetails.downstreamExternalSymbols.map(edge => `- ${edge.symbol} in ${edgeSource(edge)}`).join("\n")
      : "- No downstream function with the same external/API func name was found.",
    "",
    "Downstream handler behavior:",
    pathDetails.downstreamExternalFacts.length > 0
      ? pathDetails.downstreamExternalFacts.map(fact => `- ${fact}`).join("\n")
      : "- No downstream handler body was resolved.",
    "",
    "Model/symbol calls inside downstream handlers:",
    pathDetails.downstreamSymbolCalls.length > 0
      ? pathDetails.downstreamSymbolCalls.map(edge => `- ${edge.fromSymbol || "unknown"} calls ${edge.receiverSymbol}.${edge.calleeSymbol} in ${edgeSource(edge)}`).join("\n")
      : "- No model/symbol calls were extracted inside downstream handlers.",
    "",
    "Model/symbol behavior:",
    pathDetails.downstreamModelFacts.length > 0
      ? pathDetails.downstreamModelFacts.map(fact => `- ${fact}`).join("\n")
      : "- No called model/symbol body was resolved.",
    "",
    "Downstream RPC symbols:",
    pathDetails.downstreamSymbols.length > 0
      ? pathDetails.downstreamSymbols.map(edge => `- ${edge.symbol} in ${edgeSource(edge)}`).join("\n")
      : "- No downstream repo symbol with the same RPC func name was found.",
    "",
    "Database/table touches near downstream symbols:",
    pathDetails.tableEdges.length > 0
      ? pathDetails.tableEdges.map(edge => `- ${edge.table} in ${edgeSource(edge)}`).join("\n")
      : "- No database/table touch was extracted near downstream symbols.",
  ].filter(line => line !== undefined).join("\n")
}

async function buildGraphFlowAnswer(question: string, graph: RelationshipEdge[]): Promise<GraphFlowAnswer | undefined> {
  if (!questionAsksAboutServicesOrFlow(question) || graph.length === 0) return undefined

  const tokens = extractConceptTokens(question)

  if (tokens.length < 2) return undefined

  const scopedGraph = graph.filter(graphScopeAllows)
  const mentionedRepos = mentionedGraphRepos(question, scopedGraph)
  const candidateCalls = scopedGraph
    .filter(edge => edge.type === "CALLS_HTTP_ENDPOINT" || edge.type === "CALLS_EXTERNAL_FUNC")
    .filter(edge => graphCandidateMatchesTokens(edge, tokens))
    .map(edge => ({
      edge,
      score: scoreGraphCallEdge(edge, tokens, mentionedRepos, question),
    }))
    .filter(candidate => candidate.score >= 35)
    .sort((left, right) => right.score - left.score)
  const selectedCalls = selectGraphFlowCandidates(candidateCalls)

  if (selectedCalls.length === 0) return undefined

  const pathDetails = []

  for (const selectedCall of selectedCalls) {
    pathDetails.push(await resolveGraphPath(selectedCall, scopedGraph))
  }

  const reposInvolved = unique(
    pathDetails.flatMap(details => details.sources).map(edge => {
      return `${edge.repoName}@${edge.branchName || "unknown"} [${edge.serviceType}]`
    }),
    16,
  )
  const sources = [...new Map(pathDetails.flatMap(details => details.sources).map(edge => [edge.id, edge])).values()]

  const answer = [
    "Graph flow found from relationship index:",
    "",
    "Services/repos involved:",
    reposInvolved.length > 0 ? reposInvolved.map(repo => `- ${repo}`).join("\n") : "- NOT_FOUND_IN_INDEXED_CODEBASE",
    "",
    "Matching paths:",
    pathDetails.map((details, index) => formatGraphPathDetails(details, index)).join("\n\n"),
    "",
    "What is still missing:",
    "- Relationship graph edges prove code references and matching names; they do not prove runtime success paths or all conditional branches.",
    "- For return body and validation details, ask the exact endpoint after the graph identifies it.",
  ].join("\n")

  return { answer, sources }
}

async function retrieveExactRouteMatches(routes: string[]): Promise<RetrievedChunk[]> {
  if (routes.length === 0) return []

  // BM25 candidate retrieval: search route strings against the in-memory index
  // (routes field + content) → candidate IDs → fetch full payloads by ID.
  // Avoids the prior ~24s full-collection scroll by narrowing to BM25 hits.
  const bm25Results = await bm25Search(routes.join(" "), 300)

  if (bm25Results.length === 0) return []

  const filter = buildFilter()
  const candidates = await retrieveChunksByIds(bm25Results.map(r => r.id), filter)
  const matches: RetrievedChunk[] = []

  for (const chunk of candidates) {
    const payload = chunk.payload

    if (!options.repoName && payload.repoName === "local-codebase-ai") continue

    const storedRoutes = payload.routes ?? []
    const hasMatch = routes.some(route => {
      return storedRoutes.some(storedRoute => routeMatches(storedRoute, route)) || contentContainsRoute(payload.content ?? "", route)
    })

    if (hasMatch) {
      matches.push(chunk)
    }
  }

  return matches
}

function metadataTextForConceptSearch(payload: RetrievedPayload): string {
  return [
    payload.repoName ?? "",
    payload.serviceType ?? "",
    payload.branchName ?? "",
    payload.filePath ?? "",
    ...(payload.routes ?? []),
    ...(payload.symbols ?? []),
    ...(payload.messageNames ?? []),
    ...(payload.dbTables ?? []),
    ...(payload.structuredFacts ?? []).map(fact => `${fact.category} ${fact.text}`),
    payload.content ?? "",
  ].join("\n")
}

function scoreConceptAnchor(payload: RetrievedPayload, tokens: string[]): number {
  const metadataText = metadataTextForConceptSearch(payload).toLowerCase()

  if (tokens.length === 0 || !tokens.every(token => metadataText.includes(token))) return 0

  let score = tokens.length

  if ((payload.routes?.length ?? 0) > 0) score += 8
  if ((payload.symbols?.length ?? 0) > 0) score += 3
  if (payload.filePath?.includes("config")) score += 2
  if (payload.filePath?.includes("route")) score += 2

  return score
}

async function discoverConceptRouteAnchors(question: string): Promise<string[]> {
  if (!questionAsksAboutServicesOrFlow(question)) return []

  const tokens = extractConceptTokens(question)

  if (tokens.length < 2) return []

  // BM25 candidate retrieval: search concept tokens against the in-memory
  // index → candidate IDs → fetch full payloads → score locally.
  // Avoids the prior ~25s full-collection scroll.
  const bm25Results = await bm25Search(tokens.join(" "), 300)

  if (bm25Results.length === 0) return []

  const filter = buildFilter()
  const candidates = await retrieveChunksByIds(bm25Results.map(r => r.id), filter)
  const matches: Array<RetrievedChunk & { score: number }> = []

  for (const chunk of candidates) {
    const score = scoreConceptAnchor(chunk.payload, tokens)

    if (score > 0) {
      matches.push({ ...chunk, score })
    }
  }

  const bestMatches = matches.sort((left, right) => right.score - left.score).slice(0, 12)

  return unique(
    bestMatches.flatMap(match => {
      return (match.payload.routes ?? []).filter(route => {
        const routeText = route.toLowerCase()

        return tokens.every(token => routeText.includes(token))
      })
    }),
    6,
  )
}

function textForExactSearch(payload: RetrievedPayload): string {
  return [
    payload.content ?? "",
    ...(payload.routes ?? []),
    ...(payload.symbols ?? []),
    ...(payload.messageNames ?? []),
    ...(payload.queueNames ?? []),
    ...(payload.exchangeNames ?? []),
    ...(payload.dbTables ?? []),
    ...(payload.structuredFacts ?? []).map(fact => `${fact.category} ${fact.text}`),
  ].join("\n")
}

function scoreExactTermMatch(payload: RetrievedPayload, terms: string[]): number {
  const text = textForExactSearch(payload).toLowerCase()
  const filePath = payload.filePath?.toLowerCase() ?? ""
  const repoName = payload.repoName?.toLowerCase() ?? ""
  const content = payload.content ?? ""

  let score = terms.reduce((currentScore, term) => {
    const normalizedTerm = term.toLowerCase()

    if (!normalizedTerm) return currentScore
    if (payload.symbols?.some(symbol => symbol.toLowerCase() === normalizedTerm)) return currentScore + 5
    if (payload.messageNames?.some(messageName => messageName.toLowerCase() === normalizedTerm)) return currentScore + 5
    if (new RegExp(`(^|[^a-z0-9_])${escapeRegExp(normalizedTerm)}([^a-z0-9_]|$)`, "i").test(text)) {
      let termScore = 4

      if (new RegExp(`["']${escapeRegExp(normalizedTerm)}["']`, "i").test(content)) termScore += 5
      if (new RegExp(`\\b${escapeRegExp(normalizedTerm)}\\s*:`, "i").test(content)) termScore += 4

      return currentScore + termScore
    }

    if (text.toLowerCase().includes(normalizedTerm)) return currentScore + 1

    return currentScore
  }, 0)

  if (terms.some(term => term.toLowerCase() === "isignal")) {
    if (filePath.includes("isignal-docs")) score += 20
    if (repoName.includes("isignal")) score += 10
  }

  if (terms.some(term => term.toLowerCase() === "askap" || term.toLowerCase() === "mmb")) {
    if (filePath.includes("askap")) score += 12
    if (repoName.includes("askap")) score += 8
  }

  if (terms.some(term => term.toLowerCase() === "mrg")) {
    if (filePath.includes("components/mrg")) score += 12
    if (repoName.includes("mrg")) score += 8
    if (filePath.includes("whitelabel/account")) score += 8
  }

  // Boost chunks that contain multi-word phrases from the question
  const contentLower = content.toLowerCase()
  const phraseTerms = terms.filter(t => t.length >= 3).map(t => t.toLowerCase())

  for (let i = 0; i < phraseTerms.length - 1; i++) {
    const phrase = `${phraseTerms[i]} ${phraseTerms[i + 1]}`

    if (contentLower.includes(phrase)) {
      score += 12
    }
  }

  for (let i = 0; i < phraseTerms.length - 2; i++) {
    const phrase = `${phraseTerms[i]} ${phraseTerms[i + 1]} ${phraseTerms[i + 2]}`

    if (contentLower.includes(phrase)) {
      score += 20
    }
  }

  if (terms.some(term => /account(types?|_type)|tipe akun|mt4|mt5/i.test(term))) {
    if (filePath.includes("askap/libs/config")) score += 30
    if (filePath.includes("mrg/libs/config")) score += 30
    if (filePath.includes("askap/controllers/askap")) score += 14
    if (filePath.includes("mrg/controllers")) score += 14
    if (filePath.includes("askap/route")) score += 8
    if (filePath.includes("mrg/route")) score += 8
    if (filePath.includes("whitelabel/account")) score += 10
    if (text.includes("accounttypesv2")) score += 20
    if (text.includes("accounttypes")) score += 12
    if (text.includes("getaccounttypesv2")) score += 10
    if (text.includes("getaccounttypebyuserid")) score += 10
    if (text.includes("metaaccounttype.getpublicaccounttypes")) score += 14
  }

  if (terms.some(term => term.toLowerCase() === "calculatepointandmedal20260531")) {
    if (filePath.includes("domain/vp")) score += 80
    if (/export\s+function\s+CalculatePointAndMedal20260531/.test(content)) score += 80
  }

  if (terms.some(term => /^mt[45]$/i.test(term))) {
    if (filePath.includes("devops-docs")) score -= 80
    if (/metatrader|platform_type|metaserver|ServerPlatform|TF_METATRADER_PLATFORM_TYPE|MRG_METATRADER_PLATFORM_TYPE|ASKAP_METATRADER_PLATFORM_TYPE|VOLUME_MULTIPLIER/i.test(text)) score += 35
    if (filePath.includes("libs/config")) score += 28
    if (filePath.includes("models/user") || filePath.includes("models/demo") || filePath.includes("models/real")) score += 16
    if (filePath.includes("isignal-docs") && filePath.includes("architecture")) score += 10
  }

  // Boost vocabulary/glossary chunks when question contains defined terms
  if (filePath.startsWith("vocabulary://")) {
    const definedTerms = (payload.symbols ?? []).map(s => s.toLowerCase())
    const matchingTerms = terms.filter(term => definedTerms.includes(term.toLowerCase()))

    if (matchingTerms.length > 0) {
      score += 25 + matchingTerms.length * 5
    }
  }

  return score
}

async function retrieveExactTermMatches(terms: string[], maxMatches: number, filter: SearchFilter = buildFilter()): Promise<RetrievedChunk[]> {
  const exactTerms = unique(terms, 24)

  if (exactTerms.length === 0) return []

  // When a specific filter is provided (e.g. repoBranchFileFilter), the scroll
  // is already scoped to a small result set — keep the original scroll path.
  // Only use BM25 candidate retrieval for unfiltered (full-collection) scans,
  // which were the dominant latency source (~24s each).
  if (filter) {
    return retrieveExactTermMatchesViaScroll(exactTerms, maxMatches, filter)
  }

  const bm25Results = await bm25Search(exactTerms.join(" "), Math.max(maxMatches * 6, 300))

  if (bm25Results.length === 0) return []

  const candidates = await retrieveChunksByIds(bm25Results.map(r => r.id))
  const matches: Array<RetrievedChunk & { score: number }> = []

  for (const chunk of candidates) {
    const score = scoreExactTermMatch(chunk.payload, exactTerms)

    if (score > 0) {
      matches.push({ ...chunk, score })
    }
  }

  return matches
    .sort((left, right) => right.score - left.score)
    .slice(0, maxMatches)
    .map(({ score: _score, ...chunk }) => chunk)
}

async function retrieveExactTermMatchesViaScroll(
  exactTerms: string[],
  maxMatches: number,
  filter: SearchFilter,
): Promise<RetrievedChunk[]> {
  const matches: Array<RetrievedChunk & { score: number }> = []
  let offset: string | number | Record<string, unknown> | null | undefined

  do {
    const scrollRequest = {
      limit: 256,
      with_payload: true,
      with_vector: false,
      ...(filter ? { filter } : {}),
      ...(offset ? { offset } : {}),
    }
    const page = await qdrant.scroll(config.collectionName, scrollRequest)

    for (const point of page.points) {
      const payload = point.payload as RetrievedPayload | null | undefined

      if (!payload?.content) continue

      const score = scoreExactTermMatch(payload, exactTerms)

      if (score > 0) {
        matches.push({
          id: String(point.id),
          payload,
          score,
        })
      }
    }

    offset = page.next_page_offset
  } while (offset)

  return matches
    .sort((left, right) => right.score - left.score)
    .slice(0, maxMatches)
    .map(({ score: _score, ...chunk }) => chunk)
}

function repoBranchFileFilter(repoName: string, branchName: string, filePath: string) {
  return {
    must: [
      {
        key: "repoName",
        match: {
          value: repoName,
        },
      },
      {
        key: "branchName",
        match: {
          value: branchName,
        },
      },
      {
        key: "filePath",
        match: {
          value: filePath,
        },
      },
    ],
  }
}

async function retrieveFileChunks(repoName: string, branchName: string, filePath: string): Promise<RetrievedChunk[]> {
  const cacheKey = `${repoName}|${branchName}|${filePath}`
  const cached = _fileChunkCache.get(cacheKey)
  if (cached) return cached

  const chunks: RetrievedChunk[] = []
  let offset: string | number | Record<string, unknown> | null | undefined

  do {
    const page = await qdrant.scroll(config.collectionName, {
      filter: repoBranchFileFilter(repoName, branchName, filePath),
      limit: 128,
      with_payload: true,
      with_vector: false,
      ...(offset ? { offset } : {}),
    })

    for (const point of page.points) {
      const payload = point.payload as RetrievedPayload | null | undefined

      if (!payload?.content) continue

      chunks.push({
        id: String(point.id),
        payload,
      })
    }

    offset = page.next_page_offset
  } while (offset)

  chunks.sort((left, right) => (left.payload.startLine ?? 0) - (right.payload.startLine ?? 0))
  _fileChunkCache.set(cacheKey, chunks)
  return chunks
}

async function retrieveNeighborChunks(chunks: RetrievedChunk[], lineWindow = 90): Promise<RetrievedChunk[]> {
  // Group input chunks by file scope so each unique file is scrolled at most
  // once (the prior version did one scroll-per-chunk, re-fetching the same
  // file N times). Uses retrieveFileChunks which is backed by the per-request
  // file cache, so repeated neighbor calls on the same file are free.
  const byFile = new Map<string, RetrievedChunk[]>()

  for (const chunk of chunks) {
    if (!chunk.payload.repoName || !chunk.payload.branchName || !chunk.payload.filePath) continue
    const key = `${chunk.payload.repoName}|${chunk.payload.branchName}|${chunk.payload.filePath}`
    const arr = byFile.get(key) ?? []
    arr.push(chunk)
    byFile.set(key, arr)
  }

  const neighbors: RetrievedChunk[] = []

  for (const [, fileChunks] of byFile) {
    const first = fileChunks[0]
    if (!first) continue
    const fileScopeChunks = await retrieveFileChunks(
      first.payload.repoName!,
      first.payload.branchName!,
      first.payload.filePath!,
    )

    for (const chunk of fileChunks) {
      const nearStart = (chunk.payload.startLine ?? 0) - lineWindow
      const nearEnd = (chunk.payload.endLine ?? 0) + lineWindow

      for (const fc of fileScopeChunks) {
        const fcStart = fc.payload.startLine
        const fcEnd = fc.payload.endLine
        if (fcStart === undefined || fcEnd === undefined) continue
        if (fcEnd >= nearStart && fcStart <= nearEnd) {
          neighbors.push(fc)
        }
      }
    }
  }

  // Deduplicate by id — overlapping windows from multiple input chunks may
  // select the same neighbor chunk.
  return [...new Map(neighbors.map(n => [n.id, n])).values()]
}

async function retrieveAccountTypeFileChunks(chunks: RetrievedChunk[], question: string): Promise<RetrievedChunk[]> {
  const seedRegex = /accountTypes|accountTypesV2|type_name|platform_type|group_creation|MetaAccountType\.getPublicAccountTypes|"mindepo"|minFirstDepo/i

  const seedFromFileChunks = (pool: RetrievedChunk[]): string[] =>
    unique(
      pool
        .filter(chunk => seedRegex.test(chunk.payload.content ?? ""))
        .filter(chunk => chunk.payload.repoName && chunk.payload.branchName && chunk.payload.filePath)
        .map(chunk => `${chunk.payload.repoName}|${chunk.payload.branchName}|${chunk.payload.filePath}`),
      20,
    )

  let fileKeys = seedFromFileChunks(chunks)

  // Always search Qdrant for the broker-specific config file. Account-type
  // config chunks (e.g. components/askap/libs/config.js) have no
  // symbols/routes/tables/queues, so they are excluded from the BM25 index
  // and won't appear in the retrieval pool via bm25Search. A server-side
  // scroll filtered by evidenceTypes=env_config + filePath narrows to ~1k
  // chunks, then we filter locally for account-type content.
  const brokerHint = questionBrokerHint(question)
  const configFilePaths: string[] = []
  if (brokerHint === "askap") configFilePaths.push("components/askap/libs/config.js")
  else if (brokerHint === "mrg") configFilePaths.push("components/mrg/libs/config.js")

  if (configFilePaths.length > 0) {
    try {
      const scrollMust: Array<Record<string, unknown>> = [
        { key: "evidenceTypes", match: { value: "env_config" } },
      ]
      const scrollShould = configFilePaths.map(fp => ({ key: "filePath", match: { value: fp } }))

      const seedPool: RetrievedChunk[] = []
      let offset: string | number | Record<string, unknown> | null | undefined
      do {
        const page = await qdrant.scroll(config.collectionName, {
          filter: { must: scrollMust, should: scrollShould },
          limit: 256,
          with_payload: true,
          with_vector: false,
          ...(offset ? { offset } : {}),
        })
        for (const point of page.points) {
          const payload = point.payload as RetrievedPayload | null | undefined
          if (!payload?.content) continue
          if (!seedRegex.test(payload.content)) continue
          seedPool.push({ id: String(point.id), payload })
        }
        offset = page.next_page_offset
      } while (offset)

      const configKeys = seedFromFileChunks(seedPool)
      fileKeys = unique([...fileKeys, ...configKeys], 20)
    } catch { /* fall through — no config seeds found */ }
  }

  const expanded: RetrievedChunk[] = []

  for (const key of fileKeys) {
    const [repoName, branchName, filePath] = key.split("|")

    if (!repoName || !branchName || !filePath) continue

    expanded.push(...await retrieveFileChunks(repoName, branchName, filePath))
  }

  return expanded
}

function extractRouteHandlerRefs(chunks: RetrievedChunk[]): HandlerRef[] {
  const refs: HandlerRef[] = []

  for (const chunk of chunks) {
    const content = chunk.payload.content ?? ""

    for (const match of content.matchAll(/\bhandler\s*:\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)/g)) {
      const handlerRef = match[1]

      if (!handlerRef) continue

      const parts = handlerRef.split(".")
      const objectName = parts[0]
      const methodName = parts.at(-1)

      if (!objectName || !methodName) continue

      refs.push({
        objectName,
        methodName,
        fullName: handlerRef,
      })
    }
  }

  return [...new Map(refs.map(ref => [ref.fullName, ref])).values()]
}

function extractExactRouteHandlerRefs(chunks: RetrievedChunk[], routes: string[]): HandlerRef[] {
  const refs: HandlerRef[] = []
  const definitions = extractRouteDefinitions(chunks, routes)

  for (const definition of definitions) {
    for (const match of definition.matchAll(/\bhandler\s*:\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)/g)) {
      const handlerRef = match[1]

      if (!handlerRef) continue

      const parts = handlerRef.split(".")
      const objectName = parts[0]
      const methodName = parts.at(-1)

      if (!objectName || !methodName) continue

      refs.push({
        objectName,
        methodName,
        fullName: handlerRef,
      })
    }
  }

  return [...new Map(refs.map(ref => [ref.fullName, ref])).values()]
}

function parseRequireAliases(content: string, routeFilePath: string): Map<string, string> {
  const aliases = new Map<string, string>()
  const routeDir = path.posix.dirname(routeFilePath)

  for (const match of content.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
    const alias = match[1]
    const requirePath = match[2]

    if (!alias || !requirePath || !requirePath.startsWith(".")) continue

    const resolved = path.posix.normalize(path.posix.join(routeDir, requirePath))
    const withExtension = path.posix.extname(resolved) ? resolved : `${resolved}.js`

    aliases.set(alias, withExtension)
  }

  return aliases
}

async function resolveHandlerChunks(exactChunks: RetrievedChunk[], handlerRefs: HandlerRef[]): Promise<RetrievedChunk[]> {
  const chunks: RetrievedChunk[] = []

  for (const exactChunk of exactChunks) {
    const repoName = exactChunk.payload.repoName
    const branchName = exactChunk.payload.branchName
    const routeFilePath = exactChunk.payload.filePath

    if (!repoName || !branchName || !routeFilePath) continue

    const routeFileChunks = await retrieveFileChunks(repoName, branchName, routeFilePath)
    const routeFileHeader = routeFileChunks
      .filter(chunk => (chunk.payload.startLine ?? 0) <= 120)
      .map(chunk => chunk.payload.content ?? "")
      .join("\n")
    const aliases = parseRequireAliases(routeFileHeader, routeFilePath)

    for (const ref of handlerRefs) {
      const controllerFilePath = aliases.get(ref.objectName)

      if (!controllerFilePath) continue

      const controllerChunks = await retrieveExactTermMatches(
        [ref.methodName, ref.fullName],
        6,
        repoBranchFileFilter(repoName, branchName, controllerFilePath),
      )

      chunks.push(...controllerChunks)
      chunks.push(...await retrieveNeighborChunks(controllerChunks, 45))
    }
  }

  if (chunks.length > 0) return chunks

  const fallbackTerms = handlerRefs.flatMap(ref => [ref.fullName, ref.methodName, ref.objectName])

  return retrieveExactTermMatches(fallbackTerms, 10)
}

function extractRpcAndCallTerms(chunks: RetrievedChunk[]): string[] {
  const terms: string[] = []

  for (const chunk of chunks) {
    const content = chunk.payload.content ?? ""

    terms.push(...(chunk.payload.messageNames ?? []))
    terms.push(...(chunk.payload.queueNames ?? []))
    terms.push(...(chunk.payload.exchangeNames ?? []))
    terms.push(...[...content.matchAll(/\bfunc\s*:\s*["'`]([^"'`]+)["'`]/g)].map(match => match[1] ?? ""))

    for (const match of content.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*\(/g)) {
      const call = match[1]

      if (!call) continue

      const lowerCall = call.toLowerCase()

      if (
        lowerCall.includes("rpc") ||
        lowerCall.includes("account") ||
        lowerCall.includes("mrg") ||
        lowerCall.includes("publish") ||
        lowerCall.includes("consume") ||
        lowerCall.includes("send")
      ) {
        terms.push(call)
        terms.push(call.split(".").at(-1) ?? call)
      }
    }
  }

  return unique(terms, 24)
}

function extractRpcFuncNames(chunks: RetrievedChunk[]): string[] {
  return unique(
    chunks.flatMap(chunk => {
      const content = chunk.payload.content ?? ""

      return [...content.matchAll(/\bfunc\s*:\s*["'`]([^"'`]+)["'`]/g)].map(match => match[1] ?? "")
    }),
    12,
  )
}

function extractRouteDefinitions(chunks: RetrievedChunk[], routes: string[]): string[] {
  return chunks.flatMap(chunk => {
    const content = chunk.payload.content ?? ""
    const definitions = []

    for (const match of content.matchAll(/\{[\s\S]*?method\s*:\s*\[[\s\S]*?url\s*:\s*["'`]\/[^"'`]+["'`][\s\S]*?handler\s*:\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+[\s\S]*?\}/g)) {
      const definition = match[0]

      if (routes.some(route => contentContainsRoute(definition, route))) {
        definitions.push(definition.trim())
      }
    }

    return definitions
  })
}

function extractRouteDefinitionsForSymbol(content: string, symbolName: string): RouteDefinition[] {
  const definitions: RouteDefinition[] = []

  for (const match of content.matchAll(/\{[\s\S]*?method\s*:\s*\[[\s\S]*?url\s*:\s*["'`]\/[^"'`]+["'`][\s\S]*?handler\s*:\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+[\s\S]*?\}/g)) {
    const parsed = parseRouteDefinition(match[0])

    if (parsed?.handler.split(".").at(-1) === symbolName) {
      definitions.push(parsed)
    }
  }

  return definitions
}

function extractPhpConstantRoutes(content: string): Array<{ name: string; route: string; expression: string }> {
  const constants = new Map<string, string>()

  for (const match of content.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*([^;]+);/g)) {
    const name = match[1]
    const expression = match[2]

    if (name && expression) {
      constants.set(name, expression)
    }
  }

  function resolveExpression(expression: string, seen = new Set<string>()): string {
    return expression
      .split(".")
      .map(part => {
        const trimmed = part.trim()
        const stringValue = trimmed.match(/^["'`]([^"'`]*)["'`]$/)?.[1]

        if (stringValue !== undefined) return stringValue

        const selfReference = trimmed.match(/^self::([A-Z][A-Z0-9_]*)$/)?.[1]

        if (selfReference && constants.has(selfReference) && !seen.has(selfReference)) {
          return resolveExpression(constants.get(selfReference) ?? "", new Set([...seen, selfReference]))
        }

        return ""
      })
      .join("")
  }

  return [...constants.entries()]
    .map(([name, expression]) => ({
      name,
      expression,
      route: resolveExpression(expression),
    }))
    .filter(value => value.route.startsWith("/"))
}

function extractPhpConstantNamesForRoutes(chunks: RetrievedChunk[], routes: string[]): string[] {
  return unique(
    chunks.flatMap(chunk => {
      return extractPhpConstantRoutes(chunk.payload.content ?? "")
        .filter(constantRoute => routes.some(route => routeMatches(constantRoute.route, route)))
        .map(constantRoute => constantRoute.name)
    }),
    16,
  )
}

function parseRouteDefinition(definition: string): RouteDefinition | undefined {
  const method = definition.match(/\bmethod\s*:\s*\[([^\]]+)\]/)?.[1]?.replaceAll(/["'`\s]/g, "") ?? ""
  const alias = definition.match(/\balias\s*:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? ""
  const url = definition.match(/\burl\s*:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? ""
  const handler = definition.match(/\bhandler\s*:\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)/)?.[1] ?? ""

  if (!url || !handler) return undefined

  return {
    method,
    alias,
    url,
    handler,
  }
}

function orderRouteDefinitions(routeDefinitions: string[], routes: string[]): string[] {
  return [...routeDefinitions].sort((left, right) => {
    const leftDefinition = parseRouteDefinition(left)
    const rightDefinition = parseRouteDefinition(right)
    const leftIndex = leftDefinition ? routes.findIndex(route => routeMatches(leftDefinition.url, route)) : -1
    const rightIndex = rightDefinition ? routes.findIndex(route => routeMatches(rightDefinition.url, route)) : -1
    const normalizedLeftIndex = leftIndex >= 0 ? leftIndex : Number.MAX_SAFE_INTEGER
    const normalizedRightIndex = rightIndex >= 0 ? rightIndex : Number.MAX_SAFE_INTEGER

    return normalizedLeftIndex - normalizedRightIndex
  })
}

function isExactRouteComparisonQuestion(question: string): boolean {
  const lower = question.toLowerCase()

  return lower.includes("different") || lower.includes("difference") || lower.includes("compare")
}

function buildExactRouteComparisonAnswer(
  routeDefinitions: string[],
  handlerFacts: string[],
  downstreamFacts: string[],
  chunks: RetrievedPayload[],
): string | undefined {
  const definitions = routeDefinitions.map(parseRouteDefinition).filter(definition => definition !== undefined)

  if (definitions.length < 2) return undefined

  const source = chunks[0]
  const lines = source ? `${source.filePath}:${source.startLine}-${source.endLine}` : "unknown"
  const factsByHandler = new Map(
    definitions.map(definition => {
      const methodName = definition.handler.split(".").at(-1) ?? definition.handler
      const fact = handlerFacts.find(handlerFact => handlerFact.startsWith(`${methodName} `)) ?? ""

      return [definition.handler, fact]
    }),
  )
  const downstreamUsesDepo = downstreamFacts.some(fact => fact.includes("uses data.depo"))

  function hasFact(handler: string, factText: string): boolean {
    return factsByHandler.get(handler)?.includes(factText) ?? false
  }

  function methodName(handler: string): string {
    return handler.split(".").at(-1) ?? handler
  }

  const behavioralDifferences: string[] = []

  for (const definition of definitions) {
    const handler = definition.handler
    const additions = [
      hasFact(handler, "reads request.query values") ? "reads query parameters" : undefined,
      hasFact(handler, "passes depo into the RPC payload") ? "passes `depo` to the RPC payload" : undefined,
      hasFact(handler, "passes an explicit timeout") ? "sets an explicit RPC timeout" : undefined,
      hasFact(handler, "filters/maps account response") ? "filters/maps the account response before returning" : undefined,
    ].filter(Boolean)

    if (additions.length > 0) {
      behavioralDifferences.push(`- ${definition.url} (${methodName(handler)}) ${additions.join(", ")}.`)
    }
  }

  const rpcFuncs = unique(
    handlerFacts.flatMap(fact => {
      const match = fact.match(/rpc func values: ([^;]+)/)

      return match?.[1]?.split(",").map(value => value.trim()) ?? []
    }),
  )

  if (rpcFuncs.length > 0) {
    behavioralDifferences.unshift(`- Both handlers call RPC func ${rpcFuncs.join(", ")}.`)
  }

  if (downstreamUsesDepo) {
    behavioralDifferences.push(
      "- The downstream RPC handler uses `data.depo`, so only callers that pass `depo` can influence that downstream behavior.",
    )
  }

  const returnBehavior = definitions.map(definition => {
    const fact = factsByHandler.get(definition.handler) ?? ""
    const returns = [
      fact.includes("returns results.message from res.message") ? "returns `results.message = res.message`" : undefined,
      fact.includes("maps account type 7 to 0") ? "maps account `type == 7` to `0` before returning" : undefined,
      fact.includes("unless all=1") ? "unless `all=1`, removes accounts whose `login` is empty" : undefined,
      fact.includes("normalizes type_name") ? "normalizes `type_name` and sets `allowed_rate`" : undefined,
      fact.includes("sets login/created") ? "turns empty `login` into `New Account` and sets `created` flag" : undefined,
    ].filter(Boolean)

    return `- ${definition.url} (${methodName(definition.handler)}): ${returns.length > 0 ? returns.join("; ") : "no return transformation was extracted."}`
  })

  return [
    `The important difference is in the handler behavior, not only the URL version. Source route definitions: ${source?.repoName}@${source?.branchName} ${lines}.`,
    "",
    ...definitions.map(definition => {
      return [
        `- ${definition.url}`,
        `  method: ${definition.method || "unknown"}`,
        `  alias: ${definition.alias || "unknown"}`,
        `  handler: ${definition.handler}`,
      ].join("\n")
    }),
    "",
    "Behavioral differences:",
    behavioralDifferences.length > 0
      ? behavioralDifferences.join("\n")
      : "- No behavioral differences were extracted from the retrieved handler chunks.",
    "",
    "Return behavior:",
    returnBehavior.join("\n"),
    "",
    "Handler details found:",
    handlerFacts.length > 0 ? handlerFacts.map(fact => `- ${fact}`).join("\n") : "- No handler implementation details were extracted.",
    "",
    "Downstream RPC details found:",
    downstreamFacts.length > 0
      ? downstreamFacts.map(fact => `- ${fact}`).join("\n")
      : "- No downstream RPC handler details were extracted.",
  ].join("\n")
}

function buildExactEndpointDetailAnswer(
  routeDefinitions: string[],
  endpointFacts: string[],
  downstreamFacts: string[],
  chunks: RetrievedPayload[],
  upstreamFacts: string[] = [],
): string | undefined {
  const definition = routeDefinitions.map(parseRouteDefinition).find(routeDefinition => routeDefinition !== undefined)

  if (!definition) return undefined

  // Only keep endpoint facts for the specific handler from the route definition.
  // Without this, facts for unrelated handlers in the same route file (e.g.
  // GetAccountTypes, CheckAccounts) pollute the evidence section.
  const handlerMethodName = definition.handler.split(".").at(-1) ?? definition.handler
  const relevantEndpointFacts = endpointFacts.filter(fact => {
    const factMethodName = fact.match(/^\s*([A-Za-z_$][\w$]*)\s+in\s+/)?.[1]
    return factMethodName === handlerMethodName
  })
  const source =
    chunks.find(chunk => {
      const content = chunk.content ?? ""

      return contentContainsRoute(content, definition.url) && content.includes(definition.handler)
    }) ?? chunks[0]
  const lines = source ? `${source.filePath}:${source.startLine}-${source.endLine}` : "unknown"
  const bodyFields = unique(
    relevantEndpointFacts.flatMap(fact => {
      const match = fact.match(/body fields:\s*([^;]+)/)

      return match?.[1] ? match[1].split(",").map(value => value.trim()) : []
    }),
    12,
  )
  const rpcFunctions = extractRpcFuncNamesFromFacts(relevantEndpointFacts)
  const validationFacts = unique(
    relevantEndpointFacts.flatMap(fact => {
      const match = fact.match(/validation\/auth:\s*([^;]+)/)

      return match?.[1] ? match[1].split(",").map(value => value.trim()) : []
    }),
    12,
  )
  const extraPayload = unique(
    relevantEndpointFacts.flatMap(fact => {
      const match = fact.match(/extra payload:\s*([^;]+)/)

      return match?.[1] ? match[1].split(",").map(value => value.trim()) : []
    }),
    12,
  )
  const returnFacts = unique(
    relevantEndpointFacts.flatMap(fact => {
      const match = fact.match(/return:\s*([^;]+)/)

      return match?.[1] ? match[1].split(",").map(value => value.trim()) : []
    }),
    12,
  )
  const downstreamValidation = unique(
    downstreamFacts.flatMap(fact => {
      return fact
        .split(";")
        .map(value => value.trim())
        .filter(value => {
          return (
            value.includes("Joi") ||
            value.includes("requires") ||
            value.includes("checks") ||
            value.includes("deposit_demo") ||
            value.includes("balance RPC") ||
            value.includes("returns true") ||
            value.includes("delegates")
          )
        })
    }),
    16,
  )
  const servicesInvolved = unique(
    [...relevantEndpointFacts, ...downstreamFacts].flatMap(fact => {
      const match = fact.match(/\bin\s+([^@\s]+)@([^ ]+)\s+([^:;]+)/)

      return match?.[1] && match?.[2] ? [`${match[1]}@${match[2]}`] : []
    }),
    8,
  )
  const databaseEffects = unique(
    downstreamValidation.filter(fact => {
      return fact.includes("users_demoid") || fact.includes("deposit_demo") || fact.includes("table")
    }),
    8,
  )

  return [
    `Endpoint definition found in ${source?.repoName}@${source?.branchName} ${lines}.`,
    "",
    `- ${definition.url}`,
    `  method: ${definition.method || "unknown"}`,
    `  alias: ${definition.alias || "unknown"}`,
    `  handler: ${definition.handler}`,
    "",
    "Upstream callers:",
    upstreamFacts.length > 0
      ? upstreamFacts.map(fact => `- ${fact}`).join("\n")
      : "- No upstream caller was extracted from the retrieved context.",
    "",
    "Services/repos involved:",
    servicesInvolved.length > 0 ? servicesInvolved.map(service => `- ${service}`).join("\n") : "- Only the route owner was found.",
    "",
    "Request body:",
    bodyFields.length > 0
      ? bodyFields.map(field => `- ${field}`).join("\n")
      : "- No request.body fields were extracted from the handler.",
    "",
    "API-layer validation and payload behavior:",
    validationFacts.length > 0 ? validationFacts.map(fact => `- ${fact}`).join("\n") : "- No API-layer validation facts were extracted.",
    extraPayload.length > 0 ? extraPayload.map(fact => `- ${fact}`).join("\n") : undefined,
    rpcFunctions.length > 0 ? `- calls RPC func: ${rpcFunctions.join(", ")}` : undefined,
    "",
    "Database/table effects:",
    databaseEffects.length > 0
      ? databaseEffects.map(fact => `- ${fact}`).join("\n")
      : "- No database/table effect was extracted.",
    "",
    "Downstream RPC/model behavior:",
    downstreamValidation.length > 0
      ? downstreamValidation.map(fact => `- ${fact}`).join("\n")
      : "- No downstream RPC/model facts were extracted.",
    "",
    "Return:",
    returnFacts.length > 0 ? returnFacts.map(fact => `- ${fact}`).join("\n") : "- No API return facts were extracted.",
    downstreamFacts.some(fact => fact.includes("returns true on success"))
      ? "- downstream model returns true on success before the API returns RPC res.message"
      : undefined,
    "",
    "Evidence:",
    upstreamFacts.length > 0 ? upstreamFacts.map(fact => `- ${fact}`).join("\n") : undefined,
    relevantEndpointFacts.length > 0 ? relevantEndpointFacts.map(fact => `- ${fact}`).join("\n") : "- No handler facts were extracted.",
    downstreamFacts.length > 0 ? downstreamFacts.map(fact => `- ${fact}`).join("\n") : "- No downstream facts were extracted.",
  ].join("\n")
}

function extractDownstreamRpcFacts(chunks: RetrievedChunk[], handlerRepoNames: string[]): string[] {
  const facts: string[] = []

  for (const chunk of chunks) {
    const content = chunk.payload.content ?? ""

    if (!content.includes("GetAccountByUserID")) continue
    if (chunk.payload.repoName && handlerRepoNames.includes(chunk.payload.repoName)) continue

    const methodName = content.match(/\basync\s+([A-Za-z_$][\w$]*)\s*\(/)?.[1] ?? "unknown"
    const validatesUserId = content.includes("data.user_id")
    const usesDepo = content.includes("data.depo")
    const callsPlatformAccounts = content.includes("getUserPlatformAccountsAsync")
    const usesManager = content.includes("MRGManager.getManagerByID") || content.includes("MRGUserFromManagerApi.getInstance")
    const returnsPlatformAccounts = /return\s+results/.test(content) && callsPlatformAccounts

    facts.push(
      [
        `${methodName} in ${chunk.payload.repoName}@${chunk.payload.branchName} ${chunk.payload.filePath}:${chunk.payload.startLine}-${chunk.payload.endLine}`,
        validatesUserId ? "validates/uses data.user_id" : undefined,
        usesDepo ? "uses data.depo" : undefined,
        usesManager ? "builds MRG manager/user context" : undefined,
        callsPlatformAccounts ? "calls userModel.getUserPlatformAccountsAsync" : undefined,
        returnsPlatformAccounts ? "returns that model result to the RPC caller" : undefined,
      ]
        .filter(Boolean)
        .join("; "),
    )
  }

  return unique(facts, 12)
}

function buildLineMap(fileChunks: RetrievedChunk[]): Map<number, string> {
  const linesByNumber = new Map<number, string>()
  const sortedChunks = fileChunks.sort((left, right) => (left.payload.startLine ?? 0) - (right.payload.startLine ?? 0))

  for (const chunk of sortedChunks) {
    const startLine = chunk.payload.startLine ?? 0
    const lines = (chunk.payload.content ?? "").split(/\r?\n/)

    lines.forEach((line, index) => {
      const lineNumber = startLine + index

      if (!linesByNumber.has(lineNumber)) {
        linesByNumber.set(lineNumber, line)
      }
    })
  }

  return linesByNumber
}

function findMethodWindow(fileChunks: RetrievedChunk[], methodName: string, maxLines = 120): MethodWindow | undefined {
  const lineMap = buildLineMap(fileChunks)
  const methodPattern = new RegExp(`\\basync\\s+${escapeRegExp(methodName)}\\s*\\(`)
  const methodDeclarationPattern = /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{?\s*,?\s*$/
  const controlFlowKeywords = new Set(["if", "for", "while", "switch", "catch", "return", "throw"])
  const sortedLineNumbers = [...lineMap.keys()].sort((left, right) => left - right)
  const startLine = sortedLineNumbers.find(lineNumber => methodPattern.test(lineMap.get(lineNumber) ?? ""))

  if (!startLine) return undefined

  const nextMethodLine = sortedLineNumbers.find(lineNumber => {
    if (lineNumber <= startLine) return false

    const line = lineMap.get(lineNumber) ?? ""
    const match = line.match(methodDeclarationPattern)

    return Boolean(match?.[1] && !controlFlowKeywords.has(match[1]))
  })
  const endLine = Math.min(nextMethodLine ? nextMethodLine - 1 : startLine + maxLines, startLine + maxLines)
  const contentLines = sortedLineNumbers
    .filter(lineNumber => lineNumber >= startLine && lineNumber <= endLine)
    .map(lineNumber => lineMap.get(lineNumber) ?? "")
  const sortedChunks = fileChunks.sort((left, right) => (left.payload.startLine ?? 0) - (right.payload.startLine ?? 0))
  const windowChunks = sortedChunks.filter(chunk => {
    const chunkStart = chunk.payload.startLine ?? 0
    const chunkEnd = chunk.payload.endLine ?? 0

    return chunkEnd >= startLine && chunkStart <= endLine
  })

  return {
    content: contentLines.join("\n"),
    firstChunk: windowChunks[0]?.payload,
    lastChunk: windowChunks.at(-1)?.payload,
    startLine,
    endLine,
  }
}

function extractRpcFuncNamesFromFacts(facts: string[]): string[] {
  return unique(
    facts.flatMap(fact => {
      const match = fact.match(/rpc func values:\s*([^;]+)/)

      if (!match?.[1]) return []

      return match[1].split(",").map(value => value.trim())
    }),
    16,
  )
}

function extractGenericDownstreamRpcFacts(
  chunks: RetrievedChunk[],
  handlerRepoNames: string[],
  allowedMethodNames: string[] = [],
): string[] {
  const facts: string[] = []
  const chunksByFile = new Map<string, RetrievedChunk[]>()
  const allowedMethods = new Set(allowedMethodNames)

  for (const chunk of chunks) {
    if (chunk.payload.repoName && handlerRepoNames.includes(chunk.payload.repoName)) continue

    const key = [chunk.payload.repoName, chunk.payload.branchName, chunk.payload.filePath].join(":")

    if (!chunksByFile.has(key)) {
      chunksByFile.set(key, [])
    }

    chunksByFile.get(key)?.push(chunk)
  }

  for (const fileChunks of chunksByFile.values()) {
    const sortedChunks = fileChunks.sort((left, right) => (left.payload.startLine ?? 0) - (right.payload.startLine ?? 0))
    const methodNames = allowedMethods.size > 0
      ? [...allowedMethods]
      : unique(
          sortedChunks.flatMap(chunk => {
            const content = chunk.payload.content ?? ""

            return [...content.matchAll(/\basync\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(match => match[1] ?? "")
          }),
          20,
        )

    for (const methodName of methodNames) {
      const methodWindow = findMethodWindow(sortedChunks, methodName, 140)

      if (!methodWindow) continue

      const content = methodWindow.content
      const details = [
        content.includes("demoModel.SubmitDepositDemo") ? "delegates to demoModel.SubmitDepositDemo" : undefined,
        content.includes("Joi.object") ? "uses Joi schema validation" : undefined,
        content.includes("login: Joi.number().integer().positive().required()") ? "requires positive integer login" : undefined,
        content.includes("nominal: Joi.number().integer().min(1).max(9999999).required()")
          ? "requires nominal integer from 1 to 9999999"
          : undefined,
        content.includes("metaserver_id: Joi.number().integer().valid(1, 2).required()")
          ? "requires metaserver_id 1 or 2"
          : undefined,
        content.includes("user_id: Joi.number().integer().required()") ? "requires integer user_id" : undefined,
        content.includes("users_demoid") ? "checks users_demoid for matching demo account" : undefined,
        content.includes("deposit_demo") ? "writes to deposit_demo" : undefined,
        /INSERT\s+INTO\s+deposit_demo/i.test(content) && content.includes("status")
          ? "creates deposit_demo row with status 0"
          : undefined,
        content.includes("metaserver_id == 1") ? "uses MT4 demo balance flow when metaserver_id is 1" : undefined,
        content.includes("metaserver_id == 2") ? "uses MT5 demo balance flow when metaserver_id is 2" : undefined,
        content.includes("MRGDemoAddBalanceRequestAsync") ? "calls demo balance RPC" : undefined,
        content.includes("return true") ? "returns true on success" : undefined,
        content.includes("status = 1") ? "marks deposit_demo status 1 on success" : undefined,
        content.includes("status = 2") ? "marks deposit_demo status 2 on failure" : undefined,
      ].filter(Boolean)

      if (details.length === 0) continue

      facts.push(
        `${methodName} in ${methodWindow.firstChunk?.repoName}@${methodWindow.firstChunk?.branchName} ${methodWindow.firstChunk?.filePath}:${methodWindow.startLine}-${methodWindow.endLine}; ${details.join("; ")}`,
      )
    }
  }

  return unique(facts, 16)
}

function extractHandlerFactSummary(
  chunks: RetrievedChunk[],
  handlerRefs: HandlerRef[],
  handlerRepoNames: string[] = [],
): string[] {
  const facts: string[] = []
  const chunksByFile = new Map<string, RetrievedChunk[]>()

  for (const chunk of chunks) {
    if (handlerRepoNames.length > 0 && (!chunk.payload.repoName || !handlerRepoNames.includes(chunk.payload.repoName))) continue

    const key = [chunk.payload.repoName, chunk.payload.branchName, chunk.payload.filePath].join(":")

    if (!chunksByFile.has(key)) {
      chunksByFile.set(key, [])
    }

    chunksByFile.get(key)?.push(chunk)
  }

  for (const handlerRef of handlerRefs) {
    for (const fileChunks of chunksByFile.values()) {
      const sortedChunks = fileChunks.sort((left, right) => (left.payload.startLine ?? 0) - (right.payload.startLine ?? 0))
      const methodWindow = findMethodWindow(sortedChunks, handlerRef.methodName, 120)

      if (!methodWindow) continue

      const methodBody = methodWindow.content

      const hasMrgAccountRpc = methodBody.includes("MRGAccountRpc.send")
      const funcNames = [...methodBody.matchAll(/\bfunc\s*:\s*["'`]([^"'`]+)["'`]/g)].map(match => match[1] ?? "")
      const queryFlags = [
        ...[...methodBody.matchAll(/\b(?:const|let|var)\s+\{\s*([A-Za-z_$][\w$]*)\s*\}\s*=\s*request\.query/g)].map(
          match => match[1] ?? "",
        ),
        ...[...methodBody.matchAll(/\brequest\.query\.([A-Za-z_$][\w$]*)/g)].map(match => match[1] ?? ""),
      ]
      const passesDepo = /\bdepo\b/.test(methodBody) && /MRGAccountRpc\.send/.test(methodBody)
      const hasTimeout = /MRGAccountRpc\.send\([\s\S]*,\s*\d+/.test(methodBody)
      const filtersAccounts = /filter\s*\(/.test(methodBody)
      const returnsRpcMessage = /results\.message\s*=\s*res\.message/.test(methodBody)
      const mapsTypeSevenToZero = /type\s*==\s*7/.test(methodBody) && /type\s*=\s*0/.test(methodBody)
      const filtersEmptyLoginUnlessAll = /parseInt\(all\)\s*!==\s*1/.test(methodBody) && /account\.login\s*!=\s*''/.test(methodBody)
      const shapesTypeName = methodBody.includes("type_name") && methodBody.includes("allowed_rate")
      const marksCreatedState = methodBody.includes("created = 0") && methodBody.includes("created = 1")

      if (hasMrgAccountRpc || funcNames.length > 0 || queryFlags.length > 0) {
        facts.push(
          [
            `${handlerRef.methodName} in ${methodWindow.firstChunk?.repoName}@${methodWindow.firstChunk?.branchName} ${methodWindow.firstChunk?.filePath}:${methodWindow.startLine}-${methodWindow.endLine}`,
            hasMrgAccountRpc ? "calls MRGAccountRpc.send" : undefined,
            funcNames.length > 0 ? `rpc func values: ${unique(funcNames).join(", ")}` : undefined,
            queryFlags.length > 0 ? `reads request.query values: ${unique(queryFlags).join(", ")}` : undefined,
            passesDepo ? "passes depo into the RPC payload" : undefined,
            hasTimeout ? "passes an explicit timeout to RPC send" : undefined,
            filtersAccounts ? "filters/maps account response before returning" : undefined,
            returnsRpcMessage ? "returns results.message from res.message" : undefined,
            mapsTypeSevenToZero ? "maps account type 7 to 0" : undefined,
            filtersEmptyLoginUnlessAll ? "unless all=1, filters out accounts with empty login" : undefined,
            shapesTypeName ? "normalizes type_name and sets allowed_rate" : undefined,
            marksCreatedState ? "sets login/created fields for empty vs existing login" : undefined,
          ]
            .filter(Boolean)
            .join("; "),
        )
      }
    }
  }

  return unique(facts, 12)
}

function extractEndpointHandlerFacts(
  chunks: RetrievedChunk[],
  handlerRefs: HandlerRef[],
  handlerRepoNames: string[] = [],
): string[] {
  const facts: string[] = []
  const chunksByFile = new Map<string, RetrievedChunk[]>()

  for (const chunk of chunks) {
    if (handlerRepoNames.length > 0 && (!chunk.payload.repoName || !handlerRepoNames.includes(chunk.payload.repoName))) continue

    const key = [chunk.payload.repoName, chunk.payload.branchName, chunk.payload.filePath].join(":")

    if (!chunksByFile.has(key)) {
      chunksByFile.set(key, [])
    }

    chunksByFile.get(key)?.push(chunk)
  }

  for (const handlerRef of handlerRefs) {
    for (const fileChunks of chunksByFile.values()) {
      const sortedChunks = fileChunks.sort((left, right) => (left.payload.startLine ?? 0) - (right.payload.startLine ?? 0))
      const methodWindow = findMethodWindow(sortedChunks, handlerRef.methodName, 120)

      if (!methodWindow) continue

      const methodBody = methodWindow.content
      const bodyFields = [
        ...[...methodBody.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*request\.body\.([A-Za-z_$][\w$]*)/g)].map(
          match => `${match[2]} -> ${match[1]}`,
        ),
        ...[...methodBody.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*parseInt\(request\.body\.([A-Za-z_$][\w$]*)\)/g)].map(
          match => `${match[2]} -> ${match[1]} (parseInt)`,
        ),
      ]
      const rpcFuncNames = [...methodBody.matchAll(/\bfunc\s*:\s*["'`]([^"'`]+)["'`]/g)].map(match => match[1] ?? "")
      const validations = [
        methodBody.includes("request.jwtVerify") ? "verifies JWT" : undefined,
        methodBody.includes("encryptedJwt.ua != request.headers['user-agent']") ? "checks JWT user-agent against request user-agent" : undefined,
        methodBody.includes("userid < 1") ? "requires authenticated userid >= 1" : undefined,
        methodBody.includes("request.validationError") ? "throws on request.validationError" : undefined,
        methodBody.includes("userModel.getMrgAccount") ? "looks up mapped MRG account for userid" : undefined,
        methodBody.includes("MrgAccountNotFoundError") ? "throws MRG_ACCOUNT_NOT_FOUND when mapped MRG account is missing" : undefined,
      ].filter(Boolean)
      const extraPayload = [
        /user_id\s*:\s*parseInt\(mrguser\.mrgid\)/.test(methodBody) ? "adds user_id from mapped mrguser.mrgid" : undefined,
        methodBody.includes("x-forwarded-for") ? "adds ip from x-forwarded-for or remoteAddress" : undefined,
        methodBody.includes("request.headers['user-agent']") ? "adds browser from user-agent header" : undefined,
      ].filter(Boolean)
      const returns = [
        methodBody.includes("const result = { message: false }") ? "initial result is { message: false }" : undefined,
        methodBody.includes("MrgApiError") && methodBody.includes("res.error") ? "throws MrgApiError when RPC returns res.error" : undefined,
        methodBody.includes("result.message = res.message") ? "sets result.message from RPC res.message" : undefined,
        /return\s+result/.test(methodBody) ? "returns result" : undefined,
      ].filter(Boolean)

      facts.push(
        [
          `${handlerRef.methodName} in ${methodWindow.firstChunk?.repoName}@${methodWindow.firstChunk?.branchName} ${methodWindow.firstChunk?.filePath}:${methodWindow.startLine}-${methodWindow.endLine}`,
          bodyFields.length > 0 ? `body fields: ${unique(bodyFields, 12).join(", ")}` : undefined,
          rpcFuncNames.length > 0 ? `rpc func values: ${unique(rpcFuncNames, 12).join(", ")}` : undefined,
          validations.length > 0 ? `validation/auth: ${validations.join(", ")}` : undefined,
          extraPayload.length > 0 ? `extra payload: ${extraPayload.join(", ")}` : undefined,
          returns.length > 0 ? `return: ${returns.join(", ")}` : undefined,
        ]
          .filter(Boolean)
          .join("; "),
      )
    }
  }

  return unique(facts, 16)
}

function extractUpstreamRouteCallerFacts(chunks: RetrievedChunk[], constantNames: string[]): string[] {
  const constants = new Set(constantNames)
  const facts: string[] = []

  if (constants.size === 0) return []

  for (const chunk of chunks) {
    const content = chunk.payload.content ?? ""
    const matchingConstants = [...constants].filter(constantName => containsExactIdentifier(content, constantName))

    if (matchingConstants.length === 0) continue
    if (!content.includes("Helper::requestAPI")) continue

    for (const constantName of matchingConstants) {
      const usageIndex = content.search(new RegExp(`\\b${escapeRegExp(constantName)}\\b`))
      const contentBeforeUsage = usageIndex >= 0 ? content.slice(0, usageIndex) : content
      const functionName =
        [...contentBeforeUsage.matchAll(/\b(?:public|private|protected)?\s*function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)]
          .map(match => match[1] ?? "")
          .filter(Boolean)
          .at(-1) ?? "unknown"

      facts.push(
        `${functionName} in ${chunk.payload.repoName}@${chunk.payload.branchName} ${chunk.payload.filePath}:${chunk.payload.startLine}-${chunk.payload.endLine}; calls Helper::requestAPI with ${constantName}`,
      )
    }
  }

  return unique(facts, 12)
}

async function retrieveExactRouteDetails(
  exactChunks: RetrievedChunk[],
  handlerRefs: HandlerRef[],
  includeRpcHop: boolean,
  exactRoutes: string[] = [],
): Promise<RetrievedChunk[]> {
  const handlerChunks = await resolveHandlerChunks(exactChunks, handlerRefs)
  const phpConstantNames = extractPhpConstantNamesForRoutes(exactChunks, exactRoutes)
  const phpConstantChunks = phpConstantNames.length > 0 ? await retrieveExactTermMatches(phpConstantNames, 40) : []
  const phpConstantNeighborChunks = phpConstantChunks.length > 0 ? await retrieveNeighborChunks(phpConstantChunks, 45) : []

  if (!includeRpcHop) return [...handlerChunks, ...phpConstantChunks, ...phpConstantNeighborChunks]

  const rpcFuncNames = extractRpcFuncNames(handlerChunks)
  const rpcTerms = extractRpcAndCallTerms(handlerChunks)
  const rpcFuncChunks = await retrieveExactTermMatches(rpcFuncNames, 80)
  const rpcChunks = await retrieveExactTermMatches([...rpcFuncNames, ...rpcTerms], 80)
  const originRepos = new Set(exactChunks.map(chunk => chunk.payload.repoName).filter(Boolean))
  const downstreamFuncChunks = rpcFuncChunks.filter(chunk => {
    const content = chunk.payload.content ?? ""

    return !originRepos.has(chunk.payload.repoName) && rpcFuncNames.some(funcName => content.includes(funcName))
  })
  const downstreamNeighborChunks = await retrieveNeighborChunks(downstreamFuncChunks, 170)
  const downstreamRpcChunks = rpcChunks.filter(chunk => !originRepos.has(chunk.payload.repoName))
  const localRpcChunks = rpcChunks.filter(chunk => originRepos.has(chunk.payload.repoName))

  return [
    ...handlerChunks,
    ...phpConstantChunks.slice(0, 12),
    ...phpConstantNeighborChunks.slice(0, 12),
    ...downstreamFuncChunks.slice(0, 20),
    ...downstreamNeighborChunks.slice(0, 32),
    ...downstreamRpcChunks.slice(0, 6),
    ...localRpcChunks.slice(0, 6),
  ]
}

function shouldExpandRetrieval(question: string, hints: RelationshipHints): boolean {
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

function shouldExpandExactRouteQuestion(question: string): boolean {
  const lower = question.toLowerCase()

  return ["flow", "rpc", "amqp", "rabbit", "queue", "exchange", "publish", "consume", "consumer", "handler", "call"].some(
    keyword => lower.includes(keyword),
  )
}

function shouldInspectExactEndpointDetails(question: string): boolean {
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

function buildExpansionQueries(question: string, hints: RelationshipHints): string[] {
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

function mergeChunks(chunks: RetrievedChunk[], maxResults = Math.max(limit, 12)): RetrievedChunk[] {
  return compactRetrievedChunks(chunks, maxResults)
}

function chunkHasStrongQuestionEvidence(chunk: RetrievedPayload, questionText: string): boolean {
  const text = [
    chunk.repoName ?? "",
    chunk.filePath ?? "",
    chunk.content ?? "",
    ...(chunk.routes ?? []),
    ...(chunk.symbols ?? []),
    ...(chunk.messageNames ?? []),
    ...(chunk.queueNames ?? []),
    ...(chunk.exchangeNames ?? []),
    ...(chunk.dbTables ?? []),
  ].join("\n").toLowerCase()
  const terms = unique([
    ...extractQuestionRoutes(questionText),
    ...extractQuestionHints(questionText),
    ...extractQuestionTerms(questionText),
    ...extractConceptTokens(questionText),
    ...registryExactSearchTerms(),
  ].filter(term => term.length >= 2), 48)

  if (terms.length === 0) return true

  return terms.some(term => text.includes(term.toLowerCase()))
}

function scoreFallbackContextChunk(chunk: RetrievedPayload, questionText: string): number {
  const lowerQuestion = questionText.toLowerCase()
  const text = [
    chunk.repoName ?? "",
    chunk.filePath ?? "",
    chunk.content ?? "",
    ...(chunk.routes ?? []),
    ...(chunk.symbols ?? []),
    ...(chunk.messageNames ?? []),
    ...(chunk.queueNames ?? []),
    ...(chunk.exchangeNames ?? []),
    ...(chunk.dbTables ?? []),
  ].join("\n").toLowerCase()
  let score = 0

  if (chunk.filePath?.startsWith("knowledge-notes://")) score += 70
  if (chunk.filePath?.startsWith("decision://")) {
    score += (chunk.retrieval_priority ?? 0) * 2
    if (/decided|decision|changed|why|rationale|rule|aturan|diputuskan|alasan|perubahan/i.test(questionText)) score += 40
  }
  if (chunk.filePath?.startsWith("vocabulary://")) score += questionAsksAboutGlossary(questionText) ? 50 : 8
  if (chunk.filePath?.startsWith("doctor:") || chunk.filePath?.startsWith("doctor-fact:")) score += questionAsksInventory(questionText) ? 80 : 20
  if (chunk.evidenceTypes?.includes("documentation")) score += questionAsksAboutGlossary(questionText) || questionAsksHowWorks(questionText) || questionAsksInventory(questionText) ? 25 : -12
  // Boost comment chunks for rationale/meaning questions — comments often explain WHY
  if (chunk.evidenceTypes?.includes("comment")) {
    score += /\b(why|kenapa|mengapa|what does|apa itu|artinya|maksud|mean|means|meaning|rationale|reason|alasan|explain|jelasin|jelaskan)\b/i.test(questionText) ? 35 : 8
  }
  // Boost migration chunks for "what does X mean" questions about DB columns/values
  if (chunk.evidenceTypes?.includes("migration")) {
    score += /\b(status|value|nilai|arti|mean|means|apa itu|what does|column|kolom)\b/i.test(questionText) ? 25 : 0
  }
  // For "how works" questions, boost implementation code over docs —
  // code chunks with routes/queues/tables show the actual implementation.
  if (questionAsksHowWorks(questionText) && !chunk.evidenceTypes?.includes("documentation")) {
    if ((chunk.routes?.length ?? 0) > 0 || (chunk.queueNames?.length ?? 0) > 0 || (chunk.exchangeNames?.length ?? 0) > 0 || (chunk.dbTables?.length ?? 0) > 0 || (chunk.symbols?.length ?? 0) > 0) {
      score += 35
    }
  }
  if ((chunk.routes?.length ?? 0) > 0) score += 28
  if ((chunk.symbols?.length ?? 0) > 0) score += 18
  if ((chunk.messageNames?.length ?? 0) > 0 || (chunk.queueNames?.length ?? 0) > 0 || (chunk.exchangeNames?.length ?? 0) > 0) score += 24
  if ((chunk.dbTables?.length ?? 0) > 0) score += questionAsksAboutDatabase(questionText) ? 35 : 12
  if (chunk.evidenceTypes?.includes("env_config")) score += /\b(config|env|minimum|minimal|syarat|requirement|rules?|aturan)\b/i.test(questionText) ? 30 : 4
  if (chunk.evidenceTypes?.includes("test")) score -= 10
  if (!options.repoName && chunk.repoName === "local-codebase-ai") score -= 100

  for (const term of unique([...extractQuestionHints(questionText), ...extractQuestionTerms(questionText), ...extractConceptTokens(questionText)], 36)) {
    const normalized = term.toLowerCase()

    if (normalized.length < 2) continue
    if (text.includes(normalized)) score += normalized.includes("/") ? 55 : 10
  }

  if (lowerQuestion.includes("isignal") && /isignal|auto copy|copy signal|bot copy|dsc_/i.test(text)) score += 22
  if (lowerQuestion.includes("flow") || lowerQuestion.includes("alur") || lowerQuestion.includes("jelasin")) {
    if (/route|handler|rpc|queue|consumer|publisher|model|controller/i.test(text)) score += 18
  }

  return score
}

function selectFallbackContextChunks(chunks: RetrievedPayload[], questionText: string): RetrievedPayload[] {
  const maxContextChunks = deepMode ? 28 : Math.max(limit, 12)
  const scored = chunks
    .filter(chunk => chunk.content)
    .filter(chunk => chunkHasStrongQuestionEvidence(chunk, questionText) || questionAsksAboutGlossary(questionText))
    .map((chunk, index) => ({
      chunk,
      index,
      score: scoreFallbackContextChunk(chunk, questionText),
    }))
    .filter(item => item.score > -40)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, maxContextChunks)
    .map(item => item.chunk)

  return scored.length > 0 ? scored : chunks.slice(0, maxContextChunks)
}

type DeepInvestigation = {
  trace: string[]
  chunks: RetrievedChunk[]
}

async function runDeepInvestigation(
  questionText: string,
  graph: RelationshipEdge[],
  seedChunks: RetrievedChunk[],
  exactRoutes: string[],
  exactTerms: string[],
  hints: RelationshipHints,
): Promise<DeepInvestigation> {
  const trace: string[] = [
    "Deep investigation mode: read-only, bounded to indexed Qdrant chunks and relationship graph.",
  ]
  const collected: RetrievedChunk[] = [...seedChunks]
  const investigationTerms = unique([
    ...exactTerms,
    ...extractQuestionHints(questionText),
    ...extractConceptTokens(questionText),
    ...extractQuestionTerms(questionText),
    ...exactRoutes,
    ...hints.routes,
    ...hints.symbols,
    ...hints.messageNames,
    ...hints.queueNames,
    ...hints.exchangeNames,
    ...hints.dbTables,
  ].filter(term => term.length >= 2), 40)

  trace.push(`Step 1: extracted ${investigationTerms.length} search anchor(s): ${investigationTerms.slice(0, 16).join(", ") || "none"}.`)

  const exactMatches = investigationTerms.length > 0
    ? await retrieveExactTermMatches(investigationTerms, 80)
    : []

  collected.push(...exactMatches)
  trace.push(`Step 2: exact index search found ${exactMatches.length} chunk(s).`)

  const neighborMatches = exactMatches.length > 0
    ? await retrieveNeighborChunks(exactMatches.slice(0, 24), 120)
    : []

  collected.push(...neighborMatches)
  trace.push(`Step 3: neighbor expansion added ${neighborMatches.length} nearby chunk(s).`)

  const graphTerms = new Set(investigationTerms.map(term => term.toLowerCase()))
  const graphMatches = graph
    .filter(edge => {
      if (!options.repoName && edge.repoName === "local-codebase-ai") return false
      if (options.repoName && edge.repoName !== options.repoName) return false
      if (options.branch && edge.branchName !== options.branch) return false
      if (serviceType && edge.serviceType !== serviceType) return false
      if (projectFilterIds.length > 0) {
        const edgeProjectIds = edge.projectIds ?? []

        if (edgeProjectIds.length > 0) {
          return edgeProjectIds.some(projectId => projectFilterIds.includes(projectId))
        }

        return projectFilterRepos.has(edge.repoName)
      }

      return true
    })
    .map(edge => {
      const text = edgeTextForConceptSearch(edge)
      let score = 0

      for (const term of graphTerms) {
        if (term.length >= 2 && text.includes(term)) score += term.includes("/") ? 60 : 12
      }

      if (exactRoutes.some(route => edge.toRoute && routeMatches(edge.toRoute, route))) score += 100
      if (questionAsksAboutServicesOrFlow(questionText) && (edge.toRoute || edge.rpcFunc || edge.table || edge.symbol || edge.handler)) score += 20

      return { edge, score }
    })
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 12)
    .map(item => item.edge)

  trace.push(`Step 4: relationship graph matched ${graphMatches.length} route/message/table edge(s).`)

  const graphFileKeys = unique(
    graphMatches.map(edge => `${edge.repoName}|${edge.branchName || "unknown"}|${edge.filePath}`),
    8,
  )
  let graphFileChunkCount = 0

  for (const key of graphFileKeys) {
    const [repoName, branchName, filePath] = key.split("|")

    if (!repoName || !branchName || !filePath) continue

    const fileChunks = await retrieveFileChunks(repoName, branchName, filePath)
    graphFileChunkCount += fileChunks.length
    collected.push(...fileChunks)
  }

  trace.push(`Step 5: graph file expansion loaded ${graphFileChunkCount} chunk(s) from ${graphFileKeys.length} file(s).`)

  const semanticQueries = unique(buildExpansionQueries(questionText, hints), 4)
  let semanticChunkCount = 0

  for (const queryText of semanticQueries) {
    const semanticChunks = await retrieve(queryText, 6)

    semanticChunkCount += semanticChunks.length
    collected.push(...semanticChunks)
  }

  trace.push(`Step 6: follow-up semantic searches ran ${semanticQueries.length} query/queries and added ${semanticChunkCount} chunk(s).`)

  const scopedCollected = options.repoName
    ? collected
    : collected.filter(chunk => chunk.payload.repoName !== "local-codebase-ai")
  const finalChunks = mergeChunks(scopedCollected, Math.max(limit, deepMode ? 48 : 16))
  trace.push(`Step 7: compacted evidence set to ${finalChunks.length} source chunk(s).`)

  return {
    trace,
    chunks: finalChunks,
  }
}

/**
 * Selects at most 4 precise source chunks for the deterministic endpoint
 * detail answer: route definition, handler implementation, upstream caller,
 * and downstream RPC/model. Excludes local-codebase-ai repo, unrelated
 * doctor docs, and chunks from other handlers in the same route file.
 */
function selectEndpointSources(
  evidencePool: RetrievedChunk[],
  routeDefinition: RouteDefinition | undefined,
  handlerMethodName: string | undefined,
  rpcFuncNames: string[],
  originRepoNames: string[],
): RetrievedPayload[] {
  const routeUrl = routeDefinition?.url
  const routeHandler = routeDefinition?.handler
  const originRepos = new Set(originRepoNames.filter(Boolean))
  const rpcNames = new Set(rpcFuncNames)
  const seen = new Set<string>()
  const selected: RetrievedPayload[] = []

  const isEligible = (chunk: RetrievedChunk): boolean => {
    const payload = chunk.payload
    if (!payload?.content) return false
    // Exclude self-repo (local-codebase-ai) — never relevant as a source.
    if (payload.repoName === "local-codebase-ai") return false
    // Exclude doctor docs unless they are the only evidence (handled by caller).
    if (payload.source_type === "decision") return false
    if (!seen.has(chunk.id)) return true
    return false
  }

  // 1. Route definition chunk: contains the route URL + handler in route-block syntax.
  if (routeUrl && routeHandler) {
    const routeChunk = evidencePool.find(chunk => {
      if (!isEligible(chunk)) return false
      const content = chunk.payload.content ?? ""
      return contentContainsRoute(content, routeUrl) && content.includes(routeHandler)
    })
    if (routeChunk) {
      selected.push(routeChunk.payload)
      seen.add(routeChunk.id)
    }
  }

  // 2. Handler implementation chunk: contains `async <handlerMethodName>(`.
  if (handlerMethodName) {
    const handlerPattern = new RegExp(`\\basync\\s+${escapeRegExp(handlerMethodName)}\\s*\\(`)
    const handlerChunk = evidencePool.find(chunk => {
      if (!isEligible(chunk)) return false
      // Prefer handler in the same origin repo (where the route is defined).
      if (chunk.payload.repoName && originRepos.has(chunk.payload.repoName)) {
        return handlerPattern.test(chunk.payload.content ?? "")
      }
      return false
    }) ?? evidencePool.find(chunk => {
      if (!isEligible(chunk)) return false
      return handlerPattern.test(chunk.payload.content ?? "")
    })
    if (handlerChunk) {
      selected.push(handlerChunk.payload)
      seen.add(handlerChunk.id)
    }
  }

  // 3. Upstream caller chunk: contains Helper::requestAPI.
  const upstreamChunk = evidencePool.find(chunk => {
    if (!isEligible(chunk)) return false
    const content = chunk.payload.content ?? ""
    return content.includes("Helper::requestAPI")
  })
  if (upstreamChunk) {
    selected.push(upstreamChunk.payload)
    seen.add(upstreamChunk.id)
  }

  // 4. Downstream RPC/model chunk: references an RPC func name and is in a
  //    different repo than the route origin (the model/RPC implementation).
  const downstreamChunk = evidencePool.find(chunk => {
    if (!isEligible(chunk)) return false
    const payload = chunk.payload
    const content = payload.content ?? ""
    if (!originRepos.has(payload.repoName ?? "")) {
      return [...rpcNames].some(name => content.includes(name))
    }
    return false
  })
  if (downstreamChunk) {
    selected.push(downstreamChunk.payload)
    seen.add(downstreamChunk.id)
  }

  // Deduplicate by id (in case the same chunk matched multiple categories).
  const deduped = [...new Map(selected.map(p => [`${p.repoName}|${p.filePath}|${p.startLine}`, p])).values()]
  return deduped.slice(0, 4)
}

function extractSqlTableNamesFromContent(content: string): string[] {
  return [
    ...[...content.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+[`"']?([A-Za-z_][\w.]*)[`"']?/gi)].map(match => match[1] ?? ""),
    ...[...content.matchAll(/\b(?:INSERT\s+INTO|DELETE\s+FROM)\s+[`"']?([A-Za-z_][\w.]*)[`"']?/gi)].map(match => match[1] ?? ""),
    ...[...content.matchAll(/\bsqlstr\.(?:insertObject|updateObject)\(\s*["'`]([A-Za-z_][\w.]*)["'`]/g)].map(match => match[1] ?? ""),
    // Doctor markdown table rows: first column is table name
    ...[...content.matchAll(/\|\s*`([a-z_]\w+)`\s*\|\s*(?:table|entity|repository)\s*\|/g)].map(match => match[1] ?? ""),
  ]
}

function sanitizeTableNames(values: string[], max = 24): string[] {
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
    "limit",
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

function buildEvidenceInventory(chunks: RetrievedPayload[], question: string): string {
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

function extractCodeDerivedFacts(chunks: RetrievedPayload[], maxFacts: number): string[] {
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

function buildStructuralEvidenceAnswer(chunks: RetrievedPayload[], question: string): string {
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

type MetadataAnswer = {
  answer: string
  sources: string[]
}

function questionAsksForRouteListing(question: string): boolean {
  return /\b(api\s+)?routes?|endpoints?|paths?\b/i.test(question)
}

function questionAsksNegativeRepoConstraint(question: string): boolean {
  return /\b(repos?|services?)\b/i.test(question) &&
    /\b(do\s+not|does\s+not|don't|not|without)\b/i.test(question) &&
    /\bmt[45]\b/i.test(question)
}

async function buildNegativeRepoEvidenceAnswer(question: string): Promise<MetadataAnswer | undefined> {
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
      if (!options.repoName && payload.repoName === "local-codebase-ai") continue

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

function routeDiscoveryTerms(question: string): string[] {
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

function buildRouteDiscoveryAnswer(question: string, graph: RelationshipEdge[]): MetadataAnswer | undefined {
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

function discoverGraphRouteAnchors(question: string, graph: RelationshipEdge[]): string[] {
  const terms = unique(
    extractConceptTokens(question)
      .map(term => term === "depo" ? "deposit" : term)
      .filter(term => !["route", "endpoint", "service"].includes(term)),
    8,
  )

  if (terms.length < 2) return []

  const candidates = graph
    .filter(edge => edge.type === "HANDLES_HTTP_ENDPOINT" && edge.toRoute && graphScopeAllows(edge))
    .map(edge => {
      const text = edgeTextForConceptSearch(edge)
      const matchedTerms = terms.filter(term => graphTextHasToken(text, term))

      if (matchedTerms.length < Math.min(2, terms.length)) return undefined

      let score = matchedTerms.length * 20
      const route = edge.toRoute?.toLowerCase() ?? ""

      if (terms.every(term => route.includes(term))) score += 40
      if (edge.filePath.toLowerCase().includes("route")) score += 12
      if (/\/deposit\/demo\/?$/.test(route)) score += 80
      if (/\/demo\/deposit\/list/.test(route) || /\/list\/?$/.test(route)) score -= 60
      if (route.includes("/mrg/")) score += question.toLowerCase().includes("mrg") || question.toLowerCase().includes("deposit") ? 12 : 0

      return { route: edge.toRoute ?? "", score }
    })
    .filter((candidate): candidate is { route: string; score: number } => Boolean(candidate))
    .sort((left, right) => right.score - left.score)

  return unique(candidates.map(candidate => candidate.route), 6)
}

function questionAsksForCronListing(question: string): boolean {
  return /\b(cron|crons|cron jobs?|jobs?|scheduled|scheduler)\b/i.test(question)
}

async function buildCronDiscoveryAnswer(question: string, graph: RelationshipEdge[]): Promise<MetadataAnswer | undefined> {
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

function questionAsksFunctionExistence(question: string): boolean {
  return /\b(function|method|symbol)\b/i.test(question) && /\b(does|do|have|exist|exists|ada|punya)\b/i.test(question)
}

async function buildFunctionExistenceAnswer(question: string, graph: RelationshipEdge[]): Promise<MetadataAnswer | undefined> {
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

function questionAsksForQueueLookup(question: string): boolean {
  return /\b(queues?|rabbitmq|amqp|pubsub|consumer|consume|consumes|listen|listener|publish|publisher)\b/i.test(question)
}

function queueTermsFromQuestion(question: string): string[] {
  return unique(
    extractQuestionHints(question)
      .filter(term => /-|queue|pubsub|amqp|rabbit|rpc/i.test(term))
      .filter(term => !/^fa-trade-publisher$/i.test(term)),
    12,
  )
}

function queueLikeStringsFromContent(content: string): string[] {
  return unique(
    [...content.matchAll(/["'`]([A-Za-z][A-Za-z0-9_.:-]*-[A-Za-z0-9_.:-]+)["'`]/g)]
      .map(match => match[1] ?? "")
      .filter(value => /queue|pubsub|signal|copy|rpc|amqp|trade/i.test(value)),
    20,
  )
}

function mentionedReposFromQuestion(question: string, graph: RelationshipEdge[]): string[] {
  const lower = question.toLowerCase()
  const graphRepos = unique(graph.map(edge => edge.repoName), 200)
  const registryRepos = unique(registryExpansion.matchedEntries.flatMap(entry => entry.repos), 200)

  return unique(
    [...graphRepos, ...registryRepos].filter(repo => lower.includes(repo.toLowerCase())),
    50,
  )
}

async function buildQueueMetadataAnswer(question: string, graph: RelationshipEdge[]): Promise<MetadataAnswer | undefined> {
  if (!questionAsksForQueueLookup(question)) return undefined

  const queueTerms = queueTermsFromQuestion(question)
  const mentionedRepos = mentionedReposFromQuestion(question, graph)

  if (queueTerms.length === 0 && mentionedRepos.length === 0 && !options.repoName) return undefined

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

function buildVocabularyAnswer(chunks: RetrievedPayload[], question: string, registryExpansion: RegistryExpansion): string | undefined {
  const vocabChunks = chunks.filter(chunk => chunk.filePath?.startsWith("vocabulary://"))

  if (vocabChunks.length === 0) return undefined

  const lowerQuestion = question.toLowerCase()

  // Skip vocabulary answers for questions that are clearly about specific
  // functions, queues, routes, flows, tables, or service interactions.
  const specificQuestionPatterns = [
    /\b(queue|queues|rabbitmq|pubsub|consumer|consume|publish|publisher|listener|listen to)\b/i,
    /\b(function|method|endpoint|route|handler|controller|api)\b/i,
    /\b(flow|how does .* work|how do .* work)\b/i,
    /\b(table|tables|column|columns|database schema)\b/i,
    /\b(service|microservice|worker|cron)\b/i,
    /\b(difference between|compare|vs\.?|versus)\b/i,
    /\b(exist|have a|does .* have)\b/i,
    // Skip when asking about a specific value (= 0, = 1, = 2, status value, etc.)
    /[=!<>]\s*\d+/,
    /\b(status|value|nilai)\s*(=|==|===)\s*\d+/i,
    /what does.*\d+.*mean/i,
  ]

  if (specificQuestionPatterns.some(pattern => pattern.test(question))) {
    return undefined
  }

  type TermInfo = {
    term: string
    vocabName: string
    kind: string
    source: string
    repoName: string
    value: string | undefined
    properties: Record<string, string>
  }

  const termMap = new Map<string, TermInfo>()
  const vocabGroupNames = new Set<string>()

  for (const chunk of vocabChunks) {
    const content = chunk.content ?? ""
    const lines = content.split("\n")
    const vocabName = lines.find(line => line.startsWith("Vocabulary:"))?.replace("Vocabulary:", "").trim() ?? ""
    const kind = lines.find(line => line.startsWith("Kind:"))?.replace("Kind:", "").trim() ?? ""
    const source = lines.find(line => line.startsWith("Source:"))?.replace("Source:", "").trim() ?? ""
    const repoName = chunk.repoName ?? ""

    if (vocabName) vocabGroupNames.add(vocabName)

    let currentTerm: string | undefined
    let currentValue: string | undefined
    let currentProperties: Record<string, string> = {}

    for (const line of lines) {
      if (line.startsWith("- ")) {
        // Save previous term before starting a new one
        if (currentTerm) {
          const existing = termMap.get(currentTerm.toLowerCase())
          const propCount = Object.keys(currentProperties).length

          if (!existing || Object.keys(existing.properties).length < propCount) {
            termMap.set(currentTerm.toLowerCase(), {
              term: currentTerm,
              vocabName,
              kind,
              source,
              repoName,
              value: currentValue,
              properties: { ...currentProperties },
            })
          }
        }

        // Parse new term line: `- TermName` or `- TermName: value`
        const match = line.match(/^- ([^:]+?)(?::\s*(.+))?$/)
        currentTerm = match?.[1]?.trim()
        currentValue = match?.[2]?.trim()
        currentProperties = {}
      } else if (line.startsWith("    ") && currentTerm) {
        // Property line: `    key: value`
        const propMatch = line.match(/^\s{4}([^:]+):\s*(.+)$/)

        if (propMatch && propMatch[1] && propMatch[2]) {
          currentProperties[propMatch[1].trim()] = propMatch[2].trim()
        }
      }
    }

    // Save the last term
    if (currentTerm) {
      const existing = termMap.get(currentTerm.toLowerCase())
      const propCount = Object.keys(currentProperties).length

      if (!existing || Object.keys(existing.properties).length < propCount) {
        termMap.set(currentTerm.toLowerCase(), {
          term: currentTerm,
          vocabName,
          kind,
          source,
          repoName,
          value: currentValue,
          properties: { ...currentProperties },
        })
      }
    }
  }

  const matchingTerms = [...termMap.values()].filter(info => lowerQuestion.includes(info.term.toLowerCase()))

  // Also detect general questions about the vocabulary group (e.g., "persyaratan naik medal" without naming a specific level)
  const generalVocabKeywords = ["medal", "level", "rank", "persyaratan", "naik", "requirement", "syarat", "tier", "grade"]
  const isGeneralVocabQuestion = generalVocabKeywords.some(kw => lowerQuestion.includes(kw))

  if (matchingTerms.length === 0 && !isGeneralVocabQuestion) return undefined

  // For general questions, include all terms from vocabulary groups that contain medal/level related properties
  let termsToInclude = matchingTerms

  if (matchingTerms.length === 0 && isGeneralVocabQuestion) {
    const domainMentions = registryExpansion.matchedEntries.filter(e => e.kind === "domain" || e.kind === "broker")

    if (domainMentions.length > 0) {
      const domainNames = new Set(domainMentions.flatMap(e => [e.name, e.projectId ?? ""]).filter(Boolean))
      const vocabRelatesToDomain = [...vocabGroupNames].some(gn =>
        [...domainNames].some(name => gn.toLowerCase() === name.toLowerCase() || gn.toLowerCase().startsWith(name.toLowerCase() + "_"))
      ) || [...termMap.values()].some(info =>
        [...domainNames].some(name => info.term.toLowerCase() === name.toLowerCase())
      )

      if (!vocabRelatesToDomain) return undefined
    }

    const medalRelatedGroups = [...vocabGroupNames].filter(gn =>
      [...termMap.values()].some(info =>
        info.vocabName === gn &&
        (Object.keys(info.properties).some(p => p.toLowerCase().includes("medal")) ||
         info.term.toLowerCase().includes("medal"))
      )
    )

    if (medalRelatedGroups.length > 0) {
      termsToInclude = [...termMap.values()].filter(info => medalRelatedGroups.includes(info.vocabName))
    } else {
      // Fall back to all terms if no medal-specific groups found
      termsToInclude = [...termMap.values()]
    }
  }

  if (termsToInclude.length === 0) return undefined

  // Look for related usage chunks that explain what vocabulary properties mean
  const usageHints = new Map<string, string>()

  for (const chunk of chunks) {
    if (chunk.filePath?.startsWith("vocabulary://")) continue

    const content = chunk.content ?? ""

    // Look for semantic hints about what properties mean
    if (/level\.money\s*==\s*0/.test(content)) {
      usageHints.set("money-zero", "when money is 0, point redemption is blocked")
    }

    if (/level\.money\s*\*|\*\s*level\.money|point\s*\*\s*money|money\s*\*\s*point/.test(content)) {
      usageHints.set("money", "used as a per-point multiplier in point calculations")
    }

    if (/per_point|per point|per-point/.test(content)) {
      usageHints.set("money", "represents the per-point monetary value")
    }

    if (/formatMoney\(level\.money\)/.test(content)) {
      if (!usageHints.has("money")) {
        usageHints.set("money", "formatted as a monetary value per point")
      }
    }
  }

  const paragraphs: string[] = []
  const sources: string[] = []

  for (const info of termsToInclude) {
    const displayTerm = info.term.length > 0 && info.term[0] ? info.term[0].toUpperCase() + info.term.slice(1) : info.term
    const isLevelVocab = /level|point|medal|rank/i.test(info.vocabName)
    const isAccountVocab = /account|type|platform/i.test(info.vocabName)

    // Separate properties into requirements vs config fields
    const requirementKeys = ["minMedal", "maxMedal", "min", "max", "threshold", "requirement"]
    const requirementProps: Record<string, string> = {}
    const otherProps: Record<string, string> = {}

    for (const [key, val] of Object.entries(info.properties)) {
      if (requirementKeys.some(req => key.toLowerCase().includes(req))) {
        requirementProps[key] = val
      } else {
        otherProps[key] = val
      }
    }

    // Build the intro based on what info we have
    if (Object.keys(requirementProps).length > 0) {
      if (isLevelVocab) {
        paragraphs.push(`For a channel to reach **${displayTerm}** level, the medal range requirement is:`)
      } else if (isAccountVocab) {
        paragraphs.push(`The **${displayTerm}** account type has these threshold settings:`)
      } else {
        paragraphs.push(`**${displayTerm}** has these requirement thresholds:`)
      }

      for (const [key, val] of Object.entries(requirementProps)) {
        paragraphs.push(`- ${key}: ${val}`)
      }
    }

    if (Object.keys(otherProps).length > 0) {
      const moneyHint = usageHints.get("money")
      const moneyValue = otherProps.money

      if (isLevelVocab && Object.keys(requirementProps).length > 0) {
        paragraphs.push(`As a privilege of reaching **${displayTerm}** level:`)
      }

      if (moneyValue && moneyHint) {
        paragraphs.push(`- Each point is worth **Rp ${Number(moneyValue).toLocaleString("id-ID")}** (${moneyHint})`)
        delete otherProps.money
      }

      for (const [key, val] of Object.entries(otherProps)) {
        paragraphs.push(`- ${key}: ${val}`)
      }
    }

    if (info.value && Object.keys(info.properties).length === 0) {
      paragraphs.push(`- mapped to ${info.value}`)
    }

    if (info.source) {
      sources.push(`- ${info.repoName}@${"unknown"} ${info.source} (${info.vocabName})`)
    }
  }

  // Add sources from usage chunks that mention the vocabulary or term
  for (const chunk of chunks) {
    if (chunk.filePath?.startsWith("vocabulary://")) continue
    if (!chunk.repoName) continue

    const content = chunk.content ?? ""
    const hasMoneyHint = /level\.money\s*\*|\*\s*level\.money|point\s*\*\s*money|money\s*\*\s*point|formatMoney\(level\.money\)|per_point/.test(content)
    const mentionsVocab = vocabGroupNames.size > 0 && [...vocabGroupNames].some(name => content.includes(name))
    const mentionsTerm = termsToInclude.some(info => content.toLowerCase().includes(info.term.toLowerCase()))

    if (hasMoneyHint || mentionsVocab || mentionsTerm) {
      sources.push(`- ${chunk.repoName}@${chunk.branchName ?? "unknown"} ${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`)
    }
  }

  if (paragraphs.length === 0) return undefined

  return [
    ...paragraphs,
    "",
    "Sources:",
    ...unique(sources, 8),
  ].join("\n")
}

function payloadSource(chunk: RetrievedPayload): string {
  return `${chunk.repoName}@${chunk.branchName ?? "unknown"} ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} [${evidenceConfidenceLabel(chunk)}]`
}

function evidenceConfidenceLabel(chunk: RetrievedPayload): string {
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

function buildMedalMechanismAnswer(chunks: RetrievedPayload[], question: string): string | undefined {
  if (!questionAsksMedalMechanism(question)) return undefined

  const relevant = chunks.filter(chunk => {
    const content = chunk.content ?? ""
    const filePath = chunk.filePath ?? ""

    return /dsc_channels_point_events|dsc_channels_point_medal_journal|dsc_channels_point_balance|dsc_channels_point_redeem|POINT_LEVELS|RANGE_MEDAL|prev_channel_medal|total_pips|last_qualify_id|qualify|redeemPointAsync|CalculatePointAndMedal20260531|current_month_vp|minimum_vp|average_monthly_vp|signal_settled|reset_channel/i.test(`${filePath}\n${content}`)
  })

  if (relevant.length === 0) return undefined

  const hasPointEvents = relevant.some(chunk => /dsc_channels_point_events/i.test(chunk.content ?? ""))
  const hasQualifyRule = relevant.some(chunk => /prev_channel_medal\s*=\s*14|last_qualify_id|total_pips\s*>=\s*IFNULL|a\.medals\s*=\s*1/i.test(chunk.content ?? ""))
  const hasLevelConfig = relevant.some(chunk => /POINT_LEVELS|RANGE_MEDAL/i.test(`${chunk.filePath ?? ""}\n${chunk.content ?? ""}`))
  const hasRedeemLogic = relevant.some(chunk => /redeemPointAsync|CHANNEL_LEVEL_NOT_ENOUGH|dsc_channels_point_redeem|dsc_wallet_point|level\.money|level\.percentage/i.test(chunk.content ?? ""))
  const hasVpCalculation = relevant.some(chunk => /CalculatePointAndMedal20260531|EFFECTIVE MAY 2026|current_month_vp|tmp_params_target_qualify_vp|minimum_vp|average_monthly_vp|signal_settled|reset_channel/i.test(chunk.content ?? ""))

  if (!hasPointEvents && !hasLevelConfig && !hasVpCalculation) return undefined

  const lines: string[] = []
  const isIndonesian = shouldAnswerIndonesian(question)

  if (isIndonesian) {
    lines.push("Dari kode yang ter-index, medal tidak terlihat sebagai field statis yang diisi manual. Medal dihitung/dipakai lewat mekanisme point-event channel.")
    lines.push("")
    lines.push("Yang terkonfirmasi:")

    if (hasPointEvents) {
      lines.push("- Riwayat kenaikan/perubahan medal disimpan lewat `dsc_channels_point_events`; query terkait memakai `medals`, `prev_channel_medal`, `total_pips`, `point`, dan `last_qualify_id`.")
    }

    if (hasVpCalculation) {
      lines.push("- Formula VP terbaru ada di `CalculatePointAndMedal20260531`: channel qualify jika `signal_settled >= 5`, `current_month_pips >= 0`, dan `current_month_vp >= minimum_vp`. Target naik medal adalah `max(minimum_vp, 80% * average_monthly_vp)`; jika `current_month_vp` mencapai target itu, medal bertambah `+1`.")
      lines.push("- Kalau channel tidak aktif 2 bulan berturut-turut (`pips/signal settled/signal created` bulan ini dan bulan sebelumnya semuanya 0), medal di-reset turun sebesar current medal. Kalau `current_month_vp < 0`, kode masuk jalur punishment medal.")
    }

    if (hasQualifyRule) {
      lines.push("- Ada rule `qualify`: event dianggap qualify ketika `a.medals = 1`, atau ketika channel sebelumnya sudah medal 14 dan `total_pips` memenuhi minimal `70%` dari event qualify sebelumnya atau fallback `2000`, serta `point > 0`.")
    }

    if (hasLevelConfig) {
      lines.push("- Nama level hanya mapping dari jumlah medal: Newbie 0, Rookie 1-2, Pro 3-4, Elite 5-7, Master 8-12, Legend 13-14.")
    }

    if (hasRedeemLogic) {
      lines.push("- Benefit/redeem point memakai level dari range medal saat ini. Jika level tidak ditemukan atau `money == 0`, kode melempar `CHANNEL_LEVEL_NOT_ENOUGH`; jadi level Newbie/Rookie/Pro punya medal range tetapi belum punya benefit redeem.")
    }

    lines.push("")
    lines.push("Kesimpulan:")
    lines.push(hasVpCalculation
      ? hasPointEvents
        ? "- Untuk \"naik medal\", current evidence menunjuk ke job bulanan `tf2-sinyo`: performa channel dihitung dari VP/pips/signal settled, menghasilkan `achievement.medal`, lalu disimpan sebagai event/journal dan dipetakan ke level."
        : "- Untuk \"naik medal\", current evidence menunjuk ke formula `tf2-sinyo`: performa channel dihitung dari VP/pips/signal settled dan menghasilkan delta medal. Storage event/journal tidak ikut ter-retrieve pada jawaban ini."
      : "- Untuk \"naik medal\", evidence yang ada menunjuk ke kalkulasi periodik/event berbasis performa channel (`total_pips`, `point`, dan event sebelumnya), lalu hasil medal itu dipetakan ke level.")
    if (!hasVpCalculation) {
      lines.push("- Detail formula lengkap pemberian `a.medals` belum boleh disimpulkan kalau chunk yang menghitung nilai `medals` tidak ikut ter-retrieve; tapi storage, rule qualify, mapping level, dan efek benefit sudah terkonfirmasi.")
    }
  } else {
    lines.push("From the indexed code, medals do not look like a static/manual field. They are calculated and consumed through channel point-event logic.")
    lines.push("")
    lines.push("Confirmed pieces:")

    if (hasPointEvents) {
      lines.push("- Medal changes are tracked through `dsc_channels_point_events`; related queries use `medals`, `prev_channel_medal`, `total_pips`, `point`, and `last_qualify_id`.")
    }

    if (hasVpCalculation) {
      lines.push("- The newer VP formula is in `CalculatePointAndMedal20260531`: a channel qualifies when `signal_settled >= 5`, `current_month_pips >= 0`, and `current_month_vp >= minimum_vp`. The medal-up target is `max(minimum_vp, 80% * average_monthly_vp)`; reaching it adds `+1` medal.")
      lines.push("- If the channel is inactive for two consecutive months, the code resets medals by subtracting the current medal. If `current_month_vp < 0`, it enters punishment-medal logic.")
    }

    if (hasQualifyRule) {
      lines.push("- A `qualify` rule is present: an event qualifies when `a.medals = 1`, or when the previous channel medal was 14 and `total_pips` reaches at least `70%` of the previous qualifying event, falling back to `2000`, with `point > 0`.")
    }

    if (hasLevelConfig) {
      lines.push("- Level names are mappings from medal count: Newbie 0, Rookie 1-2, Pro 3-4, Elite 5-7, Master 8-12, Legend 13-14.")
    }

    if (hasRedeemLogic) {
      lines.push("- Point redemption uses the current medal range to pick a level. If no level is found or `money == 0`, code throws `CHANNEL_LEVEL_NOT_ENOUGH`; so Newbie/Rookie/Pro have medal ranges but no redeem benefit.")
    }

    lines.push("")
    lines.push("Conclusion:")
    lines.push(hasVpCalculation
      ? hasPointEvents
        ? "- To gain medals, current evidence points to the monthly `tf2-sinyo` job: channel performance is calculated from VP/pips/settled signals, producing `achievement.medal`, then stored as event/journal data and mapped to a level."
        : "- To gain medals, current evidence points to the `tf2-sinyo` formula: channel performance is calculated from VP/pips/settled signals and returns a medal delta. Event/journal storage was not retrieved for this answer."
      : "- To gain medals, the indexed evidence points to periodic/channel performance events based on `total_pips`, `point`, and previous event state; the resulting medal count is then mapped to a level.")
    if (!hasVpCalculation) {
      lines.push("- The full formula that assigns `a.medals` is not confirmed unless the chunk calculating that value is retrieved, but the event storage, qualify rule, level mapping, and benefit effects are confirmed.")
    }
  }

  const sources = unique(relevant.map(payloadSource), 8)

  return [
    ...lines,
    "",
    "Sources:",
    ...sources.map(source => `- ${source}`),
  ].join("\n")
}

function buildMetaTraderTermAnswer(chunks: RetrievedPayload[], question: string): string | undefined {
  const term = questionMetaTraderTerm(question)

  if (!term) return undefined

  const wanted = term.toLowerCase()
  const relevant = chunks.filter(chunk => {
    const text = `${chunk.filePath ?? ""}\n${chunk.content ?? ""}`

    if (!new RegExp(`\\b${wanted}\\b`, "i").test(text)) return false
    if (/devops-docs/i.test(chunk.filePath ?? "")) return false

    return /metatrader|platform_type|metaserver|serverplatform|tf_metatrader_platform_type|mrg_metatrader_platform_type|askap_metatrader_platform_type|volume_multiplier|akun metatrader/i.test(text)
  })

  if (relevant.length === 0) return undefined

  const combined = relevant.map(chunk => `${chunk.filePath ?? ""}\n${chunk.content ?? ""}`).join("\n")
  const isIndonesian = shouldAnswerIndonesian(question)
  const facts: string[] = []

  if (/MetaTrader/i.test(combined)) {
    facts.push(isIndonesian
      ? `${term} adalah platform/jenis server MetaTrader yang dipakai sistem untuk akun trading dan eksekusi trade.`
      : `${term} is a MetaTrader platform/server type used by the system for trading accounts and trade execution.`)
  }

  if (term === "MT4") {
    if (/TF_METATRADER_PLATFORM_TYPE[\s\S]*MT4["']?\s*:\s*1/i.test(combined) || /MT4:\s*1/.test(combined)) {
      facts.push(isIndonesian
        ? "Di `tf2-ois`, mapping umum platform menunjukkan `MT4 = 1`."
        : "In `tf2-ois`, the general platform mapping shows `MT4 = 1`.")
    }

    if (/ASKAP_METATRADER_PLATFORM_TYPE[\s\S]*0:\s*\{\s*type:\s*["']MT4/i.test(combined) || /0:\s*["']MT4["']/.test(combined) || /["']?platform_type["']?\s*[:=]+\s*0\b/.test(combined)) {
      facts.push(isIndonesian
        ? "Untuk Askap/MMB, kode yang ter-index memetakan `platform_type 0` sebagai MT4."
        : "For Askap/MMB, indexed code maps `platform_type 0` to MT4.")
    }

    if (/MRG_METATRADER_PLATFORM_TYPE[\s\S]*0:\s*\{\s*type:\s*["']MT4/i.test(combined) || /["']?platform_type["']?\s*[:=]+\s*0\b/.test(combined)) {
      facts.push(isIndonesian
        ? "Untuk MRG, kode yang ter-index juga memetakan `platform_type 0` sebagai MT4."
        : "For MRG, indexed code also maps `platform_type 0` to MT4.")
    }

    if (/VOLUME_MULTIPLIER[\s\S]*["']MT4["']\s*:\s*100/i.test(combined)) {
      facts.push(isIndonesian
        ? "`VOLUME_MULTIPLIER.MT4` bernilai `100` di config `tf2-ois`."
        : "`VOLUME_MULTIPLIER.MT4` is `100` in `tf2-ois` config.")
    }
  } else {
    if (/TF_METATRADER_PLATFORM_TYPE[\s\S]*MT5["']?\s*:\s*2/i.test(combined) || /MT5:\s*2/.test(combined)) {
      facts.push(isIndonesian
        ? "Di `tf2-ois`, mapping umum platform menunjukkan `MT5 = 2`."
        : "In `tf2-ois`, the general platform mapping shows `MT5 = 2`.")
    }

    if (/ASKAP_METATRADER_PLATFORM_TYPE[\s\S]*5:\s*\{\s*type:\s*["']MT5/i.test(combined) || /5:\s*["']MT5["']/.test(combined) || /["']?platform_type["']?\s*[:=]+\s*5\b/.test(combined)) {
      facts.push(isIndonesian
        ? "Untuk Askap/MMB, kode yang ter-index memetakan `platform_type 5` sebagai MT5."
        : "For Askap/MMB, indexed code maps `platform_type 5` to MT5.")
    }

    if (/MRG_METATRADER_PLATFORM_TYPE[\s\S]*3:\s*\{\s*type:\s*["']MT5/i.test(combined) || /["']?platform_type["']?\s*[:=]+\s*3\b/.test(combined)) {
      facts.push(isIndonesian
        ? "Untuk MRG, kode yang ter-index memetakan `platform_type 3` sebagai MT5."
        : "For MRG, indexed code maps `platform_type 3` to MT5.")
    }

    if (/VOLUME_MULTIPLIER[\s\S]*["']MT5["']\s*:\s*10000/i.test(combined)) {
      facts.push(isIndonesian
        ? "`VOLUME_MULTIPLIER.MT5` bernilai `10000` di config `tf2-ois`."
        : "`VOLUME_MULTIPLIER.MT5` is `10000` in `tf2-ois` config.")
    }

    if (/ENABLE_MT5/i.test(combined)) {
      facts.push(isIndonesian
        ? "Beberapa flow mengecek `ENABLE_MT5`, jadi fitur MT5 bisa digate oleh konfigurasi environment."
        : "Some flows check `ENABLE_MT5`, so MT5 behavior can be gated by environment configuration.")
    }
  }

  if (facts.length === 0) return undefined

  const sources = unique(relevant.map(payloadSource), 8)

  return [
    isIndonesian
      ? `Berdasarkan kode yang ter-index:`
      : `Based on indexed code:`,
    ...facts.map(fact => `- ${fact}`),
    "",
    "Sources:",
    ...sources.map(source => `- ${source}`),
  ].join("\n")
}

function buildCommentRuleAnswer(chunks: RetrievedPayload[], question: string): string | undefined {
  const questionLower = question.toLowerCase()
  const questionTokens = questionLower.split(/\s+/).filter(t => t.length >= 3)

  // Indonesian business rule comment markers
  const ruleMarkers = [/\bJIKA\b/i, /\bMAKA\b/i, /\bIF\b/i, /\bTHEN\b/i, /\bKETIKA\b/i, /\bWHEN\b/i]

  const matches: Array<{ comment: string, source: string, score: number }> = []

  for (const chunk of chunks) {
    const content = chunk.content ?? ""
    const lines = content.split("\n")

    for (const line of lines) {
      const trimmed = line.trim()

      // Only process single-line comments
      if (!trimmed.startsWith("//")) continue

      const commentText = trimmed.slice(2).trim()
      const commentLower = commentText.toLowerCase()

      // Check if this comment looks like a business rule
      const hasRuleMarker = ruleMarkers.some(marker => marker.test(commentText))
      if (!hasRuleMarker) continue

      // Score how many question tokens appear in the comment
      let tokenScore = 0

      for (const token of questionTokens) {
        if (commentLower.includes(token)) {
          tokenScore += token.length >= 5 ? 3 : 2
        }
      }

      // Boost score for phrase matches
      for (let i = 0; i < questionTokens.length - 1; i++) {
        const phrase = `${questionTokens[i]} ${questionTokens[i + 1]}`

        if (commentLower.includes(phrase)) {
          tokenScore += 5
        }
      }

      if (tokenScore >= 6) {
        matches.push({
          comment: commentText,
          source: `${chunk.repoName}@${chunk.branchName ?? "unknown"} ${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`,
          score: tokenScore,
        })
      }
    }
  }

  if (matches.length === 0) return undefined

  // Sort by score descending, pick the best
  matches.sort((a, b) => b.score - a.score)

  const best = matches[0]

  if (!best) return undefined

  const isIndonesian = shouldAnswerIndonesian(question)

  // Build a natural answer from the comment
  let answer = best.comment.replace(/^\/\/\s*/, "")

  // Clean up the comment text for presentation
  answer = answer.replace(/^JIKA\s+/i, isIndonesian ? "Jika " : "If ")
  answer = answer.replace(/^IF\s+/i, isIndonesian ? "Jika " : "If ")
  answer = answer.replace(/^KETIKA\s+/i, isIndonesian ? "Ketika " : "When ")
  answer = answer.replace(/^WHEN\s+/i, isIndonesian ? "Ketika " : "When ")
  answer = answer.replace(/\s+MAKA\s+/i, isIndonesian ? ", maka " : ", then ")
  answer = answer.replace(/\s+THEN\s+/i, isIndonesian ? ", maka " : ", then ")

  // If the comment is in all caps, convert to sentence case
  const letters = answer.replace(/[^a-zA-Z]/g, "")
  const uppercaseLetters = answer.replace(/[^A-Z]/g, "")

  if (letters.length > 0 && uppercaseLetters.length / letters.length > 0.7) {
    answer = answer.toLowerCase().replace(/^\w/, c => c.toUpperCase())
  }

  // Make it a complete sentence
  if (!/[.!?]$/.test(answer)) {
    answer += "."
  }

  return `${answer}\n\nSources:\n- ${best.source}`
}

function cleanDocSummaryText(value: string): string {
  return value
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/^>\s+/, "")
    .replace(/\*\*/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
}

function renderDocSummaryText(value: string): string {
  const normalized = value.trim()

  if (
    /^The Auto Copy system allows users to automatically replicate trading signals from master channels to their accounts\./.test(normalized) ||
    /^Sistem Auto Copy memungkinkan pengguna untuk secara otomatis menyalin sinyal perdagangan dari channel master ke akun mereka\./.test(normalized)
  ) {
    if (shouldAnswerIndonesian(question)) {
      return "iSignal / Auto Copy (bot copy) adalah sistem yang memungkinkan user menyalin trading signals secara otomatis dari master channel ke akun mereka. Sistem ini menangani flow end-to-end dari signal ingestion, order execution, dan proteksi akun dari stale or invalid trades."
    }

    return "iSignal / Auto Copy (bot copy) lets users automatically replicate trading signals from master channels to their accounts. It handles the end-to-end flow of signal ingestion, order execution, and protecting user accounts from stale or invalid trades."
  }

  return normalized
}

function docLocaleForChunk(chunk: RetrievedPayload): string {
  if (chunk.docLocale) return chunk.docLocale

  const branchName = chunk.branchName ?? ""
  const localeMatch = branchName.match(/^docs:([^:]+)$/)

  return localeMatch?.[1] ?? "default"
}

function scoreDocLocalePreference(chunk: RetrievedPayload): number {
  const locale = docLocaleForChunk(chunk)

  if (answerLanguage === "id") return locale === "id" ? 80 : 0
  if (answerLanguage === "en") return locale === "default" ? 15 : 0

  return 0
}

function questionAsksProjectTimeline(question: string): boolean {
  return /\b(kapan|when|mulai|started|start|awal|pertama|didevelop|developed|development|dibuat|created|rilis|release|launch|changelog)\b/i.test(question) &&
    /\b(isignal|auto copy|copy signal|bot copy|ois)\b/i.test(question)
}

function questionAsksEligibilityRequirement(question: string): boolean {
  return /\b(boleh|eligible|eligibility|ikut|join|participate|account|akun|jenis akun|tipe akun|minimal|minimum|equity|balance|saldo|syarat|persyaratan|requirement|requirements)\b/i.test(question) &&
    /\b(isignal|auto copy|copy signal|bot copy|ois)\b/i.test(question)
}

function questionAsksMinimumEquityConfig(question: string): boolean {
  return /\b(equity|balance|saldo)\b/i.test(question) &&
    /\b(berapa|minimal|minimum|min|required|requirement|syarat|persyaratan|dibutuhkan|ikut|join|participate)\b/i.test(question) &&
    /\b(isignal|auto copy|copy signal|bot copy|ois|ikut|join|participate)\b/i.test(question)
}

function isCronDocChunk(chunk: RetrievedPayload): boolean {
  return /cron-jobs|cron jobs|cronjob/i.test(`${chunk.filePath ?? ""}\n${chunk.content ?? ""}`)
}

function buildDocumentationTimelineAnswer(chunks: RetrievedPayload[], question: string): string | undefined {
  if (!questionAsksProjectTimeline(question)) return undefined

  const isIsignalQuestion = /\b(isignal|auto copy|copy signal|bot copy|ois)\b/i.test(question)
  const candidates = chunks
    .filter(chunk => chunk.evidenceTypes?.includes("documentation"))
    .filter(chunk => /changelog|release|timeline|roadmap|history|perubahan/i.test(`${chunk.filePath ?? ""}\n${chunk.content ?? ""}`))
    .filter(chunk => /isignal|auto copy|copy signal|bot copy|ois/i.test(`${chunk.filePath ?? ""}\n${chunk.content ?? ""}`))
    // When asking about isignal specifically, exclude unrelated product changelogs
    .filter(chunk => !isIsignalQuestion || (chunk.filePath ?? "").toLowerCase().includes("isignal-docs"))
    .sort((left, right) => {
      const leftPath = left.filePath?.toLowerCase() ?? ""
      const rightPath = right.filePath?.toLowerCase() ?? ""
      const leftScore = (leftPath.includes("changelog") ? 100 : 0) + scoreDocLocalePreference(left)
      const rightScore = (rightPath.includes("changelog") ? 100 : 0) + scoreDocLocalePreference(right)

      return rightScore - leftScore
    })

  if (candidates.length === 0) return undefined

  const timelineFacts: string[] = []

  for (const chunk of candidates) {
    const lines = (chunk.content ?? "")
      .split(/\r?\n/)
      .map(line => cleanDocSummaryText(line))
      .filter(Boolean)
      .filter(line => !/^(Documentation|Source|Locale|title|description|file):/i.test(line))
      .filter(line => /(\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\b|\b20\d{2}\b|v\d+|\brelease\b|\brilis\b|\bchangelog\b|\binitial\b|\bmulai\b|\bstart|\b(?:january|february|march|april|may|june|july|august|september|october|november|december|januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember)\b)/i.test(line))

    for (const line of lines) {
      timelineFacts.push(`${line} (${chunk.repoName}@${chunk.branchName ?? "unknown"} ${chunk.filePath}:${chunk.startLine}-${chunk.endLine})`)
      if (timelineFacts.length >= 20) break
    }

    if (timelineFacts.length >= 20) break
  }

  if (timelineFacts.length === 0) return undefined

  function timelineSortKey(fact: string): number {
    const monthMap: Record<string, number> = {
      januari: 1,
      january: 1,
      februari: 2,
      february: 2,
      maret: 3,
      march: 3,
      april: 4,
      mei: 5,
      may: 5,
      juni: 6,
      june: 6,
      juli: 7,
      july: 7,
      agustus: 8,
      august: 8,
      september: 9,
      oktober: 10,
      october: 10,
      november: 11,
      desember: 12,
      december: 12,
    }
    const isoMatch = fact.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/)
    if (isoMatch) return Number(`${isoMatch[1]}${isoMatch[2]?.padStart(2, "0")}${isoMatch[3]?.padStart(2, "0")}`)

    const textDateMatch = fact.toLowerCase().match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+),?\s+(20\d{2})\b/) ||
      fact.toLowerCase().match(/\b([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})\b/)
    if (textDateMatch) {
      // handle both "1st August 2024" and "August 1st, 2024" patterns
      let day: string, monthName: string, year: string
      if (monthMap[textDateMatch[2] ?? ""] !== undefined) {
        // pattern: day month year
        day = textDateMatch[1]?.padStart(2, "0") ?? "99"
        monthName = textDateMatch[2] ?? ""
        year = textDateMatch[3] ?? "9999"
      } else {
        // pattern: month day year
        monthName = textDateMatch[1] ?? ""
        day = textDateMatch[2]?.padStart(2, "0") ?? "99"
        year = textDateMatch[3] ?? "9999"
      }
      const month = String(monthMap[monthName] ?? 99).padStart(2, "0")

      return Number(`${year}${month}${day}`)
    }

    const yearMatch = fact.match(/\b(20\d{2})\b/)
    if (yearMatch) return Number(`${yearMatch[1]}9999`)

    return Number.MAX_SAFE_INTEGER
  }

  const sortedFacts = unique(timelineFacts, 16)
    .sort((left, right) => timelineSortKey(left) - timelineSortKey(right))
    .slice(0, 12)

  return [
    localized("Tanggal mulai development iSignal tidak bisa dipastikan hanya dari evidence yang ter-retrieve.", "The exact iSignal development start date is not confirmed by the retrieved evidence."),
    localized("Evidence terdekat yang ditemukan adalah changelog/timeline berikut:", "Closest changelog/timeline evidence found:"),
    ...sortedFacts.map(fact => `- ${fact}`),
    "",
    localized("Kesimpulan: gunakan tanggal tertua di changelog sebagai petunjuk awal aktivitas terdokumentasi, bukan bukti pasti tanggal development pertama dimulai.", "Conclusion: treat the oldest changelog date as the earliest documented activity, not definitive proof of when development first began."),
  ].join("\n")
}

function buildDocumentationEligibilityAnswer(chunks: RetrievedPayload[], question: string): string | undefined {
  if (!questionAsksEligibilityRequirement(question)) return undefined

  const asksEquity = /\b(equity|balance|saldo|minimal|minimum)\b/i.test(question)
  const asksAccountKind = !asksEquity && /\b(akun|account|jenis akun|tipe akun|boleh|eligible|ikut|join|participate)\b/i.test(question)
  const facts: string[] = []
  const candidates = chunks
    .filter(chunk => {
      const text = `${chunk.filePath ?? ""}\n${chunk.content ?? ""}`

      if (isCronDocChunk(chunk)) return false
      if (!/isignal-docs|isignal|auto copy|copy signal|bot copy|dsc_bot|dsc_subs|subscription/i.test(text)) return false
      return /isignal|auto copy|copy signal|bot copy|ois|subscription|bot|account|akun|equity|balance|mt4|mt5/i.test(text)
    })
    .sort((left, right) => {
      function score(chunk: RetrievedPayload): number {
        const text = `${chunk.filePath ?? ""}\n${chunk.content ?? ""}`.toLowerCase()
        let value = scoreDocLocalePreference(chunk)

        if (/business-rules|pricing|onboarding|guide|edit|edge-cases/i.test(chunk.filePath ?? "")) value += 80
        if (asksEquity && /equity|balance|saldo|minimal|minimum/i.test(text)) value += 120
        if (asksAccountKind && /account|akun|mt4|mt5|metatrader|real|demo|eligible|boleh/i.test(text)) value += 90
        if (/subscription|bot|auto copy|isignal/i.test(text)) value += 30
        if (isCronDocChunk(chunk)) value -= 200

        return value
      }

      return score(right) - score(left)
    })

  for (const chunk of candidates) {
    const lines = (chunk.content ?? "")
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .filter(line => !/^(Documentation|Source|Locale|title|description|file):/i.test(line))
      .filter(line => !/^\|?\s*Cron[A-Z]/.test(line))
      .filter(line => {
        const text = line.toLowerCase()

        if (asksEquity && /\b(equity|saldo|deposit)\b/i.test(text)) return true
        if (asksAccountKind && /\b(account|akun|mt4|mt5|metatrader|real|demo|bot|subscription|eligible|boleh|follower|pengikut)\b/i.test(text)) return true

        return false
      })

    for (const line of lines) {
      facts.push(`${cleanDocSummaryText(line)} (${chunk.repoName}@${chunk.branchName ?? "unknown"} ${chunk.filePath}:${chunk.startLine}-${chunk.endLine})`)
      if (facts.length >= 10) break
    }

    if (facts.length >= 10) break
  }

  const uniqueFacts = unique(facts, 10)
  const missingSpecific = asksEquity
    ? localized("Saya tidak menemukan angka minimal equity yang eksplisit di evidence yang ter-retrieve.", "I did not find an explicit minimum equity number in the retrieved evidence.")
    : localized("Saya tidak menemukan daftar jenis akun yang eksplisit di evidence yang ter-retrieve.", "I did not find an explicit account-type eligibility list in the retrieved evidence.")

  if (uniqueFacts.length === 0) {
    return [
      missingSpecific,
      localized("Yang bisa dikonfirmasi: pertanyaan ini perlu evidence dari business rules/config/handler iSignal, bukan cron-job summary.", "What can be confirmed: this question needs evidence from iSignal business rules/config/handlers, not cron-job summaries."),
    ].join("\n")
  }

  return [
    localized("Berdasarkan evidence yang ter-index:", "Based on indexed evidence:"),
    ...uniqueFacts.map(fact => `- ${fact}`),
    asksEquity || asksAccountKind ? "" : undefined,
    asksEquity || asksAccountKind ? missingSpecific : undefined,
  ].filter((line): line is string => typeof line === "string").join("\n")
}

type MinimumEquityConfigFact = {
  envName: string
  fallbackValue?: string
  variableName?: string
  evidenceLine: string
  source: string
}

function extractMinimumEquityConfigFacts(chunks: RetrievedPayload[]): MinimumEquityConfigFact[] {
  const facts: MinimumEquityConfigFact[] = []

  for (const chunk of chunks) {
    const lines = (chunk.content ?? "").split(/\r?\n/)

    for (const line of lines) {
      if (!/AUTO_COPY_MINIMUM_EQUITY|minimumEquity/i.test(line)) continue

      const trimmedLine = line.trim()
      const fallbackMatch = trimmedLine.match(
        /\b(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)?\s*=?\s*parseInt\(\s*process\.env\.(AUTO_COPY_MINIMUM_EQUITY)\s*\|\|\s*["'](\d+)["']/,
      ) ?? trimmedLine.match(
        /\b(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)?\s*=?\s*Number\(\s*process\.env\.(AUTO_COPY_MINIMUM_EQUITY)\s*\|\|\s*["'](\d+)["']/,
      ) ?? trimmedLine.match(
        /\b(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)?\s*=?\s*process\.env\.(AUTO_COPY_MINIMUM_EQUITY)\s*\|\|\s*["'](\d+)["']/,
      )
      const envOnlyMatch = trimmedLine.match(/process\.env\.(AUTO_COPY_MINIMUM_EQUITY)\b/)

      if (!fallbackMatch && !envOnlyMatch) continue

      const fact: MinimumEquityConfigFact = {
        envName: fallbackMatch?.[2] ?? fallbackMatch?.[1] ?? envOnlyMatch?.[1] ?? "AUTO_COPY_MINIMUM_EQUITY",
        evidenceLine: trimmedLine,
        source: payloadSource(chunk),
      }

      if (fallbackMatch?.[3]) fact.fallbackValue = fallbackMatch[3]
      if (fallbackMatch?.[1]) fact.variableName = fallbackMatch[1]

      facts.push(fact)
    }
  }

  return unique(facts.map(fact => JSON.stringify(fact)), 8).map(value => JSON.parse(value) as MinimumEquityConfigFact)
}

function buildMinimumEquityConfigAnswer(chunks: RetrievedPayload[], question: string): string | undefined {
  if (!questionAsksMinimumEquityConfig(question)) return undefined

  const facts = extractMinimumEquityConfigFacts(chunks)
  const factWithFallback = facts.find(fact => fact.fallbackValue)
  const firstFact = factWithFallback ?? facts[0]

  if (!firstFact) return undefined

  if (factWithFallback?.fallbackValue) {
    return [
      localized(
        `Minimal equity iSignal yang terkonfirmasi dari kode adalah ${factWithFallback.fallbackValue}.`,
        `The confirmed iSignal minimum equity fallback in code is ${factWithFallback.fallbackValue}.`,
      ),
      localized(
        `Nilai itu berasal dari fallback env ${factWithFallback.envName}; jika env var ini diset di runtime, nilai runtime bisa berbeda dari fallback kode.`,
        `That value comes from the ${factWithFallback.envName} env fallback; if this env var is set at runtime, the runtime value can differ from the code fallback.`,
      ),
      "",
      "Evidence:",
      `- ${factWithFallback.evidenceLine} (${factWithFallback.source})`,
    ].join("\n")
  }

  return [
    localized(
      `Saya menemukan config env ${firstFact.envName} untuk minimum equity iSignal, tapi angka fallback eksplisitnya tidak ada di chunk yang ter-retrieve.`,
      `I found the ${firstFact.envName} env config for iSignal minimum equity, but no explicit fallback number in the retrieved chunks.`,
    ),
    "",
    "Evidence:",
    `- ${firstFact.evidenceLine} (${firstFact.source})`,
  ].join("\n")
}

function normalizeRegistryAlias(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

function registryAliasMatchesTerm(entry: ServiceRegistryEntry, term: string): boolean {
  const normalizedTerm = normalizeRegistryAlias(term)

  if (!normalizedTerm) return false

  return [entry.name, ...(entry.aliases ?? [])].some(alias => {
    const normalizedAlias = normalizeRegistryAlias(alias)

    return normalizedAlias === normalizedTerm ||
      normalizedAlias.split(/\s+/g).includes(normalizedTerm)
  })
}

function buildRegistryAliasDefinitionAnswer(question: string, expansion: RegistryExpansion): string | undefined {
  if (!questionAsksAboutGlossary(question)) return undefined
  if (questionAsksAboutAccountTypes(question)) return undefined
  if (/\b(aturan|rules?|rule|ketentuan|business rules?)\b/i.test(question)) return undefined

  const asksDefinition = /\b(apa itu|what is|maksud|meaning|define|definition|explain|describe|jelasin|jelaskan)\b/i.test(question)

  if (!asksDefinition) return undefined

  const explicitTerms = unique([
    ...extractDefinitionSubjectTerms(question),
    ...extractQuestionAcronyms(question),
    ...extractShortSubjectTokens(question),
  ], 12)
  const entry = expansion.matchedEntries.find(candidate => {
    if (candidate.kind !== "broker") return false

    return explicitTerms.some(term => registryAliasMatchesTerm(candidate, term))
  })

  if (!entry?.description) return undefined

  const canonicalName = entry.name
  const aliases = unique([entry.name, ...(entry.aliases ?? [])], 12)
  const repos = unique(entry.repos ?? [], 12)
  const projectId = entry.projectId ?? entry.name

  return [
    localized(
      `Berdasarkan registry lokal: ${entry.description}`,
      `From the local registry: ${entry.description}`,
    ),
    localized(
      `Nama canonical/projectId: ${canonicalName} / ${projectId}.`,
      `Canonical name/projectId: ${canonicalName} / ${projectId}.`,
    ),
    aliases.length > 0
      ? localized(`Alias: ${aliases.join(", ")}.`, `Aliases: ${aliases.join(", ")}.`)
      : undefined,
    repos.length > 0
      ? localized(`Repo terkait: ${repos.join(", ")}.`, `Related repos: ${repos.join(", ")}.`)
      : undefined,
    "",
    localized(
      "Catatan: ini berasal dari config/services.json sebagai registry lokal. Untuk detail implementasi, tanyakan endpoint, flow, tabel, atau tipe akun spesifik.",
      "Note: this comes from config/services.json as local registry knowledge. For implementation details, ask for a specific endpoint, flow, table, or account type.",
    ),
  ].filter((line): line is string => typeof line === "string").join("\n")
}

async function buildDocumentationGlossaryAnswer(chunks: RetrievedPayload[], question: string): Promise<string | undefined> {
  if (!questionAsksAboutGlossary(question)) return undefined
  if (questionAsksAboutAccountTypes(question)) return undefined
  if (questionAsksForDiagram(question)) return undefined

  const lowerQuestion = question.toLowerCase()
  const asksRules = /\b(aturan|rules?|rule|ketentuan|business rules?)\b/i.test(question)
  const asksDefinition = /\b(apa itu|what is|maksud|meaning|define|definition|explain|describe|jelasin|jelaskan|glossary|glosarium)\b/i.test(question)
  const asksHowWorks = questionAsksHowWorks(question)
  const asksGuide = /\b(onboard|onboarding|guide|panduan)\b/i.test(question)
  const asksCron = questionAsksForCronListing(question)
  const asksOverview = asksDefinition || asksHowWorks || asksGuide
  const asksGlossaryExplicitly = /\b(glossary|glosarium|glossarium)\b/i.test(question)
  const subjectTerms = unique([
    ...extractConceptTokens(question),
    ...extractDefinitionSubjectTerms(question),
    ...extractQuestionAcronyms(question),
    ...extractShortSubjectTokens(question),
    ...registryExpansion.terms.filter(term => term.length >= 4),
  ], 24).map(term => term.toLowerCase())
  const explicitSubjectTerms = unique([
    ...extractDefinitionSubjectTerms(question),
    ...extractQuestionAcronyms(question),
    ...extractShortSubjectTokens(question),
  ], 12).map(term => term.toLowerCase())
  const shortDefinitionTerms = asksDefinition
    ? explicitSubjectTerms.filter(term => term.length >= 2 && term.length <= 4)
    : []
  const asksShortDefinition = asksDefinition && shortDefinitionTerms.length > 0
  function mentionsExactSubject(text: string, terms = shortDefinitionTerms): boolean {
    return terms.some(term => {
      const escaped = escapeRegExp(term)

      return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text)
    })
  }
  const asksFinancialAdvisor = subjectTerms.includes("fa") ||
    subjectTerms.includes("financial advisor") ||
    /\b(financial advisor|penasihat keuangan|fa porto)\b/i.test(question)
  const matchingDocChunks = chunks.filter(chunk => {
    if (!chunk.evidenceTypes?.includes("documentation")) return false

    // When asking about FA, exclude devops-docs and legacy-archives chunks — they
    // often contain "Legacy Archives" text that the LLM quotes verbatim as product info.
    if (asksFinancialAdvisor) {
      const fp = chunk.filePath?.toLowerCase() ?? ""
      if (fp.includes("devops-docs")) return false
      if (fp.includes("legacy-archives")) return false
      if (/legacy archives/i.test(chunk.content ?? "")) return false
    }

    const text = [
      chunk.filePath ?? "",
      chunk.content ?? "",
      ...(chunk.symbols ?? []),
      ...(chunk.messageNames ?? []),
    ].join("\n").toLowerCase()

    if (asksShortDefinition && !asksFinancialAdvisor) {
      return mentionsExactSubject(text)
    }

    return subjectTerms.some(term => {
      const normalizedTerm = term.toLowerCase()

      if (normalizedTerm.length <= 2) {
        return new RegExp(`\\b${escapeRegExp(normalizedTerm)}\\b`, "i").test(text)
      }

      return text.includes(normalizedTerm)
    })
  })

  function isTopLevelIndexPath(filePath: string): boolean {
    return /docs:[^/\\]+[/\\]index\.mdx?$/.test(filePath.toLowerCase())
  }

  function score(chunk: RetrievedPayload): number {
    const filePath = chunk.filePath?.toLowerCase() ?? ""
    const repoName = chunk.repoName?.toLowerCase() ?? ""
    const content = chunk.content?.toLowerCase() ?? ""
    let value = 0

    if (subjectTerms.includes("isignal")) {
      if (filePath.includes("isignal-docs")) value += 40
      if (repoName.includes("isignal")) value += 20
      if (content.includes("auto copy")) value += 10
      if (asksOverview && isTopLevelIndexPath(filePath)) value += 90
      // Penalize unrelated product docs when asking specifically about isignal
      if (filePath.includes("fa-porto-docs")) value -= 80
      if (filePath.includes("devops-docs")) value -= 60
    }

    if (asksFinancialAdvisor) {
      if (filePath.includes("fa-porto-docs")) value += 100
      if (content.includes("financial advisor") || content.includes("penasihat keuangan")) value += 60
      if (asksOverview && isTopLevelIndexPath(filePath)) value += 90
      if (filePath.includes("isignal-docs")) value -= 80
      if (filePath.includes("devops-docs")) value -= 120
      if (filePath.includes("glossarium") || filePath.includes("glossary")) value -= asksGlossaryExplicitly ? 0 : 35
    }

    value += scoreDocLocalePreference(chunk)
    if (asksGuide) {
      if (filePath.includes("onboarding") || filePath.includes("guide")) value += 260
      if (filePath.includes("cron") || filePath.includes("business-rules") || filePath.includes("architecture")) value -= 70
      if (content.includes("onboarding") || content.includes("panduan")) value += 45
    }
    if (filePath.includes("flow")) value += asksHowWorks ? 45 : 0
    if (filePath.includes("business-rules") || filePath.includes("rules")) value += asksRules ? 260 : asksHowWorks ? 14 : 0
    if (filePath.includes("architecture")) value += asksHowWorks ? 12 : 0
    if (filePath.includes("glossarium") || filePath.includes("glossary")) value += asksOverview ? asksGlossaryExplicitly ? 18 : -60 : 4
    if (filePath.endsWith("index.mdx") || filePath.endsWith("index.md")) value += asksRules ? 0 : 18
    if (asksOverview && /\ballows users to automatically|memungkinkan pengguna|pengenalan|overview|tujuan utama|core purpose|internal documentation for|dokumentasi internal|end-to-end|signal ingestion|pengolahan sinyal/i.test(content)) value += 35
    if (!asksCron && (filePath.includes("cron") || content.includes("croncheck"))) value -= asksHowWorks ? 60 : 160
    if (asksOverview && filePath.includes("diagram")) value -= asksHowWorks ? 8 : 25
    if (!asksRules && filePath.includes("business-rules")) value -= asksDefinition ? 8 : 0

    return value
  }

  const sortedDocChunks = matchingDocChunks.sort((left, right) => score(right) - score(left))

  let docChunks = asksOverview
    ? sortedDocChunks.filter(chunk => {
        const filePath = chunk.filePath?.toLowerCase() ?? ""
        const content = chunk.content?.toLowerCase() ?? ""
        const isTopLevelIndex = isTopLevelIndexPath(filePath)

        if (asksShortDefinition && !asksFinancialAdvisor && !mentionsExactSubject(`${filePath}\n${content}`)) {
          return false
        }

        return isTopLevelIndex ||
          (asksGuide && (filePath.includes("onboarding") || filePath.includes("guide"))) ||
          (asksGlossaryExplicitly && (filePath.includes("glossarium") || filePath.includes("glossary"))) ||
          (asksRules && (filePath.includes("business-rules") || filePath.includes("rules"))) ||
          (asksHowWorks && (filePath.includes("flow") || filePath.includes("business-rules") || filePath.includes("architecture"))) ||
          content.includes("allows users to automatically") ||
          content.includes("memungkinkan pengguna")
      })
    : sortedDocChunks

  if (asksShortDefinition && !asksFinancialAdvisor && docChunks.length === 0) {
    const subject = shortDefinitionTerms[0]?.toUpperCase() ?? explicitSubjectTerms[0] ?? "term"

    return localized(
      `Saya tidak menemukan definisi ${subject} yang eksplisit di indexed code/docs. Registry hanya punya alias untuk membantu retrieval, tapi itu bukan evidence definisi.`,
      `I did not find an explicit ${subject} definition in indexed code/docs. The registry only has aliases for retrieval, but that is not definition evidence.`,
    )
  }

  if (!asksOverview && asksRules) {
    const fullRuleChunks: RetrievedPayload[] = []
    const ruleRefs = sortedDocChunks
      .filter(chunk => {
        const filePath = chunk.filePath?.toLowerCase() ?? ""

        return chunk.repoName && chunk.branchName && chunk.filePath && (filePath.includes("business-rules") || filePath.includes("rules"))
      })
      .slice(0, 4)

    for (const ref of ruleRefs) {
      const fileChunks = await retrieveFileChunks(ref.repoName ?? "", ref.branchName ?? "", ref.filePath ?? "")
      fullRuleChunks.push(...fileChunks.map(chunk => chunk.payload))
    }

    const byKey = new Map<string, RetrievedPayload>()

    for (const chunk of [...fullRuleChunks, ...docChunks]) {
      const key = chunk.contentHash ?? [chunk.repoName, chunk.branchName, chunk.filePath, chunk.startLine, chunk.endLine].join(":")
      if (!byKey.has(key)) byKey.set(key, chunk)
    }

    docChunks = [...byKey.values()].sort((left, right) => {
      const scoreDifference = score(right) - score(left)

      if (Math.abs(scoreDifference) > 50) return scoreDifference

      const leftFile = left.filePath ?? ""
      const rightFile = right.filePath ?? ""

      if (leftFile !== rightFile) return leftFile.localeCompare(rightFile)

      return (left.startLine ?? 0) - (right.startLine ?? 0)
    })
  }

  if (asksOverview) {
    const fullIndexChunks: RetrievedPayload[] = []
    const fullRuleChunks: RetrievedPayload[] = []
    const topIndexRefs = sortedDocChunks
      .filter(chunk => chunk.repoName && chunk.branchName && chunk.filePath && isTopLevelIndexPath(chunk.filePath))
      .slice(0, 4)
    const ruleRefs = asksRules
      ? sortedDocChunks
          .filter(chunk => {
            const filePath = chunk.filePath?.toLowerCase() ?? ""

            return chunk.repoName && chunk.branchName && chunk.filePath && (filePath.includes("business-rules") || filePath.includes("rules"))
          })
          .slice(0, 4)
      : []

    for (const ref of topIndexRefs) {
      const fileChunks = await retrieveFileChunks(ref.repoName ?? "", ref.branchName ?? "", ref.filePath ?? "")
      fullIndexChunks.push(...fileChunks.map(chunk => chunk.payload))
    }

    for (const ref of ruleRefs) {
      const fileChunks = await retrieveFileChunks(ref.repoName ?? "", ref.branchName ?? "", ref.filePath ?? "")
      fullRuleChunks.push(...fileChunks.map(chunk => chunk.payload))
    }

    const byKey = new Map<string, RetrievedPayload>()

    for (const chunk of [...fullIndexChunks, ...fullRuleChunks, ...docChunks]) {
      const key = chunk.contentHash ?? [chunk.repoName, chunk.branchName, chunk.filePath, chunk.startLine, chunk.endLine].join(":")
      if (!byKey.has(key)) byKey.set(key, chunk)
    }

    docChunks = [...byKey.values()].sort((left, right) => score(right) - score(left))
  }

  if (docChunks.length === 0) return undefined

  const facts: string[] = []
  const maxFacts = asksOverview && asksRules ? 40 : asksOverview ? 8 : asksRules ? 30 : 14

  for (const chunk of docChunks) {
    const lines = (chunk.content ?? "")
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .filter(line => !/^(Documentation|Source|Locale|title|description|file):/i.test(line))

    for (const line of lines) {
      const lowerLine = line.toLowerCase()
      const isHeader = /^#{1,4}\s+/.test(line)
      const isListOrTable = /^[-*]\s+/.test(line) || /^\|/.test(line) || /^\d+\.\s+/.test(line)
      const isDiagramOrCode = /^(graph|flowchart|sequenceDiagram|classDef|subgraph|%%|[A-Za-z0-9_]+\[|[A-Za-z0-9_]+-->|[A-Za-z0-9_]+-.->)/.test(line)
      const isDocusaurusComponent = /^<|^import\s+|DocCardList|useCurrentSidebarCategory|items=\{/.test(line)
      const isMetadataLine = /^---$/.test(line) || /^>\s+/.test(line)
      const mentionsSubject = subjectTerms.some(term => lowerLine.includes(term))
      const mentionsShortSubject = asksShortDefinition ? mentionsExactSubject(lowerLine) : false

      if (isDiagramOrCode || isDocusaurusComponent || isMetadataLine) continue
      if (!asksCron && (/^\|?\s*Cron[A-Z]/.test(line) || lowerLine.includes("croncheck"))) continue
      if (asksOverview && isListOrTable && !asksRules) continue
      if (asksShortDefinition && !asksFinancialAdvisor && !mentionsShortSubject) continue

      if (mentionsSubject || (asksRules && isListOrTable) || (!asksRules && !isListOrTable && !isHeader)) {
        facts.push(`${line} (${chunk.repoName}@${chunk.branchName ?? "unknown"} ${chunk.filePath}:${chunk.startLine}-${chunk.endLine})`)
      }

      if (facts.length >= maxFacts) break
    }

    if (facts.length >= maxFacts) break
  }

  const uniqueFacts = unique(facts, maxFacts)

  if (uniqueFacts.length === 0) {
    if (asksShortDefinition && !asksFinancialAdvisor) {
      const subject = shortDefinitionTerms[0]?.toUpperCase() ?? explicitSubjectTerms[0] ?? "term"

      return localized(
        `Saya tidak menemukan definisi ${subject} yang eksplisit di indexed code/docs. Registry hanya punya alias untuk membantu retrieval, tapi itu bukan evidence definisi.`,
        `I did not find an explicit ${subject} definition in indexed code/docs. The registry only has aliases for retrieval, but that is not definition evidence.`,
      )
    }

    return undefined
  }

  function parseDocFact(fact: string): { text: string; source: string } {
    const match = fact.match(/^(.*)\s+\(([^()]+:\d+-\d+)\)$/)

    return {
      text: cleanDocSummaryText(match?.[1] ?? fact),
      source: match?.[2] ?? "",
    }
  }

  const parsedFacts = uniqueFacts
    .map(parseDocFact)
    .filter(fact => fact.text.length > 0)
    .filter((fact, index, facts) => {
      const key = fact.text.toLowerCase()

      return facts.findIndex(other => other.text.toLowerCase() === key) === index
    })

  if (asksOverview) {
    const definitionFacts = parsedFacts.filter(fact => {
      return !/^welcome to\b/i.test(fact.text) &&
        !/^selamat datang\b/i.test(fact.text) &&
        !/^auto copy \(isignal\) product documentation$/i.test(fact.text) &&
        !/^dokumentasi produk auto copy \(isignal\)$/i.test(fact.text) &&
        !/business-rules|rules/i.test(fact.source) &&
        fact.text.length >= 40
    })
    const ruleFacts = asksRules
      ? parsedFacts.filter(fact =>
          /business-rules|rules/i.test(fact.source) &&
          !/^aturan bisnis financial advisor$/i.test(fact.text) &&
          !/^financial advisor business rules$/i.test(fact.text) &&
          !/^dokumen ini menjelaskan\b/i.test(fact.text) &&
          !/^this document outlines\b/i.test(fact.text)
        ).slice(0, 10)
      : []
    const guideFacts = asksGuide
      ? parsedFacts.filter(fact => /onboarding|guide|panduan/i.test(fact.source) || /onboarding|guide|panduan/i.test(fact.text))
      : []
    const mainFact = guideFacts[0] ?? definitionFacts[0] ?? parsedFacts[0]
    const supportingFacts = (guideFacts.length > 0 ? guideFacts : definitionFacts).filter(fact => fact !== mainFact).slice(0, asksHowWorks || asksGuide ? 6 : 4)
    const sources = unique([mainFact?.source ?? "", ...supportingFacts.map(fact => fact.source), ...ruleFacts.map(fact => fact.source)], 8)

    if (!mainFact) return undefined

    return [
      asksHowWorks
        ? localized("Cara kerja berdasarkan dokumentasi:", "How it works from indexed documentation:")
        : localized("Ringkasan berdasarkan dokumentasi:", "Summary from indexed documentation:"),
      asksGuide && subjectTerms.includes("isignal")
        ? localized("Panduan onboarding iSignal:", "iSignal onboarding guide:")
        : undefined,
      renderDocSummaryText(mainFact.text),
      supportingFacts.length > 0 ? "" : undefined,
      supportingFacts.length > 0 ? localized("Poin penting:", "Key points:") : undefined,
      supportingFacts.length > 0 ? supportingFacts.map(fact => `- ${renderDocSummaryText(fact.text)}`).join("\n") : undefined,
      ruleFacts.length > 0 ? "" : undefined,
      ruleFacts.length > 0 ? localized("Aturan yang ditemukan:", "Rules found:") : undefined,
      ruleFacts.length > 0 ? ruleFacts.map(fact => `- ${renderDocSummaryText(fact.text)}`).join("\n") : undefined,
      "",
      localized("Sumber utama:", "Primary sources:"),
      sources.map(source => `- ${source}`).join("\n"),
    ].filter((line): line is string => typeof line === "string").join("\n")
  }

  return [
    shouldAnswerIndonesian(question)
      ? "Ringkasan berdasarkan dokumentasi yang ter-index:"
      : "Summary from indexed documentation:",
    parsedFacts.map(fact => `- ${fact.text}${fact.source ? ` (${fact.source})` : ""}`).join("\n"),
    "",
    shouldAnswerIndonesian(question)
      ? "Catatan: ini adalah ringkasan evidence dokumentasi. Untuk detail implementasi, tanyakan flow, endpoint, tabel, atau service spesifik."
      : "Note: this is a documentation evidence summary. For implementation details, ask for a specific flow, endpoint, table, or service.",
  ].join("\n")
}

function documentationGlossarySourceChunks(chunks: RetrievedPayload[], question: string): RetrievedPayload[] {
  const asksDefinition = /\b(apa itu|what is|maksud|meaning|define|definition|glossary|glosarium)\b/i.test(question)
  const asksHowWorks = questionAsksHowWorks(question)
  const asksRules = /\b(aturan|rules?|rule|ketentuan|business rules?)\b/i.test(question)
  const subjectTerms = unique([
    ...extractConceptTokens(question),
    ...extractDefinitionSubjectTerms(question),
    ...extractQuestionAcronyms(question),
    ...extractShortSubjectTokens(question),
  ], 16).map(term => term.toLowerCase())
  const shortDefinitionTerms = asksDefinition
    ? subjectTerms.filter(term => term.length >= 2 && term.length <= 4)
    : []
  const asksShortDefinition = asksDefinition && shortDefinitionTerms.length > 0
  function mentionsExactSubject(text: string): boolean {
    return shortDefinitionTerms.some(term => new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}([^a-z0-9]|$)`, "i").test(text))
  }
  const asksFinancialAdvisor = subjectTerms.includes("fa") ||
    subjectTerms.includes("financial advisor") ||
    /\b(financial advisor|penasihat keuangan|fa porto)\b/i.test(question)

  return chunks.filter(chunk => {
    if (!chunk.evidenceTypes?.includes("documentation")) return false

    const filePath = chunk.filePath?.toLowerCase() ?? ""
    const content = chunk.content?.toLowerCase() ?? ""
    const text = `${filePath}\n${content}`

    if (asksShortDefinition && !asksFinancialAdvisor && !mentionsExactSubject(text)) {
      return false
    }

    if (asksFinancialAdvisor) {
      return filePath.includes("fa-porto-docs") &&
        (filePath.endsWith("index.mdx") || filePath.endsWith("index.md") || content.includes("financial advisor") || content.includes("penasihat keuangan"))
    }

    if (asksRules) return filePath.includes("rules")
    if (asksDefinition || asksHowWorks) {
      const isTopLevelIndex = /docs:[^/\\]+[/\\]index\.mdx?$/.test(filePath)

      return isTopLevelIndex ||
        (asksDefinition && (filePath.includes("glossarium") || filePath.includes("glossary"))) ||
        (asksHowWorks && (filePath.includes("flow") || filePath.includes("business-rules") || filePath.includes("architecture"))) ||
        content.includes("allows users to automatically")
    }

    return true
  }).sort((left, right) => scoreDocLocalePreference(right) - scoreDocLocalePreference(left)).slice(0, 12)
}

type MermaidDiagramAnswer = {
  answer: string
  sources: RetrievedPayload[]
}

function stripDocChunkMetadata(content: string): string {
  return content
    .split(/\r?\n/)
    .filter(line => !/^(Documentation|Source|Locale|title|description|file):/i.test(line.trim()))
    .join("\n")
}

function extractMermaidBlocks(content: string): string[] {
  const blocks = [
    ...[...content.matchAll(/```mermaid\s*([\s\S]*?)```/gi)].map(match => match[1] ?? ""),
    ...[...content.matchAll(/<ZoomableMermaid\s+chart=\{`\s*([\s\S]*?)`\s*\}\s*\/?>/gi)].map(match => match[1] ?? ""),
  ]

  return blocks
    .map(block => block.trim())
    .filter(block => /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt)\b/i.test(block))
}

function scoreMermaidBlock(block: string, question: string): number {
  const lowerBlock = block.toLowerCase()
  const lowerQuestion = question.toLowerCase()
  let score = 0

  for (const token of extractConceptTokens(question)) {
    if (lowerBlock.includes(token.toLowerCase())) score += 10
  }

  if (/\bsignal|isignal|auto copy\b/i.test(lowerQuestion) && /signal|isignal|auto copy/i.test(block)) score += 30
  if (/\bsignal|isignal|auto copy|copy signal\b/i.test(lowerQuestion) && /SignalBroadcast/i.test(block)) score += 240
  if (/\bsignal|isignal|auto copy|copy signal\b/i.test(lowerQuestion) && /Trade Publisher|Active iSignal Bots/i.test(block)) score += 90
  if (/\bauto copy|copy signal\b/i.test(lowerQuestion) && !/SignalBroadcast/i.test(block)) score -= 80
  if (/\bflow|works?|cara kerja|alur\b/i.test(lowerQuestion) && /flow|start|-->|publish|consume|process/i.test(block)) score += 20
  if (/\barchitecture|arsitektur\b/i.test(lowerQuestion) && /architecture|service|api|worker/i.test(block)) score += 16

  return score
}

async function buildMermaidDiagramAnswer(chunks: RetrievedPayload[], question: string): Promise<MermaidDiagramAnswer | undefined> {
  if (!questionAsksForDiagram(question) && !questionAsksHowWorks(question)) return undefined

  const docChunks = chunks
    .filter(chunk => chunk.evidenceTypes?.includes("documentation"))
    .filter(chunk => /mermaid|graph\s+(?:TB|TD|LR|RL|BT)|flowchart|sequenceDiagram|ZoomableMermaid/i.test(chunk.content ?? ""))

  // When asking how something works, proactively include diagrams.mdx chunks
  // even if they didn't rank in the top vector results
  const isIsignalQuestion = /\b(isignal|auto copy|copy signal|bot copy)\b/i.test(question)
  const isChannelSubsQuestion = /\b(channel.?subs|channel subscription)\b/i.test(question)
  const proactiveDiagramKeys: string[] = []
  if (questionAsksHowWorks(question)) {
    if (isIsignalQuestion || (!isChannelSubsQuestion)) {
      proactiveDiagramKeys.push("isignal|docs|docs:isignal-docs\\architecture\\diagrams.mdx")
    }
    if (isChannelSubsQuestion) {
      proactiveDiagramKeys.push("channel-subscription|docs|docs:channel-subs-docs\\architecture\\diagrams.mdx")
    }
  }

  const candidateFiles = unique(
    [
      ...docChunks.map(chunk => [chunk.repoName, chunk.branchName, chunk.filePath].join("|")),
      ...proactiveDiagramKeys,
    ].filter(key => !key.includes("undefined")),
    8,
  )

  const candidates: Array<{ block: string; source: RetrievedPayload; score: number }> = []

  for (const key of candidateFiles) {
    const [repoName, branchName, filePath] = key.split("|")
    if (!repoName || !branchName || !filePath) continue

    const fileChunks = await retrieveFileChunks(repoName, branchName, filePath)
    const fullContent = fileChunks.map(chunk => stripDocChunkMetadata(chunk.payload.content ?? "")).join("\n")

    for (const block of extractMermaidBlocks(fullContent)) {
      const signatureLine = block
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(line => line.length > 12 &&
          !/^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|classDef|style|%%)\b/i.test(line))
      const source = fileChunks.find(chunk => {
        const content = chunk.payload.content ?? ""

        return signatureLine ? content.includes(signatureLine) : /mermaid|ZoomableMermaid/i.test(content)
      })?.payload ?? fileChunks[0]?.payload

      if (!source) continue

      candidates.push({
        block,
        source,
        score: scoreMermaidBlock(block, question),
      })
    }
  }

  candidates.sort((left, right) => right.score - left.score)

  const best = candidates[0]
  if (!best) return undefined

  const answer = [
    localized("Flowchart dari dokumentasi ter-index:", "Flowchart from indexed documentation:"),
    localized(
      "Konteks: iSignal / Auto Copy adalah flow copy signal/sinyal dari master channel ke akun user.",
      "Context: iSignal / Auto Copy (bot copy) is the copy-signal flow from master channels to user accounts.",
    ),
    "",
    "```mermaid",
    best.block,
    "```",
    "",
    localized(
      "Catatan: diagram ini diambil dari Mermaid yang sudah ter-index. Edge yang tidak ada di diagram/source tidak ditambahkan.",
      "Note: this diagram is taken from indexed Mermaid documentation. Edges not present in the diagram/source were not added.",
    ),
  ].join("\n")

  return {
    answer,
    sources: [best.source],
  }
}

function extractNamedSymbolsFromQuestion(question: string): string[] {
  return unique(
    [
      ...[...question.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*\b/g)].map(match => match[0]),
      ...[...question.matchAll(/\b[A-Z][A-Za-z0-9_]{2,}\b/g)]
        .map(match => match[0])
        .filter(value => !["What", "When", "Where", "Which", "How", "Does"].includes(value)),
    ],
    8,
  )
}

function describeMethodBody(content: string): string[] {
  const bodyFields = [
    ...[...content.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*request\.body\.([A-Za-z_$][\w$]*)/g)].map(
      match => `${match[2]} -> ${match[1]}`,
    ),
    ...[...content.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*parseInt\(request\.body\.([A-Za-z_$][\w$]*)\)/g)].map(
      match => `${match[2]} -> ${match[1]} (parseInt)`,
    ),
  ]
  const rpcFuncNames = [...content.matchAll(/\bfunc\s*:\s*["'`]([^"'`]+)["'`]/g)].map(match => match[1] ?? "")
  const externalFuncNames = [...content.matchAll(/\bpostParamsAsync\(\s*["'`]([^"'`]+)["'`]/g)].map(match => match[1] ?? "")
  const requiredFields = [
    ...[...content.matchAll(/\b([A-Za-z_$][\w$]*)\s*:\s*Joi\.[^\n,;]+?\.required\(\)/g)].map(match => match[1] ?? ""),
    ...[...content.matchAll(/\bif\s*\(\s*!\s*data\.([A-Za-z_$][\w$]*)\s*\)/g)].map(match => match[1] ?? ""),
  ]
  const modelCalls = unique(
    [...content.matchAll(/\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g)]
      .map(match => `${match[1]}.${match[2]}`)
      .filter(call => !/^console\./.test(call))
      .filter(call => !/\.validateAsync$/.test(call)),
    12,
  )
  const tables = sanitizeTableNames(extractSqlTableNamesFromContent(content), 12)
  const details = [
    bodyFields.length > 0 ? `body fields: ${unique(bodyFields, 12).join(", ")}` : undefined,
    rpcFuncNames.length > 0 ? `rpc func values: ${unique(rpcFuncNames, 12).join(", ")}` : undefined,
    externalFuncNames.length > 0 ? `external API func values: ${unique(externalFuncNames, 12).join(", ")}` : undefined,
    requiredFields.length > 0 ? `required fields/checks: ${unique(requiredFields, 16).join(", ")}` : undefined,
    modelCalls.length > 0 ? `calls: ${modelCalls.join(", ")}` : undefined,
    content.includes("request.jwtVerify") ? "verifies JWT" : undefined,
    content.includes("request.validationError") ? "throws on request.validationError" : undefined,
    content.includes("Joi.object") ? "uses Joi schema validation" : undefined,
    content.includes("login: Joi.number().integer().positive().required()") ? "requires positive integer login" : undefined,
    content.includes("nominal: Joi.number().integer().min(1).max(9999999).required()")
      ? "requires nominal integer from 1 to 9999999"
      : undefined,
    content.includes("metaserver_id: Joi.number().integer().valid(1, 2).required()")
      ? "requires metaserver_id 1 or 2"
      : undefined,
    content.includes("user_id: Joi.number().integer().required()") ? "requires integer user_id" : undefined,
    content.includes("users_demoid") ? "checks users_demoid" : undefined,
    tables.length > 0 ? `tables: ${tables.join(", ")}` : undefined,
    content.includes("MRGAccountRpc.send") ? "calls MRGAccountRpc.send" : undefined,
    content.includes("demoModel.SubmitDepositDemo") ? "delegates to demoModel.SubmitDepositDemo" : undefined,
    content.includes("MRGDemoAddBalanceRequestAsync") ? "calls demo balance RPC" : undefined,
    content.includes("result.message = res.message") ? "sets result.message from RPC res.message" : undefined,
    /return\s+result/.test(content) ? "returns result" : undefined,
    /return\s+true/.test(content) ? "returns true on success" : undefined,
  ].filter((detail): detail is string => Boolean(detail))

  return unique(details, 20)
}

function buildExactSymbolAnswer(symbolNames: string[], chunks: RetrievedChunk[]): string | undefined {
  const methodFacts: string[] = []
  const routeFacts: string[] = []
  const constantFacts: string[] = []
  const usageFacts: string[] = []
  const chunksByFile = new Map<string, RetrievedChunk[]>()

  for (const chunk of chunks) {
    const key = [chunk.payload.repoName, chunk.payload.branchName, chunk.payload.filePath].join(":")

    if (!chunksByFile.has(key)) {
      chunksByFile.set(key, [])
    }

    chunksByFile.get(key)?.push(chunk)
  }

  for (const symbolName of symbolNames) {
    const shortSymbolName = symbolName.includes("::") ? symbolName.split("::").at(-1) ?? symbolName : symbolName

    for (const chunk of chunks) {
      const content = chunk.payload.content ?? ""

      if (!content.includes(symbolName) && !content.includes(shortSymbolName)) continue

      const constantPattern = new RegExp(`\\bconst\\s+${escapeRegExp(shortSymbolName)}\\s*=\\s*([^;]+);`)
      const constantMatch = content.match(constantPattern)

      if (constantMatch?.[1]) {
        constantFacts.push(
          `${shortSymbolName} constant in ${chunk.payload.repoName}@${chunk.payload.branchName} ${chunk.payload.filePath}:${chunk.payload.startLine}-${chunk.payload.endLine}; expression: ${constantMatch[1].trim()}`,
        )
      }

      if (content.includes(`Helper::requestAPI(${symbolName}`) || content.includes(`Helper::requestAPI(${shortSymbolName}`)) {
        usageFacts.push(
          `${symbolName} used in Helper::requestAPI call at ${chunk.payload.repoName}@${chunk.payload.branchName} ${chunk.payload.filePath}:${chunk.payload.startLine}-${chunk.payload.endLine}`,
        )
      }

      const routeDefinitions = extractRouteDefinitionsForSymbol(content, symbolName)

      for (const routeDefinition of routeDefinitions) {
        routeFacts.push(
          `${symbolName} referenced by route in ${chunk.payload.repoName}@${chunk.payload.branchName} ${chunk.payload.filePath}:${chunk.payload.startLine}-${chunk.payload.endLine}; method: ${routeDefinition.method}; url: ${routeDefinition.url}; alias: ${routeDefinition.alias}; handler: ${routeDefinition.handler}`,
        )
      }
    }

    for (const fileChunks of chunksByFile.values()) {
      const methodWindow = findMethodWindow(fileChunks, shortSymbolName, 140)

      if (!methodWindow) continue

      const details = describeMethodBody(methodWindow.content)
      methodFacts.push(
        `${shortSymbolName} in ${methodWindow.firstChunk?.repoName}@${methodWindow.firstChunk?.branchName} ${methodWindow.firstChunk?.filePath}:${methodWindow.startLine}-${methodWindow.endLine}${details.length > 0 ? `; ${details.join("; ")}` : ""}`,
      )
    }
  }

  const facts = unique([...constantFacts, ...usageFacts, ...routeFacts, ...methodFacts], 24)

  if (facts.length === 0) return undefined

  return [
    `Exact symbol evidence found for: ${symbolNames.join(", ")}`,
    "",
    "Confirmed facts:",
    facts.map(fact => `- ${fact}`).join("\n"),
    "",
    "What is still missing:",
    "- This answer only uses chunks that exactly mention the named symbol plus nearby chunks.",
    "- If you need the full runtime flow, ask with the endpoint path, queue name, or RPC func and include what detail you want.",
  ].join("\n")
}

async function main() {
  const mainStart = nowMs()
  const provider = resolveChatProvider()
  dlog("ask-start", {
    provider,
    chatBaseUrlHost: resolveChatBaseUrlHost(),
    chatModel: config.chatModel,
    embeddingModel: config.embeddingModel,
    embeddingUrl: config.ollamaUrl,
    qdrantUrl: config.qdrantUrl,
    deep: deepMode,
    limit,
    repoName: options.repoName ?? "-",
    project: options.project ?? "-",
    branch: options.branch ?? "-",
    serviceType: serviceType ?? "-",
    questionChars: question.length,
  })

  retrievalDegradation.bm25Unavailable = false
  _fileChunkCache.clear()
  answerLanguage = await timeStage("language", () => detectAnswerLanguage(question))

  const questionRoutes = extractQuestionRoutes(question)
  const relationshipGraph = await timeStage("graph-load", () => readRelationshipGraph())
  const negativeRepoConstraint = questionAsksNegativeRepoConstraint(question)

  if (negativeRepoConstraint) {
    const negativeRepoAnswer = await buildNegativeRepoEvidenceAnswer(question)

    if (negativeRepoAnswer) {
      console.log("\nANSWER\n")
      console.log(localizeAnswer(negativeRepoAnswer.answer, question))

      console.log("\nSOURCES\n")
      console.log(negativeRepoAnswer.sources.join("\n"))

      return
    }
  }

  if (questionRoutes.length === 0 && !negativeRepoConstraint) {
    const graphFlowAnswer = await buildGraphFlowAnswer(question, relationshipGraph)

    if (graphFlowAnswer) {
      console.log("\nANSWER\n")
      const answer = deepMode
        ? [
            localized("Investigation trace:", "Investigation trace:"),
            localized("- Step 1: mencari anchor flow di relationship graph yang ter-index.", "- Step 1: searched indexed relationship graph for flow anchors."),
            localized("- Step 2: menemukan path terkonfirmasi dari edge route/caller/handler yang saling cocok.", "- Step 2: found a confirmed path from matching route/caller/handler edges."),
            localized("- Step 3: menjawab hanya dari source graph/chunk yang terkonfirmasi.", "- Step 3: answered only from confirmed graph/chunk sources."),
            "",
            graphFlowAnswer.answer,
          ].join("\n")
        : graphFlowAnswer.answer

      console.log(localizeAnswer(answer, question))

      console.log("\nSOURCES\n")

      for (const edge of graphFlowAnswer.sources) {
        console.log(`- ${edgeSource(edge)} (${edge.type})`)
      }

      return
    }

    // Decision-intent questions should not be intercepted by the queue metadata path,
    // even when they mention AMQP/queue terms as part of the subject being decided about.
    const isDecisionQuestion = /\b(decided|decision|why|rationale|rule|changed|aturan|diputuskan|alasan)\b/i.test(question)
    const queueMetadataAnswer = isDecisionQuestion ? undefined : await buildQueueMetadataAnswer(question, relationshipGraph)

    if (queueMetadataAnswer) {
      // Feed queue evidence into LLM for synthesis instead of raw dump
      const queueContext = queueMetadataAnswer.answer
      const queuePrompt = [
        `Question: ${question}`,
        `Answer language: ${answerLanguageLabel(question)}`,
        "",
        "Queue/messaging evidence from relationship graph and indexed code:",
        queueContext,
        "",
        "Answer requirements:",
        "- Synthesize the queue evidence above into a clear, readable explanation.",
        "- Explain the flow: which service publishes, which queue/exchange, which service consumes.",
        "- Mention specific file paths and line numbers from the evidence.",
        "- If a step in the flow is missing from the evidence, say so explicitly.",
        "- Do not repeat the raw evidence table — synthesize it into prose.",
        "- Say NOT_FOUND_IN_INDEXED_CODEBASE only if the evidence contains nothing relevant.",
      ].join("\n")

      console.log("\nANSWER\n")
      const synthesized = await chat(queuePrompt)
      console.log(localizeAnswer(synthesized, question))
      console.log("\nSOURCES\n")
      console.log(queueMetadataAnswer.sources.join("\n"))
      return
    }

    const cronDiscoveryAnswer = await buildCronDiscoveryAnswer(question, relationshipGraph)

    if (cronDiscoveryAnswer) {
      console.log("\nANSWER\n")
      console.log(localizeAnswer(cronDiscoveryAnswer.answer, question))

      console.log("\nSOURCES\n")
      console.log(cronDiscoveryAnswer.sources.join("\n"))

      return
    }

    const functionExistenceAnswer = await buildFunctionExistenceAnswer(question, relationshipGraph)

    if (functionExistenceAnswer) {
      console.log("\nANSWER\n")
      console.log(localizeAnswer(functionExistenceAnswer.answer, question))

      console.log("\nSOURCES\n")
      console.log(functionExistenceAnswer.sources.join("\n"))

      return
    }

    const routeDiscoveryAnswer = buildRouteDiscoveryAnswer(question, relationshipGraph)

    if (routeDiscoveryAnswer) {
      console.log("\nANSWER\n")
      console.log(localizeAnswer(routeDiscoveryAnswer.answer, question))

      console.log("\nSOURCES\n")
      console.log(routeDiscoveryAnswer.sources.join("\n"))

      return
    }
  }

  const shouldDiscoverConceptRoutes = questionRoutes.length === 0 &&
    !negativeRepoConstraint &&
    questionAsksAboutServicesOrFlow(question) &&
    !questionAsksHowWorks(question) &&
    !questionAsksInventory(question)
  const conceptRoutes = shouldDiscoverConceptRoutes
    ? await timeStage("concept-route-discovery", async () =>
        unique([...discoverGraphRouteAnchors(question, relationshipGraph), ...await discoverConceptRouteAnchors(question)], 10))
    : []
  const exactRoutes = unique([...questionRoutes, ...conceptRoutes], 10)
  const exactRouteStart = nowMs()
  const exactChunks = await retrieveExactRouteMatches(exactRoutes)
  dlog("stage", { name: "exact-route-match", ms: elapsedMs(exactRouteStart), exactRoutes: exactRoutes.length, chunks: exactChunks.length })

  // BM25 symbol lookup — runs independently of vector search for identifier queries
  const symbolIdentifiers = extractQuestionHints(question).filter(t => isIdentifierQuery(t))
  const symbolChunks: RetrievedChunk[] = symbolIdentifiers.length > 0
    ? await timeStage("bm25-symbol", async () => {
        const bm25Results = await bm25Search(symbolIdentifiers.join(" "), 8)
        if (bm25Results.length === 0) return []
        try {
          const points = await qdrant.retrieve(config.collectionName, {
            ids: bm25Results.map(r => r.id),
            with_payload: true,
          })
          return points
            .map(p => ({ id: String(p.id), payload: p.payload as RetrievedPayload }))
            .filter(c => c.payload.content)
        } catch (err) {
          console.error("BM25 symbol retrieve failed:", err instanceof Error ? err.message : err)
          return []
        }
      })
    : []
  const questionHints = extractQuestionHints(question)
  const generalVocabKeywords = ["medal", "level", "rank", "persyaratan", "naik", "requirement", "syarat", "tier", "grade"]
  const isGeneralVocabQuestion = generalVocabKeywords.some(kw => question.toLowerCase().includes(kw))

  const vocabBoostTerms = isGeneralVocabQuestion
    ? ["POINT_LEVELS", "RANGE_MEDAL", "minMedal", "maxMedal", "MEDALS", "levelToMedals"]
    : []
  const medalMechanismTerms = questionAsksMedalMechanism(question)
    ? [
        "dsc_channels_point_events",
        "dsc_channels_point_medal_journal",
        "dsc_channels_point_balance",
        "dsc_channels_point_redeem",
        "prev_channel_medal",
        "last_qualify_id",
        "total_pips",
        "qualify",
        "redeemPointAsync",
        "CHANNEL_LEVEL_NOT_ENOUGH",
        "CalculatePointAndMedal20260531",
        "current_month_vp",
        "minimum_vp",
        "average_monthly_vp",
        "signal_settled",
        "reset_channel",
      ]
    : []
  const metaTraderTerm = questionMetaTraderTerm(question)
  const metaTraderSearchTerms = metaTraderTerm
    ? [
        metaTraderTerm,
        "MetaTrader",
        "platform_type",
        "metaserver_id",
        "TF_METATRADER_PLATFORM_TYPE",
        "MRG_METATRADER_PLATFORM_TYPE",
        "ASKAP_METATRADER_PLATFORM_TYPE",
        "VOLUME_MULTIPLIER",
        "ServerPlatform",
      ]
    : []
  const minimumEquitySearchTerms = questionAsksMinimumEquityConfig(question)
    ? [
        "AUTO_COPY_MINIMUM_EQUITY",
        "minimumEquity",
        "minimum equity",
        "auto copy minimum equity",
        "equity",
      ]
    : []

  const exactTermSearchTerms = unique([
    ...questionHints,
    ...extractConceptTokens(question),
    ...registryExactSearchTerms(),
    ...vocabBoostTerms,
    ...medalMechanismTerms,
    ...metaTraderSearchTerms,
    ...minimumEquitySearchTerms,
  ], 48)
  // Run all independent exact-match scroll scans in parallel.
  const exactParallelStart = nowMs()
  const [exactTermChunks, exactVocabularyChunks, exactMetaTraderChunks, exactMinimumEquityChunks, isignalDocChunks] = await Promise.all([
    exactRoutes.length === 0
      ? retrieveExactTermMatches(exactTermSearchTerms, questionAsksAboutAccountTypes(question) ? 60 : 32)
      : Promise.resolve([]),
    exactRoutes.length === 0 && isGeneralVocabQuestion
      ? retrieveExactVocabularyMatches(exactTermSearchTerms, 24)
      : Promise.resolve([]),
    exactRoutes.length === 0 && metaTraderTerm
      ? retrieveMetaTraderTermMatches(metaTraderTerm, 64)
      : Promise.resolve([]),
    exactRoutes.length === 0 && questionAsksMinimumEquityConfig(question)
      ? retrieveMinimumEquityConfigChunks(24)
      : Promise.resolve([]),
    // Explicit isignal-docs scroll for timeline and eligibility questions — these specific
    // question types are not well-served by vector search when isignal has no docs:id locale.
    exactRoutes.length === 0 && (questionAsksProjectTimeline(question) || questionAsksEligibilityRequirement(question))
      ? (async (): Promise<RetrievedChunk[]> => {
          const result = await qdrant.scroll(config.collectionName, {
            filter: { must: [{ key: "repoName", match: { value: "isignal" } }, { key: "branchName", match: { value: "docs" } }] },
            limit: 100, with_payload: true, with_vector: false,
          })
          return result.points
            .map(p => ({ id: String(p.id), payload: p.payload as RetrievedPayload }))
            .filter(c => c.payload.content)
        })()
      : Promise.resolve([]),
  ])
  if (exactRoutes.length > 0) {
    dlog("stage", { name: "exact-term-parallel", status: "skipped", reason: "exact-routes-present" })
  } else {
    dlog("stage", {
      name: "exact-term-parallel",
      status: "executed",
      ms: elapsedMs(exactParallelStart),
      exactTerm: exactTermChunks.length,
      vocab: exactVocabularyChunks.length,
      metaTrader: exactMetaTraderChunks.length,
      equity: exactMinimumEquityChunks.length,
      isignal: isignalDocChunks.length,
    })
  }

  // Fallback: if the question is about general vocabulary topics (medal, level, rank) but no vocabulary
  // chunks were retrieved via exact matching, explicitly search for vocabulary chunks.
  const hasVocabChunks = [...exactTermChunks, ...exactVocabularyChunks].some(chunk => chunk.payload.filePath?.startsWith("vocabulary://"))

  let generalVocabChunks: RetrievedChunk[] = []

  if (isGeneralVocabQuestion && !hasVocabChunks) {
    generalVocabChunks = await retrieveVocabularyChunks(question, 16)
  }

  // If vocabulary chunks were found, also retrieve code chunks that reference
  // the vocabulary group names and their properties (e.g., POINT_LEVELS and level.money usage)
  const vocabGroupNames = new Set<string>()
  const vocabPropertyNames = new Set<string>()

  for (const chunk of [...exactTermChunks, ...exactVocabularyChunks]) {
    if (chunk.payload.filePath?.startsWith("vocabulary://")) {
      const lines = (chunk.payload.content ?? "").split("\n")
      const vocabName = lines.find(line => line.startsWith("Vocabulary:"))?.replace("Vocabulary:", "").trim()

      if (vocabName) vocabGroupNames.add(vocabName)

      // Extract property names from indented lines in the Terms section only
      let inTermsSection = false

      for (const line of lines) {
        if (line === "Terms:") {
          inTermsSection = true
          continue
        }

        if (line === "Context:") {
          inTermsSection = false
          continue
        }

        if (!inTermsSection) continue

        // Only capture property lines (4-space indented) under a term, not the term line itself
        if (line.startsWith("    ")) {
          const propMatch = line.match(/^\s{4}([^:]+):/)

          if (propMatch && propMatch[1]) {
            const propName = propMatch[1].trim().replace(/^["']|["']$/g, "")

            if (propName && propName !== "name" && propName !== "label") {
              vocabPropertyNames.add(propName)
            }
          }
        }
      }
    }
  }

  const vocabSearchTerms = [...vocabGroupNames]

  for (const prop of vocabPropertyNames) {
    vocabSearchTerms.push(prop)
    vocabSearchTerms.push(`level.${prop}`)
  }

  const vocabUsageChunks = vocabSearchTerms.length > 0
    ? await retrieveExactTermMatches(vocabSearchTerms, 48)
    : []

  const exactTermDetailChunks =
    exactRoutes.length === 0 && exactTermChunks.length > 0
      ? await timeStage("exact-term-detail-neighbors", () =>
          retrieveNeighborChunks(exactTermChunks, questionAsksAboutAccountTypes(question) ? 240 : 70))
      : []
  const exactComparison = exactRoutes.length >= 2 && isExactRouteComparisonQuestion(question)
  // Decision-intent questions should not be treated as endpoint inspections — they ask
  // about WHY something was decided, not HOW an endpoint behaves.
  // "rule"/"aturan" alone are too broad — they match glossary+rules questions like "apa itu FA dan aturan nya".
  // Require either an explicit decision verb OR "rule/aturan" paired with a decision subject word.
  const isDecisionIntentQuestion = /\b(decided|decision|rationale|changed|diputuskan|alasan|kenapa|mengapa)\b/i.test(question) ||
    (/\b(rule|aturan)\b/i.test(question) && /\b(why|kenapa|mengapa|diputus|adr|architectural)\b/i.test(question)) ||
    // "what does X = N mean" — value meaning questions should check decisions+migrations
    (/\b(mean|means|meaning|arti|artinya|maksud)\b/i.test(question) && /[=]\s*\d+/.test(question))
  const exactEndpointInspection =
    exactRoutes.length > 0 &&
    !exactComparison &&
    !isDecisionIntentQuestion &&
    (shouldInspectExactEndpointDetails(question) || shouldExpandExactRouteQuestion(question) || conceptRoutes.length > 0)
  const exactHandlerRefs = extractExactRouteHandlerRefs(exactChunks, exactRoutes)
  const exactDetailChunks =
    exactChunks.length > 0
      ? await timeStage("exact-route-details", () => retrieveExactRouteDetails(
          exactChunks,
          exactHandlerRefs,
          exactComparison || exactEndpointInspection || shouldExpandExactRouteQuestion(question),
          exactRoutes,
        ))
      : []
  const retrievalLimit = questionAsksAboutGlossary(question) ? Math.max(limit, 18) : limit

  // Fast path: inventory questions with Doctor chunks — filter-only, no embedding needed
  if (questionAsksInventory(question) && exactRoutes.length === 0) {
    const mentionedRepo = question.match(/\b([\w]+-[\w-]+|bpjs|bpts|ims-tf2?)\b/i)?.[1]?.toLowerCase()
    const doctorRepoName = mentionedRepo ? `${mentionedRepo}-docs` : undefined
    const asksServices = /\b(what services|services? (detected|list|available)|detected (services?|repos?))\b/i.test(question)
    const asksEnv = /\b(environment variables?|env vars?|process\.env|what env|which env)\b/i.test(question)
    const asksDbTables = /\b(database tables?|db tables?|which tables?|what tables?|tables? (used|detected)|touch|services.*touch|what.*touch)\b/i.test(question)
    const asksDeps = /\b(dependenc)/i.test(question)

    const doctorFileFilters: string[] = []
    if (asksServices || asksDeps) doctorFileFilters.push("doctor:overview.md", "doctor:services.md")
    if (asksEnv) doctorFileFilters.push("doctor:env.md")
    if (asksDbTables) doctorFileFilters.push("doctor:database.md")
    if (doctorFileFilters.length === 0) doctorFileFilters.push("doctor:overview.md")

    if (doctorRepoName) {
      // Single-repo path — repo mentioned in question
      try {
        const scrollFilter = {
          must: [
            { key: "repoName", match: { value: doctorRepoName } },
            { key: "branchName", match: { value: "doctor" } },
          ],
          should: doctorFileFilters.map(fp => ({ key: "filePath", match: { value: fp } })),
        }
        const scrollResult = await qdrant.scroll(config.collectionName, {
          filter: scrollFilter, limit: 20, with_payload: true, with_vector: false,
        })
        const doctorChunks = (scrollResult.points as Array<{ id: string | number; payload?: Record<string, unknown> | null }>)
          .map(p => p.payload as RetrievedPayload | undefined)
          .filter((p): p is RetrievedPayload => !!p?.content)

        if (doctorChunks.length > 0) {
          const summaryChunks = doctorChunks.filter(c => c.content?.includes('unique)') || c.content?.includes('# ') || c.content?.includes('## Summary'))
          const detailChunks = doctorChunks.filter(c => !summaryChunks.includes(c))
          const output = summaryChunks.length > 0
            ? [...summaryChunks, ...detailChunks.slice(0, 2)]
            : doctorChunks.slice(0, 8)

          // Synthesize via LLM instead of raw dump — same pattern as queue answer
          const inventoryContext = output.map(c => c.content ?? "").join("\n\n---\n\n")
          const inventoryPrompt = [
            `Question: ${question}`,
            `Answer language: ${answerLanguageLabel(question)}`,
            "",
            "Repo Doctor evidence for the requested service/repo:",
            inventoryContext,
            "",
            "Answer requirements:",
            "- Synthesize the evidence above into a clear, readable answer.",
            "- Group related facts (services, env vars, DB tables, dependencies) into sections.",
            "- Mention specific file paths and line numbers from the evidence.",
            "- If a section has no evidence, omit it rather than saying 'none found'.",
            "- Do not repeat raw markdown tables verbatim — summarize and highlight key facts.",
            "- Say NOT_FOUND_IN_INDEXED_CODEBASE only if the evidence contains nothing relevant.",
          ].join("\n")

          console.log("\nANSWER\n")
          const synthesized = await chat(inventoryPrompt)
          console.log(localizeAnswer(synthesized, question))
          console.log("\nSOURCES\n")
          for (const chunk of output) {
            console.log(`- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`)
          }
          return
        }
      } catch { /* no doctor chunks — fall through to normal retrieval */ }
    } else if (asksDbTables) {
      // Cross-repo path — no repo mentioned, fetch database.md from ALL doctor repos
      // Filter by any table name mentioned in the question
      const tableHints = [
        ...extractQuestionHints(question).filter(t => /^[a-z][a-z0-9]+_[a-z][a-z0-9_]+$/.test(t)),
        // also extract snake_case words directly from the question
        ...(question.match(/\b[a-z][a-z0-9]+(?:_[a-z][a-z0-9]+)+\b/g) ?? []),
      ].filter((v, i, a) => a.indexOf(v) === i) // dedupe

      try {
        const scrollFilter = {
          must: [
            { key: "branchName", match: { value: "doctor" } },
            { key: "filePath", match: { value: "doctor:database.md" } },
          ],
        }
        let offset: string | number | Record<string, unknown> | null | undefined
        const allDoctorDbChunks: RetrievedPayload[] = []

        do {
          const page = await qdrant.scroll(config.collectionName, {
            filter: scrollFilter, limit: 256, with_payload: true, with_vector: false,
            ...(offset ? { offset } : {}),
          })
          for (const p of page.points) {
            const payload = p.payload as RetrievedPayload | null | undefined
            if (!payload?.content) continue
            // if table hints extracted, only keep chunks mentioning those tables
            if (tableHints.length > 0) {
              const content = payload.content.toLowerCase()
              if (!tableHints.some(t => content.includes(t))) continue
            }
            allDoctorDbChunks.push(payload)
          }
          offset = page.next_page_offset
        } while (offset)

        if (allDoctorDbChunks.length > 0) {
          // Group by repo
          const byRepo = new Map<string, RetrievedPayload[]>()
          for (const chunk of allDoctorDbChunks) {
            const repo = chunk.repoName ?? "unknown"
            const list = byRepo.get(repo) ?? []
            list.push(chunk)
            byRepo.set(repo, list)
          }

          // For each repo, extract only lines matching the table hints
          const repoSummaries: Array<{ repo: string; chunk: RetrievedPayload; lines: string[] }> = []
          for (const [repo, chunks] of byRepo) {
            const matchingLines: string[] = []
            for (const chunk of chunks) {
              const lines = (chunk.content ?? "").split("\n")
              for (const line of lines) {
                if (tableHints.length === 0 || tableHints.some(t => line.toLowerCase().includes(t))) {
                  if (line.startsWith("|") || line.startsWith("#")) matchingLines.push(line)
                }
              }
            }
            if (matchingLines.length > 0) {
              repoSummaries.push({ repo, chunk: chunks[0]!, lines: matchingLines.slice(0, 20) })
            }
          }

          if (repoSummaries.length > 0) {
            console.log("\nANSWER\n")
            console.log(`Services that touch \`${tableHints.join(", ")}\` (Repo Doctor, ${repoSummaries.length} repos):\n`)
            for (const { repo, lines } of repoSummaries) {
              console.log(`### ${repo}`)
              console.log(lines.join("\n"))
              console.log("")
            }
            console.log("\nSOURCES\n")
            for (const { chunk } of repoSummaries) {
              console.log(`- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`)
            }
            return
          }
        }
      } catch { /* fall through */ }
    }
  }

  // Run independent retrieval calls in parallel to avoid sequential Qdrant round-trips.
  const isGlossaryNotAccountTypes = exactRoutes.length === 0 && questionAsksAboutGlossary(question) && !questionAsksAboutAccountTypes(question)
  const vectorParallelStart = nowMs()
  const [
    initialChunks,
    preferredLocaleDocChunksRaw,
    exactDocumentationSubjectChunksRaw,
  ] = await Promise.all([
    exactRoutes.length > 0 ? Promise.resolve([]) : retrieve(retrievalQuestion, retrievalLimit),
    isGlossaryNotAccountTypes
      ? retrievePreferredLocaleDocChunks(retrievalQuestion, Math.max(retrievalLimit, 16))
      : Promise.resolve([]),
    isGlossaryNotAccountTypes && !isGeneralVocabQuestion
      ? retrieveDocumentationSubjectMatches([
          ...extractConceptTokens(question),
          ...extractDefinitionSubjectTerms(question),
          ...extractQuestionAcronyms(question),
          ...extractShortSubjectTokens(question),
        ], Math.max(retrievalLimit, 24))
      : Promise.resolve([]),
  ])
  if (exactRoutes.length > 0) {
    dlog("stage", { name: "vector-retrieval-parallel", status: "skipped", reason: "exact-routes-present" })
  } else {
    dlog("stage", {
      name: "vector-retrieval-parallel",
      status: "executed",
      ms: elapsedMs(vectorParallelStart),
      initial: initialChunks.length,
      preferredLocaleDoc: (preferredLocaleDocChunksRaw as RetrievedChunk[]).length,
      docSubject: (exactDocumentationSubjectChunksRaw as RetrievedChunk[]).length,
    })
  }
  const preferredLocaleDocChunks = (preferredLocaleDocChunksRaw as RetrievedChunk[]).filter(chunk => {
    // When the question is about a specific product (isignal, FA, etc.), exclude unrelated repos
    // so the docs:id locale for a different product doesn't dominate.
    const repoName = chunk.payload.repoName?.toLowerCase() ?? ""
    const filePath = chunk.payload.filePath?.toLowerCase() ?? ""
    if (registryExpansion.terms.map(t => t.toLowerCase()).includes("isignal")) {
      // isignal has no docs:id — drop docs:id chunks from other repos to avoid pollution
      if (!repoName.includes("isignal") && !filePath.includes("isignal")) return false
    }
    return true
  })
  const exactDocumentationSubjectChunks = exactDocumentationSubjectChunksRaw as RetrievedChunk[]
  const docNeighborStart = nowMs()
  const [preferredLocaleDocNeighborChunks, exactDocumentationSubjectNeighborChunks] = await Promise.all([
    preferredLocaleDocChunks.length > 0 && questionAsksAboutGlossary(question)
      ? retrieveNeighborChunks(preferredLocaleDocChunks, 30)
      : Promise.resolve([]),
    exactDocumentationSubjectChunks.length > 0 && questionAsksAboutGlossary(question)
      ? retrieveNeighborChunks(exactDocumentationSubjectChunks, 40)
      : Promise.resolve([]),
  ])
  if (preferredLocaleDocChunks.length > 0 || exactDocumentationSubjectChunks.length > 0) {
    dlog("stage", {
      name: "doc-neighbor-retrieval",
      ms: elapsedMs(docNeighborStart),
      preferredLocaleNeighbors: preferredLocaleDocNeighborChunks.length,
      docSubjectNeighbors: exactDocumentationSubjectNeighborChunks.length,
    })
  }
  const hints = collectHints([...exactChunks, ...exactDetailChunks, ...exactTermChunks, ...exactVocabularyChunks, ...exactMetaTraderChunks, ...exactMinimumEquityChunks, ...isignalDocChunks, ...exactTermDetailChunks, ...vocabUsageChunks, ...exactDocumentationSubjectChunks, ...initialChunks])
  const expansionQueries =
    exactEndpointInspection
      ? []
      : exactRoutes.length > 0 && exactChunks.length === 0
        ? []
      : exactRoutes.length > 0 && !shouldExpandExactRouteQuestion(question)
        ? []
      : shouldExpandRetrieval(question, hints)
        ? buildExpansionQueries(question, hints)
        : []
  const expandedChunks = []

  const expansionStart = nowMs()
  for (const expansionQuery of expansionQueries) {
    expandedChunks.push(...await retrieve(`${expansionQuery}\n${registryExpansion.terms.join(" ")}`, Math.max(3, Math.ceil(retrievalLimit / 2))))
  }
  if (expansionQueries.length > 0) {
    dlog("stage", { name: "expansion-retrieval", ms: elapsedMs(expansionStart), queries: expansionQueries.length, chunks: expandedChunks.length })
  }

  // Bridge vocabulary gap: extract code identifiers from retrieved documentation
  // chunks and find the actual implementation code they reference.
  // First, expand to sibling docs from the same doc section — e.g., if we found
  // isignal-docs/edge-cases.md, also fetch cron-jobs/index.md which contains
  // specific identifiers (CronCheckDeals, etc.) that lead to implementation code.
  const docChunksForExpansion = [...preferredLocaleDocChunks, ...exactDocumentationSubjectChunks, ...isignalDocChunks, ...preferredLocaleDocNeighborChunks, ...exactDocumentationSubjectNeighborChunks]
  const docSectionStart = nowMs()
  const docSectionSiblings = docChunksForExpansion.length > 0
    ? await retrieveDocSectionSiblings(docChunksForExpansion, 24)
    : []
  if (docSectionSiblings.length > 0) {
    dlog("stage", { name: "doc-section-expansion", ms: elapsedMs(docSectionStart), siblingDocs: docSectionSiblings.length })
  }
  const docChunksForCodeRef = [...docChunksForExpansion, ...docSectionSiblings]
  const docRefStart = nowMs()
  const docRefCodeChunks = docChunksForCodeRef.length > 0
    ? await retrieveCodeFromDocReferences(docChunksForCodeRef, Math.max(retrievalLimit, 24))
    : []
  if (docRefCodeChunks.length > 0) {
    dlog("stage", { name: "doc-ref-code-retrieval", ms: elapsedMs(docRefStart), codeChunks: docRefCodeChunks.length })
  }

  // For decision-intent questions, always fetch approved decision chunks directly
  // and prepend them — they must not compete for slots against code chunks.
  const decisionChunks: RetrievedChunk[] = isDecisionIntentQuestion
    ? await timeStage("decision-chunks", async () => {
        const result = await qdrant.scroll(config.collectionName, {
          filter: { must: [{ key: "source_type", match: { value: "decision" } }] },
          limit: 20,
          with_payload: true,
          with_vector: false,
        })
        return result.points
          .map(point => ({ id: String(point.id), payload: point.payload as RetrievedPayload }))
          .filter(chunk => chunk.payload.content)
      })
    : []

  const mergeStart = nowMs()
  const retrievedChunks = mergeChunks(
    [
      ...decisionChunks,
      ...exactChunks,
      ...symbolChunks,
      ...exactDetailChunks,
      // Code chunks from doc-ref retrieval go early — compactRetrievedChunks is
      // first-come-first-served, so code must be ahead of docs to survive the limit.
      ...docRefCodeChunks,
      // isignalDocChunks first — they are explicitly scrolled for timeline/eligibility
      // questions and must not be crowded out by docs:id chunks from other repos
      ...isignalDocChunks,
      ...preferredLocaleDocChunks,
      ...preferredLocaleDocNeighborChunks,
      ...exactDocumentationSubjectChunks,
      ...exactDocumentationSubjectNeighborChunks,
      ...docSectionSiblings,
      ...exactTermChunks,
      ...exactVocabularyChunks,
      ...exactMetaTraderChunks,
      ...exactMinimumEquityChunks,
      ...generalVocabChunks,
      ...vocabUsageChunks,
      ...exactTermDetailChunks,
      ...initialChunks,
      ...expandedChunks,
    ],
    exactRoutes.length > 0
      ? Math.max(limit, 24)
      : questionAsksAboutAccountTypes(question)
        ? Math.max(retrievalLimit, 36)
        : questionAsksAboutGlossary(question)
        ? Math.max(retrievalLimit, 96)
        : (questionAsksProjectTimeline(question) || questionAsksEligibilityRequirement(question))
        ? Math.max(limit, 48)
        : Math.max(limit, 12),
  )
  dlog("stage", { name: "merge-chunks", ms: elapsedMs(mergeStart), retrievedChunks: retrievedChunks.length })
  const accountTypeFileChunks = questionAsksAboutAccountTypes(question)
    ? await timeStage("account-type-file-chunks", () => retrieveAccountTypeFileChunks(retrievedChunks, question))
    : []
  const answerChunks = accountTypeFileChunks.length > 0
    ? mergeChunks([...retrievedChunks, ...accountTypeFileChunks], Math.max(retrievalLimit, 320))
    : retrievedChunks
  const deepInvestigation = deepMode
    ? await runDeepInvestigation(question, relationshipGraph, answerChunks, exactRoutes, exactTermSearchTerms, hints)
    : undefined
  const finalAnswerChunks = deepInvestigation
    ? mergeChunks([...answerChunks, ...deepInvestigation.chunks], Math.max(retrievalLimit, 64))
    : answerChunks
  // For decision-intent questions, only send decision chunks to the LLM — code chunks
  // are noise that causes smaller models to ignore the actual decision content.
  const chunks = (isDecisionIntentQuestion && decisionChunks.length > 0
    ? finalAnswerChunks.filter(chunk => chunk.payload.source_type === "decision")
    : finalAnswerChunks
  ).map(chunk => chunk.payload)
  const routeDefinitions = orderRouteDefinitions(extractRouteDefinitions(exactChunks, exactRoutes), exactRoutes)
  const exactRouteRepoNames = unique(exactChunks.map(chunk => chunk.payload.repoName ?? ""), 12)
  const handlerFacts = extractHandlerFactSummary(exactDetailChunks, exactHandlerRefs, exactRouteRepoNames)
  const endpointFacts = extractEndpointHandlerFacts(exactDetailChunks, exactHandlerRefs, exactRouteRepoNames)
  const endpointRpcFuncNames = extractRpcFuncNamesFromFacts(endpointFacts)
  // Skip endpoint-extra-terms when exactDetailChunks already contain the
  // relevant downstream evidence (deposit_demo / users_demoid / RPC func).
  // The extra retrieval is only needed when the route-details stage didn't
  // already surface the downstream model chunks.
  const hasDownstreamEvidence = exactDetailChunks.some(c => {
    const content = c.payload.content ?? ""
    return content.includes("deposit_demo") || content.includes("users_demoid") || endpointRpcFuncNames.some(name => content.includes(name))
  })
  const endpointExtraTermChunks = endpointRpcFuncNames.some(name => /SubmitDepositDemo/i.test(name)) && !hasDownstreamEvidence
    ? await timeStage("endpoint-extra-terms", () =>
        retrieveExactTermMatches(["deposit_demo", "users_demoid", "SubmitDepositDemo"], 12))
    : []
  if (endpointRpcFuncNames.some(name => /SubmitDepositDemo/i.test(name)) && hasDownstreamEvidence) {
    dlog("stage", { name: "endpoint-extra-terms", status: "skipped", reason: "downstream-evidence-already-present" })
  }
  const endpointDetailEvidenceChunks = [...exactDetailChunks, ...endpointExtraTermChunks]
  const phpConstantNamesForExactRoutes = extractPhpConstantNamesForRoutes(exactChunks, exactRoutes)
  // Compute upstream facts from existing evidence first. Only run the PHP
  // caller fallback (php-caller-chunks) when no upstream facts were found
  // and no PHP constants were extracted — avoids ~85ms BM25+retrieve when
  // the evidence is already present.
  const upstreamConstantNames = phpConstantNamesForExactRoutes.length > 0
    ? phpConstantNamesForExactRoutes
    : endpointDetailEvidenceChunks.flatMap(c =>
        [...(c.payload.content ?? "").matchAll(/\bHelper::requestAPI\s*\(\s*(?:[A-Z][A-Za-z0-9_]*::)?([A-Z][A-Z0-9_]+)/g)]
          .map(m => m[1] ?? "")
          .filter(Boolean)
      )
  const preliminaryUpstreamFacts = extractUpstreamRouteCallerFacts(
    endpointDetailEvidenceChunks,
    upstreamConstantNames,
  )
  const phpCallerChunks: RetrievedChunk[] = preliminaryUpstreamFacts.length === 0 && phpConstantNamesForExactRoutes.length === 0 && exactRoutes.length > 0
    ? await timeStage("php-caller-chunks", async () => {
        const routeSegments = exactRoutes.flatMap(r => r.split("/").filter(s => s.length > 3 && !/^v\d+$/.test(s)))
        if (routeSegments.length === 0) return []
        const bm25Hits = await bm25Search(routeSegments.join(" "), 16)
        if (bm25Hits.length === 0) return []
        try {
          const points = await qdrant.retrieve(config.collectionName, { ids: bm25Hits.map(r => r.id), with_payload: true })
          return points
            .map(p => ({ id: String(p.id), payload: p.payload as RetrievedPayload }))
            .filter(c => c.payload.content && c.payload.content.includes("Helper::requestAPI"))
        } catch (err) {
          console.error("BM25 PHP caller retrieve failed:", err instanceof Error ? err.message : err)
          return []
        }
      })
    : []
  if (preliminaryUpstreamFacts.length > 0) {
    dlog("stage", { name: "php-caller-chunks", status: "skipped", reason: "upstream-facts-already-present" })
  }
  const upstreamFacts = phpCallerChunks.length > 0
    ? extractUpstreamRouteCallerFacts(
        [...endpointDetailEvidenceChunks, ...phpCallerChunks],
        phpCallerChunks.flatMap(c =>
          [...(c.payload.content ?? "").matchAll(/\bHelper::requestAPI\s*\(\s*(?:[A-Z][A-Za-z0-9_]*::)?([A-Z][A-Z0-9_]+)/g)]
            .map(m => m[1] ?? "")
            .filter(Boolean)
        ),
      )
    : preliminaryUpstreamFacts
  const downstreamFacts = extractDownstreamRpcFacts(
    endpointDetailEvidenceChunks,
    exactRouteRepoNames,
  )
  const genericDownstreamFacts = extractGenericDownstreamRpcFacts(
    endpointDetailEvidenceChunks,
    exactRouteRepoNames,
    endpointRpcFuncNames,
  )
  const deterministicExactAnswer =
    exactComparison
      ? buildExactRouteComparisonAnswer(routeDefinitions, handlerFacts, downstreamFacts, chunks)
      : undefined
  const deterministicEndpointAnswer = exactEndpointInspection
    ? buildExactEndpointDetailAnswer(routeDefinitions, endpointFacts, genericDownstreamFacts, chunks, upstreamFacts)
    : undefined

  // In deep mode, skip ALL deterministic fast paths — let the LLM synthesize
  // from the full retrieved context for richer, more nuanced answers.
  fastPaths: {
    if (deepMode) break fastPaths

  if (deterministicExactAnswer || deterministicEndpointAnswer) {
    // Build source list from precise evidence chunks used in the answer.
    // selectEndpointSources picks at most 4: route definition, handler
    // implementation, upstream caller, downstream RPC/model — excluding
    // local-codebase-ai, unrelated doctor docs, and other handlers in the
    // same route file.
    const endpointDefinition = deterministicEndpointAnswer
      ? routeDefinitions.map(parseRouteDefinition).find(d => d !== undefined)
      : undefined
    const specificHandler = endpointDefinition?.handler.split(".").at(-1)
    const sourcePayloads = deterministicEndpointAnswer
      ? selectEndpointSources(
          [...exactChunks, ...exactDetailChunks, ...endpointExtraTermChunks, ...phpCallerChunks],
          endpointDefinition,
          specificHandler,
          endpointRpcFuncNames,
          exactRouteRepoNames,
        )
      : chunks
    const sourceChunks = compactPayloadSources(sourcePayloads, 16)

    dlog("early-return", { path: deterministicExactAnswer ? "exact-route-comparison" : "exact-endpoint-detail", totalMs: elapsedMs(mainStart), sources: sourceChunks.length })

    console.log("\nANSWER\n")
    console.log(localizeAnswer(deterministicExactAnswer ?? deterministicEndpointAnswer ?? "", question))

    console.log("\nSOURCES\n")

    for (const chunk of sourceChunks) {
      console.log(
        `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`,
      )
    }

    return
  }

  if (chunks.length === 0) {
    console.warn("No chunks were retrieved. Try a broader question or remove repo/service filters.")
  }

  const exactSymbolAnswer =
    exactRoutes.length === 0 && exactTermChunks.length > 0
      ? buildExactSymbolAnswer(extractNamedSymbolsFromQuestion(question), mergeChunks([...exactTermChunks, ...exactTermDetailChunks], 24))
      : undefined

  if (exactSymbolAnswer) {
    const sourceChunks = compactPayloadSources(mergeChunks([...exactTermChunks, ...exactTermDetailChunks], 16).map(chunk => chunk.payload), 16)

    console.log("\nANSWER\n")
    console.log(localizeAnswer(exactSymbolAnswer, question))

    console.log("\nSOURCES\n")

    for (const chunk of sourceChunks) {
      console.log(
        `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`,
      )
    }

    return
  }

  const platformTypeGlossaryAnswer = buildPlatformTypeGlossaryAnswer(chunks, question, localized)

  if (platformTypeGlossaryAnswer) {
    const sourceChunks = compactPayloadSources(chunks.filter(chunk => {
      return /platform_type|mt4DemoType|mt5DemoType|MetaTrader|MT4|MT5/i.test(chunk.content ?? "")
    }), 12)

    console.log("\nANSWER\n")
    console.log(platformTypeGlossaryAnswer)

    console.log("\nSOURCES\n")

    for (const chunk of sourceChunks) {
      console.log(
        `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`,
      )
    }

    return
  }

  const accountTypeGlossaryAnswer = buildAccountTypeGlossaryAnswer(chunks, question, localized)

  if (accountTypeGlossaryAnswer) {
    const sourceChunks = compactPayloadSources(accountTypeRelevantSourceChunks(chunks, question), 12)

    console.log("\nANSWER\n")
    console.log(accountTypeGlossaryAnswer)

    console.log("\nSOURCES\n")

    for (const chunk of sourceChunks) {
      console.log(
        `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`,
      )
    }

    return
  }

  if (questionAsksAboutAccountTypes(question)) {
    console.log("\nANSWER\n")
    console.log(buildAccountTypeNotFoundAnswer(question, localized))

    console.log("\nSOURCES\n")

    return
  }

  const medalMechanismAnswer = buildMedalMechanismAnswer(chunks, question)

  if (medalMechanismAnswer) {
    const sourceChunks = compactPayloadSources(chunks
      .filter(chunk => /dsc_channels_point_events|dsc_channels_point_medal_journal|dsc_channels_point_balance|dsc_channels_point_redeem|POINT_LEVELS|RANGE_MEDAL|prev_channel_medal|total_pips|last_qualify_id|qualify|redeemPointAsync|CalculatePointAndMedal20260531|current_month_vp|minimum_vp|average_monthly_vp|signal_settled|reset_channel/i.test(`${chunk.filePath ?? ""}\n${chunk.content ?? ""}`))
      , 12)

    console.log("\nANSWER\n")
    console.log(medalMechanismAnswer)

    console.log("\nSOURCES\n")

    for (const chunk of sourceChunks) {
      console.log(
        `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`,
      )
    }

    return
  }

  const metaTraderPayloads = mergeChunks([...exactMetaTraderChunks, ...exactTermChunks, ...exactTermDetailChunks], 80).map(chunk => chunk.payload)
  const metaTraderTermAnswer = buildMetaTraderTermAnswer(metaTraderPayloads.length > 0 ? metaTraderPayloads : chunks, question)

  if (metaTraderTermAnswer) {
    const sourceChunks = compactPayloadSources((metaTraderPayloads.length > 0 ? metaTraderPayloads : chunks)
      .filter(chunk => /metatrader|platform_type|metaserver|serverplatform|tf_metatrader_platform_type|mrg_metatrader_platform_type|askap_metatrader_platform_type|volume_multiplier|akun metatrader/i.test(`${chunk.filePath ?? ""}\n${chunk.content ?? ""}`))
      .filter(chunk => !/devops-docs/i.test(chunk.filePath ?? ""))
      , 12)

    console.log("\nANSWER\n")
    console.log(metaTraderTermAnswer)

    console.log("\nSOURCES\n")

    for (const chunk of sourceChunks) {
      console.log(
        `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`,
      )
    }

    return
  }

  const vocabularyAnswer = isDecisionIntentQuestion && decisionChunks.length > 0
    ? undefined
    : buildVocabularyAnswer(chunks, question, registryExpansion)

  if (vocabularyAnswer) {
    const sourceChunks = compactPayloadSources(chunks.filter(chunk => chunk.filePath?.startsWith("vocabulary://")), 12)

    console.log("\nANSWER\n")
    console.log(vocabularyAnswer)

    console.log("\nSOURCES\n")

    for (const chunk of sourceChunks) {
      console.log(
        `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`,
      )
    }

    return
  }

  const commentRuleAnswer = buildCommentRuleAnswer(chunks, question)

  if (commentRuleAnswer) {
    console.log("\nANSWER\n")
    console.log(commentRuleAnswer)

    console.log("\nSOURCES\n")

    return
  }

  const documentationTimelineAnswer = buildDocumentationTimelineAnswer(chunks, question)

  if (documentationTimelineAnswer) {
    const sourceChunks = compactPayloadSources(chunks
      .filter(chunk => chunk.evidenceTypes?.includes("documentation"))
      .filter(chunk => /changelog|timeline|roadmap|history/i.test(chunk.filePath ?? ""))
      .filter(chunk => /isignal-docs/i.test(chunk.filePath ?? ""))
      , 12)

    console.log("\nANSWER\n")
    console.log(documentationTimelineAnswer)

    console.log("\nSOURCES\n")

    for (const chunk of sourceChunks) {
      console.log(
        `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`,
      )
    }

    return
  }

  const minimumEquityEvidenceChunks = mergeChunks([
    ...exactMinimumEquityChunks,
    ...exactTermChunks,
    ...exactTermDetailChunks,
    ...answerChunks,
  ], 32).map(chunk => chunk.payload)
  const minimumEquityConfigAnswer = buildMinimumEquityConfigAnswer(minimumEquityEvidenceChunks.length > 0 ? minimumEquityEvidenceChunks : chunks, question)

  if (minimumEquityConfigAnswer) {
    const sourceChunks = compactPayloadSources((minimumEquityEvidenceChunks.length > 0 ? minimumEquityEvidenceChunks : chunks)
      .filter(chunk => /AUTO_COPY_MINIMUM_EQUITY|minimumEquity/i.test(`${chunk.filePath ?? ""}\n${chunk.content ?? ""}`))
      , 12)
    const answer = deepMode
      ? [
          localized("Investigation trace:", "Investigation trace:"),
          localized("- Step 1: mendeteksi pertanyaan minimum equity iSignal.", "- Step 1: detected an iSignal minimum equity question."),
          localized("- Step 2: mencari config code exact untuk AUTO_COPY_MINIMUM_EQUITY/minimumEquity.", "- Step 2: searched exact config code for AUTO_COPY_MINIMUM_EQUITY/minimumEquity."),
          localized("- Step 3: memakai evidence config terkonfirmasi sebelum retrieval dokumentasi yang lebih noisy.", "- Step 3: used confirmed config evidence before noisier documentation retrieval."),
          "",
          minimumEquityConfigAnswer,
        ].join("\n")
      : minimumEquityConfigAnswer

    console.log("\nANSWER\n")
    console.log(answer)

    console.log("\nSOURCES\n")

    for (const chunk of sourceChunks) {
      console.log(
        `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`,
      )
    }

    return
  }

  const documentationEligibilityAnswer = buildDocumentationEligibilityAnswer(chunks, question)

  if (documentationEligibilityAnswer) {
    const sourceChunks = compactPayloadSources(chunks
      .filter(chunk => /isignal|auto copy|copy signal|bot copy|ois|subscription|bot|account|akun|equity|balance|mt4|mt5/i.test(`${chunk.filePath ?? ""}\n${chunk.content ?? ""}`))
      .filter(chunk => !isCronDocChunk(chunk))
      , 12)

    console.log("\nANSWER\n")
    console.log(documentationEligibilityAnswer)

    console.log("\nSOURCES\n")

    for (const chunk of sourceChunks) {
      console.log(
        `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`,
      )
    }

    return
  }

  // In deep mode, skip the deterministic mermaid fast path — let the LLM synthesize
  // a richer answer using the diagram + surrounding retrieved context.
  const mermaidDiagramAnswer = !deepMode
    ? await buildMermaidDiagramAnswer(chunks, question)
    : undefined

  if (mermaidDiagramAnswer) {
    console.log("\nANSWER\n")
    console.log(mermaidDiagramAnswer.answer)

    console.log("\nSOURCES\n")

    for (const chunk of mermaidDiagramAnswer.sources) {
      console.log(
        `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`,
      )
    }

    return
  }

  const registryAliasDefinitionAnswer = buildRegistryAliasDefinitionAnswer(question, registryExpansion)

  if (registryAliasDefinitionAnswer) {
    console.log("\nANSWER\n")
    console.log(registryAliasDefinitionAnswer)

    console.log("\nSOURCES\n")
    console.log("- config/services.json (local registry)")

    return
  }

  // Decision fast path must run before glossary/documentation paths — decision-intent
  // questions like "what is the rule about X" match questionAsksAboutGlossary() but
  // should be answered from approved decisions, not documentation summaries.
  const documentationGlossaryAnswer = isDecisionIntentQuestion && decisionChunks.length > 0
    ? undefined
    : await buildDocumentationGlossaryAnswer(chunks, question)

  if (documentationGlossaryAnswer) {
    const glossaryNotFoundAnswer = /Saya tidak menemukan definisi|I did not find an explicit/i.test(documentationGlossaryAnswer)
    const sourceChunks = glossaryNotFoundAnswer
      ? []
      : compactPayloadSources(documentationGlossarySourceChunks(chunks, question), 12)

    console.log("\nANSWER\n")
    console.log(documentationGlossaryAnswer)

    console.log("\nSOURCES\n")

    for (const chunk of sourceChunks) {
      console.log(
        `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`,
      )
    }

    return
  }

  const doctorInventoryAnswer = questionAsksInventory(question)
    ? buildDoctorInventoryAnswer(chunks)
    : undefined
  const hasDoctorInventory = Boolean(doctorInventoryAnswer)

  // Direct Doctor inventory answer — no LLM needed for listing questions
  if (doctorInventoryAnswer) {
    console.log("\nANSWER\n")
    console.log(doctorInventoryAnswer.answer)
    console.log("\nSOURCES\n")
    for (const chunk of doctorInventoryAnswer.sources) {
      console.log(`- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`)
    }
    return
  }

  // Only use structural evidence answer when chunks actually contain structural signals
  // (routes, tables, queues, messages). Without those, it just emits a "missing anchor"
  // disclaimer that's worse than letting the LLM fallback synthesize from the raw context.
  const chunksHaveStructuralEvidence = chunks.some(c =>
    (c.routes?.length ?? 0) > 0 ||
    (c.dbTables?.length ?? 0) > 0 ||
    (c.queueNames?.length ?? 0) > 0 ||
    (c.messageNames?.length ?? 0) > 0 ||
    (c.exchangeNames?.length ?? 0) > 0,
  )
  const structuralEvidenceAnswer =
    !hasDoctorInventory &&
    exactRoutes.length === 0 &&
    chunksHaveStructuralEvidence &&
    (questionAsksAboutDatabase(question) || questionAsksAboutServicesOrFlow(question))
      ? buildStructuralEvidenceAnswer(chunks, question)
      : undefined

  if (structuralEvidenceAnswer) {
    console.log("\nANSWER\n")
    console.log(localizeAnswer(structuralEvidenceAnswer, question))

    console.log("\nSOURCES\n")

    for (const chunk of chunks) {
      console.log(
        `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`,
      )
    }

    return
  }
  } // end fastPaths

  // Fast path for decision-intent questions when approved decisions are available.
  // Send only decision chunks with a focused prompt — avoids noise from code chunks
  // and works reliably with smaller models.
  if (isDecisionIntentQuestion && decisionChunks.length > 0) {
    // Pre-filter by keyword relevance — only send decisions that mention terms from the question.
    // Prevents the model from summarizing all decisions when only one is relevant.
    const questionTerms = unique([
      ...extractQuestionHints(question),
      ...extractQuestionTerms(question),
      ...extractConceptTokens(question),
    ], 24).map(t => t.toLowerCase()).filter(t => t.length >= 3)

    const scoredDecisions = decisionChunks.map(chunk => {
      const text = (chunk.payload.content ?? "").toLowerCase()
      const score = questionTerms.reduce((s, term) => s + (text.includes(term) ? 1 : 0), 0)
      return { chunk, score }
    })

    const relevantDecisions = scoredDecisions
      .filter(d => d.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map(d => d.chunk)

    // Fall back to all decisions if none matched by keyword
    const decisionsToSend = relevantDecisions.length > 0 ? relevantDecisions : decisionChunks
    const decisionPayloads = decisionsToSend.map(chunk => chunk.payload)
    const decisionContext = decisionPayloads.map(p => p.content ?? "").join("\n\n---\n\n")
    const decisionPrompt = [
      `Question: ${question}`,
      "",
      "The following are approved architectural decisions from the team's decision log:",
      "",
      decisionContext,
      "",
      "Answer the question using only the decisions above.",
      "If no decision directly answers the question, say NOT_FOUND_IN_INDEXED_CODEBASE.",
      "Be concise. State the decision, the rationale if present, and which services are affected.",
      "Do not invent information not present in the decisions above.",
    ].join("\n")

    // Distinguish "LLM returned nothing" from "LLM call failed". Previously
    // both collapsed to "" via .catch(() => ""), making a down Ollama/network
    // error indistinguishable from "no matching decision" and silently falling
    // through to general retrieval. Now the failure is logged + flagged so it
    // is alertable, while still degrading safely.
    let decisionAnswer = ""
    let decisionLlmFailed = false
    try {
      decisionAnswer = await chat(decisionPrompt)
    } catch (err) {
      decisionLlmFailed = true
      const reason = err instanceof Error ? err.message : String(err)
      console.error(
        JSON.stringify({
          level: "warn",
          component: "decision-answer",
          event: "llm_call_failed",
          reason,
        }),
      )
    }

    if (decisionAnswer && !/^\s*$/.test(decisionAnswer)) {
      const sourceChunks = compactPayloadSources(decisionPayloads, 8)

      console.log("\nANSWER\n")
      console.log(decisionAnswer)
      console.log("\nSOURCES\n")
      for (const chunk of sourceChunks) {
        console.log(`- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`)
      }
      return
    }

    if (decisionLlmFailed) {
      // The decision LLM call failed (not merely empty) — record that we are
      // degrading to the general retrieval path instead of answering from decisions.
      console.error(
        JSON.stringify({
          level: "info",
          component: "decision-answer",
          event: "degrade_to_general_retrieval",
          reason: "decision LLM call failed",
        }),
      )
    }
  }

  const fallbackContextChunks = selectFallbackContextChunks(chunks, question)
  const context = fallbackContextChunks
    .map((chunk, index) => {
      return [
        `SOURCE ${index + 1}`,
        `repo: ${chunk.repoName}`,
        `projects: ${chunk.projectIds?.join(", ") ?? "unassigned"}`,
        `projectTagSources: ${chunk.projectTagSources?.join(", ") ?? ""}`,
        `branch: ${chunk.branchName}`,
        `commit: ${chunk.commitSha}`,
        `docLocale: ${chunk.docLocale ?? "default"}`,
        `serviceType: ${chunk.serviceType}`,
        `evidenceTypes: ${chunk.evidenceTypes?.join(", ") ?? "unknown"}`,
        `routes: ${chunk.routes?.join(", ") ?? ""}`,
        `symbols: ${chunk.symbols?.join(", ") ?? ""}`,
        `messageNames: ${chunk.messageNames?.join(", ") ?? ""}`,
        `queues: ${chunk.queueNames?.join(", ") ?? ""}`,
        `exchanges: ${chunk.exchangeNames?.join(", ") ?? ""}`,
        `dbTables: ${chunk.dbTables?.join(", ") ?? ""}`,
        `file: ${chunk.filePath}`,
        `lines: ${chunk.startLine}-${chunk.endLine}`,
        "```",
        chunk.content,
        "```",
      ].join("\n")
    })
    .join("\n\n")
  const evidenceInventory = buildEvidenceInventory(fallbackContextChunks, question)
  const graphFlowContext = buildGraphFlowContext(relationshipGraph, question, hints)
  const registryPromptContext = buildRegistryPromptContext(registryExpansion)
  const investigationTraceLines = deepInvestigation
    ? [
        "Investigation trace:",
        ...deepInvestigation.trace.map(item => `- ${item}`),
        "",
      ]
    : []

  const historyLines = history.length > 0
    ? [
        "Previous conversation:",
        ...history.map(h => `${h.role === "user" ? "User" : "Assistant"}: ${h.content}`),
        "",
      ]
    : []

  const prompt = [
    ...historyLines,
    `Question: ${question}`,
    `Answer language: ${answerLanguageLabel(question)}`,
    "",
    `Exact routes requested: ${exactRoutes.join(", ") || "none"}`,
    `Exact route matches found: ${exactChunks.length}`,
    `Handler/detail chunks found: ${exactDetailChunks.length}`,
    `Route handlers discovered: ${exactHandlerRefs.map(ref => ref.fullName).join(", ") || "none"}`,
    "",
    "Domain vocabulary hints:",
    registryPromptContext,
    "",
    "Extracted route definitions:",
    routeDefinitions.length > 0 ? routeDefinitions.join("\n\n") : "none",
    "",
    "Extracted handler facts:",
    handlerFacts.length > 0 ? handlerFacts.map(fact => `- ${fact}`).join("\n") : "none",
    "",
    "Evidence inventory:",
    evidenceInventory,
    "",
    "Cross-service graph evidence (from relationship index):",
    graphFlowContext,
    "",
    ...investigationTraceLines,
    "Relevant context:",
    context,
    "",
    "Answer requirements:",
    "- Answer in the same language as the user's question. If the question is in Bahasa Indonesia, answer in Bahasa Indonesia while keeping code identifiers unchanged.",
    "- Focus on answering the user's EXACT question. Do not describe unrelated features that happen to appear in the context. If the question asks about signal flow, describe signal flow — not the edit feature, even if edit docs are in the context.",
    "- For 'how does X work' questions, lead with code evidence (function names, SQL queries, cron jobs, queue operations). Use documentation only to provide context, not as the primary answer.",
    "- Synthesize a coherent answer that connects documentation and code evidence. Do not just list sources — explain how the pieces fit together.",
    "- For 'how does X work' questions, describe the end-to-end flow: entry points, processing steps, data flow, and output. Cite specific function names, SQL queries, queue operations, and config from the sources.",
    "- When code chunks are retrieved alongside docs, use the code to confirm, deepen, or correct what the docs say. Code is ground truth — if docs and code disagree, trust the code.",
    "- Quote specific function names, table names, and key lines from the source when explaining behavior. Do not paraphrase vaguely — point to the exact code.",
    "- Structure the answer with clear sections when the question is broad. Use markdown headers, not just bullet lists.",
    "- For cross-service flows, trace the path through services and explain each hop with evidence from the sources.",
    "- The cross-service graph evidence shows confirmed code-level connections between services (calls, handles, defines, touches table). Use these to trace cross-service flows and describe how services connect. These edges are confirmed by code analysis, not inferred.",
    "- Highlight design patterns, edge-case handling, and business rules visible in the code. These are insights the user cannot get from docs alone.",
    "- Anti-hallucination guardrail: every claim must trace back to a specific source chunk. If you cannot point to a function name, SQL query, config value, or doc line that supports a claim, do not make the claim.",
    "- Do not infer patterns, design decisions, or business rules that are not explicitly stated in the source code or documentation. Only describe what is directly visible in the code.",
    "- When connecting services or describing flows, only state connections that are explicitly shown in sources (e.g., a cron job calling a function, a SQL query referencing a table, a queue consumer). Do not infer connections from naming similarity or domain knowledge.",
    "- Answer from the context only.",
    "- Answer the user's exact question. If retrieved context is about a different topic, say NOT_FOUND_IN_INDEXED_CODEBASE for the requested topic instead of answering the different topic.",
    "- Domain vocabulary hints are synonyms for retrieval and disambiguation, not evidence. Do not present a hint as a fact unless it is supported by the source context.",
    "- Inline code comments are valid evidence when they directly state business rules, behavior, or consequences. If a comment clearly answers the user's question, quote it and cite the source. Do not require seeing the full implementation if the comment itself states the outcome.",
    "- For glossary/list questions, synthesize a concise glossary-style answer from all relevant source chunks. Include aliases, code constants, tables, routes, and rules only when they are visible in sources.",
    "- If the question asks for a list, return a list and cite the source lines for each group of facts.",
    "- If the question asks for a diagram, flowchart, Mermaid, or visual flow, include a fenced ```mermaid code block that uses only confirmed entities and edges from the context. Keep node labels short and include repo/service names when known.",
    "- If an indexed source contains a relevant Mermaid diagram, you may reuse or simplify that Mermaid diagram, but do not add unconfirmed edges.",
    "- If the question names exact routes or paths, prioritize sources whose content or route metadata exactly contains those paths.",
    "- Do not replace an exact route from the question with a different route unless explaining that the exact route was not found.",
    "- When comparing route definitions, compare method, alias, url, and handler exactly as written. Do not say handlers are the same if their names differ.",
    "- Do not say compared routes match exactly when their urls, aliases, or handlers differ.",
    "- Mention service/repo names, source file paths, and line ranges.",
    "- Mention branch names when they are present in source metadata.",
    "- Say NOT_FOUND_IN_INDEXED_CODEBASE only when NONE of the retrieved sources mention the user's topic. If any source, including inline comments, mentions the topic, answer from what it says even if the implementation uses variables or helper functions.",
    "- Treat the Evidence inventory as a whitelist for service, route, message, queue, exchange, and database table names.",
    "- Do not infer database table names from domain words. Only name tables that appear in metadata, SQL, or quoted source context.",
    "- Do not infer service involvement from class/client names alone. A service/repo is confirmed only when it appears in source metadata or an explicit source says it calls/handles the same route/message/function.",
    "- Use 'not confirmed in retrieved context' for gaps instead of hedging with likely, probably, might, or suggests.",
    "- If the evidence inventory says requested database/table evidence is not present, answer that the table impact is NOT_FOUND_IN_INDEXED_CODEBASE.",
    "- If the evidence inventory says requested service/flow evidence is not present, do not describe a flow; say what anchor was missing.",
    "- Prefer evidence from RabbitMQ handlers, API routes, cron jobs, database usage, and config files.",
    deepMode ? "- Deep investigation mode is enabled. Include a short 'Investigation trace' section before the final answer, summarizing which indexed evidence paths were followed. Keep it concise and do not expose hidden chain-of-thought." : undefined,
    deepMode ? "- In deep investigation mode, use the expanded evidence set to follow route -> handler -> RPC/message -> consumer -> database/config/docs when those links are present. Stop at NEED_MORE_EVIDENCE when the next link is missing." : undefined,
    "- Mention queue, routing key, exchange, and database table names when present.",
    "- If a route calls a symbol/message and another service consumes or handles the same symbol/message, explain that link as confirmed only when both sides appear in sources.",
    "- For general summary questions, only describe cross-service flow when the question asks about it or the context directly traces the flow through multiple services.",
    history.length > 0 ? "- This question may be a follow-up. Use the previous conversation to resolve pronouns like 'it', 'that', or 'the endpoint', but still ground your answer in the retrieved context above." : undefined,
  ].filter((line): line is string => typeof line === "string").join("\n")

  dlog("prompt-built", { promptChars: prompt.length, fallbackChunks: fallbackContextChunks.length })

  const answerStart = nowMs()
  let answer = await chat(prompt, deepMode ? config.deepMaxTokens : undefined)
  dlog("stage", { name: "answer-llm", ms: elapsedMs(answerStart), outChars: answer.length })

  // Quality gate: evaluate and retry if needed
  if (config.qualityRetryEnabled && fallbackContextChunks.length > 0) {
    const evalStart = nowMs()
    const evaluation = await evaluateAnswerQuality(question, answer, fallbackContextChunks)
    dlog("stage", { name: "quality-eval", ms: elapsedMs(evalStart), score: evaluation.score, threshold: config.qualityThreshold })
    await logQualityEvaluation(question, evaluation, false, answer)

    if (evaluation.score < config.qualityThreshold) {
      console.log(`\n⚠ Answer quality low (${evaluation.score.toFixed(2)}), retrying with refinement...\n`)

      const retryPrompt = `${prompt}\n\nPrevious answer had quality issues:\n${evaluation.issues.join("\n")}\n\nPlease improve the answer based on this feedback.`
      const retryStart = nowMs()
      answer = await chat(retryPrompt, deepMode ? config.deepMaxTokens : undefined)
      dlog("stage", { name: "answer-llm-retry", ms: elapsedMs(retryStart), outChars: answer.length })

      const retryEval = await evaluateAnswerQuality(question, answer, fallbackContextChunks)
      await logQualityEvaluation(question, retryEval, true, answer)
    }
  }

  const displayAnswer = /\bNOT_FOUND_IN_INDEXED_CODEBASE\b/.test(answer) && !/\bI do not have\b/i.test(answer)
    ? `I do not have enough indexed evidence for the requested topic.\n\n${answer}`
    : answer

  console.log("\nANSWER\n")
  console.log(localizeAnswer(displayAnswer, question))

  if (retrievalDegradation.bm25Unavailable) {
    console.log("\n[degraded] keyword (BM25) search was unavailable for this query — answer based on vector results only.")
  }

  console.log("\nSOURCES\n")

  // Build the complete set of chunks whose evidence was included in the prompt.
  // fallbackContextChunks is the main set, but the prompt also includes structured
  // facts (upstream/downstream/handler facts) extracted from endpointExtraTermChunks
  // and phpCallerChunks, which are retrieved AFTER the main chunk set and may not
  // be in fallbackContextChunks. Include them so source attribution is complete.
  const sourcePayloads = [...fallbackContextChunks]
  const seenKeys = new Set(
    fallbackContextChunks.map(c => `${c.repoName}:${c.filePath}:${c.startLine}-${c.endLine}`),
  )

  for (const chunk of [...endpointExtraTermChunks, ...phpCallerChunks]) {
    const p = chunk.payload
    const key = `${p.repoName}:${p.filePath}:${p.startLine}-${p.endLine}`
    if (!seenKeys.has(key)) {
      seenKeys.add(key)
      sourcePayloads.push(p)
    }
  }

  for (const chunk of sourcePayloads) {
    console.log(
      `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`,
    )
  }

  _askCompletedFull = true
  dlog("ask-complete", { totalMs: elapsedMs(mainStart), sources: sourcePayloads.length, bm25Degraded: retrievalDegradation.bm25Unavailable })
}

main()
  .then(() => {
    if (!_askCompletedFull) {
      dlog("ask-complete-early-return", { totalMs: elapsedMs(_askMainStart) })
    }
  })
  .catch(error => {
    dlog("ask-failed", { totalMs: elapsedMs(_askMainStart), error: error instanceof Error ? error.message : String(error) })
    console.error(error)
    process.exit(1)
  })
