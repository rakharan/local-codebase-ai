---
date: 2026-06-10
status: approved
type: implicit_rule
discovered_in: BotCopyService.php:87
affected_services: []
source: debug_discovery
---

# Implicit Rule: The status of dsc_bot_copy must be 1 before signal copy execution.

## What it does
The status of dsc_bot_copy must be 1 before signal copy execution.

This rule was found in BotCopyService.php line 87 with no associated documentation.

## Where it lives
BotCopyService.php:87

## Risk
⚠️  unknown — not mentioned in input

## Review notes
[ ] Confirm the decision maker
[ ] Confirm which services are affected
[ ] Resolve open question: What is the rationale behind requiring dsc_bot_copy.status to be 1?
