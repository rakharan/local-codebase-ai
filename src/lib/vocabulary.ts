export type TermDefinition = {
  term: string
  group: string
  kind: "enum" | "range" | "constant" | "array" | "map"
  value?: string
  properties?: Record<string, string>
}

export type VocabularyGroup = {
  groupName: string
  kind: "enum" | "range" | "constant" | "array" | "map"
  terms: TermDefinition[]
  sourceFile: string
  contextLines: string
}

function isLikelyConfigName(name: string): boolean {
  return /^[A-Z][A-Za-z0-9_]{1,}[A-Z_]$/.test(name) ||
    /^(RANGE|MAP|CONFIG|STATUS|TYPE|LEVEL|MODE|SETTING|CONST|ENUM)/i.test(name) ||
    /^[a-z][a-z0-9_]*(?:_map|_config|_types|_status|_levels|_modes|_settings)$/i.test(name)
}

function normalizeValue(value: string): string {
  return value.trim().replace(/^["'`]|["'`]$/g, "")
}

export function extractVocabulary(filePath: string, content: string): VocabularyGroup[] {
  const groups: VocabularyGroup[] = []
  const lines = content.split("\n")

  // Pattern 1: JS/TS object literal with array/numeric/string values
  // const RANGE_MEDAL = { newbie: [0], rookie: [1,2], pro: [3,4] }
  // const STATUS = { PENDING: 0, ACTIVE: 1, EXPIRED: 2 }
  const objPattern = /(?:const|let|var|export\s+const)\s+([A-Za-z_$][\w$]*)\s*=\s*\{([\s\S]*?)\n\s*\}/g

  for (const match of content.matchAll(objPattern)) {
    const groupName = match[1] ?? ""
    const body = match[2] ?? ""

    if (!isLikelyConfigName(groupName)) continue

    const entries: TermDefinition[] = []
    let hasArrayValues = false
    let hasNumericValues = false
    let hasStringValues = false

    // Extract key-value pairs line by line to handle arrays with commas
    for (const line of body.split("\n")) {
      const entryMatch = line.match(/["']?([A-Za-z_$][\w$]*)["']?\s*:\s*(.+)/)

      if (!entryMatch) continue

      const key = entryMatch[1]?.trim() ?? ""
      const rawValue = entryMatch[2]?.trim().replace(/,\s*$/, "") ?? ""

      if (!key || key === "name" || key === "label") continue

      const normalizedValue = normalizeValue(rawValue)
      entries.push({ term: key, group: groupName, kind: "constant", value: normalizedValue })

      if (/^\[/.test(rawValue)) hasArrayValues = true
      if (/^\d+/.test(rawValue)) hasNumericValues = true
      if (/^["'`]/.test(rawValue)) hasStringValues = true
    }

    // Deduplicate terms by term name
  const uniqueEntries = entries.filter((entry, index, self) =>
    index === self.findIndex(e => e.term === entry.term)
  )

  if (uniqueEntries.length < 3) continue

    const kind = hasArrayValues ? "range" : hasNumericValues ? "enum" : hasStringValues ? "enum" : "map"

    // Find context lines
    const startIdx = match.index ?? 0
    const startLine = content.slice(0, startIdx).split("\n").length
    const endLine = startLine + match[0].split("\n").length - 1
    const contextLines = lines.slice(Math.max(0, startLine - 1), Math.min(lines.length, endLine)).join("\n")

    groups.push({
      groupName,
      kind,
      terms: uniqueEntries,
      sourceFile: filePath,
      contextLines,
    })
  }

  // Pattern 2: Inline object property with array/numeric values
  // RANGE_MEDAL: { newbie: [0], rookie: [1,2] }
  const inlinePattern = /([A-Za-z_$][\w$]*)\s*:\s*\{([\s\S]*?)\n\s*\}/g

  for (const match of content.matchAll(inlinePattern)) {
    const groupName = match[1] ?? ""
    const body = match[2] ?? ""

    if (!isLikelyConfigName(groupName)) continue

    // Skip if already captured as part of Pattern 1
    const alreadyCaptured = groups.some(g => g.groupName === groupName && g.sourceFile === filePath)
    if (alreadyCaptured) continue

    const entries: TermDefinition[] = []
    let hasArrayValues = false
    let hasNumericValues = false

    for (const line of body.split("\n")) {
      const entryMatch = line.match(/["']?([A-Za-z_$][\w$]*)["']?\s*:\s*(.+)/)

      if (!entryMatch) continue

      const key = entryMatch[1]?.trim() ?? ""
      const rawValue = entryMatch[2]?.trim().replace(/,\s*$/, "") ?? ""

      if (!key || key === "name" || key === "label") continue

      const normalizedValue = normalizeValue(rawValue)
      entries.push({ term: key, group: groupName, kind: "constant", value: normalizedValue })

      if (/^\[/.test(rawValue)) hasArrayValues = true
      if (/^\d+/.test(rawValue)) hasNumericValues = true
    }

    // Deduplicate terms by term name
  const uniqueEntries = entries.filter((entry, index, self) =>
    index === self.findIndex(e => e.term === entry.term)
  )

  if (uniqueEntries.length < 3) continue

    const kind = hasArrayValues ? "range" : hasNumericValues ? "enum" : "map"

    const startIdx = match.index ?? 0
    const startLine = content.slice(0, startIdx).split("\n").length
    const endLine = startLine + match[0].split("\n").length - 1
    const contextLines = lines.slice(Math.max(0, startLine - 1), Math.min(lines.length, endLine)).join("\n")

    groups.push({
      groupName,
      kind,
      terms: uniqueEntries,
      sourceFile: filePath,
      contextLines,
    })
  }

  // Pattern 3: Array constants
  // const ACCOUNT_TYPES = ['basic', 'silver', 'gold', 'premium']
  const arrayPattern = /(?:const|let|var|export\s+const)\s+([A-Za-z_$][\w$]*)\s*=\s*\[([\s\S]*?)\]/g

  for (const match of content.matchAll(arrayPattern)) {
    const groupName = match[1] ?? ""
    const body = match[2] ?? ""

    if (!isLikelyConfigName(groupName)) continue

    const entries: TermDefinition[] = []

    for (const itemMatch of body.matchAll(/["'`]([A-Za-z_$][\w$]*)["'`]/g)) {
      const term = itemMatch[1]
      if (term) {
        entries.push({ term, group: groupName, kind: "constant" })
      }
    }

    // Deduplicate terms by term name
  const uniqueEntries = entries.filter((entry, index, self) =>
    index === self.findIndex(e => e.term === entry.term)
  )

  if (uniqueEntries.length < 3) continue

    const startIdx = match.index ?? 0
    const startLine = content.slice(0, startIdx).split("\n").length
    const endLine = startLine + match[0].split("\n").length - 1
    const contextLines = lines.slice(Math.max(0, startLine - 1), Math.min(lines.length, endLine)).join("\n")

    groups.push({
      groupName,
      kind: "array",
      terms: uniqueEntries,
      sourceFile: filePath,
      contextLines,
    })
  }

  // Pattern 5: Array of objects with name/label field
  // POINT_LEVELS: [ { "name": "Legend", "minMedal": 13, "maxMedal": 14 }, ... ]
  const arrayOfObjectsPattern = /(?:const|let|var|export\s+const)?\s*([A-Za-z_$][\w$]*)\s*[:=]\s*\[([\s\S]*?)\n\s*\]/g

  for (const match of content.matchAll(arrayOfObjectsPattern)) {
    const groupName = match[1] ?? ""
    const body = match[2] ?? ""

    if (!isLikelyConfigName(groupName)) continue

    const entries: TermDefinition[] = []

    for (const objectBlock of body.matchAll(/\{([\s\S]*?)\}/g)) {
      const block = objectBlock[1] ?? ""
      const nameMatch = block.match(/["']?name["']?\s*:\s*["']([^"']+)["']/)
      const term = nameMatch?.[1]

      if (!term) continue

      const properties: Record<string, string> = {}

      for (const line of block.split("\n")) {
        const propMatch = line.match(/["']?([A-Za-z_$][\w$]*)["']?\s*:\s*(.+)/)

        if (!propMatch) continue

        const key = propMatch[1]?.trim() ?? ""
        const rawValue = propMatch[2]?.trim().replace(/,\s*$/, "") ?? ""

        if (!key || key === "name" || key === "label") continue
        if (rawValue.includes("{")) continue

        properties[key] = normalizeValue(rawValue)
      }

      if (Object.keys(properties).length === 0) continue

      entries.push({ term, group: groupName, kind: "range", properties })
    }

    const uniqueEntries = entries.filter((entry, index, self) =>
      index === self.findIndex(e => e.term === entry.term)
    )

    if (uniqueEntries.length < 2) continue

    const startIdx = match.index ?? 0
    const startLine = content.slice(0, startIdx).split("\n").length
    const endLine = startLine + match[0].split("\n").length - 1
    const contextLines = lines.slice(Math.max(0, startLine - 1), Math.min(lines.length, endLine)).join("\n")

    groups.push({
      groupName,
      kind: "range",
      terms: uniqueEntries,
      sourceFile: filePath,
      contextLines,
    })
  }

  // Pattern 4: PHP array()
  // $LEVELS = array('newbie' => [0], 'rookie' => [1,2])
  const phpArrayPattern = /\$([A-Za-z_][\w$]*)\s*=\s*array\s*\(([\s\S]*?)\)/g

  for (const match of content.matchAll(phpArrayPattern)) {
    const groupName = match[1] ?? ""
    const body = match[2] ?? ""

    if (!isLikelyConfigName(groupName)) continue

    const entries: TermDefinition[] = []
    let hasArrayValues = false
    let hasNumericValues = false

    for (const line of body.split("\n")) {
      const entryMatch = line.match(/["'`]([A-Za-z_$][\w$]*)["'`]\s*=>\s*(.+)/)

      if (!entryMatch) continue

      const key = entryMatch[1]?.trim() ?? ""
      const rawValue = entryMatch[2]?.trim().replace(/,\s*$/, "") ?? ""

      if (!key) continue

      const normalizedValue = normalizeValue(rawValue)
      entries.push({ term: key, group: groupName, kind: "constant", value: normalizedValue })

      if (/^\[/.test(rawValue) || /^array\(/.test(rawValue)) hasArrayValues = true
      if (/^\d+/.test(rawValue)) hasNumericValues = true
    }

    // Deduplicate terms by term name
  const uniqueEntries = entries.filter((entry, index, self) =>
    index === self.findIndex(e => e.term === entry.term)
  )

  if (uniqueEntries.length < 3) continue

    const kind = hasArrayValues ? "range" : hasNumericValues ? "enum" : "map"

    const startIdx = match.index ?? 0
    const startLine = content.slice(0, startIdx).split("\n").length
    const endLine = startLine + match[0].split("\n").length - 1
    const contextLines = lines.slice(Math.max(0, startLine - 1), Math.min(lines.length, endLine)).join("\n")

    groups.push({
      groupName,
      kind,
      terms: uniqueEntries,
      sourceFile: filePath,
      contextLines,
    })
  }

  return groups
}

export function buildGlossaryContent(group: VocabularyGroup): string {
  const termList = group.terms.map(t => {
    const value = t.value ? `: ${t.value}` : ""
    const props = t.properties
      ? Object.entries(t.properties).map(([k, v]) => `    ${k}: ${v}`).join("\n")
      : ""
    return `- ${t.term}${value}${props ? "\n" + props : ""}`
  }).join("\n")

  return [
    `Vocabulary: ${group.groupName}`,
    `Kind: ${group.kind}`,
    `Source: ${group.sourceFile}`,
    `Terms:`,
    termList,
    ``,
    `Context:`,
    "```",
    group.contextLines,
    "```",
  ].join("\n")
}

export function extractQuestionTerms(question: string): string[] {
  const lower = question.toLowerCase()

  // Extract candidate terms that look like config values
  const matches = [
    ...lower.matchAll(/\b([a-z][a-z0-9_]{2,})\b/g),
  ]

  const stopWords = new Set([
    "what", "is", "are", "the", "how", "does", "work", "does", "do", "can",
    "you", "tell", "explain", "describe", "show", "give", "list", "and", "or",
    "from", "for", "with", "about", "using", "this", "that", "these", "those",
    "need", "want", "like", "know", "help", "please", "question", "answer",
    "requirements", "syarat", "ketentuan", "aturan", "rules", "become", "jadi",
    "menjadi", "maksud", "meaning", "definition", "definisi", "apa", "itu",
    "yang", "dan", "atau", "dari", "untuk", "dengan", "di", "ke", "pada",
    "dalam", "oleh", "saya", "kamu", "mereka", "kita", "ada", "tidak", "bisa",
    "adalah", "merupakan", "sebagai", "salah", "satu", "dua", "tiga", "empat",
    "lima", "enam", "tujuh", "delapan", "sembilan", "sepuluh", "codebase",
    "repository", "repo", "project", "service", "endpoint", "flow", "function",
  ])

  return [...new Set(matches.map(m => m[1]).filter((t): t is string => Boolean(t)))]
    .filter(term => term.length >= 3 && !stopWords.has(term))
    .slice(0, 20)
}
