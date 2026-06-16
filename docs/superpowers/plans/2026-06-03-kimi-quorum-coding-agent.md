# Kimi Quorum Coding-Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Kimi Code as a first-class Quorum Coding-Agent target without binding to local `~/.kimi-code`, while proving Superpowers plugin bootstrap, fail-closing harness capture problems, and capturing unpriced Kimi token counts.

**Architecture:** Keep Kimi inside the existing Quorum Coding-Agent adapter model, but move Kimi-specific auth, env, plugin, preflight, and raw-wire checks into a focused `quorum/kimi.py` helper module. `quorum/runner.py` remains the orchestrator: it asks the Kimi helper to provision isolated state, passes the generated launcher substitutions to Gauntlet, runs central Kimi capture invariants, and always converts setup/capture errors into structured indeterminate verdicts. `quorum/run_all.py` owns batch-level Kimi preflight so multi-scenario Kimi sweeps preflight once before scheduling children.

**Tech Stack:** Python 3.11+, uv, pytest, ty, ruff, Bash check tools, jq, Gauntlet TUI adapter, Kimi Code CLI `kimi`.

**Spec:** [docs/superpowers/specs/2026-06-03-kimi-quorum-coding-agent-design.md](../specs/2026-06-03-kimi-quorum-coding-agent-design.md)

---

## File Structure

**Create:**
- `quorum/kimi.py` - Kimi-specific env contract, sanitized subprocess env, runtime env-file writing/cleanup metadata, Superpowers plugin validation/install, stream-json preflight parsing, raw `plugin_session_start` scan, and Kimi wire token parsing helpers.
- `tests/quorum/test_kimi.py` - focused unit tests for `quorum/kimi.py`.

**Modify:**
- `coding-agents/kimi.yaml` - require `KIMI_MODEL_API_KEY` in addition to `SUPERPOWERS_ROOT`.
- `coding-agents/kimi-context/launch-agent` - source the runtime env file with export semantics, clean it, then `exec kimi --yolo`.
- `coding-agents/kimi-context/HOWTO.md` - remove symlinked-auth language, avoid env-file path exposure, keep one-command launcher and log-observation guidance.
- `bin/kimi-plugin-installed` - validate exactly one enabled `superpowers` plugin with `source == "local-path"`, root realpath equal to `SUPERPOWERS_ROOT`, and no copied managed plugin root.
- `scenarios/kimi-superpowers-bootstrap/checks.sh` - keep bootstrap behavior checks and rely on central runner/capture invariant for raw `plugin_session_start`.
- `quorum/coding_agent_config.py` - no broad schema change; keep required env behavior.
- `quorum/runner.py` - catch config errors as setup indeterminate, replace stale `_seed_kimi_config`, support provisioning substitutions/cleanup, run Kimi preflight, and fail closed on Kimi capture invariants.
- `quorum/capture.py` - add helper(s) to distinguish Kimi cwd mismatch from truly missing logs.
- `quorum/normalizers.py` - no change planned; the current Kimi tool-call normalization stays as the supported shape for this implementation.
- `quorum/token_usage.py` - add Kimi `usage.record` parsing and unpriced aggregation.
- `quorum/economics.py` - make sure Kimi null coding-agent cost keeps total economics partial.
- `quorum/run_all.py` - add parent-process Kimi preflight and per-cell setup indeterminate records on parent preflight failure.
- `tests/quorum/test_coding_agent_config.py` - Kimi required-env assertions.
- `tests/quorum/test_runner.py` - Kimi provisioning, launcher, cleanup, fail-closed, and no-secret tests.
- `tests/quorum/test_runner_always_verdict.py` - config-loader setup-stage diagnostic coverage.
- `tests/quorum/test_capture.py` - Kimi cwd-mismatch detection and Kimi token capture integration.
- `tests/quorum/test_token_usage.py` - Kimi usage-scope aggregation and null-cost behavior.
- `tests/quorum/test_trace_tools.py` - `kimi-plugin-installed` local-path and root-realpath behavior.
- `tests/quorum/test_run_all.py` - one batch preflight, parent preflight failure records, and child marker env.
- `README.md` - Kimi live eval setup, safety, and troubleshooting.
- `SECURITY.md` - Kimi `--yolo`, raw wire log sensitivity, and untrusted-PR live-run warning.

**Do Not Change:**
- Public CI must not run live Kimi.
- Do not add generated provider `config.toml` fallback.
- Do not use `--skills-dir`.
- Do not copy, read, or symlink from local `~/.kimi-code`.
- Do not add a generic plugin-source abstraction for all agents.

---

## Task 1: Config Surface and Setup-Stage Missing-Env Verdicts

**Why first:** The runner currently lets `CodingAgentConfigError` fall into the generic unexpected-crash path. Kimi missing `KIMI_MODEL_API_KEY` must become setup-stage indeterminate with no Gauntlet launch.

**Files:**
- Modify: `coding-agents/kimi.yaml`
- Modify: `quorum/runner.py`
- Test: `tests/quorum/test_coding_agent_config.py`
- Test: `tests/quorum/test_runner_always_verdict.py`

- [ ] **Step 1: Write the failing config test**

In `tests/quorum/test_coding_agent_config.py`, update `test_kimi_config_loads_when_superpowers_root_set`:

```python
def test_kimi_config_loads_when_superpowers_root_set(monkeypatch, tmp_path):
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "superpowers"))
    monkeypatch.setenv("KIMI_MODEL_API_KEY", "fake-kimi-key")
    cfg = load_coding_agent_config(
        Path(__file__).resolve().parents[2] / "coding-agents" / "kimi.yaml"
    )

    assert cfg.name == "kimi"
    assert cfg.binary == "kimi"
    assert cfg.agent_config_env == "KIMI_CODE_HOME"
    assert cfg.required_env == ("SUPERPOWERS_ROOT", "KIMI_MODEL_API_KEY")
    assert cfg.normalizer == "kimi"
    assert cfg.resolve_session_log_dir(tmp_path / "cfg") == (
        tmp_path / "cfg" / "sessions"
    )
```

Add:

```python
def test_kimi_config_requires_model_api_key(monkeypatch, tmp_path):
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "superpowers"))
    monkeypatch.delenv("KIMI_MODEL_API_KEY", raising=False)

    with pytest.raises(CodingAgentConfigError, match="KIMI_MODEL_API_KEY"):
        load_coding_agent_config(
            Path(__file__).resolve().parents[2] / "coding-agents" / "kimi.yaml"
        )
```

- [ ] **Step 2: Write the failing runner diagnostic test**

In `tests/quorum/test_runner_always_verdict.py`, add:

```python
def test_coding_agent_config_error_is_setup_indeterminate(tmp_path):
    scen = tmp_path / "s"
    scen.mkdir()
    (scen / "story.md").write_text("---\nid: x\ntitle: t\n---\n")
    _exec(scen / "setup.sh", "#!/usr/bin/env bash\nexit 0\n")
    (scen / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")

    coding_agents_dir = tmp_path / "coding-agents"
    coding_agents_dir.mkdir()
    (coding_agents_dir / "kimi.yaml").write_text(
        yaml.safe_dump(
            {
                "name": "kimi",
                "binary": "kimi",
                "agent_config_env": "KIMI_CODE_HOME",
                "session_log_dir": "${KIMI_CODE_HOME}/sessions",
                "session_log_glob": "**/wire.jsonl",
                "normalizer": "kimi",
                "required_env": ["KIMI_MODEL_API_KEY"],
            }
        )
    )

    with patch("quorum.runner.invoke_gauntlet") as mock_gauntlet:
        run_dir, verdict = run_scenario(
            scenario_dir=scen,
            coding_agent="kimi",
            coding_agents_dir=coding_agents_dir,
            out_root=tmp_path / "results",
            skeleton_root=tmp_path / "fixtures",
        )

    mock_gauntlet.assert_not_called()
    assert verdict.final == "indeterminate"
    assert verdict.error is not None
    assert verdict.error.stage == "setup"
    assert "KIMI_MODEL_API_KEY" in verdict.error.message
    assert json.loads((run_dir / "verdict.json").read_text())["error"]["stage"] == "setup"
```

- [ ] **Step 3: Run the targeted tests and verify failure**

Run:

```bash
uv run pytest tests/quorum/test_coding_agent_config.py::test_kimi_config_loads_when_superpowers_root_set tests/quorum/test_coding_agent_config.py::test_kimi_config_requires_model_api_key tests/quorum/test_runner_always_verdict.py::test_coding_agent_config_error_is_setup_indeterminate -q
```

Expected: FAIL because `coding-agents/kimi.yaml` does not require `KIMI_MODEL_API_KEY`, and `run_scenario` currently catches config errors through the unexpected exception path.

- [ ] **Step 4: Update `coding-agents/kimi.yaml`**

Change:

```yaml
required_env:
  - SUPERPOWERS_ROOT
```

to:

```yaml
required_env:
  - SUPERPOWERS_ROOT
  - KIMI_MODEL_API_KEY
```

- [ ] **Step 5: Catch config errors in `quorum/runner.py`**

Update the import:

```python
from quorum.coding_agent_config import (
    CodingAgentConfig,
    CodingAgentConfigError,
    load_coding_agent_config,
)
```

Add this `except` block in `run_scenario(...)`, before `except SetupError`:

```python
    except CodingAgentConfigError as e:
        v = _write_indeterminate(
            run_dir,
            final_reason=f"coding-agent config failed: {e}",
            error=RunError(stage="setup", message=str(e)[:500]),
        )
        return run_dir, v
```

- [ ] **Step 6: Run the tests and commit**

Run:

```bash
uv run pytest tests/quorum/test_coding_agent_config.py tests/quorum/test_runner_always_verdict.py -q
```

Expected: PASS.

Commit:

```bash
git add coding-agents/kimi.yaml quorum/runner.py tests/quorum/test_coding_agent_config.py tests/quorum/test_runner_always_verdict.py
git commit -m "quorum: surface kimi config errors as setup verdicts"
```

---

## Task 2: Kimi Env Contract, Sanitized Env, and Runtime Env File

**Why now:** The Kimi harness cannot be reproducible until host env overrides are explicit and the secret-bearing env file is outside `results/` with deterministic cleanup metadata.

**Files:**
- Create: `quorum/kimi.py`
- Test: `tests/quorum/test_kimi.py`
- Reference: `quorum/runner.py` - runner integration starts in Task 3.

- [ ] **Step 1: Write failing Kimi env tests**

Create `tests/quorum/test_kimi.py` with:

```python
import json
import os
import stat
import subprocess
from pathlib import Path

import pytest

from quorum.kimi import (
    KimiConfigError,
    build_kimi_subprocess_env,
    effective_kimi_model_env,
    write_effective_kimi_config,
    write_kimi_runtime_env_file,
)


def test_effective_env_allows_only_api_key_and_model_name(monkeypatch):
    monkeypatch.setenv("KIMI_MODEL_API_KEY", "fake-key")
    monkeypatch.setenv("KIMI_MODEL_NAME", "kimi-custom")
    monkeypatch.setenv("KIMI_MODEL_BASE_URL", "https://wrong.example")

    with pytest.raises(KimiConfigError, match="KIMI_MODEL_BASE_URL"):
        effective_kimi_model_env(os.environ)


def test_effective_env_supplies_defaults(monkeypatch):
    monkeypatch.setenv("KIMI_MODEL_API_KEY", "fake-key")
    monkeypatch.delenv("KIMI_MODEL_NAME", raising=False)

    env = effective_kimi_model_env(os.environ)

    assert env["KIMI_MODEL_API_KEY"] == "fake-key"
    assert env["KIMI_MODEL_NAME"] == "kimi-for-coding"
    assert env["KIMI_MODEL_PROVIDER_TYPE"] == "kimi"
    assert env["KIMI_MODEL_BASE_URL"] == "https://api.kimi.com/coding/v1"
    assert env["KIMI_DISABLE_TELEMETRY"] == "1"
    assert env["KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT"] == "false"


def test_sanitized_env_drops_host_state(monkeypatch, tmp_path):
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    monkeypatch.setenv("HOME", "/real/home")
    monkeypatch.setenv("XDG_CONFIG_HOME", "/real/xdg")
    monkeypatch.setenv("KIMI_CODE_HOME", "/real/kimi")
    monkeypatch.setenv("MOONSHOT_API_KEY", "do-not-copy")

    kimi_home = tmp_path / "kimi-home"
    env = build_kimi_subprocess_env(
        base_env=os.environ,
        kimi_home=kimi_home,
        cwd=tmp_path / "cwd",
        kimi_model_env={"KIMI_MODEL_API_KEY": "fake-key", "KIMI_MODEL_NAME": "kimi"},
    )

    assert env["PATH"] == "/usr/bin:/bin"
    assert env["HOME"] == str(kimi_home / "home")
    assert env["KIMI_CODE_HOME"] == str(kimi_home)
    assert env["KIMI_CODE_CACHE_DIR"] == str(kimi_home / "cache")
    assert env["XDG_CONFIG_HOME"] == str(kimi_home / "xdg-config")
    assert env["XDG_CACHE_HOME"] == str(kimi_home / "xdg-cache")
    assert env["XDG_DATA_HOME"] == str(kimi_home / "xdg-data")
    assert "MOONSHOT_API_KEY" not in env


def test_runtime_env_file_is_0600_outside_run_dir_and_sourceable(tmp_path):
    run_dir = tmp_path / "results" / "run"
    run_dir.mkdir(parents=True)
    env_file = write_kimi_runtime_env_file(
        {
            "KIMI_MODEL_API_KEY": "fake key with spaces",
            "KIMI_MODEL_NAME": "kimi-for-coding",
        },
        run_dir=run_dir,
    )

    assert not str(env_file).startswith(str(run_dir))
    assert stat.S_IMODE(env_file.stat().st_mode) == 0o600

    script = "set -a; . \"$1\"; set +a; printf '%s\\n' \"$KIMI_MODEL_API_KEY\""
    result = subprocess.run(
        ["bash", "-c", script, "bash", str(env_file)],
        text=True,
        capture_output=True,
        check=True,
    )
    assert result.stdout.strip() == "fake key with spaces"


def test_effective_config_summary_redacts_api_key(tmp_path):
    path = write_effective_kimi_config(
        tmp_path,
        {
            "KIMI_MODEL_API_KEY": "fake-key",
            "KIMI_MODEL_NAME": "kimi-for-coding",
            "KIMI_MODEL_PROVIDER_TYPE": "kimi",
        },
        kimi_binary="/usr/bin/kimi",
        kimi_version="kimi 0.6.0",
    )

    data = json.loads(path.read_text())
    assert data["kimi_binary"] == "/usr/bin/kimi"
    assert data["kimi_version"] == "kimi 0.6.0"
    assert data["model_env"]["KIMI_MODEL_API_KEY"] == "<present>"
    assert "fake-key" not in path.read_text()
```

- [ ] **Step 2: Run the tests and verify failure**

Run:

```bash
uv run pytest tests/quorum/test_kimi.py -q
```

Expected: FAIL because `quorum/kimi.py` does not exist.

- [ ] **Step 3: Create `quorum/kimi.py` env helpers**

Create `quorum/kimi.py` with these initial helpers:

```python
from __future__ import annotations

import json
import os
import shlex
import stat
import tempfile
from pathlib import Path
from typing import Mapping


class KimiConfigError(RuntimeError):
    """Raised when Kimi provisioning or preflight cannot run safely."""


ALLOWED_HOST_KIMI_MODEL_ENV = {"KIMI_MODEL_API_KEY", "KIMI_MODEL_NAME"}
DEFAULT_KIMI_MODEL_ENV = {
    "KIMI_MODEL_NAME": "kimi-for-coding",
    "KIMI_MODEL_PROVIDER_TYPE": "kimi",
    "KIMI_MODEL_BASE_URL": "https://api.kimi.com/coding/v1",
    "KIMI_MODEL_MAX_CONTEXT_SIZE": "262144",
    "KIMI_MODEL_CAPABILITIES": "thinking,image_in,video_in,tool_use",
    "KIMI_MODEL_DEFAULT_THINKING": "true",
}
KIMI_RUNTIME_FLAGS = {
    "KIMI_DISABLE_TELEMETRY": "1",
    "KIMI_DISABLE_CRON": "1",
    "KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT": "false",
}


def effective_kimi_model_env(env: Mapping[str, str]) -> dict[str, str]:
    unknown = sorted(
        key for key in env if key.startswith("KIMI_MODEL_") and key not in ALLOWED_HOST_KIMI_MODEL_ENV
    )
    if unknown:
        raise KimiConfigError(
            "unsupported host KIMI_MODEL_* override(s): " + ", ".join(unknown)
        )
    api_key = env.get("KIMI_MODEL_API_KEY")
    if not api_key:
        raise KimiConfigError("KIMI_MODEL_API_KEY is required for Kimi evals")
    merged = {**DEFAULT_KIMI_MODEL_ENV, **KIMI_RUNTIME_FLAGS}
    merged["KIMI_MODEL_API_KEY"] = api_key
    if env.get("KIMI_MODEL_NAME"):
        merged["KIMI_MODEL_NAME"] = env["KIMI_MODEL_NAME"]
    return merged


def build_kimi_subprocess_env(
    *,
    base_env: Mapping[str, str],
    kimi_home: Path,
    cwd: Path,
    kimi_model_env: Mapping[str, str],
) -> dict[str, str]:
    allow_exact = {"PATH", "TERM", "LANG", "SHELL"}
    out = {key: value for key, value in base_env.items() if key in allow_exact}
    for key, value in base_env.items():
        if key.startswith("LC_") or key.lower().endswith("_proxy"):
            out[key] = value
    out.update(kimi_model_env)
    out["HOME"] = str(kimi_home / "home")
    out["KIMI_CODE_HOME"] = str(kimi_home)
    out["KIMI_CODE_CACHE_DIR"] = str(kimi_home / "cache")
    out["XDG_CONFIG_HOME"] = str(kimi_home / "xdg-config")
    out["XDG_CACHE_HOME"] = str(kimi_home / "xdg-cache")
    out["XDG_DATA_HOME"] = str(kimi_home / "xdg-data")
    out["PWD"] = str(cwd)
    return out


def _shell_assignment(key: str, value: str) -> str:
    return f"{key}={shlex.quote(value)}"


def write_kimi_runtime_env_file(env: Mapping[str, str], *, run_dir: Path) -> Path:
    secret_dir = Path(tempfile.mkdtemp(prefix=f"quorum-kimi-env-{run_dir.name}-"))
    path = secret_dir / "kimi-runtime.env"
    path.write_text("".join(_shell_assignment(k, v) + "\n" for k, v in sorted(env.items())))
    path.chmod(stat.S_IRUSR | stat.S_IWUSR)
    return path


def write_effective_kimi_config(
    kimi_home: Path,
    env: Mapping[str, str],
    *,
    kimi_binary: str | None,
    kimi_version: str | None,
) -> Path:
    payload = {
        "kimi_binary": kimi_binary,
        "kimi_version": kimi_version,
        "model_env": {
            key: ("<present>" if key == "KIMI_MODEL_API_KEY" else value)
            for key, value in sorted(env.items())
        },
    }
    path = kimi_home / "effective-kimi-model-config.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n")
    return path
```

- [ ] **Step 4: Run the Kimi helper tests**

Run:

```bash
uv run pytest tests/quorum/test_kimi.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add quorum/kimi.py tests/quorum/test_kimi.py
git commit -m "quorum: add kimi env contract helpers"
```

---

## Task 3: Superpowers Plugin Validation and Isolated Kimi Install

**Why now:** The stale implementation symlinks auth/config from `~/.kimi-code` and writes `source: "local"`. This task replaces that with `source: "local-path"` metadata rooted at `SUPERPOWERS_ROOT`.

**Files:**
- Modify: `quorum/kimi.py`
- Modify: `quorum/runner.py`
- Test: `tests/quorum/test_kimi.py`
- Test: `tests/quorum/test_runner.py`

- [ ] **Step 1: Add failing plugin tests in `tests/quorum/test_kimi.py`**

Append:

```python
from quorum.kimi import install_kimi_superpowers_plugin, validate_superpowers_kimi_root


def _superpowers_root(tmp_path: Path) -> Path:
    root = tmp_path / "superpowers"
    (root / ".kimi-plugin").mkdir(parents=True)
    (root / "skills" / "using-superpowers").mkdir(parents=True)
    (root / "skills" / "brainstorming").mkdir(parents=True)
    (root / ".kimi-plugin" / "plugin.json").write_text(
        json.dumps(
            {
                "name": "superpowers",
                "skills": "./skills/",
                "sessionStart": {"skill": "using-superpowers"},
                "skillInstructions": {"tools": {"Bash": "shell"}},
            }
        )
    )
    (root / "skills" / "using-superpowers" / "SKILL.md").write_text("skill")
    (root / "skills" / "brainstorming" / "SKILL.md").write_text("skill")
    return root


def test_validate_superpowers_kimi_root_accepts_manifest(tmp_path):
    root = _superpowers_root(tmp_path)
    assert validate_superpowers_kimi_root(root) == root.resolve()


def test_validate_superpowers_kimi_root_rejects_wrong_session_start(tmp_path):
    root = _superpowers_root(tmp_path)
    manifest = json.loads((root / ".kimi-plugin" / "plugin.json").read_text())
    manifest["sessionStart"]["skill"] = "other"
    (root / ".kimi-plugin" / "plugin.json").write_text(json.dumps(manifest))

    with pytest.raises(KimiConfigError, match="sessionStart.skill"):
        validate_superpowers_kimi_root(root)


def test_install_kimi_superpowers_plugin_writes_local_path_metadata(tmp_path):
    root = _superpowers_root(tmp_path)
    kimi_home = tmp_path / "kimi-home"

    installed_path = install_kimi_superpowers_plugin(kimi_home, root)

    installed = json.loads(installed_path.read_text())
    assert installed["version"] == 1
    assert len(installed["plugins"]) == 1
    plugin = installed["plugins"][0]
    assert plugin["id"] == "superpowers"
    assert plugin["enabled"] is True
    assert plugin["source"] == "local-path"
    assert Path(plugin["root"]).resolve() == root.resolve()
    assert not (kimi_home / "plugins" / "managed" / "superpowers").exists()
```

- [ ] **Step 2: Replace the stale Kimi runner test**

In `tests/quorum/test_runner.py`, replace `test_kimi_seed_links_auth_and_installs_local_superpowers` with:

```python
def test_kimi_seed_installs_local_path_superpowers_without_host_state(
    self, tmp_path, monkeypatch
):
    home = tmp_path / "home"
    source_home = home / ".kimi-code"
    (source_home / "credentials").mkdir(parents=True)
    (source_home / "config.toml").write_text("must not be read\n")

    superpowers = tmp_path / "superpowers"
    (superpowers / ".kimi-plugin").mkdir(parents=True)
    (superpowers / ".kimi-plugin" / "plugin.json").write_text(
        json.dumps(
            {
                "name": "superpowers",
                "skills": "./skills/",
                "sessionStart": {"skill": "using-superpowers"},
                "skillInstructions": {"tools": {"Bash": "shell"}},
            }
        )
    )
    (superpowers / "skills" / "using-superpowers").mkdir(parents=True)
    (superpowers / "skills" / "brainstorming").mkdir(parents=True)
    (superpowers / "skills" / "using-superpowers" / "SKILL.md").write_text("skill")
    (superpowers / "skills" / "brainstorming" / "SKILL.md").write_text("skill")

    dest = tmp_path / "agent-config"
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(superpowers))
    monkeypatch.setenv("KIMI_MODEL_API_KEY", "fake-kimi-key")
    monkeypatch.setattr("quorum.runner.shutil.which", lambda name: "/usr/bin/kimi")

    runtime = _seed_kimi_config(dest, run_dir=tmp_path / "run")

    assert (dest / "home").is_dir()
    assert not (dest / "config.toml").exists()
    assert not (dest / "credentials").exists()
    assert not (dest / "oauth").exists()
    installed = json.loads((dest / "plugins" / "installed.json").read_text())
    plugin = installed["plugins"][0]
    assert plugin["id"] == "superpowers"
    assert Path(plugin["root"]).resolve() == superpowers.resolve()
    assert plugin["source"] == "local-path"
    assert plugin["enabled"] is True
    assert runtime.env_file.exists()
```

- [ ] **Step 3: Run the targeted tests and verify failure**

Run:

```bash
uv run pytest tests/quorum/test_kimi.py tests/quorum/test_runner.py::TestSeedAgentConfigDir::test_kimi_seed_installs_local_path_superpowers_without_host_state -q
```

Expected: FAIL because the helper functions and new `_seed_kimi_config(..., run_dir=...)` signature do not exist.

- [ ] **Step 4: Implement plugin helpers in `quorum/kimi.py`**

Add:

```python
import datetime as _dt


def validate_superpowers_kimi_root(root: str | Path) -> Path:
    resolved = Path(root).expanduser().resolve()
    manifest_path = resolved / ".kimi-plugin" / "plugin.json"
    required = [
        manifest_path,
        resolved / "skills" / "using-superpowers" / "SKILL.md",
        resolved / "skills" / "brainstorming" / "SKILL.md",
    ]
    missing = [str(path.relative_to(resolved)) for path in required if not path.is_file()]
    if missing:
        raise KimiConfigError("SUPERPOWERS_ROOT missing Kimi files: " + ", ".join(missing))
    try:
        manifest = json.loads(manifest_path.read_text())
    except json.JSONDecodeError as e:
        raise KimiConfigError(f"{manifest_path} is not valid JSON: {e}") from e
    if manifest.get("name") != "superpowers":
        raise KimiConfigError("Kimi manifest name must be superpowers")
    if manifest.get("skills") != "./skills/":
        raise KimiConfigError("Kimi manifest skills must be ./skills/")
    session_start = manifest.get("sessionStart") or {}
    if not isinstance(session_start, dict) or session_start.get("skill") != "using-superpowers":
        raise KimiConfigError("Kimi manifest sessionStart.skill must be using-superpowers")
    if not manifest.get("skillInstructions"):
        raise KimiConfigError("Kimi manifest skillInstructions must be non-empty")
    return resolved


def install_kimi_superpowers_plugin(kimi_home: Path, superpowers_root: str | Path) -> Path:
    root = validate_superpowers_kimi_root(superpowers_root)
    plugins_dir = kimi_home / "plugins"
    plugins_dir.mkdir(parents=True, exist_ok=True)
    now = _dt.datetime.now(_dt.UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    payload = {
        "version": 1,
        "plugins": [
            {
                "id": "superpowers",
                "root": str(root),
                "source": "local-path",
                "enabled": True,
                "installedAt": now,
                "updatedAt": now,
                "originalSource": str(root),
            }
        ],
    }
    path = plugins_dir / "installed.json"
    path.write_text(json.dumps(payload, indent=2) + "\n")
    return path
```

- [ ] **Step 5: Replace stale `_seed_kimi_config` behavior**

In `quorum/runner.py`, use the existing `import dataclasses` and add:

Add imports:

```python
from quorum.kimi import (
    KimiConfigError,
    build_kimi_subprocess_env,
    effective_kimi_model_env,
    install_kimi_superpowers_plugin,
    write_effective_kimi_config,
    write_kimi_runtime_env_file,
)
```

Add:

```python
@dataclasses.dataclass(frozen=True)
class AgentRuntime:
    env_file: Path | None = None
    substitutions: dict[str, str] = dataclasses.field(default_factory=dict)
    cleanup_dirs: tuple[Path, ...] = ()
```

Change `_seed_kimi_config` to:

```python
def _seed_kimi_config(kimi_home: Path, *, run_dir: Path) -> AgentRuntime:
    """Seed an isolated Kimi home with env-overlay auth and local Superpowers plugin."""
    superpowers_root = os.environ.get("SUPERPOWERS_ROOT", "")
    if not superpowers_root:
        raise RunnerError(
            "SUPERPOWERS_ROOT not set; cannot install Kimi Superpowers plugin",
            stage="setup",
        )
    kimi_binary = shutil.which("kimi")
    if kimi_binary is None:
        raise RunnerError("kimi not found on PATH; cannot run Kimi evals", stage="setup")

    try:
        kimi_env = effective_kimi_model_env(os.environ)
        install_kimi_superpowers_plugin(kimi_home, superpowers_root)
    except KimiConfigError as e:
        raise RunnerError(str(e), stage="setup") from e

    kimi_home.mkdir(parents=True, exist_ok=True)
    for child in ("home", "cache", "xdg-config", "xdg-cache", "xdg-data"):
        (kimi_home / child).mkdir(parents=True, exist_ok=True)

    runtime_env = build_kimi_subprocess_env(
        base_env=os.environ,
        kimi_home=kimi_home,
        cwd=kimi_home,
        kimi_model_env=kimi_env,
    )
    env_file = write_kimi_runtime_env_file(runtime_env, run_dir=run_dir)
    write_effective_kimi_config(
        kimi_home,
        runtime_env,
        kimi_binary=kimi_binary,
        kimi_version=None,
    )
    return AgentRuntime(
        env_file=env_file,
        substitutions={"$KIMI_ENV_FILE": str(env_file)},
        cleanup_dirs=(env_file.parent,),
    )
```

This initial implementation sets `kimi_version=None`; Task 5 fills it in from the preflight/binary check.

- [ ] **Step 6: Update `_seed_agent_config_dir` signature**

Change:

```python
def _seed_agent_config_dir(
    coding_agent: CodingAgentConfig,
    skeleton_root: Path,
    dest: Path,
    workdir: Path,
) -> None:
```

to:

```python
def _seed_agent_config_dir(
    coding_agent: CodingAgentConfig,
    skeleton_root: Path,
    dest: Path,
    workdir: Path,
    *,
    run_dir: Path,
) -> AgentRuntime:
```

At the start of the function, add:

```python
    runtime = AgentRuntime()
```

Replace the Kimi branch:

```python
    if coding_agent.name == "kimi":
        _seed_kimi_config(dest)
```

with:

```python
    if coding_agent.name == "kimi":
        runtime = _seed_kimi_config(dest, run_dir=run_dir)
```

At the end, return:

```python
    return runtime
```

Update the direct calls in `tests/quorum/test_runner.py` to pass a run dir. The current call sites are in `TestSeedAgentConfigDir`; add `run_dir=tmp_path / "run-dir"` to each call, for example:

```python
_seed_agent_config_dir(
    _tcfg("anything"),
    tmp_path / "no-fixtures",
    dest,
    tmp_path,
    run_dir=tmp_path / "run-dir",
)
```

Do the same for the current `claude`, `codex`, `antigravity`, and `kimi` direct calls. Update the runner call site by assigning the return value as shown in Task 4 Step 5.

- [ ] **Step 7: Run tests and commit**

Run:

```bash
uv run pytest tests/quorum/test_kimi.py tests/quorum/test_runner.py -q
```

Expected: PASS.

Commit:

```bash
git add quorum/kimi.py quorum/runner.py tests/quorum/test_kimi.py tests/quorum/test_runner.py
git commit -m "quorum: install kimi superpowers plugin from local path"
```

---

## Task 4: Launcher, HOWTO, Secret Cleanup, and No-Leak Tests

**Why now:** Kimi secrets must reach Kimi despite tmux env loss, but not remain in run artifacts or generated guidance.

**Files:**
- Modify: `coding-agents/kimi-context/launch-agent`
- Modify: `coding-agents/kimi-context/HOWTO.md`
- Modify: `quorum/runner.py`
- Test: `tests/quorum/test_runner.py`

- [ ] **Step 1: Write failing launcher and no-leak assertions**

Update `test_kimi_launch_agent_is_interactive_and_substituted` in `tests/quorum/test_runner.py` so its Kimi YAML includes `required_env: []`, but its Kimi runtime patch returns a fake `AgentRuntime`:

```python
from quorum.runner import AgentRuntime
```

Inside the test patch block, replace `patch("quorum.runner._seed_kimi_config")` with:

```python
        patch(
            "quorum.runner._seed_kimi_config",
            return_value=AgentRuntime(
                env_file=tmp_path / "secret" / "kimi-runtime.env",
                substitutions={"$KIMI_ENV_FILE": str(tmp_path / "secret" / "kimi-runtime.env")},
                cleanup_dirs=(tmp_path / "secret",),
            ),
        ),
```

Then assert:

```python
    assert "$KIMI_ENV_FILE" not in content
    assert "set -a" in content
    assert '. "$KIMI_ENV_FILE"' not in content
    assert str(tmp_path / "secret" / "kimi-runtime.env") in content
    assert "trap cleanup_kimi_env EXIT HUP INT TERM" in content
    assert "unset KIMI_ENV_FILE" in content
    assert "exec kimi --yolo" in content
    assert "--skills-dir" not in content
    assert "--auto" not in content
```

Add a test:

```python
def test_kimi_runtime_env_file_cleaned_when_gauntlet_never_launches(tmp_path, monkeypatch):
    coding_agents_dir = tmp_path / "coding-agents"
    scenarios_dir = tmp_path / "scenarios"
    coding_agents_dir.mkdir(parents=True, exist_ok=True)
    (coding_agents_dir / "kimi.yaml").write_text(
        yaml.safe_dump(
            {
                "name": "kimi",
                "binary": "kimi",
                "agent_config_env": "KIMI_CODE_HOME",
                "session_log_dir": "${KIMI_CODE_HOME}/sessions",
                "session_log_glob": "**/wire.jsonl",
                "normalizer": "kimi",
                "required_env": [],
            }
        )
    )
    cd_kimi = coding_agents_dir / "kimi-context"
    cd_kimi.mkdir()
    (cd_kimi / "launch-agent").write_text("#!/usr/bin/env bash\nexit 0\n")
    sd = _make_scenario(scenarios_dir, "x")
    out_root = tmp_path / "results"
    secret_dir = tmp_path / "secret"
    secret_dir.mkdir()
    env_file = secret_dir / "kimi-runtime.env"
    env_file.write_text("KIMI_MODEL_API_KEY=fake\n")

    with (
        patch(
            "quorum.runner._seed_kimi_config",
            return_value=AgentRuntime(
                env_file=env_file,
                substitutions={"$KIMI_ENV_FILE": str(env_file)},
                cleanup_dirs=(secret_dir,),
            ),
        ),
        patch("quorum.runner.invoke_gauntlet", side_effect=RunnerError("gauntlet boom", stage="gauntlet")),
    ):
        _run_dir, verdict = run_scenario(
            scenario_dir=sd,
            coding_agent="kimi",
            coding_agents_dir=coding_agents_dir,
            out_root=out_root,
            skeleton_root=_empty_skeleton(tmp_path),
        )

    assert verdict.final == "indeterminate"
    assert not env_file.exists()
    assert not secret_dir.exists()
```

- [ ] **Step 2: Run targeted tests and verify failure**

Run:

```bash
uv run pytest tests/quorum/test_runner.py::test_kimi_launch_agent_is_interactive_and_substituted tests/quorum/test_runner.py::test_kimi_runtime_env_file_cleaned_when_gauntlet_never_launches -q
```

Expected: FAIL because the launch template and runner cleanup are still stale.

- [ ] **Step 3: Update `coding-agents/kimi-context/launch-agent`**

Replace the file with:

```bash
#!/usr/bin/env bash
# quorum-generated launcher for Kimi Code (the agent under test).
set -euo pipefail

cleanup_kimi_env() {
  rm -f "$KIMI_ENV_FILE"
}
trap cleanup_kimi_env EXIT HUP INT TERM

cd "$QUORUM_AGENT_CWD" || {
  echo "launch-agent: cannot cd to $QUORUM_AGENT_CWD" >&2
  exit 1
}

set -a
. "$KIMI_ENV_FILE"
set +a
cleanup_kimi_env
trap - EXIT HUP INT TERM
unset KIMI_ENV_FILE
unset -f cleanup_kimi_env

exec kimi --yolo "$@"
```

- [ ] **Step 4: Update `coding-agents/kimi-context/HOWTO.md`**

Keep the one-command launch instruction and log paths, but replace the auth paragraph with:

```markdown
`KIMI_CODE_HOME` points at a per-run isolated Kimi home. quorum registers the
local Superpowers checkout as the only enabled Kimi plugin in that home. Auth
and model settings are supplied by quorum through its generated launcher; do
not hand-type provider env vars, use a local Kimi login, or reconstruct the
command yourself.
```

Ensure the HOWTO does not contain:

```text
~/.kimi-code
symlink
existing Kimi login
KIMI_ENV_FILE
```

- [ ] **Step 5: Add runner cleanup**

In `_run_scenario_inner`, capture the runtime return:

```python
    agent_runtime = _seed_agent_config_dir(
        tcfg,
        skeleton_root=skeleton_root or (_quorum_repo_root() / "coding-agents"),
        dest=agent_config_dir,
        workdir=workdir,
        run_dir=run_dir,
    )
```

When populating context, merge substitutions:

```python
        substitutions={
            "$QUORUM_AGENT_CWD": str(launch_cwd),
            "$SUPERPOWERS_ROOT": os.environ.get("SUPERPOWERS_ROOT", ""),
            "$QUORUM_LAUNCH_AGENT": str(launch_agent_path),
            f"${tcfg.agent_config_env}": str(agent_config_dir),
            **agent_runtime.substitutions,
        },
```

Add this cleanup helper near the other runner helpers:

```python
def _cleanup_agent_runtime(runtime: AgentRuntime) -> None:
    for path in runtime.cleanup_dirs:
        shutil.rmtree(path, ignore_errors=True)
```

Keep cleanup owned by `_run_scenario_inner`. Immediately after the `_seed_agent_config_dir(...)` call, wrap the existing setup, pre-check, Gauntlet launch, capture, post-check, and composition body in one `try/finally`:

```python
    try:
        session_log_dir = tcfg.resolve_session_log_dir(agent_config_dir)
        env_extra = {"QUORUM_REPO_ROOT": str(_quorum_repo_root())}
    finally:
        _cleanup_agent_runtime(agent_runtime)
```

The current `run_setup(...)` statement becomes the first statement after the `env_extra` assignment inside the `try`, and the current final `return run_dir, verdict` remains inside the `try` immediately before the `finally`. Leave the existing `invoke_gauntlet(..., extra_env={tcfg.agent_config_env: str(agent_config_dir)})` shape intact; Kimi's secret-bearing env values are carried by the generated launcher file, not by Gauntlet process env.

- [ ] **Step 6: Run tests and commit**

Run:

```bash
uv run pytest tests/quorum/test_runner.py -q
```

Expected: PASS.

Commit:

```bash
git add coding-agents/kimi-context/launch-agent coding-agents/kimi-context/HOWTO.md quorum/runner.py tests/quorum/test_runner.py
git commit -m "quorum: launch kimi through cleaned runtime env file"
```

---

## Task 5: Kimi Auth Preflight and Stream-JSON Parsing

**Why now:** Direct `quorum run` must prove the env overlay can invoke Kimi before Gauntlet starts. The parser must understand Kimi `--output-format stream-json`, not plain stdout.

**Files:**
- Modify: `quorum/kimi.py`
- Modify: `quorum/runner.py`
- Test: `tests/quorum/test_kimi.py`
- Test: `tests/quorum/test_runner.py`

- [ ] **Step 1: Write failing stream-json parser tests**

Append to `tests/quorum/test_kimi.py`:

```python
from quorum.kimi import kimi_stream_json_reply_ok, run_kimi_auth_preflight


def test_kimi_stream_json_reply_ok_accepts_assistant_ok():
    stdout = "\n".join(
        [
            json.dumps({"type": "system", "message": "ignored"}),
            json.dumps({"type": "assistant", "content": "OK."}),
        ]
    )
    assert kimi_stream_json_reply_ok(stdout)


def test_kimi_stream_json_reply_ok_rejects_verbose_reply():
    stdout = json.dumps({"type": "assistant", "content": "OK, I will do that"})
    assert not kimi_stream_json_reply_ok(stdout)
```

- [ ] **Step 2: Write failing preflight test**

Append:

```python
def test_run_kimi_auth_preflight_uses_throwaway_home_and_checks_logs(tmp_path, monkeypatch):
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append((cmd, kwargs))
        kimi_home = Path(kwargs["env"]["KIMI_CODE_HOME"])
        cwd = Path(kwargs["cwd"])
        session = kimi_home / "sessions" / "wd" / "session" / "agents" / "main"
        session.mkdir(parents=True)
        (session / "wire.jsonl").write_text("{}\n")
        (kimi_home / "session_index.jsonl").write_text(
            json.dumps({"sessionDir": str(session.parent.parent), "workDir": str(cwd)}) + "\n"
        )
        return subprocess.CompletedProcess(
            cmd,
            0,
            json.dumps({"type": "assistant", "content": "OK"}) + "\n",
            "",
        )

    monkeypatch.setattr("quorum.kimi.subprocess.run", fake_run)
    run_kimi_auth_preflight(
        kimi_binary="kimi",
        kimi_model_env={"KIMI_MODEL_API_KEY": "fake", "KIMI_MODEL_NAME": "kimi"},
        base_env={"PATH": "/usr/bin:/bin"},
    )

    cmd, kwargs = calls[0]
    assert cmd == ["kimi", "-p", "Reply with EXACTLY OK.", "--output-format", "stream-json"]
    assert Path(kwargs["env"]["KIMI_CODE_HOME"]).name.startswith("kimi-home")
    assert kwargs["env"]["KIMI_MODEL_API_KEY"] == "fake"
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
uv run pytest tests/quorum/test_kimi.py -q
```

Expected: FAIL because parser and preflight functions do not exist.

- [ ] **Step 4: Implement stream-json parser and preflight**

In `quorum/kimi.py`, add imports:

```python
import contextlib
import subprocess
```

Add:

```python
def _normalized_ok(text: str) -> bool:
    return text.strip().rstrip(".!").strip().upper() == "OK"


def kimi_stream_json_reply_ok(stdout: str) -> bool:
    assistant_parts: list[str] = []
    for line in stdout.splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(row, dict):
            continue
        if row.get("type") in {"assistant", "message", "response"}:
            content = row.get("content")
            if isinstance(content, str):
                assistant_parts.append(content)
            elif isinstance(content, list):
                assistant_parts.extend(
                    part.get("text", "")
                    for part in content
                    if isinstance(part, dict) and isinstance(part.get("text"), str)
                )
    return _normalized_ok("".join(assistant_parts))
```

Add:

```python
def run_kimi_auth_preflight(
    *,
    kimi_binary: str,
    kimi_model_env: Mapping[str, str],
    base_env: Mapping[str, str],
    timeout: int = 90,
) -> None:
    with tempfile.TemporaryDirectory(prefix="quorum-kimi-preflight-") as tmp:
        tmp_path = Path(tmp)
        kimi_home = tmp_path / "kimi-home"
        cwd = tmp_path / "cwd"
        cwd.mkdir()
        env = build_kimi_subprocess_env(
            base_env=base_env,
            kimi_home=kimi_home,
            cwd=cwd,
            kimi_model_env=kimi_model_env,
        )
        try:
            result = subprocess.run(
                [kimi_binary, "-p", "Reply with EXACTLY OK.", "--output-format", "stream-json"],
                cwd=cwd,
                env=env,
                text=True,
                capture_output=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as e:
            raise KimiConfigError("kimi auth preflight timed out") from e
        if result.returncode != 0:
            stderr = result.stderr.strip()[:300]
            raise KimiConfigError(
                f"kimi auth preflight failed (exit {result.returncode}); stderr: {stderr}"
            )
        if not kimi_stream_json_reply_ok(result.stdout):
            raise KimiConfigError(
                "kimi auth preflight did not return OK; stdout: "
                + result.stdout.strip()[:300]
            )
        index_path = kimi_home / "session_index.jsonl"
        logs = sorted((kimi_home / "sessions").glob("**/wire.jsonl"))
        if not index_path.is_file():
            raise KimiConfigError("kimi auth preflight produced no session_index.jsonl")
        if not logs:
            raise KimiConfigError("kimi auth preflight produced no wire.jsonl")
        target = os.path.realpath(cwd)
        matched = False
        with index_path.open() as f:
            for line in f:
                if not line.strip():
                    continue
                with contextlib.suppress(json.JSONDecodeError):
                    row = json.loads(line)
                    if isinstance(row, dict) and os.path.realpath(str(row.get("workDir", ""))) == target:
                        matched = True
                        break
        if not matched:
            raise KimiConfigError("kimi auth preflight session_index workDir did not match cwd")
```

- [ ] **Step 5: Wire direct-run preflight in `quorum/runner.py`**

In `_seed_kimi_config`, after `effective_kimi_model_env(...)`, run preflight unless a batch marker is present:

```python
    if not os.environ.get("QUORUM_KIMI_PREFLIGHT_SENTINEL"):
        try:
            run_kimi_auth_preflight(
                kimi_binary=kimi_binary,
                kimi_model_env=kimi_env,
                base_env=os.environ,
            )
        except KimiConfigError as e:
            raise RunnerError(str(e), stage="setup") from e
```

Import `run_kimi_auth_preflight`.

- [ ] **Step 6: Run tests and commit**

Run:

```bash
uv run pytest tests/quorum/test_kimi.py tests/quorum/test_runner.py -q
```

Expected: PASS with preflight mocked in runner tests where needed.

Commit:

```bash
git add quorum/kimi.py quorum/runner.py tests/quorum/test_kimi.py tests/quorum/test_runner.py
git commit -m "quorum: preflight kimi env auth"
```

---

## Task 6: Kimi Capture Fail-Closed and Plugin Bootstrap Invariant

**Why now:** Kimi harness failures must not pass file-only scenarios. The reviewer specifically wanted `plugin_session_start` as a central runner/capture invariant.

**Files:**
- Modify: `quorum/kimi.py`
- Modify: `quorum/capture.py`
- Modify: `quorum/runner.py`
- Test: `tests/quorum/test_kimi.py`
- Test: `tests/quorum/test_capture.py`
- Test: `tests/quorum/test_runner.py`

- [ ] **Step 1: Write raw plugin-session-start tests**

Append to `tests/quorum/test_kimi.py`:

```python
from quorum.kimi import kimi_logs_have_superpowers_session_start


def test_kimi_logs_have_superpowers_session_start(tmp_path):
    wire = tmp_path / "wire.jsonl"
    wire.write_text(
        json.dumps(
            {
                "type": "context.append_loop_event",
                "event": {
                    "type": "plugin_session_start",
                    "plugin": "superpowers",
                    "skill": "using-superpowers",
                },
            }
        )
        + "\n"
    )

    assert kimi_logs_have_superpowers_session_start([wire])


def test_kimi_logs_reject_missing_superpowers_session_start(tmp_path):
    wire = tmp_path / "wire.jsonl"
    wire.write_text(json.dumps({"type": "context.append_loop_event", "event": {}}) + "\n")

    assert not kimi_logs_have_superpowers_session_start([wire])
```

- [ ] **Step 2: Write Kimi cwd-mismatch detection test**

In `tests/quorum/test_capture.py`, add:

```python
from quorum.capture import detect_kimi_cwd_mismatch


def test_detect_kimi_cwd_mismatch_when_new_logs_exist_but_none_match(tmp_path):
    log_dir = tmp_path / "sessions"
    session_dir = log_dir / "wd_other" / "session_other"
    wire_dir = session_dir / "agents" / "main"
    wire_dir.mkdir(parents=True)
    snap = snapshot_dir(log_dir, "**/wire.jsonl")
    wire = wire_dir / "wire.jsonl"
    wire.write_text("{}\n")
    (tmp_path / "session_index.jsonl").write_text(
        json.dumps({"sessionDir": str(session_dir), "workDir": str(tmp_path / "wrong")}) + "\n"
    )

    assert detect_kimi_cwd_mismatch(
        log_dir=log_dir,
        log_glob="**/wire.jsonl",
        snapshot=snap,
        launch_cwd=tmp_path / "expected",
    ) == [wire]
```

- [ ] **Step 3: Write runner fail-closed tests**

In `tests/quorum/test_runner.py`, add one helper:

```python
def _make_kimi_agent(coding_agents_dir: Path, session_log_dir: Path) -> None:
    coding_agents_dir.mkdir(parents=True, exist_ok=True)
    (coding_agents_dir / "kimi.yaml").write_text(
        yaml.safe_dump(
            {
                "name": "kimi",
                "binary": "kimi",
                "agent_config_env": "KIMI_CODE_HOME",
                "session_log_dir": str(session_log_dir),
                "session_log_glob": "**/wire.jsonl",
                "normalizer": "kimi",
                "required_env": [],
            }
        )
    )
    (coding_agents_dir / "kimi-context").mkdir(parents=True, exist_ok=True)
```

Add:

```python
def test_kimi_no_wire_logs_is_capture_indeterminate_even_without_trace_checks(tmp_path):
    coding_agents_dir = tmp_path / "coding-agents"
    scenarios_dir = tmp_path / "scenarios"
    session_log_dir = tmp_path / "kimi-home" / "sessions"
    session_log_dir.mkdir()
    _make_kimi_agent(coding_agents_dir, session_log_dir)
    sd = _make_scenario(scenarios_dir, "x")
    out_root = tmp_path / "results"

    with (
        patch("quorum.runner._seed_kimi_config", return_value=AgentRuntime()),
        patch("quorum.runner.invoke_gauntlet", side_effect=_stub_gauntlet_pass),
    ):
        _run_dir, verdict = run_scenario(
            scenario_dir=sd,
            coding_agent="kimi",
            coding_agents_dir=coding_agents_dir,
            out_root=out_root,
            skeleton_root=_empty_skeleton(tmp_path),
        )

    assert verdict.final == "indeterminate"
    assert verdict.error is not None
    assert verdict.error.stage == "capture"
    assert "no Kimi wire.jsonl" in verdict.error.message
```

Add a plugin-start test:

```python
def test_kimi_missing_plugin_session_start_is_indeterminate(tmp_path):
    coding_agents_dir = tmp_path / "coding-agents"
    scenarios_dir = tmp_path / "scenarios"
    session_log_dir = tmp_path / "kimi-home" / "sessions"
    session_log_dir.mkdir()
    _make_kimi_agent(coding_agents_dir, session_log_dir)
    sd = _make_scenario(scenarios_dir, "x")
    out_root = tmp_path / "results"

    def fake_gauntlet(*, launch_cwd, **kwargs):
        session_dir = session_log_dir / "wd" / "session"
        wire_dir = session_dir / "agents" / "main"
        wire_dir.mkdir(parents=True)
        (wire_dir / "wire.jsonl").write_text(
            json.dumps(
                {
                    "type": "context.append_loop_event",
                    "event": {"type": "tool.call", "name": "Read", "args": {"path": "README.md"}},
                }
            )
            + "\n"
        )
        (session_log_dir.parent / "session_index.jsonl").write_text(
            json.dumps({"sessionDir": str(session_dir), "workDir": str(launch_cwd)}) + "\n"
        )
        return "pass"

    with (
        patch("quorum.runner._seed_kimi_config", return_value=AgentRuntime()),
        patch("quorum.runner.invoke_gauntlet", side_effect=fake_gauntlet),
    ):
        _run_dir, verdict = run_scenario(
            scenario_dir=sd,
            coding_agent="kimi",
            coding_agents_dir=coding_agents_dir,
            out_root=out_root,
            skeleton_root=_empty_skeleton(tmp_path),
        )

    assert verdict.final == "indeterminate"
    assert verdict.error is not None
    assert verdict.error.stage == "capture"
    assert "plugin_session_start" in verdict.error.message
```

- [ ] **Step 4: Run tests and verify failure**

Run:

```bash
uv run pytest tests/quorum/test_kimi.py tests/quorum/test_capture.py tests/quorum/test_runner.py -q
```

Expected: FAIL because helper functions and runner branches do not exist.

- [ ] **Step 5: Implement raw scan helper**

In `quorum/kimi.py`, add:

```python
def kimi_logs_have_superpowers_session_start(paths: list[Path] | tuple[Path, ...]) -> bool:
    for path in paths:
        try:
            lines = path.read_text().splitlines()
        except OSError:
            continue
        for line in lines:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            event = row.get("event") if isinstance(row, dict) else None
            if not isinstance(event, dict):
                continue
            if (
                event.get("type") == "plugin_session_start"
                and event.get("plugin") == "superpowers"
                and event.get("skill") == "using-superpowers"
            ):
                return True
    return False
```

- [ ] **Step 6: Implement Kimi cwd mismatch detection**

In `quorum/capture.py`, add:

```python
def detect_kimi_cwd_mismatch(
    *,
    log_dir: Path,
    log_glob: str,
    snapshot: set[str],
    launch_cwd: Path,
) -> list[Path]:
    new = new_files_since(log_dir, log_glob, snapshot)
    if not new:
        return []
    matched = filter_kimi_logs_by_cwd(new, str(launch_cwd))
    if matched:
        return []
    return new
```

- [ ] **Step 7: Add central runner Kimi fail-closed branches**

Import:

```python
from quorum.capture import detect_kimi_cwd_mismatch
from quorum.kimi import kimi_logs_have_superpowers_session_start
```

After `gauntlet_layer` is built and before post-checks, add:

```python
    if tcfg.normalizer == "kimi":
        if not capture_result.source_logs:
            mismatched = detect_kimi_cwd_mismatch(
                log_dir=session_log_dir,
                log_glob=tcfg.session_log_glob,
                snapshot=snap,
                launch_cwd=launch_cwd,
            )
            if mismatched:
                rel = [str(p.relative_to(session_log_dir)) for p in mismatched]
                return run_dir, _write_indeterminate(
                    run_dir,
                    final_reason=(
                        "Kimi wrote wire logs, but none matched the launch cwd; "
                        "the QA agent likely bypassed the generated launcher"
                    ),
                    gauntlet=gauntlet_layer,
                    checks=pre_records,
                    error=RunError(
                        stage="qa-agent-misconfigured",
                        message=f"Kimi wire logs did not match launch cwd: {rel}",
                    ),
                )
            return run_dir, _write_indeterminate(
                run_dir,
                final_reason=(
                    f"no Kimi wire.jsonl appeared under isolated {session_log_dir}; "
                    "cannot evaluate this run"
                ),
                gauntlet=gauntlet_layer,
                checks=pre_records,
                error=RunError(stage="capture", message="no Kimi wire.jsonl captured"),
            )
        if capture_result.row_count == 0:
            rel = [str(p.relative_to(session_log_dir)) for p in capture_result.source_logs]
            return run_dir, _write_indeterminate(
                run_dir,
                final_reason="Kimi wire log(s) normalized to zero tool-call rows: " + ", ".join(rel),
                gauntlet=gauntlet_layer,
                checks=pre_records,
                error=RunError(stage="capture", message="Kimi capture normalized to zero rows"),
            )
        if not kimi_logs_have_superpowers_session_start(capture_result.source_logs):
            return run_dir, _write_indeterminate(
                run_dir,
                final_reason="Kimi raw wire log lacks Superpowers plugin_session_start",
                gauntlet=gauntlet_layer,
                checks=pre_records,
                error=RunError(
                    stage="capture",
                    message="missing plugin_session_start plugin=superpowers skill=using-superpowers",
                ),
            )
```

- [ ] **Step 8: Run tests and commit**

Run:

```bash
uv run pytest tests/quorum/test_kimi.py tests/quorum/test_capture.py tests/quorum/test_runner.py -q
```

Expected: PASS.

Commit:

```bash
git add quorum/kimi.py quorum/capture.py quorum/runner.py tests/quorum/test_kimi.py tests/quorum/test_capture.py tests/quorum/test_runner.py
git commit -m "quorum: fail closed on kimi capture invariants"
```

---

## Task 7: Kimi Token Usage Without Cost Estimation

**Why now:** Token capture is measurement-only and must parse Kimi `usage.record` rows without double-counting `turn` plus `session`.

**Files:**
- Modify: `quorum/token_usage.py`
- Modify: `quorum/capture.py` - keep token capture integration using the existing normalizer dispatch.
- Modify: `quorum/economics.py` - add/verify null coding-agent cost coverage so Kimi usage keeps total economics partial.
- Test: `tests/quorum/test_token_usage.py`
- Test: `tests/quorum/test_capture.py`
- Test: `tests/quorum/test_economics.py`

- [ ] **Step 1: Write failing Kimi token parser tests**

In `tests/quorum/test_token_usage.py`, import `parse_kimi_wire`:

```python
from quorum.token_usage import parse_kimi_wire
```

Add:

```python
class TestParseKimiWire:
    def test_uses_turn_rows_and_ignores_session_when_both_exist(self, tmp_path: Path):
        p = tmp_path / "wire.jsonl"
        rows = [
            {
                "type": "usage.record",
                "usageScope": "turn",
                "model": "kimi-for-coding",
                "time": 1800000000000,
                "usage": {
                    "inputOther": 10,
                    "inputCacheRead": 20,
                    "inputCacheCreation": 30,
                    "output": 40,
                },
            },
            {
                "type": "usage.record",
                "usageScope": "session",
                "model": "kimi-for-coding",
                "time": 1800000001000,
                "usage": {
                    "inputOther": 999,
                    "inputCacheRead": 999,
                    "inputCacheCreation": 999,
                    "output": 999,
                },
            },
        ]
        p.write_text("".join(json.dumps(row) + "\n" for row in rows))

        usage = parse_kimi_wire(p)

        assert usage is not None
        assert usage["total_input"] == 10
        assert usage["total_cache_read"] == 20
        assert usage["total_cache_create"] == 30
        assert usage["total_output"] == 40
        assert usage["total_tokens"] == 100
        assert usage["n_assistant_turns"] == 1
        assert usage["first_ts"] == 1800000000000
        assert usage["last_ts"] == 1800000000000
        assert usage["duration_ms"] == 0

    def test_session_row_fallback_when_no_turn_rows(self, tmp_path: Path):
        p = tmp_path / "wire.jsonl"
        p.write_text(
            json.dumps(
                {
                    "type": "usage.record",
                    "usageScope": "session",
                    "model": "kimi-for-coding",
                    "time": 1800000000000,
                    "usage": {"inputOther": 1, "inputCacheRead": 2, "inputCacheCreation": 3, "output": 4},
                }
            )
            + "\n"
        )

        usage = parse_kimi_wire(p)

        assert usage is not None
        assert usage["total_tokens"] == 10
        assert usage["n_assistant_turns"] == 0
        assert usage["usage_source"] == "session_fallback"
```

- [ ] **Step 2: Write failing capture aggregation test**

In `TestCaptureTokens`, add:

```python
def test_kimi_family_returns_unpriced_usage(self, tmp_path: Path):
    p = tmp_path / "wire.jsonl"
    p.write_text(
        json.dumps(
            {
                "type": "usage.record",
                "usageScope": "turn",
                "model": "kimi-for-coding",
                "time": 1800000000000,
                "usage": {"inputOther": 10, "inputCacheRead": 20, "inputCacheCreation": 30, "output": 40},
            }
        )
        + "\n"
    )

    result = capture_tokens(backend_family="kimi", session_log_files=[p])

    assert result is not None
    assert result["total_tokens"] == 100
    assert result["est_cost_usd"] is None
    assert result["has_unpriced_model"] is True
    assert result["models"]["kimi-for-coding"]["est_cost_usd"] is None
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
uv run pytest tests/quorum/test_token_usage.py -q
```

Expected: FAIL because `parse_kimi_wire` and Kimi capture support do not exist.

- [ ] **Step 4: Implement `parse_kimi_wire`**

In `quorum/token_usage.py`, add:

```python
def _track_numeric_ts(
    current_first: int | None, current_last: int | None, ts: Any
) -> tuple[int | None, int | None]:
    if not isinstance(ts, int | float):
        return current_first, current_last
    value = int(ts)
    first = value if current_first is None or value < current_first else current_first
    last = value if current_last is None or value > current_last else current_last
    return first, last


def parse_kimi_wire(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    turn_rows: list[dict[str, Any]] = []
    session_rows: list[dict[str, Any]] = []
    with path.open() as f:
        for line in f:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(row, dict) or row.get("type") != "usage.record":
                continue
            if row.get("usageScope") == "turn":
                turn_rows.append(row)
            elif row.get("usageScope") == "session":
                session_rows.append(row)
    selected = turn_rows
    usage_source = "turn"
    if not selected and session_rows:
        selected = [session_rows[-1]]
        usage_source = "session_fallback"
    if not selected:
        return None

    first_ts: int | None = None
    last_ts: int | None = None
    by_model: dict[str, dict[str, int]] = {}
    totals = _empty_model_bucket()
    model: str | None = None
    for row in selected:
        first_ts, last_ts = _track_numeric_ts(first_ts, last_ts, row.get("time"))
        model_id = row.get("model") if isinstance(row.get("model"), str) else "unknown"
        model = model or model_id
        usage = row.get("usage") if isinstance(row.get("usage"), dict) else {}
        entry = {
            "total_input": int(usage.get("inputOther", 0) or 0),
            "total_cache_read": int(usage.get("inputCacheRead", 0) or 0),
            "total_cache_create": int(usage.get("inputCacheCreation", 0) or 0),
            "total_output": int(usage.get("output", 0) or 0),
        }
        bucket = by_model.setdefault(model_id, _empty_model_bucket())
        for key, value in entry.items():
            totals[key] += value
            bucket[key] += value
        if row.get("usageScope") == "turn":
            totals["n_assistant_turns"] += 1
            bucket["n_assistant_turns"] += 1
    duration_ms = None
    if first_ts is not None and last_ts is not None:
        duration_ms = max(last_ts - first_ts, 0)
    return {
        **totals,
        "total_tokens": sum(totals[k] for k in _MODEL_TOKEN_KEYS),
        "model": model,
        "tool_result_total_bytes": 0,
        "first_ts": first_ts,
        "last_ts": last_ts,
        "duration_ms": duration_ms,
        "by_model": by_model,
        "usage_source": usage_source,
    }
```

- [ ] **Step 5: Update `capture_tokens` for Kimi and null all-unpriced costs**

Change:

```python
    elif backend_family == "codex":
        per_file = [parse_codex_rollout(p) for p in session_log_files]
```

to:

```python
    elif backend_family == "codex":
        per_file = [parse_codex_rollout(p) for p in session_log_files]
    elif backend_family == "kimi":
        per_file = [parse_kimi_wire(p) for p in session_log_files]
```

After the model loop, replace:

```python
    summed["est_cost_usd"] = round(total_cost, 6)
```

with:

```python
    priced_any = any(model["est_cost_usd"] is not None for model in models_out.values())
    summed["est_cost_usd"] = round(total_cost, 6) if priced_any else None
```

- [ ] **Step 6: Add capture integration test**

In `tests/quorum/test_capture.py`, add:

```python
def test_kimi_token_usage_writes_unpriced_json(tmp_path):
    log_dir = _mkdir(tmp_path / "sessions")
    session_dir = log_dir / "wd" / "session"
    wire_dir = session_dir / "agents" / "main"
    wire_dir.mkdir(parents=True)
    snap = snapshot_dir(log_dir, "**/wire.jsonl")
    launch_cwd = tmp_path / "launch"
    launch_cwd.mkdir()
    wire = wire_dir / "wire.jsonl"
    wire.write_text(
        json.dumps(
            {
                "type": "usage.record",
                "usageScope": "turn",
                "model": "kimi-for-coding",
                "time": 1800000000000,
                "usage": {"inputOther": 10, "inputCacheRead": 20, "inputCacheCreation": 30, "output": 40},
            }
        )
        + "\n"
    )
    (tmp_path / "session_index.jsonl").write_text(
        json.dumps({"sessionDir": str(session_dir), "workDir": str(launch_cwd)}) + "\n"
    )
    run_dir = _mkdir(tmp_path / "run")

    out = capture_token_usage(
        log_dir=log_dir,
        log_glob="**/wire.jsonl",
        snapshot=snap,
        normalizer="kimi",
        run_dir=run_dir,
        launch_cwd=launch_cwd,
    )

    assert out == run_dir / "coding-agent-token-usage.json"
    data = json.loads(out.read_text())
    assert data["total_tokens"] == 100
    assert data["est_cost_usd"] is None
```

- [ ] **Step 7: Run tests and commit**

Run:

```bash
uv run pytest tests/quorum/test_token_usage.py tests/quorum/test_capture.py tests/quorum/test_economics.py -q
```

Expected: PASS.

Commit:

```bash
git add quorum/token_usage.py tests/quorum/test_token_usage.py tests/quorum/test_capture.py tests/quorum/test_economics.py
git commit -m "quorum: capture unpriced kimi token usage"
```

---

## Task 8: `run-all` Parent Kimi Preflight and Failure Records

**Why now:** `run-all` shells out one `quorum run` child per cell. A child-local preflight would run once per scenario. Parent preflight must run once per batch and produce per-cell setup indeterminate records if it fails.

**Files:**
- Modify: `quorum/run_all.py`
- Modify: `quorum/runner.py`
- Test: `tests/quorum/test_run_all.py`

- [ ] **Step 1: Write failing one-preflight test**

In `tests/quorum/test_run_all.py`, add:

```python
def test_run_batch_preflights_kimi_once_for_multiple_cells(tmp_path):
    scenarios = tmp_path / "scenarios"
    agents = tmp_path / "agents"
    _scenario(scenarios, "a")
    _scenario(scenarios, "b")
    _agent(agents, "kimi")
    out_root = tmp_path / "results"
    calls = {"preflight": 0}
    child_envs = []

    def fake_preflight(**_kwargs):
        calls["preflight"] += 1
        return {"QUORUM_KIMI_PREFLIGHT_SENTINEL": str(tmp_path / "sentinel.json")}

    def fake_invoke(
        *, scenario_dir, coding_agent, coding_agents_dir, out_root, extra_env=None, timeout_seconds=None
    ):
        child_envs.append(extra_env or {})
        return ChildResult(run_id=f"{scenario_dir.name}-{coding_agent}-x", exit_code=0, error=None)

    with patch("quorum.run_all.prepare_kimi_batch_preflight", side_effect=fake_preflight):
        run_batch(
            scenarios_root=scenarios,
            coding_agents_dir=agents,
            out_root=out_root,
            jobs=1,
            agent_filter=["kimi"],
            invoke=fake_invoke,
        )

    assert calls["preflight"] == 1
    assert len(child_envs) == 2
    assert all("QUORUM_KIMI_PREFLIGHT_SENTINEL" in env for env in child_envs)
```

- [ ] **Step 2: Write failing parent-preflight failure record test**

Add:

```python
def test_run_batch_kimi_preflight_failure_writes_indeterminate_runs(tmp_path):
    scenarios = tmp_path / "scenarios"
    agents = tmp_path / "agents"
    _scenario(scenarios, "a")
    _scenario(scenarios, "b")
    _agent(agents, "kimi")
    out_root = tmp_path / "results"

    with patch("quorum.run_all.prepare_kimi_batch_preflight", side_effect=RuntimeError("kimi auth failed")):
        batch_dir = run_batch(
            scenarios_root=scenarios,
            coding_agents_dir=agents,
            out_root=out_root,
            jobs=1,
            agent_filter=["kimi"],
            invoke=lambda **_kwargs: ChildResult(run_id=None, exit_code=99, error="should not run"),
        )

    records = [json.loads(line) for line in (batch_dir / "results.jsonl").read_text().splitlines()]
    assert len(records) == 2
    assert all(record["run_id"] for record in records)
    verdicts = [json.loads((out_root / record["run_id"] / "verdict.json").read_text()) for record in records]
    assert all(v["final"] == "indeterminate" for v in verdicts)
    assert all(v["error"]["stage"] == "setup" for v in verdicts)
    assert all("kimi auth failed" in v["error"]["message"] for v in verdicts)
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
uv run pytest tests/quorum/test_run_all.py -q
```

Expected: FAIL because `prepare_kimi_batch_preflight` and `extra_env` plumbing do not exist.

- [ ] **Step 4: Add `extra_env` plumbing to `invoke_child`**

Change the signature:

```python
def invoke_child(
    *,
    scenario_dir: Path,
    coding_agent: str,
    coding_agents_dir: Path,
    out_root: Path,
    timeout_seconds: float | None = None,
    extra_env: dict[str, str] | None = None,
) -> ChildResult:
```

Change `subprocess.run(...)` to:

```python
        completed = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            env={**os.environ, **(extra_env or {})},
        )
```

Add `import os` at the top.

Update `_worker` to accept and pass per-agent env:

```python
        result = invoke(
            scenario_dir=entry.scenario_dir,
            coding_agent=entry.coding_agent,
            coding_agents_dir=coding_agents_dir,
            out_root=out_root,
            extra_env=preflight_env_by_agent.get(entry.coding_agent),
        )
```

- [ ] **Step 5: Implement parent preflight preparation**

In `quorum/run_all.py`, import:

```python
from quorum.composer import RunError
from quorum.kimi import KimiConfigError, effective_kimi_model_env, run_kimi_auth_preflight
from quorum.runner import _allocate_run_dir, _write_indeterminate
```

Add:

```python
def prepare_kimi_batch_preflight(*, batch_dir: Path, coding_agents_dir: Path) -> dict[str, str]:
    kimi_yaml = coding_agents_dir / "kimi.yaml"
    if not kimi_yaml.exists():
        return {}
    kimi_env = effective_kimi_model_env(os.environ)
    run_kimi_auth_preflight(
        kimi_binary="kimi",
        kimi_model_env=kimi_env,
        base_env=os.environ,
    )
    marker = batch_dir / "kimi-preflight-ok.json"
    marker.write_text(
        json.dumps(
            {
                "schema": 1,
                "agent": "kimi",
                "model": kimi_env["KIMI_MODEL_NAME"],
                "provider": kimi_env["KIMI_MODEL_PROVIDER_TYPE"],
            },
            indent=2,
        )
        + "\n"
    )
    return {"QUORUM_KIMI_PREFLIGHT_SENTINEL": str(marker)}
```

Add:

```python
def _write_setup_indeterminate_run(
    *,
    out_root: Path,
    scenario: str,
    coding_agent: str,
    message: str,
) -> str:
    run_dir = _allocate_run_dir(out_root=out_root, scenario_name=scenario, coding_agent=coding_agent)
    _write_indeterminate(
        run_dir,
        final_reason=f"coding-agent batch preflight failed: {message}",
        error=RunError(stage="setup", message=message[:500]),
    )
    return run_dir.name
```

- [ ] **Step 6: Use preflight in `run_batch`**

After `write_batch_header(...)`, add:

```python
    preflight_env_by_agent: dict[str, dict[str, str]] = {}
    kimi_entries = [entry for entry in runnable_indexed if entry[1].coding_agent == "kimi"]
    if kimi_entries:
        try:
            preflight_env_by_agent["kimi"] = prepare_kimi_batch_preflight(
                batch_dir=batch_dir,
                coding_agents_dir=coding_agents_dir,
            )
        except Exception as e:
            for idx, entry in kimi_entries:
                run_id = _write_setup_indeterminate_run(
                    out_root=out_root,
                    scenario=entry.scenario,
                    coding_agent=entry.coding_agent,
                    message=str(e),
                )
                append_result_record(
                    batch_dir=batch_dir,
                    scenario=entry.scenario,
                    coding_agent=entry.coding_agent,
                    run_id=run_id,
                    skipped=None,
                )
                progress.finished(idx, "indeterminate")
            runnable_indexed = [
                (idx, entry) for idx, entry in runnable_indexed if entry.coding_agent != "kimi"
            ]
```

Because `runnable_indexed` is currently assigned once, remove `final` assumptions by making it a mutable list:

```python
    runnable_indexed = [(idx, e) for idx, e in indexed if e.runnable]
```

already yields a list, so reassigning it is fine.

- [ ] **Step 7: Skip child preflight when marker is present**

In `_seed_kimi_config`, keep the Task 5 skip:

```python
    if not os.environ.get("QUORUM_KIMI_PREFLIGHT_SENTINEL"):
        run_kimi_auth_preflight(...)
```

Also validate the marker path exists:

```python
    marker = os.environ.get("QUORUM_KIMI_PREFLIGHT_SENTINEL")
    if marker and not Path(marker).is_file():
        raise RunnerError("Kimi preflight sentinel missing", stage="setup")
```

- [ ] **Step 8: Run tests and commit**

Run:

```bash
uv run pytest tests/quorum/test_run_all.py tests/quorum/test_runner.py -q
```

Expected: PASS.

Commit:

```bash
git add quorum/run_all.py quorum/runner.py tests/quorum/test_run_all.py
git commit -m "quorum: preflight kimi once per run-all batch"
```

---

## Task 9: Plugin Check Tool, Bootstrap Scenario, Docs, and Security

**Why now:** Once the harness internals are correct, update the deterministic check and human-facing docs so future maintainers do not resurrect the old local-state binding.

**Files:**
- Modify: `bin/kimi-plugin-installed`
- Modify: `tests/quorum/test_trace_tools.py`
- Modify: `scenarios/kimi-superpowers-bootstrap/checks.sh`
- Modify: `README.md`
- Modify: `SECURITY.md`
- Test: `tests/quorum/test_trace_tools.py`

- [ ] **Step 1: Update failing trace-tool tests**

In `tests/quorum/test_trace_tools.py`, change Kimi plugin fixtures from:

```python
"source": "local",
```

to:

```python
"source": "local-path",
```

Add:

```python
def test_kimi_plugin_installed_fails_when_source_is_local(tmp_path):
    run_dir = tmp_path / "run"
    workdir = run_dir / "coding-agent-workdir"
    workdir.mkdir(parents=True)
    superpowers = tmp_path / "superpowers"
    (superpowers / ".kimi-plugin").mkdir(parents=True)
    (superpowers / "skills" / "using-superpowers").mkdir(parents=True)
    (superpowers / ".kimi-plugin" / "plugin.json").write_text("{}")
    (superpowers / "skills" / "using-superpowers" / "SKILL.md").write_text("skill")
    plugins_dir = run_dir / "coding-agent-config" / "plugins"
    plugins_dir.mkdir(parents=True)
    (plugins_dir / "installed.json").write_text(
        json.dumps(
            {
                "version": 1,
                "plugins": [
                    {
                        "id": "superpowers",
                        "root": str(superpowers),
                        "source": "local",
                        "enabled": True,
                    }
                ],
            }
        )
        + "\n"
    )
    sink = tmp_path / "s"

    result = subprocess.run(
        [str(BIN / "kimi-plugin-installed")],
        cwd=workdir,
        env={
            "PATH": f"{BIN}:/usr/bin:/bin",
            "QUORUM_RECORD_SINK": str(sink),
            "QUORUM_RUN_DIR": str(run_dir),
            "SUPERPOWERS_ROOT": str(superpowers),
        },
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "local-path" in _r(sink)["detail"]
```

- [ ] **Step 2: Run trace-tool tests and verify failure**

Run:

```bash
uv run pytest tests/quorum/test_trace_tools.py -q
```

Expected: FAIL because `bin/kimi-plugin-installed` still accepts `source == "local"` and does not require `SUPERPOWERS_ROOT`.

- [ ] **Step 3: Update `bin/kimi-plugin-installed`**

Replace the jq selection with:

```bash
PLUGIN_ROOT=$(
    jq -r '
      [.plugins[]
       | select(.id == "superpowers" and .enabled == true and .source == "local-path")]
      | if length == 1 then .[0].root else empty end
    ' "$INSTALLED"
)
```

Before checking files, require:

```bash
if [ -z "${SUPERPOWERS_ROOT:-}" ]; then
    record_fail "SUPERPOWERS_ROOT is not set"
    exit 1
fi

ROOT_REAL=$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$PLUGIN_ROOT")
EXPECTED_REAL=$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$SUPERPOWERS_ROOT")
if [ "$ROOT_REAL" != "$EXPECTED_REAL" ]; then
    record_fail "Kimi Superpowers plugin root $ROOT_REAL does not match SUPERPOWERS_ROOT $EXPECTED_REAL"
    exit 1
fi

if [ -d "$KIMI_HOME_DIR/plugins/managed/superpowers" ]; then
    record_fail "Kimi Superpowers plugin must not use copied plugins/managed/superpowers"
    exit 1
fi
```

Update the missing-plugin message to say:

```bash
record_fail "exactly one enabled local-path Superpowers plugin missing from $INSTALLED"
```

- [ ] **Step 4: Keep bootstrap checks focused on behavior**

Keep `scenarios/kimi-superpowers-bootstrap/checks.sh` as:

```bash
# coding-agents: kimi

pre() {
    git-repo
    git-branch main
}

post() {
    kimi-plugin-installed
    skill-called superpowers:brainstorming
    skill-before-tool superpowers:brainstorming Edit
    skill-before-tool superpowers:brainstorming Write
}
```

Do not add a separate `plugin_session_start` check here. Task 6 implements that as a central runner/capture invariant so every Kimi scenario proves plugin bootstrap, including scenarios without trace checks.

- [ ] **Step 5: Update README Kimi docs**

In `README.md`, update the actor lists and safety sections to include Kimi. Add:

````markdown
Trusted-maintainer Kimi smoke:

```bash
export SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers
export KIMI_MODEL_API_KEY=...
uv run quorum run scenarios/kimi-superpowers-bootstrap --coding-agent kimi
```

Kimi runs use a fresh per-run `KIMI_CODE_HOME` and do not read or symlink local
`~/.kimi-code`. Auth/model config comes from `KIMI_MODEL_API_KEY` plus Quorum's
default Kimi provider env. `KIMI_MODEL_NAME` may be overridden; other host
`KIMI_MODEL_*` overrides are rejected in v1 for reproducibility.
````

Also document:

```markdown
Do not wire Kimi live evals to public CI. They launch `kimi --yolo`, write raw
`wire.jsonl` model/tool logs, and should not be run against untrusted PR
scenarios until Kimi tool-subprocess env scrubbing has been verified.
```

- [ ] **Step 6: Update `SECURITY.md`**

Add a Kimi section:

```markdown
## Kimi Live Evals

Kimi live evals launch `kimi --yolo` inside a Quorum-prepared workdir. Quorum
uses a fresh `KIMI_CODE_HOME`, installs only the local Superpowers plugin via
`plugins/installed.json`, and supplies model auth through a temporary runtime
env file that is deleted by the launcher and runner cleanup paths.

Treat Kimi `results/` artifacts as sensitive. Raw `wire.jsonl` logs may contain
model outputs, tool arguments, and provider env until Kimi tool-subprocess env
scrubbing is verified. Do not run live Kimi evals in public CI or against
untrusted PR scenarios.
```

- [ ] **Step 7: Run tests and commit**

Run:

```bash
uv run pytest tests/quorum/test_trace_tools.py -q
uv run quorum check kimi-superpowers-bootstrap
```

Expected: PASS.

Commit:

```bash
git add bin/kimi-plugin-installed tests/quorum/test_trace_tools.py scenarios/kimi-superpowers-bootstrap/checks.sh README.md SECURITY.md
git commit -m "docs: document isolated kimi eval setup"
```

---

## Task 10: Full Static Verification and Live Smoke Handoff

**Why last:** This verifies the whole implementation locally without invoking live Kimi unless explicitly opted in.

**Files:**
- Verification-only task; no planned file edits.

- [ ] **Step 1: Run focused static/unit checks**

Run:

```bash
uv run ruff check
uv run ty check
uv run quorum check
uv run pytest tests/quorum/test_coding_agent_config.py tests/quorum/test_kimi.py tests/quorum/test_runner.py tests/quorum/test_capture.py tests/quorum/test_normalizers.py tests/quorum/test_token_usage.py tests/quorum/test_trace_tools.py tests/quorum/test_run_all.py tests/quorum/test_economics.py -q
```

Expected: PASS.

- [ ] **Step 2: Run the full test suite**

Run:

```bash
uv run pytest
```

Expected: PASS.

- [ ] **Step 3: Confirm generated static artifacts avoid secret and stale-local-state strings**

Run:

```bash
! rg -n 'fake-kimi-key|KIMI_MODEL_API_KEY=.*fake' coding-agents quorum bin scenarios README.md SECURITY.md
! rg -n '~/.kimi-code|symlinked local auth|existing Kimi login|source": "local"' coding-agents quorum bin scenarios
```

Expected: both commands exit 0 because `rg` finds no matches. Tests may still include stale examples that assert rejection.

- [ ] **Step 4: Return verification failures to their owning task**

If Step 1-3 fails, fix the failing behavior in the task that introduced it, rerun that task's focused tests, then rerun Task 10 from Step 1. Do not create a catch-all verification commit.

- [ ] **Step 5: Live smoke, trusted maintainer only**

Run only with Drew's approval and real local credentials:

```bash
export SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers
export KIMI_MODEL_API_KEY=...
uv run quorum run scenarios/kimi-superpowers-bootstrap --coding-agent kimi
uv run quorum show kimi-superpowers-bootstrap
```

Expected:

- final verdict is `pass`;
- `coding-agent-tool-calls.jsonl` contains `superpowers:brainstorming`;
- the raw matched `wire.jsonl` contains `plugin_session_start` for `superpowers` and `using-superpowers`;
- `coding-agent-token-usage.json` exists when Kimi emitted `usage.record` rows;
- Kimi cost fields are `null`;
- no runtime env file remains outside `results/`.

- [ ] **Step 6: Live curated subset, trusted maintainer only**

After the bootstrap run passes:

```bash
uv run quorum run-all --coding-agents kimi --scenarios kimi-superpowers-bootstrap,triggering-writing-plans,triggering-test-driven-development,explicit-skill-request-sdd,claim-without-verification-naive --jobs 1
uv run quorum show
```

Expected:

- parent Kimi preflight runs once for the batch;
- no cells are `unknown` due to parent preflight failure;
- failures, if any, are triaged as `harness-fail`, `scenario-port-needed`, or `product-fail`.

- [ ] **Step 7: Final implementation branch review**

Request code review after the implementation branch is verified:

```bash
git status --short
git log --oneline -10
```

Dispatch one reviewer with:

```text
Review the Kimi Quorum Coding-Agent implementation against docs/superpowers/specs/2026-06-03-kimi-quorum-coding-agent-design.md and docs/superpowers/plans/2026-06-03-kimi-quorum-coding-agent.md. Focus on isolation from ~/.kimi-code, secret handling, run-all preflight semantics, fail-closed capture behavior, plugin_session_start proof, token aggregation, and stale local-path surfaces.
```

Expected: reviewer finds no Critical or Important issues before merging or opening the PR.

---

## Plan Self-Review Checklist

- Spec coverage: Tasks 1-9 cover config, env, auth, plugin install, launcher, preflight, capture, token usage, run-all, docs, security, and bootstrap checks.
- Reviewer carry-forward: Task 6 makes `plugin_session_start` central; Task 8 defines parent preflight failure as per-cell setup indeterminate; Task 3 and Task 9 replace stale local-auth/source surfaces; Task 1 routes missing `KIMI_MODEL_API_KEY` to setup-stage diagnostics.
- TDD shape: Each implementation task starts with failing tests, then implementation, then targeted verification and commit.
- Live safety: No task requires live Kimi until Task 10, and that task is explicitly trusted-maintainer only.
