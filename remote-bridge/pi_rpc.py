"""One long-lived pi JSONL subprocess; local pipes never cross the network."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import signal
import subprocess
import threading
from pathlib import Path

from inbox import local_path

LOG = logging.getLogger("remote.pi")


def launch_options(config: dict) -> tuple[list[str], Path, dict[str, str]]:
    options = config["pi"]
    repo = local_path(config, options.get("repo_dir", ".."))
    cwd = local_path(config, options.get("cwd", ".."))
    if not cwd.is_dir():
        raise ValueError(f"pi.cwd is not a directory: {cwd}")
    command = options.get("command")
    if command is None:
        # Resolve the installed bin rather than using a .cmd wrapper or shell.
        package = repo / "node_modules" / "tsx" / "package.json"
        if not package.is_file():
            raise ValueError("tsx is missing; install this repository's existing dependencies first")
        metadata = json.loads(package.read_text(encoding="utf-8"))
        entry = metadata.get("bin")
        entry = entry.get("tsx") if isinstance(entry, dict) else entry
        if not isinstance(entry, str):
            raise ValueError("Cannot locate the installed tsx executable")
        command = [
            options.get("node", "node"), str((package.parent / entry).resolve()),
            "--tsconfig", str(repo / "tsconfig.json"),
            str(repo / "packages/coding-agent/src/cli.ts"),
        ]
    if not isinstance(command, list) or not command or not all(isinstance(x, str) for x in command):
        raise ValueError("pi.command must be a nonempty argument array, not a shell string")
    # Dedicated history per cwd: do not take over a desktop TUI session by default.
    workspace = hashlib.sha256(os.path.normcase(str(cwd)).encode()).hexdigest()[:12]
    session_dir = local_path(config, options.get("session_dir", ".local/sessions")) / workspace
    session_dir.mkdir(parents=True, exist_ok=True)
    command = [*command, "--mode", "rpc", "--session-dir", str(session_dir)]
    if options.get("session_file"):
        command += ["--session", str(local_path(config, options["session_file"]))]
    elif options.get("resume", True):
        command.append("--continue")
    env = os.environ.copy()
    env["PI_PACKAGE_DIR"] = str(repo / "packages/coding-agent")
    env["PI_WORK_DIR"] = str(cwd)
    if options.get("agent_dir"):
        env["DAAS_CODING_AGENT_DIR"] = str(local_path(config, options["agent_dir"]))
    return command, cwd, env


class PiProcess:
    def __init__(self, config: dict, bus):
        self.config, self.bus = config, bus
        self.process = None
        self.write_lock = threading.Lock()
        self.threads: list[threading.Thread] = []

    def start(self) -> None:
        command, cwd, env = launch_options(self.config)
        self.process = subprocess.Popen(
            command, cwd=cwd, env=env, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=os.name != "nt", shell=False,
        )
        for target in (self._stdout, self._stderr):
            thread = threading.Thread(target=target, daemon=True)
            thread.start()
            self.threads.append(thread)

    def send(self, payload: dict) -> None:
        if self.process is None or self.process.poll() is not None:
            raise RuntimeError("pi process is not running")
        data = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        with self.write_lock:
            self.process.stdin.write(data)
            self.process.stdin.flush()

    def _stdout(self) -> None:
        # Binary iteration splits on LF, not Unicode U+2028/U+2029.
        for line in self.process.stdout:
            try:
                event = json.loads(line.decode("utf-8"))
                if not isinstance(event, dict):
                    raise ValueError("RPC record must be an object")
                self.bus.put(("rpc", event))
            except (UnicodeError, ValueError):
                LOG.warning("Ignoring a non-JSON RPC stdout line")
        self.bus.put(("exit", self.process.wait()))

    def _stderr(self) -> None:
        for line in self.process.stderr:
            LOG.info("pi: %s", line.decode("utf-8", errors="replace").rstrip())

    def close(self) -> None:
        if self.process is None:
            return
        try:
            if self.process.stdin:
                self.process.stdin.close()
            self.process.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            if self.process.poll() is None:
                if os.name == "nt":
                    subprocess.run(
                        ["taskkill", "/PID", str(self.process.pid), "/T", "/F"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
                    )
                else:
                    try:
                        os.killpg(self.process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                self.process.wait(timeout=5)
        finally:
            for thread in self.threads:
                thread.join(timeout=1)
            for stream in (self.process.stdout, self.process.stderr):
                if stream:
                    stream.close()
