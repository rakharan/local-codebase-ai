/**
 * Per-request debug logger. Writes structured single-line traces to stderr so
 * they surface in /api/ask `raw` without polluting stdout (which carries the
 * ANSWER/SOURCES protocol). Safe by default — disabled when ASK_DEBUG != "1"
 * to keep production logs quiet unless explicitly opted in.
 */

const REQUEST_ID = process.env.ASK_REQUEST_ID ?? "noid"
const ENABLED = process.env.ASK_DEBUG === "1" || process.env.ASK_DEBUG === "true"

function ts(): string {
  return new Date().toISOString()
}

function formatVal(v: unknown): string {
  if (v === null || v === undefined) return "-"
  if (typeof v === "number") return String(v)
  if (typeof v === "boolean") return String(v)
  if (typeof v === "string") return v
  return JSON.stringify(v)
}

export function dlog(stage: string, fields: Record<string, unknown> = {}): void {
  if (!ENABLED) return
  const parts = [stage]
  for (const [k, v] of Object.entries(fields)) {
    parts.push(`${k}=${formatVal(v)}`)
  }
  process.stderr.write(`[ask][${REQUEST_ID}] ${ts()} ${parts.join(" ")}\n`)
}

export function nowMs(): number {
  return Date.now()
}

export function elapsedMs(from: number): number {
  return Date.now() - from
}

/**
 * Times an async stage and emits a dlog line on completion.
 * Returns the inner result.
 */
export async function timeStage<T>(
  stage: string,
  fn: () => Promise<T>,
  extraFields: Record<string, unknown> = {},
): Promise<T> {
  const start = nowMs()
  try {
    const result = await fn()
    dlog("stage", { name: stage, ms: elapsedMs(start), ok: true, ...extraFields })
    return result
  } catch (err) {
    dlog("stage", {
      name: stage,
      ms: elapsedMs(start),
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ...extraFields,
    })
    throw err
  }
}

export function isDebugEnabled(): boolean {
  return ENABLED
}
