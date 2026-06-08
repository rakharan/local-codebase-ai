import { generateOverviewMarkdown } from '../generators/overview-generator.js';
import type { OverviewInput } from '../generators/overview-generator.js';

function runTests(): void {
  console.log('Running overview generator tests...');

  testEmptyInput();
  testCounts();
  testLinks();
  testLimitations();
  testNoTimestampByDefault();
  testTimestampFlag();
  testDeterministic();

  console.log('✅ All overview generator tests passed!');
}

function emptyInput(): OverviewInput {
  return { packageFacts: [], envFacts: [], apiRouteFacts: [], rabbitMqFacts: [], databaseFacts: [] };
}

function testEmptyInput(): void {
  console.log('Test: empty input');
  const result = generateOverviewMarkdown(emptyInput());
  assert(result.includes('# Repository Overview'), 'Should have title');
  assert(result.includes('| Services (package.json) | 0 |'), 'Should show 0 services');
  console.log('  ✓ passed');
}

function testCounts(): void {
  console.log('Test: counts');
  const input: OverviewInput = {
    packageFacts: [{ metadata: [], dependencies: [], scripts: [] }, { metadata: [], dependencies: [], scripts: [] }],
    envFacts: [{ name: 'A', sourcePath: 'x', line: 1, confidence: 'high' }],
    apiRouteFacts: [{ method: 'GET', path: '/', sourcePath: 'x', line: 1, framework: 'express', confidence: 'high' }],
    rabbitMqFacts: [{ name: 'q', messageType: 'queue', operation: 'assert', sourcePath: 'x', line: 1, confidence: 'high' }],
    databaseFacts: [
      { name: 't1', kind: 'table', operation: 'select', sourcePath: 'x', line: 1, confidence: 'high' },
      { name: 't2', kind: 'table', operation: 'insert', sourcePath: 'x', line: 2, confidence: 'high' },
    ],
  };
  const result = generateOverviewMarkdown(input);
  assert(result.includes('| Services (package.json) | 2 |'), 'Should count 2 services');
  assert(result.includes('| Environment variables | 1 |'), 'Should count 1 env');
  assert(result.includes('| API routes | 1 |'), 'Should count 1 route');
  assert(result.includes('| RabbitMQ usages | 1 |'), 'Should count 1 mq');
  assert(result.includes('| Database usages | 2 |'), 'Should count 2 db');
  console.log('  ✓ passed');
}

function testLinks(): void {
  console.log('Test: links');
  const result = generateOverviewMarkdown(emptyInput());
  assert(result.includes('[services.md](./services.md)'), 'Link to services');
  assert(result.includes('[env.md](./env.md)'), 'Link to env');
  assert(result.includes('[api.md](./api.md)'), 'Link to api');
  assert(result.includes('[rabbitmq.md](./rabbitmq.md)'), 'Link to rabbitmq');
  assert(result.includes('[database.md](./database.md)'), 'Link to database');
  assert(result.includes('[architecture.md](./architecture.md)'), 'Link to architecture');
  console.log('  ✓ passed');
}

function testLimitations(): void {
  console.log('Test: limitations');
  const result = generateOverviewMarkdown(emptyInput());
  assert(result.includes('## Limitations'), 'Should have limitations section');
  assert(result.includes('Static analysis only'), 'Should mention static analysis');
  console.log('  ✓ passed');
}

function testNoTimestampByDefault(): void {
  console.log('Test: no timestamp by default');
  const result = generateOverviewMarkdown(emptyInput());
  assert(!result.includes('Generated at:'), 'Should not have timestamp by default');
  console.log('  ✓ passed');
}

function testTimestampFlag(): void {
  console.log('Test: timestamp flag');
  const result = generateOverviewMarkdown({ ...emptyInput(), timestamp: true });
  assert(result.includes('Generated at:'), 'Should have timestamp when flag is true');
  console.log('  ✓ passed');
}

function testDeterministic(): void {
  console.log('Test: deterministic output');
  const input = emptyInput();
  const r1 = generateOverviewMarkdown(input);
  const r2 = generateOverviewMarkdown(input);
  assert(r1 === r2, 'Should produce identical output');
  console.log('  ✓ passed');
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

export { runTests };
