import type { DatabaseFact, DatabaseKind, DatabaseOperation, ConfidenceLabel } from '../types.js';

interface PatternDef {
  regex: RegExp;
  kind: DatabaseKind;
  operation: DatabaseOperation;
  confidence: ConfidenceLabel;
  nameGroup: number;
}

// SQL table name: word chars, optionally schema-qualified (schema.table)
const TBL = `(\\w+(?:\\.\\w+)?)`;

const PATTERNS: PatternDef[] = [
  // SELECT ... FROM table
  { regex: new RegExp(`\\bSELECT\\b[^;]*\\bFROM\\s+${TBL}`, 'gi'), kind: 'table', operation: 'select', confidence: 'high', nameGroup: 1 },
  // JOIN table
  { regex: new RegExp(`\\bJOIN\\s+${TBL}`, 'gi'), kind: 'table', operation: 'join', confidence: 'high', nameGroup: 1 },
  // INSERT INTO table
  { regex: new RegExp(`\\bINSERT\\s+INTO\\s+${TBL}`, 'gi'), kind: 'table', operation: 'insert', confidence: 'high', nameGroup: 1 },
  // UPDATE table
  { regex: new RegExp(`\\bUPDATE\\s+${TBL}\\s+SET\\b`, 'gi'), kind: 'table', operation: 'update', confidence: 'high', nameGroup: 1 },
  // DELETE FROM table
  { regex: new RegExp(`\\bDELETE\\s+FROM\\s+${TBL}`, 'gi'), kind: 'table', operation: 'delete', confidence: 'high', nameGroup: 1 },
  // @Entity("table_name") or @Entity('table_name')
  { regex: /@Entity\(\s*['"]([^'"]+)['"]\s*\)/g, kind: 'entity', operation: 'entity', confidence: 'high', nameGroup: 1 },
  // getRepository(EntityName)
  { regex: /\.?getRepository\(\s*(\w+)\s*\)/g, kind: 'repository', operation: 'repository', confidence: 'medium', nameGroup: 1 },
];

/**
 * Extracts database/TypeORM usage facts from source file content.
 */
export function extractDatabase(content: string, sourcePath: string): DatabaseFact[] {
  const facts: DatabaseFact[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNumber = i + 1;

    // Skip comment lines (JS/TS/Go/SQL line comments and block comment lines)
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('--') || trimmed.startsWith('#')) continue;

    for (const pattern of PATTERNS) {
      pattern.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.regex.exec(line)) !== null) {
        const name = match[pattern.nameGroup]!;
        if (isSqlKeyword(name)) continue;
        // Nama tabel tidak boleh dimulai dengan angka
        if (/^\d/.test(name)) continue;
        facts.push({
          name,
          kind: pattern.kind,
          operation: pattern.operation,
          sourcePath,
          line: lineNumber,
          confidence: pattern.confidence,
        });
      }
    }
  }

  return facts;
}

const SQL_KEYWORDS = new Set([
  'select', 'from', 'where', 'set', 'into', 'values', 'join',
  'inner', 'outer', 'left', 'right', 'cross', 'on', 'and', 'or',
  'not', 'null', 'true', 'false', 'as', 'in', 'exists', 'between',
  'like', 'order', 'group', 'having', 'limit', 'offset', 'union',
]);

function isSqlKeyword(name: string): boolean {
  return SQL_KEYWORDS.has(name.toLowerCase());
}
