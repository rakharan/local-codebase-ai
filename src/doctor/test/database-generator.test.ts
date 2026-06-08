import { generateDatabaseMarkdown } from '../generators/database-generator.js';
import type { DatabaseFact } from '../types.js';

function runTests(): void {
  console.log('Running database generator tests...');

  testEmptyFacts();
  testBasicGeneration();
  testDeterministicOutput();
  testGroupedByKind();

  console.log('✅ All database generator tests passed!');
}

function testEmptyFacts(): void {
  console.log('Test: empty facts');
  const result = generateDatabaseMarkdown([]);
  assert(result.includes('# Database Usage'), 'Should have title');
  assert(result.includes('No database usage was detected'), 'Should show empty message');
  console.log('  ✓ passed');
}

function testBasicGeneration(): void {
  console.log('Test: basic generation');
  const facts: DatabaseFact[] = [
    { name: 'users', kind: 'table', operation: 'select', sourcePath: 'src/repo.ts', line: 3, confidence: 'high' },
    { name: 'orders', kind: 'table', operation: 'insert', sourcePath: 'src/repo.ts', line: 7, confidence: 'high' },
  ];
  const result = generateDatabaseMarkdown(facts);
  assert(result.includes('## Tables (2 unique)'), 'Should show unique count');
  assert(result.includes('| `users` |'), 'Should have users row');
  assert(result.includes('| `orders` |'), 'Should have orders row');
  assert(result.includes('## Detail (2 usages)'), 'Should have detail section');
  console.log('  ✓ passed');
}

function testDeterministicOutput(): void {
  console.log('Test: deterministic output');
  const facts: DatabaseFact[] = [
    { name: 'z_table', kind: 'table', operation: 'select', sourcePath: 'src/a.ts', line: 1, confidence: 'high' },
    { name: 'a_table', kind: 'table', operation: 'insert', sourcePath: 'src/b.ts', line: 2, confidence: 'high' },
  ];
  const r1 = generateDatabaseMarkdown(facts);
  const r2 = generateDatabaseMarkdown(facts);
  assert(r1 === r2, 'Should produce identical output');
  assert(r1.indexOf('a_table') < r1.indexOf('z_table'), 'Should sort by name');
  console.log('  ✓ passed');
}

function testGroupedByKind(): void {
  console.log('Test: grouped by kind');
  const facts: DatabaseFact[] = [
    { name: 'users', kind: 'table', operation: 'select', sourcePath: 'src/db.ts', line: 1, confidence: 'high' },
    { name: 'UserEntity', kind: 'entity', operation: 'entity', sourcePath: 'src/entity.ts', line: 2, confidence: 'high' },
    { name: 'OrderEntity', kind: 'repository', operation: 'repository', sourcePath: 'src/svc.ts', line: 3, confidence: 'medium' },
  ];
  const result = generateDatabaseMarkdown(facts);
  assert(result.includes('## Tables (3 unique)'), 'Should show 3 unique');
  assert(result.includes('| `users` | table |'), 'Should have table kind');
  assert(result.includes('| `UserEntity` | entity |'), 'Should have entity kind');
  assert(result.includes('| `OrderEntity` | repository |'), 'Should have repository kind');
  console.log('  ✓ passed');
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

export { runTests };
