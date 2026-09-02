import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { prewarmBM25Index } from "./lib/bm25-index.js"

const execFileAsync = promisify(execFile)

type AnswerCase = {
  name: string
  question: string
  smoke?: boolean
  args?: string[]
  required: string[]
  forbidden?: string[]
  timeoutMs?: number
  // Structured assertions against the combined stdout+stderr output (debug logs).
  // These check retrieval behavior, not just answer prose.
  requiredOutput?: string[]
  forbiddenOutput?: string[]
  // Max number of SOURCES lines permitted in the answer. Asserts source precision.
  maxSources?: number
  // Soft performance budget: fail if internal ask (ask-complete-early-return or
  // ask-complete totalMs) exceeds this. Generous default to avoid flakiness.
  maxInternalMs?: number
}

type RunnerOptions = {
  chatModel?: string
  grep?: string
  suite?: "smoke" | "full"
}

const cases: AnswerCase[] = [
  {
    name: "exact endpoint details follows ims-tf2 to mrg-accounts",
    smoke: true,
    question: "request body, validasi, dan return dari endpoint /mrg/api/v1/deposit/demo/ itu apa?",
    required: [
      "/mrg/api/v1/deposit/demo/",
      "ims-tf2@develop",
      "mrg-accounts@develop",
      "mt_id -> login",
      "metaserver_id -> metaserver_id (parseInt)",
      "nominal -> nominal (parseInt)",
      "deposit_demo",
      "users_demoid",
    ],
  },
  {
    name: "exact symbol explains SubmitDepositDemo",
    question: "jelasin SubmitDepositDemo",
    required: [
      "SubmitDepositDemo",
      "/mrg/api/v1/deposit/demo/",
      "MrgV2Controller.SubmitDepositDemo",
      "mrg-accounts@develop",
      "demoModel.SubmitDepositDemo",
    ],
  },
  {
    name: "php ims-tf caller links to ims-tf2 endpoint",
    question: "which ims-tf PHP code calls /mrg/api/v1/account/demo/request/ and what happens in ims-tf2?",
    required: [
      "ims-tf@develop-mt5",
      "accountReqDemo",
      "ACCOUNT_REQUEST_DEMO_1",
      "ims-tf2@develop",
      "/mrg/api/v1/account/demo/request/",
      "MrgController.RequestDemoAccount",
    ],
    forbidden: [
      "transactionHistory in ims-tf@develop-mt5",
      "NOT_FOUND_IN_INDEXED_CODEBASE",
    ],
  },
  {
    name: "broad ims-tf demo account flow auto-discovers route anchor",
    smoke: true,
    question: "jelasin flow request account demo dari ims-tf",
    required: [
      "ims-tf@develop-mt5",
      "accountReqDemo",
      "ims-tf2@develop",
      "/mrg/api/v1/account/demo/request",
      "MrgController.RequestDemoAccount",
      "ReqAccountDemo",
      "mrg-accounts@develop",
      "demoModel.RequestAccountNew",
      "users_demoid",
      "components/askap/models/askap.php",
    ],
    forbidden: [
      "Saya tidak punya anchor route/function yang persis",
      "/mrg/api/v2/account/demo/request/",
      "/mrg/api/v1/account/demo/delete",
    ],
  },
  {
    name: "broad ims-tf demo account flow tolerates simple typo",
    question: "explain flow request account deemo from ims-tf",
    required: [
      "ims-tf@develop-mt5",
      "accountReqDemo",
      "ACCOUNT_REQUEST_DEMO_1",
      "ims-tf2@develop",
      "/mrg/api/v1/account/demo/request",
      "MrgController.RequestDemoAccount",
      "ReqAccountDemo",
      "mrg-accounts@develop",
      "demoModel.RequestAccountNew",
      "users_demoid",
      "components/askap/models/askap.php",
    ],
    forbidden: [
      "I do not have an exact route/function anchor",
      "NOT_FOUND_IN_INDEXED_CODEBASE",
      "/mrg/api/v2/account/demo/request/",
      "/mrg/api/v1/account/demo/delete",
    ],
  },
  {
    name: "glossary lists MMB MT4 account types",
    smoke: true,
    question: "Berikan list tipe akun mt4 mmb",
    required: [
      "Tipe akun MMB/Askap MT4",
      "SILVER",
      "GOLD",
      "PREMIUM",
      "Micro",
      "ULTIMATE",
      "i-Profesional",
      "platform_type 0",
    ],
    forbidden: [
      "NOT_FOUND_IN_INDEXED_CODEBASE",
    ],
  },
  {
    name: "glossary follows English answer language",
    question: "Give me the list of MT4 MMB account types",
    required: [
      "MMB/Askap MT4 account types found",
      "SILVER",
      "GOLD",
      "PREMIUM",
      "platform_type 0",
    ],
    forbidden: [
      "Tipe akun MMB MT4",
      "NOT_FOUND_IN_INDEXED_CODEBASE",
    ],
  },
  {
    name: "glossary explains hidden MMB MT5 account types",
    question: "Berikan list tipe akun mt5 mmb",
    required: [
      "Tipe akun MMB/Askap MT5",
      "SILVER",
      "GOLD",
      "PREMIUM",
      "Micro",
      "i-Profesional",
      "platform_type 5",
      "show 0",
    ],
    forbidden: [
      "NOT_FOUND_IN_INDEXED_CODEBASE",
    ],
  },
  {
    name: "glossary lists MRG account types without documentation fallback",
    question: "apa saja tipe akun mrg",
    required: [
      "Tipe akun MRG",
      "basic",
      "premium",
      "infinite",
      "components/mrg/libs/config.js",
    ],
    forbidden: [
      "docs:isignal-docs",
      "MRG Broker Path",
      "NOT_FOUND_IN_INDEXED_CODEBASE",
    ],
  },
  {
    name: "glossary definition prefers iSignal overview docs",
    smoke: true,
    question: "apa itu isignal",
    timeoutMs: 30_000,
    required: [
      "Auto Copy",
      "signal ingestion",
      "docs:isignal-docs\\index.mdx",
    ],
    forbidden: [
      "CronCheckAutoCopyTrade",
      "classDef mrg",
      "MRG Broker Path",
    ],
  },
  {
    name: "iSignal development date uses changelog and does not invent exact start",
    question: "Kapan isignal mulai didevelop",
    required: [
      "Tanggal mulai development iSignal tidak bisa dipastikan",
      "August 1st, 2024",
      "docs:isignal-docs\\CHANGELOG.md",
    ],
    forbidden: [
      "CronCheckAutoCopyTrade",
      "docs:fa-porto-docs",
    ],
  },
  {
    name: "iSignal account eligibility avoids cron fallback",
    question: "akun jenis apa yang boleh ikut isignal",
    required: [
      "Berdasarkan evidence yang ter-index",
      "Saya tidak menemukan daftar jenis akun yang eksplisit",
      "docs:isignal-docs\\features\\business-rules.md",
    ],
    forbidden: [
      "CronCheckAutoCopyTrade",
      "docs:product-knowledge\\glossary.mdx",
    ],
  },
  {
    name: "iSignal minimum equity reads config fallback",
    smoke: true,
    question: "berapa minimal equity untuk bisa ikut isignal",
    required: [
      "Minimal equity iSignal",
      "1000",
      "AUTO_COPY_MINIMUM_EQUITY",
      "runtime bisa berbeda",
      "tf2-ois@develop",
      "models/ois.js",
    ],
    forbidden: [
      "Saya tidak menemukan angka minimal equity",
      "CronCheckAutoCopyTrade",
      "By Tier Balance",
      "Margin Level",
    ],
  },
  {
    name: "deep mode keeps iSignal minimum equity grounded in config",
    smoke: true,
    question: "berapa minimal equity untuk bisa ikut isignal",
    args: ["--deep"],
    required: [
      "Investigation trace",
      "Minimal equity iSignal",
      "1000",
      "AUTO_COPY_MINIMUM_EQUITY",
      "tf2-ois@develop",
      "models/ois.js",
    ],
    forbidden: [
      "NOT_FOUND_IN_INDEXED_CODEBASE",
      "docs:isignal-docs\\cron-jobs",
      "By Tier Balance",
      "Margin Level",
    ],
    timeoutMs: 240_000,
  },
  {
    name: "short acronym definition prefers FA product docs",
    question: "apa itu FA",
    required: [
      "Penasihat Keuangan",
      "FA",
      "docs:fa-porto-docs\\index.mdx",
    ],
    forbidden: [
      "Legacy Archives",
      "docs:devops-docs",
      "NOT_FOUND_IN_INDEXED_CODEBASE",
    ],
  },
  {
    name: "short broker alias definition answers from registry",
    smoke: true,
    question: "apa itu mmb",
    args: ["--deep"],
    required: [
      "Askap/MMB adalah broker/domain yang sama",
      "Alias: askap, mmb",
      "config/services.json",
    ],
    forbidden: [
      "Legacy Archives",
      "Kami telah mempertahankan dokumentasi lama",
      "docs:devops-docs\\index.mdx",
    ],
    timeoutMs: 240_000,
  },
  {
    name: "canonical broker definition answers from registry",
    question: "apa itu askap",
    args: ["--deep"],
    required: [
      "Askap/MMB adalah broker/domain yang sama",
      "MMB adalah alias",
      "Nama canonical/projectId: askap / askap",
      "config/services.json",
    ],
    forbidden: [
      "Legacy Archives",
      "Kami telah mempertahankan dokumentasi lama",
      "docs:devops-docs\\index.mdx",
    ],
    timeoutMs: 240_000,
  },
  {
    name: "short acronym definition with rules includes FA business rules",
    question: "apa itu FA dan apa saja aturan nya",
    required: [
      "Penasihat Keuangan",
      "Aturan yang ditemukan",
      "Pendaftaran",
      "2 portfolio aktif",
      "Wishlist",
      "docs:fa-porto-docs\\features\\business-rules.md",
    ],
    forbidden: [
      "Legacy Archives",
      "docs:devops-docs",
      "NOT_FOUND_IN_INDEXED_CODEBASE",
    ],
  },
  {
    name: "short lowercase acronym rules prefers FA business rules",
    question: "apa saja rules fa",
    required: [
      "Financial Advisor",
      "Pendaftaran",
      "2 portfolio aktif",
      "Wishlist",
      "tf2_signals_incubation",
      "docs:fa-porto-docs\\features\\business-rules.md",
    ],
    forbidden: [
      "docs:isignal-docs\\features\\business-rules.md",
      "dsc_signals_copy",
      "NOT_FOUND_IN_INDEXED_CODEBASE",
    ],
  },
  {
    name: "short technical term explains MT4 from code config",
    smoke: true,
    question: "apa itu mt4",
    required: [
      "MT4 adalah platform/jenis server MetaTrader",
      "MT4 = 1",
      "platform_type 0",
      "VOLUME_MULTIPLIER.MT4",
      "tf2-ois@develop libs/config.js",
    ],
    forbidden: [
      "Legacy Archives",
      "docs:devops-docs",
      "NOT_FOUND_IN_INDEXED_CODEBASE",
    ],
  },
  {
    name: "short technical term explains MT5 from code config",
    question: "apa itu mt5",
    required: [
      "MT5 adalah platform/jenis server MetaTrader",
      "MT5 = 2",
      "platform_type 5",
      "platform_type 3",
      "VOLUME_MULTIPLIER.MT5",
      "ENABLE_MT5",
      "tf2-ois@develop libs/config.js",
    ],
    forbidden: [
      "Legacy Archives",
      "docs:devops-docs",
      "NOT_FOUND_IN_INDEXED_CODEBASE",
    ],
  },
  {
    name: "documentation how-it-works returns Mermaid flowchart",
    smoke: true,
    question: "how isignal works?",
    required: [
      "Flowchart from indexed documentation",
      "```mermaid",
      "graph TB",
      "SignalBroadcast",
      "Trade Publisher",
      "docs:isignal-docs\\architecture\\diagrams.mdx",
    ],
    forbidden: [
      "| CronCheckAutoCopyTrade |",
      "| tf2-ois |",
      "classDef mrg",
      "MRG Broker Path",
    ],
  },
  {
    name: "broad level requirement question finds tf2-ois legend config",
    question: "What is the requirements to be a legend",
    required: [
      "tf2-ois",
      "Legend",
      "13",
      "14",
      "RANGE_MEDAL",
    ],
    forbidden: [
      "NOT_FOUND_IN_INDEXED_CODEBASE",
      "docs:devops-docs",
    ],
  },
  {
    name: "medal mechanism explains implicit VP formula",
    smoke: true,
    question: "how do we gain medal",
    required: [
      "CalculatePointAndMedal20260531",
      "signal_settled >= 5",
      "current_month_vp >= minimum_vp",
      "80% * average_monthly_vp",
      "src/domain/vp.ts",
    ],
    forbidden: [
      "For a channel to reach Newbie",
      "NOT_FOUND_IN_INDEXED_CODEBASE",
    ],
  },
  {
    name: "retrieval: exact endpoint source precision excludes self-repo and docs",
    smoke: true,
    question: "Which services call the mrg API?",
    required: [
      "Endpoint definition found in",
      "/mrg/api/v1/deposit/demo/",
      "MrgV2Controller.SubmitDepositDemo",
      "ims-tf2@develop",
      "mrg-accounts@develop",
      "accountReqDemo",
    ],
    forbidden: [
      "local-codebase-ai@main",
      "ims-tf2-docs@doctor",
      "ims-tf2@doctor",
      "GetAccountTypes in ims-tf2",
      "CheckAccounts in ims-tf2",
      "GetAccounts in ims-tf2",
      "GetDemoAccounts in ims-tf2",
      "GetContestAccounts in ims-tf2",
    ],
    // Assert retrieval behavior via debug logs.
    requiredOutput: [
      "early-return path=exact-endpoint-detail",
    ],
    forbiddenOutput: [
      "llm-start call=language",
      "stage name=expansion-retrieval",
    ],
    // Source precision: at most 4 sources (route def, handler, upstream, downstream).
    maxSources: 4,
    // Soft latency budget (10s, generous to avoid flakiness on cold BM25 load).
    maxInternalMs: 10_000,
  },
  {
    name: "retrieval: explicit endpoint question returns handler details",
    smoke: true,
    question: "What does /mrg/api/v1/deposit/demo/ do?",
    required: [
      "Endpoint definition found in",
      "/mrg/api/v1/deposit/demo/",
      "MrgV2Controller.SubmitDepositDemo",
      "SubmitDepositDemo",
      "mrg-accounts@develop",
      "deposit_demo",
      "users_demoid",
    ],
    forbidden: [
      "local-codebase-ai@main",
      "NOT_FOUND_IN_INDEXED_CODEBASE",
    ],
  },
  {
    name: "retrieval: repo-filtered query respects scope",
    question: "What does /mrg/api/v1/deposit/demo/ do?",
    args: ["--repo-name", "ims-tf2", "--branch", "develop"],
    required: [
      "/mrg/api/v1/deposit/demo/",
      "MrgV2Controller.SubmitDepositDemo",
      "ims-tf2@develop",
    ],
    forbidden: [
      "local-codebase-ai@main",
      "NOT_FOUND_IN_INDEXED_CODEBASE",
    ],
  },
  {
    name: "retrieval: Indonesian endpoint question uses heuristic language",
    smoke: true,
    question: "Bagaimana alur endpoint /mrg/api/v1/deposit/demo/?",
    required: [
      "/mrg/api/v1/deposit/demo/",
      "MrgV2Controller.SubmitDepositDemo",
    ],
    forbidden: [
      "local-codebase-ai@main",
      "NOT_FOUND_IN_INDEXED_CODEBASE",
    ],
    // Assert the language LLM call was skipped (heuristic was confident),
    // rather than asserting an exact ms=0 which is brittle.
    forbiddenOutput: [
      "llm-start call=language",
    ],
  },
  {
    name: "retrieval: ambiguous identifier query falls through to LLM or heuristic",
    // Question with no heuristic language tokens — exercises the LLM fallback
    // path (or heuristic "unknown"). Previous version used "validation flow"
    // which the English heuristic already matches, so it never tested fallback.
    question: "MRG SubmitDepositDemo",
    required: [
      "SubmitDepositDemo",
      "/mrg/api/v1/deposit/demo/",
    ],
    forbidden: [
      "local-codebase-ai@main",
      "NOT_FOUND_IN_INDEXED_CODEBASE",
    ],
  },
  {
    name: "retrieval: decision-intent question avoids deterministic endpoint path",
    question: "Why was SubmitDepositDemo changed?",
    required: [],
    forbidden: [
      "Endpoint definition found in",
    ],
    // Strengthen: must not take the deterministic endpoint-detail early return,
    // and the process must not fail mid-answer.
    forbiddenOutput: [
      "early-return path=exact-endpoint-detail",
    ],
  },
  {
    name: "isignal auto copy flow (deep, ID)",
    question: "bagaimana cara kerja isignal auto copy dari signal masuk sampai ke akun user",
    smoke: true,
    args: ["--deep"],
    required: ["dsc_signals", "fa-trade-publisher"],
    forbidden: ["edit feature"],
    requiredOutput: ["doc-ref-code-retrieval"],
    maxSources: 30,
    maxInternalMs: 120_000,
  },
]

function parseOptions(argv: string[]): RunnerOptions {
  const options: RunnerOptions = {}

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = argv[i + 1]
    if (arg === "--chat-model" && value) {
      options.chatModel = value
      i++
    } else if (arg === "--grep" && value) {
      options.grep = value
      i++
    } else if (arg === "--suite" && (value === "smoke" || value === "full")) {
      options.suite = value
      i++
    }
  }

  return options
}

async function ask(question: string, timeoutMs: number, args: string[] = [], options: RunnerOptions = {}): Promise<string> {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      "--import",
      "./register-ts-node.mjs",
      "src/ask.ts",
      question,
      ...(options.chatModel ? ["--chat-model", options.chatModel] : []),
      ...args,
    ],
    {
      cwd: process.cwd(),
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, ASK_DEBUG: "1" },
    },
  )

  return [stdout, stderr].filter(Boolean).join("\n")
}

function findMissing(output: string, expected: string[]): string[] {
  return expected.filter(value => !output.includes(value))
}

function countSources(output: string): number {
  const sourcesMatch = output.match(/\nSOURCES\n\n([\s\S]*)/)
  if (!sourcesMatch?.[1]) return 0
  return sourcesMatch[1]
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.startsWith("- ")).length
}

function parseInternalMs(output: string): number | undefined {
  // Matches both ask-complete-early-return and ask-complete totalMs=N.
  const match = output.match(/ask-complete(?:-early-return)? totalMs=(\d+)/)
  return match?.[1] ? Number(match[1]) : undefined
}

async function main() {
  const runnerOptions = parseOptions(process.argv.slice(2))
  const chatModel = runnerOptions.chatModel ?? process.env.ANSWER_TEST_CHAT_MODEL ?? "qwen2.5-coder:3b"
  runnerOptions.chatModel = chatModel
  const suite = runnerOptions.suite ?? "smoke"
  const suiteCases = suite === "full" ? cases : cases.filter(answerCase => answerCase.smoke)
  const selectedCases = runnerOptions.grep
    ? suiteCases.filter(answerCase => {
      const pattern = runnerOptions.grep!.toLowerCase()
      return answerCase.name.toLowerCase().includes(pattern) || answerCase.question.toLowerCase().includes(pattern)
    })
    : suiteCases

  if (selectedCases.length === 0) {
    throw new Error(`No answer regression cases matched --grep ${JSON.stringify(runnerOptions.grep)}`)
  }

  let failed = 0
  console.log(`Answer regression model: ${chatModel}`)
  console.log(`Suite: ${suite} (${selectedCases.length}/${cases.length})`)
  if (runnerOptions.grep) {
    console.log(`Case filter: ${runnerOptions.grep}`)
  }

  // Prewarm BM25 in-process before spawning children so each child hits the
  // fast disk-cache path instead of contending on the cross-process build lock.
  // Without this, the first smoke case can SIGTERM while waiting up to 300s
  // for another process's build to finish.
  console.log("Prewarming BM25 index...")
  try {
    await prewarmBM25Index()
    console.log("BM25 index ready.")
  } catch (err) {
    console.warn(`BM25 prewarm failed (non-fatal): ${err instanceof Error ? err.message : err}`)
  }

  for (const answerCase of selectedCases) {
    process.stdout.write(`Running: ${answerCase.name}... `)

    try {
      const output = await ask(answerCase.question, answerCase.timeoutMs ?? 180_000, answerCase.args, runnerOptions)
      const failures: string[] = []

      // 1. Answer-content assertions (required / forbidden against full output).
      const missing = findMissing(output, answerCase.required)
      const presentForbidden = (answerCase.forbidden ?? []).filter(value => output.includes(value))
      if (missing.length > 0) {
        failures.push(`Missing required evidence: ${missing.join(", ")}`)
      }
      if (presentForbidden.length > 0) {
        failures.push(`Found forbidden output: ${presentForbidden.join(", ")}`)
      }

      // 2. Structured debug-output assertions.
      const missingOutput = findMissing(output, answerCase.requiredOutput ?? [])
      const presentForbiddenOutput = (answerCase.forbiddenOutput ?? []).filter(value => output.includes(value))
      if (missingOutput.length > 0) {
        failures.push(`Missing required debug output: ${missingOutput.join(", ")}`)
      }
      if (presentForbiddenOutput.length > 0) {
        failures.push(`Found forbidden debug output: ${presentForbiddenOutput.join(", ")}`)
      }

      // 3. Source-count precision budget.
      if (answerCase.maxSources !== undefined) {
        const sourceCount = countSources(output)
        if (sourceCount > answerCase.maxSources) {
          failures.push(`Source count ${sourceCount} exceeds max ${answerCase.maxSources}`)
        }
      }

      // 4. Soft performance budget (internal ask time).
      if (answerCase.maxInternalMs !== undefined) {
        const internalMs = parseInternalMs(output)
        if (internalMs !== undefined && internalMs > answerCase.maxInternalMs) {
          failures.push(`Internal ask ${internalMs}ms exceeds budget ${answerCase.maxInternalMs}ms`)
        }
      }

      if (failures.length > 0) {
        failed++
        console.log("FAILED")
        for (const f of failures) {
          console.log(`  - ${f}`)
        }
        console.log("  Output preview:")
        console.log(output.slice(0, 2_000))
      } else {
        console.log("ok")
      }
    } catch (error) {
      failed++
      console.log("FAILED")
      console.error(error)
    }
  }

  if (failed > 0) {
    throw new Error(`${failed} answer regression case(s) failed`)
  }

  console.log(`All ${selectedCases.length} answer regression cases passed.`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
