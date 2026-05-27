import fs from "node:fs/promises"
import path from "node:path"
import { sha256 } from "./hash.js"
import type { SourceFile } from "./files.js"
import type { ServiceType } from "./chunker.js"

export type RelationshipType =
  | "CALLS_HTTP_ENDPOINT"
  | "HANDLES_HTTP_ENDPOINT"
  | "CALLS_RPC_FUNC"
  | "CALLS_EXTERNAL_FUNC"
  | "CALLS_SYMBOL"
  | "DEFINES_SYMBOL"
  | "TOUCHES_TABLE"

export type RelationshipEdge = {
  id: string
  type: RelationshipType
  repoName: string
  serviceType: ServiceType
  branchName: string
  commitSha: string
  filePath: string
  startLine: number
  endLine: number
  fromSymbol?: string | undefined
  toRoute?: string | undefined
  httpMethod?: string | undefined
  alias?: string | undefined
  handler?: string | undefined
  viaConstant?: string | undefined
  rpcFunc?: string | undefined
  externalFunc?: string | undefined
  receiverSymbol?: string | undefined
  calleeSymbol?: string | undefined
  symbol?: string | undefined
  table?: string | undefined
  evidence?: string | undefined
}

type ConstantRoute = {
  name: string
  fullName: string
  route: string
  expression: string
}

type TableOccurrence = {
  table: string
  line: number
}

const graphPath = path.join(process.cwd(), ".data", "relationships.jsonl")

function unique(values: string[], max = 50): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].slice(0, max)
}

function lineNumberAt(content: string, index: number): number {
  return content.slice(0, Math.max(0, index)).split(/\r?\n/).length
}

function edgeId(edge: Omit<RelationshipEdge, "id">): string {
  return sha256([
    edge.type,
    edge.repoName,
    edge.branchName,
    edge.filePath,
    edge.startLine,
    edge.endLine,
    edge.fromSymbol ?? "",
    edge.toRoute ?? "",
    edge.handler ?? "",
    edge.viaConstant ?? "",
    edge.rpcFunc ?? "",
    edge.externalFunc ?? "",
    edge.receiverSymbol ?? "",
    edge.calleeSymbol ?? "",
    edge.symbol ?? "",
    edge.table ?? "",
  ].join(":"))
}

function createEdge(edge: Omit<RelationshipEdge, "id">): RelationshipEdge {
  return {
    id: edgeId(edge),
    ...edge,
  }
}

function normalizeRoute(route: string): string {
  const normalized = route.trim().replace(/\/+$/, "")

  return normalized.length > 0 ? normalized : "/"
}

function extractTableOccurrences(content: string): TableOccurrence[] {
  const stopWords = new Set(["on", "status", "set", "where", "order", "group", "select", "from"])
  const matches = [
    ...content.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+[`"']?([A-Za-z_][\w.]*)[`"']?/gi),
    ...content.matchAll(/\b(?:INSERT\s+INTO|DELETE\s+FROM)\s+[`"']?([A-Za-z_][\w.]*)[`"']?/gi),
    ...content.matchAll(/\bsqlstr\.(?:insertObject|updateObject)\(\s*["'`]([A-Za-z_][\w.]*)["'`]/g),
  ]

  return [...new Map(matches
    .map(match => ({
      table: match[1] ?? "",
      line: lineNumberAt(content, match.index ?? 0),
    }))
    .filter(occurrence => occurrence.table && !stopWords.has(occurrence.table.toLowerCase()))
    .map(occurrence => [`${occurrence.table}:${occurrence.line}`, occurrence])).values()].slice(0, 100)
}

function findPhpFunctionBefore(content: string, index: number): { name: string; line: number } | undefined {
  const before = content.slice(0, index)
  const matches = [...before.matchAll(/\b(?:public|private|protected)?\s*function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)]
  const match = matches.at(-1)

  if (!match?.[1] || match.index === undefined) return undefined

  return {
    name: match[1],
    line: lineNumberAt(content, match.index),
  }
}

function findJsMethodBefore(content: string, index: number): { name: string; line: number } | undefined {
  const before = content.slice(0, index)
  const matches = [...before.matchAll(/\b(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g)]
    .filter(match => !["if", "for", "while", "switch", "catch", "function"].includes(match[1] ?? ""))
  const match = matches.at(-1)

  if (!match?.[1] || match.index === undefined) return undefined

  return {
    name: match[1],
    line: lineNumberAt(content, match.index),
  }
}

function extractPhpConstantRoutes(file: SourceFile): ConstantRoute[] {
  const className = file.content.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/)?.[1] ?? ""
  const constants = new Map<string, string>()

  for (const match of file.content.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*=\s*([^;]+);/g)) {
    if (match[1] && match[2]) {
      constants.set(match[1], match[2])
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
      fullName: className ? `${className}::${name}` : name,
      expression,
      route: normalizeRoute(resolveExpression(expression)),
    }))
    .filter(constant => constant.route.startsWith("/"))
}

function parseRouteDefinition(definition: string) {
  const method = definition.match(/\bmethod\s*:\s*\[([^\]]+)\]/)?.[1]?.replaceAll(/["'`\s]/g, "") ?? ""
  const alias = definition.match(/\balias\s*:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? ""
  const url = definition.match(/\burl\s*:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? ""
  const handler = definition.match(/\bhandler\s*:\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)/)?.[1] ?? ""

  if (!url || !handler) return undefined

  return {
    method,
    alias,
    url: normalizeRoute(url),
    handler,
  }
}

export function extractRelationshipEdges(
  files: SourceFile[],
  repoName: string,
  serviceType: ServiceType,
  branchName: string,
  commitSha: string,
): RelationshipEdge[] {
  const edges: RelationshipEdge[] = []
  const phpConstantRoutes = new Map<string, ConstantRoute>()

  for (const file of files) {
    for (const constantRoute of extractPhpConstantRoutes(file)) {
      phpConstantRoutes.set(constantRoute.name, constantRoute)
      phpConstantRoutes.set(constantRoute.fullName, constantRoute)
    }
  }

  for (const file of files) {
    const base = {
      repoName,
      serviceType,
      branchName,
      commitSha,
      filePath: file.relativePath,
    }

    for (const match of file.content.matchAll(/\{[\s\S]*?method\s*:\s*\[[\s\S]*?url\s*:\s*["'`]\/[^"'`]+["'`][\s\S]*?handler\s*:\s*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+[\s\S]*?\}/g)) {
      const definition = parseRouteDefinition(match[0])

      if (!definition || match.index === undefined) continue

      const startLine = lineNumberAt(file.content, match.index)
      const endLine = startLine + match[0].split(/\r?\n/).length - 1

      edges.push(createEdge({
        ...base,
        type: "HANDLES_HTTP_ENDPOINT",
        startLine,
        endLine,
        toRoute: definition.url,
        httpMethod: definition.method,
        alias: definition.alias,
        handler: definition.handler,
        symbol: definition.handler.split(".").at(-1),
        evidence: match[0].trim(),
      }))
    }

    for (const match of file.content.matchAll(/\bHelper::requestAPI\(\s*([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)?)/g)) {
      if (!match[1] || match.index === undefined) continue

      const constantRoute = phpConstantRoutes.get(match[1]) ?? phpConstantRoutes.get(match[1].split("::").at(-1) ?? "")

      if (!constantRoute) continue

      const caller = findPhpFunctionBefore(file.content, match.index)
      const startLine = caller?.line ?? lineNumberAt(file.content, match.index)

      edges.push(createEdge({
        ...base,
        type: "CALLS_HTTP_ENDPOINT",
        startLine,
        endLine: lineNumberAt(file.content, match.index),
        fromSymbol: caller?.name,
        toRoute: constantRoute.route,
        viaConstant: constantRoute.fullName,
        evidence: match[0],
      }))
    }

    for (const match of file.content.matchAll(/\bfunc\s*:\s*["'`]([^"'`]+)["'`]/g)) {
      if (!match[1] || match.index === undefined) continue

      const caller = findJsMethodBefore(file.content, match.index) ?? findPhpFunctionBefore(file.content, match.index)
      const startLine = caller?.line ?? lineNumberAt(file.content, match.index)

      edges.push(createEdge({
        ...base,
        type: "CALLS_RPC_FUNC",
        startLine,
        endLine: lineNumberAt(file.content, match.index),
        fromSymbol: caller?.name,
        rpcFunc: match[1],
        evidence: match[0],
      }))
    }

    for (const match of file.content.matchAll(/\bpostParamsAsync\(\s*["'`]([^"'`]+)["'`]/g)) {
      if (!match[1] || match.index === undefined) continue

      const caller = findJsMethodBefore(file.content, match.index) ?? findPhpFunctionBefore(file.content, match.index)
      const startLine = caller?.line ?? lineNumberAt(file.content, match.index)

      edges.push(createEdge({
        ...base,
        type: "CALLS_EXTERNAL_FUNC",
        startLine,
        endLine: lineNumberAt(file.content, match.index),
        fromSymbol: caller?.name,
        externalFunc: match[1],
        evidence: match[0],
      }))
    }

    for (const match of file.content.matchAll(/\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (!match[1] || !match[2] || match.index === undefined) continue

      const receiverSymbol = match[1]
      const calleeSymbol = match[2]

      if (["console", "Math", "JSON", "Object", "Array", "String", "Number", "Promise"].includes(receiverSymbol)) continue
      if (["log", "error", "warn", "map", "filter", "find", "then", "catch", "indexOf", "includes"].includes(calleeSymbol)) continue

      const caller = findJsMethodBefore(file.content, match.index) ?? findPhpFunctionBefore(file.content, match.index)
      const startLine = caller?.line ?? lineNumberAt(file.content, match.index)

      edges.push(createEdge({
        ...base,
        type: "CALLS_SYMBOL",
        startLine,
        endLine: lineNumberAt(file.content, match.index),
        fromSymbol: caller?.name,
        receiverSymbol,
        calleeSymbol,
        evidence: match[0],
      }))
    }

    for (const match of file.content.matchAll(/\b(?:async\s+)?(?:public\s+|private\s+|protected\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g)) {
      if (!match[1] || match.index === undefined) continue
      if (["if", "for", "while", "switch", "catch", "function"].includes(match[1])) continue

      const line = lineNumberAt(file.content, match.index)

      edges.push(createEdge({
        ...base,
        type: "DEFINES_SYMBOL",
        startLine: line,
        endLine: line,
        symbol: match[1],
        evidence: match[0],
      }))
    }

    for (const occurrence of extractTableOccurrences(file.content)) {
      edges.push(createEdge({
        ...base,
        type: "TOUCHES_TABLE",
        startLine: occurrence.line,
        endLine: occurrence.line,
        table: occurrence.table,
      }))
    }
  }

  return [...new Map(edges.map(edge => [edge.id, edge])).values()]
}

export async function readRelationshipGraph(): Promise<RelationshipEdge[]> {
  try {
    const content = await fs.readFile(graphPath, "utf8")

    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => JSON.parse(line) as RelationshipEdge)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []

    throw error
  }
}

export async function writeRelationshipGraphForRepo(
  repoName: string,
  branchName: string,
  edges: RelationshipEdge[],
  replaceRepo: boolean,
): Promise<void> {
  await fs.mkdir(path.dirname(graphPath), { recursive: true })

  const existing = await readRelationshipGraph()
  const kept = existing.filter(edge => {
    if (replaceRepo) return edge.repoName !== repoName

    return !(edge.repoName === repoName && edge.branchName === branchName)
  })
  const next = [...kept, ...edges]
  const content = next.map(edge => JSON.stringify(edge)).join("\n")

  await fs.writeFile(graphPath, content.length > 0 ? `${content}\n` : "", "utf8")
}
