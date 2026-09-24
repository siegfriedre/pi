# DaaS 升级与维护

## 当前结构

本分支已从完整终端工程收敛为网页专用工程。三份保留核心为 `packages/agent`、`packages/ai`、`packages/telemetry`，以原样源码快照保存；确切基线与目录 Git tree SHA 记录在根目录 `UPSTREAM.json`。

根 package.json **没有 workspaces**。第三方依赖由根目录的精简声明和锁文件管理，不执行上游目录各自的 install/build/test 脚本。源码启动与 esbuild 通过 `daas-web/tsconfig.json` 指向必要源文件。因此不需要先为每个上游包构建 dist，也不需要 tsgo。

这是“复用有限源码入口”，不是“保证完整上游包的所有导出都可运行”。保留目录内的旧 package.json、测试和文档是快照的一部分，可能引用被裁掉的完整框架功能。它们不参与本应用安装，也不被复制进运行容器。

## 日常改动

- 页面与交互：`daas-web/public/`。
- 业务工具：`daas-web/.daas/extensions/`，由 `.daas/index.ts` 显式注册。
- 模型目录和思考级别：`.daas/models.json`、`.daas/settings.json`（见 `MODELS.md`）。
- 产品基础和模式提示词：`.daas/prompts/`。
- Skills/参考资料：`.daas/skills/`，按批准的资源 ID 注册。
- 平台接口与登录协议：`server/adapters/platform.ts`、`server/safety.ts`。
- 核心 ABI 适配：`server/adapters/framework-entry.ts` 和 `model.ts`。

业务插件不直接导入上游 SDK。不要为了一项业务功能重新引入完整 CLI/TUI 或把 npm workspaces 改回通配符。

## 升级三份核心源码

先在升级分支操作。当前的 `company-deepseek` 是保留完整项目的来源。应固定一个你审核过的来源提交，而不是不加检查地使用远程分支最新头。

```sh
git fetch origin
git switch -c upgrade/daas-core
# 将下面来源替换为本次审核过的实际提交或引用：
git restore --source origin/company-deepseek -- packages/agent packages/ai packages/telemetry
```

同步审查模型适配代码、上游依赖变化、许可证以及路径别名；更新 `UPSTREAM.json` 的来源与三份 tree SHA。固定依赖不要自动升级，内网缺少新依赖时先评估兼容方案。

```sh
npm run check
npm test
npm run check:upstream
npm run build
```

应用检查不遍历完整上游包；真实 ABI 与 bundle 的依赖检查由后两步负责。构建过程遇到未保留的核心目录、未打包的第三方依赖或隔离运行失败会报错，而不是悄悄把整个 monorepo 又带回来。

## 恢复一个已删除的包

例如需要原来的终端包：

```sh
git fetch origin
git restore --source origin/company-deepseek -- packages/coding-agent
```

这只恢复工作树中的文件，不会改变远程 company 分支。**复制包不等于自动可用**：还需检查该包依赖的 tui/chord 等目录、第三方固定版本、构建脚本和入口。网页运行主路径仍应保持精简；另建工具分支通常比污染生产入口更清楚。

从 Git 历史恢复同版本文件也可以，已删除目录并未从历史中抹除。

## 发布与运行

`npm run build` 只更新 `daas-web/dist`，只使用已安装依赖，不在线安装。成功条件包括一个仓库外的隔离 smoke：真实 bundle、四个系统工具、一轮模型工具调用和下一轮回复。它使用本机假模型 HTTP 服务，不带公司凭据。

运行容器只接收 `dist/` 内容。新增纯 TypeScript 业务工具或修改前端后重新构建；没有必要上传整个 packages。生产代码与 Skills 只读，数据目录独立可写。许可证保留于非公开的 licenses 目录，不做全仓库包名替换。

已生成的写入确认绑定工具 ID、版本、参数和会话。工具语义或参数有变化时递增版本，不自动恢复状态未知的写入。

## 模型配置兼容检查

AI 包仍负责真正的请求序列化；DaaS 仅负责已批准模型文件的解析、选择和凭据注入。升级时核对 getSupportedThinkingLevels、thinkingLevelMap、compat、samplingParams 以及 Authorization:null 的抑制语义。保持 providers/models 的管理员配置接口稳定；新增协议必须同时接入对应 AI 适配实现和测试，不能仅允许任意 api 字符串。

release-smoke 现在从私有 models.json/settings.json 加载三个本地测试场景：思考开启及级别映射、关闭思考、仅自定义头且没有自动 Bearer。测试验证真实发出的请求体和请求头；未运行不能宣称完整模型接入已通过。

私有模型和设置文件不进入 dist，模型文件变化或提示词更新后需重启服务。每次更新核心适配导出后重新构建，不复用旧 framework.bundle.mjs。
