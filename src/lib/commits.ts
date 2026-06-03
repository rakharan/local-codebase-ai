import { sha256, uuidFromHash } from "./hash.js"
import { inferRelationshipHints } from "./relationships.js"
import { extractStructuredFacts } from "./facts.js"
import type { CommitInfo } from "./git.js"
import type { CodeChunk, ServiceType } from "./chunker.js"

const INDEX_SCHEMA_VERSION = "commits-v1"
const COMMIT_BRANCH_NAME = "git-history"

function projectHashKey(projectIds: string[]): string {
  return projectIds.length > 0 ? projectIds.join(",") : "unassigned"
}

export function createCommitChunks(
  commits: CommitInfo[],
  repoName: string,
  serviceType: ServiceType,
  projectIds: string[] = [],
): CodeChunk[] {
  const chunks: CodeChunk[] = []

  for (const commit of commits) {
    const content = [
      `Commit: ${commit.sha}`,
      `Author: ${commit.author}`,
      `Date: ${commit.date}`,
      `Message: ${commit.message}`,
      `Files changed:`,
      ...commit.files.map(file => `- ${file}`),
    ].join("\n")

    const contentHash = sha256(
      `${INDEX_SCHEMA_VERSION}:${repoName}:${projectHashKey(projectIds)}:${COMMIT_BRANCH_NAME}:${serviceType}:${commit.sha}:${content}`,
    )

    chunks.push({
      id: uuidFromHash(contentHash),
      repoName,
      projectIds,
      projectTagSources: projectIds.map(projectId => `repo:${projectId}`),
      serviceType,
      branchName: COMMIT_BRANCH_NAME,
      commitSha: commit.sha,
      filePath: `git:commit:${commit.sha}`,
      startLine: 1,
      endLine: commit.files.length + 4,
      content,
      contentHash,
      evidenceTypes: ["git_commit"],
      relationshipHints: inferRelationshipHints(content),
      structuredFacts: extractStructuredFacts(content),
    })
  }

  return chunks
}
