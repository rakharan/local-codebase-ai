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

const MAX_ATTEMPTS = 4

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

    try {
        res = await fetchWithRetry(`${config.ollamaUrl}/api/embed`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: config.embeddingModel,
                input,
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

    try {
        res = await fetchWithRetry(`${config.ollamaUrl}/api/chat`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: config.chatModel,
                stream: false,
                messages: [
                    {
                        role: "system",
                        content: [
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
                        ].join("\n"),
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

    return data.message?.content ?? ""
}
