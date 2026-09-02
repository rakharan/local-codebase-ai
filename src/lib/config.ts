export const config = {
  qdrantUrl: process.env.QDRANT_URL ?? "http://localhost:6333",
  ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
  collectionName: process.env.QDRANT_COLLECTION ?? "code_chunks",

  embeddingModel: process.env.EMBEDDING_MODEL ?? "nomic-embed-text",
  chatModel: process.env.CHAT_MODEL ?? "qwen2.5-coder:3b",

  vectorSize: Number(process.env.VECTOR_SIZE ?? 768),

  // Cap context window sent to Ollama. Lower = faster on CPU. Default 8192 is a good
  // balance; drop to 4096 if inference is too slow. Raise to 16384 for deep mode.
  numCtx: Number(process.env.OLLAMA_NUM_CTX ?? 8192),

  // Cloud inference — set any one of these to use instead of local Ollama for chat.
  // Embeddings always use local Ollama regardless.
  // Gemini:    set GEMINI_API_KEY + CHAT_MODEL=gemini-2.0-flash
  // Groq:      set GROQ_API_KEY   + CHAT_MODEL=llama-3.1-8b-instant
  // OpenAI:    set OPENAI_API_KEY + CHAT_MODEL=gpt-4o-mini
  // Anthropic: set ANTHROPIC_API_KEY + CHAT_MODEL=claude-opus-4-8 (or kiro-fallback for 9router)
  // 9router:   set ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL=http://localhost:20128/v1 + CHAT_MODEL=kiro-fallback
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  groqApiKey: process.env.GROQ_API_KEY ?? "",
  openAIApiKey: process.env.OPENAI_API_KEY ?? "",
  openAIBaseUrl: process.env.OPENAI_BASE_URL ?? "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",

  // Max tokens in LLM response. Default 2048 is fine for most answers.
  maxTokens: Number(process.env.MAX_TOKENS ?? 2048),
  deepMaxTokens: Number(process.env.DEEP_MAX_TOKENS ?? 4096),

  // Quality gate threshold. Answers scoring below this trigger retry.
  qualityThreshold: Number(process.env.QUALITY_THRESHOLD ?? 0.5),

  // Enable/disable quality gate retry. Set to "false" to disable.
  qualityRetryEnabled: process.env.QUALITY_RETRY !== "false",

  // BM25 in-process index TTL. When this elapses, getBM25Index re-validates
  // against Qdrant point count and reloads from disk only if data changed.
  // Default 60 min balances freshness with avoiding repeated disk JSON parses.
  bm25IndexTtlMs: Number(process.env.BM25_INDEX_TTL_MS ?? 60 * 60 * 1000),

  // BM25 cross-process build lock wait timeout. When another process is
  // cold-building the index, others wait this long for the cache to appear
  // before stealing the lock and building themselves. Default 5 min covers
  // the slowest expected cold build. Set lower (e.g. 10000) in test runners
  // to fail-fast instead of hanging on a contended build.
  bm25WaitTimeoutMs: Number(process.env.BM25_WAIT_TIMEOUT_MS ?? 5 * 60 * 1000),

  // Concurrency for embedding + upsert during indexing. Each task hits Ollama
  // (embedding) and Qdrant (upsert). Local Ollama on CPU is largely serial, so
  // keep this modest. Raise only on GPU/remote Ollama.
  indexConcurrency: Number(process.env.INDEX_CONCURRENCY ?? 4),

  // Chunker tuning. Changing these after indexing affects NEW chunks only —
  // existing indexed chunks keep their original boundaries until reindexed.
  chunkMinLines: Number(process.env.CHUNK_MIN_LINES ?? 5),
  chunkMaxLines: Number(process.env.CHUNK_MAX_LINES ?? 120),
  chunkMinChars: Number(process.env.CHUNK_MIN_CHARS ?? 100),
  chunkMaxChars: Number(process.env.CHUNK_MAX_CHARS ?? 2_000),
  chunkOverlapLines: Number(process.env.CHUNK_OVERLAP_LINES ?? 3),

  // LLM call tuning.
  maxCloudPromptChars: Number(process.env.MAX_CLOUD_PROMPT_CHARS ?? 60_000),
  chatMaxAttempts: Number(process.env.CHAT_MAX_ATTEMPTS ?? 4),

  // Documentation chunking.
  maxDocChunkChars: Number(process.env.MAX_DOC_CHUNK_CHARS ?? 1_500),

  // Self-learning: meta-evaluator model (must differ from chatModel to avoid self-eval bias).
  // Uses the same 9router/cloud provider as chat. Default: prod/claude-sonnet-5.
  evalModel: process.env.EVAL_MODEL ?? "prod/glm-5.2",

  // Self-learning: path to learning rules JSON file. Rules are injected into
  // the LLM prompt to correct systematic answer errors.
  learningRulesPath: process.env.LEARNING_RULES_PATH ?? ".data/learning-rules.json",
}

export function setChatModel(model: string): void {
  const trimmed = model.trim()
  if (!trimmed) {
    throw new Error("CHAT_MODEL_OVERRIDE_EMPTY")
  }

  config.chatModel = trimmed
}
