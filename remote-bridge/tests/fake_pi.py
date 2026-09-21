"""Offline JSONL fixture. Never loads pi, credentials, tools or a real model."""
from __future__ import annotations

import json
import sys
import threading
import time

lock = threading.RLock()
running = False
generation = 0
session = 1
dialogs = {}


def output(event):
    with lock:
        sys.stdout.buffer.write((json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8"))
        sys.stdout.buffer.flush()


def success(command, data=None):
    event = {"type": "response", "id": command.get("id"), "command": command["type"], "success": True}
    if data is not None:
        event["data"] = data
    output(event)


def finish(text, token):
    global running
    time.sleep(0.03)
    with lock:
        if token != generation:
            return
        output({"type": "message_end", "message": {
            "role": "assistant", "stopReason": "stop",
            "content": [{"type": "thinking", "thinking": "DO_NOT_FORWARD"},
                        {"type": "text", "text": "回显：" + text}],
        }})
        running = False
        output({"type": "agent_end", "messages": [], "willRetry": False})
        output({"type": "agent_settled"})


for raw in sys.stdin.buffer:
    command = json.loads(raw)
    kind = command["type"]
    with lock:
        if kind == "get_state":
            success(command, {"sessionId": f"fake-{session}", "sessionFile": f"fake-{session}.jsonl",
                              "isStreaming": running, "isCompacting": False,
                              "pendingMessageCount": 0, "model": {"id": "fake", "provider": "fixture"}})
        elif kind == "get_commands":
            success(command, {"commands": [{"name": "plan"}, {"name": "ask"}, {"name": "skill:echo"}]})
        elif kind == "prompt":
            text = command["message"]
            if text == "crash":
                raise SystemExit(7)
            if text == "/ask":
                dialogs["fixture-question"] = command
                output({"type": "extension_ui_request", "id": "fixture-question", "method": "confirm",
                        "title": "继续执行？", "message": "这是一个模拟确认框。"})
            elif text == "/plan":
                output({"type": "extension_ui_request", "id": "notice", "method": "notify", "message": "计划模式已切换"})
                success(command)
            else:
                running = True
                generation += 1
                success(command)
                output({"type": "agent_start"})
                if text != "wait":
                    threading.Thread(target=finish, args=(text, generation), daemon=True).start()
        elif kind == "extension_ui_response":
            pending = dialogs.pop(command["id"], None)
            if pending:
                output({"type": "extension_ui_request", "id": "notice", "method": "notify",
                        "message": "已确认" if command.get("confirmed") else "已取消"})
                success(pending)
        elif kind == "abort":
            if running:
                running = False
                generation += 1
                output({"type": "agent_end", "messages": [], "willRetry": False})
                output({"type": "agent_settled"})
            success(command)
        elif kind == "clear_queue":
            success(command, {"steering": [], "followUp": []})
        elif kind == "new_session":
            session += 1
            success(command, {"cancelled": False})
        elif kind in ("abort_bash", "steer", "compact", "set_model"):
            success(command)
        else:
            output({"type": "response", "id": command.get("id"), "command": kind,
                    "success": False, "error": "Unknown fixture command"})
