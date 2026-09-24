import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import { AppError } from './safety.ts';
import type { Mode } from './types.ts';

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];
export interface ModelDefinition {
  id: string; name: string; api: 'openai-completions'; provider: string; baseUrl: string;
  reasoning: boolean; input: ('text' | 'image')[]; contextWindow: number; maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
  samplingParams?: Record<string, unknown>;
  compat: Record<string, unknown>;
}
export interface ResolvedModel {
  model: ModelDefinition;
  // Connection secrets stay outside model metadata, session state and browser responses.
  apiKey: string;
  headers: Record<string, string | null>;
  thinkingLevel: ThinkingLevel;
}
export type ModelProfiles = Record<Mode, ResolvedModel>;
type ObjectValue = Record<string, unknown>;
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function fail(field: string, reason: string): never {
  // Show field names, never configuration values, credentials, parser excerpts or filesystem paths.
  throw new AppError('MODEL_CONFIG_ERROR', `DaaS 模型配置 ${field}：${reason}`, 503);
}
function record(value: unknown, field: string): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field, '必须是对象。');
  const obj = value as ObjectValue;
  if (Object.keys(obj).some(k => BAD_KEYS.has(k))) fail(field, '包含不允许的字段。');
  return obj;
}
function keys(obj: ObjectValue, allowed: readonly string[], field: string): void {
  if (Object.keys(obj).some(k => !allowed.includes(k))) fail(field, '包含当前版本不支持的字段，请参考 MODELS.md。');
}
function text(value: unknown, field: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail(field, '必须是长度受限的非空字符串。');
  return value as string;
}
function bool(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(field, '必须是布尔值。');
  return value as boolean;
}
function positive(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 10000000) fail(field, '必须是有效的正整数。');
  return value as number;
}
export async function readConfigObject(file: string, label: string, optional = false): Promise<ObjectValue | undefined> {
  let handle;
  try {
    handle = await open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 256000) fail(label, '文件必须是小于 256KB 的普通 JSON 文件。');
    const raw = await handle.readFile('utf8');
    if (Buffer.byteLength(raw) > 256000) fail(label, '文件过大。');
    return record(JSON.parse(raw), label);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    if (error instanceof AppError) throw error;
    fail(label, '文件不存在、无法读取或不是有效 JSON；不会回退到其他模型。');
  } finally { await handle?.close(); }
}
/** models.json-compatible interpolation only. No subprocess, eval, auto-env-name guessing, or recursive expansion. */
export function resolveConfigValue(value: unknown, env: NodeJS.ProcessEnv, field: string): string {
  const input = text(value, field, 16000);
  if (input.trimStart().startsWith('!')) fail(field, '不允许 !命令；请使用环境变量或字面值。');
  let out = '';
  for (let i = 0; i < input.length;) {
    if (input[i] !== '$') { out += input[i++]; continue; }
    const next = input[i + 1];
    if (next === '$' || next === '!') { out += next; i += 2; continue; }
    let name: string;
    if (next === '{') {
      const end = input.indexOf('}', i + 2);
      if (end < 0) fail(field, '环境变量引用格式无效。');
      name = input.slice(i + 2, end); i = end + 1;
    } else {
      const match = input.slice(i + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
      if (!match) fail(field, '字面 $ 请写成 $$。');
      name = match[0]; i += name.length + 1;
    }
    if (!KEY_PATTERN.test(name) || !Object.hasOwn(env, name) || !env[name]) fail(field, '引用的环境变量未设置或为空。');
    out += env[name];
  }
  if (!out.trim() || out.length > 16000 || /[\r\n\0]/.test(out)) fail(field, '解析值为空、过长或含不允许的控制字符。');
  return out;
}
function endpoint(value: unknown, env: NodeJS.ProcessEnv, field: string): string {
  const raw = resolveConfigValue(value, env, field);
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail(field, '必须是不含凭据、查询和片段的 HTTP(S) 地址。');
    return raw.replace(/\/$/, '');
  } catch (error) { if (error instanceof AppError) throw error; fail(field, '不是有效的模型服务地址。'); }
}
function headers(value: unknown, env: NodeJS.ProcessEnv, field: string): Record<string, string> {
  if (value === undefined) return {};
  const obj = record(value, field);
  if (Object.keys(obj).length > 40) fail(field, '请求头过多。');
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(obj)) {
    const key = name.toLowerCase();
    if (Object.hasOwn(out, key) || ['host', 'content-length', 'connection', 'transfer-encoding'].includes(key)) fail(field, '存在重复或不允许覆盖的请求头。');
    const resolved = resolveConfigValue(raw, env, field);
    try { validateHeaderName(name); validateHeaderValue(name, resolved); }
    catch { fail(field, '请求头名称或内容无效。'); }
    out[key] = resolved;
  }
  return out;
}
function safeJson(value: unknown, field: string, depth = 0): void {
  if (depth > 10) fail(field, '嵌套过深。');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value === 'string' && value.length <= 8000) return;
  if (Array.isArray(value) && value.length <= 100) { value.forEach(v => safeJson(v, field, depth + 1)); return; }
  const obj = record(value, field);
  if (Object.keys(obj).length > 100) fail(field, '字段过多。');
  Object.values(obj).forEach(v => safeJson(v, field, depth + 1));
}
const COMPAT_BOOLEANS = [
  'supportsStore', 'supportsDeveloperRole', 'supportsReasoningEffort', 'supportsUsageInStreaming',
  'supportsFinishReason', 'requiresToolResultName', 'requiresAssistantAfterToolResult', 'requiresThinkingAsText',
  'requiresReasoningContentOnAssistantMessages', 'zaiToolStream', 'supportsThinkingTokenBudget',
  'supportsOpenAIGrammarTools', 'supportsStrictMode', 'sendSessionAffinityHeaders', 'supportsLongCacheRetention',
];
const COMPAT_ENUMS: Record<string, readonly string[]> = {
  maxTokensField: ['max_tokens', 'max_completion_tokens'],
  thinkingFormat: ['openai', 'openrouter', 'deepseek', 'together', 'baseten', 'zai', 'qwen', 'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling'],
  thinkingTokenBudgetField: ['thinking_token_budget', 'thinking_budget', 'thinking_budget_tokens'],
  cacheControlFormat: ['anthropic'], deferredToolsMode: ['kimi'], sessionAffinityFormat: ['openai', 'openai-nosession', 'openrouter'],
};
function compatibility(value: unknown, field: string): ObjectValue {
  if (value === undefined) return {};
  const obj = record(value, field);
  keys(obj, [...COMPAT_BOOLEANS, ...Object.keys(COMPAT_ENUMS), 'chatTemplateKwargs', 'chatTemplateArgs', 'openRouterRouting', 'vercelGatewayRouting', 'vllmPriority'], field);
  for (const [key, val] of Object.entries(obj)) {
    if (COMPAT_BOOLEANS.includes(key)) bool(val, field, false);
    else if (Object.hasOwn(COMPAT_ENUMS, key)) { if (typeof val !== 'string' || !COMPAT_ENUMS[key].includes(val)) fail(field, '兼容参数枚举无效。'); }
    else if (key === 'vllmPriority') { if (!Number.isSafeInteger(val)) fail(field, '调度优先级必须是整数。'); }
    else { record(val, field); safeJson(val, field); }
  }
  return structuredClone(obj);
}
function sampling(value: unknown, field: string): ObjectValue | undefined {
  if (value === undefined) return undefined;
  const obj = record(value, field);
  // The core merges this object over its request: protect identity, prompts, tool schemas and protocol fields.
  const allowed = ['temperature', 'top_p', 'top_k', 'min_p', 'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'seed'];
  keys(obj, allowed, field);
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val !== 'number' || !Number.isFinite(val)) fail(field, '采样参数必须是有限数值。');
    if (['top_p', 'min_p'].includes(key) && (val < 0 || val > 1)) fail(field, '概率参数必须位于 0—1。');
    if (key === 'temperature' && (val < 0 || val > 2)) fail(field, 'temperature 必须位于 0—2。');
    if (['seed', 'top_k'].includes(key) && !Number.isSafeInteger(val)) fail(field, 'seed/top_k 必须是整数。');
  }
  return structuredClone(obj);
}
function thinkingMap(value: unknown, field: string): ModelDefinition['thinkingLevelMap'] {
  if (value === undefined) return undefined;
  const obj = record(value, field); keys(obj, THINKING_LEVELS, field);
  for (const val of Object.values(obj)) if (val !== null) text(val, field, 80);
  return { ...obj } as ModelDefinition['thinkingLevelMap'];
}
function supportedLevels(model: ModelDefinition): ThinkingLevel[] {
  // Mirrors this source baseline's metadata contract; the adapter also checks with the real AI helper.
  if (!model.reasoning) return ['off'];
  return THINKING_LEVELS.filter(level => model.thinkingLevelMap?.[level] !== null &&
    (!['xhigh', 'max'].includes(level) || model.thinkingLevelMap?.[level] !== undefined));
}
export function parseModelProfiles(document: unknown, settings: ObjectValue, env: NodeJS.ProcessEnv): ModelProfiles {
  const doc = record(document, 'models.json'); keys(doc, ['providers'], 'models.json');
  const providers = record(doc.providers, 'providers');
  const providerList = Object.entries(providers);
  if (!providerList.length || providerList.length > 32) fail('providers', '需要 1—32 个提供方。');
  const catalog: Omit<ResolvedModel, 'thinkingLevel'>[] = [];
  for (const [providerIndex, [provider, raw]] of providerList.entries()) {
    const loc = `providers[${providerIndex}]`; text(provider, loc, 100);
    const p = record(raw, loc); keys(p, ['baseUrl', 'api', 'apiKey', 'authHeader', 'headers', 'compat', 'models'], loc);
    const baseUrl = endpoint(p.baseUrl, env, `${loc}.baseUrl`);
    const pHeaders = headers(p.headers, env, `${loc}.headers`);
    const apiKey = p.apiKey === undefined ? '' : resolveConfigValue(p.apiKey, env, `${loc}.apiKey`);
    const automaticAuth = bool(p.authHeader, `${loc}.authHeader`, true);
    const pCompat = compatibility(p.compat, `${loc}.compat`);
    if (!Array.isArray(p.models) || !p.models.length || p.models.length > 128) fail(`${loc}.models`, '需要非空模型列表。');
    const ids = new Set<string>();
    for (const [index, item] of p.models.entries()) {
      const at = `${loc}.models[${index}]`; const m = record(item, at);
      keys(m, ['id', 'name', 'api', 'baseUrl', 'headers', 'reasoning', 'thinkingLevelMap', 'input', 'contextWindow', 'maxTokens', 'cost', 'compat', 'samplingParams'], at);
      const modelId = text(m.id, `${at}.id`, 200);
      if (ids.has(modelId)) fail(`${at}.id`, '同一提供方中模型 ID 重复。');
      ids.add(modelId);
      if ((m.api ?? p.api) !== 'openai-completions') fail(`${at}.api`, '本版本仅接入 openai-completions，不会把其他协议当成兼容协议调用。');
      const input = m.input ?? ['text'];
      if (!Array.isArray(input) || !input.includes('text') || input.some(v => !['text', 'image'].includes(v)) || new Set(input).size !== input.length) fail(`${at}.input`, '必须包含 text，可额外声明 image。');
      const contextWindow = positive(m.contextWindow, `${at}.contextWindow`, 128000);
      const maxTokens = positive(m.maxTokens, `${at}.maxTokens`, Math.min(16384, contextWindow));
      if (maxTokens > contextWindow) fail(`${at}.maxTokens`, '不能大于 contextWindow。');
      const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      if (m.cost !== undefined) {
        const c = record(m.cost, `${at}.cost`); keys(c, Object.keys(cost), `${at}.cost`);
        for (const key of Object.keys(cost) as (keyof typeof cost)[]) if (c[key] !== undefined) {
          if (typeof c[key] !== 'number' || !Number.isFinite(c[key]) || c[key] < 0) fail(`${at}.cost`, '费率必须为非负有限数值。');
          cost[key] = c[key] as number;
        }
      }
      const effectiveHeaders: Record<string, string | null> = { ...pHeaders, ...headers(m.headers, env, `${at}.headers`) };
      if (automaticAuth && !apiKey && !effectiveHeaders.authorization && !effectiveHeaders['cf-aig-authorization']) fail(`${loc}.apiKey`, '需要密钥/Authorization，或明确设置 authHeader:false。');
      if (!automaticAuth && !effectiveHeaders.authorization) effectiveHeaders.authorization = null;
      // Override branding only for the transport user-agent, not for identifiers or generated business data.
      delete effectiveHeaders['user-agent'];
      effectiveHeaders['User-Agent'] = 'DaaS-Agent/0.1';
      if (Object.hasOwn(effectiveHeaders, 'authorization')) {
        effectiveHeaders.Authorization = effectiveHeaders.authorization; delete effectiveHeaders.authorization;
      }
      const model: ModelDefinition = {
        id: modelId, name: m.name === undefined ? modelId : text(m.name, `${at}.name`), api: 'openai-completions', provider,
        baseUrl: m.baseUrl === undefined ? baseUrl : endpoint(m.baseUrl, env, `${at}.baseUrl`),
        reasoning: bool(m.reasoning, `${at}.reasoning`, false), input: input as ('text' | 'image')[],
        contextWindow, maxTokens, cost,
        compat: { ...pCompat, ...compatibility(m.compat, `${at}.compat`) },
        thinkingLevelMap: thinkingMap(m.thinkingLevelMap, `${at}.thinkingLevelMap`),
        samplingParams: sampling(m.samplingParams, `${at}.samplingParams`),
      };
      if (!supportedLevels(model).length) fail(`${at}.thinkingLevelMap`, '至少应支持一种思考级别。');
      catalog.push({ model, apiKey: apiKey || 'daas-header-auth', headers: effectiveHeaders });
      if (catalog.length > 256) fail('providers', '总模型数量不能超过 256。');
    }
  }
  const modeSettings = settings.modeModels === undefined ? {} : record(settings.modeModels, 'settings.modeModels');
  keys(modeSettings, ['developer', 'analyst'], 'settings.modeModels');
  function select(mode: Mode): ResolvedModel {
    const selection = modeSettings[mode] === undefined ? {} : record(modeSettings[mode], `settings.modeModels.${mode}`);
    keys(selection, ['provider', 'model', 'thinkingLevel'], `settings.modeModels.${mode}`);
    if ((selection.provider === undefined) !== (selection.model === undefined)) fail(`settings.modeModels.${mode}`, 'provider 和 model 必须一起设置。');
    if ((settings.defaultProvider === undefined) !== (settings.defaultModel === undefined)) fail('settings', 'defaultProvider 和 defaultModel 必须一起设置。');
    const provider = selection.provider ?? settings.defaultProvider;
    const modelId = selection.model ?? settings.defaultModel;
    if (provider !== undefined) { text(provider, 'settings.provider'); text(modelId, 'settings.model'); }
    const entry = provider === undefined && catalog.length === 1 ? catalog[0] : catalog.find(e => e.model.provider === provider && e.model.id === modelId);
    if (!entry) fail(`settings.${mode}`, '无法唯一选择模型，请配置有效的 defaultProvider/defaultModel 或模式模型。');
    const available = supportedLevels(entry.model);
    const requested = selection.thinkingLevel ?? settings.defaultThinkingLevel;
    const level = requested ?? (entry.model.reasoning && available.includes('medium') ? 'medium' : available[0]);
    if (!THINKING_LEVELS.includes(level as ThinkingLevel) || !available.includes(level as ThinkingLevel)) fail(`settings.${mode}.thinkingLevel`, '所选模型不支持该思考级别；请检查 reasoning 和 thinkingLevelMap。');
    return { ...entry, thinkingLevel: level as ThinkingLevel };
  }
  return { developer: select('developer'), analyst: select('analyst') };
}
export async function loadModelProfiles(root: string, settings: ObjectValue, env: NodeJS.ProcessEnv): Promise<ModelProfiles> {
  const explicit = env.DAAS_MODELS_FILE;
  if (explicit !== undefined && !explicit.trim()) fail('DAAS_MODELS_FILE', '不能是空路径。');
  const file = resolve(root, explicit ?? '.daas/models.json');
  const doc = await readConfigObject(file, 'models.json', explicit === undefined);
  if (doc) return parseModelProfiles(doc, settings, env);
  // Migration path only when the DEFAULT file is absent. A present/broken/explicit file never falls back.
  if (!env.DAAS_MODEL_BASE_URL || !env.DAAS_MODEL_KEY) fail('models.json', '请配置独立模型文件；旧环境变量方式需要 DAAS_MODEL_BASE_URL 和 DAAS_MODEL_KEY。');
  let legacyHeaders: unknown;
  try { legacyHeaders = JSON.parse(env.DAAS_MODEL_HEADERS_JSON ?? '{}'); } catch { fail('DAAS_MODEL_HEADERS_JSON', '不是有效 JSON。'); }
  const modelId = env.DAAS_MODEL_ID ?? 'deepseek-flash';
  return parseModelProfiles({ providers: { deepseek: {
    api: 'openai-completions', baseUrl: '$DAAS_MODEL_BASE_URL', apiKey: '$DAAS_MODEL_KEY', headers: legacyHeaders,
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: 'max_tokens', ...record(settings.modelCompat ?? {}, 'modelCompat') },
    models: [{ id: modelId, reasoning: false, contextWindow: settings.modelContext ?? 65536, maxTokens: settings.modelMaxTokens ?? 4096 }],
  } } }, { ...settings, defaultProvider: 'deepseek', defaultModel: modelId }, env);
}
