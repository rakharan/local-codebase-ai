import { config } from "./config.js"

type OllamaEmbedResponse = {
    embeddings: number[][]
}

type OllamaChatResponse = {
    message?: {
        role: string
        content: string
    }
}

export type AnswerLanguage = "id" | "en" | "unknown"

const MAX_ATTEMPTS = 4
const MAX_EMBED_INPUT_CHARS = 3_500

function wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let lastError: unknown

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            return await fetch(url, init)
        } catch (error) {
            lastError = error

            if (attempt === MAX_ATTEMPTS) break

            await wait(1_000 * attempt)
        }
    }

    throw lastError
}

export async function createEmbedding(input: string): Promise<number[]> {
    let res
    const embeddingInput = input.length <= MAX_EMBED_INPUT_CHARS
        ? input
        : [
            input.slice(0, 2_300),
            "\n\n[...truncated for embedding...]\n\n",
            input.slice(-1_000),
        ].join("")

    try {
        res = await fetchWithRetry(`${config.ollamaUrl}/api/embed`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: config.embeddingModel,
                input: embeddingInput,
            }),
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        throw new Error(
            `Ollama is not reachable at ${config.ollamaUrl}. Start Ollama and run: ollama pull ${config.embeddingModel}\n${message}`,
        )
    }

    if (!res.ok) {
        throw new Error(`OLLAMA_EMBED_FAILED: ${res.status} ${await res.text()}`)
    }

    const data = (await res.json()) as OllamaEmbedResponse
    const embedding = data.embeddings?.[0]

    if (!embedding) {
        throw new Error("OLLAMA_EMBED_EMPTY_RESPONSE")
    }

    return embedding
}

export async function chat(prompt: string): Promise<string> {
    let res

    const isQwen3 = config.chatModel.startsWith("qwen3")

    try {
        res = await fetchWithRetry(`${config.ollamaUrl}/api/chat`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: config.chatModel,
                stream: false,
                options: {
                    num_ctx: config.numCtx,
                },
                messages: [
                    {
                        role: "system",
                        content: [
                            isQwen3 ? "/no_think" : undefined,
                            "You are an internal microservice codebase assistant.",
                            "Answer in the same language as the user question. If the question is in Bahasa Indonesia, answer in Bahasa Indonesia while preserving code identifiers exactly.",
                            "Answer only from the provided context.",
                            "If the context is insufficient, say NOT_FOUND_IN_INDEXED_CODEBASE.",
                            "Always mention service/repo name, source file paths, and line ranges.",
                            "Do not invent architecture.",
                            "Do not infer database table names, services, queues, or cross-service flows from domain words or naming conventions.",
                            "Only name database tables when they appear in metadata, SQL, or quoted source context.",
                            "Only claim service involvement when a repo appears in source metadata or an explicit source links the same route, message, RPC function, queue, or handler.",
                            "Avoid likely/probably/might for facts; say not confirmed in retrieved context.",
                            "When explaining cross-service flow, separate confirmed facts from guesses.",
                            "Prefer evidence from RabbitMQ handlers, API routes, cron jobs, database usage, and config files.",
                            "Only discuss cross-service flow, queues, jobs, or database tables when the question asks for them or the retrieved context clearly contains them.",
                            "For general summary questions, do not add cross-service, queue, database, deployment, or speculation sections.",
                        ].filter(Boolean).join("\n"),
                    },
                    {
                        role: "user",
                        content: prompt,
                    },
                ],
            }),
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        throw new Error(
            `Ollama is not reachable at ${config.ollamaUrl}. Start Ollama and run: ollama pull ${config.chatModel}\n${message}`,
        )
    }

    if (!res.ok) {
        throw new Error(`OLLAMA_CHAT_FAILED: ${res.status} ${await res.text()}`)
    }

    const data = (await res.json()) as OllamaChatResponse

    const raw = data.message?.content ?? ""
    // Strip qwen3 thinking blocks (complete or partial) and post-NOT_FOUND hallucination
    const cleaned = raw.replace(/<think>[\s\S]*?<\/think>\s*/g, "").replace(/^[\s\S]*?<\/think>\s*/g, "")
    // If NOT_FOUND is present, only keep text up to and including it
    const notFoundIdx = cleaned.indexOf("NOT_FOUND_IN_INDEXED_CODEBASE")
    if (notFoundIdx >= 0) {
      return cleaned.slice(0, notFoundIdx + "NOT_FOUND_IN_INDEXED_CODEBASE".length).trim()
    }
    return cleaned.trim()
}

export async function detectPreferredLanguage(input: string): Promise<AnswerLanguage> {
    let res

    try {
        res = await fetchWithRetry(`${config.ollamaUrl}/api/chat`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: config.chatModel,
                stream: false,
                format: "json",
                options: {
                    temperature: 0,
                    num_predict: 32,
                },
                messages: [
                    {
                        role: "system",
                        content: [
                            "Detect the user's preferred answer language from the message.",
                            "Return only compact JSON with this shape: {\"language\":\"id\"|\"en\"|\"unknown\"}.",
                            "Use \"id\" for Bahasa Indonesia, Indonesian slang, or mixed Indonesian-English.",
                            "Use \"en\" for English.",
                            "Use \"unknown\" only when the language cannot be inferred.",
                            "Do not translate. Do not answer the message.",
                        ].join("\n"),
                    },
                    {
                        role: "user",
                        content: input,
                    },
                ],
            }),
        })
    } catch {
        return "unknown"
    }

    if (!res.ok) return "unknown"

    try {
        const data = (await res.json()) as OllamaChatResponse
        const content = data.message?.content ?? ""
        const parsed = JSON.parse(content) as { language?: unknown }

        return parsed.language === "id" || parsed.language === "en" ? parsed.language : "unknown"
    } catch {
        return "unknown"
    }
}

export async function chatJson(systemPrompt: string, userPrompt: string): Promise<string> {
    let res

    const isQwen3 = config.chatModel.startsWith("qwen3")
    const systemContent = [
        isQwen3 ? "/no_think" : undefined,
        systemPrompt,
    ].filter(Boolean).join("\n")

    try {
        res = await fetchWithRetry(`${config.ollamaUrl}/api/chat`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: config.chatModel,
                stream: false,
                format: "json",
                options: {
                    temperature: 0,
                    num_ctx: config.numCtx,
                },
                messages: [
                    {
                        role: "system",
                        content: systemContent,
                    },
                    {
                        role: "user",
                        content: userPrompt,
                    },
                ],
            }),
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)

        throw new Error(
            `Ollama is not reachable at ${config.ollamaUrl}. Start Ollama and run: ollama pull ${config.chatModel}\n${message}`,
        )
    }

    if (!res.ok) {
        throw new Error(`OLLAMA_CHAT_FAILED: ${res.status} ${await res.text()}`)
    }

    const data = (await res.json()) as OllamaChatResponse
    const raw = data.message?.content ?? ""

    // Buang blok berpikir qwen3 agar parser JSON tidak menerima teks tambahan.
    return raw.replace(/<think>[\s\S]*?<\/think>\s*/g, "").replace(/^[\s\S]*?<\/think>\s*/g, "").trim()
}
