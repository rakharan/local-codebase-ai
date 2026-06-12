import path from "node:path"
import { sha256, uuidFromHash } from "./hash.js"
import { inferRelationshipHints } from "./relationships.js"
import { extractStructuredFacts } from "./facts.js"
import type { CodeChunk, ServiceType } from "./chunker.js"
import type { ProjectTag } from "./chunker.js"

const INDEX_SCHEMA_VERSION = "comments-v1"

function projectHashKey(projectIds: string[]): string {
  return projectIds.length > 0 ? projectIds.join(",") : "unassigned"
}

type CommentBlock = {
  startLine: number
  endLine: number
  content: string
}

function lineCommentPrefix(ext: string): string[] {
  const jsLike = [".js", ".ts", ".tsx", ".jsx", ".go", ".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".java", ".cs", ".swift", ".rs", ".kt"]
  const hashLike = [".php", ".phtml", ".inc", ".py", ".sh", ".bash", ".zsh", ".ps1", ".yaml", ".yml", ".toml", ".ini", ".conf", ".properties", ".rb", ".pl"]
  const sqlLike = [".sql", ".psql"]

  if (jsLike.includes(ext)) return ["//"]
  if (hashLike.includes(ext)) return ["#", "//"]
  if (sqlLike.includes(ext)) return ["--", "//"]

  return ["#", "//", "--"]
}

function isBlockCommentStart(line: string): boolean {
  return /\/\*/.test(line) && !/\*\//.test(line)
}

function isBlockCommentEnd(line: string): boolean {
  return /\*\//.test(line)
}

function hasSingleLineBlockComment(line: string): boolean {
  return /\/\*.*?\*\//.test(line)
}

function extractSingleLineBlockComment(line: string): string | undefined {
  const match = line.match(/\/\*.*?(\*\/)/)

  return match ? line.slice(line.indexOf("/*"), line.indexOf("*/") + 2) : undefined
}

function extractLineComment(line: string, prefixes: string[]): string | undefined {
  let earliest = -1

  for (const prefix of prefixes) {
    const idx = line.indexOf(prefix)

    if (idx >= 0 && (earliest === -1 || idx < earliest)) {
      earliest = idx
    }
  }

  return earliest >= 0 ? line.slice(earliest) : undefined
}

export function extractCommentBlocks(filePath: string, fileContent: string): CommentBlock[] {
  const ext = path.extname(filePath).toLowerCase()
  const prefixes = lineCommentPrefix(ext)
  const lines = fileContent.split("\n")
  const blocks: CommentBlock[] = []

  let inBlock = false
  let blockStart = 0
  let blockLines: string[] = []

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ""

    if (hasSingleLineBlockComment(line)) {
      const comment = extractSingleLineBlockComment(line)

      if (comment) {
        blocks.push({
          startLine: index + 1,
          endLine: index + 1,
          content: comment,
        })
      }

      continue
    }

    if (isBlockCommentStart(line) && !inBlock) {
      inBlock = true
      blockStart = index + 1
      blockLines = [line]
      continue
    }

    if (inBlock) {
      blockLines.push(line)

      if (isBlockCommentEnd(line)) {
        const content = blockLines.join("\n").trim()

        if (content.length > 0) {
          blocks.push({
            startLine: blockStart,
            endLine: index + 1,
            content,
          })
        }

        inBlock = false
        blockLines = []
      }

      continue
    }

    const lineComment = extractLineComment(line, prefixes)

    if (lineComment) {
      if (blockLines.length > 0 && index === blockStart + blockLines.length) {
        blockLines.push(lineComment)
      } else {
        if (blockLines.length > 0) {
          const content = blockLines.join("\n").trim()

          if (content.length > 0) {
            blocks.push({
              startLine: blockStart,
              endLine: blockStart + blockLines.length - 1,
              content,
            })
          }
        }

        blockStart = index + 1
        blockLines = [lineComment]
      }
    } else if (blockLines.length > 0) {
      const content = blockLines.join("\n").trim()

      if (content.length > 0) {
        blocks.push({
          startLine: blockStart,
          endLine: blockStart + blockLines.length - 1,
          content,
        })
      }

      blockLines = []
    }
  }

  if (blockLines.length > 0) {
    const content = blockLines.join("\n").trim()

    if (content.length > 0) {
      blocks.push({
        startLine: blockStart,
        endLine: blockStart + blockLines.length - 1,
        content,
      })
    }
  }

  return blocks.filter(block => block.content.length >= 8 && !isCommentedOutCode(block.content))
}

/**
 * Returns true if the comment block looks like commented-out code rather than
 * a human-written explanation. We want to index rationale/documentation comments,
 * not disabled code.
 */
function isCommentedOutCode(content: string): boolean {
  // Strip comment markers to get the raw text
  const raw = content
    .replace(/^\/\*+|\*+\/$/g, "")
    .replace(/^\s*\*\s?/gm, "")
    .replace(/^\/\/+\s?/gm, "")
    .replace(/^#+\s?/gm, "")
    .trim()

  if (!raw) return false

  const lines = raw.split("\n").map(l => l.trim()).filter(Boolean)
  if (lines.length === 0) return false

  // Count lines that look like code statements
  const codeLinePatterns = [
    /^(const|let|var|function|class|if|else|for|while|return|import|export|require|await|async)\s/,
    /^\$[a-zA-Z_][\w]*\s*[=({]/, // PHP variables: $foo = ...
    /^[a-zA-Z_][\w]*\s*[=({].*[;,{]$/, // assignment or call ending with ; , {
    /^[a-zA-Z_$][\w.]*\(.*\)[;,]?$/, // function call
    /^\}\s*$/, // closing brace alone
    /^(public|private|protected|static|abstract)\s+(function|class|\$)/, // PHP/Java modifiers
    /^<[a-zA-Z][\w-]*[\s/>]/, // HTML/JSX tags
    /^\[.+\]\s*=/, // array assignment
    /^(echo|print|var_dump|console\.(log|error|warn))\s*[({]/, // debug statements
  ]

  const codeLines = lines.filter(line => codeLinePatterns.some(p => p.test(line)))
  const codeRatio = codeLines.length / lines.length

  // If more than 60% of lines look like code, it's commented-out code
  if (codeRatio > 0.6) return true

  // Single-line comment that is purely a code expression (no prose words)
  if (lines.length === 1) {
    const hasProseWords = /\b(this|the|is|are|was|will|when|how|why|what|note|todo(?!\s*:?\s*$)|fixme|hack|because|should|must|can|use|used|returns?|sets?|gets?|adds?|removes?|handles?|creates?|updates?|deletes?|checks?|fetches?|sends?|calls?)\b/i.test(raw)
    if (!hasProseWords && codeLinePatterns.some(p => p.test(lines[0] ?? ""))) return true
  }

  return false
}

export function createCommentChunks(
  filePath: string,
  fileContent: string,
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
  const blocks = extractCommentBlocks(filePath, fileContent)
  const chunks: CodeChunk[] = []

  for (const block of blocks) {
    const projectTag = inferProjectTag(filePath, block.content)
    const contentHash = sha256(
      `${INDEX_SCHEMA_VERSION}:${repoName}:${projectHashKey(projectTag.projectIds)}:${branchName}:${serviceType}:${filePath}:${block.startLine}:${block.endLine}:${block.content}`,
    )

    chunks.push({
      id: uuidFromHash(contentHash),
      repoName,
      projectIds: projectTag.projectIds,
      projectTagSources: projectTag.sources,
      serviceType,
      branchName,
      commitSha,
      filePath,
      startLine: block.startLine,
      endLine: block.endLine,
      content: block.content,
      contentHash,
      evidenceTypes: ["comment"],
      relationshipHints: inferRelationshipHints(block.content),
      structuredFacts: extractStructuredFacts(block.content, block.startLine),
      chunkType: "block",
      hasOverlap: false,
    })
  }

  return chunks
}
