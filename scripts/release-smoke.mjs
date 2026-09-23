import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const root = process.argv[2];
let requests = 0;
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer local-test-key');
    assert.equal(req.headers['user-agent'], 'DaaS-Agent/0.1');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw);
    assert.equal(payload.tools.length, 4);
    const first = requests++ === 0;
    if (!first) assert.ok(payload.messages.some(message => message.role === 'tool'));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const delta = first ? {
      role: 'assistant', tool_calls: [{ index: 0, id: 'call-discover', type: 'function', function: { name: 'sys_discover', arguments: '{"query":"销售"}' } }],
    } : { role: 'assistant', content: 'DaaS 发布包验证通过。' };
    const chunk = { id: 'mock', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'mock-model',
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
  let calls = 0; const replies = [];
  await runModel({
    modelId: 'mock-model', modelBase: `http://127.0.0.1:${server.address().port}/v1`,
    modelKey: 'local-test-key', modelHeaders: {}, modelCompat: {},
    modelContext: 65536, modelMaxTokens: 1024, maxTurns: 4, taskTimeoutMs: 15000,
  }, {
    session: { mode: 'analyst', messages: [{ role: 'user', text: '查找销售能力', time: new Date().toISOString() }], results: [] },
    prompt: '查找销售能力', signal: AbortSignal.timeout(20000), definitions: SYSTEM_TOOLS,
    async call(name, args) { assert.equal(name, 'sys_discover'); assert.deepEqual(args, { query: '销售' }); calls++; return []; },
    async reply(text) { replies.push(text); },
  });
  assert.equal(calls, 1); assert.equal(requests, 2); assert.match(replies.join(''), /DaaS 发布包验证通过/);
} finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
