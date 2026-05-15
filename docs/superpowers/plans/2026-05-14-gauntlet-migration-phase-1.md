# Gauntlet Migration Phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Python harness in `superpowers-evals/harness/` that wraps Gauntlet to reproduce Drill's eval-lab capability — workdir setup, agent-under-test session-log capture, deterministic assertions — and prove parity with Drill on three representative scenarios.

**Architecture:** A new Python package `harness/` lives alongside `drill/`. It invokes `gauntlet run` as a subprocess for the agent loop, and owns the eval-specific concerns Gauntlet doesn't: per-scenario `setup.sh`, per-target session-log snapshot/diff/normalize, deterministic assertions via the existing `bin/` helpers, optional external LLM verifier, and a fixed all-must-pass composition rule. Drill stays fully functional throughout Phase 1 — they coexist in the repo until Phase 3 decommission.

**Tech Stack:** Python 3.11+, uv, click, pyyaml, anthropic SDK (for optional verifier), pytest. Lifts `drill/normalizer.py` and `drill/token_capture.py` near-verbatim. Reuses `bin/*` assertion scripts unchanged. Subprocess-invokes the externally-installed `gauntlet` CLI.

**Spec reference:** `docs/gauntlet-migration.md`

---

## File Structure

```
superpowers-evals/
├── harness/                          # NEW — replaces drill/ in Phase 3
│   ├── __init__.py
│   ├── cli.py                        # click CLI (run, list)
│   ├── runner.py                     # per-run orchestration
│   ├── manifest.py                   # scenario manifest loader (target.yaml)
│   ├── setup_step.py                 # run scenario setup.sh against workdir
│   ├── capture.py                    # snapshot/diff session-log directories
│   ├── normalizers.py                # lifted from drill/normalizer.py
│   ├── token_usage.py                # lifted from drill/token_capture.py
│   ├── assertions.py                 # run scenario's assertions/*.sh, compose
│   ├── composer.py                   # combine gauntlet + assertions + verifier
│   ├── verifier.py                   # optional external LLM verifier
│   └── target_prompts/
│       ├── claude.md                 # prompt augmentation for Claude Code target
│       └── codex.md                  # prompt augmentation for Codex target
├── harness/scenarios/                # NEW — directory-format scenarios
│   ├── triggering-writing-plans/
│   │   ├── story.md
│   │   ├── setup.sh
│   │   ├── target.yaml
│   │   └── assertions/
│   │       └── 01-skill-called.sh
│   ├── worktree-already-inside/
│   │   ├── story.md
│   │   ├── setup.sh
│   │   ├── target.yaml
│   │   └── assertions/
│   │       └── 01-no-new-worktree.sh
│   └── codex-subagent-wait-mapping/
│       ├── story.md
│       ├── setup.sh
│       ├── target.yaml
│       └── assertions/
│           ├── 01-spawn-agent-called.sh
│           ├── 02-wait-agent-called.sh
│           ├── 03-wait-not-called.sh
│           └── 04-spawn-before-wait.sh
├── tests/
│   └── harness/                      # NEW — mirrors harness/ layout
│       ├── test_normalizers.py       # lifted from tests/test_normalizer.py
│       ├── test_token_usage.py       # lifted from tests/test_token_capture.py
│       ├── test_capture.py
│       ├── test_setup_step.py
│       ├── test_assertions.py
│       ├── test_composer.py
│       ├── test_manifest.py
│       └── fixtures/                 # symlink or copy of tests/fixtures
├── docs/
│   ├── gauntlet-migration.md         # spec (already written)
│   └── superpowers/plans/2026-05-14-gauntlet-migration-phase-1.md  # this file
├── drill/                            # UNCHANGED through Phase 1
├── scenarios/                        # UNCHANGED — old Drill YAML scenarios
├── bin/                              # UNCHANGED — assertion helpers reused
├── backends/                         # UNCHANGED through Phase 1
└── pyproject.toml                    # MODIFIED — add harness package, scripts entry
```

**Naming choice:** the new CLI is `harness` (boring and accurate). `uv run harness run <scenario>` is the entry point.

---

## Tasks

### Task 1: Bootstrap the harness package

**Files:**
- Create: `harness/__init__.py`
- Modify: `pyproject.toml`

- [ ] **Step 1: Create empty package directory and `__init__.py`**

```python
# harness/__init__.py
"""Eval harness wrapping Gauntlet for superpowers skill compliance benchmarks."""

__version__ = "0.1.0"
```

- [ ] **Step 2: Update `pyproject.toml` to register the package and CLI entry point**

In the `[project.scripts]` table, add a `harness` entry pointing at the (yet-to-exist) CLI:

```toml
[project.scripts]
drill = "drill.cli:main"
harness = "harness.cli:main"

[tool.hatch.build.targets.wheel]
packages = ["drill", "setup_helpers", "harness"]
```

- [ ] **Step 3: Verify the package installs**

```bash
uv sync --extra dev
```

Expected: succeeds; `uv run python -c "import harness; print(harness.__version__)"` prints `0.1.0`.

- [ ] **Step 4: Commit**

```bash
git add pyproject.toml harness/__init__.py
git commit -m "harness: bootstrap empty package alongside drill"
```

---

### Task 2: Lift normalizers from drill

The `drill/normalizer.py` module is framework-agnostic (operates on raw log content + paths). Lift it verbatim into the harness — copying rather than importing keeps drill independent and lets us delete drill cleanly in Phase 3 without churning harness imports.

**Files:**
- Create: `harness/normalizers.py`
- Create: `tests/harness/__init__.py`
- Create: `tests/harness/test_normalizers.py`
- Create: `tests/harness/fixtures/` (symlink or copy of `tests/fixtures/`)

- [ ] **Step 1: Copy `drill/normalizer.py` → `harness/normalizers.py`**

```bash
cp drill/normalizer.py harness/normalizers.py
```

No edits to the file content. The module is self-contained.

- [ ] **Step 2: Copy `tests/test_normalizer.py` → `tests/harness/test_normalizers.py` and rewrite imports**

```bash
mkdir -p tests/harness
touch tests/harness/__init__.py
cp tests/test_normalizer.py tests/harness/test_normalizers.py
```

Then in `tests/harness/test_normalizers.py`, replace every `from drill.normalizer import` with `from harness.normalizers import`. Use `sed`:

```bash
sed -i '' 's|from drill\.normalizer import|from harness.normalizers import|g' tests/harness/test_normalizers.py
```

(On Linux, omit the `''` argument to `-i`.)

- [ ] **Step 3: Make fixtures available to harness tests**

The original tests reference `tests/fixtures/*.jsonl`. Symlink the dir so harness tests can find them:

```bash
ln -s ../fixtures tests/harness/fixtures
```

If the existing tests load fixtures via path relative to the test file, the symlink is enough. If they load via absolute project-relative path, no change needed; the symlink is harmless.

- [ ] **Step 4: Run the lifted tests; verify they pass**

```bash
uv run pytest tests/harness/test_normalizers.py -v
```

Expected: all tests in `test_normalizers.py` pass. If any fail, the cause is fixture-path resolution — fix and re-run before committing.

- [ ] **Step 5: Run lint and typecheck on the new module**

```bash
uv run ruff check harness/normalizers.py tests/harness/test_normalizers.py
uv run ty check harness/normalizers.py
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add harness/normalizers.py tests/harness/__init__.py tests/harness/test_normalizers.py tests/harness/fixtures
git commit -m "harness: lift normalizers from drill verbatim with tests"
```

---

### Task 3: Lift token_usage from drill

Same pattern as Task 2 — `drill/token_capture.py` is framework-agnostic.

**Files:**
- Create: `harness/token_usage.py`
- Create: `tests/harness/test_token_usage.py`

- [ ] **Step 1: Copy source and tests**

```bash
cp drill/token_capture.py harness/token_usage.py
cp tests/test_token_capture.py tests/harness/test_token_usage.py
sed -i '' 's|from drill\.token_capture import|from harness.token_usage import|g' tests/harness/test_token_usage.py
```

- [ ] **Step 2: Run lifted tests**

```bash
uv run pytest tests/harness/test_token_usage.py -v
```

Expected: all pass.

- [ ] **Step 3: Lint and typecheck**

```bash
uv run ruff check harness/token_usage.py tests/harness/test_token_usage.py
uv run ty check harness/token_usage.py
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add harness/token_usage.py tests/harness/test_token_usage.py
git commit -m "harness: lift token_usage from drill verbatim with tests"
```

---

### Task 4: Manifest loader

Each harness scenario has a `target.yaml` describing how to launch the agent under test. The manifest loader parses it, validates required fields, and resolves env-var substitution.

**Files:**
- Create: `harness/manifest.py`
- Create: `tests/harness/test_manifest.py`

`target.yaml` schema (Phase 1):

```yaml
name: claude              # human label, used in evidence dir
target_command: |         # the `--target` Gauntlet receives (shell command)
  claude --dangerously-skip-permissions --plugin-dir ${SUPERPOWERS_ROOT} --model opus
required_env:             # checked before launch; abort if missing
  - ANTHROPIC_API_KEY
  - SUPERPOWERS_ROOT
session_log_dir: ~/.claude/projects   # snapshot before, diff after
session_log_glob: "**/session-*.jsonl"
normalizer: claude        # key into NORMALIZERS registry
target_prompt: harness/target_prompts/claude.md   # passed to gauntlet --project-prompt
max_time: 10m             # gauntlet --max-time
```

- [ ] **Step 1: Write the failing tests**

```python
# tests/harness/test_manifest.py
import os
from pathlib import Path

import pytest
import yaml

from harness.manifest import Manifest, ManifestError, load_manifest


def _write(tmp_path: Path, doc: dict) -> Path:
    p = tmp_path / "target.yaml"
    p.write_text(yaml.safe_dump(doc))
    return p


class TestLoadManifest:
    def test_minimal_valid_manifest(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "x")
        monkeypatch.setenv("SUPERPOWERS_ROOT", "/sp")
        path = _write(tmp_path, {
            "name": "claude",
            "target_command": "claude --plugin-dir ${SUPERPOWERS_ROOT}",
            "required_env": ["ANTHROPIC_API_KEY", "SUPERPOWERS_ROOT"],
            "session_log_dir": "~/.claude/projects",
            "session_log_glob": "**/session-*.jsonl",
            "normalizer": "claude",
        })
        m = load_manifest(path)
        assert isinstance(m, Manifest)
        assert m.name == "claude"
        assert "/sp" in m.target_command  # env substitution applied
        assert m.session_log_dir == Path("~/.claude/projects").expanduser()
        assert m.normalizer == "claude"
        assert m.target_prompt is None
        assert m.max_time is None

    def test_missing_required_env_raises(self, tmp_path, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        path = _write(tmp_path, {
            "name": "claude",
            "target_command": "claude",
            "required_env": ["ANTHROPIC_API_KEY"],
            "session_log_dir": "~/.claude/projects",
            "session_log_glob": "**/session-*.jsonl",
            "normalizer": "claude",
        })
        with pytest.raises(ManifestError, match="ANTHROPIC_API_KEY"):
            load_manifest(path)

    def test_unknown_normalizer_raises(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "x")
        path = _write(tmp_path, {
            "name": "weirdo",
            "target_command": "weirdo",
            "required_env": ["ANTHROPIC_API_KEY"],
            "session_log_dir": "/tmp",
            "session_log_glob": "*.jsonl",
            "normalizer": "weirdo",
        })
        with pytest.raises(ManifestError, match="weirdo"):
            load_manifest(path)

    def test_optional_target_prompt_resolved_relative_to_repo(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "x")
        path = _write(tmp_path, {
            "name": "claude",
            "target_command": "claude",
            "required_env": ["ANTHROPIC_API_KEY"],
            "session_log_dir": "/tmp",
            "session_log_glob": "*.jsonl",
            "normalizer": "claude",
            "target_prompt": "harness/target_prompts/claude.md",
        })
        m = load_manifest(path)
        assert m.target_prompt is not None
        assert m.target_prompt.name == "claude.md"
```

- [ ] **Step 2: Run tests; verify they fail**

```bash
uv run pytest tests/harness/test_manifest.py -v
```

Expected: `ImportError: cannot import name 'Manifest' from 'harness.manifest'`.

- [ ] **Step 3: Implement `harness/manifest.py`**

```python
"""Per-scenario target manifest loader.

A scenario's target.yaml describes which agent CLI to launch and where its
session logs land. Loaded once at the start of a run and threaded through
the runner, capture, and normalizer steps.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path

import yaml

from harness.normalizers import NORMALIZERS


class ManifestError(ValueError):
    """Raised when a target.yaml is invalid or required env vars are missing."""


@dataclass(frozen=True)
class Manifest:
    name: str
    target_command: str
    required_env: tuple[str, ...]
    session_log_dir: Path
    session_log_glob: str
    normalizer: str
    target_prompt: Path | None
    max_time: str | None

    @property
    def normalizer_fn(self):
        return NORMALIZERS[self.normalizer]


_ENV_PATTERN = re.compile(r"\$\{([A-Z_][A-Z0-9_]*)\}")


def _substitute_env(value: str) -> str:
    def repl(match: re.Match[str]) -> str:
        var = match.group(1)
        return os.environ.get(var, match.group(0))

    return _ENV_PATTERN.sub(repl, value)


def load_manifest(path: Path) -> Manifest:
    raw = yaml.safe_load(path.read_text())
    if not isinstance(raw, dict):
        raise ManifestError(f"{path}: top-level must be a mapping")

    required = ("name", "target_command", "required_env", "session_log_dir",
                "session_log_glob", "normalizer")
    missing = [k for k in required if k not in raw]
    if missing:
        raise ManifestError(f"{path}: missing required fields: {missing}")

    required_env = tuple(raw["required_env"])
    missing_env = [v for v in required_env if not os.environ.get(v)]
    if missing_env:
        raise ManifestError(
            f"{path}: required env vars not set: {missing_env}"
        )

    normalizer = raw["normalizer"]
    if normalizer not in NORMALIZERS:
        raise ManifestError(
            f"{path}: unknown normalizer {normalizer!r}; known: {sorted(NORMALIZERS)}"
        )

    target_prompt = None
    if "target_prompt" in raw:
        # Resolve relative to the manifest file's directory unless absolute.
        candidate = Path(raw["target_prompt"]).expanduser()
        if not candidate.is_absolute():
            candidate = (path.parent / candidate).resolve()
            # If still doesn't exist, try resolving against repo root (cwd).
            if not candidate.exists():
                candidate = Path(raw["target_prompt"]).resolve()
        target_prompt = candidate

    return Manifest(
        name=raw["name"],
        target_command=_substitute_env(raw["target_command"]),
        required_env=required_env,
        session_log_dir=Path(_substitute_env(raw["session_log_dir"])).expanduser(),
        session_log_glob=raw["session_log_glob"],
        normalizer=normalizer,
        target_prompt=target_prompt,
        max_time=raw.get("max_time"),
    )
```

- [ ] **Step 4: Run tests; verify they pass**

```bash
uv run pytest tests/harness/test_manifest.py -v
```

Expected: all 4 tests pass.

- [ ] **Step 5: Lint and typecheck**

```bash
uv run ruff check harness/manifest.py tests/harness/test_manifest.py
uv run ty check harness/manifest.py
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add harness/manifest.py tests/harness/test_manifest.py
git commit -m "harness: target.yaml manifest loader with env substitution and validation"
```

---

### Task 5: Capture utility

The capture step snapshots the agent's session-log directory before launch, then identifies new files after. For Codex/Pi, we filter further by cwd. The normalizer functions from Task 2 already handle the per-target diff → JSONL transformation.

**Files:**
- Create: `harness/capture.py`
- Create: `tests/harness/test_capture.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/harness/test_capture.py
import json
from pathlib import Path

from harness.capture import (
    capture_tool_calls,
    snapshot_dir,
    new_files_since,
)


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
        assert len(new) == 1
        assert new[0].name == "session-001.jsonl"

    def test_missing_dir_returns_empty(self, tmp_path):
        log_dir = tmp_path / "missing"
        snap = snapshot_dir(log_dir, "*.jsonl")
        assert snap == set()
        assert new_files_since(log_dir, "*.jsonl", snap) == []


class TestCaptureToolCalls:
    def test_writes_normalized_jsonl_into_evidence_dir(self, tmp_path):
        log_dir = tmp_path / "logs"
        log_dir.mkdir()
        snap = snapshot_dir(log_dir, "*.jsonl")
        # Drop a Claude-shaped session log post-snapshot.
        session = log_dir / "session-abc.jsonl"
        session.write_text(json.dumps({
            "type": "assistant",
            "message": {
                "content": [
                    {"type": "tool_use", "name": "Bash", "input": {"command": "ls"}}
                ]
            }
        }) + "\n")
        evidence_dir = tmp_path / "evidence"
        evidence_dir.mkdir()
        out = capture_tool_calls(
            log_dir=log_dir,
            log_glob="*.jsonl",
            snapshot=snap,
            normalizer="claude",
            evidence_dir=evidence_dir,
        )
        assert out == evidence_dir / "tool_calls.jsonl"
        rows = [json.loads(line) for line in out.read_text().splitlines() if line.strip()]
        assert len(rows) == 1
        assert rows[0]["tool"] == "Bash"
        assert rows[0]["source"] == "shell"
```

- [ ] **Step 2: Run tests; verify they fail**

```bash
uv run pytest tests/harness/test_capture.py -v
```

Expected: `ImportError`.

- [ ] **Step 3: Implement `harness/capture.py`**

```python
"""Snapshot, diff, and normalize agent-under-test session-log directories.

Per-target normalizer choice is made by the caller (the runner). This module
deals only in paths and JSONL.
"""

from __future__ import annotations

import json
from pathlib import Path

from harness.normalizers import (
    NORMALIZERS,
    filter_codex_logs_by_cwd,
    filter_pi_logs_by_cwd,
)


def snapshot_dir(log_dir: Path, glob: str) -> set[str]:
    """Return relative paths of all log files matching glob under log_dir."""
    if not log_dir.exists():
        return set()
    return {str(p.relative_to(log_dir)) for p in log_dir.glob(glob)}


def new_files_since(log_dir: Path, glob: str, snapshot: set[str]) -> list[Path]:
    """Files matching glob under log_dir that weren't present in snapshot."""
    if not log_dir.exists():
        return []
    current = {str(p.relative_to(log_dir)): p for p in log_dir.glob(glob)}
    return [current[k] for k in sorted(set(current) - snapshot)]


def capture_tool_calls(
    log_dir: Path,
    log_glob: str,
    snapshot: set[str],
    normalizer: str,
    evidence_dir: Path,
    *,
    workdir: Path | None = None,
) -> Path:
    """Diff log_dir, filter by cwd if applicable, normalize, write JSONL.

    Returns the path of the written tool_calls.jsonl. Always writes the file
    (empty if no new logs) so downstream assertions can rely on its existence.
    """
    new = new_files_since(log_dir, log_glob, snapshot)

    # cwd filtering for Codex / Pi (shared session-log roots across runs).
    if normalizer == "codex" and workdir is not None:
        new = filter_codex_logs_by_cwd(new, str(workdir))
    elif normalizer == "pi" and workdir is not None:
        new = filter_pi_logs_by_cwd(new, str(workdir))

    fn = NORMALIZERS[normalizer]
    out_path = evidence_dir / "tool_calls.jsonl"
    with out_path.open("w") as f:
        for path in new:
            for row in fn(path.read_text()):
                f.write(json.dumps(row) + "\n")
    return out_path
```

- [ ] **Step 4: Run tests; verify they pass**

```bash
uv run pytest tests/harness/test_capture.py -v
```

Expected: all 4 tests pass.

- [ ] **Step 5: Lint and typecheck**

```bash
uv run ruff check harness/capture.py tests/harness/test_capture.py
uv run ty check harness/capture.py
```

- [ ] **Step 6: Commit**

```bash
git add harness/capture.py tests/harness/test_capture.py
git commit -m "harness: snapshot + diff + normalize session-log capture utility"
```

---

### Task 6: Setup-step runner

Run a scenario's `setup.sh` against a freshly-created temp workdir. Non-zero exit aborts the run (Drill's "setup invariant violated" pattern).

**Files:**
- Create: `harness/setup_step.py`
- Create: `tests/harness/test_setup_step.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/harness/test_setup_step.py
import os
import stat
from pathlib import Path

import pytest

from harness.setup_step import SetupError, run_setup


def _write_executable(path: Path, body: str) -> None:
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


class TestRunSetup:
    def test_exit_zero_succeeds_and_workdir_mutated(self, tmp_path):
        scenario_dir = tmp_path / "scenario"
        scenario_dir.mkdir()
        workdir = tmp_path / "workdir"
        workdir.mkdir()
        _write_executable(
            scenario_dir / "setup.sh",
            "#!/usr/bin/env bash\nset -e\necho hello > marker\n",
        )
        run_setup(scenario_dir, workdir, env_extra={})
        assert (workdir / "marker").read_text().strip() == "hello"

    def test_nonzero_exit_raises_setup_error(self, tmp_path):
        scenario_dir = tmp_path / "scenario"
        scenario_dir.mkdir()
        workdir = tmp_path / "workdir"
        workdir.mkdir()
        _write_executable(
            scenario_dir / "setup.sh",
            "#!/usr/bin/env bash\necho boom 1>&2\nexit 7\n",
        )
        with pytest.raises(SetupError) as exc:
            run_setup(scenario_dir, workdir, env_extra={})
        assert "exit 7" in str(exc.value)
        assert "boom" in str(exc.value)

    def test_missing_setup_is_fine(self, tmp_path):
        scenario_dir = tmp_path / "scenario"
        scenario_dir.mkdir()
        workdir = tmp_path / "workdir"
        workdir.mkdir()
        # No setup.sh present — run_setup should be a no-op.
        run_setup(scenario_dir, workdir, env_extra={})

    def test_workdir_env_var_set(self, tmp_path):
        scenario_dir = tmp_path / "scenario"
        scenario_dir.mkdir()
        workdir = tmp_path / "workdir"
        workdir.mkdir()
        _write_executable(
            scenario_dir / "setup.sh",
            '#!/usr/bin/env bash\necho "$DRILL_WORKDIR" > /tmp/_test_drill_wd\n',
        )
        run_setup(scenario_dir, workdir, env_extra={})
        assert Path("/tmp/_test_drill_wd").read_text().strip() == str(workdir)
```

- [ ] **Step 2: Run tests; verify they fail**

```bash
uv run pytest tests/harness/test_setup_step.py -v
```

Expected: `ImportError`.

- [ ] **Step 3: Implement `harness/setup_step.py`**

```python
"""Run a scenario's setup.sh against a temp workdir.

DRILL_WORKDIR is exported (matching Drill's convention) so existing helper
scripts and assertion bin/* programs continue to work without renaming.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path


class SetupError(RuntimeError):
    """Raised when setup.sh exits non-zero."""


def run_setup(
    scenario_dir: Path,
    workdir: Path,
    *,
    env_extra: dict[str, str],
) -> None:
    setup_path = scenario_dir / "setup.sh"
    if not setup_path.exists():
        return

    env = {**os.environ, **env_extra, "DRILL_WORKDIR": str(workdir)}
    proc = subprocess.run(
        [str(setup_path)],
        cwd=workdir,
        env=env,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise SetupError(
            f"setup.sh exit {proc.returncode} (in {scenario_dir.name}):\n"
            f"--- stdout ---\n{proc.stdout}\n"
            f"--- stderr ---\n{proc.stderr}"
        )
```

- [ ] **Step 4: Run tests; verify they pass**

```bash
uv run pytest tests/harness/test_setup_step.py -v
```

Expected: all 4 tests pass.

- [ ] **Step 5: Lint and typecheck; commit**

```bash
uv run ruff check harness/setup_step.py tests/harness/test_setup_step.py
uv run ty check harness/setup_step.py
git add harness/setup_step.py tests/harness/test_setup_step.py
git commit -m "harness: setup.sh runner with DRILL_WORKDIR convention"
```

---

### Task 7: Assertions runner

Run every executable in `assertions/` from the evidence directory. Aggregate results into a list of `{name, exit_code, stdout, stderr}` records and a single boolean.

**Files:**
- Create: `harness/assertions.py`
- Create: `tests/harness/test_assertions.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/harness/test_assertions.py
import stat
from pathlib import Path

from harness.assertions import run_assertions, AssertionResult


def _write_executable(path: Path, body: str) -> None:
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


class TestRunAssertions:
    def test_no_assertions_dir_returns_empty_pass(self, tmp_path):
        evidence_dir = tmp_path / "evidence"
        evidence_dir.mkdir()
        results, all_pass = run_assertions(
            assertions_dir=tmp_path / "missing",
            evidence_dir=evidence_dir,
            workdir=tmp_path / "wd",
            bin_dir=tmp_path / "bin",
        )
        assert results == []
        assert all_pass is True

    def test_runs_each_executable_in_alphabetical_order(self, tmp_path):
        a_dir = tmp_path / "a"
        a_dir.mkdir()
        for n, body in [
            ("01-first.sh", "#!/usr/bin/env bash\nexit 0\n"),
            ("02-second.sh", "#!/usr/bin/env bash\nexit 0\n"),
        ]:
            _write_executable(a_dir / n, body)
        evidence_dir = tmp_path / "evidence"
        evidence_dir.mkdir()
        results, all_pass = run_assertions(
            assertions_dir=a_dir,
            evidence_dir=evidence_dir,
            workdir=tmp_path / "wd",
            bin_dir=tmp_path / "bin",
        )
        assert [r.name for r in results] == ["01-first.sh", "02-second.sh"]
        assert all_pass is True

    def test_failing_assertion_caught_with_stderr(self, tmp_path):
        a_dir = tmp_path / "a"
        a_dir.mkdir()
        _write_executable(
            a_dir / "01-fail.sh",
            "#!/usr/bin/env bash\necho oops 1>&2\nexit 3\n",
        )
        evidence_dir = tmp_path / "evidence"
        evidence_dir.mkdir()
        results, all_pass = run_assertions(
            assertions_dir=a_dir,
            evidence_dir=evidence_dir,
            workdir=tmp_path / "wd",
            bin_dir=tmp_path / "bin",
        )
        assert all_pass is False
        assert len(results) == 1
        assert results[0].exit_code == 3
        assert "oops" in results[0].stderr

    def test_bin_dir_on_path(self, tmp_path):
        # An assertion that calls a script from bin/ should find it.
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        _write_executable(bin_dir / "myhelper", "#!/usr/bin/env bash\necho HELLO\n")
        a_dir = tmp_path / "a"
        a_dir.mkdir()
        _write_executable(
            a_dir / "01-uses-helper.sh",
            "#!/usr/bin/env bash\nset -e\nout=$(myhelper)\n[ \"$out\" = HELLO ]\n",
        )
        evidence_dir = tmp_path / "evidence"
        evidence_dir.mkdir()
        results, all_pass = run_assertions(
            assertions_dir=a_dir,
            evidence_dir=evidence_dir,
            workdir=tmp_path / "wd",
            bin_dir=bin_dir,
        )
        assert all_pass is True

    def test_drill_workdir_env_set(self, tmp_path):
        a_dir = tmp_path / "a"
        a_dir.mkdir()
        _write_executable(
            a_dir / "01-check-env.sh",
            '#!/usr/bin/env bash\n[ "$DRILL_WORKDIR" = "%s" ]\n' % str(tmp_path / "wd"),
        )
        evidence_dir = tmp_path / "evidence"
        evidence_dir.mkdir()
        results, all_pass = run_assertions(
            assertions_dir=a_dir,
            evidence_dir=evidence_dir,
            workdir=tmp_path / "wd",
            bin_dir=tmp_path / "bin",
        )
        assert all_pass is True
```

- [ ] **Step 2: Run tests; verify they fail**

```bash
uv run pytest tests/harness/test_assertions.py -v
```

Expected: `ImportError`.

- [ ] **Step 3: Implement `harness/assertions.py`**

```python
"""Run a scenario's assertions/*.sh against the evidence directory."""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class AssertionResult:
    name: str
    exit_code: int
    stdout: str
    stderr: str

    @property
    def passed(self) -> bool:
        return self.exit_code == 0


def run_assertions(
    *,
    assertions_dir: Path,
    evidence_dir: Path,
    workdir: Path,
    bin_dir: Path,
) -> tuple[list[AssertionResult], bool]:
    """Run every executable in assertions_dir from evidence_dir.

    Files are run in alphabetical order. bin_dir is prepended to PATH so
    helper scripts (skill-called, tool-called, ...) resolve. DRILL_WORKDIR
    points at the mutated scenario workdir for compatibility with existing
    bin/* helpers and assertion conventions.
    """
    if not assertions_dir.exists():
        return [], True

    scripts = sorted(
        p for p in assertions_dir.iterdir()
        if p.is_file() and os.access(p, os.X_OK)
    )

    env = {
        **os.environ,
        "DRILL_WORKDIR": str(workdir),
        "PATH": f"{bin_dir}:{os.environ.get('PATH', '')}",
    }

    results: list[AssertionResult] = []
    for script in scripts:
        proc = subprocess.run(
            [str(script)],
            cwd=evidence_dir,
            env=env,
            capture_output=True,
            text=True,
        )
        results.append(AssertionResult(
            name=script.name,
            exit_code=proc.returncode,
            stdout=proc.stdout,
            stderr=proc.stderr,
        ))

    all_pass = all(r.passed for r in results)
    return results, all_pass
```

- [ ] **Step 4: Run tests; verify they pass**

```bash
uv run pytest tests/harness/test_assertions.py -v
```

Expected: all 5 tests pass.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
uv run ruff check harness/assertions.py tests/harness/test_assertions.py
uv run ty check harness/assertions.py
git add harness/assertions.py tests/harness/test_assertions.py
git commit -m "harness: assertions runner with bin/ on PATH and DRILL_WORKDIR"
```

---

### Task 8: Composer

Combine the Gauntlet verdict, assertion results, and (optional) external verifier verdict into a single final verdict per the fixed all-must-pass rule from the spec.

**Files:**
- Create: `harness/composer.py`
- Create: `tests/harness/test_composer.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/harness/test_composer.py
from harness.composer import FinalVerdict, compose
from harness.assertions import AssertionResult


class TestCompose:
    def test_all_pass(self):
        verdict = compose(
            gauntlet_status="pass",
            assertion_results=[AssertionResult("a", 0, "", "")],
            verifier_status="pass",
        )
        assert verdict.final == "pass"
        assert verdict.gauntlet == "pass"
        assert verdict.assertions == "pass"
        assert verdict.verifier == "pass"

    def test_gauntlet_fail_dominates(self):
        verdict = compose(
            gauntlet_status="fail",
            assertion_results=[AssertionResult("a", 0, "", "")],
            verifier_status=None,
        )
        assert verdict.final == "fail"
        assert verdict.assertions == "pass"

    def test_assertion_fail_dominates(self):
        verdict = compose(
            gauntlet_status="pass",
            assertion_results=[
                AssertionResult("a", 0, "", ""),
                AssertionResult("b", 1, "", "boom"),
            ],
            verifier_status=None,
        )
        assert verdict.final == "fail"
        assert verdict.assertions == "fail"

    def test_verifier_fail_dominates(self):
        verdict = compose(
            gauntlet_status="pass",
            assertion_results=[AssertionResult("a", 0, "", "")],
            verifier_status="fail",
        )
        assert verdict.final == "fail"
        assert verdict.verifier == "fail"

    def test_investigate_propagates(self):
        verdict = compose(
            gauntlet_status="investigate",
            assertion_results=[],
            verifier_status=None,
        )
        # Per spec: investigate is treated as fail for gating, but preserved
        # in the field so reviewers can see it.
        assert verdict.gauntlet == "investigate"
        assert verdict.final == "fail"

    def test_no_verifier_means_na(self):
        verdict = compose(
            gauntlet_status="pass",
            assertion_results=[],
            verifier_status=None,
        )
        assert verdict.verifier == "n/a"
        assert verdict.final == "pass"

    def test_serializable_to_dict(self):
        verdict = compose(
            gauntlet_status="pass",
            assertion_results=[AssertionResult("a", 0, "ok", "")],
            verifier_status=None,
        )
        d = verdict.to_dict()
        assert d["final"] == "pass"
        assert d["gauntlet"] == "pass"
        assert d["assertions"] == "pass"
        assert d["verifier"] == "n/a"
        assert d["assertion_details"] == [
            {"name": "a", "exit_code": 0, "stdout": "ok", "stderr": ""}
        ]
```

- [ ] **Step 2: Run tests; verify they fail**

```bash
uv run pytest tests/harness/test_composer.py -v
```

Expected: `ImportError`.

- [ ] **Step 3: Implement `harness/composer.py`**

```python
"""Combine Gauntlet, assertion, and (optional) verifier verdicts.

Composition is fixed: all-must-pass. There is no per-scenario rule. See
docs/gauntlet-migration.md "The Agent / Verifier question".
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Literal

from harness.assertions import AssertionResult

GauntletStatus = Literal["pass", "fail", "investigate"]
AssertionStatus = Literal["pass", "fail"]
VerifierStatus = Literal["pass", "fail", "n/a"]
FinalStatus = Literal["pass", "fail"]


@dataclass(frozen=True)
class FinalVerdict:
    gauntlet: GauntletStatus
    assertions: AssertionStatus
    verifier: VerifierStatus
    final: FinalStatus
    assertion_details: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def compose(
    *,
    gauntlet_status: GauntletStatus,
    assertion_results: list[AssertionResult],
    verifier_status: VerifierStatus | None,
) -> FinalVerdict:
    assertions: AssertionStatus = "pass" if all(r.passed for r in assertion_results) else "fail"
    verifier: VerifierStatus = verifier_status if verifier_status is not None else "n/a"
    final: FinalStatus = (
        "pass"
        if gauntlet_status == "pass" and assertions == "pass" and verifier in ("pass", "n/a")
        else "fail"
    )
    return FinalVerdict(
        gauntlet=gauntlet_status,
        assertions=assertions,
        verifier=verifier,
        final=final,
        assertion_details=[
            {"name": r.name, "exit_code": r.exit_code, "stdout": r.stdout, "stderr": r.stderr}
            for r in assertion_results
        ],
    )
```

- [ ] **Step 4: Run tests; verify they pass**

```bash
uv run pytest tests/harness/test_composer.py -v
```

Expected: all 7 tests pass.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
uv run ruff check harness/composer.py tests/harness/test_composer.py
uv run ty check harness/composer.py
git add harness/composer.py tests/harness/test_composer.py
git commit -m "harness: fixed all-must-pass composer for gauntlet+assertions+verifier"
```

---

### Task 9: Optional external verifier (deferred)

Spec calls for an optional second-pass LLM verifier. None of the three Phase 1 scenarios need it (their assertions are sufficient). Defer to Phase 2 when a scenario actually requires it.

**Action:** Mark as deferred in `docs/migration-notes.md` (created here for the first time):

- [ ] **Step 1: Write `docs/migration-notes.md`**

```markdown
# Migration Notes

Tracks decisions, deferrals, and skipped scenarios during the Drill→Gauntlet
migration. Reviewed before Phase 3 decommission.

## Phase 1 deferrals

- **External LLM verifier (`harness/verifier.py`)** — none of the three Phase 1
  scenarios (`triggering-writing-plans`, `worktree-already-inside`,
  `codex-subagent-wait-mapping`) require it. The composer already handles a
  `verifier_status=None` path. Build when the first Phase-2 scenario actually
  needs it; leaving it unimplemented keeps the harness lean and avoids
  speculative API design.

- **Token-cost wiring** — `harness/token_usage.py` is lifted from Drill but
  the runner doesn't yet call it. None of the three Phase 1 scenarios need
  cost data. Wire into the runner when the first cost-* scenario ports
  (Phase 2). The lifted module + tests sit ready.

- **`setup.sh` shell-out latency** — each ported scenario's `setup.sh`
  invokes `uv run python -c "..."` to call into `setup_helpers/`, costing
  ~600ms per run for uv resolve + interpreter startup. Acceptable in
  Phase 1 (3 scenarios, manual runs). Promote to a `setup_helpers run
  <name>` CLI in Phase 2 when sweep-N runs make it visible.

- **PATH inheritance in assertions** — `harness/assertions.run_assertions`
  prepends `bin_dir` onto the inherited `os.environ['PATH']`. Helper
  scripts assume `jq`, `python`, `git` are findable; on a clean CI runner
  this is not guaranteed. Document required tooling in the harness README
  before any CI integration.
```

- [ ] **Step 2: Commit**

```bash
git add docs/migration-notes.md
git commit -m "docs: defer external LLM verifier to phase 2 when needed"
```

---

### Task 10: Target prompt files

Two short markdown files that get passed to Gauntlet via `--project-prompt`. Their job is to teach the Gauntlet QA agent about target-specific busy patterns so it doesn't interrupt thinking blocks.

**Files:**
- Create: `harness/target_prompts/claude.md`
- Create: `harness/target_prompts/codex.md`

- [ ] **Step 1: Write `harness/target_prompts/claude.md`**

```markdown
# Target context: Claude Code CLI

The terminal application you are driving is Claude Code (the `claude` CLI).
It is itself an AI coding agent — you are the user; it is the agent under
test.

## Critical: do NOT type while Claude is busy

Claude shows continuous animated output when thinking or working:

- Spinner glyphs (⠇⠏⠋⠙⠹⠸⠼⠴⠦⠧⠶⠾⠽⠻⠿) cycle once per ~100ms.
- Status lines like "Thinking..." or "Cogitating..." with an elapsed-time
  counter that ticks every second.
- "(esc to cancel)" hint appears alongside busy indicators.

If ANY of these are visible, Claude is still working. Do not type. Do not
press Enter. Wait. Capture the screen again in a few seconds.

You may type only when:

- The screen shows a `❯` prompt at the start of a line, OR
- You see the literal string `Human:` at the start of a line, OR
- You see "Enter to confirm" and you intend to confirm.

## Shutdown

Type `/exit` and press Enter to end the session cleanly.
```

- [ ] **Step 2: Write `harness/target_prompts/codex.md`**

```markdown
# Target context: Codex CLI

The terminal application you are driving is Codex (the `codex` CLI). It is
itself an AI coding agent — you are the user; it is the agent under test.

## When you may type

You may type only when the screen shows a `›`, `codex>`, or `>` prompt at
the start of a line. If the cursor is anywhere else, Codex is still
working — wait and capture the screen again.

## Shutdown

Press Ctrl+D to end the session cleanly.
```

- [ ] **Step 3: Commit**

```bash
git add harness/target_prompts/
git commit -m "harness: per-target system prompts (busy patterns, shutdown)"
```

---

### Task 11: Runner orchestration

Glue everything together. One function that takes a scenario directory and a target manifest, runs the full per-run flow from the spec, and returns a final verdict + writes the evidence dir.

**Files:**
- Create: `harness/runner.py`
- Create: `tests/harness/test_runner.py`

**Behavior to test:** orchestration glue. Real Gauntlet invocation is stubbed; tests must additionally cover (a) the launch-cwd sentinel, (b) the empty-capture synthetic assertion, (c) the lockfile guard, (d) workdir kept on failure.

- [ ] **Step 1: Write the failing tests** (these test orchestration with a stubbed `gauntlet run` invocation)

```python
# tests/harness/test_runner.py
import json
import os
import stat
from pathlib import Path
from unittest.mock import patch

import pytest
import yaml

from harness.runner import RunnerError, run_scenario


def _write_exec(path: Path, body: str) -> None:
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _make_scenario(scenario_dir: Path, *, with_assertion_pass: bool = True) -> None:
    scenario_dir.mkdir(parents=True)
    (scenario_dir / "story.md").write_text("---\nid: x\ntitle: x\n---\nbody\n")
    _write_exec(
        scenario_dir / "setup.sh",
        "#!/usr/bin/env bash\necho ok > marker\n",
    )
    (scenario_dir / "target.yaml").write_text(yaml.safe_dump({
        "name": "fake",
        "target_command": "echo hi",
        "required_env": [],
        "session_log_dir": "/tmp/nonexistent-fake-dir",
        "session_log_glob": "*.jsonl",
        "normalizer": "claude",
    }))
    a = scenario_dir / "assertions"
    a.mkdir()
    _write_exec(
        a / "01-x.sh",
        f"#!/usr/bin/env bash\nexit {'0' if with_assertion_pass else '1'}\n",
    )


def _stub_gauntlet_pass(*args, **kwargs):
    """Replacement for invoke_gauntlet that returns a passing verdict."""
    evidence_dir = kwargs["evidence_dir"]
    (evidence_dir / "result.json").write_text(json.dumps({"status": "pass"}))
    return "pass"


def _stub_gauntlet_fail(*args, **kwargs):
    evidence_dir = kwargs["evidence_dir"]
    (evidence_dir / "result.json").write_text(json.dumps({"status": "fail"}))
    return "fail"


class TestRunScenario:
    def test_full_pass(self, tmp_path):
        scenario_dir = tmp_path / "scenarios" / "x"
        _make_scenario(scenario_dir)
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        out_root = tmp_path / "out"
        with patch("harness.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass):
            verdict = run_scenario(
                scenario_dir=scenario_dir,
                out_root=out_root,
                bin_dir=bin_dir,
            )
        assert verdict.final == "pass"
        assert verdict.gauntlet == "pass"
        assert verdict.assertions == "pass"
        # Evidence dir should contain the produced artifacts.
        runs = list(out_root.iterdir())
        assert len(runs) == 1
        ev = runs[0]
        assert (ev / "result.json").exists()
        assert (ev / "tool_calls.jsonl").exists()
        assert (ev / "verdict.json").exists()
        # Final verdict is persisted.
        persisted = json.loads((ev / "verdict.json").read_text())
        assert persisted["final"] == "pass"

    def test_assertion_fail_overrides_gauntlet_pass(self, tmp_path):
        scenario_dir = tmp_path / "scenarios" / "x"
        _make_scenario(scenario_dir, with_assertion_pass=False)
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        out_root = tmp_path / "out"
        with patch("harness.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass):
            verdict = run_scenario(
                scenario_dir=scenario_dir,
                out_root=out_root,
                bin_dir=bin_dir,
            )
        assert verdict.final == "fail"
        assert verdict.gauntlet == "pass"
        assert verdict.assertions == "fail"

    def test_setup_failure_aborts_before_gauntlet(self, tmp_path):
        scenario_dir = tmp_path / "scenarios" / "x"
        _make_scenario(scenario_dir)
        # Replace setup.sh with one that fails.
        _write_exec(
            scenario_dir / "setup.sh",
            "#!/usr/bin/env bash\nexit 9\n",
        )
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        out_root = tmp_path / "out"
        with patch("harness.runner.invoke_gauntlet") as mock_g:
            with pytest.raises(RunnerError, match="setup"):
                run_scenario(
                    scenario_dir=scenario_dir,
                    out_root=out_root,
                    bin_dir=bin_dir,
                )
            mock_g.assert_not_called()

    def test_launch_cwd_sentinel_overrides_workdir(self, tmp_path):
        scenario_dir = tmp_path / "scenarios" / "x"
        _make_scenario(scenario_dir)
        # Replace setup.sh with one that creates a sibling and writes the
        # sentinel pointing there.
        _write_exec(
            scenario_dir / "setup.sh",
            '#!/usr/bin/env bash\nset -e\n'
            'sib="${DRILL_WORKDIR}-sibling"\nmkdir -p "$sib"\n'
            'echo "$sib" > "${DRILL_WORKDIR}/.harness-launch-cwd"\n',
        )
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        out_root = tmp_path / "out"
        captured_cwd: dict[str, Path] = {}

        def stub(*args, **kwargs):
            captured_cwd["cwd"] = kwargs["launch_cwd"]
            evidence_dir = kwargs["evidence_dir"]
            (evidence_dir / "result.json").write_text(json.dumps({"status": "pass"}))
            return "pass"

        with patch("harness.runner.invoke_gauntlet", side_effect=stub):
            run_scenario(
                scenario_dir=scenario_dir,
                out_root=out_root,
                bin_dir=bin_dir,
            )
        # The sentinel pointed at the sibling, so launch_cwd should NOT be the workdir.
        assert captured_cwd["cwd"].name.endswith("-sibling")

    def test_empty_capture_inserts_synthetic_failed_assertion(self, tmp_path):
        scenario_dir = tmp_path / "scenarios" / "x"
        _make_scenario(scenario_dir)
        # Replace assertion with one named to look like a tool-related check.
        a_dir = scenario_dir / "assertions"
        for old in a_dir.iterdir():
            old.unlink()
        _write_exec(
            a_dir / "01-tool-called.sh",
            "#!/usr/bin/env bash\nexit 0\n",
        )
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        out_root = tmp_path / "out"
        with patch("harness.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass):
            verdict = run_scenario(
                scenario_dir=scenario_dir,
                out_root=out_root,
                bin_dir=bin_dir,
            )
        # capture_tool_calls created an empty file — synthetic assertion should fire.
        assert verdict.final == "fail"
        assert verdict.assertions == "fail"
        assert any(
            d["name"] == "00-non-empty-capture" for d in verdict.assertion_details
        )

    def test_lockfile_blocks_concurrent_runs(self, tmp_path, monkeypatch):
        # Point the manifest's session_log_dir at a tmp_path so we can pre-create the lock.
        scenario_dir = tmp_path / "scenarios" / "x"
        _make_scenario(scenario_dir)
        # Override target.yaml to use a session_log_dir we control.
        log_dir = tmp_path / "fake-log-root" / "child"
        log_dir.mkdir(parents=True)
        (scenario_dir / "target.yaml").write_text(yaml.safe_dump({
            "name": "fake",
            "target_command": "echo hi",
            "required_env": [],
            "session_log_dir": str(log_dir),
            "session_log_glob": "*.jsonl",
            "normalizer": "claude",
        }))
        # Pre-create the lockfile.
        lock_root = log_dir.parent
        (lock_root / ".harness-run.lock").write_text("pid=99999\n")
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        out_root = tmp_path / "out"
        with patch("harness.runner.invoke_gauntlet"):
            with pytest.raises(RunnerError, match="lock"):
                run_scenario(
                    scenario_dir=scenario_dir,
                    out_root=out_root,
                    bin_dir=bin_dir,
                )

    def test_workdir_kept_on_failure(self, tmp_path):
        scenario_dir = tmp_path / "scenarios" / "x"
        _make_scenario(scenario_dir, with_assertion_pass=False)
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        out_root = tmp_path / "out"
        with patch("harness.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass):
            verdict = run_scenario(
                scenario_dir=scenario_dir,
                out_root=out_root,
                bin_dir=bin_dir,
            )
        assert verdict.final == "fail"
        # Evidence dir should record where the workdir was kept.
        runs = list(out_root.iterdir())
        wd_path = (runs[0] / "workdir-path.txt").read_text().strip()
        assert Path(wd_path).exists(), f"workdir at {wd_path} should be retained on failure"
```

- [ ] **Step 2: Run tests; verify they fail**

```bash
uv run pytest tests/harness/test_runner.py -v
```

Expected: `ImportError`.

- [ ] **Step 3: Implement `harness/runner.py`**

```python
"""Per-run orchestration. One scenario, one target, one verdict.

Single-run-at-a-time only in Phase 1. Multiple harness processes against the
same target's session-log dir will cross-contaminate via snapshot/diff. The
runner enforces this with a sentinel lockfile and refuses to start if one
exists.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

from harness.assertions import AssertionResult, run_assertions
from harness.capture import capture_tool_calls, snapshot_dir
from harness.composer import FinalVerdict, compose
from harness.manifest import Manifest, load_manifest
from harness.setup_step import SetupError, run_setup

LAUNCH_CWD_SENTINEL = ".harness-launch-cwd"
LOCK_FILENAME = ".harness-run.lock"


class RunnerError(RuntimeError):
    """Raised when a non-recoverable error stops the run before composition."""


def _gauntlet_status_from_result(evidence_dir: Path) -> str:
    result_path = evidence_dir / "result.json"
    if not result_path.exists():
        return "investigate"
    try:
        return json.loads(result_path.read_text()).get("status", "investigate")
    except (OSError, json.JSONDecodeError):
        return "investigate"


@contextmanager
def _single_run_lock(session_log_dir: Path):
    """Enforce one-harness-run-at-a-time per session-log root.

    Lockfile lives in session_log_dir.parent so it persists if session_log_dir
    itself is the agent CLI's auto-created tree. We bail loudly if locked —
    silent waiting would mask concurrency issues we want surfaced.
    """
    lock_root = session_log_dir.parent if session_log_dir.parent.exists() else Path.home()
    lock_path = lock_root / LOCK_FILENAME
    if lock_path.exists():
        raise RunnerError(
            f"Another harness run appears active (lock at {lock_path}). "
            "Phase 1 does not support concurrent runs against the same target. "
            "Remove the lockfile if you're sure no other run is in progress."
        )
    try:
        lock_path.write_text(f"pid={os.getpid()}\nstarted={time.time()}\n")
        yield
    finally:
        try:
            lock_path.unlink()
        except FileNotFoundError:
            pass


def _resolve_launch_cwd(workdir: Path) -> Path:
    """Read .harness-launch-cwd if setup.sh wrote one; else return workdir."""
    sentinel = workdir / LAUNCH_CWD_SENTINEL
    if sentinel.exists():
        path = Path(sentinel.read_text().strip())
        if not path.exists():
            raise RunnerError(
                f"setup.sh wrote {LAUNCH_CWD_SENTINEL}={path} but that path doesn't exist"
            )
        return path
    return workdir


def invoke_gauntlet(
    *,
    story_path: Path,
    target_command: str,
    launch_cwd: Path,
    evidence_dir: Path,
    target_prompt: Path | None,
    max_time: str | None,
) -> str:
    """Invoke `gauntlet run` as a subprocess. Returns the verdict status string.

    Wraps target_command with `cd <launch_cwd> && ...` so the agent under test
    starts in the correct cwd (Drill's workdir_override behavior). Gauntlet's
    TUI adapter spawns the target via tmux from the gauntlet process's cwd, so
    we encode the cwd shift into the command itself.

    Stubbed in tests to avoid real LLM calls.
    """
    wrapped = f"cd {launch_cwd!s} && {target_command}"
    cmd = [
        "gauntlet", "run", str(story_path),
        "--adapter", "tui",
        "--target", wrapped,
        "--out", str(evidence_dir),
        "--silent",
    ]
    if max_time:
        cmd += ["--max-time", max_time]
    if target_prompt is not None:
        cmd += ["--project-prompt", str(target_prompt)]
    subprocess.run(cmd, check=False)  # don't raise on non-zero — verdict is in result.json
    return _gauntlet_status_from_result(evidence_dir)


def _has_tool_assertions(assertions_dir: Path) -> bool:
    """Heuristic: scenario cares about tool calls iff any assertion's name or
    body references a tool helper. Cheap signal — we check filename for now.
    """
    if not assertions_dir.exists():
        return False
    indicators = ("tool", "skill")
    return any(
        any(ind in p.name.lower() for ind in indicators)
        for p in assertions_dir.iterdir()
        if p.is_file()
    )


def _empty_capture_synthetic_assertion(tool_calls_path: Path) -> AssertionResult | None:
    """If tool_calls.jsonl is empty AND scenario expects tool calls,
    inject a failing synthetic assertion so the verdict reflects it.

    Mirrors drill/engine.py:169–178.
    """
    if not tool_calls_path.exists() or tool_calls_path.stat().st_size == 0:
        return AssertionResult(
            name="00-non-empty-capture",
            exit_code=1,
            stdout="",
            stderr=(
                f"FAIL: {tool_calls_path.name} is empty. "
                "Either the agent session crashed before any tool calls, "
                "or the per-target capture missed them. Investigate "
                "session-log dir and normalizer config."
            ),
        )
    return None


def run_scenario(
    *,
    scenario_dir: Path,
    out_root: Path,
    bin_dir: Path,
) -> FinalVerdict:
    manifest = load_manifest(scenario_dir / "target.yaml")
    story_path = scenario_dir / "story.md"
    if not story_path.exists():
        raise RunnerError(f"{scenario_dir}: story.md missing")

    timestamp = time.strftime("%Y%m%dT%H%M%S")
    evidence_dir = out_root / f"{scenario_dir.name}-{manifest.name}-{timestamp}"
    evidence_dir.mkdir(parents=True, exist_ok=True)

    workdir = Path(tempfile.mkdtemp(prefix="harness-wd-"))
    workdir_kept = False
    try:
        with _single_run_lock(manifest.session_log_dir):
            # 1. Setup (mutate workdir; fail-fast on non-zero)
            try:
                run_setup(scenario_dir, workdir, env_extra={})
            except SetupError as e:
                raise RunnerError(f"setup failed: {e}") from e

            # 2. Resolve launch cwd (defaults to workdir; setup.sh may override)
            launch_cwd = _resolve_launch_cwd(workdir)

            # 3. Snapshot the agent's session-log dir
            snap = snapshot_dir(manifest.session_log_dir, manifest.session_log_glob)

            # 4. Invoke Gauntlet
            gauntlet_status = invoke_gauntlet(
                story_path=story_path,
                target_command=manifest.target_command,
                launch_cwd=launch_cwd,
                evidence_dir=evidence_dir,
                target_prompt=manifest.target_prompt,
                max_time=manifest.max_time,
            )

            # 5. Capture + normalize tool calls into the evidence dir
            tool_calls_path = capture_tool_calls(
                log_dir=manifest.session_log_dir,
                log_glob=manifest.session_log_glob,
                snapshot=snap,
                normalizer=manifest.normalizer,
                evidence_dir=evidence_dir,
                workdir=workdir,
            )

            # 6. Run scenario assertions
            results, _ = run_assertions(
                assertions_dir=scenario_dir / "assertions",
                evidence_dir=evidence_dir,
                workdir=workdir,
                bin_dir=bin_dir,
            )

            # 6b. Empty-capture parity guard (Drill engine.py:169–178)
            if _has_tool_assertions(scenario_dir / "assertions"):
                synthetic = _empty_capture_synthetic_assertion(tool_calls_path)
                if synthetic is not None:
                    results = [synthetic, *results]

            # 7. Compose final verdict (verifier deferred — pass None)
            verdict = compose(
                gauntlet_status=gauntlet_status,  # type: ignore[arg-type]
                assertion_results=results,
                verifier_status=None,
            )

            # 8. Persist
            (evidence_dir / "verdict.json").write_text(
                json.dumps(verdict.to_dict(), indent=2)
            )
            if verdict.final != "pass":
                # Keep workdir on failure for debugging.
                workdir_kept = True
                (evidence_dir / "workdir-path.txt").write_text(str(workdir))
            return verdict
    finally:
        if not workdir_kept:
            shutil.rmtree(workdir, ignore_errors=True)
```

- [ ] **Step 4: Run tests; verify they pass**

```bash
uv run pytest tests/harness/test_runner.py -v
```

Expected: all 7 tests pass (3 happy-path + 4 added for sentinel/lock/empty-capture/workdir-keep).

- [ ] **Step 5: Lint, typecheck, commit**

```bash
uv run ruff check harness/runner.py tests/harness/test_runner.py
uv run ty check harness/runner.py
git add harness/runner.py tests/harness/test_runner.py
git commit -m "harness: per-run orchestrator with stubbed gauntlet invocation"
```

---

### Task 12: CLI

Thin click CLI exposing `harness run <scenario-dir>` and `harness list`.

**Files:**
- Create: `harness/cli.py`
- Create: `tests/harness/test_cli.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/harness/test_cli.py
from pathlib import Path
from unittest.mock import patch

from click.testing import CliRunner

from harness.cli import main


def test_list_finds_scenario_dirs(tmp_path):
    scenarios = tmp_path / "scenarios"
    (scenarios / "alpha").mkdir(parents=True)
    (scenarios / "alpha" / "story.md").write_text("---\nid: alpha\n---\n")
    (scenarios / "beta").mkdir()
    (scenarios / "beta" / "story.md").write_text("---\nid: beta\n---\n")
    (scenarios / "not-a-scenario").mkdir()  # no story.md — skipped
    runner = CliRunner()
    result = runner.invoke(main, ["list", "--scenarios-root", str(scenarios)])
    assert result.exit_code == 0
    assert "alpha" in result.output
    assert "beta" in result.output
    assert "not-a-scenario" not in result.output


def test_run_invokes_run_scenario(tmp_path):
    runner = CliRunner()
    with patch("harness.cli.run_scenario") as mock:
        mock.return_value.final = "pass"
        mock.return_value.to_dict.return_value = {"final": "pass"}
        result = runner.invoke(main, [
            "run", str(tmp_path / "fake-scenario"),
            "--out-root", str(tmp_path / "out"),
            "--bin-dir", str(tmp_path / "bin"),
        ])
        assert result.exit_code == 0
        mock.assert_called_once()
```

- [ ] **Step 2: Run tests; verify they fail**

```bash
uv run pytest tests/harness/test_cli.py -v
```

Expected: `ImportError`.

- [ ] **Step 3: Implement `harness/cli.py`**

```python
"""click CLI: harness run, harness list."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import click

from harness.runner import run_scenario


# TODO(phase-3): When Drill is decommissioned and harness scenarios move to the
# top-level `scenarios/` directory, change this default.
_DEFAULT_SCENARIOS_ROOT = Path("harness/scenarios")
_DEFAULT_OUT_ROOT = Path("results")
_DEFAULT_BIN_DIR = Path("bin")


@click.group()
def main() -> None:
    """Eval harness wrapping Gauntlet for skill-compliance benchmarks."""


@main.command("run")
@click.argument("scenario_dir", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("--out-root", default=_DEFAULT_OUT_ROOT, type=click.Path(path_type=Path),
              help="Where to write the per-run evidence dir")
@click.option("--bin-dir", default=_DEFAULT_BIN_DIR, type=click.Path(path_type=Path),
              help="Directory containing assertion helpers (skill-called, etc)")
def run(scenario_dir: Path, out_root: Path, bin_dir: Path) -> None:
    """Run one scenario with its declared target."""
    out_root.mkdir(parents=True, exist_ok=True)
    verdict = run_scenario(
        scenario_dir=scenario_dir,
        out_root=out_root,
        bin_dir=bin_dir,
    )
    click.echo(json.dumps(verdict.to_dict(), indent=2))
    sys.exit(0 if verdict.final == "pass" else 1)


@main.command("list")
@click.option("--scenarios-root", default=_DEFAULT_SCENARIOS_ROOT,
              type=click.Path(exists=True, file_okay=False, path_type=Path))
def list_scenarios(scenarios_root: Path) -> None:
    """List scenarios under scenarios-root."""
    found = sorted(
        d.name for d in scenarios_root.iterdir()
        if d.is_dir() and (d / "story.md").exists()
    )
    for name in found:
        click.echo(name)
```

- [ ] **Step 4: Run tests; verify they pass**

```bash
uv run pytest tests/harness/test_cli.py -v
```

Expected: 2 tests pass.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
uv run ruff check harness/cli.py tests/harness/test_cli.py
uv run ty check harness/cli.py
git add harness/cli.py tests/harness/test_cli.py
git commit -m "harness: click CLI with run and list subcommands"
```

---

### Task 13: Convert scenario 1 — `triggering-writing-plans`

The smallest end-to-end parity test. One turn, one assertion. Does not require a setup helper beyond initializing a base repo.

**Files:**
- Create: `harness/scenarios/triggering-writing-plans/story.md`
- Create: `harness/scenarios/triggering-writing-plans/setup.sh`
- Create: `harness/scenarios/triggering-writing-plans/target.yaml`
- Create: `harness/scenarios/triggering-writing-plans/assertions/01-skill-called.sh`

Reference the original Drill scenario in `scenarios/triggering-writing-plans.yaml` and the `create_base_repo` helper in `setup_helpers/base.py`.

- [ ] **Step 1: Write `story.md` (rewritten per writing-gauntlet-stories)**

```markdown
---
id: triggering-writing-plans
title: Agent loads writing-plans skill before implementing a multi-step spec
status: ready
tags: skill-triggering
---

You are an engineer handing the agent a multi-step authentication spec.
Type this exact message at the agent's prompt and press Enter — do not
paraphrase, do not shorten:

"Here's the spec for our new authentication system:

Requirements:
- Users can register with email/password
- Users can log in and receive a JWT token
- Protected routes require valid JWT
- Tokens expire after 24 hours
- Support password reset via email

We need to implement this. There are multiple steps involved - user
model, auth routes, middleware, email service integration."

Do NOT mention plans, writing a plan, decomposition, or any superpowers
concept in your message. Once the agent loads a skill or starts planning
or decomposing the work, you are done.

## Acceptance Criteria

- The agent loaded the `superpowers:writing-plans` skill before writing
  any implementation code.
```

- [ ] **Step 2: Write `setup.sh`**

This scenario uses `create_base_repo`. Rather than re-implementing it in shell, call into the existing Python helper from a wrapper script:

```bash
#!/usr/bin/env bash
set -euo pipefail
# DRILL_WORKDIR is the temp scenario workdir set by harness.setup_step.
# Reuse the existing setup_helpers package to keep helpers in one place
# until Phase 3 lifts them.
exec uv run python -c "
import os, pathlib
from setup_helpers.base import create_base_repo
create_base_repo(pathlib.Path(os.environ['DRILL_WORKDIR']))
"
```

```bash
chmod +x harness/scenarios/triggering-writing-plans/setup.sh
```

- [ ] **Step 3: Write `target.yaml`**

```yaml
name: claude
target_command: |
  claude --dangerously-skip-permissions --plugin-dir ${SUPERPOWERS_ROOT} --model opus
required_env:
  - ANTHROPIC_API_KEY
  - SUPERPOWERS_ROOT
session_log_dir: ~/.claude/projects
session_log_glob: "**/session-*.jsonl"
normalizer: claude
target_prompt: harness/target_prompts/claude.md
max_time: 5m
```

- [ ] **Step 4: Write `assertions/01-skill-called.sh`**

```bash
#!/usr/bin/env bash
# Wraps the bin/skill-called helper for this scenario.
set -euo pipefail
exec skill-called superpowers:writing-plans
```

```bash
chmod +x harness/scenarios/triggering-writing-plans/assertions/01-skill-called.sh
```

- [ ] **Step 5: Sanity-check scenario discovery**

```bash
uv run harness list --scenarios-root harness/scenarios
```

Expected: prints `triggering-writing-plans`.

- [ ] **Step 6: Commit**

```bash
git add harness/scenarios/triggering-writing-plans/
git commit -m "scenarios: port triggering-writing-plans to harness format"
```

---

### Task 14: Parity run — scenario 1

Run both Drill's version and the harness version against the same backend, compare.

This is a **manual-execution task** — it requires `ANTHROPIC_API_KEY` and a Claude Code install. The implementer must run it interactively and document outcomes; do not attempt to automate it in CI.

- [ ] **Step 1: Run the Drill version**

```bash
export ANTHROPIC_API_KEY=...
export SUPERPOWERS_ROOT=/path/to/superpowers
uv run drill run triggering-writing-plans -b claude
```

Note the result location (something under `results/triggering-writing-plans/claude/<timestamp>/`).
Note the contents of `tool_calls.jsonl`, the verdict, and which assertions passed.

- [ ] **Step 2: Run the harness version**

```bash
uv run harness run harness/scenarios/triggering-writing-plans \
  --out-root results-harness
```

Expected: command exits with status 0; `verdict.json` shows `final: pass`.

- [ ] **Step 3: Compare**

```bash
diff <(jq -S . results/triggering-writing-plans/claude/<ts>/tool_calls.jsonl) \
     <(jq -S . results-harness/triggering-writing-plans-claude-<ts>/tool_calls.jsonl)
```

Expected: byte-for-byte identical, OR documented divergence (e.g. ordering differences from filesystem walk order — acceptable).

- [ ] **Step 4: Document outcome in `docs/migration-notes.md`**

Append a section:

```markdown
## Phase 1 parity: triggering-writing-plans

- Drill verdict: <pass|fail>
- Harness verdict: <pass|fail>
- tool_calls.jsonl: <byte-equivalent | acceptable-divergence: ...>
- Notes: <anything observed>
```

- [ ] **Step 5: Commit notes**

```bash
git add docs/migration-notes.md
git commit -m "docs: phase 1 parity outcome for triggering-writing-plans"
```

---

### Task 15: Convert scenario 2 — `worktree-already-inside`

Exercises a multi-helper setup and the workdir-override pattern. The original scenario uses `create_base_repo` + `add_existing_worktree` + a `workdir_override` that points the agent at the existing worktree subdir.

**Files:**
- Create: `harness/scenarios/worktree-already-inside/{story.md, setup.sh, target.yaml, assertions/}`

Reference the original `scenarios/worktree-already-inside.yaml` and `setup_helpers/worktree.py:add_existing_worktree`.

- [ ] **Step 1: Write `story.md` (rewritten outcome-shaped)**

```markdown
---
id: worktree-already-inside
title: Agent doesn't create a new worktree when already inside one
status: ready
tags: worktree
---

You are an engineer working in an existing feature branch worktree. You
ask the agent (in plain language, no superpowers vocabulary) to create
an isolated workspace for building a signup feature. You only have one
turn — once the agent answers, you're done.

## Acceptance Criteria

- After the run, no new worktree was added beyond the one that existed
  at setup (still exactly two worktrees: main + the existing-feature
  worktree).
- The agent communicated, in its response, that the current worktree
  is already isolated and sufficient.
```

- [ ] **Step 2: Write `setup.sh`** — wraps two Python helpers and emits the launch-cwd sentinel so the runner launches the agent *inside* the existing-worktree subdir (matching Drill's `workdir_override` behavior)

```bash
#!/usr/bin/env bash
set -euo pipefail
uv run python -c "
import os, pathlib
from setup_helpers.base import create_base_repo
from setup_helpers.worktree import add_existing_worktree
wd = pathlib.Path(os.environ['DRILL_WORKDIR'])
create_base_repo(wd)
add_existing_worktree(wd)
"
# Drill's workdir_override pointed the agent at the sibling existing-worktree
# directory; matched here via the .harness-launch-cwd sentinel. setup_helpers/
# worktree.py:add_existing_worktree creates ${DRILL_WORKDIR}-existing-worktree
# as a sibling — point the runner at it.
echo "${DRILL_WORKDIR}-existing-worktree" > "${DRILL_WORKDIR}/.harness-launch-cwd"
```

This recovers parity with Drill — the agent starts in the existing-worktree subdir, exactly as the original scenario intended. The acceptance criterion ("agent recognizes its current cwd is already a worktree") is preserved unchanged.

```bash
chmod +x harness/scenarios/worktree-already-inside/setup.sh
```

- [ ] **Step 3: Write `target.yaml`** (same shape as Task 13, max_time bumped to 10m for worktree turns):

```yaml
name: claude
target_command: |
  claude --dangerously-skip-permissions --plugin-dir ${SUPERPOWERS_ROOT} --model opus
required_env:
  - ANTHROPIC_API_KEY
  - SUPERPOWERS_ROOT
session_log_dir: ~/.claude/projects
session_log_glob: "**/session-*.jsonl"
normalizer: claude
target_prompt: harness/target_prompts/claude.md
max_time: 10m
```

- [ ] **Step 4: Write `assertions/01-no-new-worktree.sh`**

```bash
#!/usr/bin/env bash
# Pass iff there are still exactly 2 worktrees (main + existing-feature).
set -euo pipefail
COUNT=$(cd "$DRILL_WORKDIR" && git worktree list | wc -l | tr -d ' ')
if [ "$COUNT" = "2" ]; then
    echo "PASS: 2 worktrees (no new one created)"
    exit 0
else
    echo "FAIL: expected 2 worktrees, found $COUNT"
    cd "$DRILL_WORKDIR" && git worktree list
    exit 1
fi
```

```bash
chmod +x harness/scenarios/worktree-already-inside/assertions/01-no-new-worktree.sh
```

- [ ] **Step 5: Commit scenario**

```bash
git add harness/scenarios/worktree-already-inside/
git commit -m "scenarios: port worktree-already-inside (launch-cwd sentinel preserves workdir_override behavior)"
```

---

### Task 16: Parity run — scenario 2

Same shape as Task 14: run Drill, run harness, compare, document.

- [ ] **Step 1–3: Run both, diff tool_calls.jsonl, document outcome.** Use the same commands as Task 14, substituting the scenario name.

- [ ] **Step 4: If verdicts diverge,** investigate before committing. Likely culprits: (a) workdir-override divergence affecting the agent's behavior; (b) prompt-augmentation insufficient (agent typed during a thinking block — see spec Risks).

- [ ] **Step 5: Commit notes** (same as Task 14 step 5).

---

### Task 17: Convert scenario 3 — `codex-subagent-wait-mapping`

Exercises the Codex normalizer and its cwd-filter logic — the most likely place for per-target capture to break.

**Files:**
- Create: `harness/scenarios/codex-subagent-wait-mapping/{story.md, setup.sh, target.yaml, assertions/}`

Reference original `scenarios/codex-subagent-wait-mapping.yaml`.

- [ ] **Step 1: Write `story.md`** (lifted from the original turn intent, kept verbatim because the turn is highly prescriptive on purpose — the test relies on the agent reading the mapping file rather than guessing)

```markdown
---
id: codex-subagent-wait-mapping
title: Codex agent uses wait_agent (not wait) when collecting subagent results
status: ready
tags: codex, tool-mapping
---

You are an engineer testing whether the Codex agent follows the
Superpowers tool-mapping reference. When Codex shows its input prompt,
type this exact message and press Enter — do not paraphrase, do not
shorten:

"Read .agents/skills/superpowers/using-superpowers/references/codex-tools.md.
Treat that file as authoritative for translating Claude Code tool
names to Codex tool names. Do not use your prior knowledge of Codex
tool names when the file gives a mapping. Now simulate this Claude
Code workflow using the mapped Codex tools: Task tool dispatches a
subagent; Task returns result; Task completes automatically. The
subagent's whole job is to answer exactly PR963_OK. Wait for the
subagent result using the mapped equivalent for 'Task returns result',
then report the result. Do not edit files."

If the agent asks a short clarifying question, answer briefly and
tell it to follow the mapping file. Once it reports PR963_OK or says
it cannot complete the mapped wait step, you are done.

## Acceptance Criteria

- The agent invoked `spawn_agent` (the Codex subagent-spawn tool).
- The agent invoked `wait_agent` (the mapped equivalent of "Task returns
  result") to collect the subagent's output.
- The agent did NOT invoke the bare `wait` tool.
- `spawn_agent` was invoked before `wait_agent` (correct ordering).
```

- [ ] **Step 2: Write `setup.sh`** (uses the no-hooks pattern — original scenario used `codex-no-hooks` backend):

```bash
#!/usr/bin/env bash
set -euo pipefail
uv run python -c "
import os, pathlib
from setup_helpers.base import create_base_repo
from setup_helpers.worktree import symlink_superpowers
wd = pathlib.Path(os.environ['DRILL_WORKDIR'])
create_base_repo(wd)
symlink_superpowers(wd, os.environ['SUPERPOWERS_ROOT'])
"
```

```bash
chmod +x harness/scenarios/codex-subagent-wait-mapping/setup.sh
```

- [ ] **Step 3: Write `target.yaml`** (Codex no-hooks variant — uses the symlink path, not the plugin-hook isolated CODEX_HOME):

```yaml
name: codex-no-hooks
target_command: codex --dangerously-bypass-approvals-and-sandbox
required_env:
  - OPENAI_API_KEY
  - SUPERPOWERS_ROOT
session_log_dir: ~/.codex/sessions
session_log_glob: "rollout-*.jsonl"
normalizer: codex
target_prompt: harness/target_prompts/codex.md
max_time: 10m
```

- [ ] **Step 4: Write four assertions**

```bash
# 01-spawn-agent-called.sh
#!/usr/bin/env bash
exec tool-called spawn_agent
```

```bash
# 02-wait-agent-called.sh
#!/usr/bin/env bash
exec tool-called wait_agent
```

```bash
# 03-wait-not-called.sh
#!/usr/bin/env bash
exec tool-not-called wait
```

```bash
# 04-spawn-before-wait.sh
#!/usr/bin/env bash
exec tool-before spawn_agent wait_agent
```

```bash
chmod +x harness/scenarios/codex-subagent-wait-mapping/assertions/*.sh
```

- [ ] **Step 5: Commit**

```bash
git add harness/scenarios/codex-subagent-wait-mapping/
git commit -m "scenarios: port codex-subagent-wait-mapping (exercises codex normalizer)"
```

---

### Task 18: Parity run — scenario 3

Same shape as Tasks 14 and 16. Critical: this is the first scenario to actually run the Codex normalizer + cwd-filter end-to-end. If `tool_calls.jsonl` is empty when the Drill version captures rows, the cwd-filter step is the most likely culprit.

- [ ] **Step 1–5: Run both, diff, document.** Pay special attention to: does `tool_calls.jsonl` contain rows? Are the tool names normalized correctly (`spawn_agent`, `wait_agent`)?

---

### Task 19: Full Phase 1 verification

Run all three harness scenarios sequentially. Verify:
- All three pass independently (per their own verdicts).
- Drill versions also pass (parity).
- `migration-notes.md` documents every accepted divergence.

- [ ] **Step 1: Run all three harness scenarios**

```bash
for s in triggering-writing-plans worktree-already-inside codex-subagent-wait-mapping; do
    echo "=== $s ==="
    uv run harness run "harness/scenarios/$s" --out-root results-harness || echo "FAILED: $s"
done
```

- [ ] **Step 2: Run all three Drill scenarios**

```bash
for s in triggering-writing-plans worktree-already-inside codex-subagent-wait-mapping; do
    echo "=== $s ==="
    backend=claude
    [ "$s" = codex-subagent-wait-mapping ] && backend=codex-no-hooks
    uv run drill run "$s" -b "$backend"
done
```

- [ ] **Step 3: Append a Phase-1 status section to `docs/migration-notes.md`**

```markdown
## Phase 1 status

| Scenario | Drill verdict | Harness verdict | tool_calls.jsonl parity | Divergences |
|----------|---------------|-----------------|-------------------------|-------------|
| triggering-writing-plans | <pass\|fail> | <pass\|fail> | <byte\|schema\|none> | … |
| worktree-already-inside | <pass\|fail> | <pass\|fail> | <byte\|schema\|none> | workdir_override path |
| codex-subagent-wait-mapping | <pass\|fail> | <pass\|fail> | <byte\|schema\|none> | … |

Phase 1 verdict: <ready-for-phase-2 | needs-rework — reason>
```

- [ ] **Step 4: Run the entire test suite to confirm no regressions in Drill**

```bash
uv run pytest -v
```

Expected: all pre-existing tests still pass plus the new harness tests.

- [ ] **Step 5: Commit final phase-1 status**

```bash
git add docs/migration-notes.md
git commit -m "docs: phase 1 status — three-scenario parity outcome"
```

---

### Task 20: Update README and CLAUDE.md to introduce the harness

The repo's README and CLAUDE.md currently describe only Drill. Add a brief harness section so the next person opening the repo sees both tools and knows which is which.

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add a "Harness (in-progress migration)" section to `README.md`**

Add after the existing "How Drill Works" section, before "Setup":

```markdown
## Harness (Drill → Gauntlet migration in progress)

`harness/` is a new Python harness that wraps the
[Gauntlet](../gauntlet) QA framework to reproduce Drill's eval-lab
capabilities. It owns workdir setup, agent-under-test session-log
capture, and deterministic assertions; Gauntlet owns the agent loop
and screen-side verdict.

Phase 1 (this work) ports three representative scenarios. Phase 2
ports the rest. Phase 3 deletes Drill. See
[`docs/gauntlet-migration.md`](docs/gauntlet-migration.md) for the
spec and [`docs/migration-notes.md`](docs/migration-notes.md) for
running notes.

Run a harness scenario:

```bash
uv run harness run harness/scenarios/triggering-writing-plans
uv run harness list
```
```

- [ ] **Step 2: Add a brief harness command set to `CLAUDE.md`**

Add a new `## Harness commands` section after the existing `## Commands` section:

```markdown
## Harness commands

- **run scenario**: `uv run harness run harness/scenarios/<name>`
- **list**: `uv run harness list`

The harness lives in `harness/` and replaces Drill incrementally — see
`docs/gauntlet-migration.md`.
```

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: introduce harness in README and CLAUDE.md"
```

---

## Self-Review

**Spec coverage** — every section of `docs/gauntlet-migration.md` mapped to tasks:

| Spec section | Plan task(s) |
|---|---|
| Three real gaps: workdir setup | Task 6 (setup_step), Tasks 13/15/17 (setup.sh per scenario) |
| Three real gaps: log capture+normalization | Tasks 2 (normalizers), 5 (capture), 11 (runner glue) |
| Three real gaps: deterministic assertions | Task 7 (assertions runner), 13/15/17 (per-scenario assertions) |
| Agent/Verifier decision (B+C, deferred) | Task 9 (deferred verifier), Task 8 (composer handles None) |
| Composition rule (all-must-pass, fixed) | Task 8 (composer) |
| Per-target prompt augmentation | Task 10 (target_prompts), Task 4 (manifest passes through) |
| Phase 1 = three scenarios | Tasks 13, 15, 17 |
| Forcing function (migration-notes.md) | Tasks 9, 14, 15, 16, 18, 19 |
| Token-cost capture | Task 3 (lifted) — note: not yet wired into runner; flagged as Phase 2 work |
| Idle-detection mitigation (stage 1) | Task 10 (target prompts) |

**Gaps identified during self-review:**

- Task 3 lifts token capture but the runner doesn't call it. That's intentional for Phase 1 (the three Phase 1 scenarios don't need cost data) but should be flagged. **Adding to QUESTIONS.md as a deferred question.**

- The `harness/scenarios/worktree-already-inside/setup.sh` accepts a behavioral divergence from Drill's `workdir_override`. This is an honest acknowledgment but Matt should bless the divergence before it ships. **Adding to QUESTIONS.md.**

- The CLI's `harness run` exit code is 0/1 only. Drill writes a richer status. Phase 1 minimal-CLI is fine; promote on demand.

**Placeholder scan:** none of the red-flag patterns ("TBD", "implement later", "add appropriate error handling") found.

**Type consistency:** `FinalVerdict.gauntlet` is `Literal["pass", "fail", "investigate"]` and Task 11 passes through whatever Gauntlet wrote in `result.json`. Task 8 covers all three values in tests.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-14-gauntlet-migration-phase-1.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Awaiting Matt's morning review of the spec, plan, and `QUESTIONS.md` before execution.**
