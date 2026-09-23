# DaaS 升级与维护边界

## 基线

本应用建立在 `company-deepseek` 的提交 `5d9f6422c177a40a68294113166bede4cf12d22f` 上。该基线核心包版本为 0.85.1。

本次仅新增 `daas-web/`，不修改核心包、既有远程桥接、根目录启动脚本、原模型配置、依赖固定项或锁文件。现有终端产品继续独立存在，但不作为此网页应用的运行入口。

## 你日常会修改的地方

| 需求 | 文件/目录 |
| --- | --- |
| 页面布局、主题、交互 | `public/` |
| 增加业务工具 | `.daas/extensions/`，并在 `.daas/index.ts` 显式导入注册 |
| 增加业务技能和资料 | `.daas/skills/`，登记资源 ID 与必要工具依赖 |
| 适配实际 DaaS 接口 | `server/adapters/platform.ts` 与私有 settings.json |
| 适配公司 SSO | `server/safety.ts` 的 authenticate，或独立替换为公司验证器 |
| 切换模型网关 | 服务器环境变量和 modelCompat |
| 更换数据库存储 | `server/store.ts`，保持会话归属与执行意图约束 |

所有新增目录均使用 `.daas`，不创建旧框架的用户配置目录。不能简单全仓库替换上游 npm 包名；这样会破坏导入、锁文件和后续合并。上游真实包名只保留于私有适配器/构建映射/许可证等必要位置，不进入网页工具目录、产品身份或通用文件读取范围。许可证和原始归属不应为了品牌替换而删除。

## 升级时只检查一个薄适配层

`server/adapters/framework-entry.ts` 引入 `Agent` 及 OpenAI-compatible streamSimple，`model.ts` 负责把 DaaS 运行契约映射到它们。没有引用 Coding Agent CLI/TUI、默认工具、终端会话层、项目资源发现器或动态扩展安装器。

建议在单独的升级分支更新核心，保留公司模型接入和固定依赖策略，然后依次运行：

```sh
npm --prefix daas-web test
npm --prefix daas-web run check
npm --prefix daas-web run check:upstream
npm --prefix daas-web run build:framework
```

应用级 check 不遍历上游源码入口，真实 API 变化由 check:upstream 和打包检测。check:upstream 会使用实际 Agent 和本地假模型流，验证构造、Schema 校验、工具执行、工具结果进入下一轮；不会调用公司模型。

重点核对 Agent 构造参数、streamSimple 参数/事件、工具 execute 签名、消息和结果格式、取消与顺序执行。优先修适配器，不为了保留终端细节重新引入整个终端包。即使 Schema 合约测试通过，仍需用当前业务模型测试能力发现、参数正确率、业务确认、权限和错误处理。

依赖版本当前沿用分支已固定项：tsx 4.22.1、esbuild 0.28.1、typescript 5.9.3、typebox 1.3.27；chalk 5.6.2、ignore 7.0.5、marked 18.0.5、undici 8.5.0 等根覆盖项也没有改动。网页自身未增加运行依赖。安装依赖必须对应 Linux/目标 CPU 架构，不能直接搬运 Windows 上的原生二进制缓存。

## 能力版本与发布

修改工具语义或参数时递增工具 version；生产代码和 Skills 通过管理员构建发布，第一版不热加载。不要把运行期下载、用户附件、生成报告目录作为模块搜索路径。部署代码目录只读，数据目录独立。

已经生成的确认记录绑定工具 ID、version、参数摘要与会话。工具版本不匹配或参数改变后拒绝执行；已在执行中但没有确定结果的操作在重启后标为 unknown，不能自动补做。管理员必须保证实现有变化时更新 version，不能仅依赖文件名不变。

前端与插件面向 DaaS 自己的类型，后续核心升级不应要求它们随上游的 TUI 或扩展事件体系一起重写。
