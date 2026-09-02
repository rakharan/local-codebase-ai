// Vocabulary Answers

import { config } from "../lib/config.js"
import type { RegistryExpansion } from "../lib/service-registry.js"
import type { RetrievedPayload } from "./types.js"
import { unique } from "./question.js"

export function buildVocabularyAnswer(chunks: RetrievedPayload[], question: string, registryExpansion: RegistryExpansion): string | undefined {
  const vocabChunks = chunks.filter(chunk => chunk.filePath?.startsWith("vocabulary://"))

  if (vocabChunks.length === 0) return undefined

  const lowerQuestion = question.toLowerCase()

  // Skip vocabulary answers for questions that are clearly about specific
  // functions, queues, routes, flows, tables, or service interactions.
  const specificQuestionPatterns = [
    /\b(queue|queues|rabbitmq|pubsub|consumer|consume|publish|publisher|listener|listen to)\b/i,
    /\b(function|method|endpoint|route|handler|controller|api)\b/i,
    /\b(flow|how does .* work|how do .* work)\b/i,
    /\b(table|tables|column|columns|database schema)\b/i,
    /\b(service|microservice|worker|cron)\b/i,
    /\b(difference between|compare|vs\.?|versus)\b/i,
    /\b(exist|have a|does .* have)\b/i,
    // Skip when asking about a specific value (= 0, = 1, = 2, status value, etc.)
    /[=!<>]\s*\d+/,
    /\b(status|value|nilai)\s*(=|==|===)\s*\d+/i,
    /what does.*\d+.*mean/i,
  ]

  if (specificQuestionPatterns.some(pattern => pattern.test(question))) {
    return undefined
  }

  type TermInfo = {
    term: string
    vocabName: string
    kind: string
    source: string
    repoName: string
    value: string | undefined
    properties: Record<string, string>
  }

  const termMap = new Map<string, TermInfo>()
  const vocabGroupNames = new Set<string>()

  for (const chunk of vocabChunks) {
    const content = chunk.content ?? ""
    const lines = content.split("\n")
    const vocabName = lines.find(line => line.startsWith("Vocabulary:"))?.replace("Vocabulary:", "").trim() ?? ""
    const kind = lines.find(line => line.startsWith("Kind:"))?.replace("Kind:", "").trim() ?? ""
    const source = lines.find(line => line.startsWith("Source:"))?.replace("Source:", "").trim() ?? ""
    const repoName = chunk.repoName ?? ""

    if (vocabName) vocabGroupNames.add(vocabName)

    let currentTerm: string | undefined
    let currentValue: string | undefined
    let currentProperties: Record<string, string> = {}

    for (const line of lines) {
      if (line.startsWith("- ")) {
        // Save previous term before starting a new one
        if (currentTerm) {
          const existing = termMap.get(currentTerm.toLowerCase())
          const propCount = Object.keys(currentProperties).length

          if (!existing || Object.keys(existing.properties).length < propCount) {
            termMap.set(currentTerm.toLowerCase(), {
              term: currentTerm,
              vocabName,
              kind,
              source,
              repoName,
              value: currentValue,
              properties: { ...currentProperties },
            })
          }
        }

        // Parse new term line: `- TermName` or `- TermName: value`
        const match = line.match(/^- ([^:]+?)(?::\s*(.+))?$/)
        currentTerm = match?.[1]?.trim()
        currentValue = match?.[2]?.trim()
        currentProperties = {}
      } else if (line.startsWith("    ") && currentTerm) {
        // Property line: `    key: value`
        const propMatch = line.match(/^\s{4}([^:]+):\s*(.+)$/)

        if (propMatch && propMatch[1] && propMatch[2]) {
          currentProperties[propMatch[1].trim()] = propMatch[2].trim()
        }
      }
    }

    // Save the last term
    if (currentTerm) {
      const existing = termMap.get(currentTerm.toLowerCase())
      const propCount = Object.keys(currentProperties).length

      if (!existing || Object.keys(existing.properties).length < propCount) {
        termMap.set(currentTerm.toLowerCase(), {
          term: currentTerm,
          vocabName,
          kind,
          source,
          repoName,
          value: currentValue,
          properties: { ...currentProperties },
        })
      }
    }
  }

  const matchingTerms = [...termMap.values()].filter(info => lowerQuestion.includes(info.term.toLowerCase()))

  // Also detect general questions about the vocabulary group (e.g., "persyaratan naik medal" without naming a specific level)
  const generalVocabKeywords = ["medal", "level", "rank", "persyaratan", "naik", "requirement", "syarat", "tier", "grade"]
  const isGeneralVocabQuestion = generalVocabKeywords.some(kw => lowerQuestion.includes(kw))

  if (matchingTerms.length === 0 && !isGeneralVocabQuestion) return undefined

  // For general questions, include all terms from vocabulary groups that contain medal/level related properties
  let termsToInclude = matchingTerms

  if (matchingTerms.length === 0 && isGeneralVocabQuestion) {
    const domainMentions = registryExpansion.matchedEntries.filter(e => e.kind === "domain" || e.kind === "broker")

    if (domainMentions.length > 0) {
      const domainNames = new Set(domainMentions.flatMap(e => [e.name, e.projectId ?? ""]).filter(Boolean))
      const vocabRelatesToDomain = [...vocabGroupNames].some(gn =>
        [...domainNames].some(name => gn.toLowerCase() === name.toLowerCase() || gn.toLowerCase().startsWith(name.toLowerCase() + "_"))
      ) || [...termMap.values()].some(info =>
        [...domainNames].some(name => info.term.toLowerCase() === name.toLowerCase())
      )

      if (!vocabRelatesToDomain) return undefined
    }

    const medalRelatedGroups = [...vocabGroupNames].filter(gn =>
      [...termMap.values()].some(info =>
        info.vocabName === gn &&
        (Object.keys(info.properties).some(p => p.toLowerCase().includes("medal")) ||
         info.term.toLowerCase().includes("medal"))
      )
    )

    if (medalRelatedGroups.length > 0) {
      termsToInclude = [...termMap.values()].filter(info => medalRelatedGroups.includes(info.vocabName))
    } else {
      // Fall back to all terms if no medal-specific groups found
      termsToInclude = [...termMap.values()]
    }
  }

  if (termsToInclude.length === 0) return undefined

  // Look for related usage chunks that explain what vocabulary properties mean
  const usageHints = new Map<string, string>()

  for (const chunk of chunks) {
    if (chunk.filePath?.startsWith("vocabulary://")) continue

    const content = chunk.content ?? ""

    // Look for semantic hints about what properties mean
    if (/level\.money\s*==\s*0/.test(content)) {
      usageHints.set("money-zero", "when money is 0, point redemption is blocked")
    }

    if (/level\.money\s*\*|\*\s*level\.money|point\s*\*\s*money|money\s*\*\s*point/.test(content)) {
      usageHints.set("money", "used as a per-point multiplier in point calculations")
    }

    if (/per_point|per point|per-point/.test(content)) {
      usageHints.set("money", "represents the per-point monetary value")
    }

    if (/formatMoney\(level\.money\)/.test(content)) {
      if (!usageHints.has("money")) {
        usageHints.set("money", "formatted as a monetary value per point")
      }
    }
  }

  const paragraphs: string[] = []
  const sources: string[] = []

  for (const info of termsToInclude) {
    const displayTerm = info.term.length > 0 && info.term[0] ? info.term[0].toUpperCase() + info.term.slice(1) : info.term
    const isLevelVocab = /level|point|medal|rank/i.test(info.vocabName)
    const isAccountVocab = /account|type|platform/i.test(info.vocabName)

    // Separate properties into requirements vs config fields
    const requirementKeys = ["minMedal", "maxMedal", "min", "max", "threshold", "requirement"]
    const requirementProps: Record<string, string> = {}
    const otherProps: Record<string, string> = {}

    for (const [key, val] of Object.entries(info.properties)) {
      if (requirementKeys.some(req => key.toLowerCase().includes(req))) {
        requirementProps[key] = val
      } else {
        otherProps[key] = val
      }
    }

    // Build the intro based on what info we have
    if (Object.keys(requirementProps).length > 0) {
      if (isLevelVocab) {
        paragraphs.push(`For a channel to reach **${displayTerm}** level, the medal range requirement is:`)
      } else if (isAccountVocab) {
        paragraphs.push(`The **${displayTerm}** account type has these threshold settings:`)
      } else {
        paragraphs.push(`**${displayTerm}** has these requirement thresholds:`)
      }

      for (const [key, val] of Object.entries(requirementProps)) {
        paragraphs.push(`- ${key}: ${val}`)
      }
    }

    if (Object.keys(otherProps).length > 0) {
      const moneyHint = usageHints.get("money")
      const moneyValue = otherProps.money

      if (isLevelVocab && Object.keys(requirementProps).length > 0) {
        paragraphs.push(`As a privilege of reaching **${displayTerm}** level:`)
      }

      if (moneyValue && moneyHint) {
        paragraphs.push(`- Each point is worth **Rp ${Number(moneyValue).toLocaleString("id-ID")}** (${moneyHint})`)
        delete otherProps.money
      }

      for (const [key, val] of Object.entries(otherProps)) {
        paragraphs.push(`- ${key}: ${val}`)
      }
    }

    if (info.value && Object.keys(info.properties).length === 0) {
      paragraphs.push(`- mapped to ${info.value}`)
    }

    if (info.source) {
      sources.push(`- ${info.repoName}@${"unknown"} ${info.source} (${info.vocabName})`)
    }
  }

  // Add sources from usage chunks that mention the vocabulary or term
  for (const chunk of chunks) {
    if (chunk.filePath?.startsWith("vocabulary://")) continue
    if (!chunk.repoName) continue

    const content = chunk.content ?? ""
    const hasMoneyHint = /level\.money\s*\*|\*\s*level\.money|point\s*\*\s*money|money\s*\*\s*point|formatMoney\(level\.money\)|per_point/.test(content)
    const mentionsVocab = vocabGroupNames.size > 0 && [...vocabGroupNames].some(name => content.includes(name))
    const mentionsTerm = termsToInclude.some(info => content.toLowerCase().includes(info.term.toLowerCase()))

    if (hasMoneyHint || mentionsVocab || mentionsTerm) {
      sources.push(`- ${chunk.repoName}@${chunk.branchName ?? "unknown"} ${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`)
    }
  }

  if (paragraphs.length === 0) return undefined

  return [
    ...paragraphs,
    "",
    "Sources:",
    ...unique(sources, 8),
  ].join("\n")
}
