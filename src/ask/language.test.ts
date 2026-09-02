import { heuristicAnswerLanguage } from './language.js';

function runTests(): void {
  console.log('Running language heuristic tests...');

  testEnglishHeuristic();
  testIndonesianHeuristic();
  testAmbiguousReturnsUnknown();
  testIndonesianSlang();
  testEnglishWithCodeIdentifiers();
  testEmptyString();

  console.log('All language heuristic tests passed!');
}

function testEnglishHeuristic(): void {
  console.log('Test: English heuristic detects common question words');

  assert(heuristicAnswerLanguage('What does this endpoint do?') === 'en', 'What-question should be English');
  assert(heuristicAnswerLanguage('Which services call the mrg API?') === 'en', 'Which-question should be English');
  assert(heuristicAnswerLanguage('How does isignal work?') === 'en', 'How-question should be English');
  assert(heuristicAnswerLanguage('Explain the flow of SubmitDepositDemo') === 'en', 'Explain should be English');
  assert(heuristicAnswerLanguage('List all MT4 account types') === 'en', 'List should be English');

  console.log('  English heuristic test passed');
}

function testIndonesianHeuristic(): void {
  console.log('Test: Indonesian heuristic detects common question words');

  assert(heuristicAnswerLanguage('Apa itu mrg?') === 'id', 'Apa-question should be Indonesian');
  assert(heuristicAnswerLanguage('Bagaimana alur endpoint ini?') === 'id', 'Bagaimana should be Indonesian');
  assert(heuristicAnswerLanguage('Jelaskan flow request account demo') === 'id', 'Jelaskan should be Indonesian');
  assert(heuristicAnswerLanguage('Berikan list tipe akun mt4') === 'id', 'Berikan should be Indonesian');
  assert(heuristicAnswerLanguage('validasi dan return dari endpoint') === 'id', 'validasi should be Indonesian');

  console.log('  Indonesian heuristic test passed');
}

function testAmbiguousReturnsUnknown(): void {
  console.log('Test: Ambiguous input returns unknown (triggers LLM fallback)');

  // Pure identifier with no language indicator words.
  assert(heuristicAnswerLanguage('SubmitDepositDemo') === 'unknown', 'Bare identifier should be unknown');
  assert(heuristicAnswerLanguage('MRG SubmitDepositDemo') === 'unknown', 'Identifier combo should be unknown');
  assert(heuristicAnswerLanguage('/mrg/api/v1/deposit/demo/') === 'unknown', 'Bare route should be unknown');

  console.log('  Ambiguous/unknown test passed');
}

function testIndonesianSlang(): void {
  console.log('Test: Indonesian slang detected as Indonesian');

  assert(heuristicAnswerLanguage('gimana cara kerja isignal?') === 'id', 'gimana should be Indonesian');
  assert(heuristicAnswerLanguage('kenapa SubmitDepositDemo error?') === 'id', 'kenapa should be Indonesian');

  console.log('  Indonesian slang test passed');
}

function testEnglishWithCodeIdentifiers(): void {
  console.log('Test: English question with code identifiers stays English');

  // Even with identifiers, the English indicator word should win.
  assert(heuristicAnswerLanguage('What is SubmitDepositDemo?') === 'en', 'What+identifier should be English');
  assert(heuristicAnswerLanguage('Show me the deposit_demo flow') === 'en', 'Show+identifier should be English');

  console.log('  English+identifier test passed');
}

function testEmptyString(): void {
  console.log('Test: Empty string returns unknown');

  assert(heuristicAnswerLanguage('') === 'unknown', 'Empty string should be unknown');

  console.log('  Empty string test passed');
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

export { runTests };
