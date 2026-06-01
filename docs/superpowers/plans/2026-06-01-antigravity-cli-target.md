# Antigravity CLI Target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `antigravity` as a first-class Quorum Coding-Agent target that installs Superpowers from local `SUPERPOWERS_ROOT`, captures Antigravity transcripts, and runs the same behavioral scenarios as Claude and Codex.

**Architecture:** Keep Antigravity inside the existing Coding-Agent adapter model: one YAML config, one context launcher, runner-level config seeding, one normalizer, and shared trace predicates. The runner gets small target-specific hooks for Antigravity provisioning, auth/isolation preflight, `.antigravitycli/` git exclusion, and missing-transcript diagnostics; broad scenario sweeps stay governed by the existing `# coding-agents:` directive semantics.

**Tech Stack:** Python 3.11+, uv, pytest, ty, ruff, Bash check tools, jq, Gauntlet TUI adapter, Google Antigravity CLI `agy`.

**Spec:** [docs/superpowers/specs/2026-06-01-antigravity-cli-target-design.md](../specs/2026-06-01-antigravity-cli-target-design.md)

---

## File Structure

**Create:**
- `coding-agents/antigravity.yaml` - Antigravity Coding-Agent config.
- `coding-agents/antigravity-context/HOWTO.md` - Gauntlet-Agent driver instructions.
- `coding-agents/antigravity-context/launch-agent` - generated launcher template for interactive `agy`.
- `bin/antigravity-plugin-installed` - deterministic check for installed Superpowers plugin files in the isolated run config.
- `scenarios/antigravity-superpowers-bootstrap/story.md` - naive bootstrap scenario.
- `scenarios/antigravity-superpowers-bootstrap/setup.sh` - base fixture setup.
- `scenarios/antigravity-superpowers-bootstrap/checks.sh` - Antigravity bootstrap checks.
- `docs/baselines/antigravity-sweeps/README.md` - triage report convention for broad Antigravity sweeps.

**Modify:**
- `quorum/normalizers.py` - add Antigravity tool normalization and register `normalizer: antigravity`.
- `quorum/capture.py` - return capture metadata (`path`, `source_logs`, `row_count`) while still writing `coding-agent-tool-calls.jsonl`.
- `quorum/runner.py` - seed Antigravity config, run auth/isolation preflight, install Superpowers, exclude `.antigravitycli/`, and fail closed on missing or empty Antigravity capture.
- `quorum/composer.py` - widen `RunError.stage` typing only if needed by `RunnerError.stage`; reuse existing runtime stages where possible.
- `bin/_skill_predicate.jq` - count normalized Antigravity `Read` calls on `skills/.../SKILL.md` as skill invocations.
- `tests/quorum/test_normalizers.py` - Antigravity normalizer coverage.
- `tests/quorum/test_capture.py` - `CaptureResult` coverage.
- `tests/quorum/test_runner.py` - Antigravity provisioning, preflight, launcher, exclusion, and capture diagnostics.
- `tests/quorum/test_trace_tools.py` - skill predicate parity for Antigravity `Read`.
- `tests/quorum/test_coding_agent_config.py` or an existing config-loader test file - Antigravity YAML load coverage.
- `README.md` - target docs, safety, isolation, troubleshooting, and live-smoke commands.
- `scenarios/triggering-test-driven-development/story.md` - backend-neutral evidence wording.
- `scenarios/worktree-creation-from-main/story.md` - remove Claude-native worktree-tool requirement from acceptance prose.

**Do Not Change:**
- `quorum/run_all.py` gating semantics. Absent `# coding-agents:` continues to mean "try this scenario for every selected Coding-Agent", including Antigravity.
- Public CI to launch `agy`. All live `quorum run ... --coding-agent antigravity` commands remain trusted-maintainer operations.
- Claude or Codex setup, except where shared tests need to adapt to the new `CaptureResult`.

---

## Task 1: Capture Metadata Without Changing Capture Artifacts

**Why first:** Antigravity needs to distinguish "no transcript files" from "transcripts normalized to zero rows". The artifact path stays the same, but callers need metadata.

**Files:**
- Modify: `quorum/capture.py`
- Test: `tests/quorum/test_capture.py`
- Touch callers: `quorum/runner.py`, existing capture tests

- [ ] **Step 1: Write failing capture metadata tests**

In `tests/quorum/test_capture.py`, update the existing assertions that treat `capture_tool_calls(...)` as a `Path`, then add this test in `TestCaptureToolCalls`:

```python
def test_capture_tool_calls_returns_source_logs_and_row_count(self, tmp_path):
    log_dir = tmp_path / "logs"
    log_dir.mkdir()
    snap = snapshot_dir(log_dir, "*.jsonl")
    first = log_dir / "first.jsonl"
    first.write_text(
        json.dumps({
            "type": "assistant",
            "message": {"content": [
                {"type": "tool_use", "name": "Read", "input": {"file_path": "a.py"}},
                {"type": "tool_use", "name": "Edit", "input": {"file_path": "a.py"}},
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
```

Also change the existing path-style tests in this file from:

```python
out = capture_tool_calls(...)
assert out == run_dir / "coding-agent-tool-calls.jsonl"
rows = [json.loads(line) for line in out.read_text().splitlines() if line.strip()]
```

to:

```python
result = capture_tool_calls(...)
assert result.path == run_dir / "coding-agent-tool-calls.jsonl"
rows = [json.loads(line) for line in result.path.read_text().splitlines() if line.strip()]
```

For `test_empty_capture_writes_empty_file`, assert:

```python
assert result.source_logs == ()
assert result.row_count == 0
assert result.path.exists()
assert result.path.read_text() == ""
```

- [ ] **Step 2: Run the targeted tests and verify failure**

Run: `uv run pytest tests/quorum/test_capture.py -x -q`

Expected: FAIL because `capture_tool_calls` still returns a `Path` and has no `source_logs` or `row_count`.

- [ ] **Step 3: Add `CaptureResult` and return it**

In `quorum/capture.py`, add the dataclass import and result type:

```python
from dataclasses import dataclass
```

Add this near the top, after imports:

```python
@dataclass(frozen=True)
class CaptureResult:
    path: Path
    source_logs: tuple[Path, ...]
    row_count: int
```

Replace `capture_tool_calls(...) -> Path` with:

```python
def capture_tool_calls(
    *,
    log_dir: Path,
    log_glob: str,
    snapshot: set[str],
    normalizer: str,
    run_dir: Path,
    launch_cwd: Path | None = None,
) -> CaptureResult:
    """Diff log_dir, filter by cwd if applicable, normalize, write JSONL.

    Always writes coding-agent-tool-calls.jsonl (empty if no new logs) so
    downstream assertions can rely on the file existing. The returned metadata
    lets runner diagnostics distinguish missing source logs from zero normalized
    rows.
    """
    new = _new_session_logs(log_dir, log_glob, snapshot, normalizer, launch_cwd)
    fn = NORMALIZERS[normalizer]
    out_path = run_dir / "coding-agent-tool-calls.jsonl"
    row_count = 0
    with out_path.open("w") as f:
        for path in new:
            for row in fn(path.read_text()):
                f.write(json.dumps(row) + "\n")
                row_count += 1
    return CaptureResult(path=out_path, source_logs=tuple(new), row_count=row_count)
```

- [ ] **Step 4: Update the runner caller**

In `quorum/runner.py`, change the capture call to assign the result:

```python
    capture_result = capture_tool_calls(
        log_dir=session_log_dir,
        log_glob=tcfg.session_log_glob,
        snapshot=snap,
        normalizer=tcfg.normalizer,
        run_dir=run_dir,
        launch_cwd=launch_cwd,
    )
```

Then change:

```python
    tcp = run_dir / "coding-agent-tool-calls.jsonl"
    capture_empty = not tcp.exists() or tcp.stat().st_size == 0
```

to:

```python
    tcp = capture_result.path
    capture_empty = capture_result.row_count == 0
```

- [ ] **Step 5: Run capture and runner tests**

Run: `uv run pytest tests/quorum/test_capture.py tests/quorum/test_runner.py -x -q`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add quorum/capture.py quorum/runner.py tests/quorum/test_capture.py
git commit -m "quorum: return tool-call capture metadata"
```

---

## Task 2: Antigravity Normalizer

**Why next:** Config loading, trace checks, and scenarios all depend on `normalizer: antigravity` existing and producing canonical rows.

**Files:**
- Modify: `quorum/normalizers.py`
- Test: `tests/quorum/test_normalizers.py`

- [ ] **Step 1: Write failing Antigravity normalizer tests**

In `tests/quorum/test_normalizers.py`, add `normalize_antigravity_logs` to the import list:

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
    normalize_pi_logs,
    snapshot_log_dir,
)
```

Append this class near the other normalizer tests:

```python
class TestNormalizeAntigravityLogs:
    def test_normalizes_top_level_tool_calls_and_pascal_case_args(self):
        raw = "\n".join([
            json.dumps({
                "type": "assistant",
                "tool_calls": [
                    {"name": "run_command", "args": {"CommandLine": "pytest -q"}},
                    {
                        "name": "view_file",
                        "args": {
                            "AbsolutePath": "/tmp/run/.gemini/config/plugins/superpowers/skills/test-driven-development/SKILL.md",
                            "IsSkillFile": True,
                        },
                    },
                    {"name": "list_dir", "args": {"DirectoryPath": "src"}},
                ],
            }),
            "not json",
            json.dumps({"type": "assistant", "text": "no tools here"}),
        ])

        rows = normalize_antigravity_logs(raw)

        assert [r["tool"] for r in rows] == ["Bash", "Read", "Glob"]
        assert rows[0]["args"]["command"] == "pytest -q"
        assert rows[0]["args"]["raw_args"] == {"CommandLine": "pytest -q"}
        assert rows[1]["args"]["file_path"].endswith(
            "/skills/test-driven-development/SKILL.md"
        )
        assert rows[1]["args"]["is_skill_file"] is True
        assert rows[1]["args"]["raw_args"]["IsSkillFile"] is True
        assert rows[2]["args"]["path"] == "src"

    def test_normalizes_nested_planner_response_tool_calls(self):
        raw = json.dumps({
            "PLANNER_RESPONSE": {
                "tool_calls": [
                    {"name": "write_to_file", "args": {"Path": "src/app.py"}},
                    {"name": "replace_file_content", "args": {"path": "src/app.py"}},
                    {"name": "grep_search", "args": {"pattern": "validate"}},
                ]
            }
        })

        rows = normalize_antigravity_logs(raw)

        assert [r["tool"] for r in rows] == ["Write", "Edit", "Grep"]
        assert all("raw_args" in r["args"] for r in rows)

    def test_preserves_unknown_tools_and_non_launch_manage_subagents(self):
        raw = json.dumps({
            "tool_calls": [
                {"name": "unknown_tool", "args": {"x": 1}},
                {"name": "manage_subagents", "args": {"action": "list"}},
                {"name": "invoke_subagent", "args": {"prompt": "review this"}},
            ]
        })

        rows = normalize_antigravity_logs(raw)

        assert [r["tool"] for r in rows] == [
            "unknown_tool",
            "manage_subagents",
            "Agent",
        ]
        assert rows[0]["args"]["raw_args"] == {"x": 1}
        assert rows[1]["args"]["raw_args"] == {"action": "list"}
        assert rows[2]["source"] == "native"

    def test_canonicalizes_skill_marker_casing_and_nested_metadata(self):
        raw = json.dumps({
            "tool_calls": [
                {
                    "name": "view_file",
                    "args": {
                        "Path": "/x/skills/superpowers/brainstorming/SKILL.md",
                        "metadata": {"isSkillFile": True},
                    },
                }
            ]
        })

        rows = normalize_antigravity_logs(raw)

        assert rows[0]["tool"] == "Read"
        assert rows[0]["args"]["file_path"] == "/x/skills/superpowers/brainstorming/SKILL.md"
        assert rows[0]["args"]["is_skill_file"] is True
```

- [ ] **Step 2: Run normalizer tests and verify failure**

Run: `uv run pytest tests/quorum/test_normalizers.py::TestNormalizeAntigravityLogs -x -q`

Expected: FAIL with an import error because `normalize_antigravity_logs` does not exist.

- [ ] **Step 3: Add Antigravity mapping and helpers**

In `quorum/normalizers.py`, add this after `GEMINI_TOOL_MAP` or before `NORMALIZERS`:

```python
ANTIGRAVITY_TOOL_MAP: dict[str, str] = {
    "run_command": "Bash",
    "view_file": "Read",
    "write_to_file": "Write",
    "create_file": "Write",
    "replace_file_content": "Edit",
    "multi_replace_file_content": "Edit",
    "edit_file": "Edit",
    "grep_search": "Grep",
    "search_directory": "Grep",
    "list_dir": "Glob",
    "find_by_name": "Glob",
    "find_file": "Glob",
    "list_directory": "Glob",
    "invoke_subagent": "Agent",
    "search_web": "WebSearch",
    "read_url_content": "WebFetch",
}

ANTIGRAVITY_NATIVE_TOOLS = {
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    "Agent",
    "WebSearch",
    "WebFetch",
    "manage_task",
    "list_permissions",
}


def _normalized_arg_key(key: str) -> str:
    return "".join(ch for ch in key.lower() if ch != "_")


def _arg_value(raw_args: dict[str, Any], *keys: str) -> Any:
    wanted = {_normalized_arg_key(k) for k in keys}
    for key, value in raw_args.items():
        if _normalized_arg_key(str(key)) in wanted:
            return value
    return None


def _nested_arg_value(raw_args: dict[str, Any], *keys: str) -> Any:
    found = _arg_value(raw_args, *keys)
    if found is not None:
        return found
    for value in raw_args.values():
        if isinstance(value, dict):
            found = _nested_arg_value(value, *keys)
            if found is not None:
                return found
    return None


def _parse_tool_args(raw_args: Any) -> dict[str, Any]:
    if isinstance(raw_args, str):
        try:
            parsed = json.loads(raw_args)
        except json.JSONDecodeError:
            return {"raw": raw_args}
        return parsed if isinstance(parsed, dict) else {"value": parsed}
    return raw_args if isinstance(raw_args, dict) else {"value": raw_args}


def _antigravity_tool_calls(entry: dict[str, Any]) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    for key in ("tool_calls", "toolCalls"):
        value = entry.get(key)
        if isinstance(value, list):
            calls.extend(c for c in value if isinstance(c, dict))

    planner = entry.get("PLANNER_RESPONSE") or entry.get("planner_response")
    if isinstance(planner, dict):
        for key in ("tool_calls", "toolCalls"):
            value = planner.get(key)
            if isinstance(value, list):
                calls.extend(c for c in value if isinstance(c, dict))
    return calls


def _canonical_antigravity_args(tool_name: str, raw_args: dict[str, Any]) -> dict[str, Any]:
    args: dict[str, Any] = {"raw_args": raw_args}
    if tool_name == "run_command":
        command = _arg_value(raw_args, "CommandLine", "command")
        if command is not None:
            args["command"] = str(command)
    elif tool_name == "view_file":
        file_path = _arg_value(
            raw_args,
            "AbsolutePath",
            "Path",
            "path",
            "file_path",
            "filePath",
        )
        if file_path is not None:
            args["file_path"] = str(file_path)
        is_skill_file = _nested_arg_value(
            raw_args,
            "IsSkillFile",
            "isSkillFile",
            "is_skill_file",
        )
        if is_skill_file is not None:
            args["is_skill_file"] = bool(is_skill_file)
    elif tool_name == "list_dir":
        path = _arg_value(raw_args, "DirectoryPath", "directory_path", "path")
        if path is not None:
            args["path"] = str(path)
    else:
        args.update(raw_args)
    return args
```

- [ ] **Step 4: Add `normalize_antigravity_logs` and register it**

Still in `quorum/normalizers.py`, add:

```python
def normalize_antigravity_logs(raw_content: str) -> list[dict[str, Any]]:
    """Normalize Google Antigravity transcript JSONL to Quorum tool rows.

    Antigravity transcript shape is observed rather than guaranteed. Keep the
    parser tolerant: ignore malformed/non-tool lines, preserve unknown tools,
    and retain each call's raw arguments under args.raw_args.
    """
    results: list[dict[str, Any]] = []
    for line in raw_content.strip().split("\n"):
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(entry, dict):
            continue
        for call in _antigravity_tool_calls(entry):
            name = call.get("name") or call.get("tool_name") or call.get("toolName") or ""
            if not isinstance(name, str) or not name:
                continue
            raw_args = _parse_tool_args(call.get("args", call.get("arguments", {})))
            canonical = ANTIGRAVITY_TOOL_MAP.get(name, name)
            args = _canonical_antigravity_args(name, raw_args)
            source = "native" if canonical in ANTIGRAVITY_NATIVE_TOOLS else "shell"
            results.append({"tool": canonical, "args": args, "source": source})
    return results
```

Then add it to `NORMALIZERS`:

```python
NORMALIZERS: dict[str, Callable[[str], list[dict[str, Any]]]] = {
    "antigravity": normalize_antigravity_logs,
    "claude": normalize_claude_logs,
    "codex": normalize_codex_logs,
    "gemini": normalize_gemini_logs,
    "pi": normalize_pi_logs,
}
```

- [ ] **Step 5: Run normalizer tests**

Run: `uv run pytest tests/quorum/test_normalizers.py -x -q`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add quorum/normalizers.py tests/quorum/test_normalizers.py
git commit -m "quorum: normalize antigravity transcript tool calls"
```

---

## Task 3: Skill Predicate Parity for Antigravity Reads

**Why now:** Antigravity loads skills through file reads. Shared predicate support makes every `skill-*` check agree without scenario-specific logic.

**Files:**
- Modify: `bin/_skill_predicate.jq`
- Test: `tests/quorum/test_trace_tools.py`

- [ ] **Step 1: Add failing trace-tool tests for normalized `Read` skill loads**

Append these tests near the existing `skill-called` predicate tests in `tests/quorum/test_trace_tools.py`:

```python
def test_skill_called_recognizes_antigravity_read_skill_md(tmp_path):
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(
        parent,
        {
            "tool": "Read",
            "args": {
                "file_path": "/tmp/run/.gemini/config/plugins/superpowers/skills/brainstorming/SKILL.md",
                "is_skill_file": True,
            },
        },
    )
    sink = tmp_path / "s"
    assert (
        _run(
            "skill-called",
            "superpowers:brainstorming",
            trace=trace,
            cwd=workdir,
            sink=sink,
        )
        == 0
    )


def test_skill_before_tool_recognizes_antigravity_read_skill_md(tmp_path):
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(
        parent,
        {
            "tool": "Read",
            "args": {
                "file_path": "/tmp/run/skills/superpowers/test-driven-development/SKILL.md",
            },
        },
        {"tool": "Edit", "args": {"file_path": "src/app.py"}},
    )
    sink = tmp_path / "s"
    assert (
        _run(
            "skill-before-tool",
            "superpowers:test-driven-development",
            "Edit",
            trace=trace,
            cwd=workdir,
            sink=sink,
        )
        == 0
    )


def test_skill_called_rejects_antigravity_read_of_other_skill(tmp_path):
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(
        parent,
        {
            "tool": "Read",
            "args": {
                "file_path": "/tmp/run/skills/writing-plans/SKILL.md",
                "is_skill_file": True,
            },
        },
    )
    sink = tmp_path / "s"
    assert (
        _run(
            "skill-called",
            "superpowers:brainstorming",
            trace=trace,
            cwd=workdir,
            sink=sink,
        )
        != 0
    )
```

- [ ] **Step 2: Run targeted trace tests and verify failure**

Run: `uv run pytest tests/quorum/test_trace_tools.py::test_skill_called_recognizes_antigravity_read_skill_md -x -q`

Expected: FAIL because `_skill_predicate.jq` only recognizes native `Skill` and shell `SKILL.md` reads.

- [ ] **Step 3: Update `_skill_predicate.jq`**

In `bin/_skill_predicate.jq`, replace `def is_skill_invocation($name; $dir): ...` with this complete definition:

```jq
def is_skill_invocation($name; $dir):
    (.tool == "Skill" and (.args.skill // "") == $name)
    or (
        ((.tool // "") | test("^(Bash|Shell|LocalShellCall)$"))
        and (
            ((.args.command // .args.cmd // "") | test(
                "(^|[[:space:]'\\''\"/])skills/(superpowers/)?" + $dir + "/SKILL[.]md([[:space:]'\\''\";]|$)"
            ))
        )
    )
    or (
        (.tool == "Read")
        and (
            (((.args.file_path // .args.path // "") | tostring) | test(
                "(^|/)skills/(superpowers/)?" + $dir + "/SKILL[.]md$"
            ))
        )
    );
```

Update the coverage comment above it to list the Antigravity `Read` form.

- [ ] **Step 4: Run all trace-tool tests**

Run: `uv run pytest tests/quorum/test_trace_tools.py -x -q`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bin/_skill_predicate.jq tests/quorum/test_trace_tools.py
git commit -m "quorum: count antigravity skill file reads as skill invocations"
```

---

## Task 4: Antigravity Config, Context, and Launcher

**Why now:** Once the normalizer is registered, the YAML can load and the Gauntlet-Agent needs the same one-command launch affordance as Claude and Codex.

**Files:**
- Create: `coding-agents/antigravity.yaml`
- Create: `coding-agents/antigravity-context/HOWTO.md`
- Create: `coding-agents/antigravity-context/launch-agent`
- Test: `tests/quorum/test_coding_agent_config.py` or existing config-loader tests
- Test: `tests/quorum/test_runner.py`

- [ ] **Step 1: Add a failing config-load test**

If `tests/quorum/test_coding_agent_config.py` exists, add this there. If not, create it with the imports below:

```python
from pathlib import Path

from quorum.coding_agent_config import load_coding_agent_config


def test_antigravity_config_loads_when_superpowers_root_set(monkeypatch, tmp_path):
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "superpowers"))
    cfg = load_coding_agent_config(
        Path(__file__).resolve().parents[2] / "coding-agents" / "antigravity.yaml"
    )

    assert cfg.name == "antigravity"
    assert cfg.binary == "agy"
    assert cfg.agent_config_env == "ANTIGRAVITY_CONFIG_DIR"
    assert cfg.normalizer == "antigravity"
    assert cfg.resolve_session_log_dir(tmp_path / "cfg") == (
        tmp_path / "cfg" / ".gemini" / "antigravity-cli" / "brain"
    )
```

- [ ] **Step 2: Run the config test and verify failure**

Run: `uv run pytest tests/quorum/test_coding_agent_config.py -x -q`

Expected: FAIL because `coding-agents/antigravity.yaml` does not exist.

- [ ] **Step 3: Create `coding-agents/antigravity.yaml`**

Create `coding-agents/antigravity.yaml`:

```yaml
name: antigravity
binary: agy
agent_config_env: ANTIGRAVITY_CONFIG_DIR
session_log_dir: "${ANTIGRAVITY_CONFIG_DIR}/.gemini/antigravity-cli/brain"
session_log_glob: "**/transcript.jsonl"
normalizer: antigravity
required_env:
  - SUPERPOWERS_ROOT
max_time: 10m
```

- [ ] **Step 4: Create the launcher**

Create `coding-agents/antigravity-context/launch-agent`:

```bash
#!/usr/bin/env bash
# quorum-generated launcher for Google Antigravity (the agent under test).
#
# The cd, ANTIGRAVITY_CONFIG_DIR, hidden --gemini_dir, auto-update disable,
# and dangerous-mode flag are baked in here so the QA agent starts agy from the
# prepared workdir with one command. quorum substitutes the $... values below
# at runtime; the installed copy contains literal absolute paths.
#
# Equivalent manual command (for debugging):
#   cd "$QUORUM_AGENT_CWD" && ANTIGRAVITY_CONFIG_DIR="$ANTIGRAVITY_CONFIG_DIR" AGY_CLI_DISABLE_AUTO_UPDATE=true agy --gemini_dir="$ANTIGRAVITY_CONFIG_DIR/.gemini" --dangerously-skip-permissions --log-file "$ANTIGRAVITY_CONFIG_DIR/agy.log"
set -euo pipefail
cd "$QUORUM_AGENT_CWD" || { echo "launch-agent: cannot cd to $QUORUM_AGENT_CWD" >&2; exit 1; }
exec env \
  ANTIGRAVITY_CONFIG_DIR="$ANTIGRAVITY_CONFIG_DIR" \
  AGY_CLI_DISABLE_AUTO_UPDATE=true \
  agy \
    --gemini_dir="$ANTIGRAVITY_CONFIG_DIR/.gemini" \
    --dangerously-skip-permissions \
    --log-file "$ANTIGRAVITY_CONFIG_DIR/agy.log" \
    "$@"
```

Make it executable:

Run: `chmod +x coding-agents/antigravity-context/launch-agent`

- [ ] **Step 5: Create the HOWTO**

Create `coding-agents/antigravity-context/HOWTO.md`:

````markdown
# How to drive Google Antigravity (the agent under test)

You are driving Google Antigravity in a bash shell inside tmux. Antigravity is
itself an AI agent; what appears on screen is its work.

## Launch Antigravity with one command

Your bash starts in a scratch directory, NOT the workdir quorum prepared.
quorum has generated a launcher that handles everything: it cds into the
prepared workdir, sets the per-run isolated `ANTIGRAVITY_CONFIG_DIR`, disables
Antigravity auto-update, points `agy` at the isolated `.gemini` tree, and starts
the interactive CLI with dangerous permissions enabled.

Type this one line, verbatim, as your first action:

```
"$QUORUM_LAUNCH_AGENT"
```

That path is burned into this HOWTO at runtime by quorum; it points at a
generated executable that runs, in effect:

```
cd <prepared-workdir> && ANTIGRAVITY_CONFIG_DIR=<per-run-isolated-dir> AGY_CLI_DISABLE_AUTO_UPDATE=true agy --gemini_dir=<per-run-isolated-dir>/.gemini --dangerously-skip-permissions --log-file <per-run-isolated-dir>/agy.log
```

Because the `cd` and flags live inside the launcher, do not hand-type a bare
`agy` or reconstruct the command yourself.

## Observing what Antigravity is doing

Antigravity writes transcripts under:

```
$ANTIGRAVITY_CONFIG_DIR/.gemini/antigravity-cli/brain/**/transcript.jsonl
```

The launcher also writes a CLI log at:

```
$ANTIGRAVITY_CONFIG_DIR/agy.log
```

The transcript is the ground truth for tool calls. The screen can lag, scroll,
or omit details. When checking whether Antigravity loaded a skill, edited a
file, dispatched a subagent, or ran a shell command, inspect the transcript or
the log rather than trusting only the screen.

Find the newest transcript:

```
find "$ANTIGRAVITY_CONFIG_DIR/.gemini/antigravity-cli/brain" -name transcript.jsonl -print 2>/dev/null | sort | tail -1
```

Peek at recent tool calls:

```
tail -20 <path-to-transcript.jsonl> | jq -c '{tool_calls, PLANNER_RESPONSE}'
```

## Waiting for Antigravity to work

After launch, register the transcript glob once, then block-wait:

```
watch_logs(glob="$ANTIGRAVITY_CONFIG_DIR/.gemini/antigravity-cli/brain/**/transcript.jsonl")
wake_on_idle_log(idle_ms=60000, timeout_ms=240000)
```

Use ad-hoc `bash tail -n` after waking if you need to see what changed.

## Tool mapping notes

Antigravity skill loads usually appear as `view_file` calls on plugin skill
files, not as a native `Skill` call. Subagents may appear as `invoke_subagent`
or `manage_subagents`; only fixture-proven subagent launch calls count as
canonical `Agent` behavior in Quorum. Task-management artifacts are not
evidence of native task behavior by themselves.

Antigravity may write `.antigravitycli/` project metadata into the workdir.
Treat that directory as Antigravity runtime metadata, not user-requested work.

## Shutdown

Exit the Antigravity CLI cleanly when the scenario is complete.
````

- [ ] **Step 6: Add a launcher substitution test**

In `tests/quorum/test_runner.py`, add:

```python
def test_antigravity_launch_agent_is_interactive_and_substituted(self, tmp_path, monkeypatch):
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "sp"))
    coding_agents_dir = tmp_path / "coding-agents"
    scenarios_dir = tmp_path / "scenarios"
    session_log_dir = tmp_path / "logs"
    session_log_dir.mkdir()
    (coding_agents_dir / "antigravity.yaml").write_text(yaml.safe_dump({
        "name": "antigravity",
        "binary": "echo",
        "agent_config_env": "ANTIGRAVITY_CONFIG_DIR",
        "session_log_dir": str(session_log_dir),
        "session_log_glob": "*.jsonl",
        "normalizer": "claude",
        "required_env": [],
    }))
    ctx = coding_agents_dir / "antigravity-context"
    ctx.mkdir(parents=True)
    (ctx / "launch-agent").write_text(
        '#!/usr/bin/env bash\n'
        'cd "$QUORUM_AGENT_CWD"\n'
        'exec env ANTIGRAVITY_CONFIG_DIR="$ANTIGRAVITY_CONFIG_DIR" '
        'AGY_CLI_DISABLE_AUTO_UPDATE=true agy '
        '--gemini_dir="$ANTIGRAVITY_CONFIG_DIR/.gemini" '
        '--dangerously-skip-permissions '
        '--log-file "$ANTIGRAVITY_CONFIG_DIR/agy.log" "$@"\n'
    )
    sd = _make_scenario(scenarios_dir, "x")
    out_root = tmp_path / "results"

    with patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass):
        run_scenario(
            scenario_dir=sd,
            coding_agent="antigravity",
            coding_agents_dir=coding_agents_dir,
            out_root=out_root,
            skeleton_root=_empty_skeleton(tmp_path),
        )

    shim = next(out_root.iterdir()) / "gauntlet-agent" / "context" / "launch-agent"
    content = shim.read_text()
    assert "$QUORUM_AGENT_CWD" not in content
    assert "$ANTIGRAVITY_CONFIG_DIR" not in content
    assert "AGY_CLI_DISABLE_AUTO_UPDATE=true" in content
    assert "--gemini_dir=" in content
    assert "--dangerously-skip-permissions" in content
    assert "--print" not in content
```

- [ ] **Step 7: Run config and launcher tests**

Run: `uv run pytest tests/quorum/test_coding_agent_config.py tests/quorum/test_runner.py::test_antigravity_launch_agent_is_interactive_and_substituted -x -q`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add coding-agents/antigravity.yaml coding-agents/antigravity-context tests/quorum/test_coding_agent_config.py tests/quorum/test_runner.py
git commit -m "quorum: add antigravity coding-agent config"
```

---

## Task 5: Runner Provisioning, Auth Preflight, and `.antigravitycli/` Exclusion

**Why now:** The CLI target must install Superpowers into the isolated config before scenario execution, verify auth/isolation with a throwaway config, and prevent Antigravity project metadata from breaking git-clean checks.

**Files:**
- Modify: `quorum/runner.py`
- Test: `tests/quorum/test_runner.py`

- [ ] **Step 1: Add failing runner tests**

In `tests/quorum/test_runner.py`, extend imports:

```python
from quorum.runner import (
    RunnerError,
    _exclude_antigravity_project_marker,
    _seed_agent_config_dir,
    _seed_antigravity_config,
    run_scenario,
)
```

Add these tests in `TestSeedAgentConfigDir`:

```python
def test_antigravity_seed_requires_superpowers_root(self, tmp_path, monkeypatch):
    monkeypatch.delenv("SUPERPOWERS_ROOT", raising=False)
    with pytest.raises(RunnerError, match="SUPERPOWERS_ROOT"):
        _seed_antigravity_config(tmp_path / "cfg")


def test_antigravity_seed_runs_auth_preflight_then_plugin_install(self, tmp_path, monkeypatch):
    sp = tmp_path / "superpowers"
    sp.mkdir()
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(sp))
    monkeypatch.setattr("quorum.runner.shutil.which", lambda name: "/usr/bin/agy")
    cfg = tmp_path / "cfg"

    def fake_run(cmd, **kwargs):
        if "--print" in cmd:
            assert kwargs["cwd"] != cfg
            assert str(cfg) not in str(cmd)
            assert cmd.index("--print-timeout") < cmd.index("--print")
            gemini_arg = next(part for part in cmd if part.startswith("--gemini_dir="))
            gemini_dir = Path(gemini_arg.split("=", 1)[1])
            transcript_dir = gemini_dir / "antigravity-cli" / "brain" / "session" / ".system_generated" / "logs"
            transcript_dir.mkdir(parents=True)
            (transcript_dir / "transcript.jsonl").write_text('{"tool_calls":[]}\n')
            return subprocess.CompletedProcess(cmd, 0, "OK\n", "")
        assert cmd == [
            "agy",
            f"--gemini_dir={cfg / '.gemini'}",
            "plugin",
            "install",
            str(sp),
        ]
        assert kwargs["env"]["AGY_CLI_DISABLE_AUTO_UPDATE"] == "true"
        root = cfg / ".gemini" / "config" / "plugins" / "superpowers"
        (root / "skills" / "using-superpowers").mkdir(parents=True)
        (root / "plugin.json").write_text("{}")
        (root / "hooks.json").write_text("{}")
        (root / "skills" / "using-superpowers" / "SKILL.md").write_text("skill")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    with patch("quorum.runner.subprocess.run", side_effect=fake_run) as mock_run:
        _seed_antigravity_config(cfg)

    assert mock_run.call_count == 2


def test_antigravity_seed_fails_when_install_creates_real_config_transcript(
    self, tmp_path, monkeypatch
):
    sp = tmp_path / "superpowers"
    sp.mkdir()
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(sp))
    monkeypatch.setattr("quorum.runner.shutil.which", lambda name: "/usr/bin/agy")
    cfg = tmp_path / "cfg"

    def fake_run(cmd, **kwargs):
        gemini_arg = next(part for part in cmd if part.startswith("--gemini_dir="))
        gemini_dir = Path(gemini_arg.split("=", 1)[1])
        if "--print" in cmd:
            transcript_dir = gemini_dir / "antigravity-cli" / "brain" / "session" / ".system_generated" / "logs"
            transcript_dir.mkdir(parents=True)
            (transcript_dir / "transcript.jsonl").write_text('{"tool_calls":[]}\n')
            return subprocess.CompletedProcess(cmd, 0, "OK\n", "")
        root = cfg / ".gemini" / "config" / "plugins" / "superpowers"
        (root / "skills" / "using-superpowers").mkdir(parents=True)
        (root / "plugin.json").write_text("{}")
        (root / "hooks.json").write_text("{}")
        (root / "skills" / "using-superpowers" / "SKILL.md").write_text("skill")
        transcript_dir = cfg / ".gemini" / "antigravity-cli" / "brain" / "session" / ".system_generated" / "logs"
        transcript_dir.mkdir(parents=True)
        (transcript_dir / "transcript.jsonl").write_text("{}\n")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    with (
        patch("quorum.runner.subprocess.run", side_effect=fake_run),
        pytest.raises(RunnerError, match="provisioning unexpectedly wrote transcripts"),
    ):
        _seed_antigravity_config(cfg)
```

Add this test class near runner helpers:

```python
class TestAntigravityProjectMarkerExclusion:
    def test_excludes_marker_in_git_info_exclude_idempotently(self, tmp_path):
        repo = tmp_path / "repo"
        repo.mkdir()
        subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)

        _exclude_antigravity_project_marker(repo)
        _exclude_antigravity_project_marker(repo)

        exclude_path = subprocess.check_output(
            ["git", "-C", str(repo), "rev-parse", "--git-path", "info/exclude"],
            text=True,
        ).strip()
        lines = (repo / exclude_path).read_text().splitlines()
        assert lines.count(".antigravitycli/") == 1

    def test_exclusion_is_noop_outside_git_repo(self, tmp_path):
        plain = tmp_path / "plain"
        plain.mkdir()
        _exclude_antigravity_project_marker(plain)
        assert not (plain / ".git").exists()
```

Add this run-scenario integration test:

```python
def test_antigravity_excludes_project_marker_after_launch_cwd_resolution(
    self, tmp_path, monkeypatch
):
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "sp"))
    coding_agents_dir = tmp_path / "coding-agents"
    scenarios_dir = tmp_path / "scenarios"
    session_log_dir = tmp_path / "logs"
    session_log_dir.mkdir()
    (coding_agents_dir / "antigravity.yaml").write_text(yaml.safe_dump({
        "name": "antigravity",
        "binary": "echo",
        "agent_config_env": "ANTIGRAVITY_CONFIG_DIR",
        "session_log_dir": str(session_log_dir),
        "session_log_glob": "*.jsonl",
        "normalizer": "claude",
        "required_env": [],
    }))
    (coding_agents_dir / "antigravity-context").mkdir(parents=True)
    sd = _make_scenario(scenarios_dir, "x")
    _exec(
        sd / "setup.sh",
        "#!/usr/bin/env bash\nset -euo pipefail\n"
        "git init >/dev/null\n"
        "mkdir app\n"
        "git -C app init >/dev/null\n"
        'echo "$QUORUM_WORKDIR/app" > "$QUORUM_WORKDIR/.quorum-launch-cwd"\n',
    )
    out_root = tmp_path / "results"

    with (
        patch("quorum.runner._seed_antigravity_config"),
        patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass),
    ):
        run_scenario(
            scenario_dir=sd,
            coding_agent="antigravity",
            coding_agents_dir=coding_agents_dir,
            out_root=out_root,
            skeleton_root=_empty_skeleton(tmp_path),
        )

    launch_repo = next(out_root.iterdir()) / "coding-agent-workdir" / "app"
    exclude_path = subprocess.check_output(
        ["git", "-C", str(launch_repo), "rev-parse", "--git-path", "info/exclude"],
        text=True,
    ).strip()
    assert ".antigravitycli/" in (launch_repo / exclude_path).read_text()
```

- [ ] **Step 2: Run targeted tests and verify failure**

Run: `uv run pytest tests/quorum/test_runner.py -k 'antigravity' -x -q`

Expected: FAIL because `_seed_antigravity_config` and `_exclude_antigravity_project_marker` do not exist.

- [ ] **Step 3: Add staged `RunnerError` support**

In `quorum/runner.py`, replace the current `RunnerError` class with:

```python
class RunnerError(RuntimeError):
    """Raised on non-recoverable errors before verdict composition."""

    def __init__(self, message: str, *, stage: str = "unknown"):
        super().__init__(message)
        self.stage = stage
```

In `run_scenario`, change the `except RunnerError as e` block to:

```python
    except RunnerError as e:
        v = _write_indeterminate(
            run_dir,
            final_reason=f"runner error: {e}",
            error=RunError(stage=e.stage, message=str(e)[:500]),
        )
        return run_dir, v
```

If `ty` complains that `e.stage` is too wide for `RunError.stage`, add this type alias in `quorum/composer.py`:

```python
RunErrorStage = Literal[
    "setup",
    "gauntlet",
    "capture",
    "checks",
    "compose",
    "qa-agent-misconfigured",
    "unknown",
]
```

Then change `RunError.stage` to `RunErrorStage` and import `RunErrorStage` in `quorum/runner.py` for the `RunnerError` annotation:

```python
from quorum.composer import FinalVerdict, GauntletLayer, GauntletStatus, RunError, RunErrorStage, compose
```

```python
class RunnerError(RuntimeError):
    def __init__(self, message: str, *, stage: RunErrorStage = "unknown"):
        super().__init__(message)
        self.stage = stage
```

- [ ] **Step 4: Implement Antigravity provisioning helpers**

In `quorum/runner.py`, add imports:

```python
import tempfile
```

Add these helpers after `_seed_codex_plugin_hooks`:

```python
def _antigravity_transcripts(config_dir: Path) -> list[Path]:
    brain = config_dir / ".gemini" / "antigravity-cli" / "brain"
    if not brain.exists():
        return []
    return sorted(brain.glob("**/transcript.jsonl"))


def _run_antigravity_auth_preflight() -> None:
    """Verify agy auth and hidden --gemini_dir isolation using throwaway state."""
    with tempfile.TemporaryDirectory(prefix="quorum-antigravity-preflight-") as tmp:
        tmp_path = Path(tmp)
        cwd = tmp_path / "cwd"
        cwd.mkdir()
        gemini_dir = tmp_path / ".gemini"
        log_path = tmp_path / "agy.log"
        cmd = [
            "agy",
            f"--gemini_dir={gemini_dir}",
            "--dangerously-skip-permissions",
            "--log-file",
            str(log_path),
            "--print-timeout",
            "60s",
            "--print",
            "Reply with EXACTLY OK.",
        ]
        try:
            result = subprocess.run(
                cmd,
                cwd=cwd,
                text=True,
                capture_output=True,
                timeout=90,
                env={**os.environ, "AGY_CLI_DISABLE_AUTO_UPDATE": "true"},
            )
        except subprocess.TimeoutExpired as e:
            raise RunnerError(
                "antigravity auth preflight timed out after 90s; check agy browser/keyring auth",
                stage="setup",
            ) from e
        if result.returncode != 0:
            raise RunnerError(
                "antigravity auth preflight failed "
                f"(exit {result.returncode}); check agy browser/keyring auth. "
                f"stderr: {result.stderr.strip()[:300]}",
                stage="setup",
            )
        if "OK" not in result.stdout:
            raise RunnerError(
                "antigravity auth preflight did not return OK; "
                f"stdout: {result.stdout.strip()[:300]}",
                stage="setup",
            )
        transcripts = sorted(
            (gemini_dir / "antigravity-cli" / "brain").glob("**/transcript.jsonl")
        )
        if not transcripts:
            raise RunnerError(
                "antigravity auth preflight produced no transcript under isolated --gemini_dir",
                stage="setup",
            )


def _seed_antigravity_config(antigravity_config_dir: Path) -> None:
    """Install Superpowers into an isolated Antigravity .gemini tree."""
    superpowers_root = os.environ.get("SUPERPOWERS_ROOT", "")
    if not superpowers_root:
        raise RunnerError(
            "SUPERPOWERS_ROOT not set; cannot install antigravity Superpowers plugin",
            stage="setup",
        )
    if shutil.which("agy") is None:
        raise RunnerError("agy not found on PATH; cannot run antigravity evals", stage="setup")

    antigravity_config_dir.mkdir(parents=True, exist_ok=True)
    _run_antigravity_auth_preflight()

    cmd = [
        "agy",
        f"--gemini_dir={antigravity_config_dir / '.gemini'}",
        "plugin",
        "install",
        superpowers_root,
    ]
    result = subprocess.run(
        cmd,
        cwd=antigravity_config_dir,
        text=True,
        capture_output=True,
        env={**os.environ, "AGY_CLI_DISABLE_AUTO_UPDATE": "true"},
    )
    if result.returncode != 0:
        raise RunnerError(
            "agy plugin install failed "
            f"(exit {result.returncode}); stderr: {result.stderr.strip()[:300]}",
            stage="setup",
        )

    plugin_root = antigravity_config_dir / ".gemini" / "config" / "plugins" / "superpowers"
    required = [
        plugin_root / "plugin.json",
        plugin_root / "hooks.json",
        plugin_root / "skills" / "using-superpowers" / "SKILL.md",
    ]
    missing = [str(p.relative_to(plugin_root)) for p in required if not p.exists()]
    if missing:
        raise RunnerError(
            "agy plugin install completed but expected Superpowers plugin files are missing: "
            + ", ".join(missing),
            stage="setup",
        )

    transcripts = _antigravity_transcripts(antigravity_config_dir)
    if transcripts:
        rel = [str(p.relative_to(antigravity_config_dir)) for p in transcripts]
        raise RunnerError(
            "antigravity provisioning unexpectedly wrote transcripts before capture snapshot: "
            + ", ".join(rel),
            stage="setup",
        )
```

- [ ] **Step 5: Wire Antigravity seeding into `_seed_agent_config_dir`**

In `_seed_agent_config_dir`, after the Codex block, add:

```python
    if coding_agent.name == "antigravity":
        _seed_antigravity_config(dest)
```

- [ ] **Step 6: Implement `.antigravitycli/` local git exclusion**

In `quorum/runner.py`, add:

```python
def _exclude_antigravity_project_marker(launch_cwd: Path) -> None:
    """Ignore Antigravity's project marker in the launch repo when one exists."""
    inside = subprocess.run(
        ["git", "-C", str(launch_cwd), "rev-parse", "--is-inside-work-tree"],
        text=True,
        capture_output=True,
    )
    if inside.returncode != 0 or inside.stdout.strip() != "true":
        return

    git_path = subprocess.run(
        ["git", "-C", str(launch_cwd), "rev-parse", "--git-path", "info/exclude"],
        text=True,
        capture_output=True,
        check=True,
    ).stdout.strip()
    exclude_path = Path(git_path)
    if not exclude_path.is_absolute():
        exclude_path = launch_cwd / exclude_path
    exclude_path.parent.mkdir(parents=True, exist_ok=True)
    existing = exclude_path.read_text().splitlines() if exclude_path.exists() else []
    if ".antigravitycli/" not in existing:
        with exclude_path.open("a") as f:
            if existing and existing[-1] != "":
                f.write("\n")
            f.write(".antigravitycli/\n")
```

After `launch_cwd = _resolve_launch_cwd(workdir)` in `_run_scenario_inner`, add:

```python
    if tcfg.name == "antigravity":
        _exclude_antigravity_project_marker(launch_cwd)
```

- [ ] **Step 7: Run Antigravity runner tests**

Run: `uv run pytest tests/quorum/test_runner.py -k 'antigravity' -x -q`

Expected: PASS.

- [ ] **Step 8: Run the full runner suite**

Run: `uv run pytest tests/quorum/test_runner.py -x -q`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add quorum/runner.py quorum/composer.py tests/quorum/test_runner.py
git commit -m "quorum: provision isolated antigravity runs"
```

---

## Task 6: Antigravity Missing-Transcript and Zero-Row Diagnostics

**Why now:** Once Antigravity can launch, Quorum must fail closed when capture did not prove the target was observed.

**Files:**
- Modify: `quorum/runner.py`
- Test: `tests/quorum/test_runner.py`

- [ ] **Step 1: Add failing diagnostic tests**

In `tests/quorum/test_runner.py`, add:

```python
def _make_antigravity_agent(coding_agents_dir: Path, session_log_dir: Path, normalizer: str = "claude") -> None:
    coding_agents_dir.mkdir(parents=True, exist_ok=True)
    (coding_agents_dir / "antigravity.yaml").write_text(yaml.safe_dump({
        "name": "antigravity",
        "binary": "echo",
        "agent_config_env": "ANTIGRAVITY_CONFIG_DIR",
        "session_log_dir": str(session_log_dir),
        "session_log_glob": "*.jsonl",
        "normalizer": normalizer,
        "required_env": [],
    }))
    (coding_agents_dir / "antigravity-context").mkdir(parents=True, exist_ok=True)
```

Append these tests in `TestRunScenario`:

```python
def test_antigravity_missing_transcript_is_indeterminate_even_without_trace_checks(
    self, tmp_path, monkeypatch
):
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "sp"))
    coding_agents_dir = tmp_path / "coding-agents"
    scenarios_dir = tmp_path / "scenarios"
    session_log_dir = tmp_path / "logs"
    session_log_dir.mkdir()
    _make_antigravity_agent(coding_agents_dir, session_log_dir)
    sd = _make_scenario(scenarios_dir, "x", with_checks=False)
    (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")
    out_root = tmp_path / "results"

    with (
        patch("quorum.runner._seed_antigravity_config"),
        patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass),
    ):
        _run_dir, verdict = run_scenario(
            scenario_dir=sd,
            coding_agent="antigravity",
            coding_agents_dir=coding_agents_dir,
            out_root=out_root,
            skeleton_root=_empty_skeleton(tmp_path),
        )

    assert verdict.final == "indeterminate"
    assert "no Antigravity transcript" in verdict.final_reason
    assert verdict.error is not None
    assert verdict.error.stage == "capture"


def test_antigravity_zero_normalized_rows_is_distinct_from_missing_transcript(
    self, tmp_path, monkeypatch
):
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "sp"))
    coding_agents_dir = tmp_path / "coding-agents"
    scenarios_dir = tmp_path / "scenarios"
    session_log_dir = tmp_path / "logs"
    session_log_dir.mkdir()
    _make_antigravity_agent(coding_agents_dir, session_log_dir)
    sd = _make_scenario(scenarios_dir, "x", with_checks=False)
    (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")
    out_root = tmp_path / "results"

    def gauntlet_with_non_tool_log(*, run_dir, **kwargs):
        (session_log_dir / "session.jsonl").write_text('{"type":"assistant","text":"hello"}\n')
        return "pass"

    with (
        patch("quorum.runner._seed_antigravity_config"),
        patch("quorum.runner.invoke_gauntlet", side_effect=gauntlet_with_non_tool_log),
    ):
        _run_dir, verdict = run_scenario(
            scenario_dir=sd,
            coding_agent="antigravity",
            coding_agents_dir=coding_agents_dir,
            out_root=out_root,
            skeleton_root=_empty_skeleton(tmp_path),
        )

    assert verdict.final == "indeterminate"
    assert "normalized to zero tool-call rows" in verdict.final_reason
    assert verdict.error is not None
    assert verdict.error.stage == "capture"
```

- [ ] **Step 2: Run diagnostic tests and verify failure**

Run: `uv run pytest tests/quorum/test_runner.py -k 'antigravity_missing_transcript or antigravity_zero_normalized' -x -q`

Expected: FAIL because the runner currently lets empty non-trace captures compose normally.

- [ ] **Step 3: Add Antigravity capture short-circuits**

In `quorum/runner.py`, after `capture_token_usage(...)` and before post-checks, build the Gauntlet layer and short-circuit Antigravity capture failures:

```python
    gauntlet_layer = _build_gauntlet_layer_from_run_dir(run_dir)
    if gauntlet_layer is None:
        gauntlet_layer = GauntletLayer(
            status=gauntlet_status,
            summary="",
            reasoning="",
            run_id=None,
        )

    if tcfg.normalizer == "antigravity" and not capture_result.source_logs:
        return run_dir, _write_indeterminate(
            run_dir,
            final_reason=(
                "no Antigravity transcript appeared under isolated "
                f"{session_log_dir}; cannot evaluate this run"
            ),
            gauntlet=gauntlet_layer,
            checks=pre_records,
            error=RunError(stage="capture", message="no Antigravity transcript captured"),
        )

    if (
        tcfg.normalizer == "antigravity"
        and capture_result.source_logs
        and capture_result.row_count == 0
    ):
        rel = [str(p.relative_to(session_log_dir)) for p in capture_result.source_logs]
        return run_dir, _write_indeterminate(
            run_dir,
            final_reason=(
                "Antigravity transcript(s) normalized to zero tool-call rows: "
                + ", ".join(rel)
            ),
            gauntlet=gauntlet_layer,
            checks=pre_records,
            error=RunError(stage="capture", message="Antigravity capture normalized to zero rows"),
        )
```

Remove the later duplicate `gauntlet_layer = _build_gauntlet_layer_from_run_dir(...)` block before `compose`, since it now exists earlier.

- [ ] **Step 4: Run runner tests**

Run: `uv run pytest tests/quorum/test_runner.py -x -q`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add quorum/runner.py tests/quorum/test_runner.py
git commit -m "quorum: fail closed on missing antigravity capture"
```

---

## Task 7: Antigravity Plugin Install Check and Bootstrap Scenario

**Why now:** The harness target exists, but v1 acceptance needs a real scenario proving installed skills plus natural bootstrap behavior. `hooks.json` presence alone is not enough.

**Files:**
- Create: `bin/antigravity-plugin-installed`
- Create: `scenarios/antigravity-superpowers-bootstrap/story.md`
- Create: `scenarios/antigravity-superpowers-bootstrap/setup.sh`
- Create: `scenarios/antigravity-superpowers-bootstrap/checks.sh`
- Test: `tests/quorum/test_trace_tools.py`

- [ ] **Step 1: Add check-tool tests**

In `tests/quorum/test_trace_tools.py`, append:

```python
def test_antigravity_plugin_installed_passes_when_required_files_exist(tmp_path):
    run_dir = tmp_path / "run"
    workdir = run_dir / "coding-agent-workdir"
    workdir.mkdir(parents=True)
    plugin_root = (
        run_dir
        / "coding-agent-config"
        / ".gemini"
        / "config"
        / "plugins"
        / "superpowers"
    )
    (plugin_root / "skills" / "using-superpowers").mkdir(parents=True)
    (plugin_root / "plugin.json").write_text("{}")
    (plugin_root / "hooks.json").write_text("{}")
    (plugin_root / "skills" / "using-superpowers" / "SKILL.md").write_text("skill")
    sink = tmp_path / "s"

    result = subprocess.run(
        [str(BIN / "antigravity-plugin-installed")],
        cwd=workdir,
        env={
            "PATH": f"{BIN}:/usr/bin:/bin",
            "QUORUM_RECORD_SINK": str(sink),
            "QUORUM_RUN_DIR": str(run_dir),
        },
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0
    assert _r(sink)["passed"]


def test_antigravity_plugin_installed_fails_when_skill_missing(tmp_path):
    run_dir = tmp_path / "run"
    workdir = run_dir / "coding-agent-workdir"
    workdir.mkdir(parents=True)
    plugin_root = (
        run_dir
        / "coding-agent-config"
        / ".gemini"
        / "config"
        / "plugins"
        / "superpowers"
    )
    plugin_root.mkdir(parents=True)
    (plugin_root / "plugin.json").write_text("{}")
    (plugin_root / "hooks.json").write_text("{}")
    sink = tmp_path / "s"

    result = subprocess.run(
        [str(BIN / "antigravity-plugin-installed")],
        cwd=workdir,
        env={
            "PATH": f"{BIN}:/usr/bin:/bin",
            "QUORUM_RECORD_SINK": str(sink),
            "QUORUM_RUN_DIR": str(run_dir),
        },
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    rec = _r(sink)
    assert not rec["passed"]
    assert "using-superpowers" in rec["detail"]
```

- [ ] **Step 2: Run the new check-tool test and verify failure**

Run: `uv run pytest tests/quorum/test_trace_tools.py::test_antigravity_plugin_installed_passes_when_required_files_exist -x -q`

Expected: FAIL because `bin/antigravity-plugin-installed` does not exist.

- [ ] **Step 3: Create the check tool**

Create `bin/antigravity-plugin-installed`:

```bash
#!/usr/bin/env bash
_RECORD_CHECK=antigravity-plugin-installed
_RECORD_ARGS=("$@")
source "$(dirname "$0")/_record"
set -uo pipefail

if [ -z "${QUORUM_RUN_DIR:-}" ]; then
    record_fail "QUORUM_RUN_DIR is not set"
    exit 1
fi

PLUGIN_ROOT="$QUORUM_RUN_DIR/coding-agent-config/.gemini/config/plugins/superpowers"
missing=()
for rel in \
    "plugin.json" \
    "hooks.json" \
    "skills/using-superpowers/SKILL.md"
do
    if [ ! -f "$PLUGIN_ROOT/$rel" ]; then
        missing+=("$rel")
    fi
done

if [ "${#missing[@]}" -eq 0 ]; then
    record_pass "Superpowers plugin installed at $PLUGIN_ROOT"
else
    detail=$(printf '%s\n' "${missing[@]}" | paste -sd ', ' -)
    record_fail "missing Antigravity Superpowers plugin files: $detail"
    exit 1
fi
```

Make it executable:

Run: `chmod +x bin/antigravity-plugin-installed`

- [ ] **Step 4: Create the bootstrap scenario**

Create `scenarios/antigravity-superpowers-bootstrap/setup.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
uv run setup-helpers run create_base_repo
```

Make it executable:

Run: `chmod +x scenarios/antigravity-superpowers-bootstrap/setup.sh`

Create `scenarios/antigravity-superpowers-bootstrap/checks.sh`:

```bash
# coding-agents: antigravity

pre() {
    git-repo
    git-branch main
}

post() {
    antigravity-plugin-installed
    skill-called superpowers:brainstorming
    skill-before-tool superpowers:brainstorming Edit
    skill-before-tool superpowers:brainstorming Write
}
```

Create `scenarios/antigravity-superpowers-bootstrap/story.md`:

```markdown
---
id: antigravity-superpowers-bootstrap
title: Antigravity bootstraps Superpowers from the isolated plugin install
status: ready
tags: antigravity, bootstrap
---

You are a developer starting a new project with the Antigravity agent.

When Antigravity is at its input prompt, type this exact message and press
Enter:

"Let's make a react todo list"

Do NOT mention Superpowers, hooks, skills, brainstorming, planning, or tests.
The point is to see whether Antigravity's startup context and installed
Superpowers plugin make the agent reach for the right workflow on its own.

Once the agent has loaded a skill, started brainstorming, or started writing
tests or code, you are done. The goal is to test startup bootstrap, not to
drive the todo app to completion.

## Acceptance Criteria

- Quorum installed Superpowers into Antigravity's isolated
  `.gemini/config/plugins/superpowers` tree for this run. The installed
  `plugin.json`, `hooks.json`, and `skills/using-superpowers/SKILL.md` files
  exist under the per-run `ANTIGRAVITY_CONFIG_DIR`.
- The installed files alone are not considered proof that Antigravity honored
  startup hooks. The behavioral proof is the normalized transcript.
- The agent loaded `superpowers:brainstorming` in response to the naive
  "react todo list" request before writing implementation code. For
  Antigravity this may appear as a normalized `Read` tool call on
  `skills/brainstorming/SKILL.md` or `skills/superpowers/brainstorming/SKILL.md`.
```

- [ ] **Step 5: Run static scenario validation**

Run: `uv run quorum check`

Expected: PASS. If it fails on executable-bit conventions, keep `setup.sh` executable and keep `checks.sh` non-executable.

- [ ] **Step 6: Run trace-tool tests**

Run: `uv run pytest tests/quorum/test_trace_tools.py -x -q`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add bin/antigravity-plugin-installed scenarios/antigravity-superpowers-bootstrap tests/quorum/test_trace_tools.py
git commit -m "quorum: add antigravity bootstrap scenario"
```

---

## Task 8: Scenario Portability Edits and Sweep Triage Convention

**Why now:** Antigravity should run broadly by default, but representative scenarios should stop encoding Claude-only evidence where the deterministic checks are already portable.

**Files:**
- Modify: `scenarios/triggering-test-driven-development/story.md`
- Modify: `scenarios/worktree-creation-from-main/story.md`
- Create: `docs/baselines/antigravity-sweeps/README.md`
- Test: `uv run quorum check`

- [ ] **Step 1: Make TDD evidence wording backend-neutral**

In `scenarios/triggering-test-driven-development/story.md`, replace the current acceptance evidence paragraph:

```markdown
- The agent under test loaded the `superpowers:test-driven-development`
  skill before writing implementation code. Evidence: a `Skill` tool
  invocation naming `superpowers:test-driven-development` appears in
  the agent's session log under
  `$CLAUDE_CONFIG_DIR/projects/.../*.jsonl`, OR an equivalent shell
  invocation reading the skill's SKILL.md. Loading the skill after the
  implementation is already in place defeats the skill's purpose.
```

with:

```markdown
- The agent under test loaded the `superpowers:test-driven-development`
  skill before writing implementation code. Evidence comes from Quorum's
  normalized `coding-agent-tool-calls.jsonl`: a native `Skill` invocation,
  a shell read of the skill's `SKILL.md`, or a normalized `Read` of the skill's
  `SKILL.md` appears before any `Edit` or `Write`. Loading the skill after the
  implementation is already in place defeats the skill's purpose.
```

- [ ] **Step 2: Make worktree acceptance backend-neutral**

In `scenarios/worktree-creation-from-main/story.md`, replace:

```markdown
- The agent used the platform's native worktree tool to create it -
  on Claude Code, the `EnterWorktree` tool - rather than a raw
  `git worktree add`.
```

with:

```markdown
- The agent created the isolated worktree. Evidence may be a platform-native
  worktree tool such as `EnterWorktree`, or a shell command that runs
  `git worktree add`. The deterministic `worktree-created` check accepts both
  forms because the behavioral requirement is isolated workspace creation.
```

- [ ] **Step 3: Add broad sweep triage docs**

Create `docs/baselines/antigravity-sweeps/README.md`:

````markdown
# Antigravity Sweep Triage

Antigravity is a trusted-maintainer live target. Do not wire these commands
into public CI.

Run a broad sweep with:

```bash
SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers \
uv run quorum run-all --coding-agents antigravity --jobs 1
```

Every scenario without an explicit `# coding-agents:` directive is attempted
for Antigravity. Explicit directives still exclude Antigravity when they do
not name it.

For each non-passing result, classify the run in a dated markdown report under
this directory:

```markdown
# YYYY-MM-DD Antigravity Sweep

Command:
`SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers uv run quorum run-all --coding-agents antigravity --jobs 1`

Batch:
`results-quorum/batches/<batch-id>`

| Scenario | Verdict | Class | Run | Notes |
| --- | --- | --- | --- | --- |
| antigravity-superpowers-bootstrap | pass | n/a | results-quorum/... | Bootstrap passed. |
| example-scenario | fail | product-fail | results-quorum/... | Superpowers behavior failed in Antigravity. |
| example-port | fail | scenario-port-needed | results-quorum/... | Story/check still assumes Claude or Codex. |
| example-harness | indeterminate | harness-fail | results-quorum/... | Auth, install, capture, normalization, or isolation failed. |
```

Use exactly these classes:

- `product-fail` - Antigravity launched and was captured, but Superpowers or
  Antigravity behavior did not satisfy the scenario.
- `scenario-port-needed` - the scenario story or deterministic check assumes
  Claude/Codex-specific behavior instead of the shared Quorum behavior.
- `harness-fail` - install, auth, capture, normalization, isolation, or Quorum
  orchestration failed.

Do not convert broad failures into `# coding-agents:` gates by default. Add a
directive only when a scenario is inherently nonsensical for Antigravity, and
record that decision in the sweep report.
````

- [ ] **Step 4: Run scenario validation**

Run: `uv run quorum check`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scenarios/triggering-test-driven-development/story.md scenarios/worktree-creation-from-main/story.md docs/baselines/antigravity-sweeps/README.md
git commit -m "docs: prepare scenarios for antigravity sweeps"
```

---

## Task 9: README and Troubleshooting Docs

**Why now:** Maintainers need the exact environment, safety caveats, and diagnostics before running live evals.

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update command references**

In `README.md`, update examples that list Coding-Agents so `antigravity` appears alongside `claude` and `codex` where appropriate:

```markdown
uv run quorum run scenarios/<name> --coding-agent <claude|codex|antigravity>
```

For `run-all`, add an Antigravity-only trusted-maintainer example:

```markdown
SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers \
uv run quorum run-all --coding-agents antigravity --jobs 1
```

- [ ] **Step 2: Add Antigravity target docs**

In the Coding-Agent configuration section, add:

````markdown
### Antigravity

`coding-agents/antigravity.yaml` launches the Google Antigravity CLI (`agy`).
It requires:

```bash
export SUPERPOWERS_ROOT=/path/to/superpowers
```

Quorum creates a per-run `ANTIGRAVITY_CONFIG_DIR` under the run directory and
starts `agy` with:

```bash
AGY_CLI_DISABLE_AUTO_UPDATE=true \
agy --gemini_dir="$ANTIGRAVITY_CONFIG_DIR/.gemini" \
  --dangerously-skip-permissions \
  --log-file "$ANTIGRAVITY_CONFIG_DIR/agy.log"
```

`--gemini_dir` is a hidden Antigravity CLI compatibility dependency. It is
contained to the Antigravity runner and launcher. The runner performs a
throwaway auth/isolation preflight before installing Superpowers into the real
per-run config.

Antigravity live evals rely on local browser/keyring auth. They are
trusted-maintainer operations and are not safe for public CI.
````

- [ ] **Step 3: Add isolation and troubleshooting notes**

In the safety/isolation/troubleshooting sections, add:

```markdown
Antigravity writes `.antigravitycli/` project metadata into the launch workdir.
For git-backed fixtures, Quorum adds `.antigravitycli/` to the launch repo's
local `.git/info/exclude` file so git-clean checks keep measuring user work
rather than Antigravity metadata.

If an Antigravity run is indeterminate:

1. Check `agy --version`.
2. Check browser/keyring auth by running a one-shot `agy --print` smoke outside
   Quorum.
3. Inspect `<run>/coding-agent-config/agy.log`.
4. Confirm Superpowers installed under
   `<run>/coding-agent-config/.gemini/config/plugins/superpowers/`.
5. Confirm transcripts landed under
   `<run>/coding-agent-config/.gemini/antigravity-cli/brain/**/transcript.jsonl`.
6. Render the verdict with `uv run quorum show <run-id>` and classify broad
   sweep failures with `docs/baselines/antigravity-sweeps/README.md`.
```

- [ ] **Step 4: Run README grep sanity**

Run: `rg -n "antigravity|ANTIGRAVITY|agy|gemini_dir|dangerously-skip-permissions|run-all --coding-agents antigravity" README.md`

Expected: output includes each new topic.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document antigravity quorum target"
```

---

## Task 10: Static Verification

**Why now:** All non-live behavior should be verified before asking `agy` to run.

**Files:**
- No source edits unless a check reveals a defect.

- [ ] **Step 1: Run lint**

Run: `uv run ruff check`

Expected: PASS. If it fails, fix only the reported files touched by this plan, then rerun.

- [ ] **Step 2: Run typecheck**

Run: `uv run ty check`

Expected: PASS. If `RunError.stage` typing fails, apply the `RunErrorStage` alias from Task 5 Step 3 and rerun.

- [ ] **Step 3: Validate scenarios**

Run: `uv run quorum check`

Expected: PASS.

- [ ] **Step 4: Run tests**

Run: `uv run pytest`

Expected: PASS.

- [ ] **Step 5: Commit fixes if static verification required changes**

If Step 1 through Step 4 required code or docs fixes, commit them:

```bash
git add <changed-files>
git commit -m "quorum: fix antigravity static verification"
```

If no files changed, do not create an empty commit.

---

## Task 11: Trusted-Maintainer Live Smoke and Broad Sweep

**Why last:** These commands launch live agent CLIs with permissive flags and may capture sensitive local transcripts. They verify the behavior this harness exists to measure, but they must stay out of public CI.

**Files:**
- Optionally create: `docs/baselines/antigravity-sweeps/YYYY-MM-DD-antigravity-sweep.md`
- Optionally modify: scenario docs or checks if a sweep proves a scenario is Claude/Codex-specific

- [ ] **Step 1: Confirm local source target**

Run:

```bash
test -d /Users/drewritter/prime-rad/superpowers/.git
git -C /Users/drewritter/prime-rad/superpowers branch --show-current
```

Expected: the checkout exists. Branch may be `dev` or another local branch containing Jesse's Antigravity support.

- [ ] **Step 2: Run the required bootstrap smoke**

Run:

```bash
SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers \
uv run quorum run scenarios/antigravity-superpowers-bootstrap --coding-agent antigravity
```

Expected: terminal prints `run-id: <id>` and the final verdict is `pass`.

If the verdict is not `pass`, inspect it:

```bash
uv run quorum show <id>
```

Classify the cause:

- `harness-fail` if auth, install, capture, normalization, isolation, or `.antigravitycli/` exclusion failed.
- `product-fail` if Antigravity ran and was captured but Superpowers did not bootstrap to `superpowers:brainstorming`.
- `scenario-port-needed` only if the scenario text or deterministic checks are wrong for Antigravity.

- [ ] **Step 3: Run representative named matrix**

Run each scenario separately so failures are easy to inspect:

```bash
SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers \
uv run quorum run scenarios/triggering-test-driven-development --coding-agent antigravity

SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers \
uv run quorum run scenarios/claim-without-verification-naive --coding-agent antigravity

SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers \
uv run quorum run scenarios/worktree-creation-from-main --coding-agent antigravity
```

Expected: each produces a concrete verdict. Passing is ideal; a non-passing verdict is acceptable only with a clear class in the sweep notes.

Do not include `explicit-skill-request-sdd` in the acceptance matrix until a live Antigravity fixture proves which `manage_subagents` action is a subagent launch and which actions are list/wait/result operations. It will still be attempted by broad sweeps because it has no `# coding-agents:` directive.

- [ ] **Step 4: Run broad Antigravity sweep**

Run:

```bash
SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers \
uv run quorum run-all --coding-agents antigravity --jobs 1
```

Expected: Quorum attempts every ungated scenario and skips only scenarios whose `# coding-agents:` directive excludes `antigravity`.

- [ ] **Step 5: Write sweep report**

Create `docs/baselines/antigravity-sweeps/YYYY-MM-DD-antigravity-sweep.md` with this structure:

```markdown
# YYYY-MM-DD Antigravity Sweep

Command:
`SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers uv run quorum run-all --coding-agents antigravity --jobs 1`

Batch:
`results-quorum/batches/<batch-id>`

| Scenario | Verdict | Class | Run | Notes |
| --- | --- | --- | --- | --- |
| antigravity-superpowers-bootstrap | pass | n/a | results-quorum/... | Bootstrap passed. |
```

For every non-passing result, use one of `product-fail`, `scenario-port-needed`, or `harness-fail` and include the run path or run id.

- [ ] **Step 6: Commit live-report updates**

If the live sweep created a report or justified scenario wording/check edits:

```bash
git add docs/baselines/antigravity-sweeps scenarios README.md
git commit -m "docs: record initial antigravity sweep"
```

If the live smoke passed and no tracked files changed, do not create an empty commit.

---

## Final Verification Checklist

- [ ] `uv run ruff check` passes.
- [ ] `uv run ty check` passes.
- [ ] `uv run quorum check` passes.
- [ ] `uv run pytest` passes.
- [ ] `SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers uv run quorum run scenarios/antigravity-superpowers-bootstrap --coding-agent antigravity` produces a concrete verdict and is triaged.
- [ ] `uv run quorum show <bootstrap-run-id>` clearly reports pass or a specific `setup`/`capture` diagnostic.
- [ ] Broad sweep command is documented and either run or explicitly left for Drew with the static implementation complete.

## Self-Review

**Spec coverage:** The plan covers Antigravity YAML/context/launcher (Task 4), runner provisioning and `SUPERPOWERS_ROOT` local source parity (Task 5), auth/keyring preflight and hidden `--gemini_dir` isolation (Task 5), transcript capture metadata and fail-closed diagnostics (Tasks 1 and 6), normalizer mapping and unknown tool preservation (Task 2), skill invocation parity through shared jq (Task 3), `.antigravitycli/` exclusion (Task 5), bootstrap scenario and broad sweep triage without an allowlist (Tasks 7 and 8), README docs (Task 9), static verification (Task 10), and trusted live acceptance (Task 11).

**Placeholder scan:** The plan contains no unresolved placeholder markers and no vague "add tests" steps. Code-changing steps include concrete snippets, file paths, commands, and expected outcomes.

**Type consistency:** `CaptureResult.path/source_logs/row_count` is introduced in Task 1 and used consistently in Task 6. Antigravity config uses `ANTIGRAVITY_CONFIG_DIR` and `normalizer: antigravity` consistently across YAML, launcher, runner, and docs. Runner diagnostics reuse existing `setup` and `capture` stages, with an optional `RunErrorStage` type alias if `ty` needs narrower typing.
