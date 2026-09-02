# local-codebase-ai — RAG state

## Architecture
- Vector store: Qdrant (decisions indexed on approval)
- Cache/queue: Redis (ADR 2026-06-09)
- Pipeline: doctor extractors → `src/lib/doctor-report-chunks.ts` → Qdrant
- Extractors: http-client, cron, rabbitmq (PHP + Node), db-table, route
- Frontend: Index Manager at http://localhost:3456 (Phase 6 web UI)

## Reindex
- Full: `npm run index-doctor-all` (after `doctor-all` completes)
- Decisions: auto-indexed on draft approval (`draft-manager.ts`)

## Current phase
- Phase 6 COMPLETE (merged to main 2026-06-15)
- Answer quality gate committed (answer-evaluation.ts, config.qualityThreshold, retry-on-low-score)
- Reliability hardening DONE: structured failure logging, Qdrant index-error narrowing, `/api/ready` readiness probe, BM25 TTL configurable, bounded embedding concurrency, lock-protected reindex
- Config externalized: chunker/ollama/docs constants + doc-folder→repo map env-overridable
- ask.ts SPLIT DONE (2026-09-02): 7193→1679 lines, 14 modules under src/ask/, ctx singleton for shared state
- BGE neural reranker DONE: src/lib/reranker.ts, qllama/bge-reranker-v2-m3 (636MB), top-20 chunks in ~5.6s
- tsx DONE: replaced ts-node, near-instant startup
- Next: smoke-test cross-service queries; map `channelsconfig.php` + `faconfig.php` to `CONFIG_CONST_MAP`

## Open gaps (`docs/phase4-gap-report-2026-06-11.md`)
- `dsc_signals` / `dsc_signals_copy` / `traders_details` / `dsc_users` / `dsc_channels` / `mail_template` / `dsc_withdrawal` — no ADRs
- ADR violation: `fa-trade-publisher` + `tf2-microservice` still write directly to `dsc_signals`
