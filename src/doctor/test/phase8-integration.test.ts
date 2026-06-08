import path from 'node:path';
import fs from 'node:fs/promises';
import { runDoctor } from '../doctor.js';
import type { DoctorReport } from '../doctor.js';

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures', 'api-service');
const TMP_OUT = path.resolve(import.meta.dirname, '..', '..', '..', '.tmp-doctor-test');

async function cleanup(): Promise<void> {
  await fs.rm(TMP_OUT, { recursive: true, force: true });
}

function runTests(): void {
  console.log('Running Phase 8 integration tests...');
}

async function runTestsAsync(): Promise<void> {
  runTests();

  await testBasicRun();
  await testJsonOutput();
  await testFailOnEmpty();
  await testRepoNameFilter();
  await testMaxFiles();
  await testIncludeExclude();
  await testVerboseSilentConflict();
  await testMaxFilesValidation();
  await testServiceTypeValidation();

  await cleanup();
  console.log('✅ All Phase 8 integration tests passed!');
}

async function testBasicRun(): Promise<void> {
  console.log('Test: basic run');
  await cleanup();
  const report = await runDoctor({ rootFolder: FIXTURES, outputFolder: TMP_OUT, silent: true });
  assert(report.summary.serviceCount === 1, `Services: ${report.summary.serviceCount}`);
  assert(report.summary.apiRouteCount === 3, `Routes: ${report.summary.apiRouteCount}`);
  assert(report.summary.envVarCount >= 2, `Env: ${report.summary.envVarCount}`);
  assert(report.summary.databaseCount >= 2, `DB: ${report.summary.databaseCount}`);

  // Check files exist
  const files = await fs.readdir(TMP_OUT);
  assert(files.includes('overview.md'), 'Has overview.md');
  assert(files.includes('services.md'), 'Has services.md');
  assert(files.includes('api.md'), 'Has api.md');
  console.log('  ✓ passed');
}

async function testJsonOutput(): Promise<void> {
  console.log('Test: --json output');
  await cleanup();
  await runDoctor({ rootFolder: FIXTURES, outputFolder: TMP_OUT, json: true, silent: true });
  const reportPath = path.join(TMP_OUT, 'report.json');
  const content = await fs.readFile(reportPath, 'utf8');
  const report: DoctorReport = JSON.parse(content);
  assert(report.summary.serviceCount === 1, 'JSON has correct service count');
  assert(Array.isArray(report.apiRoutes), 'JSON has apiRoutes array');
  assert(Array.isArray(report.envVars), 'JSON has envVars array');
  assert(Array.isArray(report.rabbitMq), 'JSON has rabbitMq array');
  assert(Array.isArray(report.database), 'JSON has database array');

  // Deterministic: run again and compare
  await runDoctor({ rootFolder: FIXTURES, outputFolder: TMP_OUT, json: true, silent: true });
  const content2 = await fs.readFile(reportPath, 'utf8');
  assert(content === content2, 'JSON output is deterministic');
  console.log('  ✓ passed');
}

async function testFailOnEmpty(): Promise<void> {
  console.log('Test: --fail-on-empty');
  await cleanup();
  // With a repo that has a service, should not fail
  await runDoctor({ rootFolder: FIXTURES, outputFolder: TMP_OUT, failOnEmpty: true, silent: true });

  // With a nonexistent repo-name filter, should fail
  try {
    await runDoctor({ rootFolder: FIXTURES, outputFolder: TMP_OUT, failOnEmpty: true, repoName: 'nonexistent', silent: true });
    assert(false, 'Should have thrown');
  } catch (e) {
    assert((e as Error).message.includes('--fail-on-empty'), `Error: ${(e as Error).message}`);
  }
  console.log('  ✓ passed');
}

async function testRepoNameFilter(): Promise<void> {
  console.log('Test: --repo-name filter');
  await cleanup();
  const report = await runDoctor({ rootFolder: FIXTURES, outputFolder: TMP_OUT, repoName: 'api-service', silent: true });
  assert(report.summary.serviceCount === 1, 'Finds matching service');

  await cleanup();
  const report2 = await runDoctor({ rootFolder: FIXTURES, outputFolder: TMP_OUT, repoName: 'wrong-name', silent: true });
  assert(report2.summary.serviceCount === 0, 'Filters out non-matching');
  console.log('  ✓ passed');
}

async function testMaxFiles(): Promise<void> {
  console.log('Test: --max-files');
  await cleanup();
  const report = await runDoctor({ rootFolder: FIXTURES, outputFolder: TMP_OUT, maxFiles: 1, silent: true });
  assert(report.summary.filesScanned === 1, `Files: ${report.summary.filesScanned}`);
  console.log('  ✓ passed');
}

async function testIncludeExclude(): Promise<void> {
  console.log('Test: --include / --exclude');
  await cleanup();
  // Only include package.json
  const report = await runDoctor({ rootFolder: FIXTURES, outputFolder: TMP_OUT, include: ['package.json'], silent: true });
  assert(report.summary.serviceCount === 1, 'Has service from package.json');
  assert(report.summary.apiRouteCount === 0, 'No routes (source excluded)');

  // Exclude src
  await cleanup();
  const report2 = await runDoctor({ rootFolder: FIXTURES, outputFolder: TMP_OUT, exclude: ['src/**'], silent: true });
  assert(report2.summary.apiRouteCount === 0, 'No routes when src excluded');
  console.log('  ✓ passed');
}

async function testVerboseSilentConflict(): Promise<void> {
  console.log('Test: --verbose + --silent conflict');
  try {
    await runDoctor({ rootFolder: FIXTURES, outputFolder: TMP_OUT, verbose: true, silent: true });
    assert(false, 'Should have thrown');
  } catch (e) {
    assert((e as Error).message.includes('cannot be used together'), `Error: ${(e as Error).message}`);
  }
  console.log('  ✓ passed');
}

async function testMaxFilesValidation(): Promise<void> {
  console.log('Test: --max-files validation');
  try {
    await runDoctor({ rootFolder: FIXTURES, outputFolder: TMP_OUT, maxFiles: -1, silent: true });
    assert(false, 'Should have thrown');
  } catch (e) {
    assert((e as Error).message.includes('positive integer'), `Error: ${(e as Error).message}`);
  }
  try {
    await runDoctor({ rootFolder: FIXTURES, outputFolder: TMP_OUT, maxFiles: 1.5, silent: true });
    assert(false, 'Should have thrown');
  } catch (e) {
    assert((e as Error).message.includes('positive integer'), `Error: ${(e as Error).message}`);
  }
  console.log('  ✓ passed');
}

async function testServiceTypeValidation(): Promise<void> {
  console.log('Test: --service-type validation');
  try {
    await runDoctor({ rootFolder: FIXTURES, outputFolder: TMP_OUT, serviceType: 'invalid', silent: true });
    assert(false, 'Should have thrown');
  } catch (e) {
    assert((e as Error).message.includes('must be one of'), `Error: ${(e as Error).message}`);
  }
  console.log('  ✓ passed');
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

export { runTestsAsync as runTests };
