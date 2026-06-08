# Local Codebase AI

Local-first RAG prototype for asking questions across one or more locally cloned codebases.

It indexes source files and documentation from local repositories, embeds chunks with Ollama, stores vectors and metadata in Qdrant, then answers questions from retrieved code context. It is read-only and does not edit indexed repositories.

## Stack

- Node.js 20+
- TypeScript
- ts-node
- commander
- Express
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

## Index Documentation

For Docusaurus docs, point the docs indexer at the `docs` folder:

```powershell
npm run index-docs -- C:\GIT\work\tf-documentation\my-website\docs --repo-name tf-documentation
```

For localized Docusaurus docs, index the locale folder too:

```powershell
npm run index-docs -- C:\GIT\work\tf-documentation\my-website\i18n\id\docusaurus-plugin-content-docs\current --repo-name tf-documentation --locale id
```

The docs indexer reads Markdown/MDX files, uses frontmatter `repos` when present, and maps known docs folders like `isignal-docs`, `wallet-docs`, and `devops-docs` to related service repos. Re-running it is incremental: unchanged doc chunks are skipped and stale chunks for the same repo/docs branch are removed. Localized docs are stored under locale-specific docs branches such as `docs:id`, so Indonesian and default docs can coexist. Indonesian questions prefer `id` docs when available and fall back to default docs when a page is still untranslated.

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

`ask` detects the preferred answer language with the local Ollama chat model and falls back to a small local heuristic if detection is unavailable. This only affects presentation; retrieval, source paths, identifiers, and evidence rules stay unchanged.

Start the local web UI:

```powershell
npm run start
```

Then open:

```text
http://localhost:3456
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
- `CALLS_SYMBOL`
- `DEFINES_SYMBOL`
- `TOUCHES_TABLE`

`ask` uses this graph before semantic retrieval for broad flow-style questions. For example, a PHP caller in `ims-tf` can resolve a config constant to an HTTP route, find the matching route handler in `ims-tf2`, inspect that handler for RPC or external API calls, follow same-name downstream functions in another repo, and then follow model/function calls inside that downstream handler.

When a broad concept has multiple matching entrypoints, `ask` returns multiple paths instead of forcing a single best route. This is useful for legacy flows where the same business action exists under MRG, Askap/MMB, or older direct API callers.

## Domain Vocabulary

Generic business questions often use product names, broker names, or domain words that do not exactly match source identifiers. The file `config/services.json` acts as a small local vocabulary registry.

Examples already included:

- `mmb` maps to Askap/MMB-related terms such as `askap`, `AskapController`, and `AskapApps`
- `isignal` maps to `tf2-ois`, `ims-tf2`, signal/channel/subscription terms
- `platform_type` maps to MT4/MT5/metaserver/account-type terms

This helps questions like:

```powershell
npm run ask -- "Berikan list tipe akun mt4 mmb"
npm run ask -- "Berikan list tipe akun mt5 mmb"
npm run ask -- "apa maksud dari platform_type untuk masing masing broker?"
npm run ask -- "apa itu iSignal?"
npm run ask -- "apa saja aturan yang ada di iSignal?"
```

The registry is used as retrieval/disambiguation help only. Answers still have to come from indexed code or documentation sources.

## Current Limits

- This is RAG, not a full static call graph.
- Cross-repo relationships are inferred from relationship edges and retrieved evidence, not guaranteed.
- Chunking is still simple line/character-based.
- Polyglot support uses heuristics, not language parsers.
- Answers should be treated as investigation aids and verified against the cited files.

## Repo Doctor

Repo Doctor is a deterministic documentation generator that scans a local repository and produces structured Markdown files describing its services, environment variables, API routes, RabbitMQ usage, database usage, and architecture diagrams.

It uses static analysis only — no LLMs, no Ollama, no Qdrant, no network calls. Scanned repositories are **read-only and never modified**.

### Basic Usage

```powershell
npm run doctor -- ./services --output ./repo-docs
```

### Generated Files

| File | Contents |
|------|----------|
| `overview.md` | Entry point with summary counts and links |
| `services.md` | Package metadata and dependencies |
| `env.md` | Environment variables detected in source |
| `api.md` | HTTP API routes (Express, Fastify) |
| `rabbitmq.md` | Queues, exchanges, and messaging patterns |
| `database.md` | SQL tables, TypeORM entities, repositories |
| `architecture.md` | Mermaid architecture diagrams |
| `report.json` | Machine-readable report (with `--json`) |

### CLI Options

| Option | Description |
|--------|-------------|
| `--output <folder>` | Output folder for generated docs (required) |
| `--json` | Also write `report.json` beside Markdown files |
| `--fail-on-empty` | Exit non-zero if no services detected |
| `--repo-name <name>` | Only include service matching this package name |
| `--service-type <type>` | Filter by type: `api`, `worker`, `cron`, `library`, `unknown` |
| `--include <glob...>` | Include patterns for file scanning (repeatable) |
| `--exclude <glob...>` | Exclude patterns for file scanning (repeatable) |
| `--max-files <number>` | Stop scanning after N files |
| `--verbose` | Print scan progress and summary counts |
| `--silent` | Suppress all output except errors |

### Example Commands

```powershell
# Basic scan
npm run doctor -- ./services --output ./repo-docs

# With JSON report
npm run doctor -- ./services --output ./repo-docs --json

# Filter by service name
npm run doctor -- ./services --output ./repo-docs --repo-name payment-service

# Scope scanning
npm run doctor -- ./services --output ./repo-docs --include "src/**/*.ts" --exclude "**/*.test.ts"

# Limit file count for large repos
npm run doctor -- ./services --output ./repo-docs --max-files 5000 --verbose
```

### Confidence Labels

Each extracted fact includes a confidence label:

- **high** — pattern match is unambiguous (e.g., `app.get('/path', ...)`)
- **medium** — pattern match is likely but could be a false positive (e.g., `.subscribe(...)`)
- **low** — speculative extraction

### Limitations

- Static analysis only — no runtime or dynamic behavior is captured.
- Regex-based extraction — complex or indirect patterns may be missed.
- No cross-service resolution — relationships are per-repository.
- Confidence labels indicate extraction certainty, not code correctness.
- Results should be verified against source code.

### Running Doctor Tests

```powershell
npm run test:doctor
```

## Useful Commands

```powershell
docker compose ps
docker compose logs qdrant
npm run index -- ../Personal-Site --repo-name personal-site --service-type unknown
npm run ask -- "What is this project about?" --repo-name personal-site --branch main
npx tsc --noEmit
```
