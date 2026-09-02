// Deep
// Refactored from ask.ts — uses ctx for shared state

import type { RelationshipEdge } from "../lib/graph.js"
import type { RelationshipHints } from "../lib/relationships.js"
import { extractQuestionTerms } from "../lib/vocabulary.js"
import type { RetrievedChunk, RetrievedPayload, RouteDefinition } from "./types.js"
import { ctx } from "./context.js"
import { buildExpansionQueries, mergeChunks } from "./expansion.js"
import { edgeTextForConceptSearch } from "./graph-flow.js"
import { retrieve, retrieveExactTermMatches, retrieveFileChunks, retrieveNeighborChunks } from "./retrieve.js"
import { contentContainsRoute, routeMatches } from "./route-analysis.js"
import { escapeRegExp, extractConceptTokens, extractQuestionHints, questionAsksAboutServicesOrFlow, unique } from "./question.js"

export async function runDeepInvestigation(
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
      if (!ctx.repoName && edge.repoName === "local-codebase-ai") return false
      if (ctx.repoName && edge.repoName !== ctx.repoName) return false
      if (ctx.branch && edge.branchName !== ctx.branch) return false
      if (ctx.serviceType && edge.serviceType !== ctx.serviceType) return false
      if (ctx.projectFilterIds.length > 0) {
        const edgeProjectIds = edge.projectIds ?? []

        if (edgeProjectIds.length > 0) {
          return edgeProjectIds.some(projectId => ctx.projectFilterIds.includes(projectId))
        }

        return ctx.projectFilterRepos.has(edge.repoName)
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

  const scopedCollected = ctx.repoName
    ? collected
    : collected.filter(chunk => chunk.payload.repoName !== "local-codebase-ai")
  const finalChunks = mergeChunks(scopedCollected, Math.max(ctx.limit, ctx.deepMode ? 48 : 16))
  trace.push(`Step 7: compacted evidence set to ${finalChunks.length} source chunk(s).`)

  return {
    trace,
    chunks: finalChunks,
  }
}


export function selectEndpointSources(
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


export type DeepInvestigation = {
  trace: string[]
  chunks: RetrievedChunk[]
}
