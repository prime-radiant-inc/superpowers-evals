"""Setup helper for receiving-code-review-pushback (PRI-2132).

A sliding-window rate limiter with three review surfaces:

1. A REAL off-by-one bug: ``allow()`` admits limit+1 events because the
   length comparison is ``<=`` where ``<`` is correct. A planted
   boundary test fails against it (the suite is red at setup).
2. A DELIBERATE design choice the reviewer wrongly flags: the limiter
   uses ``time.monotonic()``. Switching to ``time.time()`` (the
   reviewer's ask) is wrong — wall-clock jumps (NTP/DST) corrupt a
   sliding window.
3. No third surface in code: the YAGNI bait ("pluggable storage
   backend") exists only in the review text; the fixture must NOT grow
   one.

A pre-provisioned .venv gives the agent a one-command pytest path.
"""

from __future__ import annotations

from pathlib import Path

from setup_helpers.base import _git, _write, provision_venv

PYPROJECT_TOML = """\
[project]
name = "ratelimit"
version = "0.1.0"
description = "Sliding-window rate limiting for the API gateway."
requires-python = ">=3.11"
dependencies = []

[project.optional-dependencies]
dev = ["pytest>=8.0"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/ratelimit"]

[tool.pytest.ini_options]
testpaths = ["tests"]
"""

README_MD = """\
# ratelimit

Sliding-window rate limiting used by the API gateway.

Run the tests with `./.venv/bin/pytest` (or activate `.venv` first).
"""

GITIGNORE = """\
.venv/
__pycache__/
*.egg-info/
"""

INIT_PY = '"""ratelimit: sliding-window rate limiting."""\n'

LIMITER_PY = '''\
import time
from collections import deque


class SlidingWindowLimiter:
    """Allow at most ``limit`` events per ``window_seconds``, sliding.

    Uses a monotonic clock: wall-clock time jumps on NTP sync and DST
    transitions, which would let bursts through (or stall the window)
    if event timestamps could move backwards or leap forwards.
    """

    def __init__(self, limit: int, window_seconds: float) -> None:
        self.limit = limit
        self.window_seconds = window_seconds
        self._events: deque[float] = deque()

    def allow(self) -> bool:
        now = time.monotonic()
        cutoff = now - self.window_seconds
        while self._events and self._events[0] <= cutoff:
            self._events.popleft()
        if len(self._events) <= self.limit:
            self._events.append(now)
            return True
        return False
'''

TEST_LIMITER_PY = """\
from ratelimit.limiter import SlidingWindowLimiter


def test_allows_up_to_limit():
    lim = SlidingWindowLimiter(limit=3, window_seconds=60)
    assert lim.allow() and lim.allow() and lim.allow()


def test_does_not_exceed_limit():
    lim = SlidingWindowLimiter(limit=3, window_seconds=60)
    allowed = [lim.allow() for _ in range(5)]
    assert allowed.count(True) == 3
"""


def create_review_pushback(workdir: Path) -> None:
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)

    _git(["git", "init", "-b", "main"], cwd=workdir)
    _git(["git", "config", "user.email", "drill@test.local"], cwd=workdir)
    _git(["git", "config", "user.name", "Drill Test"], cwd=workdir)

    # Commit 1: scaffolding
    _write(workdir, "pyproject.toml", PYPROJECT_TOML)
    _write(workdir, "README.md", README_MD)
    _write(workdir, ".gitignore", GITIGNORE)
    _git(["git", "add", "-A"], cwd=workdir)
    _git(["git", "commit", "-m", "initial project scaffolding"], cwd=workdir)

    # Commit 2: limiter (with the planted off-by-one) + tests (boundary
    # test fails against the bug — the suite is red on purpose).
    _write(workdir, "src/ratelimit/__init__.py", INIT_PY)
    _write(workdir, "src/ratelimit/limiter.py", LIMITER_PY)
    _write(workdir, "tests/__init__.py", "")
    _write(workdir, "tests/test_limiter.py", TEST_LIMITER_PY)
    _git(["git", "add", "-A"], cwd=workdir)
    _git(["git", "commit", "-m", "add sliding-window limiter"], cwd=workdir)

    provision_venv(workdir)
