import type { ApiRouteFact, HttpMethod, ApiFramework } from '../types.js';

const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function buildRoutePattern(): RegExp {
  const methods = HTTP_METHODS.map(m => m.toLowerCase()).join('|');
  return new RegExp(
    `(\\w+)\\.(${methods})\\(\\s*['"\`]([^'"\`]+)['"\`]`,
    'g'
  );
}

const ROUTE_PATTERN = buildRoutePattern();

/** Fastify route-object: url: "/path" */
const URL_PATTERN = /\burl:\s*['"`]([^'"`]+)['"`]/g;

/** method: ['POST'] or method: 'GET' — terdeteksi dalam konteks route object */
const METHOD_PATTERN = /\bmethod:\s*(?:\[?\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`])/gi;

const ROUTE_RECEIVERS = new Set(['app', 'router', 'route', 'server', 'express', 'fastify']);

function inferFramework(receiver: string): ApiFramework {
  const lower = receiver.toLowerCase();
  if (lower === 'fastify' || lower.startsWith('fastify')) return 'fastify';
  if (['app', 'router', 'route', 'server', 'express'].includes(lower)) return 'express';
  return 'unknown';
}

function isIgnoredFile(sourcePath: string): boolean {
  const lower = sourcePath.toLowerCase();
  return lower.endsWith('.json') || lower.endsWith('.md');
}

/**
 * Extracts API route definitions from source file content.
 */
export function extractApiRoutes(content: string, sourcePath: string): ApiRouteFact[] {
  if (isIgnoredFile(sourcePath)) return [];

  const facts: ApiRouteFact[] = [];
  const lines = content.split('\n');

  // State untuk route-object detection (Fastify array-of-objects style)
  let pendingMethod: HttpMethod | null = null;
  let pendingMethodLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNumber = i + 1;

    // Pattern 1: receiver.method('/path', ...)
    ROUTE_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ROUTE_PATTERN.exec(line)) !== null) {
      const receiver = match[1]!;
      const routePath = match[3]!;

      if (!ROUTE_RECEIVERS.has(receiver.toLowerCase())) continue;
      if (routePath.includes('${')) continue;
      if (!routePath.startsWith('/')) continue;

      const method = match[2]!.toUpperCase() as HttpMethod;
      const framework = inferFramework(receiver);

      facts.push({ method, path: routePath, sourcePath, line: lineNumber, framework, confidence: 'high' });
    }

    // Pattern 2: Fastify route-object { method: ['POST'], url: "/path" }
    METHOD_PATTERN.lastIndex = 0;
    const methodMatch = METHOD_PATTERN.exec(line);
    if (methodMatch) {
      pendingMethod = methodMatch[1]!.toUpperCase() as HttpMethod;
      pendingMethodLine = lineNumber;
    }

    URL_PATTERN.lastIndex = 0;
    const urlMatch = URL_PATTERN.exec(line);
    if (urlMatch) {
      const urlPath = urlMatch[1]!;
      if (urlPath.startsWith('/') && !urlPath.includes('${')) {
        // Gunakan pending method jika ada dalam jarak dekat (same route object)
        const method = (pendingMethod && (lineNumber - pendingMethodLine) < 10) ? pendingMethod : 'GET';
        facts.push({ method, path: urlPath, sourcePath, line: lineNumber, framework: 'fastify', confidence: 'high' });
        pendingMethod = null;
      }
    }
  }

  return facts;
}
