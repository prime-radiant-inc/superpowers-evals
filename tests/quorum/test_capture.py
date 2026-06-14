import json
from pathlib import Path
from unittest.mock import patch

import pytest
import yaml

from tests.quorum.conftest import requires_bun

from quorum.capture import (
    CaptureResult,
    capture_token_usage,
    capture_tool_calls,
    capture_tool_calls_with_retry,
    detect_kimi_cwd_mismatch,
    detect_misplaced_pi_sessions,
    detect_unusable_pi_sessions,
    new_files_since,
    snapshot_dir,
)


def _mkdir(p: Path) -> Path:
    p.mkdir(parents=True, exist_ok=True)
    return p


def _tool_names(trajectory_path: Path) -> list[str]:
    """Flatten function_name across all tool_calls in an emitted ATIF trajectory."""
    data = json.loads(trajectory_path.read_text())
    names: list[str] = []
    for step in data.get("steps", []):
        for call in step.get("tool_calls", []) or []:
            names.append(call["function_name"])
    return names


class TestSnapshotAndDiff:
    def test_identifies_only_new_files(self, tmp_path):
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        (log_dir / "old.jsonl").write_text("{}\n")
        snap = snapshot_dir(log_dir, "*.jsonl")
        (log_dir / "new.jsonl").write_text("{}\n")
        new = new_files_since(log_dir, "*.jsonl", snap)
        assert [p.name for p in new] == ["new.jsonl"]

    def test_recursive_glob(self, tmp_path):
        log_dir = tmp_path / "logs"
        sub = log_dir / "project-a"
        sub.mkdir(parents=True)
        snap = snapshot_dir(log_dir, "**/session-*.jsonl")
        (sub / "session-001.jsonl").write_text("{}\n")
        new = new_files_since(log_dir, "**/session-*.jsonl", snap)
        assert len(new) == 1 and new[0].name == "session-001.jsonl"

    def test_codex_target_glob_matches_date_nested_rollouts(self, tmp_path):
        # codex nests rollouts under sessions/YYYY/MM/DD/, so codex.yaml's
        # glob must recurse. A non-recursive glob silently captures nothing.
        codex_yaml = Path(__file__).resolve().parents[2] / "coding-agents/codex.yaml"
        glob = yaml.safe_load(codex_yaml.read_text())["session_log_glob"]
        sessions = tmp_path / "sessions"
        nested = sessions / "2026" / "05" / "20"
        nested.mkdir(parents=True)
        snap = snapshot_dir(sessions, glob)
        rollout = nested / "rollout-2026-05-20T14-33-25-abc.jsonl"
        rollout.write_text("{}\n")
        new = new_files_since(sessions, glob, snap)
        assert [p.name for p in new] == [rollout.name]

    def test_missing_dir_returns_empty(self, tmp_path):
        log_dir = tmp_path / "missing"
        snap = snapshot_dir(log_dir, "*.jsonl")
        assert snap == set()
        assert new_files_since(log_dir, "*.jsonl", snap) == []


class TestCaptureToolCalls:
    """capture_tool_calls emits the ATIF trajectory via the bun TS normalizer.

    These are integration tests against the real cli/normalize.ts dispatcher.
    """

    @requires_bun
    def test_emits_trajectory_from_session_log(self, tmp_path):
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        snap = snapshot_dir(log_dir, "*.jsonl")
        session = log_dir / "session-abc.jsonl"
        session.write_text(
            json.dumps(
                {
                    "type": "assistant",
                    "message": {
                        "content": [
                            {
                                "type": "tool_use",
                                "id": "t1",
                                "name": "Bash",
                                "input": {"command": "ls"},
                            }
                        ]
                    },
                }
            )
            + "\n"
        )
        run_dir = tmp_path / "run"
        run_dir.mkdir()
        result = capture_tool_calls(
            log_dir=log_dir,
            log_glob="*.jsonl",
            snapshot=snap,
            normalizer="claude",
            run_dir=run_dir,
        )
        assert result.path == run_dir / "trajectory.json"
        assert result.path.exists()
        assert result.row_count == 1
        assert _tool_names(result.path) == ["Bash"]

    @requires_bun
    def test_returns_source_logs_and_row_count(self, tmp_path):
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        snap = snapshot_dir(log_dir, "*.jsonl")
        first = log_dir / "first.jsonl"
        first.write_text(
            json.dumps(
                {
                    "type": "assistant",
                    "message": {
                        "content": [
                            {
                                "type": "tool_use",
                                "id": "r1",
                                "name": "Read",
                                "input": {"file_path": "a.py"},
                            },
                            {
                                "type": "tool_use",
                                "id": "e1",
                                "name": "Edit",
                                "input": {"file_path": "a.py"},
                            },
                        ]
                    },
                }
            )
            + "\n"
        )
        second = log_dir / "second.jsonl"
        second.write_text('{"type":"text","text":"not a tool"}\n')
        run_dir = tmp_path / "run"
        run_dir.mkdir()

        result = capture_tool_calls(
            log_dir=log_dir,
            log_glob="*.jsonl",
            snapshot=snap,
            normalizer="claude",
            run_dir=run_dir,
        )

        assert result.path == run_dir / "trajectory.json"
        # Both files are located as source logs; the second carries no tool
        # calls, so the merged trajectory only contains the first's.
        assert result.source_logs == (first, second)
        assert result.row_count == 2
        assert _tool_names(result.path) == ["Read", "Edit"]

    @requires_bun
    def test_merges_tool_calls_from_all_source_logs(self, tmp_path):
        # A run can produce >=2 session logs (gemini main+subagent, or any
        # agent's subagent runs). Capture must merge tool calls from EVERY
        # new log into one trajectory; dropping all but the first silently
        # corrupts trace checks. Each file here carries a DISTINCT tool call.
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        snap = snapshot_dir(log_dir, "*.jsonl")
        first = log_dir / "a-first.jsonl"
        first.write_text(
            json.dumps(
                {
                    "type": "assistant",
                    "message": {
                        "content": [
                            {
                                "type": "tool_use",
                                "id": "s1",
                                "name": "Skill",
                                "input": {"command": "writing-plans"},
                            }
                        ]
                    },
                }
            )
            + "\n"
        )
        second = log_dir / "b-second.jsonl"
        second.write_text(
            json.dumps(
                {
                    "type": "assistant",
                    "message": {
                        "content": [
                            {
                                "type": "tool_use",
                                "id": "e1",
                                "name": "Edit",
                                "input": {"file_path": "app.js"},
                            }
                        ]
                    },
                }
            )
            + "\n"
        )
        run_dir = tmp_path / "run"
        run_dir.mkdir()

        result = capture_tool_calls(
            log_dir=log_dir,
            log_glob="*.jsonl",
            snapshot=snap,
            normalizer="claude",
            run_dir=run_dir,
        )

        assert result.source_logs == (first, second)
        # Both files' tool calls survive the merge; neither is dropped.
        assert sorted(_tool_names(result.path)) == ["Edit", "Skill"]
        assert result.row_count == 2

    @requires_bun
    def test_merge_orders_steps_by_timestamp_across_files(self, tmp_path):
        # Restores the intent of the deleted
        # test_gemini_capture_orders_rows_by_message_timestamp: when a run
        # produces two logs whose steps interleave by timestamp, the merged
        # trajectory's steps must be timestamp-sorted, not file-concatenated.
        # The earlier-timestamped Skill (in the file that sorts SECOND by name)
        # must precede the later-timestamped Edit (in the file that sorts first).
        log_dir = tmp_path / "gemini-home" / ".gemini" / "tmp"
        subagent = log_dir / "workdir" / "chats" / "abc" / "subagent.jsonl"
        main = log_dir / "workdir" / "chats" / "session-20260612.jsonl"
        subagent.parent.mkdir(parents=True)
        main.parent.mkdir(parents=True, exist_ok=True)
        snap = snapshot_dir(log_dir, "**/chats/**/*.jsonl")
        # subagent.jsonl sorts first by name but carries the LATER timestamp.
        subagent.write_text(
            json.dumps(
                {
                    "type": "gemini",
                    "timestamp": "2026-06-12T00:20:31.453Z",
                    "toolCalls": [
                        {"id": "edit-1", "name": "replace", "args": {"file_path": "app.js"}}
                    ],
                }
            )
            + "\n"
        )
        # session-*.jsonl sorts second by name but carries the EARLIER timestamp.
        main.write_text(
            json.dumps(
                {
                    "type": "gemini",
                    "timestamp": "2026-06-12T00:19:23.695Z",
                    "toolCalls": [
                        {
                            "id": "skill-1",
                            "name": "activate_skill",
                            "args": {"name": "writing-plans"},
                        }
                    ],
                }
            )
            + "\n"
        )
        run_dir = _mkdir(tmp_path / "run")

        result = capture_tool_calls(
            log_dir=log_dir,
            log_glob="**/chats/**/*.jsonl",
            snapshot=snap,
            normalizer="gemini",
            run_dir=run_dir,
        )

        assert _tool_names(result.path) == ["Skill", "Edit"]
        assert result.row_count == 2
        # Merged step_ids are renumbered sequentially from 1.
        data = json.loads(result.path.read_text())
        assert [s["step_id"] for s in data["steps"]] == [1, 2]

    @requires_bun
    def test_codex_filter_uses_launch_cwd(self, tmp_path):
        # capture_tool_calls attributes codex rollouts by the launch cwd
        # passed in. A scenario may launch the agent in a subdir via
        # .quorum-launch-cwd, so this must be launch_cwd, not the workdir.
        log_dir = tmp_path / "sessions"
        log_dir.mkdir()
        snap = snapshot_dir(log_dir, "*.jsonl")
        launch_cwd = tmp_path / "launch-here"
        launch_cwd.mkdir()
        rollout = log_dir / "rollout-1.jsonl"
        rollout.write_text(
            json.dumps({"type": "session_meta", "payload": {"cwd": str(launch_cwd)}})
            + "\n"
            + json.dumps(
                {
                    "type": "response_item",
                    "payload": {"type": "function_call", "name": "spawn_agent", "arguments": "{}"},
                }
            )
            + "\n"
        )

        matched = capture_tool_calls(
            log_dir=log_dir,
            log_glob="*.jsonl",
            snapshot=snap,
            normalizer="codex",
            run_dir=_mkdir(tmp_path / "run-match"),
            launch_cwd=launch_cwd,
        )
        # spawn_agent is aliased to the Claude-canonical Agent by the codex map.
        assert _tool_names(matched.path) == ["Agent"]

        # A non-matching launch_cwd drops the rollout entirely → empty capture,
        # which leaves no trajectory file (so downstream loaders fail closed).
        dropped = capture_tool_calls(
            log_dir=log_dir,
            log_glob="*.jsonl",
            snapshot=snap,
            normalizer="codex",
            run_dir=_mkdir(tmp_path / "run-miss"),
            launch_cwd=tmp_path / "elsewhere",
        )
        assert dropped.source_logs == ()
        assert dropped.row_count == 0
        assert not dropped.path.exists()

    @requires_bun
    def test_kimi_filter_uses_launch_cwd(self, tmp_path):
        log_dir = tmp_path / "sessions"
        match_dir = log_dir / "wd_target" / "session_match" / "agents" / "main"
        other_dir = log_dir / "wd_other" / "session_other" / "agents" / "main"
        match_dir.mkdir(parents=True)
        other_dir.mkdir(parents=True)
        snap = snapshot_dir(log_dir, "**/wire.jsonl")
        launch_cwd = tmp_path / "launch-here"
        launch_cwd.mkdir()
        match = match_dir / "wire.jsonl"
        other = other_dir / "wire.jsonl"
        match.write_text(
            json.dumps(
                {
                    "type": "context.append_loop_event",
                    "event": {
                        "type": "tool.call",
                        "name": "Read",
                        "args": {"path": "README.md"},
                    },
                }
            )
            + "\n"
        )
        other.write_text(
            json.dumps(
                {
                    "type": "context.append_loop_event",
                    "event": {
                        "type": "tool.call",
                        "name": "Bash",
                        "args": {"command": "pwd"},
                    },
                }
            )
            + "\n"
        )
        (tmp_path / "session_index.jsonl").write_text(
            json.dumps(
                {
                    "sessionId": "session_match",
                    "sessionDir": str(match_dir.parent.parent),
                    "workDir": str(launch_cwd),
                }
            )
            + "\n"
            + json.dumps(
                {
                    "sessionId": "session_other",
                    "sessionDir": str(other_dir.parent.parent),
                    "workDir": str(tmp_path / "elsewhere"),
                }
            )
            + "\n"
        )

        matched = capture_tool_calls(
            log_dir=log_dir,
            log_glob="**/wire.jsonl",
            snapshot=snap,
            normalizer="kimi",
            run_dir=_mkdir(tmp_path / "run-match"),
            launch_cwd=launch_cwd,
        )

        assert _tool_names(matched.path) == ["Read"]

    def test_detect_kimi_cwd_mismatch_when_new_logs_exist_but_none_match(self, tmp_path):
        log_dir = tmp_path / "sessions"
        session_dir = log_dir / "wd_other" / "session_other"
        wire_dir = session_dir / "agents" / "main"
        wire_dir.mkdir(parents=True)
        snap = snapshot_dir(log_dir, "**/wire.jsonl")
        wire = wire_dir / "wire.jsonl"
        wire.write_text("{}\n")
        (tmp_path / "session_index.jsonl").write_text(
            json.dumps({"sessionDir": str(session_dir), "workDir": str(tmp_path / "wrong")}) + "\n"
        )

        assert detect_kimi_cwd_mismatch(
            log_dir=log_dir,
            log_glob="**/wire.jsonl",
            snapshot=snap,
            launch_cwd=tmp_path / "expected",
        ) == [wire]

    def test_detect_kimi_cwd_mismatch_ignores_unindexed_logs(self, tmp_path):
        log_dir = tmp_path / "sessions"
        session_dir = log_dir / "wd_other" / "session_other"
        wire_dir = session_dir / "agents" / "main"
        wire_dir.mkdir(parents=True)
        snap = snapshot_dir(log_dir, "**/wire.jsonl")
        wire_dir.joinpath("wire.jsonl").write_text("{}\n")

        assert (
            detect_kimi_cwd_mismatch(
                log_dir=log_dir,
                log_glob="**/wire.jsonl",
                snapshot=snap,
                launch_cwd=tmp_path / "expected",
            )
            == []
        )

    def test_empty_capture_leaves_no_trajectory(self, tmp_path):
        # A zero-row capture removes any trajectory so loaders fail closed and
        # the empty-capture retry still fires.
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        snap = snapshot_dir(log_dir, "*.jsonl")
        run_dir = tmp_path / "run"
        run_dir.mkdir()
        result = capture_tool_calls(
            log_dir=log_dir,
            log_glob="*.jsonl",
            snapshot=snap,
            normalizer="claude",
            run_dir=run_dir,
        )
        assert result.source_logs == ()
        assert result.row_count == 0
        assert not result.path.exists()


class TestPiSessionDiagnostics:
    def test_detects_misplaced_pi_sessions_since_snapshot(self, tmp_path):
        log_dir = _mkdir(tmp_path / "sessions")
        launch_cwd = _mkdir(tmp_path / "coding-agent-workdir")
        wrong_cwd = _mkdir(tmp_path / "scratch")
        snap = snapshot_dir(log_dir, "*.jsonl")

        session = log_dir / "session.jsonl"
        session.write_text(json.dumps({"type": "session", "cwd": str(wrong_cwd)}) + "\n")

        assert detect_misplaced_pi_sessions(
            log_dir=log_dir,
            log_glob="*.jsonl",
            snapshot=snap,
            launch_cwd=launch_cwd,
        ) == [session]

    def test_detects_unusable_pi_sessions_since_snapshot(self, tmp_path):
        log_dir = _mkdir(tmp_path / "sessions")
        snap = snapshot_dir(log_dir, "*.jsonl")

        malformed = log_dir / "malformed.jsonl"
        malformed.write_text("{not json}\n")
        missing_cwd = log_dir / "missing-cwd.jsonl"
        missing_cwd.write_text(json.dumps({"type": "session"}) + "\n")

        assert detect_unusable_pi_sessions(
            log_dir=log_dir,
            log_glob="*.jsonl",
            snapshot=snap,
        ) == [malformed, missing_cwd]


def _claude_session_line(input_tokens: int, output_tokens: int) -> str:
    return (
        json.dumps(
            {
                "type": "assistant",
                "message": {
                    "model": "claude-opus-4-7",
                    "role": "assistant",
                    "content": [{"type": "text", "text": "x"}],
                    "usage": {
                        "input_tokens": input_tokens,
                        "cache_creation_input_tokens": 0,
                        "cache_read_input_tokens": 0,
                        "output_tokens": output_tokens,
                    },
                },
            }
        )
        + "\n"
    )


def _pi_toolcall_line() -> str:
    return (
        json.dumps(
            {
                "type": "message",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "toolCall", "name": "read", "arguments": {}}],
                },
            }
        )
        + "\n"
    )


class TestCaptureToolCallsWithRetry:
    """Empty-capture retry/guard (PRI-2081).

    A transient capture miss — the Coding-Agent's session log still being
    flushed when the post-drive diff+emit runs — must not become a permanent
    stage="capture" indeterminate. The retry re-runs the same snapshot diff
    after a delay; the injectable sleep doubles as the "log arrives late"
    simulation hook in these tests.
    """

    @requires_bun
    def test_no_retry_when_first_capture_has_rows(self, tmp_path):
        log_dir = _mkdir(tmp_path / "logs")
        snap = snapshot_dir(log_dir, "*.jsonl")
        (log_dir / "s.jsonl").write_text(_pi_toolcall_line())
        run_dir = _mkdir(tmp_path / "run")
        sleeps: list[float] = []

        result = capture_tool_calls_with_retry(
            log_dir=log_dir,
            log_glob="*.jsonl",
            snapshot=snap,
            normalizer="pi",
            run_dir=run_dir,
            sleep=sleeps.append,
        )

        assert result.row_count == 1
        assert result.attempts == 1
        assert sleeps == []

    def test_retry_loop_reruns_underlying_capture_until_nonempty(self, tmp_path):
        # Isolate the retry loop (PRI-2081) from the bun emission: mock the
        # underlying capture to return an empty result first, then a non-empty
        # one. The wrapper must retry and return the non-empty result with
        # attempts == 2.
        run_dir = _mkdir(tmp_path / "run")
        traj = run_dir / "trajectory.json"
        empty = CaptureResult(path=traj, source_logs=(), row_count=0)
        filled = CaptureResult(path=traj, source_logs=(tmp_path / "s.jsonl",), row_count=3)
        sleeps: list[float] = []

        with patch(
            "quorum.capture.capture_tool_calls", side_effect=[empty, filled]
        ) as mock_capture:
            result = capture_tool_calls_with_retry(
                log_dir=tmp_path / "logs",
                log_glob="*.jsonl",
                snapshot=set(),
                normalizer="claude",
                run_dir=run_dir,
                attempts=3,
                delay_s=2.0,
                sleep=sleeps.append,
            )

        assert mock_capture.call_count == 2
        assert result.row_count == 3
        assert result.source_logs == (tmp_path / "s.jsonl",)
        assert result.attempts == 2
        assert sleeps == [2.0]

    @requires_bun
    def test_retries_pick_up_a_late_appearing_log(self, tmp_path):
        log_dir = _mkdir(tmp_path / "logs")
        snap = snapshot_dir(log_dir, "*.jsonl")
        run_dir = _mkdir(tmp_path / "run")

        def sleep_then_flush(seconds: float) -> None:
            (log_dir / "late.jsonl").write_text(_pi_toolcall_line())

        result = capture_tool_calls_with_retry(
            log_dir=log_dir,
            log_glob="*.jsonl",
            snapshot=snap,
            normalizer="pi",
            run_dir=run_dir,
            sleep=sleep_then_flush,
        )

        assert result.row_count == 1
        assert [p.name for p in result.source_logs] == ["late.jsonl"]
        assert result.attempts == 2
        # The artifact reflects the final (successful) capture.
        assert _tool_names(result.path) == ["Read"]

    @requires_bun
    def test_retries_pick_up_a_late_filling_log(self, tmp_path):
        # The file exists but yields zero tool calls (still mid-flush);
        # content arrives during the retry delay.
        log_dir = _mkdir(tmp_path / "logs")
        snap = snapshot_dir(log_dir, "*.jsonl")
        run_dir = _mkdir(tmp_path / "run")
        (log_dir / "s.jsonl").write_text("")

        def sleep_then_fill(seconds: float) -> None:
            (log_dir / "s.jsonl").write_text(_pi_toolcall_line())

        result = capture_tool_calls_with_retry(
            log_dir=log_dir,
            log_glob="*.jsonl",
            snapshot=snap,
            normalizer="pi",
            run_dir=run_dir,
            sleep=sleep_then_fill,
        )

        assert result.row_count == 1
        assert result.attempts == 2

    def test_gives_up_after_bounded_attempts(self, tmp_path):
        log_dir = _mkdir(tmp_path / "logs")
        snap = snapshot_dir(log_dir, "*.jsonl")
        run_dir = _mkdir(tmp_path / "run")
        sleeps: list[float] = []

        result = capture_tool_calls_with_retry(
            log_dir=log_dir,
            log_glob="*.jsonl",
            snapshot=snap,
            normalizer="pi",
            run_dir=run_dir,
            attempts=3,
            delay_s=2.0,
            sleep=sleeps.append,
        )

        assert result.row_count == 0
        assert result.source_logs == ()
        assert result.attempts == 3
        assert sleeps == [2.0, 2.0]
        # A genuinely-empty capture leaves no trajectory artifact.
        assert not result.path.exists()


class TestCaptureTokenUsage:
    def test_writes_token_usage_json(self, tmp_path):
        log_dir = _mkdir(tmp_path / "logs")
        snap = snapshot_dir(log_dir, "*.jsonl")
        (log_dir / "session.jsonl").write_text(_claude_session_line(100, 40))
        run_dir = _mkdir(tmp_path / "run")
        out = capture_token_usage(
            log_dir=log_dir,
            log_glob="*.jsonl",
            snapshot=snap,
            normalizer="claude",
            run_dir=run_dir,
        )
        assert out is not None
        assert out == run_dir / "coding-agent-token-usage.json"
        usage = json.loads(out.read_text())
        assert usage["total_input"] == 100
        assert usage["total_output"] == 40
        assert usage["est_cost_usd"] > 0
        assert usage["pricing_as_of"] == "2026-06-09"  # fixture snapshot
        assert "duration_ms" in usage

    def test_no_new_logs_writes_nothing(self, tmp_path):
        # Measurement is best-effort: no logs -> no file, not an empty one.
        log_dir = _mkdir(tmp_path / "logs")
        snap = snapshot_dir(log_dir, "*.jsonl")
        run_dir = _mkdir(tmp_path / "run")
        out = capture_token_usage(
            log_dir=log_dir,
            log_glob="*.jsonl",
            snapshot=snap,
            normalizer="claude",
            run_dir=run_dir,
        )
        assert out is None
        assert not (run_dir / "coding-agent-token-usage.json").exists()

    def test_unparseable_log_writes_nothing(self, tmp_path):
        # gemini is a mapped obol dialect, but obol finds no usage in `{}`
        # -> zero usage -> capture no-ops cleanly.
        log_dir = _mkdir(tmp_path / "logs")
        snap = snapshot_dir(log_dir, "*.jsonl")
        (log_dir / "s.jsonl").write_text("{}\n")
        run_dir = _mkdir(tmp_path / "run")
        out = capture_token_usage(
            log_dir=log_dir,
            log_glob="*.jsonl",
            snapshot=snap,
            normalizer="gemini",
            run_dir=run_dir,
        )
        assert out is None
        assert not (run_dir / "coding-agent-token-usage.json").exists()

    def test_kimi_token_usage_priced_by_obol(self, tmp_path):
        # Pre-obol quorum couldn't price kimi (est None); obol + the fixture
        # snapshot can.
        log_dir = _mkdir(tmp_path / "sessions")
        session_dir = log_dir / "wd" / "session"
        wire_dir = session_dir / "agents" / "main"
        wire_dir.mkdir(parents=True)
        snap = snapshot_dir(log_dir, "**/wire.jsonl")
        launch_cwd = tmp_path / "launch"
        launch_cwd.mkdir()
        wire = wire_dir / "wire.jsonl"
        wire.write_text(
            json.dumps(
                {
                    "type": "usage.record",
                    "usageScope": "turn",
                    "model": "kimi-for-coding",
                    "time": 1800000000000,
                    "usage": {
                        "inputOther": 10,
                        "inputCacheRead": 20,
                        "inputCacheCreation": 30,
                        "output": 40,
                    },
                }
            )
            + "\n"
        )
        (tmp_path / "session_index.jsonl").write_text(
            json.dumps({"sessionDir": str(session_dir), "workDir": str(launch_cwd)}) + "\n"
        )
        run_dir = _mkdir(tmp_path / "run")

        out = capture_token_usage(
            log_dir=log_dir,
            log_glob="**/wire.jsonl",
            snapshot=snap,
            normalizer="kimi",
            run_dir=run_dir,
            launch_cwd=launch_cwd,
        )

        assert out is not None
        data = json.loads(out.read_text())
        assert data["total_tokens"] == 100
        assert data["est_cost_usd"] == pytest.approx(0.0001695)
