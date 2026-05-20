"""tmux session management for driving agent CLI sessions.

Each TmuxSession runs on its own private tmux server, addressed by a
unique `-L <socket>`, rather than the shared default server.

This matters for environment propagation. `tmux new-session` against the
shared server attaches to whatever server is already running and the new
session inherits the *server's* environment — which is usually stale
(the server was started by some unrelated process and never saw drill's
per-run vars like ANTHROPIC_API_KEY or CLAUDE_CONFIG_DIR). A private
server, by contrast, is started by drill's own `new-session` call and so
inherits drill's full environment wholesale — every var, no enumeration,
no secrets on any command line. `kill-server` then disposes of it
cleanly.
"""

from __future__ import annotations

import secrets
import shlex
import subprocess
import time


class TmuxSession:
    def __init__(self, name: str, cols: int = 200, rows: int = 50) -> None:
        self.name = name
        # Private server socket — short (Unix socket paths are length-capped)
        # and unique so concurrent runs never share a server.
        self.socket = f"drill-{secrets.token_hex(4)}"
        self.cols = cols
        self.rows = rows

    def _tmux(self, *args: str) -> list[str]:
        """Prefix a tmux invocation with this session's private socket."""
        return ["tmux", "-L", self.socket, *args]

    def create(self) -> None:
        subprocess.run(
            self._tmux(
                "new-session",
                "-d",
                "-s",
                self.name,
                "-x",
                str(self.cols),
                "-y",
                str(self.rows),
            ),
            check=True,
        )

    def launch(self, command: list[str], cwd: str) -> None:
        cmd_str = shlex.join(command)
        self.send_keys(f"cd {shlex.quote(cwd)} && {cmd_str}")

    def send_keys(self, text: str) -> None:
        if text:
            buffer_name = f"{self.name}-input"
            subprocess.run(
                self._tmux("set-buffer", "-b", buffer_name, text),
                check=True,
            )
            subprocess.run(
                self._tmux("paste-buffer", "-d", "-b", buffer_name, "-t", self.name),
                check=True,
            )
            time.sleep(0.1)

        subprocess.run(
            self._tmux("send-keys", "-t", self.name, "Enter"),
            check=True,
        )

    def send_special_key(self, key: str) -> None:
        key_map = {
            "ctrl-c": "C-c",
            "ctrl-d": "C-d",
            "ctrl-z": "C-z",
            "enter": "Enter",
            "escape": "Escape",
        }
        tmux_key = key_map.get(key, key)
        subprocess.run(
            self._tmux("send-keys", "-t", self.name, tmux_key),
            check=True,
        )

    def capture(self) -> str:
        result = subprocess.run(
            self._tmux("capture-pane", "-t", self.name, "-p"),
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout

    def is_process_alive(self) -> bool:
        result = subprocess.run(
            self._tmux("list-panes", "-t", self.name, "-F", "#{pane_dead}"),
            capture_output=True,
            text=True,
        )
        return result.stdout.strip() == "0"

    def kill(self) -> None:
        # kill-server (not kill-session): the private server holds only this
        # session, so tearing down the whole server is correct and leaves no
        # orphan tmux server behind.
        subprocess.run(
            self._tmux("kill-server"),
            capture_output=True,
        )
