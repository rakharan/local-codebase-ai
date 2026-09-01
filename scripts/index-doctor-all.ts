#!/usr/bin/env node
/**
 * Batch script: index all Doctor output folders into RAG.
 * Usage: node --import ./register-ts-node.mjs scripts/index-doctor-all.ts
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { readDoctorFiles, chunkDoctorMarkdown } from '../src/index-doctor.js';
import { buildReportChunks } from '../src/lib/doctor-report-chunks.js';
import type { DoctorReport } from '../src/lib/doctor-report-chunks.js';
import { ensureCollection, qdrant } from '../src/lib/qdrant.js';
import { config } from '../src/lib/config.js';
import { createEmbedding } from '../src/lib/ollama.js';
import type { CodeChunk } from '../src/lib/chunker.js';

const OUTPUT_BASE = path.resolve('./repo-docs-work');
const BRANCH = 'doctor';
const UPSERT_BATCH = 64;

async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency))
  const results: R[] = new Array(items.length)
  let cursor = 0
  async function worker() { while (cursor < items.length) { const i = cursor++; results[i] = await task(items[i]!, i) } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

type ExistingPoint = { id: string | number; payload?: { contentHash?: string } | null };

async function fetchExistingIndex(repoName: string) {
  const ids = new Set<string | number>();
  const hashes = new Set<string>();
  let offset: string | number | Record<string, unknown> | null | undefined;
  do {
    const page = await qdrant.scroll(config.collectionName, {
      filter: { must: [{ key: 'repoName', match: { value: repoName } }, { key: 'branchName', match: { value: BRANCH } }] },
      limit: 256, with_payload: true, with_vector: false,
      ...(offset ? { offset } : {}),
    });
    for (const point of page.points as ExistingPoint[]) {
      ids.add(point.id);
      if (point.payload?.contentHash) hashes.add(point.payload.contentHash);
    }
    offset = page.next_page_offset;
  } while (offset);
  return { ids, hashes };
}

async function upsertChunk(chunk: CodeChunk): Promise<void> {
  const embeddingInput = [
    `Repository: ${chunk.repoName}`, `Branch: ${chunk.branchName}`,
    `Evidence types: ${chunk.evidenceTypes.join(', ')}`,
    `Routes: ${chunk.relationshipHints.routes.join(', ')}`,
    `Queues: ${chunk.relationshipHints.queueNames.join(', ')}`,
    `Database tables: ${chunk.relationshipHints.dbTables.join(', ')}`,
    `File: ${chunk.filePath}`, '', chunk.content,
  ].join('\n');
  const vector = await createEmbedding(embeddingInput);
  await qdrant.upsert(config.collectionName, {
    points: [{
      id: chunk.id, vector,
      payload: {
        repoName: chunk.repoName, projectIds: chunk.projectIds, projectTagSources: chunk.projectTagSources,
        serviceType: chunk.serviceType, branchName: chunk.branchName, commitSha: chunk.commitSha,
        evidenceTypes: chunk.evidenceTypes, routes: chunk.relationshipHints.routes,
        symbols: chunk.relationshipHints.symbols, messageNames: chunk.relationshipHints.messageNames,
        queueNames: chunk.relationshipHints.queueNames, exchangeNames: chunk.relationshipHints.exchangeNames,
        dbTables: chunk.relationshipHints.dbTables, structuredFacts: chunk.structuredFacts,
        filePath: chunk.filePath, startLine: chunk.startLine, endLine: chunk.endLine,
        content: chunk.content, contentHash: chunk.contentHash,
      },
    }],
  });
}

async function main() {
  const entries = await fs.readdir(OUTPUT_BASE, { withFileTypes: true });
  const repos = entries.filter(e => e.isDirectory()).map(e => e.name);
  console.log(`Found ${repos.length} doctor output folders in ${OUTPUT_BASE}\n`);

  await ensureCollection();

  for (const repo of repos) {
    const repoDocsPath = path.join(OUTPUT_BASE, repo);
    const repoName = `${repo}-docs`;
    console.log(`\n━━━ ${repo} → ${repoName}@${BRANCH} ━━━`);

    const files = await readDoctorFiles(repoDocsPath);
    const allChunks: CodeChunk[] = [];
    for (const file of files) {
      allChunks.push(...chunkDoctorMarkdown(file, repoName));
    }

    // Load report.json facts
    try {
      const reportContent = await fs.readFile(path.join(repoDocsPath, 'report.json'), 'utf8');
      const report: DoctorReport = JSON.parse(reportContent);
      allChunks.push(...buildReportChunks(report, repoName));
    } catch { /* no report.json */ }

    const existing = await fetchExistingIndex(repoName);
    const currentIds = new Set(allChunks.map(c => c.id));
    const staleIds = [...existing.ids].filter(id => !currentIds.has(String(id)));
    const toIndex = allChunks.filter(c => !existing.hashes.has(c.contentHash));

    console.log(`  Chunks: ${allChunks.length} total, ${toIndex.length} new, ${staleIds.length} stale`);

    if (staleIds.length > 0) {
      await qdrant.delete(config.collectionName, { wait: true, points: staleIds });
    }

    let indexed = 0;
    // Phase 1: compute embeddings concurrently
    const points = await mapWithConcurrency(toIndex, config.indexConcurrency, async (chunk) => {
      const embeddingInput = [
        `Repository: ${chunk.repoName}`, `Branch: ${chunk.branchName}`,
        `Evidence types: ${chunk.evidenceTypes.join(', ')}`,
        `Routes: ${chunk.relationshipHints.routes.join(', ')}`,
        `Queues: ${chunk.relationshipHints.queueNames.join(', ')}`,
        `Database tables: ${chunk.relationshipHints.dbTables.join(', ')}`,
        `File: ${chunk.filePath}`, '', chunk.content,
      ].join('\n');
      const vector = await createEmbedding(embeddingInput);
      indexed++;
      if (indexed % 20 === 0) console.log(`    ${indexed}/${toIndex.length}...`);
      return {
        id: chunk.id, vector,
        payload: {
          repoName: chunk.repoName, projectIds: chunk.projectIds, projectTagSources: chunk.projectTagSources,
          serviceType: chunk.serviceType, branchName: chunk.branchName, commitSha: chunk.commitSha,
          evidenceTypes: chunk.evidenceTypes, routes: chunk.relationshipHints.routes,
          symbols: chunk.relationshipHints.symbols, messageNames: chunk.relationshipHints.messageNames,
          queueNames: chunk.relationshipHints.queueNames, exchangeNames: chunk.relationshipHints.exchangeNames,
          dbTables: chunk.relationshipHints.dbTables, structuredFacts: chunk.structuredFacts,
          filePath: chunk.filePath, startLine: chunk.startLine, endLine: chunk.endLine,
          content: chunk.content, contentHash: chunk.contentHash,
        },
      };
    });

    // Phase 2: batch upsert to Qdrant
    for (let i = 0; i < points.length; i += UPSERT_BATCH) {
      await qdrant.upsert(config.collectionName, { points: points.slice(i, i + UPSERT_BATCH) });
    }
    console.log(`  Done: ${indexed} indexed, ${allChunks.length - toIndex.length} skipped, ${staleIds.length} deleted`);
  }

  console.log('\n✅ All repos indexed.');
}

main().catch(e => { console.error(e); process.exit(1); });
