import fs from "node:fs"
import path from "node:path"
import type { ProjectTag } from "./chunker.js"

export type ServiceRegistryEntry = {
  name: string
  kind: "service" | "broker" | "domain" | "concept"
  projectId?: string
  description?: string
  aliases: string[]
  repos: string[]
  docs?: string[]
  keywords: string[]
  routes?: string[]
  functions?: string[]
  queues?: string[]
  tables?: string[]
  pathRules?: Array<{
    repo: string
    pattern: string
    projectId: string
  }>
  notes?: string[]
}

type ServiceRegistryFile = {
  entries: ServiceRegistryEntry[]
}

export type RegistryExpansion = {
  expandedQuestion: string
  matchedEntries: ServiceRegistryEntry[]
  terms: string[]
  projectIds: string[]
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
    const nameOrAliasMatch = [entry.name, ...entry.aliases].some(alias => includesLoose(question, alias))
    const repoMatch = entry.repos.some(repo => includesLoose(repo, question.toLowerCase().trim()) || includesLoose(question, repo))
    return nameOrAliasMatch || repoMatch
  })
  const terms = unique(
    matchedEntries.flatMap(entry => [
      entry.name,
      entry.projectId ?? "",
      ...entry.aliases,
      ...entry.repos,
      ...entry.keywords,
    ]),
  )
  const projectIds = unique(matchedEntries.flatMap(entry => entry.projectId ?? entry.name), 24)
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
    projectIds,
  }
}

export function inferProjectIdsForRepo(repoName: string, entries = loadServiceRegistry()): string[] {
  const normalizedRepoName = repoName.toLowerCase()

  return unique(
    entries
      .filter(entry => entry.repos.some(repo => repo.toLowerCase() === normalizedRepoName))
      .map(entry => entry.projectId ?? entry.name),
    24,
  )
}

export function reposForProjectIds(projectIds: string[], entries = loadServiceRegistry()): string[] {
  const normalizedProjectIds = new Set(normalizeProjectIds(projectIds))

  if (normalizedProjectIds.size === 0) return []

  return unique(
    entries
      .filter(entry => normalizedProjectIds.has(entry.projectId ?? entry.name))
      .flatMap(entry => entry.repos),
    100,
  )
}

export function normalizeProjectIds(projectIds: string[]): string[] {
  return unique(
    projectIds
      .flatMap(value => value.split(","))
      .map(value => value.trim().toLowerCase())
      .filter(value => /^[a-z0-9][a-z0-9_-]*$/.test(value)),
    24,
  )
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

function matchableTerms(entry: ServiceRegistryEntry): string[] {
  return unique([
    entry.projectId ?? entry.name,
    entry.name,
    entry.description ?? "",
    ...entry.aliases,
    ...entry.keywords,
    ...(entry.docs ?? []),
    ...(entry.routes ?? []),
    ...(entry.functions ?? []),
    ...(entry.queues ?? []),
    ...(entry.tables ?? []),
  ], 120)
    .filter(term => normalizeToken(term).length >= 3)
}

function pathRuleMatches(pattern: string, filePath: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, "/").toLowerCase()
  const normalizedPath = filePath.replace(/\\/g, "/").toLowerCase()

  if (normalizedPattern.endsWith("/**")) {
    return normalizedPath.startsWith(normalizedPattern.slice(0, -3))
  }

  if (normalizedPattern.includes("*")) {
    const regex = new RegExp(`^${normalizedPattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`)

    return regex.test(normalizedPath)
  }

  return normalizedPath === normalizedPattern || normalizedPath.startsWith(`${normalizedPattern}/`)
}

export function inferProjectTagForChunk(input: {
  repoName: string
  filePath: string
  content: string
  fallbackProjectIds?: string[]
  entries?: ServiceRegistryEntry[]
}): ProjectTag {
  const entries = input.entries ?? loadServiceRegistry()
  const fallbackProjectIds = normalizeProjectIds(input.fallbackProjectIds ?? [])
  const normalizedPath = normalizeToken(input.filePath)
  const normalizedContent = normalizeToken(input.content.slice(0, 6_000))
  const scored = new Map<string, { score: number; sources: string[] }>()

  function addScore(projectId: string, score: number, source: string) {
    const normalizedProjectId = normalizeProjectIds([projectId])[0]
    if (!normalizedProjectId) return

    const current = scored.get(normalizedProjectId) ?? { score: 0, sources: [] }
    current.score += score
    current.sources.push(source)
    scored.set(normalizedProjectId, current)
  }

  for (const entry of entries) {
    const projectId = entry.projectId ?? entry.name
    const repoMatches = entry.repos.some(repo => repo.toLowerCase() === input.repoName.toLowerCase())

    for (const rule of entry.pathRules ?? []) {
      if (rule.repo.toLowerCase() !== input.repoName.toLowerCase()) continue
      if (!pathRuleMatches(rule.pattern, input.filePath)) continue

      addScore(rule.projectId, 100, `path-rule:${rule.repo}:${rule.pattern}`)
    }

    for (const term of matchableTerms(entry)) {
      const normalizedTerm = normalizeToken(term)
      if (normalizedTerm.length < 3) continue

      if (normalizedPath.includes(normalizedTerm)) {
        addScore(projectId, 30, `path:${term}`)
      }

      if (repoMatches && normalizedContent.includes(normalizedTerm)) {
        addScore(projectId, normalizedTerm.length >= 6 ? 8 : 4, `content:${term}`)
      }
    }
  }

  const confidentMatches = [...scored.entries()]
    .filter(([, value]) => value.score >= 12)
    .sort((left, right) => right[1].score - left[1].score)
    .slice(0, 6)

  if (confidentMatches.length > 0) {
    return {
      projectIds: confidentMatches.map(([projectId]) => projectId),
      sources: unique(confidentMatches.flatMap(([, value]) => value.sources), 12),
    }
  }

  if (fallbackProjectIds.length <= 1) {
    return {
      projectIds: fallbackProjectIds,
      sources: fallbackProjectIds.map(projectId => `repo:${projectId}`),
    }
  }

  return {
    projectIds: [],
    sources: [`repo:ambiguous:${fallbackProjectIds.join(",")}`],
  }
}

export function buildRegistryPromptContext(expansion: RegistryExpansion): string {
  if (expansion.matchedEntries.length === 0) return "none"

  return expansion.matchedEntries
    .map(entry => {
      return [
        `- ${entry.name} (${entry.kind})`,
        `  project: ${entry.projectId ?? entry.name}`,
        entry.description ? `  description: ${entry.description}` : undefined,
        `  aliases: ${entry.aliases.join(", ")}`,
        `  repos: ${entry.repos.join(", ")}`,
        entry.docs?.length ? `  docs: ${entry.docs.join(", ")}` : undefined,
        entry.routes?.length ? `  routes: ${entry.routes.join(", ")}` : undefined,
        entry.functions?.length ? `  functions: ${entry.functions.join(", ")}` : undefined,
        entry.queues?.length ? `  queues: ${entry.queues.join(", ")}` : undefined,
        entry.tables?.length ? `  tables: ${entry.tables.join(", ")}` : undefined,
        `  retrieval keywords: ${entry.keywords.join(", ")}`,
        entry.notes?.length ? `  notes: ${entry.notes.join("; ")}` : undefined,
      ].filter(Boolean).join("\n")
    })
    .join("\n")
}
