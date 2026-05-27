import path from "node:path"
import { Command } from "commander"
import { qdrant } from "./lib/qdrant.js"
import { config } from "./lib/config.js"
import { createEmbedding, chat } from "./lib/ollama.js"
import { readRelationshipGraph } from "./lib/graph.js"
import type { RelationshipEdge } from "./lib/graph.js"
import type { EvidenceType } from "./lib/evidence.js"
import type { RelationshipHints } from "./lib/relationships.js"
import type { ServiceType } from "./lib/chunker.js"

type RetrievedPayload = {
  repoName?: string
  serviceType?: ServiceType
  branchName?: string
  commitSha?: string
  filePath?: string
  startLine?: number
  endLine?: number
  content?: string
  evidenceTypes?: EvidenceType[]
  routes?: string[]
  symbols?: string[]
  messageNames?: string[]
  queueNames?: string[]
  exchangeNames?: string[]
  dbTables?: string[]
  contentHash?: string
}

type RetrievedChunk = {
  id: string
  payload: RetrievedPayload
}

type SearchFilter = ReturnType<typeof buildFilter>

type HandlerRef = {
  objectName: string
  methodName: string
  fullName: string
}

type RouteDefinition = {
  method: string
  alias: string
  url: string
  handler: string
}

type MethodWindow = {
  content: string
  firstChunk: RetrievedPayload | undefined
  lastChunk: RetrievedPayload | undefined
  startLine: number
  endLine: number
}

type GraphFlowAnswer = {
  answer: string
  sources: RelationshipEdge[]
}

const serviceTypes = new Set<ServiceType>(["api", "worker", "cron", "library", "unknown"])

const program = new Command()

program
  .argument("<question...>", "Question to ask")
  .option("--limit <limit>", "Number of chunks to retrieve", "8")
  .option("--repo-name <repoName>", "Only search one indexed repository")
  .option("--branch <branchName>", "Only search one indexed branch")
  .option("--service-type <serviceType>", "Only search one service type")
  .parse()

const question = program.args.join(" ")
const options = program.opts<{ limit: string; repoName?: string; branch?: string; serviceType?: string }>()
const limit = Number(options.limit)
const serviceType = options.serviceType && serviceTypes.has(options.serviceType as ServiceType)
  ? (options.serviceType as ServiceType)
  : undefined

function buildFilter() {
  const must = []

  if (options.repoName) {
    must.push({
      key: "repoName",
      match: {
        value: options.repoName,
      },
    })
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

  return must.length > 0 ? { must } : undefined
}

async function retrieve(queryText: string, resultLimit: number): Promise<RetrievedChunk[]> {
  const questionVector = await createEmbedding(queryText)
  const filter = buildFilter()
  const query = {
    query: questionVector,
    limit: resultLimit,
    with_payload: true,
    ...(filter ? { filter } : {}),
  }

  const results = await qdrant.query(config.collectionName, query)

  return results.points
    .map(point => ({
      id: String(point.id),
      payload: point.payload as RetrievedPayload,
    }))
    .filter(chunk => chunk.payload.content)
}

function unique(values: string[], max = 12): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].slice(0, max)
}

function shouldAnswerIndonesian(question: string): boolean {
  return /\b(apa|apakah|bagaimana|gimana|kenapa|mengapa|jelasin|jelaskan|terangkan|beda|bedanya|perbedaan|yang|dan|atau|dari|untuk|dengan|di|ke|validasi|validasinya|returnnya|servis|layanan|tabel|database|alur|endpointnya|bodynya)\b/i.test(question)
}

function localizeAnswer(answer: string, question: string): string {
  if (!shouldAnswerIndonesian(question)) return answer

  const replacements: Array<[RegExp, string]> = [
    [/Endpoint definition found in/g, "Definisi endpoint ditemukan di"],
    [/Exact symbol evidence found for:/g, "Evidence symbol persis ditemukan untuk:"],
    [/Graph flow found from relationship index:/g, "Flow graph ditemukan dari relationship index:"],
    [/Confirmed path:/g, "Path yang terkonfirmasi:"],
    [/Endpoint handlers:/g, "Handler endpoint:"],
    [/Handler behavior:/g, "Behavior handler:"],
    [/RPC calls from handlers:/g, "Call RPC dari handler:"],
    [/External calls from handlers:/g, "Call eksternal dari handler:"],
    [/Downstream handlers for external\/API funcs:/g, "Handler downstream untuk func API eksternal:"],
    [/Downstream handler behavior:/g, "Behavior handler downstream:"],
    [/Model\/symbol calls inside downstream handlers:/g, "Call model/symbol di dalam handler downstream:"],
    [/Model\/symbol behavior:/g, "Behavior model/symbol:"],
    [/Downstream RPC symbols:/g, "Symbol RPC downstream:"],
    [/Database\/table touches near downstream symbols:/g, "Touch database/tabel di sekitar symbol downstream:"],
    [/Confirmed facts:/g, "Fakta yang terkonfirmasi:"],
    [/referenced by route in/g, "direferensikan oleh route di"],
    [/referenced by route block in/g, "direferensikan oleh block route di"],
    [/Services\/repos involved:/g, "Service/repo yang terlibat:"],
    [/Upstream callers:/g, "Caller upstream:"],
    [/Request body:/g, "Request body:"],
    [/API-layer validation and payload behavior:/g, "Validasi layer API dan perilaku payload:"],
    [/Database\/table effects:/g, "Efek database/tabel:"],
    [/Downstream RPC\/model behavior:/g, "Perilaku RPC/model downstream:"],
    [/Return:/g, "Return:"],
    [/Evidence:/g, "Evidence:"],
    [/What is still missing:/g, "Yang masih belum ada:"],
    [/Retrieved repos\/services with matching evidence:/g, "Repo/service yang ditemukan dari evidence:"],
    [/Confirmed routes in retrieved evidence:/g, "Route yang terkonfirmasi di evidence:"],
    [/Confirmed message\/queue evidence:/g, "Evidence message/queue yang terkonfirmasi:"],
    [/Database\/table evidence:/g, "Evidence database/tabel:"],
    [/Table evidence sources:/g, "Source evidence tabel:"],
    [/Retrieved source set:/g, "Source yang ter-retrieve:"],
    [/The important difference is in the handler behavior, not only the URL version\./g, "Perbedaan pentingnya ada di behavior handler, bukan hanya versi URL."],
    [/Behavioral differences:/g, "Perbedaan behavior:"],
    [/Return behavior:/g, "Behavior return:"],
    [/Handler details found:/g, "Detail handler yang ditemukan:"],
    [/Downstream RPC details found:/g, "Detail RPC downstream yang ditemukan:"],
    [/method:/g, "method:"],
    [/alias:/g, "alias:"],
    [/handler:/g, "handler:"],
    [/body fields:/g, "field body:"],
    [/rpc func values:/g, "nilai func RPC:"],
    [/external API func values:/g, "nilai func API eksternal:"],
    [/required fields\/checks:/g, "field/check wajib:"],
    [/calls:/g, "memanggil:"],
    [/tables:/g, "tabel:"],
    [/validation\/auth:/g, "validasi/auth:"],
    [/extra payload:/g, "payload tambahan:"],
    [/return:/g, "return:"],
    [/verifies JWT/g, "memverifikasi JWT"],
    [/checks JWT user-agent against request user-agent/g, "mengecek user-agent JWT terhadap user-agent request"],
    [/requires authenticated userid >= 1/g, "mewajibkan userid terautentikasi >= 1"],
    [/throws on request\.validationError/g, "throw jika ada request.validationError"],
    [/looks up mapped MRG account for userid/g, "mencari mapping akun MRG untuk userid"],
    [/throws MRG_ACCOUNT_NOT_FOUND when mapped MRG account is missing/g, "throw MRG_ACCOUNT_NOT_FOUND jika mapping akun MRG tidak ada"],
    [/adds user_id from mapped mrguser\.mrgid/g, "menambahkan user_id dari mrguser.mrgid yang sudah ter-mapping"],
    [/adds ip from x-forwarded-for or remoteAddress/g, "menambahkan ip dari x-forwarded-for atau remoteAddress"],
    [/adds browser from user-agent header/g, "menambahkan browser dari header user-agent"],
    [/calls RPC func:/g, "memanggil func RPC:"],
    [/calls MRGAccountRpc\.send/g, "memanggil MRGAccountRpc.send"],
    [/uses Joi schema validation/g, "menggunakan validasi schema Joi"],
    [/requires positive integer login/g, "mewajibkan login integer positif"],
    [/requires nominal integer from 1 to 9999999/g, "mewajibkan nominal integer dari 1 sampai 9999999"],
    [/requires metaserver_id 1 or 2/g, "mewajibkan metaserver_id 1 atau 2"],
    [/requires integer user_id/g, "mewajibkan user_id integer"],
    [/checks users_demoid for matching demo account/g, "mengecek users_demoid untuk akun demo yang cocok"],
    [/checks users_demoid/g, "mengecek users_demoid"],
    [/writes to deposit_demo/g, "menulis ke deposit_demo"],
    [/creates deposit_demo row with status 0/g, "membuat row deposit_demo dengan status 0"],
    [/calls demo balance RPC/g, "memanggil RPC balance demo"],
    [/uses MT4 demo balance flow when metaserver_id is 1/g, "memakai flow balance demo MT4 ketika metaserver_id = 1"],
    [/uses MT5 demo balance flow when metaserver_id is 2/g, "memakai flow balance demo MT5 ketika metaserver_id = 2"],
    [/returns true on success/g, "mengembalikan true saat sukses"],
    [/marks deposit_demo status 1 on success/g, "menandai deposit_demo status 1 saat sukses"],
    [/marks deposit_demo status 2 on failure/g, "menandai deposit_demo status 2 saat gagal"],
    [/delegates to demoModel\.SubmitDepositDemo/g, "mendelegasikan ke demoModel.SubmitDepositDemo"],
    [/initial result is/g, "nilai awal result adalah"],
    [/sets result\.message from RPC res\.message/g, "mengisi result.message dari RPC res.message"],
    [/returns result/g, "mengembalikan result"],
    [/downstream model returns true on success before the API returns RPC res\.message/g, "model downstream mengembalikan true saat sukses sebelum API mengembalikan RPC res.message"],
    [/before the API returns RPC res\.message/g, "sebelum API mengembalikan RPC res.message"],
    [/I do not have an exact route\/function anchor for this question, so this is an evidence-only retrieval summary, not a confirmed end-to-end flow\./g, "Saya tidak punya anchor route/function yang persis untuk pertanyaan ini, jadi ini hanya ringkasan retrieval berbasis evidence, bukan flow end-to-end yang terkonfirmasi."],
    [/An exact endpoint, function name, queue name, or RPC func is needed to confirm a full service-to-service flow\./g, "Perlu endpoint, nama function, queue name, atau func RPC yang persis untuk mengonfirmasi flow service-to-service penuh."],
    [/Retrieved repos\/files alone are not proof that every listed repo participates in the same runtime path\./g, "Repo/file yang ter-retrieve saja belum membuktikan semua repo tersebut ikut dalam runtime path yang sama."],
    [/This answer only uses chunks that exactly mention the named symbol plus nearby chunks\./g, "Jawaban ini hanya memakai chunk yang menyebut symbol tersebut secara persis plus chunk di sekitarnya."],
    [/If you need the full runtime flow, ask with the endpoint path, queue name, or RPC func and include what detail you want\./g, "Kalau butuh runtime flow penuh, tanyakan dengan path endpoint, queue name, atau func RPC dan sertakan detail yang kamu mau."],
    [/No upstream caller was extracted from the retrieved context\./g, "Tidak ada caller upstream yang berhasil diekstrak dari context yang ter-retrieve."],
    [/No database\/table effect was extracted\./g, "Tidak ada efek database\/tabel yang berhasil diekstrak."],
  ]

  return replacements.reduce((localized, [pattern, replacement]) => localized.replace(pattern, replacement), answer)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
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

function extractQuestionHints(question: string): string[] {
  return unique([
    ...[...question.matchAll(/\/[A-Za-z0-9_./:{}-]+/g)].map(match => match[0]),
    ...[...question.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*\b/g)].map(match => match[0]),
    ...[...question.matchAll(/\b[A-Z][A-Za-z0-9_]{2,}\b/g)]
      .map(match => match[0])
      .filter(value => !["What", "When", "Where", "Which", "How", "Does"].includes(value)),
    ...[...question.matchAll(/["'`]([^"'`]{2,80})["'`]/g)].map(match => match[1] ?? ""),
  ])
}

function extractQuestionRoutes(question: string): string[] {
  return unique(
    [...question.matchAll(/\/[A-Za-z0-9_./:{}-]+/g)].map(match => match[0]),
    10,
  )
}

function extractConceptTokens(question: string): string[] {
  const stopWords = new Set([
    "apa",
    "apakah",
    "bagaimana",
    "gimana",
    "jelasin",
    "jelaskan",
    "flow",
    "alur",
    "dari",
    "yang",
    "dan",
    "atau",
    "ke",
    "di",
    "the",
    "what",
    "which",
    "how",
    "explain",
    "describe",
    "show",
    "tell",
    "from",
    "to",
    "in",
    "of",
    "repo",
    "service",
    "ims",
    "tf",
    "tf2",
  ])

  const aliases = new Map([
    ["deemo", "demo"],
    ["demos", "demo"],
    ["demoaccount", "demo"],
    ["acct", "account"],
    ["accounts", "account"],
    ["requests", "request"],
  ])

  return unique(
    question
      .toLowerCase()
      .split(/[^a-z0-9_]+/g)
      .map(token => token.trim())
      .map(token => aliases.get(token) ?? token)
      .filter(token => token.length >= 3)
      .filter(token => !stopWords.has(token)),
    8,
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

function mentionedGraphRepos(question: string, graph: RelationshipEdge[]): string[] {
  const lower = question.toLowerCase()
  const repos = unique(graph.map(edge => edge.repoName), 100)
  const mentioned = repos.filter(repo => lower.includes(repo.toLowerCase()))

  return options.repoName ? unique([options.repoName, ...mentioned], 100) : mentioned
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
  if (edge.viaConstant) score += 3

  return score
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

async function buildGraphFlowAnswer(question: string, graph: RelationshipEdge[]): Promise<GraphFlowAnswer | undefined> {
  if (!questionAsksAboutServicesOrFlow(question) || graph.length === 0) return undefined

  const tokens = extractConceptTokens(question)

  if (tokens.length < 2) return undefined

  const scopedGraph = graph.filter(graphScopeAllows)
  const mentionedRepos = mentionedGraphRepos(question, scopedGraph)
  const candidateCalls = scopedGraph
    .filter(edge => edge.type === "CALLS_HTTP_ENDPOINT")
    .map(edge => ({
      edge,
      score: scoreGraphCallEdge(edge, tokens, mentionedRepos, question),
    }))
    .filter(candidate => candidate.score >= 35)
    .sort((left, right) => right.score - left.score)

  const selectedCall = candidateCalls[0]?.edge

  if (!selectedCall?.toRoute) return undefined

  const endpointHandlers = scopedGraph
    .filter(edge => edge.type === "HANDLES_HTTP_ENDPOINT" && edge.toRoute && routeMatches(edge.toRoute, selectedCall.toRoute ?? ""))
    .sort((left, right) => {
      const leftScore = left.repoName === selectedCall.repoName ? -1 : 0
      const rightScore = right.repoName === selectedCall.repoName ? -1 : 0

      return rightScore - leftScore
    })
    .slice(0, 6)
  const handlerNames = unique(endpointHandlers.flatMap(edge => [handlerMethodName(edge.handler) ?? "", edge.symbol ?? ""]), 12)
  const handlerDefinitionEdges = endpointHandlers.flatMap(edge => findGraphHandlerDefinitions(edge, scopedGraph)).slice(0, 8)
  const handlerDefinitionNames = unique(handlerDefinitionEdges.map(edge => edge.symbol ?? ""), 12)
  const handlerFacts = await describeGraphSymbolEdges(handlerDefinitionEdges)
  const rpcCalls = scopedGraph
    .filter(edge => {
      if (edge.type !== "CALLS_RPC_FUNC" || !edge.rpcFunc) return false
      if (handlerNames.length === 0 && handlerDefinitionNames.length === 0) return false

      return Boolean(edge.fromSymbol && [...handlerNames, ...handlerDefinitionNames].includes(edge.fromSymbol))
    })
    .slice(0, 12)
  const externalCalls = scopedGraph
    .filter(edge => {
      if (edge.type !== "CALLS_EXTERNAL_FUNC" || !edge.externalFunc) return false

      return Boolean(edge.fromSymbol && [...handlerNames, ...handlerDefinitionNames].includes(edge.fromSymbol))
    })
    .slice(0, 12)
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
  const reposInvolved = unique(
    [selectedCall, ...endpointHandlers, ...rpcCalls, ...externalCalls, ...downstreamExternalSymbols, ...downstreamSymbolCalls, ...downstreamModelDefinitions, ...downstreamSymbols, ...tableEdges].map(edge => {
      return `${edge.repoName}@${edge.branchName || "unknown"} [${edge.serviceType}]`
    }),
    16,
  )
  const sources = [...new Map([selectedCall, ...endpointHandlers, ...handlerDefinitionEdges, ...rpcCalls, ...externalCalls, ...downstreamExternalSymbols, ...downstreamSymbolCalls, ...downstreamModelDefinitions, ...downstreamSymbols, ...tableEdges].map(edge => [edge.id, edge])).values()]

  const answer = [
    "Graph flow found from relationship index:",
    "",
    "Confirmed path:",
    `- ${edgeSource(selectedCall)} calls ${selectedCall.toRoute}${selectedCall.viaConstant ? ` via ${selectedCall.viaConstant}` : ""}${selectedCall.fromSymbol ? ` from ${selectedCall.fromSymbol}` : ""}`,
    endpointHandlers.length > 0 ? endpointHandlers.map(edge => `- ${edgeSource(edge)} handles ${edge.toRoute}; method: ${edge.httpMethod || "unknown"}; alias: ${edge.alias || "unknown"}; handler: ${edge.handler || "unknown"}`).join("\n") : "- No matching endpoint handler was found in the relationship index.",
    "",
    "Services/repos involved:",
    reposInvolved.length > 0 ? reposInvolved.map(repo => `- ${repo}`).join("\n") : "- NOT_FOUND_IN_INDEXED_CODEBASE",
    "",
    "Endpoint handlers:",
    endpointHandlers.length > 0
      ? endpointHandlers.map(edge => `- ${edge.handler || edge.symbol || "unknown"} in ${edgeSource(edge)}`).join("\n")
      : "- No endpoint handler was found.",
    "",
    "Handler behavior:",
    handlerFacts.length > 0
      ? handlerFacts.map(fact => `- ${fact}`).join("\n")
      : "- No controller method body was resolved for the endpoint handler.",
    "",
    "RPC calls from handlers:",
    rpcCalls.length > 0
      ? rpcCalls.map(edge => `- ${edge.fromSymbol || "unknown"} calls RPC func ${edge.rpcFunc} in ${edgeSource(edge)}`).join("\n")
      : "- No RPC call was extracted from the endpoint handler.",
    "",
    "External calls from handlers:",
    externalCalls.length > 0
      ? externalCalls.map(edge => `- ${edge.fromSymbol || "unknown"} calls ${edge.externalFunc} in ${edgeSource(edge)}`).join("\n")
      : "- No external API/client call was extracted from the endpoint handler.",
    "",
    "Downstream handlers for external/API funcs:",
    downstreamExternalSymbols.length > 0
      ? downstreamExternalSymbols.map(edge => `- ${edge.symbol} in ${edgeSource(edge)}`).join("\n")
      : "- No downstream function with the same external/API func name was found.",
    "",
    "Downstream handler behavior:",
    downstreamExternalFacts.length > 0
      ? downstreamExternalFacts.map(fact => `- ${fact}`).join("\n")
      : "- No downstream handler body was resolved.",
    "",
    "Model/symbol calls inside downstream handlers:",
    downstreamSymbolCalls.length > 0
      ? downstreamSymbolCalls.map(edge => `- ${edge.fromSymbol || "unknown"} calls ${edge.receiverSymbol}.${edge.calleeSymbol} in ${edgeSource(edge)}`).join("\n")
      : "- No model/symbol calls were extracted inside downstream handlers.",
    "",
    "Model/symbol behavior:",
    downstreamModelFacts.length > 0
      ? downstreamModelFacts.map(fact => `- ${fact}`).join("\n")
      : "- No called model/symbol body was resolved.",
    "",
    "Downstream RPC symbols:",
    downstreamSymbols.length > 0
      ? downstreamSymbols.map(edge => `- ${edge.symbol} in ${edgeSource(edge)}`).join("\n")
      : "- No downstream repo symbol with the same RPC func name was found.",
    "",
    "Database/table touches near downstream symbols:",
    tableEdges.length > 0
      ? tableEdges.map(edge => `- ${edge.table} in ${edgeSource(edge)}`).join("\n")
      : "- No database/table touch was extracted near downstream symbols.",
    "",
    "What is still missing:",
    "- Relationship graph edges prove code references and matching names; they do not prove runtime success paths or all conditional branches.",
    "- For return body and validation details, ask the exact endpoint after the graph identifies it.",
  ].join("\n")

  return { answer, sources }
}

async function retrieveExactRouteMatches(routes: string[]): Promise<RetrievedChunk[]> {
  if (routes.length === 0) return []

  const filter = buildFilter()
  const matches: RetrievedChunk[] = []
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

      const storedRoutes = payload.routes ?? []
      const hasMatch = routes.some(route => {
        return storedRoutes.some(storedRoute => routeMatches(storedRoute, route)) || contentContainsRoute(payload.content ?? "", route)
      })

      if (hasMatch) {
        matches.push({
          id: String(point.id),
          payload,
        })
      }
    }

    offset = page.next_page_offset
  } while (offset)

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

  const filter = buildFilter()
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

      const score = scoreConceptAnchor(payload, tokens)

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
  ].join("\n")
}

function scoreExactTermMatch(payload: RetrievedPayload, terms: string[]): number {
  const text = textForExactSearch(payload).toLowerCase()

  return terms.reduce((score, term) => {
    const normalizedTerm = term.toLowerCase()

    if (!normalizedTerm) return score
    if (payload.symbols?.some(symbol => symbol.toLowerCase() === normalizedTerm)) return score + 5
    if (payload.messageNames?.some(messageName => messageName.toLowerCase() === normalizedTerm)) return score + 5
    if (text.includes(normalizedTerm)) return score + 1

    return score
  }, 0)
}

async function retrieveExactTermMatches(terms: string[], maxMatches: number, filter: SearchFilter = buildFilter()): Promise<RetrievedChunk[]> {
  const exactTerms = unique(terms, 24)

  if (exactTerms.length === 0) return []

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

function chunkScopeFilter(chunk: RetrievedChunk) {
  const must = [
    {
      key: "repoName",
      match: {
        value: chunk.payload.repoName ?? "",
      },
    },
    {
      key: "branchName",
      match: {
        value: chunk.payload.branchName ?? "",
      },
    },
    {
      key: "filePath",
      match: {
        value: chunk.payload.filePath ?? "",
      },
    },
  ]

  return { must }
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

  return chunks.sort((left, right) => (left.payload.startLine ?? 0) - (right.payload.startLine ?? 0))
}

async function retrieveNeighborChunks(chunks: RetrievedChunk[], lineWindow = 90): Promise<RetrievedChunk[]> {
  const neighbors: RetrievedChunk[] = []

  for (const chunk of chunks) {
    if (!chunk.payload.repoName || !chunk.payload.branchName || !chunk.payload.filePath) continue

    let offset: string | number | Record<string, unknown> | null | undefined

    do {
      const page = await qdrant.scroll(config.collectionName, {
        filter: chunkScopeFilter(chunk),
        limit: 128,
        with_payload: true,
        with_vector: false,
        ...(offset ? { offset } : {}),
      })

      for (const point of page.points) {
        const payload = point.payload as RetrievedPayload | null | undefined

        if (!payload?.content || payload.startLine === undefined || payload.endLine === undefined) continue

        const nearStart = (chunk.payload.startLine ?? 0) - lineWindow
        const nearEnd = (chunk.payload.endLine ?? 0) + lineWindow

        if (payload.endLine >= nearStart && payload.startLine <= nearEnd) {
          neighbors.push({
            id: String(point.id),
            payload,
          })
        }
      }

      offset = page.next_page_offset
    } while (offset)
  }

  return neighbors
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

  const source =
    chunks.find(chunk => {
      const content = chunk.content ?? ""

      return contentContainsRoute(content, definition.url) && content.includes(definition.handler)
    }) ?? chunks[0]
  const lines = source ? `${source.filePath}:${source.startLine}-${source.endLine}` : "unknown"
  const bodyFields = unique(
    endpointFacts.flatMap(fact => {
      const match = fact.match(/body fields:\s*([^;]+)/)

      return match?.[1] ? match[1].split(",").map(value => value.trim()) : []
    }),
    12,
  )
  const rpcFunctions = extractRpcFuncNamesFromFacts(endpointFacts)
  const validationFacts = unique(
    endpointFacts.flatMap(fact => {
      const match = fact.match(/validation\/auth:\s*([^;]+)/)

      return match?.[1] ? match[1].split(",").map(value => value.trim()) : []
    }),
    12,
  )
  const extraPayload = unique(
    endpointFacts.flatMap(fact => {
      const match = fact.match(/extra payload:\s*([^;]+)/)

      return match?.[1] ? match[1].split(",").map(value => value.trim()) : []
    }),
    12,
  )
  const returnFacts = unique(
    endpointFacts.flatMap(fact => {
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
    [...endpointFacts, ...downstreamFacts].flatMap(fact => {
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
    endpointFacts.length > 0 ? endpointFacts.map(fact => `- ${fact}`).join("\n") : "- No handler facts were extracted.",
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
  const downstreamNeighborChunks = await retrieveNeighborChunks(downstreamFuncChunks, 70)
  const downstreamRpcChunks = rpcChunks.filter(chunk => !originRepos.has(chunk.payload.repoName))
  const localRpcChunks = rpcChunks.filter(chunk => originRepos.has(chunk.payload.repoName))

  return [
    ...handlerChunks,
    ...phpConstantChunks.slice(0, 12),
    ...phpConstantNeighborChunks.slice(0, 12),
    ...downstreamFuncChunks.slice(0, 12),
    ...downstreamNeighborChunks.slice(0, 12),
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
  ].some(keyword => lower.includes(keyword))
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
  const byKey = new Map<string, RetrievedChunk>()

  for (const chunk of chunks) {
    const key = chunk.payload.contentHash ?? chunk.id

    if (!byKey.has(key)) {
      byKey.set(key, chunk)
    }
  }

  return [...byKey.values()].slice(0, maxResults)
}

function filterEndpointSourceChunks(
  chunks: RetrievedChunk[],
  routes: string[],
  handlerRefs: HandlerRef[],
  rpcFuncNames: string[],
  extraTerms: string[] = [],
): RetrievedChunk[] {
  const handlerNames = new Set(handlerRefs.map(ref => ref.methodName))
  const rpcNames = new Set(rpcFuncNames)
  const terms = new Set(extraTerms)
  const filtered = chunks.filter(chunk => {
    const content = chunk.payload.content ?? ""
    const hasRoute = routes.some(route => contentContainsRoute(content, route))
    const hasHandler = [...handlerNames].some(handlerName => content.includes(handlerName))
    const hasRpcFunc = [...rpcNames].some(rpcFuncName => content.includes(rpcFuncName))
    const hasExtraTerm = [...terms].some(term => content.includes(term))

    return hasRoute || hasHandler || hasRpcFunc || hasExtraTerm
  })

  return mergeChunks(filtered, 14)
}

function questionAsksAboutDatabase(question: string): boolean {
  return /\b(database|databases|table|tables|sql|affected|insert|update|delete|select)\b/i.test(question)
}

function questionAsksAboutServicesOrFlow(question: string): boolean {
  return /\b(service|services|repo|repos|flow|involved|calls?|publishes?|consumes?|rpc|amqp|rabbitmq|queue|exchange)\b/i.test(question)
}

function extractSqlTableNamesFromContent(content: string): string[] {
  return [
    ...[...content.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+[`"']?([A-Za-z_][\w.]*)[`"']?/gi)].map(match => match[1] ?? ""),
    ...[...content.matchAll(/\b(?:INSERT\s+INTO|DELETE\s+FROM)\s+[`"']?([A-Za-z_][\w.]*)[`"']?/gi)].map(match => match[1] ?? ""),
    ...[...content.matchAll(/\bsqlstr\.(?:insertObject|updateObject)\(\s*["'`]([A-Za-z_][\w.]*)["'`]/g)].map(match => match[1] ?? ""),
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
  ].join("\n")
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
  const questionRoutes = extractQuestionRoutes(question)

  if (questionRoutes.length === 0) {
    const graphFlowAnswer = await buildGraphFlowAnswer(question, await readRelationshipGraph())

    if (graphFlowAnswer) {
      console.log("\nANSWER\n")
      console.log(localizeAnswer(graphFlowAnswer.answer, question))

      console.log("\nSOURCES\n")

      for (const edge of graphFlowAnswer.sources) {
        console.log(`- ${edgeSource(edge)} (${edge.type})`)
      }

      return
    }
  }

  const conceptRoutes = questionRoutes.length === 0 ? await discoverConceptRouteAnchors(question) : []
  const exactRoutes = unique([...questionRoutes, ...conceptRoutes], 10)
  const exactChunks = await retrieveExactRouteMatches(exactRoutes)
  const questionHints = extractQuestionHints(question)
  const exactTermChunks = exactRoutes.length === 0 ? await retrieveExactTermMatches(questionHints, 24) : []
  const exactTermDetailChunks =
    exactRoutes.length === 0 && exactTermChunks.length > 0 ? await retrieveNeighborChunks(exactTermChunks, 70) : []
  const exactComparison = exactRoutes.length >= 2 && isExactRouteComparisonQuestion(question)
  const exactEndpointInspection =
    exactRoutes.length > 0 &&
    !exactComparison &&
    (shouldInspectExactEndpointDetails(question) || shouldExpandExactRouteQuestion(question) || conceptRoutes.length > 0)
  const exactHandlerRefs = extractExactRouteHandlerRefs(exactChunks, exactRoutes)
  const exactDetailChunks =
    exactChunks.length > 0
      ? await retrieveExactRouteDetails(
          exactChunks,
          exactHandlerRefs,
          exactComparison || exactEndpointInspection || shouldExpandExactRouteQuestion(question),
          exactRoutes,
        )
      : []
  const initialChunks = exactRoutes.length > 0 ? [] : await retrieve(question, limit)
  const hints = collectHints([...exactChunks, ...exactDetailChunks, ...exactTermChunks, ...exactTermDetailChunks, ...initialChunks])
  const expansionQueries =
    exactRoutes.length > 0 && exactChunks.length === 0
      ? []
      : exactRoutes.length > 0 && !shouldExpandExactRouteQuestion(question)
        ? []
      : shouldExpandRetrieval(question, hints)
        ? buildExpansionQueries(question, hints)
        : []
  const expandedChunks = []

  for (const expansionQuery of expansionQueries) {
    expandedChunks.push(...await retrieve(expansionQuery, Math.max(3, Math.ceil(limit / 2))))
  }

  const retrievedChunks = mergeChunks(
    [...exactChunks, ...exactDetailChunks, ...exactTermChunks, ...exactTermDetailChunks, ...initialChunks, ...expandedChunks],
    exactRoutes.length > 0 ? Math.max(limit, 24) : Math.max(limit, 12),
  )
  const chunks = retrievedChunks.map(chunk => chunk.payload)
  const routeDefinitions = orderRouteDefinitions(extractRouteDefinitions(exactChunks, exactRoutes), exactRoutes)
  const exactRouteRepoNames = unique(exactChunks.map(chunk => chunk.payload.repoName ?? ""), 12)
  const handlerFacts = extractHandlerFactSummary(exactDetailChunks, exactHandlerRefs, exactRouteRepoNames)
  const endpointFacts = extractEndpointHandlerFacts(exactDetailChunks, exactHandlerRefs, exactRouteRepoNames)
  const endpointRpcFuncNames = extractRpcFuncNamesFromFacts(endpointFacts)
  const phpConstantNamesForExactRoutes = extractPhpConstantNamesForRoutes(exactChunks, exactRoutes)
  const upstreamFacts = extractUpstreamRouteCallerFacts(exactDetailChunks, phpConstantNamesForExactRoutes)
  const downstreamFacts = extractDownstreamRpcFacts(
    exactDetailChunks,
    exactRouteRepoNames,
  )
  const genericDownstreamFacts = extractGenericDownstreamRpcFacts(
    exactDetailChunks,
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

  if (deterministicExactAnswer || deterministicEndpointAnswer) {
    const sourceChunks = deterministicEndpointAnswer
      ? filterEndpointSourceChunks(
          retrievedChunks,
          exactRoutes,
          exactHandlerRefs,
          endpointRpcFuncNames,
          phpConstantNamesForExactRoutes,
        ).map(chunk => chunk.payload)
      : chunks

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
    const sourceChunks = mergeChunks([...exactTermChunks, ...exactTermDetailChunks], 16).map(chunk => chunk.payload)

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

  const structuralEvidenceAnswer =
    exactRoutes.length === 0 && (questionAsksAboutDatabase(question) || questionAsksAboutServicesOrFlow(question))
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

  const context = chunks
    .map((chunk, index) => {
      return [
        `SOURCE ${index + 1}`,
        `repo: ${chunk.repoName}`,
        `branch: ${chunk.branchName}`,
        `commit: ${chunk.commitSha}`,
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
  const evidenceInventory = buildEvidenceInventory(chunks, question)

  const prompt = [
    `Question: ${question}`,
    `Answer language: ${shouldAnswerIndonesian(question) ? "Indonesian/Bahasa Indonesia" : "same language as the question"}`,
    "",
    `Exact routes requested: ${exactRoutes.join(", ") || "none"}`,
    `Exact route matches found: ${exactChunks.length}`,
    `Handler/detail chunks found: ${exactDetailChunks.length}`,
    `Route handlers discovered: ${exactHandlerRefs.map(ref => ref.fullName).join(", ") || "none"}`,
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
    "Relevant context:",
    context,
    "",
    "Answer requirements:",
    "- Answer in the same language as the user's question. If the question is in Bahasa Indonesia, answer in Bahasa Indonesia while keeping code identifiers unchanged.",
    "- Answer from the context only.",
    "- If the question names exact routes or paths, prioritize sources whose content or route metadata exactly contains those paths.",
    "- Do not replace an exact route from the question with a different route unless explaining that the exact route was not found.",
    "- When comparing route definitions, compare method, alias, url, and handler exactly as written. Do not say handlers are the same if their names differ.",
    "- Do not say compared routes match exactly when their urls, aliases, or handlers differ.",
    "- Mention service/repo names, source file paths, and line ranges.",
    "- Mention branch names when they are present in source metadata.",
    "- If context is insufficient, say NOT_FOUND_IN_INDEXED_CODEBASE and explain what is missing.",
    "- Treat the Evidence inventory as a whitelist for service, route, message, queue, exchange, and database table names.",
    "- Do not infer database table names from domain words. Only name tables that appear in metadata, SQL, or quoted source context.",
    "- Do not infer service involvement from class/client names alone. A service/repo is confirmed only when it appears in source metadata or an explicit source says it calls/handles the same route/message/function.",
    "- Avoid words like likely, probably, might, or suggests for facts. Use 'not confirmed in retrieved context' instead.",
    "- If the evidence inventory says requested database/table evidence is not present, answer that the table impact is NOT_FOUND_IN_INDEXED_CODEBASE.",
    "- If the evidence inventory says requested service/flow evidence is not present, do not describe a flow; say what anchor was missing.",
    "- For cross-service flows, separate confirmed facts from guesses.",
    "- Prefer evidence from RabbitMQ handlers, API routes, cron jobs, database usage, and config files.",
    "- Mention queue, routing key, exchange, and database table names when present.",
    "- If a route calls a symbol/message and another service consumes or handles the same symbol/message, explain that link as confirmed only when both sides appear in sources.",
    "- Do not add architecture, database, deployment, or cross-service sections unless the question asks for them or the context directly supports them.",
    "- For general summary questions, do not mention cross-service flow unless the question explicitly asks about it.",
  ].join("\n")

  const answer = await chat(prompt)

  console.log("\nANSWER\n")
  console.log(localizeAnswer(answer, question))

  console.log("\nSOURCES\n")

  for (const chunk of chunks) {
    console.log(
      `- ${chunk.repoName}@${chunk.branchName ?? "unknown"} [${chunk.serviceType ?? "unknown"}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.evidenceTypes?.join(", ") ?? "unknown"})`,
    )
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
