# Codebase AI — User Guide & Demo Playbook

> **Internal Knowledge Base for Engineering Teams**  
> Ask questions about your codebase in English or Bahasa Indonesia. Get instant answers backed by actual code, documentation, and approved decisions.

---

## Table of Contents

1. [What Is This?](#what-is-this)
2. [Getting Started](#getting-started)
3. [What You Can Ask](#what-you-can-ask)
4. [Repo Doctor — Service Health Reports](#repo-doctor)
5. [Demo Scenarios](#demo-scenarios)
6. [Managing Knowledge](#managing-knowledge)
7. [For Admins — Setup & Maintenance](#admin-guide)

---

## What Is This?

Codebase AI is an internal Q&A system that reads your actual codebase and answers questions about it. Think of it as a **knowledge book for your entire engineering team** — one that never forgets, answers in seconds, and cites its sources.

It knows:
- Every service's API routes, database tables, queues, and env vars
- Cross-service flows (how service A calls service B)
- Architecture decisions (ADRs) and implicit rules
- Config values and business rules buried in code
- Account types, eligibility rules, formulas

It does **not** guess. If it doesn't know, it says `NOT_FOUND_IN_INDEXED_CODEBASE`.

---

## Getting Started

### Prerequisites
- 9router running locally (`9router.cmd`)
- Qdrant running (`docker compose up -d`)
- Ollama running (for embeddings)

### Start the server
```powershell
cd C:\GIT\personal\local-codebase-ai
npm run start
```

Open **http://localhost:9191** in your browser.

### First time setup
1. The UI will prompt for an API key if one is configured (`APP_API_KEY` in `.env`)
2. For local dev, leave `APP_API_KEY` unset — no key needed
3. Click any example question to test the system

### Configuration (`.env`)
```env
# Required: 9router for fast cloud inference
OPENAI_API_KEY=<your-9router-key>
OPENAI_BASE_URL=http://localhost:20128/v1
CHAT_MODEL=kr/claude-haiku-4.5

# Optional: protect the server
APP_API_KEY=your-secret-here

# Embeddings (always local)
OLLAMA_URL=http://localhost:11434
EMBEDDING_MODEL=nomic-embed-text
```

---

## What You Can Ask

### Service & Flow Questions
> *"jelasin flow request account demo dari ims-tf"*  
> *"which PHP code in ims-tf calls /mrg/api/v1/account/demo/request/?"*  
> *"what does tf2-ois do?"*  
> *"what services touch the dsc_signals table?"*

### API & Endpoint Questions
> *"request body, validasi, dan return dari endpoint /mrg/api/v1/deposit/demo/"*  
> *"what routes does ims-tf2 expose?"*

### Glossary & Definitions
> *"apa itu MMB?"*  
> *"apa itu iSignal?"*  
> *"berikan list tipe akun MT4 MMB"*  
> *"apa itu MT4 vs MT5?"*

### Business Rules & Decisions
> *"kenapa dsc_bot_copy.status harus 1?"*  
> *"berapa minimal equity untuk bisa ikut iSignal?"*  
> *"how do we gain medal?"*

### Architecture & Diagrams
> *"how isignal works?"* → returns actual Mermaid flowchart  
> *"what is the signal processing flow?"*

### Cross-service & Database
> *"what tables does mrg-accounts write to?"*  
> *"what queues does tf2-sinyo publish to?"*

---

## Repo Doctor

Repo Doctor automatically scans a service's codebase and generates a **health report** — a structured summary of everything the service does.

### What it generates per service
| Section | What it contains |
|---|---|
| **Overview** | Service name, tech stack, dependencies |
| **API Routes** | All HTTP endpoints (method, path, file, line) |
| **Database** | Tables read/written, SQL operations |
| **RabbitMQ** | Queues and exchanges published/consumed |
| **Environment** | All env vars the service needs |
| **Config** | Business-rule defaults baked into config |
| **Architecture** | Service topology diagram |

### How to run it

**From the UI:**
1. Open **Index Manager** (sidebar button)
2. Go to **Indexing** tab
3. Scroll to **🩺 Run Repo Doctor**
4. Enter the repo path, e.g. `C:\GIT\work\tf2-ois`
5. Click **Run Doctor + Index**

**From the CLI:**
```powershell
# Run doctor on one repo
node --import ./register-ts-node.mjs scripts/doctor-all.ts C:\GIT\work\tf2-ois

# Then index the report
npm run index-doctor -- repo-docs-work/tf2-ois
```

### After running doctor, you can ask:
> *"what does tf2-ois do?"*  
> *"list all API routes in tf2-ois"*  
> *"what database tables does ims-tf use?"*  
> *"what env vars does mrg-accounts need?"*  
> *"which services publish to which queues?"*

### Demo use case
Run doctor on `tf2-ois` before the demo. Then show:
1. "What does this service do?" — instant service overview
2. "What routes does it expose?" — API inventory
3. "What tables does it touch?" — database mapping

This is the **"knowledge book"** use case: instead of reading thousands of lines of code, ask one question.

---

## Demo Scenarios

### Scenario 1: New Developer Onboarding
**Story:** A new engineer joins the team and needs to understand the demo account flow.

**Questions to show:**
1. *"jelasin flow request account demo dari ims-tf"* → full cross-service flow with file/line citations
2. *"apa itu MMB?"* → broker definition from registry
3. *"berikan list tipe akun MT4 MMB"* → account type table with all types

**Impact:** What used to take 3 days of asking teammates now takes 30 seconds.

---

### Scenario 2: Bug Investigation
**Story:** Someone reports that signal copy isn't working. You need to understand the prerequisite conditions.

**Questions to show:**
1. *"kenapa dsc_bot_copy.status harus 1?"* → ADR with rationale and source file
2. *"what services touch dsc_bot_copy?"* → cross-service inventory
3. *"how isignal works?"* → Mermaid architecture diagram

**Impact:** Root cause in seconds, not hours of grepping.

---

### Scenario 3: API Documentation on Demand
**Story:** Frontend team asks about the deposit demo endpoint.

**Questions to show:**
1. *"request body, validasi, dan return dari endpoint /mrg/api/v1/deposit/demo/"* → full endpoint spec
2. *"what routes does ims-tf2 expose?"* → complete API inventory (from Doctor)

**Impact:** No need to write/maintain API docs — they're auto-generated from code.

---

### Scenario 4: Business Rule Lookup
**Story:** Finance team asks about the medal/VP formula and iSignal eligibility.

**Questions to show:**
1. *"how do we gain medal?"* → VP formula from code
2. *"berapa minimal equity untuk bisa ikut iSignal?"* → config value with source
3. *"akun jenis apa yang boleh ikut iSignal?"* → eligibility rules

**Impact:** Business rules are searchable without digging through Confluence or asking the original developer.

---

### Scenario 5: Repo Doctor Live Demo
**Story:** Show how the system auto-documents a service.

**Steps:**
1. Open Index Manager → Indexing tab → 🩺 Run Repo Doctor
2. Enter `C:\GIT\work\tf2-ois`
3. Click Run Doctor + Index (takes ~1 min)
4. Ask: *"what does tf2-ois do?"* → instant overview
5. Ask: *"what database tables does tf2-ois use?"*
6. Ask: *"list all API routes in tf2-ois"*

**Impact:** Any service can be auto-documented in minutes, not weeks.

---

### Scenario 6: Architecture Decision Records (ADRs)
**Story:** Show that team decisions are captured and searchable forever.

**Questions to show:**
1. *"kenapa kita pakai Redis?"* → ADR with rationale
2. *"apa keputusan tentang direct DB writes?"* → ADR about the violation
3. *"when was the dsc_bot_copy status rule approved?"*

**Impact:** Institutional memory that survives team turnover.

---

## Managing Knowledge

### Add a new decision (ADR)
```powershell
npm run drafts -- create "Why we chose Redis for caching"
# Edit the draft in docs/decisions/drafts/
npm run drafts -- approve <filename>
```

### Add an implicit rule from code
```powershell
npm run digest -- --finding "dsc_signals must only be written via queue, not direct DB"
```

### Reindex after code changes
```powershell
# Reindex a specific repo
npm run index -- C:\GIT\work\tf2-ois --index-comments

# Run doctor + reindex a service
# UI: Index Manager → 🩺 Run Repo Doctor
```

---

## Admin Guide

### Indexed repos (152k chunks as of June 2026)
All repos in `C:\GIT\work\` are indexed, including:
- PHP repos: ims-mrg, ims-tf, ims-askap (with exclude rules)
- TypeScript/Node: tf2-ois, tf2-sinyo, mrg-accounts, etc.
- Documentation: tf-documentation

### Security
- Set `APP_API_KEY` in `.env` for team access
- Rate limiting: 60 requests/minute per IP (configured in `server.ts`)
- Embeddings are always local — only answer generation goes to cloud (9router)

### Keeping knowledge fresh
| Trigger | Action |
|---|---|
| New repo added | `npm run index -- C:\GIT\work\<repo> --index-comments` |
| Major code change | Re-run doctor: Index Manager → 🩺 Run Repo Doctor |
| New decision made | `npm run drafts -- create` → approve |
| New business rule found | `npm run digest -- --finding "..."` |

### Troubleshooting
| Issue | Fix |
|---|---|
| Slow responses | Check 9router is running (`9router.cmd`) |
| No answer found | Re-index the relevant repo |
| ECONNRESET errors | BM25 cache warming — retry in 20s |
| Context too long | Already handled — prompts are auto-truncated |

---

*Last updated: June 2026*  
*Maintained by the platform team*
