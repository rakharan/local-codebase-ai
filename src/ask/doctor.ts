import type { RetrievedPayload } from "./types.js"

export function isDoctorChunk(chunk: RetrievedPayload): boolean {
  return Boolean(chunk.filePath?.startsWith("doctor:") || chunk.filePath?.startsWith("doctor-fact:"))
}

export function buildDoctorInventoryAnswer(chunks: RetrievedPayload[]): {
  answer: string
  sources: RetrievedPayload[]
} | undefined {
  const doctorChunks = chunks.filter(isDoctorChunk)
  if (doctorChunks.length === 0) return undefined

  return {
    answer: doctorChunks.map(chunk => chunk.content ?? "").filter(Boolean).join("\n\n---\n\n"),
    sources: doctorChunks,
  }
}

