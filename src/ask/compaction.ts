import type { RetrievedChunk, RetrievedPayload } from "./types.js"

function normalizePath(value: string | undefined): string {
  return (value ?? "").replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase()
}

function normalizeContent(value: string | undefined): string {
  return (value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

function shortFingerprint(value: string | undefined): string {
  const normalized = normalizeContent(value)

  return normalized.length <= 360 ? normalized : `${normalized.slice(0, 180)}...${normalized.slice(-180)}`
}

function isDocumentation(payload: RetrievedPayload): boolean {
  return payload.evidenceTypes?.includes("documentation") || normalizePath(payload.filePath).includes("docs:")
}

function mirrorKey(payload: RetrievedPayload): string {
  const filePath = normalizePath(payload.filePath)
  const contentKey = payload.contentHash || shortFingerprint(payload.content)

  if (isDocumentation(payload)) {
    const docsPath = filePath.replace(/^.*?docs:/, "docs:")
    return `docs:${payload.docLocale ?? payload.branchName ?? ""}:${docsPath}:${contentKey}`
  }

  if (payload.contentHash) {
    return `hash:${payload.repoName ?? ""}:${payload.branchName ?? ""}:${payload.filePath ?? ""}:${payload.contentHash}`
  }

  return `content:${payload.repoName ?? ""}:${payload.branchName ?? ""}:${payload.filePath ?? ""}:${contentKey}`
}

function isNearDuplicate(chunk: RetrievedChunk, selected: RetrievedChunk[]): boolean {
  const payload = chunk.payload

  return selected.some(existing => {
    const content = normalizeContent(payload.content)
    const existingContent = normalizeContent(existing.payload.content)

    if (!content || !existingContent) return false
    if (content === existingContent) return true
    if (content.length < 160 || existingContent.length < 160) return false

    return content.includes(existingContent) || existingContent.includes(content)
  })
}

export function compactRetrievedChunks(chunks: RetrievedChunk[], maxResults: number): RetrievedChunk[] {
  const selected: RetrievedChunk[] = []
  const seenIds = new Set<string>()
  const seenMirrors = new Set<string>()

  for (const chunk of chunks) {
    if (seenIds.has(chunk.id)) continue
    seenIds.add(chunk.id)

    const key = mirrorKey(chunk.payload)
    if (seenMirrors.has(key)) continue
    if (isNearDuplicate(chunk, selected)) continue

    seenMirrors.add(key)
    selected.push(chunk)

    if (selected.length >= maxResults) break
  }

  return selected
}

export function compactPayloadSources(chunks: RetrievedPayload[], maxResults: number): RetrievedPayload[] {
  return compactRetrievedChunks(
    chunks.map((payload, index) => ({
      id: `${payload.repoName ?? "unknown"}:${payload.branchName ?? "unknown"}:${payload.filePath ?? "unknown"}:${payload.startLine ?? 0}:${payload.endLine ?? 0}:${index}`,
      payload,
    })),
    maxResults,
  ).map(chunk => chunk.payload)
}
