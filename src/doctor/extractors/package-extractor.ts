import type { ExtractedFact, PackageFacts } from '../types.js';

/** Helper: build an ExtractedFact with optional sourcePath */
function makeFact(value: string, sourcePath: string | undefined, confidence: ExtractedFact['confidence']): ExtractedFact {
  const fact: ExtractedFact = { value, confidence };
  if (sourcePath !== undefined) {
    fact.sourcePath = sourcePath;
  }
  return fact;
}

/**
 * Extracts package metadata from package.json content.
 * Pure function: accepts string content and returns structured facts.
 */
export function extractPackageMetadata(content: string, sourcePath?: string): PackageFacts {
  const facts: PackageFacts = {
    metadata: [],
    dependencies: [],
    scripts: []
  };

  try {
    const pkg = JSON.parse(content) as Record<string, unknown>;

    if (typeof pkg.name === 'string') {
      facts.metadata.push(makeFact(`Package name: ${pkg.name}`, sourcePath, 'high'));
    }

    if (typeof pkg.version === 'string') {
      facts.metadata.push(makeFact(`Version: ${pkg.version}`, sourcePath, 'high'));
    }

    const deps = pkg.dependencies;
    if (deps && typeof deps === 'object' && !Array.isArray(deps)) {
      for (const [name, version] of Object.entries(deps as Record<string, string>).sort(([a], [b]) => a.localeCompare(b))) {
        facts.dependencies.push(makeFact(`${name}: ${version}`, sourcePath, 'high'));
      }
    }

    const devDeps = pkg.devDependencies;
    if (devDeps && typeof devDeps === 'object' && !Array.isArray(devDeps)) {
      for (const [name, version] of Object.entries(devDeps as Record<string, string>).sort(([a], [b]) => a.localeCompare(b))) {
        facts.dependencies.push(makeFact(`${name}: ${version} (dev)`, sourcePath, 'high'));
      }
    }

    const scripts = pkg.scripts;
    if (scripts && typeof scripts === 'object' && !Array.isArray(scripts)) {
      for (const [name, command] of Object.entries(scripts as Record<string, string>).sort(([a], [b]) => a.localeCompare(b))) {
        facts.scripts.push(makeFact(`${name}: ${command}`, sourcePath, 'high'));
      }
    }

  } catch {
    facts.metadata.push(makeFact('Parse error: Invalid JSON format', sourcePath, 'low'));
  }

  return facts;
}