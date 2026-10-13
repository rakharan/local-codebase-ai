# Local Codebase AI

Local-first RAG system for asking questions across multiple codebases. Indexes source code and documentation, retrieves via hybrid BM25 + vector + graph search, reranks with a neural cross-encoder, and synthesizes grounded answers with a cloud LLM. Includes a self-learning feedback loop that corrects future queries from past mistakes.

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

## Features

- **Hybrid retrieval**: BM25 keyword + Qdrant vector + relationship graph — merged and deduplicated
- **Neural reranker**: BGE cross-encoder (`bge-reranker-v2-m3`) re-scores top-20 chunks for precision
- **Repo Doctor**: static analysis extractor — routes, DB tables, RabbitMQ queues, crons, env configs, architecture diagrams. No LLM needed.
- **Quality gate**: independent eval model scores answers on groundedness, relevance, completeness, faithfulness. Auto-retries low-scoring answers.
- **Self-learning**: thumbs up/down feedback → meta-evaluation → learning rules (prompt directives, retrieval boosts, query rewrites). Rules persist and auto-apply to matching future queries.
- **MCP server**: zero-dependency bridge for AI agents (Hermes, Claude Desktop, etc.) — tools: `ask_codebase`, `get_index_summary`, `create_learning_rule`, `list_learning_rules`, `rollback_learning_rule`
- **Multi-language**: auto-detects answer language (English, Indonesian, etc.) — retrieval and sources stay in original code language
- **Domain vocabulary**: `config/services.json` maps product names to source identifiers for disambiguation
- **DB Schema Explorer**: browse database tables, columns, and relationships in the web UI
- **Web UI**: chat interface with source citations, feedback buttons, index manager, graph visualization

## Quick Start

```bash
git clone <repo-url>
cd local-codebase-ai
npm install

# Start Qdrant
docker compose up -d

# Pull embedding model
ollama pull nomic-embed-text

# Configure environment
cp .env.example .env
# Edit .env — set chat provider (9router, Anthropic, OpenAI, Gemini, Groq, or local Ollama)

# Start server
npm run start
```

Open `http://localhost:9191`.

## Requirements

- **Node.js** ≥18 (global Web Streams API required by `undici`)
- **Qdrant** — via `docker compose up -d` (or remote instance)
- **Ollama** — for local embeddings (`nomic-embed-text`, 768-dim). Always required regardless of chat provider.
- **Chat LLM** — one of:
  - 9router (local proxy, recommended — routes to best available model)
  - Anthropic API (direct or via proxy)
  - OpenAI API
  - Google Gemini API
  - Groq API
  - Local Ollama model (slow on CPU)

## Configuration

All config is env-driven. See `.env.example` for the full list.

| Variable | Default | Description |
|---|---|---|
| `QDRANT_URL` | `http://localhost:6333` | Qdrant endpoint |
| `QDRANT_COLLECTION` | `code_chunks` | Collection name |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama endpoint (embeddings) |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Embedding model |
| `VECTOR_SIZE` | `768` | Embedding dimensions |
| `CHAT_MODEL` | `qwen2.5-coder:3b` | Chat/LLM model (or cloud model ID) |
| `EVAL_MODEL` | `prod/glm-5.3` | Quality gate evaluator model (should differ from chat model) |
| `PORT` | `9191` | Server port |
| `REPOS_DIR` | `C:/GIT/work` | Base dir for audit scripts |
| `DOCS_DIR` | `C:/GIT/work/tf-documentation/my-website/docs` | Docs dir for audit scripts |
| `QUALITY_THRESHOLD` | `0.5` | Min quality score before retry |
| `QUALITY_RETRY` | `true` | Enable quality gate retry |
| `RERANKER_MODEL` | `qllama/bge-reranker-v2-m3` | Neural reranker model |
| `RERANKER_TOP_N` | `20` | Chunks to rerank |
| `APP_API_KEY` | _(unset)_ | API key for server auth |

## Usage

### Index a repo

```bash
npm run index -- ../my-service --repo-name my-service --service-type api
```

Supported service types: `api`, `worker`, `cron`, `library`, `unknown`.

### Index documentation

```bash
npm run index-docs -- ../docs-site/docs --repo-name docs
```

### Ask questions

```bash
npm run ask -- "How does the payment flow work?"
npm run ask -- "Which services touch the users table?" --repo-name my-service
npm run ask -- "What handles /api/v1/users?" --deep
```

### Web UI

```bash
npm run start
```

- Chat with source citations
- Thumbs up/down feedback
- Index manager panel
- DB Schema Explorer
- Graph visualization

### API

```bash
curl -X POST http://localhost:9191/api/ask \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $APP_API_KEY" \
  -d '{"question": "How does deposit flow work?"}'
```

### Repo Doctor

```bash
npm run doctor -- ../my-service --output ./repo-docs --json
npm run index-doctor -- ./repo-docs --repo-name my-service
```

Generates structured Markdown: overview, services, env, config, API routes, RabbitMQ, database, architecture diagrams.

## Advanced

### Learning Rules

When an answer is wrong, create a learning rule that corrects future queries:

- `prompt_directive` — tells the LLM what to focus on or avoid
- `retrieval_boost` — adds extra search terms to BM25 query
- `query_rewrite` — replaces the entire retrieval query with a better one

Rules match by trigger keyword and auto-apply to all future questions containing that keyword. Old rules with the same trigger+type are auto-deactivated when a new one is created.

```bash
curl -X POST http://localhost:9191/api/learning/rules \
  -H "Content-Type: application/json" \
  -d '{"type": "prompt_directive", "trigger": "deposit flow", "content": "Focus on MT4/MT5 fund deposit process.", "rationale": "Was returning subscription payment flow instead."}'
```

### Meta-Evaluation

```bash
npm run eval:feedback -- --apply
```

Evaluates bad feedback with the eval model, categorizes root cause (retrieval miss, prompt weakness, hallucination, ambiguous question), creates the appropriate rule type, re-asks the question to verify improvement, and auto-rolls back rules that made things worse.

### MCP Server

```bash
node mcp-server.mjs
```

Exposes 5 tools for AI agents. Register in Hermes/Claude config:

```json
{
  "mcpServers": {
    "codebase-rag": {
      "command": "node",
      "args": ["mcp-server.mjs"]
    }
  }
}
```

## Project Structure

```
src/
├── ask.ts              # Main retrieval + synthesis pipeline (7100+ lines)
├── ask/                # Split modules (question detection, retrieve, rerank, etc.)
├── server.ts           # Express API server + web UI
├── index-repo.ts       # Code indexer
├── index-docs.ts       # Documentation indexer
├── doctor-cli.ts       # Repo Doctor CLI
├── doctor/             # Extractors + generators + tests
├── lib/
│   ├── config.ts       # All env-overridable config
│   ├── ollama.ts       # LLM + embedding calls
│   ├── qdrant.ts       # Vector store client
│   ├── bm25-index.ts   # In-process keyword search
│   ├── reranker.ts     # BGE neural cross-encoder
│   ├── learning-rules.ts  # Self-learning rule system
│   ├── graph.ts        # Relationship graph
│   ├── answer-feedback.ts # Feedback storage
│   └── ...
scripts/
├── audit-docs.ts       # Documentation gap audit
├── check-code-changes.ts # Git change detection for doc sync
├── eval-feedback.ts    # Meta-evaluation + auto-rule creation
├── model-eval.ts       # Cross-model answer quality comparison
└── ...
mcp-server.mjs          # Zero-dep MCP server for AI agents
public/index.html       # Web UI (single-file SPA)
config/services.json    # Domain vocabulary registry
```

## Testing

```bash
npm run test:doctor     # Extractor + generator unit tests
npm run test:answers    # Answer regression (smoke suite)
npm run test:answers:full  # Full regression suite
npm run test:language   # Language detection tests
npm run test:api        # API endpoint regression
```

## Limitations

- RAG, not a static call graph — cross-repo relationships are inferred, not guaranteed
- Chunking is line/character-based, not AST-aware
- Polyglot support uses regex heuristics, not language parsers
- Answers are investigation aids — always verify against cited source files

## License

MIT
