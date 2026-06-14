import type { DraftSource, ExtractedDecision } from "./extractors/types.js"

export type AdrMetadata = {
  date: string
  source: DraftSource
  discoveredIn?: string | null
}

const UNKNOWN_MARKER = "⚠️  unknown — not mentioned in input"

function frontmatterList(values: string[]): string {
  return values.join(", ")
}

function bodyOrUnknown(value: string | null): string {
  return value ?? UNKNOWN_MARKER
}

function renderOpenQuestions(openQuestions: string[]): string {
  if (openQuestions.length === 0) {
    return "- (none identified — confirm nothing was missed)"
  }

  return openQuestions.map(question => `- ${question}`).join("\n")
}

// Setiap field yang kosong/null wajib muncul sebagai item checklist agar gap terlihat saat review.
function renderReviewNotes(decision: ExtractedDecision, meta: AdrMetadata): string {
  const items: string[] = []

  if (!decision.context) items.push("[ ] Add the missing context")
  if (decision.type === "decision" && !decision.rationale) items.push("[ ] Fill in the rationale (why this choice)")
  if (decision.type === "decision" && !decision.alternatives_rejected) items.push("[ ] Note alternatives that were rejected")
  if (!decision.decision_maker) items.push("[ ] Confirm the decision maker")
  if (decision.affected_services.length === 0) items.push("[ ] Confirm which services are affected")
  if (decision.type === "decision" && decision.affected_tables.length === 0) items.push("[ ] Confirm which tables are affected")
  if (decision.type === "implicit_rule" && !meta.discoveredIn) items.push("[ ] Confirm where this rule lives (file:line)")

  for (const question of decision.open_questions) {
    items.push(`[ ] Resolve open question: ${question}`)
  }

  if (items.length === 0) {
    items.push("[ ] Verify all extracted details against the source")
  }

  return items.join("\n")
}

export function renderAdr(decision: ExtractedDecision, meta: AdrMetadata): string {
  return [
    "---",
    `date: ${meta.date}`,
    "status: draft",
    `decision_maker: ${decision.decision_maker ?? "unknown"}`,
    `affected_services: [${frontmatterList(decision.affected_services)}]`,
    `affected_tables: [${frontmatterList(decision.affected_tables)}]`,
    `source: ${meta.source}`,
    "---",
    "",
    `# ADR: ${decision.decision}`,
    "",
    "## Decision",
    decision.decision,
    "",
    "## Context",
    bodyOrUnknown(decision.context),
    "",
    "## Rationale",
    bodyOrUnknown(decision.rationale),
    "",
    "## Alternatives rejected",
    bodyOrUnknown(decision.alternatives_rejected),
    "",
    "## Open questions",
    renderOpenQuestions(decision.open_questions),
    "",
    "## Review notes",
    renderReviewNotes(decision, meta),
    "",
  ].join("\n")
}

export function renderImplicitRule(decision: ExtractedDecision, meta: AdrMetadata): string {
  const whatItDoes = decision.context
    ? `${decision.decision}\n\n${decision.context}`
    : decision.decision

  return [
    "---",
    `date: ${meta.date}`,
    "status: draft",
    "type: implicit_rule",
    `discovered_in: ${meta.discoveredIn ?? "unknown"}`,
    `affected_services: [${frontmatterList(decision.affected_services)}]`,
    `source: ${meta.source}`,
    "---",
    "",
    `# Implicit Rule: ${decision.decision}`,
    "",
    "## What it does",
    whatItDoes,
    "",
    "## Where it lives",
    meta.discoveredIn ?? UNKNOWN_MARKER,
    "",
    "## Risk",
    bodyOrUnknown(decision.rationale),
    "",
    "## Review notes",
    renderReviewNotes(decision, meta),
    "",
  ].join("\n")
}

export function renderDraft(decision: ExtractedDecision, meta: AdrMetadata): string {
  return decision.type === "implicit_rule"
    ? renderImplicitRule(decision, meta)
    : renderAdr(decision, meta)
}

// Slug = lima kata pertama dari decision, di-kebab-case, untuk nama file draft.
export function slugFromDecision(decision: string): string {
  const slug = decision
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join("-")

  return slug || "decision"
}

export function draftFileName(date: string, decision: string): string {
  return `draft-${date}-${slugFromDecision(decision)}.md`
}
