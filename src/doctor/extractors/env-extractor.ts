import type { EnvVarFact } from '../types.js';

/**
 * Regex patterns for static env var access:
 * - process.env.VARIABLE_NAME
 * - process.env["VARIABLE_NAME"]
 * - process.env['VARIABLE_NAME']
 *
 * Dynamic access like process.env[variable] is intentionally ignored.
 */
const ENV_DOT_PATTERN = /process\.env\.([A-Z_][A-Z0-9_]*)/g;
const ENV_BRACKET_DOUBLE_PATTERN = /process\.env\["([A-Z_][A-Z0-9_]*)"\]/g;
const ENV_BRACKET_SINGLE_PATTERN = /process\.env\['([A-Z_][A-Z0-9_]*)'\]/g;

/**
 * Extracts environment variable references from source file content.
 * Pure function: accepts string content, returns structured facts.
 * Only extracts statically known variable names (dot access and string-literal bracket access).
 * Ignores dynamic bracket access like process.env[someVar].
 */
export function extractEnvVars(content: string, sourcePath: string): EnvVarFact[] {
  const facts: EnvVarFact[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNumber = i + 1;

    extractFromLine(line, ENV_DOT_PATTERN, sourcePath, lineNumber, facts);
    extractFromLine(line, ENV_BRACKET_DOUBLE_PATTERN, sourcePath, lineNumber, facts);
    extractFromLine(line, ENV_BRACKET_SINGLE_PATTERN, sourcePath, lineNumber, facts);
  }

  return facts;
}

function extractFromLine(
  line: string,
  pattern: RegExp,
  sourcePath: string,
  lineNumber: number,
  facts: EnvVarFact[]
): void {
  // Reset lastIndex since we reuse global regex across calls
  pattern.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null) {
    const name = match[1]!;
    facts.push({
      name,
      sourcePath,
      line: lineNumber,
      confidence: 'high'
    });
  }
}

/**
 * Deduplicates env var facts by name, keeping the first occurrence (by source path then line).
 * Returns a sorted array of unique env var names with their first reference.
 */
export function deduplicateEnvVars(facts: EnvVarFact[]): EnvVarFact[] {
  const seen = new Map<string, EnvVarFact>();

  // Sort by name, then sourcePath, then line for deterministic first-occurrence
  const sorted = [...facts].sort((a, b) => {
    const nameCompare = a.name.localeCompare(b.name);
    if (nameCompare !== 0) return nameCompare;
    const pathCompare = a.sourcePath.localeCompare(b.sourcePath);
    if (pathCompare !== 0) return pathCompare;
    return a.line - b.line;
  });

  for (const fact of sorted) {
    if (!seen.has(fact.name)) {
      seen.set(fact.name, fact);
    }
  }

  // Return sorted by name for deterministic output
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Groups env var facts by source path for per-service reporting.
 * Returns a Map of sourcePath → EnvVarFact[] sorted deterministically.
 */
export function groupEnvVarsBySource(facts: EnvVarFact[]): Map<string, EnvVarFact[]> {
  const groups = new Map<string, EnvVarFact[]>();

  for (const fact of facts) {
    const existing = groups.get(fact.sourcePath);
    if (existing) {
      existing.push(fact);
    } else {
      groups.set(fact.sourcePath, [fact]);
    }
  }

  // Sort facts within each group by name then line
  for (const [, groupFacts] of groups) {
    groupFacts.sort((a, b) => {
      const nameCompare = a.name.localeCompare(b.name);
      if (nameCompare !== 0) return nameCompare;
      return a.line - b.line;
    });
  }

  return new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)));
}