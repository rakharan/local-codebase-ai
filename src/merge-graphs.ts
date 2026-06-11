import { readRelationshipGraph, appendRelationshipEdges } from "./lib/graph.js"
import type { RelationshipEdge, RelationshipType } from "./lib/graph.js"
import { sha256 } from "./lib/hash.js"

// ---------------------------------------------------------------------------
// CROSS_REPO_LINK edge type (extends RelationshipType at runtime)
// ---------------------------------------------------------------------------

type CrossRepoLinkEdge = Omit<RelationshipEdge, "type"> & {
  type: "CROSS_REPO_LINK"
  sourceRepo: string
  targetRepo: string
  linkType: "rpc_call" | "shared_table" | "shared_queue"
  sharedIdentifier: string
}

// Noise words to skip for table matching
const TABLE_STOP_WORDS = new Set([
  "typeorm", "style", "the", "if", "moment", "data", "set", "on",
  "where", "order", "group", "select", "from", "status", "users",
])

function makeCrossRepoEdge(
  callerEdge: RelationshipEdge,
  definerEdge: RelationshipEdge,
  linkType: CrossRepoLinkEdge["linkType"],
  sharedIdentifier: string,
): CrossRepoLinkEdge {
  const id = sha256([
    "CROSS_REPO_LINK",
    callerEdge.repoName,
    definerEdge.repoName,
    linkType,
    sharedIdentifier,
    callerEdge.filePath,
    callerEdge.startLine,
  ].join(":"))

  return {
    id,
    type: "CROSS_REPO_LINK",
    repoName: callerEdge.repoName,
    projectIds: callerEdge.projectIds,
    projectTagSources: callerEdge.projectTagSources,
    serviceType: callerEdge.serviceType,
    branchName: callerEdge.branchName,
    commitSha: callerEdge.commitSha,
    filePath: callerEdge.filePath,
    startLine: callerEdge.startLine,
    endLine: callerEdge.endLine,
    fromSymbol: callerEdge.fromSymbol,
    sourceRepo: callerEdge.repoName,
    targetRepo: definerEdge.repoName,
    linkType,
    sharedIdentifier,
    evidence: `${callerEdge.repoName}:${callerEdge.filePath}:${callerEdge.startLine} → ${definerEdge.repoName}:${definerEdge.filePath}:${definerEdge.startLine}`,
  } as CrossRepoLinkEdge
}

// ---------------------------------------------------------------------------
// Link: CALLS_RPC_FUNC in repo A → DEFINES_SYMBOL in repo B
// ---------------------------------------------------------------------------

function linkRpcCalls(edges: RelationshipEdge[]): CrossRepoLinkEdge[] {
  const callers = edges.filter(e => e.type === "CALLS_RPC_FUNC" && e.rpcFunc)
  const definers = edges.filter(e => e.type === "DEFINES_SYMBOL" && e.symbol)

  // index definers by symbol name
  const definersBySymbol = new Map<string, RelationshipEdge[]>()
  for (const d of definers) {
    const key = d.symbol!
    const list = definersBySymbol.get(key) ?? []
    list.push(d)
    definersBySymbol.set(key, list)
  }

  const result: CrossRepoLinkEdge[] = []
  for (const caller of callers) {
    const matches = definersBySymbol.get(caller.rpcFunc!) ?? []
    for (const definer of matches) {
      if (definer.repoName === caller.repoName) continue // skip same-repo
      result.push(makeCrossRepoEdge(caller, definer, "rpc_call", caller.rpcFunc!))
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Link: shared TOUCHES_TABLE across repos
// ---------------------------------------------------------------------------

function linkSharedTables(edges: RelationshipEdge[]): CrossRepoLinkEdge[] {
  const tableEdges = edges.filter(e => e.type === "TOUCHES_TABLE" && e.table && !TABLE_STOP_WORDS.has(e.table.toLowerCase()))

  // group by table name
  const byTable = new Map<string, RelationshipEdge[]>()
  for (const e of tableEdges) {
    const key = e.table!.toLowerCase()
    const list = byTable.get(key) ?? []
    list.push(e)
    byTable.set(key, list)
  }

  const result: CrossRepoLinkEdge[] = []
  for (const [table, tableEdges] of byTable) {
    const repos = [...new Set(tableEdges.map(e => e.repoName))]
    if (repos.length < 2) continue // only interested in cross-repo

    // emit one link per (sourceRepo, targetRepo) pair per table — use first edge from each repo
    const byRepo = new Map<string, RelationshipEdge>()
    for (const e of tableEdges) {
      if (!byRepo.has(e.repoName)) byRepo.set(e.repoName, e)
    }

    const repoList = [...byRepo.entries()]
    for (let i = 0; i < repoList.length; i++) {
      for (let j = i + 1; j < repoList.length; j++) {
        const [, edgeA] = repoList[i]!
        const [, edgeB] = repoList[j]!
        result.push(makeCrossRepoEdge(edgeA, edgeB, "shared_table", table))
      }
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Link: shared queue names (from evidence strings containing queue patterns)
// ---------------------------------------------------------------------------

function extractQueueNames(evidence: string): string[] {
  const matches = [
    ...evidence.matchAll(/["'`](pubsub-[^"'`]+)["'`]/g),
    ...evidence.matchAll(/["'`](queue[.-][^"'`]+)["'`]/g),
    ...evidence.matchAll(/["'`]([a-z][a-z0-9-]*\.(queue|exchange|topic))[^"'`]*["'`]/gi),
  ]
  return [...new Set(matches.map(m => m[1]!.toLowerCase()))]
}

function linkSharedQueues(edges: RelationshipEdge[]): CrossRepoLinkEdge[] {
  // collect edges that have queue-like evidence
  const queueEdges: Array<{ edge: RelationshipEdge; queueName: string }> = []
  for (const e of edges) {
    if (!e.evidence) continue
    for (const q of extractQueueNames(e.evidence)) {
      queueEdges.push({ edge: e, queueName: q })
    }
  }

  // group by queue name
  const byQueue = new Map<string, RelationshipEdge[]>()
  for (const { edge, queueName } of queueEdges) {
    const list = byQueue.get(queueName) ?? []
    list.push(edge)
    byQueue.set(queueName, list)
  }

  const result: CrossRepoLinkEdge[] = []
  for (const [queueName, qEdges] of byQueue) {
    const repos = [...new Set(qEdges.map(e => e.repoName))]
    if (repos.length < 2) continue

    const byRepo = new Map<string, RelationshipEdge>()
    for (const e of qEdges) {
      if (!byRepo.has(e.repoName)) byRepo.set(e.repoName, e)
    }

    const repoList = [...byRepo.entries()]
    for (let i = 0; i < repoList.length; i++) {
      for (let j = i + 1; j < repoList.length; j++) {
        const [, edgeA] = repoList[i]!
        const [, edgeB] = repoList[j]!
        result.push(makeCrossRepoEdge(edgeA, edgeB, "shared_queue", queueName))
      }
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("Reading relationship graph...")
  const edges = await readRelationshipGraph()
  console.log(`Loaded ${edges.length} edges from ${new Set(edges.map(e => e.repoName)).size} repos`)

  // remove existing CROSS_REPO_LINK edges before recomputing
  const baseEdges = edges.filter(e => e.type !== ("CROSS_REPO_LINK" as RelationshipType))

  console.log("\nLinking RPC calls across repos...")
  const rpcLinks = linkRpcCalls(baseEdges)
  console.log(`  Found ${rpcLinks.length} RPC cross-repo links`)

  console.log("Linking shared tables across repos...")
  const tableLinks = linkSharedTables(baseEdges)
  console.log(`  Found ${tableLinks.length} shared-table cross-repo links`)

  console.log("Linking shared queues across repos...")
  const queueLinks = linkSharedQueues(baseEdges)
  console.log(`  Found ${queueLinks.length} shared-queue cross-repo links`)

  const allLinks = [...rpcLinks, ...tableLinks, ...queueLinks]
  // dedup by id
  const deduped = [...new Map(allLinks.map(e => [e.id, e])).values()]
  console.log(`\nTotal cross-repo links (deduped): ${deduped.length}`)

  if (deduped.length === 0) {
    console.log("Nothing to write.")
    return
  }

  // Print top links summary
  const byType = new Map<string, number>()
  const byIdentifier = new Map<string, number>()
  for (const link of deduped) {
    byType.set(link.linkType, (byType.get(link.linkType) ?? 0) + 1)
    byIdentifier.set(link.sharedIdentifier, (byIdentifier.get(link.sharedIdentifier) ?? 0) + 1)
  }

  console.log("\nBy link type:")
  for (const [type, count] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`)
  }

  console.log("\nTop shared identifiers:")
  for (const [id, count] of [...byIdentifier.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${id}: ${count} links`)
  }

  // Print specific interesting links
  const queueLinkList = deduped.filter(e => e.linkType === "shared_queue")
  if (queueLinkList.length > 0) {
    console.log("\nQueue links found:")
    for (const link of queueLinkList) {
      console.log(`  ${link.sourceRepo} ↔ ${link.targetRepo} via queue "${link.sharedIdentifier}"`)
    }
  }

  await appendRelationshipEdges(deduped as unknown as RelationshipEdge[])
  console.log(`\nWrote ${deduped.length} cross-repo links to graph.`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
