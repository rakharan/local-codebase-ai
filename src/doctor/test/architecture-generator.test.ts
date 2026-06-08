import { generateArchitectureMarkdown } from '../generators/architecture-generator.js';
import type { ArchitectureInput } from '../generators/architecture-generator.js';
import type { PackageFacts, ApiRouteFact, RabbitMqFact, DatabaseFact } from '../types.js';

function runTests(): void {
  console.log('Running architecture generator tests...');

  testEmptyInput();
  testServiceOverview();
  testRabbitMqFlow();
  testDatabaseGraph();
  testFullInput();

  console.log('✅ All architecture generator tests passed!');
}

function emptyInput(): ArchitectureInput {
  return { packageFacts: [], apiRouteFacts: [], rabbitMqFacts: [], databaseFacts: [] };
}

function testEmptyInput(): void {
  console.log('Test: empty input');
  const result = generateArchitectureMarkdown(emptyInput());
  assert(result.includes('# Architecture Overview'), 'Should have title');
  assert(result.includes('No RabbitMQ usage detected'), 'Should indicate no RabbitMQ');
  assert(result.includes('No database usage detected'), 'Should indicate no DB');
  console.log('  ✓ empty input test passed');
}

function testServiceOverview(): void {
  console.log('Test: service overview graph');
  const input: ArchitectureInput = {
    packageFacts: [{
      metadata: [{ value: 'Package name: payment-service', confidence: 'high' }],
      dependencies: [],
      scripts: [],
    }],
    apiRouteFacts: [{ method: 'GET', path: '/health', sourcePath: 'src/app.ts', line: 1, framework: 'express', confidence: 'high' }],
    rabbitMqFacts: [],
    databaseFacts: [],
  };
  const result = generateArchitectureMarkdown(input);
  assert(result.includes('```mermaid'), 'Should contain mermaid block');
  assert(result.includes('graph TD'), 'Should be TD graph');
  assert(result.includes('payment_service[payment-service]'), 'Should have service node');
  assert(result.includes('API{{API Routes: 1}}'), 'Should have API node');
  console.log('  ✓ service overview test passed');
}

function testRabbitMqFlow(): void {
  console.log('Test: RabbitMQ flow graph');
  const input: ArchitectureInput = {
    ...emptyInput(),
    rabbitMqFacts: [
      { name: 'orders', messageType: 'queue', operation: 'send', sourcePath: 'src/pub.ts', line: 5, confidence: 'high' },
      { name: 'orders', messageType: 'queue', operation: 'consume', sourcePath: 'src/con.ts', line: 10, confidence: 'high' },
    ],
  };
  const result = generateArchitectureMarkdown(input);
  assert(result.includes('## RabbitMQ Flow'), 'Should have RabbitMQ section');
  assert(result.includes('graph LR'), 'Should be LR graph');
  assert(result.includes('orders'), 'Should reference queue name');
  assert(result.includes('publish'), 'Should show publish edge');
  assert(result.includes('consume'), 'Should show consume edge');
  console.log('  ✓ RabbitMQ flow test passed');
}

function testDatabaseGraph(): void {
  console.log('Test: database graph');
  const input: ArchitectureInput = {
    ...emptyInput(),
    databaseFacts: [
      { name: 'users', kind: 'table', operation: 'select', sourcePath: 'src/repo.ts', line: 3, confidence: 'high' },
      { name: 'orders', kind: 'table', operation: 'insert', sourcePath: 'src/repo.ts', line: 7, confidence: 'high' },
    ],
  };
  const result = generateArchitectureMarkdown(input);
  assert(result.includes('## Database Usage'), 'Should have DB section');
  assert(result.includes('users'), 'Should reference users table');
  assert(result.includes('orders'), 'Should reference orders table');
  assert(result.includes('select'), 'Should show select operation');
  assert(result.includes('insert'), 'Should show insert operation');
  console.log('  ✓ database graph test passed');
}

function testFullInput(): void {
  console.log('Test: full input produces all sections');
  const input: ArchitectureInput = {
    packageFacts: [{
      metadata: [{ value: 'Package name: my-app', confidence: 'high' }],
      dependencies: [],
      scripts: [],
    }],
    apiRouteFacts: [{ method: 'POST', path: '/api/pay', sourcePath: 'src/routes.ts', line: 2, framework: 'express', confidence: 'high' }],
    rabbitMqFacts: [{ name: 'payments', messageType: 'queue', operation: 'send', sourcePath: 'src/mq.ts', line: 4, confidence: 'high' }],
    databaseFacts: [{ name: 'transactions', kind: 'table', operation: 'insert', sourcePath: 'src/db.ts', line: 6, confidence: 'high' }],
  };
  const result = generateArchitectureMarkdown(input);
  assert(result.includes('## Service Overview'), 'Has service section');
  assert(result.includes('## RabbitMQ Flow'), 'Has RabbitMQ section');
  assert(result.includes('## Database Usage'), 'Has DB section');
  assert(result.includes('RabbitMQ[(RabbitMQ)]'), 'Service graph shows RabbitMQ');
  assert(result.includes('DB[(Database)]'), 'Service graph shows DB');
  console.log('  ✓ full input test passed');
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

export { runTests };
