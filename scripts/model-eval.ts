#!/usr/bin/env node
import fs from "node:fs/promises"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

type ModelEvalResult = {
  model: string
  ok: boolean
  durationMs: number
  passedCases?: number
  outputTail: string
}

function parseModels(): string[] {
  const argIndex = process.argv.findIndex(arg => arg === "--models")
  const raw = argIndex >= 0 ? process.argv[argIndex + 1] : undefined
  const models = (raw ?? "qwen2.5-coder:3b,qwen3:8b")
    .split(",")
    .map(model => model.trim())
    .filter(Boolean)

  return [...new Set(models)]
}

function outputTail(output: string): string {
  return output
    .split(/\r?\n/)
    .slice(-40)
    .join("\n")
    .trim()
}

function parsePassedCases(output: string): number | undefined {
  const match = output.match(/All\s+(\d+)\s+answer regression cases passed/i)
  return match ? Number(match[1]) : undefined
}

async function runForModel(model: string): Promise<ModelEvalResult> {
  const startedAt = Date.now()

  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "./register-ts-node.mjs", "src/answer-regression.ts", "--chat-model", model],
      {
        cwd: process.cwd(),
        timeout: 900_000,
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          CHAT_MODEL: model,
        },
      },
    )
    const output = [stdout, stderr].filter(Boolean).join("\n")

    return {
      model,
      ok: true,
      durationMs: Date.now() - startedAt,
      ...(() => {
        const passedCases = parsePassedCases(output)
        return passedCases === undefined ? {} : { passedCases }
      })(),
      outputTail: outputTail(output),
    }
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout ?? ""
    const stderr = (error as { stderr?: string }).stderr ?? ""
    const output = [stdout, stderr, error instanceof Error ? error.message : String(error)]
      .filter(Boolean)
      .join("\n")

    return {
      model,
      ok: false,
      durationMs: Date.now() - startedAt,
      outputTail: outputTail(output),
    }
  }
}

async function main(): Promise<void> {
  const models = parseModels()
  const results: ModelEvalResult[] = []

  console.log(`Running answer regression against ${models.length} model(s): ${models.join(", ")}`)

  for (const model of models) {
    process.stdout.write(`\n${model}... `)
    const result = await runForModel(model)
    results.push(result)
    console.log(result.ok ? `ok (${Math.round(result.durationMs / 1000)}s)` : `failed (${Math.round(result.durationMs / 1000)}s)`)
  }

  await fs.mkdir(path.resolve(".data"), { recursive: true })
  const reportPath = path.resolve(".data", "model-eval.json")
  await fs.writeFile(reportPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    models,
    results,
  }, null, 2), "utf8")

  console.log(`\nSaved report: ${reportPath}`)
  for (const result of results) {
    console.log(`- ${result.model}: ${result.ok ? "PASS" : "FAIL"}${result.passedCases ? ` (${result.passedCases} cases)` : ""}`)
  }

  if (results.some(result => !result.ok)) {
    process.exitCode = 1
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
