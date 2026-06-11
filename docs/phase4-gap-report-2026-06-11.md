# Phase 4 — Tribal Knowledge Gap Discovery Report
# Generated: 2026-06-11

## Heavily-Shared Tables With No ADR

These tables are touched by 3+ repos but have no documented decision or ADR.
Each is a potential tribal knowledge gap.

| Table | Repos | Gap Type |
|---|---|---|
| `traders_details` | 8 repos | Who owns this table? What's the write contract? |
| `dsc_users` | 8 repos | Same as traders_details — are they the same entity? |
| `dsc_channels` | 8 repos | Core DSC table — what is the ownership model? |
| `dsc_signals` | 7 repos | Signal lifecycle — who writes, who reads, who deletes? |
| `dsc_signals_copy` | 7 repos | Why a separate copy table? What triggers the copy? |
| `dsc_subs` | 7 repos | Subscription model — undocumented |
| `traders_kyc` | 7 repos | KYC data — who is authoritative writer? |
| `dsc_mt4server` | 7 repos | MT4 server config — shared read, single writer? |
| `dsc_payment` | 6 repos | Payment records — write ownership undocumented |
| `traders_referral` | 6 repos | Referral model — undocumented |
| `mail_template` | 6 repos | Email templates — who owns, who reads? |
| `dsc_withdrawal` | 5 repos | Withdrawal flow — undocumented cross-repo writes |
| `dsc_channels_point_events` | 5 repos | Medal/VP point events — undocumented |

## Known Gaps (from session-2026-06-10)

| Gap | Status | Notes |
|---|---|---|
| Why `dsc_bot_copy.status = 1` | ❌ Unknown | Only `tf2-ois-admin` ADR mentions it |
| `dsc_bot_copy` affected_services | ❌ Empty | |
| Medal/VP calculation logic | ❌ Not documented | `dsc_channels_point_events` touched by 5 repos |
| Services writing direct to DB vs queue | ❌ Unknown | ADR exists but no service list |
| MT4/MT5 metaserver_id range rationale | ❌ Not documented | |

## Newly Discovered Gaps

| Gap | Evidence |
|---|---|
| `dsc_signals` write/read contract | 7 repos touch it, no ADR |
| `dsc_signals_copy` purpose | Why copy? What triggers it? 7 repos |
| `traders_details` vs `dsc_users` | Are these the same entity? Both in 8 repos |
| `dsc_channels` ownership model | 8 repos, no documented owner |
| `mail_template` ownership | 6 repos read it — who writes? |
| `dsc_withdrawal` cross-repo writes | 5 repos — direct DB or queue? |

## Probe Results (2026-06-11)

| Question | Finding |
|---|---|
| Who writes/reads `dsc_signals`? | **Writers:** `fa-trade-publisher` (cron/mt4/trade.ts), `tf2-microservice` (ois-routines/trade.js) — both direct DB writes. **Readers:** `tf2-ois` (models/signal.js). ADR "stop-using-direct-db-writes" exists but not followed. |
| What triggers `dsc_signals_copy`? | `fa-trade-publisher` — copy trade crons (`cron/mt4/trade.ts`, `cron/mt5/trade.ts`, `services/copytrade.ts`). This is the copy trading signal table. |
| `traders_details` vs `dsc_users`? | Different entities — `traders_details` = trader profile/KYC. `dsc_users` = DSC copy trading user. Product docs confirm this. |

## ADR Violations Found

- `fa-trade-publisher` and `tf2-microservice` still write directly to `dsc_signals` — violates "stop-using-direct-db-writes" ADR


1. Ask the system about each gap to see what it knows:
   - `"who writes to dsc_signals and who reads it?"`
   - `"what is the difference between traders_details and dsc_users?"`
   - `"what triggers a copy to dsc_signals_copy?"`
   - `"what services write directly to dsc_withdrawal?"`

2. For each NOT_FOUND answer → create an ADR draft capturing what you know

3. Run `ask digest --finding` on anything discovered in code review
