import type { EvidenceType } from "../lib/evidence.js"
import type { RelationshipEdge } from "../lib/graph.js"
import type { ServiceType } from "../lib/chunker.js"

export type RetrievedPayload = {
  repoName?: string
  projectIds?: string[]
  projectTagSources?: string[]
  serviceType?: ServiceType
  branchName?: string
  commitSha?: string
  docLocale?: string
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
  noteStatus?: "confirmed" | "proposal" | "deprecated"
  noteAuthor?: string
  noteUpdatedAt?: string
}

export type RetrievedChunk = {
  id: string
  payload: RetrievedPayload
}

export type HandlerRef = {
  objectName: string
  methodName: string
  fullName: string
}

export type RouteDefinition = {
  method: string
  alias: string
  url: string
  handler: string
}

export type MethodWindow = {
  content: string
  firstChunk: RetrievedPayload | undefined
  lastChunk: RetrievedPayload | undefined
  startLine: number
  endLine: number
}

export type GraphFlowAnswer = {
  answer: string
  sources: RelationshipEdge[]
}

export type GraphPathDetails = {
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
