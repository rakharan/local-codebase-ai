import { sha256, uuidFromHash } from "./hash.js"
import type { CodeChunk } from "./chunker.js"
import type { RelationshipHints } from "./relationships.js"
import type {
  PackageFacts,
  EnvVarFact,
  ApiRouteFact,
  RabbitMqFact,
  DatabaseFact,
} from "../doctor/types.js"

export interface DoctorReport {
  services: PackageFacts[];
  envVars: EnvVarFact[];
  apiRoutes: ApiRouteFact[];
  rabbitMq: RabbitMqFact[];
  database: DatabaseFact[];
  summary: {
    serviceCount: number;
    envVarCount: number;
    apiRouteCount: number;
    rabbitMqCount: number;
    databaseCount: number;
    filesScanned: number;
  };
}

const BRANCH = "doctor"
const EMPTY_HINTS: RelationshipHints = { routes: [], symbols: [], messageNames: [], queueNames: [], exchangeNames: [], dbTables: [] }

function makeChunk(repoName: string, filePath: string, line: number, content: string, hints: RelationshipHints): CodeChunk {
  const contentHash = sha256(`doctor-fact-v1:${repoName}:${filePath}:${line}:${content}`)
  return {
    id: uuidFromHash(contentHash),
    repoName,
    projectIds: [],
    projectTagSources: [],
    serviceType: "unknown",
    branchName: BRANCH,
    commitSha: "doctor",
    filePath,
    startLine: line,
    endLine: line,
    content,
    contentHash,
    evidenceTypes: ["documentation"],
    relationshipHints: hints,
    structuredFacts: [],
  }
}

function getServiceName(pkg: PackageFacts): string {
  const nameFact = pkg.metadata.find(m => m.value.startsWith('Package name:'))
  return nameFact ? nameFact.value.replace('Package name: ', '') : 'unknown'
}

export function buildServiceChunks(report: DoctorReport, repoName: string): CodeChunk[] {
  const chunks: CodeChunk[] = []
  for (const pkg of report.services) {
    const name = getServiceName(pkg)
    const deps = pkg.dependencies.map(d => d.value.split(':')[0]!.trim()).join(', ')
    const scripts = pkg.scripts.map(s => s.value.split(':')[0]!.trim()).join(', ')
    const content = [
      `Service ${name}`,
      `Type: unknown`,
      scripts ? `Scripts: ${scripts}` : null,
      deps ? `Dependencies: ${deps}` : null,
    ].filter(Boolean).join('\n')
    chunks.push(makeChunk(repoName, `doctor-fact:service:${name}`, 0, content, EMPTY_HINTS))
  }
  return chunks
}

export function buildEnvChunks(report: DoctorReport, repoName: string): CodeChunk[] {
  return report.envVars.map(fact => {
    const content = `Environment variable ${fact.name} is used in ${fact.sourcePath} line ${fact.line}.\nConfidence: ${fact.confidence}.`
    const hints: RelationshipHints = { ...EMPTY_HINTS }
    return makeChunk(repoName, `doctor-fact:env:${fact.name}`, fact.line, content, hints)
  })
}

export function buildApiRouteChunks(report: DoctorReport, repoName: string): CodeChunk[] {
  return report.apiRoutes.map(fact => {
    const content = `API route ${fact.method} ${fact.path} is handled in ${fact.sourcePath} line ${fact.line}.\nFramework: ${fact.framework}.\nConfidence: ${fact.confidence}.`
    const hints: RelationshipHints = { ...EMPTY_HINTS, routes: [fact.path] }
    return makeChunk(repoName, `doctor-fact:api:${fact.method}:${fact.path}`, fact.line, content, hints)
  })
}

export function buildRabbitMqChunks(report: DoctorReport, repoName: string): CodeChunk[] {
  return report.rabbitMq.map(fact => {
    const content = `RabbitMQ ${fact.messageType} ${fact.name} — ${fact.operation} in ${fact.sourcePath} line ${fact.line}.\nConfidence: ${fact.confidence}.`
    const hints: RelationshipHints = {
      ...EMPTY_HINTS,
      queueNames: fact.messageType === 'queue' ? [fact.name] : [],
      exchangeNames: fact.messageType === 'exchange' ? [fact.name] : [],
      messageNames: fact.messageType === 'routing_key' ? [fact.name] : [],
    }
    return makeChunk(repoName, `doctor-fact:rabbitmq:${fact.name}`, fact.line, content, hints)
  })
}

export function buildDatabaseChunks(report: DoctorReport, repoName: string): CodeChunk[] {
  return report.database.map(fact => {
    const content = `Database ${fact.kind} ${fact.name} — ${fact.operation} in ${fact.sourcePath} line ${fact.line}.\nConfidence: ${fact.confidence}.`
    const hints: RelationshipHints = { ...EMPTY_HINTS, dbTables: [fact.name] }
    return makeChunk(repoName, `doctor-fact:database:${fact.name}:${fact.operation}:${fact.line}`, fact.line, content, hints)
  })
}

/**
 * Convert a full DoctorReport into RAG-ready CodeChunks.
 */
export function buildReportChunks(report: DoctorReport, repoName: string): CodeChunk[] {
  return [
    ...buildServiceChunks(report, repoName),
    ...buildEnvChunks(report, repoName),
    ...buildApiRouteChunks(report, repoName),
    ...buildRabbitMqChunks(report, repoName),
    ...buildDatabaseChunks(report, repoName),
  ]
}
