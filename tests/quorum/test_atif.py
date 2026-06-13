"""Tests for best-effort ATIF trajectory emission (quorum/atif.py).

The ATIF path is additive: it shells out to the bun normalizer to write
trajectory.json next to the flat-JSONL capture, and must never raise into the
run or change the verdict. These tests assert a real claude session log
produces a valid-looking ATIF trajectory, and that every failure mode
(unsupported normalizer, missing session log, bun failure) returns False
without raising and without writing a trajectory.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from quorum.atif import (
    ATIF_SUPPORTED_NORMALIZERS,
    ATIF_TRAJECTORY_FILENAME,
    emit_atif_trajectory,
    supports_atif,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
TS_ROOT = REPO_ROOT / "ts"

# Minimal codex session log: a single function_call response_item.
CODEX_SESSION = "\n".join(
    [
        json.dumps(
            {
                "type": "response_item",
                "payload": {
                    "type": "function_call",
                    "name": "exec_command",
                    "arguments": json.dumps({"cmd": "ls /tmp", "workdir": "/tmp"}),
                    "call_id": "call_1",
                },
            }
        ),
    ]
)

# A minimal claude session log in the legacy projects/*.jsonl layout the
# normalize-claude.ts CLI consumes: one user turn, one assistant turn with a
# tool_use, and its tool_result.
CLAUDE_SESSION = "\n".join(
    [
        json.dumps({"type": "user", "message": {"role": "user", "content": "make hello.txt"}}),
        json.dumps(
            {
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type": "text", "text": "Writing the file."},
                        {
                            "type": "tool_use",
                            "id": "toolu_01",
                            "name": "Write",
                            "input": {"file_path": "hello.txt", "content": "hi"},
                        },
                    ],
                },
            }
        ),
        json.dumps(
            {
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": "toolu_01",
                            "content": "ok",
                        }
                    ],
                },
            }
        ),
    ]
)


def _write_session(tmp_path: Path, content: str = CLAUDE_SESSION) -> Path:
    session = tmp_path / "session-abc.jsonl"
    session.write_text(content + "\n")
    return session


def test_supports_atif_all_six_normalizers():
    """supports_atif returns True for all six TS-backed normalizers."""
    for name in ("claude", "codex", "gemini", "copilot", "opencode", "pi"):
        assert supports_atif(name) is True, f"expected True for normalizer {name!r}"
    assert {"claude", "codex", "gemini", "copilot", "opencode", "pi"} == ATIF_SUPPORTED_NORMALIZERS


def test_supports_atif_false_for_unsupported():
    """supports_atif returns False for normalizers without a TS implementation."""
    assert supports_atif("kimi") is False
    assert supports_atif("antigravity") is False
    assert supports_atif("unknown") is False


@pytest.mark.skipif(shutil.which("bun") is None, reason="bun not installed")
def test_emit_writes_valid_atif_trajectory(tmp_path):
    session = _write_session(tmp_path)
    out_path = tmp_path / ATIF_TRAJECTORY_FILENAME

    ok = emit_atif_trajectory(
        session_log_path=session,
        out_path=out_path,
        normalizer="claude",
        version="2.1.175",
        ts_root=TS_ROOT,
    )

    assert ok is True
    assert out_path.exists()
    traj = json.loads(out_path.read_text())
    assert traj["schema_version"] == "ATIF-v1.7"
    assert traj["agent"]["version"] == "2.1.175"
    assert isinstance(traj["steps"], list) and traj["steps"]


def test_emit_unsupported_normalizer_returns_false_no_file(tmp_path):
    # kimi has no TS normalizer yet; must return False without writing anything.
    session = _write_session(tmp_path)
    out_path = tmp_path / ATIF_TRAJECTORY_FILENAME

    ok = emit_atif_trajectory(
        session_log_path=session,
        out_path=out_path,
        normalizer="kimi",
        version="unknown",
        ts_root=TS_ROOT,
    )

    assert ok is False
    assert not out_path.exists()


def test_emit_missing_session_log_returns_false_no_file(tmp_path):
    out_path = tmp_path / ATIF_TRAJECTORY_FILENAME

    ok = emit_atif_trajectory(
        session_log_path=tmp_path / "does-not-exist.jsonl",
        out_path=out_path,
        normalizer="claude",
        version="unknown",
        ts_root=TS_ROOT,
    )

    assert ok is False
    assert not out_path.exists()


def test_emit_bun_launch_failure_returns_false_no_raise(tmp_path):
    """A missing bun binary must not raise and must not write a trajectory."""
    session = _write_session(tmp_path)
    out_path = tmp_path / ATIF_TRAJECTORY_FILENAME

    ok = emit_atif_trajectory(
        session_log_path=session,
        out_path=out_path,
        normalizer="claude",
        version="unknown",
        ts_root=TS_ROOT,
        bun=str(tmp_path / "no-such-bun-binary"),
    )

    assert ok is False
    assert not out_path.exists()


@pytest.mark.skipif(shutil.which("bun") is None, reason="bun not installed")
def test_emit_normalizer_error_returns_false(tmp_path):
    """A bad ts_root (normalizer CLI absent) makes bun exit non-zero -> False."""
    session = _write_session(tmp_path)
    out_path = tmp_path / ATIF_TRAJECTORY_FILENAME

    ok = emit_atif_trajectory(
        session_log_path=session,
        out_path=out_path,
        normalizer="claude",
        version="unknown",
        ts_root=tmp_path / "nonexistent-ts-root",
    )

    assert ok is False
    assert not out_path.exists()


@pytest.mark.skipif(shutil.which("bun") is None, reason="bun not installed")
def test_emit_codex_writes_valid_atif_trajectory(tmp_path):
    """codex normalizer emits a valid ATIF trajectory via the unified CLI."""
    session = _write_session(tmp_path, content=CODEX_SESSION)
    out_path = tmp_path / ATIF_TRAJECTORY_FILENAME

    ok = emit_atif_trajectory(
        session_log_path=session,
        out_path=out_path,
        normalizer="codex",
        version="1.0.0",
        ts_root=TS_ROOT,
    )

    assert ok is True
    assert out_path.exists()
    traj = json.loads(out_path.read_text())
    assert traj["schema_version"] == "ATIF-v1.7"
    assert traj["agent"]["name"] == "codex"
    assert traj["agent"]["version"] == "1.0.0"
    assert isinstance(traj["steps"], list) and traj["steps"]
