# OpenCode Quorum Coding-Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `opencode` as a first-class Quorum Coding-Agent target that installs Superpowers from local `SUPERPOWERS_ROOT`, launches isolated OpenCode through Gauntlet, exports OpenCode sessions, and normalizes tool calls.

**Architecture:** Keep OpenCode inside Quorum's existing Coding-Agent model: one YAML config, one context launcher, runner-level config seeding, one export helper, one normalizer, and shared trace checks. The only capture-model extension is a target-specific post-Gauntlet export step that turns OpenCode's SQLite-backed sessions into JSON files before the existing file-diff normalizer runs.

**Tech Stack:** Python 3.11+, uv, pytest, ty, ruff, Bash check tools, jq, Gauntlet TUI adapter, OpenCode CLI `1.15.x`.

**Spec:** [docs/superpowers/specs/2026-06-03-opencode-quorum-coding-agent-design.md](../specs/2026-06-03-opencode-quorum-coding-agent-design.md)

---

## File Structure

**Create:**
- `quorum/opencode_capture.py` - isolated OpenCode env construction and session export helper.
- `tests/quorum/test_opencode_capture.py` - export helper tests.
- `coding-agents/opencode.yaml` - OpenCode Coding-Agent config.
- `coding-agents/opencode-context/HOWTO.md` - Gauntlet-Agent driver instructions.
- `coding-agents/opencode-context/launch-agent` - generated launcher template for `opencode run -i`.
- `bin/opencode-plugin-installed` - deterministic check for the staged Superpowers OpenCode plugin.
- `scenarios/opencode-superpowers-bootstrap/story.md` - OpenCode bootstrap smoke scenario.
- `scenarios/opencode-superpowers-bootstrap/setup.sh` - base fixture setup.
- `scenarios/opencode-superpowers-bootstrap/checks.sh` - OpenCode bootstrap checks.

**Modify:**
- `quorum/normalizers.py` - add OpenCode tool normalization and register `normalizer: opencode`.
- `quorum/runner.py` - seed OpenCode config, export sessions after Gauntlet, and add OpenCode capture diagnostics.
- `tests/quorum/test_normalizers.py` - OpenCode normalizer coverage.
- `tests/quorum/test_runner.py` - OpenCode seeding, launcher, export, and capture diagnostics.
- `tests/quorum/test_coding_agent_config.py` - OpenCode YAML load coverage.
- `tests/quorum/test_trace_tools.py` - OpenCode-normalized write/edit rows against implementation-path checks.
- `tests/quorum/test_opencode_plugin_installed.py` - deterministic check-tool coverage for `bin/opencode-plugin-installed`.
- `README.md` - add OpenCode target command and safety note if the target list is documented there.

**Do Not Change:**
- Public CI to launch OpenCode live evals.
- Existing Claude, Codex, Pi, Gemini, or Antigravity target behavior except where shared test helpers need another target name.
- OpenCode's real SQLite schema. Use `opencode session list` and `opencode export`.

---

## Task 1: OpenCode Normalizer

**Files:**
- Modify: `quorum/normalizers.py`
- Modify: `tests/quorum/test_normalizers.py`
- Modify: `tests/quorum/test_trace_tools.py`

- [ ] **Step 1: Write failing normalizer tests**

In `tests/quorum/test_normalizers.py`, add `normalize_opencode_logs` to the import list:

```python
from quorum.normalizers import (
    collect_new_logs,
    filter_codex_logs_by_cwd,
    filter_pi_logs_by_cwd,
    find_misplaced_codex_rollouts,
    normalize_antigravity_logs,
    normalize_claude_logs,
    normalize_codex_logs,
    normalize_gemini_logs,
    normalize_opencode_logs,
    normalize_pi_logs,
    snapshot_log_dir,
)
```

Add this class after `TestNormalizeGeminiLogs`:

```python
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
                        {"type": "tool", "tool": "write", "state": {"input": {"path": "app.py", "content": "x"}}},
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
                        {"type": "tool", "tool": "webfetch", "state": {"input": {"url": "https://example.com"}}},
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
        assert normalize_opencode_logs(json.dumps({"messages": [{"parts": [{"type": "text"}]}]})) == []
```

- [ ] **Step 2: Add trace-tool compatibility coverage**

In `tests/quorum/test_trace_tools.py`, add a focused test near the existing
skill/implementation-path checks. Add `json` and
`quorum.normalizers.normalize_opencode_logs` imports if the file does not
already have them:

```python
def test_skill_before_implementation_tool_accepts_opencode_apply_patch_rows(tmp_path):
    workdir = tmp_path / "workdir"
    workdir.mkdir()
    rows = normalize_opencode_logs(
        json.dumps(
            {
                "messages": [
                    {
                        "parts": [
                            {
                                "type": "tool",
                                "tool": "skill",
                                "state": {"input": {"name": "brainstorming"}},
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
                        ]
                    }
                ]
            }
        )
    )
    trace = _trace(
        tmp_path,
        *rows,
    )
    sink = tmp_path / "records.jsonl"

    assert (
        _run(
            "skill-before-implementation-tool",
            "superpowers:brainstorming",
            "Edit",
            trace=trace,
            cwd=workdir,
            sink=sink,
        )
        == 0
    )
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
uv run pytest tests/quorum/test_normalizers.py -x -q
```

Expected: FAIL with `ImportError` or unknown import for `normalize_opencode_logs`.

- [ ] **Step 4: Implement the normalizer**

In `quorum/normalizers.py`, add the OpenCode map below `GEMINI_TOOL_MAP` or before `ANTIGRAVITY_TOOL_MAP`:

```python
OPENCODE_TOOL_MAP: dict[str, str] = {
    "skill": "Skill",
    "task": "Agent",
    "bash": "Bash",
    "read": "Read",
    "write": "Write",
    "edit": "Edit",
    "apply_patch": "Edit",
    "grep": "Grep",
    "glob": "Glob",
    "todowrite": "TodoWrite",
    "webfetch": "WebFetch",
    "websearch": "WebSearch",
}

OPENCODE_NATIVE_TOOLS = (set(OPENCODE_TOOL_MAP.values()) - {"Bash"}) | {
    "TodoWrite",
    "WebFetch",
    "WebSearch",
}
```

Add these helpers and normalizer:

```python
def _opencode_tool_input(part: dict[str, Any]) -> Any:
    state = part.get("state")
    if not isinstance(state, dict):
        return {}
    raw_input = state.get("input", {})
    return raw_input


def _opencode_apply_patch_paths(patch_text: Any) -> list[str]:
    if not isinstance(patch_text, str):
        return []
    paths: list[str] = []
    prefixes = (
        "*** Add File: ",
        "*** Update File: ",
        "*** Delete File: ",
    )
    for line in patch_text.splitlines():
        for prefix in prefixes:
            if line.startswith(prefix):
                path = line[len(prefix):].strip()
                if path:
                    paths.append(path)
                break
    return paths


def _normalize_opencode_args(name: str, raw_input: Any) -> dict[str, Any]:
    args = dict(raw_input) if isinstance(raw_input, dict) else {}
    args["raw_input"] = raw_input

    if name == "skill":
        skill_name = ""
        if isinstance(raw_input, dict):
            candidate = raw_input.get("skill") or raw_input.get("name")
            if isinstance(candidate, str):
                skill_name = candidate
        if skill_name:
            args["name"] = skill_name.split(":", 1)[-1]
            args["skill"] = skill_name if ":" in skill_name else f"superpowers:{skill_name}"

    if name == "bash" and "command" not in args:
        command = args.get("cmd")
        if isinstance(command, str):
            args["command"] = command

    if name in {"read", "write", "edit"} and "file_path" not in args:
        for key in ("file_path", "filePath", "path", "file"):
            value = args.get(key)
            if isinstance(value, str):
                args["file_path"] = value
                break

    if name == "apply_patch" and "file_path" not in args:
        patch_text = args.get("patch")
        if not isinstance(patch_text, str) and isinstance(raw_input, str):
            patch_text = raw_input
        paths = _opencode_apply_patch_paths(patch_text)
        if paths:
            args["file_path"] = paths[0]
            args["file_paths"] = paths

    return args


def normalize_opencode_logs(raw_content: str) -> list[dict[str, Any]]:
    """Normalize OpenCode exported session JSON tool parts."""
    try:
        data = json.loads(raw_content)
    except json.JSONDecodeError:
        return []
    if not isinstance(data, dict):
        return []

    results: list[dict[str, Any]] = []
    messages = data.get("messages", [])
    if not isinstance(messages, list):
        return []

    for message in messages:
        if not isinstance(message, dict):
            continue
        parts = message.get("parts", [])
        if not isinstance(parts, list):
            continue
        for part in parts:
            if not isinstance(part, dict) or part.get("type") != "tool":
                continue
            name = part.get("tool", "")
            if not isinstance(name, str) or not name:
                continue
            canonical = OPENCODE_TOOL_MAP.get(name, name)
            args = _normalize_opencode_args(name, _opencode_tool_input(part))
            source = "native" if canonical in OPENCODE_NATIVE_TOOLS else "shell"
            results.append({"tool": canonical, "args": args, "source": source})
    return results
```

Register it in `NORMALIZERS`:

```python
NORMALIZERS: dict[str, Callable[[str], list[dict[str, Any]]]] = {
    "antigravity": normalize_antigravity_logs,
    "claude": normalize_claude_logs,
    "codex": normalize_codex_logs,
    "gemini": normalize_gemini_logs,
    "opencode": normalize_opencode_logs,
    "pi": normalize_pi_logs,
}
```

- [ ] **Step 5: Run normalizer and trace tests**

Run:

```bash
uv run pytest tests/quorum/test_normalizers.py tests/quorum/test_trace_tools.py -x -q
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add quorum/normalizers.py tests/quorum/test_normalizers.py tests/quorum/test_trace_tools.py
git commit -m "quorum: normalize opencode session exports"
```

---

## Task 2: OpenCode Session Export Helper

**Files:**
- Create: `quorum/opencode_capture.py`
- Create: `tests/quorum/test_opencode_capture.py`

- [ ] **Step 1: Write failing export helper tests**

Create `tests/quorum/test_opencode_capture.py`:

```python
import json
import os
import subprocess
from pathlib import Path

import pytest

from quorum.opencode_capture import (
    OpenCodeCaptureError,
    export_opencode_sessions,
    opencode_env,
    opencode_run_env,
    snapshot_opencode_sessions,
)


def test_opencode_env_isolates_home_and_xdg(tmp_path):
    home = tmp_path / "home"

    env = opencode_env(home)

    assert env == {
        "HOME": str(home),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_DATA_HOME": str(home / ".local" / "share"),
        "XDG_STATE_HOME": str(home / ".local" / "state"),
        "XDG_CACHE_HOME": str(home / ".cache"),
        "TMPDIR": str(home / ".tmp"),
        "OPENCODE_CONFIG_DIR": str(home / ".config" / "opencode"),
    }


def test_opencode_run_env_scrubs_harness_paths_and_preserves_provider_env(
    tmp_path, monkeypatch
):
    home = tmp_path / "home"
    monkeypatch.setenv("SUPERPOWERS_ROOT", "/real/superpowers")
    monkeypatch.setenv("QUORUM_AGENT_CWD", "/real/workdir")
    monkeypatch.setenv("OPENCODE_CONFIG_DIR", "/real/opencode")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setenv("PATH", "/bin")

    env = opencode_run_env(home)

    assert env["OPENAI_API_KEY"] == "sk-test"
    assert env["PATH"] == "/bin"
    assert env["OPENCODE_CONFIG_DIR"] == str(home / ".config" / "opencode")
    assert "SUPERPOWERS_ROOT" not in env
    assert "QUORUM_AGENT_CWD" not in env


def test_snapshot_opencode_sessions_filters_by_launch_cwd(tmp_path, monkeypatch):
    home = tmp_path / "home"
    launch_cwd = tmp_path / "project"
    launch_cwd.mkdir()

    def fake_run(cmd, **kwargs):
        assert cmd == ["opencode", "session", "list", "--format", "json"]
        assert kwargs["cwd"] == launch_cwd
        return subprocess.CompletedProcess(
            cmd,
            0,
            json.dumps(
                [
                    {"id": "ses_old", "directory": str(launch_cwd)},
                    {"id": "ses_other", "directory": str(tmp_path / "other")},
                ]
            ),
            "",
        )

    monkeypatch.setattr("quorum.opencode_capture.subprocess.run", fake_run)

    assert snapshot_opencode_sessions(opencode_home=home, launch_cwd=launch_cwd) == {
        "ses_old"
    }


def test_export_opencode_sessions_exports_only_new_matching_sessions_and_manifest(
    tmp_path, monkeypatch
):
    home = tmp_path / "home"
    export_dir = home / ".quorum" / "session-exports"
    launch_real = tmp_path / "real-project"
    launch_real.mkdir()
    launch_link = tmp_path / "linked-project"
    launch_link.symlink_to(launch_real, target_is_directory=True)
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append((cmd, kwargs))
        assert kwargs["cwd"] == launch_link
        assert kwargs["text"] is True
        assert kwargs["capture_output"] is True
        assert kwargs["env"]["HOME"] == str(home)
        assert "SUPERPOWERS_ROOT" not in kwargs["env"]
        if cmd == ["opencode", "session", "list", "--format", "json"]:
            return subprocess.CompletedProcess(
                cmd,
                0,
                json.dumps(
                    [
                        {
                            "id": "ses_old",
                            "directory": str(launch_real.resolve()),
                            "created": 100,
                        },
                        {
                            "id": "ses_new",
                            "directory": str(launch_real.resolve()),
                            "created": 200,
                        },
                        {"id": "ses_other", "directory": str(tmp_path / "other")},
                    ]
                ),
                "",
            )
        if cmd == ["opencode", "export", "ses_new"]:
            return subprocess.CompletedProcess(
                cmd,
                0,
                json.dumps(
                    {
                        "info": {
                            "id": "ses_new",
                            "time": {"created": 200},
                        },
                        "messages": [],
                    }
                ),
                "Exporting session: ses_new\n",
            )
        raise AssertionError(f"unexpected command: {cmd}")

    monkeypatch.setattr("quorum.opencode_capture.subprocess.run", fake_run)

    exported = export_opencode_sessions(
        opencode_home=home,
        export_dir=export_dir,
        launch_cwd=launch_link,
        snapshot={"ses_old"},
    )

    assert exported == (export_dir / "0000000000000200-ses_new.json",)
    assert json.loads(exported[0].read_text())["info"]["id"] == "ses_new"
    manifest = json.loads((export_dir / "opencode-session-export-manifest.json").read_text())
    assert manifest["raw_session_rows"][0]["id"] == "ses_old"
    assert manifest["snapshot_ids"] == ["ses_old"]
    assert manifest["matched_ids"] == ["ses_new"]
    assert manifest["skipped_existing_ids"] == ["ses_old"]
    assert manifest["skipped_nonmatching_ids"] == ["ses_other"]
    assert manifest["session_decisions"][0]["matched"] is True
    assert manifest["session_decisions"][2]["matched"] is False
    assert manifest["exports"][0]["stderr"] == "Exporting session: ses_new\n"
    assert [call[0] for call in calls] == [
        ["opencode", "session", "list", "--format", "json"],
        ["opencode", "export", "ses_new"],
    ]


def test_export_opencode_sessions_returns_empty_when_no_matching_session(tmp_path, monkeypatch):
    home = tmp_path / "home"
    launch_cwd = tmp_path / "project"
    launch_cwd.mkdir()

    def fake_run(cmd, **kwargs):
        assert cmd == ["opencode", "session", "list", "--format", "json"]
        return subprocess.CompletedProcess(
            cmd,
            0,
            json.dumps([{"id": "ses_other", "directory": str(tmp_path / "other")}]),
            "",
        )

    monkeypatch.setattr("quorum.opencode_capture.subprocess.run", fake_run)

    assert export_opencode_sessions(
        opencode_home=home,
        export_dir=home / ".quorum" / "session-exports",
        launch_cwd=launch_cwd,
        snapshot=set(),
    ) == ()


def test_export_opencode_sessions_orders_by_exported_created_when_list_lacks_created(
    tmp_path, monkeypatch
):
    home = tmp_path / "home"
    export_dir = home / ".quorum" / "session-exports"
    launch_cwd = tmp_path / "project"
    launch_cwd.mkdir()

    def fake_run(cmd, **kwargs):
        if cmd == ["opencode", "session", "list", "--format", "json"]:
            return subprocess.CompletedProcess(
                cmd,
                0,
                json.dumps(
                    [
                        {"id": "ses_late", "directory": str(launch_cwd)},
                        {"id": "ses_early", "directory": str(launch_cwd)},
                    ]
                ),
                "",
            )
        session_id = cmd[-1]
        created = {"ses_early": 10, "ses_late": 20}[session_id]
        return subprocess.CompletedProcess(
            cmd,
            0,
            json.dumps({"info": {"id": session_id, "time": {"created": created}}, "messages": []}),
            "",
        )

    monkeypatch.setattr("quorum.opencode_capture.subprocess.run", fake_run)

    exported = export_opencode_sessions(
        opencode_home=home,
        export_dir=export_dir,
        launch_cwd=launch_cwd,
        snapshot=set(),
    )

    assert exported == (
        export_dir / "0000000000000010-ses_early.json",
        export_dir / "0000000000000020-ses_late.json",
    )


def test_export_opencode_sessions_raises_on_list_failure(tmp_path, monkeypatch):
    def fake_run(cmd, **kwargs):
        return subprocess.CompletedProcess(cmd, 1, "", "bad auth")

    monkeypatch.setattr("quorum.opencode_capture.subprocess.run", fake_run)

    with pytest.raises(OpenCodeCaptureError, match="session list"):
        export_opencode_sessions(
            opencode_home=tmp_path / "home",
            export_dir=tmp_path / "exports",
            launch_cwd=tmp_path,
            snapshot=set(),
        )


def test_export_opencode_sessions_raises_on_export_failure(tmp_path, monkeypatch):
    launch_cwd = tmp_path / "project"
    launch_cwd.mkdir()

    def fake_run(cmd, **kwargs):
        if cmd == ["opencode", "session", "list", "--format", "json"]:
            return subprocess.CompletedProcess(
                cmd,
                0,
                json.dumps([{"id": "ses_match", "directory": str(launch_cwd), "created": 10}]),
                "",
            )
        return subprocess.CompletedProcess(cmd, 2, "", "export failed")

    monkeypatch.setattr("quorum.opencode_capture.subprocess.run", fake_run)

    with pytest.raises(OpenCodeCaptureError, match="export ses_match"):
        export_opencode_sessions(
            opencode_home=tmp_path / "home",
            export_dir=tmp_path / "exports",
            launch_cwd=launch_cwd,
            snapshot=set(),
        )


def test_export_opencode_sessions_raises_when_multiple_new_sessions_lack_ordering(
    tmp_path, monkeypatch
):
    launch_cwd = tmp_path / "project"
    launch_cwd.mkdir()

    def fake_run(cmd, **kwargs):
        if cmd == ["opencode", "session", "list", "--format", "json"]:
            return subprocess.CompletedProcess(
                cmd,
                0,
                json.dumps(
                    [
                        {"id": "ses_a", "directory": str(launch_cwd)},
                        {"id": "ses_b", "directory": str(launch_cwd)},
                    ]
                ),
                "",
            )
        session_id = cmd[-1]
        return subprocess.CompletedProcess(
            cmd,
            0,
            json.dumps({"info": {"id": session_id}, "messages": []}),
            "",
        )

    monkeypatch.setattr("quorum.opencode_capture.subprocess.run", fake_run)

    with pytest.raises(OpenCodeCaptureError, match="cannot order"):
        export_opencode_sessions(
            opencode_home=tmp_path / "home",
            export_dir=tmp_path / "exports",
            launch_cwd=launch_cwd,
            snapshot=set(),
        )
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
uv run pytest tests/quorum/test_opencode_capture.py -x -q
```

Expected: FAIL because `quorum.opencode_capture` does not exist.

- [ ] **Step 3: Implement `quorum/opencode_capture.py`**

Create `quorum/opencode_capture.py`:

```python
"""Export OpenCode sessions from isolated per-run state."""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any


class OpenCodeCaptureError(RuntimeError):
    """Raised when OpenCode session export cannot complete."""


def opencode_env(opencode_home: Path) -> dict[str, str]:
    return {
        "HOME": str(opencode_home),
        "XDG_CONFIG_HOME": str(opencode_home / ".config"),
        "XDG_DATA_HOME": str(opencode_home / ".local" / "share"),
        "XDG_STATE_HOME": str(opencode_home / ".local" / "state"),
        "XDG_CACHE_HOME": str(opencode_home / ".cache"),
        "TMPDIR": str(opencode_home / ".tmp"),
        "OPENCODE_CONFIG_DIR": str(opencode_home / ".config" / "opencode"),
    }


OPENCODE_ENV_ALLOWLIST = {
    "PATH",
    "TERM",
    "COLORTERM",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "REQUESTS_CA_BUNDLE",
    "NODE_EXTRA_CA_CERTS",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "AWS_PROFILE",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
}


def opencode_run_env(opencode_home: Path) -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if key in OPENCODE_ENV_ALLOWLIST}
    env.setdefault("PATH", os.defpath)
    env.setdefault("TERM", "xterm-256color")
    env.setdefault("LANG", "C.UTF-8")
    env.update(opencode_env(opencode_home))
    return env


def _realpath(value: str | Path) -> str:
    return os.path.realpath(str(value))


def _session_decisions(
    raw_sessions: Any, launch_cwd: Path
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    if not isinstance(raw_sessions, list):
        raise OpenCodeCaptureError("opencode session list returned non-list JSON")
    target = _realpath(launch_cwd)
    decisions: list[dict[str, Any]] = []
    matches: list[dict[str, Any]] = []
    for index, session in enumerate(raw_sessions):
        if not isinstance(session, dict):
            decisions.append({"index": index, "matched": False, "reason": "non-dict row"})
            continue
        directory = session.get("directory")
        session_id = session.get("id")
        if not isinstance(directory, str) or not isinstance(session_id, str):
            decisions.append(
                {
                    "index": index,
                    "id": session_id,
                    "matched": False,
                    "reason": "missing id or directory",
                }
            )
            continue
        directory_realpath = _realpath(directory)
        matched = directory_realpath == target
        decisions.append(
            {
                "index": index,
                "id": session_id,
                "directory": directory,
                "directory_realpath": directory_realpath,
                "launch_cwd_realpath": target,
                "matched": matched,
            }
        )
        if matched:
            matches.append(session)
    return decisions, matches


def _list_sessions(*, opencode_home: Path, launch_cwd: Path) -> list[dict[str, Any]]:
    result = subprocess.run(
        ["opencode", "session", "list", "--format", "json"],
        cwd=launch_cwd,
        text=True,
        capture_output=True,
        env=opencode_run_env(opencode_home),
    )
    if result.returncode != 0:
        raise OpenCodeCaptureError(
            "opencode session list failed "
            f"(exit {result.returncode}): {result.stderr.strip()[:300]}"
        )
    try:
        sessions = json.loads(result.stdout or "[]")
    except json.JSONDecodeError as e:
        raise OpenCodeCaptureError("opencode session list returned invalid JSON") from e
    if not isinstance(sessions, list):
        raise OpenCodeCaptureError("opencode session list returned non-list JSON")
    return sessions


def snapshot_opencode_sessions(*, opencode_home: Path, launch_cwd: Path) -> set[str]:
    _decisions, sessions = _session_decisions(
        _list_sessions(opencode_home=opencode_home, launch_cwd=launch_cwd), launch_cwd
    )
    return {session["id"] for session in sessions}


def _session_created(session: dict[str, Any]) -> int | None:
    for key in ("created", "time_created"):
        value = session.get(key)
        if isinstance(value, int):
            return value
    return None


def _export_session(
    *, session_id: str, opencode_home: Path, launch_cwd: Path
) -> tuple[dict[str, Any], str, str]:
    result = subprocess.run(
        ["opencode", "export", session_id],
        cwd=launch_cwd,
        text=True,
        capture_output=True,
        env=opencode_run_env(opencode_home),
    )
    if result.returncode != 0:
        raise OpenCodeCaptureError(
            f"opencode export {session_id} failed "
            f"(exit {result.returncode}): {result.stderr.strip()[:300]}"
        )
    try:
        exported_json = json.loads(result.stdout)
    except json.JSONDecodeError as e:
        raise OpenCodeCaptureError(f"opencode export {session_id} returned invalid JSON") from e
    exported_id = exported_json.get("info", {}).get("id")
    if exported_id != session_id:
        raise OpenCodeCaptureError(
            f"opencode export {session_id} returned session id {exported_id!r}"
        )
    return exported_json, result.stdout, result.stderr


def _exported_created(exported_json: dict[str, Any]) -> int | None:
    created = exported_json.get("info", {}).get("time", {}).get("created")
    return created if isinstance(created, int) else None


def export_opencode_sessions(
    *,
    opencode_home: Path,
    export_dir: Path,
    launch_cwd: Path,
    snapshot: set[str],
) -> tuple[Path, ...]:
    """Export OpenCode sessions for launch_cwd into export_dir."""
    export_dir.mkdir(parents=True, exist_ok=True)
    raw_sessions = _list_sessions(opencode_home=opencode_home, launch_cwd=launch_cwd)
    decisions, sessions = _session_decisions(raw_sessions, launch_cwd)
    new_sessions = [session for session in sessions if session["id"] not in snapshot]
    export_records: list[dict[str, Any]] = []
    for session in new_sessions:
        session_id = session["id"]
        exported_json, stdout, stderr = _export_session(
            session_id=session_id, opencode_home=opencode_home, launch_cwd=launch_cwd
        )
        created = _session_created(session) or _exported_created(exported_json)
        export_records.append(
            {
                "session": session,
                "id": session_id,
                "json": exported_json,
                "stdout": stdout,
                "stderr": stderr,
                "created": created,
            }
        )
    if len(export_records) > 1 and any(record["created"] is None for record in export_records):
        raise OpenCodeCaptureError("cannot order multiple new OpenCode sessions without creation times")
    export_records.sort(key=lambda record: (record["created"] or 0, record["id"]))
    exported: list[Path] = []
    manifest: dict[str, Any] = {
        "raw_session_rows": raw_sessions,
        "session_decisions": decisions,
        "snapshot_ids": sorted(snapshot),
        "all_matching_ids": [session["id"] for session in sessions],
        "matched_ids": [session["id"] for session in new_sessions],
        "skipped_existing_ids": [session["id"] for session in sessions if session["id"] in snapshot],
        "skipped_nonmatching_ids": [
            decision["id"]
            for decision in decisions
            if decision.get("id") and not decision.get("matched")
        ],
        "exports": [],
    }
    for record in export_records:
        created = record["created"] or 0
        out_path = export_dir / f"{created:016d}-{record['id']}.json"
        out_path.write_text(record["stdout"])
        manifest["exports"].append(
            {
                "id": record["id"],
                "created": created,
                "path": str(out_path),
                "stderr": record["stderr"],
            }
        )
        exported.append(out_path)

    (export_dir / "opencode-session-export-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n"
    )
    return tuple(exported)
```

- [ ] **Step 4: Run export helper tests**

Run:

```bash
uv run pytest tests/quorum/test_opencode_capture.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add quorum/opencode_capture.py tests/quorum/test_opencode_capture.py
git commit -m "quorum: export isolated opencode sessions"
```

---

## Task 3: OpenCode Provisioning Hook

**Files:**
- Modify: `quorum/runner.py`
- Modify: `tests/quorum/test_runner.py`

- [ ] **Step 1: Write failing seeding tests**

In `tests/quorum/test_runner.py`, add this helper near `_antigravity_tcfg()`:

```python
def _opencode_tcfg() -> CodingAgentConfig:
    return CodingAgentConfig(
        name="opencode",
        binary="opencode",
        agent_config_env="OPENCODE_QUORUM_HOME",
        session_log_dir="${OPENCODE_QUORUM_HOME}/.quorum/session-exports",
        session_log_glob="[0-9]*-ses_*.json",
        normalizer="opencode",
        required_env=("SUPERPOWERS_ROOT",),
        max_time="10m",
        project_prompt=None,
    )
```

Add tests to `TestSeedAgentConfigDir`:

```python
def test_opencode_seed_requires_superpowers_root(self, tmp_path, monkeypatch):
    monkeypatch.delenv("SUPERPOWERS_ROOT", raising=False)
    monkeypatch.setattr("quorum.runner.shutil.which", lambda name: "/usr/bin/opencode")

    with pytest.raises(RunnerError, match="SUPERPOWERS_ROOT"):
        _seed_agent_config_dir(_opencode_tcfg(), tmp_path, tmp_path / "cfg", tmp_path / "wd")


def test_opencode_seed_requires_opencode_binary(self, tmp_path, monkeypatch):
    sp = tmp_path / "superpowers"
    (sp / ".opencode" / "plugins").mkdir(parents=True)
    (sp / ".opencode" / "plugins" / "superpowers.js").write_text("export {};")
    (sp / "skills" / "using-superpowers").mkdir(parents=True)
    (sp / "skills" / "using-superpowers" / "SKILL.md").write_text("skill")
    (sp / "skills" / "brainstorming").mkdir(parents=True)
    (sp / "skills" / "brainstorming" / "SKILL.md").write_text("skill")
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(sp))
    monkeypatch.setattr("quorum.runner.shutil.which", lambda name: None)

    with pytest.raises(RunnerError, match="opencode not found"):
        _seed_agent_config_dir(_opencode_tcfg(), tmp_path, tmp_path / "cfg", tmp_path / "wd")


def test_opencode_seed_stages_plugin_layout(self, tmp_path, monkeypatch):
    sp = tmp_path / "superpowers"
    plugin_src = sp / ".opencode" / "plugins" / "superpowers.js"
    plugin_src.parent.mkdir(parents=True)
    plugin_src.write_text("export const SuperpowersPlugin = async () => ({});")
    for skill_name in ("using-superpowers", "brainstorming"):
        skill_dir = sp / "skills" / skill_name
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(f"# {skill_name}")
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(sp))
    monkeypatch.setattr("quorum.runner.shutil.which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(
        "quorum.runner.subprocess.run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 0, "", ""),
    )

    dest = tmp_path / "cfg"
    _seed_agent_config_dir(_opencode_tcfg(), tmp_path, dest, tmp_path / "wd")

    config_dir = dest / ".config" / "opencode"
    staged_plugin = config_dir / "superpowers" / ".opencode" / "plugins" / "superpowers.js"
    plugin_link = config_dir / "plugins" / "superpowers.js"
    staged_skills = config_dir / "superpowers" / "skills"

    assert staged_plugin.read_text() == plugin_src.read_text()
    assert plugin_link.is_symlink()
    assert plugin_link.resolve() == staged_plugin.resolve()
    assert staged_skills.is_dir()
    assert not staged_skills.is_symlink()
    assert (staged_skills / "using-superpowers" / "SKILL.md").exists()
    assert staged_skills.resolve().is_relative_to(dest.resolve())
    assert (dest / ".local" / "share" / "opencode").is_dir()
    assert (dest / ".local" / "state" / "opencode").is_dir()
    assert (dest / ".cache").is_dir()
    assert (dest / ".tmp").is_dir()
    assert (dest / ".quorum" / "session-exports").is_dir()


def test_opencode_seed_rejects_skill_tree_symlinks(self, tmp_path, monkeypatch):
    sp = tmp_path / "superpowers"
    plugin_src = sp / ".opencode" / "plugins" / "superpowers.js"
    plugin_src.parent.mkdir(parents=True)
    plugin_src.write_text("export const SuperpowersPlugin = async () => ({});")
    (sp / "skills" / "using-superpowers").mkdir(parents=True)
    (sp / "skills" / "using-superpowers" / "SKILL.md").write_text("skill")
    (sp / "skills" / "brainstorming").mkdir(parents=True)
    (sp / "skills" / "brainstorming" / "SKILL.md").write_text("skill")
    (sp / "skills" / "brainstorming" / "escape").symlink_to(tmp_path)
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(sp))
    monkeypatch.setattr("quorum.runner.shutil.which", lambda name: f"/usr/bin/{name}")

    with pytest.raises(RunnerError, match="symlink"):
        _seed_agent_config_dir(_opencode_tcfg(), tmp_path, tmp_path / "cfg", tmp_path / "wd")


def test_opencode_seed_rejects_preexisting_session_exports(self, tmp_path, monkeypatch):
    sp = tmp_path / "superpowers"
    plugin_src = sp / ".opencode" / "plugins" / "superpowers.js"
    plugin_src.parent.mkdir(parents=True)
    plugin_src.write_text("export const SuperpowersPlugin = async () => ({});")
    for skill_name in ("using-superpowers", "brainstorming"):
        skill_dir = sp / "skills" / skill_name
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(f"# {skill_name}")
    dest = tmp_path / "cfg"
    stale = dest / ".quorum" / "session-exports" / "0000000000000001-ses_old.json"
    stale.parent.mkdir(parents=True)
    stale.write_text("{}")
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(sp))
    monkeypatch.setattr("quorum.runner.shutil.which", lambda name: f"/usr/bin/{name}")

    with pytest.raises(RunnerError, match="pre-existing OpenCode session exports"):
        _seed_agent_config_dir(_opencode_tcfg(), tmp_path, dest, tmp_path / "wd")
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
uv run pytest tests/quorum/test_runner.py::TestSeedAgentConfigDir -x -q
```

Expected: FAIL because `_seed_agent_config_dir` does not handle `opencode`.

- [ ] **Step 3: Implement `_seed_opencode_config`**

In `quorum/runner.py`, import `opencode_run_env` from
`quorum.opencode_capture` and add constants near the existing target constants:

```python
OPENCODE_EXPORT_SUBDIR = Path(".quorum/session-exports")
```

Add this helper near the other seeding helpers. Reuse the existing
`_preflight_response_ok` helper already defined for Antigravity:

```python
def _run_opencode_provider_preflight() -> None:
    """Verify OpenCode can answer in a throwaway isolated home."""
    with tempfile.TemporaryDirectory(prefix="quorum-opencode-preflight-") as tmp:
        tmp_path = Path(tmp)
        cwd = tmp_path / "cwd"
        cwd.mkdir()
        home = tmp_path / "home"
        for path in (
            home / ".config" / "opencode",
            home / ".local" / "share" / "opencode",
            home / ".local" / "state" / "opencode",
            home / ".cache",
            home / ".tmp",
        ):
            path.mkdir(parents=True, exist_ok=True)
        version_hint = "unknown"
        try:
            version = subprocess.run(
                ["opencode", "--version"],
                cwd=cwd,
                text=True,
                capture_output=True,
                timeout=15,
                env=opencode_run_env(home),
            )
            version_hint = (version.stdout or version.stderr).strip() or "unknown"
        except (subprocess.TimeoutExpired, OSError):
            pass
        try:
            result = subprocess.run(
                [
                    "opencode",
                    "run",
                    "--dangerously-skip-permissions",
                    "Reply with EXACTLY OK.",
                ],
                cwd=cwd,
                text=True,
                capture_output=True,
                timeout=90,
                env=opencode_run_env(home),
            )
        except subprocess.TimeoutExpired as e:
            raise RunnerError(
                "opencode provider preflight timed out after 90s",
                stage="setup",
            ) from e
    if result.returncode != 0:
        raise RunnerError(
            "opencode provider preflight failed "
            f"(version {version_hint[:120]}, exit {result.returncode}); "
            f"stderr: {result.stderr.strip()[:300]}",
            stage="setup",
        )
    if not _preflight_response_ok(result.stdout):
        raise RunnerError(
            "opencode provider preflight did not return OK; "
            f"version {version_hint[:120]}, stdout: {result.stdout.strip()[:300]}",
            stage="setup",
        )


def _reject_symlinks(root: Path, *, label: str) -> None:
    for path in root.rglob("*"):
        if path.is_symlink():
            raise RunnerError(f"{label} contains unsupported symlink: {path}", stage="setup")


def _require_under_home(path: Path, opencode_home: Path) -> None:
    if not path.resolve().is_relative_to(opencode_home.resolve()):
        raise RunnerError(
            f"staged OpenCode Superpowers path escapes isolated home: {path}",
            stage="setup",
        )


def _seed_opencode_config(opencode_home: Path) -> None:
    """Install Superpowers into an isolated OpenCode home."""
    superpowers_root = os.environ.get("SUPERPOWERS_ROOT", "")
    if not superpowers_root:
        raise RunnerError(
            "SUPERPOWERS_ROOT not set; cannot install opencode Superpowers plugin",
            stage="setup",
        )
    if shutil.which("opencode") is None:
        raise RunnerError("opencode not found on PATH; cannot run opencode evals", stage="setup")

    sp_root = Path(superpowers_root)
    plugin_src = sp_root / ".opencode" / "plugins" / "superpowers.js"
    required = [
        plugin_src,
        sp_root / "skills" / "using-superpowers" / "SKILL.md",
        sp_root / "skills" / "brainstorming" / "SKILL.md",
    ]
    missing = [str(p) for p in required if not p.exists()]
    if missing:
        raise RunnerError(
            "SUPERPOWERS_ROOT is missing OpenCode plugin files: " + ", ".join(missing),
            stage="setup",
        )

    export_dir = opencode_home / OPENCODE_EXPORT_SUBDIR
    stale_exports = sorted(export_dir.glob("[0-9]*-ses_*.json"))
    if stale_exports:
        raise RunnerError(
            "pre-existing OpenCode session exports before capture snapshot: "
            + ", ".join(str(path) for path in stale_exports[:3]),
            stage="setup",
        )

    _reject_symlinks(sp_root / "skills", label="SUPERPOWERS_ROOT skills")

    opencode_config_dir = opencode_home / ".config" / "opencode"
    for path in (
        opencode_config_dir,
        opencode_home / ".local" / "share" / "opencode",
        opencode_home / ".local" / "state" / "opencode",
        opencode_home / ".cache",
        opencode_home / ".tmp",
        export_dir,
    ):
        path.mkdir(parents=True, exist_ok=True)

    package_root = opencode_config_dir / "superpowers"
    staged_plugin = package_root / ".opencode" / "plugins" / "superpowers.js"
    staged_plugin.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(plugin_src, staged_plugin)

    staged_skills = package_root / "skills"
    if staged_skills.exists() or staged_skills.is_symlink():
        if staged_skills.is_dir() and not staged_skills.is_symlink():
            shutil.rmtree(staged_skills)
        else:
            staged_skills.unlink()
    shutil.copytree(sp_root / "skills", staged_skills)

    plugin_link = opencode_config_dir / "plugins" / "superpowers.js"
    plugin_link.parent.mkdir(parents=True, exist_ok=True)
    if plugin_link.exists() or plugin_link.is_symlink():
        plugin_link.unlink()
    plugin_link.symlink_to(staged_plugin)

    node = shutil.which("node")
    if node is not None:
        result = subprocess.run(
            [node, "--check", str(staged_plugin)],
            text=True,
            capture_output=True,
        )
        if result.returncode != 0:
            raise RunnerError(
                "staged OpenCode Superpowers plugin failed node --check: "
                f"{result.stderr.strip()[:300]}",
                stage="setup",
            )

    _require_under_home(staged_plugin, opencode_home)
    _require_under_home(plugin_link, opencode_home)
    _require_under_home(staged_skills, opencode_home)
    for path in staged_skills.rglob("*"):
        _require_under_home(path, opencode_home)

    _run_opencode_provider_preflight()
```

Wire it into `_seed_agent_config_dir`:

```python
    if coding_agent.name == "opencode":
        _seed_opencode_config(dest)
```

- [ ] **Step 4: Run seeding tests**

Run:

```bash
uv run pytest tests/quorum/test_runner.py::TestSeedAgentConfigDir -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add quorum/runner.py tests/quorum/test_runner.py
git commit -m "quorum: seed isolated opencode homes"
```

---

## Task 4: OpenCode Config and Launcher Context

**Files:**
- Create: `coding-agents/opencode.yaml`
- Create: `coding-agents/opencode-context/HOWTO.md`
- Create: `coding-agents/opencode-context/launch-agent`
- Modify: `tests/quorum/test_coding_agent_config.py`
- Modify: `tests/quorum/test_runner.py`

- [ ] **Step 1: Write failing config test**

In `tests/quorum/test_coding_agent_config.py`, add:

```python
def test_opencode_config_loads_when_superpowers_root_set(monkeypatch, tmp_path):
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "superpowers"))
    cfg = load_coding_agent_config(
        Path(__file__).resolve().parents[2] / "coding-agents" / "opencode.yaml"
    )

    assert cfg.name == "opencode"
    assert cfg.binary == "opencode"
    assert cfg.agent_config_env == "OPENCODE_QUORUM_HOME"
    assert cfg.session_log_glob == "[0-9]*-ses_*.json"
    assert cfg.normalizer == "opencode"
    assert cfg.resolve_session_log_dir(tmp_path / "cfg") == (
        tmp_path / "cfg" / ".quorum" / "session-exports"
    )
```

- [ ] **Step 2: Add context substitution test**

In `tests/quorum/test_runner.py`, add `_populate_context_dir` to the
`from quorum.runner import (...)` list, then add a runner test near existing
HOWTO substitution tests:

```python
def test_opencode_howto_substitutes_quorum_home_and_launcher(self, tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "sp"))
    coding_agents_dir = Path(__file__).resolve().parents[2] / "coding-agents"
    run_dir = tmp_path / "run"
    launch_cwd = tmp_path / "workdir"
    launch_cwd.mkdir()
    agent_config_dir = run_dir / "coding-agent-config"
    launch_agent_path = run_dir / "gauntlet-agent" / "context" / "launch-agent"

    _populate_context_dir(
        coding_agents_dir,
        "opencode",
        run_dir,
        substitutions={
            "$QUORUM_AGENT_CWD": str(launch_cwd),
            "$SUPERPOWERS_ROOT": str(tmp_path / "sp"),
            "$QUORUM_LAUNCH_AGENT": str(launch_agent_path),
            "$OPENCODE_QUORUM_HOME": str(agent_config_dir),
        },
    )

    howto = (run_dir / "gauntlet-agent" / "context" / "HOWTO.md").read_text()
    launcher = launch_agent_path.read_text()

    assert str(launch_agent_path) in howto
    assert str(launch_cwd) in launcher
    assert str(agent_config_dir) in launcher
    assert "opencode run -i --dangerously-skip-permissions" in launcher
    assert "env -i" in launcher
    assert "OPENCODE_CONFIG_DIR=" in launcher
    assert "TMPDIR=" in launcher
    assert "SUPERPOWERS_ROOT" not in launcher
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
uv run pytest tests/quorum/test_coding_agent_config.py tests/quorum/test_runner.py::test_opencode_howto_substitutes_quorum_home_and_launcher -x -q
```

Expected: FAIL because `opencode.yaml` and `opencode-context` do not exist.

- [ ] **Step 4: Add `coding-agents/opencode.yaml`**

Create `coding-agents/opencode.yaml`:

```yaml
name: opencode
binary: opencode
agent_config_env: OPENCODE_QUORUM_HOME
session_log_dir: "${OPENCODE_QUORUM_HOME}/.quorum/session-exports"
session_log_glob: "[0-9]*-ses_*.json"
normalizer: opencode
required_env:
  - SUPERPOWERS_ROOT
max_time: 10m
max_concurrency: 1
```

- [ ] **Step 5: Add launcher template**

Create `coding-agents/opencode-context/launch-agent`:

```bash
#!/usr/bin/env bash
# quorum-generated launcher for OpenCode (the agent under test).
#
# The cd, isolated HOME/XDG directories, OPENCODE_CONFIG_DIR, and dangerous
# permission flag are baked in here so the QA agent launches OpenCode from the
# prepared workdir with one command. quorum substitutes the $... values below
# at runtime; the installed copy contains literal absolute paths.
set -euo pipefail
cd "$QUORUM_AGENT_CWD" || { echo "launch-agent: cannot cd to $QUORUM_AGENT_CWD" >&2; exit 1; }

env_args=(
  "PATH=${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"
  "TERM=${TERM:-xterm-256color}"
  "LANG=${LANG:-C.UTF-8}"
)
for name in \
  OPENAI_API_KEY ANTHROPIC_API_KEY OPENROUTER_API_KEY \
  GEMINI_API_KEY GOOGLE_API_KEY \
  AWS_PROFILE AWS_REGION AWS_DEFAULT_REGION \
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN; do
  if [[ -n "${!name-}" ]]; then
    env_args+=("$name=${!name}")
  fi
done

exec env -i \
  "${env_args[@]}" \
  HOME="$OPENCODE_QUORUM_HOME" \
  XDG_CONFIG_HOME="$OPENCODE_QUORUM_HOME/.config" \
  XDG_DATA_HOME="$OPENCODE_QUORUM_HOME/.local/share" \
  XDG_STATE_HOME="$OPENCODE_QUORUM_HOME/.local/state" \
  XDG_CACHE_HOME="$OPENCODE_QUORUM_HOME/.cache" \
  TMPDIR="$OPENCODE_QUORUM_HOME/.tmp" \
  OPENCODE_CONFIG_DIR="$OPENCODE_QUORUM_HOME/.config/opencode" \
  opencode run -i --dangerously-skip-permissions "$@"
```

- [ ] **Step 6: Add HOWTO**

Create `coding-agents/opencode-context/HOWTO.md`:

```markdown
# How to drive OpenCode (the agent under test)

You are driving OpenCode in a bash shell inside tmux. OpenCode is itself an AI
agent; what appears on screen is its work.

## Launch OpenCode with one command

Your bash starts in a scratch directory, NOT the workdir quorum prepared.
quorum has generated a launcher that handles everything: it cds into the
prepared workdir, sets an isolated OpenCode home, sets XDG state/config/cache
directories, registers the isolated `OPENCODE_CONFIG_DIR`, and starts OpenCode
in direct interactive mode with dangerous permissions skipped. Type this one
line, verbatim, as your first action:

```
"$QUORUM_LAUNCH_AGENT"
```

That path is burned into this HOWTO at runtime by quorum; it points at a
generated executable that runs, in effect:

```
cd <prepared-workdir> && env -i PATH=<path> HOME=<per-run-isolated-home> XDG_CONFIG_HOME=<home>/.config XDG_DATA_HOME=<home>/.local/share XDG_STATE_HOME=<home>/.local/state XDG_CACHE_HOME=<home>/.cache TMPDIR=<home>/.tmp OPENCODE_CONFIG_DIR=<home>/.config/opencode opencode run -i --dangerously-skip-permissions
```

Because the cd and isolated environment live inside the launcher, do not
hand-type a bare `opencode` or reconstruct the command yourself. Just run the
one line above.

## Observing what OpenCode is doing

OpenCode writes runtime state under the isolated home:

```
$OPENCODE_QUORUM_HOME/.local/share/opencode/opencode.db
$OPENCODE_QUORUM_HOME/.local/share/opencode/log/
```

After the run, quorum exports matching sessions to:

```
$OPENCODE_QUORUM_HOME/.quorum/session-exports/[0-9]*-ses_*.json
```

Those exported JSON files are the ground truth for tool calls and are what
quorum normalizes into `coding-agent-tool-calls.jsonl`.

## Waiting for OpenCode to work

When OpenCode is busy, wait for it to finish rather than repeatedly polling the
screen. If you need to inspect local logs, use the isolated log directory:

```
find "$OPENCODE_QUORUM_HOME/.local/share/opencode/log" -type f -maxdepth 1 -print 2>/dev/null
```

## Shutdown

Type `/exit` and press Enter to end the session cleanly.
```

- [ ] **Step 7: Run config/context tests**

Run:

```bash
uv run pytest tests/quorum/test_coding_agent_config.py tests/quorum/test_runner.py::test_opencode_howto_substitutes_quorum_home_and_launcher -q
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add coding-agents/opencode.yaml coding-agents/opencode-context/HOWTO.md coding-agents/opencode-context/launch-agent tests/quorum/test_coding_agent_config.py tests/quorum/test_runner.py
git commit -m "quorum: add opencode coding-agent config"
```

---

## Task 5: Runner Export and Capture Diagnostics

**Files:**
- Modify: `quorum/runner.py`
- Modify: `tests/quorum/test_runner.py`

- [ ] **Step 1: Write failing runner export test**

In `tests/quorum/test_runner.py`, add a helper like existing `_make_antigravity_agent`:

```python
def _make_opencode_agent(coding_agents_dir: Path, session_log_dir: Path) -> None:
    coding_agents_dir.mkdir(parents=True, exist_ok=True)
    (coding_agents_dir / "opencode.yaml").write_text(
        yaml.safe_dump(
            {
                "name": "opencode",
                "binary": "opencode",
                "agent_config_env": "OPENCODE_QUORUM_HOME",
                "session_log_dir": str(session_log_dir),
                "session_log_glob": "[0-9]*-ses_*.json",
                "normalizer": "opencode",
                "required_env": ["SUPERPOWERS_ROOT"],
                "max_time": "10m",
            }
        )
    )
```

Add this test near the capture diagnostic tests:

```python
def test_opencode_exports_sessions_before_capture(self, tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "sp"))
    coding_agents_dir = tmp_path / "coding-agents"
    scenarios_dir = tmp_path / "scenarios"
    export_dir = tmp_path / "exports"
    export_dir.mkdir()
    _make_opencode_agent(coding_agents_dir, export_dir)
    sd = _make_scenario(scenarios_dir, "x", with_checks=False)
    (sd / "checks.sh").write_text("pre() { :; }\npost() { skill-called superpowers:brainstorming; }\n")

    def fake_export(*, opencode_home, export_dir, launch_cwd, snapshot):
        assert snapshot == {"ses_old"}
        exported = export_dir / "0000000000000200-ses_1.json"
        exported.write_text(
            json.dumps(
                {
                    "messages": [
                        {
                            "parts": [
                                {
                                    "type": "tool",
                                    "tool": "skill",
                                    "state": {"input": {"name": "brainstorming"}},
                                }
                            ]
                        }
                    ]
                }
            )
        )
        return (exported,)

    with (
        patch("quorum.runner._seed_opencode_config"),
        patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass),
        patch(
            "quorum.runner.snapshot_opencode_sessions",
            return_value={"ses_old"},
            create=True,
        ),
        patch(
            "quorum.runner.export_opencode_sessions",
            side_effect=fake_export,
            create=True,
        ) as mock_export,
    ):
        _run_dir, verdict = run_scenario(
            scenario_dir=sd,
            coding_agent="opencode",
            coding_agents_dir=coding_agents_dir,
            out_root=tmp_path / "results",
            skeleton_root=_empty_skeleton(tmp_path),
        )

    assert verdict.final == "pass"
    mock_export.assert_called_once()
```

- [ ] **Step 2: Add missing-session and zero-row diagnostics tests**

Add:

```python
def test_opencode_missing_session_export_is_indeterminate(self, tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "sp"))
    coding_agents_dir = tmp_path / "coding-agents"
    scenarios_dir = tmp_path / "scenarios"
    export_dir = tmp_path / "exports"
    export_dir.mkdir()
    _make_opencode_agent(coding_agents_dir, export_dir)
    sd = _make_scenario(scenarios_dir, "x", with_checks=False)
    (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")

    def fake_export(*, opencode_home, export_dir, launch_cwd, snapshot):
        (export_dir / "opencode-session-export-manifest.json").write_text(
            json.dumps({"matched_ids": [], "exports": []})
        )
        return ()

    with (
        patch("quorum.runner._seed_opencode_config"),
        patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass),
        patch("quorum.runner.snapshot_opencode_sessions", return_value=set(), create=True),
        patch("quorum.runner.export_opencode_sessions", side_effect=fake_export, create=True),
    ):
        _run_dir, verdict = run_scenario(
            scenario_dir=sd,
            coding_agent="opencode",
            coding_agents_dir=coding_agents_dir,
            out_root=tmp_path / "results",
            skeleton_root=_empty_skeleton(tmp_path),
        )

    assert verdict.final == "indeterminate"
    assert "no OpenCode session export" in verdict.final_reason
    assert verdict.error is not None
    assert verdict.error.stage == "capture"


def test_opencode_zero_normalized_rows_is_indeterminate(self, tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "sp"))
    coding_agents_dir = tmp_path / "coding-agents"
    scenarios_dir = tmp_path / "scenarios"
    export_dir = tmp_path / "exports"
    export_dir.mkdir()
    _make_opencode_agent(coding_agents_dir, export_dir)
    sd = _make_scenario(scenarios_dir, "x", with_checks=False)
    (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")

    def fake_export(*, opencode_home, export_dir, launch_cwd, snapshot):
        exported = export_dir / "0000000000000100-ses_empty.json"
        exported.write_text(json.dumps({"messages": []}))
        return (exported,)

    with (
        patch("quorum.runner._seed_opencode_config"),
        patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass),
        patch("quorum.runner.snapshot_opencode_sessions", return_value=set(), create=True),
        patch("quorum.runner.export_opencode_sessions", side_effect=fake_export, create=True),
    ):
        _run_dir, verdict = run_scenario(
            scenario_dir=sd,
            coding_agent="opencode",
            coding_agents_dir=coding_agents_dir,
            out_root=tmp_path / "results",
            skeleton_root=_empty_skeleton(tmp_path),
        )

    assert verdict.final == "indeterminate"
    assert "OpenCode export(s) normalized to zero tool-call rows" in verdict.final_reason
    assert verdict.error is not None
    assert verdict.error.stage == "capture"
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
uv run pytest tests/quorum/test_runner.py -k opencode -x -q
```

Expected: FAIL because `runner.py` does not call `snapshot_opencode_sessions`
or `export_opencode_sessions`.

- [ ] **Step 4: Wire export helper into runner**

In `quorum/runner.py`, import:

```python
from quorum.opencode_capture import (
    OpenCodeCaptureError,
    export_opencode_sessions,
    opencode_run_env,
    snapshot_opencode_sessions,
)
```

After `launch_cwd` is resolved and before the export-dir `snapshot_dir(...)`
call, snapshot existing OpenCode sessions for this launch cwd:

```python
    opencode_session_snapshot: set[str] = set()
    if tcfg.normalizer == "opencode":
        try:
            opencode_session_snapshot = snapshot_opencode_sessions(
                opencode_home=agent_config_dir,
                launch_cwd=launch_cwd,
            )
        except OpenCodeCaptureError as e:
            return run_dir, _write_indeterminate(
                run_dir,
                final_reason=f"OpenCode session snapshot failed: {e}",
                checks=pre_records,
                error=RunError(stage="capture", message=str(e)),
            )
```

After `invoke_gauntlet(...)` returns and before `capture_tool_calls(...)`, add:

```python
    opencode_exported_paths: tuple[Path, ...] = ()
    if tcfg.normalizer == "opencode":
        try:
            opencode_exported_paths = export_opencode_sessions(
                opencode_home=agent_config_dir,
                export_dir=session_log_dir,
                launch_cwd=launch_cwd,
                snapshot=opencode_session_snapshot,
            )
        except OpenCodeCaptureError as e:
            gauntlet_layer = _build_gauntlet_layer_from_run_dir(run_dir)
            if gauntlet_layer is None:
                gauntlet_layer = GauntletLayer(
                    status=gauntlet_status,
                    summary="",
                    reasoning="",
                    run_id=None,
                )
            return run_dir, _write_indeterminate(
                run_dir,
                final_reason=f"OpenCode session export failed: {e}",
                gauntlet=gauntlet_layer,
                checks=pre_records,
                error=RunError(stage="capture", message=str(e)),
            )
```

After `gauntlet_layer` is built and before post-checks, add OpenCode diagnostics parallel to Antigravity:

```python
    if (
        tcfg.normalizer == "opencode"
        and capture_result.source_logs == ()
        and opencode_exported_paths
    ):
        return run_dir, _write_indeterminate(
            run_dir,
            final_reason=(
                "OpenCode exported session files, but file-diff capture did not "
                "see them as new; check export snapshot timing"
            ),
            gauntlet=gauntlet_layer,
            checks=pre_records,
            error=RunError(stage="capture", message="OpenCode export/capture snapshot mismatch"),
        )

    if tcfg.normalizer == "opencode" and not capture_result.source_logs:
        return run_dir, _write_indeterminate(
            run_dir,
            final_reason=(
                "no OpenCode session export appeared under isolated "
                f"{session_log_dir}; cannot evaluate this run"
            ),
            gauntlet=gauntlet_layer,
            checks=pre_records,
            error=RunError(stage="capture", message="no OpenCode session export captured"),
        )

    if (
        tcfg.normalizer == "opencode"
        and capture_result.source_logs
        and capture_result.row_count == 0
    ):
        rel = [str(p.relative_to(session_log_dir)) for p in capture_result.source_logs]
        return run_dir, _write_indeterminate(
            run_dir,
            final_reason="OpenCode export(s) normalized to zero tool-call rows: " + ", ".join(rel),
            gauntlet=gauntlet_layer,
            checks=pre_records,
            error=RunError(stage="capture", message="OpenCode capture normalized to zero rows"),
        )
```

- [ ] **Step 5: Run runner tests**

Run:

```bash
uv run pytest tests/quorum/test_runner.py -k opencode -q
uv run pytest tests/quorum/test_runner.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add quorum/runner.py tests/quorum/test_runner.py
git commit -m "quorum: capture exported opencode sessions"
```

---

## Task 6: OpenCode Bootstrap Scenario and Check Tool

**Files:**
- Create: `bin/opencode-plugin-installed`
- Create: `tests/quorum/test_opencode_plugin_installed.py`
- Create: `scenarios/opencode-superpowers-bootstrap/story.md`
- Create: `scenarios/opencode-superpowers-bootstrap/setup.sh`
- Create: `scenarios/opencode-superpowers-bootstrap/checks.sh`

- [ ] **Step 1: Add plugin-installed check tool**

Create `bin/opencode-plugin-installed`:

```bash
#!/usr/bin/env bash
_RECORD_CHECK=opencode-plugin-installed
_RECORD_ARGS=("$@")
source "$(dirname "$0")/_record"
set -uo pipefail

home="${OPENCODE_QUORUM_HOME:-${QUORUM_RUN_DIR:-}/coding-agent-config}"
config_dir="$home/.config/opencode"
plugin="$config_dir/plugins/superpowers.js"
using_skill="$config_dir/superpowers/skills/using-superpowers/SKILL.md"

if [ ! -e "$plugin" ]; then
    record_fail "OpenCode Superpowers plugin missing at $plugin"
    exit 1
fi

if [ ! -f "$using_skill" ]; then
    record_fail "OpenCode using-superpowers skill missing at $using_skill"
    exit 1
fi

record_pass "OpenCode Superpowers plugin installed in isolated config"
```

Make it executable:

```bash
chmod +x bin/opencode-plugin-installed
```

- [ ] **Step 2: Add check-tool tests**

Create `tests/quorum/test_opencode_plugin_installed.py`:

```python
import json
import os
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "bin" / "opencode-plugin-installed"


def _run_tool(run_dir: Path) -> tuple[int, list[dict]]:
    sink = run_dir / "records.jsonl"
    env = {
        **os.environ,
        "QUORUM_RUN_DIR": str(run_dir),
        "QUORUM_RECORD_SINK": str(sink),
        "PATH": f"{ROOT / 'bin'}:{os.environ.get('PATH', '')}",
    }
    proc = subprocess.run([str(TOOL)], text=True, capture_output=True, env=env)
    records = [
        json.loads(line)
        for line in sink.read_text().splitlines()
        if line.strip()
    ]
    return proc.returncode, records


def test_opencode_plugin_installed_passes_for_staged_layout(tmp_path):
    cfg = tmp_path / "coding-agent-config" / ".config" / "opencode"
    plugin = cfg / "plugins" / "superpowers.js"
    skill = cfg / "superpowers" / "skills" / "using-superpowers" / "SKILL.md"
    plugin.parent.mkdir(parents=True)
    skill.parent.mkdir(parents=True)
    plugin.write_text("export {};")
    skill.write_text("skill")

    code, records = _run_tool(tmp_path)

    assert code == 0
    assert records[0]["passed"] is True


def test_opencode_plugin_installed_fails_when_plugin_missing(tmp_path):
    code, records = _run_tool(tmp_path)

    assert code != 0
    assert records[0]["passed"] is False
    assert "plugin missing" in records[0]["detail"]
```

- [ ] **Step 3: Add scenario story**

Create `scenarios/opencode-superpowers-bootstrap/story.md`:

```markdown
---
id: opencode-superpowers-bootstrap
title: OpenCode bootstraps Superpowers from isolated plugin install
status: ready
tags: opencode, bootstrap
---

You are a developer starting a new project with the OpenCode agent.

When OpenCode is at its input prompt, type this exact message and press Enter:

"Let's make a react todo list"

Do NOT mention Superpowers, skills, brainstorming, planning, or tests. The
point is to see whether OpenCode's startup context makes the agent reach for
the right workflow on its own.

Once the agent has loaded a skill, started brainstorming, or started writing
tests or code, you are done. The goal is to test startup bootstrap, not to
drive the todo app to completion.

## Acceptance Criteria

- Quorum installed Superpowers into OpenCode's isolated config directory for
  this run.
- The installed files alone are not considered proof that OpenCode honored the
  plugin. The behavioral proof is the normalized exported session.
- The agent loaded `superpowers:brainstorming` in response to the naive
  "react todo list" request before writing implementation code. For OpenCode
  this should appear as a normalized `Skill` tool call from OpenCode's native
  `skill` tool.
```

- [ ] **Step 4: Add scenario setup and checks**

Create `scenarios/opencode-superpowers-bootstrap/setup.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
uv run setup-helpers run create_base_repo
```

Create `scenarios/opencode-superpowers-bootstrap/checks.sh`:

```bash
# coding-agents: opencode

pre() {
    git-repo
    git-branch main
}

post() {
    opencode-plugin-installed
    skill-called superpowers:brainstorming
    skill-before-tool superpowers:brainstorming Edit
    skill-before-tool superpowers:brainstorming Write
}
```

Ensure `checks.sh` is not executable:

```bash
chmod +x scenarios/opencode-superpowers-bootstrap/setup.sh
chmod -x scenarios/opencode-superpowers-bootstrap/checks.sh
```

- [ ] **Step 5: Validate scenario definitions and check-tool tests**

Run:

```bash
uv run quorum check
uv run pytest tests/quorum/test_opencode_plugin_installed.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add bin/opencode-plugin-installed tests/quorum/test_opencode_plugin_installed.py scenarios/opencode-superpowers-bootstrap
git commit -m "quorum: add opencode bootstrap scenario"
```

---

## Task 7: Final Verification and Live Smoke

**Files:**
- Modify: `README.md` only if target docs are missing.
- No code changes unless verification exposes a defect.

- [ ] **Step 1: Run static checks**

Run:

```bash
uv run ruff check
uv run ty check
uv run quorum check
```

Expected: all PASS.

- [ ] **Step 2: Run unit tests**

Run:

```bash
uv run pytest
```

Expected: PASS.

- [ ] **Step 3: Run trusted live OpenCode smoke**

Run:

```bash
export SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers
uv run quorum run scenarios/opencode-superpowers-bootstrap --coding-agent opencode
```

Expected: the run completes with a concrete verdict and writes exported session
JSON under:

```text
<run>/coding-agent-config/.quorum/session-exports/[0-9]*-ses_*.json
```

- [ ] **Step 4: Inspect verdict**

Run:

```bash
uv run quorum show
```

Expected for a successful first pass: `pass`.

If the live smoke is `fail`, inspect whether it is a real OpenCode behavior
failure or a harness capture failure:

```bash
latest="$(ls -td results/opencode-superpowers-bootstrap-opencode-* | head -1)"
jq . "$latest/verdict.json"
find "$latest/coding-agent-config/.quorum/session-exports" -name '[0-9]*-ses_*.json' -print
jq '.messages[].parts[]? | select(.type == "tool") | {tool, input: .state.input}' "$latest"/coding-agent-config/.quorum/session-exports/[0-9]*-ses_*.json
```

Harness capture failures must be fixed before claiming the target works. Real
behavioral failures can be left as scenario evidence if the normalized trace is
correct and the verdict explains the failed check.

- [ ] **Step 5: Commit verification docs if README changed**

If `README.md` changed:

```bash
git add README.md
git commit -m "docs: document opencode quorum target"
```

- [ ] **Step 6: Final status**

Run:

```bash
git status --short
```

Expected: clean worktree after the task commits, or only intentional live-run
artifacts ignored by git.
