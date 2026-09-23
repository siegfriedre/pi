import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { AppError } from './safety.ts';
import type { Config } from './types.ts';

export const APP_ROOT = fileURLToPath(new URL('../', import.meta.url));
export async function loadConfig(env = process.env, args = process.argv): Promise<Config> {
  let local: Record<string, unknown> = {};
  try { local = JSON.parse(await readFile(resolve(APP_ROOT, '.daas/settings.json'), 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new AppError('CONFIG_ERROR', 'DaaS 配置文件格式无效。'); }
  const demo = args.includes('--demo') || env.DAAS_DEMO === '1';
  const port = Number(env.DAAS_PORT ?? 3210);
  const host = env.DAAS_HOST ?? '127.0.0.1';
  const origin = env.DAAS_PUBLIC_ORIGIN ?? `http://localhost:${port}`;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new AppError('CONFIG_ERROR', '端口配置无效。');
  if (demo && !['127.0.0.1', '::1', 'localhost'].includes(host) && env.DAAS_ALLOW_DEMO_NETWORK !== '1') throw new AppError('CONFIG_ERROR', '演示模式默认仅允许本机访问；开放演示网络必须明确设置 DAAS_ALLOW_DEMO_NETWORK=1。');
  const gatewaySecret = env.DAAS_GATEWAY_SECRET ?? '';
  const modelKey = env.DAAS_MODEL_KEY ?? '';
  const modelBase = env.DAAS_MODEL_BASE_URL ?? '';
  if (!demo && (gatewaySecret.length < 32 || !modelKey || !modelBase || !env.DAAS_PUBLIC_ORIGIN)) throw new AppError('CONFIG_ERROR', '正式模式需要网关签名密钥、模型密钥、模型地址和公开访问地址；不会自动降级为演示。');
  for (const value of [origin, modelBase, env.DAAS_PLATFORM_BASE_URL ?? ''].filter(Boolean)) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new AppError('CONFIG_ERROR', '服务地址必须是不含凭据、查询或片段的 HTTP(S) 地址。');
  }
  let modelHeaders: Record<string, string> = {};
  try { modelHeaders = JSON.parse(env.DAAS_MODEL_HEADERS_JSON ?? '{}'); } catch { throw new AppError('CONFIG_ERROR', '模型请求头配置无效。'); }
  if (!modelHeaders || Array.isArray(modelHeaders) || Object.values(modelHeaders).some(v => typeof v !== 'string')) throw new AppError('CONFIG_ERROR', '模型请求头配置无效。');
  const operations = (local.operations ?? {}) as Record<string, string>;
  const readApiIds = (local.readApiIds ?? []) as string[];
  if (!operations || Array.isArray(operations) || Object.values(operations).some(v => typeof v !== 'string' || !/^\/(?!\/)[A-Za-z0-9/_-]+$/.test(v)) || !Array.isArray(readApiIds) || readApiIds.some(v => typeof v !== 'string')) throw new AppError('CONFIG_ERROR', '平台操作映射或只读 API 白名单配置无效。');
  return {
    demo, host, port, origin: new URL(origin).origin, root: APP_ROOT,
    dataDir: resolve(env.DAAS_DATA_DIR ?? resolve(APP_ROOT, 'runtime-data')),
    gatewaySecret, modelKey, modelBase, modelId: env.DAAS_MODEL_ID ?? 'deepseek-flash', modelHeaders,
    modelCompat: (local.modelCompat ?? {}) as Record<string, unknown>,
    modelContext: Number(local.modelContext ?? 65536), modelMaxTokens: Number(local.modelMaxTokens ?? 4096),
    maxTurns: 18, taskTimeoutMs: 180000,
    platformBase: env.DAAS_PLATFORM_BASE_URL ?? '', operations, readApiIds,
  };
}
