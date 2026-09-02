import type { AnswerLanguage } from "../lib/ollama.js"
import type { ServiceType } from "../lib/chunker.js"
import type { RetrievedChunk } from "./types.js"
import type { RegistryExpansion } from "../lib/service-registry.js"

export type AskContext = {
  question: string
  retrievalQuestion: string
  limit: number
  deepMode: boolean
  serviceType?: ServiceType
  repoName?: string
  branch?: string
  project?: string
  projectFilterIds: string[]
  projectFilterRepos: Set<string>
  registryExpansion: RegistryExpansion
  retrievalDegradation: { bm25Unavailable: boolean }
  fileChunkCache: Map<string, RetrievedChunk[]>
  answerLanguage: AnswerLanguage
  history: Array<{ role: string; content: string }>
}

export const ctx: AskContext = {} as AskContext
