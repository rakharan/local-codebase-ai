import { extractDatabase } from '../extractors/database-extractor.js';

function runTests(): void {
  console.log('Running database extractor tests...');

  testSelectFrom();
  testJoin();
  testInsertInto();
  testUpdateSet();
  testDeleteFrom();
  testEntityDecorator();
  testGetRepository();
  testSkipsSqlKeywords();
  testSkipsCommentLines();
  testSkipsDigitLeadingNames();
  testLineNumbers();
  testEmptyContent();
  testSchemaQualified();

  console.log('✅ All database extractor tests passed!');
}

function testSelectFrom(): void {
  console.log('Test: SELECT FROM');
  const facts = extractDatabase(`const q = "SELECT id, name FROM users WHERE active = 1";`, 'src/repo.ts');
  assert(facts.length === 1, `Expected 1, got ${facts.length}`);
  assert(facts[0]!.name === 'users', `Name: ${facts[0]!.name}`);
  assert(facts[0]!.kind === 'table', `Kind: ${facts[0]!.kind}`);
  assert(facts[0]!.operation === 'select', `Op: ${facts[0]!.operation}`);
  console.log('  ✓ passed');
}

function testJoin(): void {
  console.log('Test: JOIN');
  const facts = extractDatabase(`const q = "SELECT u.id FROM users u JOIN orders o ON u.id = o.user_id";`, 'src/repo.ts');
  const joinFact = facts.find(f => f.operation === 'join');
  assert(joinFact !== undefined, 'Should find JOIN');
  assert(joinFact!.name === 'orders', `Name: ${joinFact!.name}`);
  console.log('  ✓ passed');
}

function testInsertInto(): void {
  console.log('Test: INSERT INTO');
  const facts = extractDatabase(`db.query("INSERT INTO payments (amount) VALUES (100)");`, 'src/pay.ts');
  assert(facts.length === 1, `Expected 1, got ${facts.length}`);
  assert(facts[0]!.name === 'payments', `Name: ${facts[0]!.name}`);
  assert(facts[0]!.operation === 'insert', `Op: ${facts[0]!.operation}`);
  console.log('  ✓ passed');
}

function testUpdateSet(): void {
  console.log('Test: UPDATE SET');
  const facts = extractDatabase(`db.query("UPDATE accounts SET balance = 0 WHERE id = 1");`, 'src/db.ts');
  assert(facts.length === 1, `Expected 1, got ${facts.length}`);
  assert(facts[0]!.name === 'accounts', `Name: ${facts[0]!.name}`);
  assert(facts[0]!.operation === 'update', `Op: ${facts[0]!.operation}`);
  console.log('  ✓ passed');
}

function testDeleteFrom(): void {
  console.log('Test: DELETE FROM');
  const facts = extractDatabase(`db.query("DELETE FROM sessions WHERE expired = true");`, 'src/db.ts');
  assert(facts.length === 1, `Expected 1, got ${facts.length}`);
  assert(facts[0]!.name === 'sessions', `Name: ${facts[0]!.name}`);
  assert(facts[0]!.operation === 'delete', `Op: ${facts[0]!.operation}`);
  console.log('  ✓ passed');
}

function testEntityDecorator(): void {
  console.log('Test: @Entity decorator');
  const facts = extractDatabase(`@Entity("user_profiles")`, 'src/entity.ts');
  assert(facts.length === 1, `Expected 1, got ${facts.length}`);
  assert(facts[0]!.name === 'user_profiles', `Name: ${facts[0]!.name}`);
  assert(facts[0]!.kind === 'entity', `Kind: ${facts[0]!.kind}`);
  assert(facts[0]!.operation === 'entity', `Op: ${facts[0]!.operation}`);
  assert(facts[0]!.confidence === 'high', `Confidence: ${facts[0]!.confidence}`);
  console.log('  ✓ passed');
}

function testGetRepository(): void {
  console.log('Test: getRepository');
  const facts = extractDatabase(`const repo = dataSource.getRepository(UserEntity);`, 'src/svc.ts');
  assert(facts.length === 1, `Expected 1, got ${facts.length}`);
  assert(facts[0]!.name === 'UserEntity', `Name: ${facts[0]!.name}`);
  assert(facts[0]!.kind === 'repository', `Kind: ${facts[0]!.kind}`);
  assert(facts[0]!.operation === 'repository', `Op: ${facts[0]!.operation}`);
  assert(facts[0]!.confidence === 'medium', `Confidence: ${facts[0]!.confidence}`);
  console.log('  ✓ passed');
}

function testSkipsSqlKeywords(): void {
  console.log('Test: skips SQL keywords as table names');
  // "JOIN inner" should be skipped because "inner" is a keyword
  const facts = extractDatabase(`const q = "SELECT x FROM inner";`, 'src/x.ts');
  assert(facts.length === 0, `Expected 0 (inner is keyword), got ${facts.length}`);
  console.log('  ✓ passed');
}

function testLineNumbers(): void {
  console.log('Test: line numbers');
  const content = `// line 1\n// line 2\nconst q = "SELECT id FROM users";\n// line 4\nconst q2 = "INSERT INTO orders (x) VALUES (1)";`;
  const facts = extractDatabase(content, 'src/db.ts');
  assert(facts[0]!.line === 3, `Expected line 3, got ${facts[0]!.line}`);
  assert(facts[1]!.line === 5, `Expected line 5, got ${facts[1]!.line}`);
  console.log('  ✓ passed');
}

function testSkipsCommentLines(): void {
  console.log('Test: skips comment lines');
  // Real case: "* Dibuat left join 2x ke dsc_subs_active..."
  const content = `  * Dibuat left join 2x ke dsc_subs_active...\n  // SELECT id FROM fake_table\n  -- DELETE FROM also_fake\n  # JOIN comment_table ON x = y`;
  const facts = extractDatabase(content, 'src/model.js');
  assert(facts.length === 0, `Expected 0 from comments, got ${facts.length}`);
  console.log('  ✓ passed');
}

function testSkipsDigitLeadingNames(): void {
  console.log('Test: skips digit-leading table names');
  const content = `const q = "SELECT x FROM 2x_invalid";`;
  const facts = extractDatabase(content, 'src/db.ts');
  assert(facts.length === 0, `Expected 0 for digit-leading name, got ${facts.length}`);
  console.log('  ✓ passed');
}

function testEmptyContent(): void {
  console.log('Test: empty content');
  assert(extractDatabase('', 'src/x.ts').length === 0, 'Empty should produce 0');
  assert(extractDatabase('const x = 42;', 'src/x.ts').length === 0, 'No SQL should produce 0');
  console.log('  ✓ passed');
}

function testSchemaQualified(): void {
  console.log('Test: schema-qualified table');
  const facts = extractDatabase(`const q = "SELECT id FROM public.users WHERE 1=1";`, 'src/db.ts');
  assert(facts.length === 1, `Expected 1, got ${facts.length}`);
  assert(facts[0]!.name === 'public.users', `Name: ${facts[0]!.name}`);
  console.log('  ✓ passed');
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

export { runTests };
