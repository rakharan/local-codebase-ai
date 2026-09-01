/**
 * BM25 pre-filter using MiniSearch.
 *
 * Builds an in-memory index from Qdrant payload fields that are useful for
 * exact identifier queries (symbol names, table names, queue names, file paths).
 *
 * Persists the index to disk (.data/bm25-index.json) so subsequent process
 * starts load from disk instead of scrolling ~160k Qdrant points.
 *
 * Cross-process safety: when multiple ask.ts processes start concurrently
 * (e.g. parallel /api/ask requests), a build lock ensures only ONE process
 * cold-builds. Others wait for the cache file and then load it.
 */

import MiniSearch from "minisearch"
import { QdrantClient } from "@qdrant/js-client-rest"
import { config } from "./config.js"
import { dlog, nowMs, elapsedMs } from "./debug-log.js"
import type { RetrievedPayload } from "../ask/types.js"
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  statSync,
} from "node:fs"
import { resolve, dirname } from "node:path"

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

// --- Stable absolute cache paths ---
// Resolved once from process.cwd() so every ask.ts child process (spawned by
// the server with cwd=rootDir) uses the same on-disk cache.
const CACHE_DIR = resolve(process.cwd(), ".data")
const CACHE_PATH = resolve(CACHE_DIR, "bm25-index.json")
const META_PATH = resolve(CACHE_DIR, "bm25-index-meta.json")
const BUILD_LOCK_PATH = resolve(CACHE_DIR, "bm25-build.lock")

const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000  // 6 hours
const BUILD_LOCK_TIMEOUT_MS = config.bm25WaitTimeoutMs  // env-configurable; default 5 min
const BUILD_LOCK_POLL_MS = 2_000               // poll interval when waiting for another process

// Bump when the cache format changes to invalidate old caches.
const CACHE_SCHEMA_VERSION = 5

type CacheMeta = {
  schemaVersion: number
  collectionName: string
  builtAt: number
  pointCount: number
}

let _index: MiniSearchInstance | null = null
let _indexedAt: number = 0
let _indexedPointCount: number = 0
const INDEX_TTL_MS = config.bm25IndexTtlMs

const MINISEARCH_OPTS = {
  fields: ["symbolName", "symbols", "tables", "queues", "routes", "filePath", "content", "repoName"],
  storeFields: ["id", "repoName", "branchName", "filePath", "startLine", "endLine", "chunkType", "symbolName"],
  searchOptions: {
    boost: { symbolName: 4, symbols: 3, tables: 3, queues: 3, routes: 2, filePath: 1.5, repoName: 2, content: 1 },
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

// --- Qdrant helpers ---

async function getQdrantPointCount(): Promise<number> {
  try {
    const info = await bm25QdrantClient.getCollection(config.collectionName)
    return info.points_count ?? 0
  } catch {
    return 0
  }
}

// --- Cache metadata ---

function readCacheMeta(): CacheMeta | null {
  try {
    if (!existsSync(META_PATH)) return null
    const raw = readFileSync(META_PATH, "utf8")
    const meta = JSON.parse(raw) as Partial<CacheMeta>
    if (
      typeof meta.schemaVersion !== "number" ||
      typeof meta.builtAt !== "number" ||
      typeof meta.pointCount !== "number"
    ) {
      console.warn(`[bm25] cache meta invalid shape: ${raw.slice(0, 200)}`)
      return null
    }
    if (meta.schemaVersion !== CACHE_SCHEMA_VERSION) {
      console.warn(`[bm25] cache schema version mismatch (got ${meta.schemaVersion}, want ${CACHE_SCHEMA_VERSION}) — rebuilding`)
      return null
    }
    if (meta.collectionName && meta.collectionName !== config.collectionName) {
      console.warn(`[bm25] cache collection mismatch (got ${meta.collectionName}, want ${config.collectionName}) — rebuilding`)
      return null
    }
    return meta as CacheMeta
  } catch (err) {
    console.warn(`[bm25] readCacheMeta failed: ${err instanceof Error ? err.message : err}`)
    return null
  }
}

function isCacheValid(pointCount: number, skipPointCountCheck: boolean): boolean {
  const meta = readCacheMeta()
  if (!meta) return false
  if (!existsSync(CACHE_PATH)) return false
  if (Date.now() - meta.builtAt > CACHE_MAX_AGE_MS) return false
  if (skipPointCountCheck) return true
  const delta = Math.abs(pointCount - meta.pointCount)
  if (delta / Math.max(pointCount, 1) > 0.01) return false
  return true
}

function loadCached(): MiniSearchInstance | null {
  try {
    if (!existsSync(CACHE_PATH)) {
      console.warn(`[bm25] loadCached: cache file missing at ${CACHE_PATH}`)
      return null
    }
    const stat = statSync(CACHE_PATH)
    const json = readFileSync(CACHE_PATH, "utf8")
    console.log(`[bm25] loadCached: parsing ${Math.round(stat.size / 1_048_576)}MB JSON from ${CACHE_PATH}`)
    const instance = (MiniSearch as unknown as { loadJSON: (json: string, opts: object) => MiniSearchInstance }).loadJSON(json, MINISEARCH_OPTS)
    console.log(`[bm25] loadCached: MiniSearch instance created successfully`)
    return instance
  } catch (err) {
    console.warn(`[bm25] loadCached failed, will cold-rebuild: ${err instanceof Error ? err.message : err}`)
    return null
  }
}

/**
 * Save index to disk atomically: write to temp file, then rename. Prevents
 * partial writes from corrupting the cache when multiple processes or an
 * interrupted exit occur.
 */
function saveToDisk(index: MiniSearchInstance, pointCount: number): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    const tmpCachePath = CACHE_PATH + ".tmp"
    const tmpMetaPath = META_PATH + ".tmp"

    const json = JSON.stringify(index.toJSON())
    const meta: CacheMeta = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      collectionName: config.collectionName,
      builtAt: Date.now(),
      pointCount,
    }

    writeFileSync(tmpCachePath, json, "utf8")
    writeFileSync(tmpMetaPath, JSON.stringify(meta), "utf8")

    // Atomic rename (same filesystem).
    renameSync(tmpCachePath, CACHE_PATH)
    renameSync(tmpMetaPath, META_PATH)

    console.log(`[bm25] saveToDisk: wrote ${Math.round(json.length / 1_048_576)}MB index + meta to ${CACHE_PATH}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[bm25] saveToDisk failed (non-fatal): ${message}`)
  }
}

// --- Cross-process build lock ---
// Prevents N concurrent ask.ts processes from all cold-building simultaneously.
// First process acquires the lock, builds, saves. Others wait and load the cache.

function tryAcquireBuildLock(): boolean {
  try {
    mkdirSync(CACHE_DIR, { recursive: true })
    const payload = JSON.stringify({ pid: process.pid, startedAt: Date.now() })
    writeFileSync(BUILD_LOCK_PATH, payload, { flag: "wx" })
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "EEXIST") return false
    // Non-EEXIST error — log but don't block (fall through to build).
    console.warn(`[bm25] tryAcquireBuildLock unexpected error: ${err instanceof Error ? err.message : err}`)
    return true
  }
}

function releaseBuildLock(): void {
  try {
    unlinkSync(BUILD_LOCK_PATH)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== "ENOENT") {
      console.warn(`[bm25] releaseBuildLock failed: ${err instanceof Error ? err.message : err}`)
    }
  }
}

function isBuildLockStale(): boolean {
  try {
    if (!existsSync(BUILD_LOCK_PATH)) return false
    const raw = readFileSync(BUILD_LOCK_PATH, "utf8")
    const lock = JSON.parse(raw) as { pid?: number; startedAt?: number }
    if (typeof lock.startedAt !== "number") return true
    return Date.now() - lock.startedAt > BUILD_LOCK_TIMEOUT_MS
  } catch {
    return true
  }
}

function stealBuildLock(): boolean {
  try {
    const payload = JSON.stringify({ pid: process.pid, startedAt: Date.now() })
    writeFileSync(BUILD_LOCK_PATH, payload)
    console.warn(`[bm25] stole stale build lock`)
    return true
  } catch {
    return false
  }
}

/**
 * Wait for another process to finish building and writing the cache.
 * Polls the cache meta file — if its builtAt timestamp updates, the build
 * is done. Returns true if cache became available, false on timeout.
 */
async function waitForCacheFromOtherProcess(): Promise<boolean> {
  const initialMeta = readCacheMeta()
  const initialBuiltAt = initialMeta?.builtAt ?? 0
  const deadline = Date.now() + BUILD_LOCK_TIMEOUT_MS

  console.log(`[bm25] another process is building BM25 — waiting up to ${BUILD_LOCK_TIMEOUT_MS / 1000}s for cache...`)

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, BUILD_LOCK_POLL_MS))

    const meta = readCacheMeta()
    if (meta && meta.builtAt > initialBuiltAt && existsSync(CACHE_PATH)) {
      console.log(`[bm25] cache from other process detected (builtAt=${meta.builtAt})`)
      return true
    }

    // If the lock is gone, the other process finished (possibly with an error).
    if (!existsSync(BUILD_LOCK_PATH)) {
      // Give it one more check — the cache might have just been written.
      const meta2 = readCacheMeta()
      if (meta2 && meta2.builtAt > initialBuiltAt && existsSync(CACHE_PATH)) {
        console.log(`[bm25] cache from other process detected after lock release`)
        return true
      }
      // Lock gone but no new cache — other process failed. Build ourselves.
      console.warn(`[bm25] build lock released but no cache appeared — will build ourselves`)
      return false
    }
  }

  console.warn(`[bm25] timed out waiting for other process — will steal lock and build`)
  return false
}

// --- Index building ---

async function buildIndex(): Promise<MiniSearchInstance> {
  const index = new (MiniSearch as unknown as new (opts: object) => MiniSearchInstance)(MINISEARCH_OPTS)
  const seen = new Set<string>()
  let offset: string | number | Record<string, unknown> | null | undefined
  let added = 0
  let skipped = 0

  do {
    const page = await bm25QdrantClient.scroll(config.collectionName, {
      limit: 512,
      with_payload: true,
      with_vector: false,
      ...(offset ? { offset } : {}),
    })

    for (const point of page.points) {
      const payload = point.payload as RetrievedPayload | null | undefined
      if (!payload?.content) { skipped++; continue }
      const hasIdentifiers = (payload.symbols?.length ?? 0) > 0
        || (payload.dbTables?.length ?? 0) > 0
        || (payload.queueNames?.length ?? 0) > 0
        || (payload.routes?.length ?? 0) > 0
        || (payload as Record<string, unknown>).symbolName
        || (payload.evidenceTypes?.includes("documentation") ?? false)
        || (payload.evidenceTypes?.includes("env_config") ?? false)
        || (payload.evidenceTypes?.includes("migration") ?? false)
      if (!hasIdentifiers) { skipped++; continue }
      const id = String(point.id)
      if (seen.has(id)) continue
      seen.add(id)
      try {
        index.add(makeEntry(id, payload))
        added++
      } catch {
        // skip docs that cause MiniSearch to throw
      }
    }

    offset = page.next_page_offset
  } while (offset)

  console.log(`[bm25] buildIndex: added ${added} entries, skipped ${skipped} (no identifiers)`)
  return index
}

// --- Public API ---

export async function getBM25Index(): Promise<MiniSearchInstance> {
  const start = nowMs()
  const now = Date.now()

  // Fast path: in-memory index still valid.
  if (_index && now - _indexedAt < INDEX_TTL_MS) {
    dlog("bm25-load", { source: "memory", ms: elapsedMs(start), pointCount: _indexedPointCount })
    return _index
  }

  // In-process TTL elapsed but process still alive — check point count.
  if (_index) {
    const currentPointCount = await getQdrantPointCount()
    if (currentPointCount > 0 && currentPointCount === _indexedPointCount) {
      _indexedAt = now
      console.log(`[bm25] TTL elapsed but point count unchanged (${currentPointCount}) — keeping in-memory index`)
      dlog("bm25-load", { source: "memory-ttl-refresh", ms: elapsedMs(start), pointCount: currentPointCount })
      return _index
    }
  }

  // Fresh process (or data changed) — try disk cache.
  const meta = readCacheMeta()
  const cacheAge = meta ? Date.now() - meta.builtAt : Infinity
  const cacheIsRecent = cacheAge < CACHE_MAX_AGE_MS / 2
  const pointCount = cacheIsRecent ? 0 : await getQdrantPointCount()

  if (isCacheValid(pointCount, cacheIsRecent)) {
    const cached = loadCached()
    if (cached) {
      _index = cached
      _indexedAt = now
      _indexedPointCount = pointCount || meta?.pointCount || await getQdrantPointCount()
      console.log(`[bm25] loaded index from disk (pointCount=${_indexedPointCount}, cacheAgeMs=${Math.round(cacheAge)})`)
      dlog("bm25-load", { source: "disk", ms: elapsedMs(start), pointCount: _indexedPointCount, cacheAgeMs: Math.round(cacheAge) })
      return _index
    }
    // loadCached failed — fall through to build.
  }

  // No valid cache — need to cold-build. Use cross-process lock to avoid
  // N concurrent processes all scrolling ~160k Qdrant points simultaneously.
  const lockAcquired = tryAcquireBuildLock()

  if (!lockAcquired) {
    // Another process is building. Wait for its cache.
    const cacheReady = await waitForCacheFromOtherProcess()
    if (cacheReady) {
      const cached = loadCached()
      if (cached) {
        _index = cached
        _indexedAt = Date.now()
        const freshMeta = readCacheMeta()
        _indexedPointCount = freshMeta?.pointCount ?? await getQdrantPointCount()
        console.log(`[bm25] loaded index from disk after waiting for other process (pointCount=${_indexedPointCount})`)
        dlog("bm25-load", { source: "disk-after-wait", ms: elapsedMs(start), pointCount: _indexedPointCount })
        return _index
      }
    }
    // Cache still not available — steal lock and build ourselves.
    if (isBuildLockStale()) {
      stealBuildLock()
    } else {
      // Lock not stale but wait timed out — try one more acquire.
      if (!tryAcquireBuildLock()) {
        console.warn(`[bm25] could not acquire build lock — building without lock (may duplicate work)`)
      }
    }
  }

  const fullPointCount = pointCount || await getQdrantPointCount()
  console.log(`[bm25] cold-building index (pointCount=${fullPointCount})`)
  dlog("bm25-build-start", { pointCount: fullPointCount, lockAcquired })
  _index = await buildIndex()
  _indexedAt = Date.now()
  _indexedPointCount = fullPointCount
  saveToDisk(_index, fullPointCount)
  dlog("bm25-build-done", { ms: elapsedMs(start), pointCount: fullPointCount })

  if (lockAcquired || existsSync(BUILD_LOCK_PATH)) {
    releaseBuildLock()
  }

  return _index
}

/**
 * Prewarm the BM25 index in the background. Safe to call on server startup —
 * does not block. Errors are logged but never thrown.
 */
export async function prewarmBM25Index(): Promise<void> {
  try {
    await getBM25Index()
    console.log(`[bm25] prewarm complete`)
  } catch (err) {
    console.error(`[bm25] prewarm failed: ${err instanceof Error ? err.message : err}`)
  }
}

/**
 * Search the BM25 index for exact/near-exact identifier matches.
 */
export async function bm25Search(
  query: string,
  limit = 20,
): Promise<Array<{ id: string; score: number; repoName: string; branchName: string; filePath: string; startLine: number; endLine: number; chunkType: string; symbolName: string }>> {
  if (!query.trim()) return []

  const start = nowMs()
  const index = await getBM25Index()
  const results = index.search(query).slice(0, limit)
  const mapped = results.map((r: Record<string, unknown>) => ({
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

  dlog("bm25-search", {
    ms: elapsedMs(start),
    queryChars: query.length,
    limit,
    hits: mapped.length,
  })

  return mapped
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
