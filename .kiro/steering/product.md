# Product

Local Codebase AI is a local-first RAG (Retrieval-Augmented Generation) prototype for asking natural-language questions across one or more locally cloned codebases.

## What It Does

- Indexes source files and documentation from local repositories.
- Embeds chunks with a local Ollama model and stores vectors plus metadata in Qdrant.
- Answers questions from retrieved code context, citing source files and line ranges.
- Builds a local relationship graph (HTTP routes, RPC calls, symbol definitions, table touches) used for broad cross-repo "flow" questions before semantic retrieval.

## Core Principles

- Local-first: no external/cloud LLM APIs. Everything runs against local Ollama + Qdrant.
- Read-only: indexed repositories are never modified.
- Evidence-based: answers must come from indexed code or documentation, with source paths cited. Answers are investigation aids and should be verified against the cited files.
- Polyglot: supports TypeScript, JavaScript, PHP, Go, C/C++, SQL, Markdown, YAML, JSON, and common config/build files via heuristics (not full language parsers).

## Key Capabilities

- Incremental indexing using deterministic chunk hashes (skips unchanged chunks, removes stale ones).
- Scoping by `repoName`, `branchName`, `serviceType`, and `projectId`.
- A domain vocabulary registry (`config/services.json`) that maps product/broker/domain words to source identifiers for retrieval disambiguation.
- Multilingual answers (e.g. English and Indonesian), affecting presentation only, not retrieval or evidence rules.
- A small Express web UI plus CLI commands for indexing and asking.
