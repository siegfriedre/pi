from __future__ import annotations

import contextlib
import io
import json
import logging
import os
import queue
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bridge import Bridge
from inbox import Message, expand_env, extract_messages, fetch_messages, load_config, poll_inbox
from notify import make_event, notification_worker, send_notification
from pi_rpc import PiProcess, launch_options

HERE = Path(__file__).resolve().parent


def config(base="."):
    return {
        "_base": str(base),
        "inbox": {"url": "http://127.0.0.1:1/inbox", "poll_seconds": 0.02,
                  "timeout_seconds": 1, "startup_policy": "process"},
        "pi": {"command": [sys.executable, str(HERE / "fake_pi.py")], "cwd": ".",
               "startup_timeout_seconds": 3},
        "notification": {"timeout_seconds": 1},
    }


class RecordingRpc:
    def __init__(self):
        self.sent = []

    def send(self, event):
        self.sent.append(event)

    def last(self, kind):
        return next(item for item in reversed(self.sent) if item["type"] == kind)


def reply(bridge, command, data=None, success=True):
    bridge.handle_rpc({"type": "response", "id": command["id"], "command": command["type"],
                       "success": success, "data": data, "error": "fixture error"})


def drain(outbox):
    events = []
    while not outbox.empty():
        events.append(outbox.get_nowait())
    return events


def wait_for(predicate, timeout=4):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("Timed out waiting for fixture")


class HttpFixture:
    def __init__(self):
        self.payload = []
        self.gets, self.posts = [], []
        self.failures = 0
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                fixture.gets.append(self.path)
                if fixture.failures:
                    fixture.failures -= 1
                    self.send_error(503)
                    return
                data = json.dumps(fixture.payload, ensure_ascii=False).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                fixture.posts.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                self.send_response(204)
                self.end_headers()

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()


class InboxTests(unittest.TestCase):
    def test_arrays_encoded_arrays_and_encoded_entries(self):
        message = {"id": "a", "text": "中文"}
        for payload in ([message], json.dumps([message]), [json.dumps(message)]):
            self.assertEqual(Message.parse(extract_messages(payload)[0]).text, "中文")

    def test_nested_path_decodes_json_between_components(self):
        payload = {"data": json.dumps({"value": json.dumps([{"id": 7, "text": "x"}])})}
        self.assertEqual(Message.parse(extract_messages(payload, "data.value")[0]).id, "7")

    def test_null_key_is_empty(self):
        self.assertEqual(extract_messages({"data": None}, "data"), [])
        self.assertEqual(extract_messages(None), [])

    def test_missing_path_and_wrong_type_are_errors(self):
        for payload, path in (({}, "data.value"), ({"a": 1}, ""), ("not json", "")):
            with self.assertRaises(ValueError):
                extract_messages(payload, path)

    def test_invalid_messages(self):
        for value in (None, {"text": "x"}, {"id": True, "text": "x"},
                      {"id": "", "text": "x"}, {"id": "a", "text": " "},
                      {"id": "a", "text": "x", "expires_at": "2020-01-01T00:00:00"}):
            with self.assertRaises(ValueError):
                Message.parse(value)

    def test_expiry_is_optional_and_timezone_aware(self):
        self.assertFalse(Message.parse({"id": "a", "text": "x"}).expired())
        old = (datetime.now(timezone.utc) - timedelta(seconds=10)).isoformat()
        self.assertTrue(Message.parse({"id": "a", "text": "x", "expires_at": old}).expired())

    def test_env_only_expands_config(self):
        with patch.dict(os.environ, {"REMOTE_FIXTURE": "secret"}):
            self.assertEqual(expand_env({"headers": {"X": "${REMOTE_FIXTURE}"}}),
                             {"headers": {"X": "secret"}})
        self.assertEqual(Message.parse({"id": "a", "text": "${MISSING}"}).text, "${MISSING}")
        with self.assertRaises(ValueError):
            expand_env("${REMOTE_TEST_DEFINITELY_MISSING}")

    def test_config_validation(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "config.json"
            for value in (0, -1, True):
                settings = config(temp)
                settings["inbox"]["poll_seconds"] = value
                path.write_text(json.dumps(settings))
                with self.assertRaises(ValueError):
                    load_config(path)
            path.write_text(json.dumps(config(temp)))
            self.assertEqual(load_config(path)["_base"], temp)

    def test_http_get_query_and_list_result(self):
        http = HttpFixture()
        self.addCleanup(http.close)
        http.payload = {"data": {"value": json.dumps([json.dumps({"id": "a", "text": "x"})])}}
        settings = config()
        settings["inbox"].update(url=http.url + "/inbox", query={"key": "pi:inbox"},
                                 messages_path="data.value")
        self.assertEqual(Message.parse(fetch_messages(settings)[0]).id, "a")
        self.assertIn("key=pi%3Ainbox", http.gets[0])
        self.assertEqual(http.posts, [])

    def test_http_failure_does_not_stop_polling(self):
        http = HttpFixture()
        self.addCleanup(http.close)
        http.failures = 1
        http.payload = [{"id": "a", "text": "x"}]
        settings = config()
        settings["inbox"]["url"] = http.url
        bus, stop = queue.Queue(), threading.Event()
        thread = threading.Thread(target=poll_inbox, args=(settings, bus, stop))
        with self.assertLogs("remote.inbox", level="WARNING"):
            thread.start()
            try:
                self.assertEqual(bus.get(timeout=2)[1][0]["id"], "a")
            finally:
                stop.set()
                thread.join(timeout=2)
        self.assertGreaterEqual(len(http.gets), 2)


class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.rpc = RecordingRpc()
        self.bridge = Bridge(config(), self.rpc)
        self.bridge.ready = True
        self.bridge.commands = {"plan", "ask", "skill:echo"}

    def start(self, text="hello"):
        self.bridge.ingest([{"id": "a", "text": text}])
        self.bridge.dispatch_next()
        return self.rpc.last("prompt")

    def test_memory_dedup_marks_at_receipt_and_logs_only_once(self):
        with self.assertLogs("remote", level="INFO") as logs:
            self.bridge.ingest([{"id": "a", "text": "x"}] * 3)
            self.bridge.ingest([{"id": "a", "text": "x"}])
        self.assertEqual(len(self.bridge.tasks), 1)
        self.assertEqual(sum("RECEIVED" in line for line in logs.output), 1)

    def test_new_process_does_not_remember_ids(self):
        self.bridge.ingest([{"id": "a", "text": "x"}])
        other = Bridge(config(), RecordingRpc())
        other.ingest([{"id": "a", "text": "x"}])
        self.assertEqual(len(other.tasks), 1)

    def test_skip_first_snapshot_then_receive_new(self):
        self.bridge.config["inbox"]["startup_policy"] = "skip"
        self.bridge.ingest([{"id": "old", "text": "old"}])
        self.bridge.ingest([{"id": "old", "text": "old"}, {"id": "new", "text": "new"}])
        self.assertEqual([m.id for m in self.bridge.tasks], ["new"])

    def test_malformed_item_does_not_block_valid_item(self):
        with self.assertLogs("remote", level="WARNING"):
            self.bridge.ingest(["broken", {"id": "a", "text": "ok"}])
        self.assertEqual(len(self.bridge.tasks), 1)

    def test_expired_in_local_queue_not_executed(self):
        with patch.object(Message, "expired", side_effect=[False, True]):
            self.bridge.ingest([{"id": "a", "text": "x"}])
            self.bridge.dispatch_next()
        self.assertIsNone(self.bridge.active)
        self.assertFalse(self.rpc.sent)

    def test_agent_end_is_not_completion_and_only_text_is_forwarded(self):
        command = self.start()
        reply(self.bridge, command)
        self.bridge.handle_rpc({"type": "agent_start"})
        reply(self.bridge, self.rpc.last("get_state"), {"isStreaming": True})
        self.bridge.ingest([{"id": "b", "text": "next"}])
        self.bridge.handle_rpc({"type": "agent_end", "willRetry": True})
        self.bridge.dispatch_next()
        self.assertEqual(self.bridge.active.id, "a")
        self.bridge.handle_rpc({"type": "message_end", "message": {
            "role": "assistant", "stopReason": "stop",
            "content": [{"type": "thinking", "thinking": "HIDDEN"},
                        {"type": "text", "text": "done"}],
        }})
        self.bridge.handle_rpc({"type": "agent_settled"})
        events = drain(self.bridge.outbox)
        self.assertNotIn("HIDDEN", json.dumps(events))
        self.assertEqual([e["request_id"] for e in events if e["type"] == "task_completed"], ["a"])
        self.assertEqual([m.id for m in self.bridge.tasks], ["b"])
        self.assertFalse(self.bridge.ready)  # Refresh session/commands before next task.

    def test_extension_without_agent_run_completes(self):
        command = self.start("/plan")
        reply(self.bridge, command)
        self.assertIsNotNone(self.bridge.active)
        reply(self.bridge, self.rpc.last("get_state"), {"isStreaming": False, "sessionId": "same"})
        self.assertIsNone(self.bridge.active)
        self.assertTrue(any(e["type"] == "task_completed" for e in drain(self.bridge.outbox)))

    def test_prompt_rejected_is_not_success(self):
        reply(self.bridge, self.start(), success=False)
        events = drain(self.bridge.outbox)
        self.assertTrue(any(e["type"] == "task_failed" for e in events))
        self.assertFalse(any(e["type"] == "task_completed" for e in events))

    def test_unknown_slash_command_not_sent_to_model(self):
        self.bridge.ingest([{"id": "a", "text": "/settings"}])
        self.bridge.dispatch_next()
        self.assertFalse(any(c["type"] == "prompt" for c in self.rpc.sent))

    def test_new_session_maps_to_rpc(self):
        self.bridge.ingest([{"id": "a", "text": "/new"}])
        self.bridge.dispatch_next()
        self.assertEqual(self.rpc.sent[-1]["type"], "new_session")

    def test_stop_clears_queue_and_bypasses_active_task(self):
        self.start("wait")
        self.bridge.ingest([{"id": "b", "text": "later"}, {"id": "s", "text": "/stop"}])
        self.assertEqual(len(self.bridge.tasks), 0)
        clear = self.rpc.last("clear_queue")
        reply(self.bridge, clear)
        self.assertEqual(self.rpc.sent[-1]["type"], "abort")
        self.assertTrue(self.bridge.stopping)

    def test_confirmation_bypasses_task_queue(self):
        self.start("/ask")
        self.bridge.handle_rpc({"type": "extension_ui_request", "id": "q1",
                                "method": "confirm", "title": "Proceed?"})
        self.bridge.ingest([{"id": "answer", "text": "/confirm q1"}])
        self.assertEqual(self.rpc.sent[-1], {"type": "extension_ui_response", "id": "q1", "confirmed": True})
        self.assertFalse(self.bridge.dialogs)

    def test_invalid_select_reply_does_not_resolve_dialog(self):
        self.bridge.handle_rpc({"type": "extension_ui_request", "id": "q1", "method": "select",
                                "title": "Choose", "options": ["A", "B"]})
        self.bridge.ingest([{"id": "a", "text": "/reply q1 3"}])
        self.assertIn("q1", self.bridge.dialogs)
        self.bridge.ingest([{"id": "b", "text": "/reply q1 2"}])
        self.assertEqual(self.rpc.sent[-1]["value"], "B")

    def test_ui_timeout_cancels_instead_of_approving(self):
        self.bridge.handle_rpc({"type": "extension_ui_request", "id": "q1", "method": "confirm"})
        self.bridge.dialogs["q1"]["deadline"] = 0
        self.bridge.tick()
        self.assertTrue(self.rpc.sent[-1]["cancelled"])

    def test_status_does_not_wait_for_agent(self):
        self.start("wait")
        self.bridge.ingest([{"id": "s", "text": "/status"}])
        self.assertEqual(self.rpc.sent[-1]["type"], "get_state")
        self.assertEqual(self.bridge.active.id, "a")


    def test_model_error_is_not_task_completed(self):
        command = self.start()
        reply(self.bridge, command)
        self.bridge.handle_rpc({"type": "agent_start"})
        self.bridge.handle_rpc({"type": "message_end", "message": {
            "role": "assistant", "stopReason": "error", "errorMessage": "fixture failure", "content": [],
        }})
        self.bridge.handle_rpc({"type": "agent_settled"})
        events = drain(self.bridge.outbox)
        self.assertTrue(any(e["type"] == "task_failed" for e in events))
        self.assertFalse(any(e["type"] == "task_completed" for e in events))

    def test_extension_can_settle_before_prompt_response(self):
        command = self.start("/plan")
        self.bridge.handle_rpc({"type": "agent_start"})
        self.bridge.handle_rpc({"type": "agent_settled"})
        self.assertIsNotNone(self.bridge.active)
        reply(self.bridge, command)
        reply(self.bridge, self.rpc.last("get_state"), {"isStreaming": False})
        self.assertIsNone(self.bridge.active)

    def test_same_snapshot_stop_cancels_not_yet_dispatched_tasks(self):
        self.bridge.ingest([{"id": "a", "text": "work"}, {"id": "s", "text": "/stop"}])
        self.bridge.dispatch_next()
        self.assertFalse(any(c["type"] == "prompt" for c in self.rpc.sent))
        self.assertEqual(len(self.bridge.tasks), 0)


class ProcessAndNotificationTests(unittest.TestCase):
    def test_default_launch_reads_tsx_bin_and_separates_cwd(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            package = base / "repo/node_modules/tsx"
            package.mkdir(parents=True)
            (package / "package.json").write_text(json.dumps({"bin": {"tsx": "./bin.mjs"}}))
            cwd = base / "work"
            cwd.mkdir()
            settings = config(temp)
            settings["pi"] = {"repo_dir": "repo", "cwd": "work", "agent_dir": "repo/.config/agent"}
            command, workdir, env = launch_options(settings)
            self.assertEqual(workdir, cwd)
            self.assertIn(str(package / "bin.mjs"), command)
            self.assertIn("--continue", command)
            self.assertEqual(env["PI_WORK_DIR"], str(cwd))
            self.assertEqual(env["DAAS_CODING_AGENT_DIR"], str(base / "repo/.config/agent"))

    def test_explicit_session_does_not_add_continue(self):
        with tempfile.TemporaryDirectory() as temp:
            settings = config(temp)
            settings["pi"]["session_file"] = "saved.jsonl"
            command, _, _ = launch_options(settings)
            self.assertIn("--session", command)
            self.assertNotIn("--continue", command)

    def test_real_subprocess_preserves_unicode_jsonl(self):
        with tempfile.TemporaryDirectory() as temp:
            bus = queue.Queue()
            rpc = PiProcess(config(temp), bus)
            rpc.start()
            try:
                text = "中文\u2028分隔\u2029符\n下一行"
                rpc.send({"type": "prompt", "id": "a", "message": text})
                events = []
                while not any(e.get("type") == "agent_settled" for e in events):
                    kind, event = bus.get(timeout=3)
                    self.assertEqual(kind, "rpc")
                    events.append(event)
                assistant = next(e for e in events if e["type"] == "message_end")
                self.assertEqual(assistant["message"]["content"][1]["text"], "回显：" + text)
            finally:
                rpc.close()
            self.assertIsNotNone(rpc.process.returncode)

    def test_notification_default_only_prints_and_optional_post(self):
        http = HttpFixture()
        self.addCleanup(http.close)
        settings = config()
        event = make_event("assistant_message", "a", "s", "你好")
        with contextlib.redirect_stdout(io.StringIO()) as captured:
            send_notification(event, settings)
            settings["notification"]["url"] = http.url + "/notify"
            send_notification(event, settings)
        self.assertEqual(len(http.posts), 1)
        self.assertEqual(http.posts[0], event)
        self.assertEqual(len(captured.getvalue().splitlines()), 2)

    def test_notification_failure_does_not_block_next_event(self):
        outbox = queue.Queue()
        outbox.put(make_event("error", "a", None, "one"))
        outbox.put(make_event("error", "b", None, "two"))
        outbox.put(None)
        with patch("notify.send_notification", side_effect=[OSError("fixture"), None]) as send:
            with self.assertLogs("remote.notification", level="WARNING"):
                notification_worker(outbox, config())
        self.assertEqual(send.call_count, 2)

    def test_end_to_end_get_dedup_confirm_new_session_and_notify(self):
        http = HttpFixture()
        self.addCleanup(http.close)
        with tempfile.TemporaryDirectory() as temp:
            settings = config(temp)
            settings["inbox"].update(url=http.url + "/inbox", startup_policy="skip")
            bridge = Bridge(settings)
            events, failures = [], []

            def run():
                try:
                    bridge.run()
                except Exception as error:
                    failures.append(error)

            with patch("notify.send_notification", side_effect=lambda event, _: events.append(event)):
                thread = threading.Thread(target=run)
                thread.start()
                try:
                    wait_for(lambda: bridge.initialized and not bridge.first_snapshot)
                    http.payload = [{"id": "a", "text": "hello"}]
                    wait_for(lambda: any(e["type"] == "task_completed" and e["request_id"] == "a" for e in events))
                    http.payload = [*http.payload, {"id": "q", "text": "/ask"}]
                    wait_for(lambda: any(e["type"] == "confirmation_request" for e in events))
                    http.payload = [*http.payload, {"id": "status", "text": "/status"}]
                    wait_for(lambda: any(e["request_id"] == "status" for e in events))
                    http.payload = [*http.payload, {"id": "answer", "text": "/confirm fixture-question"}]
                    wait_for(lambda: any(e["type"] == "task_completed" and e["request_id"] == "q" for e in events))
                    http.payload = [*http.payload, {"id": "new", "text": "/new"}, {"id": "b", "text": "after new"}]
                    wait_for(lambda: any(e["type"] == "task_completed" and e["request_id"] == "b" for e in events))
                    self.assertEqual(sum(e["type"] == "assistant_message" and e["request_id"] == "a" for e in events), 1)
                    self.assertTrue(any(e["request_id"] == "b" and e["session_id"] == "fake-2" for e in events))
                    self.assertNotIn("DO_NOT_FORWARD", json.dumps(events))
                    http.payload = [*http.payload, {"id": "w", "text": "wait"}]
                    wait_for(lambda: bridge.active and bridge.active.id == "w" and bridge.started)
                    http.payload = [*http.payload, {"id": "queued", "text": "cancel me"},
                                    {"id": "stop", "text": "/stop"}]
                    wait_for(lambda: any(e["type"] == "task_cancelled" and e["request_id"] == "w" for e in events))
                    self.assertTrue(any(e["type"] == "task_cancelled" and e["request_id"] == "queued" for e in events))
                    http.payload = [*http.payload, {"id": "c", "text": "after stop"}]
                    wait_for(lambda: any(e["type"] == "task_completed" and e["request_id"] == "c" for e in events))
                finally:
                    bridge.stop_event.set()
                    thread.join(timeout=5)
                self.assertFalse(thread.is_alive())
                self.assertEqual(failures, [])


    def test_subprocess_exit_notifies_without_automatic_restart(self):
        http = HttpFixture()
        self.addCleanup(http.close)
        with tempfile.TemporaryDirectory() as temp:
            settings = config(temp)
            settings["inbox"]["url"] = http.url
            http.payload = [{"id": "crash-id", "text": "crash"}]
            bridge = Bridge(settings)
            events = []
            with patch("notify.send_notification", side_effect=lambda event, _: events.append(event)):
                with self.assertRaisesRegex(RuntimeError, "pi exited"):
                    bridge.run()
            self.assertTrue(any(e["type"] == "error" and e["request_id"] == "crash-id" for e in events))
            self.assertIn("crash-id", bridge.seen)


if __name__ == "__main__":
    unittest.main()
