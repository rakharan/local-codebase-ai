import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

type EdgeCase = {
  name: string
  question: string
  required?: string[]
  forbidden?: string[]
  mustContainOneOf?: string[][]
  timeoutMs?: number
}

const edgeCases: EdgeCase[] = [
  {
    name: "ambiguous broad term should not hallucinate",
    question: "what is config",
    forbidden: ["NOT_FOUND_IN_INDEXED_CODEBASE", "I do not have"],
    mustContainOneOf: [
      ["tf2-ois", "ims-tf2", "mrg-accounts", "fa-trade-publisher"],
    ],
  },
  {
    name: "multi-domain overlap should resolve correctly",
    question: "how does auto copy work",
    required: [
      "SignalBroadcast",
      "bot copy",
      "Auto Copy",
    ],
    forbidden: [
      "MRG Broker Path",
      "accountTypes",
    ],
  },
  {
    name: "non-existent feature should not invent",
    question: "explain the bitcoin trading feature",
    required: [
      "I do not have",
      "NOT_FOUND_IN_INDEXED_CODEBASE",
    ],
  },
  {
    name: "table-specific query finds columns",
    question: "what columns are in dsc_bot_copy table",
    required: [
      "dsc_bot_copy",
      "tf2-ois",
    ],
    forbidden: [
      "NOT_FOUND_IN_INDEXED_CODEBASE",
    ],
  },
  {
    name: "route discovery for subscriptions",
    question: "what API routes exist for managing subscriptions",
    required: [
      "/ois/api/v1/subscribe/",
      "tf2-ois",
    ],
    forbidden: [
      "NOT_FOUND_IN_INDEXED_CODEBASE",
    ],
  },
  {
    name: "cross-repo deposit flow",
    question: "how does deposit demo money flow from web to MT4",
    required: [
      "ims-tf2",
      "mrg-accounts",
      "/mrg/api/v1/deposit/demo/",
      "SubmitDepositDemo",
    ],
    forbidden: [
      "NOT_FOUND_IN_INDEXED_CODEBASE",
    ],
  },
  {
    name: "short generic acronym resolves to project",
    question: "what is ois",
    required: [
      "tf2-ois",
      "order",
      "signal",
    ],
    forbidden: [
      "NOT_FOUND_IN_INDEXED_CODEBASE",
    ],
  },
  {
    name: "queue consumer identification",
    question: "what service consumes pubsub-tf-fx-signal-copy",
    required: [
      "pubsub-tf-fx-signal-copy",
      "fa-trade-publisher",
    ],
    forbidden: [
      "NOT_FOUND_IN_INDEXED_CODEBASE",
    ],
  },
  {
    name: "function existence check",
    question: "does tf2-ois have a function to calculate lot size",
    required: [
      "lot",
      "calculate",
      "tf2-ois",
    ],
    forbidden: [
      "NOT_FOUND_IN_INDEXED_CODEBASE",
    ],
  },
  {
    name: "comparison between brokers",
    question: "what is the difference between MRG and Askap account types",
    required: [
      "MRG",
      "Askap",
      "platform_type",
    ],
    forbidden: [
      "NOT_FOUND_IN_INDEXED_CODEBASE",
    ],
  },
  {
    name: "cron job discovery",
    question: "what cron jobs exist in tf2-sinyo",
    required: [
      "CronCheckAutoCopyTrade",
      "tf2-sinyo",
    ],
    forbidden: [
      "NOT_FOUND_IN_INDEXED_CODEBASE",
    ],
  },
  {
    name: "indonesian informal phrasing",
    question: "cara kerja isignal gimana",
    required: [
      "Auto Copy",
      "sinyal",
      "channel",
    ],
    forbidden: [
      "NOT_FOUND_IN_INDEXED_CODEBASE",
    ],
  },
  {
    name: "vague project reference resolves",
    question: "explain the copy signal bot",
    required: [
      "Auto Copy",
      "bot copy",
      "iSignal",
    ],
    forbidden: [
      "NOT_FOUND_IN_INDEXED_CODEBASE",
    ],
  },
  {
    name: "negative constraint should filter",
    question: "which repos do NOT use MT5",
    required: [
      "MT5",
      "tf2-ois",
    ],
  },
  {
    name: "channel-medal level requirements in Indonesian",
    question: "berapa medal yang dibutuhkan untuk jadi legend",
    required: [
      "Legend",
      "13",
      "14",
    ],
    forbidden: [
      "NOT_FOUND_IN_INDEXED_CODEBASE",
    ],
  },
  {
    name: "glossary for all MRG account types in English",
    question: "list all MRG account types",
    required: [
      "MRG",
      "basic",
      "premium",
      "infinite",
    ],
    forbidden: [
      "NOT_FOUND_IN_INDEXED_CODEBASE",
      "Askap",
    ],
  },
  {
    name: "specific route handler lookup",
    question: "what does /mrg/api/v2/account/types/ return",
    required: [
      "/mrg/api/v2/account/types/",
      "GetAccountTypesV2",
      "ims-tf2",
    ],
    forbidden: [
      "NOT_FOUND_IN_INDEXED_CODEBASE",
    ],
  },
  {
    name: "extreme typo tolerance",
    question: "jelasin flow requesst akkount deemo dr imstf",
    required: [
      "ims-tf",
      "demo",
      "RequestDemoAccount",
    ],
    forbidden: [
      "NOT_FOUND_IN_INDEXED_CODEBASE",
    ],
  },
  {
    name: "docs-only question should prefer docs",
    question: "how to onboard as an iSignal user",
    required: [
      "onboarding",
      "iSignal",
      "docs:isignal-docs",
    ],
    forbidden: [
      "NOT_FOUND_IN_INDEXED_CODEBASE",
      "CronCheckAutoCopyTrade",
    ],
  },
  {
    name: "worker service queue lookup",
    question: "what queues does fa-trade-publisher listen to",
    required: [
      "fa-trade-publisher",
      "pubsub-tf-fx-signal-copy",
    ],
    forbidden: [
      "NOT_FOUND_IN_INDEXED_CODEBASE",
    ],
  },
]

async function ask(question: string, timeoutMs: number): Promise<string> {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["--import", "./register-ts-node.mjs", "src/ask.ts", question],
    {
      cwd: process.cwd(),
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    },
  )

  return [stdout, stderr].filter(Boolean).join("\n")
}

async function main() {
  let failed = 0
  const results: { name: string; status: string; details?: string }[] = []

  for (const testCase of edgeCases) {
    process.stdout.write(`Running: ${testCase.name}... `)

    try {
      const output = await ask(testCase.question, testCase.timeoutMs ?? 180_000)
      const missing = (testCase.required ?? []).filter(value => !output.includes(value))
      const presentForbidden = (testCase.forbidden ?? []).filter(value => output.includes(value))
      const missingOneOf = (testCase.mustContainOneOf ?? []).filter(group => !group.some(value => output.includes(value)))

      if (missing.length > 0 || presentForbidden.length > 0 || missingOneOf.length > 0) {
        failed++
        console.log("FAILED")
        results.push({ name: testCase.name, status: "FAILED", details: output.slice(0, 2_000) })

        if (missing.length > 0) {
          console.log("  Missing required evidence:")
          for (const value of missing) {
            console.log(`  - ${value}`)
          }
        }

        if (presentForbidden.length > 0) {
          console.log("  Found forbidden output:")
          for (const value of presentForbidden) {
            console.log(`  - ${value}`)
          }
        }

        if (missingOneOf.length > 0) {
          console.log("  Missing at least one from group:")
          for (const group of missingOneOf) {
            console.log(`  - [${group.join(", ")}]`)
          }
        }
      } else {
        console.log("ok")
        results.push({ name: testCase.name, status: "ok" })
      }
    } catch (error) {
      failed++
      console.log("FAILED")
      const errorMsg = error instanceof Error ? error.message : String(error)
      results.push({ name: testCase.name, status: "ERROR", details: errorMsg })
      console.error(error)
    }
  }

  console.log("\n=== SUMMARY ===")
  console.log(`Passed: ${results.filter(r => r.status === "ok").length}/${edgeCases.length}`)
  console.log(`Failed: ${results.filter(r => r.status === "FAILED" || r.status === "ERROR").length}/${edgeCases.length}`)

  for (const result of results) {
    if (result.status !== "ok") {
      console.log(`\n[${result.status}] ${result.name}`)
      if (result.details) {
        console.log(result.details)
      }
    }
  }

  if (failed > 0) {
    console.log(`\n${failed} edge case(s) failed`)
    process.exit(1)
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
