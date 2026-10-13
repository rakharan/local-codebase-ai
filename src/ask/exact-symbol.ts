// Exact Symbol

import type { RetrievedChunk } from "./types.js"
import path from "node:path"
import { extractSqlTableNamesFromContent, sanitizeTableNames } from "./evidence.js"
import { extractRouteDefinitionsForSymbol, findMethodWindow } from "./route-analysis.js"
import { escapeRegExp, unique } from "./question.js"

export function extractNamedSymbolsFromQuestion(question: string): string[] {
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


export function describeMethodBody(content: string): string[] {
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


export function buildExactSymbolAnswer(symbolNames: string[], chunks: RetrievedChunk[]): string | undefined {
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
