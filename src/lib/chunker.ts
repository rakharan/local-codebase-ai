import { sha256, uuidFromHash } from "./hash.js"
import { inferEvidenceTypes } from "./evidence.js"
import { inferRelationshipHints } from "./relationships.js"
import type { EvidenceType } from "./evidence.js"
import type { RelationshipHints } from "./relationships.js"
import type { SourceFile } from "./files.js"

export type ProjectTag = {
  projectIds: string[]
  sources: string[]
}

export type CodeChunk = {
  id: string
  repoName: string
  projectIds: string[]
  projectTagSources: string[]
  serviceType: ServiceType
  branchName: string
  commitSha: string
  docLocale?: string
  filePath: string
  startLine: number
  endLine: number
  content: string
  contentHash: string
  evidenceTypes: EvidenceType[]
  relationshipHints: RelationshipHints
}

export type ServiceType = "api" | "worker" | "cron" | "library" | "unknown"

const MAX_LINES = 50
const OVERLAP_LINES = 15
const MAX_CHARS = 2_000
export const INDEX_SCHEMA_VERSION = "branches-v1"

function projectHashKey(projectIds: string[]): string {
  return projectIds.length > 0 ? projectIds.join(",") : "unassigned"
}

export function chunkFile(
  file: SourceFile,
  repoName: string,
  serviceType: ServiceType,
  branchName: string,
  commitSha: string,
  projectIds: string[] = [],
  inferProjectTag: (filePath: string, content: string) => ProjectTag = () => ({
    projectIds,
    sources: projectIds.map(projectId => `repo:${projectId}`),
  }),
): CodeChunk[] {
  const lines = file.content.split("\n")
  const chunks: CodeChunk[] = []

  let start = 0

  while (start < lines.length) {
    const firstLine = lines[start] ?? ""

    if (firstLine.length > MAX_CHARS) {
      for (let offset = 0; offset < firstLine.length; offset += MAX_CHARS) {
        const content = firstLine.slice(offset, offset + MAX_CHARS).trim()

        if (content.length === 0) continue

        const lineNumber = start + 1
        const evidenceTypes = inferEvidenceTypes(file.relativePath, content)
        const relationshipHints = inferRelationshipHints(content)
        const projectTag = inferProjectTag(file.relativePath, content)
        const contentHash = sha256(
          `${INDEX_SCHEMA_VERSION}:${repoName}:${projectHashKey(projectTag.projectIds)}:${branchName}:${serviceType}:${file.relativePath}:${lineNumber}:${lineNumber}:${offset}:${content}`,
        )

        chunks.push({
          id: uuidFromHash(contentHash),
          repoName,
          projectIds: projectTag.projectIds,
          projectTagSources: projectTag.sources,
          serviceType,
          branchName,
          commitSha,
          filePath: file.relativePath,
          startLine: lineNumber,
          endLine: lineNumber,
          content,
          contentHash,
          evidenceTypes,
          relationshipHints,
        })
      }

      start++
      continue
    }

    let end = start
    let charCount = 0

    while (end < lines.length && end - start < MAX_LINES) {
      const nextLine = lines[end] ?? ""
      const nextCharCount = charCount + nextLine.length + 1

      if (end > start && nextCharCount > MAX_CHARS) break

      charCount = nextCharCount
      end++
    }

    // Look backward for leading comment lines to include context
    let commentStart = start
    while (commentStart > 0) {
      const prevLine = lines[commentStart - 1]?.trim() ?? ""
      if (prevLine.startsWith("//") || prevLine.startsWith("/*") || prevLine.startsWith("*") || prevLine.startsWith("#")) {
        commentStart--
      } else {
        break
      }
    }

    const selectedLines = lines.slice(commentStart, end)
    const content = selectedLines.join("\n").trim()

    if (content.length > 0) {
      const startLine = commentStart + 1
      const endLine = end
      const evidenceTypes = inferEvidenceTypes(file.relativePath, content)
      const relationshipHints = inferRelationshipHints(content)
      const projectTag = inferProjectTag(file.relativePath, content)
      const contentHash = sha256(
        `${INDEX_SCHEMA_VERSION}:${repoName}:${projectHashKey(projectTag.projectIds)}:${branchName}:${serviceType}:${file.relativePath}:${startLine}:${endLine}:${content}`,
      )

      chunks.push({
        id: uuidFromHash(contentHash),
        repoName,
        projectIds: projectTag.projectIds,
        projectTagSources: projectTag.sources,
        serviceType,
        branchName,
        commitSha,
        filePath: file.relativePath,
        startLine,
        endLine,
        content,
        contentHash,
        evidenceTypes,
        relationshipHints,
      })
    }

    start = Math.max(end - OVERLAP_LINES, start + 1)
  }

  return chunks
}
