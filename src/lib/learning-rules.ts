import fs from "node:fs/promises"
import path from "node:path"
import { config } from "./config.js"

export type LearningRuleType = "prompt_directive" | "retrieval_boost" | "query_rewrite"

export type LearningRule = {
  id: string
  type: LearningRuleType
  trigger: string
  content: string
  rationale: string
  source: "manual" | "meta_eval" | "feedback"
  status: "active" | "rolled_back"
  createdAt: string
  appliedAt: string | null
  rolledBackAt: string | null
  rollbackReason: string | null
}

const dataDir = path.join(process.cwd(), ".data")

export async function loadActiveLearningRules(): Promise<LearningRule[]> {
  const rulesPath = path.join(process.cwd(), config.learningRulesPath)
  try {
    const raw = await fs.readFile(rulesPath, "utf8")
    const parsed = JSON.parse(raw) as { rules?: LearningRule[] }
    return (parsed.rules ?? []).filter(r => r.status === "active")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
    console.error("Failed to load learning rules:", err instanceof Error ? err.message : err)
    return []
  }
}

export async function loadAllLearningRules(): Promise<LearningRule[]> {
  const rulesPath = path.join(process.cwd(), config.learningRulesPath)
  try {
    const raw = await fs.readFile(rulesPath, "utf8")
    const parsed = JSON.parse(raw) as { rules?: LearningRule[] }
    return parsed.rules ?? []
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
    throw err
  }
}

export async function saveLearningRules(rules: LearningRule[]): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true })
  const rulesPath = path.join(process.cwd(), config.learningRulesPath)
  const tempPath = `${rulesPath}.tmp`
  await fs.writeFile(tempPath, JSON.stringify({ rules }, null, 2) + "\n", "utf8")
  await fs.rename(tempPath, rulesPath)
}

export async function createLearningRule(input: {
  type: LearningRuleType
  trigger: string
  content: string
  rationale: string
  source?: "manual" | "meta_eval" | "feedback"
}): Promise<LearningRule> {
  const rules = await loadAllLearningRules()
  const now = new Date().toISOString()
  const rule: LearningRule = {
    id: `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    type: input.type,
    trigger: input.trigger,
    content: input.content,
    rationale: input.rationale,
    source: input.source ?? "manual",
    status: "active",
    createdAt: now,
    appliedAt: null,
    rolledBackAt: null,
    rollbackReason: null,
  }
  rules.push(rule)
  await saveLearningRules(rules)
  return rule
}

export async function rollbackRule(ruleId: string, reason: string): Promise<boolean> {
  const rules = await loadAllLearningRules()
  const rule = rules.find(r => r.id === ruleId)
  if (!rule) return false
  rule.status = "rolled_back"
  rule.rolledBackAt = new Date().toISOString()
  rule.rollbackReason = reason
  await saveLearningRules(rules)
  return true
}

export function formatRulesForPrompt(rules: LearningRule[]): string {
  if (rules.length === 0) return ""
  const directives = rules.filter(r => r.type === "prompt_directive")
  if (directives.length === 0) return ""
  const lines = directives.map(r => `- When the question matches "${r.trigger}": ${r.content}`)
  return `\nActive learning rules (corrections from past feedback):\n${lines.join("\n")}\n`
}
