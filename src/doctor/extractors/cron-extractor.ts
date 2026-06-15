import type { CronFact, CronScheduleKind, ConfidenceLabel } from '../types.js';

interface PatternDef {
  regex: RegExp;
  kind: CronScheduleKind;
  confidence: ConfidenceLabel;
  expressionGroup: number;
}

const PATTERNS: PatternDef[] = [
  // node-cron: cron.schedule('0 * * * *', ...)
  { regex: /\bcron\.schedule\(\s*['"`]([^'"`]+)['"`]/g, kind: 'node-cron', confidence: 'high', expressionGroup: 1 },
  // NestJS @Cron('0 * * * *') or @Cron(CronExpression.EVERY_HOUR)
  { regex: /@Cron\(\s*['"`]([^'"`]+)['"`]/g, kind: 'nestjs', confidence: 'high', expressionGroup: 1 },
  { regex: /@Cron\(\s*(CronExpression\.\w+)/g, kind: 'nestjs', confidence: 'high', expressionGroup: 1 },
  // setInterval(fn, ms) — capture the ms value
  { regex: /\bsetInterval\s*\([^,]+,\s*(\d+)\s*\)/g, kind: 'setInterval', confidence: 'medium', expressionGroup: 1 },
];

function isIgnoredFile(sourcePath: string): boolean {
  const lower = sourcePath.toLowerCase();
  if (lower.endsWith('.json') || lower.endsWith('.md')) return true;
  if (lower.includes('node_modules')) return true;
  // skip vendored/minified frontend assets
  if (lower.includes('/vendor/') || lower.includes('/assets/') || lower.includes('/plugins/')) return true;
  if (lower.endsWith('.min.js') || lower.endsWith('.min.css')) return true;
  // skip well-known frontend libraries
  const base = lower.split('/').pop() ?? '';
  if (base.startsWith('jquery') || base.startsWith('bootstrap') || base.startsWith('lazysizes')) return true;
  // PHP files don't use setInterval/node-cron for scheduling
  if (lower.endsWith('.php')) return true;
  return false;
}

/**
 * Extracts scheduled/cron task definitions from Node/JS/TS source files.
 */
export function extractCron(content: string, sourcePath: string): CronFact[] {
  if (isIgnoredFile(sourcePath)) return [];

  const facts: CronFact[] = [];
  const lines = content.split('\n');
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNumber = i + 1;

    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue;

    for (const pattern of PATTERNS) {
      pattern.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.regex.exec(line)) !== null) {
        const expression = match[pattern.expressionGroup]!.trim();
        const key = `${expression}|${pattern.kind}|${lineNumber}`;
        if (seen.has(key)) continue;
        seen.add(key);
        facts.push({ expression, kind: pattern.kind, sourcePath, line: lineNumber, confidence: pattern.confidence });
      }
    }
  }

  return facts;
}
