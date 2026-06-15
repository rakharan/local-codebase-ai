import type { HttpClientFact } from '../types.js';

/**
 * Generates http-clients.md content from extracted HTTP client facts.
 * Shows outbound calls per source file — useful for mapping cross-service dependencies.
 */
export function generateHttpClientMarkdown(facts: HttpClientFact[]): string {
  const lines: string[] = [];

  lines.push('# Outbound HTTP Calls');
  lines.push('');
  lines.push('Outbound HTTP client calls detected in source files. Useful for tracing cross-service dependencies (e.g. PHP → Node endpoints).');
  lines.push('');

  if (facts.length === 0) {
    lines.push('No outbound HTTP calls detected in this repository.');
    lines.push('');
    return lines.join('\n');
  }

  const sorted = [...facts].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath) || a.line - b.line);

  lines.push(`## Summary (${sorted.length} calls)`);
  lines.push('');
  lines.push('| Method | URL / Hint | Library | Source | Line | Confidence |');
  lines.push('|--------|-----------|---------|--------|------|------------|');

  for (const fact of sorted) {
    lines.push(`| ${fact.method} | \`${fact.urlHint}\` | ${fact.lib} | ${fact.sourcePath} | ${fact.line} | ${fact.confidence} |`);
  }
  lines.push('');

  // Group by source file
  const byFile = new Map<string, HttpClientFact[]>();
  for (const fact of sorted) {
    const existing = byFile.get(fact.sourcePath);
    if (existing) existing.push(fact);
    else byFile.set(fact.sourcePath, [fact]);
  }

  lines.push('## By File');
  lines.push('');
  for (const [file, fileFacts] of byFile) {
    lines.push(`### ${file}`);
    lines.push('');
    for (const fact of fileFacts) {
      lines.push(`- \`${fact.method} ${fact.urlHint}\` via **${fact.lib}** (line ${fact.line}) *(confidence: ${fact.confidence})*`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
