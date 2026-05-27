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

For large legacy repos, preview a narrow scope before embedding:

```powershell
npm run index -- C:/GIT/work/ims-tf `
  --repo-name ims-tf `
  --service-type api `
  --dry-run `
  --include "components/mrg/controllers/**" `
  --include "components/mrg/models/**" `
  --include "components/mrg/includes/**" `
  --include "components/askap/controllers/**" `
  --include "components/askap/models/**" `
  --include "components/askap/includes/**" `
  --include "config.ex.php" `
  --exclude "**/assets/**" `
  --exclude "**/views/**" `
  --exclude "**/templates/**" `
  --exclude "**/libraries/**" `
  --max-chunks 5000
```

Then index the same scope:

```powershell
npm run index -- C:/GIT/work/ims-tf `
  --repo-name ims-tf `
  --service-type api `
  --replace-repo `
  --include "components/mrg/controllers/**" `
  --include "components/mrg/models/**" `
  --include "components/mrg/includes/**" `
  --include "components/askap/controllers/**" `
  --include "components/askap/models/**" `
  --include "components/askap/includes/**" `
  --include "config.ex.php" `
  --exclude "**/assets/**" `
  --exclude "**/views/**" `
  --exclude "**/templates/**" `
  --exclude "**/libraries/**" `
  --max-chunks 5000
```

`--replace-repo` deletes all existing chunks with the same `repoName` before indexing. Use it after an accidental broad index or when changing from a full-repo index to a scoped index.

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

## Answer Regression Tests

After indexing the sample repos you care about, run:

```powershell
npm run test:answers
```

This executes known CLI questions and checks that important evidence strings still appear in the answer. The current cases cover:

- exact endpoint detail lookup for `/mrg/api/v1/deposit/demo/`
- exact symbol lookup for `SubmitDepositDemo`
- PHP `ims-tf` caller lookup for `/mrg/api/v1/account/demo/request/`
- broad `ims-tf` request-account-demo flow discovery, including typo tolerance

These tests require Ollama, Qdrant, and the relevant indexed repos/chunks to be available.

## Incremental Indexing

Reindexing does not embed/upload everything from scratch.

The indexer:

1. Reads and chunks the repo.
2. Computes deterministic chunk hashes.
3. Loads existing Qdrant points for the same repo and branch.
4. Skips unchanged chunks.
5. Embeds and upserts only new or changed chunks.
6. Deletes stale chunks that no longer exist.

Indexing also writes a local relationship graph to `.data/relationships.jsonl`. This graph is refreshed for the indexed repo and branch even when every chunk is skipped as unchanged.

Example:

```text
Found 143 chunks
Found 81 relationship edges
Skipping 143 unchanged chunks
Indexing 0 new or changed chunks
Deleting 0 stale chunks
Done. Indexed 0 chunks, skipped 143, deleted 0 stale chunks and 0 legacy chunks, wrote 81 relationship edges.
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

The indexer also extracts graph edges:

- `CALLS_HTTP_ENDPOINT`
- `HANDLES_HTTP_ENDPOINT`
- `CALLS_RPC_FUNC`
- `CALLS_EXTERNAL_FUNC`
- `DEFINES_SYMBOL`
- `TOUCHES_TABLE`

`ask` uses this graph before semantic retrieval for broad flow-style questions. For example, a PHP caller in `ims-tf` can resolve a config constant to an HTTP route, find the matching route handler in `ims-tf2`, then inspect that handler for RPC or external API calls.

## Current Limits

- This is RAG, not a full static call graph.
- Cross-repo relationships are inferred from relationship edges and retrieved evidence, not guaranteed.
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
