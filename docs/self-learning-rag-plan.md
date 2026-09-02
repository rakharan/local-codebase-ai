# Self-Learning RAG Architecture Plan

_Written: 2026-09-01_
_Status: Draft — pending review_

---

## 1. Executive Summary

**local-codebase-ai** is a RAG (Retrieval-Augmented Generation) system that lets developers ask natural-language questions about a multi-repo PHP/Node.js codebase and get grounded, source-cited answers. It is currently operational: 160,718 code chunks indexed in Qdrant, BM25 hybrid retrieval, deep-mode synthesis, answer quality gate with auto-retry, and a web UI at `http://localhost:9191`.

The system is **not yet self-correcting**. Indexing is manual, feedback is collected but not analyzed, and bad answers are retried but never root-caused. This plan proposes four phases to close those gaps:

| Phase | Goal | Effort | Dependency |
|---|---|---|---|
| 1. Auto-Reindex | Code changes trigger reindex automatically | ~2 days | GitHub webhook or cron |
| 2. Feedback Analytics | Bad answers surface as actionable items | ~2 days | Phase 1 (for fix verification) |
| 3. Hermes Meta-Evaluation | LLM judge identifies root cause of bad answers | ~3-4 days | Cloud GPU for Hermes |
| 4. Continuous Learning | Approved corrections feed back into prompt/retrieval | ~3 days | Phase 3 |

**Total estimated effort: 10-12 developer-days.**

---

## 2. Current State

### What works today

| Capability | Implementation | Location |
|---|---|---|
| Vector search | Qdrant collection `code_chunks`, 160,718 points | `src/lib/qdrant.ts` |
| Hybrid retrieval | BM25 (MiniSearch) + vector + graph context | `src/lib/bm25-index.ts`, `src/ask.ts` |
| Doc-to-code cross-ref | Extract identifiers from docs → BM25 code search | `src/ask.ts:491` |
| Deep mode | Skip deterministic fast paths, LLM synthesizes from full context | `src/ask.ts` |
| Answer quality gate | LLM self-eval (groundedness/relevance/completeness/faithfulness), auto-retry on low score | `src/ask/answer-evaluation.ts` |
| Feedback collection | Thumbs up/down via UI, stored in `.data/answer-feedback.json` | `src/lib/answer-feedback.ts`, `src/server.ts:1002` |
| Draft decisions | ADR drafts with approve/reject workflow | `src/lib/draft-manager.ts` |
| Chunk quality filters | Noise/comment/CSS/boilerplate filtering | `src/lib/chunker.ts`, `src/lib/facts.ts`, `src/lib/comments.ts` |
| Indexing | `npm run reindex-full` (doctor + source + docs in one pass) | `scripts/reindex-full.ts` |

### What is missing

1. **No auto-reindex** — code changes require manual `npm run reindex-full`. Forgetting this means stale search results.
2. **Feedback is write-only** — thumbs up/down stored but never analyzed. No dashboard, no triage, no root-cause loop.
3. **No meta-evaluation** — the quality gate uses the same LLM that generated the answer (self-eval bias). No independent judge.
4. **No feedback loop** — even when a bad answer is identified, there is no mechanism to feed the correction back into the prompt or retrieval pipeline.

---

## 3. Phase 1 — Auto-Reindex

**Goal:** When code is pushed to any tracked repo, the relevant repo's chunks are automatically updated in Qdrant and BM25 cache.

### Trigger options

| Option | How | Pros | Cons |
|---|---|---|---|
| A. GitHub Actions | Workflow on push, calls `POST /api/index/repo` | Real-time, per-repo granularity | Requires public URL for self-hosted runner; or GitHub-hosted runner needs VPN access |
| B. Cron polling | Cron job every N min, `git pull` + check changed files | Simple, no inbound network needed | Up to N-minute staleness; wastes cycles when nothing changed |
| C. GitHub Webhook | GitHub pushes `push` event to our server | Real-time, precise | Requires public URL (ngrok/Cloudflare Tunnel) |

**Recommended: Option B (cron polling) for initial implementation.** Lowest operational complexity. Upgrade to A or C when team has a public endpoint or self-hosted runner.

### Implementation

```
scripts/watch-repos.ts
  ├── git pull each tracked repo
  ├── git diff --name-only HEAD~1 to get changed files
  ├── if changed files match indexer extensions (src/lib/files.ts:allowedExtensions)
  │     → call indexRepo(repoPath) for that repo
  ├── if changed files are in docs/ → call indexDocs(docsPath)
  └── invalidate BM25 cache (delete .data/bm25-index.json)
```

Cron entry (every 10 min):
```cron
*/10 * * * * cd /path/to/local-codebase-ai && node --import ./register-ts-node.mjs scripts/watch-repos.ts >> .data/watch.log 2>&1
```

### Deliverables

- `scripts/watch-repos.ts` — incremental reindex on git change
- `.env.example` entry: `WATCH_REPOS` (comma-separated repo paths)
- `npm run watch` script alias
- Documentation update in `docs/reindex-commands.md`

### Effort: ~2 days

---

## 4. Phase 2 — Feedback Analytics

**Goal:** Bad answers become actionable items. A dashboard shows: which questions got thumbs-down, what the quality score was, what sources were retrieved, and whether a re-ask (after reindex) fixes it.

### Data model

Feedback is already collected (`src/lib/answer-feedback.ts`). Extend the stored record:

```jsonc
// .data/answer-feedback.json (existing format, extended)
{
  "id": "uuid",
  "rating": "bad",
  "question": "how does isignal auto-copy work?",
  "answer": "...",
  "sources": ["repo:file:line", ...],
  "note": "user comment",
  "createdAt": "2026-09-01T12:00:00Z",
  "qualityScore": {           // NEW — linked from quality log
    "groundedness": 0.6,
    "relevance": 0.8,
    "completeness": 0.3,
    "faithfulness": 0.7,
    "issues": ["missing fa-trade-publisher flow"]
  },
  "status": "open",            // NEW — open | triaged | fixed | wontfix
  "triageNote": ""            // NEW — admin note
}
```

### New API endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/feedback` | List all feedback (existing, add `?status=open` filter) |
| `PATCH` | `/api/feedback/:id` | Update status + triageNote |
| `POST` | `/api/feedback/:id/reask` | Re-run the question, compare new answer to old |

### UI additions

- **Feedback dashboard** page (`/feedback` route in `public/index.html` or separate `public/feedback.html`)
- Per-item: question, answer preview, quality score, sources, status badge
- "Re-ask" button — runs the question through current pipeline, shows diff vs. old answer
- "Triage" form — set status + note

### Deliverables

- Extended `AnswerFeedback` type + migration for existing records
- `PATCH /api/feedback/:id` endpoint
- `POST /api/feedback/:id/reask` endpoint
- Feedback dashboard UI
- `npm run feedback:export` script (CSV export for reporting)

### Effort: ~2 days

---

## 5. Phase 3 — Hermes Meta-Evaluation

**Goal:** An independent LLM (Hermes by NousResearch) evaluates bad answers and identifies root cause: retrieval miss, prompt weakness, or hallucination. Human reviews and approves corrections.

### Why a separate judge?

The current quality gate (`src/ask/answer-evaluation.ts`) uses the **same LLM** that generated the answer. This creates self-evaluation bias — the model is unlikely to flag its own errors. An independent, stronger model (Hermes) acts as a meta-evaluator with no stake in the original answer.

### Why Hermes?

| Attribute | Hermes (NousResearch) | Notes |
|---|---|---|
| Model family | Llama 3 fine-tunes | Open weights, self-hostable |
| Strength | Instruction following, structured output | Good for rubric-based evaluation |
| Size | 8B / 70B variants | 70B for quality; 8B for cost |
| Availability | HuggingFace, Ollama | Can run on cloud GPU |

### Hardware constraint

Hermes 70B requires ~40GB VRAM (Q4 quantization). Our local machine (AMD Ryzen Z1 Extreme, 11.7GB RAM, no CUDA) **cannot run it locally**. Options:

| Option | Cost | Quality | Notes |
|---|---|---|---|
| RunPOD / Vultr A100 80GB | ~$1.50-2.00/hr | Best (70B Q8) | Pay per use; spin up only for triage sessions |
| RunPOD / Vultr A40 48GB | ~$1.00/hr | Good (70B Q4) | Fits 70B at Q4 |
| Together AI / OpenRouter API | ~$0.50-2.00/M tokens | No infra to manage | API call, no GPU to provision |
| Local Hermes 8B | Free | Lower quality | Needs 6GB VRAM; we have no CUDA |

**Recommended: OpenRouter or Together AI API for Hermes 70B.** No infrastructure to manage. Pay per token. Triage is not real-time — batch processing once a day/week is fine.

### Evaluation pipeline

```
feedback.json (bad answers)
  │
  ▼
scripts/hermes-eval.ts
  │
  ├── For each bad answer:
  │     ├── Load original question + answer + sources + quality score
  │     ├── Send to Hermes with rubric prompt:
  │     │     "You are a senior codebase analyst. Evaluate this Q&A.
  │     │      Identify root cause category:
  │     │        - RETRIEVAL_MISS: relevant code not retrieved
  │     │        - PROMPT_WEAKNESS: retrieved code not synthesized well
  │     │        - HALLUCINATION: answer contains facts not in sources
  │     │        - AMBIGUOUS_QUESTION: question unclear
  │     │      Suggest specific fix:
  │     │        - Add extraction rule for X
  │     │        - Boost retrieval weight for Y
  │     │        - Add prompt instruction: 'always mention Z'
  │     │      Return JSON: {category, severity, suggestedFix, rationale}"
  │     └── Store result in .data/suggestions.jsonl
  │
  ▼
Dashboard (Phase 2 UI extended)
  │
  ├── Show Hermes suggestion per feedback item
  ├── Admin approves / rejects / edits suggestion
  └── Approved suggestions → Phase 4
```

### Hermes API call (pseudo)

```typescript
// src/lib/hermes.ts
async function evaluateWithHermes(
  question: string,
  answer: string,
  sources: RetrievedPayload[],
  qualityScore: QualityScore
): Promise<HermesSuggestion> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.HERMES_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "nousresearch/hermes-3-llama-3.1-70b",
      messages: [
        { role: "system", content: HERMES_SYSTEM_PROMPT },
        { role: "user", content: formatEvaluationInput(...) },
      ],
      response_format: { type: "json_object" },
    }),
  })
  // ... parse + validate
}
```

### Deliverables

- `src/lib/hermes.ts` — Hermes API client
- `scripts/hermes-eval.ts` — batch evaluate all open bad answers
- `.data/suggestions.jsonl` — Hermes output storage
- `npm run hermes:eval` script alias
- `.env.example` entries: `HERMES_API_KEY`, `HERMES_MODEL`
- Hermes rubric prompt (versioned in `src/lib/hermes-prompts.ts`)
- Dashboard extension: show suggestion per feedback item, approve/reject UI

### Effort: ~3-4 days

---

## 6. Phase 4 — Continuous Learning

**Goal:** Approved Hermes suggestions are applied to the retrieval + prompt pipeline automatically, with rollback safety.

### Correction types

Hermes suggestions map to concrete changes:

| Suggestion Category | Applied As | Mechanism |
|---|---|---|
| RETRIEVAL_MISS | Extraction rule or boost weight | `config/services.json` keyword addition, or BM25 boost adjustment |
| PROMPT_WEAKNESS | Prompt instruction | Append to synthesis directive in `src/ask.ts` prompt builder |
| HALLUCINATION | Anti-hallucination guardrail | Append to anti-hallucination block in prompt |
| AMBIGUOUS_QUESTION | Query rewrite rule | `src/ask/question.ts` query normalization |

### Safety: staging config

Approved corrections do NOT modify source code directly. They are stored as **runtime-overridable config**:

```jsonc
// .data/learning-rules.json
{
  "rules": [
    {
      "id": "rule-uuid",
      "source": "hermes-suggestion-uuid",
      "type": "prompt_directive",       // prompt_directive | retrieval_boost | extraction_rule | query_rewrite
      "content": "Always mention fa-trade-publisher when discussing signal copying.",
      "appliedAt": "2026-09-15T10:00:00Z",
      "appliedBy": "admin",
      "status": "active",               // active | rolled_back
      "rollbackReason": null
    }
  ]
}
```

At runtime, `src/ask.ts` loads active rules and injects them into the prompt / retrieval pipeline.

### Application points

```typescript
// src/ask.ts (conceptual)
const rules = await loadActiveLearningRules()

// Prompt directives → append to synthesis block
const promptDirectives = rules
  .filter(r => r.type === "prompt_directive" && r.status === "active")
  .map(r => r.content)
if (promptDirectives.length) {
  synthesisBlock += "\n\nAdditional requirements:\n" + promptDirectives.map(r => `- ${r}`).join("\n")
}

// Retrieval boosts → add to BM25 search terms or boost fields
const retrievalBoosts = rules
  .filter(r => r.type === "retrieval_boost" && r.status === "active")
  // ... apply to BM25 search
```

### Verification

Every applied rule triggers a re-run of the relevant answer-regression test case (`src/answer-regression.ts`). If the test fails, the rule is auto-rolled back and flagged for manual review.

```
Rule applied → run relevant test case
  ├── PASS → rule stays active
  └── FAIL → rule rolled back, flagged in dashboard
```

### Deliverables

- `.data/learning-rules.json` schema + storage
- `src/lib/learning-rules.ts` — load/apply/rollback logic
- Rule application in `src/ask.ts` (prompt directives + retrieval boosts)
- `POST /api/learning/rules/:id/rollback` endpoint
- Dashboard: rule history, rollback button
- Regression test auto-run on rule application

### Effort: ~3 days

---

## 7. End-to-End Flow

```
Developer pushes code
        │
        ▼
  Phase 1: Auto-reindex ─── chunks updated in Qdrant + BM25
        │
        ▼
  Developer asks question ─── answer generated
        │
        ▼
  Quality gate ─── score < threshold? → retry with deeper context
        │
        ▼
  Developer rates answer (thumbs up/down)
        │
        ├── good → done
        └── bad
                │
                ▼
          Phase 2: Feedback dashboard ─── item status: open
                │
                ▼
          Phase 3: Hermes evaluates ─── root cause + suggested fix
                │
                ▼
          Admin reviews suggestion
                │
                ├── reject → closed
                └── approve
                        │
                        ▼
                  Phase 4: Rule created ─── applied to prompt/retrieval
                        │
                        ▼
                  Regression test runs
                        │
                        ├── pass → rule active
                        └── fail → auto-rollback, flag for review
```

---

## 8. Infrastructure Requirements

### Current (no change)

| Component | Spec | Notes |
|---|---|---|
| App server | Node.js, `localhost:9191` | No change |
| Qdrant | Docker, `localhost:6333` | No change; may need disk growth as feedback accumulates |
| Ollama | `localhost:11434`, `nomic-embed-text` | Embeddings only; chat uses cloud API |
| Chat LLM | 9router (`prod/glm-5.2`) via `localhost:20128` | No change |

### New (Phase 3 only)

| Component | Purpose | Cost |
|---|---|---|
| Hermes API (OpenRouter or Together AI) | Meta-evaluation of bad answers | ~$0.50-2.00/M tokens. Est. ~$5-15/month for weekly triage of 20-50 bad answers. |
| (Alternative) RunPOD A40 48GB | Self-host Hermes 70B | ~$1.00/hr. ~$4-8/month for weekly triage sessions. |

No new infrastructure for Phases 1, 2, 4 — all run on existing app server.

---

## 9. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Cron polling misses time-sensitive changes | Medium | Low | Pair with manual reindex trigger in UI; upgrade to webhook later |
| Hermes suggestions are wrong / low quality | Medium | Medium | Human-in-the-loop approval gate; auto-rollback on test failure |
| Learning rules conflict with each other | Low | Medium | Rule priority order; test each new rule in isolation before activating |
| Feedback dashboard performance degrades with volume | Low | Low | Paginate; archive closed items > 90 days to `.data/feedback-archive.json` |
| Hermes API downtime | Low | Low | Triage is batch, not real-time; retry on next session |
| Learning rules cause prompt bloat | Medium | Medium | Cap active rules at N (e.g. 20); oldest inactive when exceeding |

---

## 10. Timeline

| Week | Phase | Deliverable |
|---|---|---|
| 1 | Phase 1 | Auto-reindex via cron polling |
| 1-2 | Phase 2 | Feedback dashboard + triage workflow |
| 2-3 | Phase 3 | Hermes evaluation pipeline |
| 3-4 | Phase 4 | Learning rules + auto-application + rollback |

**MVP (Phases 1-2): 1 week.** Delivers auto-reindex + feedback analytics. No cloud spend.

**Full system (Phases 1-4): 3-4 weeks.** Adds Hermes meta-evaluation + continuous learning. ~$5-15/month cloud API cost.

---

## 11. Open Questions (need decision)

1. **GitHub Actions vs cron polling for auto-reindex?** Cron is simpler. GitHub Actions gives real-time but needs self-hosted runner or public URL. Which does the team prefer?

2. **Hermes hosting: API or self-hosted GPU?** API (OpenRouter/Together AI) is zero-infra. Self-hosted GPU is cheaper long-term but needs provisioning. Which?

3. **Feedback granularity: thumbs up/down vs 1-5 stars?** Current system is binary. 1-5 stars gives more signal but increases user friction. Keep binary?

4. **Staging config scope: per-rule or global?** Should learning rules be applied globally, or scoped per question-type / per repo?

5. **Regression test coverage: how many cases before auto-apply?** Current `answer-regression.ts` has 31 cases. Is that enough coverage to trust auto-application, or should we require a minimum pass-rate threshold?

---

## 12. Glossary

| Term | Definition |
|---|---|
| RAG | Retrieval-Augmented Generation — retrieve relevant context, then generate answer |
| Qdrant | Vector database for similarity search |
| BM25 | Sparse keyword search algorithm (Okapi BM25). Hybrid with vector search. |
| Hermes | Open-weight LLM by NousResearch, used here as independent meta-evaluator |
| ADR | Architecture Decision Record |
| Meta-evaluation | Evaluating the evaluator — using a separate model to judge answer quality |
| Learning rule | A runtime-applied correction (prompt directive, retrieval boost, etc.) derived from approved Hermes suggestions |
