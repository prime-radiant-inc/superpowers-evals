# Gauntlet Migration Phase 1 — Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Python harness in `superpowers-evals/harness/` that wraps Gauntlet to reproduce Drill's eval-lab capability — workdir setup, agent-under-test session-log capture, deterministic AC-regression assertions — and prove parity with Drill on three representative scenarios.

**Architecture:** A new `harness/` package lives alongside `drill/`. Per-target config (binary, log path, normalizer, required env) lives once in `harness/targets/<name>.yaml`; per-target HOWTO context in `harness/target_contexts/<name>/`. Scenarios are target-agnostic by default — `scenarios/<name>/{story.md, setup.sh, assertions/*.sh}` plus an optional `scenario.yaml` for target-specific scenarios. The harness invokes `gauntlet run` as a subprocess from a per-run scratch dir that doubles as Gauntlet's `--project-dir`.

**Tech Stack:** Python 3.11+, uv, click, pyyaml, pytest. Lifts `drill/normalizer.py` and `drill/token_capture.py` near-verbatim. Reuses `bin/*` assertion scripts unchanged. Subprocess-invokes the externally-installed `gauntlet` CLI.

**Spec reference:** `docs/gauntlet-migration.md` (v2)

---

## File Structure

```
superpowers-evals/
├── harness/                          # NEW
│   ├── __init__.py
│   ├── cli.py                        # click CLI: run, list
│   ├── runner.py                     # per-run orchestration
│   ├── target_config.py              # load harness/targets/<name>.yaml
│   ├── scenario_config.py            # load optional scenarios/<n>/scenario.yaml
│   ├── setup_step.py                 # run setup.sh
│   ├── capture.py                    # snapshot/diff/normalize session logs
│   ├── normalizers.py                # lifted from drill/normalizer.py
│   ├── token_usage.py                # lifted from drill/token_capture.py
│   ├── assertions.py                 # run assertions/*.sh
│   ├── composer.py                   # gauntlet + assertions → verdict
│   ├── targets/                      # one yaml per agent CLI
│   │   ├── claude.yaml
│   │   └── codex.yaml
│   └── target_contexts/              # one dir per agent CLI
│       ├── claude/
│       │   └── HOWTO.md              # 5-line invocation + log path + /exit
│       └── codex/
│           └── HOWTO.md
├── harness/scenarios/                # NEW — directory-format scenarios
│   ├── triggering-writing-plans/
│   │   ├── story.md
│   │   ├── setup.sh
│   │   └── assertions/
│   │       └── 01-skill-called.sh
│   ├── worktree-already-inside/
│   │   ├── story.md
│   │   ├── setup.sh
│   │   └── assertions/
│   │       └── 01-no-new-worktree.sh
│   └── codex-subagent-wait-mapping/
│       ├── story.md
│       ├── scenario.yaml             # declares compatible_targets: codex
│       ├── setup.sh
│       └── assertions/
│           ├── 01-spawn-agent-called.sh
│           ├── 02-wait-agent-called.sh
│           ├── 03-wait-not-called.sh
│           └── 04-spawn-before-wait.sh
├── tests/harness/                    # NEW
│   ├── __init__.py
│   ├── fixtures/                     # symlink to ../fixtures
│   ├── test_normalizers.py
│   ├── test_token_usage.py
│   ├── test_target_config.py
│   ├── test_scenario_config.py
│   ├── test_setup_step.py
│   ├── test_capture.py
│   ├── test_assertions.py
│   ├── test_composer.py
│   ├── test_runner.py
│   └── test_cli.py
├── docs/
│   ├── gauntlet-migration.md         # spec (v2, already in place)
│   ├── migration-notes.md            # NEW — running log of decisions
│   └── superpowers/plans/2026-05-18-gauntlet-migration-phase-1.md
├── drill/                            # UNCHANGED through Phase 1
├── scenarios/                        # UNCHANGED — old Drill YAML scenarios
├── bin/                              # UNCHANGED — assertion helpers reused
├── backends/                         # UNCHANGED through Phase 1
└── pyproject.toml                    # MODIFIED — add harness pkg + script
```

---

## Tasks

### Task 1: Bootstrap the harness package

**Files:**
- Create: `harness/__init__.py`
- Modify: `pyproject.toml`

- [ ] **Step 1: Create the package directory and `__init__.py`**

```python
# harness/__init__.py
"""Eval harness wrapping Gauntlet for superpowers skill compliance benchmarks."""

__version__ = "0.1.0"
```

- [ ] **Step 2: Update `pyproject.toml` to register the package and CLI**

In `[project.scripts]`, add a `harness` entry:

```toml
[project.scripts]
drill = "drill.cli:main"
harness = "harness.cli:main"

[tool.hatch.build.targets.wheel]
packages = ["drill", "setup_helpers", "harness"]
```

- [ ] **Step 3: Sync and verify**

```bash
uv sync --extra dev
uv run python -c "import harness; print(harness.__version__)"
```

Expected: prints `0.1.0`.

- [ ] **Step 4: Commit**

```bash
git add pyproject.toml harness/__init__.py
git commit -m "harness: bootstrap empty package alongside drill"
```

---

### Task 2: Lift normalizers from drill

`drill/normalizer.py` is framework-agnostic. Copy verbatim; copy its tests with import rewrite.

**Files:**
- Create: `harness/normalizers.py`
- Create: `tests/harness/__init__.py`
- Create: `tests/harness/test_normalizers.py`
- Create: `tests/harness/fixtures` (symlink)

- [ ] **Step 1: Copy source and tests, rewrite imports**

```bash
cp drill/normalizer.py harness/normalizers.py
mkdir -p tests/harness
touch tests/harness/__init__.py
cp tests/test_normalizer.py tests/harness/test_normalizers.py
# BSD sed (macOS) requires the empty '' arg; GNU sed (Linux) omits it.
sed -i '' 's|from drill\.normalizer import|from harness.normalizers import|g' tests/harness/test_normalizers.py 2>/dev/null \
  || sed -i 's|from drill\.normalizer import|from harness.normalizers import|g' tests/harness/test_normalizers.py
ln -s ../fixtures tests/harness/fixtures
```

- [ ] **Step 2: Run lifted tests**

```bash
uv run pytest tests/harness/test_normalizers.py -v
```

Expected: all tests pass. If a fixture path fails, the original test loads fixtures by path relative to the test file — the symlink covers that.

- [ ] **Step 3: Lint and typecheck**

```bash
uv run ruff check harness/normalizers.py tests/harness/test_normalizers.py
uv run ty check harness/normalizers.py
```

- [ ] **Step 4: Commit**

```bash
git add harness/normalizers.py tests/harness/__init__.py tests/harness/test_normalizers.py tests/harness/fixtures
git commit -m "harness: lift normalizers from drill verbatim with tests"
```

---

### Task 3: Lift token_usage from drill

Same pattern as Task 2.

- [ ] **Step 1: Copy and rewrite**

```bash
cp drill/token_capture.py harness/token_usage.py
cp tests/test_token_capture.py tests/harness/test_token_usage.py
sed -i '' 's|from drill\.token_capture import|from harness.token_usage import|g' tests/harness/test_token_usage.py 2>/dev/null \
  || sed -i 's|from drill\.token_capture import|from harness.token_usage import|g' tests/harness/test_token_usage.py
```

- [ ] **Step 2: Verify**

```bash
uv run pytest tests/harness/test_token_usage.py -v
uv run ruff check harness/token_usage.py tests/harness/test_token_usage.py
uv run ty check harness/token_usage.py
```

- [ ] **Step 3: Commit**

```bash
git add harness/token_usage.py tests/harness/test_token_usage.py
git commit -m "harness: lift token_usage from drill verbatim with tests"
```

---

### Task 4: Target config loader

`harness/targets/<name>.yaml` describes one agent CLI: binary path, where it writes logs, which normalizer, required env. Loaded once at the start of a run.

**Files:**
- Create: `harness/target_config.py`
- Create: `tests/harness/test_target_config.py`

`targets/<name>.yaml` schema:

```yaml
name: claude
binary: claude              # path or PATH-resolvable name
session_log_dir: ~/.claude/projects
session_log_glob: "**/session-*.jsonl"
normalizer: claude          # key into harness.normalizers.NORMALIZERS
required_env:
  - ANTHROPIC_API_KEY
  - SUPERPOWERS_ROOT
max_time: 10m               # optional, passed to gauntlet --max-time
```

- [ ] **Step 1: Write the failing tests**

```python
# tests/harness/test_target_config.py
from pathlib import Path

import pytest
import yaml

from harness.target_config import TargetConfig, TargetConfigError, load_target_config


def _write(tmp_path: Path, name: str, doc: dict) -> Path:
    p = tmp_path / f"{name}.yaml"
    p.write_text(yaml.safe_dump(doc))
    return p


class TestLoadTargetConfig:
    def test_minimal_valid(self, tmp_path, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "x")
        path = _write(tmp_path, "claude", {
            "name": "claude",
            "binary": "claude",
            "session_log_dir": "~/.claude/projects",
            "session_log_glob": "**/session-*.jsonl",
            "normalizer": "claude",
            "required_env": ["ANTHROPIC_API_KEY"],
        })
        cfg = load_target_config(path)
        assert isinstance(cfg, TargetConfig)
        assert cfg.name == "claude"
        assert cfg.binary == "claude"
        assert cfg.session_log_dir == Path("~/.claude/projects").expanduser()
        assert cfg.normalizer == "claude"
        assert cfg.max_time is None

    def test_missing_required_env_raises(self, tmp_path, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        path = _write(tmp_path, "claude", {
            "name": "claude",
            "binary": "claude",
            "session_log_dir": "/tmp",
            "session_log_glob": "*.jsonl",
            "normalizer": "claude",
            "required_env": ["ANTHROPIC_API_KEY"],
        })
        with pytest.raises(TargetConfigError, match="ANTHROPIC_API_KEY"):
            load_target_config(path)

    def test_unknown_normalizer_raises(self, tmp_path, monkeypatch):
        path = _write(tmp_path, "weirdo", {
            "name": "weirdo",
            "binary": "weirdo",
            "session_log_dir": "/tmp",
            "session_log_glob": "*.jsonl",
            "normalizer": "weirdo",
            "required_env": [],
        })
        with pytest.raises(TargetConfigError, match="weirdo"):
            load_target_config(path)

    def test_max_time_optional(self, tmp_path):
        path = _write(tmp_path, "claude", {
            "name": "claude",
            "binary": "claude",
            "session_log_dir": "/tmp",
            "session_log_glob": "*.jsonl",
            "normalizer": "claude",
            "required_env": [],
            "max_time": "5m",
        })
        cfg = load_target_config(path)
        assert cfg.max_time == "5m"
```

- [ ] **Step 2: Run; verify failure**

```bash
uv run pytest tests/harness/test_target_config.py -v
```

Expected: `ImportError`.

- [ ] **Step 3: Implement**

```python
# harness/target_config.py
"""Per-target configuration loader.

A target.yaml describes one agent CLI: its binary, where it writes session
logs, which normalizer to apply to those logs, and required env vars.
Authored once per agent CLI; shared across scenarios.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import yaml

from harness.normalizers import NORMALIZERS


class TargetConfigError(ValueError):
    """Raised when a target yaml is invalid or required env is missing."""


@dataclass(frozen=True)
class TargetConfig:
    name: str
    binary: str
    session_log_dir: Path
    session_log_glob: str
    normalizer: str
    required_env: tuple[str, ...]
    max_time: str | None


def load_target_config(path: Path) -> TargetConfig:
    raw = yaml.safe_load(path.read_text())
    if not isinstance(raw, dict):
        raise TargetConfigError(f"{path}: top-level must be a mapping")

    required = ("name", "binary", "session_log_dir", "session_log_glob",
                "normalizer", "required_env")
    missing = [k for k in required if k not in raw]
    if missing:
        raise TargetConfigError(f"{path}: missing required fields: {missing}")

    required_env = tuple(raw["required_env"])
    missing_env = [v for v in required_env if not os.environ.get(v)]
    if missing_env:
        raise TargetConfigError(
            f"{path}: required env vars not set: {missing_env}"
        )

    normalizer = raw["normalizer"]
    if normalizer not in NORMALIZERS:
        raise TargetConfigError(
            f"{path}: unknown normalizer {normalizer!r}; known: {sorted(NORMALIZERS)}"
        )

    return TargetConfig(
        name=raw["name"],
        binary=raw["binary"],
        session_log_dir=Path(raw["session_log_dir"]).expanduser(),
        session_log_glob=raw["session_log_glob"],
        normalizer=normalizer,
        required_env=required_env,
        max_time=raw.get("max_time"),
    )
```

- [ ] **Step 4: Run tests; verify pass**

```bash
uv run pytest tests/harness/test_target_config.py -v
```

Expected: 4 pass.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
uv run ruff check harness/target_config.py tests/harness/test_target_config.py
uv run ty check harness/target_config.py
git add harness/target_config.py tests/harness/test_target_config.py
git commit -m "harness: target_config loader (binary, log path, normalizer, env)"
```

---

### Task 5: Scenario config loader (optional compatibility hint)

A scenario's `scenario.yaml` is optional. When present, it can declare `compatible_targets: [<name>, ...]` to refuse runs against incompatible targets.

**Files:**
- Create: `harness/scenario_config.py`
- Create: `tests/harness/test_scenario_config.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/harness/test_scenario_config.py
from pathlib import Path

import pytest
import yaml

from harness.scenario_config import (
    ScenarioConfig,
    ScenarioConfigError,
    check_target_compatibility,
    load_scenario_config,
)


class TestLoadScenarioConfig:
    def test_no_file_returns_default(self, tmp_path):
        cfg = load_scenario_config(tmp_path / "scenario.yaml")
        assert isinstance(cfg, ScenarioConfig)
        assert cfg.compatible_targets is None  # None = any target OK

    def test_compatible_targets_list(self, tmp_path):
        p = tmp_path / "scenario.yaml"
        p.write_text(yaml.safe_dump({"compatible_targets": ["codex"]}))
        cfg = load_scenario_config(p)
        assert cfg.compatible_targets == ("codex",)

    def test_invalid_shape_raises(self, tmp_path):
        p = tmp_path / "scenario.yaml"
        p.write_text("compatible_targets: not-a-list")
        with pytest.raises(ScenarioConfigError):
            load_scenario_config(p)


class TestCheckTargetCompatibility:
    def test_no_constraint_accepts_anything(self):
        check_target_compatibility(ScenarioConfig(compatible_targets=None), "anything")

    def test_matching_target_passes(self):
        cfg = ScenarioConfig(compatible_targets=("codex",))
        check_target_compatibility(cfg, "codex")

    def test_non_matching_target_raises(self):
        cfg = ScenarioConfig(compatible_targets=("codex",))
        with pytest.raises(ScenarioConfigError, match="claude"):
            check_target_compatibility(cfg, "claude")
```

- [ ] **Step 2: Run; verify failure**

```bash
uv run pytest tests/harness/test_scenario_config.py -v
```

- [ ] **Step 3: Implement**

```python
# harness/scenario_config.py
"""Optional per-scenario configuration.

Most scenarios are target-agnostic and need no scenario.yaml. Target-specific
scenarios (e.g., a Codex tool-mapping test) declare compatibility here.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml


class ScenarioConfigError(ValueError):
    """Raised on malformed scenario.yaml or an incompatible target choice."""


@dataclass(frozen=True)
class ScenarioConfig:
    compatible_targets: tuple[str, ...] | None  # None = any target accepted


def load_scenario_config(path: Path) -> ScenarioConfig:
    if not path.exists():
        return ScenarioConfig(compatible_targets=None)
    raw = yaml.safe_load(path.read_text())
    if raw is None:
        return ScenarioConfig(compatible_targets=None)
    if not isinstance(raw, dict):
        raise ScenarioConfigError(f"{path}: top-level must be a mapping")
    targets = raw.get("compatible_targets")
    if targets is None:
        return ScenarioConfig(compatible_targets=None)
    if not isinstance(targets, list) or not all(isinstance(t, str) for t in targets):
        raise ScenarioConfigError(
            f"{path}: compatible_targets must be a list of strings"
        )
    return ScenarioConfig(compatible_targets=tuple(targets))


def check_target_compatibility(cfg: ScenarioConfig, target: str) -> None:
    if cfg.compatible_targets is None:
        return
    if target not in cfg.compatible_targets:
        raise ScenarioConfigError(
            f"scenario not compatible with target {target!r}; "
            f"declared compatible_targets: {list(cfg.compatible_targets)}"
        )
```

- [ ] **Step 4: Run; verify pass**

```bash
uv run pytest tests/harness/test_scenario_config.py -v
uv run ruff check harness/scenario_config.py tests/harness/test_scenario_config.py
uv run ty check harness/scenario_config.py
```

- [ ] **Step 5: Commit**

```bash
git add harness/scenario_config.py tests/harness/test_scenario_config.py
git commit -m "harness: optional scenario.yaml with compatible_targets hint"
```

---

### Task 6: Setup-step runner

Run a scenario's `setup.sh` against a freshly-created temp workdir. Non-zero exit aborts the run.

**Files:**
- Create: `harness/setup_step.py`
- Create: `tests/harness/test_setup_step.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/harness/test_setup_step.py
import stat
from pathlib import Path

import pytest

from harness.setup_step import SetupError, run_setup


def _make_executable(path: Path, body: str) -> None:
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


class TestRunSetup:
    def test_no_setup_is_fine(self, tmp_path):
        scenario_dir = tmp_path / "scenario"
        scenario_dir.mkdir()
        workdir = tmp_path / "wd"
        workdir.mkdir()
        run_setup(scenario_dir, workdir)  # should not raise

    def test_zero_exit_succeeds_and_workdir_mutated(self, tmp_path):
        scenario_dir = tmp_path / "scenario"
        scenario_dir.mkdir()
        workdir = tmp_path / "wd"
        workdir.mkdir()
        _make_executable(
            scenario_dir / "setup.sh",
            "#!/usr/bin/env bash\nset -e\necho hello > marker\n",
        )
        run_setup(scenario_dir, workdir)
        assert (workdir / "marker").read_text().strip() == "hello"

    def test_nonzero_exit_raises_with_streams(self, tmp_path):
        scenario_dir = tmp_path / "scenario"
        scenario_dir.mkdir()
        workdir = tmp_path / "wd"
        workdir.mkdir()
        _make_executable(
            scenario_dir / "setup.sh",
            "#!/usr/bin/env bash\necho boom 1>&2\nexit 7\n",
        )
        with pytest.raises(SetupError) as exc:
            run_setup(scenario_dir, workdir)
        assert "exit 7" in str(exc.value)
        assert "boom" in str(exc.value)

    def test_drill_workdir_env_set(self, tmp_path):
        scenario_dir = tmp_path / "scenario"
        scenario_dir.mkdir()
        workdir = tmp_path / "wd"
        workdir.mkdir()
        marker_path = tmp_path / "captured_workdir"
        _make_executable(
            scenario_dir / "setup.sh",
            f'#!/usr/bin/env bash\necho "$DRILL_WORKDIR" > {marker_path}\n',
        )
        run_setup(scenario_dir, workdir)
        assert marker_path.read_text().strip() == str(workdir)
```

- [ ] **Step 2: Run; fail**

```bash
uv run pytest tests/harness/test_setup_step.py -v
```

- [ ] **Step 3: Implement**

```python
# harness/setup_step.py
"""Run a scenario's setup.sh against a temp workdir.

DRILL_WORKDIR is exported (matching Drill's convention) so existing helper
shell scripts continue to work without rename.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path


class SetupError(RuntimeError):
    """Raised when setup.sh exits non-zero."""


def run_setup(scenario_dir: Path, workdir: Path) -> None:
    setup_path = scenario_dir / "setup.sh"
    if not setup_path.exists():
        return
    env = {**os.environ, "DRILL_WORKDIR": str(workdir)}
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

- [ ] **Step 4: Run; pass; lint; commit**

```bash
uv run pytest tests/harness/test_setup_step.py -v
uv run ruff check harness/setup_step.py tests/harness/test_setup_step.py
uv run ty check harness/setup_step.py
git add harness/setup_step.py tests/harness/test_setup_step.py
git commit -m "harness: setup.sh runner with DRILL_WORKDIR convention"
```

---

### Task 7: Capture utility

Snapshot, diff, and normalize agent-under-test session-log directories. The harness writes `tool_calls.jsonl` for the assertions step to read.

**Files:**
- Create: `harness/capture.py`
- Create: `tests/harness/test_capture.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/harness/test_capture.py
import json
from pathlib import Path

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
        rows = [json.loads(l) for l in out.read_text().splitlines() if l.strip()]
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
```

- [ ] **Step 2: Run; fail**

```bash
uv run pytest tests/harness/test_capture.py -v
```

- [ ] **Step 3: Implement**

```python
# harness/capture.py
"""Snapshot, diff, and normalize agent-under-test session-log directories."""

from __future__ import annotations

import json
from pathlib import Path

from harness.normalizers import (
    NORMALIZERS,
    filter_codex_logs_by_cwd,
    filter_pi_logs_by_cwd,
)


def snapshot_dir(log_dir: Path, glob: str) -> set[str]:
    if not log_dir.exists():
        return set()
    return {str(p.relative_to(log_dir)) for p in log_dir.glob(glob)}


def new_files_since(log_dir: Path, glob: str, snapshot: set[str]) -> list[Path]:
    if not log_dir.exists():
        return []
    current = {str(p.relative_to(log_dir)): p for p in log_dir.glob(glob)}
    return [current[k] for k in sorted(set(current) - snapshot)]


def capture_tool_calls(
    *,
    log_dir: Path,
    log_glob: str,
    snapshot: set[str],
    normalizer: str,
    run_dir: Path,
    workdir: Path | None = None,
) -> Path:
    """Diff log_dir, filter by cwd if applicable, normalize, write JSONL.

    Always writes tool_calls.jsonl (empty if no new logs) so downstream
    assertions can rely on the file existing.
    """
    new = new_files_since(log_dir, log_glob, snapshot)
    if normalizer == "codex" and workdir is not None:
        new = filter_codex_logs_by_cwd(new, str(workdir))
    elif normalizer == "pi" and workdir is not None:
        new = filter_pi_logs_by_cwd(new, str(workdir))
    fn = NORMALIZERS[normalizer]
    out_path = run_dir / "tool_calls.jsonl"
    with out_path.open("w") as f:
        for path in new:
            for row in fn(path.read_text()):
                f.write(json.dumps(row) + "\n")
    return out_path
```

- [ ] **Step 4: Run; pass; lint; commit**

```bash
uv run pytest tests/harness/test_capture.py -v
uv run ruff check harness/capture.py tests/harness/test_capture.py
uv run ty check harness/capture.py
git add harness/capture.py tests/harness/test_capture.py
git commit -m "harness: snapshot + diff + normalize session-log capture"
```

---

### Task 8: Assertions runner

Run every executable in `assertions/` from the run dir, with `bin/` on PATH and `DRILL_WORKDIR` set.

**Files:**
- Create: `harness/assertions.py`
- Create: `tests/harness/test_assertions.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/harness/test_assertions.py
import stat
from pathlib import Path

from harness.assertions import AssertionResult, run_assertions


def _make_executable(path: Path, body: str) -> None:
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


class TestRunAssertions:
    def test_no_dir_returns_empty_pass(self, tmp_path):
        results, all_pass = run_assertions(
            assertions_dir=tmp_path / "missing",
            run_dir=tmp_path / "run",
            workdir=tmp_path / "wd",
            bin_dir=tmp_path / "bin",
        )
        assert results == []
        assert all_pass is True

    def test_runs_alphabetically_and_collects_results(self, tmp_path):
        a = tmp_path / "a"; a.mkdir()
        for n, body in [
            ("01-first.sh", "#!/usr/bin/env bash\nexit 0\n"),
            ("02-second.sh", "#!/usr/bin/env bash\nexit 0\n"),
        ]:
            _make_executable(a / n, body)
        run_dir = tmp_path / "run"; run_dir.mkdir()
        results, all_pass = run_assertions(
            assertions_dir=a, run_dir=run_dir,
            workdir=tmp_path / "wd", bin_dir=tmp_path / "bin",
        )
        assert [r.name for r in results] == ["01-first.sh", "02-second.sh"]
        assert all_pass is True

    def test_failing_assertion_caught_with_streams(self, tmp_path):
        a = tmp_path / "a"; a.mkdir()
        _make_executable(a / "01-fail.sh",
            "#!/usr/bin/env bash\necho oops 1>&2\nexit 3\n")
        run_dir = tmp_path / "run"; run_dir.mkdir()
        results, all_pass = run_assertions(
            assertions_dir=a, run_dir=run_dir,
            workdir=tmp_path / "wd", bin_dir=tmp_path / "bin",
        )
        assert all_pass is False
        assert results[0].exit_code == 3
        assert "oops" in results[0].stderr

    def test_bin_dir_on_path(self, tmp_path):
        bin_dir = tmp_path / "bin"; bin_dir.mkdir()
        _make_executable(bin_dir / "helper", "#!/usr/bin/env bash\necho HELLO\n")
        a = tmp_path / "a"; a.mkdir()
        _make_executable(a / "01.sh",
            "#!/usr/bin/env bash\nset -e\n[ \"$(helper)\" = HELLO ]\n")
        run_dir = tmp_path / "run"; run_dir.mkdir()
        _, all_pass = run_assertions(
            assertions_dir=a, run_dir=run_dir,
            workdir=tmp_path / "wd", bin_dir=bin_dir,
        )
        assert all_pass is True

    def test_drill_workdir_env(self, tmp_path):
        a = tmp_path / "a"; a.mkdir()
        wd = tmp_path / "wd"
        _make_executable(a / "01.sh",
            f'#!/usr/bin/env bash\n[ "$DRILL_WORKDIR" = "{wd}" ]\n')
        run_dir = tmp_path / "run"; run_dir.mkdir()
        _, all_pass = run_assertions(
            assertions_dir=a, run_dir=run_dir, workdir=wd, bin_dir=tmp_path / "bin",
        )
        assert all_pass is True
```

- [ ] **Step 2: Run; fail**

```bash
uv run pytest tests/harness/test_assertions.py -v
```

- [ ] **Step 3: Implement**

```python
# harness/assertions.py
"""Run a scenario's assertions/*.sh against the per-run dir.

These are AC regression-tests, not a second verifier. The Gauntlet QA
agent's verdict is authoritative for any single run; the assertions are
frozen deterministic checks that an AC catches what it should catch as
LLMs drift over time.
"""

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
    run_dir: Path,
    workdir: Path,
    bin_dir: Path,
) -> tuple[list[AssertionResult], bool]:
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
            cwd=run_dir,
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
    return results, all(r.passed for r in results)
```

- [ ] **Step 4: Run; pass; lint; commit**

```bash
uv run pytest tests/harness/test_assertions.py -v
uv run ruff check harness/assertions.py tests/harness/test_assertions.py
uv run ty check harness/assertions.py
git add harness/assertions.py tests/harness/test_assertions.py
git commit -m "harness: assertions runner with bin/ on PATH and DRILL_WORKDIR"
```

---

### Task 9: Composer

Combine Gauntlet's verdict with assertion results. Fixed all-must-pass.

**Files:**
- Create: `harness/composer.py`
- Create: `tests/harness/test_composer.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/harness/test_composer.py
from harness.assertions import AssertionResult
from harness.composer import FinalVerdict, compose


class TestCompose:
    def test_all_pass(self):
        v = compose(gauntlet_status="pass",
                    assertion_results=[AssertionResult("a", 0, "", "")])
        assert v.final == "pass"
        assert v.gauntlet == "pass"
        assert v.assertions == "pass"

    def test_gauntlet_fail_dominates(self):
        v = compose(gauntlet_status="fail",
                    assertion_results=[AssertionResult("a", 0, "", "")])
        assert v.final == "fail"
        assert v.assertions == "pass"

    def test_assertion_fail_dominates(self):
        v = compose(gauntlet_status="pass", assertion_results=[
            AssertionResult("a", 0, "", ""),
            AssertionResult("b", 1, "", "boom"),
        ])
        assert v.final == "fail"
        assert v.assertions == "fail"

    def test_investigate_is_fail(self):
        v = compose(gauntlet_status="investigate", assertion_results=[])
        assert v.gauntlet == "investigate"
        assert v.final == "fail"

    def test_no_assertions_passes_when_gauntlet_passes(self):
        v = compose(gauntlet_status="pass", assertion_results=[])
        assert v.final == "pass"

    def test_to_dict_serializable(self):
        v = compose(gauntlet_status="pass",
                    assertion_results=[AssertionResult("a", 0, "ok", "")])
        d = v.to_dict()
        assert d["final"] == "pass"
        assert d["assertion_details"] == [
            {"name": "a", "exit_code": 0, "stdout": "ok", "stderr": ""}
        ]
```

- [ ] **Step 2: Run; fail**

```bash
uv run pytest tests/harness/test_composer.py -v
```

- [ ] **Step 3: Implement**

```python
# harness/composer.py
"""Combine Gauntlet's screen-side verdict with assertion results.

Fixed all-must-pass: final=pass iff gauntlet=pass AND every assertion exits 0.
No per-scenario composition rule; see docs/gauntlet-migration.md "The Agent
/ Verifier collapse".
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Literal

from harness.assertions import AssertionResult

GauntletStatus = Literal["pass", "fail", "investigate"]
AssertionStatus = Literal["pass", "fail"]
FinalStatus = Literal["pass", "fail"]


@dataclass(frozen=True)
class FinalVerdict:
    gauntlet: GauntletStatus
    assertions: AssertionStatus
    final: FinalStatus
    assertion_details: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def compose(
    *,
    gauntlet_status: GauntletStatus,
    assertion_results: list[AssertionResult],
) -> FinalVerdict:
    assertions: AssertionStatus = (
        "pass" if all(r.passed for r in assertion_results) else "fail"
    )
    final: FinalStatus = (
        "pass" if gauntlet_status == "pass" and assertions == "pass" else "fail"
    )
    return FinalVerdict(
        gauntlet=gauntlet_status,
        assertions=assertions,
        final=final,
        assertion_details=[
            {"name": r.name, "exit_code": r.exit_code, "stdout": r.stdout,
             "stderr": r.stderr}
            for r in assertion_results
        ],
    )
```

- [ ] **Step 4: Run; pass; lint; commit**

```bash
uv run pytest tests/harness/test_composer.py -v
uv run ruff check harness/composer.py tests/harness/test_composer.py
uv run ty check harness/composer.py
git add harness/composer.py tests/harness/test_composer.py
git commit -m "harness: fixed all-must-pass composer"
```

---

### Task 10: Runner orchestration

Glue. Takes a scenario dir + target name, runs the full per-run flow, returns a verdict.

**Files:**
- Create: `harness/runner.py`
- Create: `tests/harness/test_runner.py`

Per-run flow (from spec):
1. Parse `harness/targets/<target>.yaml` + optional `scenarios/<name>/scenario.yaml`; check compatibility.
2. Create per-run dir `/tmp/harness-run-XXX/`.
3. Populate `<run-dir>/.gauntlet/context/` from `harness/target_contexts/<target>/`.
4. Create temp workdir.
5. Run `setup.sh`.
6. Snapshot agent-under-test session-log dir.
7. Invoke `gauntlet run` with `cwd=workdir`, `--project-dir=<run-dir>`.
8. Capture + normalize logs → `<run-dir>/tool_calls.jsonl`.
9. Inject synthetic `00-non-empty-capture` if tool_calls.jsonl is empty AND scenario expects tool calls.
10. Run assertions.
11. Compose verdict.
12. Write `<run-dir>/verdict.json`.
13. Cleanup workdir on pass; keep on fail (write `<run-dir>/workdir-path.txt`).

Lockfile guard: refuse to start if another harness run is active against the same target's session-log dir.

- [ ] **Step 1: Write the failing tests**

```python
# tests/harness/test_runner.py
import json
import stat
from pathlib import Path
from unittest.mock import patch

import pytest
import yaml

from harness.runner import RunnerError, run_scenario


def _exec(path: Path, body: str) -> None:
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _make_target(targets_dir: Path, name: str, session_log_dir: Path) -> None:
    targets_dir.mkdir(parents=True, exist_ok=True)
    (targets_dir / f"{name}.yaml").write_text(yaml.safe_dump({
        "name": name,
        "binary": "echo",  # we never actually run the real CLI in tests
        "session_log_dir": str(session_log_dir),
        "session_log_glob": "*.jsonl",
        "normalizer": "claude",
        "required_env": [],
    }))


def _make_scenario(scenarios_dir: Path, name: str, *, asserts_pass: bool = True,
                   compat: list[str] | None = None,
                   tool_named_assertion: bool = False) -> Path:
    sd = scenarios_dir / name
    sd.mkdir(parents=True)
    (sd / "story.md").write_text("---\nid: x\ntitle: x\n---\nbody\n")
    _exec(sd / "setup.sh", "#!/usr/bin/env bash\necho ok > marker\n")
    if compat is not None:
        (sd / "scenario.yaml").write_text(yaml.safe_dump({"compatible_targets": compat}))
    a = sd / "assertions"; a.mkdir()
    aname = "01-tool-x.sh" if tool_named_assertion else "01-x.sh"
    _exec(a / aname, f"#!/usr/bin/env bash\nexit {'0' if asserts_pass else '1'}\n")
    return sd


def _stub_gauntlet_pass(*, run_dir, **kwargs):
    (run_dir / ".gauntlet" / "results").mkdir(parents=True, exist_ok=True)
    return "pass"


def _stub_gauntlet_fail(*, run_dir, **kwargs):
    (run_dir / ".gauntlet" / "results").mkdir(parents=True, exist_ok=True)
    return "fail"


class TestRunScenario:
    def test_happy_path(self, tmp_path):
        targets_dir = tmp_path / "targets"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "session-logs"; session_log_dir.mkdir()
        _make_target(targets_dir, "claude", session_log_dir)
        sd = _make_scenario(scenarios_dir, "x")
        contexts_dir = tmp_path / "contexts"
        (contexts_dir / "claude").mkdir(parents=True)
        (contexts_dir / "claude" / "HOWTO.md").write_text("invoke `claude`")
        out_root = tmp_path / "results"
        bin_dir = tmp_path / "bin"; bin_dir.mkdir()

        with patch("harness.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass):
            verdict = run_scenario(
                scenario_dir=sd, target="claude",
                targets_dir=targets_dir, contexts_dir=contexts_dir,
                out_root=out_root, bin_dir=bin_dir,
            )
        assert verdict.final == "pass"
        run_dirs = list(out_root.iterdir())
        assert len(run_dirs) == 1
        rd = run_dirs[0]
        assert (rd / "verdict.json").exists()
        assert (rd / "tool_calls.jsonl").exists()
        assert (rd / ".gauntlet" / "context" / "HOWTO.md").read_text() == "invoke `claude`"

    def test_assertion_fail_overrides_gauntlet_pass(self, tmp_path):
        targets_dir = tmp_path / "targets"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"; session_log_dir.mkdir()
        _make_target(targets_dir, "claude", session_log_dir)
        sd = _make_scenario(scenarios_dir, "x", asserts_pass=False)
        contexts_dir = tmp_path / "contexts"
        (contexts_dir / "claude").mkdir(parents=True)
        out_root = tmp_path / "results"
        bin_dir = tmp_path / "bin"; bin_dir.mkdir()

        with patch("harness.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass):
            verdict = run_scenario(
                scenario_dir=sd, target="claude",
                targets_dir=targets_dir, contexts_dir=contexts_dir,
                out_root=out_root, bin_dir=bin_dir,
            )
        assert verdict.final == "fail"
        assert verdict.assertions == "fail"

    def test_setup_failure_aborts_before_gauntlet(self, tmp_path):
        targets_dir = tmp_path / "targets"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"; session_log_dir.mkdir()
        _make_target(targets_dir, "claude", session_log_dir)
        sd = _make_scenario(scenarios_dir, "x")
        _exec(sd / "setup.sh", "#!/usr/bin/env bash\nexit 9\n")
        contexts_dir = tmp_path / "contexts"
        (contexts_dir / "claude").mkdir(parents=True)
        out_root = tmp_path / "results"
        bin_dir = tmp_path / "bin"; bin_dir.mkdir()

        with patch("harness.runner.invoke_gauntlet") as mock_g:
            with pytest.raises(RunnerError, match="setup"):
                run_scenario(
                    scenario_dir=sd, target="claude",
                    targets_dir=targets_dir, contexts_dir=contexts_dir,
                    out_root=out_root, bin_dir=bin_dir,
                )
            mock_g.assert_not_called()

    def test_incompatible_target_refused(self, tmp_path):
        targets_dir = tmp_path / "targets"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"; session_log_dir.mkdir()
        _make_target(targets_dir, "claude", session_log_dir)
        sd = _make_scenario(scenarios_dir, "x", compat=["codex"])
        contexts_dir = tmp_path / "contexts"
        (contexts_dir / "claude").mkdir(parents=True)
        out_root = tmp_path / "results"
        bin_dir = tmp_path / "bin"; bin_dir.mkdir()

        with patch("harness.runner.invoke_gauntlet") as mock_g:
            with pytest.raises(RunnerError, match="compat"):
                run_scenario(
                    scenario_dir=sd, target="claude",
                    targets_dir=targets_dir, contexts_dir=contexts_dir,
                    out_root=out_root, bin_dir=bin_dir,
                )
            mock_g.assert_not_called()

    def test_empty_capture_synthetic_assertion_when_scenario_expects_tools(self, tmp_path):
        targets_dir = tmp_path / "targets"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"; session_log_dir.mkdir()
        _make_target(targets_dir, "claude", session_log_dir)
        sd = _make_scenario(scenarios_dir, "x", tool_named_assertion=True)
        contexts_dir = tmp_path / "contexts"
        (contexts_dir / "claude").mkdir(parents=True)
        out_root = tmp_path / "results"
        bin_dir = tmp_path / "bin"; bin_dir.mkdir()

        with patch("harness.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass):
            verdict = run_scenario(
                scenario_dir=sd, target="claude",
                targets_dir=targets_dir, contexts_dir=contexts_dir,
                out_root=out_root, bin_dir=bin_dir,
            )
        # Capture was empty (no real CLI run) and assertion name starts with
        # tool-* — synthetic 00-non-empty-capture fires.
        assert verdict.final == "fail"
        assert any(d["name"] == "00-non-empty-capture" for d in verdict.assertion_details)

    def test_workdir_kept_on_failure(self, tmp_path):
        targets_dir = tmp_path / "targets"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"; session_log_dir.mkdir()
        _make_target(targets_dir, "claude", session_log_dir)
        sd = _make_scenario(scenarios_dir, "x", asserts_pass=False)
        contexts_dir = tmp_path / "contexts"
        (contexts_dir / "claude").mkdir(parents=True)
        out_root = tmp_path / "results"
        bin_dir = tmp_path / "bin"; bin_dir.mkdir()

        with patch("harness.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass):
            verdict = run_scenario(
                scenario_dir=sd, target="claude",
                targets_dir=targets_dir, contexts_dir=contexts_dir,
                out_root=out_root, bin_dir=bin_dir,
            )
        assert verdict.final == "fail"
        rd = list(out_root.iterdir())[0]
        wd_path = Path((rd / "workdir-path.txt").read_text().strip())
        assert wd_path.exists()

    def test_lockfile_blocks_concurrent_runs(self, tmp_path):
        targets_dir = tmp_path / "targets"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"; session_log_dir.mkdir()
        _make_target(targets_dir, "claude", session_log_dir)
        sd = _make_scenario(scenarios_dir, "x")
        contexts_dir = tmp_path / "contexts"
        (contexts_dir / "claude").mkdir(parents=True)
        out_root = tmp_path / "results"
        bin_dir = tmp_path / "bin"; bin_dir.mkdir()
        # Pre-create the lockfile.
        (session_log_dir.parent / ".harness-run.lock").write_text("pid=999\n")

        with patch("harness.runner.invoke_gauntlet"):
            with pytest.raises(RunnerError, match="lock"):
                run_scenario(
                    scenario_dir=sd, target="claude",
                    targets_dir=targets_dir, contexts_dir=contexts_dir,
                    out_root=out_root, bin_dir=bin_dir,
                )
```

- [ ] **Step 2: Run; fail**

```bash
uv run pytest tests/harness/test_runner.py -v
```

- [ ] **Step 3: Implement**

```python
# harness/runner.py
"""Per-run orchestration. One scenario, one target, one verdict.

Single-run-at-a-time only in Phase 1. Multiple harness processes against the
same target's session-log dir cross-contaminate via snapshot/diff. Enforced
with a sentinel lockfile.
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
from harness.scenario_config import (
    ScenarioConfigError,
    check_target_compatibility,
    load_scenario_config,
)
from harness.setup_step import SetupError, run_setup
from harness.target_config import TargetConfig, load_target_config

LOCK_FILENAME = ".harness-run.lock"


class RunnerError(RuntimeError):
    """Raised on non-recoverable errors before verdict composition."""


@contextmanager
def _single_run_lock(session_log_dir: Path):
    """Enforce one-harness-run-at-a-time per session-log root.

    Bail loudly if locked — silent waiting would mask real concurrency bugs.
    """
    lock_root = session_log_dir.parent if session_log_dir.parent.exists() else Path.home()
    lock_path = lock_root / LOCK_FILENAME
    if lock_path.exists():
        raise RunnerError(
            f"Another harness run appears active (lock at {lock_path}). "
            "Remove the lockfile if you're sure no other run is in progress."
        )
    try:
        lock_path.write_text(f"pid={os.getpid()}\nstarted={time.time()}\n")
        yield
    finally:
        lock_path.unlink(missing_ok=True)


def _gauntlet_status_from_run_dir(run_dir: Path) -> str:
    """Read gauntlet's verdict from <run-dir>/.gauntlet/results/<runId>/result.json.

    Gauntlet writes results under .gauntlet/results/<runId>/. There should be
    exactly one runId per harness invocation. If we can't find a result.json,
    treat as investigate.
    """
    results_root = run_dir / ".gauntlet" / "results"
    if not results_root.exists():
        return "investigate"
    candidates = sorted(p for p in results_root.iterdir() if p.is_dir())
    for run_id_dir in reversed(candidates):
        result_path = run_id_dir / "result.json"
        if result_path.exists():
            try:
                return json.loads(result_path.read_text()).get("status", "investigate")
            except (OSError, json.JSONDecodeError):
                continue
    return "investigate"


def invoke_gauntlet(
    *,
    story_path: Path,
    target_binary: str,
    workdir: Path,
    run_dir: Path,
    max_time: str | None,
) -> str:
    """Subprocess-invoke `gauntlet run`. Returns the verdict status string.

    cwd=workdir so the agent-under-test inherits that cwd via tmux. run_dir
    serves as Gauntlet's --project-dir (so the agent reads .gauntlet/context/
    we populated). Stubbed in tests.
    """
    cmd = [
        "gauntlet", "run", str(story_path),
        "--adapter", "tui",
        "--target", target_binary,
        "--project-dir", str(run_dir),
        "--silent",
    ]
    if max_time:
        cmd += ["--max-time", max_time]
    subprocess.run(cmd, cwd=workdir, check=False)
    return _gauntlet_status_from_run_dir(run_dir)


def _has_tool_assertions(assertions_dir: Path) -> bool:
    """Heuristic: scenario cares about tool calls iff any assertion's name
    contains 'tool' or 'skill'. Cheap; ports Drill's empty-capture guard.
    """
    if not assertions_dir.exists():
        return False
    return any(
        any(k in p.name.lower() for k in ("tool", "skill"))
        for p in assertions_dir.iterdir() if p.is_file()
    )


def _empty_capture_synthetic(tool_calls_path: Path) -> AssertionResult | None:
    """Drill engine.py:169-178 parity guard."""
    if not tool_calls_path.exists() or tool_calls_path.stat().st_size == 0:
        return AssertionResult(
            name="00-non-empty-capture",
            exit_code=1,
            stdout="",
            stderr=(
                f"FAIL: {tool_calls_path.name} is empty. The agent session "
                "either crashed before any tool call, or per-target capture "
                "missed them. Investigate session-log dir + normalizer config."
            ),
        )
    return None


def _populate_context_dir(
    contexts_dir: Path, target: str, run_dir: Path
) -> None:
    src = contexts_dir / target
    dst = run_dir / ".gauntlet" / "context"
    dst.mkdir(parents=True, exist_ok=True)
    if src.exists():
        for entry in src.iterdir():
            if entry.is_file():
                shutil.copy2(entry, dst / entry.name)
            elif entry.is_dir():
                shutil.copytree(entry, dst / entry.name)


def run_scenario(
    *,
    scenario_dir: Path,
    target: str,
    targets_dir: Path,
    contexts_dir: Path,
    out_root: Path,
    bin_dir: Path,
) -> FinalVerdict:
    # 1. Parse target + (optional) scenario configs; check compatibility.
    target_path = targets_dir / f"{target}.yaml"
    if not target_path.exists():
        raise RunnerError(f"unknown target {target!r}: no {target_path}")
    tcfg = load_target_config(target_path)
    scfg = load_scenario_config(scenario_dir / "scenario.yaml")
    try:
        check_target_compatibility(scfg, target)
    except ScenarioConfigError as e:
        raise RunnerError(f"compatibility: {e}") from e

    story_path = scenario_dir / "story.md"
    if not story_path.exists():
        raise RunnerError(f"{scenario_dir}: story.md missing")

    # 2. Create per-run dir (doubles as gauntlet --project-dir).
    timestamp = time.strftime("%Y%m%dT%H%M%S")
    run_dir = out_root / f"{scenario_dir.name}-{target}-{timestamp}"
    run_dir.mkdir(parents=True, exist_ok=True)

    # 3. Populate .gauntlet/context/ from harness/target_contexts/<target>/
    _populate_context_dir(contexts_dir, target, run_dir)

    # 4. Create temp workdir.
    workdir = Path(tempfile.mkdtemp(prefix="harness-wd-"))
    workdir_kept = False
    try:
        with _single_run_lock(tcfg.session_log_dir):
            # 5. Run setup.sh.
            try:
                run_setup(scenario_dir, workdir)
            except SetupError as e:
                raise RunnerError(f"setup failed: {e}") from e

            # 6. Snapshot session-log dir.
            snap = snapshot_dir(tcfg.session_log_dir, tcfg.session_log_glob)

            # 7. Invoke gauntlet.
            gauntlet_status = invoke_gauntlet(
                story_path=story_path,
                target_binary=tcfg.binary,
                workdir=workdir,
                run_dir=run_dir,
                max_time=tcfg.max_time,
            )

            # 8. Capture + normalize logs.
            tool_calls_path = capture_tool_calls(
                log_dir=tcfg.session_log_dir,
                log_glob=tcfg.session_log_glob,
                snapshot=snap,
                normalizer=tcfg.normalizer,
                run_dir=run_dir,
                workdir=workdir,
            )

            # 9. Run scenario assertions.
            results, _ = run_assertions(
                assertions_dir=scenario_dir / "assertions",
                run_dir=run_dir,
                workdir=workdir,
                bin_dir=bin_dir,
            )

            # 10. Empty-capture parity guard.
            if _has_tool_assertions(scenario_dir / "assertions"):
                synth = _empty_capture_synthetic(tool_calls_path)
                if synth is not None:
                    results = [synth, *results]

            # 11. Compose final verdict.
            verdict = compose(
                gauntlet_status=gauntlet_status,  # type: ignore[arg-type]
                assertion_results=results,
            )

            # 12. Persist.
            (run_dir / "verdict.json").write_text(
                json.dumps(verdict.to_dict(), indent=2)
            )

            # 13. Workdir disposition.
            if verdict.final != "pass":
                workdir_kept = True
                (run_dir / "workdir-path.txt").write_text(str(workdir))
            return verdict
    finally:
        if not workdir_kept:
            shutil.rmtree(workdir, ignore_errors=True)
```

- [ ] **Step 4: Run; pass; lint; commit**

```bash
uv run pytest tests/harness/test_runner.py -v
uv run ruff check harness/runner.py tests/harness/test_runner.py
uv run ty check harness/runner.py
git add harness/runner.py tests/harness/test_runner.py
git commit -m "harness: per-run orchestrator with lockfile, context population, parity guards"
```

---

### Task 11: CLI

Thin click CLI exposing `harness run` and `harness list`.

**Files:**
- Create: `harness/cli.py`
- Create: `tests/harness/test_cli.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/harness/test_cli.py
from pathlib import Path
from unittest.mock import MagicMock, patch

from click.testing import CliRunner

from harness.cli import main


def test_list_finds_scenarios(tmp_path):
    scenarios = tmp_path / "scenarios"
    (scenarios / "alpha").mkdir(parents=True)
    (scenarios / "alpha" / "story.md").write_text("---\nid: alpha\n---\n")
    (scenarios / "beta").mkdir()
    (scenarios / "beta" / "story.md").write_text("---\nid: beta\n---\n")
    (scenarios / "not-a-scenario").mkdir()  # no story.md
    runner = CliRunner()
    result = runner.invoke(main, ["list", "--scenarios-root", str(scenarios)])
    assert result.exit_code == 0
    assert "alpha" in result.output
    assert "beta" in result.output
    assert "not-a-scenario" not in result.output


def test_run_invokes_run_scenario(tmp_path):
    sd = tmp_path / "scenarios" / "x"
    sd.mkdir(parents=True)
    (sd / "story.md").write_text("---\nid: x\n---\n")
    runner = CliRunner()
    with patch("harness.cli.run_scenario") as mock:
        mock.return_value = MagicMock(final="pass", to_dict=lambda: {"final": "pass"})
        result = runner.invoke(main, [
            "run", str(sd),
            "--target", "claude",
            "--targets-dir", str(tmp_path / "t"),
            "--contexts-dir", str(tmp_path / "c"),
            "--out-root", str(tmp_path / "out"),
            "--bin-dir", str(tmp_path / "bin"),
        ])
        assert result.exit_code == 0
        mock.assert_called_once()
```

- [ ] **Step 2: Run; fail**

```bash
uv run pytest tests/harness/test_cli.py -v
```

- [ ] **Step 3: Implement**

```python
# harness/cli.py
"""click CLI: harness run, harness list."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import click

from harness.runner import run_scenario


# TODO(phase-3): when drill is decommissioned, scenarios move to top-level
# scenarios/ and target_contexts/targets/ may relocate.
_DEFAULT_SCENARIOS_ROOT = Path("harness/scenarios")
_DEFAULT_TARGETS_DIR = Path("harness/targets")
_DEFAULT_CONTEXTS_DIR = Path("harness/target_contexts")
_DEFAULT_OUT_ROOT = Path("results-harness")
_DEFAULT_BIN_DIR = Path("bin")


@click.group()
def main() -> None:
    """Eval harness wrapping Gauntlet for skill-compliance benchmarks."""


@main.command("run")
@click.argument("scenario_dir", type=click.Path(exists=True, file_okay=False, path_type=Path))
@click.option("--target", required=True, help="Target name (matches harness/targets/<name>.yaml)")
@click.option("--targets-dir", default=_DEFAULT_TARGETS_DIR, type=click.Path(path_type=Path))
@click.option("--contexts-dir", default=_DEFAULT_CONTEXTS_DIR, type=click.Path(path_type=Path))
@click.option("--out-root", default=_DEFAULT_OUT_ROOT, type=click.Path(path_type=Path))
@click.option("--bin-dir", default=_DEFAULT_BIN_DIR, type=click.Path(path_type=Path))
def run(scenario_dir: Path, target: str, targets_dir: Path, contexts_dir: Path,
        out_root: Path, bin_dir: Path) -> None:
    """Run one scenario against one target."""
    out_root.mkdir(parents=True, exist_ok=True)
    verdict = run_scenario(
        scenario_dir=scenario_dir, target=target,
        targets_dir=targets_dir, contexts_dir=contexts_dir,
        out_root=out_root, bin_dir=bin_dir,
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

- [ ] **Step 4: Run; pass; lint; commit**

```bash
uv run pytest tests/harness/test_cli.py -v
uv run ruff check harness/cli.py tests/harness/test_cli.py
uv run ty check harness/cli.py
git add harness/cli.py tests/harness/test_cli.py
git commit -m "harness: click CLI (run with --target, list)"
```

---

### Task 12: Author Claude target config + context

**Files:**
- Create: `harness/targets/claude.yaml`
- Create: `harness/target_contexts/claude/HOWTO.md`

- [ ] **Step 1: Write `harness/targets/claude.yaml`**

```yaml
name: claude
binary: claude
session_log_dir: ~/.claude/projects
session_log_glob: "**/session-*.jsonl"
normalizer: claude
required_env:
  - ANTHROPIC_API_KEY
  - SUPERPOWERS_ROOT
max_time: 10m
```

- [ ] **Step 2: Write `harness/target_contexts/claude/HOWTO.md`**

```markdown
# How to drive Claude Code (the agent under test)

You are driving Claude Code in a bash shell inside tmux. Claude Code is
itself an AI agent; what appears on screen is its work.

## Invocation

Run:

```
claude --dangerously-skip-permissions --plugin-dir $SUPERPOWERS_ROOT --model opus
```

`$SUPERPOWERS_ROOT` is set in the inherited environment.

## Observing what Claude is doing

Claude writes its session log as JSONL files under
`~/.claude/projects/<derived-path>/session-*.jsonl`. You can `tail` or
`jq` this file to see what tools Claude has invoked. Useful when the
screen is mid-render or you want ground truth on tool usage.

The exact subdirectory under `~/.claude/projects/` is derived from the
cwd Claude was launched in. After launching, find the newest matching
file:

```
find ~/.claude/projects -name 'session-*.jsonl' -mmin -5 -print
```

## Shutdown

Type `/exit` and press Enter to end the session cleanly.
```

- [ ] **Step 3: Commit**

```bash
git add harness/targets/claude.yaml harness/target_contexts/claude/
git commit -m "harness: author Claude target config + HOWTO context"
```

---

### Task 13: Author Codex target config + context

**Files:**
- Create: `harness/targets/codex.yaml`
- Create: `harness/target_contexts/codex/HOWTO.md`

- [ ] **Step 1: Write `harness/targets/codex.yaml`**

```yaml
name: codex
binary: codex
session_log_dir: ~/.codex/sessions
session_log_glob: "rollout-*.jsonl"
normalizer: codex
required_env:
  - OPENAI_API_KEY
  - SUPERPOWERS_ROOT
max_time: 10m
```

- [ ] **Step 2: Write `harness/target_contexts/codex/HOWTO.md`**

```markdown
# How to drive Codex (the agent under test)

You are driving Codex in a bash shell inside tmux. Codex is itself an
AI agent; what appears on screen is its work.

## Invocation

Run:

```
codex --dangerously-bypass-approvals-and-sandbox
```

For superpowers tool-mapping scenarios that use the legacy `.agents`
symlink path, the setup step creates `.agents/skills/superpowers/` in
the workdir before you start.

## Observing what Codex is doing

Codex writes rollout logs as JSONL files under
`~/.codex/sessions/rollout-*.jsonl`. Multiple Codex sessions across all
projects share this directory. Find the newest file:

```
ls -t ~/.codex/sessions/rollout-*.jsonl | head -1
```

`tail` or `jq` it to see Codex's tool invocations.

## Shutdown

Press Ctrl+D to end the session cleanly.
```

- [ ] **Step 3: Commit**

```bash
git add harness/targets/codex.yaml harness/target_contexts/codex/
git commit -m "harness: author Codex target config + HOWTO context"
```

---

### Task 14: Convert scenario 1 — `triggering-writing-plans`

Smallest parity test. Single turn-equivalent prose, single assertion.

**Files:**
- Create: `harness/scenarios/triggering-writing-plans/story.md`
- Create: `harness/scenarios/triggering-writing-plans/setup.sh`
- Create: `harness/scenarios/triggering-writing-plans/assertions/01-skill-called.sh`

Reference: `scenarios/triggering-writing-plans.yaml`, `setup_helpers/base.py:create_base_repo`.

- [ ] **Step 1: Write `story.md`** (rewritten per `writing-gauntlet-stories`)

```markdown
---
id: triggering-writing-plans
title: Agent loads writing-plans skill before implementing a multi-step spec
status: ready
tags: skill-triggering
---

You are an engineer handing the agent under test a multi-step
authentication spec. Once it has loaded a skill or started planning,
you are done.

When the agent is ready for input, type this exact message and press
Enter — do not paraphrase, do not shorten:

"Here's the spec for our new authentication system:

Requirements:
- Users can register with email/password
- Users can log in and receive a JWT token
- Protected routes require valid JWT
- Tokens expire after 24 hours
- Support password reset via email

We need to implement this. There are multiple steps involved - user
model, auth routes, middleware, email service integration."

Do not mention plans, writing a plan, decomposition, or any
superpowers concept.

## Acceptance Criteria

- The agent under test loaded the `superpowers:writing-plans` skill
  before writing any implementation code. Evidence: a `Skill` tool
  invocation naming `superpowers:writing-plans` appears in the agent's
  session log under `~/.claude/projects/.../session-*.jsonl`, OR an
  equivalent shell invocation reading the skill's SKILL.md.
```

- [ ] **Step 2: Write `setup.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
# DRILL_WORKDIR is set by harness.setup_step. Reuse the existing
# setup_helpers package; eventually a setup_helpers CLI replaces this.
exec uv run python -c "
import os, pathlib
from setup_helpers.base import create_base_repo
create_base_repo(pathlib.Path(os.environ['DRILL_WORKDIR']))
"
```

```bash
chmod +x harness/scenarios/triggering-writing-plans/setup.sh
```

- [ ] **Step 3: Write `assertions/01-skill-called.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
exec skill-called superpowers:writing-plans
```

```bash
mkdir -p harness/scenarios/triggering-writing-plans/assertions
chmod +x harness/scenarios/triggering-writing-plans/assertions/01-skill-called.sh
```

- [ ] **Step 4: Verify discovery**

```bash
uv run harness list --scenarios-root harness/scenarios
```

Expected: prints `triggering-writing-plans`.

- [ ] **Step 5: Commit**

```bash
git add harness/scenarios/triggering-writing-plans/
git commit -m "scenarios: port triggering-writing-plans to harness format"
```

---

### Task 15: Convert scenario 2 — `worktree-already-inside`

Exercises multi-helper setup. The QA agent reads the story prose and the filesystem (via bash) to discover the existing-worktree subdir; it `cd`s there before invoking claude. No `.harness-launch-cwd` mechanism.

**Files:**
- Create: `harness/scenarios/worktree-already-inside/story.md`
- Create: `harness/scenarios/worktree-already-inside/setup.sh`
- Create: `harness/scenarios/worktree-already-inside/assertions/01-no-new-worktree.sh`

Reference: `scenarios/worktree-already-inside.yaml`, `setup_helpers/worktree.py:add_existing_worktree`.

- [ ] **Step 1: Write `story.md`**

```markdown
---
id: worktree-already-inside
title: Agent doesn't create a new worktree when already inside one
status: ready
tags: worktree
---

You are an engineer working inside an existing feature-branch worktree
on a project. The setup step created two worktrees in this project:
the main one (your default working directory) and a sibling whose name
ends `-existing-worktree`. You are supposed to be working *inside the
existing worktree* — `cd` into it before invoking the agent under test.

You only get one turn. Ask the agent (in plain language, no
superpowers vocabulary) to create an isolated workspace for building a
signup feature. Once it responds, you are done.

## Acceptance Criteria

- After the run, the project still has exactly two worktrees (main +
  the existing-feature worktree). No new worktree was added. Evidence:
  run `git worktree list` from the main workdir before reporting.
- The agent's response indicated, in some form, that the current
  worktree is already isolated and sufficient.
```

- [ ] **Step 2: Write `setup.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
exec uv run python -c "
import os, pathlib
from setup_helpers.base import create_base_repo
from setup_helpers.worktree import add_existing_worktree
wd = pathlib.Path(os.environ['DRILL_WORKDIR'])
create_base_repo(wd)
add_existing_worktree(wd)
"
```

```bash
chmod +x harness/scenarios/worktree-already-inside/setup.sh
```

- [ ] **Step 3: Write `assertions/01-no-new-worktree.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
COUNT=$(cd "$DRILL_WORKDIR" && git worktree list | wc -l | tr -d ' ')
if [ "$COUNT" = "2" ]; then
    echo "PASS: still 2 worktrees"
    exit 0
fi
echo "FAIL: expected 2 worktrees, found $COUNT"
cd "$DRILL_WORKDIR" && git worktree list
exit 1
```

```bash
mkdir -p harness/scenarios/worktree-already-inside/assertions
chmod +x harness/scenarios/worktree-already-inside/assertions/01-no-new-worktree.sh
```

- [ ] **Step 4: Commit**

```bash
git add harness/scenarios/worktree-already-inside/
git commit -m "scenarios: port worktree-already-inside (QA agent navigates via bash)"
```

---

### Task 16: Convert scenario 3 — `codex-subagent-wait-mapping`

Codex-only via `scenario.yaml`. Exercises the Codex normalizer + cwd-filter.

**Files:**
- Create: `harness/scenarios/codex-subagent-wait-mapping/story.md`
- Create: `harness/scenarios/codex-subagent-wait-mapping/scenario.yaml`
- Create: `harness/scenarios/codex-subagent-wait-mapping/setup.sh`
- Create: `harness/scenarios/codex-subagent-wait-mapping/assertions/*.sh`

Reference: `scenarios/codex-subagent-wait-mapping.yaml`.

- [ ] **Step 1: Write `story.md`**

```markdown
---
id: codex-subagent-wait-mapping
title: Codex uses wait_agent (not wait) when collecting subagent results
status: ready
tags: codex, tool-mapping
---

You are an engineer testing whether the Codex agent follows the
Superpowers tool-mapping reference. When Codex is ready, type this
exact message and press Enter — do not paraphrase:

"Read .agents/skills/superpowers/using-superpowers/references/codex-tools.md.
Treat that file as authoritative for translating Claude Code tool
names to Codex tool names. Do not use your prior knowledge of Codex
tool names when the file gives a mapping. Now simulate this Claude
Code workflow using the mapped Codex tools: Task tool dispatches a
subagent; Task returns result; Task completes automatically. The
subagent's whole job is to answer exactly PR963_OK. Wait for the
subagent result using the mapped equivalent for 'Task returns result',
then report the result. Do not edit files."

If Codex asks a short clarifying question, answer briefly and tell it
to follow the mapping file. Once it reports PR963_OK or says it
cannot complete the mapped wait step, you are done.

## Acceptance Criteria

- Codex invoked `spawn_agent` (the subagent-spawn tool).
- Codex invoked `wait_agent` (the mapped equivalent of "Task returns
  result").
- Codex did NOT invoke the bare `wait` tool.
- `spawn_agent` was invoked before `wait_agent`.
```

- [ ] **Step 2: Write `scenario.yaml`**

```yaml
compatible_targets:
  - codex
```

- [ ] **Step 3: Write `setup.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail
exec uv run python -c "
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

- [ ] **Step 4: Write four assertions**

```bash
mkdir -p harness/scenarios/codex-subagent-wait-mapping/assertions
cat > harness/scenarios/codex-subagent-wait-mapping/assertions/01-spawn-agent-called.sh <<'EOF'
#!/usr/bin/env bash
exec tool-called spawn_agent
EOF
cat > harness/scenarios/codex-subagent-wait-mapping/assertions/02-wait-agent-called.sh <<'EOF'
#!/usr/bin/env bash
exec tool-called wait_agent
EOF
cat > harness/scenarios/codex-subagent-wait-mapping/assertions/03-wait-not-called.sh <<'EOF'
#!/usr/bin/env bash
exec tool-not-called wait
EOF
cat > harness/scenarios/codex-subagent-wait-mapping/assertions/04-spawn-before-wait.sh <<'EOF'
#!/usr/bin/env bash
exec tool-before spawn_agent wait_agent
EOF
chmod +x harness/scenarios/codex-subagent-wait-mapping/assertions/*.sh
```

- [ ] **Step 5: Commit**

```bash
git add harness/scenarios/codex-subagent-wait-mapping/
git commit -m "scenarios: port codex-subagent-wait-mapping (Codex-only)"
```

---

### Task 17: Initialize migration-notes.md

Forcing-function file for skipped/deferred decisions during the migration.

**Files:**
- Create: `docs/migration-notes.md`

- [ ] **Step 1: Write the file**

```markdown
# Migration Notes

Tracks decisions, deferrals, and skipped scenarios during the Drill→Gauntlet
migration. Reviewed before Phase 3 decommission.

## Phase 1 deferrals

- **Token-cost wiring.** `harness/token_usage.py` is lifted from Drill but
  the runner doesn't yet call it. The three Phase 1 scenarios don't need
  cost data. Wire when the first cost-* scenario ports (Phase 2).
- **`setup.sh` shell-out latency.** Each scenario's `setup.sh` invokes
  `uv run python -c "..."` to call `setup_helpers/`, costing ~600ms per run.
  Acceptable for 3-scenario manual Phase 1. Promote to a `setup_helpers run
  <name>` CLI in Phase 2 when sweep-N runs make it visible.
- **PATH inheritance in assertions.** Phase 1 is not a CI workload. Document
  required tooling (jq, git, python) in the harness README before any CI
  integration.

## Phase 1 parity outcomes

Filled in by Tasks 18, 19, 20.
```

- [ ] **Step 2: Commit**

```bash
git add docs/migration-notes.md
git commit -m "docs: initialize migration-notes.md with phase 1 deferrals"
```

---

### Task 18: Parity run — scenario 1 (manual)

This task requires real API keys + a Claude Code install. Run interactively.

- [ ] **Step 1: Run the Drill version**

```bash
export ANTHROPIC_API_KEY=...
export SUPERPOWERS_ROOT=/path/to/superpowers
uv run drill run triggering-writing-plans -b claude
```

Record: result dir, verdict, contents of `tool_calls.jsonl`.

- [ ] **Step 2: Run the harness version**

```bash
uv run harness run harness/scenarios/triggering-writing-plans --target claude
```

Record: same items, from `results-harness/triggering-writing-plans-claude-<ts>/`.

- [ ] **Step 3: Diff captured tool calls**

```bash
diff <(jq -S . results/.../tool_calls.jsonl) \
     <(jq -S . results-harness/.../tool_calls.jsonl)
```

Expected: byte-identical, or schema-equivalent ordering differences only.

- [ ] **Step 4: Append outcome to `docs/migration-notes.md`** under "Phase 1 parity outcomes"

```markdown
### triggering-writing-plans

- Drill verdict: <pass|fail>
- Harness verdict: <pass|fail>
- tool_calls.jsonl: <byte-equivalent | schema-equivalent | divergent — explain>
- Notes: <anything observed>
```

- [ ] **Step 5: Commit**

```bash
git add docs/migration-notes.md
git commit -m "docs: parity outcome for triggering-writing-plans"
```

---

### Task 19: Parity run — scenario 2 (manual)

Same shape as Task 18, scenario name `worktree-already-inside`. Pay attention to whether the QA agent successfully navigated into the existing-worktree subdir before invoking claude.

---

### Task 20: Parity run — scenario 3 (manual)

Same shape as Task 18, scenario name `codex-subagent-wait-mapping`, target `codex`. The first scenario to exercise the Codex normalizer + cwd-filter end-to-end. If `tool_calls.jsonl` is empty when the Drill version captures rows, the cwd-filter is the most likely cause.

---

### Task 21: Phase 1 full-suite verification

Run all three through the harness, run all three through Drill, summarize.

- [ ] **Step 1: Run all three harness scenarios**

```bash
for s in triggering-writing-plans worktree-already-inside codex-subagent-wait-mapping; do
    echo "=== $s ==="
    target=claude
    [ "$s" = codex-subagent-wait-mapping ] && target=codex
    uv run harness run "harness/scenarios/$s" --target "$target" || echo "FAILED: $s"
done
```

- [ ] **Step 2: Run all three Drill scenarios**

```bash
for s in triggering-writing-plans worktree-already-inside codex-subagent-wait-mapping; do
    backend=claude
    [ "$s" = codex-subagent-wait-mapping ] && backend=codex-no-hooks
    uv run drill run "$s" -b "$backend"
done
```

- [ ] **Step 3: Append Phase 1 status table to `docs/migration-notes.md`**

```markdown
## Phase 1 status

| Scenario | Drill | Harness | tool_calls parity | Notes |
|----------|-------|---------|-------------------|-------|
| triggering-writing-plans | … | … | … | |
| worktree-already-inside | … | … | … | |
| codex-subagent-wait-mapping | … | … | … | |

Phase 1 verdict: <ready-for-phase-2 | needs-rework — reason>
```

- [ ] **Step 4: Confirm pre-existing tests still pass**

```bash
uv run pytest -v
```

Expected: no regressions.

- [ ] **Step 5: Commit**

```bash
git add docs/migration-notes.md
git commit -m "docs: phase 1 status across all three scenarios"
```

---

### Task 22: Update README and CLAUDE.md

The repo's top-level docs currently describe only Drill.

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add a "Harness" section to `README.md`** after "How Drill Works"

```markdown
## Harness (Drill → Gauntlet migration in progress)

`harness/` is a Python harness that wraps the
[Gauntlet](../gauntlet) QA framework to reproduce Drill's eval-lab
capabilities. Gauntlet drives the target (the agent under test) via
its TUI adapter and reads both the screen and the agent's session log
via bash. The harness handles per-scenario workdir setup and post-run
deterministic assertions that regression-test the acceptance criteria.

Phase 1 ports three representative scenarios; Phase 2 ports the rest;
Phase 3 deletes Drill. See [`docs/gauntlet-migration.md`](docs/gauntlet-migration.md).

Run a harness scenario:

```bash
uv run harness run harness/scenarios/triggering-writing-plans --target claude
uv run harness list
```

Per-target config lives in `harness/targets/<name>.yaml`; per-target
HOWTO context in `harness/target_contexts/<name>/`.
```

- [ ] **Step 2: Add a `## Harness commands` section to `CLAUDE.md`**

```markdown
## Harness commands

- **run scenario**: `uv run harness run harness/scenarios/<name> --target <name>`
- **list**: `uv run harness list`

Per-target config: `harness/targets/<name>.yaml`. Per-target HOWTO:
`harness/target_contexts/<name>/`. Spec: `docs/gauntlet-migration.md`.
```

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: introduce harness in README and CLAUDE.md"
```

---

## Self-Review

**Spec coverage** — each load-bearing v2 spec claim mapped to tasks:

| Spec claim | Plan task(s) |
|---|---|
| Harness owns workdir setup | Task 6 (setup_step), Tasks 14/15/16 (setup.sh per scenario) |
| Harness owns log capture+normalization | Tasks 2 (normalizers), 7 (capture), 10 (runner glue) |
| Harness owns AC regression-test assertions | Task 8 (assertions runner), Tasks 14/15/16 (per-scenario assertions) |
| Agent/Verifier collapse: QA agent has bash | No code change needed (Gauntlet provides this) |
| Per-target config in `harness/targets/<name>.yaml` | Task 4 (loader), Tasks 12/13 (author) |
| Per-target HOWTO context | Task 10 (runner copies into .gauntlet/context/), Tasks 12/13 (author) |
| Optional `scenario.yaml` compatibility hint | Task 5 (loader), Task 10 (runner enforces), Task 16 (uses) |
| All-must-pass composition | Task 9 (composer) |
| Empty-capture parity guard | Task 10 (runner step 10) |
| Lockfile single-run-at-a-time | Task 10 (runner) |
| Workdir kept on failure | Task 10 (runner) |
| Forcing function for skipped scenarios | Task 17 + Tasks 18/19/20 |
| Phase 1 = three scenarios | Tasks 14, 15, 16, 18, 19, 20 |

**Placeholder scan:** none of the red-flag patterns found.

**Type consistency:** `FinalVerdict.gauntlet` is `Literal["pass", "fail", "investigate"]`; runner passes whatever Gauntlet's `result.json` contains. Composer handles all three.

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-05-18-gauntlet-migration-phase-1.md`. Two execution options:

1. **Subagent-driven** (recommended) — fresh subagent per task, review between, fast iteration.
2. **Inline** — execute in current session via `superpowers:executing-plans`, batch with checkpoints.

Will pick after the plan review fires.
