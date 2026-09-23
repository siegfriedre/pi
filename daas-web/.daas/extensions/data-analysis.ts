import { AppError, brand, escapeHtml, validateJson } from '../../server/safety.ts';
import type { Json, RegistryAPI, Schema } from '../../server/types.ts';
const text: Schema = { type: 'string', maxLength: 300 };
const schema = (properties: Record<string, Schema>, required: string[]): Schema => ({ type: 'object', properties, required, additionalProperties: false });
const months = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];
const sales = [126, 118, 145, 159, 152, 181];
export default function register(api: RegistryAPI): void {
  api.tool({
    id: 'daas.api.search', version: '1', title: '查找业务 API', domain: 'analysis', modes: ['analyst', 'developer'], effect: 'read',
    description: '搜索当前用户获准查看的已发布 API 目录。', schema: schema({ query: text }, ['query']),
    async execute(args, ctx) {
      return ctx.demo ? { demo: true, items: [{ id: 'demo.sales.monthly', name: '月度销售额', description: '演示用六个月区域销售数据，不是真实业务数据。', effect: 'read' }] }
        : ctx.platform('api.search', args, ctx.signal);
    },
  });
  api.tool({
    id: 'daas.api.describe', version: '1', title: '读取 API 定义', domain: 'analysis', modes: ['analyst', 'developer'], effect: 'read',
    description: '读取 API 参数、返回字段与业务口径。调用前必须理解定义。', schema: schema({ apiId: text }, ['apiId']),
    async execute(args, ctx) {
      return ctx.demo ? { demo: true, id: 'demo.sales.monthly', parameters: { type: 'object', properties: {}, additionalProperties: false }, fields: ['month', 'region', 'sales'], unit: '万元', period: '2026 年 1—6 月' }
        : ctx.platform('api.describe', args, ctx.signal);
    },
  });
  api.tool({
    id: 'daas.api.query', version: '1', title: '查询业务数据', domain: 'analysis', modes: ['analyst'], effect: 'read',
    description: '调用管理员批准的只读 API。参数按 API 定义填写，结果保存为本会话的 resultId。返回有限样本而不是全部数据。',
    schema: schema({ apiId: text, parameters: { type: 'object', properties: {}, additionalProperties: true } }, ['apiId', 'parameters']),
    async execute(args, ctx) {
      let rows: Record<string, Json>[]; let complete: boolean; let source: string;
      if (ctx.demo) {
        if (args.apiId !== 'demo.sales.monthly' || Object.keys(args.parameters as object).length) throw new AppError('INVALID_ARGUMENTS', '演示 API 只接受已登记 ID 和空参数。');
        rows = months.flatMap((month, i) => [{ month, region: '华东', sales: sales[i] }, { month, region: '华南', sales: Math.round(sales[i] * 0.72) }]);
        complete = true; source = '演示销售数据 · 2026 年 1—6 月 · 单位：万元';
      } else {
        const response = await ctx.platform('api.invoke', args, ctx.signal) as { rows?: unknown; complete?: unknown; source?: unknown };
        if (!response || !Array.isArray(response.rows) || typeof response.complete !== 'boolean') throw new AppError('PLATFORM_FORMAT', '数据适配器需要返回 { rows, complete, source }。', 502);
        validateJson(response.rows);
        if (response.rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new AppError('PLATFORM_FORMAT', '结果行必须是字段对象。', 502);
        rows = response.rows as Record<string, Json>[]; complete = response.complete; source = typeof response.source === 'string' ? response.source : `API ${args.apiId}`;
      }
      const r = ctx.addResult({ title: 'API 查询结果', rows, complete, source, demo: ctx.demo });
      return { resultId: r.id, rowCount: rows.length, complete, source, demo: ctx.demo, sample: rows.slice(0, 5) };
    },
  });
  api.tool({
    id: 'daas.result.aggregate', version: '1', title: '汇总分析数据', domain: 'analysis', modes: ['analyst'], effect: 'read',
    description: '对本会话结果按一个字段分组，计算指定数值字段的 sum 或 average。固定程序实现，不接收脚本或表达式。',
    schema: schema({ resultId: text, groupBy: text, valueField: text, operation: { ...text, enum: ['sum', 'average'] } }, ['resultId', 'groupBy', 'valueField', 'operation']),
    async execute(args, ctx) {
      const source = ctx.result(String(args.resultId)); const groups = new Map<string, { sum: number; count: number }>();
      for (const row of source.rows) {
        const group = row[String(args.groupBy)]; const number = row[String(args.valueField)];
        if (group === undefined || !['string', 'number'].includes(typeof group) || typeof number !== 'number' || !Number.isFinite(number)) throw new AppError('INVALID_FIELD', '分组字段必须为文本或数字，数值字段必须是有限数值；不会静默丢弃无效行。');
        const key = String(group); const item = groups.get(key) ?? { sum: 0, count: 0 }; item.sum += number; item.count++; groups.set(key, item);
      }
      const rows = [...groups].map(([group, value]) => ({ group, value: args.operation === 'average' ? value.sum / value.count : value.sum }));
      if (rows.some(r => !Number.isFinite(r.value))) throw new AppError('NUMERIC_OVERFLOW', '汇总数值超出支持范围。');
      const r = ctx.addResult({ title: '分组汇总结果', rows, complete: source.complete, source: `${source.source} · ${args.operation}(${args.valueField}) by ${args.groupBy}`, demo: source.demo });
      return { resultId: r.id, rowCount: rows.length, complete: r.complete, demo: r.demo, sample: rows.slice(0, 8) };
    },
  });
  api.tool({
    id: 'daas.report.create', version: '1', title: '生成图表与 HTML 报告', domain: 'analysis', modes: ['analyst'], effect: 'artifact',
    description: '把本会话结果生成表格、柱状图或折线图和静态 HTML 报告。使用固定模板，不执行生成的 JavaScript。图表仅支持最多 24 条数值记录。',
    schema: schema({ resultId: text, title: text, chart: { ...text, enum: ['bar', 'line', 'table'] }, xField: text, yField: text }, ['resultId', 'title', 'chart']),
    async execute(args, ctx) {
      args.title = brand(String(args.title));
      const r = ctx.result(String(args.resultId)); const fields = Object.keys(r.rows[0] ?? {}).slice(0, 12);
      const x = String(args.xField ?? fields[0] ?? ''); const y = String(args.yField ?? fields[1] ?? '');
      const rows = r.rows.slice(0, 24); let graph = '';
      if (args.chart !== 'table' && rows.length) {
        if (rows.some(row => typeof row[y] !== 'number' || !Number.isFinite(row[y] as number) || row[x] === undefined)) throw new AppError('INVALID_FIELD', '请选择有效的横轴字段和数值纵轴字段。');
        const values = rows.map(row => row[y] as number); const lo = Math.min(0, ...values); const hi = Math.max(0, ...values); const range = hi - lo || 1;
        const width = 720; const step = 640 / rows.length; const base = 240 - (0 - lo) / range * 190;
        const points = values.map((v, i) => ({ x: 48 + i * step + step / 2, y: 240 - (v - lo) / range * 190 }));
        const shapes = args.chart === 'line' ? `<polyline fill="none" stroke="#446f5b" stroke-width="3" points="${points.map(p => `${p.x},${p.y}`).join(' ')}"/>` : points.map(p => `<rect x="${p.x - step * .28}" y="${Math.min(base, p.y)}" width="${step * .56}" height="${Math.max(1, Math.abs(p.y - base))}" rx="3" fill="#446f5b"/>`).join('');
        graph = `<svg viewBox="0 0 ${width} 290" role="img" aria-label="${escapeHtml(args.title)}"><line x1="40" y1="${base}" x2="700" y2="${base}" stroke="#d9dfdc"/>${shapes}${points.map((p, i) => `<text x="${p.x}" y="${Math.max(22, p.y - 8)}" text-anchor="middle" font-size="12">${escapeHtml(values[i].toFixed(2))}</text><text x="${p.x}" y="265" text-anchor="middle" font-size="11">${escapeHtml(String(rows[i][x]).slice(0, 14))}</text>`).join('')}</svg>`;
      }
      const table = `<table><thead><tr>${fields.map(f => `<th>${escapeHtml(f)}</th>`).join('')}</tr></thead><tbody>${r.rows.slice(0, 200).map(row => `<tr>${fields.map(f => `<td>${escapeHtml(typeof row[f] === 'object' ? JSON.stringify(row[f]) : row[f] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(args.title)} · DaaS</title><style>body{font:14px/1.7 system-ui,sans-serif;color:#26332c;max-width:880px;margin:40px auto;padding:0 24px}h1{font-size:28px}small{color:#6e7973}svg{width:100%;margin:28px 0}table{width:100%;border-collapse:collapse;display:block;overflow:auto}th,td{text-align:left;padding:10px 16px;border-bottom:1px solid #e7eae8}th{background:#f3f6f4}.notice{padding:12px 16px;background:#f5f6f3;border-radius:8px}</style><header><small>DaaS Agent · 数据报告</small><h1>${escapeHtml(args.title)}</h1><p>${escapeHtml(r.source)}</p></header><p class="notice">${r.demo ? '演示数据，不代表真实业务。' : ''}${r.complete ? '查询结果标记为完整。' : '查询结果不完整，结论仅适用于已返回数据。'} 共 ${r.rows.length} 行；图表最多展示前 24 行，表格最多展示前 200 行。</p>${graph}${table}<footer><p><small>生成时间：${escapeHtml(new Date().toISOString())} · 来源结果：${escapeHtml(r.id)}</small></p></footer></html>`;
      const a = ctx.addArtifact({ title: String(args.title), kind: 'report', html });
      return { artifactId: a.id, title: a.title, resultId: r.id, demo: r.demo, message: '报告已生成，可在工作台预览或下载。' };
    },
  });
}
