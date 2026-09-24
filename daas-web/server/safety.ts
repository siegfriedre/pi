import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Config, Mode, Principal, Schema } from './types.ts';

export class AppError extends Error {
  code: string; status: number;
  constructor(code: string, message: string, status = 400) {
    super(message); this.name = 'AppError'; this.code = code; this.status = status;
  }
}
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}
export const escapeHtml = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
// Normalize only self-identification, never arbitrary occurrences in SQL, identifiers or data.
// Product prompts/UI and fixed identity replies are the main branding controls, not text rewriting.
export function brand(text: string): string {
  const upstreamName = '(?:pi(?:[- ](?:coding[- ]agent|agent|mono))?|Claude Code|ChatGPT)';
  const chinese = new RegExp(`(^(?:我是|我叫|我的名字是|我的身份是)\\s*)${upstreamName}(?=$|[\\s，。！!：:；;、])`, 'i');
  const english = new RegExp(`(^(?:I am|I'm|My name is)\\s+)${upstreamName}(?=$|[\\s,.;!:])`, 'i');
  return text.replace(chinese, '$1DaaS Agent').replace(english, '$1DaaS Agent');
}
export function publicError(e: unknown): { code: string; message: string } {
  return e instanceof AppError ? { code: e.code, message: brand(e.message) }
    : { code: 'INTERNAL_ERROR', message: 'DaaS 暂时无法完成此操作，请联系管理员查看服务日志。' };
}
export function identityReply(text: string): string | undefined {
  if (/^(你是(谁|什么(?:助手|系统|产品)?)|介绍(?:一下)?你自己|who\s+are\s+you)[？?。！!\s]*$/i.test(text.trim())) {
    return '我是 DaaS Agent，你的数据 API 开发与分析助手。我使用管理员提供的受控能力，在你的业务空间和权限范围内协助开发 API、查询数据、生成图表和报告。';
  }
}
export function validate(schema: Schema, value: unknown, path = '参数', depth = 0): void {
  const fail = (message: string): never => { throw new AppError('INVALID_ARGUMENTS', `${path}${message}`); };
  if (depth > 12) fail('嵌套过深');
  if (schema.enum && !schema.enum.some(v => v === value)) fail('不在允许的选项中');
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('必须是对象');
      const obj = value as Record<string, unknown>;
      if (Object.keys(obj).length > 100) fail('字段过多');
      for (const k of Object.keys(obj)) {
        if (['__proto__', 'constructor', 'prototype'].includes(k)) fail('包含不允许的字段');
        if (!Object.hasOwn(schema.properties ?? {}, k)) {
          if (schema.additionalProperties !== true) fail(`包含未知字段 ${k}`);
          // Arbitrary JSON data is allowed only when the administrator explicitly opts in.
          validateJson(obj[k], depth + 1);
        } else validate(schema.properties![k], obj[k], `${path}.${k}`, depth + 1);
      }
      for (const k of schema.required ?? []) if (!Object.hasOwn(obj, k)) fail(`缺少 ${k}`);
      return;
    }
    case 'array':
      if (!Array.isArray(value)) fail('必须是数组');
      if ((value as unknown[]).length > (schema.maxItems ?? 200)) fail('数组过长');
      if (!schema.items) fail('缺少数组元素定义');
      (value as unknown[]).forEach((v, i) => validate(schema.items!, v, `${path}[${i}]`, depth + 1)); return;
    case 'string':
      if (typeof value !== 'string') fail('必须是字符串');
      if ((value as string).length > (schema.maxLength ?? 8000)) fail('字符串过长'); return;
    case 'boolean': if (typeof value !== 'boolean') fail('必须是布尔值'); return;
    case 'number': case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) fail('必须是有效数字');
      if ((value as number) < (schema.minimum ?? -Infinity) || (value as number) > (schema.maximum ?? Infinity)) fail('超出范围'); return;
    default: fail('定义不受支持');
  }
}
export function validateJson(value: unknown, depth = 0): void {
  if (depth > 12) throw new AppError('INVALID_ARGUMENTS', '数据嵌套过深');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string' && value.length <= 50000) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value) && value.length <= 2000) { value.forEach(v => validateJson(v, depth + 1)); return; }
  if (value && typeof value === 'object' && Object.keys(value).length <= 100) {
    for (const [k, v] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(k)) throw new AppError('INVALID_ARGUMENTS', '不允许的字段');
      validateJson(v, depth + 1);
    }
    return;
  }
  throw new AppError('INVALID_ARGUMENTS', '数据类型或大小不受支持');
}
export function authorize(p: Principal, space: string, mode: Mode): void {
  if (p.exp <= Date.now() / 1000) throw new AppError('UNAUTHENTICATED', '登录已过期，请刷新页面。', 401);
  if (!p.spaces.some(s => s.id === space && s.modes.includes(mode))) throw new AppError('FORBIDDEN', '无权访问当前业务空间或模式。', 403);
}
export function signContext(encoded: string, token: string, secret: string): string {
  return createHmac('sha256', secret).update(`${encoded}.${digest(token)}`).digest('hex');
}
export function authenticate(req: IncomingMessage, config: Config): Principal {
  if (config.demo) return { sub: 'demo-user', tenant: 'demo', name: '演示用户', exp: Date.now() / 1000 + 3600, spaces: [{ id: 'demo-space', name: '演示空间', modes: ['developer', 'analyst'] }] };
  const encoded = req.headers['x-daas-context']; const sig = req.headers['x-daas-signature'];
  const authorization = req.headers.authorization ?? '';
  if (typeof encoded !== 'string' || encoded.length > 16000 || typeof sig !== 'string' || !/^[a-f0-9]{64}$/.test(sig) || !authorization.startsWith('Bearer ')) throw new AppError('UNAUTHENTICATED', '请通过 DaaS 平台登录。', 401);
  const token = authorization.slice(7);
  const expected = signContext(encoded, token, config.gatewaySecret);
  if (!timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'))) throw new AppError('UNAUTHENTICATED', '身份校验失败。', 401);
  let p: Principal;
  try { p = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { throw new AppError('UNAUTHENTICATED', '身份格式错误。', 401); }
  if (!p || typeof p.sub !== 'string' || !p.sub || p.sub.length > 200 || typeof p.tenant !== 'string' || !p.tenant || typeof p.name !== 'string' || !Number.isFinite(p.exp) || p.exp <= Date.now() / 1000 || p.exp > Date.now() / 1000 + 600 || !Array.isArray(p.spaces) || p.spaces.length > 100 || p.spaces.some(s => !s || typeof s.id !== 'string' || !s.id || typeof s.name !== 'string' || !Array.isArray(s.modes) || s.modes.some(m => !['developer', 'analyst'].includes(m)))) throw new AppError('UNAUTHENTICATED', '身份已过期或内容无效。', 401);
  return { sub: p.sub, tenant: p.tenant, name: p.name, exp: p.exp, spaces: p.spaces, token };
}
export async function readApproved(root: string, file: string, maxBytes = 64000): Promise<string> {
  if (isAbsolute(file) || file.includes('\0') || file.includes('\\')) throw new AppError('RESOURCE_DENIED', '资源路径不允许。', 403);
  const base = await realpath(root); const candidate = resolve(base, file); const rel = relative(base, candidate);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new AppError('RESOURCE_DENIED', '资源路径不允许。', 403);
  // Reject every symlink component, not just a lexical prefix. Content directories must also be read-only.
  let current = base;
  for (const part of rel.split(sep)) { current = resolve(current, part); if ((await lstat(current)).isSymbolicLink()) throw new AppError('RESOURCE_DENIED', '不允许符号链接资源。', 403); }
  if (await realpath(candidate) !== candidate) throw new AppError('RESOURCE_DENIED', '资源路径不允许。', 403);
  const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new AppError('RESOURCE_TOO_LARGE', '资源类型不允许或内容过大。');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}
