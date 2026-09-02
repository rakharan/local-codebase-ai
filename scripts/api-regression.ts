/**
 * HTTP smoke tests for /api/ask and related endpoints.
 *
 * Requires a running server: `npm run start`.
 *
 * Tests:
 *   - /api/health liveness
 *   - /api/ready readiness (Qdrant + Ollama)
 *   - /api/auth-required shape
 *   - /api/ask basic endpoint query (response shape + answer content)
 *   - /api/ask missing question -> 400
 *   - /api/ask invalid API key -> 401 (when APP_API_KEY configured)
 *   - /api/ask deep=true completes (generous timeout)
 *
 * Usage:
 *   node --import ./register-ts-node.mjs scripts/api-regression.ts
 *   node --import ./register-ts-node.mjs scripts/api-regression.ts --base-url http://localhost:9191
 */

const BASE_URL = parseBaseUrl(process.argv.slice(2))
const API_KEY = process.env.APP_API_KEY?.trim() ?? ""

type AskResponse = {
  answer: string
  sources: string[]
  raw: string
}

let failed = 0

async function main(): Promise<void> {
  console.log(`API regression target: ${BASE_URL}`)
  console.log(`Auth: ${API_KEY ? "enabled (key configured)" : "disabled (open mode)"}`)

  await testHealth()
  await testReady()
  await testAuthRequired()
  await testAskBasicEndpoint()
  await testAskMissingQuestion()
  await testAskInvalidApiKey()
  await testAskDeep()

  if (failed > 0) {
    throw new Error(`${failed} API regression case(s) failed`)
  }

  console.log(`\nAll API regression cases passed.`)
}

function parseBaseUrl(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base-url" && argv[i + 1]) {
      return argv[i + 1]!.replace(/\/$/, "")
    }
  }
  return "http://localhost:9191"
}

async function fetchJson(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE_URL}${path}`, init)
  const text = await res.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // keep raw text
  }
  return { status: res.status, body }
}

function authHeaders(): Record<string, string> {
  return API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}
}

async function testHealth(): Promise<void> {
  process.stdout.write("Running: /api/health liveness... ")
  try {
    const { status, body } = await fetchJson("/api/health")
    assert(status === 200, `Expected 200, got ${status}`)
    const b = body as { status?: string }
    assert(b.status === "ok", `Expected status "ok", got ${b.status}`)
    console.log("ok")
  } catch (err) {
    failed++
    console.log("FAILED")
    console.error(`  ${err instanceof Error ? err.message : err}`)
  }
}

async function testReady(): Promise<void> {
  process.stdout.write("Running: /api/ready readiness... ")
  try {
    const { status, body } = await fetchJson("/api/ready")
    // 503 is acceptable if dependencies are down — just verify the shape.
    assert(status === 200 || status === 503, `Expected 200 or 503, got ${status}`)
    const b = body as { ready?: boolean; dependencies?: unknown }
    assert(typeof b.ready === "boolean", `Expected ready boolean, got ${b.ready}`)
    assert(b.dependencies !== undefined, "Expected dependencies field")
    if (status === 503) {
      console.log("ok (503 — dependencies not all ready)")
    } else {
      console.log("ok")
    }
  } catch (err) {
    failed++
    console.log("FAILED")
    console.error(`  ${err instanceof Error ? err.message : err}`)
  }
}

async function testAuthRequired(): Promise<void> {
  process.stdout.write("Running: /api/auth-required shape... ")
  try {
    const { status, body } = await fetchJson("/api/auth-required")
    assert(status === 200, `Expected 200, got ${status}`)
    const b = body as { required?: boolean }
    assert(typeof b.required === "boolean", `Expected required boolean, got ${b.required}`)
    console.log("ok")
  } catch (err) {
    failed++
    console.log("FAILED")
    console.error(`  ${err instanceof Error ? err.message : err}`)
  }
}

async function testAskBasicEndpoint(): Promise<void> {
  process.stdout.write("Running: /api/ask basic endpoint query... ")
  try {
    const { status, body } = await fetchJson("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ question: "What does /mrg/api/v1/deposit/demo/ do?" }),
    })
    assert(status === 200, `Expected 200, got ${status}`)
    const b = body as AskResponse
    assert(typeof b.answer === "string" && b.answer.length > 0, "Expected non-empty answer string")
    assert(Array.isArray(b.sources), "Expected sources array")
    assert(typeof b.raw === "string", "Expected raw string")
    assert(b.answer.includes("/mrg/api/v1/deposit/demo/"), "Answer should mention the route")
    assert(b.answer.includes("SubmitDepositDemo"), "Answer should mention the handler")
    console.log(`ok (sources=${b.sources.length})`)
  } catch (err) {
    failed++
    console.log("FAILED")
    console.error(`  ${err instanceof Error ? err.message : err}`)
  }
}

async function testAskMissingQuestion(): Promise<void> {
  process.stdout.write("Running: /api/ask missing question -> 400... ")
  try {
    const { status, body } = await fetchJson("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({}),
    })
    assert(status === 400, `Expected 400, got ${status}`)
    const b = body as { error?: string }
    assert(typeof b.error === "string" && b.error.length > 0, "Expected error message")
    console.log("ok")
  } catch (err) {
    failed++
    console.log("FAILED")
    console.error(`  ${err instanceof Error ? err.message : err}`)
  }
}

async function testAskInvalidApiKey(): Promise<void> {
  // Only test when APP_API_KEY is configured; otherwise skip.
  if (!API_KEY) {
    console.log("Running: /api/ask invalid API key -> 401... skipped (open mode)")
    return
  }
  process.stdout.write("Running: /api/ask invalid API key -> 401... ")
  try {
    const { status } = await fetchJson("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-key" },
      body: JSON.stringify({ question: "test" }),
    })
    assert(status === 401, `Expected 401, got ${status}`)
    console.log("ok")
  } catch (err) {
    failed++
    console.log("FAILED")
    console.error(`  ${err instanceof Error ? err.message : err}`)
  }
}

async function testAskDeep(): Promise<void> {
  process.stdout.write("Running: /api/ask deep=true completes... ")
  try {
    const { status, body } = await fetchJson("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ question: "apa itu mmb", deep: true }),
    })
    assert(status === 200, `Expected 200, got ${status}`)
    const b = body as AskResponse
    assert(typeof b.answer === "string" && b.answer.length > 0, "Expected non-empty answer string")
    console.log("ok")
  } catch (err) {
    failed++
    console.log("FAILED")
    console.error(`  ${err instanceof Error ? err.message : err}`)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
