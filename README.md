# Local Codebase AI

CLI-only, local-first RAG prototype for asking questions across one or more locally cloned codebases.

It indexes source files from local repositories, embeds chunks with Ollama, stores vectors and metadata in Qdrant, then answers questions from retrieved code context. It is read-only and does not edit indexed repositories.

## Stack

- Node.js 20+
- TypeScript
- ts-node
- commander
- fast-glob
- ignore
- Ollama local API
- Qdrant via Docker Compose

Default models:

- Embeddings: `nomic-embed-text`
- Chat: `qwen2.5-coder:3b`

## Setup

```powershell
npm install
docker compose up -d
ollama pull nomic-embed-text
ollama pull qwen2.5-coder:3b
```

Optional environment variables:

```powershell
$env:QDRANT_URL="http://localhost:6333"
$env:OLLAMA_URL="http://localhost:11434"
$env:QDRANT_COLLECTION="code_chunks"
$env:EMBEDDING_MODEL="nomic-embed-text"
$env:CHAT_MODEL="qwen2.5-coder:3b"
$env:VECTOR_SIZE="768"
```

## Index A Repo

```powershell
npm run index -- ../payment-service --repo-name payment-service --service-type api
npm run index -- ../notification-service --repo-name notification-service --service-type worker
```

Supported service types:

- `api`
- `worker`
- `cron`
- `library`
- `unknown`

If `--repo-name` is omitted, the folder name is used. If `--service-type` is omitted, `unknown` is used.

## Branches

The indexer reads the currently checked-out Git branch and commit from the target repo.

```powershell
cd ../payment-service
git switch main

cd ../local-codebase-ai
npm run index -- ../payment-service --repo-name payment-service --service-type api
```

Each chunk stores:

- `repoName`
- `serviceType`
- `branchName`
- `commitSha`
- source file path and line range

Indexing is scoped by `repoName + branchName`, so indexing `main` does not delete chunks from another branch.

## Ask Questions

Search across all indexed repos:

```powershell
npm run ask -- "When payment succeeds, which services are involved?"
npm run ask -- "Which service publishes or consumes RabbitMQ messages?"
npm run ask -- "Which services use subscription tables?"
```

Filter by repo, branch, or service type:

```powershell
npm run ask -- "How does /hello work?" --repo-name payment-service
npm run ask -- "How does /hello work?" --repo-name payment-service --branch main
npm run ask -- "Which API routes exist?" --service-type api
```

Limit retrieved chunks:

```powershell
npm run ask -- "What database tables are used by request account flow?" --limit 12
```

## Incremental Indexing

Reindexing does not embed/upload everything from scratch.

The indexer:

1. Reads and chunks the repo.
2. Computes deterministic chunk hashes.
3. Loads existing Qdrant points for the same repo and branch.
4. Skips unchanged chunks.
5. Embeds and upserts only new or changed chunks.
6. Deletes stale chunks that no longer exist.

Example:

```text
Found 143 chunks
Skipping 143 unchanged chunks
Indexing 0 new or changed chunks
Deleting 0 stale chunks
Done. Indexed 0 chunks, skipped 143, deleted 0 stale chunks and 0 legacy chunks.
```

## Indexed Files

The indexer supports TypeScript, JavaScript, PHP, Go, C/C++, SQL, Markdown, YAML, JSON, and common config/build files.

Examples:

- `.ts`, `.tsx`, `.js`, `.jsx`
- `.php`, `.phtml`, `.inc`
- `.go`
- `.c`, `.cc`, `.cpp`, `.cxx`, `.h`, `.hpp`
- `.sql`, `.md`, `.json`, `.yml`, `.yaml`
- `.proto`, `.toml`, `.ini`, `.conf`, `.properties`, `.xml`
- `Dockerfile`, `Jenkinsfile`, `Makefile`, `go.mod`, `composer.json`

It also reads the target repo's `.gitignore`.

Ignored by default:

- dependency folders like `node_modules`, `vendor`, `third_party`
- build/output folders like `dist`, `build`, `.next`, `.turbo`, `.cache`
- secrets like `.env`, keys, pem files
- lockfiles and archives
- media, fonts, binaries, dumps, local databases
- files larger than 1 MB

## Metadata

Chunks store evidence hints to improve retrieval:

- `api_route`
- `controller`
- `rabbitmq_publisher`
- `rabbitmq_consumer`
- `typeorm_entity`
- `db_model`
- `migration`
- `raw_sql`
- `env_config`
- `docker_config`
- `ci_config`
- `cron_job`
- `shell_script`
- `test`
- `documentation`
- `unknown`

Chunks also store relationship hints:

- routes
- symbols/functions/classes
- message or RPC names
- queue names
- exchange names
- database table names

`ask` uses these hints for a second retrieval pass on flow-style questions, so a route in one repo can pull related consumers or handlers from another repo when they share a symbol/message name.

## Current Limits

- This is RAG, not a full static call graph.
- Cross-repo relationships are inferred from retrieved evidence, not guaranteed.
- Chunking is still simple line/character-based.
- Polyglot support uses heuristics, not language parsers.
- Answers should be treated as investigation aids and verified against the cited files.

## Useful Commands

```powershell
docker compose ps
docker compose logs qdrant
npm run index -- ../Personal-Site --repo-name personal-site --service-type unknown
npm run ask -- "What is this project about?" --repo-name personal-site --branch main
npx tsc --noEmit
```
