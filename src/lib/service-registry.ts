import fs from "node:fs"
import fsp from "node:fs/promises"
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
  repoPaths?: Array<{
    repo: string
    path: string
    serviceType?: "api" | "worker" | "cron" | "library" | "unknown"
  }>
  notes?: string[]
}

type ServiceRegistryFile = {
  entries: ServiceRegistryEntry[]
}

export type ServiceRegistryInput = {
  entries?: unknown
}

type RegistryEntryUpsertInput = Record<string, unknown> & {
  previousName?: unknown
}

export type RegistryExpansion = {
  expandedQuestion: string
  matchedEntries: ServiceRegistryEntry[]
  terms: string[]
  projectIds: string[]
}

const registryPath = path.join(process.cwd(), "config", "services.json")
const registryKinds = ["service", "broker", "domain", "concept"] as const
const registryServiceTypes = ["api", "worker", "cron", "library", "unknown"] as const

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

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function asStringArray(value: unknown, max = 120): string[] {
  if (Array.isArray(value)) {
    return unique(value.map(asString), max)
  }

  if (typeof value === "string") {
    return unique(value.split(/[\n,]/).map(item => item.trim()), max)
  }

  return []
}

function normalizeKind(value: unknown): ServiceRegistryEntry["kind"] {
  return registryKinds.includes(value as ServiceRegistryEntry["kind"])
    ? value as ServiceRegistryEntry["kind"]
    : "domain"
}

function normalizePathRules(value: unknown): NonNullable<ServiceRegistryEntry["pathRules"]> {
  if (!Array.isArray(value)) return []

  return value
    .map(rule => {
      if (!rule || typeof rule !== "object") return undefined

      const record = rule as Record<string, unknown>
      const repo = asString(record.repo)
      const pattern = asString(record.pattern)
      const projectId = normalizeProjectIds([asString(record.projectId)])[0]

      if (!repo || !pattern || !projectId) return undefined

      return {
        repo,
        pattern,
        projectId,
      }
    })
    .filter((rule): rule is { repo: string; pattern: string; projectId: string } => Boolean(rule))
}

function normalizeServiceType(value: unknown): NonNullable<NonNullable<ServiceRegistryEntry["repoPaths"]>[number]["serviceType"]> {
  return registryServiceTypes.includes(value as NonNullable<NonNullable<ServiceRegistryEntry["repoPaths"]>[number]["serviceType"]>)
    ? value as NonNullable<NonNullable<ServiceRegistryEntry["repoPaths"]>[number]["serviceType"]>
    : "unknown"
}

function normalizeRepoPaths(value: unknown): NonNullable<ServiceRegistryEntry["repoPaths"]> {
  if (!Array.isArray(value)) return []

  return value
    .map(repoPath => {
      if (!repoPath || typeof repoPath !== "object") return undefined

      const record = repoPath as Record<string, unknown>
      const repo = asString(record.repo)
      const localPath = asString(record.path)
      const serviceType = normalizeServiceType(record.serviceType)

      if (!repo || !localPath) return undefined

      return {
        repo,
        path: localPath,
        serviceType,
      }
    })
    .filter((repoPath): repoPath is { repo: string; path: string; serviceType: "api" | "worker" | "cron" | "library" | "unknown" } => Boolean(repoPath))
}

export function normalizeServiceRegistryEntry(input: unknown): ServiceRegistryEntry {
  if (!input || typeof input !== "object") {
    throw new Error("Registry entry must be an object")
  }

  const record = input as Record<string, unknown>
  const name = asString(record.name)
  const projectId = normalizeProjectIds([asString(record.projectId || record.name)])[0]

  if (!name) {
    throw new Error("Registry entry is missing required field: name")
  }

  if (!projectId) {
    throw new Error(`Registry entry "${name}" has an invalid projectId`)
  }

  const entry: ServiceRegistryEntry = {
    name,
    kind: normalizeKind(record.kind),
    projectId,
    aliases: asStringArray(record.aliases),
    repos: asStringArray(record.repos),
    docs: asStringArray(record.docs),
    keywords: asStringArray(record.keywords),
    routes: asStringArray(record.routes),
    functions: asStringArray(record.functions),
    queues: asStringArray(record.queues),
    tables: asStringArray(record.tables),
    pathRules: normalizePathRules(record.pathRules),
    repoPaths: normalizeRepoPaths(record.repoPaths),
    notes: asStringArray(record.notes),
  }

  const description = asString(record.description)
  if (description) {
    entry.description = description
  }

  return entry
}

export function affectedReposForRegistryEntry(entry: ServiceRegistryEntry): string[] {
  return unique([
    ...entry.repos,
    ...(entry.pathRules ?? []).map(rule => rule.repo),
    ...(entry.repoPaths ?? []).map(repoPath => repoPath.repo),
  ], 100)
}

export function findServiceRegistryEntry(entryName: string, entries = loadServiceRegistry()): ServiceRegistryEntry | undefined {
  const lookupName = entryName.trim().toLowerCase()

  return entries.find(entry => entry.name.toLowerCase() === lookupName)
}

export function repoPathConfigsForEntry(entry: ServiceRegistryEntry, entries = loadServiceRegistry()): Array<{
  repo: string
  path: string
  serviceType: "api" | "worker" | "cron" | "library" | "unknown"
}> {
  const affectedRepos = new Set(affectedReposForRegistryEntry(entry).map(repo => repo.toLowerCase()))
  const byRepo = new Map<string, {
    repo: string
    path: string
    serviceType: "api" | "worker" | "cron" | "library" | "unknown"
  }>()

  for (const candidate of entries) {
    for (const repoPath of candidate.repoPaths ?? []) {
      if (!affectedRepos.has(repoPath.repo.toLowerCase())) continue
      if (byRepo.has(repoPath.repo.toLowerCase())) continue

      byRepo.set(repoPath.repo.toLowerCase(), {
        repo: repoPath.repo,
        path: repoPath.path,
        serviceType: repoPath.serviceType ?? "unknown",
      })
    }
  }

  return [...byRepo.values()].sort((left, right) => left.repo.localeCompare(right.repo))
}

export function normalizeServiceRegistryFile(input: ServiceRegistryInput): ServiceRegistryFile {
  if (!Array.isArray(input.entries)) {
    throw new Error("Registry file must contain an entries array")
  }

  const entries = input.entries.map(normalizeServiceRegistryEntry)
  const seenNames = new Set<string>()

  for (const entry of entries) {
    const normalizedName = entry.name.toLowerCase()

    if (seenNames.has(normalizedName)) {
      throw new Error(`Duplicate registry entry name: ${entry.name}`)
    }

    seenNames.add(normalizedName)
  }

  return { entries }
}

export async function readServiceRegistryFile(): Promise<ServiceRegistryFile> {
  const parsed = JSON.parse(await fsp.readFile(registryPath, "utf8")) as ServiceRegistryInput

  return normalizeServiceRegistryFile(parsed)
}

export async function writeServiceRegistryFile(input: ServiceRegistryInput): Promise<ServiceRegistryFile> {
  const registry = normalizeServiceRegistryFile(input)
  const tempPath = `${registryPath}.tmp`

  await fsp.mkdir(path.dirname(registryPath), { recursive: true })
  await fsp.writeFile(tempPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8")
  await fsp.rename(tempPath, registryPath)

  return registry
}

export async function upsertServiceRegistryEntry(input: unknown): Promise<{
  entry: ServiceRegistryEntry
  entries: ServiceRegistryEntry[]
  affectedRepos: string[]
}> {
  const registry = await readServiceRegistryFile()
  const entry = normalizeServiceRegistryEntry(input)
  const previousName = asString((input as RegistryEntryUpsertInput | null | undefined)?.previousName)
  const lookupName = (previousName || entry.name).toLowerCase()
  const index = registry.entries.findIndex(existing => existing.name.toLowerCase() === lookupName)
  const entries = index >= 0
    ? registry.entries.map((existing, existingIndex) => existingIndex === index ? entry : existing)
    : [...registry.entries, entry]
  const saved = await writeServiceRegistryFile({ entries })

  return {
    entry,
    entries: saved.entries,
    affectedRepos: affectedReposForRegistryEntry(entry),
  }
}

export async function deleteServiceRegistryEntry(entryName: string): Promise<{
  deleted: ServiceRegistryEntry
  entries: ServiceRegistryEntry[]
  affectedRepos: string[]
}> {
  const lookupName = entryName.trim().toLowerCase()
  if (!lookupName) {
    throw new Error("Missing registry entry name")
  }

  const registry = await readServiceRegistryFile()
  const deleted = registry.entries.find(entry => entry.name.toLowerCase() === lookupName)

  if (!deleted) {
    throw new Error(`Registry entry not found: ${entryName}`)
  }

  const saved = await writeServiceRegistryFile({
    entries: registry.entries.filter(entry => entry.name.toLowerCase() !== lookupName),
  })

  return {
    deleted,
    entries: saved.entries,
    affectedRepos: affectedReposForRegistryEntry(deleted),
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
