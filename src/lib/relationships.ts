export type RelationshipHints = {
  routes: string[]
  symbols: string[]
  messageNames: string[]
  queueNames: string[]
  exchangeNames: string[]
  dbTables: string[]
}

const MAX_VALUES = 20

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].slice(0, MAX_VALUES)
}

function matches(input: string, regex: RegExp): string[] {
  return [...input.matchAll(regex)].map(match => match[1] ?? "").filter(Boolean)
}

function quotedNearKeyword(content: string, keywords: string[]): string[] {
  const lines = content.split("\n")
  const values: string[] = []

  for (const line of lines) {
    const lower = line.toLowerCase()

    if (!keywords.some(keyword => lower.includes(keyword))) continue

    values.push(...matches(line, /["'`]([A-Za-z][A-Za-z0-9_.:-]{1,80})["'`]/g))
  }

  return values
}

function inferRoutes(content: string): string[] {
  const routes = [
    ...matches(content, /(?:app|router|route)\s*\.\s*(?:get|post|put|patch|delete|any)\s*\(\s*["'`]([^"'`]+)["'`]/gi),
    ...matches(content, /@(?:Get|Post|Put|Patch|Delete|All)\s*\(\s*["'`]([^"'`]+)["'`]/g),
    ...matches(content, /http\.HandleFunc\s*\(\s*["'`]([^"'`]+)["'`]/g),
    ...matches(content, /\$route\[[^\]]+\]\s*=\s*["'`]([^"'`]+)["'`]/gi),
    ...matches(content, /["'`](\/[A-Za-z0-9_./:{}-]+)["'`]/g),
  ]

  return unique(routes.filter(route => route.startsWith("/")))
}

function inferSymbols(content: string): string[] {
  return unique([
    ...matches(content, /\b(?:function|func)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g),
    ...matches(content, /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b/g),
    ...matches(content, /\bstruct\s+([A-Za-z_][A-Za-z0-9_]*)\b/g),
    ...matches(content, /\btype\s+([A-Za-z_][A-Za-z0-9_]*)\s+struct\b/g),
    ...matches(content, /\b(?:public|private|protected)\s+function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g),
  ])
}

function inferMessageNames(content: string): string[] {
  return unique([
    ...quotedNearKeyword(content, [
      "rpc",
      "call",
      "command",
      "event",
      "message",
      "handler",
      "publish",
      "consume",
      "routing",
      "queue",
      "amqp",
      "rabbit",
    ]),
    ...matches(content, /@(?:EventPattern|MessagePattern)\s*\(\s*["'`]([^"'`]+)["'`]/g),
  ])
}

function inferQueueNames(content: string): string[] {
  return unique([
    ...matches(content, /(?:queue|queueName|queue_name)\s*[:=]\s*["'`]([^"'`]+)["'`]/gi),
    ...matches(content, /(?:assertQueue|QueueDeclare|queue_declare|basic_consume)\s*\(\s*["'`]([^"'`]+)["'`]/gi),
    ...quotedNearKeyword(content, ["queue", "basic_consume", "assertqueue", "queuedeclare"]),
  ])
}

function inferExchangeNames(content: string): string[] {
  return unique([
    ...matches(content, /(?:exchange|exchangeName|exchange_name)\s*[:=]\s*["'`]([^"'`]+)["'`]/gi),
    ...matches(content, /(?:assertExchange|ExchangeDeclare|exchange_declare)\s*\(\s*["'`]([^"'`]+)["'`]/gi),
    ...quotedNearKeyword(content, ["exchange", "basic_publish", "publishexchange"]),
  ])
}

function inferDbTables(content: string): string[] {
  return unique([
    ...matches(content, /\b(?:from|join|into|update|table)\s+[`"']?([A-Za-z_][A-Za-z0-9_.]*)[`"']?/gi),
    ...matches(content, /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?[`"']?([A-Za-z_][A-Za-z0-9_.]*)[`"']?/gi),
    ...matches(content, /@Entity\s*\(\s*["'`]([^"'`]+)["'`]/g),
    ...matches(content, /Schema::(?:create|table)\s*\(\s*["'`]([^"'`]+)["'`]/g),
  ])
}

export function inferRelationshipHints(content: string): RelationshipHints {
  return {
    routes: inferRoutes(content),
    symbols: inferSymbols(content),
    messageNames: inferMessageNames(content),
    queueNames: inferQueueNames(content),
    exchangeNames: inferExchangeNames(content),
    dbTables: inferDbTables(content),
  }
}
