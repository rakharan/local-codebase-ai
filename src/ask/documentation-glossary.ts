// Documentation Glossary

import type { RetrievedPayload } from "./types.js"
import { ctx } from "./context.js"
import { localized, shouldAnswerIndonesian } from "../ask.js"
import { retrieveFileChunks } from "./retrieve.js"
import { cleanDocSummaryText, renderDocSummaryText, scoreDocLocalePreference } from "./specialized-answers.js"
import { escapeRegExp, extractConceptTokens, extractDefinitionSubjectTerms, extractQuestionAcronyms, extractShortSubjectTokens, questionAsksAboutAccountTypes, questionAsksAboutGlossary, questionAsksForDiagram, questionAsksHowWorks, unique } from "./question.js"
import { questionAsksForCronListing } from "./metadata-answers.js"

export async function buildDocumentationGlossaryAnswer(chunks: RetrievedPayload[], question: string): Promise<string | undefined> {
  if (!questionAsksAboutGlossary(question)) return undefined
  if (questionAsksAboutAccountTypes(question)) return undefined
  if (questionAsksForDiagram(question)) return undefined

  const lowerQuestion = question.toLowerCase()
  const asksRules = /\b(aturan|rules?|rule|ketentuan|business rules?)\b/i.test(question)
  const asksDefinition = /\b(apa itu|what is|maksud|meaning|define|definition|explain|describe|jelasin|jelaskan|glossary|glosarium)\b/i.test(question)
  const asksHowWorks = questionAsksHowWorks(question)
  const asksGuide = /\b(onboard|onboarding|guide|panduan)\b/i.test(question)
  const asksCron = questionAsksForCronListing(question)
  const asksOverview = asksDefinition || asksHowWorks || asksGuide
  const asksGlossaryExplicitly = /\b(glossary|glosarium|glossarium)\b/i.test(question)
  const subjectTerms = unique([
    ...extractConceptTokens(question),
    ...extractDefinitionSubjectTerms(question),
    ...extractQuestionAcronyms(question),
    ...extractShortSubjectTokens(question),
    ...ctx.registryExpansion.terms.filter(term => term.length >= 4),
  ], 24).map(term => term.toLowerCase())
  const explicitSubjectTerms = unique([
    ...extractDefinitionSubjectTerms(question),
    ...extractQuestionAcronyms(question),
    ...extractShortSubjectTokens(question),
  ], 12).map(term => term.toLowerCase())
  const shortDefinitionTerms = asksDefinition
    ? explicitSubjectTerms.filter(term => term.length >= 2 && term.length <= 4)
    : []
  const asksShortDefinition = asksDefinition && shortDefinitionTerms.length > 0
  function mentionsExactSubject(text: string, terms = shortDefinitionTerms): boolean {
    return terms.some(term => {
      const escaped = escapeRegExp(term)

      return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text)
    })
  }
  const asksFinancialAdvisor = subjectTerms.includes("fa") ||
    subjectTerms.includes("financial advisor") ||
    /\b(financial advisor|penasihat keuangan|fa porto)\b/i.test(question)
  const matchingDocChunks = chunks.filter(chunk => {
    if (!chunk.evidenceTypes?.includes("documentation")) return false

    // When asking about FA, exclude devops-docs and legacy-archives chunks — they
    // often contain "Legacy Archives" text that the LLM quotes verbatim as product info.
    if (asksFinancialAdvisor) {
      const fp = chunk.filePath?.toLowerCase() ?? ""
      if (fp.includes("devops-docs")) return false
      if (fp.includes("legacy-archives")) return false
      if (/legacy archives/i.test(chunk.content ?? "")) return false
    }

    const text = [
      chunk.filePath ?? "",
      chunk.content ?? "",
      ...(chunk.symbols ?? []),
      ...(chunk.messageNames ?? []),
    ].join("\n").toLowerCase()

    if (asksShortDefinition && !asksFinancialAdvisor) {
      return mentionsExactSubject(text)
    }

    return subjectTerms.some(term => {
      const normalizedTerm = term.toLowerCase()

      if (normalizedTerm.length <= 2) {
        return new RegExp(`\\b${escapeRegExp(normalizedTerm)}\\b`, "i").test(text)
      }

      return text.includes(normalizedTerm)
    })
  })

  function isTopLevelIndexPath(filePath: string): boolean {
    return /docs:[^/\\]+[/\\]index\.mdx?$/.test(filePath.toLowerCase())
  }

  function score(chunk: RetrievedPayload): number {
    const filePath = chunk.filePath?.toLowerCase() ?? ""
    const repoName = chunk.repoName?.toLowerCase() ?? ""
    const content = chunk.content?.toLowerCase() ?? ""
    let value = 0

    if (subjectTerms.includes("isignal")) {
      if (filePath.includes("isignal-docs")) value += 40
      if (repoName.includes("isignal")) value += 20
      if (content.includes("auto copy")) value += 10
      if (asksOverview && isTopLevelIndexPath(filePath)) value += 90
      // Penalize unrelated product docs when asking specifically about isignal
      if (filePath.includes("fa-porto-docs")) value -= 80
      if (filePath.includes("devops-docs")) value -= 60
    }

    if (asksFinancialAdvisor) {
      if (filePath.includes("fa-porto-docs")) value += 100
      if (content.includes("financial advisor") || content.includes("penasihat keuangan")) value += 60
      if (asksOverview && isTopLevelIndexPath(filePath)) value += 90
      if (filePath.includes("isignal-docs")) value -= 80
      if (filePath.includes("devops-docs")) value -= 120
      if (filePath.includes("glossarium") || filePath.includes("glossary")) value -= asksGlossaryExplicitly ? 0 : 35
    }

    value += scoreDocLocalePreference(chunk)
    if (asksGuide) {
      if (filePath.includes("onboarding") || filePath.includes("guide")) value += 260
      if (filePath.includes("cron") || filePath.includes("business-rules") || filePath.includes("architecture")) value -= 70
      if (content.includes("onboarding") || content.includes("panduan")) value += 45
    }
    if (filePath.includes("flow")) value += asksHowWorks ? 45 : 0
    if (filePath.includes("business-rules") || filePath.includes("rules")) value += asksRules ? 260 : asksHowWorks ? 14 : 0
    if (filePath.includes("architecture")) value += asksHowWorks ? 12 : 0
    if (filePath.includes("glossarium") || filePath.includes("glossary")) value += asksOverview ? asksGlossaryExplicitly ? 18 : -60 : 4
    if (filePath.endsWith("index.mdx") || filePath.endsWith("index.md")) value += asksRules ? 0 : 18
    if (asksOverview && /\ballows users to automatically|memungkinkan pengguna|pengenalan|overview|tujuan utama|core purpose|internal documentation for|dokumentasi internal|end-to-end|signal ingestion|pengolahan sinyal/i.test(content)) value += 35
    if (!asksCron && (filePath.includes("cron") || content.includes("croncheck"))) value -= asksHowWorks ? 60 : 160
    if (asksOverview && filePath.includes("diagram")) value -= asksHowWorks ? 8 : 25
    if (!asksRules && filePath.includes("business-rules")) value -= asksDefinition ? 8 : 0

    return value
  }

  const sortedDocChunks = matchingDocChunks.sort((left, right) => score(right) - score(left))

  let docChunks = asksOverview
    ? sortedDocChunks.filter(chunk => {
        const filePath = chunk.filePath?.toLowerCase() ?? ""
        const content = chunk.content?.toLowerCase() ?? ""
        const isTopLevelIndex = isTopLevelIndexPath(filePath)

        if (asksShortDefinition && !asksFinancialAdvisor && !mentionsExactSubject(`${filePath}\n${content}`)) {
          return false
        }

        return isTopLevelIndex ||
          (asksGuide && (filePath.includes("onboarding") || filePath.includes("guide"))) ||
          (asksGlossaryExplicitly && (filePath.includes("glossarium") || filePath.includes("glossary"))) ||
          (asksRules && (filePath.includes("business-rules") || filePath.includes("rules"))) ||
          (asksHowWorks && (filePath.includes("flow") || filePath.includes("business-rules") || filePath.includes("architecture"))) ||
          content.includes("allows users to automatically") ||
          content.includes("memungkinkan pengguna")
      })
    : sortedDocChunks

  if (asksShortDefinition && !asksFinancialAdvisor && docChunks.length === 0) {
    const subject = shortDefinitionTerms[0]?.toUpperCase() ?? explicitSubjectTerms[0] ?? "term"

    return localized(
      `Saya tidak menemukan definisi ${subject} yang eksplisit di indexed code/docs. Registry hanya punya alias untuk membantu retrieval, tapi itu bukan evidence definisi.`,
      `I did not find an explicit ${subject} definition in indexed code/docs. The registry only has aliases for retrieval, but that is not definition evidence.`,
    )
  }

  if (!asksOverview && asksRules) {
    const fullRuleChunks: RetrievedPayload[] = []
    const ruleRefs = sortedDocChunks
      .filter(chunk => {
        const filePath = chunk.filePath?.toLowerCase() ?? ""

        return chunk.repoName && chunk.branchName && chunk.filePath && (filePath.includes("business-rules") || filePath.includes("rules"))
      })
      .slice(0, 4)

    for (const ref of ruleRefs) {
      const fileChunks = await retrieveFileChunks(ref.repoName ?? "", ref.branchName ?? "", ref.filePath ?? "")
      fullRuleChunks.push(...fileChunks.map(chunk => chunk.payload))
    }

    const byKey = new Map<string, RetrievedPayload>()

    for (const chunk of [...fullRuleChunks, ...docChunks]) {
      const key = chunk.contentHash ?? [chunk.repoName, chunk.branchName, chunk.filePath, chunk.startLine, chunk.endLine].join(":")
      if (!byKey.has(key)) byKey.set(key, chunk)
    }

    docChunks = [...byKey.values()].sort((left, right) => {
      const scoreDifference = score(right) - score(left)

      if (Math.abs(scoreDifference) > 50) return scoreDifference

      const leftFile = left.filePath ?? ""
      const rightFile = right.filePath ?? ""

      if (leftFile !== rightFile) return leftFile.localeCompare(rightFile)

      return (left.startLine ?? 0) - (right.startLine ?? 0)
    })
  }

  if (asksOverview) {
    const fullIndexChunks: RetrievedPayload[] = []
    const fullRuleChunks: RetrievedPayload[] = []
    const topIndexRefs = sortedDocChunks
      .filter(chunk => chunk.repoName && chunk.branchName && chunk.filePath && isTopLevelIndexPath(chunk.filePath))
      .slice(0, 4)
    const ruleRefs = asksRules
      ? sortedDocChunks
          .filter(chunk => {
            const filePath = chunk.filePath?.toLowerCase() ?? ""

            return chunk.repoName && chunk.branchName && chunk.filePath && (filePath.includes("business-rules") || filePath.includes("rules"))
          })
          .slice(0, 4)
      : []

    for (const ref of topIndexRefs) {
      const fileChunks = await retrieveFileChunks(ref.repoName ?? "", ref.branchName ?? "", ref.filePath ?? "")
      fullIndexChunks.push(...fileChunks.map(chunk => chunk.payload))
    }

    for (const ref of ruleRefs) {
      const fileChunks = await retrieveFileChunks(ref.repoName ?? "", ref.branchName ?? "", ref.filePath ?? "")
      fullRuleChunks.push(...fileChunks.map(chunk => chunk.payload))
    }

    const byKey = new Map<string, RetrievedPayload>()

    for (const chunk of [...fullIndexChunks, ...fullRuleChunks, ...docChunks]) {
      const key = chunk.contentHash ?? [chunk.repoName, chunk.branchName, chunk.filePath, chunk.startLine, chunk.endLine].join(":")
      if (!byKey.has(key)) byKey.set(key, chunk)
    }

    docChunks = [...byKey.values()].sort((left, right) => score(right) - score(left))
  }

  if (docChunks.length === 0) return undefined

  const facts: string[] = []
  const maxFacts = asksOverview && asksRules ? 40 : asksOverview ? 8 : asksRules ? 30 : 14

  for (const chunk of docChunks) {
    const lines = (chunk.content ?? "")
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .filter(line => !/^(Documentation|Source|Locale|title|description|file):/i.test(line))

    for (const line of lines) {
      const lowerLine = line.toLowerCase()
      const isHeader = /^#{1,4}\s+/.test(line)
      const isListOrTable = /^[-*]\s+/.test(line) || /^\|/.test(line) || /^\d+\.\s+/.test(line)
      const isDiagramOrCode = /^(graph|flowchart|sequenceDiagram|classDef|subgraph|%%|[A-Za-z0-9_]+\[|[A-Za-z0-9_]+-->|[A-Za-z0-9_]+-.->)/.test(line)
      const isDocusaurusComponent = /^<|^import\s+|DocCardList|useCurrentSidebarCategory|items=\{/.test(line)
      const isMetadataLine = /^---$/.test(line) || /^>\s+/.test(line)
      const mentionsSubject = subjectTerms.some(term => lowerLine.includes(term))
      const mentionsShortSubject = asksShortDefinition ? mentionsExactSubject(lowerLine) : false

      if (isDiagramOrCode || isDocusaurusComponent || isMetadataLine) continue
      if (!asksCron && (/^\|?\s*Cron[A-Z]/.test(line) || lowerLine.includes("croncheck"))) continue
      if (asksOverview && isListOrTable && !asksRules) continue
      if (asksShortDefinition && !asksFinancialAdvisor && !mentionsShortSubject) continue

      if (mentionsSubject || (asksRules && isListOrTable) || (!asksRules && !isListOrTable && !isHeader)) {
        facts.push(`${line} (${chunk.repoName}@${chunk.branchName ?? "unknown"} ${chunk.filePath}:${chunk.startLine}-${chunk.endLine})`)
      }

      if (facts.length >= maxFacts) break
    }

    if (facts.length >= maxFacts) break
  }

  const uniqueFacts = unique(facts, maxFacts)

  if (uniqueFacts.length === 0) {
    if (asksShortDefinition && !asksFinancialAdvisor) {
      const subject = shortDefinitionTerms[0]?.toUpperCase() ?? explicitSubjectTerms[0] ?? "term"

      return localized(
        `Saya tidak menemukan definisi ${subject} yang eksplisit di indexed code/docs. Registry hanya punya alias untuk membantu retrieval, tapi itu bukan evidence definisi.`,
        `I did not find an explicit ${subject} definition in indexed code/docs. The registry only has aliases for retrieval, but that is not definition evidence.`,
      )
    }

    return undefined
  }

  function parseDocFact(fact: string): { text: string; source: string } {
    const match = fact.match(/^(.*)\s+\(([^()]+:\d+-\d+)\)$/)

    return {
      text: cleanDocSummaryText(match?.[1] ?? fact),
      source: match?.[2] ?? "",
    }
  }

  const parsedFacts = uniqueFacts
    .map(parseDocFact)
    .filter(fact => fact.text.length > 0)
    .filter((fact, index, facts) => {
      const key = fact.text.toLowerCase()

      return facts.findIndex(other => other.text.toLowerCase() === key) === index
    })

  if (asksOverview) {
    const definitionFacts = parsedFacts.filter(fact => {
      return !/^welcome to\b/i.test(fact.text) &&
        !/^selamat datang\b/i.test(fact.text) &&
        !/^auto copy \(isignal\) product documentation$/i.test(fact.text) &&
        !/^dokumentasi produk auto copy \(isignal\)$/i.test(fact.text) &&
        !/business-rules|rules/i.test(fact.source) &&
        fact.text.length >= 40
    })
    const ruleFacts = asksRules
      ? parsedFacts.filter(fact =>
          /business-rules|rules/i.test(fact.source) &&
          !/^aturan bisnis financial advisor$/i.test(fact.text) &&
          !/^financial advisor business rules$/i.test(fact.text) &&
          !/^dokumen ini menjelaskan\b/i.test(fact.text) &&
          !/^this document outlines\b/i.test(fact.text)
        ).slice(0, 10)
      : []
    const guideFacts = asksGuide
      ? parsedFacts.filter(fact => /onboarding|guide|panduan/i.test(fact.source) || /onboarding|guide|panduan/i.test(fact.text))
      : []
    const mainFact = guideFacts[0] ?? definitionFacts[0] ?? parsedFacts[0]
    const supportingFacts = (guideFacts.length > 0 ? guideFacts : definitionFacts).filter(fact => fact !== mainFact).slice(0, asksHowWorks || asksGuide ? 6 : 4)
    const sources = unique([mainFact?.source ?? "", ...supportingFacts.map(fact => fact.source), ...ruleFacts.map(fact => fact.source)], 8)

    if (!mainFact) return undefined

    return [
      asksHowWorks
        ? localized("Cara kerja berdasarkan dokumentasi:", "How it works from indexed documentation:")
        : localized("Ringkasan berdasarkan dokumentasi:", "Summary from indexed documentation:"),
      asksGuide && subjectTerms.includes("isignal")
        ? localized("Panduan onboarding iSignal:", "iSignal onboarding guide:")
        : undefined,
      renderDocSummaryText(mainFact.text),
      supportingFacts.length > 0 ? "" : undefined,
      supportingFacts.length > 0 ? localized("Poin penting:", "Key points:") : undefined,
      supportingFacts.length > 0 ? supportingFacts.map(fact => `- ${renderDocSummaryText(fact.text)}`).join("\n") : undefined,
      ruleFacts.length > 0 ? "" : undefined,
      ruleFacts.length > 0 ? localized("Aturan yang ditemukan:", "Rules found:") : undefined,
      ruleFacts.length > 0 ? ruleFacts.map(fact => `- ${renderDocSummaryText(fact.text)}`).join("\n") : undefined,
      "",
      localized("Sumber utama:", "Primary sources:"),
      sources.map(source => `- ${source}`).join("\n"),
    ].filter((line): line is string => typeof line === "string").join("\n")
  }

  return [
    shouldAnswerIndonesian(question)
      ? "Ringkasan berdasarkan dokumentasi yang ter-index:"
      : "Summary from indexed documentation:",
    parsedFacts.map(fact => `- ${fact.text}${fact.source ? ` (${fact.source})` : ""}`).join("\n"),
    "",
    shouldAnswerIndonesian(question)
      ? "Catatan: ini adalah ringkasan evidence dokumentasi. Untuk detail implementasi, tanyakan flow, endpoint, tabel, atau service spesifik."
      : "Note: this is a documentation evidence summary. For implementation details, ask for a specific flow, endpoint, table, or service.",
  ].join("\n")
}

export function documentationGlossarySourceChunks(chunks: RetrievedPayload[], question: string): RetrievedPayload[] {
  const asksDefinition = /\b(apa itu|what is|maksud|meaning|define|definition|glossary|glosarium)\b/i.test(question)
  const asksHowWorks = questionAsksHowWorks(question)
  const asksRules = /\b(aturan|rules?|rule|ketentuan|business rules?)\b/i.test(question)
  const subjectTerms = unique([
    ...extractConceptTokens(question),
    ...extractDefinitionSubjectTerms(question),
    ...extractQuestionAcronyms(question),
    ...extractShortSubjectTokens(question),
  ], 16).map(term => term.toLowerCase())
  const shortDefinitionTerms = asksDefinition
    ? subjectTerms.filter(term => term.length >= 2 && term.length <= 4)
    : []
  const asksShortDefinition = asksDefinition && shortDefinitionTerms.length > 0
  function mentionsExactSubject(text: string): boolean {
    return shortDefinitionTerms.some(term => new RegExp(`(^|[^a-z0-9])${escapeRegExp(term)}([^a-z0-9]|$)`, "i").test(text))
  }
  const asksFinancialAdvisor = subjectTerms.includes("fa") ||
    subjectTerms.includes("financial advisor") ||
    /\b(financial advisor|penasihat keuangan|fa porto)\b/i.test(question)

  return chunks.filter(chunk => {
    if (!chunk.evidenceTypes?.includes("documentation")) return false

    const filePath = chunk.filePath?.toLowerCase() ?? ""
    const content = chunk.content?.toLowerCase() ?? ""
    const text = `${filePath}\n${content}`

    if (asksShortDefinition && !asksFinancialAdvisor && !mentionsExactSubject(text)) {
      return false
    }

    if (asksFinancialAdvisor) {
      return filePath.includes("fa-porto-docs") &&
        (filePath.endsWith("index.mdx") || filePath.endsWith("index.md") || content.includes("financial advisor") || content.includes("penasihat keuangan"))
    }

    if (asksRules) return filePath.includes("rules")
    if (asksDefinition || asksHowWorks) {
      const isTopLevelIndex = /docs:[^/\\]+[/\\]index\.mdx?$/.test(filePath)

      return isTopLevelIndex ||
        (asksDefinition && (filePath.includes("glossarium") || filePath.includes("glossary"))) ||
        (asksHowWorks && (filePath.includes("flow") || filePath.includes("business-rules") || filePath.includes("architecture"))) ||
        content.includes("allows users to automatically")
    }

    return true
  }).sort((left, right) => scoreDocLocalePreference(right) - scoreDocLocalePreference(left)).slice(0, 12)
}
