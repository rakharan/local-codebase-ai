#!/usr/bin/env node
/**
 * Lock-protected full reindex: doctor-all → index-doctor-all.
 *
 * Prevents overlapping reindex runs (which would double-embed and race on
 * Qdrant upserts). Safe to schedule via cron/Task Scheduler — if a previous
 * run is still active, this exits with a clear "already running" message
 * instead of starting a second concurrent reindex.
 *
 * Usage:
 *   node --import ./register-ts-node.mjs scripts/reindex-all.ts <repos-folder>
 *
 * Exit codes:
 *   0  reindex completed
 *   1  lock held by another live run (or usage error)
 *   2  doctor-all or index-doctor-all failed
 */
import path from "node:path"
import fs from "node:fs/promises"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"

const LOCK_PATH = path.resolve(".data/reindex.lock")
// If a lock file is older than this, assume the previous run died and steal it.
const LOCK_MAX_AGE_MS = 4 * 60 * 60 * 1000 // 4h — longer than any expected reindex

type LockPayload = { pid: number; startedAt: string }

async function acquireLock(): Promise<void> {
  await fs.mkdir(path.dirname(LOCK_PATH), { recursive: true })
  const payload: LockPayload = { pid: process.pid, startedAt: new Date().toISOString() }

  try {
    // Exclusive create — fails if the file already exists.
    await fs.writeFile(LOCK_PATH, JSON.stringify(payload), { flag: "wx" })
    return
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== "EEXIST") throw err
  }

  // Lock exists — check whether it is stale enough to steal.
  if (existsSync(LOCK_PATH)) {
    try {
      const raw = await fs.readFile(LOCK_PATH, "utf8")
      const existing = JSON.parse(raw) as LockPayload
      const startedAt = Date.parse(existing.startedAt)
      if (Number.isFinite(startedAt) && Date.now() - startedAt > LOCK_MAX_AGE_MS) {
        console.warn(`[reindex-all] stale lock detected (PID ${existing.pid}, started ${existing.startedAt}); stealing.`)
        await fs.writeFile(LOCK_PATH, JSON.stringify(payload))
        return
      }
      console.error(`[reindex-all] another reindex is already running (PID ${existing.pid}, started ${existing.startedAt}). Aborting.`)
      process.exit(1)
    } catch {
      // Corrupted lock file — overwrite it.
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
    child.on("close", code => {
      resolve(code ?? 1)
    })
  })
}

async function main(): Promise<number> {
  const targetDir = process.argv[2]
  if (!targetDir) {
    console.error("Usage: node --import ./register-ts-node.mjs scripts/reindex-all.ts <repos-folder>")
    return 1
  }

  await acquireLock()
  console.log(`[reindex-all] lock acquired (PID ${process.pid})`)

  try {
    const doctorCode = await runStep("doctor-all", ["scripts/doctor-all.ts", path.resolve(targetDir)])
    if (doctorCode !== 0) {
      console.error(`[reindex-all] doctor-all exited with code ${doctorCode}`)
      return 2
    }

    const indexCode = await runStep("index-doctor-all", ["scripts/index-doctor-all.ts"])
    if (indexCode !== 0) {
      console.error(`[reindex-all] index-doctor-all exited with code ${indexCode}`)
      return 2
    }

    console.log("\n[reindex-all] reindex completed successfully.")
    return 0
  } finally {
    // Always release the lock — even when returning an error code. Note:
    // process.exit() inside try would skip this, so we return codes instead.
    await releaseLock()
  }
}

main()
  .then(code => process.exit(code))
  .catch(error => {
    console.error(error)
    releaseLock().finally(() => process.exit(1))
  })
