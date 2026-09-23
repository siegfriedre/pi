import { APP_ROOT } from '../server/config.ts';
import type { Config, Principal } from '../server/types.ts';
export function demoConfig(dataDir: string): Config {
  return { demo: true, host: '127.0.0.1', port: 0, origin: 'http://localhost:3210', root: APP_ROOT, dataDir,
    gatewaySecret: 'x'.repeat(40), modelKey: 'test-secret', modelBase: 'http://localhost:12345/v1', modelId: 'test-model', modelHeaders: {}, modelCompat: {}, modelContext: 65536, modelMaxTokens: 4096, maxTurns: 18, taskTimeoutMs: 5000, platformBase: '', operations: {}, readApiIds: [] };
}
export function principal(): Principal { return { sub: 'user-a', tenant: 'company-a', name: '测试用户', exp: Date.now() / 1000 + 300, spaces: [{ id: 'space-a', name: '测试空间', modes: ['developer', 'analyst'] }] }; }
