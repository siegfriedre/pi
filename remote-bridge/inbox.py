"""HTTP inbox adapter. No Redis client, writes, deletes or acknowledgements."""
from __future__ import annotations

import json
import logging
import os
import re
import ssl
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen

LOG = logging.getLogger("remote.inbox")


def expand_env(value):
    """Expand ${NAME} in local config only; never apply this to incoming messages."""
    if isinstance(value, str):
        def replace(match):
            name = match.group(1)
            if name not in os.environ:
                raise ValueError(f"Missing environment variable: {name}")
            return os.environ[name]
        return re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", replace, value)
    if isinstance(value, dict):
        return {key: expand_env(item) for key, item in value.items()}
    if isinstance(value, list):
        return [expand_env(item) for item in value]
    return value


def decode(value):
    # Some key APIs return JSON strings, including JSON strings inside List elements.
    for _ in range(4):
        if not isinstance(value, str):
            return value
        value = json.loads(value)
    if isinstance(value, str):
        raise ValueError("Too many JSON encoding layers")
    return value


def extract_messages(payload, path: str = "") -> list:
    value = decode(payload)
    if value is None:  # Missing key represented by JSON null.
        return []
    if path:
        for part in path.split("."):
            value = decode(value)
            if not isinstance(value, dict) or part not in value:
                raise ValueError(f"messages_path not found: {path}")
            value = value[part]
            if value is None:
                return []
    value = decode(value)
    if not isinstance(value, list):
        raise ValueError("Inbox must resolve to an array; check messages_path")
    return value


@dataclass(frozen=True)
class Message:
    id: str
    text: str
    expires_at: datetime | None = None

    @classmethod
    def parse(cls, raw) -> "Message":
        raw = decode(raw)
        if not isinstance(raw, dict):
            raise ValueError("Message must be an object")
        msg_id, text = raw.get("id"), raw.get("text")
        if isinstance(msg_id, bool) or not isinstance(msg_id, (str, int)):
            raise ValueError("Message id must be a nonempty string or integer")
        if not str(msg_id).strip() or not isinstance(text, str) or not text.strip():
            raise ValueError("Message id/text cannot be empty")
        expires = raw.get("expires_at")
        if expires is not None:
            if not isinstance(expires, str):
                raise ValueError("expires_at must be an ISO-8601 string or null")
            expires = datetime.fromisoformat(expires.replace("Z", "+00:00"))
            if expires.tzinfo is None:
                raise ValueError("expires_at must include a timezone")
        return cls(str(msg_id), text, expires)

    def expired(self) -> bool:
        return self.expires_at is not None and datetime.now(timezone.utc) >= self.expires_at


def load_config(path: Path) -> dict:
    config = expand_env(json.loads(path.read_text(encoding="utf-8-sig")))
    if not isinstance(config, dict):
        raise ValueError("Config must be a JSON object")
    for section in ("inbox", "pi", "notification"):
        if not isinstance(config.setdefault(section, {}), dict):
            raise ValueError(f"{section} must be an object")
    inbox = config["inbox"]
    url = inbox.get("url", "")
    if not isinstance(url, str) or urlsplit(url).scheme not in ("http", "https"):
        raise ValueError("inbox.url must be an http(s) URL")
    if inbox.get("startup_policy", "skip") not in ("skip", "process"):
        raise ValueError("startup_policy must be skip or process")
    for section, key, default in (
        ("inbox", "poll_seconds", 10), ("inbox", "timeout_seconds", 10),
        ("pi", "startup_timeout_seconds", 30), ("pi", "ui_timeout_seconds", 300),
        ("notification", "timeout_seconds", 10),
    ):
        value = config[section].get(key, default)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 < value < float("inf"):
            raise ValueError(f"{section}.{key} must be positive and finite")
    config["_base"] = str(path.resolve().parent)
    return config


def local_path(config: dict, value: str) -> Path:
    path = Path(value).expanduser()
    return (Path(config["_base"]) / path).resolve() if not path.is_absolute() else path.resolve()


def http_json(url: str, *, headers: dict, timeout: float, body=None, ca_file=None):
    """GET when body is None; POST only for an explicitly configured notification."""
    if urlsplit(url).scheme not in ("http", "https"):
        raise ValueError("Only http(s) URLs are supported")
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = Request(
        url, data=data, method="GET" if body is None else "POST",
        headers={"Accept": "application/json", "Cache-Control": "no-cache",
                 **({"Content-Type": "application/json; charset=utf-8"} if data is not None else {}),
                 **headers},
    )
    context = ssl.create_default_context(cafile=ca_file) if ca_file else None
    with urlopen(request, timeout=timeout, context=context) as response:
        content = response.read(8 * 1024 * 1024 + 1)
    if len(content) > 8 * 1024 * 1024:
        raise ValueError("HTTP response exceeds 8 MiB")
    # Notification endpoints may return plain text or an empty body.
    if body is not None:
        return None
    return json.loads(content.decode("utf-8-sig")) if content else None


def fetch_messages(config: dict) -> list:
    """The only inbox network operation is an HTTP GET."""
    options = config["inbox"]
    parts = urlsplit(options["url"])
    query = parse_qsl(parts.query, keep_blank_values=True)
    query.extend(options.get("query", {}).items())
    url = urlunsplit(parts._replace(query=urlencode(query, doseq=True)))
    ca = options.get("ca_file")
    payload = http_json(
        url, headers=options.get("headers", {}),
        timeout=options.get("timeout_seconds", 10),
        ca_file=str(local_path(config, ca)) if ca else None,
    )
    return extract_messages(payload, options.get("messages_path", ""))


def poll_inbox(config: dict, bus, stop) -> None:
    while not stop.is_set():
        try:
            bus.put(("inbox", fetch_messages(config)))
        except Exception as error:
            # No headers, credentials or full response bodies in error logs.
            LOG.warning("Inbox GET failed (%s); retrying on next poll", type(error).__name__)
        stop.wait(config["inbox"].get("poll_seconds", 10))
