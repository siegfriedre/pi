import type { RegistryAPI } from '../server/types.ts';
import registerDevelopment from './extensions/api-development.ts';
import registerAnalysis from './extensions/data-analysis.ts';

// Explicit administrator entry list. Files dropped into a directory are NOT automatically executable.
export default function register(api: RegistryAPI): void {
  registerDevelopment(api);
  registerAnalysis(api);
  api.resource({
    id: 'skill.api-development', title: '数据 API 开发', domain: 'development', kind: 'skill', modes: ['developer'],
    description: '从数据源、表结构、SQL 校验到 API 草稿。创建、修改、保存前先展示变更。',
    file: 'skills/api-development/SKILL.md',
    dependencies: ['daas.datasource.list', 'daas.datasource.schema', 'daas.sql.validate', 'daas.api.save_draft'],
  });
  api.resource({
    id: 'doc.api-development.rules', title: 'API 开发规范', domain: 'development', kind: 'document', modes: ['developer'],
    description: '参数化查询、权限范围、草稿与发布的边界。', file: 'skills/api-development/references/rules.md',
  });
  api.resource({
    id: 'skill.sales-analysis', title: '销售数据分析', domain: 'analysis', kind: 'skill', modes: ['analyst'],
    description: '查找销售数据 API，按月份或区域汇总，生成表格、趋势图和 HTML 报告。',
    file: 'skills/sales-analysis/SKILL.md', dependencies: ['daas.api.search', 'daas.api.describe', 'daas.api.query', 'daas.result.aggregate', 'daas.report.create'],
  });
  api.resource({
    id: 'doc.sales.metrics', title: '销售指标口径', domain: 'analysis', kind: 'document', modes: ['analyst'],
    description: '分析前确认时间范围、币种、退款口径与数据完整性。', file: 'skills/sales-analysis/references/metrics.md',
  });
}
