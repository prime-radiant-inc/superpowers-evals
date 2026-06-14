"""Task 5: invoke_gauntlet runs the agy rate-limit watcher alongside gauntlet.

These tests drive a real subprocess (a fake `gauntlet` script) so the Popen +
watcher wiring is exercised end-to-end, with the teardown injected as a fast
stub. The real teardown (kill the gauntlet tmux server) is covered by Task 3.
"""

import os
import stat
import sys
import time
from pathlib import Path
from unittest.mock import patch

from quorum.runner import _kill_gauntlet_tmux_for_run, invoke_gauntlet


def _write_fake_gauntlet(path: Path, body: str) -> None:
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _gauntlet_writing_result(run_dir: Path, status: str) -> str:
    """A fake gauntlet that writes a valid result.json then exits 0."""
    results = run_dir / "gauntlet-agent" / "results" / "run-1"
    return (
        f"#!{sys.executable}\n"
        "import json, pathlib\n"
        f"results = pathlib.Path({str(results)!r})\n"
        "results.mkdir(parents=True, exist_ok=True)\n"
        f"(results / 'result.json').write_text(json.dumps({{'status': {status!r}}}))\n"
    )


def _gauntlet_429_then_wait_for_teardown(run_dir: Path, teardown_signal: Path) -> str:
    """A fake gauntlet: write RESOURCE_EXHAUSTED into agy.log, then run until
    torn down.

    Mirrors the real failure: gauntlet keeps driving agy when the Code Assist
    window trips, and only exits once the teardown reaps its tmux server. The
    real teardown kills a tmux server (which ends agy, then gauntlet); here the
    teardown stub touches `teardown_signal`, and this script polls for it and
    exits — modelling "teardown ends gauntlet" without the stub needing the
    Popen handle. The hard timeout is the test's safety net, not the path under
    test: without a tripping watcher this would hang well past it.
    """
    log = run_dir / "coding-agent-config" / "agy.log"
    return (
        f"#!{sys.executable}\n"
        "import pathlib, time\n"
        f"log = pathlib.Path({str(log)!r})\n"
        f"signal = pathlib.Path({str(teardown_signal)!r})\n"
        "log.parent.mkdir(parents=True, exist_ok=True)\n"
        "log.write_text('googleapi: Error 429: RESOURCE_EXHAUSTED\\n')\n"
        "deadline = time.time() + 60\n"
        "while time.time() < deadline:\n"
        "    if signal.exists():\n"
        "        break\n"
        "    time.sleep(0.02)\n"
    )


def _put_on_path(monkeypatch, fake_gauntlet: Path) -> None:
    bin_dir = fake_gauntlet.parent
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")


def test_antigravity_midrun_rate_limit_trips_and_kills(tmp_path, monkeypatch):
    run_dir = tmp_path / "run"
    (run_dir / "coding-agent-config").mkdir(parents=True)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    teardown_signal = tmp_path / "teardown.flag"
    fake = bin_dir / "gauntlet"
    _write_fake_gauntlet(fake, _gauntlet_429_then_wait_for_teardown(run_dir, teardown_signal))
    _put_on_path(monkeypatch, fake)

    killed: list[Path] = []

    def fake_teardown(sd):
        killed.append(sd)
        teardown_signal.touch()  # model "tmux killed -> gauntlet exits"
        return True

    started = time.time()
    result = invoke_gauntlet(
        story_path=tmp_path / "story.md",
        target_binary="agy",
        launch_cwd=run_dir,
        run_dir=run_dir,
        max_time=None,
        coding_agent="antigravity",
        extra_env={"ANTIGRAVITY_CONFIG_DIR": str(run_dir / "coding-agent-config")},
        teardown=fake_teardown,
    )
    elapsed = time.time() - started

    assert result.rate_limited is True
    assert elapsed < 30, f"watcher should have killed the hung run promptly, took {elapsed:.1f}s"
    assert killed, "teardown should have been invoked on the rate-limit signal"


def test_antigravity_clean_run_does_not_trip(tmp_path, monkeypatch):
    run_dir = tmp_path / "run"
    (run_dir / "coding-agent-config").mkdir(parents=True)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake = bin_dir / "gauntlet"
    _write_fake_gauntlet(fake, _gauntlet_writing_result(run_dir, "pass"))
    _put_on_path(monkeypatch, fake)

    killed: list[Path] = []
    result = invoke_gauntlet(
        story_path=tmp_path / "story.md",
        target_binary="agy",
        launch_cwd=run_dir,
        run_dir=run_dir,
        max_time=None,
        coding_agent="antigravity",
        extra_env={"ANTIGRAVITY_CONFIG_DIR": str(run_dir / "coding-agent-config")},
        teardown=lambda sd: killed.append(sd) or True,
    )

    assert result.status == "pass"
    assert result.rate_limited is False
    assert killed == []


def test_non_antigravity_run_has_no_watcher(tmp_path, monkeypatch):
    run_dir = tmp_path / "run"
    (run_dir / "coding-agent-config").mkdir(parents=True)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake = bin_dir / "gauntlet"
    _write_fake_gauntlet(fake, _gauntlet_writing_result(run_dir, "fail"))
    _put_on_path(monkeypatch, fake)

    killed: list[Path] = []
    result = invoke_gauntlet(
        story_path=tmp_path / "story.md",
        target_binary="claude",
        launch_cwd=run_dir,
        run_dir=run_dir,
        max_time=None,
        coding_agent="claude",
        extra_env={"CLAUDE_CONFIG_DIR": str(run_dir / "coding-agent-config")},
        teardown=lambda sd: killed.append(sd) or True,
    )

    assert result.status == "fail"
    assert result.rate_limited is False
    assert killed == []


def test_kill_helper_discovers_run_scratch_dir(tmp_path):
    """The default teardown globs the gauntlet-minted runId scratch dir and
    hands that exact path to kill_run_tmux_server (Task 3 matches it by path).
    """
    run_dir = tmp_path / "run"
    scratch = run_dir / "gauntlet-agent" / "results" / "story_20260604_abcd" / "scratch"
    scratch.mkdir(parents=True)

    with patch("quorum.runner.kill_run_tmux_server", return_value=True) as kill:
        result = _kill_gauntlet_tmux_for_run(run_dir)

    assert result is True
    kill.assert_called_once_with(scratch)


def test_kill_helper_returns_false_when_no_scratch_dir(tmp_path):
    """No results dir yet (e.g. gauntlet died before starting): nothing to kill."""
    run_dir = tmp_path / "run"
    run_dir.mkdir()

    with patch("quorum.runner.kill_run_tmux_server") as kill:
        result = _kill_gauntlet_tmux_for_run(run_dir)

    assert result is False
    kill.assert_not_called()
