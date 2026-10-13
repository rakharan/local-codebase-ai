/**
 * Meta-evaluation script: evaluates bad answers using an independent LLM model.
 * 
 * Usage:
 *   npm run eval:feedback              # evaluate all bad answers
 *   npm run eval:feedback -- --apply   # auto-create learning rules from suggestions
 * 
 * Requires: 9router running at localhost:20128
 * Uses EVAL_MODEL (default: prod/glm-5.2) as the evaluator.
 * Answer generator uses CHAT_MODEL (default: prod/glm-5.2).
 * Different models = no self-evaluation bias.
 */

import fs from "node:fs/promises"
import path from "node:path"
import { config } from "../src/lib/config.js"
import { createLearningRule, loadAllLearningRules, rollbackRule } from "../src/lib/learning-rules.js"
import { readAnswerFeedback } from "../src/lib/answer-feedback.js"

type EvalResult = {
  category: "RETRIEVAL_MISS" | "PROMPT_WEAKNESS" | "HALLUCINATION" | "AMBIGUOUS_QUESTION"
  severity: "high" | "medium" | "low"
  trigger: string
  directive: string
  rationale: string
}

const EVAL_SYSTEM_PROMPT = `You are a meta-evaluator for a codebase Q&A system. Your job is to analyze bad answers and identify the root cause, then suggest a correction.

Root cause categories:
- RETRIEVAL_MISS: relevant code was not retrieved from the vector DB
- PROMPT_WEAKNESS: retrieved code was correct but the LLM synthesized it poorly
- HALLUCINATION: answer contains facts not supported by the sources
- AMBIGUOUS_QUESTION: the question itself is unclear or ambiguous

Return ONLY valid JSON (no markdown, no explanation):
{"category":"...","severity":"high|medium|low","trigger":"keyword or pattern that should activate this rule","directive":"specific instruction to add to the LLM prompt","rationale":"why this correction is needed"}`

async function callEvalModel(userPrompt: string): Promise<string> {
  const baseUrl = config.anthropicBaseUrl.replace(/\/$/, "")
  const res = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.anthropicApiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.evalModel,
      max_tokens: 1024,
      system: EVAL_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
    signal: AbortSignal.timeout(120_000),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`EVAL_MODEL_FAILED: ${res.status} ${text}`)
  }

  const data = await res.json() as { content?: Array<{ type: string; text?: string }> }
  return data.content?.find(b => b.type === "text")?.text?.trim() ?? ""
}

function parseEvalResult(raw: string): EvalResult | null {
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return null
  try {
    const parsed = JSON.parse(jsonMatch[0])
    if (!parsed.category || !parsed.directive) return null
    return parsed as EvalResult
  } catch {
    return null
  }
}

async function reAskAndVerify(question: string, oldAnswer: string, ruleId: string): Promise<string> {
  const baseUrl = process.env.CODEBASE_AI_URL || "http://localhost:9191"
  const apiKey = process.env.APP_API_KEY ?? ""
  try {
    const res = await fetch(`${baseUrl}/api/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ question }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) return `skipped (server returned ${res.status})`
    const data = await res.json() as { answer?: string }
    const newAnswer = data.answer ?? ""

    if (newAnswer.trim() === oldAnswer.trim()) {
      return "no change — rule had no effect on answer"
    }

    // Ask eval model to compare
    const compareSystem = "You are a QA evaluator. Compare two answers to the same question. Return ONLY JSON: {\"improved\": true/false, \"reason\": \"brief\"}"
    const compareUser = `Question: ${question}\n\nOld answer (rated bad):\n${oldAnswer.slice(0, 1500)}\n\nNew answer (after correction rule):\n${newAnswer.slice(0, 1500)}\n\nIs the new answer better?`
    const raw = await callEvalModel(`${compareSystem}\n\n${compareUser}`)
    const match = raw.match(/\{[\s\S]*\}/)
    if (match) {
      const parsed = JSON.parse(match[0]) as { improved?: boolean; reason?: string }
      if (parsed.improved === false) {
        await rollbackRule(ruleId, "Regression check: new answer not improved")
        return `ROLLED_BACK — ${parsed.reason ?? "no improvement"}`
      }
      return `improved — ${parsed.reason ?? "yes"}`
    }
    return "inconclusive (could not parse eval)"
  } catch (err) {
    return `skipped (${err instanceof Error ? err.message.slice(0, 80) : "error"})`
  }
}

async function main(): Promise<number> {
  const applyRules = process.argv.includes("--apply")
  const feedback = await readAnswerFeedback()
  const badFeedback = feedback.filter(f => f.rating === "bad")

  if (badFeedback.length === 0) {
    console.log("No bad answers to evaluate.")
    return 0
  }

  console.log(`Found ${badFeedback.length} bad answer(s). Evaluating with ${config.evalModel}...\n`)
  const existingRules = await loadAllLearningRules()

  let evaluated = 0
  let rulesCreated = 0

  for (const item of badFeedback) {
    console.log(`\n━ ${item.id} ━`)
    console.log(`Q: ${item.question.slice(0, 80)}`)
    console.log(`A: ${item.answer.slice(0, 100)}...`)

    // Skip if already has an active rule whose trigger matches this question
    const hasRule = existingRules.some(r =>
      r.status === "active" && item.question.toLowerCase().includes(r.trigger.toLowerCase())
    )
    if (hasRule) {
      console.log("⏭  Already has a learning rule — skipping.")
      continue
    }

    const userPrompt = [
      `Question: ${item.question}`,
      "",
      "Answer provided:",
      item.answer.slice(0, 2000),
      "",
      "Sources retrieved:",
      (item.sources || []).slice(0, 10).join("\n"),
      "",
      item.note ? `User feedback note: ${item.note}` : "",
      "",
      "Analyze why this answer is wrong and suggest a prompt directive to prevent this error in future queries.",
    ].join("\n")

    try {
      const rawResult = await callEvalModel(userPrompt)
      const result = parseEvalResult(rawResult)

      if (!result) {
        console.log("⚠  Could not parse evaluation result.")
        console.log(`   Raw: ${rawResult.slice(0, 200)}`)
        continue
      }

      console.log(`\n  Category: ${result.category}`)
      console.log(`  Severity: ${result.severity}`)
      console.log(`  Trigger:  ${result.trigger}`)
      console.log(`  Rule:     ${result.directive}`)
      console.log(`  Why:      ${result.rationale}`)

      evaluated++

      if (applyRules) {
        // Choose rule type based on root cause category
        const ruleType: "prompt_directive" | "retrieval_boost" =
          result.category === "RETRIEVAL_MISS" ? "retrieval_boost" : "prompt_directive"

        // For retrieval_boost, the content should be search terms, not a prompt instruction
        const ruleContent = ruleType === "retrieval_boost"
          ? result.directive.replace(/^(focus on|search for|look for|retrieve)\s*/i, "").replace(/\s*(not|don't|avoid)\s+.*/i, "")
          : result.directive

        // Skip ambiguous questions — can't fix with a rule
        if (result.category === "AMBIGUOUS_QUESTION") {
          console.log("  ⏭  Ambiguous question — skipping rule creation.")
          continue
        }

        const rule = await createLearningRule({
          type: ruleType,
          trigger: result.trigger,
          content: ruleContent,
          rationale: result.rationale,
          source: "meta_eval",
        })
        console.log(`  ✓ Rule created: ${rule.id}`)
        rulesCreated++

        // Regression check: re-ask the question and verify the rule helped
        if (process.env.SKIP_REGRESSION !== "1") {
          const regStart = Date.now()
          const regResult = await reAskAndVerify(item.question, item.answer, rule.id)
          console.log(`  ⟳ Regression check (${Date.now() - regStart}ms): ${regResult}`)
          if (regResult.startsWith("ROLLED_BACK")) {
            console.log(`  ↩ Rule ${rule.id} auto-rolled back — made answer worse`)
          }
        }
      }
    } catch (err) {
      console.log(`  ✗ Evaluation failed: ${err instanceof Error ? err.message : err}`)
    }
  }

  console.log(`\n━━━ Summary ━━━`)
  console.log(`Evaluated: ${evaluated}/${badFeedback.length}`)
  if (applyRules) {
    console.log(`Rules created: ${rulesCreated}`)
    console.log(`\nRules are now active. Next query matching the trigger will include the correction.`)
    console.log(`To verify: run the same question through 'npm run ask -- \"<question>\"'`)
  } else {
    console.log(`\nDry run — no rules created. Run with --apply to create learning rules.`)
  }

  return 0
}

main().then(code => process.exit(code)).catch(err => {
  console.error(err)
  process.exit(1)
})
