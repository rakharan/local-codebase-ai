import { extractPackageMetadata } from '../extractors/package-extractor.js';
import type { PackageFacts } from '../types.js';

// Test fixtures
const validPackageJson = `{
  "name": "test-package",
  "version": "1.0.0",
  "scripts": {
    "build": "tsc",
    "test": "jest",
    "start": "node dist/index.js"
  },
  "dependencies": {
    "express": "^4.18.0",
    "lodash": "~4.17.21"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "@types/node": "*"
  }
}`;

const minimalPackageJson = `{
  "name": "minimal-package"
}`;

const invalidPackageJson = `{
  "name": "broken-package",
  "version": "1.0.0"
  // missing comma
}`;

const emptyPackageJson = `{}`;

function runTests(): void {
  console.log('Running package extractor tests...');
  
  testValidPackageJson();
  testMinimalPackageJson();
  testInvalidPackageJson();
  testEmptyPackageJson();
  testSourcePathAttribution();
  testDeterministicOrdering();
  
  console.log('✅ All package extractor tests passed!');
}

function testValidPackageJson(): void {
  console.log('Test: Valid package.json');
  
  const facts = extractPackageMetadata(validPackageJson, 'package.json');
  
  // Check metadata
  assert(facts.metadata.length === 2, 'Should extract name and version');
  assert(facts.metadata[0]?.value === 'Package name: test-package', 'Should extract correct name');
  assert(facts.metadata[1]?.value === 'Version: 1.0.0', 'Should extract correct version');
  assert(facts.metadata.every(f => f.confidence === 'high'), 'Metadata should have high confidence');
  
  // Check scripts
  assert(facts.scripts.length === 3, 'Should extract all scripts');
  assert(facts.scripts.some(s => s.value === 'build: tsc'), 'Should extract build script');
  assert(facts.scripts.every(f => f.confidence === 'high'), 'Scripts should have high confidence');
  
  // Check dependencies
  assert(facts.dependencies.length === 4, 'Should extract all dependencies');
  assert(facts.dependencies.some(d => d.value === 'express: ^4.18.0'), 'Should extract runtime dependency');
  assert(facts.dependencies.some(d => d.value === 'typescript: ^5.0.0 (dev)'), 'Should mark dev dependencies');
  assert(facts.dependencies.every(f => f.confidence === 'high'), 'Dependencies should have high confidence');
  
  console.log('  ✓ Valid package.json test passed');
}

function testMinimalPackageJson(): void {
  console.log('Test: Minimal package.json');
  
  const facts = extractPackageMetadata(minimalPackageJson);
  
  assert(facts.metadata.length === 1, 'Should extract only name');
  assert(facts.metadata[0]?.value === 'Package name: minimal-package', 'Should extract correct name');
  assert(facts.scripts.length === 0, 'Should have no scripts');
  assert(facts.dependencies.length === 0, 'Should have no dependencies');
  
  console.log('  ✓ Minimal package.json test passed');
}

function testInvalidPackageJson(): void {
  console.log('Test: Invalid package.json');
  
  const facts = extractPackageMetadata(invalidPackageJson, 'broken/package.json');
  
  assert(facts.metadata.length === 1, 'Should have one parse error fact');
  assert(facts.metadata[0]?.value === 'Parse error: Invalid JSON format', 'Should record parse error');
  assert(facts.metadata[0]?.confidence === 'low', 'Parse error should have low confidence');
  assert(facts.metadata[0]?.sourcePath === 'broken/package.json', 'Should preserve source path');
  
  console.log('  ✓ Invalid package.json test passed');
}

function testEmptyPackageJson(): void {
  console.log('Test: Empty package.json');
  
  const facts = extractPackageMetadata(emptyPackageJson);
  
  assert(facts.metadata.length === 0, 'Should extract no metadata from empty object');
  assert(facts.scripts.length === 0, 'Should have no scripts');
  assert(facts.dependencies.length === 0, 'Should have no dependencies');
  
  console.log('  ✓ Empty package.json test passed');
}

function testSourcePathAttribution(): void {
  console.log('Test: Source path attribution');
  
  const sourcePath = 'services/api/package.json';
  const facts = extractPackageMetadata(validPackageJson, sourcePath);
  
  assert(facts.metadata.every(f => f.sourcePath === sourcePath), 'All facts should have source path');
  assert(facts.scripts.every(f => f.sourcePath === sourcePath), 'All facts should have source path');
  assert(facts.dependencies.every(f => f.sourcePath === sourcePath), 'All facts should have source path');
  
  console.log('  ✓ Source path attribution test passed');
}

function testDeterministicOrdering(): void {
  console.log('Test: Deterministic ordering');
  
  // Run extraction multiple times
  const facts1 = extractPackageMetadata(validPackageJson);
  const facts2 = extractPackageMetadata(validPackageJson);
  
  // Should produce identical results
  assert(JSON.stringify(facts1) === JSON.stringify(facts2), 'Multiple runs should produce identical results');
  
  console.log('  ✓ Deterministic ordering test passed');
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

export { runTests };