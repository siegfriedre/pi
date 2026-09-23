export type Mode = 'developer' | 'analyst';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Args = Record<string, unknown>;
export interface Schema {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean;
  items?: Schema; enum?: (string | number | boolean)[]; maxLength?: number;
  minimum?: number; maximum?: number; maxItems?: number;
}
export interface Principal {
  sub: string; tenant: string; name: string; exp: number;
  spaces: { id: string; name: string; modes: Mode[] }[];
  token?: string;
}
export interface Config {
  demo: boolean; host: string; port: number; origin: string; root: string; dataDir: string;
  gatewaySecret: string; modelKey: string; modelBase: string; modelId: string;
  modelHeaders: Record<string, string>; modelCompat: Record<string, unknown>;
  modelContext: number; modelMaxTokens: number; maxTurns: number; taskTimeoutMs: number;
  platformBase: string; operations: Record<string, string>; readApiIds: string[];
}
export interface Message { id: string; role: 'user' | 'assistant'; text: string; time: string }
export interface Trace { id: string; label: string; state: 'running' | 'done' | 'error'; time: string }
export interface Result { id: string; title: string; rows: Record<string, Json>[]; source: string; complete: boolean; demo: boolean; createdAt: string }
export interface Artifact { id: string; title: string; kind: 'report' | 'draft'; html: string; createdAt: string }
export interface Approval {
  id: string; key: string; toolId: string; title?: string; version: string; args: Args;
  expiresAt: number; state: 'pending' | 'executing' | 'done' | 'denied' | 'unknown' | 'expired';
  output?: unknown;
}
export interface Session {
  id: string; owner: string; tenant: string; space: string; mode: Mode; title: string;
  revision: number; createdAt: string; updatedAt: string;
  messages: Message[]; traces: Trace[]; results: Result[]; artifacts: Artifact[]; approvals: Approval[];
  task: { status: 'idle' | 'running' | 'done' | 'error' | 'cancelled'; id?: string };
}
export interface ToolContext {
  principal: Principal; session: Session; signal: AbortSignal; idempotencyKey?: string;
  platform: (operation: string, args: Args, signal: AbortSignal, key?: string) => Promise<unknown>;
  result: (id: string) => Result;
  addResult: (value: Omit<Result, 'id' | 'createdAt'>) => Result;
  addArtifact: (value: Omit<Artifact, 'id' | 'createdAt'>) => Artifact;
  demo: boolean;
}
export interface Capability {
  id: string; version: string; title: string; description: string; domain: string;
  modes: Mode[]; effect: 'read' | 'artifact' | 'write'; schema: Schema;
  execute: (args: Args, ctx: ToolContext) => Promise<unknown>;
}
export interface Resource {
  id: string; title: string; description: string; domain: string; modes: Mode[];
  kind: 'skill' | 'document'; file: string; dependencies?: string[];
}
export interface RegistryAPI {
  tool: (capability: Capability) => void;
  resource: (resource: Resource) => void;
}
export type SystemCall = (name: string, args: Args) => Promise<unknown>;
export interface SystemDefinition { name: string; description: string; parameters: Schema }
export interface RuntimeInput {
  session: Session; prompt: string; signal: AbortSignal;
  definitions: SystemDefinition[]; call: SystemCall;
  reply: (text: string) => Promise<void>;
}
