import json
from pathlib import Path

import yaml

from harness.capture import capture_tool_calls, new_files_since, snapshot_dir


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
            Path(__file__).resolve().parents[2] / "harness/targets/codex.yaml"
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
        out = capture_tool_calls(
            log_dir=log_dir,
            log_glob="*.jsonl",
            snapshot=snap,
            normalizer="claude",
            run_dir=run_dir,
        )
        assert out == run_dir / "tool_calls.jsonl"
        rows = [json.loads(line) for line in out.read_text().splitlines() if line.strip()]
        assert len(rows) == 1
        assert rows[0]["tool"] == "Bash"
        assert rows[0]["source"] == "shell"

    def test_empty_capture_writes_empty_file(self, tmp_path):
        # File must always exist so assertions can rely on its presence.
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        snap = snapshot_dir(log_dir, "*.jsonl")
        run_dir = tmp_path / "run"
        run_dir.mkdir()
        out = capture_tool_calls(
            log_dir=log_dir, log_glob="*.jsonl", snapshot=snap,
            normalizer="claude", run_dir=run_dir,
        )
        assert out.exists()
        assert out.read_text() == ""
