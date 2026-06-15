import type { HttpClientFact, HttpClientMethod, HttpClientLib, ConfidenceLabel } from '../types.js';

interface PatternDef {
  regex: RegExp;
  method: HttpClientMethod;
  lib: HttpClientLib;
  confidence: ConfidenceLabel;
  urlGroup: number;
}

// Node/JS patterns
const NODE_PATTERNS: PatternDef[] = [
  // axios.get(url), axios.post(url, data)
  { regex: /\baxios\.(get|post|put|patch|delete)\(\s*([`'"](.*?)[`'"]|\w[\w.]*)/g, method: 'unknown', lib: 'axios', confidence: 'high', urlGroup: 2 },
  // axios({ method: 'post', url: '...' })
  { regex: /\baxios\(\s*\{[^}]*\burl:\s*['"`]([^'"`]+)['"`]/g, method: 'unknown', lib: 'axios', confidence: 'medium', urlGroup: 1 },
  // fetch(url)
  { regex: /\bfetch\(\s*['"`]([^'"`]+)['"`]/g, method: 'GET', lib: 'fetch', confidence: 'high', urlGroup: 1 },
  // got.get(url), got.post(url)
  { regex: /\bgot\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g, method: 'unknown', lib: 'got', confidence: 'high', urlGroup: 2 },
  // NestJS HttpService: this.httpService.get/post(url)
  { regex: /\bhttpService\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/g, method: 'unknown', lib: 'axios', confidence: 'high', urlGroup: 2 },
];

// PHP curl patterns — multi-line aware via two-pass approach per line
const PHP_CURL_INLINE = /\bcurl_init\(\s*['"]([^'"]+)['"]\s*\)/g;
const PHP_CURL_SETOPT_URL = /\bcurl_setopt\s*\(\s*\$\w+\s*,\s*CURLOPT_URL\s*,\s*['"]([^'"]+)['"]/g;

// PHP NodeAPI bridge pattern — NodeAPI::methodName() calls map to ims-tf2 endpoints
const PHP_NODE_API = /\bNodeAPI::(\w+)\s*\(/g;
const NODE_API_ENDPOINT_MAP: Record<string, { method: HttpClientMethod; path: string }> = {
  getJwtServer:      { method: 'POST', path: '/traders/api/v2/jwt-server/' },
  getToken:          { method: 'POST', path: '/traders/api/v1/login/' },
  validateIdToken:   { method: 'POST', path: '/traders/api/v1/login/social/' },
  loginWithMT4:      { method: 'POST', path: '/traders/api/v1/login-with-mt4/' },
};

function extractMethod(line: string): HttpClientMethod {
  const m = line.match(/\.(get|post|put|patch|delete)\(/i);
  if (!m) return 'unknown';
  return m[1]!.toUpperCase() as HttpClientMethod;
}

function normalizeUrl(raw: string): string {
  // Strip template literal expressions, keep static parts
  return raw.replace(/\$\{[^}]+\}/g, '*').trim();
}

/** Look back up to 5 lines to resolve a bare variable to its assigned value */
function resolveVariable(varName: string, lines: string[], currentIndex: number): string | null {
  // matches: const url = 'literal', const url = process.env.FOO, or ternary with env vars
  const simpleAssign = new RegExp(`(?:const|let|var)\\s+${varName}\\s*=\\s*(['"\`]([^'"\`]+)['"\`]|process\\.env\\.\\w+)`);
  const ternaryAssign = new RegExp(`(?:const|let|var)\\s+${varName}\\s*=.*?(process\\.env\\.\\w+)`);
  for (let j = currentIndex - 1; j >= Math.max(0, currentIndex - 5); j--) {
    const line = lines[j]!;
    const m = simpleAssign.exec(line) ?? ternaryAssign.exec(line);
    if (m) return m[1]!;
  }
  return null;
}

function isIgnoredFile(sourcePath: string): boolean {
  const lower = sourcePath.toLowerCase();
  return lower.endsWith('.json') || lower.endsWith('.md') || lower.includes('node_modules');
}

/**
 * Extracts outbound HTTP client calls from Node/JS/TS and PHP source files.
 * Captures cross-service calls like ims-tf (PHP) → ims-tf2 (Node) endpoints.
 */
export function extractHttpClients(content: string, sourcePath: string): HttpClientFact[] {
  if (isIgnoredFile(sourcePath)) return [];

  const facts: HttpClientFact[] = [];
  const lines = content.split('\n');
  const seen = new Set<string>();
  const isPhp = sourcePath.toLowerCase().endsWith('.php');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNumber = i + 1;

    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue;

    if (isPhp) {
      // curl_init($url) inline
      PHP_CURL_INLINE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = PHP_CURL_INLINE.exec(line)) !== null) {
        const urlHint = normalizeUrl(match[1]!);
        const key = `${urlHint}|curl|${lineNumber}`;
        if (seen.has(key)) continue;
        seen.add(key);
        facts.push({ method: 'unknown', urlHint, lib: 'curl', sourcePath, line: lineNumber, confidence: 'high' });
      }

      // curl_setopt($ch, CURLOPT_URL, $url)
      PHP_CURL_SETOPT_URL.lastIndex = 0;
      while ((match = PHP_CURL_SETOPT_URL.exec(line)) !== null) {
        const urlHint = normalizeUrl(match[1]!);
        const key = `${urlHint}|curl|${lineNumber}`;
        if (seen.has(key)) continue;
        seen.add(key);
        facts.push({ method: 'unknown', urlHint, lib: 'curl', sourcePath, line: lineNumber, confidence: 'high' });
      }

      // NodeAPI::method() — PHP→ims-tf2 bridge calls
      PHP_NODE_API.lastIndex = 0;
      while ((match = PHP_NODE_API.exec(line)) !== null) {
        const methodName = match[1]!;
        const mapped = NODE_API_ENDPOINT_MAP[methodName];
        const urlHint = mapped ? `APIURL${mapped.path}` : `APIURL/[${methodName}]`;
        const httpMethod = mapped?.method ?? 'POST';
        const key = `${urlHint}|curl|${lineNumber}`;
        if (seen.has(key)) continue;
        seen.add(key);
        facts.push({ method: httpMethod, urlHint, lib: 'curl', sourcePath, line: lineNumber, confidence: mapped ? 'high' : 'medium' });
      }
    } else {
      for (const pattern of NODE_PATTERNS) {
        pattern.regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.regex.exec(line)) !== null) {
          let raw = match[pattern.urlGroup] ?? '';
          let confidence = pattern.confidence;
          // If captured value is a bare variable (no quotes/slash/dot), look back up to 5 lines
          if (raw && !raw.startsWith("'") && !raw.startsWith('"') && !raw.startsWith('`') && !raw.includes('/') && !raw.includes('.')) {
            const resolved = resolveVariable(raw, lines, i);
            if (resolved) { raw = resolved; confidence = 'medium'; }
          }
          const urlHint = normalizeUrl(raw);
          if (!urlHint) continue;
          const method = pattern.method === 'unknown' ? extractMethod(line) : pattern.method;
          const key = `${urlHint}|${pattern.lib}|${lineNumber}`;
          if (seen.has(key)) continue;
          seen.add(key);
          facts.push({ method, urlHint, lib: pattern.lib, sourcePath, line: lineNumber, confidence });
        }
      }
    }
  }

  return facts;
}
