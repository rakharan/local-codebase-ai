import path from "node:path"
import { fileURLToPath } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import express from "express"

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, "..")
const publicDir = path.join(rootDir, "public")

const app = express()
app.use(express.json())
app.use(express.static(publicDir))

type HistoryMessage = {
  role: "user" | "assistant"
  content: string
}

type AskBody = {
  question: string
  limit?: number
  repoName?: string
  branch?: string
  serviceType?: string
  history?: HistoryMessage[]
}

type AskResult = {
  answer: string
  sources: string[]
  raw: string
}

function parseAskOutput(stdout: string): AskResult {
  const answerMatch = stdout.match(/\nANSWER\n\n([\s\S]*?)(?:\nSOURCES\n|$)/)
  const sourcesMatch = stdout.match(/\nSOURCES\n\n([\s\S]*)/)

  const answer = answerMatch?.[1]?.trim() ?? stdout.trim()
  const sourcesText = sourcesMatch?.[1]?.trim() ?? ""
  const sources = sourcesText
    .split("\n")
    .map(line => line.trim())
    .filter(line => line.startsWith("- "))
    .map(line => line.slice(2).trim())

  return { answer, sources, raw: stdout }
}

app.post("/api/ask", async (request, response) => {
  const body = request.body as AskBody
  const question = body.question?.trim()

  if (!question) {
    response.status(400).json({ error: "Missing required field: question" })
    return
  }

  const args = ["--import", "./register-ts-node.mjs", "src/ask.ts", question]

  if (body.limit) {
    args.push("--limit", String(body.limit))
  }

  if (body.repoName) {
    args.push("--repo-name", body.repoName)
  }

  if (body.branch) {
    args.push("--branch", body.branch)
  }

  if (body.serviceType) {
    args.push("--service-type", body.serviceType)
  }

  if (body.history && body.history.length > 0) {
    args.push("--history", JSON.stringify(body.history))
  }

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd: rootDir,
      timeout: 180_000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    })

    const output = [stdout, stderr].filter(Boolean).join("\n")
    const result = parseAskOutput(output)

    response.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const stdout = (error as { stdout?: string }).stdout ?? ""
    const stderr = (error as { stderr?: string }).stderr ?? ""

    console.error("Ask process failed:", message)

    response.status(500).json({
      error: message,
      raw: [stdout, stderr].filter(Boolean).join("\n"),
    })
  }
})

app.get("/api/health", (_request, response) => {
  response.json({ status: "ok" })
})

const port = Number(process.env.PORT ?? 3456)

app.listen(port, () => {
  console.log(`Local Codebase AI server running at http://localhost:${port}`)
})
