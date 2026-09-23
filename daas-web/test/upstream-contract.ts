// Run after installing the EXISTING branch dependencies: npm --prefix daas-web run check:upstream
// Uses the real framework with a local fake provider stream; no model gateway or credentials needed.
import assert from 'node:assert/strict';
import { Agent } from '../../packages/agent/src/agent.ts';
import { AssistantMessageEventStream } from '../../packages/ai/src/utils/event-stream.ts';
import { streamSimple } from '../../packages/ai/src/api/openai-completions.ts';

assert.equal(typeof streamSimple, 'function');
let requests = 0; let calls = 0;
const model = { id: 'contract', name: 'DaaS contract', api: 'openai-completions' as const, provider: 'deepseek', baseUrl: 'http://127.0.0.1:1', reasoning: false, input: ['text' as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 200 };
const agent = new Agent({
  initialState: { model, thinkingLevel: 'off', systemPrompt: 'DaaS Agent', tools: [{ name: 'sys_probe', label: 'probe', description: 'Local contract test', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }, async execute(_id, args) { assert.equal(args.id, 'registered'); calls++; return { content: [{ type: 'text', text: 'ok' }], details: {} }; } }] },
  toolExecution: 'sequential',
  streamFn: (_model, context) => {
    const stream = new AssistantMessageEventStream(); const first = requests++ === 0;
    if (!first) assert.ok(context.messages.some(message => message.role === 'toolResult'));
    const message = { role: 'assistant' as const, api: 'openai-completions' as const, provider: 'deepseek', model: 'contract', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: first ? 'toolUse' as const : 'stop' as const, content: first ? [{ type: 'toolCall' as const, id: 'call-1', name: 'sys_probe', arguments: { id: 'registered' } }] : [{ type: 'text' as const, text: 'DaaS ready' }] };
    queueMicrotask(() => { stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(); }); return stream;
  },
});
await agent.prompt('Run the local probe');
assert.equal(calls, 1); assert.equal(requests, 2);
assert.ok(agent.state.messages.some(m => m.role === 'assistant'));
console.log('DaaS upstream contract passed: real loop, schema validation, tool result, next turn.');
