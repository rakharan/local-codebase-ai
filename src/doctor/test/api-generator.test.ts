import { generateApiMarkdown } from '../generators/api-generator.js';
import type { ApiRouteFact } from '../types.js';

function runTests(): void {
  console.log('Running API generator tests...');

  testEmptyState();
  testBasicGeneration();
  testDeterministicOutput();
  testGroupedBySource();

  console.log('✅ All API generator tests passed!');
}

function testEmptyState(): void {
  console.log('Test: api.md empty state');

  const markdown = generateApiMarkdown([]);

  assert(markdown.includes('# API Routes'), 'Should have main header');
  assert(markdown.includes('No HTTP routes were detected'), 'Should show empty message');
  assert(!markdown.includes('## Summary'), 'Should not have summary section');

  console.log('  ✓ api.md empty state test passed');
}

function testBasicGeneration(): void {
  console.log('Test: Basic api.md generation');

  const facts: ApiRouteFact[] = [
    { method: 'GET', path: '/users', sourcePath: 'src/routes.ts', line: 5, framework: 'express', confidence: 'high' },
    { method: 'POST', path: '/users', sourcePath: 'src/routes.ts', line: 6, framework: 'express', confidence: 'high' },
    { method: 'GET', path: '/health', sourcePath: 'src/server.ts', line: 3, framework: 'fastify', confidence: 'high' },
  ];

  const markdown = generateApiMarkdown(facts);

  assert(markdown.includes('# API Routes'), 'Should have main header');
  assert(markdown.includes('## Summary (3 routes)'), 'Should show route count');
  assert(markdown.includes('| GET | `/users`'), 'Should include GET /users');
  assert(markdown.includes('| POST | `/users`'), 'Should include POST /users');
  assert(markdown.includes('| GET | `/health`'), 'Should include GET /health');
  assert(markdown.includes('express'), 'Should include framework');
  assert(markdown.includes('fastify'), 'Should include fastify');

  console.log('  ✓ Basic api.md generation test passed');
}

function testDeterministicOutput(): void {
  console.log('Test: Deterministic output');

  const facts: ApiRouteFact[] = [
    { method: 'DELETE', path: '/z', sourcePath: 'src/z.ts', line: 1, framework: 'express', confidence: 'high' },
    { method: 'GET', path: '/a', sourcePath: 'src/a.ts', line: 1, framework: 'express', confidence: 'high' },
    { method: 'POST', path: '/m', sourcePath: 'src/m.ts', line: 1, framework: 'fastify', confidence: 'high' },
  ];

  const markdown1 = generateApiMarkdown(facts);
  const markdown2 = generateApiMarkdown([...facts].reverse());

  assert(markdown1 === markdown2, 'Should produce identical output regardless of input order');

  // Verify path-based alphabetical order
  const tableLines = markdown1.split('\n').filter(l => l.startsWith('| GET') || l.startsWith('| POST') || l.startsWith('| DELETE'));
  assert(tableLines[0]!.includes('/a'), 'First should be /a');
  assert(tableLines[1]!.includes('/m'), 'Second should be /m');
  assert(tableLines[2]!.includes('/z'), 'Third should be /z');

  console.log('  ✓ Deterministic output test passed');
}

function testGroupedBySource(): void {
  console.log('Test: Grouped by source file');

  const facts: ApiRouteFact[] = [
    { method: 'GET', path: '/users', sourcePath: 'src/users.ts', line: 5, framework: 'express', confidence: 'high' },
    { method: 'POST', path: '/users', sourcePath: 'src/users.ts', line: 6, framework: 'express', confidence: 'high' },
    { method: 'GET', path: '/health', sourcePath: 'src/health.ts', line: 3, framework: 'express', confidence: 'high' },
  ];

  const markdown = generateApiMarkdown(facts);

  assert(markdown.includes('## By Source File'), 'Should have by-source section');
  assert(markdown.includes('### src/health.ts'), 'Should have health.ts group');
  assert(markdown.includes('### src/users.ts'), 'Should have users.ts group');
  assert(markdown.includes('(line 5, express)'), 'Should show line and framework');

  console.log('  ✓ Grouped by source file test passed');
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

export { runTests };