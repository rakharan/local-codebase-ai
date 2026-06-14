import { runExtraction } from "./shared.js"
import type { ExtractedDecision, KnowledgeContext } from "./types.js"

export type JiraCredentials = {
  baseUrl: string
  token: string
  email?: string
}

export type JiraIssue = {
  key: string
  summary: string
  description: string
  labels: string[]
  components: string[]
  reporter: string | null
  assignee: string | null
}

export const JIRA_SETUP_MESSAGE = [
  "Jira integration is not configured.",
  "Set the following environment variables to enable --jira:",
  "  JIRA_BASE_URL   e.g. https://your-org.atlassian.net",
  "  JIRA_TOKEN      a Jira API token",
  "  JIRA_EMAIL      (optional) account email for basic auth",
  "",
  "Without credentials you can still paste ticket content with: ask digest --jira-text \"<pasted text>\"",
].join("\n")

export function readJiraCredentials(env: NodeJS.ProcessEnv = process.env): JiraCredentials | null {
  const baseUrl = env.JIRA_BASE_URL?.trim()
  const token = env.JIRA_TOKEN?.trim()

  if (!baseUrl || !token) return null

  const credentials: JiraCredentials = { baseUrl: baseUrl.replace(/\/+$/, ""), token }
  const email = env.JIRA_EMAIL?.trim()
  if (email) {
    credentials.email = email
  }

  return credentials
}

// Atlassian Document Format adalah pohon node; ambil teksnya saja secara rekursif.
export function adfToText(node: unknown): string {
  if (!node || typeof node !== "object") return ""

  const record = node as Record<string, unknown>
  const parts: string[] = []

  if (typeof record.text === "string") {
    parts.push(record.text)
  }

  if (Array.isArray(record.content)) {
    const childText = record.content.map(child => adfToText(child)).filter(Boolean)

    if (record.type === "paragraph" || record.type === "heading" || record.type === "listItem") {
      parts.push(childText.join(""))
      parts.push("\n")
    } else {
      parts.push(childText.join(""))
    }
  }

  return parts.join("")
}

function descriptionToText(description: unknown): string {
  if (typeof description === "string") return description
  if (description && typeof description === "object") return adfToText(description).trim()

  return ""
}

export function mapJiraResponse(raw: unknown): JiraIssue {
  if (!raw || typeof raw !== "object") {
    throw new Error("JIRA_INVALID_RESPONSE: unexpected issue payload.")
  }

  const issue = raw as Record<string, unknown>
  const key = typeof issue.key === "string" ? issue.key : ""
  const fields = (issue.fields ?? {}) as Record<string, unknown>

  const labels = Array.isArray(fields.labels)
    ? fields.labels.filter((label): label is string => typeof label === "string")
    : []

  const components = Array.isArray(fields.components)
    ? fields.components
        .map(component => (component && typeof component === "object" ? (component as Record<string, unknown>).name : undefined))
        .filter((name): name is string => typeof name === "string")
    : []

  const reporter = fields.reporter && typeof fields.reporter === "object"
    ? ((fields.reporter as Record<string, unknown>).displayName as string | undefined) ?? null
    : null

  const assignee = fields.assignee && typeof fields.assignee === "object"
    ? ((fields.assignee as Record<string, unknown>).displayName as string | undefined) ?? null
    : null

  return {
    key,
    summary: typeof fields.summary === "string" ? fields.summary : "",
    description: descriptionToText(fields.description),
    labels,
    components,
    reporter,
    assignee,
  }
}

// Susun teks bebas dari tiket agar bisa dilewatkan ke prompt ekstraksi yang sama.
export function buildJiraInputText(issue: JiraIssue): string {
  return [
    `Jira ticket ${issue.key}`.trim(),
    `Title: ${issue.summary}`,
    issue.reporter ? `Reporter: ${issue.reporter}` : undefined,
    issue.assignee ? `Assignee: ${issue.assignee}` : undefined,
    issue.labels.length > 0 ? `Labels: ${issue.labels.join(", ")}` : undefined,
    issue.components.length > 0 ? `Components: ${issue.components.join(", ")}` : undefined,
    "",
    "Description:",
    issue.description || "(no description provided)",
  ].filter(value => value !== undefined).join("\n")
}

export async function fetchJiraIssue(ticketId: string, credentials: JiraCredentials): Promise<JiraIssue> {
  const cleanId = ticketId.trim()

  if (!cleanId) {
    throw new Error("JIRA_TICKET_ID_EMPTY: provide a ticket id such as TF-1234.")
  }

  const authHeader = credentials.email
    ? `Basic ${Buffer.from(`${credentials.email}:${credentials.token}`).toString("base64")}`
    : `Bearer ${credentials.token}`

  const url = `${credentials.baseUrl}/rest/api/3/issue/${encodeURIComponent(cleanId)}`
  let res

  try {
    res = await fetch(url, {
      headers: {
        Authorization: authHeader,
        Accept: "application/json",
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`JIRA_UNREACHABLE: could not reach ${credentials.baseUrl}.\n${message}`)
  }

  if (!res.ok) {
    throw new Error(`JIRA_FETCH_FAILED: ${res.status} ${await res.text()}`)
  }

  return mapJiraResponse(await res.json())
}

// Gabungkan service hasil ekstraksi dengan petunjuk dari label/komponen tiket.
function mergeServiceHints(decision: ExtractedDecision, issue: JiraIssue, context: KnowledgeContext): string[] {
  const knownLookup = new Map(context.serviceNames.map(name => [name.toLowerCase(), name]))
  const hints = [...issue.labels, ...issue.components]
    .map(value => knownLookup.get(value.trim().toLowerCase()))
    .filter((value): value is string => Boolean(value))

  return [...new Set([...decision.affected_services, ...hints])]
}

export async function extractJiraIssue(issue: JiraIssue, context: KnowledgeContext): Promise<ExtractedDecision> {
  const decision = await runExtraction(buildJiraInputText(issue), context)

  return {
    ...decision,
    affected_services: mergeServiceHints(decision, issue, context),
    decision_maker: decision.decision_maker ?? issue.reporter,
  }
}

export async function extractJiraTicket(ticketId: string, context: KnowledgeContext, credentials: JiraCredentials): Promise<ExtractedDecision> {
  const issue = await fetchJiraIssue(ticketId, credentials)

  return extractJiraIssue(issue, context)
}

export async function extractJiraText(text: string, context: KnowledgeContext): Promise<ExtractedDecision> {
  const trimmed = text.trim()

  if (trimmed.length === 0) {
    throw new Error("JIRA_TEXT_EMPTY: no pasted ticket content to digest.")
  }

  return runExtraction(trimmed, context)
}
