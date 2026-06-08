import type { DatabaseFact } from '../types.js';

/**
 * Generates database.md content from extracted database facts.
 */
export function generateDatabaseMarkdown(facts: DatabaseFact[]): string {
  const lines: string[] = [];

  lines.push('# Database Usage');
  lines.push('');
  lines.push('This document lists SQL tables, TypeORM entities, and repository usage detected in source files.');
  lines.push('');

  if (facts.length === 0) {
    lines.push('No database usage was detected in this repository.');
    lines.push('');
    return lines.join('\n');
  }

  const sorted = [...facts].sort((a, b) => {
    const kindCmp = a.kind.localeCompare(b.kind);
    if (kindCmp !== 0) return kindCmp;
    const nameCmp = a.name.localeCompare(b.name);
    if (nameCmp !== 0) return nameCmp;
    const srcCmp = a.sourcePath.localeCompare(b.sourcePath);
    if (srcCmp !== 0) return srcCmp;
    return a.line - b.line;
  });

  // Deduplicated summary by name
  const tableMap = new Map<string, { kind: string; operations: Set<string>; sources: Set<string>; count: number }>();
  for (const fact of sorted) {
    const existing = tableMap.get(fact.name);
    if (existing) {
      existing.operations.add(fact.operation);
      existing.sources.add(fact.sourcePath);
      existing.count++;
    } else {
      tableMap.set(fact.name, { kind: fact.kind, operations: new Set([fact.operation]), sources: new Set([fact.sourcePath]), count: 1 });
    }
  }

  lines.push(`## Tables (${tableMap.size} unique)`);
  lines.push('');
  lines.push('| Name | Kind | Operations | Sources | Usages |');
  lines.push('|------|------|-----------|---------|--------|');

  for (const [name, info] of tableMap) {
    const ops = [...info.operations].sort().join(', ');
    lines.push(`| \`${name}\` | ${info.kind} | ${ops} | ${info.sources.size} files | ${info.count} |`);
  }
  lines.push('');

  // Detail table
  lines.push(`## Detail (${sorted.length} usages)`);
  lines.push('');
  lines.push('| Name | Kind | Operation | Source | Line | Confidence |');
  lines.push('|------|------|-----------|--------|------|------------|');

  for (const fact of sorted) {
    lines.push(`| \`${fact.name}\` | ${fact.kind} | ${fact.operation} | ${fact.sourcePath} | ${fact.line} | ${fact.confidence} |`);
  }
  lines.push('');

  return lines.join('\n');
}
