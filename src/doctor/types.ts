export type ConfidenceLabel = 'high' | 'medium' | 'low';

export interface ExtractedFact {
  value: string;
  sourcePath?: string;
  confidence: ConfidenceLabel;
}

export interface PackageMetadata {
  name?: string;
  version?: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

export interface PackageFacts {
  metadata: ExtractedFact[];
  dependencies: ExtractedFact[];
  scripts: ExtractedFact[];
}

export interface EnvVarFact {
  name: string;
  sourcePath: string;
  line: number;
  confidence: ConfidenceLabel;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type ApiFramework = 'express' | 'fastify' | 'unknown';

export interface ApiRouteFact {
  method: HttpMethod;
  path: string;
  sourcePath: string;
  line: number;
  framework: ApiFramework;
  confidence: ConfidenceLabel;
}

export type RabbitMessageType = 'queue' | 'exchange' | 'routing_key' | 'rpc' | 'unknown';
export type RabbitOperation = 'publish' | 'consume' | 'assert' | 'send' | 'unknown';

export interface RabbitMqFact {
  name: string;
  messageType: RabbitMessageType;
  operation: RabbitOperation;
  sourcePath: string;
  line: number;
  confidence: ConfidenceLabel;
}

export type DatabaseKind = 'table' | 'entity' | 'repository';
export type DatabaseOperation = 'select' | 'insert' | 'update' | 'delete' | 'join' | 'entity' | 'repository' | 'unknown';

export interface DatabaseFact {
  name: string;
  kind: DatabaseKind;
  operation: DatabaseOperation;
  sourcePath: string;
  line: number;
  confidence: ConfidenceLabel;
}
