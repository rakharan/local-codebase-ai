---
date: 2026-06-10
status: approved
type: implicit_rule
discovered_in: tf2-ois/AccountHelper.php:234
affected_services: [mt4-account-types, mt5-account-types]
source: debug_discovery
---

# Implicit Rule: Account number ranges are defined as 1-999 for MT4 and 1000+ for MT5

## What it does
Account number ranges are defined as 1-999 for MT4 and 1000+ for MT5

Code in AccountHelper.php:234 specifies account number range conventions for MT4 and MT5 platforms

## Where it lives
tf2-ois/AccountHelper.php:234

## Risk
⚠️  unknown — not mentioned in input

## Review notes
[ ] Confirm the decision maker
[ ] Resolve open question: Why were these specific number ranges chosen?
[ ] Resolve open question: Are there any other platforms requiring similar conventions?
