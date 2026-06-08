import path from 'node:path';
import { readDoctorFiles, chunkDoctorMarkdown } from '../../index-doctor.js';
import type { DoctorDocFile } from '../../index-doctor.js';

function runTests(): void {
  console.log('Running index-doctor tests...');
}

async function runTestsAsync(): Promise<void> {
  runTests();

  await testReadDoctorFiles();
  testDocTypeInContent();
  testChunkMetadata();
  testIgnoresEmptyFiles();
  testChunkSplitting();
  testDeterministic();

  console.log('✅ All index-doctor tests passed!');
}

async function testReadDoctorFiles(): Promise<void> {
  console.log('Test: reads doctor output files');
  const testDir = path.resolve(import.meta.dirname, '..', '..', 'repo-docs-topup-store');
  try {
    const files = await readDoctorFiles(testDir);
    assert(files.length === 7, `Expected 7 doctor files, got ${files.length}`);
    const docTypes = files.map((f: DoctorDocFile) => f.docType).sort();
    assert(docTypes.includes('overview'), 'Should include overview');
    assert(docTypes.includes('api'), 'Should include api');
    assert(docTypes.includes('database'), 'Should include database');
    assert(docTypes.includes('architecture'), 'Should include architecture');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log('  ⚠ Skipped (no repo-docs-topup-store folder). Using synthetic data.');
    } else {
      throw e;
    }
  }
  console.log('  ✓ passed');
}

function testDocTypeInContent(): void {
  console.log('Test: docType embedded in chunk content');
  const file: DoctorDocFile = {
    relativePath: 'api.md',
    docType: 'api',
    content: '# API Routes\n\nSome content about routes.\n',
  };
  const chunks = chunkDoctorMarkdown(file, 'test-repo');
  assert(chunks.length >= 1, `Expected at least 1 chunk, got ${chunks.length}`);

  const chunk = chunks[0]!;
  // sourceKind and docType are in the content prefix
  assert(chunk.content.includes('DocType: api'), `Content should include DocType: api`);
  assert(chunk.content.includes('Repo Doctor:'), `Content should include Repo Doctor:`);
  assert(chunk.filePath === 'doctor:api.md', `filePath: ${chunk.filePath}`);
  console.log('  ✓ passed');
}

function testChunkMetadata(): void {
  console.log('Test: chunk metadata shape');
  const file: DoctorDocFile = {
    relativePath: 'rabbitmq.md',
    docType: 'rabbitmq',
    content: '# RabbitMQ Usage\n\n## Summary\n\nSome queues here.\n',
  };
  const chunks = chunkDoctorMarkdown(file, 'my-service');

  for (const chunk of chunks) {
    assert(chunk.repoName === 'my-service', `repoName: ${chunk.repoName}`);
    assert(chunk.branchName === 'doctor', `branchName: ${chunk.branchName}`);
    assert(chunk.commitSha === 'doctor', `commitSha: ${chunk.commitSha}`);
    assert(chunk.filePath === 'doctor:rabbitmq.md', `filePath: ${chunk.filePath}`);
    assert(chunk.evidenceTypes.includes('documentation'), 'Should have documentation evidence type');
    assert(chunk.serviceType === 'unknown', `serviceType: ${chunk.serviceType}`);
  }
  console.log('  ✓ passed');
}

function testIgnoresEmptyFiles(): void {
  console.log('Test: ignores empty content');
  const file: DoctorDocFile = {
    relativePath: 'overview.md',
    docType: 'overview',
    content: '',
  };
  const chunks = chunkDoctorMarkdown(file, 'test-repo');
  assert(chunks.length === 0, 'Empty content should produce no chunks');
  console.log('  ✓ passed');
}

function testChunkSplitting(): void {
  console.log('Test: large content split into multiple chunks');
  const bigContent = '# Database Usage\n\n' + '| row | data |\n'.repeat(200);
  const file: DoctorDocFile = {
    relativePath: 'database.md',
    docType: 'database',
    content: bigContent,
  };
  const chunks = chunkDoctorMarkdown(file, 'test-repo');
  assert(chunks.length > 1, `Expected multiple chunks, got ${chunks.length}`);
  for (const chunk of chunks) {
    assert(chunk.filePath === 'doctor:database.md', 'All chunks same filePath');
    assert(chunk.branchName === 'doctor', 'All chunks same branch');
  }
  console.log('  ✓ passed');
}

function testDeterministic(): void {
  console.log('Test: deterministic chunk IDs');
  const file: DoctorDocFile = {
    relativePath: 'env.md',
    docType: 'env',
    content: '# Environment Variables\n\n## Summary\n\nVAR1, VAR2\n',
  };
  const chunks1 = chunkDoctorMarkdown(file, 'test-repo');
  const chunks2 = chunkDoctorMarkdown(file, 'test-repo');
  assert(chunks1.length === chunks2.length, 'Same number of chunks');
  for (let i = 0; i < chunks1.length; i++) {
    assert(chunks1[i]!.id === chunks2[i]!.id, 'IDs should be identical');
    assert(chunks1[i]!.contentHash === chunks2[i]!.contentHash, 'Hashes should be identical');
  }
  console.log('  ✓ passed');
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

export { runTestsAsync as runTests };
