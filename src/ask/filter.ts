// Filter
// Refactored from ask.ts — uses ctx for shared state

import type { ServiceType } from "../lib/chunker.js"
import { chat } from "../lib/ollama.js"
import type { RetrievedPayload } from "./types.js"
import { Command } from "commander"
import { ctx } from "./context.js"

export function buildFilter() {
  const must = []
  const should = []

  if (ctx.repoName) {
    must.push({
      key: "repoName",
      match: {
        value: ctx.repoName,
      },
    })
  }

  if (ctx.projectFilterIds.length === 1) {
    must.push({
      key: "projectIds",
      match: {
        value: ctx.projectFilterIds[0],
      },
    })
  } else if (ctx.projectFilterIds.length > 1) {
    should.push(
      ...ctx.projectFilterIds.map((projectId: string) => ({
        key: "projectIds",
        match: {
          value: projectId,
        },
      })),
    )
  }

  if (ctx.branch) {
    must.push({
      key: "branchName",
      match: {
        value: ctx.branch,
      },
    })
  }

  if (ctx.serviceType) {
    must.push({
      key: "ctx.serviceType",
      match: {
        value: ctx.serviceType,
      },
    })
  }

  if (must.length === 0 && should.length === 0) return undefined

  return {
    ...(must.length > 0 ? { must } : {}),
    ...(should.length > 0 ? { should } : {}),
  }
}


export function payloadMatchesFilter(payload: RetrievedPayload, filter: SearchFilter): boolean {
  if (!filter) return true

  if (filter.must) {
    for (const cond of filter.must) {
      const key = (cond as { key: string }).key
      const value = (cond as { match: { value: unknown } }).match.value
      if (key === "repoName" && payload.repoName !== value) return false
      if (key === "branchName" && payload.branchName !== value) return false
      if (key === "ctx.serviceType" && payload.serviceType !== value) return false
      if (key === "projectIds" && !payload.projectIds?.includes(value as string)) return false
    }
  }

  if (filter.should && filter.should.length > 0) {
    const matched = filter.should.some(cond => {
      const key = (cond as { key: string }).key
      const value = (cond as { match: { value: unknown } }).match.value
      if (key === "projectIds") return payload.projectIds?.includes(value as string) ?? false
      if (key === "repoName") return payload.repoName === value
      if (key === "branchName") return payload.branchName === value
      if (key === "ctx.serviceType") return payload.serviceType === value
      return false
    })
    if (!matched) return false
  }

  return true
}


export function repoBranchFileFilter(repoName: string, branchName: string, filePath: string) {
  return {
    must: [
      {
        key: "repoName",
        match: {
          value: repoName,
        },
      },
      {
        key: "branchName",
        match: {
          value: branchName,
        },
      },
      {
        key: "filePath",
        match: {
          value: filePath,
        },
      },
    ],
  }
}


export type SearchFilter = ReturnType<typeof buildFilter>

const serviceTypes = new Set<ServiceType>(["api", "worker", "cron", "library", "unknown"])

const program = new Command()

program
  .argument("<question...>", "Question to ask")
  .option("--limit <limit>", "Number of chunks to retrieve", "8")
  .option("--deep", "Run bounded read-only multi-step investigation before answering")
  .option("--repo-name <repoName>", "Only search one indexed repository")
  .option("--project <projectId>", "Only search one project/product/domain")
  .option("--branch <branchName>", "Only search one indexed branch")
  .option("--service-type <serviceType>", "Only search one service type")
  .option("--chat-model <model>", "Ollama chat model override for this question")
  .option("--history <json>", "JSON string of previous conversation messages")
  .parse()

const question = program.args.join(" ")
const options = program.opts<{ limit: string; deep?: boolean; repoName?: string; project?: string; branch?: string; serviceType?: string; chatModel?: string; history?: string }>()
