import { resolve } from 'node:path';
import { AppError, authorize, brand, canonical, digest, id, now, publicError, readApproved, validate } from './safety.ts';
import { platformClient } from './adapters/platform.ts';
import type { Store } from './store.ts';
import type { Args, Capability, Config, Principal, RegistryAPI, Resource, Schema, Session, SystemDefinition, ToolContext } from './types.ts';

const resourceId = /^[a-z][a-z0-9._:-]{2,120}$/;
const string = (maxLength = 300): Schema => ({ type: 'string', maxLength });
const object = (properties: Record<string, Schema>, required: string[]): Schema => ({ type: 'object', properties, required, additionalProperties: false });
export const SYSTEM_TOOLS: SystemDefinition[] = [
  { name: 'sys_discover', description: '按任务搜索当前用户可用的业务能力、技能或文档，仅返回摘要。query 为空可查看目录；可指定领域或类型。', parameters: object({ query: string(500), domain: string(80), kind: { ...string(), enum: ['tool', 'skill', 'document'] } }, ['query']) },
  { name: 'sys_load', description: '按注册 ID 加载工具完整参数定义或技能正文。技能的必要工具依赖一起加载。调用前必须加载；此操作不授予权限也不确认写入。', parameters: object({ ids: { type: 'array', items: string(), maxItems: 6 } }, ['ids']) },
  { name: 'sys_read_resource', description: '按资源 ID 分页读取批准文档或技能；不能读取服务器路径、源码、凭据或其他会话。', parameters: object({ id: string(), offset: { type: 'integer', minimum: 0, maximum: 64000 }, limit: { type: 'integer', minimum: 1, maximum: 12000 } }, ['id']) },
  { name: 'sys_invoke', description: '按已加载工具 ID 和其定义中的结构化参数调用管理员提供的能力。不能传代码、文件路径、命令或运行环境。写入只生成确认卡，用户需在网页点击确认。', parameters: object({ toolId: string(), arguments: { type: 'object', properties: {}, additionalProperties: true } }, ['toolId', 'arguments']) },
];
function assertSchema(s: Schema): void {
  const allowed = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'maxLength', 'minimum', 'maximum', 'maxItems']);
  if (!s || !['object', 'array', 'string', 'number', 'integer', 'boolean'].includes(s.type) || Object.keys(s).some(k => !allowed.has(k))) throw new Error('Unsupported schema; use the documented DaaS schema subset');
  if (s.type === 'array' && !s.items) throw new Error('Array schema requires items');
  if (s.required?.some(k => !Object.hasOwn(s.properties ?? {}, k))) throw new Error('Unknown required field');
  Object.values(s.properties ?? {}).forEach(assertSchema); if (s.items) assertSchema(s.items);
}
export class Registry implements RegistryAPI {
  tools = new Map<string, Capability>(); resources = new Map<string, Resource>();
  private sealed = false;
  private check(idValue: string): void {
    if (this.sealed || !resourceId.test(idValue) || idValue.startsWith('sys') || this.tools.has(idValue) || this.resources.has(idValue)) throw new Error('Invalid or duplicate DaaS registration');
  }
  tool(t: Capability): void { this.check(t.id); assertSchema(t.schema); this.tools.set(t.id, Object.freeze(t)); }
  resource(r: Resource): void { this.check(r.id); this.resources.set(r.id, Object.freeze(r)); }
  seal(): void {
    for (const r of this.resources.values()) for (const dep of r.dependencies ?? []) if (!this.tools.has(dep)) throw new Error('Skill references an unregistered capability');
    this.sealed = true;
  }
}
export class ToolRun {
  registry: Registry; config: Config; session: Session; principal: Principal; store: Store; signal: AbortSignal;
  private loaded = new Map<string, string>(); private calls = 0;
  constructor(registry: Registry, config: Config, session: Session, principal: Principal, store: Store, signal: AbortSignal) {
    this.registry = registry; this.config = config; this.session = session; this.principal = principal; this.store = store; this.signal = signal;
  }
  private guard(): void {
    this.signal.throwIfAborted();
    if (this.session.owner !== this.principal.sub || this.session.tenant !== this.principal.tenant) throw new AppError('NOT_FOUND', '会话不存在。', 404);
    authorize(this.principal, this.session.space, this.session.mode);
  }
  private visible(item: Capability | Resource): boolean { return item.modes.includes(this.session.mode); }
  private getTool(toolId: string): Capability {
    this.guard(); const tool = this.registry.tools.get(toolId);
    if (!tool || !this.visible(tool)) throw new AppError('NOT_FOUND', '能力不存在或当前模式不可用。', 404);
    return tool;
  }
  private getResource(rid: string): Resource {
    this.guard(); const r = this.registry.resources.get(rid);
    if (!r || !this.visible(r)) throw new AppError('NOT_FOUND', '资源不存在或无权读取。', 404);
    return r;
  }
  async call(name: string, args: Args): Promise<unknown> {
    this.guard(); if (++this.calls > 60) throw new AppError('TOOL_LIMIT', '本轮调用次数已达上限，请缩小任务范围。');
    const definition = SYSTEM_TOOLS.find(t => t.name === name);
    if (!definition) throw new AppError('NOT_FOUND', '系统工具不存在。', 404);
    validate(definition.parameters, args);
    const label = name === 'sys_invoke' ? this.getTool(String(args.toolId)).title : ({ sys_discover: '发现相关能力', sys_load: '加载任务能力', sys_read_resource: '读取参考资料' } as Record<string, string>)[name];
    const trace = { id: id(), label: brand(label), state: 'running' as 'running' | 'done' | 'error', time: now() };
    this.session.traces.push(trace); if (this.session.traces.length > 150) this.session.traces.shift(); await this.store.save(this.session);
    try {
      let output: unknown;
      if (name === 'sys_discover') output = this.discover(args);
      else if (name === 'sys_load') output = await this.load(args.ids as string[]);
      else if (name === 'sys_read_resource') output = await this.readResource(args);
      else output = await this.invoke(String(args.toolId), args.arguments as Args);
      trace.state = 'done'; await this.store.save(this.session); return output;
    } catch (e) { trace.state = 'error'; await this.store.save(this.session); throw e; }
  }
  private discover(args: Args) {
    const query = String(args.query).toLowerCase();
    const terms = [...new Set([query, ...query.split(/[\s,，。]+/), ...Array.from({ length: Math.max(0, query.length - 1) }, (_, i) => query.slice(i, i + 2))].filter(t => t.trim()))];
    const items: ((Capability & { kind: 'tool' }) | Resource)[] = [...this.registry.tools.values()].map(t => ({ ...t, kind: 'tool' as const }));
    items.push(...this.registry.resources.values());
    return items.filter(t => this.visible(t) && (!args.domain || t.domain === args.domain) && (!args.kind || t.kind === args.kind))
      .map(t => ({ id: t.id, title: brand(t.title), kind: t.kind, domain: t.domain, description: brand(t.description), score: query ? terms.reduce((n, term) => n + (`${t.id} ${t.title} ${t.description}`.toLowerCase().includes(term) ? term.length : 0), 0) : 1 }))
      .filter(t => t.score > 0).sort((a, b) => b.score - a.score).slice(0, 8).map(({ score: _score, ...t }) => t);
  }
  private async load(ids: string[]) {
    const out: unknown[] = [];
    for (const rid of [...new Set(ids)]) {
      if (this.registry.tools.has(rid)) out.push(this.loadTool(rid));
      else {
        const r = this.getResource(rid);
        if (r.kind !== 'skill') { out.push({ id: r.id, title: r.title, readWith: 'sys_read_resource' }); continue; }
        const text = await readApproved(resolve(this.config.root, '.daas'), r.file);
        out.push({ id: r.id, kind: 'skill', content: brand(text), dependencies: (r.dependencies ?? []).filter(dep => this.visible(this.registry.tools.get(dep)!)).map(dep => this.loadTool(dep)) });
      }
    }
    if (JSON.stringify(out).length > 50000) throw new AppError('CONTEXT_LIMIT', '加载内容过多，请分批加载。');
    return out;
  }
  private loadTool(toolId: string) {
    const t = this.getTool(toolId);
    if (!this.loaded.has(toolId) && this.loaded.size >= 16) throw new AppError('CONTEXT_LIMIT', '本轮加载的能力过多，请开始一个更小的任务。');
    this.loaded.set(t.id, t.version);
    return { id: t.id, version: t.version, title: brand(t.title), description: brand(t.description), effect: t.effect, schema: t.schema, requiresConfirmation: t.effect === 'write' };
  }
  private async readResource(args: Args) {
    const r = this.getResource(String(args.id));
    const text = brand(await readApproved(resolve(this.config.root, '.daas'), r.file));
    const offset = Number(args.offset ?? 0); const limit = Number(args.limit ?? 8000);
    return { id: r.id, content: text.slice(offset, offset + limit), totalCharacters: text.length, nextOffset: offset + limit < text.length ? offset + limit : null };
  }
  private context(key?: string): ToolContext {
    const s = this.session;
    return {
      principal: this.principal, session: s, signal: this.signal, idempotencyKey: key, demo: this.config.demo,
      platform: platformClient(this.config, this.principal, s),
      result: rid => { this.guard(); const r = s.results.find(x => x.id === rid); if (!r) throw new AppError('NOT_FOUND', '查询结果不存在或不属于本会话。', 404); return r; },
      addResult: value => {
        this.guard(); if (s.results.length >= 30 || value.rows.length > 2000 || Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) throw new AppError('RESULT_LIMIT', '结果数量或大小超出本会话限额。', 413);
        const r = { ...value, id: id(), createdAt: now() }; s.results.push(r); return r;
      },
      addArtifact: value => {
        this.guard(); if (s.artifacts.length >= 20 || Buffer.byteLength(value.html) > 256000) throw new AppError('ARTIFACT_LIMIT', '产物数量或大小超出限额。', 413);
        const a = { ...value, id: id(), createdAt: now() }; s.artifacts.push(a); return a;
      },
    };
  }
  private async invoke(toolId: string, args: Args) {
    const t = this.getTool(toolId);
    if (this.loaded.get(t.id) !== t.version) throw new AppError('LOAD_REQUIRED', '请先使用 sys_load 加载当前工具定义。');
    validate(t.schema, args);
    if (t.effect !== 'write') return await this.execute(t, args);
    const key = digest(`${this.session.id}:${t.id}:${t.version}:${canonical(args)}`);
    const old = this.session.approvals.find(a => a.key === key && !['expired', 'denied'].includes(a.state));
    if (old) return { status: old.state, approvalId: old.id, message: '请查看工作台中的确认卡；不要重复提交。' };
    const approval = { id: id(), key, toolId: t.id, title: brand(t.title), version: t.version, args: structuredClone(args), expiresAt: Date.now() + 10 * 60 * 1000, state: 'pending' as const };
    this.session.approvals.push(approval); await this.store.save(this.session);
    return { status: 'requires_confirmation', approvalId: approval.id, message: '已生成操作确认卡，尚未执行。用户必须在网页确认，聊天中的确认文字无效。' };
  }
  private async execute(t: Capability, args: Args, key?: string) {
    this.guard(); const output = await t.execute(structuredClone(args), this.context(key));
    if (JSON.stringify(output ?? null).length > 32000) throw new AppError('OUTPUT_LIMIT', '工具返回过大，请使用结果引用和摘要。');
    return output ?? null;
  }
  async approve(approvalId: string, accept: boolean): Promise<unknown> {
    this.guard(); const a = this.session.approvals.find(x => x.id === approvalId);
    if (!a) throw new AppError('NOT_FOUND', '确认记录不存在。', 404);
    if (a.state === 'done') return a.output;
    if (a.state !== 'pending') throw new AppError('APPROVAL_STATE', '确认记录已处理或状态未知，请先核对平台。', 409);
    if (a.expiresAt < Date.now()) { a.state = 'expired'; await this.store.save(this.session); throw new AppError('APPROVAL_EXPIRED', '确认已过期，请重新生成。', 409); }
    if (!accept) { a.state = 'denied'; await this.store.save(this.session); return { status: 'denied' }; }
    const t = this.getTool(a.toolId);
    if (t.version !== a.version || t.effect !== 'write') throw new AppError('VERSION_CHANGED', '能力已更新，请重新生成确认。', 409);
    validate(t.schema, a.args);
    if (a.key !== digest(`${this.session.id}:${t.id}:${t.version}:${canonical(a.args)}`)) throw new AppError('APPROVAL_CHANGED', '确认内容已变化，请重新生成。', 409);
    a.state = 'executing'; await this.store.save(this.session); // Persist intent BEFORE a side effect; never blindly retry after restart.
    try { a.output = await this.execute(t, a.args, a.id); a.state = 'done'; await this.store.save(this.session); return a.output; }
    catch (e) { a.state = 'unknown'; a.output = { ...publicError(e), message: '操作未得到确定结果，请先核对平台记录，不要重复提交。' }; await this.store.save(this.session); throw e; }
  }
}
