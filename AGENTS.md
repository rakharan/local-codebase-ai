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
- Reliability hardening DONE (uncommitted): structured failure logging (BM25 retrieve, LLM call), Qdrant index-error narrowing, `/api/ready` readiness probe, BM25 TTL configurable + point-count fast-path, Qdrant server-side evidence-type filters, bounded embedding concurrency, lock-protected `npm run reindex-all`
- Config externalized: chunker/ollama/docs constants + doc-folder→repo map now env-overridable
- DEFERRED: split ask.ts (~6500 lines) — blocked on runnable characterization tests (answer-regression.ts needs live Qdrant+Ollama stack); do not refactor blind
- Next: smoke-test cross-service queries; map `channelsconfig.php` + `faconfig.php` to `CONFIG_CONST_MAP`

## Open gaps (`docs/phase4-gap-report-2026-06-11.md`)
- `dsc_signals` / `dsc_signals_copy` / `traders_details` / `dsc_users` / `dsc_channels` / `mail_template` / `dsc_withdrawal` — no ADRs
- ADR violation: `fa-trade-publisher` + `tf2-microservice` still write directly to `dsc_signals`
