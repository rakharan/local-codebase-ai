import path from 'node:path';
import fs from 'node:fs/promises';
import { readRepoFiles } from '../lib/files.js';
import { extractPackageMetadata } from './extractors/package-extractor.js';
import { extractEnvVars } from './extractors/env-extractor.js';
import { extractConfigDefaults } from './extractors/config-default-extractor.js';
import { extractApiRoutes } from './extractors/api-route-extractor.js';
import { extractRabbitMq } from './extractors/rabbitmq-extractor.js';
import { extractDatabase } from './extractors/database-extractor.js';
import { generateServicesMarkdown } from './generators/services-generator.js';
import { generateEnvMarkdown } from './generators/env-generator.js';
import { generateConfigMarkdown } from './generators/config-generator.js';
import { generateApiMarkdown } from './generators/api-generator.js';
import { generateRabbitMqMarkdown } from './generators/rabbitmq-generator.js';
import { generateDatabaseMarkdown } from './generators/database-generator.js';
import { generateArchitectureMarkdown } from './generators/architecture-generator.js';
import { generateOverviewMarkdown } from './generators/overview-generator.js';
import type { PackageFacts, EnvVarFact, ConfigDefaultFact, ApiRouteFact, RabbitMqFact, DatabaseFact } from './types.js';

export interface DoctorOptions {
  rootFolder: string;
  outputFolder: string;
  json?: boolean;
  failOnEmpty?: boolean;
  repoName?: string;
  serviceType?: string;
  include?: string[];
  exclude?: string[];
  maxFiles?: number;
  verbose?: boolean;
  silent?: boolean;
}

export interface DoctorReport {
  services: PackageFacts[];
  envVars: EnvVarFact[];
  configDefaults: ConfigDefaultFact[];
  apiRoutes: ApiRouteFact[];
  rabbitMq: RabbitMqFact[];
  database: DatabaseFact[];
  summary: {
    serviceCount: number;
    envVarCount: number;
    configDefaultCount: number;
    apiRouteCount: number;
    rabbitMqCount: number;
    databaseCount: number;
    filesScanned: number;
  };
}

/**
 * Main Repo Doctor orchestrator
 */
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const { rootFolder, outputFolder } = options;
  const log = makeLogger(options);

  // Validate
  validateOptions(options);
  await validatePaths(rootFolder, outputFolder);
  await fs.mkdir(outputFolder, { recursive: true });

  // Scan
  log(`Scanning: ${rootFolder}`);
  let files = await readRepoFiles(rootFolder, {
    ...(options.include ? { include: options.include } : {}),
    ...(options.exclude ? { exclude: options.exclude } : {}),
  });

  if (options.maxFiles && files.length > options.maxFiles) {
    files = files.slice(0, options.maxFiles);
    log(`Capped at ${options.maxFiles} files`);
  }
  log(`Files scanned: ${files.length}`);

  // Extract
  let packageFacts: PackageFacts[] = [];
  const envFacts: EnvVarFact[] = [];
  const configDefaultFacts: ConfigDefaultFact[] = [];
  const apiRouteFacts: ApiRouteFact[] = [];
  const rabbitMqFacts: RabbitMqFact[] = [];
  const databaseFacts: DatabaseFact[] = [];

  for (const file of files) {
    if (path.basename(file.relativePath) === 'package.json') {
      const facts = extractPackageMetadata(file.content, file.relativePath);
      packageFacts.push(facts);
    }
    envFacts.push(...extractEnvVars(file.content, file.relativePath));
    configDefaultFacts.push(...extractConfigDefaults(file.content, file.relativePath));
    apiRouteFacts.push(...extractApiRoutes(file.content, file.relativePath));
    rabbitMqFacts.push(...extractRabbitMq(file.content, file.relativePath));
    databaseFacts.push(...extractDatabase(file.content, file.relativePath));
  }

  // Filter by repo-name
  if (options.repoName) {
    packageFacts = packageFacts.filter(pkg => {
      const nameFact = pkg.metadata.find(m => m.value.startsWith('Package name:'));
      return nameFact?.value === `Package name: ${options.repoName}`;
    });
  }

  // fail-on-empty
  if (options.failOnEmpty && packageFacts.length === 0) {
    throw new Error('No services detected (--fail-on-empty)');
  }

  // Generate markdown
  await fs.writeFile(path.join(outputFolder, 'services.md'), generateServicesMarkdown(packageFacts), 'utf8');
  await fs.writeFile(path.join(outputFolder, 'env.md'), generateEnvMarkdown(envFacts), 'utf8');
  await fs.writeFile(path.join(outputFolder, 'config.md'), generateConfigMarkdown(configDefaultFacts), 'utf8');
  await fs.writeFile(path.join(outputFolder, 'api.md'), generateApiMarkdown(apiRouteFacts), 'utf8');
  await fs.writeFile(path.join(outputFolder, 'rabbitmq.md'), generateRabbitMqMarkdown(rabbitMqFacts), 'utf8');
  await fs.writeFile(path.join(outputFolder, 'database.md'), generateDatabaseMarkdown(databaseFacts), 'utf8');
  await fs.writeFile(path.join(outputFolder, 'architecture.md'), generateArchitectureMarkdown({ packageFacts, apiRouteFacts, rabbitMqFacts, databaseFacts }), 'utf8');
  await fs.writeFile(path.join(outputFolder, 'overview.md'), generateOverviewMarkdown({ packageFacts, envFacts, configDefaultFacts, apiRouteFacts, rabbitMqFacts, databaseFacts }), 'utf8');

  // Build report
  const report: DoctorReport = {
    services: packageFacts,
    envVars: envFacts,
    configDefaults: configDefaultFacts,
    apiRoutes: apiRouteFacts,
    rabbitMq: rabbitMqFacts,
    database: databaseFacts,
    summary: {
      serviceCount: packageFacts.length,
      envVarCount: envFacts.length,
      configDefaultCount: configDefaultFacts.length,
      apiRouteCount: apiRouteFacts.length,
      rabbitMqCount: rabbitMqFacts.length,
      databaseCount: databaseFacts.length,
      filesScanned: files.length,
    },
  };

  // JSON output
  if (options.json) {
    await fs.writeFile(path.join(outputFolder, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    log('Generated: report.json');
  }

  log(`Documentation generated in: ${outputFolder}`);
  log(`Generated files: overview.md, services.md, env.md, config.md, api.md, rabbitmq.md, database.md, architecture.md`);
  log(`Summary: ${report.summary.serviceCount} services, ${report.summary.envVarCount} env vars, ${report.summary.configDefaultCount} config defaults, ${report.summary.apiRouteCount} routes, ${report.summary.rabbitMqCount} MQ, ${report.summary.databaseCount} DB`);

  return report;
}

function validateOptions(options: DoctorOptions): void {
  if (options.verbose && options.silent) {
    throw new Error('--verbose and --silent cannot be used together');
  }
  if (options.maxFiles !== undefined && (options.maxFiles < 1 || !Number.isInteger(options.maxFiles))) {
    throw new Error('--max-files must be a positive integer');
  }
  const validServiceTypes = ['api', 'worker', 'cron', 'library', 'unknown'];
  if (options.serviceType && !validServiceTypes.includes(options.serviceType)) {
    throw new Error(`--service-type must be one of: ${validServiceTypes.join(', ')}`);
  }
}

function makeLogger(options: DoctorOptions): (msg: string) => void {
  if (options.silent) return () => {};
  if (options.verbose) return (msg: string) => console.log(`[doctor] ${msg}`);
  return () => {};
}

async function validatePaths(rootFolder: string, outputFolder: string): Promise<void> {
  try {
    const rootStat = await fs.stat(rootFolder);
    if (!rootStat.isDirectory()) {
      throw new Error(`Root folder is not a directory: ${rootFolder}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Root folder does not exist: ${rootFolder}`);
    }
    throw error;
  }

  const rootAbsolute = path.resolve(rootFolder);
  const outputAbsolute = path.resolve(outputFolder);

  if (outputAbsolute.startsWith(rootAbsolute + path.sep) || outputAbsolute === rootAbsolute) {
    throw new Error(`Output directory cannot be inside the target repository: ${outputFolder}`);
  }
}
