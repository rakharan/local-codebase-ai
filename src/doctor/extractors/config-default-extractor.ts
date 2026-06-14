import type { ConfigDefaultFact, ConfigDefaultOperator } from '../types.js';

const CONFIG_DEFAULT_PATTERN =
  /process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[['"]([A-Z_][A-Z0-9_]*)['"]\])\s*(\|\||\?\?)\s*(["'`])([^"'`]*?)\4/g;

const BUSINESS_RULE_HINT =
  /MIN|MAX|MINIMUM|MAXIMUM|LIMIT|ENABLE|DISABLE|FEE|PRICE|AMOUNT|EQUITY|BALANCE|MARGIN|LEVERAGE|DURATION|EXPIRE|EXPIRY|TIMEOUT|RETRY|THRESHOLD|PERCENT|RATE|COUNT|LEVEL|MEDAL/i;

export function extractConfigDefaults(content: string, sourcePath: string): ConfigDefaultFact[] {
  const facts: ConfigDefaultFact[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    CONFIG_DEFAULT_PATTERN.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = CONFIG_DEFAULT_PATTERN.exec(line)) !== null) {
      const envName = match[1] ?? match[2];
      const operator = match[3] as ConfigDefaultOperator;
      const defaultValue = match[5] ?? '';
      if (!envName) continue;

      facts.push({
        envName,
        defaultValue,
        operator,
        sourcePath,
        line: i + 1,
        expression: match[0],
        businessRuleCandidate: BUSINESS_RULE_HINT.test(envName),
        confidence: 'high',
      });
    }
  }

  return facts;
}

