---
date: 2026-06-10
status: approved
decision_maker: Budi
affected_services: [tf2-admin, tf2-microservice, fa-trade-publisher]
affected_tables: [dsc_signals]
source: brain_dump
---

# ADR: Stop using direct DB writes from tf2-admin for signal copy; redirect to AMQP

## Decision
tf2-admin no longer writes directly to dsc_signals for signal copy. All writes now go through AMQP queue `pubsub-tf-fx-signal-copy` to fa-trade-publisher, which handles the downstream processing.

## Context
Race condition with tf2-microservice caused conflicts in signal copy operations when tf2-admin wrote directly to dsc_signals.

## Rationale
AMQP serialises the writes via `pubsub-tf-fx-signal-copy` queue and eliminates the race condition. fa-trade-publisher acts as the consumer (SignalSubscriberQueue handler) and publisher on this queue.

## Queue details
- Queue name: `pubsub-tf-fx-signal-copy`
- Consumer: fa-trade-publisher (`src/adapters/inbounds/amqp/subscriber.ts` — `SignalSubscriberQueue` handler)
- Publisher: fa-trade-publisher (`src/entry/main.ts:186-235`, `src/applications/boot/amqp.ts:30-79`)
- Source confirmation: fa-trade-publisher@develop indexed code

## Alternatives rejected
⚠️  unknown — not mentioned in input

## Open questions
- Are there other tables affected by this change besides dsc_signals?
- Is tf2-admin fully migrated or are there remaining direct DB write paths?

## Review notes
[x] Queue name identified: pubsub-tf-fx-signal-copy (2026-06-10)
[x] fa-trade-publisher added to affected_services
[ ] Note alternatives that were rejected
[ ] Confirm tf2-admin migration is complete — no remaining direct writes
