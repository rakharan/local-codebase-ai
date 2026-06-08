import { generateRabbitMqMarkdown } from '../generators/rabbitmq-generator.js';
import type { RabbitMqFact } from '../types.js';

function runTests(): void {
  console.log('Running RabbitMQ generator tests...');

  testEmptyFacts();
  testBasicGeneration();
  testDeterministicOutput();
  testGroupedByType();

  console.log('✅ All RabbitMQ generator tests passed!');
}

function testEmptyFacts(): void {
  console.log('Test: empty facts');
  const result = generateRabbitMqMarkdown([]);
  assert(result.includes('# RabbitMQ Usage'), 'Should have title');
  assert(result.includes('No RabbitMQ usage was detected'), 'Should show empty message');
  console.log('  ✓ passed');
}

function testBasicGeneration(): void {
  console.log('Test: basic generation');
  const facts: RabbitMqFact[] = [
    { name: 'orders', messageType: 'queue', operation: 'send', sourcePath: 'src/pub.ts', line: 5, confidence: 'high' },
    { name: 'orders', messageType: 'queue', operation: 'consume', sourcePath: 'src/con.ts', line: 10, confidence: 'high' },
  ];
  const result = generateRabbitMqMarkdown(facts);
  assert(result.includes('## Summary (2 usages)'), 'Should show count');
  assert(result.includes('| `orders` |'), 'Should have table row');
  assert(result.includes('| Name | Type | Operation |'), 'Should have table header');
  console.log('  ✓ passed');
}

function testDeterministicOutput(): void {
  console.log('Test: deterministic output');
  const facts: RabbitMqFact[] = [
    { name: 'z-queue', messageType: 'queue', operation: 'send', sourcePath: 'src/a.ts', line: 1, confidence: 'high' },
    { name: 'a-queue', messageType: 'queue', operation: 'consume', sourcePath: 'src/b.ts', line: 2, confidence: 'high' },
  ];
  const r1 = generateRabbitMqMarkdown(facts);
  const r2 = generateRabbitMqMarkdown(facts);
  assert(r1 === r2, 'Should produce identical output');
  // a-queue should come before z-queue (sorted by name)
  assert(r1.indexOf('a-queue') < r1.indexOf('z-queue'), 'Should sort by name');
  console.log('  ✓ passed');
}

function testGroupedByType(): void {
  console.log('Test: grouped by type');
  const facts: RabbitMqFact[] = [
    { name: 'ex1', messageType: 'exchange', operation: 'assert', sourcePath: 'src/mq.ts', line: 1, confidence: 'high' },
    { name: 'q1', messageType: 'queue', operation: 'assert', sourcePath: 'src/mq.ts', line: 2, confidence: 'high' },
    { name: 'getUser', messageType: 'rpc', operation: 'send', sourcePath: 'src/rpc.ts', line: 3, confidence: 'medium' },
  ];
  const result = generateRabbitMqMarkdown(facts);
  assert(result.includes('### exchange'), 'Should group exchanges');
  assert(result.includes('### queue'), 'Should group queues');
  assert(result.includes('### rpc'), 'Should group rpc');
  console.log('  ✓ passed');
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

export { runTests };
