import {
  buildServiceChunks,
  buildEnvChunks,
  buildConfigDefaultChunks,
  buildApiRouteChunks,
  buildRabbitMqChunks,
  buildDatabaseChunks,
  buildReportChunks,
} from '../../lib/doctor-report-chunks.js';
import type { DoctorReport } from '../../lib/doctor-report-chunks.js';

function runTests(): void {
  console.log('Running doctor-report-chunks tests...');

  testServiceChunks();
  testEnvChunks();
  testConfigDefaultChunks();
  testApiRouteChunks();
  testRabbitMqChunks();
  testDatabaseChunks();
  testFullReport();
  testDeterministic();
  testEmptyReport();

  console.log('✅ All doctor-report-chunks tests passed!');
}

function testConfigDefaultChunks(): void {
  console.log('Test: config default chunks');
  const report = makeReport({
    configDefaults: [
      {
        envName: 'AUTO_COPY_MINIMUM_EQUITY',
        defaultValue: '1000',
        operator: '||',
        sourcePath: 'models/ois.js',
        line: 12,
        expression: 'process.env.AUTO_COPY_MINIMUM_EQUITY || "1000"',
        businessRuleCandidate: true,
        confidence: 'high',
      },
    ],
  });
  const chunks = buildConfigDefaultChunks(report, 'tf2-ois');
  assert(chunks.length === 1, `Expected 1, got ${chunks.length}`);
  assert(chunks[0]!.content.includes('AUTO_COPY_MINIMUM_EQUITY'), 'Has config env name');
  assert(chunks[0]!.content.includes('1000'), 'Has fallback value');
  assert(chunks[0]!.content.includes('Business-rule candidate: yes'), 'Has business rule marker');
  assert(chunks[0]!.filePath.includes('doctor-fact:config:'), 'filePath has fact prefix');
  console.log('  âœ“ passed');
}

function testServiceChunks(): void {
  console.log('Test: service chunks');
  const report = makeReport({
    services: [{
      metadata: [{ value: 'Package name: payment-service', confidence: 'high' }],
      dependencies: [{ value: 'express: ^4.18.0', confidence: 'high' }, { value: 'amqplib: ^0.10.0', confidence: 'high' }],
      scripts: [{ value: 'start: node dist/index.js', confidence: 'high' }],
    }],
  });
  const chunks = buildServiceChunks(report, 'payment-service');
  assert(chunks.length === 1, `Expected 1, got ${chunks.length}`);
  assert(chunks[0]!.content.includes('Service payment-service'), 'Has service name');
  assert(chunks[0]!.content.includes('express'), 'Has dependency');
  assert(chunks[0]!.content.includes('start'), 'Has script');
  assert(chunks[0]!.branchName === 'doctor', 'Branch is doctor');
  assert(chunks[0]!.filePath.includes('doctor-fact:service:'), 'filePath has fact prefix');
  console.log('  ✓ passed');
}

function testEnvChunks(): void {
  console.log('Test: env chunks');
  const report = makeReport({
    envVars: [
      { name: 'DB_HOST', sourcePath: 'src/config.ts', line: 12, confidence: 'high' },
      { name: 'PORT', sourcePath: 'src/index.ts', line: 3, confidence: 'high' },
    ],
  });
  const chunks = buildEnvChunks(report, 'my-svc');
  assert(chunks.length === 2, `Expected 2, got ${chunks.length}`);
  assert(chunks[0]!.content.includes('DB_HOST'), 'Has env var name');
  assert(chunks[0]!.content.includes('src/config.ts'), 'Has source path');
  assert(chunks[0]!.content.includes('line 12'), 'Has line');
  assert(chunks[0]!.content.includes('Confidence: high'), 'Has confidence');
  console.log('  ✓ passed');
}

function testApiRouteChunks(): void {
  console.log('Test: api route chunks');
  const report = makeReport({
    apiRoutes: [
      { method: 'POST', path: '/withdrawal', sourcePath: 'src/routes.ts', line: 20, framework: 'express', confidence: 'high' },
    ],
  });
  const chunks = buildApiRouteChunks(report, 'pay-svc');
  assert(chunks.length === 1, `Expected 1, got ${chunks.length}`);
  assert(chunks[0]!.content.includes('POST /withdrawal'), 'Has method+path');
  assert(chunks[0]!.content.includes('express'), 'Has framework');
  assert(chunks[0]!.relationshipHints.routes.includes('/withdrawal'), 'Has route hint');
  console.log('  ✓ passed');
}

function testRabbitMqChunks(): void {
  console.log('Test: rabbitmq chunks');
  const report = makeReport({
    rabbitMq: [
      { name: 'payment.created', messageType: 'queue', operation: 'publish', sourcePath: 'src/events.ts', line: 33, confidence: 'high' },
      { name: 'events', messageType: 'exchange', operation: 'assert', sourcePath: 'src/mq.ts', line: 5, confidence: 'high' },
    ],
  });
  const chunks = buildRabbitMqChunks(report, 'pay-svc');
  assert(chunks.length === 2, `Expected 2, got ${chunks.length}`);
  assert(chunks[0]!.content.includes('payment.created'), 'Has queue name');
  assert(chunks[0]!.content.includes('publish'), 'Has operation');
  assert(chunks[0]!.relationshipHints.queueNames.includes('payment.created'), 'Has queue hint');
  assert(chunks[1]!.relationshipHints.exchangeNames.includes('events'), 'Has exchange hint');
  console.log('  ✓ passed');
}

function testDatabaseChunks(): void {
  console.log('Test: database chunks');
  const report = makeReport({
    database: [
      { name: 'dsc_withdrawal', kind: 'table', operation: 'select', sourcePath: 'src/repo.ts', line: 44, confidence: 'high' },
    ],
  });
  const chunks = buildDatabaseChunks(report, 'wallet-svc');
  assert(chunks.length === 1, `Expected 1, got ${chunks.length}`);
  assert(chunks[0]!.content.includes('dsc_withdrawal'), 'Has table name');
  assert(chunks[0]!.content.includes('select'), 'Has operation');
  assert(chunks[0]!.relationshipHints.dbTables.includes('dsc_withdrawal'), 'Has db hint');
  console.log('  ✓ passed');
}

function testFullReport(): void {
  console.log('Test: full report builds all chunk types');
  const report = makeReport({
    services: [{ metadata: [{ value: 'Package name: svc', confidence: 'high' }], dependencies: [], scripts: [] }],
    envVars: [{ name: 'X', sourcePath: 'a.ts', line: 1, confidence: 'high' }],
    configDefaults: [{ envName: 'CFG', defaultValue: 'x', operator: '??', sourcePath: 'a.ts', line: 1, expression: 'process.env.CFG ?? "x"', businessRuleCandidate: false, confidence: 'high' }],
    apiRoutes: [{ method: 'GET', path: '/', sourcePath: 'b.ts', line: 2, framework: 'express', confidence: 'high' }],
    rabbitMq: [{ name: 'q', messageType: 'queue', operation: 'assert', sourcePath: 'c.ts', line: 3, confidence: 'medium' }],
    database: [{ name: 't', kind: 'table', operation: 'insert', sourcePath: 'd.ts', line: 4, confidence: 'high' }],
  });
  const chunks = buildReportChunks(report, 'svc');
  assert(chunks.length === 6, `Expected 6, got ${chunks.length}`);
  console.log('  ✓ passed');
}

function testDeterministic(): void {
  console.log('Test: deterministic IDs');
  const report = makeReport({
    envVars: [{ name: 'KEY', sourcePath: 'x.ts', line: 1, confidence: 'high' }],
  });
  const c1 = buildEnvChunks(report, 'r');
  const c2 = buildEnvChunks(report, 'r');
  assert(c1[0]!.id === c2[0]!.id, 'IDs must be identical');
  assert(c1[0]!.contentHash === c2[0]!.contentHash, 'Hashes must be identical');
  console.log('  ✓ passed');
}

function testEmptyReport(): void {
  console.log('Test: empty report');
  const chunks = buildReportChunks(makeReport({}), 'x');
  assert(chunks.length === 0, `Expected 0, got ${chunks.length}`);
  console.log('  ✓ passed');
}

function makeReport(partial: Partial<DoctorReport>): DoctorReport {
  return {
    services: [],
    envVars: [],
    configDefaults: [],
    apiRoutes: [],
    rabbitMq: [],
    database: [],
    summary: { serviceCount: 0, envVarCount: 0, configDefaultCount: 0, apiRouteCount: 0, rabbitMqCount: 0, databaseCount: 0, filesScanned: 0 },
    ...partial,
  };
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

export { runTests };
