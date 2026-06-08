import type { ApiRouteFact } from '../types.js';

/**
 * Generates api.md content from extracted API route facts.
 * Pure function: converts structured facts into Markdown.
 */
export function generateApiMarkdown(facts: ApiRouteFact[]): string {
  const lines: string[] = [];

  lines.push('# API Routes');
  lines.push('');
  lines.push('This document lists HTTP API routes detected in source files.');
  lines.push('');

  if (facts.length === 0) {
    lines.push('No HTTP routes were detected in this repository.');
    lines.push('');
    return lines.join('\n');
  }

  // Sort deterministically: by path, then method, then sourcePath, then line
  const sorted = [...facts].sort((a, b) => {
    const pathCmp = a.path.localeCompare(b.path);
    if (pathCmp !== 0) return pathCmp;
    const methodCmp = a.method.localeCompare(b.method);
    if (methodCmp !== 0) return methodCmp;
    const srcCmp = a.sourcePath.localeCompare(b.sourcePath);
    if (srcCmp !== 0) return srcCmp;
    return a.line - b.line;
  });

  // Summary table
  lines.push(`## Summary (${sorted.length} routes)`);
  lines.push('');
  lines.push('| Method | Path | Framework | Source | Line | Confidence |');
  lines.push('|--------|------|-----------|--------|------|------------|');

  for (const fact of sorted) {
    lines.push(`| ${fact.method} | \`${fact.path}\` | ${fact.framework} | ${fact.sourcePath} | ${fact.line} | ${fact.confidence} |`);
  }
  lines.push('');

  // Group by source file
  const grouped = groupBySource(sorted);
  lines.push('## By Source File');
  lines.push('');

  for (const [sourcePath, groupFacts] of grouped) {
    lines.push(`### ${sourcePath}`);
    lines.push('');
    for (const fact of groupFacts) {
      lines.push(`- **${fact.method}** \`${fact.path}\` (line ${fact.line}, ${fact.framework}) *(confidence: ${fact.confidence})*`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function groupBySource(facts: ApiRouteFact[]): Map<string, ApiRouteFact[]> {
  const groups = new Map<string, ApiRouteFact[]>();

  for (const fact of facts) {
    const existing = groups.get(fact.sourcePath);
    if (existing) {
      existing.push(fact);
    } else {
      groups.set(fact.sourcePath, [fact]);
    }
  }

  return new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)));
}