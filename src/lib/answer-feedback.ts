import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

export type AnswerFeedbackRating = "good" | "bad"

export type AnswerFeedback = {
  id: string
  rating: AnswerFeedbackRating
  question: string
  answer: string
  sources: string[]
  note: string
  createdAt: string
}

export type AnswerFeedbackInput = {
  rating?: string
  question?: string
  answer?: string
  sources?: string[]
  note?: string
}

const dataDir = path.join(process.cwd(), ".data")
const feedbackPath = path.join(dataDir, "answer-feedback.json")

function validateFeedbackInput(input: AnswerFeedbackInput): Omit<AnswerFeedback, "id" | "createdAt"> {
  const rating = input.rating === "good" || input.rating === "bad" ? input.rating : undefined
  const question = input.question?.trim()
  const answer = input.answer?.trim()

  if (!rating) throw new Error("Feedback rating must be good or bad")
  if (!question) throw new Error("Feedback question is required")
  if (!answer) throw new Error("Feedback answer is required")

  return {
    rating,
    question,
    answer,
    sources: Array.isArray(input.sources) ? input.sources.slice(0, 40) : [],
    note: input.note?.trim() ?? "",
  }
}

async function writeFeedback(items: AnswerFeedback[]): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true })
  const tempPath = `${feedbackPath}.tmp`

  await fs.writeFile(tempPath, `${JSON.stringify({ items }, null, 2)}\n`, "utf8")
  await fs.rename(tempPath, feedbackPath)
}

export async function readAnswerFeedback(): Promise<AnswerFeedback[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(feedbackPath, "utf8")) as { items?: AnswerFeedback[] }

    return Array.isArray(parsed.items)
      ? parsed.items.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      : []
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

export async function createAnswerFeedback(input: AnswerFeedbackInput): Promise<AnswerFeedback> {
  const values = validateFeedbackInput(input)
  const item: AnswerFeedback = {
    id: crypto.randomUUID(),
    ...values,
    createdAt: new Date().toISOString(),
  }
  const items = await readAnswerFeedback()

  await writeFeedback([item, ...items])

  return item
}
