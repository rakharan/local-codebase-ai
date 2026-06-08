import type { EnvVarFact } from '../types.js';
import { deduplicateEnvVars, groupEnvVarsBySource } from '../extractors/env-extractor.js';

/**
 * Generates env.md content from extracted environment variable facts.
 * Pure function: converts structured facts into Markdown.
 */
export function generateEnvMarkdown(facts: EnvVarFact[]): string {
  const lines: string[] = [];

  lines.push('# Environment Variables');
  lines.push('');
  lines.push('This document lists environment variables detected in source files.');
  lines.push('');

  if (facts.length === 0) {
    lines.push('No environment variable references were detected in this repository.');
    lines.push('');
    return lines.join('\n');
  }

  // Summary: deduplicated list
  const unique = deduplicateEnvVars(facts);
  lines.push(`## Summary (${unique.length} unique variables)`);
  lines.push('');
  for (const fact of unique) {
    lines.push(`- \`${fact.name}\` *(confidence: ${fact.confidence})*`);
  }
  lines.push('');

  // Grouped by source file
  const grouped = groupEnvVarsBySource(facts);
  lines.push('## By Source File');
  lines.push('');

  for (const [sourcePath, groupFacts] of grouped) {
    lines.push(`### ${sourcePath}`);
    lines.push('');

    // Deduplicate within a single file, sorted by name
    const seenInFile = new Set<string>();
    for (const fact of groupFacts) {
      if (!seenInFile.has(fact.name)) {
        seenInFile.add(fact.name);
        lines.push(`- \`${fact.name}\` (line ${fact.line}) *(confidence: ${fact.confidence})*`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}