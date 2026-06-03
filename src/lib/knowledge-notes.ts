import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { config } from "./config.js"
import { sha256, uuidFromHash } from "./hash.js"
import { createEmbedding } from "./ollama.js"
import { ensureCollection, qdrant } from "./qdrant.js"
import { normalizeProjectIds } from "./service-registry.js"

export const knowledgeNoteStatuses = ["confirmed", "proposal", "deprecated"] as const

export type KnowledgeNoteStatus = typeof knowledgeNoteStatuses[number]

export type KnowledgeNote = {
  id: string
  projectIds: string[]
  title: string
  body: string
  author: string
  status: KnowledgeNoteStatus
  createdAt: string
  updatedAt: string
}

export type KnowledgeNoteInput = {
  projectIds?: string[]
  title?: string
  body?: string
  author?: string
  status?: string
}

const dataDir = path.join(process.cwd(), ".data")
const notesPath = path.join(dataDir, "knowledge-notes.json")

function nowIso(): string {
  return new Date().toISOString()
}

function normalizeStatus(status?: string): KnowledgeNoteStatus {
  return knowledgeNoteStatuses.includes(status as KnowledgeNoteStatus)
    ? status as KnowledgeNoteStatus
    : "confirmed"
}

function validateNoteInput(input: KnowledgeNoteInput): {
  projectIds: string[]
  title: string
  body: string
  author: string
  status: KnowledgeNoteStatus
} {
  const title = input.title?.trim()
  const body = input.body?.trim()
  const author = input.author?.trim() || "unknown"
  const projectIds = normalizeProjectIds(input.projectIds ?? [])
  const status = normalizeStatus(input.status)

  if (!title) {
    throw new Error("Missing required field: title")
  }

  if (!body) {
    throw new Error("Missing required field: body")
  }

  return {
    projectIds,
    title,
    body,
    author,
    status,
  }
}

function notePointId(noteId: string): string {
  return uuidFromHash(sha256(`knowledge-note:${noteId}`))
}

function noteContent(note: KnowledgeNote): string {
  return [
    `Knowledge note: ${note.title}`,
    `Status: ${note.status}`,
    `Projects: ${note.projectIds.join(", ") || "unassigned"}`,
    `Author: ${note.author}`,
    `Created: ${note.createdAt}`,
    `Updated: ${note.updatedAt}`,
    "",
    note.body,
  ].join("\n")
}

async function writeNotes(notes: KnowledgeNote[]): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true })
  const tempPath = `${notesPath}.tmp`

  await fs.writeFile(tempPath, `${JSON.stringify({ notes }, null, 2)}\n`, "utf8")
  await fs.rename(tempPath, notesPath)
}

export async function readKnowledgeNotes(): Promise<KnowledgeNote[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(notesPath, "utf8")) as { notes?: KnowledgeNote[] }

    return Array.isArray(parsed.notes)
      ? parsed.notes.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      : []
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

export async function upsertKnowledgeNotePoint(note: KnowledgeNote): Promise<void> {
  await ensureCollection()

  const content = noteContent(note)
  const contentHash = sha256(JSON.stringify(note))
  const vector = await createEmbedding([
    `Repository: knowledge-notes`,
    `Projects: ${note.projectIds.join(", ") || "unassigned"}`,
    `Branch: notes`,
    `Documentation locale: default`,
    `Service type: unknown`,
    `Evidence types: documentation`,
    `File: knowledge-notes://${note.id}`,
    "",
    content,
  ].join("\n"))

  await qdrant.upsert(config.collectionName, {
    points: [
      {
        id: notePointId(note.id),
        vector,
        payload: {
          repoName: "knowledge-notes",
          projectIds: note.projectIds,
          projectTagSources: note.projectIds.map(projectId => `knowledge-note:${note.id}:${projectId}`),
          serviceType: "unknown",
          branchName: "notes",
          commitSha: note.updatedAt,
          docLocale: "default",
          evidenceTypes: ["documentation"],
          symbols: [note.title],
          filePath: `knowledge-notes://${note.id}`,
          startLine: 1,
          endLine: content.split(/\r?\n/).length,
          content,
          contentHash,
          noteId: note.id,
          noteStatus: note.status,
          noteAuthor: note.author,
          noteUpdatedAt: note.updatedAt,
        },
      },
    ],
  })
}

export async function createKnowledgeNote(input: KnowledgeNoteInput): Promise<KnowledgeNote> {
  const values = validateNoteInput(input)
  const timestamp = nowIso()
  const note: KnowledgeNote = {
    id: crypto.randomUUID(),
    ...values,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  const notes = await readKnowledgeNotes()

  await writeNotes([note, ...notes])
  await upsertKnowledgeNotePoint(note)

  return note
}

export async function updateKnowledgeNote(noteId: string, input: KnowledgeNoteInput): Promise<KnowledgeNote> {
  const values = validateNoteInput(input)
  const notes = await readKnowledgeNotes()
  const existing = notes.find(note => note.id === noteId)

  if (!existing) {
    throw new Error(`Knowledge note not found: ${noteId}`)
  }

  const updated: KnowledgeNote = {
    ...existing,
    ...values,
    updatedAt: nowIso(),
  }

  await writeNotes(notes.map(note => note.id === noteId ? updated : note))
  await upsertKnowledgeNotePoint(updated)

  return updated
}

export async function deleteKnowledgeNote(noteId: string): Promise<boolean> {
  const notes = await readKnowledgeNotes()
  const nextNotes = notes.filter(note => note.id !== noteId)

  if (nextNotes.length === notes.length) return false

  await writeNotes(nextNotes)
  await ensureCollection()
  await qdrant.delete(config.collectionName, {
    wait: true,
    points: [notePointId(noteId)],
  })

  return true
}
