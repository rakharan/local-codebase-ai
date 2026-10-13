// Graph Flow
// Refactored from ask.ts — uses ctx for shared state

import type { RelationshipEdge } from "../lib/graph.js"
import type { RelationshipHints } from "../lib/relationships.js"
import { extractQuestionTerms } from "../lib/vocabulary.js"
import type { GraphFlowAnswer, GraphPathDetails } from "./types.js"
import path from "node:path"
import { ctx } from "./context.js"
import { describeMethodBody } from "./exact-symbol.js"
import { retrieveFileChunks } from "./retrieve.js"
import { findMethodWindow, routeMatches, routeMatchesConceptTokens } from "./route-analysis.js"
import { extractConceptTokens, extractQuestionHints, questionAsksAboutServicesOrFlow, unique } from "./question.js"

export function edgeSource(edge: RelationshipEdge): string {
  return `${edge.repoName}@${edge.branchName || "unknown"} [${edge.serviceType}] ${edge.filePath}:${edge.startLine}-${edge.endLine}`
}


export function edgeTextForConceptSearch(edge: RelationshipEdge): string {
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


export function buildGraphFlowContext(graph: RelationshipEdge[], question: string, hints: RelationshipHints): string {
  if (graph.length === 0) return "none"

  const graphTerms = unique([
    ...extractQuestionHints(question),
    ...extractQuestionTerms(question),
    ...extractConceptTokens(question),
    ...ctx.registryExpansion.terms,
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


export function mentionedGraphRepos(question: string, graph: RelationshipEdge[]): string[] {
  const lower = question.toLowerCase()
  const repos = unique(graph.map(edge => edge.repoName), 100)
  const mentioned = repos.filter(repo => lower.includes(repo.toLowerCase()))

  return unique([
    ...(ctx.repoName ? [ctx.repoName] : []),
    ...ctx.projectFilterRepos,
    ...mentioned,
  ], 100)
}


export function handlerMethodName(handler: string | undefined): string | undefined {
  if (!handler) return undefined

  return handler.split(".").at(-1)
}


export function sameRepoBranchFile(left: RelationshipEdge, right: RelationshipEdge): boolean {
  return left.repoName === right.repoName && left.branchName === right.branchName && left.filePath === right.filePath
}


export function commonPathPrefixScore(leftPath: string, rightPath: string): number {
  const leftParts = leftPath.split(/[\\/]/)
  const rightParts = rightPath.split(/[\\/]/)
  let score = 0

  for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index++) {
    if (leftParts[index] !== rightParts[index]) break

    score++
  }

  return score
}


export function graphScopeAllows(edge: RelationshipEdge): boolean {
  if (!ctx.repoName && edge.repoName === "local-codebase-ai") return false
  if (ctx.repoName && edge.repoName !== ctx.repoName) return false
  if (ctx.projectFilterIds.length > 0) {
    const edgeProjectIds = edge.projectIds ?? []

    if (edgeProjectIds.length > 0) {
      if (!edgeProjectIds.some(projectId => ctx.projectFilterIds.includes(projectId))) return false
    } else if ((edge.projectTagSources ?? []).some(source => source.startsWith("repo:ambiguous:"))) {
      return false
    } else if (!ctx.projectFilterRepos.has(edge.repoName)) {
      return false
    }
  }
  if (ctx.branch && edge.branchName !== ctx.branch) return false
  if (ctx.serviceType && edge.serviceType !== ctx.serviceType) return false

  return true
}


export function scoreGraphCallEdge(edge: RelationshipEdge, tokens: string[], mentionedRepos: string[], question: string): number {
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


export function graphTextHasToken(text: string, token: string): boolean {
  if (token === "request") {
    return text.includes("request") || text.includes("reqaccount") || text.includes("reqdemo") || /\breq\b/.test(text)
  }

  return text.includes(token)
}


export function edgeTextForTokenMatch(edge: RelationshipEdge): string {
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


export function graphCandidateMatchesTokens(edge: RelationshipEdge, tokens: string[]): boolean {
  const text = edgeTextForTokenMatch(edge)

  return tokens.every(token => graphTextHasToken(text, token))
}


export function graphCandidateKey(edge: RelationshipEdge): string {
  const domain = edge.filePath.split(/[\\/]/).find(part => ["mrg", "askap", "mmb"].includes(part.toLowerCase())) ?? edge.filePath

  return [edge.type, domain, edge.toRoute ?? edge.externalFunc ?? edge.fromSymbol ?? edge.filePath].join(":")
}


export function selectGraphFlowCandidates(candidates: Array<{ edge: RelationshipEdge; score: number }>): RelationshipEdge[] {
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


export function findRelatedGraphTableEdges(symbolEdges: RelationshipEdge[], graph: RelationshipEdge[]): RelationshipEdge[] {
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


export function receiverMatchesDefinition(receiverSymbol: string | undefined, definitionEdge: RelationshipEdge): boolean {
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


export function findGraphHandlerDefinitions(handlerEdge: RelationshipEdge, graph: RelationshipEdge[]): RelationshipEdge[] {
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


export async function describeGraphSymbolEdges(edges: RelationshipEdge[]): Promise<string[]> {
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


export function findGraphSymbolDefinitions(symbolName: string, graph: RelationshipEdge[], excludedRepos: string[] = [], receiverSymbol?: string): RelationshipEdge[] {
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


export function findCallsFromSymbols(
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


export async function resolveGraphPath(entry: RelationshipEdge, scopedGraph: RelationshipEdge[]): Promise<GraphPathDetails> {
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


export function formatGraphPathDetails(pathDetails: GraphPathDetails, index: number): string {
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


export async function buildGraphFlowAnswer(question: string, graph: RelationshipEdge[]): Promise<GraphFlowAnswer | undefined> {
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


export function discoverGraphRouteAnchors(question: string, graph: RelationshipEdge[]): string[] {
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
