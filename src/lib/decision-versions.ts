import fs from "node:fs/promises"
import path from "node:path"
import { sha256 } from "./hash.js"

const versionsDir = path.join(process.cwd(), ".data", "decision-versions")

export type DecisionVersion = {
  id: string
  timestamp: string
  summary: string
  content: string
}

export type DecisionVersionMeta = Omit<DecisionVersion, "content">

function versionFile(fileName: string): string {
  return path.join(versionsDir, `${fileName}.jsonl`)
}

export async function saveVersion(fileName: string, content: string): Promise<DecisionVersionMeta> {
  await fs.mkdir(versionsDir, { recursive: true })

  const id = sha256(`${fileName}:${content}`).slice(0, 12)
  const timestamp = new Date().toISOString()
  const summary = content.split(/\r?\n/).find(line => line.startsWith("# "))?.replace(/^#\s*/, "").trim()
    ?? content.split(/\r?\n/).find(line => line.trim().length > 0)?.trim()
    ?? "(no title)"

  const version: DecisionVersion = { id, timestamp, summary, content }

  // Read existing versions to avoid duplicate content
  const existing = await listVersions(fileName)
  const lastVersion = existing.at(-1)

  if (lastVersion) {
    const lastContent = await getVersion(fileName, lastVersion.id)
    if (lastContent === content) return lastVersion // no change
  }

  await fs.appendFile(versionFile(fileName), JSON.stringify(version) + "\n", "utf8")

  return { id, timestamp, summary }
}

export async function listVersions(fileName: string): Promise<DecisionVersionMeta[]> {
  try {
    const content = await fs.readFile(versionFile(fileName), "utf8")
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => {
        const v = JSON.parse(line) as DecisionVersion
        return { id: v.id, timestamp: v.timestamp, summary: v.summary }
      })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

export async function getVersion(fileName: string, versionId: string): Promise<string | null> {
  try {
    const content = await fs.readFile(versionFile(fileName), "utf8")
    const lines = content.split(/\r?\n/).filter(Boolean)
    for (const line of lines) {
      const v = JSON.parse(line) as DecisionVersion
      if (v.id === versionId) return v.content
    }
    return null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

export async function rollbackVersion(
  fileName: string,
  versionId: string,
  approvedDir: string,
): Promise<{ content: string; savedVersion: DecisionVersionMeta }> {
  const content = await getVersion(fileName, versionId)

  if (!content) {
    throw new Error(`Version not found: ${versionId}`)
  }

  const approvedPath = path.join(approvedDir, fileName)
  await fs.writeFile(approvedPath, content, "utf8")

  // Save the rollback itself as a new version
  const savedVersion = await saveVersion(fileName, content)

  return { content, savedVersion }
}
