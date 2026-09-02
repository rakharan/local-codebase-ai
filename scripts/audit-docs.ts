/**
 * Docs Gap Audit — queries Qdrant for known features (routes, tables, handlers,
 * crons, queues) in the top 10 repos, scans tf-documentation for mentions,
 * outputs gap report for Hermes to fill.
 *
 * Output is stable (no timestamps) for Hermes monitor-mode hash suppression.
 *
 * Usage: node --import ./register-ts-node.mjs scripts/audit-docs.ts
 */

import fs from "node:fs/promises"
import path from "node:path"
import { config } from "../src/lib/config.js"
import { qdrant } from "../src/lib/qdrant.js"
import fastGlob from "fast-glob"

const SKIP_DIRS = new Set([".claude", "node_modules", ".git", "my_usage.json", "Playgrounds", "Opencode Memory"])

async function getRepos(): Promise<string[]> {
  const entries = await fs.readdir("C:/GIT/work", { withFileTypes: true })
  return entries.filter(e => e.isDirectory() && !SKIP_DIRS.has(e.name)).map(e => e.name)
}

const DOCS_DIR = "C:/GIT/work/tf-documentation/my-website/docs"

type Feature = {
  repo: string
  type: "route" | "table" | "handler" | "cron" | "queue"
  name: string
  file: string
}

async function queryFeatures(): Promise<Feature[]> {
  const features: Feature[] = []
  const evidenceFilters = [
    { key: "evidenceTypes", match: { value: "api_route" } },
    { key: "evidenceTypes", match: { value: "db_model" } },
    { key: "evidenceTypes", match: { value: "raw_sql" } },
    { key: "evidenceTypes", match: { value: "cron" } },
    { key: "evidenceTypes", match: { value: "rabbitmq_consumer" } },
    { key: "evidenceTypes", match: { value: "rabbitmq_publisher" } },
  ]

  const repos = await getRepos()
  for (const repoName of repos) {
    let offset: string | number | null | undefined = null
    do {
      const filter = {
        must: [
          { key: "repoName", match: { value: repoName } },
          { should: evidenceFilters },
        ],
      }
      const body: Record<string, unknown> = {
        filter,
        limit: 256,
        with_payload: true,
        with_vector: false,
      }
      if (offset) body.offset = offset

      const res = await fetch(`${config.qdrantUrl}/collections/${config.collectionName}/points/scroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
      if (!res.ok) break
      const data = await res.json() as { result: { points: Array<{ payload: Record<string, unknown> }>; next_page_offset: string | null } }
      const points = data.result?.points ?? []
      if (points.length === 0) break

      for (const point of points) {
        const p = point.payload
        const routes = (p.routes as string[]) ?? []
        const symbols = (p.symbols as string[]) ?? []
        const dbTables = (p.dbTables as string[]) ?? []
        const queueNames = (p.queueNames as string[]) ?? []
        const filePath = (p.filePath as string) ?? ""
        const facts = (p.structuredFacts as Array<{ source?: string; text?: string }>) ?? []

        for (const route of routes) {
          if (route && route.length > 3) features.push({ repo: repoName, type: "route", name: route, file: filePath })
        }
        for (const sym of symbols) {
          if (sym && sym.length > 2) features.push({ repo: repoName, type: "handler", name: sym, file: filePath })
        }
        for (const table of dbTables) {
          if (table && table.length > 2) features.push({ repo: repoName, type: "table", name: table, file: filePath })
        }
        for (const queue of queueNames) {
          if (queue && queue.length > 2) features.push({ repo: repoName, type: "queue", name: queue, file: filePath })
        }
        for (const fact of facts) {
          if (fact.source === "cron" || /cron|schedule|midnight|hourly|daily/i.test(fact.text ?? "")) {
            const cronName = ((fact.text ?? "") as string).split("\n")[0]?.slice(0, 80) ?? ""
            if (cronName) features.push({ repo: repoName, type: "cron", name: cronName, file: filePath })
          }
        }
      }
      offset = data.result?.next_page_offset
    } while (offset)
  }

  // Deduplicate by repo+type+name
  const seen = new Set<string>()
  return features.filter(f => {
    const key = `${f.repo}:${f.type}:${f.name}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function scanDocs(): Promise<string> {
  const files = await fastGlob("**/*.md", { cwd: DOCS_DIR, absolute: true })
  let corpus = ""
  for (const file of files) {
    try {
      corpus += await fs.readFile(file, "utf8")
    } catch { /* skip */ }
  }
  return corpus.toLowerCase()
}

async function main() {
  const features = await queryFeatures()
  const docsCorpus = await scanDocs()

  const gaps: Feature[] = []
  for (const f of features) {
    const name = f.name.toLowerCase()
    if (!docsCorpus.includes(name)) {
      gaps.push(f)
    }
  }

  if (gaps.length === 0) {
    console.log("No documentation gaps found.")
    return
  }

  console.log(`GAPS FOUND (${gaps.length}):`)
  console.log("")
  const byRepo = new Map<string, Feature[]>()
  for (const g of gaps) {
    if (!byRepo.has(g.repo)) byRepo.set(g.repo, [])
    byRepo.get(g.repo)!.push(g)
  }
  for (const [repo, repoGaps] of byRepo) {
    // Limit to top 5 per repo to keep prompt manageable for the LLM
    const topGaps = repoGaps.slice(0, 5)
    console.log(`${repo} (${repoGaps.length} total, showing top 5):`)
    for (const g of topGaps) {
      console.log(`  [${g.type}] ${g.name}`)
    }
    console.log("")
  }
}

main().catch(err => { console.error(err); process.exit(1) })
