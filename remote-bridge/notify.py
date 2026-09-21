"""Adapt send_notification() to the company's bot notification contract."""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from uuid import uuid4

from inbox import http_json, local_path

LOG = logging.getLogger("remote.notification")


def make_event(kind: str, request_id: str | None, session_id: str | None,
               text: str, **fields) -> dict:
    return {
        "event_id": str(uuid4()), "request_id": request_id, "session_id": session_id,
        "type": kind, "text": text,
        "created_at": datetime.now(timezone.utc).isoformat(), **fields,
    }


def send_notification(event: dict, config: dict) -> None:
    """Dedicated worker, not the pi stdout reader.

    Default: print the assembled JSON event. An optional URL receives the same
    object by HTTP POST. Replace this function for a different notification API.
    """
    options = config["notification"]
    line = json.dumps(event, ensure_ascii=False)
    print(line, flush=True)
    if options.get("jsonl_path"):
        path = local_path(config, options["jsonl_path"])
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as output:
            output.write(line + "\n")
    if options.get("url"):
        ca = options.get("ca_file")
        http_json(
            options["url"], headers=options.get("headers", {}),
            timeout=options.get("timeout_seconds", 10), body=event,
            ca_file=str(local_path(config, ca)) if ca else None,
        )


def notification_worker(outbox, config: dict) -> None:
    while True:
        event = outbox.get()
        try:
            if event is None:
                return
            send_notification(event, config)
        except Exception as error:
            # No automatic notification replay and never rerun an agent task.
            LOG.warning("Notification failed event_id=%s (%s)", event["event_id"], type(error).__name__)
        finally:
            outbox.task_done()
