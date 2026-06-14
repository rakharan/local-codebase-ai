import fs from "node:fs/promises"
import path from "node:path"
import { loadServiceRegistry } from "../service-registry.js"
import type { KnowledgeContext } from "./types.js"

type ReportDatabaseEntry = {
  name?: unknown
  kind?: unknown
}

type DoctorReport = {
  database?: unknown
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

export function loadKnownServiceNames(): string[] {
  const entries = loadServiceRegistry()

  return unique(
    entries.flatMap(entry => [
      entry.name,
      entry.projectId ?? "",
      ...entry.repos,
    ]),
  )
}

function loadRegistryTableNames(): string[] {
  const entries = loadServiceRegistry()

  return unique(entries.flatMap(entry => entry.tables ?? []))
}

async function findReportFiles(rootDir: string): Promise<string[]> {
  const reports: string[] = []

  async function walk(dir: string): Promise<void> {
    let entries

    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.isFile() && entry.name === "report.json") {
        reports.push(fullPath)
      }
    }
  }

  let topLevel
  try {
    topLevel = await fs.readdir(rootDir, { withFileTypes: true })
  } catch {
    return reports
  }

  for (const entry of topLevel) {
    if (entry.isDirectory() && entry.name.startsWith("repo-docs")) {
      await walk(path.join(rootDir, entry.name))
    }
  }

  return reports
}

async function loadReportTableNames(rootDir: string): Promise<string[]> {
  const reportFiles = await findReportFiles(rootDir)
  const tableNames: string[] = []

  for (const reportFile of reportFiles) {
    try {
      const parsed = JSON.parse(await fs.readFile(reportFile, "utf8")) as DoctorReport
      const database = Array.isArray(parsed.database) ? (parsed.database as ReportDatabaseEntry[]) : []

      for (const item of database) {
        if (item.kind === "table" && typeof item.name === "string") {
          tableNames.push(item.name)
        }
      }
    } catch {
      // Lewati report.json yang rusak agar ekstraksi tetap berjalan.
    }
  }

  return tableNames
}

export async function loadKnowledgeContext(rootDir: string = process.cwd()): Promise<KnowledgeContext> {
  const serviceNames = loadKnownServiceNames()
  const tableNames = unique([
    ...loadRegistryTableNames(),
    ...(await loadReportTableNames(rootDir)),
  ])

  return {
    serviceNames,
    tableNames,
  }
}
