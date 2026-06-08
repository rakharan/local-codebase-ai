export function unique(values: string[], max = 12): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].slice(0, max)
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function extractQuestionAcronyms(question: string): string[] {
  return unique(
    [...question.matchAll(/\b[A-Z][A-Z0-9]{1,6}\b/g)].map(match => (match[0] ?? "").toLowerCase()),
    8,
  )
}

export function extractShortSubjectTokens(question: string): string[] {
  const stopWords = new Set([
    "ai",
    "an",
    "apa",
    "as",
    "at",
    "dan",
    "di",
    "do",
    "go",
    "how",
    "if",
    "in",
    "is",
    "it",
    "itu",
    "ke",
    "of",
    "on",
    "or",
    "saja",
    "to",
    "the",
    "was",
    "ya",
  ])

  return unique(
    question
      .toLowerCase()
      .split(/[^a-z0-9_]+/g)
      .map(token => token.trim())
      .filter(token => /^[a-z][a-z0-9]{1,3}$/.test(token))
      .filter(token => !stopWords.has(token)),
    8,
  )
}

export function extractDefinitionSubjectTerms(question: string): string[] {
  const terms: string[] = []

  for (const match of question.matchAll(/\b(?:apa itu|what is|maksud(?:\s+dari)?|meaning(?:\s+of)?|define|definition(?:\s+of)?)\s+([A-Za-z0-9_-]{2,}(?:\s+[A-Za-z0-9_-]{2,})?)/gi)) {
    const phrase = (match[1] ?? "").trim()

    if (!phrase) continue

    terms.push(phrase.toLowerCase())
    terms.push(...phrase.toLowerCase().split(/[^a-z0-9_]+/g).filter(token => token.length >= 2))
  }

  return unique(terms, 12)
}

export function extractQuestionHints(question: string): string[] {
  return unique([
    ...[...question.matchAll(/\/[A-Za-z0-9_./:{}-]+/g)].map(match => match[0]),
    ...[...question.matchAll(/\b[a-z][a-z0-9]+(?:-[a-z0-9]+){1,}\b/g)].map(match => match[0]),
    ...[...question.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*\b/g)].map(match => match[0]),
    ...[...question.matchAll(/\b[A-Z][A-Za-z0-9_]{2,}\b/g)]
      .map(match => match[0])
      .filter(value => !["What", "When", "Where", "Which", "How", "Does"].includes(value)),
    ...[...question.matchAll(/["'`]([^"'`]{2,80})["'`]/g)].map(match => match[1] ?? ""),
  ])
}

export function extractQuestionRoutes(question: string): string[] {
  return unique(
    [...question.matchAll(/\/[A-Za-z0-9_./:{}-]+/g)].map(match => match[0]),
    10,
  )
}

export function extractConceptTokens(question: string): string[] {
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
    "money",
    "web",
    "mt4",
    "mt5",
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
    ["requesst", "request"],
    ["akkount", "account"],
    ["acct", "account"],
    ["accounts", "account"],
    ["requests", "request"],
    ["imstf", "ims-tf"],
  ])

  const acronymTokens = extractQuestionAcronyms(question)
  const conceptTokens = question
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .map(token => token.trim())
    .map(token => aliases.get(token) ?? token)
    .filter(token => token.length >= 3)
    .filter(token => !stopWords.has(token))

  return unique(
    [
      ...conceptTokens,
      ...acronymTokens,
    ],
    8,
  )
}

export function questionAsksAboutDatabase(question: string): boolean {
  return /\b(database|databases|table|tables|sql|affected|insert|update|delete|select)\b/i.test(question)
}

export function questionAsksAboutServicesOrFlow(question: string): boolean {
  return /\b(service|services|repo|repos|flow|involved|calls?|publishes?|consumes?|rpc|amqp|rabbitmq|queue|exchange|routes?|endpoints?)\b/i.test(question)
}

export function questionAsksAboutGlossary(question: string): boolean {
  return /\b(apa itu|what is|maksud|meaning|explain|describe|jelasin|jelaskan|how .*works?|how does .*work|cara kerja|gimana .*kerja|bagaimana .*kerja|glossary|glosarium|list|daftar|berikan|tipe akun|account type|aturan|rules?|rule|ketentuan|business rules?|syarat|persyaratan|dibutuhkan|onboard|onboarding|panduan|guide|platform_type|platform type|isignal)\b/i.test(question)
}

export function questionAsksHowWorks(question: string): boolean {
  return /\b(how .*works?|how does .*work|cara kerja|gimana .*kerja|bagaimana .*kerja)\b/i.test(question)
}

export function questionAsksInventory(question: string): boolean {
  return /\b(what services|services? (detected|list|available)|detected (services?|repos?)|list.*(services?|repos?)|environment variables?|env vars?|process\.env|what env|which env|database tables?|db tables?|which tables?|what tables?|tables? (used|detected))\b/i.test(question)
}

export function questionAsksForDiagram(question: string): boolean {
  return /\b(flowchart|diagram|mermaid|sequence diagram|sequenceDiagram|visuali[sz]e|gambar(?:kan)? alur|buat(?:kan)? diagram|buat(?:kan)? flowchart|alur visual)\b/i.test(question)
}

export function questionAsksAboutAccountTypes(question: string): boolean {
  return /\b(tipe akun|jenis akun|account types?|account_type|accountTypes|accountTypesV2)\b/i.test(question)
}

export function questionMetaTraderTerm(question: string): "MT4" | "MT5" | undefined {
  const lower = question.toLowerCase()

  // If the question asks about a flow/deposit/feature that merely mentions MT4/MT5 as a destination,
  // do NOT short-circuit to the MetaTrader definition answer.
  const flowContextTerms = [
    "flow",
    "how does",
    "how do",
    "deposit",
    "withdraw",
    "transfer",
    "from",
    "to ",
    "endpoint",
    "route",
    "handler",
    "controller",
    "service",
    "consume",
    "publish",
    "queue",
    "function",
    "method",
  ]
  const hasFlowContext = flowContextTerms.some(term => lower.includes(term))

  if (/\bmt4\b/i.test(question) && !hasFlowContext) return "MT4"
  if (/\bmt5\b/i.test(question) && !hasFlowContext) return "MT5"

  return undefined
}

export function questionAsksMedalMechanism(question: string): boolean {
  return /\b(medal|medals|level|rank)\b/i.test(question) &&
    /\b(how|gain|gained|get|earn|earned|increase|naik|menaikkan|dapat|dapet|mendapat|persyaratan|syarat|requirement|requirements|cara)\b/i.test(question)
}

export function questionBrokerHint(question: string): "mrg" | "askap" | undefined {
  const mentionsMrg = /\bmrg\b/i.test(question)
  const mentionsAskap = /\b(mmb|askap)\b/i.test(question)

  if (mentionsMrg && mentionsAskap) return undefined
  if (mentionsMrg) return "mrg"
  if (mentionsAskap) return "askap"

  return undefined
}
