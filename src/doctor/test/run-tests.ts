import { runTests as runPackageExtractorTests } from './package-extractor.test.js';
import { runTests as runServicesGeneratorTests } from './services-generator.test.js';
import { runTests as runEnvExtractorTests } from './env-extractor.test.js';
import { runTests as runEnvGeneratorTests } from './env-generator.test.js';
import { runTests as runApiRouteExtractorTests } from './api-route-extractor.test.js';
import { runTests as runApiGeneratorTests } from './api-generator.test.js';
import { runTests as runRabbitMqExtractorTests } from './rabbitmq-extractor.test.js';
import { runTests as runRabbitMqGeneratorTests } from './rabbitmq-generator.test.js';
import { runTests as runDatabaseExtractorTests } from './database-extractor.test.js';
import { runTests as runDatabaseGeneratorTests } from './database-generator.test.js';
import { runTests as runArchitectureGeneratorTests } from './architecture-generator.test.js';
import { runTests as runOverviewGeneratorTests } from './overview-generator.test.js';
import { runTests as runPhase8Tests } from './phase8-integration.test.js';
import { runTests as runIndexDoctorTests } from './index-doctor.test.js';
import { runTests as runDoctorReportChunksTests } from './doctor-report-chunks.test.js';

console.log('🧪 Running Repo Doctor tests...\n');

async function main(): Promise<void> {
  runPackageExtractorTests();
  console.log('');
  runServicesGeneratorTests();
  console.log('');
  runEnvExtractorTests();
  console.log('');
  runEnvGeneratorTests();
  console.log('');
  runApiRouteExtractorTests();
  console.log('');
  runApiGeneratorTests();
  console.log('');
  runRabbitMqExtractorTests();
  console.log('');
  runRabbitMqGeneratorTests();
  console.log('');
  runDatabaseExtractorTests();
  console.log('');
  runDatabaseGeneratorTests();
  console.log('');
  runArchitectureGeneratorTests();
  console.log('');
  runOverviewGeneratorTests();
  console.log('');
  await runPhase8Tests();
  console.log('');
  await runIndexDoctorTests();
  console.log('');
  runDoctorReportChunksTests();
  console.log('');
  console.log('🎉 All tests passed successfully!');
}

main().catch((error) => {
  console.error('❌ Test failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});