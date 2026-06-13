import json
import os

from quorum.log_filters import (
    filter_codex_logs_by_cwd,
    filter_kimi_logs_by_cwd,
    filter_pi_logs_by_cwd,
    find_misplaced_codex_rollouts,
    find_misplaced_pi_sessions,
    find_unusable_pi_sessions,
)


class TestCodexLogFilters:
    def test_filter_by_cwd_keeps_matching_drops_others(self, tmp_path):
        target = "/private/tmp/drill-target"
        match = tmp_path / "match.jsonl"
        match.write_text(
            json.dumps(
                {
                    "type": "session_meta",
                    "payload": {"id": "abc", "cwd": target},
                }
            )
            + "\n"
        )
        other = tmp_path / "other.jsonl"
        other.write_text(
            json.dumps(
                {
                    "type": "session_meta",
                    "payload": {"id": "def", "cwd": "/private/tmp/drill-other"},
                }
            )
            + "\n"
        )
        no_meta = tmp_path / "no-meta.jsonl"
        no_meta.write_text(json.dumps({"type": "response_item", "payload": {}}) + "\n")
        empty = tmp_path / "empty.jsonl"
        empty.write_text("")
        kept = filter_codex_logs_by_cwd([match, other, no_meta, empty], target)
        assert kept == [match]

    def test_filter_by_cwd_resolves_symlinked_paths(self, tmp_path):
        # The target cwd may be a symlinked path (macOS hands out
        # /var/folders/... which resolves to /private/var/folders/...)
        # while codex records the resolved realpath in session_meta.
        # The filter must compare resolved paths, not raw strings.
        real = tmp_path / "real-workdir"
        real.mkdir()
        link = tmp_path / "linked-workdir"
        link.symlink_to(real)
        rollout = tmp_path / "rollout.jsonl"
        rollout.write_text(
            json.dumps(
                {
                    "type": "session_meta",
                    "payload": {"id": "abc", "cwd": os.path.realpath(real)},
                }
            )
            + "\n"
        )
        assert filter_codex_logs_by_cwd([rollout], str(link)) == [rollout]

    def test_find_misplaced_rollouts_flags_inside_run_dir_but_wrong_cwd(self, tmp_path):
        # The QA agent is supposed to `cd $QUORUM_AGENT_CWD` before launching
        # codex. If it skips that step, codex launches in <run-dir>/scratch
        # instead of the workdir. The cwd-filter drops these rollouts (correctly)
        # but quorum needs to *surface* the misconfiguration rather than
        # silently capturing nothing. This helper finds the smoking gun:
        # rollouts whose cwd is somewhere inside the run dir but not launch_cwd.
        run_dir = tmp_path / "run"
        run_dir.mkdir()
        workdir = run_dir / "coding-agent-workdir"
        workdir.mkdir()
        scratch = run_dir / "gauntlet-agent" / "scratch"
        scratch.mkdir(parents=True)

        good = tmp_path / "good.jsonl"
        good.write_text(
            json.dumps({"type": "session_meta", "payload": {"cwd": str(workdir.resolve())}}) + "\n"
        )
        misplaced = tmp_path / "misplaced.jsonl"
        misplaced.write_text(
            json.dumps({"type": "session_meta", "payload": {"cwd": str(scratch.resolve())}}) + "\n"
        )
        unrelated = tmp_path / "unrelated.jsonl"
        unrelated.write_text(
            json.dumps({"type": "session_meta", "payload": {"cwd": "/tmp/some-other-run"}}) + "\n"
        )

        misplaced_paths = find_misplaced_codex_rollouts(
            [good, misplaced, unrelated], run_dir=run_dir, launch_cwd=workdir
        )
        assert misplaced_paths == [misplaced]

    def test_find_misplaced_resolves_symlinked_paths(self, tmp_path):
        # Same realpath concern as filter_codex_logs_by_cwd — the workdir may
        # be handed out as a symlinked path while codex records the realpath.
        real = tmp_path / "real-run"
        real.mkdir()
        (real / "coding-agent-workdir").mkdir()
        scratch = real / "gauntlet-agent" / "scratch"
        scratch.mkdir(parents=True)
        link = tmp_path / "linked-run"
        link.symlink_to(real)
        rollout = tmp_path / "rollout.jsonl"
        rollout.write_text(
            json.dumps({"type": "session_meta", "payload": {"cwd": str(scratch.resolve())}}) + "\n"
        )
        assert find_misplaced_codex_rollouts(
            [rollout], run_dir=link, launch_cwd=link / "coding-agent-workdir"
        ) == [rollout]


class TestPiLogFilters:
    def test_filter_by_cwd_keeps_matching_session_headers(self, tmp_path):
        target = "/tmp/drill-target"
        match = tmp_path / "match.jsonl"
        match.write_text(json.dumps({"type": "session", "cwd": target}) + "\n")
        other = tmp_path / "other.jsonl"
        other.write_text(json.dumps({"type": "session", "cwd": "/tmp/other"}) + "\n")
        malformed = tmp_path / "malformed.jsonl"
        malformed.write_text("not json\n")

        assert filter_pi_logs_by_cwd([match, other, malformed], target) == [match]

    def test_filter_by_cwd_resolves_symlinked_paths(self, tmp_path):
        # Same macOS /var -> /private/var divergence as the codex filter:
        # the session header records the resolved realpath, the target may
        # be a symlinked path. Compare resolved paths, not raw strings.
        real = tmp_path / "real-workdir"
        real.mkdir()
        link = tmp_path / "linked-workdir"
        link.symlink_to(real)
        session = tmp_path / "session.jsonl"
        session.write_text(json.dumps({"type": "session", "cwd": os.path.realpath(real)}) + "\n")
        assert filter_pi_logs_by_cwd([session], str(link)) == [session]

    def test_find_misplaced_pi_sessions_reports_any_new_wrong_cwd(self, tmp_path):
        launch_cwd = tmp_path / "run" / "coding-agent-workdir"
        wrong_cwd = tmp_path / "scratch"
        launch_cwd.mkdir(parents=True)
        wrong_cwd.mkdir(parents=True)

        session = tmp_path / "session.jsonl"
        session.write_text(json.dumps({"type": "session", "cwd": str(wrong_cwd)}) + "\n")

        assert find_misplaced_pi_sessions([session], launch_cwd=launch_cwd) == [session]

    def test_find_unusable_pi_sessions_reports_malformed_or_missing_header(self, tmp_path):
        malformed = tmp_path / "malformed.jsonl"
        malformed.write_text("{not json}\n")
        missing_cwd = tmp_path / "missing-cwd.jsonl"
        missing_cwd.write_text(json.dumps({"type": "session"}) + "\n")
        text_first = tmp_path / "text-first.jsonl"
        text_first.write_text(json.dumps({"type": "message"}) + "\n")

        assert find_unusable_pi_sessions([malformed, missing_cwd, text_first]) == [
            malformed,
            missing_cwd,
            text_first,
        ]


class TestKimiLogFilters:
    def test_filter_by_cwd_uses_session_index_entries(self, tmp_path):
        target = "/tmp/kimi-target"
        match_dir = tmp_path / "sessions" / "wd_target" / "session_match"
        other_dir = tmp_path / "sessions" / "wd_other" / "session_other"
        match_dir.mkdir(parents=True)
        other_dir.mkdir(parents=True)
        match = match_dir / "wire.jsonl"
        other = other_dir / "wire.jsonl"
        match.write_text("{}\n")
        other.write_text("{}\n")
        index = tmp_path / "session_index.jsonl"
        index.write_text(
            json.dumps(
                {
                    "sessionId": "session_match",
                    "sessionDir": str(match_dir),
                    "workDir": target,
                }
            )
            + "\n"
            + json.dumps(
                {
                    "sessionId": "session_other",
                    "sessionDir": str(other_dir),
                    "workDir": "/tmp/elsewhere",
                }
            )
            + "\n"
        )

        assert filter_kimi_logs_by_cwd([match, other], target) == [match]
