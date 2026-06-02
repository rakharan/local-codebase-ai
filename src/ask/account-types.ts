import type { RetrievedPayload } from "./types.js"
import { escapeRegExp, questionAsksAboutAccountTypes, questionBrokerHint, unique } from "./question.js"

type LocalizeFn = (id: string, en: string) => string

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

export function buildPlatformTypeGlossaryAnswer(
  chunks: RetrievedPayload[],
  question: string,
  localize: LocalizeFn,
): string | undefined {
  if (!/\bplatform_type|platform type|tipe platform\b/i.test(question)) return undefined

  const facts: string[] = []
  const sources: string[] = []
  const accountTypeFacts = extractAccountTypeFacts(chunks, question)

  for (const fact of accountTypeFacts) {
    if (!fact.platformType || !fact.platformName) continue

    facts.push(localize(
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
      facts.push(localize(
        "platform_type 0 dipakai sebagai jalur MT4 di evidence yang ter-index.",
        "platform_type 0 is used as the MT4 path in indexed evidence.",
      ))
      sources.push(source)
    }

    if (/platform_type\s*={0,2}=\s*3/.test(content) || /["']platform_type["']\s*:\s*3/.test(content)) {
      facts.push(localize(
        "platform_type 3 dipakai sebagai jalur MT5 di evidence yang ter-index.",
        "platform_type 3 is used as the MT5 path in indexed evidence.",
      ))
      sources.push(source)
    }

    if (/platform_type\s*={0,2}=\s*5/.test(content) || /["']platform_type["']\s*:\s*5/.test(content)) {
      facts.push(localize(
        "platform_type 5 dipakai sebagai jalur MT5 di evidence yang ter-index.",
        "platform_type 5 is used as the MT5 path in indexed evidence.",
      ))
      sources.push(source)
    }

    if (/platform_type\s*:\s*Joi\.number\(\)\.required/.test(content)) {
      facts.push(localize(
        "platform_type divalidasi sebagai number wajib pada handler/model downstream.",
        "platform_type is validated as a required number in the downstream handler/model.",
      ))
      sources.push(source)
    }

    if (/platform_type\s*:\s*request\.body\.platform_type/.test(content)) {
      facts.push(localize(
        "platform_type diterima dari request body lalu diteruskan ke payload downstream.",
        "platform_type is received from the request body and forwarded into the downstream payload.",
      ))
      sources.push(source)
    }

    if (/platform_type\s*:\s*data\.platform_type/.test(content)) {
      facts.push(localize(
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
    localize("Fakta yang ditemukan tentang platform_type:", "Found facts about platform_type:"),
    uniqueFacts.map(fact => `- ${fact}`).join("\n"),
    "",
    localize("Catatan:", "Notes:"),
    localize(
      "- Mapping di atas hanya berdasarkan source yang ter-retrieve. Jika tiap broker punya mapping tambahan, index repo/dokumentasi broker tersebut lalu tanyakan lagi dengan nama broker spesifik.",
      "- This mapping is based only on retrieved sources. If each broker has additional mapping rules, index that broker's repo/docs and ask again with the broker name.",
    ),
    "",
    "Evidence:",
    uniqueSources.map(source => `- ${source}`).join("\n"),
  ].join("\n")
}

function inferAccountTypeBrokerFromSource(source: string): "mrg" | "askap" | "unknown" {
  const normalized = source.toLowerCase().replace(/\\/g, "/")

  if (normalized.includes("/components/askap/") || normalized.includes("components/askap/") || normalized.includes(" askap/")) return "askap"
  if (normalized.includes("/components/mrg/") || normalized.includes("components/mrg/") || normalized.includes(" mrg/") || normalized.includes("mrg-accounts@")) return "mrg"

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

function extractNamedArraySections(content: string, names: string[]): string[] {
  const sections: string[] = []

  for (const name of names) {
    const namePattern = new RegExp(`\\b${escapeRegExp(name)}\\b`, "g")
    let match: RegExpExecArray | null

    while ((match = namePattern.exec(content))) {
      const startSearch = match.index + name.length
      const openIndex = content.indexOf("[", startSearch)

      if (openIndex === -1) continue

      let depth = 0
      let quote: string | undefined
      let escaped = false

      for (let index = openIndex; index < content.length; index++) {
        const char = content[index]

        if (quote) {
          if (escaped) {
            escaped = false
          } else if (char === "\\") {
            escaped = true
          } else if (char === quote) {
            quote = undefined
          }
          continue
        }

        if (char === "\"" || char === "'" || char === "`") {
          quote = char
          continue
        }

        if (char === "[") depth++
        if (char === "]") depth--

        if (depth === 0) {
          sections.push(content.slice(openIndex + 1, index))
          namePattern.lastIndex = index
          break
        }
      }
    }
  }

  return sections
}

function accountTypeBlocksAroundName(content: string): string[] {
  const lines = content.split(/\r?\n/)
  const blocks: string[] = []

  for (let index = 0; index < lines.length; index++) {
    if (!/["']name["']\s*:/.test(lines[index] ?? "")) continue

    let start = index
    while (start > 0 && !/^\s*\{\s*$/.test(lines[start] ?? "")) {
      start--
    }

    let end = index
    while (end < lines.length - 1 && !/^\s*\},?\s*$/.test(lines[end] ?? "")) {
      end++
    }

    const block = lines.slice(start, end + 1).join("\n")

    if (/["'](?:mindepo|min_first_depo|type_name|group_creation|platform_type|leverage)["']\s*:/.test(block)) {
      blocks.push(block)
    }
  }

  return blocks
}

function readObjectProp(block: string, key: string): string | undefined {
  const quoted = block.match(new RegExp(`["']${escapeRegExp(key)}["']\\s*:\\s*["']([^"']+)["']`))
  if (quoted?.[1]) return quoted[1]

  const bare = block.match(new RegExp(`["']${escapeRegExp(key)}["']\\s*:\\s*([^,\\n\\r]+)`))
  return bare?.[1]?.trim().replace(/,$/, "")
}

function extractSimpleAccountTypeFactsFromContent(content: string, source: string): AccountTypeFact[] {
  const broker = inferAccountTypeBrokerFromSource(source)
  const facts: AccountTypeFact[] = []

  for (const match of content.matchAll(/\{\s*"id"\s*:\s*([^,\n\r]+),\s*"name"\s*:\s*"([^"]+)"[\s\S]*?"mindepo"\s*:\s*([^,\n\r]+)[\s\S]*?"leverage"\s*:\s*"([^"]+)"/g)) {
    facts.push({
      name: match[2] ?? "",
      broker,
      id: match[1]?.trim(),
      platformName: undefined,
      platformType: undefined,
      show: undefined,
      groupCreation: undefined,
      minFirstDepo: match[3]?.trim(),
      leverage: match[4]?.trim(),
      feature: undefined,
      source,
    })
  }

  return facts.filter(fact => fact.name.length > 0)
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
    for (const fact of extractSimpleAccountTypeFactsFromContent(content, source)) {
      if (wantedPlatform) continue
      if (wantedBroker && fact.broker !== "unknown" && fact.broker !== wantedBroker) continue
      facts.push(fact)
    }

    const accountTypeSections = extractNamedArraySections(content, ["accountTypes", "accountTypesV2"])
    const blocks = accountTypeSections.length > 0
      ? accountTypeSections.flatMap(section => [
          ...objectBlocksFromContent(section),
          ...accountTypeBlocksAroundName(section),
        ])
      : [
          ...objectBlocksFromContent(content),
          ...accountTypeBlocksAroundName(content),
        ]

    for (const block of blocks) {
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

function buildAccountTypeBehaviorNotes(chunks: RetrievedPayload[], question: string, localize: LocalizeFn): string[] {
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
    notes.push(localize("Endpoint V2 membaca `config.accountTypesV2`.", "V2 endpoint reads `config.accountTypesV2`."))
  }

  if (wantedBroker === "mrg" && /GetAccountTypesV2/.test(joined) && /GetAccountTypeByUserId/.test(joined)) {
    notes.push(localize(
      "Untuk MRG V2, `ims-tf2` memanggil RPC `GetAccountTypeByUserId`; list finalnya berasal dari service downstream, bukan hanya config lokal.",
      "For MRG V2, `ims-tf2` calls RPC `GetAccountTypeByUserId`; the final list comes from the downstream service, not only local config.",
    ))
  }

  if (wantedBroker === "mrg" && /MetaAccountType\.getPublicAccountTypes/.test(joined)) {
    notes.push(localize(
      "`mrg-accounts` mengambil tipe akun publik dari `MetaAccountType.getPublicAccountTypes` lalu mengembalikan `platform_type`, `type_name`, `group_creation`, `leverage`, dan `min_first_depo`.",
      "`mrg-accounts` reads public account types from `MetaAccountType.getPublicAccountTypes`, then returns `platform_type`, `type_name`, `group_creation`, `leverage`, and `min_first_depo`.",
    ))
  }

  if (/filter\(x\s*=>\s*x\.show\s*==\s*1\)/.test(joined)) {
    notes.push(localize("Endpoint V2 memfilter hanya entry dengan `show == 1`.", "V2 endpoint filters to entries with `show == 1`."))
  }

  if (/TF_CAN_REQUEST_MMB_MT5/.test(joined) && /platform_type\s*!=\s*5/.test(joined)) {
    notes.push(localize(
      "Jika user tidak punya rule `TF_CAN_REQUEST_MMB_MT5`, endpoint V2 membuang entry `platform_type == 5`.",
      "If the user does not have rule `TF_CAN_REQUEST_MMB_MT5`, V2 endpoint removes entries with `platform_type == 5`.",
    ))
  }

  if (/GetAccountTypes\(/.test(joined) && /config\.accountTypes/.test(joined)) {
    notes.push(localize("Endpoint V1 membaca `config.accountTypes`.", "V1 endpoint reads `config.accountTypes`."))
  }

  if (wantedPlatform === "MT5") {
    const mt5Facts = extractAccountTypeFacts(chunks, question)
    if (mt5Facts.length > 0 && mt5Facts.every(fact => fact.show === "0")) {
      notes.push(localize(
        "Di evidence yang ter-retrieve, semua entry MT5 yang terdefinisi punya `show: 0`; jadi tidak keluar dari endpoint V2 normal setelah filter `show == 1`.",
        "In retrieved evidence, every defined MT5 entry has `show: 0`, so it will not be returned by the normal V2 endpoint after the `show == 1` filter.",
      ))
    }
  }

  return unique(notes, 8)
}

export function buildAccountTypeGlossaryAnswer(
  chunks: RetrievedPayload[],
  question: string,
  localize: LocalizeFn,
): string | undefined {
  if (!questionAsksAboutAccountTypes(question)) return undefined

  const facts = extractAccountTypeFacts(chunks, question)
  if (facts.length === 0) return undefined

  const wantedPlatform = accountTypeQuestionPlatform(question)
  const wantedBroker = questionBrokerHint(question)
  const comparesMrgAndAskap = /\bmrg\b/i.test(question) && /\b(mmb|askap)\b/i.test(question)
  const brokerLabel = comparesMrgAndAskap
    ? "MRG and Askap"
    : wantedBroker === "mrg" ? "MRG" : wantedBroker === "askap" ? "MMB/Askap" : "broker"
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

  const behaviorNotes = buildAccountTypeBehaviorNotes(chunks, question, localize)
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
  const title = localize(
    `Tipe akun ${brokerLabel}${wantedPlatform ? ` ${wantedPlatform}` : ""} yang ${allPrimaryHidden ? "terdefinisi di config" : "ditemukan"}:`,
    `${brokerLabel}${wantedPlatform ? ` ${wantedPlatform}` : ""} account types ${allPrimaryHidden ? "defined in config" : "found"}:`,
  )

  return [
    title,
    primaryFacts.map(describeFact).join("\n"),
    hidden.length > 0 && visible.length > 0
      ? [
          "",
          localize("Entry yang terdefinisi tapi tidak visible (`show: 0`):", "Defined but hidden entries (`show: 0`):"),
          hidden.map(describeFact).join("\n"),
        ].join("\n")
      : undefined,
    behaviorNotes.length > 0
      ? [
          "",
          localize("Perilaku endpoint/config yang relevan:", "Relevant endpoint/config behavior:"),
          behaviorNotes.map(note => `- ${note}`).join("\n"),
        ].join("\n")
      : undefined,
    "",
    "Evidence:",
    sources.map(source => `- ${source}`).join("\n"),
  ].filter((line): line is string => typeof line === "string").join("\n")
}

export function accountTypeRelevantSourceChunks(chunks: RetrievedPayload[], question: string): RetrievedPayload[] {
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

export function buildAccountTypeNotFoundAnswer(question: string, localize: LocalizeFn): string {
  const broker = questionBrokerHint(question)
  const brokerText = broker === "mrg" ? "MRG" : broker === "askap" ? "MMB/Askap" : "broker yang diminta"

  return localize(
    `NOT_FOUND_IN_INDEXED_CODEBASE: Saya tidak menemukan source ter-index yang mendefinisikan list tipe akun ${brokerText} untuk pertanyaan ini. Saya tidak memakai fallback dokumentasi umum karena pertanyaannya meminta account type spesifik.`,
    `NOT_FOUND_IN_INDEXED_CODEBASE: I did not find indexed source defining the requested ${broker === "mrg" ? "MRG" : broker === "askap" ? "MMB/Askap" : "broker"} account type list. I did not use generic documentation fallback because the question asks for specific account types.`,
  )
}
