---
date: 2026-06-12
status: approved
decision_maker: unknown
affected_services: [tf2-ois]
affected_tables: [dsc_bot_copy]
source: brain_dump
---

# ADR: When a user reconnects a bot to a new MT4 account, the status is set to 1.

## Decision
When a user reconnects a bot to a new MT4 account, the status is set to 1.

## Context
The migration addcolomstatusbotcopytable confirms that the status column in dsc_bot_copy table can be used to track whether a bot is connected or disconnected. This change affects bots that are reconnected after extending their subscriptions.

## Rationale
⚠️  unknown — not mentioned in input

## Alternatives rejected
⚠️  unknown — not mentioned in input

## Open questions
- (none identified — confirm nothing was missed)

## Review notes
[ ] Fill in the rationale (why this choice)
[ ] Note alternatives that were rejected
[ ] Confirm the decision maker
