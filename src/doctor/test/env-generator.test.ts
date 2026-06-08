import { generateEnvMarkdown } from '../generators/env-generator.js';
import type { EnvVarFact } from '../types.js';

function runTests(): void {
  console.log('Running env generator tests...');

  testEmptyState();
  testBasicGeneration();
  testGroupedByService();
  testDeterministicOutput();

  console.log('✅ All env generator tests passed!');
}

function testEmptyState(): void {
  console.log('Test: env.md empty state');

  const markdown = generateEnvMarkdown([]);

  assert(markdown.includes('# Environment Variables'), 'Should have main header');
  assert(markdown.includes('No environment variable references were detected'), 'Should show empty message');
  assert(!markdown.includes('## Summary'), 'Should not have summary section');

  console.log('  ✓ env.md empty state test passed');
}

function testBasicGeneration(): void {
  console.log('Test: Basic env.md generation');

  const facts: EnvVarFact[] = [
    { name: 'PORT', sourcePath: 'src/server.ts', line: 3, confidence: 'high' },
    { name: 'HOST', sourcePath: 'src/server.ts', line: 4, confidence: 'high' },
    { name: 'DB_URL', sourcePath: 'src/db.ts', line: 1, confidence: 'high' },
  ];

  const markdown = generateEnvMarkdown(facts);

  assert(markdown.includes('# Environment Variables'), 'Should have main header');
  assert(markdown.includes('## Summary (3 unique variables)'), 'Should show unique count');
  assert(markdown.includes('`PORT`'), 'Should include PORT');
  assert(markdown.includes('`HOST`'), 'Should include HOST');
  assert(markdown.includes('`DB_URL`'), 'Should include DB_URL');
  assert(markdown.includes('*(confidence: high)*'), 'Should include confidence');

  console.log('  ✓ Basic env.md generation test passed');
}

function testGroupedByService(): void {
  console.log('Test: env.md grouped by service');

  const facts: EnvVarFact[] = [
    { name: 'PORT', sourcePath: 'src/server.ts', line: 3, confidence: 'high' },
    { name: 'HOST', sourcePath: 'src/server.ts', line: 4, confidence: 'high' },
    { name: 'DB_URL', sourcePath: 'src/db.ts', line: 1, confidence: 'high' },
  ];

  const markdown = generateEnvMarkdown(facts);

  assert(markdown.includes('## By Source File'), 'Should have by-source section');
  assert(markdown.includes('### src/db.ts'), 'Should have db.ts group');
  assert(markdown.includes('### src/server.ts'), 'Should have server.ts group');
  assert(markdown.includes('(line 3)'), 'Should show line numbers');

  console.log('  ✓ env.md grouped by service test passed');
}

function testDeterministicOutput(): void {
  console.log('Test: Deterministic output');

  const facts: EnvVarFact[] = [
    { name: 'ZEBRA', sourcePath: 'src/z.ts', line: 1, confidence: 'high' },
    { name: 'ALPHA', sourcePath: 'src/a.ts', line: 1, confidence: 'high' },
    { name: 'MIDDLE', sourcePath: 'src/m.ts', line: 1, confidence: 'high' },
  ];

  const markdown1 = generateEnvMarkdown(facts);
  const markdown2 = generateEnvMarkdown([...facts].reverse());

  assert(markdown1 === markdown2, 'Should produce identical output regardless of input order');

  // Verify alphabetical order in summary
  const summaryLines = markdown1.split('\n').filter(l => l.startsWith('- `'));
  assert(summaryLines[0]!.includes('ALPHA'), 'First should be ALPHA');
  assert(summaryLines[1]!.includes('MIDDLE'), 'Second should be MIDDLE');
  assert(summaryLines[2]!.includes('ZEBRA'), 'Third should be ZEBRA');

  console.log('  ✓ Deterministic output test passed');
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

export { runTests };