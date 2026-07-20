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

type OpenAIChatResponse = {
    choices?: Array<{
        message?: {
            content?: string
        }
    }>
}

type AnthropicChatResponse = {
    content?: Array<{
        type: string
        text?: string
    }>
}

export type AnswerLanguage = "id" | "en" | "unknown"

// Cloud models have smaller context windows than local Ollama.
// Truncate prompts that exceed this limit to avoid 400 errors.
const MAX_CLOUD_PROMPT_CHARS = config.maxCloudPromptChars

const MAX_ATTEMPTS = config.chatMaxAttempts
const MAX_EMBED_INPUT_CHARS = 3_500

const SYSTEM_PROMPT = [
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
].join("\n")

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

// Returns true if Anthropic API should be used (only when no OpenAI-compat config present)
function isAnthropicCompatible(): boolean {
    // If OpenAI-compatible base URL is set alongside OpenAI key, prefer that path
    if (config.openAIApiKey && config.openAIBaseUrl) return false
    return Boolean(config.anthropicApiKey)
}

// Returns true if the chat model should use OpenAI-compatible API
function isOpenAICompatible(): boolean {
    return Boolean(config.openAIApiKey) || Boolean(config.groqApiKey) || Boolean(config.geminiApiKey)
}

function getOpenAIBaseUrl(): string {
    if (config.geminiApiKey) return "https://generativelanguage.googleapis.com/v1beta/openai"
    if (config.groqApiKey) return "https://api.groq.com/openai/v1"
    return config.openAIBaseUrl ?? "https://api.openai.com/v1"
}

function getOpenAIApiKey(): string {
    return config.geminiApiKey ?? config.groqApiKey ?? config.openAIApiKey ?? ""
}

async function chatAnthropic(system: string, userContent: string): Promise<string> {
    const baseUrl = config.anthropicBaseUrl.replace(/\/$/, "")
    // Truncate if exceeds cloud model context limit
    const truncatedContent = userContent.length > MAX_CLOUD_PROMPT_CHARS
        ? userContent.slice(0, MAX_CLOUD_PROMPT_CHARS) + "\n\n[...context truncated to fit model limit...]"
        : userContent
    const res = await fetchWithRetry(`${baseUrl}/messages`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": config.anthropicApiKey,
            "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
            model: config.chatModel,
            max_tokens: config.maxTokens,
            system,
            messages: [{ role: "user", content: truncatedContent }],
        }),
    })

    if (!res.ok) {
        throw new Error(`ANTHROPIC_CHAT_FAILED: ${res.status} ${await res.text()}`)
    }

    const data = (await res.json()) as AnthropicChatResponse
    return data.content?.find(b => b.type === "text")?.text?.trim() ?? ""
}

async function chatOpenAI(messages: Array<{ role: string; content: string }>, jsonMode = false): Promise<string> {
    const baseUrl = getOpenAIBaseUrl()
    const apiKey = getOpenAIApiKey()

    // Truncate user message if it exceeds cloud model context limits
    const truncatedMessages = messages.map(m => {
        if (m.role === "user" && m.content.length > MAX_CLOUD_PROMPT_CHARS) {
            return { ...m, content: m.content.slice(0, MAX_CLOUD_PROMPT_CHARS) + "\n\n[...context truncated to fit model limit...]" }
        }
        return m
    })

    const body: Record<string, unknown> = {
        model: config.chatModel,
        messages: truncatedMessages,
        max_tokens: config.maxTokens,
        stream: false,
    }

    if (jsonMode) {
        body.response_format = { type: "json_object" }
    }

    const res = await fetchWithRetry(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
    })

    if (!res.ok) {
        throw new Error(`OPENAI_CHAT_FAILED: ${res.status} ${await res.text()}`)
    }

    const data = (await res.json()) as OpenAIChatResponse
    return data.choices?.[0]?.message?.content?.trim() ?? ""
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
    const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
    ]

    if (isAnthropicCompatible()) {
        const raw = await chatAnthropic(SYSTEM_PROMPT, prompt)
        const notFoundIdx = raw.indexOf("NOT_FOUND_IN_INDEXED_CODEBASE")
        if (notFoundIdx >= 0) {
            return raw.slice(0, notFoundIdx + "NOT_FOUND_IN_INDEXED_CODEBASE".length).trim()
        }
        return raw
    }

    if (isOpenAICompatible()) {
        const raw = await chatOpenAI(messages)
        const notFoundIdx = raw.indexOf("NOT_FOUND_IN_INDEXED_CODEBASE")
        if (notFoundIdx >= 0) {
            return raw.slice(0, notFoundIdx + "NOT_FOUND_IN_INDEXED_CODEBASE".length).trim()
        }
        return raw
    }

    // Ollama path
    let res
    const isQwen3 = config.chatModel.startsWith("qwen3")

    try {
        res = await fetchWithRetry(`${config.ollamaUrl}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: config.chatModel,
                stream: false,
                options: { num_ctx: config.numCtx },
                messages: [
                    {
                        role: "system",
                        content: [isQwen3 ? "/no_think" : undefined, SYSTEM_PROMPT].filter(Boolean).join("\n"),
                    },
                    { role: "user", content: prompt },
                ],
            }),
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`Ollama is not reachable at ${config.ollamaUrl}. Start Ollama and run: ollama pull ${config.chatModel}\n${message}`)
    }

    if (!res.ok) throw new Error(`OLLAMA_CHAT_FAILED: ${res.status} ${await res.text()}`)

    const data = (await res.json()) as OllamaChatResponse
    const raw = data.message?.content ?? ""
    const cleaned = raw.replace(/<think>[\s\S]*?<\/think>\s*/g, "").replace(/^[\s\S]*?<\/think>\s*/g, "")
    const notFoundIdx = cleaned.indexOf("NOT_FOUND_IN_INDEXED_CODEBASE")
    if (notFoundIdx >= 0) {
        return cleaned.slice(0, notFoundIdx + "NOT_FOUND_IN_INDEXED_CODEBASE".length).trim()
    }
    return cleaned.trim()
}

export async function detectPreferredLanguage(input: string): Promise<AnswerLanguage> {
    const messages = [
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
        { role: "user", content: input },
    ]

    try {
        let content: string
        const langSystem = [
            "Detect the user's preferred answer language from the message.",
            "Return only compact JSON with this shape: {\"language\":\"id\"|\"en\"|\"unknown\"}.",
            "Use \"id\" for Bahasa Indonesia, Indonesian slang, or mixed Indonesian-English.",
            "Use \"en\" for English.",
            "Use \"unknown\" only when the language cannot be inferred.",
            "Do not translate. Do not answer the message.",
        ].join("\n")

        if (isAnthropicCompatible()) {
            content = await chatAnthropic(langSystem, input)
        } else if (isOpenAICompatible()) {
            content = await chatOpenAI(messages, true)
        } else {
            const res = await fetchWithRetry(`${config.ollamaUrl}/api/chat`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: config.chatModel,
                    stream: false,
                    format: "json",
                    options: { temperature: 0, num_predict: 32 },
                    messages,
                }),
            })
            if (!res.ok) return "unknown"
            const data = (await res.json()) as OllamaChatResponse
            content = data.message?.content ?? ""
        }

        const parsed = JSON.parse(content) as { language?: unknown }
        return parsed.language === "id" || parsed.language === "en" ? parsed.language : "unknown"
    } catch {
        return "unknown"
    }
}

export async function chatJson(systemPrompt: string, userPrompt: string): Promise<string> {
    const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
    ]

    if (isAnthropicCompatible()) {
        return await chatAnthropic(systemPrompt, userPrompt)
    }

    if (isOpenAICompatible()) {
        return await chatOpenAI(messages, true)
    }

    // Ollama path
    let res
    const isQwen3 = config.chatModel.startsWith("qwen3")

    try {
        res = await fetchWithRetry(`${config.ollamaUrl}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: config.chatModel,
                stream: false,
                format: "json",
                options: { temperature: 0, num_ctx: config.numCtx },
                messages: [
                    {
                        role: "system",
                        content: [isQwen3 ? "/no_think" : undefined, systemPrompt].filter(Boolean).join("\n"),
                    },
                    { role: "user", content: userPrompt },
                ],
            }),
        })
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`Ollama is not reachable at ${config.ollamaUrl}. Start Ollama and run: ollama pull ${config.chatModel}\n${message}`)
    }

    if (!res.ok) throw new Error(`OLLAMA_CHAT_FAILED: ${res.status} ${await res.text()}`)

    const data = (await res.json()) as OllamaChatResponse
    const raw = data.message?.content ?? ""
    return raw.replace(/<think>[\s\S]*?<\/think>\s*/g, "").replace(/^[\s\S]*?<\/think>\s*/g, "").trim()
}
