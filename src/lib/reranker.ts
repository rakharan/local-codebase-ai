/**
 * Neural reranker using BGE-Reranker-v2-m3 via Ollama.
 *
 * Unlike embedding models, a cross-encoder reranker takes (query, document) pairs
 * and outputs a single relevance score. This is more accurate than cosine similarity
 * for ranking, at the cost of one inference call per document.
 *
 * Usage:
 *   const scored = await rerankChunks("how does deposit demo work", chunks)
 *   // scored[0] is the most relevant chunk
 *
 * Falls back gracefully if Ollama or the reranker model is unavailable.
 * Returns chunks in original order on failure — heuristic reranker handles scoring.
 */

import { config } from "./config.js"
import { dlog, nowMs, elapsedMs } from "./debug-log.js"
import type { RetrievedChunk } from "../ask/types.js"

type OllamaEmbedResponse = {
  embeddings: number[][]
}

const MAX_RERANK_ATTEMPTS = 2
const RERANKER_TIMEOUT_MS = 30_000

// ponytail: single score per chunk — BGE rerankers output one float per (query, doc) pair.
// Ollama exposes this via /api/embed which returns embeddings[]; for reranker models
// the "embedding" is a 1-element array containing the relevance score.
// Upgrade path: if Ollama adds a dedicated /api/rerank endpoint, use that instead.

/**
 * Score a single (query, document) pair using the reranker model.
 * Returns a relevance score (higher = more relevant).
 * Returns 0 on error.
 */
async function scorePair(query: string, document: string): Promise<number> {
  const input = `${query}\n\n${document}`.slice(0, config.rerankerMaxChars * 2)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RERANKER_TIMEOUT_MS)

  try {
    const resp = await fetch(`${config.ollamaUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.rerankerModel,
        input,
      }),
      signal: controller.signal,
    })

    if (!resp.ok) {
      throw new Error(`Ollama reranker HTTP ${resp.status}`)
    }

    const data = (await resp.json()) as OllamaEmbedResponse
    const embedding = data.embeddings?.[0]

    if (!embedding || embedding.length === 0) return 0

    // BGE reranker outputs a single relevance score as the "embedding"
    return embedding[0] ?? 0
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      dlog("reranker", { event: "timeout", queryLen: query.length, docLen: document.length })
    } else {
      dlog("reranker", { event: "error", error: err instanceof Error ? err.message : String(err) })
    }
    return 0
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Batch-score chunks with bounded concurrency.
 *
 * @param query - The user's question
 * @param chunks - Chunks to rerank
 * @returns Array of { chunk, score } sorted by score descending
 */
export async function rerankChunks(
  query: string,
  chunks: RetrievedChunk[],
): Promise<Array<{ chunk: RetrievedChunk; score: number }>> {
  if (chunks.length === 0) return []
  if (!config.rerankerModel) return chunks.map(chunk => ({ chunk, score: 0 }))

  const start = nowMs()
  const concurrency = Math.max(1, config.rerankerConcurrency)
  const results: Array<{ chunk: RetrievedChunk; score: number }> = []

  // Process in batches to avoid overwhelming Ollama
  for (let i = 0; i < chunks.length; i += concurrency) {
    const batch = chunks.slice(i, Math.min(i + concurrency, chunks.length))
    const scores = await Promise.all(
      batch.map(async chunk => {
        const doc = (chunk.payload.content ?? "").slice(0, config.rerankerMaxChars)
        return scorePair(query, doc)
      }),
    )
    for (let j = 0; j < batch.length; j++) {
      results.push({ chunk: batch[j]!, score: scores[j] ?? 0 })
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score)

  dlog("stage", {
    name: "neural-rerank",
    ms: elapsedMs(start),
    inputChunks: chunks.length,
    topScore: results[0]?.score.toFixed(4),
    bottomScore: results[results.length - 1]?.score.toFixed(4),
  })

  return results
}

/**
 * Neural rerank with heuristic fallback.
 *
 * Runs the neural reranker on top-N chunks. If the reranker fails entirely
 * (model not found, Ollama down), returns the chunks in their original
 * heuristic-reranked order.
 *
 * @param query - The user's question
 * @param chunks - Pre-merged chunks (already heuristic-reranked)
 * @param topN - How many chunks to neural-rerank (default: config.rerankerTopN)
 * @returns Chunks reranked by neural score, top first
 */
export async function neuralRerankFallback(
  query: string,
  chunks: RetrievedChunk[],
  topN: number = config.rerankerTopN,
): Promise<RetrievedChunk[]> {
  if (chunks.length === 0 || !config.rerankerModel) return chunks

  // Only rerank the top N — rest keep their heuristic order
  const toRerank = chunks.slice(0, Math.min(topN, chunks.length))
  const rest = chunks.slice(toRerank.length)

  try {
    const scored = await rerankChunks(query, toRerank)
    const reranked = scored.map(s => s.chunk)

    // If all scores are 0, the reranker likely failed silently
    const allZero = scored.every(s => s.score === 0)
    if (allZero) {
      dlog("reranker", { event: "all-zero-scores", status: "fallback-to-heuristic" })
      return chunks // original order
    }

    return [...reranked, ...rest]
  } catch (err) {
    dlog("reranker", {
      event: "rerank-failed",
      error: err instanceof Error ? err.message : String(err),
      status: "fallback-to-heuristic",
    })
    return chunks
  }
}

// Check if the reranker model is available in Ollama
export async function isRerankerAvailable(): Promise<boolean> {
  if (!config.rerankerModel) return false
  try {
    const resp = await fetch(`${config.ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(5_000),
    })
    if (!resp.ok) return false
    const data = await resp.json() as { models?: Array<{ name: string }> }
    return data.models?.some(m => m.name.startsWith(config.rerankerModel)) ?? false
  } catch {
    return false
  }
}
