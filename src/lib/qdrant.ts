import { QdrantClient } from "@qdrant/js-client-rest"
import { config } from "./config.js"
import { dlog } from "./debug-log.js"

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Bidang yang dipakai sebagai filter di scroll/query — harus diindeks agar tidak full-scan.
const PAYLOAD_INDEXES: Array<{ field: string; schema: "keyword" | "integer" }> = [
  { field: "repoName",       schema: "keyword" },
  { field: "branchName",     schema: "keyword" },
  { field: "filePath",       schema: "keyword" },
  { field: "serviceType",    schema: "keyword" },
  { field: "projectIds",     schema: "keyword" },
  { field: "source_type",    schema: "keyword" },
  { field: "evidenceTypes",  schema: "keyword" },
]

// Qdrant returns HTTP 409 (or a body containing "Index already exists for field")
// when a payload index already exists. Only that case is safe to swallow — every
// other error (connection refused, auth, schema mismatch, server error) must
// propagate so startup fails loudly instead of silently running unindexed.
function isIndexAlreadyExistsError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status
    if (status === 409) return true
  }
  const message = error instanceof Error ? error.message : String(error)
  return /already exists/i.test(message)
}

async function ensurePayloadIndexes(): Promise<void> {
  for (const { field, schema } of PAYLOAD_INDEXES) {
    try {
      await qdrant.createPayloadIndex(config.collectionName, {
        field_name: field,
        field_schema: schema,
      })
    } catch (error) {
      if (isIndexAlreadyExistsError(error)) {
        // Idempotent: index already created. Safe to ignore.
        continue
      }
      // Unexpected error — propagate so it is visible, not silently unindexed.
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Failed to ensure payload index for "${field}": ${message}`)
    }
  }
}

export async function ensureCollection(): Promise<void> {
  let collections
  let lastError: unknown

  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      collections = await qdrant.getCollections()
      break
    } catch (error) {
      lastError = error

      if (attempt < 10) {
        await delay(1_000)
      }
    }
  }

  if (!collections) {
    const message = lastError instanceof Error ? lastError.message : String(lastError)

    throw new Error(
      `Qdrant is not reachable at ${config.qdrantUrl}. Start it with: docker compose up -d and wait until docker compose ps shows qdrant as Up.\n${message}`,
    )
  }

  const exists = collections.collections.some(
    collection => collection.name === config.collectionName,
  )

  if (!exists) {
    await qdrant.createCollection(config.collectionName, {
      vectors: {
        size: config.vectorSize,
        distance: "Cosine",
      },
    })
  }

  // Buat payload index untuk semua bidang filter — idempoten, aman dijalankan berulang.
  await ensurePayloadIndexes()
}

// --- Timing wrapper ---
// Intercepts every QdrantClient method call via Proxy, logs duration + metadata
// without exposing payload contents. Catches all call sites automatically.

function extractFilterKeys(filter: unknown): string[] | undefined {
  if (!filter || typeof filter !== "object") return undefined
  const f = filter as { must?: unknown[]; should?: unknown[]; must_not?: unknown[] }
  const keys: string[] = []
  for (const clause of ["must", "should", "must_not"] as const) {
    const arr = f[clause]
    if (!Array.isArray(arr)) continue
    for (const cond of arr) {
      if (cond && typeof cond === "object" && "key" in cond) {
        keys.push(String((cond as { key: string }).key))
      }
      // Nested filters (sub-conditions with their own must/should)
      if (cond && typeof cond === "object" && "filter" in cond) {
        const nested = extractFilterKeys((cond as { filter?: unknown }).filter)
        if (nested) keys.push(...nested)
      }
    }
  }
  return keys.length > 0 ? keys : undefined
}

function extractResultCount(result: unknown): number | undefined {
  if (!result || typeof result !== "object") return undefined
  const r = result as { points?: unknown[]; points_count?: number; result?: { points?: unknown[] } }
  if (Array.isArray(r.points)) return r.points.length
  if (typeof r.points_count === "number") return r.points_count
  if (r.result && Array.isArray(r.result.points)) return r.result.points.length
  return undefined
}

// Per-op call counter so concurrent calls of the same op are distinguishable.
const _qdrantCallSeq = new Map<string, number>()

function createTimedClient(client: QdrantClient): QdrantClient {
  const handler: ProxyHandler<QdrantClient> = {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)
      if (typeof value !== "function") return value
      const opName = String(prop)

      // Skip non-query internal methods that are not latency-relevant.
      const skipTiming = prop === "on" || prop === "once" || prop === "emit" || prop === "removeListener"

      const fn = value as (...args: unknown[]) => Promise<unknown>
      const timed = async (...args: unknown[]): Promise<unknown> => {
        if (skipTiming) return fn.apply(target, args)

        const seq = (_qdrantCallSeq.get(opName) ?? 0) + 1
        _qdrantCallSeq.set(opName, seq)

        const start = Date.now()
        const collectionName = typeof args[0] === "string" ? args[0] : "-"
        const req = args[1]
        const limit = (req && typeof req === "object" && "limit" in req)
          ? (req as { limit?: number }).limit
          : undefined
        const filterKeys = (req && typeof req === "object" && "filter" in req)
          ? extractFilterKeys((req as { filter?: unknown }).filter)
          : undefined
        const idsArg = (req && typeof req === "object" && "ids" in req)
          ? Array.isArray((req as { ids?: unknown[] }).ids)
            ? (req as { ids?: unknown[] }).ids!.length
            : undefined
          : undefined

        try {
          const result = await fn.apply(target, args)
          dlog("qdrant", {
            op: opName,
            ms: Date.now() - start,
            ok: true,
            seq,
            collection: collectionName,
            limit,
            filterKeys: filterKeys ? filterKeys.join(",") : undefined,
            ids: idsArg,
            resultCount: extractResultCount(result),
          })
          return result
        } catch (err) {
          dlog("qdrant", {
            op: opName,
            ms: Date.now() - start,
            ok: false,
            seq,
            collection: collectionName,
            limit,
            filterKeys: filterKeys ? filterKeys.join(",") : undefined,
            error: err instanceof Error ? err.message : String(err),
          })
          throw err
        }
      }
      return timed
    },
  }

  return new Proxy(client, handler) as QdrantClient
}

export const qdrant = createTimedClient(new QdrantClient({
  url: config.qdrantUrl,
}))
