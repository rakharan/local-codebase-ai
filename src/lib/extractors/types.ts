export type DecisionType = "decision" | "implicit_rule"

export type DraftSource = "brain_dump" | "jira" | "debug_discovery"

export type ExtractedDecision = {
  decision: string
  context: string | null
  rationale: string | null
  alternatives_rejected: string | null
  affected_services: string[]
  affected_tables: string[]
  decision_maker: string | null
  open_questions: string[]
  type: DecisionType
}

export type KnowledgeContext = {
  serviceNames: string[]
  tableNames: string[]
}
