import type { RegistryAPI, Schema } from '../../server/types.ts';
const text: Schema = { type: 'string', maxLength: 500 };
const schema = (properties: Record<string, Schema>, required: string[]): Schema => ({ type: 'object', properties, required, additionalProperties: false });
export default function register(api: RegistryAPI): void {
  api.tool({
    id: 'daas.datasource.list', version: '1', title: '查看授权数据源', domain: 'development', modes: ['developer'], effect: 'read',
    description: '查看当前业务空间的数据源连接元数据，不返回密码。', schema: schema({}, []),
    async execute(args, ctx) {
      return ctx.demo ? { demo: true, items: [{ id: 'demo-orders', name: '演示订单数据源', type: 'SQL' }] }
        : ctx.platform('datasource.list', args, ctx.signal);
    },
  });
  api.tool({
    id: 'daas.datasource.schema', version: '1', title: '读取表结构', domain: 'development', modes: ['developer'], effect: 'read',
    description: '按数据源 ID 读取授权表结构，不连接任意地址。', schema: schema({ datasourceId: text }, ['datasourceId']),
    async execute(args, ctx) {
      return ctx.demo ? { demo: true, tables: [{ name: 'orders', columns: [{ name: 'order_month', type: 'varchar' }, { name: 'region', type: 'varchar' }, { name: 'amount', type: 'decimal' }] }] }
        : ctx.platform('datasource.schema', args, ctx.signal);
    },
  });
  api.tool({
    id: 'daas.sql.validate', version: '1', title: '校验查询草稿', domain: 'development', modes: ['developer'], effect: 'read',
    description: '交给平台受控校验接口检查 SQL。演示环境不执行 SQL，也不声称数据库语法或权限校验通过。',
    schema: schema({ datasourceId: text, sql: { type: 'string', maxLength: 10000 } }, ['datasourceId', 'sql']),
    async execute(args, ctx) {
      return ctx.demo ? { demo: true, validated: false, message: '已接收演示查询草稿；尚未连接真实数据库，未执行语法、性能或权限校验。' }
        : ctx.platform('sql.validate', args, ctx.signal);
    },
  });
  api.tool({
    id: 'daas.api.save_draft', version: '1', title: '保存 API 草稿', domain: 'development', modes: ['developer'], effect: 'write',
    description: '保存到平台草稿区，不发布。必须展示确切参数并由用户在网页确认。不可传用户身份或服务器文件路径。',
    schema: schema({ name: { type: 'string', maxLength: 100 }, datasourceId: text, sql: { type: 'string', maxLength: 10000 }, description: { type: 'string', maxLength: 2000 } }, ['name', 'datasourceId', 'sql']),
    async execute(args, ctx) {
      return ctx.demo ? { demo: true, savedToPlatform: false, message: '演示确认已完成，真实 DaaS 平台未发生任何写入。', name: args.name }
        : ctx.platform('api.save_draft', args, ctx.signal, ctx.idempotencyKey);
    },
  });
}
