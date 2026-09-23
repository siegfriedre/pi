import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import register from '../.daas/index.ts';
import { AppError, authenticate, brand, identityReply, readApproved, signContext, validate, validateJson } from '../server/safety.ts';
import { APP_ROOT, loadConfig } from '../server/config.ts';
import { Registry, SYSTEM_TOOLS, ToolRun } from '../server/registry.ts';
import { Store } from '../server/store.ts';
import { runModel, type Framework } from '../server/adapters/model.ts';
import type { Args, Config, Mode, Principal } from '../server/types.ts';

import { demoConfig, principal } from './fixtures.ts';
async function setup(t: test.TestContext, mode: Mode = 'analyst') {
  const dir = await mkdtemp(join(tmpdir(), 'daas-core-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const config = demoConfig(dir); const p = principal(); const store = new Store(join(dir, 'sessions')); await store.init();
  const session = await store.create(p, 'space-a', mode); const registry = new Registry(); register(registry); registry.seal();
  const run = new ToolRun(registry, config, session, p, store, new AbortController().signal);
  return { config, p, store, session, registry, run, dir };
}
const invoke = (run: ToolRun, toolId: string, args: Args) => run.call('sys_invoke', { toolId, arguments: args });
const strictSchema = { type: 'object' as const, properties: { count: { type: 'integer' as const, minimum: 1, maximum: 5 }, name: { type: 'string' as const, maxLength: 6 } }, required: ['count'], additionalProperties: false };
for (const [label, value] of [['unknown field', { count: 1, command: 'bash' }], ['numeric string', { count: '1' }], ['range', { count: 6 }], ['required', {}], ['long string', { count: 1, name: '1234567' }], ['null', null], ['array', []], ['prototype key', JSON.parse('{"count":1,"__proto__":{}}')]] as const) {
  test(`inner schema rejects ${label}`, () => assert.throws(() => validate(strictSchema, value), AppError));
}
test('schema permits exact structured parameters', () => validate(strictSchema, { count: 2, name: 'DaaS' }));
test('JSON validator rejects prototype keys and excessive nesting', () => {
  assert.throws(() => validateJson(JSON.parse('{"constructor":{}}')), AppError);
  let value: unknown = 'x'; for (let i = 0; i < 14; i++) value = [value]; assert.throws(() => validateJson(value), AppError);
});
test('identity has fixed DaaS name', () => { assert.match(identityReply('你是谁？')!, /DaaS Agent/); assert.match(identityReply('Who are you?')!, /DaaS/); assert.equal(identityReply('帮我查询'), undefined); });
test('product prose removes upstream branding and config directory', () => assert.equal(brand('I am pi coding agent; .pi/skills; @earendil-works/pi-agent-core'), 'I am DaaS; .daas/skills; DaaS Agent'));
test('approved resource read supports only fixed in-root regular files', async t => {
  const { dir } = await setup(t); const root = join(dir, 'resources'); await mkdir(root); await writeFile(join(root, 'ok.md'), 'DaaS');
  assert.equal(await readApproved(root, 'ok.md'), 'DaaS');
  for (const p of ['../outside', '/etc/passwd', '..\\outside']) await assert.rejects(readApproved(root, p), AppError);
  await symlink(join(root, 'ok.md'), join(root, 'link.md')); await assert.rejects(readApproved(root, 'link.md'), AppError);
  await mkdir(join(root, 'real')); await writeFile(join(root, 'real/data.md'), 'x'); await symlink(join(root, 'real'), join(root, 'linked')); await assert.rejects(readApproved(root, 'linked/data.md'), AppError);
  await assert.rejects(readApproved(root, 'ok.md', 2), AppError);
});
test('live auth rejects missing, expired, forged and token-swapped context', () => {
  const config = { ...demoConfig('/tmp/unused'), demo: false }; const p = principal(); const encoded = Buffer.from(JSON.stringify(p)).toString('base64url');
  const headers = { 'x-daas-context': encoded, 'x-daas-signature': signContext(encoded, 'token-a', config.gatewaySecret), authorization: 'Bearer token-a' };
  const req = (h: object) => ({ headers: h }) as IncomingMessage;
  assert.equal(authenticate(req(headers), config).sub, p.sub);
  assert.throws(() => authenticate(req({}), config), AppError);
  assert.throws(() => authenticate(req({ ...headers, authorization: 'Bearer token-b' }), config), AppError);
  const expired = Buffer.from(JSON.stringify({ ...p, exp: 1 })).toString('base64url');
  assert.throws(() => authenticate(req({ ...headers, 'x-daas-context': expired, 'x-daas-signature': signContext(expired, 'token-a', config.gatewaySecret) }), config), AppError);
});
test('live startup fails closed rather than enabling demo', async () => { await assert.rejects(loadConfig({}, []), AppError); });
test('demo non-loopback bind requires explicit opt-in', async () => { await assert.rejects(loadConfig({ DAAS_DEMO: '1', DAAS_HOST: '0.0.0.0' }, []), AppError); });
test('registration rejects system override, duplicates, unsupported schemas and unresolved dependencies', () => {
  const r = new Registry(); const tool = { id: 'daas.test', title: 'test', version: '1', domain: 'test', description: '', effect: 'read' as const, modes: ['analyst' as const], schema: strictSchema, async execute() { return {}; } };
  r.tool(tool); assert.throws(() => r.tool(tool)); assert.throws(() => r.tool({ ...tool, id: 'sys_invoke' }));
  assert.throws(() => r.tool({ ...tool, id: 'daas.other', schema: { ...strictSchema, '$ref': 'external' } as never }));
  r.resource({ id: 'skill.test', title: 's', description: '', kind: 'skill', file: 'x.md', domain: 'test', modes: ['analyst'], dependencies: ['not.registered'] }); assert.throws(() => r.seal());
});
test('discovery is filtered, bounded and summary-only', async t => {
  const { run } = await setup(t); const found = await run.call('sys_discover', { query: '销售' }) as Args[];
  assert.ok(found.length > 0 && found.length <= 8); assert.ok(found.every(x => !('schema' in x) && !('execute' in x) && !('file' in x)));
  const developer = await run.call('sys_discover', { query: '保存草稿' }) as Args[]; assert.ok(!developer.some(t => t.id === 'daas.api.save_draft'));
});
test('invocation before explicit load is denied', async t => { const { run } = await setup(t); await assert.rejects(invoke(run, 'daas.api.search', { query: 'sales' }), /先.*加载/); });
test('loading a skill loads its approved dependencies, not arbitrary files', async t => {
  const { run } = await setup(t); await run.call('sys_load', { ids: ['skill.sales-analysis'] });
  assert.ok(await invoke(run, 'daas.api.search', { query: 'sales' }));
  await assert.rejects(run.call('sys_read_resource', { id: '/etc/passwd' }), AppError);
  await assert.rejects(invoke(run, '../scripts/test.ts', {}), AppError);
});
test('analyst cannot load or execute developer write tools', async t => { const { run } = await setup(t); await assert.rejects(run.call('sys_load', { ids: ['daas.api.save_draft'] }), AppError); });
test('target tool arguments receive a second strict validation', async t => {
  const { run } = await setup(t); await run.call('sys_load', { ids: ['daas.api.search'] });
  await assert.rejects(invoke(run, 'daas.api.search', { query: 'x', code: 'process.exit()' }), AppError);
});
test('resource reading is paginated and exposes no physical location', async t => { const { run } = await setup(t); const r = await run.call('sys_read_resource', { id: 'doc.sales.metrics', limit: 10 }) as Args; assert.equal(String(r.content).length, 10); assert.equal(r.nextOffset, 10); assert.equal(r.file, undefined); });
test('end-to-end query, aggregate and escaped HTML report', async t => {
  const { run, session } = await setup(t); await run.call('sys_load', { ids: ['skill.sales-analysis'] });
  const q = await invoke(run, 'daas.api.query', { apiId: 'demo.sales.monthly', parameters: {} }) as Args; assert.equal(q.rowCount, 12);
  const aggregate = await invoke(run, 'daas.result.aggregate', { resultId: q.resultId, groupBy: 'month', valueField: 'sales', operation: 'sum' }) as Args; assert.equal(aggregate.rowCount, 6);
  await invoke(run, 'daas.report.create', { resultId: aggregate.resultId, title: '<script>alert(1)</script>', chart: 'bar', xField: 'group', yField: 'value' });
  assert.equal(session.artifacts.length, 1); assert.ok(!session.artifacts[0].html.includes('<script>')); assert.ok(session.artifacts[0].html.includes('&lt;script&gt;')); assert.ok(session.artifacts[0].html.includes('<svg'));
});
test('results cannot cross sessions', async t => { const { run } = await setup(t); await run.call('sys_load', { ids: ['daas.result.aggregate'] }); await assert.rejects(invoke(run, 'daas.result.aggregate', { resultId: 'someone-else', groupBy: 'month', valueField: 'sales', operation: 'sum' }), AppError); });
test('session ownership is checked by store and execution layer', async t => {
  const { store, session, p, registry, config } = await setup(t); const other = { ...p, sub: 'someone-else' };
  await assert.rejects(store.get(session.id, other), AppError); await assert.rejects(store.get('../etc/passwd', p), AppError);
  const run = new ToolRun(registry, config, session, other, store, new AbortController().signal); await assert.rejects(run.call('sys_discover', { query: '' }), AppError);
});
test('approval requires an explicit UI action, is idempotent, and preserves exact parameters', async t => {
  const { run, session } = await setup(t, 'developer'); await run.call('sys_load', { ids: ['daas.api.save_draft'] });
  const args = { name: 'monthly', datasourceId: 'demo-orders', sql: 'SELECT 1' };
  const pending = await invoke(run, 'daas.api.save_draft', args) as Args; assert.equal(pending.status, 'requires_confirmation'); assert.equal(session.approvals[0].state, 'pending');
  const again = await invoke(run, 'daas.api.save_draft', args) as Args; assert.equal(again.approvalId, pending.approvalId); assert.equal(session.approvals.length, 1);
  const result = await run.approve(String(pending.approvalId), true); assert.equal(session.approvals[0].state, 'done'); assert.deepEqual(await run.approve(String(pending.approvalId), true), result);
});
test('approval changes and expiry fail closed', async t => {
  const { run, session } = await setup(t, 'developer'); await run.call('sys_load', { ids: ['daas.api.save_draft'] });
  const pending = await invoke(run, 'daas.api.save_draft', { name: 'draft', datasourceId: 'demo', sql: 'SELECT 1' }) as Args;
  session.approvals[0].args.sql = 'SELECT 2'; await assert.rejects(run.approve(String(pending.approvalId), true), /确认内容已变化/);
  session.approvals[0].expiresAt = 1; await assert.rejects(run.approve(String(pending.approvalId), true), /过期/);
});
test('restart marks interrupted writes unknown instead of retrying them', async t => {
  const { run, session, store, p } = await setup(t, 'developer'); await run.call('sys_load', { ids: ['daas.api.save_draft'] });
  await invoke(run, 'daas.api.save_draft', { name: 'draft', datasourceId: 'demo', sql: 'SELECT 1' }); session.approvals[0].state = 'executing'; session.task.status = 'running'; await store.save(session);
  const restored = await new Store(store.root).get(session.id, p); assert.equal(restored.approvals[0].state, 'unknown'); assert.equal(restored.task.status, 'error');
  assert.ok(!JSON.stringify(restored).includes('test-secret'));
});
test('model adapter only supplies four tools, serial execution, no raw reasoning, and branded output', async t => {
  const { config, session } = await setup(t); let options: any; let listener: any; const replies: string[] = [];
  const fake: Framework = { Agent: class { constructor(o: any) { options = o; } subscribe(fn: any) { listener = fn; return () => {}; } abort() {} async prompt() { await listener({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'I am pi coding agent' }] } }); } }, streamSimple() {} };
  await runModel(config, { session, prompt: 'hello', signal: new AbortController().signal, definitions: SYSTEM_TOOLS, call: async () => ({}), reply: async text => { replies.push(text); } }, fake);
  assert.equal(options.toolExecution, 'sequential'); assert.deepEqual(options.initialState.tools.map((t: any) => t.name), SYSTEM_TOOLS.map(t => t.name)); assert.ok(!replies.join('').includes('private')); assert.ok(!replies.join('').includes('pi')); assert.ok(options.initialState.systemPrompt.includes('DaaS Agent'));
});
