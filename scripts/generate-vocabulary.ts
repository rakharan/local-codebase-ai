#!/usr/bin/env node
/**
 * Auto-generates config/services.json entries from Doctor reports.
 * Adds entries for repos not already covered.
 * Usage: node --import ./register-ts-node.mjs scripts/generate-vocabulary.ts
 */
import path from 'node:path';
import fs from 'node:fs/promises';

const DOCTOR_OUTPUT = path.resolve('./repo-docs-work');
const SERVICES_FILE = path.resolve('./config/services.json');

interface ServiceEntry {
  name: string;
  kind: string;
  projectId?: string;
  description?: string;
  aliases: string[];
  repos: string[];
  keywords?: string[];
  [key: string]: unknown;
}

interface ServicesConfig {
  entries: ServiceEntry[];
}

interface DoctorReport {
  services: Array<{ metadata: Array<{ value: string }>; dependencies: Array<{ value: string }> }>;
  envVars: Array<{ name: string }>;
  apiRoutes: Array<{ path: string }>;
  rabbitMq: Array<{ name: string }>;
  database: Array<{ name: string }>;
  summary: { serviceCount: number; envVarCount: number; apiRouteCount: number; rabbitMqCount: number; databaseCount: number };
}

async function main() {
  const config: ServicesConfig = JSON.parse(await fs.readFile(SERVICES_FILE, 'utf8'));
  const existingRepos = new Set(config.entries.flatMap(e => e.repos));

  const entries = await fs.readdir(DOCTOR_OUTPUT, { withFileTypes: true });
  const repos = entries.filter(e => e.isDirectory()).map(e => e.name);

  let added = 0;

  for (const repo of repos) {
    if (existingRepos.has(repo)) continue;

    const reportPath = path.join(DOCTOR_OUTPUT, repo, 'report.json');
    let report: DoctorReport;
    try {
      report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    } catch { continue; }

    if (report.summary.serviceCount === 0 && report.summary.apiRouteCount === 0 && report.summary.databaseCount === 0) continue;

    const pkgName = report.services[0]?.metadata.find(m => m.value.startsWith('Package name:'))?.value.replace('Package name: ', '') ?? repo;
    const topDeps = report.services[0]?.dependencies.slice(0, 5).map(d => d.value.split(':')[0]!.trim()) ?? [];
    const topQueues = report.rabbitMq.slice(0, 3).map(q => q.name);
    const topTables = [...new Set(report.database.map(d => d.name))].slice(0, 5);

    // Infer kind from dependencies/routes
    let kind = 'service';
    if (report.summary.apiRouteCount > 0) kind = 'api';
    else if (report.summary.rabbitMqCount > 0) kind = 'worker';
    else if (topDeps.some(d => d.includes('cron'))) kind = 'cron';
    else if (report.summary.serviceCount > 0 && report.summary.apiRouteCount === 0) kind = 'library';

    // Build description from summary
    const parts: string[] = [];
    if (report.summary.apiRouteCount > 0) parts.push(`${report.summary.apiRouteCount} API routes`);
    if (report.summary.databaseCount > 0) parts.push(`${report.summary.databaseCount} DB usages`);
    if (report.summary.rabbitMqCount > 0) parts.push(`${report.summary.rabbitMqCount} RabbitMQ connections`);
    if (report.summary.envVarCount > 0) parts.push(`${report.summary.envVarCount} env vars`);
    const description = parts.length > 0 ? `${pkgName} (${kind}): ${parts.join(', ')}` : undefined;

    const entry: ServiceEntry = {
      name: repo,
      kind,
      aliases: [repo, pkgName].filter((v, i, a) => a.indexOf(v) === i),
      repos: [repo],
      keywords: [...topDeps, ...topQueues, ...topTables].filter(Boolean).slice(0, 15),
    };
    if (description) entry.description = description;

    config.entries.push(entry);
    existingRepos.add(repo);
    added++;
    console.log(`+ ${repo} (${kind}): ${description ?? 'no summary'}`);
  }

  await fs.writeFile(SERVICES_FILE, JSON.stringify(config, null, 2) + '\n', 'utf8');
  console.log(`\nDone. Added ${added} entries. Total: ${config.entries.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
