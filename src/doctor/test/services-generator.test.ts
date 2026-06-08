import { generateServicesMarkdown } from '../generators/services-generator.js';
import type { PackageFacts } from '../types.js';

// Test fixtures
const samplePackageFacts: PackageFacts[] = [
  {
    metadata: [
      { value: 'Package name: test-api', sourcePath: 'api/package.json', confidence: 'high' },
      { value: 'Version: 1.2.3', sourcePath: 'api/package.json', confidence: 'high' }
    ],
    scripts: [
      { value: 'start: node index.js', sourcePath: 'api/package.json', confidence: 'high' },
      { value: 'test: jest', sourcePath: 'api/package.json', confidence: 'high' }
    ],
    dependencies: [
      { value: 'express: ^4.18.0', sourcePath: 'api/package.json', confidence: 'high' },
      { value: 'typescript: ^5.0.0 (dev)', sourcePath: 'api/package.json', confidence: 'high' }
    ]
  },
  {
    metadata: [
      { value: 'Package name: test-client', sourcePath: 'client/package.json', confidence: 'high' }
    ],
    scripts: [
      { value: 'build: webpack', sourcePath: 'client/package.json', confidence: 'high' }
    ],
    dependencies: [
      { value: 'react: ^18.0.0', sourcePath: 'client/package.json', confidence: 'high' }
    ]
  }
];

const emptyPackageFacts: PackageFacts[] = [];

function runTests(): void {
  console.log('Running services generator tests...');
  
  testValidPackageFacts();
  testEmptyPackageFacts();
  testMarkdownFormatting();
  testDeterministicOrdering();
  
  console.log('✅ All services generator tests passed!');
}

function testValidPackageFacts(): void {
  console.log('Test: Valid package facts');
  
  const markdown = generateServicesMarkdown(samplePackageFacts);
  
  // Check structure
  assert(markdown.includes('# Services'), 'Should have main header');
  assert(markdown.includes('## Package: api/package.json'), 'Should have package sections');
  assert(markdown.includes('## Package: client/package.json'), 'Should have package sections');
  
  // Check content sections
  assert(markdown.includes('### Metadata'), 'Should have metadata sections');
  assert(markdown.includes('### Scripts'), 'Should have scripts sections');
  assert(markdown.includes('### Dependencies'), 'Should have dependencies sections');
  
  // Check facts are included
  assert(markdown.includes('Package name: test-api'), 'Should include package name');
  assert(markdown.includes('express: ^4.18.0'), 'Should include dependencies');
  assert(markdown.includes('start: node index.js'), 'Should include scripts');
  
  // Check confidence labels
  assert(markdown.includes('*(confidence: high)*'), 'Should include confidence labels');
  
  console.log('  ✓ Valid package facts test passed');
}

function testEmptyPackageFacts(): void {
  console.log('Test: Empty package facts');
  
  const markdown = generateServicesMarkdown(emptyPackageFacts);
  
  assert(markdown.includes('# Services'), 'Should have main header');
  assert(markdown.includes('No package.json files were detected'), 'Should show empty message');
  assert(!markdown.includes('## Package'), 'Should not have package sections');
  
  console.log('  ✓ Empty package facts test passed');
}

function testMarkdownFormatting(): void {
  console.log('Test: Markdown formatting');
  
  const markdown = generateServicesMarkdown(samplePackageFacts);
  
  // Check valid markdown structure
  const lines = markdown.split('\n');
  
  // Headers should be properly formatted
  assert(lines.some(line => line === '# Services'), 'Should have proper main header');
  assert(lines.some(line => line.startsWith('## Package:')), 'Should have proper section headers');
  assert(lines.some(line => line.startsWith('### ')), 'Should have proper subsection headers');
  
  // Lists should be properly formatted
  assert(lines.some(line => line.startsWith('- ')), 'Should have proper list items');
  
  // Should have proper empty lines for readability
  assert(lines.includes(''), 'Should have empty lines for structure');
  
  console.log('  ✓ Markdown formatting test passed');
}

function testDeterministicOrdering(): void {
  console.log('Test: Deterministic ordering');
  
  // Shuffle the input order and test multiple times
  const shuffledFacts = [...samplePackageFacts].reverse();
  
  const markdown1 = generateServicesMarkdown(samplePackageFacts);
  const markdown2 = generateServicesMarkdown(shuffledFacts);
  
  // Should produce identical output regardless of input order
  assert(markdown1 === markdown2, 'Should produce identical output regardless of input order');
  
  console.log('  ✓ Deterministic ordering test passed');
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

export { runTests };