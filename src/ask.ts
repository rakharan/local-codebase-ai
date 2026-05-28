import path from "node:path"
import { Command } from "commander"
import { qdrant } from "./lib/qdrant.js"
import { config } from "./lib/config.js"
import { createEmbedding, chat, detectPreferredLanguage } from "./lib/ollama.js"
import { readRelationshipGraph } from "./lib/graph.js"
import { buildRegistryPromptContext, expandQuestionWithRegistry } from "./lib/service-registry.js"
import type { AnswerLanguage } from "./lib/ollama.js"
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

type GraphPathDetails = {
  entry: RelationshipEdge
  endpointHandlers: RelationshipEdge[]
  handlerDefinitionEdges: RelationshipEdge[]
  handlerFacts: string[]
  rpcCalls: RelationshipEdge[]
  externalCalls: RelationshipEdge[]
  downstreamExternalSymbols: RelationshipEdge[]
  downstreamExternalFacts: string[]
  downstreamSymbolCalls: RelationshipEdge[]
  downstreamModelDefinitions: RelationshipEdge[]
  downstreamModelFacts: string[]
  downstreamSymbols: RelationshipEdge[]
  tableEdges: RelationshipEdge[]
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
  .option("--history <json>", "JSON string of previous conversation messages")
  .parse()

const question = program.args.join(" ")
const options = program.opts<{ limit: string; repoName?: string; branch?: string; serviceType?: string; history?: string }>()
const limit = Number(options.limit)
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
let answerLanguage: AnswerLanguage = "unknown"

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

function heuristicAnswerLanguage(question: string): AnswerLanguage {
  if (/\b(apa|apakah|bagaimana|gimana|kenapa|mengapa|jelasin|jelaskan|terangkan|berikan|daftar|tipe|jenis|akun|aturan|beda|bedanya|perbedaan|yang|dan|atau|dari|untuk|dengan|di|ke|validasi|validasinya|returnnya|servis|layanan|tabel|database|alur|endpointnya|bodynya)\b/i.test(question)) {
    return "id"
  }

  if (/\b(what|which|when|where|why|how|explain|describe|show|give|list|difference|return|validation|endpoint|service|database|table|flow)\b/i.test(question)) {
    return "en"
  }

  return "unknown"
}

async function detectAnswerLanguage(question: string): Promise<AnswerLanguage> {
  const heuristic = heuristicAnswerLanguage(question)
  const detected = await detectPreferredLanguage(question)

  if (detected === "unknown") return heuristic
  if (heuristic !== "unknown" && heuristic !== detected) return heuristic

  return detected
}

function shouldAnswerIndonesian(question: string): boolean {
  return answerLanguage === "id" || (answerLanguage === "unknown" && heuristicAnswerLanguage(question) === "id")
}

function answerLanguageLabel(question: string): string {
  const language = answerLanguage === "unknown" ? heuristicAnswerLanguage(question) : answerLanguage

  if (language === "id") return "Indonesian/Bahasa Indonesia"
  if (language === "en") return "English"

  return "same language as the question"
}

function localized(id: string, en: string): string {
  return shouldAnswerIndonesian(question) ? id : en
}

function localizeAnswer(answer: string, question: string): string {
  if (!shouldAnswerIndonesian(question)) return answer

  const replacements: Array<[RegExp, string]> = [
    [/Endpoint definition found in/g, "Definisi endpoint ditemukan di"],
    [/Exact symbol evidence found for:/g, "Evidence symbol persis ditemukan untuk:"],
    [/Graph flow found from relationship index:/g, "Flow graph ditemukan dari relationship index:"],
    [/Confirmed path:/g, "Path yang terkonfirmasi:"],
    [/Matching paths:/g, "Path yang cocok:"],
    [/Entry:/g, "Entry:"],
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
  const filePath = payload.filePath?.toLowerCase() ?? ""
  const repoName = payload.repoName?.toLowerCase() ?? ""

  let score = terms.reduce((currentScore, term) => {
    const normalizedTerm = term.toLowerCase()

    if (!normalizedTerm) return currentScore
    if (payload.symbols?.some(symbol => symbol.toLowerCase() === normalizedTerm)) return currentScore + 5
    if (payload.messageNames?.some(messageName => messageName.toLowerCase() === normalizedTerm)) return currentScore + 5
    if (text.includes(normalizedTerm)) return currentScore + 1

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

  return score
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

function questionAsksAboutGlossary(question: string): boolean {
  return /\b(apa itu|what is|maksud|meaning|glossary|glosarium|list|daftar|berikan|tipe akun|account type|aturan|rules?|platform_type|platform type|isignal)\b/i.test(question)
}

function questionAsksAboutAccountTypes(question: string): boolean {
  return /\b(tipe akun|jenis akun|account types?|account_type|accountTypes|accountTypesV2)\b/i.test(question)
}

function questionBrokerHint(question: string): "mrg" | "askap" | undefined {
  if (/\bmrg\b/i.test(question)) return "mrg"
  if (/\b(mmb|askap)\b/i.test(question)) return "askap"

  return undefined
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

function buildPlatformTypeGlossaryAnswer(chunks: RetrievedPayload[], question: string): string | undefined {
  if (!/\bplatform_type|platform type|tipe platform\b/i.test(question)) return undefined

  const facts: string[] = []
  const sources: string[] = []
  const accountTypeFacts = extractAccountTypeFacts(chunks, question)

  for (const fact of accountTypeFacts) {
    if (!fact.platformType || !fact.platformName) continue

    facts.push(localized(
      `Pada config accountTypesV2 MMB/Askap, platform_type ${fact.platformType} dipakai untuk ${fact.platformName}.`,
      `In MMB/Askap accountTypesV2 config, platform_type ${fact.platformType} is used for ${fact.platformName}.`,
    ))
    sources.push(fact.source)
  }

  for (const chunk of chunks) {
    const content = chunk.content ?? ""
    const source = `${chunk.repoName}@${chunk.branchName ?? "unknown"} ${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`

    if (!/platform_type|mt4DemoType|mt5DemoType|MetaTrader|MT4|MT5/i.test(content)) continue

    if (/platform_type\s*={0,2}=\s*0/.test(content) || /["']platform_type["']\s*:\s*0/.test(content)) {
      facts.push(localized(
        "platform_type 0 dipakai sebagai jalur MT4 di evidence yang ter-index.",
        "platform_type 0 is used as the MT4 path in indexed evidence.",
      ))
      sources.push(source)
    }

    if (/platform_type\s*={0,2}=\s*3/.test(content) || /["']platform_type["']\s*:\s*3/.test(content)) {
      facts.push(localized(
        "platform_type 3 dipakai sebagai jalur MT5 di evidence yang ter-index.",
        "platform_type 3 is used as the MT5 path in indexed evidence.",
      ))
      sources.push(source)
    }

    if (/platform_type\s*={0,2}=\s*5/.test(content) || /["']platform_type["']\s*:\s*5/.test(content)) {
      facts.push(localized(
        "platform_type 5 dipakai sebagai jalur MT5 di evidence yang ter-index.",
        "platform_type 5 is used as the MT5 path in indexed evidence.",
      ))
      sources.push(source)
    }

    if (/platform_type\s*:\s*Joi\.number\(\)\.required/.test(content)) {
      facts.push(localized(
        "platform_type divalidasi sebagai number wajib pada handler/model downstream.",
        "platform_type is validated as a required number in the downstream handler/model.",
      ))
      sources.push(source)
    }

    if (/platform_type\s*:\s*request\.body\.platform_type/.test(content)) {
      facts.push(localized(
        "platform_type diterima dari request body lalu diteruskan ke payload downstream.",
        "platform_type is received from the request body and forwarded into the downstream payload.",
      ))
      sources.push(source)
    }

    if (/platform_type\s*:\s*data\.platform_type/.test(content)) {
      facts.push(localized(
        "platform_type dari data downstream diteruskan ke pembuatan akun demo.",
        "platform_type from downstream data is forwarded into demo account creation.",
      ))
      sources.push(source)
    }
  }

  const uniqueFacts = unique(facts, 12)
  const uniqueSources = unique(sources, 8)

  if (uniqueFacts.length === 0) return undefined

  return [
    localized("Fakta yang ditemukan tentang platform_type:", "Found facts about platform_type:"),
    uniqueFacts.map(fact => `- ${fact}`).join("\n"),
    "",
    localized("Catatan:", "Notes:"),
    localized(
      "- Mapping di atas hanya berdasarkan source yang ter-retrieve. Jika tiap broker punya mapping tambahan, index repo/dokumentasi broker tersebut lalu tanyakan lagi dengan nama broker spesifik.",
      "- This mapping is based only on retrieved sources. If each broker has additional mapping rules, index that broker's repo/docs and ask again with the broker name.",
    ),
    "",
    "Evidence:",
    uniqueSources.map(source => `- ${source}`).join("\n"),
  ].join("\n")
}

type AccountTypeFact = {
  name: string
  broker: "mrg" | "askap" | "unknown"
  id: string | undefined
  platformName: string | undefined
  platformType: string | undefined
  show: string | undefined
  groupCreation: string | undefined
  minFirstDepo: string | undefined
  leverage: string | undefined
  feature: string | undefined
  source: string
}

function inferAccountTypeBrokerFromSource(source: string): "mrg" | "askap" | "unknown" {
  const normalized = source.toLowerCase().replace(/\\/g, "/")

  if (normalized.includes("/components/askap/") || normalized.includes(" askap/")) return "askap"
  if (normalized.includes("/components/mrg/") || normalized.includes(" mrg/") || normalized.includes("mrg-accounts@")) return "mrg"

  return "unknown"
}

function accountTypeQuestionPlatform(question: string): "MT4" | "MT5" | undefined {
  if (/\bmt4\b/i.test(question)) return "MT4"
  if (/\bmt5\b/i.test(question)) return "MT5"

  return undefined
}

function objectBlocksFromContent(content: string): string[] {
  const blocks: string[] = []
  let current: string[] = []
  let depth = 0

  function braceDelta(line: string): number {
    const withoutStrings = line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "")

    return (withoutStrings.match(/\{/g)?.length ?? 0) - (withoutStrings.match(/\}/g)?.length ?? 0)
  }

  for (const line of content.split(/\r?\n/)) {
    if (depth === 0 && /^\s*\{/.test(line)) {
      current = []
    }

    if (depth > 0 || /^\s*\{/.test(line)) {
      current.push(line)
      depth += braceDelta(line)
    }

    if (depth === 0 && current.length > 0) {
      blocks.push(current.join("\n"))
      current = []
    }
  }

  if (blocks.length === 0 && /(?:type_name|name|platform_type|platform_name|group_creation)/i.test(content)) {
    blocks.push(content)
  }

  return blocks
}

function readObjectProp(block: string, key: string): string | undefined {
  const quoted = block.match(new RegExp(`["']${escapeRegExp(key)}["']\\s*:\\s*["']([^"']+)["']`))
  if (quoted?.[1]) return quoted[1]

  const bare = block.match(new RegExp(`["']${escapeRegExp(key)}["']\\s*:\\s*([^,\\n\\r]+)`))
  return bare?.[1]?.trim().replace(/,$/, "")
}

function extractAccountTypeFacts(chunks: RetrievedPayload[], question: string): AccountTypeFact[] {
  const wantedPlatform = accountTypeQuestionPlatform(question)
  const wantedBroker = questionBrokerHint(question)
  const facts: AccountTypeFact[] = []
  const parseUnits = new Map<string, { content: string; source: string }>()

  for (const chunk of chunks) {
    const content = chunk.content ?? ""

    if (!/accountTypes|accountTypesV2|type_name|platform_type|group_creation|GetAccountTypes/i.test(content)) continue

    const source = `${chunk.repoName}@${chunk.branchName ?? "unknown"} ${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`
    parseUnits.set(`chunk:${source}`, { content, source })
  }

  const candidateFileKeys = new Set<string>()

  for (const chunk of chunks) {
    const content = chunk.content ?? ""

    if (!/accountTypes|accountTypesV2|type_name|platform_type|group_creation/i.test(content)) continue

    const key = `${chunk.repoName ?? "unknown"}|${chunk.branchName ?? "unknown"}|${chunk.filePath ?? "unknown"}`
    candidateFileKeys.add(key)
  }

  const chunksByFile = new Map<string, RetrievedPayload[]>()

  for (const chunk of chunks) {
    const key = `${chunk.repoName ?? "unknown"}|${chunk.branchName ?? "unknown"}|${chunk.filePath ?? "unknown"}`

    if (!candidateFileKeys.has(key)) continue

    chunksByFile.set(key, [...(chunksByFile.get(key) ?? []), chunk])
  }

  for (const fileChunks of chunksByFile.values()) {
    const ordered = [...fileChunks].sort((left, right) => (left.startLine ?? 0) - (right.startLine ?? 0))
    const first = ordered[0]
    const last = ordered[ordered.length - 1]

    if (!first || !last) continue

    const lineMap = new Map<number, string>()

    for (const chunk of ordered) {
      const startLine = chunk.startLine ?? 1
      const lines = (chunk.content ?? "").split(/\r?\n/)

      lines.forEach((line, index) => {
        const lineNumber = startLine + index

        if (!lineMap.has(lineNumber)) {
          lineMap.set(lineNumber, line)
        }
      })
    }

    const content = [...lineMap.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([, line]) => line)
      .join("\n")
    const source = `${first.repoName}@${first.branchName ?? "unknown"} ${first.filePath}:${first.startLine}-${last.endLine}`
    parseUnits.set(`file:${source}`, {
      content,
      source,
    })
  }

  for (const { content, source } of parseUnits.values()) {
    for (const block of objectBlocksFromContent(content)) {
      const name = readObjectProp(block, "type_name") ?? readObjectProp(block, "name")
      const platformName = readObjectProp(block, "platform_name")
      const platformType = readObjectProp(block, "platform_type")
      const groupCreation = readObjectProp(block, "group_creation")
      const hasAccountTypeShape = /["'](?:mindepo|min_first_depo|type_name|group_creation|platform_type|leverage)["']\s*:/.test(block)

      if (!name) continue
      if (!hasAccountTypeShape) continue
      if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{1,40}$/.test(name)) continue

      const normalizedPlatform =
        platformName?.toUpperCase() ??
        (platformType === "0" ? "MT4" : platformType === "5" ? "MT5" : undefined)

      if (wantedPlatform && normalizedPlatform && normalizedPlatform !== wantedPlatform) continue
      if (wantedPlatform && !normalizedPlatform) continue

      const broker = inferAccountTypeBrokerFromSource(source)
      if (wantedBroker && broker !== "unknown" && broker !== wantedBroker) continue
      if (wantedBroker === "mrg" && /\b(mmb|askap|MMB-)/.test(block)) continue
      if (wantedBroker === "askap" && /\bmrg\b/i.test(source) && !/\b(mmb|askap|MMB-)/.test(block)) continue

      facts.push({
        name,
        broker,
        id: readObjectProp(block, "id"),
        platformName,
        platformType,
        show: readObjectProp(block, "show"),
        groupCreation,
        minFirstDepo: readObjectProp(block, "min_first_depo") ?? readObjectProp(block, "mindepo"),
        leverage: readObjectProp(block, "leverage"),
        feature: readObjectProp(block, "feature"),
        source,
      })
    }
  }

  const byKey = new Map<string, AccountTypeFact>()

  for (const fact of facts) {
    const platformKey = fact.platformName?.toLowerCase() ??
      (fact.platformType === "0" ? "mt4" : fact.platformType === "3" || fact.platformType === "5" ? "mt5" : "")
    const key = [
      fact.broker,
      fact.name.toLowerCase(),
      platformKey,
    ].join("|")

    const existing = byKey.get(key)
    if (
      !existing ||
      (existing.platformType === undefined && fact.platformType !== undefined) ||
      (existing.show === undefined && fact.show !== undefined)
    ) {
      byKey.set(key, fact)
    }
  }

  return sortAccountTypeFacts(
    [...byKey.values()].map(fact => ({
      ...fact,
      source: findBestAccountTypeSource(fact, chunks) ?? fact.source,
    })),
  )
}

function findBestAccountTypeSource(fact: AccountTypeFact, chunks: RetrievedPayload[]): string | undefined {
  const candidates = chunks.filter(chunk => {
    const content = chunk.content ?? ""
    const source = `${chunk.repoName}@${chunk.branchName ?? "unknown"} ${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`

    if (!content.includes(fact.name)) return false
    if (fact.broker !== "unknown" && inferAccountTypeBrokerFromSource(source) !== fact.broker) return false
    if (fact.groupCreation && content.includes(fact.groupCreation)) return true
    if (fact.platformType && content.includes(`"platform_type": ${fact.platformType}`)) return true
    if (fact.platformName && content.includes(`"platform_name": "${fact.platformName}"`)) return true

    return false
  })

  const best = candidates.sort((left, right) => {
    function score(chunk: RetrievedPayload): number {
      const content = chunk.content ?? ""
      let value = 0

      if (fact.groupCreation && content.includes(fact.groupCreation)) value += 10
      if (fact.platformType && content.includes(`"platform_type": ${fact.platformType}`)) value += 6
      if (fact.show !== undefined && content.includes(`"show": ${fact.show}`)) value += 4
      if (/accountTypesV2/.test(content)) value += 2

      return value
    }

    return score(right) - score(left)
  })[0]

  if (!best) return undefined

  return `${best.repoName}@${best.branchName ?? "unknown"} ${best.filePath}:${best.startLine}-${best.endLine}`
}

function sortAccountTypeFacts(facts: AccountTypeFact[]): AccountTypeFact[] {
  const preferredOrder = ["basic", "silver", "gold", "premium", "syariah", "micro", "ultimate", "isignal", "infinite", "i-profesional"]

  return [...facts].sort((left, right) => {
    const leftIndex = preferredOrder.indexOf(left.name.toLowerCase())
    const rightIndex = preferredOrder.indexOf(right.name.toLowerCase())

    if (leftIndex !== -1 || rightIndex !== -1) {
      return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) -
        (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex)
    }

    return left.name.localeCompare(right.name)
  })
}

function buildAccountTypeBehaviorNotes(chunks: RetrievedPayload[], question: string): string[] {
  const notes: string[] = []
  const wantedPlatform = accountTypeQuestionPlatform(question)
  const wantedBroker = questionBrokerHint(question)
  const relevantChunks = wantedBroker
    ? chunks.filter(chunk => {
        const source = `${chunk.repoName}@${chunk.branchName ?? "unknown"} ${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`
        return inferAccountTypeBrokerFromSource(source) === wantedBroker
      })
    : chunks
  const joined = relevantChunks.map(chunk => chunk.content ?? "").join("\n")

  if (/GetAccountTypesV2/.test(joined) && /config\.accountTypesV2/.test(joined)) {
    notes.push(localized("Endpoint V2 membaca `config.accountTypesV2`.", "V2 endpoint reads `config.accountTypesV2`."))
  }

  if (wantedBroker === "mrg" && /GetAccountTypesV2/.test(joined) && /GetAccountTypeByUserId/.test(joined)) {
    notes.push(localized(
      "Untuk MRG V2, `ims-tf2` memanggil RPC `GetAccountTypeByUserId`; list finalnya berasal dari service downstream, bukan hanya config lokal.",
      "For MRG V2, `ims-tf2` calls RPC `GetAccountTypeByUserId`; the final list comes from the downstream service, not only local config.",
    ))
  }

  if (wantedBroker === "mrg" && /MetaAccountType\.getPublicAccountTypes/.test(joined)) {
    notes.push(localized(
      "`mrg-accounts` mengambil tipe akun publik dari `MetaAccountType.getPublicAccountTypes` lalu mengembalikan `platform_type`, `type_name`, `group_creation`, `leverage`, dan `min_first_depo`.",
      "`mrg-accounts` reads public account types from `MetaAccountType.getPublicAccountTypes`, then returns `platform_type`, `type_name`, `group_creation`, `leverage`, and `min_first_depo`.",
    ))
  }

  if (/filter\(x\s*=>\s*x\.show\s*==\s*1\)/.test(joined)) {
    notes.push(localized("Endpoint V2 memfilter hanya entry dengan `show == 1`.", "V2 endpoint filters to entries with `show == 1`."))
  }

  if (/TF_CAN_REQUEST_MMB_MT5/.test(joined) && /platform_type\s*!=\s*5/.test(joined)) {
    notes.push(localized(
      "Jika user tidak punya rule `TF_CAN_REQUEST_MMB_MT5`, endpoint V2 membuang entry `platform_type == 5`.",
      "If the user does not have rule `TF_CAN_REQUEST_MMB_MT5`, V2 endpoint removes entries with `platform_type == 5`.",
    ))
  }

  if (/GetAccountTypes\(/.test(joined) && /config\.accountTypes/.test(joined)) {
    notes.push(localized("Endpoint V1 membaca `config.accountTypes`.", "V1 endpoint reads `config.accountTypes`."))
  }

  if (wantedPlatform === "MT5") {
    const mt5Facts = extractAccountTypeFacts(chunks, question)
    if (mt5Facts.length > 0 && mt5Facts.every(fact => fact.show === "0")) {
      notes.push(localized(
        "Di evidence yang ter-retrieve, semua entry MT5 yang terdefinisi punya `show: 0`; jadi tidak keluar dari endpoint V2 normal setelah filter `show == 1`.",
        "In retrieved evidence, every defined MT5 entry has `show: 0`, so it will not be returned by the normal V2 endpoint after the `show == 1` filter.",
      ))
    }
  }

  return unique(notes, 8)
}

function buildAccountTypeGlossaryAnswer(chunks: RetrievedPayload[], question: string): string | undefined {
  if (!questionAsksAboutAccountTypes(question)) return undefined

  const facts = extractAccountTypeFacts(chunks, question)
  if (facts.length === 0) return undefined

  const wantedPlatform = accountTypeQuestionPlatform(question)
  const wantedBroker = questionBrokerHint(question)
  const brokerLabel = wantedBroker === "mrg" ? "MRG" : wantedBroker === "askap" ? "MMB/Askap" : "broker"
  const visible = facts.filter(fact => fact.show !== "0")
  const hidden = facts.filter(fact => fact.show === "0")
  const primaryFacts = visible.length > 0 ? visible : facts

  function describeFact(fact: AccountTypeFact): string {
    const details = [
      fact.id ? `id ${fact.id}` : undefined,
      fact.platformName ? fact.platformName : undefined,
      fact.platformType ? `platform_type ${fact.platformType}` : undefined,
      fact.show !== undefined ? `show ${fact.show}` : undefined,
      fact.groupCreation ? `group ${fact.groupCreation}` : undefined,
      fact.minFirstDepo ? `min deposit ${fact.minFirstDepo}` : undefined,
      fact.leverage ? `leverage ${fact.leverage}` : undefined,
      fact.feature && fact.feature !== "-" ? `feature ${fact.feature}` : undefined,
    ].filter(Boolean).join(", ")

    return `- ${fact.name}${details ? ` (${details})` : ""}`
  }

  const behaviorNotes = buildAccountTypeBehaviorNotes(chunks, question)
  const sources = unique([
    ...facts.map(fact => fact.source),
    ...chunks
      .filter(chunk => {
        const source = `${chunk.repoName}@${chunk.branchName ?? "unknown"} ${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`
        const broker = inferAccountTypeBrokerFromSource(source)

        if (wantedBroker && broker !== wantedBroker) return false

        return /GetAccountTypes|account\/types|accountTypesV2|config\.accountTypes|GetAccountTypeByUserId|MetaAccountType\.getPublicAccountTypes/i.test(chunk.content ?? "")
      })
      .map(chunk => `${chunk.repoName}@${chunk.branchName ?? "unknown"} ${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`),
  ], 12)

  const allPrimaryHidden = primaryFacts.length > 0 && primaryFacts.every(fact => fact.show === "0")
  const title = localized(
    `Tipe akun ${brokerLabel}${wantedPlatform ? ` ${wantedPlatform}` : ""} yang ${allPrimaryHidden ? "terdefinisi di config" : "ditemukan"}:`,
    `${brokerLabel}${wantedPlatform ? ` ${wantedPlatform}` : ""} account types ${allPrimaryHidden ? "defined in config" : "found"}:`,
  )

  return [
    title,
    primaryFacts.map(describeFact).join("\n"),
    hidden.length > 0 && visible.length > 0
      ? [
          "",
          localized("Entry yang terdefinisi tapi tidak visible (`show: 0`):", "Defined but hidden entries (`show: 0`):"),
          hidden.map(describeFact).join("\n"),
        ].join("\n")
      : undefined,
    behaviorNotes.length > 0
      ? [
          "",
          localized("Perilaku endpoint/config yang relevan:", "Relevant endpoint/config behavior:"),
          behaviorNotes.map(note => `- ${note}`).join("\n"),
        ].join("\n")
      : undefined,
    "",
    "Evidence:",
    sources.map(source => `- ${source}`).join("\n"),
  ].filter((line): line is string => typeof line === "string").join("\n")
}

function accountTypeRelevantSourceChunks(chunks: RetrievedPayload[], question: string): RetrievedPayload[] {
  const wantedBroker = questionBrokerHint(question)
  const facts = extractAccountTypeFacts(chunks, question)
  const factSources = new Set(facts.map(fact => fact.source))

  return chunks.filter(chunk => {
    const source = `${chunk.repoName}@${chunk.branchName ?? "unknown"} ${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`
    const content = chunk.content ?? ""
    const broker = inferAccountTypeBrokerFromSource(source)
    const sourceFilePrefix = `${chunk.repoName}@${chunk.branchName ?? "unknown"} ${chunk.filePath}:`

    if (factSources.has(source)) return true
    if ([...factSources].some(factSource => factSource.startsWith(sourceFilePrefix))) return true
    if (wantedBroker && broker !== wantedBroker) return false

    return /GetAccountTypes|account\/types|accountTypesV2|config\.accountTypes|GetAccountTypeByUserId|MetaAccountType\.getPublicAccountTypes/i.test(content)
  }).slice(0, 12)
}

function buildAccountTypeNotFoundAnswer(question: string): string {
  const broker = questionBrokerHint(question)
  const brokerText = broker === "mrg" ? "MRG" : broker === "askap" ? "MMB/Askap" : "broker yang diminta"

  return localized(
    `NOT_FOUND_IN_INDEXED_CODEBASE: Saya tidak menemukan source ter-index yang mendefinisikan list tipe akun ${brokerText} untuk pertanyaan ini. Saya tidak memakai fallback dokumentasi umum karena pertanyaannya meminta account type spesifik.`,
    `NOT_FOUND_IN_INDEXED_CODEBASE: I did not find indexed source defining the requested ${broker === "mrg" ? "MRG" : broker === "askap" ? "MMB/Askap" : "broker"} account type list. I did not use generic documentation fallback because the question asks for specific account types.`,
  )
}

function buildDocumentationGlossaryAnswer(chunks: RetrievedPayload[], question: string): string | undefined {
  if (!questionAsksAboutGlossary(question)) return undefined
  if (questionAsksAboutAccountTypes(question)) return undefined

  const lowerQuestion = question.toLowerCase()
  const asksRules = /\b(aturan|rules?|rule|ketentuan|business rules?)\b/i.test(question)
  const asksDefinition = /\b(apa itu|what is|maksud|meaning|define|definition|glossary|glosarium)\b/i.test(question)
  const subjectTerms = unique([
    ...extractConceptTokens(question),
    ...registryExpansion.terms.filter(term => term.length >= 4),
  ], 24).map(term => term.toLowerCase())
  const sortedDocChunks = chunks.filter(chunk => {
    if (!chunk.evidenceTypes?.includes("documentation")) return false

    const text = [
      chunk.filePath ?? "",
      chunk.content ?? "",
      ...(chunk.symbols ?? []),
      ...(chunk.messageNames ?? []),
    ].join("\n").toLowerCase()

    return subjectTerms.some(term => text.includes(term.toLowerCase()))
  }).sort((left, right) => {
    function score(chunk: RetrievedPayload): number {
      const filePath = chunk.filePath?.toLowerCase() ?? ""
      const repoName = chunk.repoName?.toLowerCase() ?? ""
      const content = chunk.content?.toLowerCase() ?? ""
      let value = 0

      if (subjectTerms.includes("isignal")) {
        if (filePath.includes("isignal-docs")) value += 40
        if (repoName.includes("isignal")) value += 20
        if (content.includes("auto copy")) value += 10
      }

      if (filePath.includes("business-rules") || filePath.includes("rules")) value += asksRules ? 20 : 0
      if (filePath.includes("glossarium") || filePath.includes("glossary")) value += asksDefinition ? 18 : 4
      if (filePath.endsWith("index.mdx") || filePath.endsWith("index.md")) value += asksRules ? 0 : 18
      if (asksDefinition && /\ballows users to automatically|overview|core purpose|internal documentation for/i.test(content)) value += 35
      if (asksDefinition && (filePath.includes("cron") || filePath.includes("diagram"))) value -= 25
      if (!asksRules && filePath.includes("business-rules")) value -= asksDefinition ? 8 : 0

      return value
    }

    return score(right) - score(left)
  })

  const docChunks = asksDefinition
    ? sortedDocChunks.filter(chunk => {
        const filePath = chunk.filePath?.toLowerCase() ?? ""
        const content = chunk.content?.toLowerCase() ?? ""
        const isTopLevelIndex = /docs:[^/\\]+[/\\]index\.mdx?$/.test(filePath)

        return isTopLevelIndex ||
          filePath.includes("glossarium") ||
          filePath.includes("glossary") ||
          content.includes("allows users to automatically")
      })
    : sortedDocChunks

  if (docChunks.length === 0) return undefined

  const facts: string[] = []
  const maxFacts = asksDefinition ? 6 : 14

  for (const chunk of docChunks) {
    const lines = (chunk.content ?? "")
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .filter(line => !/^(Documentation|Source|title|description|file):/i.test(line))

    for (const line of lines) {
      const lowerLine = line.toLowerCase()
      const isHeader = /^#{1,4}\s+/.test(line)
      const isListOrTable = /^[-*]\s+/.test(line) || /^\|/.test(line) || /^\d+\.\s+/.test(line)
      const isDiagramOrCode = /^(graph|flowchart|sequenceDiagram|classDef|subgraph|%%|[A-Za-z0-9_]+\[|[A-Za-z0-9_]+-->|[A-Za-z0-9_]+-.->)/.test(line)
      const isDocusaurusComponent = /^<|^import\s+/.test(line)
      const isMetadataLine = /^---$/.test(line) || /^>\s+/.test(line)
      const mentionsSubject = subjectTerms.some(term => lowerLine.includes(term))

      if (isDiagramOrCode || isDocusaurusComponent || isMetadataLine) continue
      if (asksDefinition && isListOrTable) continue

      if (mentionsSubject || (asksRules && isListOrTable) || (!asksRules && !isListOrTable && !isHeader)) {
        facts.push(`${line} (${chunk.repoName}@${chunk.branchName ?? "unknown"} ${chunk.filePath}:${chunk.startLine}-${chunk.endLine})`)
      }

      if (facts.length >= maxFacts) break
    }

    if (facts.length >= maxFacts) break
  }

  const uniqueFacts = unique(facts, maxFacts)

  if (uniqueFacts.length === 0) return undefined

  return [
    shouldAnswerIndonesian(question)
      ? "Ringkasan berdasarkan dokumentasi yang ter-index:"
      : "Summary from indexed documentation:",
    uniqueFacts.map(fact => `- ${fact}`).join("\n"),
    "",
    shouldAnswerIndonesian(question)
      ? "Catatan: ini adalah ringkasan evidence dokumentasi. Untuk detail implementasi, tanyakan flow, endpoint, tabel, atau service spesifik."
      : "Note: this is a documentation evidence summary. For implementation details, ask for a specific flow, endpoint, table, or service.",
  ].join("\n")
}

function documentationGlossarySourceChunks(chunks: RetrievedPayload[], question: string): RetrievedPayload[] {
  const asksDefinition = /\b(apa itu|what is|maksud|meaning|define|definition|glossary|glosarium)\b/i.test(question)
  const asksRules = /\b(aturan|rules?|rule|ketentuan|business rules?)\b/i.test(question)

  return chunks.filter(chunk => {
    if (!chunk.evidenceTypes?.includes("documentation")) return false

    const filePath = chunk.filePath?.toLowerCase() ?? ""
    const content = chunk.content?.toLowerCase() ?? ""

    if (asksRules) return filePath.includes("rules")
    if (asksDefinition) {
      const isTopLevelIndex = /docs:[^/\\]+[/\\]index\.mdx?$/.test(filePath)

      return isTopLevelIndex ||
        filePath.includes("glossarium") ||
        filePath.includes("glossary") ||
        content.includes("allows users to automatically")
    }

    return true
  }).slice(0, 12)
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
  answerLanguage = await detectAnswerLanguage(question)

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
  const exactTermSearchTerms = unique([
    ...questionHints,
    ...(questionAsksAboutGlossary(question) ? extractConceptTokens(question) : []),
    ...registryExactSearchTerms(),
  ], 36)
  const exactTermChunks = exactRoutes.length === 0
    ? await retrieveExactTermMatches(exactTermSearchTerms, questionAsksAboutAccountTypes(question) ? 60 : 32)
    : []
  const exactTermDetailChunks =
    exactRoutes.length === 0 && exactTermChunks.length > 0
      ? await retrieveNeighborChunks(exactTermChunks, questionAsksAboutAccountTypes(question) ? 240 : 70)
      : []
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
  const retrievalLimit = questionAsksAboutGlossary(question) ? Math.max(limit, 18) : limit
  const initialChunks = exactRoutes.length > 0 ? [] : await retrieve(retrievalQuestion, retrievalLimit)
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
    expandedChunks.push(...await retrieve(`${expansionQuery}\n${registryExpansion.terms.join(" ")}`, Math.max(3, Math.ceil(retrievalLimit / 2))))
  }

  const retrievedChunks = mergeChunks(
    [...exactChunks, ...exactDetailChunks, ...exactTermChunks, ...exactTermDetailChunks, ...initialChunks, ...expandedChunks],
    exactRoutes.length > 0
      ? Math.max(limit, 24)
      : questionAsksAboutAccountTypes(question)
        ? Math.max(retrievalLimit, 36)
        : questionAsksAboutGlossary(question)
        ? Math.max(retrievalLimit, 24)
        : Math.max(limit, 12),
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

  const platformTypeGlossaryAnswer = buildPlatformTypeGlossaryAnswer(chunks, question)

  if (platformTypeGlossaryAnswer) {
    const sourceChunks = chunks.filter(chunk => {
      return /platform_type|mt4DemoType|mt5DemoType|MetaTrader|MT4|MT5/i.test(chunk.content ?? "")
    }).slice(0, 12)

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

  const accountTypeGlossaryAnswer = buildAccountTypeGlossaryAnswer(chunks, question)

  if (accountTypeGlossaryAnswer) {
    const sourceChunks = accountTypeRelevantSourceChunks(chunks, question)

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
    console.log(buildAccountTypeNotFoundAnswer(question))

    console.log("\nSOURCES\n")

    return
  }

  const documentationGlossaryAnswer = buildDocumentationGlossaryAnswer(chunks, question)

  if (documentationGlossaryAnswer) {
    const sourceChunks = documentationGlossarySourceChunks(chunks, question)

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
  const registryPromptContext = buildRegistryPromptContext(registryExpansion)

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
    "Relevant context:",
    context,
    "",
    "Answer requirements:",
    "- Answer in the same language as the user's question. If the question is in Bahasa Indonesia, answer in Bahasa Indonesia while keeping code identifiers unchanged.",
    "- Answer from the context only.",
    "- Answer the user's exact question. If retrieved context is about a different topic, say NOT_FOUND_IN_INDEXED_CODEBASE for the requested topic instead of answering the different topic.",
    "- Domain vocabulary hints are synonyms for retrieval and disambiguation, not evidence. Do not present a hint as a fact unless it is supported by the source context.",
    "- For glossary/list questions, synthesize a concise glossary-style answer from all relevant source chunks. Include aliases, code constants, tables, routes, and rules only when they are visible in sources.",
    "- If the question asks for a list, return a list and cite the source lines for each group of facts.",
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
    history.length > 0 ? "- This question may be a follow-up. Use the previous conversation to resolve pronouns like 'it', 'that', or 'the endpoint', but still ground your answer in the retrieved context above." : undefined,
  ].filter((line): line is string => typeof line === "string").join("\n")

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
