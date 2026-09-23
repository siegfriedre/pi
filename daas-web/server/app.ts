import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import register from '../.daas/index.ts';
import { AppError, authenticate, publicError } from './safety.ts';
import { Registry } from './registry.ts';
import { Store, sessionView } from './store.ts';
import { Runtime } from './runtime.ts';
import type { Config, Mode } from './types.ts';

const staticFiles: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
function headers(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN'); res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'");
}
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new AppError('CONTENT_TYPE', '请求需要 JSON 内容。', 415);
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > 64000) throw new AppError('BODY_TOO_LARGE', '请求内容过大。', 413); chunks.push(chunk); }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('INVALID_JSON', '请求 JSON 格式无效。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('INVALID_JSON', '请求必须是 JSON 对象。');
  return value as Record<string, unknown>;
}
function exact(input: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(input).some(k => !keys.includes(k))) throw new AppError('INVALID_ARGUMENTS', '请求包含未允许的字段。');
}
export async function createApplication(config: Config) {
  const registry = new Registry(); register(registry); registry.seal();
  const store = new Store(resolve(config.dataDir, 'sessions')); await store.init();
  const runtime = new Runtime(registry, config, store);
  const quotas = new Map<string, { time: number; count: number }>();
  const server = createServer(async (req, res) => {
    headers(res);
    try {
      const url = new URL(req.url ?? '/', config.origin); const path = url.pathname;
      if (req.method === 'GET' && path === '/healthz') { json(res, 200, { status: 'ok', product: 'DaaS Agent', demo: config.demo }); return; }
      if (req.method === 'GET' && Object.hasOwn(staticFiles, path)) {
        const [file, type] = staticFiles[path]; res.writeHead(200, { 'Content-Type': type }); res.end(await readFile(resolve(config.root, 'public', file))); return;
      }
      if (!path.startsWith('/api/')) throw new AppError('NOT_FOUND', '资源不存在。', 404);
      const principal = authenticate(req, config);
      const quotaKey = `${principal.tenant}:${principal.sub}`; const quota = quotas.get(quotaKey);
      if (!quota || Date.now() - quota.time > 60000) quotas.set(quotaKey, { time: Date.now(), count: 1 });
      else if (++quota.count > 240) throw new AppError('RATE_LIMIT', '请求过于频繁，请稍后重试。', 429);
      if (quotas.size > 10000) for (const [key, q] of quotas) if (Date.now() - q.time > 60000) quotas.delete(key);
      if (req.method !== 'GET') {
        if (req.method !== 'POST') throw new AppError('METHOD_NOT_ALLOWED', '此接口不支持该请求方法。', 405);
        if (req.headers.origin !== config.origin) throw new AppError('ORIGIN_DENIED', '请求来源校验失败。', 403);
      }
      if (req.method === 'GET' && path === '/api/bootstrap') { json(res, 200, { product: 'DaaS Agent', demo: config.demo, user: { name: principal.name, spaces: principal.spaces } }); return; }
      if (path === '/api/sessions' && req.method === 'GET') {
        json(res, 200, { sessions: (await store.list(principal)).map(s => ({ id: s.id, title: s.title, mode: s.mode, space: s.space, updatedAt: s.updatedAt })) }); return;
      }
      if (path === '/api/sessions' && req.method === 'POST') {
        const input = await body(req); exact(input, ['space', 'mode']);
        if (typeof input.space !== 'string' || !['developer', 'analyst'].includes(String(input.mode))) throw new AppError('INVALID_ARGUMENTS', '业务空间或模式无效。');
        json(res, 201, sessionView(await store.create(principal, input.space, input.mode as Mode))); return;
      }
      const match = path.match(/^\/api\/sessions\/([^/]+)(?:\/(messages|stop|approvals|artifacts|results)(?:\/([^/]+))?)?$/);
      if (!match) throw new AppError('NOT_FOUND', '接口不存在。', 404);
      const [, sid, action, rid] = match; const s = await store.get(sid, principal);
      if (!action && req.method === 'GET') { json(res, 200, Number(url.searchParams.get('after')) === s.revision ? { unchanged: true } : sessionView(s)); return; }
      if (action === 'messages' && req.method === 'POST' && !rid) {
        const input = await body(req); exact(input, ['text']); if (typeof input.text !== 'string') throw new AppError('INVALID_ARGUMENTS', '消息内容必须是文本。');
        await runtime.start(s, principal, input.text); json(res, 202, sessionView(s)); return;
      }
      if (action === 'stop' && req.method === 'POST' && !rid) { exact(await body(req), []); runtime.stop(sid); json(res, 200, { status: 'cancelling' }); return; }
      if (action === 'approvals' && req.method === 'POST' && rid) {
        const input = await body(req); exact(input, ['accept']); if (typeof input.accept !== 'boolean') throw new AppError('INVALID_ARGUMENTS', '确认值必须是布尔值。');
        await runtime.approval(s, principal, rid, input.accept); json(res, 200, sessionView(s)); return;
      }
      if (action === 'artifacts' && req.method === 'GET' && rid) {
        const artifact = s.artifacts.find(a => a.id === rid); if (!artifact) throw new AppError('NOT_FOUND', '产物不存在。', 404);
        res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
        if (url.searchParams.get('download') === '1') res.setHeader('Content-Disposition', `attachment; filename="daas-report-${rid}.html"`);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(artifact.html); return;
      }
      if (action === 'results' && req.method === 'GET' && rid) {
        const result = s.results.find(r => r.id === rid); if (!result) throw new AppError('NOT_FOUND', '结果不存在。', 404);
        res.setHeader('Content-Disposition', `attachment; filename="daas-data-${rid}.json"`); json(res, 200, result); return;
      }
      throw new AppError('NOT_FOUND', '接口不存在。', 404);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      json(res, error instanceof AppError ? error.status : 500, { error: publicError(error) });
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 15000; server.keepAliveTimeout = 5000; server.maxHeadersCount = 64;
  server.on('close', () => runtime.shutdown());
  return { server, store, registry, runtime };
}
