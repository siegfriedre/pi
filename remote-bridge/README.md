# 通过 GET API 远程调用 pi（单人版）

消息链路：Bot 写入 Redis → 已有 HTTP GET 接口返回消息集合 → 本地 Python 轮询 → 常驻 pi RPC → 组装通知事件。

只新增 Python 标准库代码，不安装 Redis SDK，不修改 pi 核心、模型配置或现有 npm 依赖版本。不实现 Redis 写入、删除、LPOP、ACK、租约、数据库或自动任务重跑。

## 启动

需要 Python **3.10+**，以及本仓库已经能正常启动的 Node.js / tsx / pi 依赖。Python 部分不需要 `pip install`。从仓库根目录运行：

```powershell
Copy-Item remote-bridge/config.example.json remote-bridge/config.local.json

# 先编辑 config.local.json：填写 GET 地址、返回字段和真实工作目录。
# 模型密钥沿用本地启动 pi 时使用的环境变量，不要提交到仓库。
python remote-bridge/bridge.py --config remote-bridge/config.local.json
```

默认配置只是示例，不包含可用的公司接口。所有相对文件路径都相对于配置文件所在目录；例如 `pi.repo_dir: ".."` 表示仓库根目录，`pi.cwd` 改为实际办公目录，如 `D:/work/office`。

默认 `startup_policy` 为 **`skip`**：第一次成功查询只记住已有消息 ID，不执行这些旧消息。看到 `Startup snapshot skipped` 后再给 Bot 发新消息。设置为 **`process`** 可执行首次返回的全部未过期消息，但重启也会重新接收旧消息。

启动器从已安装的 `node_modules/tsx/package.json` 读取真正的启动入口，直接创建 Node 子进程，不通过 shell 拼接用户指令。同时设置进程 `cwd` 和 `PI_WORK_DIR`，沿用 `.config/agent` 的模型、工具、技能和扩展。

编译部署或特殊 Node 路径可以配置：

```json
{
  "pi": {
    "command": ["C:/Program Files/nodejs/node.exe", "D:/tools/daas/dist/cli.js"],
    "cwd": "D:/work/office"
  }
}
```

这是 `pi` 配置节的替代示例，不是完整配置。`command` 是启动命令的参数数组前缀；程序会追加 `--mode rpc` 和会话参数，不要自行重复添加。默认源码启动无需填写 `command`。

## GET 接口的数据约定

推荐接口返回：

```json
{
  "messages": [
    {
      "id": "app-msg-001",
      "text": "检查当前项目，先不要修改文件",
      "created_at": "2026-09-21T09:00:00Z",
      "expires_at": null
    },
    {
      "id": "app-msg-002",
      "text": "检查完成后给我总结"
    }
  ]
}
```

必须有 `id`、`text`；其他字段可选。`created_at` 仅供上游记录，桥接层不依赖它排序。`expires_at` 支持带时区的 ISO-8601 时间，或 `null`；在领取及实际执行前检查过期，不限制已经开始的任务时长。

数组按消息入库顺序返回；追加新条目，不要原地修改旧 ID。相同文本重新发一次，应使用新 ID；上游重试同一条消息，沿用原 ID。不要只保存最新一句，否则轮询间隔内的其他指令会丢失。

`inbox.messages_path` 指定数组所在位置：

| 返回内容 | messages_path |
| --- | --- |
| `[{...}, {...}]` | `""` |
| `{"messages": [...]}` | `"messages"` |
| `{"data": {"value": [...]}}` | `"data.value"` |
| `{"data": {"value": "[...]"}}` | `"data.value"` |

支持值整体为 JSON 字符串、以及数组元素分别为 JSON 字符串的情况。缺失 key 用 JSON `null` 或空数组表示；路径错误会记录警告，不应伪装成“没有消息”。单条格式错误只跳过该条，不阻塞后续有效条目。若接口通过业务码而不是 HTTP 状态表示失败，请在 `inbox.py` 的 `fetch_messages()` 中增加对应判断。

这里的 GET 是 **HTTP 请求方法**。Python 不关心后端使用 String 还是 List，只要求接口返回以上结构；这不代表 Redis 原生命令 `GET` 能读取 List。底层只支持 Redis GET 时，可以用 String 保存 JSON 数组。

认证头可以放在本地配置中，推荐环境变量：

```json
{
  "headers": {
    "Authorization": "Bearer ${BOT_API_TOKEN}"
  }
}
```

`${NAME}` 仅在读取配置时展开，不处理消息内容。未设置变量会直接报错。公司 HTTPS 证书需要自定义根证书时，在 `inbox` 或 `notification` 节设置 `ca_file`；不会关闭 TLS 校验。

## 内存去重与日志

同一次 Python 运行中使用 `set` 记住已接收 ID，在入队时记入，而不是等 pi 执行结束才记。重复轮询不会重复执行；收到新的有效消息时打印：

```text
RECEIVED id=app-msg-001 text='检查当前项目，先不要修改文件'
```

不使用本地去重状态文件，不淘汰运行中的历史 ID，避免仍在服务端窗口内的旧消息被重新执行。重启后 set 清空；日志不是恢复数据库。

两种启动策略都有明确取舍：

- `skip`：忽略第一次成功查询中的所有消息，包括停机期间新发来的消息。
- `process`：处理第一次返回的消息，可能重新执行上次运行已做过的任务。

只启动一个桥接实例。内存中的排队任务和未发送通知会在进程退出时丢失；断网后的 GET 下一轮重试，但不自动重跑已经接收的任务。服务端应保留合理的消息窗口；长期离线后已被窗口淘汰的消息无法补取。

## 会话、命令与插件

默认常驻一个 pi RPC 进程，普通工作指令在 Python 内排队，一次向 pi 投递一个主任务。HTTP 轮询、pi 输出读取、通知发送分别运行；pi 忙时仍能接收控制消息，不需要跨网 stream、WebSocket 或 Redis Pub/Sub。

pi 的会话历史仍由 **pi 自己**持久化在 `.local/sessions/<工作目录摘要>/`。`resume: true` 使用该目录最近的会话；这与内存去重是两回事。不与桌面 TUI 默认共享活动会话。

`pi.session_file` 可指定明确的已有会话文件；使用前先关闭操作该会话的 TUI。重启能恢复会话历史，但不能恢复任意插件的内存、正在执行的工具或确认请求。

| 聊天内容 | 行为 |
| --- | --- |
| 普通文本 | 排队后调用 RPC `prompt` |
| `/new` | 排队调用 `new_session`，旧历史保留 |
| `/compact [要求]` | 排队压缩上下文 |
| `/model provider/model` | 排队切换已配置的模型 |
| `/commands` | 查看桥接命令和实际加载的扩展、Skills、模板命令 |
| `/status` | 直接查询状态，不等任务结束 |
| `/stop` | 清空本地队列，取消插件问答，先 `clear_queue` 再 `abort` |
| `/steer 补充要求` | 给正在运行的任务补充要求，不当作新主任务 |
| `/plan`、`/skill:名称`、模板命令 | 命令已加载时通过 `prompt` 交给 pi |
| `/confirm 问答ID` | 同意插件的确认请求 |
| `/cancel 问答ID` | 取消插件问答 |
| `/reply 问答ID 内容` | 回复输入框；选择框可回复从 1 开始的编号 |

`/plan` 需要对应扩展已经加载，程序不会假装实现计划模式。未知斜杠命令不会当成普通提示词发给模型。`/settings` 等 TUI 专用命令、自定义全屏 UI、桌面快捷键不做适配。当前不提供远程安装插件、切换工作目录或桌面 TUI 实时接管。

插件 `confirm/select/input/editor` 转成通知事件，再把上述聊天命令转成 `extension_ui_response`。问答默认 300 秒过期，或采用插件更短的超时，过期按取消处理。等待问答不会阻塞收消息。

停止不是回滚；已修改的文件和已发生的外部操作不会自动撤销。控制指令也要等下一次 HTTP 轮询才能到达。某些插件若在启动时阻塞输入初始化，可能需要先适配插件；启动超时会明确报错，不会绕过项目信任或默认批准权限。

## 交给通知接口的内容

默认 `notification.url` 为空，不发送任何通知 HTTP 请求，只把事件打印到 stdout。接收日志和 pi 日志写到 stderr。

`notify.py` 的 **`send_notification(event, config)`** 是通知适配点。填写 `notification.url` 后，现有实现会把整个事件通过 HTTP POST 发过去；也可以替换这个函数，适配你自己的 URL、GET/POST、字段包装和业务码校验。

完整的助手文本示例：

```json
{
  "event_id": "唯一通知ID",
  "request_id": "app-msg-001",
  "session_id": "pi会话ID",
  "type": "assistant_message",
  "text": "检查完成，发现两处需要关注的问题……",
  "created_at": "2026-09-21T09:00:10+00:00",
  "sequence": 1
}
```

每条 `message_end` 的 assistant 文本都会组装，不只是最后一句。不会转发 token 增量、thinking 内容或工具结果正文。

主要事件：`received`、`assistant_message`、`task_completed`、`task_failed`、`task_cancelled`、`confirmation_request`、`confirmation_expired`、`expired`、`notification`、`status`、`error`。`confirmation_request` 还包含 `ui_request_id`、`method` 和选项等字段。

任务完成以当前分支的 `agent_settled` 为准，不把 `agent_end` 或 `prompt success` 当成完成。没有触发模型的扩展命令会检查空闲状态后结束。`task_completed` 表示本轮执行结束，不是对模型结果正确性的独立验证。

通知在独立线程顺序发送，慢通知接口不会阻塞读取 pi 输出或 GET 轮询。首版失败只记日志，不自动重发、不重跑任务；应监控本地日志。需要留一份待排查的事件记录，可把 `notification.jsonl_path` 设置为 `.local/events.jsonl`，它不会被用作去重或自动恢复。

## 验证

从仓库根目录执行：

```powershell
python -m unittest discover -s remote-bridge/tests -v
```

测试使用本机 HTTP 服务和模拟 JSONL 子进程，不读取真实模型密钥、不调用模型、不执行办公工具。覆盖 GET 返回格式、内存去重、启动策略、过期、RPC 会话、确认问答、停止分流、中文与 Unicode 分隔符、通知组装。

真实公司接口返回格式、Windows 上已安装的 Node/tsx、模型网关和自定义插件仍需内网联调。程序保留宿主机工具权限，不是沙箱；消息写入接口必须只允许你本人使用。不要将未知用户或外部文档内容直接当作远程控制指令。

RPC 协议依据本分支的 [rpc.md](../packages/coding-agent/docs/rpc.md) 和 [rpc-mode.ts](../packages/coding-agent/src/modes/rpc/rpc-mode.ts)。
