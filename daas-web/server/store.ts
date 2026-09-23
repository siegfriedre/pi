import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError, authorize, id, now } from './safety.ts';
import type { Mode, Principal, Session } from './types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export class Store {
  root: string;
  private cache = new Map<string, Session>();
  private writes = new Map<string, Promise<void>>();
  constructor(root: string) { this.root = root; }
  async init(): Promise<void> { await mkdir(this.root, { recursive: true, mode: 0o700 }); }
  async create(p: Principal, space: string, mode: Mode): Promise<Session> {
    authorize(p, space, mode);
    const sessions = await this.list(p);
    if (sessions.length >= 100) throw new AppError('SESSION_LIMIT', '会话数量已达上限，请联系管理员归档。', 429);
    const session: Session = { id: id(), owner: p.sub, tenant: p.tenant, space, mode, title: '新对话', revision: 0,
      createdAt: now(), updatedAt: now(), messages: [], traces: [], results: [], artifacts: [], approvals: [], task: { status: 'idle' } };
    this.cache.set(session.id, session); await this.save(session); return session;
  }
  private async read(sid: string): Promise<Session> {
    if (!UUID.test(sid)) throw new AppError('NOT_FOUND', '会话不存在。', 404);
    const cached = this.cache.get(sid); if (cached) return cached;
    let s: Session;
    try { s = JSON.parse(await readFile(join(this.root, `${sid}.json`), 'utf8')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('NOT_FOUND', '会话不存在。', 404); throw e; }
    if (s.id !== sid) throw new AppError('NOT_FOUND', '会话不存在。', 404);
    if (s.task.status === 'running') { s.task.status = 'error'; for (const trace of s.traces) if (trace.state === 'running') trace.state = 'error'; }
    for (const a of s.approvals) if (a.state === 'executing') a.state = 'unknown';
    this.cache.set(sid, s); return s;
  }
  async get(sid: string, p: Principal): Promise<Session> {
    const s = await this.read(sid);
    if (s.owner !== p.sub || s.tenant !== p.tenant) throw new AppError('NOT_FOUND', '会话不存在。', 404);
    authorize(p, s.space, s.mode); return s;
  }
  async list(p: Principal): Promise<Session[]> {
    const files = (await readdir(this.root)).filter(f => UUID.test(f.slice(0, -5)) && f.endsWith('.json'));
    const result: Session[] = [];
    for (const f of files) {
      const s = await this.read(f.slice(0, -5));
      if (s.owner === p.sub && s.tenant === p.tenant && p.spaces.some(x => x.id === s.space && x.modes.includes(s.mode))) result.push(s);
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async save(s: Session): Promise<void> {
    s.revision++; s.updatedAt = now();
    const content = JSON.stringify(s);
    if (Buffer.byteLength(content) > 8 * 1024 * 1024) throw new AppError('SESSION_LIMIT', '会话数据过大，请新建对话。', 413);
    const previous = this.writes.get(s.id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const file = join(this.root, `${s.id}.json`); const tmp = `${file}.${id()}.tmp`;
      await writeFile(tmp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); await rename(tmp, file);
    });
    this.writes.set(s.id, next);
    try { await next; } finally { if (this.writes.get(s.id) === next) this.writes.delete(s.id); }
  }
}
export function sessionView(s: Session) {
  return {
    id: s.id, title: s.title, mode: s.mode, space: s.space, revision: s.revision,
    createdAt: s.createdAt, updatedAt: s.updatedAt, task: s.task, messages: s.messages, traces: s.traces,
    results: s.results.map(r => ({ ...r, rows: r.rows.slice(0, 30), totalRows: r.rows.length })),
    artifacts: s.artifacts.map(({ html: _html, ...a }) => a),
    approvals: s.approvals.map(({ key: _key, ...a }) => a),
  };
}
