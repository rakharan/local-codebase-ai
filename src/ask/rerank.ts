// Rerank
// Refactored from ask.ts — uses ctx for shared state

import { config } from "../lib/config.js"
import type { RelationshipHints } from "../lib/relationships.js"
import { extractQuestionTerms } from "../lib/vocabulary.js"
import type { RetrievedChunk, RetrievedPayload } from "./types.js"
import { ctx } from "./context.js"
import { registryExactSearchTerms, textForExactSearch } from "./route-analysis.js"
import { extractConceptTokens, extractQuestionHints, extractQuestionRoutes, questionAsksAboutDatabase, questionAsksAboutGlossary, questionAsksAboutServicesOrFlow, questionAsksForDiagram, questionAsksHowWorks, questionAsksInventory, unique } from "./question.js"

export function collectHints(chunks: RetrievedChunk[]): RelationshipHints {
  return {
    routes: unique(chunks.flatMap(chunk => chunk.payload.routes ?? []), 8),
    symbols: unique(chunks.flatMap(chunk => chunk.payload.symbols ?? []), 12),
    messageNames: unique(chunks.flatMap(chunk => chunk.payload.messageNames ?? []), 12),
    queueNames: unique(chunks.flatMap(chunk => chunk.payload.queueNames ?? []), 8),
    exchangeNames: unique(chunks.flatMap(chunk => chunk.payload.exchangeNames ?? []), 8),
    dbTables: unique(chunks.flatMap(chunk => chunk.payload.dbTables ?? []), 8),
  }
}


export function rerankRetrievedChunks(questionText: string, chunks: RetrievedChunk[]): RetrievedChunk[] {
  const exactTerms = unique([
    ...extractQuestionHints(questionText),
    ...extractQuestionRoutes(questionText),
    ...extractQuestionTerms(questionText),
    ...registryExactSearchTerms(),
  ], 80)
  const asksDb = questionAsksAboutDatabase(questionText)
  const asksFlow = questionAsksAboutServicesOrFlow(questionText)
  const asksGlossary = questionAsksAboutGlossary(questionText)
  const asksDiagram = questionAsksForDiagram(questionText)
  const asksHowWorks = questionAsksHowWorks(questionText)

  return chunks
    .map((chunk, index) => {
      const payload = chunk.payload
      const content = payload.content ?? ""
      const text = textForExactSearch(payload).toLowerCase()
      let score = Math.max(0, chunks.length - index)

      for (const term of exactTerms) {
        const normalizedTerm = term.toLowerCase()
        if (!normalizedTerm) continue
        if (text.includes(normalizedTerm)) score += normalizedTerm.includes("/") ? 75 : 18
        if ((payload.routes ?? []).some(route => route.toLowerCase() === normalizedTerm)) score += 100
        if ((payload.symbols ?? []).some(symbol => symbol.toLowerCase() === normalizedTerm)) score += 45
        if (payload.symbolName && payload.symbolName.toLowerCase() === normalizedTerm) score += 80
        if ((payload.queueNames ?? []).some(queue => queue.toLowerCase() === normalizedTerm)) score += 55
        if ((payload.dbTables ?? []).some(table => table.toLowerCase() === normalizedTerm)) score += 55
      }

      if (asksDb && ((payload.dbTables?.length ?? 0) > 0 || payload.structuredFacts?.some(fact => fact.category === "database"))) score += 35
      if (asksFlow && ((payload.routes?.length ?? 0) > 0 || (payload.messageNames?.length ?? 0) > 0 || (payload.queueNames?.length ?? 0) > 0)) score += 30
      if (asksGlossary && (payload.evidenceTypes?.includes("documentation") || payload.filePath?.startsWith("vocabulary://"))) score += 22
      if (asksDiagram && /```mermaid|graph\s+(?:TD|TB|LR|RL)|flowchart/i.test(content)) score += 85
      if (asksHowWorks && /mermaid|ZoomableMermaid|graph\s+(?:TD|TB|LR|RL)|flowchart/i.test(content)) score += 75

      for (const fact of payload.structuredFacts ?? []) {
        if (asksDb && fact.category === "database") score += 16
        if (asksFlow && (fact.category === "message" || fact.category === "control_flow" || fact.category === "input" || fact.category === "return")) score += 8
        if (/validasi|validation|request body|return|response|formula|rule|aturan|syarat/i.test(questionText)) {
          if (["validation", "input", "return", "formula", "constant"].includes(fact.category)) score += 12
        }
      }

      if (payload.filePath?.startsWith("knowledge-notes://")) score += 20
      if (payload.noteStatus === "proposal") score += /proposal|meeting|change|recent|terbaru|perubahan/i.test(questionText) ? 35 : -5

      // Product-specific doc bias correction: when ctx.question is about a specific product,
      // boost its docs and penalize unrelated product docs.
      const isIsignalQuestion = ctx.registryExpansion.terms.map(t => t.toLowerCase()).includes("isignal")
      if (isIsignalQuestion) {
        const fp = payload.filePath?.toLowerCase() ?? ""
        const rn = payload.repoName?.toLowerCase() ?? ""
        if (fp.includes("isignal-docs") || rn.includes("isignal")) score += 50
        else if (payload.evidenceTypes?.includes("documentation") && (fp.includes("fa-porto-docs") || fp.includes("devops-docs"))) score -= 80
      }

      // Decision/ADR boost — approved decisions carry retrieval_priority: 10 from Qdrant payload
      if (payload.source_type === "decision") {
        score += (payload.retrieval_priority ?? 0) * 2
        if (/decided|decision|changed|why|rationale|rule|aturan|diputuskan|alasan|perubahan/i.test(questionText)) score += 40
      }

      // Boost comment chunks for rationale/meaning questions
      if (payload.evidenceTypes?.includes("comment")) {
        score += /\b(why|kenapa|mengapa|what does|apa itu|artinya|maksud|mean|means|meaning|rationale|reason|alasan|explain|jelasin|jelaskan)\b/i.test(questionText) ? 35 : 8
      }
      // Boost migration chunks for column value meaning questions
      if (payload.evidenceTypes?.includes("migration")) {
        score += /\b(status|value|nilai|arti|mean|means|apa itu|what does|column|kolom)\b/i.test(questionText) ? 25 : 0
      }

      // Inventory intent detection and Repo Doctor chunk boosting
      const isDoctorChunk = payload.filePath?.startsWith("doctor:") || payload.filePath?.startsWith("doctor-fact:")
      const asksServiceInventory = /\b(what services|services? (detected|list|available)|detected (services?|repos?)|list.*(services?|repos?))\b/i.test(questionText)
      const asksEnvInventory = /\b(environment variables?|env vars?|process\.env|what env|which env)\b/i.test(questionText)
      const asksDbInventory = /\b(database tables?|db tables?|which tables?|what tables?|tables? (used|detected))\b/i.test(questionText)
      const isInventoryQuestion = asksServiceInventory || asksEnvInventory || asksDbInventory

      if (isDoctorChunk) {
        if (isInventoryQuestion) {
          // Strong boost for inventory questions — doctor facts are the primary source
          score += 100
          if (asksServiceInventory && (payload.filePath?.includes("service") || payload.filePath?.includes("overview"))) score += 50
          if (asksEnvInventory && payload.filePath?.includes("env")) score += 50
          if (asksDbInventory && (payload.filePath?.includes("database") || (payload.dbTables?.length ?? 0) > 0)) score += 50
        } else if (/\b(services?|routes?|api|endpoints?|env|environment|rabbitmq|queues?|exchanges?|databases?|tables?|dependenc|architecture|onboarding)\b/i.test(questionText)) {
          score += 40
        }
      }

      // Repo-name penalty: penalize unrelated repos for inventory questions with explicit repo name
      if (isInventoryQuestion) {
        const mentionedRepo = questionText.match(/\b([\w-]+-(?:service|worker|cron|ois|tf2|ims|admin|api)[\w-]*)\b/i)?.[1]?.toLowerCase()
        if (mentionedRepo && payload.repoName) {
          const chunkRepo = payload.repoName.toLowerCase()
          if (chunkRepo === mentionedRepo || chunkRepo.includes(mentionedRepo) || mentionedRepo.includes(chunkRepo)) {
            score += 30
          } else {
            score -= 40
          }
        }
      }

      return { chunk, score }
    })
    .sort((left, right) => right.score - left.score)
    // Repo diversity pass — penalize 3rd+ chunk from the same repo so one repo
    // can't dominate all top slots. First two chunks per repo are unaffected.
    .map((() => {
      const repoCount = new Map<string, number>()
      return (item: { chunk: RetrievedChunk; score: number }) => {
        const repo = item.chunk.payload.repoName ?? ""
        const count = repoCount.get(repo) ?? 0
        repoCount.set(repo, count + 1)
        // 3rd chunk: -30, 4th: -60, 5th+: -90
        const diversityPenalty = count >= 2 ? Math.min(30 * (count - 1), 90) : 0
        return { chunk: item.chunk, score: item.score - diversityPenalty }
      }
    })())
    .sort((left, right) => right.score - left.score)
    .map(item => item.chunk)
}


export function chunkHasStrongQuestionEvidence(chunk: RetrievedPayload, questionText: string): boolean {
  const text = [
    chunk.repoName ?? "",
    chunk.filePath ?? "",
    chunk.content ?? "",
    ...(chunk.routes ?? []),
    ...(chunk.symbols ?? []),
    ...(chunk.messageNames ?? []),
    ...(chunk.queueNames ?? []),
    ...(chunk.exchangeNames ?? []),
    ...(chunk.dbTables ?? []),
  ].join("\n").toLowerCase()
  const terms = unique([
    ...extractQuestionRoutes(questionText),
    ...extractQuestionHints(questionText),
    ...extractQuestionTerms(questionText),
    ...extractConceptTokens(questionText),
    ...registryExactSearchTerms(),
  ].filter(term => term.length >= 2), 48)

  if (terms.length === 0) return true

  return terms.some(term => text.includes(term.toLowerCase()))
}


export function scoreFallbackContextChunk(chunk: RetrievedPayload, questionText: string): number {
  const lowerQuestion = questionText.toLowerCase()
  const text = [
    chunk.repoName ?? "",
    chunk.filePath ?? "",
    chunk.content ?? "",
    ...(chunk.routes ?? []),
    ...(chunk.symbols ?? []),
    ...(chunk.messageNames ?? []),
    ...(chunk.queueNames ?? []),
    ...(chunk.exchangeNames ?? []),
    ...(chunk.dbTables ?? []),
  ].join("\n").toLowerCase()
  let score = 0

  if (chunk.filePath?.startsWith("knowledge-notes://")) score += 70
  if (chunk.filePath?.startsWith("decision://")) {
    score += (chunk.retrieval_priority ?? 0) * 2
    if (/decided|decision|changed|why|rationale|rule|aturan|diputuskan|alasan|perubahan/i.test(questionText)) score += 40
  }
  if (chunk.filePath?.startsWith("vocabulary://")) score += questionAsksAboutGlossary(questionText) ? 50 : 8
  if (chunk.filePath?.startsWith("doctor:") || chunk.filePath?.startsWith("doctor-fact:")) score += questionAsksInventory(questionText) ? 80 : 20
  if (chunk.evidenceTypes?.includes("documentation")) score += questionAsksAboutGlossary(questionText) || questionAsksHowWorks(questionText) || questionAsksInventory(questionText) ? 25 : -12
  // Boost comment chunks for rationale/meaning questions — comments often explain WHY
  if (chunk.evidenceTypes?.includes("comment")) {
    score += /\b(why|kenapa|mengapa|what does|apa itu|artinya|maksud|mean|means|meaning|rationale|reason|alasan|explain|jelasin|jelaskan)\b/i.test(questionText) ? 35 : 8
  }
  // Boost migration chunks for "what does X mean" questions about DB columns/values
  if (chunk.evidenceTypes?.includes("migration")) {
    score += /\b(status|value|nilai|arti|mean|means|apa itu|what does|column|kolom)\b/i.test(questionText) ? 25 : 0
  }
  // For "how works" questions, boost implementation code over docs —
  // code chunks with routes/queues/tables show the actual implementation.
  if (questionAsksHowWorks(questionText) && !chunk.evidenceTypes?.includes("documentation")) {
    if ((chunk.routes?.length ?? 0) > 0 || (chunk.queueNames?.length ?? 0) > 0 || (chunk.exchangeNames?.length ?? 0) > 0 || (chunk.dbTables?.length ?? 0) > 0 || (chunk.symbols?.length ?? 0) > 0) {
      score += 35
    }
  }
  if ((chunk.routes?.length ?? 0) > 0) score += 28
  if ((chunk.symbols?.length ?? 0) > 0) score += 18
  if ((chunk.messageNames?.length ?? 0) > 0 || (chunk.queueNames?.length ?? 0) > 0 || (chunk.exchangeNames?.length ?? 0) > 0) score += 24
  if ((chunk.dbTables?.length ?? 0) > 0) score += questionAsksAboutDatabase(questionText) ? 35 : 12
  if (chunk.evidenceTypes?.includes("env_config")) score += /\b(config|env|minimum|minimal|syarat|requirement|rules?|aturan)\b/i.test(questionText) ? 30 : 4
  if (chunk.evidenceTypes?.includes("test")) score -= 10
  if (!ctx.repoName && chunk.repoName === "local-codebase-ai") score -= 100

  for (const term of unique([...extractQuestionHints(questionText), ...extractQuestionTerms(questionText), ...extractConceptTokens(questionText)], 36)) {
    const normalized = term.toLowerCase()

    if (normalized.length < 2) continue
    if (text.includes(normalized)) score += normalized.includes("/") ? 55 : 10
  }

  if (lowerQuestion.includes("isignal") && /isignal|auto copy|copy signal|bot copy|dsc_/i.test(text)) score += 22
  if (lowerQuestion.includes("flow") || lowerQuestion.includes("alur") || lowerQuestion.includes("jelasin")) {
    if (/route|handler|rpc|queue|consumer|publisher|model|controller/i.test(text)) score += 18
  }

  return score
}


export function selectFallbackContextChunks(chunks: RetrievedPayload[], questionText: string): RetrievedPayload[] {
  const maxContextChunks = ctx.deepMode ? 28 : Math.max(ctx.limit, 12)
  const scored = chunks
    .filter(chunk => chunk.content)
    .filter(chunk => chunkHasStrongQuestionEvidence(chunk, questionText) || questionAsksAboutGlossary(questionText))
    .map((chunk, index) => ({
      chunk,
      index,
      score: scoreFallbackContextChunk(chunk, questionText),
    }))
    .filter(item => item.score > -40)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, maxContextChunks)
    .map(item => item.chunk)

  return scored.length > 0 ? scored : chunks.slice(0, maxContextChunks)
}
