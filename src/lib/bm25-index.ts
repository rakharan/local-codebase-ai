/**
 * BM25 pre-filter using MiniSearch.
 *
 * Builds an in-memory index from Qdrant payload fields that are useful for
 * exact identifier queries (symbol names, table names, queue names, file paths).
 *
 * Used by ask.ts to fast-path queries that contain exact identifiers before
 * falling back to vector search.
 */

import MiniSearch from "minisearch"
import { qdrant } from "./qdrant.js"
import { config } from "./config.js"
import type { RetrievedPayload } from "../ask/types.js"

export type BM25IndexEntry = {
  id: string
  repoName: string
  branchName: string
  filePath: string
  startLine: number
  endLine: number
  symbolName: string   // symbolName from new chunker (may be empty)
  symbols: string      // space-joined symbols from relationshipHints
  tables: string       // space-joined dbTables
  queues: string       // space-joined queueNames
  routes: string       // space-joined routes
  content: string      // first 500 chars of content (for term matching)
  chunkType: string
}

let _index: MiniSearch<BM25IndexEntry> | null = null
let _indexedAt: number = 0
const INDEX_TTL_MS = 10 * 60 * 1000  // rebuild after 10 min

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

async function buildIndex(): Promise<MiniSearch<BM25IndexEntry>> {
  const index = new MiniSearch<BM25IndexEntry>({
    fields: ["symbolName", "symbols", "tables", "queues", "routes", "filePath", "content"],
    storeFields: ["id", "repoName", "branchName", "filePath", "startLine", "endLine", "chunkType", "symbolName"],
    searchOptions: {
      boost: { symbolName: 4, symbols: 3, tables: 3, queues: 3, routes: 2, filePath: 1.5, content: 1 },
      fuzzy: 0.1,
      prefix: true,
    },
  })

  const docs: BM25IndexEntry[] = []
  let offset: string | number | Record<string, unknown> | null | undefined

  do {
    const page = await qdrant.scroll(config.collectionName, {
      limit: 512,
      with_payload: true,
      with_vector: false,
      ...(offset ? { offset } : {}),
    })

    for (const point of page.points) {
      const payload = point.payload as RetrievedPayload | null | undefined
      if (!payload?.content) continue
      docs.push(makeEntry(String(point.id), payload))
    }

    offset = page.next_page_offset
  } while (offset)

  index.addAll(docs)
  return index
}

export async function getBM25Index(): Promise<MiniSearch<BM25IndexEntry>> {
  const now = Date.now()
  if (_index && now - _indexedAt < INDEX_TTL_MS) return _index

  _index = await buildIndex()
  _indexedAt = now
  return _index
}

/**
 * Search the BM25 index for exact/near-exact identifier matches.
 * Returns chunk IDs sorted by BM25 score, best first.
 */
export async function bm25Search(
  query: string,
  limit = 20,
): Promise<Array<{ id: string; score: number; repoName: string; branchName: string; filePath: string; startLine: number; endLine: number; chunkType: string; symbolName: string }>> {
  if (!query.trim()) return []

  const index = await getBM25Index()
  const results = index.search(query).slice(0, limit)

  return results.map(r => ({
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
 * Returns true if the query looks like an exact identifier query —
 * contains a camelCase symbol, snake_case table name, queue name, or route path.
 */
export function isIdentifierQuery(query: string): boolean {
  // camelCase symbol: e.g. UploadKYCAsync, getTradersAsync
  if (/[a-z][A-Z]/.test(query)) return true
  // snake_case table: e.g. dsc_signals, traders_details
  if (/\b[a-z][a-z0-9]+_[a-z][a-z0-9_]+\b/.test(query)) return true
  // queue name pattern: pubsub-*, queue.*, *.queue
  if (/pubsub-|\.queue|queue\.|\.exchange|exchange\./i.test(query)) return true
  // route path
  if (/\/[a-z]/.test(query)) return true

  return false
}
