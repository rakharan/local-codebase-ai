import fs from "node:fs/promises"
import readline from "node:readline"
import { Command } from "commander"
import { loadKnowledgeContext } from "../lib/extractors/knowledge-context.js"
import { extractBrainDump } from "../lib/extractors/brain-dump.js"
import { extractDebugFinding, inferDiscoveredIn } from "../lib/extractors/debug-finding.js"
import {
  extractJiraText,
  extractJiraTicket,
  readJiraCredentials,
  JIRA_SETUP_MESSAGE,
} from "../lib/extractors/jira.js"
import { renderDraft, draftFileName, type AdrMetadata } from "../lib/adr-writer.js"
import { saveDraft } from "../lib/draft-manager.js"
import type { ExtractedDecision, DraftSource } from "../lib/extractors/types.js"

const program = new Command()

program
  .argument("[input...]", "Freeform text to digest")
  .option("--file <path>", "Read input from a text file")
  .option("--jira <ticketId>", "Fetch and digest a Jira ticket")
  .option("--jira-text", "Treat the positional input as pasted Jira ticket content")
  .option("--finding", "Short-form debug discovery (uses implicit_rule template)")
  .option("--service <name>", "Hint for affected service / discovery location")
  .option("--interactive", "Prompt for multi-turn input")
  .parse()

const options = program.opts<{
  file?: string
  jira?: string
  jiraText?: boolean
  finding?: boolean
  service?: string
  interactive?: boolean
}>()

const positionalInput = program.args.join(" ").trim()

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk))
  }

  return Buffer.concat(chunks).toString("utf8").trim()
}

async function readInteractiveInput(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  console.log("Interactive digest. Type your dump. Submit an empty line to finish.\n")

  const lines: string[] = []

  await new Promise<void>(resolve => {
    rl.on("line", line => {
      if (line.trim().length === 0) {
        rl.close()
        return
      }
      lines.push(line)
    })
    rl.on("close", () => resolve())
  })

  return lines.join("\n").trim()
}

async function resolveTextInput(): Promise<string> {
  if (options.file) {
    return (await fs.readFile(options.file, "utf8")).trim()
  }

  if (options.interactive) {
    return readInteractiveInput()
  }

  if (positionalInput) {
    return positionalInput
  }

  // Tidak ada teks di argumen — coba baca dari stdin (mis. hasil pipe atau pbpaste).
  if (!process.stdin.isTTY) {
    return readStdin()
  }

  return ""
}

async function main(): Promise<void> {
  const context = await loadKnowledgeContext()
  const date = today()

  let decision: ExtractedDecision
  let source: DraftSource
  let discoveredIn: string | null = null

  if (options.jira) {
    const credentials = readJiraCredentials()

    if (!credentials) {
      console.log(JIRA_SETUP_MESSAGE)
      process.exit(0)
    }

    source = "jira"
    decision = await extractJiraTicket(options.jira, context, credentials)
  } else if (options.jiraText) {
    const text = positionalInput || (process.stdin.isTTY ? "" : await readStdin())
    source = "jira"
    decision = await extractJiraText(text, context)
  } else if (options.finding) {
    const text = await resolveTextInput()

    if (!text) {
      throw new Error("No finding text provided. Pass text directly or via --file.")
    }

    discoveredIn = inferDiscoveredIn(text, options.service)
    source = "debug_discovery"
    decision = await extractDebugFinding({ text }, context)
  } else {
    const text = await resolveTextInput()

    if (!text) {
      throw new Error("No input provided. Pass text, --file <path>, --jira <id>, --finding, or --interactive.")
    }

    source = "brain_dump"
    decision = await extractBrainDump(text, context)
  }

  const meta: AdrMetadata = { date, source, discoveredIn }
  const draft = renderDraft(decision, meta)
  const fileName = draftFileName(date, decision.decision)
  const fullPath = await saveDraft(fileName, draft)

  console.log(`Draft created: ${fullPath}`)
  console.log(`  type: ${decision.type}`)
  console.log(`  decision: ${decision.decision}`)
  console.log(`  affected services: ${decision.affected_services.join(", ") || "(none — review)"}`)
  if (decision.type === "decision") {
    console.log(`  affected tables: ${decision.affected_tables.join(", ") || "(none — review)"}`)
  }
  console.log("\nReview it, then run: ask drafts approve " + fileName)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
