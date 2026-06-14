"""Daemon thread that tails agy.log and fires teardown on a rate-limit signal.

agy.log is the only deterministic continuous rate-limit signal: gauntlet does
not stream the agy tmux pane, so polling the log is the sole way to detect
RESOURCE_EXHAUSTED / 429 while the agy run is in flight.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from pathlib import Path

from quorum.agy_teardown import kill_run_tmux_server
from quorum.runner import _agy_log_shows_rate_limit


class AgyRateLimitWatcher(threading.Thread):
    """Poll *log_path* for rate-limit signals and call *teardown* on first hit.

    Tolerates the log file being absent at start — agy creates it late. Assumes
    a single append-only run log; log rotation / truncation under the watcher is
    out of scope and would stall detection — acceptable because each run gets its
    own fresh log.
    """

    def __init__(
        self,
        log_path: Path,
        teardown_target: Path,
        *,
        teardown: Callable[[Path], object] | None = None,
        poll_interval: float = 0.5,
    ) -> None:
        super().__init__(daemon=True)
        self._log_path = Path(log_path)
        # Opaque arg handed to teardown(); the default teardown expects the run
        # dir and globs to the scratch dir itself, so this is not a scratch dir.
        self._teardown_target = teardown_target
        self._teardown = teardown if teardown is not None else kill_run_tmux_server
        self._poll_interval = poll_interval
        self._stop_event = threading.Event()

        # Public state — written before tripped is set to True so readers that
        # check tripped always find matched_text already populated.
        self.matched_text: str = ""
        self.tripped: bool = False

    def run(self) -> None:
        offset = 0
        while not self._stop_event.is_set():
            try:
                if self._log_path.exists():
                    with self._log_path.open("rb") as fh:
                        fh.seek(offset)
                        new_bytes = fh.read()
                    if new_bytes:
                        new_text = new_bytes.decode("utf-8", errors="replace")
                        offset += len(new_bytes)
                        if _agy_log_shows_rate_limit(new_text):
                            self.matched_text = new_text
                            self._teardown(self._teardown_target)
                            # Set flag last so readers always see matched_text
                            # and teardown side-effect before tripped=True.
                            self.tripped = True
                            return
            except OSError:
                pass  # file disappeared mid-read; keep waiting
            self._stop_event.wait(self._poll_interval)

    def stop(self, timeout: float = 2.0) -> None:
        """Signal the polling loop to exit and join the thread.

        Safe to call even if the thread was never started.
        """
        self._stop_event.set()
        if self.ident is not None:  # only join a thread that was actually started
            self.join(timeout=timeout)
