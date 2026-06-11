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
npx tsx src/index-repo.ts C:\GIT\work\ims-tf --replace-repo --service-type api
npx tsx src/index-repo.ts C:\GIT\work\tf2-migrations --replace-repo
npx tsx src/index-repo.ts C:\GIT\work\mrg-migrations --replace-repo
```

> **ims-tf2 already done** — skip if it was indexed today.

## Step 2 — Re-run merge-graphs after all repos are indexed

```powershell
npx tsx src/merge-graphs.ts
```

This rewrites all `CROSS_REPO_LINK` edges based on fresh data.

## Step 3 — Dry-run to verify chunk counts (optional)

```powershell
npx tsx src/index-repo.ts C:\GIT\work\<repo> --dry-run
```

Check that chunk count is higher than before (method-level splitting should increase count).

## Notes

- Schema version is now `branches-v2` — `--replace-repo` is required to clear old `branches-v1` chunks
- If a repo path differs from above, adjust accordingly
- `mmb-migrations` — check if it exists before indexing, it was not indexed before
