// The ONLY source-level bridge to the upstream SDK. Keep the framework itself untouched.
// Never import the coding-agent CLI/TUI, default tools, resource loader or global provider registry.
export { Agent } from '../../../packages/agent/src/agent.ts';
export { streamSimple } from '../../../packages/ai/src/api/openai-completions.ts';
