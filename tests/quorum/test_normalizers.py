import json
import os

from quorum.normalizers import (
    collect_new_logs,
    filter_codex_logs_by_cwd,
    filter_kimi_logs_by_cwd,
    filter_pi_logs_by_cwd,
    find_misplaced_codex_rollouts,
    find_misplaced_pi_sessions,
    find_unusable_pi_sessions,
    normalize_antigravity_logs,
    normalize_claude_logs,
    normalize_codex_logs,
    normalize_copilot_logs,
    normalize_gemini_logs,
    normalize_kimi_logs,
    normalize_opencode_logs,
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
        # The QA agent is supposed to `cd $QUORUM_AGENT_CWD` before launching
        # codex. If it skips that step, codex launches in <run-dir>/scratch
        # instead of the workdir. The cwd-filter drops these rollouts (correctly)
        # but quorum needs to *surface* the misconfiguration rather than
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
            json.dumps({"type": "session_meta", "payload": {"cwd": str(scratch.resolve())}}) + "\n"
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
            {"tool": "Agent", "args": {"agent": "reviewer"}, "source": "native"},
        ]

    def test_subagent_execution_calls_alias_to_agent_but_management_calls_do_not(self):
        def tool_call(arguments):
            return json.dumps(
                {
                    "type": "message",
                    "message": {
                        "role": "assistant",
                        "content": [
                            {"type": "toolCall", "name": "subagent", "arguments": arguments}
                        ],
                    },
                }
            )

        lines = [
            json.dumps({"type": "session", "cwd": "/tmp/project"}),
            tool_call({"agent": "reviewer", "task": "review the diff"}),
            tool_call({"chain": [{"agent": "scout"}, {"agent": "planner"}]}),
            tool_call({"tasks": [{"agent": "reviewer", "count": 3}], "concurrency": 3}),
            tool_call({"action": "list"}),
            tool_call({"action": "status", "id": "run-1"}),
        ]

        assert normalize_pi_logs("\n".join(lines)) == [
            {
                "tool": "Agent",
                "args": {"agent": "reviewer", "task": "review the diff"},
                "source": "native",
            },
            {
                "tool": "Agent",
                "args": {"chain": [{"agent": "scout"}, {"agent": "planner"}]},
                "source": "native",
            },
            {
                "tool": "Agent",
                "args": {"tasks": [{"agent": "reviewer", "count": 3}], "concurrency": 3},
                "source": "native",
            },
            {"tool": "subagent", "args": {"action": "list"}, "source": "native"},
            {"tool": "subagent", "args": {"action": "status", "id": "run-1"}, "source": "native"},
        ]

    def test_normalizes_live_style_pi_session_with_model_and_tool_result_rows(self):
        lines = [
            json.dumps(
                {
                    "type": "session",
                    "version": 3,
                    "id": "session-1",
                    "cwd": "/tmp/project",
                }
            ),
            json.dumps(
                {
                    "type": "model_change",
                    "provider": "openai-codex",
                    "modelId": "gpt-5.5",
                }
            ),
            json.dumps({"type": "thinking_level_change", "thinkingLevel": "medium"}),
            json.dumps(
                {
                    "type": "message",
                    "message": {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "toolCall",
                                "id": "call-read",
                                "name": "read",
                                "arguments": {"path": "README.md"},
                            }
                        ],
                    },
                }
            ),
            json.dumps(
                {
                    "type": "message",
                    "message": {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "toolCall",
                                "id": "call-write",
                                "name": "write",
                                "arguments": {"path": "out.md", "content": "ok"},
                            },
                            {
                                "type": "toolCall",
                                "id": "call-edit",
                                "name": "edit",
                                "arguments": {
                                    "path": "out.md",
                                    "oldString": "ok",
                                    "newString": "done",
                                },
                            },
                            {
                                "type": "toolCall",
                                "id": "call-bash",
                                "name": "bash",
                                "arguments": {"command": "git status --short"},
                            },
                            {
                                "type": "toolCall",
                                "id": "call-find",
                                "name": "find",
                                "arguments": {"path": ".", "pattern": "*.md"},
                            },
                            {
                                "type": "toolCall",
                                "id": "call-ls",
                                "name": "ls",
                                "arguments": {"path": "."},
                            },
                            {
                                "type": "toolCall",
                                "id": "call-custom",
                                "name": "custom_tool",
                                "arguments": {"x": 1},
                            },
                        ],
                    },
                }
            ),
            json.dumps(
                {
                    "type": "message",
                    "message": {
                        "role": "toolResult",
                        "toolCallId": "call-read",
                        "toolName": "read",
                        "content": [{"type": "text", "text": "README"}],
                    },
                }
            ),
            json.dumps(
                {
                    "type": "message",
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": "done"}],
                    },
                }
            ),
        ]

        assert normalize_pi_logs("\n".join(lines)) == [
            {"tool": "Read", "args": {"path": "README.md"}, "source": "native"},
            {"tool": "Write", "args": {"path": "out.md", "content": "ok"}, "source": "native"},
            {
                "tool": "Edit",
                "args": {"path": "out.md", "oldString": "ok", "newString": "done"},
                "source": "native",
            },
            {"tool": "Bash", "args": {"command": "git status --short"}, "source": "shell"},
            {"tool": "Glob", "args": {"path": ".", "pattern": "*.md"}, "source": "native"},
            {"tool": "Glob", "args": {"path": "."}, "source": "native"},
            {"tool": "custom_tool", "args": {"x": 1}, "source": "shell"},
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

    def test_normalizes_realistic_json_and_jsonl_tool_calls(self):
        messages = [
            {"kind": "main"},
            {
                "type": "gemini",
                "content": "Using a skill",
                "toolCalls": [
                    {
                        "id": "skill-1",
                        "name": "activate_skill",
                        "args": {"skill": "superpowers:brainstorming"},
                        "status": "success",
                    },
                    {
                        "id": "ls-1",
                        "name": "list_directory",
                        "args": {"path": "src"},
                        "status": "success",
                    },
                    {
                        "id": "write-1",
                        "name": "write_file",
                        "args": {"file_path": "notes.md", "content": "x"},
                        "status": "success",
                    },
                    {
                        "id": "replace-1",
                        "name": "replace",
                        "args": {
                            "file_path": "notes.md",
                            "old_string": "x",
                            "new_string": "y",
                        },
                        "status": "success",
                    },
                    {
                        "id": "shell-1",
                        "name": "run_shell_command",
                        "args": {"command": "git status"},
                        "status": "success",
                    },
                ],
            },
            {
                "type": "gemini",
                "content": "duplicate tool call id should be ignored",
                "toolCalls": [
                    {
                        "id": "shell-1",
                        "name": "run_shell_command",
                        "args": {"command": "pwd"},
                        "status": "success",
                    }
                ],
            },
        ]

        json_rows = normalize_gemini_logs(json.dumps({"messages": messages}))
        jsonl_rows = normalize_gemini_logs("\n".join(json.dumps(m) for m in messages))

        for rows in (json_rows, jsonl_rows):
            assert [row["tool"] for row in rows] == [
                "Skill",
                "Glob",
                "Write",
                "Edit",
                "Bash",
            ]
            assert rows[0]["args"]["skill"] == "superpowers:brainstorming"
            assert rows[0]["source"] == "native"
            assert rows[-1]["args"]["command"] == "git status"
            assert rows[-1]["source"] == "shell"

    def test_normalizes_activate_skill_name_argument_to_skill_name(self):
        raw = json.dumps(
            {
                "type": "gemini",
                "toolCalls": [
                    {
                        "id": "skill-1",
                        "name": "activate_skill",
                        "args": {"name": "test-driven-development"},
                    }
                ],
            }
        )

        rows = normalize_gemini_logs(raw)

        assert rows == [
            {
                "tool": "Skill",
                "args": {
                    "name": "test-driven-development",
                    "skill": "superpowers:test-driven-development",
                },
                "source": "native",
            }
        ]


class TestNormalizeOpenCodeLogs:
    def test_normalizes_tool_parts_from_export_json(self):
        export = {
            "info": {"id": "ses_1", "directory": "/tmp/project"},
            "messages": [
                {
                    "info": {"role": "assistant"},
                    "parts": [
                        {"type": "step-start"},
                        {
                            "type": "tool",
                            "tool": "skill",
                            "state": {
                                "status": "completed",
                                "input": {"name": "brainstorming"},
                            },
                        },
                        {
                            "type": "tool",
                            "tool": "bash",
                            "state": {
                                "status": "completed",
                                "input": {"command": "git status"},
                            },
                        },
                        {
                            "type": "tool",
                            "tool": "task",
                            "state": {
                                "status": "completed",
                                "input": {"subagent_type": "general", "prompt": "review"},
                            },
                        },
                    ],
                }
            ],
        }

        assert normalize_opencode_logs(json.dumps(export)) == [
            {
                "tool": "Skill",
                "args": {
                    "skill": "superpowers:brainstorming",
                    "name": "brainstorming",
                    "raw_input": {"name": "brainstorming"},
                },
                "source": "native",
            },
            {
                "tool": "Bash",
                "args": {
                    "command": "git status",
                    "raw_input": {"command": "git status"},
                },
                "source": "shell",
            },
            {
                "tool": "Agent",
                "args": {
                    "subagent_type": "general",
                    "prompt": "review",
                    "raw_input": {"subagent_type": "general", "prompt": "review"},
                },
                "source": "native",
            },
        ]

    def test_normalizes_file_search_todo_and_web_tools(self):
        export = {
            "messages": [
                {
                    "parts": [
                        {"type": "tool", "tool": "read", "state": {"input": {"file": "README.md"}}},
                        {
                            "type": "tool",
                            "tool": "write",
                            "state": {"input": {"path": "app.py", "content": "x"}},
                        },
                        {
                            "type": "tool",
                            "tool": "edit",
                            "state": {"input": {"filePath": "src/app.py"}},
                        },
                        {
                            "type": "tool",
                            "tool": "apply_patch",
                            "state": {
                                "input": {
                                    "patch": (
                                        "*** Begin Patch\n"
                                        "*** Update File: src/app.py\n"
                                        "@@\n"
                                        "-old\n"
                                        "+new\n"
                                        "*** End Patch\n"
                                    )
                                }
                            },
                        },
                        {"type": "tool", "tool": "grep", "state": {"input": {"pattern": "Skill"}}},
                        {"type": "tool", "tool": "glob", "state": {"input": {"pattern": "*.py"}}},
                        {"type": "tool", "tool": "todowrite", "state": {"input": {"todos": []}}},
                        {
                            "type": "tool",
                            "tool": "webfetch",
                            "state": {"input": {"url": "https://example.com"}},
                        },
                    ]
                }
            ]
        }

        rows = normalize_opencode_logs(json.dumps(export))

        assert [row["tool"] for row in rows] == [
            "Read",
            "Write",
            "Edit",
            "Edit",
            "Grep",
            "Glob",
            "TodoWrite",
            "WebFetch",
        ]
        assert rows[0]["args"]["file_path"] == "README.md"
        assert rows[1]["args"]["file_path"] == "app.py"
        assert rows[2]["args"]["file_path"] == "src/app.py"
        assert rows[3]["args"]["file_path"] == "src/app.py"
        assert rows[3]["args"]["file_paths"] == ["src/app.py"]
        assert rows[3]["source"] == "native"
        assert rows[-1]["args"]["url"] == "https://example.com"

    def test_ignores_non_json_and_non_tool_parts(self):
        assert normalize_opencode_logs("not json") == []
        assert (
            normalize_opencode_logs(json.dumps({"messages": [{"parts": [{"type": "text"}]}]})) == []
        )


class TestNormalizeKimiLogs:
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

    def test_normalizes_wire_tool_calls_and_native_source(self):
        lines = [
            json.dumps(
                {
                    "type": "context.append_loop_event",
                    "event": {
                        "type": "tool.call",
                        "name": "Read",
                        "args": {"path": "sample.txt"},
                    },
                }
            ),
            json.dumps(
                {
                    "type": "context.append_loop_event",
                    "event": {
                        "type": "tool.call",
                        "name": "Bash",
                        "args": {"command": "git status"},
                    },
                }
            ),
            json.dumps(
                {
                    "type": "context.append_loop_event",
                    "event": {
                        "type": "tool.call",
                        "name": "FetchURL",
                        "args": {"url": "https://example.test"},
                    },
                }
            ),
            json.dumps(
                {
                    "type": "context.append_loop_event",
                    "event": {"type": "tool.result", "toolCallId": "tool_1"},
                }
            ),
        ]

        rows = normalize_kimi_logs("\n".join(lines))

        assert rows == [
            {"tool": "Read", "args": {"path": "sample.txt"}, "source": "native"},
            {"tool": "Bash", "args": {"command": "git status"}, "source": "shell"},
            {
                "tool": "FetchURL",
                "args": {"url": "https://example.test"},
                "source": "native",
            },
        ]

    def test_canonicalizes_short_superpowers_skill_names(self):
        raw = json.dumps(
            {
                "type": "context.append_loop_event",
                "event": {
                    "type": "tool.call",
                    "name": "Skill",
                    "args": {"skill": "brainstorming"},
                },
            }
        )

        rows = normalize_kimi_logs(raw)

        assert rows == [
            {
                "tool": "Skill",
                "args": {"skill": "superpowers:brainstorming"},
                "source": "native",
            }
        ]


class TestNormalizeCopilotLogs:
    def test_normalizes_assistant_tool_requests(self):
        raw_input = {"skill": "superpowers:brainstorming"}
        lines = [
            json.dumps(
                {
                    "type": "assistant.message",
                    "data": {
                        "toolRequests": [
                            {"name": "skill", "arguments": raw_input},
                            {"name": "bash", "arguments": {"cmd": "git status"}},
                            {
                                "name": "apply_patch",
                                "arguments": {
                                    "patch": (
                                        "*** Begin Patch\n"
                                        "*** Update File: src/app.py\n"
                                        "@@\n"
                                        "-old\n"
                                        "+new\n"
                                        "*** End Patch\n"
                                    )
                                },
                            },
                            {"name": "view", "arguments": {"file": "README.md"}},
                            {"name": "edit", "arguments": {"filePath": "src/edit.py"}},
                            {"name": "create", "arguments": {"path": "src/new.py"}},
                            {"name": "write", "arguments": {"file_path": "src/write.py"}},
                            {"name": "rg", "arguments": {"pattern": "Skill"}},
                            {"name": "glob", "arguments": {"pattern": "*.py"}},
                            {"name": "task", "arguments": {"prompt": "review"}},
                            {"name": "read_agent", "arguments": {"agent": "reviewer"}},
                            {"name": "list_agents", "arguments": {}},
                            {"name": "write_agent", "arguments": {"agent": "reviewer"}},
                            {"name": "update_todo", "arguments": {"todos": []}},
                            {"name": "web_fetch", "arguments": {"url": "https://example.test"}},
                            {"name": "web_search", "arguments": {"query": "quorum docs"}},
                        ]
                    },
                }
            )
        ]

        rows = normalize_copilot_logs("\n".join(lines))

        assert [row["tool"] for row in rows] == [
            "Skill",
            "Bash",
            "Edit",
            "Read",
            "Edit",
            "Write",
            "Write",
            "Grep",
            "Glob",
            "Agent",
            "Agent",
            "Agent",
            "Agent",
            "TodoWrite",
            "WebFetch",
            "WebSearch",
        ]
        assert [row["source"] for row in rows] == [
            "native",
            "shell",
            "native",
            "native",
            "native",
            "native",
            "native",
            "native",
            "native",
            "native",
            "native",
            "native",
            "native",
            "native",
            "native",
            "native",
        ]
        assert rows[0]["args"] == {
            "skill": "superpowers:brainstorming",
            "name": "brainstorming",
            "raw_input": raw_input,
        }
        assert rows[1]["source"] == "shell"
        assert rows[1]["args"]["command"] == "git status"
        assert rows[2]["source"] == "native"
        assert rows[2]["args"]["file_path"] == "src/app.py"
        assert rows[2]["args"]["file_paths"] == ["src/app.py"]
        assert rows[3]["args"]["file_path"] == "README.md"
        assert rows[4]["args"]["file_path"] == "src/edit.py"
        assert rows[5]["args"]["file_path"] == "src/new.py"
        assert rows[6]["args"]["file_path"] == "src/write.py"
        assert rows[-1]["args"]["query"] == "quorum docs"

    def test_preserves_multiple_tool_requests_order(self):
        lines = [
            json.dumps(
                {
                    "type": "assistant.message",
                    "data": {
                        "toolRequests": [
                            {"name": "bash", "arguments": {"command": "pwd"}},
                            {"name": "skill", "arguments": {"name": "brainstorming"}},
                        ]
                    },
                }
            ),
            json.dumps(
                {
                    "type": "assistant.message",
                    "data": {
                        "toolRequests": [
                            {"name": "view", "arguments": {"path": "README.md"}},
                            {"name": "write", "arguments": {"file": "notes.md"}},
                        ]
                    },
                }
            ),
        ]

        rows = normalize_copilot_logs("\n".join(lines))

        assert [row["tool"] for row in rows] == ["Bash", "Skill", "Read", "Write"]
        assert rows[1]["args"]["skill"] == "superpowers:brainstorming"
        assert rows[1]["args"]["name"] == "brainstorming"

    def test_ignores_non_request_events_and_bad_lines(self):
        lines = [
            "not json",
            json.dumps([]),
            json.dumps({"type": "tool.execution_complete"}),
            json.dumps({"type": "session.shutdown"}),
            json.dumps({"type": "assistant.message", "data": {"toolRequests": "bad"}}),
            json.dumps({"type": "assistant.message", "data": {"toolRequests": [123]}}),
        ]

        assert normalize_copilot_logs("\n".join(lines)) == []

    def test_negative_fixture_keeps_early_write_before_skill(self):
        lines = [
            json.dumps(
                {
                    "type": "assistant.message",
                    "data": {
                        "toolRequests": [
                            {"name": "write", "arguments": {"path": "src/app.py"}},
                            {"name": "skill", "arguments": {"name": "brainstorming"}},
                        ]
                    },
                }
            )
        ]

        rows = normalize_copilot_logs("\n".join(lines))

        assert [row["tool"] for row in rows] == ["Write", "Skill"]
        assert rows[0]["args"]["file_path"] == "src/app.py"


class TestNormalizeAntigravityLogs:
    def test_normalizes_top_level_tool_calls_and_pascal_case_args(self):
        raw = "\n".join(
            [
                json.dumps(
                    {
                        "type": "assistant",
                        "tool_calls": [
                            {"name": "run_command", "args": {"CommandLine": "pytest -q"}},
                            {
                                "name": "view_file",
                                "args": {
                                    "AbsolutePath": "/tmp/run/.gemini/config/plugins/"
                                    "superpowers/skills/test-driven-development/SKILL.md",
                                    "IsSkillFile": True,
                                },
                            },
                            {"name": "list_dir", "args": {"DirectoryPath": "src"}},
                        ],
                    }
                ),
                "not json",
                json.dumps({"type": "assistant", "text": "no tools here"}),
            ]
        )

        rows = normalize_antigravity_logs(raw)

        assert [r["tool"] for r in rows] == ["Bash", "Read", "Glob"]
        assert rows[0]["args"]["command"] == "pytest -q"
        assert rows[0]["args"]["raw_args"] == {"CommandLine": "pytest -q"}
        assert rows[1]["args"]["file_path"].endswith("/skills/test-driven-development/SKILL.md")
        assert rows[1]["args"]["is_skill_file"] is True
        assert rows[1]["args"]["raw_args"]["IsSkillFile"] is True
        assert rows[2]["args"]["path"] == "src"

    def test_decodes_antigravity_json_string_literal_args(self):
        raw = json.dumps(
            {
                "tool_calls": [
                    {
                        "name": "view_file",
                        "args": {
                            "AbsolutePath": (
                                '"/tmp/run/.gemini/config/plugins/superpowers/'
                                'skills/brainstorming/SKILL.md"'
                            ),
                            "toolSummary": '"Read brainstorming skill"',
                        },
                    },
                    {
                        "name": "run_command",
                        "args": {"CommandLine": '"pytest -q"', "Cwd": '"/tmp/run"'},
                    },
                    {
                        "name": "list_dir",
                        "args": {"DirectoryPath": '"/tmp/run/src"'},
                    },
                ]
            }
        )

        rows = normalize_antigravity_logs(raw)

        assert rows[0]["args"]["file_path"] == (
            "/tmp/run/.gemini/config/plugins/superpowers/skills/brainstorming/SKILL.md"
        )
        assert rows[0]["args"]["raw_args"]["AbsolutePath"].startswith('"')
        assert rows[1]["args"]["command"] == "pytest -q"
        assert rows[1]["args"]["cwd"] == "/tmp/run"
        assert rows[2]["args"]["path"] == "/tmp/run/src"

    def test_normalizes_antigravity_write_and_edit_target_paths(self):
        raw = json.dumps(
            {
                "tool_calls": [
                    {
                        "name": "write_to_file",
                        "args": {"TargetFile": '"/tmp/run/coding-agent-workdir/src/app.js"'},
                    },
                    {
                        "name": "replace_file_content",
                        "args": {"TargetFile": '"/tmp/run/coding-agent-workdir/src/app.js"'},
                    },
                ]
            }
        )

        rows = normalize_antigravity_logs(raw)

        assert [r["tool"] for r in rows] == ["Write", "Edit"]
        assert rows[0]["args"]["file_path"] == "/tmp/run/coding-agent-workdir/src/app.js"
        assert rows[1]["args"]["file_path"] == "/tmp/run/coding-agent-workdir/src/app.js"
        assert rows[0]["args"]["raw_args"]["TargetFile"].startswith('"')

    def test_normalizes_nested_planner_response_tool_calls(self):
        raw = json.dumps(
            {
                "PLANNER_RESPONSE": {
                    "tool_calls": [
                        {"name": "write_to_file", "args": {"Path": "src/app.py"}},
                        {
                            "name": "replace_file_content",
                            "args": {"path": "src/app.py"},
                        },
                        {"name": "grep_search", "args": {"pattern": "validate"}},
                    ]
                }
            }
        )

        rows = normalize_antigravity_logs(raw)

        assert [r["tool"] for r in rows] == ["Write", "Edit", "Grep"]
        assert all("raw_args" in r["args"] for r in rows)

    def test_normalizes_lowercase_args_and_camel_case_tool_call_shapes(self):
        raw = "\n".join(
            [
                json.dumps(
                    {
                        "toolCalls": [
                            {"name": "run_command", "args": {"command": "pytest"}},
                            {"name": "list_dir", "args": {"directory_path": "src"}},
                            {"name": "list_dir", "args": {"path": "tests"}},
                        ]
                    }
                ),
                json.dumps(
                    {
                        "planner_response": {
                            "toolCalls": [
                                {
                                    "name": "view_file",
                                    "args": {"filePath": "src/app.py"},
                                }
                            ]
                        }
                    }
                ),
            ]
        )

        rows = normalize_antigravity_logs(raw)

        assert [r["tool"] for r in rows] == ["Bash", "Glob", "Glob", "Read"]
        assert rows[0]["args"]["command"] == "pytest"
        assert rows[1]["args"]["path"] == "src"
        assert rows[2]["args"]["path"] == "tests"
        assert rows[3]["args"]["file_path"] == "src/app.py"
        assert all("raw_args" in r["args"] for r in rows)

    def test_normalizes_documented_aliases_and_preserves_unknown_find_tools(self):
        raw = json.dumps(
            {
                "tool_calls": [
                    {"name": "create_file", "args": {"Path": "new.py"}},
                    {
                        "name": "multi_replace_file_content",
                        "args": {"path": "existing.py"},
                    },
                    {"name": "edit_file", "args": {"path": "existing.py"}},
                    {"name": "search_directory", "args": {"query": "needle"}},
                    {"name": "find_by_name", "args": {"name": "README.md"}},
                    {"name": "find_file", "args": {"name": "pyproject.toml"}},
                    {"name": "find_symbol", "args": {"symbol": "validate"}},
                    {"name": "list_directory", "args": {"path": "src"}},
                    {"name": "search_web", "args": {"query": "docs"}},
                    {"name": "read_url_content", "args": {"url": "https://example.test"}},
                ]
            }
        )

        rows = normalize_antigravity_logs(raw)

        assert [r["tool"] for r in rows] == [
            "Write",
            "Edit",
            "Edit",
            "Grep",
            "Glob",
            "Glob",
            "find_symbol",
            "Glob",
            "WebSearch",
            "WebFetch",
        ]
        assert all(r["source"] == "native" for r in rows[:6])
        assert rows[6]["source"] == "shell"
        assert all(r["source"] == "native" for r in rows[7:])
        assert rows[6]["args"]["raw_args"] == {"symbol": "validate"}

    def test_preserves_unknown_tools_and_non_launch_manage_subagents(self):
        raw = json.dumps(
            {
                "tool_calls": [
                    {"name": "unknown_tool", "args": {"x": 1}},
                    {"name": "manage_subagents", "args": {"action": "list"}},
                    {"name": "invoke_subagent", "args": {"prompt": "review this"}},
                ]
            }
        )

        rows = normalize_antigravity_logs(raw)

        assert [r["tool"] for r in rows] == [
            "unknown_tool",
            "manage_subagents",
            "Agent",
        ]
        assert rows[0]["args"]["raw_args"] == {"x": 1}
        assert rows[1]["args"]["raw_args"] == {"action": "list"}
        assert rows[2]["source"] == "native"

    def test_ignores_non_string_tool_names(self):
        raw = json.dumps(
            {
                "tool_calls": [
                    {"name": 123, "args": {"x": 1}},
                    {"name": "run_command", "args": {"command": "pytest -q"}},
                ]
            }
        )

        rows = normalize_antigravity_logs(raw)

        assert [r["tool"] for r in rows] == ["Bash"]
        assert rows[0]["args"]["command"] == "pytest -q"

    def test_canonicalizes_skill_marker_casing_and_nested_metadata(self):
        raw = json.dumps(
            {
                "tool_calls": [
                    {
                        "name": "view_file",
                        "args": {
                            "Path": "/x/skills/superpowers/brainstorming/SKILL.md",
                            "metadata": {"isSkillFile": True},
                        },
                    }
                ]
            }
        )

        rows = normalize_antigravity_logs(raw)

        assert rows[0]["tool"] == "Read"
        assert rows[0]["args"]["file_path"] == "/x/skills/superpowers/brainstorming/SKILL.md"
        assert rows[0]["args"]["is_skill_file"] is True
