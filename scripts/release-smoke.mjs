import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const root = process.argv[2];
let requests = 0;
let currentCase;
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, currentCase.authorization);
    assert.equal(req.headers['x-company-key'], 'header-test-key');
    assert.equal(req.headers['user-agent'], 'DaaS-Agent/0.1');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw);
    assert.equal(payload.tools.length, 4);
    assert.equal(payload.model, currentCase.model);
    assert.equal(payload.max_tokens, 1024);
    assert.equal(payload.temperature, 0.6);
    assert.ok(payload.messages.some(m => m.role === 'system' && m.content.includes('DaaS Agent')));
    assert.ok(!JSON.stringify(payload).includes('local-test-key'));
    if (currentCase.reasoning) {
      assert.deepEqual(payload.thinking, { type: 'enabled' });
      assert.equal(payload.reasoning_effort, 'max'); // configured high -> provider max
    } else assert.equal(payload.reasoning_effort, undefined);
    const first = requests++ % 2 === 0;
    if (!first) assert.ok(payload.messages.some(message => message.role === 'tool'));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const delta = first ? {
      role: 'assistant', tool_calls: [{ index: 0, id: 'call-discover', type: 'function', function: { name: 'sys_discover', arguments: '{"query":"销售"}' } }],
    } : { role: 'assistant', content: 'DaaS 发布包验证通过。SELECT PI() AS value;' };
    const chunk = { id: 'mock', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: currentCase.model,
      choices: [{ index: 0, delta, finish_reason: null }] };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: String(e) } })); }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  const { runModel } = await import(pathToFileURL(join(root, 'server/adapters/model.ts')).href);
  const { SYSTEM_TOOLS } = await import(pathToFileURL(join(root, 'server/registry.ts')).href);
  const { loadConfig } = await import(pathToFileURL(join(root, 'server/config.ts')).href);
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  await writeFile(join(root, '.daas/models.json'), JSON.stringify({ providers: {
    company: {
      api: 'openai-completions', baseUrl, apiKey: '${LOCAL_MODEL_KEY}', headers: { 'X-Company-Key': '$LOCAL_HEADER_KEY' },
      compat: { supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: true, thinkingFormat: 'deepseek', maxTokensField: 'max_tokens' },
      models: [
        { id: 'thinking-model', reasoning: true, thinkingLevelMap: { off: null, high: 'max' }, maxTokens: 1024, samplingParams: { temperature: 0.6 } },
        { id: 'fast-model', reasoning: false, maxTokens: 1024, samplingParams: { temperature: 0.6 } },
      ],
    },
    headerOnly: { api: 'openai-completions', baseUrl, authHeader: false, headers: { 'X-Company-Key': '$LOCAL_HEADER_KEY' }, compat: { maxTokensField: 'max_tokens' }, models: [{ id: 'keyless', maxTokens: 1024, samplingParams: { temperature: 0.6 } }] },
  } }));
  const env = { DAAS_PUBLIC_ORIGIN: baseUrl, DAAS_GATEWAY_SECRET: 'x'.repeat(40), LOCAL_MODEL_KEY: 'local-test-key', LOCAL_HEADER_KEY: 'header-test-key' };
  await writeFile(join(root, '.daas/settings.json'), JSON.stringify({ defaultProvider: 'company', defaultModel: 'thinking-model', defaultThinkingLevel: 'high', modeModels: { analyst: { provider: 'company', model: 'fast-model', thinkingLevel: 'off' } } }));
  const config = await loadConfig(env, [], root);
  let calls = 0;
  for (const scenario of [
    { mode: 'developer', model: 'thinking-model', reasoning: true, authorization: 'Bearer local-test-key' },
    { mode: 'analyst', model: 'fast-model', reasoning: false, authorization: 'Bearer local-test-key' },
    { mode: 'analyst', model: 'keyless', reasoning: false, authorization: undefined },
  ]) {
    currentCase = scenario;
    let selected = config;
    if (scenario.model === 'keyless') {
      await writeFile(join(root, '.daas/settings.json'), JSON.stringify({ defaultProvider: 'headerOnly', defaultModel: 'keyless' }));
      selected = await loadConfig(env, [], root);
    }
    const replies = [];
    await runModel(selected, {
      session: { mode: scenario.mode, messages: [{ role: 'user', text: '查找销售能力', time: new Date().toISOString() }], results: [] },
      prompt: '查找销售能力', signal: AbortSignal.timeout(20000), definitions: SYSTEM_TOOLS,
      async call(name, args) { assert.equal(name, 'sys_discover'); assert.deepEqual(args, { query: '销售' }); calls++; return []; },
      async reply(text) { replies.push(text); },
    });
    assert.match(replies.join(''), /DaaS 发布包验证通过/);
    assert.match(replies.join(''), /SELECT PI\(\)/);
  }
  assert.equal(calls, 3); assert.equal(requests, 6);
} finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
