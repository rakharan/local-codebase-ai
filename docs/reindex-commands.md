# Reindex Commands

Run these from `C:\GIT\personal\local-codebase-ai`.

## Step 1 — Re-index all repos with new chunker (branches-v2)

Run each command one at a time. They are CPU-heavy — wait for each to finish before starting the next.

```powershell
npx tsx src/index-repo.ts C:\GIT\work\ims-tf2 --replace-repo --service-type api
npx tsx src/index-repo.ts C:\GIT\work\tf2-ois --replace-repo --service-type api
npx tsx src/index-repo.ts C:\GIT\work\tf2-ois-admin --replace-repo --service-type api
npx tsx src/index-repo.ts C:\GIT\work\tf2-admin --replace-repo --service-type api
npx tsx src/index-repo.ts C:\GIT\work\tf2-sinyo --replace-repo --service-type api
npx tsx src/index-repo.ts C:\GIT\work\tf2-microservice --replace-repo --service-type worker
npx tsx src/index-repo.ts C:\GIT\work\tf2-mt4-manager --replace-repo --service-type worker
npx tsx src/index-repo.ts C:\GIT\work\tf2-mt5-manager --replace-repo --service-type worker
npx tsx src/index-repo.ts C:\GIT\work\mrg-accounts --replace-repo --service-type worker
npx tsx src/index-repo.ts C:\GIT\work\fa-trade-publisher --replace-repo --service-type worker
npx tsx src/index-repo.ts C:\GIT\work\tf-email-sender --replace-repo --service-type worker
npx tsx src/index-repo.ts C:\GIT\work\mt5-wrapper --replace-repo
npx tsx src/index-repo.ts C:\GIT\work\ims-tf --replace-repo --service-type library --exclude "templates/**" --exclude "css/**" --exclude "images/**" --exclude "avatar/**" --exclude "php/**" --exclude "nginx/**" --exclude "docker/**" --exclude "**/views/**" --exclude "**/assets/**" --exclude "libraries/**" --exclude "plugins/**" --exclude "review/**"
npx tsx src/index-repo.ts C:\GIT\work\tf2-migrations --replace-repo
npx tsx src/index-repo.ts C:\GIT\work\mrg-migrations --replace-repo
```

> **Already done:** `ims-tf2` ✅, `tf2-ois` ✅

## Step 2 — Run doctor on all repos

Generates structured `database.md`, `api.md`, `rabbitmq.md` etc per repo.
Required for cross-repo table/queue/service queries to surface all repos in answers.

```powershell
npm run doctor -- C:\GIT\work\ims-tf2 --output .data\doctor-output\ims-tf2 --json --verbose
npm run doctor -- C:\GIT\work\tf2-ois --output .data\doctor-output\tf2-ois --json --verbose
npm run doctor -- C:\GIT\work\tf2-ois-admin --output .data\doctor-output\tf2-ois-admin --json --verbose
npm run doctor -- C:\GIT\work\tf2-admin --output .data\doctor-output\tf2-admin --json --verbose
npm run doctor -- C:\GIT\work\tf2-sinyo --output .data\doctor-output\tf2-sinyo --json --verbose
npm run doctor -- C:\GIT\work\tf2-microservice --output .data\doctor-output\tf2-microservice --json --verbose
npm run doctor -- C:\GIT\work\tf2-mt4-manager --output .data\doctor-output\tf2-mt4-manager --json --verbose
npm run doctor -- C:\GIT\work\tf2-mt5-manager --output .data\doctor-output\tf2-mt5-manager --json --verbose
npm run doctor -- C:\GIT\work\mrg-accounts --output .data\doctor-output\mrg-accounts --json --verbose
npm run doctor -- C:\GIT\work\fa-trade-publisher --output .data\doctor-output\fa-trade-publisher --json --verbose
npm run doctor -- C:\GIT\work\tf-email-sender --output .data\doctor-output\tf-email-sender --json --verbose
npm run doctor -- C:\GIT\work\mt5-wrapper --output .data\doctor-output\mt5-wrapper --json --verbose
npm run doctor -- C:\GIT\work\ims-tf --output .data\doctor-output\ims-tf --json --verbose
```

> **Already done:** `tf2-ois` ✅

## Step 3 — Index doctor output into Qdrant

```powershell
npm run index-doctor -- .data\doctor-output\ims-tf2 --repo-name ims-tf2
npm run index-doctor -- .data\doctor-output\tf2-ois --repo-name tf2-ois
npm run index-doctor -- .data\doctor-output\tf2-ois-admin --repo-name tf2-ois-admin
npm run index-doctor -- .data\doctor-output\tf2-admin --repo-name tf2-admin
npm run index-doctor -- .data\doctor-output\tf2-sinyo --repo-name tf2-sinyo
npm run index-doctor -- .data\doctor-output\tf2-microservice --repo-name tf2-microservice
npm run index-doctor -- .data\doctor-output\tf2-mt4-manager --repo-name tf2-mt4-manager
npm run index-doctor -- .data\doctor-output\tf2-mt5-manager --repo-name tf2-mt5-manager
npm run index-doctor -- .data\doctor-output\mrg-accounts --repo-name mrg-accounts
npm run index-doctor -- .data\doctor-output\fa-trade-publisher --repo-name fa-trade-publisher
npm run index-doctor -- .data\doctor-output\tf-email-sender --repo-name tf-email-sender
npm run index-doctor -- .data\doctor-output\mt5-wrapper --repo-name mt5-wrapper
npm run index-doctor -- .data\doctor-output\ims-tf --repo-name ims-tf
```

> **Already done:** `tf2-ois` ✅ (1775 chunks)

## Step 4 — Re-run merge-graphs after all repos are indexed

```powershell
npx tsx src/merge-graphs.ts
```

This rewrites all `CROSS_REPO_LINK` edges based on fresh data.

## Step 5 — Dry-run to verify chunk counts (optional)

```powershell
npx tsx src/index-repo.ts C:\GIT\work\<repo> --dry-run
```

## Notes

- Schema version is now `branches-v2` — `--replace-repo` is required to clear old `branches-v1` chunks
- If a repo path differs from above, adjust accordingly
- `mmb-migrations` — check if it exists before indexing, not indexed before
- `ims-tf` — PHP frontend/legacy, exclude templates/libraries/plugins to avoid noise (4317 chunks vs 16k raw)
- `ims-mrg`, `ims-askap` — not found in `C:\GIT\work\`. Clone them first before indexing
- Doctor output is stored in `.data/doctor-output/<repo>/` — safe to re-run, overwrites previous output
