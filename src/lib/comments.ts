import path from "node:path"
import { sha256, uuidFromHash } from "./hash.js"
import { inferRelationshipHints } from "./relationships.js"
import type { CodeChunk, ServiceType } from "./chunker.js"

const INDEX_SCHEMA_VERSION = "comments-v1"

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

  return blocks.filter(block => block.content.length >= 8)
}

export function createCommentChunks(
  filePath: string,
  fileContent: string,
  repoName: string,
  serviceType: ServiceType,
  branchName: string,
  commitSha: string,
): CodeChunk[] {
  const blocks = extractCommentBlocks(filePath, fileContent)
  const chunks: CodeChunk[] = []

  for (const block of blocks) {
    const contentHash = sha256(
      `${INDEX_SCHEMA_VERSION}:${repoName}:${branchName}:${serviceType}:${filePath}:${block.startLine}:${block.endLine}:${block.content}`,
    )

    chunks.push({
      id: uuidFromHash(contentHash),
      repoName,
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
    })
  }

  return chunks
}
