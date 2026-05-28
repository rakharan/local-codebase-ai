import fs from "node:fs"
import path from "node:path"

export type ServiceRegistryEntry = {
  name: string
  kind: "service" | "broker" | "domain" | "concept"
  aliases: string[]
  repos: string[]
  keywords: string[]
}

type ServiceRegistryFile = {
  entries: ServiceRegistryEntry[]
}

export type RegistryExpansion = {
  expandedQuestion: string
  matchedEntries: ServiceRegistryEntry[]
  terms: string[]
}

const registryPath = path.join(process.cwd(), "config", "services.json")

function unique(values: string[], max = 80): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].slice(0, max)
}

export function loadServiceRegistry(): ServiceRegistryEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8")) as ServiceRegistryFile

    return Array.isArray(parsed.entries) ? parsed.entries : []
  } catch {
    return []
  }
}

function includesLoose(haystack: string, needle: string): boolean {
  const normalizedHaystack = haystack.toLowerCase()
  const normalizedNeedle = needle.toLowerCase()

  if (normalizedNeedle.length < 3) return false

  return normalizedHaystack.includes(normalizedNeedle)
}

export function expandQuestionWithRegistry(question: string, entries = loadServiceRegistry()): RegistryExpansion {
  const matchedEntries = entries.filter(entry => {
    return [entry.name, ...entry.aliases].some(alias => includesLoose(question, alias))
  })
  const terms = unique(
    matchedEntries.flatMap(entry => [
      entry.name,
      ...entry.aliases,
      ...entry.repos,
      ...entry.keywords,
    ]),
  )
  const expandedQuestion = terms.length > 0
    ? [
        question,
        "",
        "Domain vocabulary expansion:",
        terms.join(" "),
      ].join("\n")
    : question

  return {
    expandedQuestion,
    matchedEntries,
    terms,
  }
}

export function buildRegistryPromptContext(expansion: RegistryExpansion): string {
  if (expansion.matchedEntries.length === 0) return "none"

  return expansion.matchedEntries
    .map(entry => {
      return [
        `- ${entry.name} (${entry.kind})`,
        `  aliases: ${entry.aliases.join(", ")}`,
        `  repos: ${entry.repos.join(", ")}`,
        `  retrieval keywords: ${entry.keywords.join(", ")}`,
      ].join("\n")
    })
    .join("\n")
}
