import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

type AnswerCase = {
  name: string
  question: string
  args?: string[]
  required: string[]
  forbidden?: string[]
  timeoutMs?: number
}

const cases: AnswerCase[] = [
  {
    name: "exact endpoint details follows ims-tf2 to mrg-accounts",
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
    question: "apa itu isignal",
    required: [
      "Auto Copy",
      "sinyal perdagangan",
      "channel master",
      "pengolahan sinyal",
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
      "1 Agustus, 2024",
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
    name: "short acronym definition says not found without exact evidence",
    question: "apa itu mmb",
    args: ["--deep"],
    required: [
      "Saya tidak menemukan definisi MMB yang eksplisit",
      "Registry hanya punya alias",
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
]

async function ask(question: string, timeoutMs: number, args: string[] = []): Promise<string> {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ["--import", "./register-ts-node.mjs", "src/ask.ts", question, ...args],
    {
      cwd: process.cwd(),
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    },
  )

  return [stdout, stderr].filter(Boolean).join("\n")
}

function findMissing(output: string, expected: string[]): string[] {
  return expected.filter(value => !output.includes(value))
}

async function main() {
  let failed = 0

  for (const answerCase of cases) {
    process.stdout.write(`Running: ${answerCase.name}... `)

    try {
      const output = await ask(answerCase.question, answerCase.timeoutMs ?? 180_000, answerCase.args)
      const missing = findMissing(output, answerCase.required)
      const presentForbidden = (answerCase.forbidden ?? []).filter(value => output.includes(value))

      if (missing.length > 0 || presentForbidden.length > 0) {
        failed++
        console.log("FAILED")

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

  console.log(`All ${cases.length} answer regression cases passed.`)
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
