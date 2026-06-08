import { extractApiRoutes } from '../extractors/api-route-extractor.js';

function runTests(): void {
  console.log('Running API route extractor tests...');

  testExpressAppRoutes();
  testExpressRouterRoutes();
  testFastifyRoutes();
  testMultipleMethods();
  testLineNumbers();
  testIgnoresDynamicPaths();
  testFrameworkDetection();
  testDeterministicOrdering();
  testEmptyContent();
  testMultipleRoutesOnOneLine();

  console.log('✅ All API route extractor tests passed!');
}

function testExpressAppRoutes(): void {
  console.log('Test: Express app routes');

  const content = `app.get('/users', getUsers);
app.post('/users', createUser);
app.put('/users/:id', updateUser);
app.patch('/users/:id', patchUser);
app.delete('/users/:id', deleteUser);`;

  const facts = extractApiRoutes(content, 'src/routes/users.ts');

  assert(facts.length === 5, `Expected 5 routes, got ${facts.length}`);
  assert(facts[0]!.method === 'GET', 'First should be GET');
  assert(facts[0]!.path === '/users', 'First path should be /users');
  assert(facts[1]!.method === 'POST', 'Second should be POST');
  assert(facts[2]!.method === 'PUT', 'Third should be PUT');
  assert(facts[3]!.method === 'PATCH', 'Fourth should be PATCH');
  assert(facts[4]!.method === 'DELETE', 'Fifth should be DELETE');
  assert(facts.every(f => f.framework === 'express'), 'All should be express');
  assert(facts.every(f => f.confidence === 'high'), 'All should be high confidence');

  console.log('  ✓ Express app routes test passed');
}

function testExpressRouterRoutes(): void {
  console.log('Test: Express router routes');

  const content = `const router = express.Router();
router.get('/api/items', listItems);
router.post('/api/items', createItem);`;

  const facts = extractApiRoutes(content, 'src/routes/items.ts');

  assert(facts.length === 2, `Expected 2 routes, got ${facts.length}`);
  assert(facts[0]!.path === '/api/items', 'Should detect router paths');
  assert(facts[0]!.framework === 'express', 'Router should be express');

  console.log('  ✓ Express router routes test passed');
}

function testFastifyRoutes(): void {
  console.log('Test: Fastify routes');

  const content = `fastify.get('/health', healthCheck);
fastify.post('/webhooks', handleWebhook);`;

  const facts = extractApiRoutes(content, 'src/server.ts');

  assert(facts.length === 2, `Expected 2 routes, got ${facts.length}`);
  assert(facts[0]!.framework === 'fastify', 'Should detect fastify');
  assert(facts[0]!.path === '/health', 'Should detect path');
  assert(facts[1]!.method === 'POST', 'Should detect POST');

  console.log('  ✓ Fastify routes test passed');
}

function testMultipleMethods(): void {
  console.log('Test: Multiple HTTP methods');

  const content = `app.get('/test', handler);
app.post('/test', handler);
app.put('/test', handler);
app.patch('/test', handler);
app.delete('/test', handler);`;

  const facts = extractApiRoutes(content, 'src/app.ts');
  const methods = facts.map(f => f.method);

  assert(methods.includes('GET'), 'Should detect GET');
  assert(methods.includes('POST'), 'Should detect POST');
  assert(methods.includes('PUT'), 'Should detect PUT');
  assert(methods.includes('PATCH'), 'Should detect PATCH');
  assert(methods.includes('DELETE'), 'Should detect DELETE');

  console.log('  ✓ Multiple HTTP methods test passed');
}

function testLineNumbers(): void {
  console.log('Test: Line number detection');

  const content = `// line 1
// line 2
app.get('/first', handler);
// line 4
app.post('/second', handler);`;

  const facts = extractApiRoutes(content, 'src/app.ts');

  assert(facts[0]!.line === 3, `Expected line 3, got ${facts[0]!.line}`);
  assert(facts[1]!.line === 5, `Expected line 5, got ${facts[1]!.line}`);

  console.log('  ✓ Line number detection test passed');
}

function testIgnoresDynamicPaths(): void {
  console.log('Test: Ignores dynamic/variable paths');

  const content = `app.get(dynamicPath, handler);
app.post(getRoute(), handler);
app.put(config.path, handler);`;

  const facts = extractApiRoutes(content, 'src/dynamic.ts');

  assert(facts.length === 0, `Expected 0 routes for dynamic paths, got ${facts.length}`);

  console.log('  ✓ Ignores dynamic paths test passed');
}

function testFrameworkDetection(): void {
  console.log('Test: Framework detection');

  const content = `app.get('/express-app', h);
router.get('/express-router', h);
server.get('/express-server', h);
fastify.get('/fastify-route', h);
customHandler.get('/unknown-route', h);`;

  const facts = extractApiRoutes(content, 'src/mixed.ts');

  // customHandler is skipped — only known receivers are accepted
  assert(facts.length === 4, `Expected 4 routes, got ${facts.length}`);
  assert(facts[0]!.framework === 'express', 'app should be express');
  assert(facts[1]!.framework === 'express', 'router should be express');
  assert(facts[2]!.framework === 'express', 'server should be express');
  assert(facts[3]!.framework === 'fastify', 'fastify should be fastify');

  console.log('  ✓ Framework detection test passed');
}

function testDeterministicOrdering(): void {
  console.log('Test: Deterministic ordering');

  const content = `app.get('/z', h);
app.get('/a', h);
app.post('/m', h);`;

  const facts1 = extractApiRoutes(content, 'src/app.ts');
  const facts2 = extractApiRoutes(content, 'src/app.ts');

  assert(JSON.stringify(facts1) === JSON.stringify(facts2), 'Multiple runs should produce identical results');

  console.log('  ✓ Deterministic ordering test passed');
}

function testEmptyContent(): void {
  console.log('Test: Empty content');

  const facts = extractApiRoutes('', 'src/empty.ts');
  assert(facts.length === 0, 'Empty content should produce no facts');

  const facts2 = extractApiRoutes('const x = 42;\nfunction hello() {}', 'src/no-routes.ts');
  assert(facts2.length === 0, 'Content without routes should produce no facts');

  console.log('  ✓ Empty content test passed');
}

function testMultipleRoutesOnOneLine(): void {
  console.log('Test: Template literal and double-quote paths');

  const content = "app.get(`/template`, h); app.post(\"/double\", h);";

  const facts = extractApiRoutes(content, 'src/inline.ts');

  assert(facts.length === 2, `Expected 2 routes, got ${facts.length}`);
  assert(facts[0]!.path === '/template', 'Should detect template literal path');
  assert(facts[1]!.path === '/double', 'Should detect double-quote path');

  console.log('  ✓ Template literal and double-quote paths test passed');
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

export { runTests };