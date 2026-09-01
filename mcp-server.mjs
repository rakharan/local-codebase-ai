#!/usr/bin/env node
// Minimal MCP server for local-codebase-ai
// Exposes: ask_codebase, get_index_summary
// Zero dependencies — uses Node.js built-in readline + global fetch

import readline from "node:readline"
import fs from "node:fs"
import path from "node:path"

// Load APP_API_KEY from local-codebase-ai .env
const envPath = process.env.CODEBASE_AI_ENV || path.resolve(import.meta.dirname, ".env")
let apiKey = process.env.APP_API_KEY ?? ""
if (!apiKey) {
  try {
    const envContent = fs.readFileSync(envPath, "utf8")
    const match = envContent.match(/^APP_API_KEY=(.+)$/m)
    if (match) apiKey = match[1].trim()
  } catch {}
}
const baseUrl = process.env.CODEBASE_AI_URL || "http://localhost:9191"

const TOOLS = [
  {
    name: "ask_codebase",
    description: "Ask a natural-language question about the indexed codebase. Uses BM25 + vector + graph retrieval to find relevant code chunks and documentation, then synthesizes an answer. Returns the answer text and source file references. Use this for: cross-service flow questions, 'how does X work' questions, architecture questions, database/table usage questions, route/handler/queue questions. Do NOT use for: simple file lookups (use file tools), questions about non-indexed repos.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Natural language question about the codebase" },
        deep: { type: "boolean", description: "Enable deep investigation mode (slower, more thorough)", default: false },
        repoName: { type: "string", description: "Filter to a specific repo (optional)", default: "" },
      },
      required: ["question"],
    },
  },
  {
    name: "get_index_summary",
    description: "Get a summary of what's indexed in the codebase RAG system: total chunks, per-repo breakdown, branch counts. Use this to understand what repos and branches are available for querying.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "create_learning_rule",
    description: "Create a learning rule that corrects the RAG system's behavior for future queries. Use this when the user points out a wrong answer — create a rule so the same mistake doesn't repeat. Rules are injected into the LLM prompt and/or BM25 search query automatically for all future questions matching the trigger.",
    inputSchema: {
      type: "object",
      properties: {
        trigger: { type: "string", description: "Keyword or phrase that activates this rule (e.g. 'deposit flow')" },
        type: { type: "string", enum: ["prompt_directive", "retrieval_boost"], description: "prompt_directive = tell LLM what to focus on; retrieval_boost = add search terms to BM25 query" },
        content: { type: "string", description: "For prompt_directive: instruction text. For retrieval_boost: extra search terms (space-separated)" },
        rationale: { type: "string", description: "Why this rule was created (what was wrong)" },
      },
      required: ["trigger", "type", "content"],
    },
  },
  {
    name: "list_learning_rules",
    description: "List all learning rules (active and rolled back). Use this to review what corrections have been applied to the RAG system.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "rollback_learning_rule",
    description: "Roll back a learning rule that made answers worse. The rule is deactivated, not deleted.",
    inputSchema: {
      type: "object",
      properties: {
        ruleId: { type: "string", description: "The rule ID to roll back" },
        reason: { type: "string", description: "Why this rule is being rolled back" },
      },
      required: ["ruleId"],
    },
  },
]

const rl = readline.createInterface({ input: process.stdin, terminal: false })

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n")
}

async function callApi(endpoint, method = "GET", body = null) {
  const headers = { "Content-Type": "application/json" }
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`
  const opts = { method, headers, signal: AbortSignal.timeout(300_000) }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(`${baseUrl}${endpoint}`, opts)
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`${res.status} ${text}`)
  }
  return res.json()
}

async function handleToolCall(name, args) {
  if (name === "ask_codebase") {
    const body = { question: args.question }
    if (args.deep) body.deep = true
    if (args.repoName) body.repoName = args.repoName
    const result = await callApi("/api/ask", "POST", body)
    let text = result.answer || "(no answer)"
    if (result.sources && result.sources.length > 0) {
      text += "\n\nSources:\n" + result.sources.map(s => `- ${s}`).join("\n")
    }
    return { content: [{ type: "text", text }] }
  }
  if (name === "get_index_summary") {
    const result = await callApi("/api/index/summary", "GET")
    const items = (result.items || result || []).map(i =>
      `  ${i.repoName}@${i.branchName}: ${i.points} chunks (${i.serviceType})`
    ).join("\n")
    return { content: [{ type: "text", text: `Indexed repos:\n${items}` }] }
  }
  if (name === "create_learning_rule") {
    const result = await callApi("/api/learning/rules", "POST", {
      type: args.type,
      trigger: args.trigger,
      content: args.content,
      rationale: args.rationale || "",
      source: "hermes",
    })
    return { content: [{ type: "text", text: `Learning rule created: ${result.id} (type: ${result.type}, trigger: ${result.trigger}). This rule is now active and will be applied to all future questions matching "${args.trigger}".` }] }
  }
  if (name === "list_learning_rules") {
    const result = await callApi("/api/learning/rules", "GET")
    const rules = (result.rules || []).map(r =>
      `  [${r.status}] ${r.id} | ${r.type} | trigger: ${r.trigger} | ${r.content.slice(0, 80)}`
    ).join("\n")
    return { content: [{ type: "text", text: `Learning rules:\n${rules || "(none)"}` }] }
  }
  if (name === "rollback_learning_rule") {
    await callApi(`/api/learning/rules/${args.ruleId}/rollback`, "POST", { reason: args.reason || "" })
    return { content: [{ type: "text", text: `Rule ${args.ruleId} rolled back.` }] }
  }
  throw new Error(`Unknown tool: ${name}`)
}

rl.on("line", (line) => {
  let req
  try { req = JSON.parse(line) } catch { return }
  const { id, method, params } = req

  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "codebase-rag", version: "1.0.0" } } })
    return
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } })
    return
  }
  if (method === "tools/call") {
    handleToolCall(params.name, params.arguments || {})
      .then(result => send({ jsonrpc: "2.0", id, result }))
      .catch(err => send({ jsonrpc: "2.0", id, error: { code: -32603, message: err.message } }))
    return
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } })
})
