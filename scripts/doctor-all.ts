#!/usr/bin/env node
/**
 * Batch script: run Repo Doctor + index-doctor on all repos in a folder.
 * Usage: node --import ./register-ts-node.mjs scripts/doctor-all.ts C:/GIT/work
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { runDoctor } from '../src/doctor/doctor.js';

const targetDir = process.argv[2];
if (!targetDir) {
  console.error('Usage: node --import ./register-ts-node.mjs scripts/doctor-all.ts <repos-folder>');
  process.exit(1);
}

const SKIP = new Set(['Playgrounds', 'node_modules', '.git', 'my_usage.json']);

async function main() {
  const outputBase = path.resolve('./repo-docs-work');
  await fs.mkdir(outputBase, { recursive: true });

  const entries = await fs.readdir(targetDir!, { withFileTypes: true });
  const repos = entries.filter(e => e.isDirectory() && !SKIP.has(e.name)).map(e => e.name);

  console.log(`Found ${repos.length} repos in ${targetDir}\n`);

  const results: { name: string; status: string; services: number; routes: number; db: number; mq: number; env: number }[] = [];

  for (const repo of repos) {
    const repoPath = path.join(targetDir!, repo);
    const outputPath = path.join(outputBase, repo);
    console.log(`\n━━━ ${repo} ━━━`);

    try {
      const report = await runDoctor({
        rootFolder: repoPath,
        outputFolder: outputPath,
        json: true,
        maxFiles: 5000,
        silent: true,
      });
      console.log(`  ✓ ${report.summary.serviceCount} services, ${report.summary.apiRouteCount} routes, ${report.summary.databaseCount} DB, ${report.summary.rabbitMqCount} MQ, ${report.summary.envVarCount} env`);
      results.push({
        name: repo,
        status: 'ok',
        services: report.summary.serviceCount,
        routes: report.summary.apiRouteCount,
        db: report.summary.databaseCount,
        mq: report.summary.rabbitMqCount,
        env: report.summary.envVarCount,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : JSON.stringify(e);
      console.log(`  ✗ ${msg}`);
      results.push({ name: repo, status: `error: ${msg}`, services: 0, routes: 0, db: 0, mq: 0, env: 0 });
    }
  }

  console.log('\n\n━━━ SUMMARY ━━━\n');
  console.log('| Repo | Services | Routes | DB | MQ | Env | Status |');
  console.log('|------|----------|--------|----|----|-----|--------|');
  for (const r of results) {
    console.log(`| ${r.name} | ${r.services} | ${r.routes} | ${r.db} | ${r.mq} | ${r.env} | ${r.status} |`);
  }

  const total = results.filter(r => r.status === 'ok');
  console.log(`\nDone. ${total.length}/${repos.length} repos processed successfully.`);
  console.log(`Output: ${outputBase}`);
  console.log(`\nTo index all into RAG, run:`);
  console.log(`  node --import ./register-ts-node.mjs scripts/index-doctor-all.ts`);
}

main().catch(e => { console.error(e); process.exit(1); });
