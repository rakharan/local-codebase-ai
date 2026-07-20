/**
 * BM25 pre-filter using MiniSearch.
 *
 * Builds an in-memory index from Qdrant payload fields that are useful for
 * exact identifier queries (symbol names, table names, queue names, file paths).
 *
 * Persists the index to disk (.data/bm25-index.json) so subsequent process
 * starts load in <1s instead of scrolling 152k Qdrant points (~60s cold build).
 */

import MiniSearch from "minisearch"
import { QdrantClient } from "@qdrant/js-client-rest"
import { config } from "./config.js"
import type { RetrievedPayload } from "../ask/types.js"

// Dedicated client for BM25 scrolling — separate from the main qdrant client
// to avoid ECONNRESET when both scroll and vector search run concurrently.
const bm25QdrantClient = new QdrantClient({ url: config.qdrantUrl })

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MiniSearchInstance = any

export type BM25IndexEntry = {
  id: string
  repoName: string
  branchName: string
  filePath: string
  startLine: number
  endLine: number
  symbolName: string
  symbols: string
  tables: string
  queues: string
  routes: string
  content: string
  chunkType: string
}

const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000  // 6 hours

let _index: MiniSearchInstance | null = null
let _indexedAt: number = 0
let _indexedPointCount: number = 0
const INDEX_TTL_MS = config.bm25IndexTtlMs

const MINISEARCH_OPTS = {
  fields: ["symbolName", "symbols", "tables", "queues", "routes", "filePath", "content"],
  storeFields: ["id", "repoName", "branchName", "filePath", "startLine", "endLine", "chunkType", "symbolName"],
  searchOptions: {
    boost: { symbolName: 4, symbols: 3, tables: 3, queues: 3, routes: 2, filePath: 1.5, content: 1 },
    fuzzy: 0.1,
    prefix: true,
  },
}

function makeEntry(id: string, payload: RetrievedPayload): BM25IndexEntry {
  return {
    id,
    repoName: payload.repoName ?? "",
    branchName: payload.branchName ?? "",
    filePath: payload.filePath ?? "",
    startLine: payload.startLine ?? 0,
    endLine: payload.endLine ?? 0,
    symbolName: (payload as Record<string, unknown>).symbolName as string ?? "",
    symbols: (payload.symbols ?? []).join(" "),
    tables: (payload.dbTables ?? []).join(" "),
    queues: (payload.queueNames ?? []).join(" "),
    routes: (payload.routes ?? []).join(" "),
    content: (payload.content ?? "").slice(0, 500),
    chunkType: (payload as Record<string, unknown>).chunkType as string ?? "",
  }
}

async function getQdrantPointCount(): Promise<number> {
  try {
    const info = await bm25QdrantClient.getCollection(config.collectionName)
    return info.points_count ?? 0
  } catch {
    return 0
  }
}

async function isCacheValid(pointCount: number, skipPointCountCheck = false): Promise<boolean> {
  try {
    const { existsSync, readFileSync } = await import("node:fs")
    const { resolve } = await import("node:path")
    const metaPath = resolve(".data/bm25-index-meta.json")
    const cachePath = resolve(".data/bm25-index.json")
    if (!existsSync(metaPath) || !existsSync(cachePath)) return false
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { builtAt: number; pointCount: number }
    if (Date.now() - meta.builtAt > CACHE_MAX_AGE_MS) return false
    if (skipPointCountCheck) return true  // trust cache when recently built
    const delta = Math.abs(pointCount - (meta.pointCount ?? 0))
    if (delta / Math.max(pointCount, 1) > 0.01) return false
    return true
  } catch {
    return false
  }
}

async function getCacheAge(): Promise<number> {
  try {
    const { existsSync, readFileSync } = await import("node:fs")
    const { resolve } = await import("node:path")
    const metaPath = resolve(".data/bm25-index-meta.json")
    if (!existsSync(metaPath)) return Infinity
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { builtAt: number }
    return Date.now() - meta.builtAt
  } catch {
    return Infinity
  }
}

async function loadCached(): Promise<MiniSearchInstance | null> {
  try {
    const { existsSync, readFileSync } = await import("node:fs")
    const { resolve } = await import("node:path")
    const cachePath = resolve(".data/bm25-index.json")
    if (!existsSync(cachePath)) return null
    const json = readFileSync(cachePath, "utf8")
    return (MiniSearch as unknown as { loadJSON: (json: string, opts: object) => MiniSearchInstance }).loadJSON(json, MINISEARCH_OPTS)
  } catch (error) {
    // Corrupted/unreadable cache → fall back to cold rebuild, but surface it
    // so a persistently broken cache does not force a ~60s rebuild silently.
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[bm25] loadCached failed, will cold-rebuild: ${message}`)
    return null
  }
}

async function saveToDisk(index: MiniSearchInstance, pointCount: number): Promise<void> {
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs")
    const { resolve, dirname } = await import("node:path")
    const cachePath = resolve(".data/bm25-index.json")
    const metaPath = resolve(".data/bm25-index-meta.json")
    mkdirSync(dirname(cachePath), { recursive: true })
    writeFileSync(cachePath, JSON.stringify(index.toJSON()), "utf8")
    writeFileSync(metaPath, JSON.stringify({ builtAt: Date.now(), pointCount }), "utf8")
  } catch (error) {
    // Non-fatal: in-memory index still serves queries. But a broken disk cache
    // would force a ~60s cold rebuild on every restart, so surface the failure.
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[bm25] saveToDisk failed (non-fatal): ${message}`)
  }
}

async function buildIndex(): Promise<MiniSearchInstance> {
  const index = new (MiniSearch as unknown as new (opts: object) => MiniSearchInstance)(MINISEARCH_OPTS)
  const seen = new Set<string>()
  let offset: string | number | Record<string, unknown> | null | undefined

  do {
    const page = await bm25QdrantClient.scroll(config.collectionName, {
      limit: 512,
      with_payload: true,
      with_vector: false,
      ...(offset ? { offset } : {}),
    })

    for (const point of page.points) {
      const payload = point.payload as RetrievedPayload | null | undefined
      if (!payload?.content) continue
      const hasIdentifiers = (payload.symbols?.length ?? 0) > 0
        || (payload.dbTables?.length ?? 0) > 0
        || (payload.queueNames?.length ?? 0) > 0
        || (payload.routes?.length ?? 0) > 0
        || (payload as Record<string, unknown>).symbolName
      if (!hasIdentifiers) continue
      const id = String(point.id)
      if (seen.has(id)) continue
      seen.add(id)
      try {
        index.add(makeEntry(id, payload))
      } catch {
        // skip docs that cause MiniSearch to throw
      }
    }

    offset = page.next_page_offset
  } while (offset)

  return index
}

async function getCachedPointCount(): Promise<number> {
  try {
    const { existsSync, readFileSync } = await import("node:fs")
    const { resolve } = await import("node:path")
    const metaPath = resolve(".data/bm25-index-meta.json")
    if (!existsSync(metaPath)) return 0
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { pointCount?: number }
    return meta.pointCount ?? 0
  } catch {
    return 0
  }
}

export async function getBM25Index(): Promise<MiniSearchInstance> {
  const now = Date.now()
  if (_index && now - _indexedAt < INDEX_TTL_MS) return _index

  // In-process TTL elapsed. Before reloading from disk (a JSON parse over
  // ~152k points), check whether Qdrant's point count changed since the index
  // was last built. If unchanged, the in-memory index is still valid — bump
  // the timestamp and skip the disk reload entirely.
  if (_index) {
    const currentPointCount = await getQdrantPointCount()
    if (currentPointCount > 0 && currentPointCount === _indexedPointCount) {
      _indexedAt = now
      console.log(`[bm25] TTL elapsed but point count unchanged (${currentPointCount}) — keeping in-memory index`)
      return _index
    }
  }

  // Check cache age first without hitting Qdrant — only validate point count if cache is old
  const cacheAge = await getCacheAge()
  const cacheIsRecent = cacheAge < CACHE_MAX_AGE_MS / 2  // < 3h: trust without point count check

  const pointCount = cacheIsRecent ? 0 : await getQdrantPointCount()

  if (await isCacheValid(pointCount, cacheIsRecent)) {
    const cached = await loadCached()
    if (cached) {
      _index = cached
      _indexedAt = now
      _indexedPointCount = pointCount || await getCachedPointCount()
      console.log(`[bm25] loaded index from disk (pointCount=${_indexedPointCount}, cacheAgeMs=${cacheAge})`)
      return _index
    }
  }

  const fullPointCount = pointCount || await getQdrantPointCount()
  console.log(`[bm25] cold-building index (pointCount=${fullPointCount})`)
  _index = await buildIndex()
  _indexedAt = now
  _indexedPointCount = fullPointCount
  await saveToDisk(_index, fullPointCount)
  return _index
}

/**
 * Search the BM25 index for exact/near-exact identifier matches.
 */
export async function bm25Search(
  query: string,
  limit = 20,
): Promise<Array<{ id: string; score: number; repoName: string; branchName: string; filePath: string; startLine: number; endLine: number; chunkType: string; symbolName: string }>> {
  if (!query.trim()) return []

  const index = await getBM25Index()
  const results = index.search(query).slice(0, limit)

  return results.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    score: r.score,
    repoName: r.repoName as string,
    branchName: r.branchName as string,
    filePath: r.filePath as string,
    startLine: r.startLine as number,
    endLine: r.endLine as number,
    chunkType: r.chunkType as string,
    symbolName: r.symbolName as string,
  }))
}

/**
 * Returns true if the query looks like an exact identifier query.
 */
export function isIdentifierQuery(query: string): boolean {
  if (/[a-z][A-Z]/.test(query)) return true
  if (/\b[a-z][a-z0-9]+_[a-z][a-z0-9_]+\b/.test(query)) return true
  if (/pubsub-|\.queue|queue\.|\.exchange|exchange\./i.test(query)) return true
  if (/\/[a-z]/.test(query)) return true
  return false
}
