// Retrieve
// Refactored from ask.ts — uses ctx for shared state

import { bm25Search, isIdentifierQuery } from "../lib/bm25-index.js"
import { config } from "../lib/config.js"
import { createEmbedding } from "../lib/ollama.js"
import { qdrant } from "../lib/qdrant.js"
import type { HandlerRef, RetrievedChunk, RetrievedPayload } from "./types.js"
import path from "node:path"
import { ctx } from "./context.js"
import { buildFilter, payloadMatchesFilter, repoBranchFileFilter, type SearchFilter } from "./filter.js"
import { rerankRetrievedChunks } from "./rerank.js"
import { contentContainsRoute, extractPhpConstantNamesForRoutes, extractRpcAndCallTerms, extractRpcFuncNames, parseRequireAliases, routeMatches, scoreExactTermMatch } from "./route-analysis.js"
import { scoreDocLocalePreference } from "./specialized-answers.js"
import { escapeRegExp, extractQuestionHints, questionBrokerHint, unique } from "./question.js"

export async function retrieveChunksByIds(ids: string[], filter: SearchFilter = undefined): Promise<RetrievedChunk[]> {
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


export async function retrieve(queryText: string, resultLimit: number): Promise<RetrievedChunk[]> {
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
  if (isIdentifierQuery(ctx.question)) {
    // extract identifier tokens from the original ctx.question, not the expanded queryText
    const identifierTokens = extractQuestionHints(ctx.question).filter(t => isIdentifierQuery(t))
    const bm25Query = identifierTokens.length > 0 ? identifierTokens.join(" ") : ctx.question
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
        ctx.retrievalDegradation.bm25Unavailable = true
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
    const rerankedRest = rerankRetrievedChunks(ctx.question, nonBm25Chunks)
    const merged = [...bm25Chunks, ...rerankedRest]
    return [...new Map(merged.map(c => [c.id, c])).values()].slice(0, resultLimit)
  }

  return rerankRetrievedChunks(ctx.question, chunks).slice(0, resultLimit)
}


export async function retrievePreferredLocaleDocChunks(queryText: string, resultLimit: number): Promise<RetrievedChunk[]> {
  if (ctx.answerLanguage !== "id" || ctx.branch) return []

  const questionVector = await createEmbedding(queryText)
  const must: Array<Record<string, unknown>> = [
    {
      key: "branchName",
      match: {
        value: "docs:id",
      },
    },
  ]

  if (ctx.repoName) {
    must.push({
      key: "repoName",
      match: {
        value: ctx.repoName,
      },
    })
  }

  if (ctx.serviceType) {
    must.push({
      key: "ctx.serviceType",
      match: {
        value: ctx.serviceType,
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


export async function retrieveDocumentationSubjectMatches(subjectTerms: string[], resultLimit: number): Promise<RetrievedChunk[]> {
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


export async function retrieveVocabularyChunks(queryText: string, resultLimit: number): Promise<RetrievedChunk[]> {
  const questionVector = await createEmbedding(queryText)
  const filter: Record<string, unknown> | undefined = ctx.repoName
    ? {
        must: [
          {
            key: "repoName",
            match: {
              value: ctx.repoName,
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


export async function retrieveExactVocabularyMatches(terms: string[], resultLimit: number): Promise<RetrievedChunk[]> {
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


export async function retrieveCodeFromDocReferences(docChunks: RetrievedChunk[], resultLimit: number): Promise<RetrievedChunk[]> {
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
  // aren't cut off by the 32-term ctx.limit.
  const repoSearchTerms: string[] = []
  for (const repo of ctx.registryExpansion.terms) {
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


export async function retrieveDocSectionSiblings(docChunks: RetrievedChunk[], maxResults: number): Promise<RetrievedChunk[]> {
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


export async function retrieveMetaTraderTermMatches(term: "MT4" | "MT5", resultLimit: number): Promise<RetrievedChunk[]> {
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


export async function retrieveMinimumEquityConfigChunks(resultLimit: number): Promise<RetrievedChunk[]> {
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


export async function retrieveExactRouteMatches(routes: string[]): Promise<RetrievedChunk[]> {
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

    if (!ctx.repoName && payload.repoName === "local-codebase-ai") continue

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


export async function retrieveExactTermMatches(terms: string[], maxMatches: number, filter: SearchFilter = buildFilter()): Promise<RetrievedChunk[]> {
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


export async function retrieveExactTermMatchesViaScroll(
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


export async function retrieveFileChunks(repoName: string, branchName: string, filePath: string): Promise<RetrievedChunk[]> {
  const cacheKey = `${repoName}|${branchName}|${filePath}`
  const cached = ctx.fileChunkCache.get(cacheKey)
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
  ctx.fileChunkCache.set(cacheKey, chunks)
  return chunks
}


export async function retrieveNeighborChunks(chunks: RetrievedChunk[], lineWindow = 90): Promise<RetrievedChunk[]> {
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


export async function retrieveAccountTypeFileChunks(chunks: RetrievedChunk[], question: string): Promise<RetrievedChunk[]> {
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


export async function resolveHandlerChunks(exactChunks: RetrievedChunk[], handlerRefs: HandlerRef[]): Promise<RetrievedChunk[]> {
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


export async function retrieveExactRouteDetails(
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
