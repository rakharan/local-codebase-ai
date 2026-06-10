export const config = {
  qdrantUrl: process.env.QDRANT_URL ?? "http://localhost:6333",
  ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
  collectionName: process.env.QDRANT_COLLECTION ?? "code_chunks",

  embeddingModel: process.env.EMBEDDING_MODEL ?? "nomic-embed-text",
  chatModel: process.env.CHAT_MODEL ?? "qwen3:8b",

  vectorSize: Number(process.env.VECTOR_SIZE ?? 768),

  // Cap context window sent to Ollama. Lower = faster on CPU. Default 8192 is a good
  // balance; drop to 4096 if inference is too slow. Raise to 16384 for deep mode.
  numCtx: Number(process.env.OLLAMA_NUM_CTX ?? 8192),
}

export function setChatModel(model: string): void {
  const trimmed = model.trim()
  if (!trimmed) {
    throw new Error("CHAT_MODEL_OVERRIDE_EMPTY")
  }

  config.chatModel = trimmed
}
