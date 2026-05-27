import json
import os

from harness.normalizers import (
    collect_new_logs,
    filter_codex_logs_by_cwd,
    filter_pi_logs_by_cwd,
    find_misplaced_codex_rollouts,
    normalize_claude_logs,
    normalize_codex_logs,
    normalize_gemini_logs,
    normalize_pi_logs,
    snapshot_log_dir,
)


class TestSnapshotAndCollect:
    def test_snapshot_and_collect_new_files(self, tmp_path):
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        (log_dir / "old.jsonl").write_text('{"old": true}\n')
        snapshot = snapshot_log_dir(log_dir)
        (log_dir / "new.jsonl").write_text('{"new": true}\n')
        new_files = collect_new_logs(log_dir, snapshot)
        assert len(new_files) == 1
        assert new_files[0].name == "new.jsonl"

    def test_empty_dir_returns_empty(self, tmp_path):
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        snapshot = snapshot_log_dir(log_dir)
        new_files = collect_new_logs(log_dir, snapshot)
        assert new_files == []


class TestNormalizeClaudeLogs:
    def test_normalizes_tool_use(self):
        lines = [
            json.dumps(
                {"type": "tool_use", "name": "EnterWorktree", "input": {"branch": "add-login"}}
            ),
            json.dumps({"type": "tool_use", "name": "Bash", "input": {"command": "git status"}}),
            json.dumps({"type": "text", "text": "I'll create a worktree"}),
        ]
        normalized = normalize_claude_logs("\n".join(lines))
        assert len(normalized) == 2
        assert normalized[0]["tool"] == "EnterWorktree"
        assert normalized[0]["source"] == "native"
        assert normalized[1]["tool"] == "Bash"
        assert normalized[1]["source"] == "shell"


class TestNormalizeCodexLogs:
    def test_normalizes_local_shell_call(self):
        lines = [
            json.dumps(
                {
                    "type": "response_item",
                    "item": {
                        "type": "local_shell_call",
                        "action": {"command": ["git", "worktree", "add", "feature"]},
                        "status": "completed",
                    },
                }
            ),
            json.dumps(
                {
                    "type": "response_item",
                    "item": {"type": "message", "content": [{"text": "Creating worktree"}]},
                }
            ),
        ]
        normalized = normalize_codex_logs("\n".join(lines))
        assert len(normalized) == 1
        assert normalized[0]["tool"] == "Bash"
        assert "git worktree add" in normalized[0]["args"]["command"]
        assert normalized[0]["source"] == "shell"

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
        # The QA agent is supposed to `cd $HARNESS_AGENT_CWD` before launching
        # codex. If it skips that step, codex launches in <run-dir>/scratch
        # instead of the workdir. The cwd-filter drops these rollouts (correctly)
        # but the harness needs to *surface* the misconfiguration rather than
        # silently producing an empty tool-calls file. This helper finds the
        # smoking gun: rollouts whose cwd is somewhere inside the run dir but
        # not equal to launch_cwd.
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
            json.dumps(
                {"type": "session_meta", "payload": {"cwd": str(scratch.resolve())}}
            )
            + "\n"
        )
        assert find_misplaced_codex_rollouts(
            [rollout], run_dir=link, launch_cwd=link / "coding-agent-workdir"
        ) == [rollout]

    def test_normalizes_function_call_with_payload(self):
        """Test the actual codex rollout format using payload instead of item."""
        lines = [
            json.dumps(
                {
                    "type": "response_item",
                    "payload": {
                        "type": "function_call",
                        "name": "exec_command",
                        "arguments": '{"cmd":"git worktree add .worktrees/feature",'
                        '"workdir":"/tmp/test"}',
                        "call_id": "call_123",
                    },
                }
            ),
            json.dumps(
                {
                    "type": "response_item",
                    "payload": {
                        "type": "function_call",
                        "name": "apply_patch",
                        "arguments": '{"patch":"--- a/file\\n+++ b/file"}',
                        "call_id": "call_456",
                    },
                }
            ),
        ]
        normalized = normalize_codex_logs("\n".join(lines))
        assert len(normalized) == 2
        assert normalized[0]["tool"] == "Bash"
        assert "git worktree add" in normalized[0]["args"]["command"]
        assert normalized[0]["source"] == "shell"
        assert normalized[1]["tool"] == "Edit"
        assert normalized[1]["source"] == "native"

    def test_aliases_spawn_agent_to_Agent(self):
        # Codex's subagent-dispatch primitive maps to Claude's canonical Agent
        # so scenarios checking `tool-called Agent` work across both backends.
        lines = [
            json.dumps(
                {
                    "type": "response_item",
                    "payload": {
                        "type": "function_call",
                        "name": "spawn_agent",
                        "arguments": '{"task": "review the PR"}',
                        "call_id": "call_1",
                    },
                }
            ),
        ]
        normalized = normalize_codex_logs("\n".join(lines))
        assert len(normalized) == 1
        assert normalized[0]["tool"] == "Agent"
        assert normalized[0]["source"] == "native"

    def test_keeps_wait_and_close_agent_verbatim(self):
        # spawn_agent maps to Agent (1:1 with a launch), but wait_agent and
        # close_agent are the async-protocol join/teardown halves — aliasing
        # all three would inflate tool-count Agent threefold and break
        # tool-before spawn_agent wait_agent in the codex-tool-mapping scenarios.
        lines = [
            json.dumps(
                {
                    "type": "response_item",
                    "payload": {
                        "type": "function_call",
                        "name": "wait_agent",
                        "arguments": "{}",
                        "call_id": "call_2",
                    },
                }
            ),
            json.dumps(
                {
                    "type": "response_item",
                    "payload": {
                        "type": "function_call",
                        "name": "close_agent",
                        "arguments": "{}",
                        "call_id": "call_3",
                    },
                }
            ),
        ]
        normalized = normalize_codex_logs("\n".join(lines))
        assert [r["tool"] for r in normalized] == ["wait_agent", "close_agent"]

    def test_normalizes_apply_patch_custom_tool_call(self):
        # Codex emits apply_patch as both function_call (older runs) and
        # custom_tool_call (current runs). The custom_tool_call variant carries
        # `input` as a raw heredoc-style patch string, not JSON-encoded args.
        lines = [
            json.dumps(
                {
                    "type": "response_item",
                    "payload": {
                        "type": "custom_tool_call",
                        "name": "apply_patch",
                        "input": "*** Begin Patch\n*** Add File: foo.go\n+package main\n"
                        "*** End Patch\n",
                        "call_id": "call_4",
                    },
                }
            ),
        ]
        normalized = normalize_codex_logs("\n".join(lines))
        assert len(normalized) == 1
        assert normalized[0]["tool"] == "Edit"
        assert normalized[0]["source"] == "native"
        assert "Begin Patch" in normalized[0]["args"]["patch"]


class TestNormalizePiLogs:
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
        session.write_text(
            json.dumps({"type": "session", "cwd": os.path.realpath(real)}) + "\n"
        )
        assert filter_pi_logs_by_cwd([session], str(link)) == [session]

    def test_normalizes_assistant_tool_calls_from_session_entries(self):
        lines = [
            json.dumps({"type": "session", "cwd": "/tmp/project"}),
            json.dumps(
                {
                    "type": "message",
                    "message": {
                        "role": "assistant",
                        "content": [
                            {"type": "text", "text": "I will inspect this."},
                            {
                                "type": "toolCall",
                                "name": "read",
                                "arguments": {"path": "README.md"},
                            },
                            {
                                "type": "toolCall",
                                "name": "bash",
                                "arguments": {"command": "git status"},
                            },
                            {
                                "type": "toolCall",
                                "name": "subagent",
                                "arguments": {"agent": "reviewer"},
                            },
                        ],
                    },
                }
            ),
        ]

        assert normalize_pi_logs("\n".join(lines)) == [
            {"tool": "Read", "args": {"path": "README.md"}, "source": "native"},
            {"tool": "Bash", "args": {"command": "git status"}, "source": "shell"},
            {"tool": "subagent", "args": {"agent": "reviewer"}, "source": "native"},
        ]


class TestNormalizeGeminiLogs:
    def test_normalizes_jsonl_tool_calls(self):
        lines = [
            json.dumps({"kind": "main"}),
            json.dumps(
                {
                    "type": "gemini",
                    "content": "Reading file",
                    "toolCalls": [
                        {
                            "id": "read_file_1",
                            "name": "read_file",
                            "args": {"file_path": "GEMINI.md"},
                            "status": "success",
                        }
                    ],
                }
            ),
            json.dumps(
                {
                    "type": "gemini",
                    "content": "Running command",
                    "toolCalls": [
                        {
                            "id": "shell_1",
                            "name": "run_shell_command",
                            "args": {"command": "git status"},
                            "status": "success",
                        }
                    ],
                }
            ),
        ]

        normalized = normalize_gemini_logs("\n".join(lines))

        assert normalized == [
            {"tool": "Read", "args": {"file_path": "GEMINI.md"}, "source": "native"},
            {"tool": "Bash", "args": {"command": "git status"}, "source": "shell"},
        ]
