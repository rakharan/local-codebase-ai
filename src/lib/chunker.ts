import { sha256, uuidFromHash } from "./hash.js"
import { inferEvidenceTypes } from "./evidence.js"
import { inferRelationshipHints } from "./relationships.js"
import { extractStructuredFacts, type StructuredFact } from "./facts.js"
import type { EvidenceType } from "./evidence.js"
import type { RelationshipHints } from "./relationships.js"
import type { SourceFile } from "./files.js"

export type ProjectTag = {
  projectIds: string[]
  sources: string[]
}

export type ChunkType = "function" | "class" | "method" | "statement" | "section" | "file" | "block"

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
  structuredFacts: StructuredFact[]
  // AST-aware fields
  chunkType: ChunkType
  symbolName?: string | undefined
  parentSymbol?: string | undefined
  hasOverlap: boolean
}

export type ServiceType = "api" | "worker" | "cron" | "library" | "unknown"

const MIN_LINES = 5
const MIN_CHARS = 100
const MAX_LINES = 120
const MAX_CHARS = 2_000
const OVERLAP_LINES = 3
export const INDEX_SCHEMA_VERSION = "branches-v2"

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

type Language = "ts" | "js" | "php" | "sql" | "go" | "markdown" | "json" | "yaml" | "config" | "unknown"

function detectLanguage(filePath: string): Language {
  const lower = filePath.toLowerCase()
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "ts"
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "js"
  if (lower.endsWith(".php")) return "php"
  if (lower.endsWith(".sql")) return "sql"
  if (lower.endsWith(".go")) return "go"
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "markdown"
  if (lower.endsWith(".json")) return "json"
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml"
  const base = lower.split("/").pop() ?? ""
  if (
    base.startsWith(".env") ||
    base.endsWith("rc") ||
    base.endsWith(".config.js") ||
    base.endsWith(".config.ts") ||
    base === "dockerfile" ||
    base === "makefile"
  ) return "config"
  return "unknown"
}

// ---------------------------------------------------------------------------
// Raw segment type
// ---------------------------------------------------------------------------

type RawSegment = {
  startLine: number   // 0-indexed
  endLine: number     // 0-indexed, inclusive
  chunkType: ChunkType
  symbolName?: string | undefined
  parentSymbol?: string | undefined
}

// ---------------------------------------------------------------------------
// Brace end finder
// ---------------------------------------------------------------------------

function findBraceEnd(lines: string[], start: number): number {
  let depth = 0
  let started = false
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i] ?? "") {
      if (ch === "{") { depth++; started = true }
      if (ch === "}") depth--
    }
    if (started && depth === 0) return i
  }
  return Math.min(start + MAX_LINES - 1, lines.length - 1)
}

// ---------------------------------------------------------------------------
// Build segments from heading/boundary indices
// ---------------------------------------------------------------------------

function buildSegmentsFromBoundaries(
  indices: number[],
  lines: string[],
  chunkType: ChunkType,
  clampStart = 0,
  clampEnd = lines.length - 1,
): RawSegment[] {
  const segments: RawSegment[] = []

  // content before first boundary
  if ((indices[0] ?? clampStart) > clampStart) {
    segments.push({ startLine: clampStart, endLine: (indices[0] ?? clampStart) - 1, chunkType })
  }

  for (let i = 0; i < indices.length; i++) {
    const segStart = indices[i] ?? 0
    const segEnd = i + 1 < indices.length ? (indices[i + 1] ?? clampEnd) - 1 : clampEnd
    const symbolName: string | undefined = lines[segStart]?.replace(/^#+\s*/, "").trim()
    segments.push({ startLine: segStart, endLine: segEnd, chunkType, symbolName })
  }

  return segments
}

// ---------------------------------------------------------------------------
// Merge adjacent tiny segments into previous
// ---------------------------------------------------------------------------

function mergeAdjacentSmall(segments: RawSegment[], lines: string[]): RawSegment[] {
  const result: RawSegment[] = []
  for (const seg of segments) {
    const lineCount = seg.endLine - seg.startLine + 1
    const content = lines.slice(seg.startLine, seg.endLine + 1).join("\n")
    if (lineCount < MIN_LINES && content.length < MIN_CHARS && result.length > 0) {
      result[result.length - 1]!.endLine = seg.endLine
      continue
    }
    result.push({ ...seg })
  }
  return result
}

// ---------------------------------------------------------------------------
// Enforce max size — split oversized segments at blank lines
// ---------------------------------------------------------------------------

function enforceMaxSize(segments: RawSegment[], lines: string[]): RawSegment[] {
  const result: RawSegment[] = []
  for (const seg of segments) {
    const lineCount = seg.endLine - seg.startLine + 1
    const charCount = lines.slice(seg.startLine, seg.endLine + 1).join("\n").length
    if (lineCount <= MAX_LINES && charCount <= MAX_CHARS) {
      result.push(seg)
      continue
    }
    let start = seg.startLine
    while (start <= seg.endLine) {
      let end = Math.min(start + MAX_LINES - 1, seg.endLine)
      // snap back to nearest blank line
      let snap = end
      while (snap > start && (lines[snap] ?? "").trim() !== "") snap--
      if (snap > start) end = snap
      result.push({ startLine: start, endLine: end, chunkType: seg.chunkType, symbolName: seg.symbolName, parentSymbol: seg.parentSymbol })
      start = end + 1
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Generic fallback — fixed block splitting
// ---------------------------------------------------------------------------

function splitByBlock(lines: string[]): RawSegment[] {
  const segments: RawSegment[] = []
  let start = 0
  while (start < lines.length) {
    const end = Math.min(start + MAX_LINES - 1, lines.length - 1)
    segments.push({ startLine: start, endLine: end, chunkType: "block" })
    start = end + 1
  }
  return segments
}

// ---------------------------------------------------------------------------
// Language splitters
// ---------------------------------------------------------------------------

function splitTs(lines: string[]): RawSegment[] {
  const segments: RawSegment[] = []
  let i = 0

  while (i < lines.length) {
    const line = (lines[i] ?? "").trimStart()

    const classDecl = /^(export\s+)?(abstract\s+)?class\s+(\w+)/.exec(line)
    const funcDecl = /^(export\s+)?(default\s+)?(async\s+)?function\s+(\w+)/.exec(line)
    const exportedConst = /^export\s+(const|let|var)\s+(\w+)/.exec(line)

    if (classDecl) {
      const className = classDecl[3] ?? "unknown"
      const classEnd = findBraceEnd(lines, i)
      // emit class header (from decl to first method or end)
      // then walk inside for methods
      const methodSegs = extractClassMethods(lines, i, classEnd, className)
      if (methodSegs.length > 0) {
        // class-level header chunk: from class decl to first method - 1
        const firstMethod = methodSegs[0]
        if (firstMethod && firstMethod.startLine > i) {
          segments.push({ startLine: i, endLine: firstMethod.startLine - 1, chunkType: "class", symbolName: className })
        }
        segments.push(...methodSegs)
      } else {
        segments.push({ startLine: i, endLine: classEnd, chunkType: "class", symbolName: className })
      }
      i = classEnd + 1
      continue
    }

    if (funcDecl) {
      const name = funcDecl[4]
      const end = findBraceEnd(lines, i)
      segments.push({ startLine: i, endLine: end, chunkType: "function", symbolName: name })
      i = end + 1
      continue
    }

    if (exportedConst) {
      const name = exportedConst[2]
      const end = findBraceEnd(lines, i)
      segments.push({ startLine: i, endLine: end, chunkType: "function", symbolName: name })
      i = end + 1
      continue
    }

    i++
  }

  if (segments.length === 0) return splitByBlock(lines)
  return mergeAdjacentSmall(segments, lines)
}

function extractClassMethods(lines: string[], classStart: number, classEnd: number, className: string): RawSegment[] {
  const segments: RawSegment[] = []
  // method pattern: optional modifiers + name + ( — indented at least 1 level
  const methodRe = /^(\s+)(async\s+)?(static\s+)?(get\s+|set\s+)?(\w+)\s*\(/
  let i = classStart + 1

  while (i <= classEnd) {
    const raw = lines[i] ?? ""
    const line = raw.trimStart()
    // skip constructor-less lines, decorators, empty
    if (line === "" || line.startsWith("//") || line.startsWith("*") || line.startsWith("@")) { i++; continue }

    const m = methodRe.exec(raw)
    // must be indented (inside class body) and not a nested function keyword
    if (m && (m[1]?.length ?? 0) >= 2 && !line.startsWith("function")) {
      const name = m[5]
      // skip common non-method tokens
      if (name && !["if", "for", "while", "switch", "return", "const", "let", "var", "new"].includes(name)) {
        const end = findBraceEnd(lines, i)
        if (end <= classEnd) {
          segments.push({ startLine: i, endLine: end, chunkType: "method", symbolName: name, parentSymbol: className })
          i = end + 1
          continue
        }
      }
    }
    i++
  }

  return segments
}

function splitPhp(lines: string[]): RawSegment[] {
  const segments: RawSegment[] = []
  let i = 0
  let currentClass: string | undefined

  while (i < lines.length) {
    const line = (lines[i] ?? "").trimStart()

    const classDecl = /^(abstract\s+)?class\s+(\w+)/.exec(line)
    const funcDecl = /^(public|private|protected|static|abstract|\s)*(function)\s+(\w+)/.exec(line)

    if (classDecl) {
      currentClass = classDecl[2]
      segments.push({ startLine: i, endLine: Math.min(i + 5, lines.length - 1), chunkType: "class", symbolName: currentClass })
      i++
      continue
    }

    if (funcDecl) {
      const name = funcDecl[3]
      const end = findBraceEnd(lines, i)
      segments.push({
        startLine: i,
        endLine: end,
        chunkType: currentClass ? "method" : "function",
        symbolName: name,
        parentSymbol: currentClass,
      })
      i = end + 1
      continue
    }

    i++
  }

  if (segments.length === 0) return splitByBlock(lines)
  return mergeAdjacentSmall(segments, lines)
}

function splitSql(lines: string[]): RawSegment[] {
  const segments: RawSegment[] = []
  let start = 0

  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").trimEnd().endsWith(";")) {
      // include preceding comment block
      let commentStart = start
      while (commentStart > 0 && lines[commentStart - 1]?.trim().startsWith("--")) commentStart--
      segments.push({ startLine: commentStart, endLine: i, chunkType: "statement" })
      start = i + 1
    }
  }

  if (start < lines.length) {
    segments.push({ startLine: start, endLine: lines.length - 1, chunkType: "statement" })
  }

  return segments
}

function splitGo(lines: string[]): RawSegment[] {
  const segments: RawSegment[] = []
  let i = 0

  while (i < lines.length) {
    const line = (lines[i] ?? "").trimStart()

    const funcDecl = /^func\s+(\(.*?\)\s+)?(\w+)\s*\(/.exec(line)
    const structDecl = /^type\s+(\w+)\s+struct/.exec(line)

    if (funcDecl) {
      const name = funcDecl[2]
      const end = findBraceEnd(lines, i)
      segments.push({ startLine: i, endLine: end, chunkType: "function", symbolName: name })
      i = end + 1
      continue
    }

    if (structDecl) {
      const name = structDecl[1]
      const end = findBraceEnd(lines, i)
      segments.push({ startLine: i, endLine: end, chunkType: "class", symbolName: name })
      i = end + 1
      continue
    }

    i++
  }

  if (segments.length === 0) return splitByBlock(lines)
  return mergeAdjacentSmall(segments, lines)
}

function splitMarkdown(lines: string[]): RawSegment[] {
  const h2Indices = lines.reduce<number[]>((acc, l, i) => { if (/^##\s/.test(l)) acc.push(i); return acc }, [])

  if (h2Indices.length === 0) {
    const h3Indices = lines.reduce<number[]>((acc, l, i) => { if (/^###\s/.test(l)) acc.push(i); return acc }, [])
    const boundaries = h3Indices.length > 0 ? h3Indices : [0]
    return buildSegmentsFromBoundaries(boundaries, lines, "section")
  }

  const sections = buildSegmentsFromBoundaries(h2Indices, lines, "section")

  // sub-chunk large H2 sections at H3
  const result: RawSegment[] = []
  for (const sec of sections) {
    const charCount = lines.slice(sec.startLine, sec.endLine + 1).join("\n").length
    if (charCount > 3200) {
      const h3Indices = lines.reduce<number[]>((acc, l, i) => {
        if (i >= sec.startLine && i <= sec.endLine && /^###\s/.test(l)) acc.push(i)
        return acc
      }, [])
      if (h3Indices.length > 0) {
        result.push(...buildSegmentsFromBoundaries(h3Indices, lines, "section", sec.startLine, sec.endLine))
        continue
      }
    }
    result.push(sec)
  }

  return result
}

function splitJsonYaml(lines: string[]): RawSegment[] {
  if (lines.length <= 100) {
    return [{ startLine: 0, endLine: lines.length - 1, chunkType: "file" }]
  }

  const topLevelIndices = lines.reduce<number[]>((acc, l, i) => {
    if (l.length > 0 && l[0] !== " " && l[0] !== "\t" && l[0] !== "#") acc.push(i)
    return acc
  }, [])

  if (topLevelIndices.length <= 1) {
    return [{ startLine: 0, endLine: lines.length - 1, chunkType: "file" }]
  }

  return buildSegmentsFromBoundaries(topLevelIndices, lines, "block")
}

function splitConfig(lines: string[]): RawSegment[] {
  if (lines.length <= 150) {
    return [{ startLine: 0, endLine: lines.length - 1, chunkType: "file" }]
  }

  const segments: RawSegment[] = []
  let start = 0

  while (start < lines.length) {
    let end = Math.min(start + 100, lines.length - 1)
    // snap to nearest blank line
    let snap = end
    while (snap > start && (lines[snap] ?? "").trim() !== "") snap--
    if (snap > start) end = snap
    segments.push({ startLine: start, endLine: end, chunkType: "block" })
    start = end + 1
  }

  return segments
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

function getSegments(lines: string[], lang: Language): RawSegment[] {
  switch (lang) {
    case "ts":
    case "js":
      return enforceMaxSize(splitTs(lines), lines)
    case "php":
      return enforceMaxSize(splitPhp(lines), lines)
    case "sql":
      return enforceMaxSize(splitSql(lines), lines)
    case "go":
      return enforceMaxSize(splitGo(lines), lines)
    case "markdown":
      return enforceMaxSize(splitMarkdown(lines), lines)
    case "json":
    case "yaml":
      return enforceMaxSize(splitJsonYaml(lines), lines)
    case "config":
      return splitConfig(lines)
    default:
      return enforceMaxSize(splitByBlock(lines), lines)
  }
}

// ---------------------------------------------------------------------------
// Project hash key
// ---------------------------------------------------------------------------

function projectHashKey(projectIds: string[]): string {
  return projectIds.length > 0 ? projectIds.join(",") : "unassigned"
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
  const lang = detectLanguage(file.relativePath)
  const segments = getSegments(lines, lang)
  const chunks: CodeChunk[] = []

  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si]
    if (!seg) continue

    // 3-line overlap from previous segment
    const prevSeg = si > 0 ? segments[si - 1] : undefined
    const overlapStart = prevSeg
      ? Math.max(seg.startLine - OVERLAP_LINES, prevSeg.startLine)
      : seg.startLine
    const hasOverlap = overlapStart < seg.startLine

    const selectedLines = lines.slice(overlapStart, seg.endLine + 1)
    const content = selectedLines.join("\n").trim()

    // skip tiny chunks
    if (selectedLines.length < MIN_LINES && content.length < MIN_CHARS) continue

    const startLine = overlapStart + 1  // 1-indexed
    const endLine = seg.endLine + 1     // 1-indexed

    const evidenceTypes = inferEvidenceTypes(file.relativePath, content)
    const relationshipHints = inferRelationshipHints(content)
    const structuredFacts = extractStructuredFacts(content, startLine)
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
      structuredFacts,
      chunkType: seg.chunkType,
      symbolName: seg.symbolName,
      parentSymbol: seg.parentSymbol,
      hasOverlap,
    })
  }

  return chunks
}
