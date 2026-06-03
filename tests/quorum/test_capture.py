import json
from pathlib import Path

import yaml

from quorum.capture import (
    capture_token_usage,
    capture_tool_calls,
    detect_misplaced_pi_sessions,
    detect_unusable_pi_sessions,
    new_files_since,
    snapshot_dir,
)


def _mkdir(p: Path) -> Path:
    p.mkdir(parents=True, exist_ok=True)
    return p


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
        codex_yaml = (
            Path(__file__).resolve().parents[2] / "coding-agents/codex.yaml"
        )
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
    def test_writes_normalized_jsonl(self, tmp_path):
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        snap = snapshot_dir(log_dir, "*.jsonl")
        session = log_dir / "session-abc.jsonl"
        session.write_text(json.dumps({
            "type": "assistant",
            "message": {"content": [
                {"type": "tool_use", "name": "Bash", "input": {"command": "ls"}}
            ]}
        }) + "\n")
        run_dir = tmp_path / "run"
        run_dir.mkdir()
        result = capture_tool_calls(
            log_dir=log_dir,
            log_glob="*.jsonl",
            snapshot=snap,
            normalizer="claude",
            run_dir=run_dir,
        )
        assert result.path == run_dir / "coding-agent-tool-calls.jsonl"
        rows = [
            json.loads(line)
            for line in result.path.read_text().splitlines()
            if line.strip()
        ]
        assert len(rows) == 1
        assert rows[0]["tool"] == "Bash"
        assert rows[0]["source"] == "shell"

    def test_capture_tool_calls_returns_source_logs_and_row_count(self, tmp_path):
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        snap = snapshot_dir(log_dir, "*.jsonl")
        first = log_dir / "first.jsonl"
        first.write_text(
            json.dumps({
                "type": "assistant",
                "message": {"content": [
                    {
                        "type": "tool_use",
                        "name": "Read",
                        "input": {"file_path": "a.py"},
                    },
                    {
                        "type": "tool_use",
                        "name": "Edit",
                        "input": {"file_path": "a.py"},
                    },
                ]},
            }) + "\n"
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

        assert result.path == run_dir / "coding-agent-tool-calls.jsonl"
        assert result.source_logs == (first, second)
        assert result.row_count == 2

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
            json.dumps({"type": "session_meta",
                        "payload": {"cwd": str(launch_cwd)}}) + "\n"
            + json.dumps({"type": "response_item",
                          "payload": {"type": "function_call",
                                      "name": "spawn_agent", "arguments": "{}"}}) + "\n"
        )

        matched = capture_tool_calls(
            log_dir=log_dir, log_glob="*.jsonl", snapshot=snap,
            normalizer="codex", run_dir=_mkdir(tmp_path / "run-match"),
            launch_cwd=launch_cwd,
        )
        rows = [
            json.loads(x)
            for x in matched.path.read_text().splitlines()
            if x.strip()
        ]
        # spawn_agent is aliased to the Claude-canonical Agent by CODEX_TOOL_MAP.
        assert [r["tool"] for r in rows] == ["Agent"]

        # A non-matching launch_cwd drops the rollout entirely.
        dropped = capture_tool_calls(
            log_dir=log_dir, log_glob="*.jsonl", snapshot=snap,
            normalizer="codex", run_dir=_mkdir(tmp_path / "run-miss"),
            launch_cwd=tmp_path / "elsewhere",
        )
        assert dropped.path.read_text() == ""

    def test_empty_capture_writes_empty_file(self, tmp_path):
        # File must always exist so assertions can rely on its presence.
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        snap = snapshot_dir(log_dir, "*.jsonl")
        run_dir = tmp_path / "run"
        run_dir.mkdir()
        result = capture_tool_calls(
            log_dir=log_dir, log_glob="*.jsonl", snapshot=snap,
            normalizer="claude", run_dir=run_dir,
        )
        assert result.source_logs == ()
        assert result.row_count == 0
        assert result.path.exists()
        assert result.path.read_text() == ""


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
    return json.dumps({
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
    }) + "\n"


class TestCaptureTokenUsage:
    def test_writes_token_usage_json(self, tmp_path):
        log_dir = _mkdir(tmp_path / "logs")
        snap = snapshot_dir(log_dir, "*.jsonl")
        (log_dir / "session.jsonl").write_text(_claude_session_line(100, 40))
        run_dir = _mkdir(tmp_path / "run")
        out = capture_token_usage(
            log_dir=log_dir, log_glob="*.jsonl", snapshot=snap,
            normalizer="claude", run_dir=run_dir,
        )
        assert out is not None
        assert out == run_dir / "coding-agent-token-usage.json"
        usage = json.loads(out.read_text())
        assert usage["total_input"] == 100
        assert usage["total_output"] == 40
        assert usage["est_cost_usd"] > 0

    def test_no_new_logs_writes_nothing(self, tmp_path):
        # Measurement is best-effort: no logs -> no file, not an empty one.
        log_dir = _mkdir(tmp_path / "logs")
        snap = snapshot_dir(log_dir, "*.jsonl")
        run_dir = _mkdir(tmp_path / "run")
        out = capture_token_usage(
            log_dir=log_dir, log_glob="*.jsonl", snapshot=snap,
            normalizer="claude", run_dir=run_dir,
        )
        assert out is None
        assert not (run_dir / "coding-agent-token-usage.json").exists()

    def test_unparseable_backend_writes_nothing(self, tmp_path):
        # token_usage.py has no gemini parser; capture must no-op cleanly.
        log_dir = _mkdir(tmp_path / "logs")
        snap = snapshot_dir(log_dir, "*.jsonl")
        (log_dir / "s.jsonl").write_text("{}\n")
        run_dir = _mkdir(tmp_path / "run")
        out = capture_token_usage(
            log_dir=log_dir, log_glob="*.jsonl", snapshot=snap,
            normalizer="gemini", run_dir=run_dir,
        )
        assert out is None
        assert not (run_dir / "coding-agent-token-usage.json").exists()
