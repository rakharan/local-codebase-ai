import type { RabbitMqFact, RabbitMessageType, RabbitOperation, ConfidenceLabel } from '../types.js';

interface PatternDef {
  regex: RegExp;
  messageType: RabbitMessageType;
  operation: RabbitOperation;
  confidence: ConfidenceLabel;
  nameGroup: number;
}

const PATTERNS: PatternDef[] = [
  { regex: /\.assertQueue\(\s*['"`]([^'"`]+)['"`]/g, messageType: 'queue', operation: 'assert', confidence: 'high', nameGroup: 1 },
  { regex: /\.assertExchange\(\s*['"`]([^'"`]+)['"`]/g, messageType: 'exchange', operation: 'assert', confidence: 'high', nameGroup: 1 },
  { regex: /\.publish\(\s*['"`]([^'"`]*)['"`]\s*,\s*['"`]([^'"`]+)['"`]/g, messageType: 'routing_key', operation: 'publish', confidence: 'high', nameGroup: 2 },
  { regex: /\.sendToQueue\(\s*['"`]([^'"`]+)['"`]/g, messageType: 'queue', operation: 'send', confidence: 'high', nameGroup: 1 },
  { regex: /\.consume\(\s*['"`]([^'"`]+)['"`]/g, messageType: 'queue', operation: 'consume', confidence: 'high', nameGroup: 1 },
  { regex: /\.subscribe\(\s*['"`]([^'"`]+)['"`]/g, messageType: 'queue', operation: 'consume', confidence: 'medium', nameGroup: 1 },
  { regex: /rpc\w*\.send\(\s*['"`]([^'"`]+)['"`]/g, messageType: 'rpc', operation: 'send', confidence: 'medium', nameGroup: 1 },
  // queue: "queue-name" dalam config object (getInstance, createChannel, dll)
  { regex: /\bqueue:\s*['"`]([^'"`]+)['"`]/g, messageType: 'queue', operation: 'assert', confidence: 'medium', nameGroup: 1 },
];

/**
 * Extracts RabbitMQ usage facts from source file content.
 */
export function extractRabbitMq(content: string, sourcePath: string): RabbitMqFact[] {
  const facts: RabbitMqFact[] = [];
  const lines = content.split('\n');
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNumber = i + 1;

    for (const pattern of PATTERNS) {
      pattern.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.regex.exec(line)) !== null) {
        const name = match[pattern.nameGroup]!;
        // Dedupe: same name+operation+line should not produce multiple facts
        const key = `${name}|${pattern.operation}|${lineNumber}`;
        if (seen.has(key)) continue;
        seen.add(key);

        facts.push({
          name,
          messageType: pattern.messageType,
          operation: pattern.operation,
          sourcePath,
          line: lineNumber,
          confidence: pattern.confidence,
        });
      }
    }
  }

  return facts;
}
