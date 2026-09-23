import { AppError, brand, id, identityReply, now, publicError } from './safety.ts';
import { SYSTEM_TOOLS, ToolRun } from './registry.ts';
import { runModel } from './adapters/model.ts';
import type { Registry } from './registry.ts';
import type { Store } from './store.ts';
import type { Args, Config, Principal, RuntimeInput, Session } from './types.ts';

async function runDemo(input: RuntimeInput): Promise<void> {
  const call = input.call;
  if (/执行.*命令|安装.*插件|\/etc\/|读取.*密码|删除|发布.*API/i.test(input.prompt)) { await input.reply('DaaS 不提供任意命令、服务器文件访问、插件安装、删除或发布能力。演示模式不会操作真实平台。'); return; }
  if (input.session.mode === 'developer') {
    await call('sys_discover', { query: 'API 开发' }); await call('sys_load', { ids: ['skill.api-development'] });
    await call('sys_invoke', { toolId: 'daas.datasource.list', arguments: {} });
    await call('sys_invoke', { toolId: 'daas.datasource.schema', arguments: { datasourceId: 'demo-orders' } });
    const sql = 'SELECT order_month, SUM(amount) AS sales\nFROM orders\nGROUP BY order_month\nORDER BY order_month';
    await call('sys_invoke', { toolId: 'daas.sql.validate', arguments: { datasourceId: 'demo-orders', sql } });
    await call('sys_invoke', { toolId: 'daas.api.save_draft', arguments: { name: '月度销售额', datasourceId: 'demo-orders', sql, description: '固定演示流程：按月汇总销售额' } });
    await input.reply(`这是固定的 API 开发演示流程，不是模型对需求的真实推理。\n\n查询草稿：\n\n${sql}\n\n尚未连接真实数据库，未完成 SQL 验证，也没有保存到 DaaS 平台。工作台中已生成确认卡，可以体验确认交互。`);
    return;
  }
  await call('sys_discover', { query: '销售 数据 分析' }); await call('sys_load', { ids: ['skill.sales-analysis'] });
  const catalog = await call('sys_invoke', { toolId: 'daas.api.search', arguments: { query: '销售' } });
  if (/查找|哪些.*接口|可用.*(?:API|接口)/i.test(input.prompt) && !/分析|报告|图表/.test(input.prompt)) {
    await input.reply(`当前演示目录中有一个只读 API：月度销售额（demo.sales.monthly）。\n它返回虚构的 2026 年 1—6 月区域销售数据。此处未连接真实模型或业务平台。`); return;
  }
  void catalog;
  await call('sys_invoke', { toolId: 'daas.api.describe', arguments: { apiId: 'demo.sales.monthly' } });
  const queried = await call('sys_invoke', { toolId: 'daas.api.query', arguments: { apiId: 'demo.sales.monthly', parameters: {} } }) as { resultId: string };
  const result = await call('sys_invoke', { toolId: 'daas.result.aggregate', arguments: { resultId: queried.resultId, groupBy: 'month', valueField: 'sales', operation: 'sum' } }) as { resultId: string };
  await call('sys_invoke', { toolId: 'daas.report.create', arguments: { resultId: result.resultId, title: '月度销售趋势 · 演示报告', chart: 'bar', xField: 'group', yField: 'value' } });
  const rows = input.session.results.find(r => r.id === result.resultId)!.rows;
  const first = Number(rows[0].value); const last = Number(rows.at(-1)!.value);
  await input.reply(`已完成固定的演示流程：发现能力 → 加载分析技能 → 查询示例 API → 按月汇总 → 生成图表和 HTML 报告。\n\n示例数据中，1 月销售额为 ${first} 万元，6 月为 ${last} 万元，变化为 ${((last / first - 1) * 100).toFixed(1)}%。\n\n请切换到「工作台」查看表格和报告。以上全部为虚构演示数据，未调用真实模型或业务系统。`);
}
export class Runtime {
  registry: Registry; config: Config; store: Store;
  private active = new Map<string, AbortController>();
  private owners = new Map<string, string>();
  constructor(registry: Registry, config: Config, store: Store) { this.registry = registry; this.config = config; this.store = store; }
  async start(s: Session, p: Principal, prompt: string): Promise<void> {
    if (!prompt.trim() || prompt.length > 12000) throw new AppError('INVALID_PROMPT', '请输入 1—12000 个字符的消息。');
    if (s.messages.length >= 120) throw new AppError('SESSION_LIMIT', '当前会话已达到消息上限，请新建对话。');
    const owner = `${p.tenant}:${p.sub}`;
    if (this.active.has(s.id) || this.owners.has(owner)) throw new AppError('BUSY', '当前用户已有任务运行，请等待或停止后再继续。', 409);
    if (this.active.size >= 8) throw new AppError('BUSY', '当前任务较多，请稍后重试。', 429);
    const controller = new AbortController(); this.active.set(s.id, controller); this.owners.set(owner, s.id);
    s.task = { status: 'running', id: id() }; s.messages.push({ id: id(), role: 'user', text: prompt, time: now() });
    if (s.title === '新对话') s.title = brand(prompt.trim().slice(0, 32));
    try { await this.store.save(s); }
    catch (e) { this.active.delete(s.id); this.owners.delete(owner); throw e; }
    void this.perform(s, p, prompt, controller).catch(e => console.error(JSON.stringify({ event: 'task_storage_error', sessionId: s.id, code: publicError(e).code })));
  }
  private async perform(s: Session, p: Principal, prompt: string, controller: AbortController): Promise<void> {
    const timer = setTimeout(() => controller.abort(), this.config.taskTimeoutMs);
    const reply = async (text: string) => { s.messages.push({ id: id(), role: 'assistant', text: brand(text).slice(0, 30000), time: now() }); await this.store.save(s); };
    try {
      const identity = identityReply(prompt);
      if (identity) await reply(identity);
      else {
        const tools = new ToolRun(this.registry, this.config, s, p, this.store, controller.signal);
        const input: RuntimeInput = { session: s, prompt, signal: controller.signal, definitions: SYSTEM_TOOLS, call: (name, args) => tools.call(name, args), reply };
        if (this.config.demo) await runDemo(input); else await runModel(this.config, input);
      }
      s.task.status = controller.signal.aborted ? 'cancelled' : 'done';
    } catch (error) {
      s.task.status = controller.signal.aborted ? 'cancelled' : 'error';
      await reply(controller.signal.aborted ? '已停止后续处理。已经提交到平台的操作不会自动回滚；请核对确认记录。' : publicError(error).message);
      console.error(JSON.stringify({ event: 'task_error', sessionId: s.id, code: controller.signal.aborted ? 'CANCELLED' : publicError(error).code }));
    } finally {
      clearTimeout(timer); this.active.delete(s.id); this.owners.delete(`${p.tenant}:${p.sub}`); await this.store.save(s);
    }
  }
  stop(sid: string): void { this.active.get(sid)?.abort(); }
  async approval(s: Session, p: Principal, approvalId: string, accept: boolean): Promise<unknown> {
    const owner = `${p.tenant}:${p.sub}`;
    if (this.active.has(s.id) || this.owners.has(owner)) throw new AppError('BUSY', '任务仍在运行，请稍后确认。', 409);
    const controller = new AbortController(); this.active.set(s.id, controller); this.owners.set(owner, s.id);
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const tools = new ToolRun(this.registry, this.config, s, p, this.store, controller.signal);
      const output = await tools.approve(approvalId, accept);
      s.messages.push({ id: id(), role: 'assistant', text: accept ? (this.config.demo ? '演示确认已完成，真实平台没有发生写入。' : '平台已返回操作结果，请在确认卡中核对。') : '已取消这次写入请求。', time: now() });
      await this.store.save(s); return output;
    } finally { clearTimeout(timer); this.active.delete(s.id); this.owners.delete(owner); }
  }
  shutdown(): void { for (const controller of this.active.values()) controller.abort(); }
}
