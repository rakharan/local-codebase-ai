# AGENTS.md

Architecture and contributing guide for this RAG system.

## Architecture

```
Source repos ──> Doctor extractors ──> Chunker ──> Ollama embeddings ──> Qdrant
                                                                        │
                                                                 BM25 index
                                                                 Graph edges
                                                                        │
                                                              BGE reranker (top-20)
                                                                        │
                                                              LLM synthesis
                                                                        │
                                                              Quality gate (eval + retry)
                                                                        │
                                                                    Answer
```

- **Vector store**: Qdrant (collection `code_chunks`)
- **Keyword search**: BM25 in-process index (cached to `.data/bm25-index.json`, TTL-based rebuild)
- **Graph**: relationship edges (`CALLS_HTTP_ENDPOINT`, `TOUCHES_TABLE`, etc.) in `.data/relationships.jsonl`
- **Reranker**: BGE neural cross-encoder via Ollama (`qllama/bge-reranker-v2-m3`)
- **Chat**: cloud LLM via Anthropic/OpenAI/Gemini/9router — embeddings always local Ollama

## Code Conventions

- **Runtime**: `npx tsx` (no build step, TypeScript runs directly)
- **Node**: ≥18 required (global Web Streams API for `undici`)
- **Module split pattern**: large files split into `src/<feature>/*.ts` with a `ctx.ts` singleton for shared state (see `src/ask/`)
- **Zero-dep MCP**: `mcp-server.mjs` uses only Node stdlib + global `fetch`
- **Config externalization**: all tunable constants in `src/lib/config.ts`, env-overridable, documented in `.env.example`
- **No comments** unless explaining non-obvious intent

## Adding Features

### New doctor extractor
1. Create `src/doctor/extractors/<name>-extractor.ts` — export `extract<X>(files): Fact[]`
2. Create `src/doctor/generators/<name>-generator.ts` — export `generate<X>(facts): string`
3. Register in `src/doctor/doctor.ts`
4. Add test in `src/doctor/test/`

### New answer type
1. Add detection in `src/ask/question.ts`
2. Add retrieval logic in `src/ask/retrieve.ts` or `src/ask/specialized-answers.ts`
3. Wire into `src/ask.ts` main flow

### New API endpoint
1. Add route in `src/server.ts`
2. Add logic in `src/lib/` or `src/commands/`
3. Export in `.env.example` if it needs config

### New learning rule type
1. Add type to `src/lib/learning-rules.ts` `LearningRuleType`
2. Handle in `formatRulesForPrompt()` (for prompt injection) or `ask.ts` retrieval section
3. Add to `mcp-server.mjs` enum
4. Document in skill files

## Debugging

- **Enable debug logging**: `DEBUG=true` env var — prints stage timings, LLM calls, retrieval counts
- **BM25 cache**: `.data/bm25-index.json` — delete to force cold rebuild
- **Qdrant inspect**: `GET http://localhost:6333/collections/code_chunks/points/scroll` with filter body
- **Quality log**: `.data/answer-quality.jsonl` — per-answer scores (groundedness, relevance, completeness, faithfulness)
- **Critical answers**: `.data/critical-quality.jsonl` — answers scoring <0.3 after retry (picked up by eval-feedback cron)

## Testing

- **Doctor tests**: `npm run test:doctor` — extractor + generator unit tests
- **Answer regression**: `npm run test:answers` — smoke suite, checks evidence strings in answers
- **Full regression**: `npm run test:answers:full` — complete suite (slower)
- **Language tests**: `npm run test:language`
- **API regression**: `npm run test:api`
- **Model comparison**: `npm run eval:models` — compares answer quality across models

## Config Pattern

All tunable values live in `src/lib/config.ts` with env var fallbacks:

```typescript
export const config = {
  qdrantUrl: process.env.QDRANT_URL ?? "http://localhost:6333",
  evalModel: process.env.EVAL_MODEL ?? "prod/glm-5.3",
  // ... see .env.example for full list
}
```

When adding new config:
1. Add to `config.ts` with `process.env.X ?? "default"`
2. Document in `.env.example`
3. Use `config.x` everywhere — never hardcode

## Pipeline Stages

1. **Index**: `npm run index -- <path> --repo-name <name>` — chunks + embeds + upserts to Qdrant
2. **Doctor**: `npm run doctor -- <path> --output <dir>` — static analysis, generates structured docs
3. **Ask**: `POST /api/ask` or `npm run ask -- "<question>"` — retrieval + synthesis + quality gate
4. **Feedback**: `POST /api/feedback` — thumbs up/down stored for meta-evaluation
5. **Eval**: `npm run eval:feedback -- --apply` — evaluates bad answers, creates learning rules, regression-checks
