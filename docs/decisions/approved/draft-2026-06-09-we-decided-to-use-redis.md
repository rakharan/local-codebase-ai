---
date: 2026-06-09
status: approved
decision_maker: Budi
affected_services: [tf2-admin]
affected_tables: []
source: brain_dump
---

# ADR: We decided to use Redis for caching in tf2-admin because MySQL was too slow

## Decision
We decided to use Redis for caching in tf2-admin because MySQL was too slow

## Context
The system experienced performance issues with MySQL database queries

## Rationale
Redis provides faster caching capabilities compared to MySQL for read-heavy operations

## Alternatives rejected
⚠️  unknown — not mentioned in input

## Open questions
- Are there other services that might benefit from Redis caching?
- Were other caching solutions considered besides Redis?

## Review notes
[ ] Note alternatives that were rejected
[ ] Confirm which tables are affected
[ ] Resolve open question: Are there other services that might benefit from Redis caching?
[ ] Resolve open question: Were other caching solutions considered besides Redis?
