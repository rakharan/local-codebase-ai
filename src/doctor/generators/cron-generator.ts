import type { CronFact } from '../types.js';

/**
 * Generates cron.md content from extracted cron/scheduled task facts.
 */
export function generateCronMarkdown(facts: CronFact[]): string {
  const lines: string[] = [];

  lines.push('# Scheduled Tasks');
  lines.push('');
  lines.push('Cron jobs and scheduled tasks detected in source files.');
  lines.push('');

  if (facts.length === 0) {
    lines.push('No scheduled tasks detected in this repository.');
    lines.push('');
    return lines.join('\n');
  }

  const sorted = [...facts].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath) || a.line - b.line);

  lines.push(`## Summary (${sorted.length} tasks)`);
  lines.push('');
  lines.push('| Expression | Kind | Source | Line | Confidence |');
  lines.push('|------------|------|--------|------|------------|');

  for (const fact of sorted) {
    const label = fact.kind === 'setInterval' ? `${fact.expression}ms` : fact.expression;
    lines.push(`| \`${label}\` | ${fact.kind} | ${fact.sourcePath} | ${fact.line} | ${fact.confidence} |`);
  }
  lines.push('');

  // Group by kind
  const byKind = new Map<string, CronFact[]>();
  for (const fact of sorted) {
    const existing = byKind.get(fact.kind);
    if (existing) existing.push(fact);
    else byKind.set(fact.kind, [fact]);
  }

  lines.push('## By Kind');
  lines.push('');
  for (const [kind, kindFacts] of byKind) {
    lines.push(`### ${kind}`);
    lines.push('');
    for (const fact of kindFacts) {
      const label = fact.kind === 'setInterval' ? `every ${fact.expression}ms` : fact.expression;
      lines.push(`- \`${label}\` (${fact.sourcePath}:${fact.line}) *(confidence: ${fact.confidence})*`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
