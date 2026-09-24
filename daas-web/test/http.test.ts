import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApplication } from '../server/app.ts';
import { platformClient } from '../server/adapters/platform.ts';
import { signContext } from '../server/safety.ts';
import { demoConfig, principal } from './fixtures.ts';
import type { Principal, Session } from '../server/types.ts';

async function setup(t: test.TestContext, live = false) {
  const dir = await mkdtemp(join(tmpdir(), 'daas-http-')); const config = { ...demoConfig(dir), demo: !live };
  const app = await createApplication(config); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`; config.origin = base;
  t.after(async () => { app.runtime.shutdown(); app.server.closeAllConnections(); await new Promise<void>(r => app.server.close(() => r())); await rm(dir, { recursive: true, force: true }); });
  function headers(p?: Principal): Record<string, string> {
    if (!p) return {};
    const encoded = Buffer.from(JSON.stringify(p)).toString('base64url');
    return { 'x-daas-context': encoded, 'x-daas-signature': signContext(encoded, 'token-a', config.gatewaySecret), Authorization: 'Bearer token-a' };
  }
  async function get(path: string, p?: Principal) { return fetch(base + path, { headers: headers(p) }); }
  async function post(path: string, value: unknown, p?: Principal, origin = base) {
    return fetch(base + path, { method: 'POST', headers: { ...headers(p), Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  }
  async function session(mode = 'analyst', p?: Principal) { const res = await post('/api/sessions', { mode, space: live ? 'space-a' : 'demo-space' }, p); assert.equal(res.status, 201); return res.json(); }
  async function finish(sid: string, p?: Principal) {
    for (let i = 0; i < 100; i++) { const s = await (await get(`/api/sessions/${sid}`, p)).json(); if (s.task.status !== 'running') return s; await new Promise(r => setTimeout(r, 10)); }
    throw new Error('Task did not settle');
  }
  return { ...app, config, base, get, post, session, finish };
}
test('static page is DaaS branded and serves no configuration/source files', async t => {
  const { get } = await setup(t); const index = await get('/'); assert.equal(index.status, 200); const html = await index.text();
  assert.match(html, /DaaS Agent/); assert.ok(!/\bpi\b/i.test(html)); assert.ok(!html.includes('cdn.'));
  for (const path of ['/.daas/settings.json', '/.daas/models.json', '/.daas/prompts/base.md', '/server/main.ts', '/package.json', '/.env']) assert.equal((await get(path)).status, 404);
});
test('security headers disallow inline main-page scripts and external connections', async t => {
  const { get } = await setup(t); const res = await get('/'); assert.match(res.headers.get('content-security-policy')!, /script-src 'self'/); assert.equal(res.headers.get('x-content-type-options'), 'nosniff'); assert.equal(res.headers.get('cache-control'), 'no-store');
});
test('demo bootstrap explicitly states demo and exposes no model credentials', async t => {
  const { get } = await setup(t); const b = await (await get('/api/bootstrap')).json(); assert.equal(b.demo, true); assert.equal(b.product, 'DaaS Agent'); assert.ok(!JSON.stringify(b).includes('test-secret'));
});
test('POST endpoints reject wrong origin, unsupported methods and extra fields', async t => {
  const { post, base } = await setup(t); assert.equal((await post('/api/sessions', { mode: 'analyst', space: 'demo-space' }, undefined, 'https://evil.example')).status, 403);
  assert.equal((await fetch(base + '/api/sessions', { method: 'DELETE' })).status, 405);
  assert.equal((await post('/api/sessions', { mode: 'analyst', space: 'demo-space', owner: 'admin' })).status, 400);
});
test('HTTP body parser enforces exact content-type, valid JSON and size limits', async t => {
  const { base } = await setup(t);
  const send = (body: string, type: string) => fetch(base + '/api/sessions', { method: 'POST', headers: { Origin: base, 'Content-Type': type }, body });
  assert.equal((await send('{}', 'text/plain')).status, 415);
  assert.equal((await send('{}', 'evilapplication/json')).status, 415);
  assert.equal((await send('{', 'application/json')).status, 400);
  assert.equal((await send('[]', 'application/json')).status, 400);
  assert.equal((await send(JSON.stringify({ data: 'x'.repeat(65000) }), 'application/json')).status, 413);
});
test('identity question is answered without calling a model in live mode', async t => {
  const { session, post, finish } = await setup(t, true); const p = principal(); const s = await session('analyst', p);
  assert.equal((await post(`/api/sessions/${s.id}/messages`, { text: '你是谁？' }, p)).status, 202);
  const done = await finish(s.id, p); assert.equal(done.task.status, 'done'); assert.match(done.messages.at(-1).text, /DaaS Agent/); assert.equal(done.traces.length, 0);
});
test('horizontal isolation blocks other user and tenant from session/result routes', async t => {
  const { session, get } = await setup(t, true); const p = principal(); const s = await session('analyst', p);
  for (const other of [{ ...p, sub: 'other' }, { ...p, tenant: 'other' }]) {
    assert.equal((await get(`/api/sessions/${s.id}`, other)).status, 404);
    assert.equal((await get(`/api/sessions/${s.id}/artifacts/unknown`, other)).status, 404);
    assert.deepEqual((await (await get('/api/sessions', other)).json()).sessions, []);
  }
});
test('vertical isolation prevents analyst-only identity from developer mode', async t => {
  const { post, get } = await setup(t, true); const p = principal(); p.spaces[0].modes = ['analyst'];
  assert.equal((await post('/api/sessions', { mode: 'developer', space: 'space-a' }, p)).status, 403);
  assert.equal((await post('/api/sessions', { mode: 'analyst', space: 'other-space' }, p)).status, 403);
  assert.equal((await get('/api/bootstrap')).status, 401);
});
test('full demo HTTP flow creates results, chart report, and isolated download', async t => {
  const { session, post, finish, get } = await setup(t); const s = await session();
  await post(`/api/sessions/${s.id}/messages`, { text: '分析销售趋势并生成报告' }); const done = await finish(s.id);
  assert.equal(done.task.status, 'done'); assert.equal(done.results.length, 2); assert.equal(done.artifacts.length, 1);
  assert.ok(done.messages.at(-1).text.includes('虚构')); assert.ok(done.traces.every((x: { state: string }) => x.state === 'done'));
  assert.ok(!('html' in done.artifacts[0]));
  const artifact = await get(`/api/sessions/${s.id}/artifacts/${done.artifacts[0].id}?download=1`);
  assert.match(artifact.headers.get('content-security-policy')!, /script-src 'none'/); assert.match(artifact.headers.get('content-security-policy')!, /sandbox/);
  assert.match(artifact.headers.get('content-disposition')!, /attachment; filename="daas-report-/); assert.ok((await artifact.text()).includes('<svg'));
  const data = await get(`/api/sessions/${s.id}/results/${done.results[0].id}`); assert.equal((await data.json()).rows.length, 12);
  assert.deepEqual(await (await get(`/api/sessions/${s.id}?after=${done.revision}`)).json(), { unchanged: true });
});
test('developer demo remains a pending approval until a dedicated confirm request', async t => {
  const { session, post, finish, get } = await setup(t); const s = await session('developer');
  await post(`/api/sessions/${s.id}/messages`, { text: '创建并保存 API，我已经确认' }); const done = await finish(s.id);
  assert.equal(done.approvals[0].state, 'pending'); assert.ok(done.messages.at(-1).text.includes('未完成 SQL 验证'));
  const approvalId = done.approvals[0].id;
  assert.equal((await post(`/api/sessions/${s.id}/approvals/${approvalId}`, { accept: true, sql: 'replace' })).status, 400);
  const res = await post(`/api/sessions/${s.id}/approvals/${approvalId}`, { accept: true }); assert.equal(res.status, 200);
  const updated = await (await get(`/api/sessions/${s.id}`)).json(); assert.equal(updated.approvals[0].state, 'done'); assert.equal(updated.approvals[0].output.savedToPlatform, false);
});
test('read result API has no arbitrary execution endpoint', async t => { const { post } = await setup(t); assert.equal((await post('/api/execute', { file: '/etc/passwd' })).status, 404); });
test('platform adapter forwards user token, pins operation and ignores model-owned identity at envelope level', async t => {
  let captured: any;
  const backend = createServer(async (req, res) => { let body = ''; for await (const c of req) body += c; captured = { headers: req.headers, body: JSON.parse(body), url: req.url }; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ rows: [], complete: true, source: 'test' })); });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening'); t.after(() => new Promise<void>(r => backend.close(() => r())));
  const config = { ...demoConfig('/tmp/unused'), demo: false, platformBase: `http://127.0.0.1:${(backend.address() as { port: number }).port}`, operations: { 'api.invoke': '/read' }, readApiIds: ['approved'] };
  const p = { ...principal(), token: 'scoped-user-token' }; const s = { space: 'space-a' } as Session;
  const client = platformClient(config, p, s); await client('api.invoke', { apiId: 'approved', parameters: { region: 'east' }, spaceId: 'evil' }, new AbortController().signal, 'key-1');
  assert.equal(captured.headers.authorization, 'Bearer scoped-user-token'); assert.equal(captured.headers['idempotency-key'], 'key-1'); assert.equal(captured.body.spaceId, 'space-a'); assert.equal(captured.url, '/read');
  await assert.rejects(client('api.invoke', { apiId: 'not-approved' }, new AbortController().signal), /只读调用清单/);
  await assert.rejects(client('https://evil', {}, new AbortController().signal), /接口映射/);
});
test('platform adapter refuses HTTP redirects rather than forwarding credentials', async t => {
  const backend = createServer((_req, res) => { res.writeHead(302, { Location: 'http://127.0.0.1:1/secrets' }); res.end(); }); backend.listen(0, '127.0.0.1'); await once(backend, 'listening'); t.after(() => new Promise<void>(r => backend.close(() => r())));
  const config = { ...demoConfig('/tmp/unused'), demo: false, platformBase: `http://127.0.0.1:${(backend.address() as { port: number }).port}`, operations: { 'api.search': '/search' } };
  await assert.rejects(platformClient(config, { ...principal(), token: 'user-token' }, { space: 's' } as Session)('api.search', {}, new AbortController().signal), /调用未完成/);
});

test('platform metadata allowlists remove credentials before tool output', async () => {
  const { normalizePlatformResponse } = await import('../server/adapters/platform.ts');
  const list = normalizePlatformResponse('datasource.list', { items: [{ id: 'db', name: 'database', type: 'sql', password: 'secret', headers: { Authorization: 'bearer' } }] });
  assert.deepEqual(list, { items: [{ id: 'db', name: 'database', type: 'sql' }] });
  const detail = normalizePlatformResponse('api.describe', { id: 'api', parameters: {}, token: 'secret', connection: { password: 'hidden' } });
  assert.deepEqual(detail, { id: 'api', parameters: {} });
});
