import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

type AnswerCase = {
  name: string
  question: string
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
    ],
    forbidden: [
      "Saya tidak punya anchor route/function yang persis",
      "/mrg/api/v2/account/demo/request/",
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
    ],
    forbidden: [
      "I do not have an exact route/function anchor",
      "NOT_FOUND_IN_INDEXED_CODEBASE",
      "/mrg/api/v2/account/demo/request/",
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

function findMissing(output: string, expected: string[]): string[] {
  return expected.filter(value => !output.includes(value))
}

async function main() {
  let failed = 0

  for (const answerCase of cases) {
    process.stdout.write(`Running: ${answerCase.name}... `)

    try {
      const output = await ask(answerCase.question, answerCase.timeoutMs ?? 180_000)
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
