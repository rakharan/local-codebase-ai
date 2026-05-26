export const config = {
  qdrantUrl: process.env.QDRANT_URL ?? "http://localhost:6333",
  ollamaUrl: process.env.OLLAMA_URL ?? "http://localhost:11434",
  collectionName: process.env.QDRANT_COLLECTION ?? "code_chunks",

  embeddingModel: process.env.EMBEDDING_MODEL ?? "nomic-embed-text",
  chatModel: process.env.CHAT_MODEL ?? "qwen2.5-coder:3b",

  vectorSize: Number(process.env.VECTOR_SIZE ?? 768),
}