// Mermaid

import type { RetrievedPayload } from "./types.js"
import { localized } from "../ask.js"
import { retrieveFileChunks } from "./retrieve.js"
import { extractConceptTokens, questionAsksForDiagram, questionAsksHowWorks, unique } from "./question.js"

export function stripDocChunkMetadata(content: string): string {
  return content
    .split(/\r?\n/)
    .filter(line => !/^(Documentation|Source|Locale|title|description|file):/i.test(line.trim()))
    .join("\n")
}


export function extractMermaidBlocks(content: string): string[] {
  const blocks = [
    ...[...content.matchAll(/```mermaid\s*([\s\S]*?)```/gi)].map(match => match[1] ?? ""),
    ...[...content.matchAll(/<ZoomableMermaid\s+chart=\{`\s*([\s\S]*?)`\s*\}\s*\/?>/gi)].map(match => match[1] ?? ""),
  ]

  return blocks
    .map(block => block.trim())
    .filter(block => /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt)\b/i.test(block))
}


export function scoreMermaidBlock(block: string, question: string): number {
  const lowerBlock = block.toLowerCase()
  const lowerQuestion = question.toLowerCase()
  let score = 0

  for (const token of extractConceptTokens(question)) {
    if (lowerBlock.includes(token.toLowerCase())) score += 10
  }

  if (/\bsignal|isignal|auto copy\b/i.test(lowerQuestion) && /signal|isignal|auto copy/i.test(block)) score += 30
  if (/\bsignal|isignal|auto copy|copy signal\b/i.test(lowerQuestion) && /SignalBroadcast/i.test(block)) score += 240
  if (/\bsignal|isignal|auto copy|copy signal\b/i.test(lowerQuestion) && /Trade Publisher|Active iSignal Bots/i.test(block)) score += 90
  if (/\bauto copy|copy signal\b/i.test(lowerQuestion) && !/SignalBroadcast/i.test(block)) score -= 80
  if (/\bflow|works?|cara kerja|alur\b/i.test(lowerQuestion) && /flow|start|-->|publish|consume|process/i.test(block)) score += 20
  if (/\barchitecture|arsitektur\b/i.test(lowerQuestion) && /architecture|service|api|worker/i.test(block)) score += 16

  return score
}


export async function buildMermaidDiagramAnswer(chunks: RetrievedPayload[], question: string): Promise<MermaidDiagramAnswer | undefined> {
  if (!questionAsksForDiagram(question) && !questionAsksHowWorks(question)) return undefined

  const docChunks = chunks
    .filter(chunk => chunk.evidenceTypes?.includes("documentation"))
    .filter(chunk => /mermaid|graph\s+(?:TB|TD|LR|RL|BT)|flowchart|sequenceDiagram|ZoomableMermaid/i.test(chunk.content ?? ""))

  // When asking how something works, proactively include diagrams.mdx chunks
  // even if they didn't rank in the top vector results
  const isIsignalQuestion = /\b(isignal|auto copy|copy signal|bot copy)\b/i.test(question)
  const isChannelSubsQuestion = /\b(channel.?subs|channel subscription)\b/i.test(question)
  const proactiveDiagramKeys: string[] = []
  if (questionAsksHowWorks(question)) {
    if (isIsignalQuestion) {
      proactiveDiagramKeys.push("isignal|docs|docs:isignal-docs\\architecture\\diagrams.mdx")
    }
    if (isChannelSubsQuestion) {
      proactiveDiagramKeys.push("channel-subscription|docs|docs:channel-subs-docs\\architecture\\diagrams.mdx")
    }
  }

  const candidateFiles = unique(
    [
      ...docChunks.map(chunk => [chunk.repoName, chunk.branchName, chunk.filePath].join("|")),
      ...proactiveDiagramKeys,
    ].filter(key => !key.includes("undefined")),
    8,
  )

  const candidates: Array<{ block: string; source: RetrievedPayload; score: number }> = []

  for (const key of candidateFiles) {
    const [repoName, branchName, filePath] = key.split("|")
    if (!repoName || !branchName || !filePath) continue

    const fileChunks = await retrieveFileChunks(repoName, branchName, filePath)
    const fullContent = fileChunks.map(chunk => stripDocChunkMetadata(chunk.payload.content ?? "")).join("\n")

    for (const block of extractMermaidBlocks(fullContent)) {
      const signatureLine = block
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(line => line.length > 12 &&
          !/^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|classDef|style|%%)\b/i.test(line))
      const source = fileChunks.find(chunk => {
        const content = chunk.payload.content ?? ""

        return signatureLine ? content.includes(signatureLine) : /mermaid|ZoomableMermaid/i.test(content)
      })?.payload ?? fileChunks[0]?.payload

      if (!source) continue

      candidates.push({
        block,
        source,
        score: scoreMermaidBlock(block, question),
      })
    }
  }

  candidates.sort((left, right) => right.score - left.score)

  const best = candidates[0]
  if (!best) return undefined

  const answer = [
    localized("Flowchart dari dokumentasi ter-index:", "Flowchart from indexed documentation:"),
    localized(
      "Konteks: iSignal / Auto Copy adalah flow copy signal/sinyal dari master channel ke akun user.",
      "Context: iSignal / Auto Copy (bot copy) is the copy-signal flow from master channels to user accounts.",
    ),
    "",
    "```mermaid",
    best.block,
    "```",
    "",
    localized(
      "Catatan: diagram ini diambil dari Mermaid yang sudah ter-index. Edge yang tidak ada di diagram/source tidak ditambahkan.",
      "Note: this diagram is taken from indexed Mermaid documentation. Edges not present in the diagram/source were not added.",
    ),
  ].join("\n")

  return {
    answer,
    sources: [best.source],
  }
}


export type MermaidDiagramAnswer = {
  answer: string
  sources: RetrievedPayload[]
}
