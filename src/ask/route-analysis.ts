// Route Analysis
// Refactored from ask.ts — uses ctx for shared state

import { bm25Search } from "../lib/bm25-index.js"
import { config } from "../lib/config.js"
import type { HandlerRef, MethodWindow, RetrievedChunk, RetrievedPayload, RouteDefinition } from "./types.js"
import path from "node:path"
import { ctx } from "./context.js"
import { buildFilter } from "./filter.js"
import { retrieveChunksByIds } from "./retrieve.js"
import { escapeRegExp, extractConceptTokens, questionAsksAboutServicesOrFlow, unique } from "./question.js"

export function registryExactSearchTerms(): string[] {
  const noisyTerms = new Set(["api", "broker", "domain", "concept", "service"])

  return unique(
    ctx.registryExpansion.terms
      .filter(term => term.length >= 3)
      .filter(term => !noisyTerms.has(term.toLowerCase()))
      .filter(term => !/^ims-/.test(term.toLowerCase()))
      .filter(term => !/^tf2-/.test(term.toLowerCase())),
    24,
  )
}


export function containsExactIdentifier(content: string, identifier: string): boolean {
  return new RegExp(`\\b${escapeRegExp(identifier)}\\b`).test(content)
}


export function normalizeRoute(route: string): string {
  const normalized = route.trim().replace(/\/+$/, "")

  return normalized.length > 0 ? normalized.toLowerCase() : "/"
}


export function routeMatches(candidate: string, wantedRoute: string): boolean {
  const candidateRoute = normalizeRoute(candidate)
  const wanted = normalizeRoute(wantedRoute)

  return candidateRoute === wanted
}


export function contentContainsRoute(content: string, wantedRoute: string): boolean {
  const wanted = normalizeRoute(wantedRoute)
  const quotedRoutes = [...content.matchAll(/["'`](\/[A-Za-z0-9_./:{}-]+)["'`]/g)].map(match => match[1] ?? "")

  return quotedRoutes.some(route => normalizeRoute(route) === wanted)
}


export function routeMatchesConceptTokens(route: string | undefined, tokens: string[]): boolean {
  if (!route || tokens.length === 0) return false

  const routeText = route.toLowerCase()

  return tokens.every(token => routeText.includes(token))
}


export function metadataTextForConceptSearch(payload: RetrievedPayload): string {
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


export function scoreConceptAnchor(payload: RetrievedPayload, tokens: string[]): number {
  const metadataText = metadataTextForConceptSearch(payload).toLowerCase()

  if (tokens.length === 0 || !tokens.every(token => metadataText.includes(token))) return 0

  let score = tokens.length

  if ((payload.routes?.length ?? 0) > 0) score += 8
  if ((payload.symbols?.length ?? 0) > 0) score += 3
  if (payload.filePath?.includes("config")) score += 2
  if (payload.filePath?.includes("route")) score += 2

  return score
}


export async function discoverConceptRouteAnchors(question: string): Promise<string[]> {
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


export function textForExactSearch(payload: RetrievedPayload): string {
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


export function scoreExactTermMatch(payload: RetrievedPayload, terms: string[]): number {
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

  // Boost chunks that contain multi-word phrases from the ctx.question
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

  // Boost vocabulary/glossary chunks when ctx.question contains defined terms
  if (filePath.startsWith("vocabulary://")) {
    const definedTerms = (payload.symbols ?? []).map(s => s.toLowerCase())
    const matchingTerms = terms.filter(term => definedTerms.includes(term.toLowerCase()))

    if (matchingTerms.length > 0) {
      score += 25 + matchingTerms.length * 5
    }
  }

  return score
}


export function extractRouteHandlerRefs(chunks: RetrievedChunk[]): HandlerRef[] {
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


export function extractExactRouteHandlerRefs(chunks: RetrievedChunk[], routes: string[]): HandlerRef[] {
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


export function parseRequireAliases(content: string, routeFilePath: string): Map<string, string> {
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


export function extractRpcAndCallTerms(chunks: RetrievedChunk[]): string[] {
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


export function extractRpcFuncNames(chunks: RetrievedChunk[]): string[] {
  return unique(
    chunks.flatMap(chunk => {
      const content = chunk.payload.content ?? ""

      return [...content.matchAll(/\bfunc\s*:\s*["'`]([^"'`]+)["'`]/g)].map(match => match[1] ?? "")
    }),
    12,
  )
}


export function extractRouteDefinitions(chunks: RetrievedChunk[], routes: string[]): string[] {
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


export function extractRouteDefinitionsForSymbol(content: string, symbolName: string): RouteDefinition[] {
  const definitions: RouteDefinition[] = []

  for (const match of content.matchAll(/\{[\s\S]*?method\s*:\s*\[[\s\S]*?url\s*:\s*["'`]\/[^"'`]+["'`][\s\S]*?handler\s*:\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+[\s\S]*?\}/g)) {
    const parsed = parseRouteDefinition(match[0])

    if (parsed?.handler.split(".").at(-1) === symbolName) {
      definitions.push(parsed)
    }
  }

  return definitions
}


export function extractPhpConstantRoutes(content: string): Array<{ name: string; route: string; expression: string }> {
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


export function extractPhpConstantNamesForRoutes(chunks: RetrievedChunk[], routes: string[]): string[] {
  return unique(
    chunks.flatMap(chunk => {
      return extractPhpConstantRoutes(chunk.payload.content ?? "")
        .filter(constantRoute => routes.some(route => routeMatches(constantRoute.route, route)))
        .map(constantRoute => constantRoute.name)
    }),
    16,
  )
}


export function parseRouteDefinition(definition: string): RouteDefinition | undefined {
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


export function orderRouteDefinitions(routeDefinitions: string[], routes: string[]): string[] {
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


export function isExactRouteComparisonQuestion(question: string): boolean {
  const lower = question.toLowerCase()

  return lower.includes("different") || lower.includes("difference") || lower.includes("compare")
}


export function buildExactRouteComparisonAnswer(
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


export function buildExactEndpointDetailAnswer(
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


export function extractDownstreamRpcFacts(chunks: RetrievedChunk[], handlerRepoNames: string[]): string[] {
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


export function buildLineMap(fileChunks: RetrievedChunk[]): Map<number, string> {
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


export function findMethodWindow(fileChunks: RetrievedChunk[], methodName: string, maxLines = 120): MethodWindow | undefined {
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


export function extractRpcFuncNamesFromFacts(facts: string[]): string[] {
  return unique(
    facts.flatMap(fact => {
      const match = fact.match(/rpc func values:\s*([^;]+)/)

      if (!match?.[1]) return []

      return match[1].split(",").map(value => value.trim())
    }),
    16,
  )
}


export function extractGenericDownstreamRpcFacts(
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


export function extractHandlerFactSummary(
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


export function extractEndpointHandlerFacts(
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


export function extractUpstreamRouteCallerFacts(chunks: RetrievedChunk[], constantNames: string[]): string[] {
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
