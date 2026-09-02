export type StructuredFact = {
  category: "validation" | "input" | "return" | "formula" | "constant" | "database" | "message" | "config" | "control_flow"
  text: string
  confidence: "confirmed" | "derived"
  line: number
}

const factPatterns: Array<{
  category: StructuredFact["category"]
  pattern: RegExp
}> = [
  { category: "validation", pattern: /validationError|Joi\.|check\(|validator|validate|throw new|MissingRequestError|Unauthorized|Forbidden/i },
  { category: "input", pattern: /\b(?:request|req)\.(?:body|query|params)|\$_(?:POST|GET|REQUEST)|input\(|bodyParser/i },
  { category: "return", pattern: /\breturn\b|res\.json|response\.json|reply\.send|echo\s+json_encode/i },
  { category: "formula", pattern: />=|<=|===|!==|\+\+|--|\bMath\.|max\(|min\(|\*\s*[a-zA-Z_][\w.]*/i },
  { category: "constant", pattern: /\b(?:const|let|var)\s+[A-Z0-9_]{3,}|\b[A-Z0-9_]{3,}\s*[:=]/ },
  { category: "database", pattern: /\bselect\b|\binsert\b|\bupdate\b|\bdelete\b|\bfrom\b|\bjoin\b|\.query\(|createQueryBuilder|table\(/i },
  { category: "message", pattern: /amqp|rabbit|queue|exchange|routingKey|publish|consume|sendToQueue|assertQueue|rpc/i },
  { category: "config", pattern: /process\.env|config\.|\.env|module\.exports|exports\./i },
  { category: "control_flow", pattern: /\bif\s*\(|\bswitch\s*\(|\bcase\b|\belse\b/i },
]

function normalizeFactLine(line: string): string {
  return line
    .trim()
    .replace(/\s+/g, " ")
    .replace(/,$/, "")
}

function isNoisyFactLine(line: string): boolean {
  return line.length < 12 ||
    line.length > 220 ||
    /^\s*(\/\/|#)/.test(line) ||          // line comment markers
    /^\s*\/\*/.test(line) ||               // block comment start
    /^\s*\*\s/.test(line) ||               // block comment continuation (JSDoc)
    /^#[0-9a-f]{3,8}\s*(!important)?/i.test(line) ||  // CSS hex colors
    /!important/i.test(line) ||             // CSS !important
    /^\s*(import|require)\s+/.test(line) || // import/require statements
    /^\s*<\/?[a-z]/i.test(line) ||          // HTML tags
    /console\.log|describe\(|it\(|expect\(|logger\.|\/\/\s*todo/i.test(line)
}

export function extractStructuredFacts(content: string, startLine = 1, maxFacts = 24): StructuredFact[] {
  const facts: StructuredFact[] = []
  const seen = new Set<string>()
  const lines = content.split(/\r?\n/)

  for (let index = 0; index < lines.length; index++) {
    const line = normalizeFactLine(lines[index] ?? "")
    if (isNoisyFactLine(line)) continue

    const matched = factPatterns.find(({ pattern }) => pattern.test(line))
    if (!matched) continue

    const key = `${matched.category}:${line.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)

    facts.push({
      category: matched.category,
      text: line,
      confidence: matched.category === "formula" || matched.category === "control_flow" ? "derived" : "confirmed",
      line: startLine + index,
    })

    if (facts.length >= maxFacts) break
  }

  return facts
}
