# Repo Doctor Rules

Repo Doctor is a deterministic documentation generator inside this project.

## Hard Rules

- Do not require Ollama for Repo Doctor.
- Do not require Qdrant for Repo Doctor.
- Do not call external LLM APIs.
- Do not edit scanned target repositories.
- Use static analysis, regex, and lightweight parsing first.
- Every extracted fact should include source file path when possible.
- Prefer confidence labels: high, medium, low.
- Generated docs must be reproducible from source code.
- Keep modules small and testable.

## Target CLI

npm run doctor -- <root-folder> --output <output-folder>

## Generated Output

- overview.md
- services.md
- env.md
- api.md
- rabbitmq.md
- database.md
- architecture.md

## Architecture Direction

Put Repo Doctor code under:

src/doctor/

Allowed shared modules:

- scanner
- ignore rules
- file utilities
- existing relationship extraction utilities

Avoid importing:

- Ollama clients
- Qdrant clients
- RAG answer generation
- embedding modules

## Testing Direction

Use fixtures for extractor tests.

Required tests:

- package.json extraction
- environment variable extraction
- scanner ignore behavior
- Markdown generation

## Phase Discipline

Repo Doctor must be implemented one phase at a time.

When working on a phase:
- Implement only the requested phase.
- Do not opportunistically add future-phase features.
- Do not add dependencies unrelated to the current phase.
- If a useful future feature is discovered, write it as a future-phase note instead of implementing it.

## Current Phase 2 Boundary

Phase 2 only covers environment variable extraction and env.md generation.

Forbidden during Phase 2:
- .env file parsing
- secret value reading
- env validation
- API route extraction
- RabbitMQ extraction
- SQL/database extraction
- TypeORM extraction
- overview.md
- architecture.md
- Mermaid diagrams
- Ollama/Qdrant/RAG dependency changes
- external LLM APIs
- modifying scanned repositories