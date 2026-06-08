import { extractEnvVars, deduplicateEnvVars, groupEnvVarsBySource } from '../extractors/env-extractor.js';

function runTests(): void {
  console.log('Running env extractor tests...');

  testDotAccess();
  testBracketDoubleQuotes();
  testBracketSingleQuotes();
  testIgnoresDynamicAccess();
  testLineNumberDetection();
  testDeduplication();
  testDeterministicSorting();
  testGroupBySource();
  testEmptyContent();
  testMultiplePatternsOnOneLine();

  console.log('✅ All env extractor tests passed!');
}

function testDotAccess(): void {
  console.log('Test: process.env.NAME');

  const content = `const port = process.env.PORT;
const host = process.env.DATABASE_HOST;`;

  const facts = extractEnvVars(content, 'src/config.ts');

  assert(facts.length === 2, `Expected 2 facts, got ${facts.length}`);
  assert(facts[0]!.name === 'PORT', `Expected PORT, got ${facts[0]!.name}`);
  assert(facts[1]!.name === 'DATABASE_HOST', `Expected DATABASE_HOST, got ${facts[1]!.name}`);
  assert(facts.every(f => f.confidence === 'high'), 'All should be high confidence');

  console.log('  ✓ process.env.NAME test passed');
}

function testBracketDoubleQuotes(): void {
  console.log('Test: process.env["NAME"]');

  const content = `const secret = process.env["API_SECRET"];
const key = process.env["AWS_ACCESS_KEY_ID"];`;

  const facts = extractEnvVars(content, 'src/auth.ts');

  assert(facts.length === 2, `Expected 2 facts, got ${facts.length}`);
  assert(facts[0]!.name === 'API_SECRET', `Expected API_SECRET, got ${facts[0]!.name}`);
  assert(facts[1]!.name === 'AWS_ACCESS_KEY_ID', `Expected AWS_ACCESS_KEY_ID, got ${facts[1]!.name}`);

  console.log('  ✓ process.env["NAME"] test passed');
}

function testBracketSingleQuotes(): void {
  console.log("Test: process.env['NAME']");

  const content = `const region = process.env['AWS_REGION'];
const bucket = process.env['S3_BUCKET'];`;

  const facts = extractEnvVars(content, 'src/storage.ts');

  assert(facts.length === 2, `Expected 2 facts, got ${facts.length}`);
  assert(facts[0]!.name === 'AWS_REGION', `Expected AWS_REGION, got ${facts[0]!.name}`);
  assert(facts[1]!.name === 'S3_BUCKET', `Expected S3_BUCKET, got ${facts[1]!.name}`);

  console.log("  ✓ process.env['NAME'] test passed");
}

function testIgnoresDynamicAccess(): void {
  console.log('Test: Ignores dynamic process.env[variable]');

  const content = `const key = 'PORT';
const value = process.env[key];
const other = process.env[getEnvKey()];
const computed = process.env[prefix + '_HOST'];`;

  const facts = extractEnvVars(content, 'src/dynamic.ts');

  assert(facts.length === 0, `Expected 0 facts for dynamic access, got ${facts.length}`);

  console.log('  ✓ Ignores dynamic access test passed');
}

function testLineNumberDetection(): void {
  console.log('Test: Line number detection');

  const content = `// line 1
const a = 1;
const port = process.env.PORT;
// line 4
const host = process.env.HOST;`;

  const facts = extractEnvVars(content, 'src/app.ts');

  assert(facts.length === 2, `Expected 2 facts, got ${facts.length}`);
  assert(facts[0]!.line === 3, `Expected line 3, got ${facts[0]!.line}`);
  assert(facts[1]!.line === 5, `Expected line 5, got ${facts[1]!.line}`);

  console.log('  ✓ Line number detection test passed');
}

function testDeduplication(): void {
  console.log('Test: Deduplication');

  const facts = [
    { name: 'PORT', sourcePath: 'src/a.ts', line: 5, confidence: 'high' as const },
    { name: 'PORT', sourcePath: 'src/b.ts', line: 10, confidence: 'high' as const },
    { name: 'HOST', sourcePath: 'src/a.ts', line: 6, confidence: 'high' as const },
    { name: 'HOST', sourcePath: 'src/c.ts', line: 1, confidence: 'high' as const },
  ];

  const unique = deduplicateEnvVars(facts);

  assert(unique.length === 2, `Expected 2 unique facts, got ${unique.length}`);
  assert(unique[0]!.name === 'HOST', `Expected HOST first, got ${unique[0]!.name}`);
  assert(unique[1]!.name === 'PORT', `Expected PORT second, got ${unique[1]!.name}`);
  // First occurrence by path sort: src/a.ts < src/b.ts
  assert(unique[1]!.sourcePath === 'src/a.ts', `Expected src/a.ts, got ${unique[1]!.sourcePath}`);

  console.log('  ✓ Deduplication test passed');
}

function testDeterministicSorting(): void {
  console.log('Test: Deterministic sorting');

  const content = `const z = process.env.ZEBRA;
const a = process.env.ALPHA;
const m = process.env.MIDDLE;`;

  const facts1 = extractEnvVars(content, 'src/app.ts');
  const facts2 = extractEnvVars(content, 'src/app.ts');

  const dedup1 = deduplicateEnvVars(facts1);
  const dedup2 = deduplicateEnvVars(facts2);

  assert(JSON.stringify(dedup1) === JSON.stringify(dedup2), 'Multiple runs should produce identical results');
  assert(dedup1[0]!.name === 'ALPHA', 'Should be sorted alphabetically');
  assert(dedup1[1]!.name === 'MIDDLE', 'Should be sorted alphabetically');
  assert(dedup1[2]!.name === 'ZEBRA', 'Should be sorted alphabetically');

  console.log('  ✓ Deterministic sorting test passed');
}

function testGroupBySource(): void {
  console.log('Test: Group by source');

  const facts = [
    { name: 'PORT', sourcePath: 'src/server.ts', line: 3, confidence: 'high' as const },
    { name: 'HOST', sourcePath: 'src/server.ts', line: 4, confidence: 'high' as const },
    { name: 'DB_URL', sourcePath: 'src/db.ts', line: 1, confidence: 'high' as const },
  ];

  const grouped = groupEnvVarsBySource(facts);

  assert(grouped.size === 2, `Expected 2 groups, got ${grouped.size}`);

  const keys = [...grouped.keys()];
  assert(keys[0] === 'src/db.ts', 'Groups should be sorted by path');
  assert(keys[1] === 'src/server.ts', 'Groups should be sorted by path');
  assert(grouped.get('src/server.ts')!.length === 2, 'Server group should have 2 facts');

  console.log('  ✓ Group by source test passed');
}

function testEmptyContent(): void {
  console.log('Test: Empty content');

  const facts = extractEnvVars('', 'src/empty.ts');
  assert(facts.length === 0, 'Empty content should produce no facts');

  const facts2 = extractEnvVars('const x = 42;\nfunction hello() {}', 'src/no-env.ts');
  assert(facts2.length === 0, 'Content without env access should produce no facts');

  console.log('  ✓ Empty content test passed');
}

function testMultiplePatternsOnOneLine(): void {
  console.log('Test: Multiple env vars on one line');

  const content = `const url = \`\${process.env.PROTOCOL}://\${process.env.HOST}:\${process.env.PORT}\`;`;

  const facts = extractEnvVars(content, 'src/url.ts');

  assert(facts.length === 3, `Expected 3 facts, got ${facts.length}`);
  const names = facts.map(f => f.name).sort();
  assert(names[0] === 'HOST', 'Should find HOST');
  assert(names[1] === 'PORT', 'Should find PORT');
  assert(names[2] === 'PROTOCOL', 'Should find PROTOCOL');
  assert(facts.every(f => f.line === 1), 'All should be on line 1');

  console.log('  ✓ Multiple patterns on one line test passed');
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

export { runTests };