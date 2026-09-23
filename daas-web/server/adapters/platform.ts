import { AppError, validateJson } from '../safety.ts';
import type { Args, Config, Principal, Session } from '../types.ts';

// Only administrator-mapped operations can reach the platform. The LLM cannot choose a URL/method/header.
// Adapt payload/response normalization here to your company's existing API contract.
export function platformClient(config: Config, principal: Principal, session: Session) {
  return async (operation: string, args: Args, signal: AbortSignal, key?: string): Promise<unknown> => {
    if (config.demo) throw new AppError('DEMO_ONLY', '演示环境不访问真实平台。');
    const path = Object.hasOwn(config.operations, operation) ? config.operations[operation] : undefined;
    if (!config.platformBase || !path) throw new AppError('PLATFORM_NOT_CONFIGURED', '该平台能力尚未完成接口映射，请管理员配置后再使用。', 503);
    if (operation === 'api.invoke' && !config.readApiIds.includes(String(args.apiId))) throw new AppError('API_NOT_APPROVED', '此 API 尚未纳入管理员批准的只读调用清单。', 403);
    if (!principal.token) throw new AppError('UNAUTHENTICATED', '缺少平台用户身份。', 401);
    const endpoint = new URL(config.platformBase.replace(/\/$/, '') + path);
    const combined = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: 'POST', redirect: 'error', signal: combined,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${principal.token}`, ...(key ? { 'Idempotency-Key': key } : {}) },
        // Server-owned identity and space cannot be overwritten by model arguments.
        body: JSON.stringify({ parameters: args, spaceId: session.space }),
      });
    } catch { throw new AppError('PLATFORM_UNAVAILABLE', '平台调用未完成；写入状态可能未知，请先核对，勿重复提交。', 502); }
    if (!res.ok) { await res.body?.cancel(); throw new AppError(res.status === 403 ? 'FORBIDDEN' : 'PLATFORM_ERROR', res.status === 403 ? '平台拒绝了本次操作。' : '平台操作未成功，请核对请求记录。', res.status === 403 ? 403 : 502); }
    if (!res.headers.get('content-type')?.includes('application/json')) { await res.body?.cancel(); throw new AppError('PLATFORM_FORMAT', '平台需要返回标准 JSON 数据。', 502); }
    const reader = res.body!.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
    try {
      for (;;) { const { value, done } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 1024 * 1024) { await reader.cancel(); throw new AppError('RESULT_TOO_LARGE', '查询结果超过 1MB，请缩小范围或在平台汇总。', 413); } chunks.push(value); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8')); validateJson(data); return normalizePlatformResponse(operation, data);
    } catch (e) { if (e instanceof AppError) throw e; throw new AppError('PLATFORM_FORMAT', '平台返回格式无法识别，请管理员检查适配器。', 502); }
    finally { reader.releaseLock(); }
  };
}

// Project metadata to an explicit allowlist so connection passwords, headers and tokens never become tool output.
// Real query rows are business data and are NOT rewritten; DaaS must enforce their data-level authorization.
export function normalizePlatformResponse(operation: string, data: unknown): unknown {
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('PLATFORM_FORMAT', '平台返回结构不符合适配器约定。', 502);
    return value as Record<string, unknown>;
  };
  const pick = (value: unknown, fields: string[]) => {
    const input = record(value); return Object.fromEntries(fields.filter(f => Object.hasOwn(input, f)).map(f => [f, input[f]]));
  };
  const array = (value: unknown): unknown[] => {
    if (!Array.isArray(value)) throw new AppError('PLATFORM_FORMAT', '平台需要返回数组字段。', 502);
    return value;
  };
  if (operation === 'datasource.list') return { items: array(record(data).items).map(x => pick(x, ['id', 'name', 'type'])) };
  if (operation === 'datasource.schema') return { tables: array(record(data).tables).map(x => ({ ...pick(x, ['name', 'description']), columns: array(record(x).columns).map(c => pick(c, ['name', 'type', 'description', 'nullable'])) })) };
  if (operation === 'api.search') return { items: array(record(data).items).map(x => pick(x, ['id', 'name', 'description', 'effect'])) };
  if (operation === 'api.describe') return pick(data, ['id', 'name', 'description', 'parameters', 'fields', 'unit', 'period', 'effect']);
  if (operation === 'sql.validate') return pick(data, ['validated', 'issues', 'warnings']);
  if (operation === 'api.save_draft') return pick(data, ['draftId', 'status', 'version']);
  return data;
}
