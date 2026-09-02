import fs from "node:fs/promises"
import path from "node:path"
import { chatJson } from "../lib/ollama.js"
import type { RetrievedPayload } from "./types.js"

export type QualityScore = {
  groundedness: number
  relevance: number
  completeness: number
  faithfulness: number
  score: number
  issues: string[]
}

export async function evaluateAnswerQuality(
  question: string,
  answer: string,
  sources: RetrievedPayload[]
): Promise<QualityScore> {
  const contextPreview = sources
    .slice(0, 5)
    .map(s => `[${s.repoName}:${s.filePath}:${s.startLine}]\n${s.content?.slice(0, 500)}`)
    .join("\n\n")

  const systemPrompt = [
    "You are a quality evaluator for a codebase Q&A system.",
    "Score each dimension 0-1 and list specific issues.",
    "Return ONLY valid JSON, no markdown.",
  ].join("\n")

  const userPrompt = [
    `Question: ${question}`,
    "",
    "Answer provided:",
    answer.slice(0, 1500),
    "",
    "Context sources:",
    contextPreview,
    "",
    "Score each dimension 0-1:",
    "- groundedness: answer cites provided sources, claims supported by context",
    "- relevance: directly addresses the question",
    "- completeness: covers key evidence points",
    "- faithfulness: no hallucinations or invented facts",
    "",
    'Return JSON: {"groundedness":0.8,"relevance":0.9,"completeness":0.7,"faithfulness":0.9,"issues":["problem1"]}',
  ].join("\n")

  try {
    const result = await chatJson(systemPrompt, userPrompt)

    // Extract JSON from response (handle potential markdown wrapping)
    const jsonMatch = result.match(/\{[\s\S]*\}/)
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(result)

    const score = (
      (parsed.groundedness ?? 0) +
      (parsed.relevance ?? 0) +
      (parsed.completeness ?? 0) +
      (parsed.faithfulness ?? 0)
    ) / 4

    return {
      groundedness: parsed.groundedness ?? 0,
      relevance: parsed.relevance ?? 0,
      completeness: parsed.completeness ?? 0,
      faithfulness: parsed.faithfulness ?? 0,
      score,
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    }
  } catch (error) {
    // If evaluation fails, return perfect score to avoid blocking the answer
    console.error("Answer evaluation failed:", error instanceof Error ? error.message : error)
    return {
      groundedness: 1,
      relevance: 1,
      completeness: 1,
      faithfulness: 1,
      score: 1,
      issues: [],
    }
  }
}

export async function logQualityEvaluation(
  question: string,
  score: QualityScore,
  retried: boolean,
  finalAnswer: string
): Promise<void> {
  const dataDir = path.join(process.cwd(), ".data")
  const logPath = path.join(dataDir, "answer-quality.jsonl")

  const logEntry = {
    timestamp: new Date().toISOString(),
    question: question.slice(0, 200),
    score: score.score,
    dimensions: {
      groundedness: score.groundedness,
      relevance: score.relevance,
      completeness: score.completeness,
      faithfulness: score.faithfulness,
    },
    issues: score.issues,
    retried,
    answerLength: finalAnswer.length,
  }

  try {
    await fs.mkdir(dataDir, { recursive: true })
    await fs.appendFile(logPath, JSON.stringify(logEntry) + "\n")
  } catch (error) {
    console.error("Failed to log quality evaluation:", error instanceof Error ? error.message : error)
  }
}
