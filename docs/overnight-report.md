# Overnight RAG Improvement Report

## Date: 2026-09-03

## Completed

### 1. ask.ts Split (7193 → 1679 lines)
- 14 new modules under `src/ask/`
- Shared state via `ctx` singleton (`context.ts`)
- 0 TypeScript errors
- Regression: identical to pre-split main

### 2. BGE Neural Reranker
- `src/lib/reranker.ts` — cross-encoder via Ollama
- Model: `qllama/bge-reranker-v2-m3` (568M params, 636MB)
- 20 chunks reranked in ~5.6s on CPU
- Falls back to heuristic if model unavailable

### 3. tsx over ts-node
- All scripts use tsx — near-instant startup
- Fixed in: package.json, server.ts, answer-regression.ts, all scripts/

### 4. Model Routing
- `src/ask/model-router.ts` — pattern-based query classification
- Simple → SIMPLE_MODEL, complex → CHAT_MODEL, deep → DEEP_MODEL
- Skips routing when --chat-model explicitly set

### 5. Regression Test Fixes
- Branch name mismatches fixed (ims-tf2@develop → @fix-zero-adid, etc.)
- dotenv loading fixed in test runner

### 6. Config Mappings (259 new entries)
- 168 ChannelsConfig + 91 FaConfig constants

### 7. Streaming Answers
- Server endpoints fixed to use tsx

### 8. Graph API + Visualization
- GET /api/graph endpoint
- Backoffice UI: vis.js force-directed graph panel
- Nodes: repos, routes, tables, RPC functions, symbols
- Click repo node to filter, edge type dropdown, stats

### 9. bge-m3 Embedding Model (IN PROGRESS)
- Model pulled (1.2GB, 1024 dims)
- .env updated: EMBEDDING_MODEL=bge-m3, VECTOR_SIZE=1024
- Qdrant collection recreated with 1024 dims
- Full reindex running (doctor phase done, index-doctor-all in progress)
- ETA: several hours on CPU (169ms/embed vs nomic's 31ms)

### 10. Backoffice UI Improvements
- Graph visualization panel with vis.js
- Relationship Graph nav button in sidebar
- Color-coded nodes by type
- Interactive filtering and stats

## Commits (all on main)
- bb59ece: split ask.ts
- fc00fce: BGE neural reranker
- e6f8381: tsx over ts-node
- 084d255: merge to main
- 169cc8c: model routing + config mappings
- 85c78fb: graph API + fix scripts
- c0d1d4e: dotenv + graph UI + fix reindex

## Pending
- bge-m3 reindex completion (running)
- Regression tests after reindex
- SIMPLE_MODEL activation (optional, when ready)
