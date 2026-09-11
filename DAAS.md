# Daas 公司定制版

保留 Pi coding-agent 的 TUI、命令行、JSONL RPC、SDK、本地工具、会话和扩展。模型只通过 `openai-completions` / `openai-responses` 调用本地配置的 OpenAI 兼容端点。

## Windows 启动

需要 Node.js 22.19+，推荐 Node.js 24。开发依赖也必须安装，因为启动器使用 `tsx` 运行源码。

```powershell
npm ci --ignore-scripts --no-audit --no-fund
$env:DEEPSEEK_API_KEY = "你的密钥"
.\start.ps1
```

`start.ps1` 调用 `pi-test.ps1`，再运行 `packages/coding-agent/src/cli.ts`。启动器保留当前工作目录，固定使用仓库 TypeScript 配置，避免混用旧版本产品包。Linux/macOS 使用 `./pi-test.sh`。

`--version`、`--help`、`--list-models` 可检查启动。模型列表只检查本地配置与凭据是否齐全，不验证密钥，也不请求模型接口。未设置环境变量时，模型不会出现在可用列表中。

首次安装仍需 npm 或公司镜像。离线交付应在目标操作系统和架构上准备依赖，保留锁文件解析的完整依赖树；不要复用旧版手工裁剪的 `node_modules`。Windows 尤其需要 `tsx`、`esbuild`、对应的 `@esbuild/win32-x64` 和图片处理依赖。

## 配置位置

配置目录优先级：

1. 显式设置的 `DAAS_CODING_AGENT_DIR`，直接指向 `agent` 目录。
2. 安装仓库根目录的 `.config/agent`。
3. 仓库 `.config` 不存在时，使用用户目录的 `~/.pi/agent`。

`.config` 与 `.pi` 使用相同结构：模型在 `.config/agent/models.json`，扩展在 `.config/agent/extensions/`，设置在 `.config/agent/settings.json`。主题、技能、提示词、凭据和会话也随选定目录走。采用整目录选择，不逐文件合并用户目录；仓库中少一个文件不会悄悄读取 C 盘旧配置。项目本身的 `.pi` 资源与项目设置仍沿用 Pi 的本地加载规则。

模板配置官方 DeepSeek V4.1 Flash：端点 `https://api.deepseek.com`，模型 ID `deepseek-flash`，密钥值 `${DEEPSEEK_API_KEY}`。`maxTokens` 设置为 32768，作为单次输出预算。实际可用模型与限制以你的服务端为准。

接公司网关时修改 `baseUrl`、模型 `id`、输入能力和上下文上限，并同步 `settings.json` 的 `defaultModel`。网关若不支持 DeepSeek thinking 参数，需要调整 `reasoning`、`thinkingLevelMap` 和 `compat`。

密钥不要写入仓库。凭据、会话、缓存和工具二进制已加入忽略规则。设置文件会被应用修改，提交前请检查差异。

## 网络和依赖调整

- 移除 Anthropic、Google、Bedrock 等 SDK 依赖及 API 实现、云端 OAuth 实现和内置模型 provider，只保留 OpenAI SDK 作为模型传输。
- 关闭远程模型目录、版本查询、自更新、安装统计、会话上传、工具自动下载，以及 npm/git 插件在线安装更新。设置 `PI_OFFLINE=0` 或刷新时传 `allowNetwork: true` 也不会恢复这些内置请求。
- 扩展、技能和提示词通过本地目录加载。缺少 `rg` / `fd` 时提示本地安装，可放入 PATH 或 `.config/agent/bin`。
- 删除 `grok-mermaid` 依赖，Mermaid 代码块按原文显示；一般 Markdown、语法高亮和工具执行仍保留。该包是渲染依赖，不等于 Grok 模型账号。
- 工作区只安装 chord、tui、telemetry、ai、agent、coding-agent 六个包。telemetry 保留内存/空实现和类型接口，没有在线上报器。未启用的上游实验性工作区、文档和历史测试不属于本分支运行或验证范围。
- 移除上游发布、公告、二进制发行和远程模型目录发布脚本/工作流，改用本分支 Linux/Windows 检查工作流。

这些修改限制 Daas 内置的辅助联网功能。模型请求仍发往配置端点，bash/PowerShell 命令和自行添加的扩展保留宿主机权限。这不是操作系统级网络隔离。

## 品牌插件

附件使用指定文件名 `.config/agent/extensions/daas-reband.ts`。原附件替换整段系统提示词，可能误改追加提示词和 AGENTS.md。现只修改识别出的默认提示词区域，保留路径、追加提示词和项目上下文；自定义提示词保持原样，重复执行不会继续修改。

`piConfig.name` 和命令名改为 `daas`，npm 包名保留 `@earendil-works/*`，保证扩展导入路径正常。

## 验证和后续升级

```bash
npm run check
npm run test:daas
```

检查覆盖格式、依赖版本固定、运行依赖声明和支持入口的 TypeScript 类型。测试覆盖配置优先级、实际扩展加载、提示词边界、禁止管理请求、环境变量密钥、DeepSeek 流式工具调用和结果回传。HTTP 响应使用模拟数据，不调用真实模型。

后续先在 `main` 同步上游，再通过新的升级分支合并到 `company-deepseek`。重点审查配置、provider API/依赖、目录刷新、启动入口、扩展事件和锁文件的冲突，重新执行上述检查，并检查新增后台联网入口。定制改动较大，升级可能需要人工处理冲突。
