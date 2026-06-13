"""Generate TS replay-parity fixtures from the Python normalizer oracle.

TRANSITIONAL DEV TOOL (quorum TS rewrite, PRI-2207). The Python
`quorum.normalizers` functions are the differential oracle for the TS
rewrite until the Spec-6 cutover. This script feeds curated inputs (lifted
from tests/quorum/test_normalizers.py, which exercise every code path) through
the *real* Python normalizer and freezes the output as
`test/fixtures/<agent>/cases.json`. The TS replay test asserts the TS
normalizer reproduces these rows exactly.

Because `expected` is always the real Python output for the given `input`, the
fixture is a genuine parity oracle regardless of how the input was authored —
authoring only decides which shapes get covered, never whether the assertion
is sound.

Modes:
  --write  (default) regenerate cases.json for every agent.
  --check  re-run the oracle over each committed case input and fail if the
           frozen `expected` no longer matches (parity-drift detector).

Remove this script and switch fixtures to TS-native generation at cutover.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from quorum.normalizers import (  # noqa: E402
    normalize_antigravity_logs,
    normalize_copilot_logs,
    normalize_gemini_logs,
    normalize_kimi_logs,
    normalize_opencode_logs,
    normalize_pi_logs,
)

J = json.dumps
FIXTURES = REPO_ROOT / "test" / "fixtures"


def pi_cases() -> list[tuple[str, str]]:
    session = J({"type": "session", "cwd": "/tmp/project"})
    assistant_tool_calls = J(
        {
            "type": "message",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "I will inspect this."},
                    {"type": "toolCall", "name": "read", "arguments": {"path": "README.md"}},
                    {"type": "toolCall", "name": "bash", "arguments": {"command": "git status"}},
                    {"type": "toolCall", "name": "subagent", "arguments": {"agent": "reviewer"}},
                ],
            },
        }
    )

    def subagent(arguments: Any) -> str:
        return J(
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

    subagent_variants = "\n".join(
        [
            session,
            subagent({"agent": "reviewer", "task": "review the diff"}),
            subagent({"chain": [{"agent": "scout"}, {"agent": "planner"}]}),
            subagent({"tasks": [{"agent": "reviewer", "count": 3}], "concurrency": 3}),
            subagent({"action": "list"}),
            subagent({"action": "status", "id": "run-1"}),
        ]
    )

    live_style = "\n".join(
        [
            J({"type": "session", "version": 3, "id": "session-1", "cwd": "/tmp/project"}),
            J({"type": "model_change", "provider": "openai-codex", "modelId": "gpt-5.5"}),
            J({"type": "thinking_level_change", "thinkingLevel": "medium"}),
            J(
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
            J(
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
            J(
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
            J(
                {
                    "type": "message",
                    "message": {"role": "assistant", "content": [{"type": "text", "text": "done"}]},
                }
            ),
        ]
    )

    # Lock the subagent alias on PRESENCE: a subagent call with a MISSING
    # arguments key defaults to {} (no "action") and aliases to Agent; an args
    # dict WITH "action" stays subagent. (Non-object args also stay subagent in
    # Python, but that path emits a non-record args -> not a valid ToolCall, so
    # it is an accepted divergence covered by a comment, not this fixture.)
    subagent_presence = "\n".join(
        [
            session,
            J(
                {
                    "type": "message",
                    "message": {
                        "role": "assistant",
                        "content": [
                            {"type": "toolCall", "name": "subagent"},
                            {"type": "toolCall", "name": "subagent", "arguments": {"action": "list"}},
                            {"type": "toolCall", "name": "subagent", "arguments": {"agent": "x"}},
                        ],
                    },
                }
            ),
        ]
    )

    return [
        ("assistant tool calls (read/bash/subagent)", "\n".join([session, assistant_tool_calls])),
        ("subagent execution vs management calls", subagent_variants),
        ("live-style session with model rows and tool result", live_style),
        ("subagent alias on key presence: missing args -> Agent, action -> subagent", subagent_presence),
    ]


def gemini_cases() -> list[tuple[str, str]]:
    jsonl_basic = "\n".join(
        [
            J({"kind": "main"}),
            J(
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
            J(
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
    )

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
                    "args": {"file_path": "notes.md", "old_string": "x", "new_string": "y"},
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

    # Lock gemini's source classification: gemini uses the GLOBAL NATIVE_TOOLS
    # set, so WebSearch/WebFetch/TodoWrite map to *shell* (unlike copilot and
    # opencode, where they are native). Plan-mode tools and an unknown tool too.
    source_quirks = J(
        {
            "type": "gemini",
            "content": "source classification",
            "toolCalls": [
                {"id": "g1", "name": "google_web_search", "args": {"query": "x"}},
                {"id": "g2", "name": "web_fetch", "args": {"url": "https://example.test"}},
                {"id": "g3", "name": "write_todos", "args": {"todos": []}},
                {"id": "g4", "name": "enter_plan_mode", "args": {}},
                {"id": "g5", "name": "exit_plan_mode", "args": {}},
                {"id": "g6", "name": "grep_search", "args": {"pattern": "p"}},
                {"id": "g7", "name": "glob", "args": {"pattern": "*.ts"}},
                {"id": "g8", "name": "unknown_gemini_tool", "args": {"k": "v"}},
            ],
        }
    )

    # Lock dedup on non-string ids: Python keys the seen-set on the raw id value
    # via truthiness (`if tool_call_id`), so a truthy numeric id dedups, while a
    # falsy id (0, null) bypasses the set entirely and is always emitted. A naive
    # string-only id schema would instead DROP these calls.
    non_string_ids = J(
        {
            "type": "gemini",
            "content": "non-string ids",
            "toolCalls": [
                {"id": 7, "name": "read_file", "args": {}},
                {"id": 7, "name": "glob", "args": {}},
                {"id": 0, "name": "read_file", "args": {}},
                {"id": 0, "name": "write_file", "args": {}},
                {"id": None, "name": "grep_search", "args": {}},
            ],
        }
    )

    return [
        ("jsonl form: read_file + run_shell_command", jsonl_basic),
        ("json-doc form with messages array + dedup by id", J({"messages": messages})),
        ("jsonl form realistic + dedup by id", "\n".join(J(m) for m in messages)),
        ("source classification: web/todo -> shell, plan-mode -> native", source_quirks),
        ("non-string id dedup: truthy numeric dedups, falsy id passes through", non_string_ids),
    ]


def opencode_cases() -> list[tuple[str, str]]:
    skill_bash_task = {
        "info": {"id": "ses_1", "directory": "/tmp/project"},
        "messages": [
            {
                "info": {"role": "assistant"},
                "parts": [
                    {"type": "step-start"},
                    {
                        "type": "tool",
                        "tool": "skill",
                        "state": {"status": "completed", "input": {"name": "brainstorming"}},
                    },
                    {
                        "type": "tool",
                        "tool": "bash",
                        "state": {"status": "completed", "input": {"command": "git status"}},
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

    file_search_web = {
        "messages": [
            {
                "parts": [
                    {"type": "tool", "tool": "read", "state": {"input": {"file": "README.md"}}},
                    {
                        "type": "tool",
                        "tool": "write",
                        "state": {"input": {"path": "app.py", "content": "x"}},
                    },
                    {"type": "tool", "tool": "edit", "state": {"input": {"filePath": "src/app.py"}}},
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

    # Lock falsy-vs-nullish skill selection and present-null input. Python uses
    # `raw_input.get("skill") or raw_input.get("name")` (FALSY fallthrough): an
    # empty-string skill falls through to name. And `state.get("input", {})`
    # only defaults on ABSENCE, so a present-but-null input stays null in raw_input.
    edge = {
        "messages": [
            {
                "parts": [
                    {
                        "type": "tool",
                        "tool": "skill",
                        "state": {"input": {"skill": "", "name": "brainstorming"}},
                    },
                    {"type": "tool", "tool": "read", "state": {"input": None}},
                ]
            }
        ]
    }

    return [
        ("export json: skill/bash/task with raw_input", J(skill_bash_task)),
        ("export json: file/search/todo/web tools + file_path inference", J(file_search_web)),
        ("not json -> empty", "not json"),
        ("non-tool parts -> empty", J({"messages": [{"parts": [{"type": "text"}]}]})),
        ("falsy skill falls through to name + present-null input stays null", J(edge)),
    ]


def kimi_cases() -> list[tuple[str, str]]:
    wire = "\n".join(
        [
            J(
                {
                    "type": "context.append_loop_event",
                    "event": {
                        "type": "tool.call",
                        "name": "Read",
                        "args": {"path": "sample.txt"},
                    },
                }
            ),
            J(
                {
                    "type": "context.append_loop_event",
                    "event": {
                        "type": "tool.call",
                        "name": "Bash",
                        "args": {"command": "git status"},
                    },
                }
            ),
            J(
                {
                    "type": "context.append_loop_event",
                    "event": {
                        "type": "tool.call",
                        "name": "FetchURL",
                        "args": {"url": "https://example.test"},
                    },
                }
            ),
            J(
                {
                    "type": "context.append_loop_event",
                    "event": {"type": "tool.result", "toolCallId": "tool_1"},
                }
            ),
        ]
    )

    skill = J(
        {
            "type": "context.append_loop_event",
            "event": {"type": "tool.call", "name": "Skill", "args": {"skill": "brainstorming"}},
        }
    )

    def event(name: Any, args: Any) -> str:
        return J(
            {
                "type": "context.append_loop_event",
                "event": {"type": "tool.call", "name": name, "args": args},
            }
        )

    # Lock kimi's source classification: KIMI_NATIVE_TOOLS extends the global
    # set with WebSearch/TodoList/etc, so those are *native* for kimi (unlike
    # gemini). Plus: already-namespaced Skill is left untouched, a Skill with no
    # skill key is left as-is, and non-dict args fall back to {"raw_args": ...}.
    quirks = "\n".join(
        [
            event("WebSearch", {"query": "x"}),
            event("TodoList", {}),
            event("UnknownKimiTool", {"k": "v"}),
            event("Skill", {"skill": "superpowers:already"}),
            event("Skill", {}),
            event("Read", ["not", "a", "dict"]),
            event(123, {"ignored": True}),
        ]
    )

    # Lock missing-args handling: Python `event.get("args", {})` defaults an
    # ABSENT args key to {} (a truly empty dict), NOT to a {"raw_args": ...} wrap.
    missing_args = J(
        {
            "type": "context.append_loop_event",
            "event": {"type": "tool.call", "name": "TodoList"},
        }
    )

    return [
        ("wire tool calls + native source + tool.result ignored", wire),
        ("short superpowers skill name canonicalization", skill),
        ("source set extras native + skill/no-skill + non-dict args", quirks),
        ("missing args key defaults to empty object (not raw_args wrap)", missing_args),
    ]


def copilot_cases() -> list[tuple[str, str]]:
    big = J(
        {
            "type": "assistant.message",
            "data": {
                "toolRequests": [
                    {"name": "skill", "arguments": {"skill": "superpowers:brainstorming"}},
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

    multi = "\n".join(
        [
            J(
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
            J(
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
    )

    bad = "\n".join(
        [
            "not json",
            J([]),
            J({"type": "tool.execution_complete"}),
            J({"type": "session.shutdown"}),
            J({"type": "assistant.message", "data": {"toolRequests": "bad"}}),
            J({"type": "assistant.message", "data": {"toolRequests": [123]}}),
        ]
    )

    write_before_skill = J(
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

    # Lock the truthy-non-string skill case: Python `get("skill") or get("name")`
    # short-circuits on a TRUTHY non-string skill (e.g. a number), so candidate is
    # that non-string value, isinstance(str) is False, and NO rewrite happens —
    # name is NOT consulted and skill/name are left untouched.
    truthy_non_string_skill = J(
        {
            "type": "assistant.message",
            "data": {
                "toolRequests": [
                    {"name": "skill", "arguments": {"skill": 5, "name": "brainstorming"}},
                ]
            },
        }
    )

    return [
        ("assistant tool requests: all 16 mappings", big),
        ("multiple assistant.message lines preserve order", multi),
        ("non-request events and bad lines -> empty", bad),
        ("negative: early write before skill", write_before_skill),
        ("truthy non-string skill -> no rewrite (name not consulted)", truthy_non_string_skill),
    ]


def antigravity_cases() -> list[tuple[str, str]]:
    top_level = "\n".join(
        [
            J(
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
            J({"type": "assistant", "text": "no tools here"}),
        ]
    )

    json_string_literal = J(
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
                {"name": "run_command", "args": {"CommandLine": '"pytest -q"', "Cwd": '"/tmp/run"'}},
                {"name": "list_dir", "args": {"DirectoryPath": '"/tmp/run/src"'}},
            ]
        }
    )

    write_edit_targets = J(
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

    planner = J(
        {
            "PLANNER_RESPONSE": {
                "tool_calls": [
                    {"name": "write_to_file", "args": {"Path": "src/app.py"}},
                    {"name": "replace_file_content", "args": {"path": "src/app.py"}},
                    {"name": "grep_search", "args": {"pattern": "validate"}},
                ]
            }
        }
    )

    lowercase_camel = "\n".join(
        [
            J(
                {
                    "toolCalls": [
                        {"name": "run_command", "args": {"command": "pytest"}},
                        {"name": "list_dir", "args": {"directory_path": "src"}},
                        {"name": "list_dir", "args": {"path": "tests"}},
                    ]
                }
            ),
            J(
                {
                    "planner_response": {
                        "toolCalls": [{"name": "view_file", "args": {"filePath": "src/app.py"}}]
                    }
                }
            ),
        ]
    )

    aliases = J(
        {
            "tool_calls": [
                {"name": "create_file", "args": {"Path": "new.py"}},
                {"name": "multi_replace_file_content", "args": {"path": "existing.py"}},
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

    unknown_manage = J(
        {
            "tool_calls": [
                {"name": "unknown_tool", "args": {"x": 1}},
                {"name": "manage_subagents", "args": {"action": "list"}},
                {"name": "invoke_subagent", "args": {"prompt": "review this"}},
            ]
        }
    )

    non_string_names = J(
        {
            "tool_calls": [
                {"name": 123, "args": {"x": 1}},
                {"name": "run_command", "args": {"command": "pytest -q"}},
            ]
        }
    )

    skill_metadata = J(
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

    # Lock present-null args: Python `tool_call.get("args", {})` defaults only on
    # ABSENCE, so a present-but-null args yields None -> _normalize_antigravity_args
    # returns {"raw_args": None}. (Absent args -> {} -> {"raw_args": {}}.)
    null_args = J({"tool_calls": [{"name": "run_command", "args": None}]})

    return [
        ("top-level tool_calls + PascalCase args + skip non-tool lines", top_level),
        ("JSON string-literal scalar decoding", json_string_literal),
        ("write/edit TargetFile -> file_path", write_edit_targets),
        ("nested PLANNER_RESPONSE tool_calls", planner),
        ("lowercase args + camelCase toolCalls + planner_response", lowercase_camel),
        ("documented aliases + unknown find tool preserved", aliases),
        ("unknown tools + non-launch manage subagents", unknown_manage),
        ("non-string tool names ignored", non_string_names),
        ("skill marker casing + nested metadata", skill_metadata),
        ("present-null args -> raw_args null (absence-only default)", null_args),
    ]


AGENTS: dict[str, Any] = {
    "gemini": (normalize_gemini_logs, gemini_cases),
    "pi": (normalize_pi_logs, pi_cases),
    "copilot": (normalize_copilot_logs, copilot_cases),
    "kimi": (normalize_kimi_logs, kimi_cases),
    "opencode": (normalize_opencode_logs, opencode_cases),
    "antigravity": (normalize_antigravity_logs, antigravity_cases),
}


def build_cases(agent: str) -> list[dict[str, Any]]:
    normalize, builder = AGENTS[agent]
    out: list[dict[str, Any]] = []
    for name, raw in builder():
        out.append({"name": name, "input": raw, "expected": normalize(raw)})
    return out


def coverage(cases: list[dict[str, Any]]) -> list[str]:
    pairs: set[tuple[str, str]] = set()
    for case in cases:
        for row in case["expected"]:
            pairs.add((row["tool"], row["source"]))
    return sorted(f"{tool}:{source}" for tool, source in pairs)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify frozen fixtures (no write)")
    args = parser.parse_args()

    failures = 0
    for agent in AGENTS:
        cases = build_cases(agent)
        path = FIXTURES / agent / "cases.json"
        rows = sum(len(c["expected"]) for c in cases)
        cov = ", ".join(coverage(cases))

        if args.check:
            if not path.exists():
                print(f"MISSING {agent}: {path}")
                failures += 1
                continue
            frozen = json.loads(path.read_text())
            if frozen != cases:
                print(f"DRIFT   {agent}: committed cases.json != oracle output")
                failures += 1
            else:
                print(f"ok      {agent}: {len(cases)} cases, {rows} rows | {cov}")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(cases, indent=2) + "\n")
            print(f"wrote   {agent}: {len(cases)} cases, {rows} rows | {cov}")

    if args.check and failures:
        print(f"\n{failures} fixture(s) drifted or missing.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
