#!/usr/bin/env node
/**
 * Lock-protected FULL reindex: doctor-all → index-doctor-all → index-repo (per repo) → index-docs.
 *
 * Applies chunker noise filters + tightened structuredFacts + low-value comment
 * filtering to ALL existing Qdrant chunks. Use this when chunker/facts/comments
 * logic changes and existing points need cleaning.
 *
 * Usage:
 *   node --import ./register-ts-node.mjs scripts/reindex-full.ts <repos-folder> [docs-folder]
 *
 * Example:
 *   node --import ./register-ts-node.mjs scripts/reindex-full.ts C:/GIT/work C:/GIT/work/my-website/docs
 *
 * Exit codes:
 *   0  reindex completed
 *   1  lock held by another live run (or usage error)
 *   2  a step failed
 */
import path from "node:path"
import fs from "node:fs/promises"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"

const LOCK_PATH = path.resolve(".data/reindex.lock")
const LOCK_MAX_AGE_MS = 4 * 60 * 60 * 1000

const SKIP_DIRS = new Set(["Playgrounds", "node_modules", ".git", "my_usage.json"])

type LockPayload = { pid: number; startedAt: string }

async function acquireLock(): Promise<void> {
  await fs.mkdir(path.dirname(LOCK_PATH), { recursive: true })
  const payload: LockPayload = { pid: process.pid, startedAt: new Date().toISOString() }

  try {
    await fs.writeFile(LOCK_PATH, JSON.stringify(payload), { flag: "wx" })
    return
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== "EEXIST") throw err
  }

  if (existsSync(LOCK_PATH)) {
    try {
      const raw = await fs.readFile(LOCK_PATH, "utf8")
      const existing = JSON.parse(raw) as LockPayload
      const startedAt = Date.parse(existing.startedAt)
      if (Number.isFinite(startedAt) && Date.now() - startedAt > LOCK_MAX_AGE_MS) {
        console.warn(`[reindex-full] stale lock (PID ${existing.pid}, ${existing.startedAt}); stealing.`)
        await fs.writeFile(LOCK_PATH, JSON.stringify(payload))
        return
      }
      console.error(`[reindex-full] another reindex is running (PID ${existing.pid}, ${existing.startedAt}). Aborting.`)
      process.exit(1)
    } catch {
      await fs.writeFile(LOCK_PATH, JSON.stringify(payload))
      return
    }
  }
}

async function releaseLock(): Promise<void> {
  try {
    await fs.unlink(LOCK_PATH)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== "ENOENT") throw err
  }
}

function runStep(label: string, args: string[]): Promise<number> {
  console.log(`\n━━━ ${label} ━━━`)
  return new Promise(resolve => {
    const child = spawn(process.execPath, ["--import", "./register-ts-node.mjs", ...args], {
      stdio: "inherit",
    })
    child.on("close", code => resolve(code ?? 1))
  })
}

async function main(): Promise<number> {
  const reposFolder = process.argv[2]
  const docsFolder = process.argv[3]

  if (!reposFolder) {
    console.error("Usage: node --import ./register-ts-node.mjs scripts/reindex-full.ts <repos-folder> [docs-folder]")
    console.error("Example: node --import ./register-ts-node.mjs scripts/reindex-full.ts C:/GIT/work C:/GIT/work/my-website/docs")
    return 1
  }

  await acquireLock()
  console.log(`[reindex-full] lock acquired (PID ${process.pid})`)
  const totalStart = Date.now()

  try {
    // Step 1: doctor-all — extract facts from source repos
    const doctorCode = await runStep("doctor-all", ["scripts/doctor-all.ts", path.resolve(reposFolder)])
    if (doctorCode !== 0) {
      console.error(`[reindex-full] doctor-all exited with code ${doctorCode}`)
      return 2
    }

    // Step 2: index-doctor-all — embed doctor output to Qdrant
    const indexDoctorCode = await runStep("index-doctor-all", ["scripts/index-doctor-all.ts"])
    if (indexDoctorCode !== 0) {
      console.error(`[reindex-full] index-doctor-all exited with code ${indexDoctorCode}`)
      return 2
    }

    // Step 3: index-repo per repo — reindex source code with noise filters
    const entries = await fs.readdir(reposFolder, { withFileTypes: true })
    const repos = entries.filter(e => e.isDirectory() && !SKIP_DIRS.has(e.name)).map(e => e.name)

    console.log(`\n━━━ index-repo (${repos.length} repos) ━━━`)
    let repoFailures = 0
    for (const repo of repos) {
      const repoPath = path.join(path.resolve(reposFolder), repo)
      console.log(`\n  → ${repo}`)
      const code = await runStep(`index-repo: ${repo}`, [
        "src/index-repo.ts", repoPath,
        "--repo-name", repo,
        "--replace-repo",
        "--index-comments",
      ])
      if (code !== 0) {
        console.error(`  ✗ ${repo} exited with code ${code}`)
        repoFailures++
      } else {
        console.log(`  ✓ ${repo} done`)
      }
    }
    if (repoFailures > 0) {
      console.warn(`[reindex-full] ${repoFailures} repo(s) failed. Continuing with docs.`)
    }

    // Step 4: index-docs — reindex Docusaurus docs (if docs folder provided)
    if (docsFolder) {
      const docsCode = await runStep("index-docs", [
        "src/index-docs.ts", path.resolve(docsFolder),
        "--replace-repo",
      ])
      if (docsCode !== 0) {
        console.error(`[reindex-full] index-docs exited with code ${docsCode}`)
        return 2
      }
    }

    const totalMs = Date.now() - totalStart
    console.log(`\n[reindex-full] completed in ${Math.round(totalMs / 1000)}s (${Math.round(totalMs / 60000)}m).`)
    if (repoFailures > 0) {
      console.warn(`[reindex-full] ${repoFailures} repo(s) had failures — check output above.`)
    }
    return 0
  } finally {
    await releaseLock()
  }
}

main()
  .then(code => process.exit(code))
  .catch(error => {
    console.error(error)
    releaseLock().finally(() => process.exit(1))
  })
