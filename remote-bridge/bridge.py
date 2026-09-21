"""Single-user HTTP polling bridge for the company-deepseek pi RPC protocol."""
from __future__ import annotations

import argparse
import logging
import queue
import sys
import threading
import time
from collections import deque
from pathlib import Path
from uuid import uuid4

from inbox import Message, load_config, poll_inbox
from notify import make_event, notification_worker
from pi_rpc import PiProcess

LOG = logging.getLogger("remote")
BUILTINS = "/new /compact /model provider/model /status /commands /stop /steer TEXT"
UI_COMMANDS = "/confirm ID | /cancel ID | /reply ID TEXT"


class Bridge:
    """Only the controller thread mutates task/session/dedup state."""
    def __init__(self, config: dict, rpc=None):
        self.config = config
        self.bus = queue.Queue()
        self.outbox = queue.Queue()
        self.stop_event = threading.Event()
        self.rpc = rpc if rpc is not None else PiProcess(config, self.bus)
        self.seen: set[str] = set()  # Intentionally memory-only; no eviction while running.
        self.first_snapshot = True
        self.tasks = deque()
        self.active: Message | None = None
        self.pending: dict[str, tuple[str, str | None]] = {}
        self.commands: set[str] = set()
        self.state: dict = {}
        self.ready = False
        self.initialized = False
        self.refresh_wait: set[str] = set()
        self.dialogs: dict[str, dict] = {}
        self.accepted = self.started = self.settled = False
        self.stopping = self.stop_ack = False
        self.failed: str | None = None
        self.last_error: str | None = None
        self.sequence = 0

    def emit(self, kind: str, request_id: str | None, text: str, **fields) -> None:
        self.outbox.put(make_event(kind, request_id, self.state.get("sessionId"), text, **fields))

    def send(self, kind: str, purpose: str, request_id: str | None = None, **fields) -> None:
        rpc_id = str(uuid4())
        self.pending[rpc_id] = (purpose, request_id)
        self.rpc.send({"id": rpc_id, "type": kind, **fields})

    def refresh(self) -> None:
        self.ready = False
        self.refresh_wait = {"state", "commands"}
        self.send("get_state", "state")
        self.send("get_commands", "commands")

    def ingest(self, items: list) -> None:
        messages = []
        for item in items:
            try:
                messages.append(Message.parse(item))
            except (TypeError, ValueError):
                LOG.warning("Ignoring malformed inbox item (id/text/expiry required to be valid)")
        if self.first_snapshot:
            self.first_snapshot = False
            if self.config["inbox"].get("startup_policy", "skip") == "skip":
                self.seen.update(message.id for message in messages)
                LOG.info("Startup snapshot skipped: %d IDs; send new messages now", len(self.seen))
                return
        for message in messages:
            if message.id in self.seen:
                continue
            self.seen.add(message.id)
            LOG.info("RECEIVED id=%s text=%r", message.id, message.text)
            if message.expired():
                self.emit("expired", message.id, "指令已过期，未执行。")
                continue
            text = message.text.strip()
            name, _, args = text.partition(" ")
            if name == "/stop":
                self.stop_task(message)
            elif name == "/status":
                self.send("get_state", "status", message.id)
            elif name == "/commands":
                available = " ".join("/" + command for command in sorted(self.commands))
                self.emit("status", message.id, f"{BUILTINS}\n{UI_COMMANDS}\n{available}")
            elif name in ("/confirm", "/cancel", "/reply"):
                self.answer_dialog(message, name, args)
            elif name == "/steer":
                if self.active and self.started and not self.settled and args.strip():
                    self.send("steer", "control", message.id, message=args)
                else:
                    self.emit("error", message.id, "/steer 需要正在运行的任务和补充内容。")
            else:
                self.tasks.append(message)
                self.emit("received", message.id, "已接收，等待顺序执行。")

    def dispatch_next(self) -> None:
        if not self.ready or self.active or self.stopping:
            return
        while self.tasks:
            message = self.tasks.popleft()
            if message.expired():
                self.emit("expired", message.id, "指令在排队期间过期，未执行。")
                continue
            self.active = message
            self.accepted = self.started = self.settled = False
            self.failed = self.last_error = None
            self.sequence = 0
            text = message.text.strip()
            name, _, args = text.partition(" ")
            if name == "/new":
                self.send("new_session", "action", message.id)
            elif name == "/compact":
                self.send("compact", "action", message.id, customInstructions=args)
            elif name == "/model":
                provider, slash, model = args.strip().partition("/")
                if not slash or not provider or not model:
                    self.finish("用法：/model provider/model")
                else:
                    self.send("set_model", "action", message.id, provider=provider, modelId=model)
            elif text.startswith("/") and name[1:] not in self.commands:
                self.finish("命令未加载或只支持 TUI；用 /commands 查看可用命令。")
            else:
                self.send("prompt", "prompt", message.id, message=message.text)
            return

    def stop_task(self, message: Message) -> None:
        while self.tasks:
            cancelled = self.tasks.popleft()
            self.emit("task_cancelled", cancelled.id, "待执行指令已取消。")
        for dialog_id in list(self.dialogs):
            self.rpc.send({"type": "extension_ui_response", "id": dialog_id, "cancelled": True})
            self.dialogs.pop(dialog_id)
        if self.stopping:
            self.emit("status", message.id, "停止请求已发送，正在等待 pi 停止。")
            return
        self.stopping, self.stop_ack = True, False
        # Sequence clear_queue -> abort; do not let a retained follow-up restart work.
        self.send("clear_queue", "stop_clear", message.id)

    def answer_dialog(self, message: Message, name: str, args: str) -> None:
        dialog_id, _, value = args.partition(" ")
        dialog = self.dialogs.get(dialog_id)
        if not dialog or time.monotonic() >= dialog["deadline"]:
            self.emit("error", message.id, "确认请求不存在或已过期。")
            return
        method = dialog["event"]["method"]
        response = {"type": "extension_ui_response", "id": dialog_id}
        if name == "/cancel":
            response["cancelled"] = True
        elif name == "/confirm" and method == "confirm":
            response["confirmed"] = True
        elif name == "/reply" and method in ("select", "input", "editor") and value:
            if method == "select":
                options = dialog["event"].get("options", [])
                if value.isdigit() and 1 <= int(value) <= len(options):
                    value = options[int(value) - 1]
                if value not in options:
                    self.emit("error", message.id, "请选择有效的选项编号或完整选项文字。")
                    return
            response["value"] = value
        else:
            self.emit("error", message.id, "回复类型不匹配：" + UI_COMMANDS)
            return
        self.rpc.send(response)
        self.dialogs.pop(dialog_id)
        self.emit("status", message.id, "回复已交给插件。")

    def finish(self, error: str | None = None) -> None:
        if not self.active:
            return
        error = error or self.failed or self.last_error
        kind = "task_cancelled" if self.stopping else "task_failed" if error else "task_completed"
        text = "本轮已停止；已产生的文件或外部操作不会自动撤销。" if self.stopping else error or "本轮执行结束。"
        self.emit(kind, self.active.id, text)
        self.active = None
        if self.stop_ack:
            self.stopping = False
        self.refresh()

    def handle_response(self, event: dict) -> None:
        purpose, request_id = self.pending.pop(event.get("id"), ("", None))
        if not purpose:
            return
        if not event.get("success"):
            error = str(event.get("error", "RPC command failed"))
            if purpose in ("state", "commands"):
                raise RuntimeError(error)
            if self.active and request_id == self.active.id:
                self.finish(error)
            else:
                self.emit("error", request_id, error)
            if purpose.startswith("stop"):
                self.stopping = False
            return
        data = event.get("data") or {}
        if purpose in ("state", "commands"):
            if purpose == "state":
                self.state = data
                LOG.info("SESSION id=%s file=%s", data.get("sessionId"), data.get("sessionFile"))
            else:
                self.commands = {item["name"] for item in data.get("commands", [])}
            self.refresh_wait.discard(purpose)
            self.ready = not self.refresh_wait
            if self.ready and not self.initialized:
                self.initialized = True
                LOG.info("pi RPC ready; inbox deduplication is memory-only")
        elif purpose == "status":
            model = data.get("model") or {}
            text = (
                f"session={data.get('sessionId')} model={model.get('id')}\n"
                f"running={data.get('isStreaming')} compacting={data.get('isCompacting')} "
                f"queued={len(self.tasks)} waiting_ui={len(self.dialogs)}"
            )
            self.emit("status", request_id, text)
        elif purpose == "stop_clear":
            self.send("abort_bash", "control", request_id)
            self.send("abort", "stop_done", request_id)
        elif purpose == "stop_done":
            self.stop_ack = True
            self.emit("status", request_id, "已向 pi 发出停止请求，并清空待执行队列。")
            if not self.active:
                self.stopping = False
            elif self.accepted:
                self.send("get_state", "probe", self.active.id)
        elif purpose == "control":
            self.emit("status", request_id, "控制指令已处理。")
        elif self.active and request_id == self.active.id:
            if purpose == "action":
                self.finish("操作被插件取消。" if data.get("cancelled") else None)
            elif purpose == "prompt":
                self.accepted = True
                # Covers extension/input handlers that never start an agent run.
                # A success response alone is NOT task completion.
                self.send("get_state", "probe", request_id)
            elif purpose == "probe":
                self.state = data
                idle = not (data.get("isStreaming") or data.get("isCompacting") or data.get("pendingMessageCount"))
                if idle and not self.dialogs and (self.settled or not self.started):
                    self.finish()

    def handle_rpc(self, event: dict) -> None:
        kind = event.get("type")
        request_id = self.active.id if self.active else None
        if kind == "response":
            self.handle_response(event)
        elif kind == "agent_start":
            self.started, self.settled = True, False
        elif kind == "agent_settled":
            self.settled = True
            if self.active and self.accepted and not self.dialogs:
                self.finish()
        elif kind == "message_end":
            message = event.get("message") or {}
            if message.get("role") != "assistant":
                return
            self.last_error = None
            if message.get("stopReason") == "error":
                self.last_error = message.get("errorMessage") or "模型请求失败。"
            elif message.get("stopReason") == "aborted":
                self.last_error = "模型请求被中止。"
            blocks = message.get("content") or []
            text = "\n".join(block["text"] for block in blocks if block.get("type") == "text" and block.get("text"))
            if text:
                self.sequence += 1
                self.emit("assistant_message", request_id, text, sequence=self.sequence)
            if self.last_error:
                self.emit("error", request_id, self.last_error)
        elif kind == "extension_error":
            self.failed = str(event.get("error", "插件执行失败。"))
            self.emit("error", request_id, self.failed)
        elif kind == "extension_ui_request":
            method = event.get("method")
            if method in ("confirm", "select", "input", "editor"):
                timeout = self.config["pi"].get("ui_timeout_seconds", 300)
                if isinstance(event.get("timeout"), (int, float)) and event["timeout"] > 0:
                    timeout = min(timeout, event["timeout"] / 1000)
                self.dialogs[event["id"]] = {
                    "event": event, "request_id": request_id, "deadline": time.monotonic() + timeout,
                }
                command = "/confirm" if method == "confirm" else "/reply"
                text = f"{event.get('title', '')}\n{event.get('message', '')}"
                if method == "select":
                    text += "\n" + "\n".join(f"{i}. {option}" for i, option in enumerate(event.get("options", []), 1))
                text += f"\n{command} {event['id']}" + (" 内容或选项编号" if command == "/reply" else "")
                text += f"\n取消：/cancel {event['id']}"
                fields = {key: event[key] for key in ("title", "message", "options", "placeholder", "prefill") if key in event}
                self.emit("confirmation_request", request_id, text, ui_request_id=event["id"], method=method, **fields)
            elif method == "notify":
                self.emit("notification", request_id, event.get("message", ""), level=event.get("notifyType", "info"))
        elif kind == "tool_execution_start":
            LOG.info("TOOL request_id=%s name=%s", request_id, event.get("toolName"))
        # agent_end, token deltas, thinking and tool result bodies are not forwarded.

    def tick(self) -> None:
        for dialog_id, dialog in list(self.dialogs.items()):
            if time.monotonic() >= dialog["deadline"]:
                self.rpc.send({"type": "extension_ui_response", "id": dialog_id, "cancelled": True})
                self.dialogs.pop(dialog_id)
                self.emit("confirmation_expired", dialog["request_id"], "插件问答已超时，按取消处理。")

    def run(self) -> None:
        notifier = threading.Thread(target=notification_worker, args=(self.outbox, self.config), daemon=True)
        poller = threading.Thread(target=poll_inbox, args=(self.config, self.bus, self.stop_event), daemon=True)
        notifier.start()
        try:
            self.rpc.start()
            self.refresh()
            poller.start()
            startup = time.monotonic()
            while not self.stop_event.is_set():
                try:
                    kind, payload = self.bus.get(timeout=0.1)
                    if kind == "inbox":
                        self.ingest(payload)
                    elif kind == "rpc":
                        self.handle_rpc(payload)
                    elif kind == "exit":
                        raise RuntimeError(f"pi exited ({payload}); tasks will not be automatically replayed")
                except queue.Empty:
                    pass
                self.tick()
                self.dispatch_next()
                if not self.initialized and time.monotonic() - startup > self.config["pi"].get("startup_timeout_seconds", 30):
                    raise RuntimeError("pi startup timed out; check model configuration, trust and extension startup logs")
        except Exception as error:
            request_id = self.active.id if self.active else None
            self.emit("error", request_id, f"桥接程序已停止，不自动重跑任务：{error}")
            raise
        finally:
            self.stop_event.set()
            self.rpc.close()
            if poller.is_alive():
                poller.join(timeout=self.config["inbox"].get("timeout_seconds", 10) + 1)
            self.outbox.put(None)
            notifier.join(timeout=self.config["notification"].get("timeout_seconds", 10) + 1)


def main() -> int:
    # Stable UTF-8 JSON/log output when redirected on Windows.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path(__file__).with_name("config.local.json"))
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    try:
        Bridge(load_config(args.config)).run()
    except KeyboardInterrupt:
        LOG.info("Bridge stopped. In-memory deduplication has been discarded.")
    except Exception as error:
        LOG.error("%s: %s", type(error).__name__, error)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
