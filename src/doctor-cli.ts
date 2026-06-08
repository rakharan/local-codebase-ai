#!/usr/bin/env node

import { program } from 'commander';
import { runDoctor } from './doctor/doctor.js';

program
  .name('doctor')
  .description('Deterministic documentation generator for repositories')
  .argument('<root-folder>', 'Root folder of the target repository to scan')
  .requiredOption('--output <folder>', 'Output folder for generated documentation')
  .option('--json', 'Also write a machine-readable report.json')
  .option('--fail-on-empty', 'Exit with non-zero code if no services are detected')
  .option('--repo-name <name>', 'Only include service matching this package name')
  .option('--service-type <type>', 'Filter by service type (api, worker, cron, library, unknown)')
  .option('--include <glob...>', 'Additional include patterns for file scanning')
  .option('--exclude <glob...>', 'Additional exclude patterns for file scanning')
  .option('--max-files <number>', 'Stop scanning after this many files', parseInt)
  .option('--verbose', 'Print scan progress and summary counts')
  .option('--silent', 'Suppress normal console output except errors')
  .action(async (rootFolder: string, opts: {
    output: string;
    json?: true;
    failOnEmpty?: true;
    repoName?: string;
    serviceType?: string;
    include?: string[];
    exclude?: string[];
    maxFiles?: number;
    verbose?: true;
    silent?: true;
  }) => {
    try {
      await runDoctor({
        rootFolder,
        outputFolder: opts.output,
        ...(opts.json ? { json: true } : {}),
        ...(opts.failOnEmpty ? { failOnEmpty: true } : {}),
        ...(opts.repoName ? { repoName: opts.repoName } : {}),
        ...(opts.serviceType ? { serviceType: opts.serviceType } : {}),
        ...(opts.include ? { include: opts.include } : {}),
        ...(opts.exclude ? { exclude: opts.exclude } : {}),
        ...(opts.maxFiles ? { maxFiles: opts.maxFiles } : {}),
        ...(opts.verbose ? { verbose: true } : {}),
        ...(opts.silent ? { silent: true } : {}),
      });
      process.exit(0);
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program.parse();
