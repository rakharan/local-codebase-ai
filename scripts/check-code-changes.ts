/**
 * Check Code Changes — polls git log in top 10 repos, compares to last-seen
 * SHA in .data/doc-sync-state.json, outputs change report for Hermes.
 *
 * Output is stable (no timestamps) for Hermes monitor-mode hash suppression.
 *
 * Usage: node --import ./register-ts-node.mjs scripts/check-code-changes.ts
 */

import fs from "node:fs/promises"
import path from "node:path"
import { execSync } from "node:child_process"

const REPOS_DIR = "C:/GIT/work"
const STATE_FILE = ".data/doc-sync-state.json"
const TOP_REPOS = [
  "ims-tf2", "ea-service", "tf2-microservice", "tf2-sinyo",
  "fa-trade-publisher", "mrg-accounts", "mrg-cash",
  "metaoffice-crm", "tf2-ois", "metaoffice-user-ts",
]

const CODE_EXTENSIONS = /\.(ts|js|php|go|sql|py|sh|json|yaml|yml)$/i

type RepoState = { sha: string }
type StateFile = Record<string, RepoState>

async function loadState(): Promise<StateFile> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8")
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

async function saveState(state: StateFile): Promise<void> {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true })
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8")
}

function git(repoPath: string, ...args: string[]): string {
  try {
    return execSync(`git -C "${repoPath}" ${args.join(" ")}`, {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    }).trim()
  } catch {
    return ""
  }
}

async function main() {
  const state = await loadState()
  const changes: Array<{ repo: string; files: string[] }> = []

  for (const repo of TOP_REPOS) {
    const repoPath = path.join(REPOS_DIR, repo)
    if (!await fs.access(repoPath).then(() => true).catch(() => false)) continue

    const currentSha = git(repoPath, "rev-parse", "HEAD")
    if (!currentSha) continue

    const prevSha = state[repo]?.sha
    if (prevSha === currentSha) continue

    if (!prevSha) {
      // First run — just record state, don't report
      state[repo] = { sha: currentSha }
      continue
    }

    const diffOutput = git(repoPath, "diff", "--name-only", `${prevSha}..${currentSha}`)
    if (!diffOutput) {
      state[repo] = { sha: currentSha }
      continue
    }

    const changedFiles = diffOutput
      .split("\n")
      .map(f => f.trim())
      .filter(f => f && CODE_EXTENSIONS.test(f) && !f.includes("node_modules") && !f.includes(".test.") && !f.includes("__test__"))

    if (changedFiles.length > 0) {
      changes.push({ repo, files: changedFiles })
    }
    state[repo] = { sha: currentSha }
  }

  await saveState(state)

  if (changes.length === 0) {
    console.log("No code changes detected.")
    return
  }

  console.log(`CODE CHANGES (${changes.length} repos):`)
  console.log("")
  for (const c of changes) {
    console.log(`${c.repo}:`)
    for (const f of c.files.slice(0, 15)) {
      console.log(`  ${f}`)
    }
    if (c.files.length > 15) console.log(`  ...and ${c.files.length - 15} more`)
    console.log("")
  }
}

main().catch(err => { console.error(err); process.exit(1) })
