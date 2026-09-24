# DaaS Agent Web

本分支专用于 DaaS 网页业务 Agent，不再作为终端助手的完整 monorepo。

## 两种运行方式

**推荐部署发布目录**：在有固定依赖的构建机器上执行 `npm run build`。构建完成后只把 `daas-web/dist/` 的内容放入容器。运行容器需要 Node.js >=22.19.0、私有配置/环境变量和一个可写数据目录；不需要 `packages/`、`node_modules`、tsx、esbuild、tsgo、Python、Redis 或终端工具。构建会执行隔离检查，失败不会替换原发布目录。

**源码开发**：仓库保留 `daas-web/`、`packages/agent`、`packages/ai`、`packages/telemetry`，根目录只安装应用需要的依赖。运行时用 `tsx` 的路径映射直接引用三份源码，不逐包构建。

```sh
# 在仓库根目录，使用公司已有的 npm 缓存/内网镜像，不升级版本。
npm ci --ignore-scripts --offline
npm run check
npm test
npm run check:upstream
npm run build
```

`--offline` 需要相应 tarball 已经在 npm 缓存中；缓存不完整时，应先从公司批准的镜像准备同版本包，不要改版本碰碰运气。不要使用 `--omit=optional`，构建环境的 esbuild 需要匹配平台的二进制。`npm ci` 会重建 node_modules，先保管手动放进去、未登记的依赖。

初次只看网页和演示流程，不需要 npm 安装：

```sh
npm run demo
```

演示模式只在本机启动，使用固定流程与虚构数据，不调用模型或真实平台。源码正式模式先按 `daas-web/README.md` 配置，再执行 `npm start`。

## packages 为什么只保留三个

| 目录 | 保留原因 |
| --- | --- |
| `packages/agent` | 当前适配器使用的 Agent 循环、工具调用和消息事件 |
| `packages/ai` | 模型协议、流响应处理和参数校验 |
| `packages/telemetry` | 模型层引用的观测接口和公共类型；不能仅因未启用外部监控就直接删掉 |

三份目录是未修改的上游源码快照，**不再声明为 npm workspaces**。其 package.json 中保留的完整上游依赖/导出，仅描述完整上游包，不代表本应用必须安装那些依赖。本应用只支持 `daas-web/server/adapters/framework-entry.ts` 引入的入口，不保证每个上游公开入口都可独立使用；例如完整 Harness 仍可能需要已移除的 chord。恢复其他入口时必须同时检查依赖，不能随意改回包根导入。

已从这个专用工作树移除的包为：
`chord`、`client`、`coding-agent`、`evals`、`protocol`、`server`、`session-backends`、`tui`。

旧终端配置、启动脚本、远程桥接和不适用的工作流/测试入口也移除。Git 历史和 `company-deepseek` 不受影响；需要恢复时按 `daas-web/UPGRADE.md` 操作。

## 独立模型与提示词配置

模型定义位于 `daas-web/.daas/models.json`，默认模型与思考级别在 `.daas/settings.json`；格式沿用 providers/models，支持多个兼容网关和按开发/分析模式选择。密钥通过 `$ENV`/`${ENV}` 引用环境变量，不执行配置中的命令。`DAAS_MODELS_FILE` 可以指定只读挂载路径。模型、设置和提示词修改后重启服务，详情见 `daas-web/MODELS.md`。

系统提示词位于 `.daas/prompts/`，按基础、公共业务、当前模式组合；不恢复终端提示词或旧 `.config`。浏览器与模型不具有修改这些文件或切换任意网关的权限。

## 固定依赖

源码/构建机器的直接运行依赖：`openai 6.40.0`、`partial-json 0.1.7`、`typebox 1.3.27`。

开发与构建依赖：`tsx 4.22.1`、`esbuild 0.28.1`、`typescript 5.9.3`、`@types/node 22.19.19`。没有新增版本；锁文件只保留它们的依赖闭包，沿用已有 tarball URL 和 integrity。旧固定版本仍保留在 overrides 作为后续恢复时的约束，但不会触发安装无用依赖。

锁文件含所有 esbuild 平台的可选记录，不表示 Linux 会安装所有平台二进制。`undici-types` 是 Node 类型声明依赖，不是之前的 `undici` 运行包。

## 部署

构建成功后，`dist/` 包含 DaaS 服务、前端、`.daas` 能力资源、内部框架 bundle、许可证和构建信息。源配置文件和运行数据不会进入发布目录。

```sh
# 上传 dist 的内容到 /opt/daas，并挂载私有配置和 /var/lib/daas。
cd /opt/daas
DAAS_DATA_DIR=/var/lib/daas node server/main.ts
```

正式模式仍需要模型网关地址/密钥、DaaS 接口映射、受信任登录网关签名。打包不会自动解决公司的网络、证书、SSO 或业务接口协议。使用只读、非 root 容器；必要出站网络限于模型和业务 API。

`npm run build` 会把发布目录复制到仓库外的临时目录，使用真实打包核心和本地模拟模型 HTTP 服务验证工具调用；不调用公司的模型或 API。也可单独执行 `npm run check:release`。这个检查验证发布依赖闭包，不等于公司业务联调。

详细功能和限制见 `daas-web/README.md`；升级、恢复包和维护边界见 `daas-web/UPGRADE.md`。
