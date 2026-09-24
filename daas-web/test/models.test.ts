import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { APP_ROOT, loadConfig } from '../server/config.ts';
import { parseModelProfiles, resolveConfigValue, loadModelProfiles } from '../server/models.ts';
import type { ModelDefinition } from '../server/models.ts';
import { loadSystemPrompts } from '../server/prompts.ts';
import { AppError, brand, publicError } from '../server/safety.ts';
import { runModel, type Framework } from '../server/adapters/model.ts';
import { SYSTEM_TOOLS } from '../server/registry.ts';
import { demoConfig } from './fixtures.ts';
import type { Session } from '../server/types.ts';

function document() {
  return { providers: { company: {
    api: 'openai-completions', baseUrl: 'https://model.invalid/v1', apiKey: '${TEST_KEY}',
    headers: { 'X-Company-Key': '$HEADER_KEY' },
    compat: { supportsDeveloperRole: false, supportsStore: false, thinkingFormat: 'deepseek' },
    models: [{ id: 'flash', name: '公司模型', reasoning: true, contextWindow: 65536, maxTokens: 4096,
      thinkingLevelMap: { off: null, high: 'high', max: 'max' }, input: ['text', 'image'],
      compat: { supportsReasoningEffort: true }, samplingParams: { temperature: 0.6 } }],
  } } };
}
const env = { TEST_KEY: 'unit-secret', HEADER_KEY: 'header-secret' };
async function setup(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'daas-models-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.daas'));
  await cp(join(APP_ROOT, '.daas/prompts'), join(root, '.daas/prompts'), { recursive: true });
  return root;
}
const vars = { ...env, DAAS_PUBLIC_ORIGIN: 'http://localhost:3210', DAAS_GATEWAY_SECRET: 'x'.repeat(40) };
const settings = { defaultProvider: 'company', defaultModel: 'flash', defaultThinkingLevel: 'high' };

test('provider/models format preserves model metadata, headers, compatibility and thinking', () => {
  const profiles = parseModelProfiles(document(), settings, env); const p = profiles.developer;
  assert.equal(p.model.id, 'flash'); assert.equal(p.model.provider, 'company'); assert.equal(p.apiKey, 'unit-secret');
  assert.equal(p.model.reasoning, true); assert.equal(p.thinkingLevel, 'high'); assert.equal(p.model.thinkingLevelMap?.off, null);
  assert.deepEqual(p.model.input, ['text', 'image']); assert.equal(p.model.maxTokens, 4096);
  assert.equal(p.headers['x-company-key'], 'header-secret'); assert.equal(p.headers['User-Agent'], 'DaaS-Agent/0.1');
  assert.deepEqual(p.model.compat, { supportsDeveloperRole: false, supportsStore: false, thinkingFormat: 'deepseek', supportsReasoningEffort: true });
  assert.ok(!JSON.stringify(p.model).includes('secret'));
});
test('minimal model defaults and single-model selection need no invented catalog', () => {
  const d = { providers: { local: { api: 'openai-completions', baseUrl: 'http://localhost:9999/v1', apiKey: 'literal', models: [{ id: 'only' }] } } };
  const p = parseModelProfiles(d, {}, {}).analyst;
  assert.equal(p.model.name, 'only'); assert.equal(p.model.contextWindow, 128000); assert.equal(p.model.maxTokens, 16384); assert.equal(p.thinkingLevel, 'off');
});
test('literal and explicit environment value semantics match modern models.json', () => {
  assert.equal(resolveConfigValue('$TEST_KEY', env, 'apiKey'), 'unit-secret');
  assert.equal(resolveConfigValue('Bearer ${TEST_KEY}', env, 'headers'), 'Bearer unit-secret');
  assert.equal(resolveConfigValue('TEST_KEY', env, 'apiKey'), 'TEST_KEY');
  assert.equal(resolveConfigValue('$$literal$!suffix', {}, 'apiKey'), '$literal!suffix');
  assert.equal(resolveConfigValue('${TEST_KEY}', { TEST_KEY: '$OTHER' }, 'apiKey'), '$OTHER');
});
for (const [label, value] of [['shell', '!cat /etc/passwd'], ['spaced shell', '  !echo key'], ['missing env', '$MISSING'], ['empty env', '${EMPTY}'], ['invalid interpolation', '${x:-fallback}'], ['unclosed variable', '${TEST_KEY'], ['line break', 'abc\r\ndef']] as const) {
  test(`secret resolver rejects ${label} without exposing its value`, () => {
    assert.throws(() => resolveConfigValue(value, { ...env, EMPTY: '' }, 'apiKey'), (e: unknown) => e instanceof AppError && !e.message.includes(value));
  });
}
test('multi-provider and per-mode selections use separate model settings', () => {
  const d = document();
  const other = { ...structuredClone(d.providers.company), models: [{ ...d.providers.company.models[0], id: 'second', reasoning: false, thinkingLevelMap: {} }] };
  const profiles = parseModelProfiles({ providers: { ...d.providers, other } }, { ...settings, modeModels: { analyst: { provider: 'other', model: 'second', thinkingLevel: 'off' } } }, env);
  assert.equal(profiles.developer.model.id, 'flash'); assert.equal(profiles.analyst.model.id, 'second'); assert.equal(profiles.analyst.thinkingLevel, 'off');
});
test('model headers override provider headers case-insensitively; transport user-agent is fixed', () => {
  const d = document(); Object.assign(d.providers.company.models[0], { headers: { 'x-COMPANY-key': 'model-override', 'User-Agent': 'other' } });
  const p = parseModelProfiles(d, settings, env).analyst;
  assert.equal(p.headers['x-company-key'], 'model-override'); assert.equal(p.headers['User-Agent'], 'DaaS-Agent/0.1');
  assert.equal(Object.keys(p.headers).filter(k => k.toLowerCase() === 'user-agent').length, 1);
});
test('explicit Authorization supports header-only authentication and false disables automatic Bearer', () => {
  const d = document(); delete (d.providers.company as Partial<typeof d.providers.company>).apiKey;
  Object.assign(d.providers.company, { authHeader: false, headers: { 'X-API-Key': '$TEST_KEY' } });
  const p = parseModelProfiles(d, settings, env).analyst;
  assert.equal(p.headers.Authorization, null); assert.equal(p.apiKey, 'daas-header-auth');
  Object.assign(d.providers.company, { authHeader: true, headers: { Authorization: 'Token ${TEST_KEY}' } });
  assert.equal(parseModelProfiles(d, settings, env).analyst.headers.Authorization, 'Token unit-secret');
});
const invalid: [string, (d: ReturnType<typeof document>) => void][] = [
  ['wrong protocol', d => { d.providers.company.api = 'anthropic-messages'; }],
  ['duplicate model id', d => { d.providers.company.models.push(structuredClone(d.providers.company.models[0])); }],
  ['string reasoning', d => { Object.assign(d.providers.company.models[0], { reasoning: 'true' }); }],
  ['max tokens exceed context', d => { d.providers.company.models[0].maxTokens = 999999; }],
  ['invalid context', d => { d.providers.company.models[0].contextWindow = -1; }],
  ['unknown provider option', d => { Object.assign(d.providers.company, { oauth: 'radius' }); }],
  ['invalid cost', d => { Object.assign(d.providers.company.models[0], { cost: { input: -1 } }); }],
  ['unsupported compat', d => { Object.assign(d.providers.company.compat, { typo: true }); }],
  ['bad compat boolean', d => { Object.assign(d.providers.company.compat, { supportsStore: 'false' }); }],
  ['array instead of enum', d => { Object.assign(d.providers.company.compat, { maxTokensField: ['max_tokens'] }); }],
  ['sampling message override', d => { Object.assign(d.providers.company.models[0].samplingParams, { messages: [] }); }],
  ['sampling stream override', d => { Object.assign(d.providers.company.models[0].samplingParams, { stream: false }); }],
  ['invalid level map', d => { Object.assign(d.providers.company.models[0].thinkingLevelMap, { banana: 'high' }); }],
  ['invalid header name', d => { Object.assign(d.providers.company.headers, { 'bad\rheader': 'x' }); }],
  ['URL credentials', d => { d.providers.company.baseUrl = 'https://secret:password@model.invalid'; }],
  ['missing secret', d => { d.providers.company.apiKey = '${MISSING}'; }],
  ['malicious prototype', d => { Object.assign(d.providers.company, JSON.parse('{"constructor":"x"}')); }],
];
for (const [label, mutate] of invalid) test(`catalog fails closed: ${label}`, () => { const d = document(); mutate(d); assert.throws(() => parseModelProfiles(d, settings, env), AppError); });
test('unsupported selected thinking level is rejected instead of silently turning it off', () => {
  assert.throws(() => parseModelProfiles(document(), { ...settings, defaultThinkingLevel: 'off' }, env), /思考级别/);
  assert.throws(() => parseModelProfiles(document(), { ...settings, defaultThinkingLevel: 'xhigh' }, env), /思考级别/);
  assert.equal(parseModelProfiles(document(), { ...settings, defaultThinkingLevel: 'max' }, env).analyst.thinkingLevel, 'max');
});
test('ambiguous or absent defaults are rejected', () => {
  const d = document(); d.providers.company.models.push({ ...d.providers.company.models[0], id: 'other' });
  assert.throws(() => parseModelProfiles(d, {}, env), /唯一选择/);
  assert.throws(() => parseModelProfiles(d, { defaultModel: 'flash' }, env), /一起设置/);
  assert.throws(() => parseModelProfiles(d, { ...settings, defaultModel: 'missing' }, env), /唯一选择/);
  assert.throws(() => parseModelProfiles(d, { ...settings, modeModels: { analyst: { model: 'other' } } }, env), /一起设置/);
});
test('catalog and settings are snapshotted, never mutated by merge or selection', () => {
  const d = document(); const original = structuredClone(d); const s = structuredClone(settings);
  const p = parseModelProfiles(d, s, env); p.analyst.model.compat.supportsStore = true;
  assert.deepEqual(d, original); assert.deepEqual(s, settings);
});
test('startup reads dedicated models.json and prompt files without legacy model env', async t => {
  const root = await setup(t);
  await writeFile(join(root, '.daas/models.json'), JSON.stringify(document()));
  await writeFile(join(root, '.daas/settings.json'), JSON.stringify(settings));
  const c = await loadConfig(vars, [], root);
  assert.equal(c.modelProfiles?.developer.model.provider, 'company'); assert.ok(c.systemPrompts.analyst.includes('当前模式：数据分析'));
});
test('explicit model path is relative to app root and takes precedence over legacy env', async t => {
  const root = await setup(t); await writeFile(join(root, 'private-models.json'), JSON.stringify(document()));
  const c = await loadConfig({ ...vars, DAAS_MODELS_FILE: 'private-models.json', DAAS_MODEL_KEY: 'ignored', DAAS_MODEL_BASE_URL: 'bad' }, [], root);
  assert.equal(c.modelProfiles?.analyst.model.baseUrl, 'https://model.invalid/v1'); assert.equal(c.modelProfiles?.analyst.apiKey, 'unit-secret');
});
test('broken or explicit-missing model file never falls back to legacy credentials', async t => {
  const root = await setup(t); const legacy = { DAAS_MODEL_KEY: 'legacy', DAAS_MODEL_BASE_URL: 'http://localhost:9/v1' };
  await writeFile(join(root, '.daas/models.json'), '{"apiKey":"never-print-me", broken');
  await assert.rejects(loadModelProfiles(root, {}, legacy), (e: unknown) => e instanceof AppError && !e.message.includes('never-print-me'));
  await assert.rejects(loadModelProfiles(root, {}, { ...legacy, DAAS_MODELS_FILE: 'missing.json' }), AppError);
});
test('legacy environment path remains compatible only when default models file is absent', async t => {
  const root = await setup(t);
  const c = await loadModelProfiles(root, {}, { DAAS_MODEL_KEY: 'old-key', DAAS_MODEL_BASE_URL: 'http://localhost:9/v1', DAAS_MODEL_ID: 'old-model' });
  assert.equal(c.analyst.model.id, 'old-model'); assert.equal(c.analyst.thinkingLevel, 'off');
});
test('does not discover old terminal configuration; demo does not require model credentials', async t => {
  const root = await setup(t); await mkdir(join(root, '.config/agent'), { recursive: true });
  await writeFile(join(root, '.config/agent/models.json'), JSON.stringify(document()));
  await assert.rejects(loadModelProfiles(root, {}, env), AppError);
  assert.equal((await loadConfig({ DAAS_DEMO: '1' }, [], root)).modelProfiles, undefined);
});
test('invalid and oversized config errors do not contain secret content', async t => {
  const root = await setup(t); await writeFile(join(root, '.daas/models.json'), 'secret'.repeat(45000));
  await assert.rejects(loadModelProfiles(root, {}, env), (e: unknown) => !publicError(e).message.includes('secret'));
});
test('prompts are layered by mode and do not expose connection information', async () => {
  const prompts = await loadSystemPrompts(APP_ROOT);
  assert.ok(prompts.developer.includes('当前模式：API 开发')); assert.ok(!prompts.analyst.includes('当前模式：API 开发'));
  assert.ok(prompts.analyst.includes('sys_invoke')); assert.ok(!/\bpi\b|apiKey|model\.company/.test(prompts.analyst));
});
test('missing prompt file fails rather than reverting to an unrelated persona', async t => {
  const root = await setup(t); await rm(join(root, '.daas/prompts/base.md'));
  await assert.rejects(loadSystemPrompts(root), /提示词文件/);
});
test('identity normalization does not corrupt SQL, code, identifiers, or quoted data', () => {
  for (const input of ['SELECT PI() AS value;', '```sql\nSELECT PI()\n```', '变量 pi 和 ChatGPT 字段', '说明：I am pi coding agent', '`I am pi`', 'pi = 3.14159']) assert.equal(brand(input), input);
  assert.equal(brand('我是 pi。'), '我是 DaaS Agent。');
});
test('runtime adapter forwards selected provider, thought settings, metadata and secret headers', async () => {
  const c = demoConfig('/tmp/unused'); c.modelProfiles = parseModelProfiles(document(), settings, env);
  c.systemPrompts = await loadSystemPrompts(APP_ROOT);
  let selected: ModelDefinition | undefined; let options: Record<string, unknown> | undefined;
  let state: Record<string, unknown> | undefined; let listener: ((event: unknown) => void | Promise<void>) | undefined;
  const replies: string[] = [];
  const sdk: Framework = {
    Agent: class {
      constructor(o: Record<string, any>) { state = o.initialState; this.stream = () => o.streamFn(o.initialState.model, {}, { reasoning: o.initialState.thinkingLevel }); }
      stream: () => void;
      subscribe(fn: (e: unknown) => void | Promise<void>) { listener = fn; return () => {}; }
      abort() {}
      async prompt() { this.stream(); await listener?.({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'thinking', thinking: 'not-public' }, { type: 'text', text: 'SELECT PI() AS value;' }] } }); }
    },
    getSupportedThinkingLevels: () => ['high', 'max'],
    streamSimple(model: ModelDefinition, _ctx: unknown, opts: Record<string, unknown>) { selected = model; options = opts; },
  };
  await runModel(c, { session: { mode: 'analyst', messages: [], results: [] } as unknown as Session, prompt: '分析', signal: new AbortController().signal, definitions: SYSTEM_TOOLS, call: async () => ({}), reply: async text => { replies.push(text); } }, sdk);
  assert.equal(selected?.provider, 'company'); assert.equal(selected?.reasoning, true); assert.equal(options?.reasoning, 'high');
  assert.equal(options?.apiKey, 'unit-secret'); assert.equal((options?.headers as Record<string, string>)['x-company-key'], 'header-secret');
  assert.equal((state?.model as ModelDefinition).compat.supportsReasoningEffort, true); assert.ok(!JSON.stringify(state).includes('unit-secret'));
  assert.deepEqual(replies, ['SELECT PI() AS value;']);
});
test('checked-in example loads with explicit secret and retains original thinking-level map', async () => {
  const doc = JSON.parse(await readFile(join(APP_ROOT, '.daas/models.example.json'), 'utf8'));
  const config = JSON.parse(await readFile(join(APP_ROOT, '.daas/settings.example.json'), 'utf8'));
  const p = parseModelProfiles(doc, config, { DEEPSEEK_API_KEY: 'test-only' });
  assert.equal(p.developer.thinkingLevel, 'high'); assert.equal(p.analyst.model.thinkingLevelMap?.off, null);
});
