import type { ConfigDefaultFact } from '../types.js';

export function generateConfigMarkdown(facts: ConfigDefaultFact[]): string {
  const lines: string[] = [];

  lines.push('# Configuration Defaults');
  lines.push('');
  lines.push('Environment-backed configuration defaults detected in source.');
  lines.push('');

  if (facts.length === 0) {
    lines.push('No static config defaults detected.');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('| Env var | Default | Operator | Source | Business-rule candidate | Confidence |');
  lines.push('|---------|---------|----------|--------|-------------------------|------------|');

  for (const fact of [...facts].sort(sortConfigFacts)) {
    lines.push([
      `| \`${fact.envName}\``,
      `\`${escapeCell(fact.defaultValue)}\``,
      `\`${fact.operator}\``,
      `${fact.sourcePath}:${fact.line}`,
      fact.businessRuleCandidate ? 'yes' : 'no',
      fact.confidence,
      '|',
    ].join(' '));
  }

  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- These values are fallback defaults from source code; runtime environment values can override them.');
  lines.push('- Business-rule candidate means the variable name looks like a product rule, threshold, price, limit, or feature flag.');
  lines.push('');

  return lines.join('\n');
}

function sortConfigFacts(a: ConfigDefaultFact, b: ConfigDefaultFact): number {
  const name = a.envName.localeCompare(b.envName);
  if (name !== 0) return name;
  const source = a.sourcePath.localeCompare(b.sourcePath);
  if (source !== 0) return source;
  return a.line - b.line;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

