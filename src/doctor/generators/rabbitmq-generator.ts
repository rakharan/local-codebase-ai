import type { RabbitMqFact } from '../types.js';

/**
 * Generates rabbitmq.md content from extracted RabbitMQ facts.
 */
export function generateRabbitMqMarkdown(facts: RabbitMqFact[]): string {
  const lines: string[] = [];

  lines.push('# RabbitMQ Usage');
  lines.push('');
  lines.push('This document lists RabbitMQ queues, exchanges, and messaging patterns detected in source files.');
  lines.push('');

  if (facts.length === 0) {
    lines.push('No RabbitMQ usage was detected in this repository.');
    lines.push('');
    return lines.join('\n');
  }

  const sorted = [...facts].sort((a, b) => {
    const typeCmp = a.messageType.localeCompare(b.messageType);
    if (typeCmp !== 0) return typeCmp;
    const nameCmp = a.name.localeCompare(b.name);
    if (nameCmp !== 0) return nameCmp;
    const srcCmp = a.sourcePath.localeCompare(b.sourcePath);
    if (srcCmp !== 0) return srcCmp;
    return a.line - b.line;
  });

  lines.push(`## Summary (${sorted.length} usages)`);
  lines.push('');
  lines.push('| Name | Type | Operation | Source | Line | Confidence |');
  lines.push('|------|------|-----------|--------|------|------------|');

  for (const fact of sorted) {
    lines.push(`| \`${fact.name}\` | ${fact.messageType} | ${fact.operation} | ${fact.sourcePath} | ${fact.line} | ${fact.confidence} |`);
  }
  lines.push('');

  // Group by messageType
  const grouped = new Map<string, RabbitMqFact[]>();
  for (const fact of sorted) {
    const existing = grouped.get(fact.messageType);
    if (existing) existing.push(fact);
    else grouped.set(fact.messageType, [fact]);
  }

  lines.push('## By Type');
  lines.push('');

  for (const [type, groupFacts] of grouped) {
    lines.push(`### ${type}`);
    lines.push('');
    for (const fact of groupFacts) {
      lines.push(`- \`${fact.name}\` — ${fact.operation} (${fact.sourcePath}:${fact.line}) *(confidence: ${fact.confidence})*`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
