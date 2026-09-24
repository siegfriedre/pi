# DaaS 模型与提示词配置

模型调用继续使用 `packages/ai`，Agent 循环继续使用 `packages/agent`。本文件描述的是独立 DaaS 应用的配置加载方式，不会恢复终端应用、OAuth 登录、项目自动扫描或远程控制。

## 文件与默认选择

默认读取 `<应用目录>/.daas/models.json`。源码启动时应用目录是 `daas-web/`，发布后是 `dist/` 内容所在目录；不受启动时 cwd 影响，不读取旧 `.config` 或用户主目录。

在仓库根目录初始化：

```sh
cp daas-web/.daas/models.example.json daas-web/.daas/models.json
cp daas-web/.daas/settings.example.json daas-web/.daas/settings.json
```

已有 settings.json 时合并默认模型字段，**不要覆盖现有接口映射**。示例中的网关地址是占位值，应替换为公司真实地址。示例的模型 ID、reasoning、thinkingLevelMap、input、上下文和输出限额沿用 company-deepseek 原模型配置的结构，不代表该地址已经验证可用。

`models.json` 定义目录与连接，`settings.json` 选择默认模型。两者都只由管理员维护。

```json
{
  "providers": {
    "deepseek": {
      "baseUrl": "https://model.company.example/v1",
      "api": "openai-completions",
      "apiKey": "${DEEPSEEK_API_KEY}",
      "headers": {},
      "compat": {
        "supportsStore": false,
        "supportsDeveloperRole": false,
        "thinkingFormat": "deepseek",
        "maxTokensField": "max_tokens"
      },
      "models": [
        {
          "id": "deepseek-flash",
          "name": "DaaS 业务模型",
          "reasoning": true,
          "thinkingLevelMap": {
            "off": null,
            "minimal": "high",
            "low": "high",
            "medium": "high",
            "high": "high",
            "xhigh": "max",
            "max": "max"
          },
          "input": ["text", "image"],
          "contextWindow": 1000000,
          "maxTokens": 32768,
          "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
        }
      ]
    }
  }
}
```

对应的 settings.json 中添加：

```json
{
  "defaultProvider": "deepseek",
  "defaultModel": "deepseek-flash",
  "defaultThinkingLevel": "high",
  "modeModels": {},
  "operations": {},
  "readApiIds": []
}
```

只配置一个模型时可省略默认 provider/model，系统能唯一选择；多个模型时要求明确选择，不能靠目录顺序碰巧选中。`name` 是展示元数据，不替代请求体中的真实 `id`，也不改变产品身份。

可为两种模式分别选择**已经在 models.json 登记的**模型：

```json
{
  "defaultProvider": "deepseek",
  "defaultModel": "deepseek-flash",
  "defaultThinkingLevel": "high",
  "modeModels": {
    "developer": {"provider": "deepseek", "model": "deepseek-flash", "thinkingLevel": "high"},
    "analyst": {"provider": "internal", "model": "your-fast-model", "thinkingLevel": "off"}
  }
}
```

上面 `internal/your-fast-model` 是第二个已登记模型的占位示例。模式选择优先于全局默认，`provider`/`model` 必须成对设置。当前由管理员选择，不提供浏览器修改提供方、网关、密钥或自由选择模型的入口。

## 凭据与环境变量

推荐保留 `"apiKey": "${DEEPSEEK_API_KEY}"`，由进程环境或公司密钥管理注入。原始密钥也支持写成字面值，但不推荐提交到版本库。

- `$NAME`、`${NAME}` 支持环境变量替换，也支持 `"Bearer ${TOKEN}"`。
- `$$` 是字面 `$`，`$!` 是字面 `!`；变量值只展开一次，不递归解释。
- `"DEEPSEEK_API_KEY"` **是字面字符串**，不是环境变量名，不能省略 `$`。
- 未设置或为空的环境变量报错，不会把变量名当作密钥继续调用。
- 不支持 `!command`，不执行 Shell，不读取旧 auth.json，不做自动 OAuth 登录。

`baseUrl` 也允许环境变量引用。提供方的 headers 对全部模型生效，模型级 headers 按不区分大小写的键覆盖同名头。模型级 compat 覆盖提供方 compat 的同名键；嵌套对象整项替换，不做隐式深合并。

`authHeader` 默认 true，使用 API key 的标准 Bearer 认证；显式 Authorization 头优先。只有自定义头认证或免认证的内部服务，可明确设置 `authHeader:false` 禁用自动 Bearer，并自行配置必要头。内部适配器的占位 key 不发送给免认证服务。User-Agent 固定为 DaaS-Agent/0.1。

所有已登记提供方的凭据引用在启动时校验，未选中的模型也不能保留缺失的环境变量。配置、凭据、URL 和完整模型目录不返回浏览器、不注入系统提示词、不写入会话对象。错误仅显示出错字段，不显示密钥值或 JSON 解析片段。

## 思考与协议

`reasoning` 表示模型能力；`defaultThinkingLevel` 或模式的 `thinkingLevel` 表示本应用选择。它们与网页是否显示内部思考内容无关：网页仍不公开内部思考。

可选级别为 off/minimal/low/medium/high/xhigh/max。非思考模型只能选择 off。思考模型未显式选择时优先 medium，否则选择它支持的第一个级别。thinkingLevelMap 的 null 代表不支持该级别，字符串是发送给提供方的映射；xhigh/max 必须显式声明支持。选择不支持的级别会报错，不会静默关闭思考。实际运行还用 AI 包的 getSupportedThinkingLevels 校验一次。

当前内核适配器支持 **openai-completions**（OpenAI-compatible Chat Completions）。DeepSeek、公司代理或其他兼容网关可配置不同 provider，但仅在它们实际实现该协议时可用。不是在 JSON 中填写任意 api 名称就自动启用其他协议；不支持的协议会拒绝启动。此改动没有恢复完整多提供方终端运行时，也没有新增 npm 依赖。

常用字段兼容：provider 的 baseUrl/api/apiKey/authHeader/headers/compat/models；model 的 id/name/api/baseUrl/headers/reasoning/thinkingLevelMap/input/contextWindow/maxTokens/cost/compat/samplingParams。仅 id 必填的模型条目可继承提供方参数。缺省 input 为 text，contextWindow 为 128000，maxTokens 为 min(16384, contextWindow)，cost 四项缺省为零；这些默认值不是自动探测出的网关能力。

支持当前核心的常用 OpenAI-compatible compat 字段，包括 thinkingFormat、supportsDeveloperRole、supportsReasoningEffort、maxTokensField、流式结束标记/用量兼容、思考预算字段和模板参数。未知字段拒绝而不是忽略。嵌套的路由/模板参数作为管理员 JSON 交由核心和网关解释，具体含义需要按网关协议验证。

samplingParams 限定为 temperature/top_p/top_k/min_p/frequency_penalty/presence_penalty/repetition_penalty/seed，不能覆盖 messages/tools/model/stream 等协议字段。暂不支持 modelOverrides、内置模型目录合并、OAuth 和 cost.tiers；使用这些字段会明确报错。input 中声明 image 仅保留能力元数据，当前网页仍只有文本输入，不会因此自动出现附件上传功能。

## 自定义路径、迁移与生效时间

```sh
export DAAS_MODELS_FILE=/run/secrets/daas-models.json
export DEEPSEEK_API_KEY='由公司密钥管理注入'
export DAAS_PUBLIC_ORIGIN=https://daas.company.example
export DAAS_GATEWAY_SECRET='至少32字符的网关签名密钥'
export DAAS_PLATFORM_BASE_URL=https://data.company.example
npm start
```

相对 DAAS_MODELS_FILE 按应用目录解析，不按 cwd。模型、密钥引用、默认选择和提示词均在启动时读取为快照，修改后重启服务。`.env.example` 不自动加载。

优先级：指定 DAAS_MODELS_FILE → 默认 .daas/models.json。仅当**默认文件不存在且没有指定路径**时，才允许旧 DAAS_MODEL_BASE_URL/DAAS_MODEL_KEY/DAAS_MODEL_ID/DAAS_MODEL_HEADERS_JSON 方式。新文件存在时旧模型环境变量不覆盖它；文件错误、指定路径丢失、缺少密钥均直接报错，不能悄悄换模型。旧方式保持原来的 reasoning:false 行为；要启用思考请迁移到模型文件。

## 提示词维护

`.daas/prompts/base.md` 定义 DaaS 身份、工作原则和信任边界；`common.md` 定义平台公共概念和发现工具的使用约定；`developer.md`、`analyst.md` 定义对应模式目标。系统提示词按 base + common + 当前模式拼装；模型适配器不再硬编码整段业务提示词。

这些都是管理员维护的只读资源；不扫描其他目录、不读取旧终端提示词，也不把全部 Skills 塞入系统提示词。具体 Skill 和文档仍按需加载。缺失/空提示词报错，不回退为其他产品身份。常见“你是谁”继续使用固定产品回复；辅助身份规范化只处理自我介绍前缀，不替换正文中的 PI()、变量或代码。

## 发布注意

`.daas/models.json`、`.daas/settings.json` 都在忽略列表中，并排除在 dist 外；示例和提示词会打包。自定义文件应放在源码树外（例如 /run/secrets）或使用 *.local.json，并在构建时也传入 DAAS_MODELS_FILE，避免自定义文件误入发布内容。不要把私有配置放进扩展、技能或网页资源目录。

构建后的模型与设置通过只读挂载提供，代码和提示词只读，数据目录单独可写。不在运行容器中执行安装或生成配置脚本。

本次改动不包含 SSE、完整对话恢复或多实例存储迁移。应用配置/适配器单元与 HTTP 回归可以离线运行；完整 bundle 的真实请求验证由 npm run build 或 check:release 在具备固定依赖的环境执行，使用本地假模型，不接触公司凭据。
