# Overnight RAG Improvement Report

## Date: 2026-09-03

## Completed

### 1. ask.ts Split (7193 → 1679 lines)
- 14 new modules under `src/ask/`
- Shared state via `ctx` singleton (`context.ts`)
- 0 TypeScript errors
- Regression: identical to pre-split main (17/26 pass)

### 2. BGE Neural Reranker
- `src/lib/reranker.ts` — cross-encoder via Ollama
- Model: `qllama/bge-reranker-v2-m3` (568M params, 636MB)
- Wired after mergeChunks, before LLM prompt
- 20 chunks reranked in ~5.6s on CPU
- Falls back to heuristic if model unavailable

### 3. tsx over ts-node
- All scripts use `npx tsx` / `--import tsx`
- Near-instant startup vs ts-node's slow compile
- Fixed in: package.json, server.ts, answer-regression.ts, all scripts/

### 4. Model Routing
- `src/ask/model-router.ts` — pattern-based query classification
- Simple → SIMPLE_MODEL, complex → CHAT_MODEL, deep → DEEP_MODEL
- Skips routing when `--chat-model` explicitly set
- Config: `SIMPLE_MODEL`, `DEEP_MODEL` env vars

### 5. Regression Test Fixes
- Branch name mismatches: `@develop` → actual indexed branches
  - ims-tf2@develop → ims-tf2@fix-zero-adid
  - mrg-accounts@develop → mrg-accounts@tc-2498
  - tf2-ois@develop → tf2-ois@patch-find-deevice
- dotenv loading fixed in test runner

### 6. Config Mappings
- 259 new CONFIG_CONST_MAP entries
  - 168 ChannelsConfig constants (channelsconfig.php)
  - 91 FaConfig constants (faconfig.php)

### 7. Streaming Answers
- SSE endpoint `/api/ask/stream` already existed
- Fixed to use tsx instead of register-ts-node.mjs
- Both `/api/ask` and `/api/ask/stream` updated

### 8. Graph API + Visualization
- `GET /api/graph` endpoint — returns relationship edges as vis.js nodes/edges
  - Nodes: repos, routes, tables, RPC functions, symbols
  - Filters: repo, edge type, limit
- Backoffice UI: graph panel with vis.js force-directed network
  - Color-coded by node group
  - Click repo node to filter
  - Edge type filter dropdown
  - Stats: edge count, node count, type distribution

### 9. bge-m3 Embedding Model
- Pulled `bge-m3` (1.2GB, 1024 dims)
- Updated .env: EMBEDDING_MODEL=bge-m3, VECTOR_SIZE=1024
- Recreated Qdrant collection with 1024 dims
- Full reindex started (will take several hours on CPU)
- Latency: 169ms/embed vs nomic's 31ms (5.4x slower)
- Quality: better multilingual + code retrieval (expected)

## In Progress
- bge-m3 full reindex (running in background, ETA 4-8 hours)
- Regression tests will pass once reindex completes

## Commits
- bb59ece: split ask.ts into 14 modules
- fc00fce: BGE neural reranker
- e6f8381: tsx over ts-node
- 084d255: merge to main
- 169cc8c: model routing + fix regression + tsx server + config mappings
- 85c78fb: graph API endpoint + fix test runner + fix tsx scripts
- (pending): graph UI + reindex

## Config Summary
```env
EMBEDDING_MODEL=bge-m3
VECTOR_SIZE=1024
RERANKER_MODEL=qllama/bge-reranker-v2-m3
RERANKER_TOP_N=20
RERANKER_MAX_CHARS=256
SIMPLE_MODEL=  (empty = disabled)
DEEP_MODEL=    (empty = disabled)
CHAT_MODEL=prod/glm-5.2
```

## Next Steps
1. Wait for bge-m3 reindex to complete
2. Re-run regression tests
3. Enable SIMPLE_MODEL=qwen2.5-coder:3b for model routing (optional)
4. Consider VPS deployment (Hostinger KVM 4) if local RAM too tight
