# DaaS Agent Web

DaaS 专用的网页开发与用数助手。一个前端、一个 Node.js 服务，两种工作模式；所有业务能力由管理员发布。网页、运行目录、身份回复和公开错误统一采用 **DaaS Agent** 品牌。

本应用以 `company-deepseek` 的现有核心为基础，新增到 `daas-web/`，**不修改核心源码、根 package.json、锁文件或已固定的依赖版本**。真正的框架引用只在 `server/adapters/framework-entry.ts`；业务扩展不引用上游 SDK。

## 先体验界面

在已经准备好当前分支依赖的仓库根目录：

```sh
npm --prefix daas-web run demo
```

浏览器打开 `http://localhost:3210`。默认仅绑定本机。没有 tsx 时，仅为了体验演示和运行本应用的离线测试，也可以使用 Node 的类型擦除功能：

```sh
node --experimental-strip-types daas-web/server/main.ts --demo
npm --prefix daas-web test
```

部署要求 Node >=22.19.0。演示模式使用**明确标记的固定流程和虚构数据**，不调用模型、不访问真实业务平台、不执行 SQL、不保存真实 API。它用于检查页面、工具发现、结果、图表、下载和确认交互，不是完整模型能力的替代品。正式模式配置缺失会报错，不会自动降级成演示模式。

页面包含：侧栏历史/搜索、新建会话、业务空间切换、API 开发/数据分析模式、对话/工作台页签、任务过程、停止、操作确认、JSON 数据下载、柱状/折线/表格报告及隔离 HTML 预览。浏览器使用 HTTP 短轮询获取状态，不要求 WebSocket 或 SSE。模型调用仍在服务端，模型网关需要支持其兼容的聊天流接口。

前端使用原生 HTML/CSS/JavaScript，无 React/Vue/Vite、图表包、外部字体或 CDN；后端用 TypeScript。这个选择是为了减少内网依赖，并保持后续替换前端框架的自由。

## 目录和职责

```text
daas-web/
  public/                         页面、样式、浏览器交互
  server/
    app.ts                        HTTP API、身份校验、访问控制
    runtime.ts                    会话任务、取消、确认调度
    registry.ts                   注册表和四个系统工具
    safety.ts                     参数、身份、资源边界与展示安全
    store.ts                      单实例会话/结果/产物存储
    adapters/
      framework-entry.ts          唯一上游源码入口
      model.ts                    模型循环适配与产品身份
      platform.ts                 现有 DaaS 接口适配
  .daas/
    index.ts                      管理员批准入口，显式注册
    extensions/                   管理员业务工具
    skills/<name>/SKILL.md         技能正文
    skills/<name>/references/      参考文档
    settings.example.json         配置示例
  runtime-data/                   运行数据，已忽略、不进入注册目录
```

系统工具不能被业务扩展覆盖。新增文件不会自动获得执行资格。只加载 `.daas/index.ts` 明确导入和注册的能力；不扫描用户主目录、祖先目录、上传文件或会话产物，也不支持在线安装扩展。

沿用扩展/Skills 的目录习惯，但不是完整终端扩展 API 的兼容实现。这里不提供终端 UI、命令、快捷键和自动资源发现。原有扩展需要适配 `RegistryAPI`；前端和业务扩展主要依赖 `server/types.ts` 中的稳定类型。

## 渐进发现与执行

模型只获得四个常驻系统工具：

| 工具 | 作用 |
| --- | --- |
| `sys_discover` | 按任务、领域、类型返回最多 8 条摘要 |
| `sys_load` | 按 ID 加载工具参数定义或 Skill 正文及必要依赖 |
| `sys_read_resource` | 按批准的资源 ID 分页读取资料，不接受主机路径 |
| `sys_invoke` | 按已加载工具 ID 与结构化参数调用固定实现 |

首次调用必须加载定义；执行前再次检查模式、身份有效期、会话归属和目标参数。每轮最多 16 个加载能力、60 次系统调用、18 轮模型交互，任务最长 180 秒。工具按顺序执行，避免发现/加载和依赖调用并发竞态。首次检索先用中文词片段/关键词和领域筛选，不增加 Embedding 或向量数据库。

注册一个业务能力时提供稳定 ID、版本、标题/描述、领域、模式、effect、schema 和执行函数。`effect` 为 `read`、`artifact` 或 `write`。TypeScript 实现可以位于 `.daas/extensions`，也可以由扩展显式导入 `.daas/skills/.../scripts`；**模型不能选择文件、导出函数、代码、命令、cwd、环境变量或依赖包**。

这里的 `Schema` 是一个明确限定的 JSON Schema 子集：object/array/string/number/integer/boolean、properties、required、additionalProperties、items、enum、maxLength、minimum/maximum、maxItems。未知关键词在注册时拒绝，不会假装已经校验 `$ref`、pattern 等规则。`sys_invoke.arguments` 只做外层 JSON 校验，分发器还会依据目标工具 Schema 进行**第二次校验**。业务参数需要复杂限制时，在受信任 handler 内再做语义检查。此设计不需要新增验证库。

写操作先生成绑定工具版本、确切参数和会话的确认记录，用户通过专用网页请求确认。聊天中的“已同意”无效。确认有效期 10 分钟。执行前持久化执行意图，并向平台转发 `Idempotency-Key`。超时或重启后未确认结果的写入标记为“未知”，不会自动重试；需要先核对平台。平台自身必须支持幂等键或等价的去重/查询机制，应用不声称跨系统 exactly-once。

## 正式模型与网关接入

复制 `.daas/settings.example.json` 为 `.daas/settings.json`；本地配置已在 `.gitignore` 中忽略。通过环境变量配置：

```sh
export DAAS_PUBLIC_ORIGIN='https://daas.company.example'
export DAAS_GATEWAY_SECRET='由管理员生成的至少32字符随机密钥'
export DAAS_MODEL_BASE_URL='https://model.company.example/v1'
export DAAS_MODEL_ID='deepseek-flash'
export DAAS_MODEL_KEY='模型网关密钥'
export DAAS_PLATFORM_BASE_URL='https://data.company.example'
# 可选：公司网关固定请求头，JSON 对象。仅放在服务器环境中。
export DAAS_MODEL_HEADERS_JSON='{}'
npm --prefix daas-web start
```

`.env.example` 只是示例，不会自动读取。正式模式不读取旧终端的配置、身份、项目资源或默认工具；公司网关的地址/密钥/自定义请求头需显式迁移。模型相关兼容参数通过 `settings.json` 的 `modelCompat` 调整。

应用在现有 SSO/网关之后运行，**不能直接信任浏览器自行传入的 userId、tenant 或 role**。正式接入适配点在 `safety.ts::authenticate`。本版本提供一个明确的签名网关契约：网关验证用户登录、读取最新空间和模式权限后，覆盖客户端同名请求头，并在每次请求中注入：

- `Authorization: Bearer <当前用户的平台Token>`，不使用管理员 Token。
- `X-DaaS-Context`：下面 JSON 的 UTF-8 base64url 编码。
- `X-DaaS-Signature`：`HMAC-SHA256(secret, encodedContext + "." + SHA256(userToken))` 的小写十六进制。Token 指不含 `Bearer ` 的原值。

```json
{
  "sub": "user-123",
  "tenant": "tenant-a",
  "name": "张三",
  "exp": 1800000000,
  "spaces": [
    { "id": "space-a", "name": "订单业务", "modes": ["developer", "analyst"] }
  ]
}
```

`exp` 必须是实际签发时计算的 Unix 秒级过期时间，位于当前时间后 10 分钟以内；上面数值只是结构占位，不可直接使用。长任务中身份过期会安全停止，用户刷新后继续。网关和应用间需 HTTPS 或受控私网；禁止公网绕过网关直连，不能把签名密钥交给前端。每次 HTTP 请求重新验证身份，工具执行再校验有效期和空间/模式，DaaS 平台对实际操作继续执行最终鉴权。

页面不实现另一套密码登录或用户管理。对已有统一认证有其他契约的公司，替换这个认证适配点即可，不需要改模型循环或业务插件。

## 真实 DaaS API 映射

因为尚未提供公司的实际接口路径与响应结构，默认 `operations` 为空，真实操作会明确返回“尚未配置”，不会编造成功结果。

管理员在 `settings.json` 配置固定 POST 路径，例如：

```json
{
  "operations": {
    "datasource.list": "/your/datasource/list",
    "datasource.schema": "/your/datasource/schema",
    "sql.validate": "/your/sql/validate",
    "api.search": "/your/api/search",
    "api.describe": "/your/api/describe",
    "api.invoke": "/your/api/invoke",
    "api.save_draft": "/your/api/save-draft"
  },
  "readApiIds": ["管理员确认是只读且允许Agent调用的API-ID"]
}
```

上述路径是占位示例，不代表已知的公司接口。适配器目前以 `{ "parameters": <业务参数>, "spaceId": <服务器确认的空间> }` 作为 POST body；需按真实平台协议在 `server/adapters/platform.ts` 统一转换。URL、方法、身份、空间和请求头不是模型参数；禁止重定向转发凭据。若实际接口使用 GET，也由管理员在适配器里固定实现，不能把它改成模型可任意指定 URL 的 HTTP 工具。

归一化的结果契约：

| 操作 | 约定返回 |
| --- | --- |
| datasource.list | `{items:[{id,name,type}]}` |
| datasource.schema | `{tables:[{name,description,columns:[{name,type,description,nullable}]}]}` |
| api.search | `{items:[{id,name,description,effect}]}` |
| api.describe | `{id,name,description,parameters,fields,unit,period,effect}` |
| api.invoke | `{rows:[字段对象],complete:boolean,source:string}` |
| sql.validate | `{validated:boolean,issues:[],warnings:[]}` |
| api.save_draft | `{draftId,status,version}` |

连接元数据按字段白名单投影，不向模型返回密码、认证头或连接对象。真实查询行属于业务数据，不会改写其中的数值或字符串；字段/行权限、脱敏、动态 API 参数校验仍由平台负责。正式查询还要求 API ID 位于管理员 `readApiIds` 白名单，不能把任何“可调用接口”一律视为只读。

不提供发布、删除、授权修改、数据库直连、任意代码执行、通用文件写入或自动扩展安装。生成 SQL 只作为平台草稿/校验输入；不在 Node 中执行。普通汇总由预写代码完成，图表与 HTML 使用固定模板。高精度财务核算应在平台使用适当的数值类型，内置 Number 汇总不是财务精度保证。

## Linux 容器与离线交付

本地源码启动复用已固定的 `tsx 4.22.1`；构建脚本只接受原分支的 `esbuild 0.28.1`，不调用 tsgo，不安装或升级任何依赖。先在具备当前分支 Linux 依赖的构建环境运行：

```sh
npm --prefix daas-web run check:upstream
npm --prefix daas-web run build:framework
```

构建输出 `daas-web/dist/`：SDK 打包为私有 `framework.bundle.mjs`；复制 DaaS 服务、前端、已批准扩展与示例配置，并保留第三方许可证。不会复制本地 settings.json、运行数据、源码映射或旧终端目录。该运行目录使用 Node 类型擦除启动管理员 TS 源码，不需要安装 CLI/TUI 或 tsx。生产运行只读代码和单独可写数据卷，不意味着允许运行模型提交的代码。

Dockerfile 不固定一个未知的公司镜像，要求显式传入已批准、已缓存的 Linux Node >=22.19 基础镜像（建议使用 digest）：

```sh
docker build --build-arg BASE_IMAGE='你的内网Node镜像或digest' -t daas-agent-web daas-web
```

部署时挂载 `settings.json` 为只读，使用 1000:1000 用户；只把 `/var/lib/daas` 作为可写数据目录。建议启用 `--read-only`、`--cap-drop=ALL`、`--security-opt=no-new-privileges`、内存/CPU/PID 配额，且不挂载 Docker socket、凭据目录和无关宿主目录。出站网络只开放模型网关及必要 DaaS 地址。不要把整个仓库绑定成可写工作目录。

管理员代码在服务进程权限下运行，受控 context 是工程接口而非对恶意管理员代码的安全沙箱。固定模块不得对业务参数使用 eval、new Function、Shell 拼接或动态导入。耗时计算必须使用受信任的独立 Worker/服务并响应取消；同进程的 AbortSignal 无法强制打断不协作的同步死循环。

## 目前边界与验证

第一版采用文件持久化和进程内任务锁，**只支持单实例**。不要让多个容器写同一数据目录。会话、结果和产物绑定租户/用户/空间；默认最多 100 个可见会话、单会话 120 条消息、30 个结果、20 个产物。此版本没有定时清理、配额管理后台或数据库级审计；正式部署需要设置数据保留策略并定期归档。日志不记录全量参数、Token 或结果，工具轨迹持久化在会话中；高要求审计应接入公司的独立不可篡改审计系统。

长对话仅取最近 16 条消息并限制单条长度，不提供完整终端的自动压缩/分支能力。重要旧条件缺失时助手应再次确认；结果通过 resultId 复用。模型文本在完成一次消息后返回页面，工具状态通过轮询逐步出现，不是逐 Token 展示。展示层只清理助手叙述和生成的产品标题中的已知上游品牌，不篡改用户输入、SQL 或业务原始数据；身份问题“你是谁”有不依赖模型的确定性回复。提示词和品牌过滤不是对任意提示攻击的数学保证。

本次实际验证：44 项 Node 离线测试通过；应用级 TypeScript 类型检查通过（容器中的 TypeScript 5.8.3）；桌面/手机布局、身份回复、查询报告、确认、历史搜索等 8 项 Chromium 检查通过。浏览器环境禁止 URL 导航，页面检查使用本地静态资源和 HTTP 测试桥接，报告在无脚本 iframe 中渲染；未修改浏览器策略。接口、Cookie/签名之外的正式网关行为仍需在公司浏览器环境联调。

当前执行环境没有原仓库的安装依赖，且不能下载，因此**未运行真实 SDK 契约测试、esbuild 0.28.1 完整打包、Docker 构建或公司模型/API 联调**。已提供 `check:upstream` 使用真实 Agent 核心与本地假模型流进行无网络回归；它和完整构建需在你的已配置工作区执行。根依赖与锁文件保持原样，未用容器中的工具版本替换它们。

升级和维护请看 `UPGRADE.md`。
