import type { PackageFacts, ApiRouteFact, RabbitMqFact, DatabaseFact } from '../types.js';

export interface ArchitectureInput {
  packageFacts: PackageFacts[];
  apiRouteFacts: ApiRouteFact[];
  rabbitMqFacts: RabbitMqFact[];
  databaseFacts: DatabaseFact[];
}

/**
 * Generates architecture.md with Mermaid diagrams from all extracted facts.
 */
export function generateArchitectureMarkdown(input: ArchitectureInput): string {
  const lines: string[] = [];

  lines.push('# Architecture Overview');
  lines.push('');
  lines.push('Auto-generated architecture diagrams based on static analysis.');
  lines.push('');

  lines.push(generateServiceGraph(input));
  lines.push(generateRabbitMqGraph(input.rabbitMqFacts));
  lines.push(generateDatabaseGraph(input.databaseFacts));

  return lines.join('\n');
}

function getServiceNames(input: ArchitectureInput): string[] {
  const names = new Set<string>();
  for (const pkg of input.packageFacts) {
    const nameFact = pkg.metadata.find(m => m.value.startsWith('Package name:'));
    if (nameFact) names.add(nameFact.value.replace('Package name: ', ''));
  }
  if (names.size === 0) names.add('service');
  return [...names].sort();
}

function generateServiceGraph(input: ArchitectureInput): string {
  const lines: string[] = [];
  const services = getServiceNames(input);

  lines.push('## Service Overview');
  lines.push('');
  lines.push('```mermaid');
  lines.push('graph TD');

  for (const svc of services) {
    const id = sanitizeId(svc);
    lines.push(`  ${id}[${svc}]`);
  }

  // Show API routes as a connection to an API node
  if (input.apiRouteFacts.length > 0) {
    lines.push(`  API{{API Routes: ${input.apiRouteFacts.length}}}`);
    for (const svc of services) {
      lines.push(`  ${sanitizeId(svc)} --> API`);
    }
  }

  // Show RabbitMQ as a broker node
  if (input.rabbitMqFacts.length > 0) {
    lines.push(`  RabbitMQ[(RabbitMQ)]`);
    for (const svc of services) {
      lines.push(`  ${sanitizeId(svc)} --> RabbitMQ`);
    }
  }

  // Show DB as a node
  if (input.databaseFacts.length > 0) {
    lines.push(`  DB[(Database)]`);
    for (const svc of services) {
      lines.push(`  ${sanitizeId(svc)} --> DB`);
    }
  }

  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

function generateRabbitMqGraph(facts: RabbitMqFact[]): string {
  const lines: string[] = [];

  lines.push('## RabbitMQ Flow');
  lines.push('');

  if (facts.length === 0) {
    lines.push('No RabbitMQ usage detected.');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('```mermaid');
  lines.push('graph LR');

  const queues = new Set<string>();
  const exchanges = new Set<string>();
  const publishers: { source: string; target: string }[] = [];
  const consumers: { source: string; target: string }[] = [];

  for (const fact of facts) {
    const sourceId = sanitizeId(fact.sourcePath);
    if (fact.messageType === 'queue') {
      queues.add(fact.name);
      if (fact.operation === 'publish' || fact.operation === 'send') {
        publishers.push({ source: sourceId, target: sanitizeId(fact.name) });
      } else if (fact.operation === 'consume') {
        consumers.push({ source: sanitizeId(fact.name), target: sourceId });
      }
    } else if (fact.messageType === 'exchange') {
      exchanges.add(fact.name);
    } else if (fact.messageType === 'routing_key') {
      publishers.push({ source: sourceId, target: sanitizeId(fact.name) });
    }
  }

  // Declare queue nodes
  for (const q of [...queues].sort()) {
    lines.push(`  ${sanitizeId(q)}[/${q}/]`);
  }
  for (const ex of [...exchanges].sort()) {
    lines.push(`  ${sanitizeId(ex)}{{${ex}}}`);
  }

  // Deduplicate edges
  const edgeSet = new Set<string>();
  for (const p of publishers) {
    const edge = `  ${p.source} -->|publish| ${p.target}`;
    if (!edgeSet.has(edge)) { edgeSet.add(edge); lines.push(edge); }
  }
  for (const c of consumers) {
    const edge = `  ${c.source} -->|consume| ${c.target}`;
    if (!edgeSet.has(edge)) { edgeSet.add(edge); lines.push(edge); }
  }

  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

function generateDatabaseGraph(facts: DatabaseFact[]): string {
  const lines: string[] = [];

  lines.push('## Database Usage');
  lines.push('');

  if (facts.length === 0) {
    lines.push('No database usage detected.');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('```mermaid');
  lines.push('graph LR');

  const tables = new Set<string>();
  const edges = new Set<string>();

  for (const fact of facts) {
    tables.add(fact.name);
    const sourceId = sanitizeId(fact.sourcePath);
    const tableId = sanitizeId(`tbl_${fact.name}`);
    edges.add(`  ${sourceId}[${fact.sourcePath}] -->|${fact.operation}| ${tableId}[${fact.name}]`);
  }

  for (const edge of [...edges].sort()) {
    lines.push(edge);
  }

  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

function sanitizeId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}
