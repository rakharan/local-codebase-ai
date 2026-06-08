import type { PackageFacts } from '../types.js';

/**
 * Generates services.md content from extracted package facts
 * Pure function that converts structured facts into Markdown
 */
export function generateServicesMarkdown(packageFacts: PackageFacts[]): string {
  const lines: string[] = [];
  
  lines.push('# Services');
  lines.push('');
  lines.push('This document lists the services and components detected in the repository.');
  lines.push('');

  if (packageFacts.length === 0) {
    lines.push('No package.json files were detected in this repository.');
    lines.push('');
    return lines.join('\n');
  }

  // Sort facts by source path for deterministic output
  const sortedFacts = packageFacts.sort((a, b) => {
    const aPath = a.metadata[0]?.sourcePath || '';
    const bPath = b.metadata[0]?.sourcePath || '';
    return aPath.localeCompare(bPath);
  });

  for (const facts of sortedFacts) {
    const sourcePath = facts.metadata[0]?.sourcePath;
    if (sourcePath) {
      lines.push(`## Package: ${sourcePath}`);
    } else {
      lines.push('## Package');
    }
    lines.push('');

    // Metadata section
    if (facts.metadata.length > 0) {
      lines.push('### Metadata');
      lines.push('');
      for (const fact of facts.metadata.sort((a, b) => a.value.localeCompare(b.value))) {
        lines.push(`- ${fact.value} *(confidence: ${fact.confidence})*`);
      }
      lines.push('');
    }

    // Scripts section
    if (facts.scripts.length > 0) {
      lines.push('### Scripts');
      lines.push('');
      for (const fact of facts.scripts.sort((a, b) => a.value.localeCompare(b.value))) {
        lines.push(`- ${fact.value} *(confidence: ${fact.confidence})*`);
      }
      lines.push('');
    }

    // Dependencies section
    if (facts.dependencies.length > 0) {
      lines.push('### Dependencies');
      lines.push('');
      for (const fact of facts.dependencies.sort((a, b) => a.value.localeCompare(b.value))) {
        lines.push(`- ${fact.value} *(confidence: ${fact.confidence})*`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}