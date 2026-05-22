# Harness Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the harness-model redesign per
`docs/superpowers/specs/2026-05-22-harness-model-design.md`: a bash `checks.sh`
vocabulary backed by a shared `_record` helper, a three-valued `pass | fail |
indeterminate` verdict, actor-prefixed run directories, the workdir born in the
run dir, and the migration of all 33 existing scenarios — with `README.md` and
`CLAUDE.md` updated to seed the canonical actor table.

**Architecture:** Build `harness/bin/` (a forked check-tool vocabulary; every
tool sources a shared `harness/bin/_record` helper that emits one JSON record
per invocation, including via an `ERR` trap for crashes) and `harness/checks.py`
(sources `checks.sh`, calls `pre()`/`post()` with `HARNESS_RECORD_SINK` set,
reads back the records). Rewrite `harness/composer.py` for the three-valued
verdict. Wire it through `runner.py` with a **per-scenario dispatch** — the
new path if a scenario has `checks.sh`, the old `assertions/` + `preflight.sh`
path otherwise — so the suite stays green during atomic per-scenario migration.
Finally remove the old path and update docs.

**Tech Stack:** Python 3.11+ (uv), pytest, bash + `jq` for the check tools, the
existing unmodified Gauntlet CLI on `PATH`. Gauntlet's `--state-dir` flag is
already supported.

---

## File Structure

**New files:**
- `harness/bin/_record` — shared sourced helper, `record_pass`/`record_fail`/`record_negated` + ERR trap, ~80 lines bash.
- `harness/bin/{file-exists,file-contains,command-succeeds,git-repo,git-branch,git-clean,git-count}` — new check tools.
- `harness/bin/{tool-called,tool-not-called,tool-count,tool-before,tool-arg-match,tool-match-before-tool-match,skill-called,skill-not-called,skill-before-tool,skill-before-tool-match}` — trace tools, copied from top-level `bin/`, re-fitted with `_record`, **and rewired to read the trace from `$HARNESS_TOOL_CALLS_PATH`** (the runner sets it; the file lives in the run dir, but cwd is the workdir).
- `harness/bin/codex-native-hook-configured` — copied from top-level `bin/`, re-fitted with `_record`, and rewired from the literal `agent-config/` to `$CODEX_HOME` (already exported by the runner) plus a workdir-relative working directory.
- `harness/bin/not` — negation wrapper.
- `harness/checks.py` — the check runner.
- `tests/harness/test_record_helper.py`, `tests/harness/test_checks.py`, `tests/harness/test_composer.py` — new tests.

**Modified files:**
- `harness/runner.py` — workdir-in-rundir; actor-prefixed paths; `--state-dir gauntlet-agent`; magic-comment parser; capture-non-empty built-in; dispatch (new path vs old); always-write-a-verdict wrapper; `target`→`coding-agent` rename.
- `harness/capture.py` — output paths `coding-agent-tool-calls.jsonl` / `coding-agent-token-usage.json`.
- `harness/composer.py` — rewritten for three-valued verdict + new schema.
- `harness/cli.py` — exit codes `0|1|2`; `--coding-agent` flag (was `--target`); `harness check` extension; `harness new` stamps `checks.sh`.
- `harness/scaffold.py` — `harness check` validates `checks.sh`; `harness new` stamps it; drop assertion/preflight scaffolding.
- `harness/target_config.py` → `harness/coding_agent_config.py` (renamed; `TargetConfig` → `CodingAgentConfig`, etc.).
- `harness/targets/` → `harness/coding-agents/`; `harness/target_contexts/` → `harness/coding-agent-contexts/`.
- `README.md` and `CLAUDE.md` — new harness section + canonical actor table verbatim.

**Deleted (at the end, phase 4):**
- `harness/assertions.py`.
- `harness/scenario_config.py` (replaced by the magic comment).
- The preflight half of `harness/setup_step.py` (the `pre` checks supplant it).
- Per-scenario `assertions/`, `preflight.sh`, `scenario.yaml` — deleted scenario by scenario during phase 3.

**Untouched:** the top-level `bin/` (frozen for Drill); `setup.sh` per scenario; `story.md` per scenario; Gauntlet itself.

---

# Phase 1 — Vocabulary + check runner

The new check infrastructure, built and tested in isolation before any runner
wiring. End state: `harness/bin/` has the full vocabulary and a working
`_record` helper; `harness/checks.py` can source a `checks.sh`, run `pre()`/
`post()`, and return structured records; `harness check` validates a
`checks.sh`. Nothing in `runner.py` calls it yet.

---

### Task 1.1: The `_record` helper

**Files:**
- Create: `harness/bin/_record`
- Create: `tests/harness/test_record_helper.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/harness/test_record_helper.py
import json
import subprocess
from pathlib import Path

HELPER = Path("harness/bin/_record").resolve()

def _run(snippet: str, sink: Path) -> subprocess.CompletedProcess:
    """Run a bash snippet with the helper sourced and HARNESS_RECORD_SINK set."""
    script = f"set -u; export HARNESS_RECORD_SINK={sink}; source {HELPER}\n{snippet}"
    return subprocess.run(["bash", "-c", script], capture_output=True, text=True)

def _records(sink: Path) -> list[dict]:
    return [json.loads(line) for line in sink.read_text().splitlines() if line.strip()]

def test_record_pass_emits_one_record(tmp_path: Path):
    sink = tmp_path / "sink.jsonl"
    snippet = """
        # Simulate a tool that captures its own args
        _RECORD_CHECK=file-exists
        _RECORD_ARGS=("docs/specs/*.md")
        record_pass
    """
    proc = _run(snippet, sink)
    assert proc.returncode == 0, proc.stderr
    rs = _records(sink)
    assert len(rs) == 1
    assert rs[0] == {
        "check": "file-exists",
        "args": ["docs/specs/*.md"],
        "negated": False,
        "passed": True,
        "detail": None,
    }

def test_record_fail_carries_detail(tmp_path: Path):
    sink = tmp_path / "sink.jsonl"
    snippet = """
        _RECORD_CHECK=file-exists
        _RECORD_ARGS=("missing.md")
        record_fail "no path matched"
    """
    _run(snippet, sink)
    rs = _records(sink)
    assert rs[0]["passed"] is False
    assert rs[0]["detail"] == "no path matched"

def test_record_negated_inverts_and_marks(tmp_path: Path):
    sink = tmp_path / "sink.jsonl"
    snippet = """
        _RECORD_CHECK=not
        _RECORD_ARGS=()
        # Inner: file-contains, with args ["index.html", "checkbox"], passed=true → negated=false
        record_negated file-contains '["index.html","checkbox"]' false ""
    """
    _run(snippet, sink)
    r = _records(sink)[0]
    assert r["check"] == "file-contains"
    assert r["args"] == ["index.html", "checkbox"]
    assert r["negated"] is True
    assert r["passed"] is False

def test_err_trap_emits_record_on_crash(tmp_path: Path):
    sink = tmp_path / "sink.jsonl"
    # A tool body that crashes (set -E lets the trap inherit)
    snippet = """
        _RECORD_CHECK=file-exists
        _RECORD_ARGS=("X")
        false   # triggers ERR
    """
    proc = _run(snippet, sink)
    assert proc.returncode != 0
    rs = _records(sink)
    assert len(rs) == 1
    assert rs[0]["passed"] is False
    assert "tool error" in rs[0]["detail"]

def test_err_trap_fires_inside_installed_tool(tmp_path: Path):
    """A real tool that crashes mid-body (not just a snippet) must still emit one record."""
    sink = tmp_path / "sink.jsonl"
    fake_tool = tmp_path / "boom-tool"
    fake_tool.write_text(
        '#!/usr/bin/env bash\n'
        f'_RECORD_CHECK=boom-tool\n_RECORD_ARGS=("$@")\nsource {HELPER}\n'
        'jq -e "this is not valid jq" /dev/null  # crashes\n'
        'record_pass\n'
    )
    fake_tool.chmod(0o755)
    proc = subprocess.run([str(fake_tool)], env={**__import__("os").environ, "HARNESS_RECORD_SINK": str(sink)},
                          capture_output=True, text=True)
    assert proc.returncode != 0
    rs = _records(sink)
    assert len(rs) == 1 and rs[0]["passed"] is False and "tool error" in (rs[0]["detail"] or "")

def test_no_sink_no_emission(tmp_path: Path):
    snippet = """
        unset HARNESS_RECORD_SINK
        source HARNESS_BIN/_record
        _RECORD_CHECK=file-exists; _RECORD_ARGS=("X")
        record_pass
    """.replace("HARNESS_BIN/_record", str(HELPER))
    proc = subprocess.run(["bash", "-c", snippet], capture_output=True, text=True)
    assert proc.returncode == 0  # no error
    # Nothing to check — by definition no sink to inspect
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run pytest tests/harness/test_record_helper.py -v`
Expected: all FAIL with "No such file or directory" for `_record`.

- [ ] **Step 3: Implement `_record`**

```bash
# harness/bin/_record
# Shared helper sourced by every harness/bin/ check tool.
#
# Caller contract (set in the tool at the top, before any logic):
#   _RECORD_CHECK=<tool-name>      # usually basename "$0"
#   _RECORD_ARGS=("$@")            # the tool's positional args
#
# Then exactly one of:
#   record_pass [detail]
#   record_fail [detail]
#   record_negated <inner-check> <inner-args-json> <passed-bool> [detail]
#
# If $HARNESS_RECORD_SINK is unset, all record_* calls are no-ops (this keeps
# the tools backward-safe for any caller — e.g. Drill — that doesn't set it).
#
# An ERR trap emits a fail record before propagating, so a crashing tool never
# silently drops out of the verdict.

set -E  # inherit ERR trap into functions and command substitutions

_record_emit() {
    # $1 passed (true|false)
    # $2 detail (may be empty string)
    # $3 check-name override (optional; default $_RECORD_CHECK)
    # $4 args-json override (optional; default JSON-encode $_RECORD_ARGS)
    # $5 negated (true|false, default false)
    local passed="$1" detail="$2"
    local check="${3:-${_RECORD_CHECK:-unknown}}"
    local args_json="${4:-}"
    local negated="${5:-false}"
    [ -z "${HARNESS_RECORD_SINK:-}" ] && return 0
    if [ -z "$args_json" ]; then
        if [ "${#_RECORD_ARGS[@]:-0}" -eq 0 ]; then
            args_json='[]'
        else
            args_json=$(printf '%s\n' "${_RECORD_ARGS[@]}" | jq -R . | jq -s -c .)
        fi
    fi
    local detail_json
    if [ -z "$detail" ]; then
        detail_json='null'
    else
        detail_json=$(printf '%s' "$detail" | jq -Rs -c .)
    fi
    jq -nc \
        --arg check "$check" \
        --argjson args "$args_json" \
        --argjson negated "$negated" \
        --argjson passed "$passed" \
        --argjson detail "$detail_json" \
        '{check:$check, args:$args, negated:$negated, passed:$passed, detail:$detail}' \
        >> "$HARNESS_RECORD_SINK"
}

record_pass()    { _record_emit true  "${1:-}"; }
record_fail()    { _record_emit false "${1:-}"; }
record_negated() { _record_emit "$3"  "${4:-}" "$1" "$2" true; }

_record_err_trap() {
    local ec=$?
    _record_emit false "tool error (exit $ec)" >/dev/null 2>&1 || true
    exit "$ec"
}
trap _record_err_trap ERR
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run pytest tests/harness/test_record_helper.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add harness/bin/_record tests/harness/test_record_helper.py
git commit -m "harness: add shared _record helper for check tools"
```

---

### Task 1.2: Artifact-surface tools (`file-exists`, `file-contains`, `command-succeeds`)

**Files:**
- Create: `harness/bin/file-exists`, `harness/bin/file-contains`, `harness/bin/command-succeeds`
- Create: `tests/harness/test_artifact_tools.py`

- [ ] **Step 1: Write failing tests**

```python
# tests/harness/test_artifact_tools.py
import json
import subprocess
from pathlib import Path

BIN = Path("harness/bin").resolve()

def _run(tool: str, *args: str, cwd: Path, sink: Path) -> int:
    proc = subprocess.run(
        [str(BIN / tool), *args],
        cwd=cwd, env={"PATH": f"{BIN}:/usr/bin:/bin", "HARNESS_RECORD_SINK": str(sink)},
        capture_output=True, text=True,
    )
    return proc.returncode

def _last_record(sink: Path) -> dict:
    return json.loads(sink.read_text().splitlines()[-1])

def test_file_exists_pass(tmp_path: Path):
    (tmp_path / "a.md").write_text("hi")
    sink = tmp_path / "sink"
    assert _run("file-exists", "*.md", cwd=tmp_path, sink=sink) == 0
    assert _last_record(sink)["passed"] is True

def test_file_exists_fail(tmp_path: Path):
    sink = tmp_path / "sink"
    assert _run("file-exists", "*.nope", cwd=tmp_path, sink=sink) != 0
    r = _last_record(sink)
    assert r["passed"] is False
    assert "no path matched" in r["detail"]

def test_file_contains_pass(tmp_path: Path):
    (tmp_path / "f.txt").write_text("hello world")
    sink = tmp_path / "sink"
    assert _run("file-contains", "f.txt", "world", cwd=tmp_path, sink=sink) == 0
    assert _last_record(sink)["passed"] is True

def test_command_succeeds_runs_in_cwd(tmp_path: Path):
    (tmp_path / "marker").write_text("x")
    sink = tmp_path / "sink"
    assert _run("command-succeeds", "test -f marker", cwd=tmp_path, sink=sink) == 0
    assert _last_record(sink)["passed"] is True
```

- [ ] **Step 2: Run them — expect failures (tools don't exist)**

Run: `uv run pytest tests/harness/test_artifact_tools.py -v`

- [ ] **Step 3: Implement the three tools**

```bash
# harness/bin/file-exists
_RECORD_CHECK=file-exists
_RECORD_ARGS=("$@")
source "$(dirname "$0")/_record"
# Pass iff at least one path matches the glob (handles globs without shopt extglob).
shopt -s nullglob
matches=( $1 )
shopt -u nullglob
if [ "${#matches[@]}" -gt 0 ]; then
    record_pass
else
    record_fail "no path matched: $1"
    exit 1
fi
```

```bash
# harness/bin/file-contains
_RECORD_CHECK=file-contains
_RECORD_ARGS=("$@")
source "$(dirname "$0")/_record"
path="$1"; pattern="$2"
if [ ! -f "$path" ]; then
    record_fail "file not found: $path"; exit 1
fi
if grep -qE -- "$pattern" "$path"; then
    record_pass
else
    record_fail "pattern not found in $path"; exit 1
fi
```

```bash
# harness/bin/command-succeeds
_RECORD_CHECK=command-succeeds
_RECORD_ARGS=("$@")
source "$(dirname "$0")/_record"
# Run the command via bash -c so the caller can pass a quoted compound command.
if bash -c "$1" >/tmp/cs.$$.out 2>&1; then
    record_pass
    rm -f /tmp/cs.$$.out
else
    detail=$(head -c 500 /tmp/cs.$$.out)
    record_fail "exit non-zero: $detail"
    rm -f /tmp/cs.$$.out
    exit 1
fi
```

- [ ] **Step 4: Run the tests — expect passes**

Run: `uv run pytest tests/harness/test_artifact_tools.py -v`

- [ ] **Step 5: Commit**

```bash
git add harness/bin/{file-exists,file-contains,command-succeeds} tests/harness/test_artifact_tools.py
git commit -m "harness: add artifact-surface check tools (file-exists, file-contains, command-succeeds)"
```

---

### Task 1.3: Git-surface tools (`git-repo`, `git-branch`, `git-clean`, `git-count`)

**Files:**
- Create: `harness/bin/git-repo`, `harness/bin/git-branch`, `harness/bin/git-clean`, `harness/bin/git-count`
- Create: `tests/harness/test_git_tools.py`

- [ ] **Step 1: Write failing tests**

```python
# tests/harness/test_git_tools.py
import json, subprocess
from pathlib import Path

BIN = Path("harness/bin").resolve()

def _repo(tmp_path: Path) -> Path:
    p = tmp_path / "r"; p.mkdir()
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=p, check=True)
    subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t",
                    "commit", "--allow-empty", "-q", "-m", "i"], cwd=p, check=True)
    return p

def _run(tool: str, *args: str, cwd: Path, sink: Path) -> int:
    return subprocess.run([str(BIN/tool), *args], cwd=cwd,
        env={"PATH": f"{BIN}:/usr/bin:/bin", "HARNESS_RECORD_SINK": str(sink)},
        capture_output=True, text=True).returncode

def _r(sink): return json.loads(sink.read_text().splitlines()[-1])

def test_git_repo_pass(tmp_path):
    r = _repo(tmp_path); sink = tmp_path/"s"
    assert _run("git-repo", cwd=r, sink=sink) == 0 and _r(sink)["passed"]

def test_git_repo_fail_outside_repo(tmp_path):
    sink = tmp_path/"s"
    assert _run("git-repo", cwd=tmp_path, sink=sink) != 0 and not _r(sink)["passed"]

def test_git_branch_match(tmp_path):
    r = _repo(tmp_path); sink = tmp_path/"s"
    assert _run("git-branch", "main", cwd=r, sink=sink) == 0 and _r(sink)["passed"]

def test_git_branch_mismatch(tmp_path):
    r = _repo(tmp_path); sink = tmp_path/"s"
    assert _run("git-branch", "feature", cwd=r, sink=sink) != 0 and not _r(sink)["passed"]

def test_git_clean(tmp_path):
    r = _repo(tmp_path); sink = tmp_path/"s"
    assert _run("git-clean", cwd=r, sink=sink) == 0

def test_git_count_commits(tmp_path):
    r = _repo(tmp_path); sink = tmp_path/"s"
    assert _run("git-count", "commits", "eq", "1", cwd=r, sink=sink) == 0

def test_git_count_worktrees(tmp_path):
    r = _repo(tmp_path); sink = tmp_path/"s"
    assert _run("git-count", "worktrees", "eq", "1", cwd=r, sink=sink) == 0
```

- [ ] **Step 2: Run them — expect failures**

Run: `uv run pytest tests/harness/test_git_tools.py -v`

- [ ] **Step 3: Implement the four tools**

```bash
# harness/bin/git-repo
_RECORD_CHECK=git-repo; _RECORD_ARGS=()
source "$(dirname "$0")/_record"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    record_pass
else
    record_fail "not a git work tree"; exit 1
fi
```

```bash
# harness/bin/git-branch
_RECORD_CHECK=git-branch; _RECORD_ARGS=("$@")
source "$(dirname "$0")/_record"
expected="$1"
current=$(git branch --show-current 2>/dev/null || true)
if [ "$expected" = "detached" ]; then
    if [ -z "$current" ]; then record_pass; else record_fail "branch is $current, expected detached"; exit 1; fi
elif [ "$current" = "$expected" ]; then
    record_pass
else
    record_fail "branch is '$current', expected '$expected'"; exit 1
fi
```

```bash
# harness/bin/git-clean
_RECORD_CHECK=git-clean; _RECORD_ARGS=()
source "$(dirname "$0")/_record"
if [ -z "$(git status --porcelain 2>/dev/null)" ]; then
    record_pass
else
    record_fail "working tree dirty"; exit 1
fi
```

```bash
# harness/bin/git-count
_RECORD_CHECK=git-count; _RECORD_ARGS=("$@")
source "$(dirname "$0")/_record"
dim="$1"; op="$2"; n="$3"
case "$dim" in
    worktrees) count=$(git worktree list | wc -l | tr -d ' ') ;;
    commits)   count=$(git rev-list --count HEAD 2>/dev/null || echo 0) ;;
    *) record_fail "unknown dimension: $dim"; exit 1 ;;
esac
case "$op" in
    eq)  [ "$count" -eq "$n" ] ;;
    ne)  [ "$count" -ne "$n" ] ;;
    gt)  [ "$count" -gt "$n" ] ;;
    gte) [ "$count" -ge "$n" ] ;;
    lt)  [ "$count" -lt "$n" ] ;;
    lte) [ "$count" -le "$n" ] ;;
    *)   record_fail "unknown op: $op"; exit 1 ;;
esac && { record_pass; } || { record_fail "$dim count $count not $op $n"; exit 1; }
```

- [ ] **Step 4: Run tests — expect passes**

Run: `uv run pytest tests/harness/test_git_tools.py -v`

- [ ] **Step 5: Commit**

```bash
git add harness/bin/git-{repo,branch,clean,count} tests/harness/test_git_tools.py
git commit -m "harness: add git-surface check tools"
```

---

### Task 1.4: Trace-surface tools — copy, source `_record`, **rewire file discovery**

The trace tools today hardcode `FILE="tool_calls.jsonl"` and rely on the runner
invoking them with `cwd = run_dir`. Under the new model, cwd is the
**workdir** (the parent of which is the run dir) and the file is renamed to
`coding-agent-tool-calls.jsonl`. The tools must read the path from an env var
the runner sets — `HARNESS_TOOL_CALLS_PATH` — with a same-dir fallback for
tests. This task includes both the mechanical refit and that rewire.

`codex-native-hook-configured` is also copied here (used by
`codex-native-hooks-bootstrap`); it is rewired to read from `$CODEX_HOME`
(already exported by the runner) rather than the literal `agent-config/`.

**Files:**
- Copy + modify: `bin/{tool-called,tool-not-called,tool-count,tool-before,tool-arg-match,tool-match-before-tool-match,skill-called,skill-not-called,skill-before-tool,skill-before-tool-match,codex-native-hook-configured}` → `harness/bin/<same>`
- Create: `tests/harness/test_trace_tools.py`

- [ ] **Step 1: Copy the tools**

```bash
for t in tool-called tool-not-called tool-count tool-before tool-arg-match \
         tool-match-before-tool-match skill-called skill-not-called \
         skill-before-tool skill-before-tool-match \
         codex-native-hook-configured; do
    cp "bin/$t" "harness/bin/$t"
done
```

- [ ] **Step 2: Refit each tool to source `_record`**

At the top of each tool, after the shebang/comment header, **add**:
```bash
_RECORD_CHECK=<tool-name>
_RECORD_ARGS=("$@")
source "$(dirname "$0")/_record"
```

If the tool has `set -euo pipefail` (some do), **remove the `-e`** — `_record`'s
ERR trap handles crashes; `set -e` would short-circuit the trap on a normal
`record_fail; exit 1` flow. Keep `-uo pipefail`.

Then **replace** each existing pass/fail outcome — `echo "PASS: ..."; exit 0`
and `echo "FAIL: ..."; exit 1` — with `record_pass [detail]` and
`record_fail [detail]; exit 1`.

- [ ] **Step 3: Rewire trace tools to read `$HARNESS_TOOL_CALLS_PATH`**

In each of the 10 trace tools (`tool-*` and `skill-*`), find the `FILE=` line
(or the bare reference to `tool_calls.jsonl`) and change it to:

```bash
FILE="${HARNESS_TOOL_CALLS_PATH:-coding-agent-tool-calls.jsonl}"
```

The fallback is workdir-relative so the tool still works in tests that stage a
fake trace in cwd. The runner (Task 1.6) sets `HARNESS_TOOL_CALLS_PATH` to the
absolute path of `<run-dir>/coding-agent-tool-calls.jsonl`.

- [ ] **Step 4: Rewire `codex-native-hook-configured`**

In `harness/bin/codex-native-hook-configured`, replace any literal
`agent-config/` path with `${CODEX_HOME:-coding-agent-config}` (the runner
exports `CODEX_HOME` to the agent-config dir; the fallback is cwd-relative for
tests). Replace any `HARNESS_WORKDIR` or `DRILL_CODEX_HOME` reference with the
same `CODEX_HOME` (the per-run codex home is the authoritative location of the
plugin install and trust state).

- [ ] **Step 5: Write smoke tests using the new env var**

```python
# tests/harness/test_trace_tools.py
import json, subprocess
from pathlib import Path
BIN = Path("harness/bin").resolve()

def _trace(tmp_path: Path, *records: dict) -> Path:
    p = tmp_path / "coding-agent-tool-calls.jsonl"
    p.write_text("\n".join(json.dumps(r) for r in records) + "\n")
    return p

def _run(tool: str, *args: str, trace: Path, cwd: Path, sink: Path) -> int:
    return subprocess.run([str(BIN/tool), *args], cwd=cwd,
        env={"PATH": f"{BIN}:/usr/bin:/bin",
             "HARNESS_RECORD_SINK": str(sink),
             "HARNESS_TOOL_CALLS_PATH": str(trace)},
        capture_output=True, text=True).returncode

def _r(sink): return json.loads(sink.read_text().splitlines()[-1])

def test_tool_called_reads_env_var(tmp_path):
    """Trace lives outside cwd; tool finds it via HARNESS_TOOL_CALLS_PATH."""
    parent = tmp_path / "rundir"; parent.mkdir()
    workdir = parent / "coding-agent-workdir"; workdir.mkdir()
    trace = _trace(parent, {"tool": "Edit", "args": {}})
    sink = tmp_path / "s"
    assert _run("tool-called", "Edit", trace=trace, cwd=workdir, sink=sink) == 0
    assert _r(sink)["passed"]

def test_tool_called_fail(tmp_path):
    parent = tmp_path / "rundir"; parent.mkdir()
    workdir = parent / "coding-agent-workdir"; workdir.mkdir()
    trace = _trace(parent, {"tool": "Read", "args": {}})
    sink = tmp_path/"s"
    assert _run("tool-called", "Edit", trace=trace, cwd=workdir, sink=sink) != 0

def test_skill_called(tmp_path):
    parent = tmp_path / "rundir"; parent.mkdir()
    workdir = parent / "coding-agent-workdir"; workdir.mkdir()
    trace = _trace(parent, {"tool": "Skill", "args": {"skill": "superpowers:foo"}})
    sink = tmp_path/"s"
    assert _run("skill-called", "superpowers:foo", trace=trace, cwd=workdir, sink=sink) == 0
```

(One smoke test per tool family — full coverage of the underlying logic is
preserved via the copy from `bin/`.)

- [ ] **Step 6: Run — expect passes**

Run: `uv run pytest tests/harness/test_trace_tools.py -v`

- [ ] **Step 7: Commit**

```bash
git add harness/bin/{tool-*,skill-*,codex-native-hook-configured} tests/harness/test_trace_tools.py
git commit -m "harness: fork trace tools + codex-native-hook-configured; read trace path from env"
```

---

### Task 1.5: The `not` wrapper

**Files:**
- Create: `harness/bin/not`
- Create: `tests/harness/test_not.py`

- [ ] **Step 1: Write failing tests**

```python
# tests/harness/test_not.py
import json, subprocess
from pathlib import Path
BIN = Path("harness/bin").resolve()

def _run(*args: str, cwd: Path, sink: Path) -> int:
    return subprocess.run([str(BIN/"not"), *args], cwd=cwd,
        env={"PATH": f"{BIN}:/usr/bin:/bin", "HARNESS_RECORD_SINK": str(sink)},
        capture_output=True, text=True).returncode

def _r(sink): return json.loads(sink.read_text().splitlines()[-1])

def test_not_inverts_failing_to_passing(tmp_path):
    sink = tmp_path/"s"
    # file-exists fails on no match → not should pass
    assert _run("file-exists", "*.nope", cwd=tmp_path, sink=sink) == 0
    r = _r(sink)
    assert r["check"] == "file-exists" and r["negated"] is True and r["passed"] is True

def test_not_inverts_passing_to_failing(tmp_path):
    (tmp_path/"f").write_text("x")
    sink = tmp_path/"s"
    assert _run("file-exists", "f", cwd=tmp_path, sink=sink) != 0
    r = _r(sink)
    assert r["check"] == "file-exists" and r["negated"] is True and r["passed"] is False

def test_not_emits_only_one_record(tmp_path):
    """Inner tool's emission must be suppressed."""
    (tmp_path/"f").write_text("x")
    sink = tmp_path/"s"
    _run("file-exists", "f", cwd=tmp_path, sink=sink)
    lines = sink.read_text().splitlines()
    assert len(lines) == 1
```

- [ ] **Step 2: Run — expect failures**

Run: `uv run pytest tests/harness/test_not.py -v`

- [ ] **Step 3: Implement `not`**

```bash
# harness/bin/not
# Usage: not <inner-tool> [args...]
# Runs the inner tool with HARNESS_RECORD_SINK unset (suppressing its record),
# captures exit code, emits one negated record on its behalf.
_RECORD_CHECK=not
_RECORD_ARGS=("$@")
source "$(dirname "$0")/_record"

inner="$1"; shift
inner_args_json=$(printf '%s\n' "$@" | jq -R . | jq -s -c .)

# Run with sink unset
( unset HARNESS_RECORD_SINK; "$(dirname "$0")/$inner" "$@" ) >/dev/null 2>&1
inner_ec=$?

if [ "$inner_ec" -eq 0 ]; then
    inverted=false
else
    inverted=true
fi

record_negated "$inner" "$inner_args_json" "$inverted" ""

# Exit code: 0 if negation passed (inner failed), 1 otherwise.
if [ "$inverted" = "true" ]; then exit 0; else exit 1; fi
```

- [ ] **Step 4: Run — expect passes**

Run: `uv run pytest tests/harness/test_not.py -v`

- [ ] **Step 5: Commit**

```bash
git add harness/bin/not tests/harness/test_not.py
git commit -m "harness: add 'not' negation wrapper"
```

---

### Task 1.6: The check runner — `harness/checks.py`

**Files:**
- Create: `harness/checks.py`
- Create: `tests/harness/test_checks.py`

- [ ] **Step 1: Write failing tests**

```python
# tests/harness/test_checks.py
from pathlib import Path
from harness.checks import (
    parse_coding_agents_directive, run_phase, CheckRecord,
)

def test_parse_coding_agents_present(tmp_path: Path):
    p = tmp_path / "checks.sh"
    p.write_text("# coding-agents: codex, gemini\npre() { :; }\npost() { :; }\n")
    assert parse_coding_agents_directive(p) == ["codex", "gemini"]

def test_parse_coding_agents_absent(tmp_path: Path):
    p = tmp_path / "checks.sh"
    p.write_text("pre() { :; }\npost() { :; }\n")
    assert parse_coding_agents_directive(p) is None

def test_run_phase_collects_records(tmp_path: Path):
    workdir = tmp_path / "wd"; workdir.mkdir()
    (workdir / "x.md").write_text("hi")
    checks_sh = tmp_path / "checks.sh"
    checks_sh.write_text(
        "pre() { git-repo 2>/dev/null || true; }\n"
        "post() { file-exists 'x.md'; file-exists 'missing.md'; }\n"
    )
    records, exit_code = run_phase(
        checks_sh=checks_sh, phase="post", workdir=workdir,
        harness_bin=Path("harness/bin").resolve(),
    )
    assert exit_code == 0
    assert len(records) == 2
    assert records[0].check == "file-exists" and records[0].passed
    assert records[1].check == "file-exists" and not records[1].passed
    assert all(r.phase == "post" for r in records)

def test_run_phase_nonzero_exit_signals_crash(tmp_path: Path):
    workdir = tmp_path / "wd"; workdir.mkdir()
    checks_sh = tmp_path / "checks.sh"
    checks_sh.write_text("pre() { :; }\npost() { undefined_function_blam; }\n")
    records, exit_code = run_phase(
        checks_sh=checks_sh, phase="post", workdir=workdir,
        harness_bin=Path("harness/bin").resolve(),
    )
    assert exit_code != 0
```

- [ ] **Step 2: Run — expect import failures**

Run: `uv run pytest tests/harness/test_checks.py -v`
Expected: ModuleNotFoundError for `harness.checks`.

- [ ] **Step 3: Implement `harness/checks.py`**

```python
# harness/checks.py
"""Source a scenario's checks.sh, run a phase, collect the records.

A scenario's checks.sh defines two bash functions, `pre()` and `post()`. The
Harness invokes one phase at a time:

    bash -c 'source <checks.sh>; <phase>'

with cwd=<workdir>, PATH prepending harness/bin/, and HARNESS_RECORD_SINK
pointing at a fresh JSONL file. Each check tool emits one record; this module
parses the records and returns CheckRecord values. The phase is stamped here.

The script's *exit code* is the crash signal — non-zero means the script did
not run to completion. Pass/fail comes from the records.
"""
from __future__ import annotations

import json
import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

Phase = Literal["pre", "post"]


@dataclass(frozen=True)
class CheckRecord:
    check: str
    args: list
    negated: bool
    passed: bool
    detail: str | None
    phase: Phase


_DIRECTIVE_RE = re.compile(r"^\s*#\s*coding-agents:\s*(.+?)\s*$")


def parse_coding_agents_directive(checks_sh: Path) -> list[str] | None:
    """Return the list from `# coding-agents: <csv>` if present, else None.

    Scans only the first ~20 lines; the directive must be a top-of-file comment.
    """
    if not checks_sh.exists():
        return None
    for i, line in enumerate(checks_sh.read_text().splitlines()):
        if i > 20:
            break
        m = _DIRECTIVE_RE.match(line)
        if m:
            return [t.strip() for t in m.group(1).split(",") if t.strip()]
    return None


def run_phase(
    *,
    checks_sh: Path,
    phase: Phase,
    workdir: Path,
    harness_bin: Path,
    tool_calls_path: Path | None = None,
) -> tuple[list[CheckRecord], int]:
    """Source checks.sh, call <phase>, return (records, script_exit_code).

    The exit code is the crash signal: non-zero means the script did not run to
    completion (per spec §7). Callers always need both — never just the records.
    """
    with tempfile.NamedTemporaryFile("w+", delete=False, suffix=".jsonl") as f:
        sink = Path(f.name)
    env = {
        "PATH": f"{harness_bin}:/usr/bin:/bin",
        "HARNESS_RECORD_SINK": str(sink),
        "HOME": str(Path.home()),  # git config, jq cache
    }
    if tool_calls_path is not None:
        env["HARNESS_TOOL_CALLS_PATH"] = str(tool_calls_path)
    try:
        proc = subprocess.run(
            ["bash", "-c", f"source '{checks_sh}'; {phase}"],
            cwd=workdir, env=env, capture_output=True, text=True,
        )
        records = [
            CheckRecord(
                check=d["check"], args=d["args"], negated=d["negated"],
                passed=d["passed"], detail=d.get("detail"), phase=phase,
            )
            for line in sink.read_text().splitlines() if line.strip()
            for d in [json.loads(line)]
        ]
        return records, proc.returncode
    finally:
        sink.unlink(missing_ok=True)
```

- [ ] **Step 4: Run — expect passes**

Run: `uv run pytest tests/harness/test_checks.py -v`

- [ ] **Step 5: Commit**

```bash
git add harness/checks.py tests/harness/test_checks.py
git commit -m "harness: add check runner (sources checks.sh, collects records)"
```

---

### Task 1.7: Extend `harness check` to validate `checks.sh`

**Files:**
- Modify: `harness/scaffold.py` — `check_scenario` gains `checks.sh` validation; drop the `assertions/`-dir / exec-bit logic (but keep `setup.sh`'s exec-bit).
- Modify: `harness/cli.py` — `harness new` stamps a `checks.sh` skeleton; no exec bit on `checks.sh`.
- Modify: `tests/harness/test_scaffold.py` — add cases.

- [ ] **Step 1: Write failing tests**

```python
# tests/harness/test_scaffold.py (add to existing or create)
from pathlib import Path
from harness.scaffold import check_scenario

def _make_scenario(d: Path, *, with_checks: bool = True, body: str = "") -> Path:
    d.mkdir(parents=True)
    (d / "story.md").write_text("---\nid: x\ntitle: t\n---\n## Acceptance Criteria\n- a\n")
    (d / "setup.sh").write_text("#!/usr/bin/env bash\n:\n"); (d / "setup.sh").chmod(0o755)
    if with_checks:
        (d / "checks.sh").write_text(body or "pre() { :; }\npost() { :; }\n")
    return d

def test_check_scenario_valid(tmp_path):
    s = _make_scenario(tmp_path / "s")
    assert check_scenario(s) == []

def test_check_scenario_missing_checks(tmp_path):
    s = _make_scenario(tmp_path / "s", with_checks=False)
    problems = check_scenario(s)
    assert any("checks.sh" in p for p in problems)

def test_check_scenario_rejects_top_level_statements(tmp_path):
    s = _make_scenario(tmp_path / "s", body="echo hi\npre(){:;}\npost(){:;}\n")
    problems = check_scenario(s)
    assert any("functions-only" in p for p in problems)

def test_check_scenario_requires_both_functions(tmp_path):
    s = _make_scenario(tmp_path / "s", body="pre() { :; }\n")
    problems = check_scenario(s)
    assert any("post" in p for p in problems)

def test_check_scenario_accepts_coding_agents_comment(tmp_path):
    body = "# coding-agents: codex\npre() { :; }\npost() { :; }\n"
    s = _make_scenario(tmp_path / "s", body=body)
    assert check_scenario(s) == []
```

- [ ] **Step 2: Run — expect failures**

- [ ] **Step 3: Modify `harness/scaffold.py`**

Add to `check_scenario`:

```python
def _validate_checks_sh(scenario_dir: Path) -> list[str]:
    """checks.sh exists, parses with bash -n, is functions-only, defines pre/post."""
    cs = scenario_dir / "checks.sh"
    problems: list[str] = []
    if not cs.exists():
        problems.append("checks.sh missing")
        return problems
    proc = subprocess.run(["bash", "-n", str(cs)], capture_output=True, text=True)
    if proc.returncode != 0:
        problems.append(f"checks.sh syntax error: {proc.stderr.strip()}")
        return problems
    text = cs.read_text()
    # Functions-only: a non-blank, non-comment, non-function-decl, non-brace line is a top-level stmt.
    in_fn = 0
    for line in text.splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if re.match(r"^(pre|post)\s*\(\)\s*\{?\s*$", s) or s == "{":
            in_fn += 1; continue
        if s == "}":
            in_fn = max(0, in_fn - 1); continue
        if in_fn == 0:
            problems.append(f"checks.sh must be functions-only (top-level statement: {s[:60]!r})")
            break
    if not re.search(r"^pre\s*\(\)", text, re.M):
        problems.append("checks.sh missing pre() function")
    if not re.search(r"^post\s*\(\)", text, re.M):
        problems.append("checks.sh missing post() function")
    # Concurrency-unsupported lint: warn on backgrounded check invocations.
    for i, line in enumerate(text.splitlines(), 1):
        if re.search(r"&\s*(#|$)", line) and not re.match(r"^\s*#", line):
            problems.append(f"checks.sh:{i}: backgrounded check (`&`) is unsupported")
    return problems
```

And remove the old `assertions/` directory validation + `fix_executable_bits` paths for assertions (keep them for `setup.sh` only). Drop `scenario.yaml` validation entirely.

Wire `_validate_checks_sh` into `check_scenario`.

- [ ] **Step 4: Modify `harness/cli.py` — `harness new` stamps `checks.sh`**

Update `_CHECKS_TEMPLATE` (new constant) and the `new` command to write:

```python
_CHECKS_TEMPLATE = """\
# Deterministic checks for this scenario. Run by the Harness.
# pre() runs after setup.sh, before the Coding-Agent.
# post() runs after the Coding-Agent's run is captured.

pre() {
    git-repo
    git-branch main
}

post() {
    : # TODO: add checks
}
"""
```

`harness new` writes `checks.sh` to the new scenario dir; **does not chmod** it.

- [ ] **Step 5: Run — expect passes**

Run: `uv run pytest tests/harness/test_scaffold.py -v`

- [ ] **Step 6: Commit**

```bash
git add harness/scaffold.py harness/cli.py tests/harness/test_scaffold.py
git commit -m "harness: validate checks.sh in harness check; scaffold it in harness new"
```

---

# Phase 2 — Verdict + runner integration

End state: a run of any scenario goes through the new path **if** it has
`checks.sh`, otherwise the old `assertions/`+`preflight.sh` path. The new
`verdict.json` schema is written. The workdir is born in the run dir.
Actor-prefixed names are in place. `--coding-agent` is the CLI flag.

---

### Task 2.0: Extract runner helpers used throughout Phase 2

`_write_indeterminate`, `_legacy_compose`, `_allocate_run_dir`, and
`_harness_bin_dir` are referenced by several Phase-2 tasks. Build them first so
each later task can use them without forward-references.

**Files:**
- Modify: `harness/runner.py`
- Modify: `tests/harness/test_runner_helpers.py` (new)

- [ ] **Step 1: Write failing tests**

```python
# tests/harness/test_runner_helpers.py
import json
from pathlib import Path
from harness.runner import (
    _write_indeterminate, _legacy_compose, _allocate_run_dir, _harness_bin_dir,
)
from harness.composer import RunError, FinalVerdict

def test_write_indeterminate_persists_verdict(tmp_path: Path):
    v = _write_indeterminate(
        tmp_path, final_reason="setup boom",
        error=RunError(stage="setup", message="boom"),
    )
    assert v.final == "indeterminate"
    persisted = json.loads((tmp_path / "verdict.json").read_text())
    assert persisted["final"] == "indeterminate"
    assert persisted["error"]["stage"] == "setup"

def test_allocate_run_dir(tmp_path: Path):
    rd = _allocate_run_dir(out_root=tmp_path, scenario_name="x", coding_agent="claude")
    assert rd.parent == tmp_path
    assert rd.name.startswith("x-claude-") and rd.is_dir()

def test_harness_bin_dir_resolves():
    assert (_harness_bin_dir() / "_record").exists()

def test_legacy_compose_pass(tmp_path: Path):
    # Old shape: gauntlet="pass" + 1 passing assertion → FinalVerdict pass
    from harness.assertions import AssertionResult
    v = _legacy_compose(
        gauntlet_status="pass",
        assertion_results=[AssertionResult(name="01-x", exit_code=0, stdout="PASS: x", stderr="")],
        gauntlet_run_id="run-abc",
    )
    assert v.final == "pass" and len(v.checks) == 1 and v.checks[0].passed

def test_legacy_compose_assertion_fail(tmp_path: Path):
    from harness.assertions import AssertionResult
    v = _legacy_compose(
        gauntlet_status="pass",
        assertion_results=[AssertionResult(name="01-x", exit_code=1, stdout="FAIL: x", stderr="")],
        gauntlet_run_id="run-abc",
    )
    assert v.final == "fail"

def test_legacy_compose_gauntlet_investigate(tmp_path: Path):
    v = _legacy_compose(gauntlet_status="investigate", assertion_results=[], gauntlet_run_id="r")
    assert v.final == "indeterminate"
```

- [ ] **Step 2: Run — expect failures (imports fail)**

- [ ] **Step 3: Implement the helpers in `harness/runner.py`**

```python
import json, time
from pathlib import Path
from harness.composer import FinalVerdict, RunError, GauntletLayer, compose

def _harness_bin_dir() -> Path:
    return Path(__file__).resolve().parent / "bin"

def _allocate_run_dir(*, out_root: Path, scenario_name: str, coding_agent: str) -> Path:
    timestamp = time.strftime("%Y%m%dT%H%M%S")
    run_dir = out_root / f"{scenario_name}-{coding_agent}-{timestamp}"
    run_dir.mkdir(parents=True, exist_ok=False)
    return run_dir

def _write_indeterminate(
    run_dir: Path,
    *,
    final_reason: str,
    gauntlet: GauntletLayer | None = None,
    checks: list | None = None,
    error: RunError | None = None,
) -> FinalVerdict:
    v = FinalVerdict(
        final="indeterminate",
        final_reason=final_reason,
        gauntlet=gauntlet,
        checks=checks or [],
        error=error,
    )
    (run_dir / "verdict.json").write_text(json.dumps(v.to_dict(), indent=2))
    return v

def _legacy_compose(
    *,
    gauntlet_status: str,            # "pass" | "fail" | "investigate"
    assertion_results: list,         # list[AssertionResult]
    gauntlet_run_id: str | None,
) -> FinalVerdict:
    """Translate the old (gauntlet, assertions) pair into the §8 FinalVerdict.

    Each AssertionResult becomes a synthetic CheckRecord with phase="post";
    `check` is the assertion script's basename without .sh; `passed` is
    exit_code == 0; `detail` is a trimmed stdout/stderr blob.
    """
    from harness.checks import CheckRecord
    checks = [
        CheckRecord(
            check=ar.name.removesuffix(".sh").lstrip("0123456789-"),
            args=[],
            negated=False,
            passed=(ar.exit_code == 0),
            detail=((ar.stdout + ar.stderr).strip()[:500] or None),
            phase="post",
        )
        for ar in assertion_results
    ]
    gl = GauntletLayer(status=gauntlet_status, summary="", reasoning="",
                      run_id=gauntlet_run_id)
    return compose(gauntlet=gl, checks=checks, capture_empty=False, error=None)
```

- [ ] **Step 4: Run tests — expect passes**

Run: `uv run pytest tests/harness/test_runner_helpers.py -v`

- [ ] **Step 5: Commit**

```bash
git add harness/runner.py tests/harness/test_runner_helpers.py
git commit -m "harness: extract runner helpers (_write_indeterminate, _legacy_compose, _allocate_run_dir, _harness_bin_dir)"
```

---

### Task 2.1: Rewrite `harness/composer.py`

**Files:**
- Modify: `harness/composer.py`
- Modify: `tests/harness/test_composer.py`

- [ ] **Step 1: Write failing tests for the new shape**

```python
# tests/harness/test_composer.py (replace existing content)
from harness.checks import CheckRecord
from harness.composer import GauntletLayer, compose, FinalVerdict

def _gl(status="pass", summary="s", reasoning="r", run_id="abc"):
    return GauntletLayer(status=status, summary=summary, reasoning=reasoning, run_id=run_id)

def _ck(name, passed, phase="post", negated=False, detail=None):
    return CheckRecord(check=name, args=[], negated=negated, passed=passed, detail=detail, phase=phase)

def test_all_pass_yields_pass():
    v = compose(gauntlet=_gl("pass"), checks=[_ck("file-exists", True)], capture_empty=False, error=None)
    assert v.final == "pass" and "passed" in v.final_reason.lower()

def test_check_fail_yields_fail():
    v = compose(gauntlet=_gl("pass"), checks=[_ck("file-exists", False, detail="no path")],
                capture_empty=False, error=None)
    assert v.final == "fail"

def test_gauntlet_fail_yields_fail():
    v = compose(gauntlet=_gl("fail"), checks=[_ck("file-exists", True)], capture_empty=False, error=None)
    assert v.final == "fail"

def test_gauntlet_investigate_yields_indeterminate():
    v = compose(gauntlet=_gl("investigate", summary="looped"), checks=[], capture_empty=False, error=None)
    assert v.final == "indeterminate" and "investigate" in v.final_reason.lower()

def test_pre_check_failure_yields_indeterminate():
    v = compose(gauntlet=_gl("pass"), checks=[_ck("git-repo", False, phase="pre")],
                capture_empty=False, error=None)
    assert v.final == "indeterminate"

def test_capture_empty_with_trace_check_yields_indeterminate():
    v = compose(gauntlet=_gl("pass"), checks=[_ck("tool-called", True)],
                capture_empty=True, error=None)
    assert v.final == "indeterminate"

def test_capture_empty_without_trace_check_passes():
    v = compose(gauntlet=_gl("pass"), checks=[_ck("file-exists", True)],
                capture_empty=True, error=None)
    assert v.final == "pass"

def test_error_yields_indeterminate():
    from harness.composer import RunError
    v = compose(gauntlet=None, checks=[], capture_empty=False,
                error=RunError(stage="setup", message="boom"))
    assert v.final == "indeterminate"

def test_zero_checks_passes_iff_gauntlet_passed():
    assert compose(gauntlet=_gl("pass"), checks=[], capture_empty=False, error=None).final == "pass"
    assert compose(gauntlet=_gl("fail"), checks=[], capture_empty=False, error=None).final == "fail"

def test_to_dict_schema_version():
    v = compose(gauntlet=_gl("pass"), checks=[_ck("file-exists", True)], capture_empty=False, error=None)
    d = v.to_dict()
    assert d["schema"] == 1
    assert d["final"] in ("pass", "fail", "indeterminate")
    assert "final_reason" in d
    assert "checks" in d and "gauntlet" in d and "error" in d
```

- [ ] **Step 2: Run — expect failures**

- [ ] **Step 3: Implement the new composer**

```python
# harness/composer.py
"""Compose the three-valued verdict from the Gauntlet-Agent layer and the
deterministic checks layer."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Literal

from harness.checks import CheckRecord

FinalStatus = Literal["pass", "fail", "indeterminate"]
GauntletStatus = Literal["pass", "fail", "investigate", "errored"]
TRACE_PRIMITIVES = {
    "tool-called", "tool-not-called", "tool-count", "tool-before",
    "tool-arg-match", "tool-match-before-tool-match",
    "skill-called", "skill-not-called", "skill-before-tool",
    "skill-before-tool-match",
}


@dataclass(frozen=True)
class GauntletLayer:
    status: GauntletStatus
    summary: str = ""
    reasoning: str = ""
    run_id: str | None = None


@dataclass(frozen=True)
class RunError:
    stage: Literal["setup", "gauntlet", "capture", "checks", "compose", "unknown"]
    message: str


@dataclass(frozen=True)
class FinalVerdict:
    schema: int = 1
    final: FinalStatus = "indeterminate"
    final_reason: str = ""
    gauntlet: GauntletLayer | None = None
    checks: list[CheckRecord] = field(default_factory=list)
    error: RunError | None = None

    def to_dict(self) -> dict:
        d = {
            "schema": self.schema,
            "final": self.final,
            "final_reason": self.final_reason,
            "gauntlet": asdict(self.gauntlet) if self.gauntlet else None,
            "checks": [
                {
                    "check": c.check, "args": c.args, "negated": c.negated,
                    "passed": c.passed, "detail": c.detail, "phase": c.phase,
                }
                for c in self.checks
            ],
            "error": asdict(self.error) if self.error else None,
        }
        return d


def _any_trace_check(checks: list[CheckRecord]) -> bool:
    return any(c.check in TRACE_PRIMITIVES for c in checks)


def compose(
    *,
    gauntlet: GauntletLayer | None,
    checks: list[CheckRecord],
    capture_empty: bool,
    error: RunError | None,
) -> FinalVerdict:
    # Crash path
    if error is not None:
        return FinalVerdict(
            final="indeterminate",
            final_reason=f"Harness error ({error.stage}): {error.message}",
            gauntlet=gauntlet, checks=checks, error=error,
        )
    # Pre-check failure
    failed_pre = [c for c in checks if c.phase == "pre" and not c.passed]
    if failed_pre:
        names = ", ".join(c.check for c in failed_pre)
        return FinalVerdict(
            final="indeterminate",
            final_reason=f"pre-check(s) failed: {names}",
            gauntlet=gauntlet, checks=checks, error=None,
        )
    # Gauntlet investigate/errored
    if gauntlet is None:
        return FinalVerdict(
            final="indeterminate",
            final_reason="no Gauntlet-Agent verdict",
            gauntlet=None, checks=checks, error=None,
        )
    if gauntlet.status in ("investigate", "errored"):
        return FinalVerdict(
            final="indeterminate",
            final_reason=f"Gauntlet-Agent did not complete (status: {gauntlet.status})",
            gauntlet=gauntlet, checks=checks, error=None,
        )
    # Empty trace with trace checks
    if capture_empty and _any_trace_check(checks):
        return FinalVerdict(
            final="indeterminate",
            final_reason="tool-call capture was empty; trace checks meaningless",
            gauntlet=gauntlet, checks=checks, error=None,
        )
    # Post-check evaluation
    failed_post = [c for c in checks if c.phase == "post" and not c.passed]
    if gauntlet.status == "pass" and not failed_post:
        n = sum(1 for c in checks if c.phase == "post")
        reason = f"Gauntlet-Agent passed; {n} check(s) passed" if n else "Gauntlet-Agent passed; no deterministic checks"
        return FinalVerdict(
            final="pass", final_reason=reason,
            gauntlet=gauntlet, checks=checks, error=None,
        )
    reason_bits: list[str] = []
    if gauntlet.status != "pass":
        reason_bits.append(f"Gauntlet-Agent reported {gauntlet.status}")
    if failed_post:
        reason_bits.append(f"{len(failed_post)} post-check(s) failed")
    return FinalVerdict(
        final="fail", final_reason="; ".join(reason_bits) or "fail",
        gauntlet=gauntlet, checks=checks, error=None,
    )
```

- [ ] **Step 4: Run — expect passes**

Run: `uv run pytest tests/harness/test_composer.py -v`

- [ ] **Step 5: Commit**

```bash
git add harness/composer.py tests/harness/test_composer.py
git commit -m "harness: rewrite composer for three-valued verdict + new schema"
```

---

### Task 2.2: Workdir lives in the run dir

**Files:**
- Modify: `harness/runner.py` — `_seed_agent_config_dir` keeps its current home; `workdir = run_dir / "coding-agent-workdir"`; delete `tempfile`, `workdir-path.txt`, keep/wipe branching.

- [ ] **Step 1: Modify `runner.py:run_scenario`**

Replace the current `workdir = Path(tempfile.mkdtemp(prefix="harness-wd-"))` block and the `finally: shutil.rmtree(...)` cleanup with:

```python
# Workdir lives in the run dir; never garbage-collected.
workdir = run_dir / "coding-agent-workdir"
workdir.mkdir()
```

Delete:
- the `tempfile.mkdtemp` line
- the `workdir_kept` / `workdir-path.txt` block
- the `finally: if not workdir_kept: shutil.rmtree(workdir, ...)` block

Also update `AGENT_CONFIG_SUBDIR = "agent-config"` to `CODING_AGENT_CONFIG_SUBDIR = "coding-agent-config"` and the `agent_config_dir = run_dir / AGENT_CONFIG_SUBDIR` line.

- [ ] **Step 2: Run the existing harness tests — expect some to fail / be updated**

Run: `uv run pytest tests/harness -v`
Update assertions about path layout. Existing scenario tests should still pass for now.

- [ ] **Step 3: Add a test that the workdir lands in the run dir**

```python
# tests/harness/test_runner_layout.py
# (Adapt from existing runner tests — assert workdir == run_dir/"coding-agent-workdir")
```

- [ ] **Step 4: Commit**

```bash
git add harness/runner.py tests/harness/
git commit -m "harness: workdir lives in run dir (coding-agent-workdir/), no /tmp"
```

---

### Task 2.2.5: Update `setup_helpers/worktree.py` for the new workdir parent

Worktree scenarios create siblings via `workdir.parent / f"{workdir.name}-…"`.
With workdir now `<run>/coding-agent-workdir/`, the parent is `<run>/` and the
siblings naturally land at `<run>/coding-agent-workdir-existing-worktree/` and
`<run>/coding-agent-workdir-codex-home/` — the spec §5 exception. The helper's
*math* is correct; what changes is that the siblings are now inside the run
dir (not `/tmp`), so the gitignore picks them up automatically. Verify and add
a regression test.

**Files:**
- Modify: `setup_helpers/worktree.py` (only if any path is hardcoded to `/tmp` — verify first)
- Create: `tests/setup_helpers/test_worktree_sibling_paths.py`

- [ ] **Step 1: Inspect `setup_helpers/worktree.py`**

Read the file, confirm sibling-dir construction is `workdir.parent /
f"{workdir.name}-existing-worktree"` (or similar) — i.e., relative to
`workdir.parent`, not a hardcoded `/tmp`. If it hardcodes anything, fix it.

- [ ] **Step 2: Add a regression test**

```python
# tests/setup_helpers/test_worktree_sibling_paths.py
from pathlib import Path
from setup_helpers.worktree import _sibling_path  # extract this if it's inline

def test_sibling_lands_under_workdir_parent(tmp_path: Path):
    wd = tmp_path / "rundir" / "coding-agent-workdir"; wd.mkdir(parents=True)
    sib = _sibling_path(wd, "existing-worktree")
    assert sib.parent == wd.parent
    assert sib.name == "coding-agent-workdir-existing-worktree"
```

(If `_sibling_path` isn't extracted, extract it as a 3-line helper to make this
testable; that itself is a small commit.)

- [ ] **Step 3: Run tests; commit**

```bash
uv run pytest tests/setup_helpers/test_worktree_sibling_paths.py -v
git add setup_helpers/worktree.py tests/setup_helpers/test_worktree_sibling_paths.py
git commit -m "setup_helpers: regression-test worktree sibling paths under new layout"
```

---

### Task 2.3: Actor-prefixed names — capture outputs

**Files:**
- Modify: `harness/capture.py` — writes `coding-agent-tool-calls.jsonl` and `coding-agent-token-usage.json`.
- Modify: `harness/runner.py` — call sites pass the new filenames.
- Modify: any tests referencing the old names.

- [ ] **Step 1: Modify `capture.py`**

Change:
- `out_path = run_dir / "tool_calls.jsonl"` → `out_path = run_dir / "coding-agent-tool-calls.jsonl"`
- `out_path = run_dir / "token_usage.json"` → `out_path = run_dir / "coding-agent-token-usage.json"`

- [ ] **Step 2: Update any test referencing the old names**

Grep: `grep -rn 'tool_calls.jsonl\|token_usage.json' tests/`
Update each hit.

- [ ] **Step 3: Run tests**

Run: `uv run pytest tests/harness -v`

- [ ] **Step 4: Commit**

```bash
git add harness/capture.py tests/
git commit -m "harness: actor-prefix coding-agent-tool-calls.jsonl and coding-agent-token-usage.json"
```

---

### Task 2.4: Un-hide Gauntlet's output via `--state-dir gauntlet-agent`

**Files:**
- Modify: `harness/runner.py` — `invoke_gauntlet` passes `--state-dir gauntlet-agent`; `_populate_context_dir` writes to `gauntlet-agent/context/`; `_gauntlet_status_from_run_dir` reads from `gauntlet-agent/results/`.

- [ ] **Step 1: Update `invoke_gauntlet`**

Add to the gauntlet `cmd` list, before `--silent`:
```python
cmd += ["--state-dir", "gauntlet-agent"]
```

- [ ] **Step 2: Update `_populate_context_dir`**

Change `dst = run_dir / ".gauntlet" / "context"` to `dst = run_dir / "gauntlet-agent" / "context"`.

- [ ] **Step 3: Update `_gauntlet_status_from_run_dir`**

Change `results_root = run_dir / ".gauntlet" / "results"` to `results_root = run_dir / "gauntlet-agent" / "results"`.

- [ ] **Step 4: Add a smoke test (or update existing) that gauntlet output lands in `gauntlet-agent/`**

(Most existing tests mock the gauntlet subprocess; update layout expectations.)

- [ ] **Step 5: Commit**

```bash
git add harness/runner.py tests/
git commit -m "harness: un-hide Gauntlet output as <run>/gauntlet-agent/ via --state-dir"
```

---

### Task 2.5: The `target` → `coding-agent` rename

**Files:**
- Rename dir: `harness/targets/` → `harness/coding-agents/`
- Rename dir: `harness/target_contexts/` → `harness/coding-agent-contexts/`
- Rename file: `harness/target_config.py` → `harness/coding_agent_config.py`
- Modify: `harness/cli.py` — `--target` → `--coding-agent` (the harness flag only); `_DEFAULT_TARGETS_DIR` → `_DEFAULT_CODING_AGENTS_DIR`; `_DEFAULT_CONTEXTS_DIR` constant for the renamed dir.
- Modify: `harness/runner.py` — `TargetConfig`→`CodingAgentConfig`; `load_target_config`→`load_coding_agent_config`; parameter names; **keep `gauntlet run --target <binary>`** verbatim (that is Gauntlet's flag).
- Modify: tests, normalizers references.

- [ ] **Step 1: Rename directories and the module file**

```bash
git mv harness/targets harness/coding-agents
git mv harness/target_contexts harness/coding-agent-contexts
git mv harness/target_config.py harness/coding_agent_config.py
```

- [ ] **Step 2: Within `coding_agent_config.py`, rename `TargetConfig`→`CodingAgentConfig`, `load_target_config`→`load_coding_agent_config`, `TargetConfigError`→`CodingAgentConfigError`. Update docstring.**

- [ ] **Step 3: Update `harness/cli.py`**

- `--target` → `--coding-agent` (the click option name); update help text.
- `_DEFAULT_TARGETS_DIR` → `_DEFAULT_CODING_AGENTS_DIR = Path("harness/coding-agents")`.
- `_DEFAULT_CONTEXTS_DIR = Path("harness/coding-agent-contexts")`.
- Rename `targets_dir` / `contexts_dir` params to `coding_agents_dir` / `contexts_dir` (or `coding_agent_contexts_dir` for clarity).

- [ ] **Step 4: Update `harness/runner.py`**

- Import: `from harness.coding_agent_config import CodingAgentConfig, load_coding_agent_config`.
- All references to `target` (the Coding-Agent sense) → `coding_agent` / `CodingAgent`.
- `tcfg.binary` references stay (it's the binary name).
- `invoke_gauntlet`: the `cmd` list keeps `"--target", tcfg.binary` — **Gauntlet's own flag, untouched**. Comment this site to prevent future confusion.
- Run-dir-name f-string: `f"{scenario_dir.name}-{coding_agent}-{timestamp}"`.

- [ ] **Step 5: Update tests + normalizer references**

Grep: `grep -rn '\-\-target\|targets_dir\|TargetConfig\|load_target_config' tests/ harness/`
Update each (but NOT the `gauntlet run --target` invocation site).

- [ ] **Step 6: Add a regression test for the Gauntlet `--target` carve-out**

```python
# tests/harness/test_gauntlet_target_carveout.py
from pathlib import Path

def test_runner_keeps_gauntlets_own_target_flag():
    """A future bulk s/target/coding-agent/ on runner.py must NOT touch the
    `gauntlet run --target <binary>` invocation — that's Gauntlet's own flag."""
    src = Path("harness/runner.py").read_text()
    # The invocation site is preserved verbatim and is annotated as Gauntlet's flag.
    assert '"--target", tcfg.binary' in src or "'--target', tcfg.binary" in src
    # And an adjacent comment makes the intent explicit:
    assert "Gauntlet's own" in src or "Gauntlet flag" in src
```

- [ ] **Step 7: Run all tests**

Run: `uv run pytest -x -q`
Fix until green.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "harness: rename target → coding-agent (flag, dirs, code; Gauntlet's own --target untouched)"
```

---

### Task 2.6: Magic-comment Coding-Agent gating + capture-non-empty built-in

**Files:**
- Modify: `harness/runner.py` — read `# coding-agents:` from `checks.sh` before setup; capture-non-empty built-in.

- [ ] **Step 1: Write tests**

```python
# tests/harness/test_runner_gating.py
from pathlib import Path
# Test that an incompatible coding-agent yields final: indeterminate with
# final_reason mentioning the requirement, and that setup.sh was NOT invoked.
```

(Exercise via running `run_scenario` against a temp scenario with `# coding-agents: codex` and `--coding-agent claude`.)

- [ ] **Step 2: Implement in `runner.py`**

```python
from harness.checks import parse_coding_agents_directive

def run_scenario(...):
    ...
    # 0. Coding-Agent gating — read before any side effect.
    checks_sh = scenario_dir / "checks.sh"
    allowed = parse_coding_agents_directive(checks_sh) if checks_sh.exists() else None
    if allowed and coding_agent not in allowed:
        return _write_indeterminate(
            run_dir,
            final_reason=f"requires coding-agents: {', '.join(allowed)}",
        )
    ...
```

`_write_indeterminate` is a helper that constructs a `FinalVerdict` with
`final=indeterminate`, writes `verdict.json`, returns it.

- [ ] **Step 3: Run tests; commit**

(Note: the capture-non-empty built-in is implemented as part of Task 2.7 where
`post()` is wired into the runner. Splitting concerns: this task only adds
gating; Task 2.7 finishes the runner loop including the built-in check.)

```bash
git add harness/runner.py tests/harness/test_runner_gating.py
git commit -m "harness: coding-agent gating via magic comment"
```

---

### Task 2.7: Wire `checks.py` into the runner — with old/new dispatch

**Files:**
- Modify: `harness/runner.py` — at the appropriate steps, run `pre()` and `post()` if `checks.sh` exists; otherwise fall through to the old `assertions/` + `preflight.sh` path.

- [ ] **Step 1: Dispatch logic**

```python
checks_sh = scenario_dir / "checks.sh"
new_path = checks_sh.exists()
```

`run_setup` still runs as today. Then:

```python
if new_path:
    pre_records, pre_exit = run_phase(
        checks_sh=checks_sh, phase="pre",
        workdir=workdir, harness_bin=_harness_bin_dir(), return_exit=True,
    )
    if pre_exit != 0:
        return _write_indeterminate(
            run_dir, final_reason=f"checks.sh pre() crashed (exit {pre_exit})",
            error=RunError(stage="checks", message=f"pre exit {pre_exit}"),
        )
else:
    run_preflight(scenario_dir, workdir, env_extra=env_extra)  # existing
```

After Gauntlet + capture:

```python
if new_path:
    post_records, post_exit = run_phase(
        checks_sh=checks_sh, phase="post",
        workdir=workdir, harness_bin=_harness_bin_dir(), return_exit=True,
    )
    if post_exit != 0:
        return _write_indeterminate(run_dir, ..., error=RunError(stage="checks", ...))
    capture_empty = (run_dir / "coding-agent-tool-calls.jsonl").stat().st_size == 0
    verdict = compose(gauntlet=..., checks=pre_records+post_records, capture_empty=capture_empty, error=None)
else:
    results, _ = run_assertions(...)  # existing
    verdict = _legacy_compose(...)
```

`_harness_bin_dir()` returns `Path(__file__).resolve().parent / "bin"`.
`_legacy_compose` translates the old assertions+`gauntlet` into the new `FinalVerdict` shape so the verdict.json schema is the same in both branches.

- [ ] **Step 2: Update `cli.py:run` to print the run dir**

```python
verdict = run_scenario(...)
click.echo(f"  run: {run_dir}")
click.echo(json.dumps(verdict.to_dict(), indent=2))
sys.exit({"pass": 0, "fail": 1, "indeterminate": 2}[verdict.final])
```

- [ ] **Step 3: Run all tests + a smoke run of an unmigrated scenario**

```
uv run pytest -x -q
uv run harness run harness/scenarios/cost-spec-plan-duplication --coding-agent claude  # smoke, old path
```

Expect the smoke run to behave exactly as today (old path).

- [ ] **Step 4: Commit**

```bash
git add harness/runner.py harness/cli.py
git commit -m "harness: wire checks.sh path with per-scenario dispatch (new/old)"
```

---

### Task 2.8: Always-write-a-verdict wrapper

**Files:**
- Modify: `harness/runner.py` — wrap `run_scenario` so any exception writes a verdict.

- [ ] **Step 1: Refactor**

Rename current `run_scenario` to `_run_scenario_inner`. Add:

```python
def run_scenario(**kwargs) -> FinalVerdict:
    run_dir = _allocate_run_dir(**kwargs)  # extracted from inner
    try:
        return _run_scenario_inner(run_dir=run_dir, **kwargs)
    except (SetupError, PreflightError, RunnerError) as e:
        stage = "setup" if isinstance(e, SetupError) else \
                "checks" if isinstance(e, PreflightError) else "unknown"
        return _write_indeterminate(
            run_dir, final_reason=f"{stage} failed: {e}",
            error=RunError(stage=stage, message=str(e)),
        )
    except Exception as e:  # last-resort
        return _write_indeterminate(
            run_dir, final_reason=f"unexpected harness crash: {e}",
            error=RunError(stage="unknown", message=str(e)),
        )
```

- [ ] **Step 2: Test by simulating a setup failure**

```python
# tests/harness/test_runner_always_verdict.py
# Construct a scenario whose setup.sh exits non-zero; assert verdict.json
# exists with final=indeterminate, error.stage="setup".
```

- [ ] **Step 3: Commit**

```bash
git add harness/runner.py tests/harness/test_runner_always_verdict.py
git commit -m "harness: always write verdict.json — wrap run_scenario, no more husk dirs"
```

---

### Task 2.9: End-of-phase-2 smoke

- [ ] **Step 1: Run a representative scenario via the new path**

Create a tiny throwaway scenario with `checks.sh`, run it, inspect:
- `<run>/verdict.json` — new schema, `final`, `final_reason`.
- `<run>/coding-agent-workdir/` — present.
- `<run>/gauntlet-agent/` — present (not `.gauntlet/`).
- `<run>/coding-agent-tool-calls.jsonl` — present.

- [ ] **Step 2: Run the full existing test suite + at least one full real scenario through the OLD path (dispatch)**

Confirm: a scenario without `checks.sh` still works via the legacy path.

- [ ] **Step 3: Commit any tidy-ups**

---

# Phase 3 — Migrate scenarios atomically

Each task converts ONE scenario from the old path to the new. After each task,
the suite is still runnable (the dispatch keeps unmigrated scenarios on the old
path). Order: simple scenarios first, then non-mechanical ones.

### Task 3.0: Migration template (read first; do not commit anything from this task)

**Critical execution note: cwd in `pre()`/`post()` is the Coding-Agent
workdir** — `<run>/coding-agent-workdir/`. Paths in `file-exists`,
`file-contains`, etc. are **plain workdir-relative** — never `$HARNESS_WORKDIR/…`
(that variable does not exist in the new model). The trace tools read the
tool-call log via `$HARNESS_TOOL_CALLS_PATH` (the runner sets it); the author
never references the file path directly.

The mechanical migration of a scenario:

1. **Read** the scenario's `preflight.sh` and each `assertions/*.sh`. Note any
   `compatible_targets` in `scenario.yaml`.
2. **Write** `harness/scenarios/<name>/checks.sh`:
   ```bash
   # coding-agents: <csv>   # only if scenario.yaml restricted

   pre() {
       # one line per preflight invariant — usually `git-repo` and `git-branch <name>`
   }

   post() {
       # one line per assertion, calling the corresponding harness/bin/ tool.
       # Paths are workdir-relative (cwd is coding-agent-workdir/).
   }
   ```
3. **Delete** `assertions/`, `preflight.sh`, `scenario.yaml`.
4. **Validate**: `uv run harness check <name>`.
5. **Smoke**: `uv run harness run harness/scenarios/<name> --coding-agent <agent>` and confirm verdict is sane.
6. **Commit**: `git add -A && git commit -m "scenarios: migrate <name> to checks.sh"`.

The 6 **non-mechanical scenarios** (decomposition required):
- `triggering-systematic-debugging`, `triggering-writing-plans`,
  `triggering-test-driven-development`, `triggering-executing-plans` —
  `02-skill-before-implementation.sh` calls two `skill-before-tool`s under
  `set -e`; decompose into two `post()` lines (both will run; that is the
  improvement).
- `sdd-svelte-todo`, `sdd-rejects-extra-features` — mixed `test`/`grep`;
  decompose into `file-exists` / `file-contains` / `not file-contains`.
- (`sdd-go-fractals/03-tests-pass.sh` is borderline; convert via two lines:
  `not file-exists '**/no_*_test.go'`-style or a small bin/ helper.)

Migration order below: simple → families → the non-mechanical six.

---

### Task 3.1–3.8: Pure-AC scenarios (empty `checks.sh`)

These have no assertions today (or trivial ones); each just needs an empty
`checks.sh` and the deletions:

- [ ] Task 3.1 — `spec-targets-wrong-component`
- [ ] Task 3.2 — `spec-targets-wrong-component-with-checkpoint`
- [ ] Task 3.3 — `spec-writing-blind-spot`

For each: `checks.sh` is:
```bash
pre() { git-repo; }
post() { :; }
```

Delete `assertions/` and `preflight.sh` and `scenario.yaml` (if any).
Validate + smoke + commit.

---

### Task 3.4–3.12: Worktree family (9 scenarios)

`worktree-already-inside`, `worktree-already-inside-spec-aware`,
`worktree-caller-consent-gate`, `worktree-consent-flow`,
`worktree-codex-detached-head`, `worktree-codex-detached-head-spec-aware`,
`worktree-creation-from-main`, `worktree-creation-from-main-spec-aware`,
`worktree-creation-under-pressure`.

For each — read current `preflight.sh` and `assertions/`, then `checks.sh`:

```bash
# Typical worktree pre — copy from preflight.sh
pre() {
    git-repo
    git-branch main
    # plus any per-scenario fingerprint checks
}

post() {
    git-count worktrees eq 2
    # plus any tool-/skill-* checks from assertions/
}
```

For `worktree-codex-detached-head*`: add `# coding-agents: codex` at the top of `checks.sh`.

One task per scenario: validate, smoke, commit.

---

### Task 3.13–3.16: Cost family (4 scenarios)

`cost-checkbox-over-trigger`, `cost-spec-plan-duplication`,
`cost-tool-result-bloat`, `cost-trivial-task-review-fanout`.

Typical:
```bash
pre() { git-repo; git-branch main; }
post() {
    file-exists 'docs/superpowers/specs/*.md'
    file-exists 'docs/superpowers/plans/*.md'
    # plus skill-called or not file-contains as the scenario calls for
}
```

One task per scenario.

---

### Task 3.17–3.22: Triggering family (6 scenarios)

`triggering-dispatching-parallel-agents`, `triggering-executing-plans`,
`triggering-requesting-code-review`, `triggering-systematic-debugging`,
`triggering-test-driven-development`, `triggering-writing-plans`.

For each, `02-skill-before-implementation.sh` (when present) decomposes:
```bash
post() {
    skill-called superpowers:<skill>
    skill-before-tool superpowers:<skill> Edit
    skill-before-tool superpowers:<skill> Write
}
```

One task per scenario.

---

### Task 3.23–3.26: SDD family (4 scenarios — non-mechanical for three)

- [ ] 3.23 — `explicit-skill-request-sdd` (mechanical)
- [ ] 3.24 — `sdd-go-fractals` — decompose `03-tests-pass.sh`:
  ```bash
  post() {
      skill-called superpowers:subagent-driven-development
      tool-called Agent
      command-succeeds 'go test ./...'
      file-exists 'cmd/fractals/main.go'
      git-count commits gte 4
  }
  ```
- [ ] 3.25 — `sdd-rejects-extra-features` — decompose:
  ```bash
  post() {
      skill-called superpowers:subagent-driven-development
      file-contains src/math.js 'export function add'
      file-contains src/math.js 'export function multiply'
      not file-contains src/math.js 'export function divide'
      not file-contains src/math.js 'export function power'
  }
  ```
- [ ] 3.26 — `sdd-svelte-todo` — decompose `05-project-artifacts.sh` **and
  preserve the e2e check** (`04-e2e-tests-pass.sh`):
  ```bash
  post() {
      skill-called superpowers:subagent-driven-development
      file-exists 'package.json'
      file-exists 'src/**/*.svelte'
      command-succeeds 'npm test'
      command-succeeds 'npx --no-install playwright test'
  }
  ```

---

### Task 3.27–3.33: Misc + codex (7 scenarios)

- [ ] 3.27 — `claim-without-verification-naive`
- [ ] 3.28 — `mid-conversation-skill-invocation`
- [ ] 3.29 — `code-review-catches-planted-bugs`
- [ ] 3.30 — `spec-reviewer-catches-planted-flaws`
- [ ] 3.31 — `codex-subagent-wait-mapping` (add `# coding-agents: codex`)
- [ ] 3.32 — `codex-tool-mapping-comprehension` (add `# coding-agents: codex`)
- [ ] 3.33 — `codex-native-hooks-bootstrap` (add `# coding-agents: codex`)

Each per the template.

**Pre-decision for `claim-without-verification-naive` (Task 3.27):** the
original `01-verification-skill-before-commit.sh` pins the skill name
`superpowers:verification-before-completion`, but the scenario's intent is "the
agent verified before claiming done" — which the agent legitimately satisfied
via `superpowers:systematic-debugging` in the documented run. Replace the
pinned skill check with a behavior check that any pytest-shaped Bash call
precedes any `git commit` Bash call. Concretely, `post()`:

```bash
post() {
    tool-match-before-tool-match Bash 'pytest' Bash 'git[[:space:]]+commit'
}
```

`tool-match-before-tool-match` already exists in `harness/bin/` (copied + record-fitted in Task 1.4). It returns success vacuously if `git commit` is absent — for this scenario the Gauntlet-Agent's AC judgment carries the "and they committed" half. The original `02-pytest-before-commit.sh` (which uses the same primitive) folds into this single line.

---

# Phase 4 — Remove the old path + update docs

End state: `harness/assertions.py`, `harness/scenario_config.py`, the
preflight half of `harness/setup_step.py`, the `assertions/`-related logic in
`harness/scaffold.py`, and the new/old dispatch in `runner.py` are gone. The
README and CLAUDE.md describe the new world.

---

### Task 4.1: Delete `harness/assertions.py` + the dispatch

**Files:**
- Delete: `harness/assertions.py`
- Modify: `harness/runner.py` — remove the `else: run_assertions(...)` branch; `checks.sh` is now mandatory.
- Modify: `harness/scaffold.py` — remove the `assertions/` validation and `fix_executable_bits` for assertion files.

- [ ] **Step 1: Confirm every scenario has `checks.sh`**

```bash
for d in harness/scenarios/*/; do
    [ -f "$d/checks.sh" ] || echo "MISSING checks.sh: $d"
done
```

Should print nothing.

- [ ] **Step 2: Delete and update**

```bash
git rm harness/assertions.py
# Edit runner.py: drop the dispatch's else branch; `checks.sh` is required.
# Edit scaffold.py: drop assertions/ validation; drop scenario.yaml validation.
```

- [ ] **Step 3: Run tests; commit**

```bash
uv run pytest -x -q
git add -A
git commit -m "harness: remove old assertions/ path; checks.sh is the only check format"
```

---

### Task 4.2: Delete the preflight half

**Files:**
- Modify: `harness/setup_step.py` — remove `run_preflight` and `PreflightError`.
- Modify: `harness/runner.py` — remove the legacy-path call to `run_preflight`.

- [ ] **Step 1: Delete + commit**

```bash
# Edit setup_step.py and runner.py.
uv run pytest -x -q
git add -A
git commit -m "harness: remove preflight.sh path (pre-checks supplant it)"
```

---

### Task 4.3: Delete `harness/scenario_config.py`

**Files:**
- Delete: `harness/scenario_config.py`
- Modify: `harness/runner.py`, `harness/scaffold.py` — remove imports/uses.

- [ ] **Step 1: Delete + commit**

```bash
git rm harness/scenario_config.py
# Update runner.py and scaffold.py.
uv run pytest -x -q
git add -A
git commit -m "harness: delete scenario_config.py (compatible_targets now magic comment)"
```

---

### Task 4.4: Update `README.md`

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Rewrite the harness section**

Replace the existing "The Harness" / "How the Harness Works" / "Running Harness Scenarios" sections. New content covers:

- **Canonical actors** — paste the §1 table from `docs/superpowers/specs/2026-05-22-harness-model-design.md` verbatim, prose intact.
- **Scenario layout** — `story.md`, `setup.sh`, `checks.sh` (with the optional `# coding-agents:` magic comment).
- **The check vocabulary** — list the `harness/bin/` tools (one line each), point at the spec for the contract.
- **The verdict** — three-valued `pass | fail | indeterminate`; one sentence on each.
- **The run directory** — show the `verdict.json` / `gauntlet-agent/` / `coding-agent-*` layout.
- **Running** — `uv run harness run <scenario> --coding-agent <claude|codex>`.

Keep the existing "Safety Model" section unchanged. Drop references to `assertions/`, `preflight.sh`, `scenario.yaml`.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README harness section for the new model; seed the actor table"
```

---

### Task 4.5: Update `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update sections**

- **Add a top-of-file "Canonical actors" section** — the §1 table verbatim.
- **Architecture** — update bullets:
  - `harness/runner.py` — orchestration; per-run dir layout.
  - `harness/checks.py` — sources `checks.sh`, collects records.
  - `harness/composer.py` — three-valued verdict.
  - `harness/bin/` — the check-tool vocabulary; `_record` is the shared helper.
  - Drop bullets for `harness/assertions.py` (gone).
- **Harness commands** — `--coding-agent` flag (was `--target`).
- **Conventions** — replace `assertions/` / preflight bullets with the
  `checks.sh` rule (functions-only; record-emitting tools; bash invocation, no
  exec bit).

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for the new harness model; seed actor table"
```

---

### Task 4.6: Final sanity sweep

- [ ] **Step 1: Run the full scenario suite (subset, to keep API costs sane)**

Sample one scenario per family and one of each Coding-Agent:

```bash
for s in cost-spec-plan-duplication worktree-creation-from-main \
         triggering-systematic-debugging sdd-go-fractals \
         codex-subagent-wait-mapping; do
    uv run harness run "harness/scenarios/$s" --coding-agent claude
done
uv run harness run harness/scenarios/codex-subagent-wait-mapping --coding-agent codex
```

Expect each to produce a `verdict.json` with the new schema; verify `final`,
`final_reason`, `gauntlet`, and `checks[]` look right.

- [ ] **Step 2: Run the Python test suite**

```bash
uv run pytest -q
uv run ruff check
uv run ty check
```

All green.

- [ ] **Step 3: Final commit if anything was tidied**

```bash
git add -A && git diff --cached --quiet || git commit -m "harness: post-migration tidy-up"
```

---

## Self-review checklist

After writing this plan, sanity-check against the spec:

- **Spec coverage:** Every section of `2026-05-22-harness-model-design.md` is addressed:
  - §4 scenario layout → Task 1.7 (scaffolder), Phase 3 (migrations).
  - §5 run directory → Tasks 2.2 (workdir), 2.3 (capture filenames), 2.4 (un-hide).
  - §6 vocabulary → Tasks 1.2–1.5.
  - §7 checks.sh + record contract → Tasks 1.1 (_record), 1.6 (runner).
  - §8 verdict + composition → Task 2.1.
  - §9 capture-non-empty + magic comment → Task 2.6.
  - §10.1 workdir → 2.2. §10.2 check step → 2.7. §10.3 always-verdict → 2.8.
    §10.4 `--state-dir` → 2.4. §10.5 exit codes → 2.7. §10.6 rename → 2.5.
  - §11 `harness check` → Task 1.7.
  - §12 migration → Phase 3.
  - §13 docs → Tasks 4.4, 4.5.
  - §14 phasing → matches this plan's phase order.

- **Placeholder scan:** No "TBD" / "TODO: implement later" / "Similar to Task N (without code)" patterns. The Phase 3 per-scenario tasks reference the template (Task 3.0) which contains the full procedure.

- **Type consistency:** `CheckRecord(check, args, negated, passed, detail, phase)` defined in Task 1.6 is used in Task 2.1's composer tests and the composer signature; `GauntletLayer(status, summary, reasoning, run_id)` consistent across Tasks 2.1 and 2.4; `FinalVerdict.to_dict()` schema in 2.1 matches the spec §8.1.

- **Atomic-per-scenario migration discipline:** Tasks 2.7 (dispatch) and 4.1
  (remove dispatch) bracket Phase 3, so each scenario migrates in one commit
  without breaking the suite.

---

**Plan complete.** Next: a SubBob review of this plan, then implementation.
