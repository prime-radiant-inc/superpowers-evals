# Claude Haiku Quorum Target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `claude-haiku` as a first-class Quorum Coding-Agent target that shares Claude Code provisioning with `claude` while pinning Claude Haiku 4.5.

**Architecture:** Keep Quorum target identity separate from runtime provisioning. `name` remains the matrix/run/directive identity, `runtime_family` chooses shared runtime setup and context templates, `normalizer` chooses transcript parsing, and `model` supplies the Claude launcher model. v1 supports only Claude-family variants where `runtime_family != name`; non-Claude variants are rejected until their provider/config paths are designed.

**Tech Stack:** Python 3.11, dataclasses, PyYAML, pytest, Quorum runner, Claude Code launcher templates.

---

## Source Spec

- `docs/superpowers/specs/2026-06-09-claude-haiku-quorum-target-design.md`

## Files

- Modify: `quorum/coding_agent_config.py`
  - Add `runtime_family` and `model` to `CodingAgentConfig`.
  - Validate file stem/name identity, known runtime families, Claude model presence, and v1 non-Claude variant guard.
- Modify: `quorum/runner.py`
  - Use `runtime_family` for Claude provisioning, skeleton selection, context selection, preflight, and `$CLAUDE_MODEL` substitution.
  - Keep requested `coding_agent` string for run identity, directives, and artifacts.
- Modify: `coding-agents/claude.yaml`
  - Add `runtime_family: claude` and `model: opus`.
- Create: `coding-agents/claude-haiku.yaml`
  - New first-class target config.
- Modify: `coding-agents/claude-context/launch-agent`
  - Replace hardcoded `--model opus` with `--model "$CLAUDE_MODEL"`.
- Modify: `coding-agents/claude-context/HOWTO.md`
  - Replace hardcoded `--model opus` prose with `$CLAUDE_MODEL`.
- Modify: `tests/quorum/test_coding_agent_config.py`
  - Schema and checked-in config coverage.
- Modify: `tests/quorum/test_runner.py`
  - Claude-family seeding, preflight, context/model substitution, project prompt, and checked-in launcher coverage.
- Modify: `tests/quorum/test_runner_always_verdict.py`
  - Keep minimal Claude config fixtures valid after Claude-family `model` is required.
- Modify: `tests/quorum/test_runner_gating.py`
  - Literal directive behavior for `claude` vs `claude-haiku`.
- Modify: `tests/quorum/test_run_all.py`
  - Matrix identity for `claude-haiku` as its own YAML stem.
- Modify: `README.md`
  - Document the new target and live-eval safety.

---

### Task 1: Add Target-Variant Schema

**Files:**
- Modify: `quorum/coding_agent_config.py`
- Modify: `tests/quorum/test_coding_agent_config.py`

- [ ] **Step 1: Add failing config-loader tests**

Append these tests inside `TestLoadCodingAgentConfig` in `tests/quorum/test_coding_agent_config.py`:

```python
    def test_runtime_family_defaults_to_name_and_model_defaults_unset(self, tmp_path):
        path = _write(tmp_path, "codex", {
            "name": "codex",
            "binary": "codex",
            "agent_config_env": "CODEX_HOME",
            "session_log_dir": "${CODEX_HOME}/sessions",
            "session_log_glob": "*.jsonl",
            "normalizer": "claude",
            "required_env": [],
        })

        cfg = load_coding_agent_config(path)

        assert cfg.runtime_family == "codex"
        assert cfg.model is None

    def test_file_stem_must_match_name(self, tmp_path):
        path = _write(tmp_path, "claude-haiku", {
            "name": "claude",
            "runtime_family": "claude",
            "binary": "claude",
            "agent_config_env": "CLAUDE_CONFIG_DIR",
            "session_log_dir": "${CLAUDE_CONFIG_DIR}/projects",
            "session_log_glob": "**/*.jsonl",
            "normalizer": "claude",
            "required_env": [],
            "model": "claude-haiku-4-5-20251001",
        })

        with pytest.raises(CodingAgentConfigError, match="name must match file stem"):
            load_coding_agent_config(path)

    def test_unknown_runtime_family_raises(self, tmp_path):
        path = _write(tmp_path, "strange", {
            "name": "strange",
            "runtime_family": "strange",
            "binary": "strange",
            "agent_config_env": "STRANGE_HOME",
            "session_log_dir": "/tmp/strange",
            "session_log_glob": "*.jsonl",
            "normalizer": "claude",
            "required_env": [],
        })

        with pytest.raises(CodingAgentConfigError, match="unknown runtime_family"):
            load_coding_agent_config(path)

    def test_claude_family_requires_model(self, tmp_path):
        path = _write(tmp_path, "claude-haiku", {
            "name": "claude-haiku",
            "runtime_family": "claude",
            "binary": "claude",
            "agent_config_env": "CLAUDE_CONFIG_DIR",
            "session_log_dir": "${CLAUDE_CONFIG_DIR}/projects",
            "session_log_glob": "**/*.jsonl",
            "normalizer": "claude",
            "required_env": [],
        })

        with pytest.raises(CodingAgentConfigError, match="model"):
            load_coding_agent_config(path)

    def test_non_claude_variant_is_rejected_in_v1(self, tmp_path):
        path = _write(tmp_path, "opencode-claude", {
            "name": "opencode-claude",
            "runtime_family": "opencode",
            "binary": "opencode",
            "agent_config_env": "OPENCODE_QUORUM_HOME",
            "session_log_dir": "${OPENCODE_QUORUM_HOME}/sessions",
            "session_log_glob": "*.json",
            "normalizer": "opencode",
            "required_env": [],
            "model": "anthropic/claude-sonnet-4-6",
        })

        with pytest.raises(CodingAgentConfigError, match="non-Claude variants"):
            load_coding_agent_config(path)
```

Update existing tests in this file that write `name: claude` configs to include `"model": "opus"` when they are meant to load successfully. Update the two existing `"weirdo"` successful config tests to use a known family such as `"codex"`, because unknown runtime families now fail.

- [ ] **Step 2: Run the config tests and confirm failure**

Run:

```bash
uv run pytest tests/quorum/test_coding_agent_config.py -q
```

Expected: failures mentioning missing `runtime_family` / `model` attributes and missing validation.

- [ ] **Step 3: Implement schema fields and validation**

In `quorum/coding_agent_config.py`, add constants near `PROJECT_ROOT`:

```python
KNOWN_RUNTIME_FAMILIES = frozenset({
    "antigravity",
    "claude",
    "codex",
    "copilot",
    "gemini",
    "kimi",
    "opencode",
    "pi",
})
```

Extend the dataclass:

```python
@dataclass(frozen=True)
class CodingAgentConfig:
    name: str
    runtime_family: str
    binary: str
    agent_config_env: str
    session_log_dir: str  # template, e.g. "${CLAUDE_CONFIG_DIR}/projects"
    session_log_glob: str
    normalizer: str
    required_env: tuple[str, ...]
    max_time: str | None
    project_prompt: Path | None
    model: str | None
```

In `load_coding_agent_config`, after the required-field check and before env validation, add:

```python
    name = raw["name"]
    if name != path.stem:
        raise CodingAgentConfigError(
            f"{path}: name must match file stem {path.stem!r}; got {name!r}"
        )

    runtime_family = raw.get("runtime_family", name)
    if runtime_family not in KNOWN_RUNTIME_FAMILIES:
        raise CodingAgentConfigError(
            f"{path}: unknown runtime_family {runtime_family!r}; "
            f"known: {sorted(KNOWN_RUNTIME_FAMILIES)}"
        )

    model = raw.get("model")
    if runtime_family == "claude" and not isinstance(model, str):
        raise CodingAgentConfigError(
            f"{path}: Claude-family targets must set non-empty model"
        )
    if isinstance(model, str) and not model.strip():
        raise CodingAgentConfigError(f"{path}: model must be a non-empty string")
    if runtime_family != "claude" and runtime_family != name:
        raise CodingAgentConfigError(
            f"{path}: non-Claude variants are not supported in v1; "
            f"runtime_family must equal name"
        )
```

Return the new fields:

```python
    return CodingAgentConfig(
        name=name,
        runtime_family=runtime_family,
        binary=raw["binary"],
        agent_config_env=raw["agent_config_env"],
        session_log_dir=raw["session_log_dir"],
        session_log_glob=raw["session_log_glob"],
        normalizer=normalizer,
        required_env=required_env,
        max_time=raw.get("max_time"),
        project_prompt=project_prompt,
        model=model,
    )
```

- [ ] **Step 4: Update direct `CodingAgentConfig(...)` construction sites**

Run:

```bash
rg -n "CodingAgentConfig\\(" tests quorum
rg -n '"name": "claude"|name: claude' tests/quorum -g '*.py'
```

For every direct construction, add `runtime_family=<same family>` and `model=<value>`. In `tests/quorum/test_runner.py`, update `_tcfg` to make future helper calls concise:

```python
def _tcfg(
    name: str = "claude",
    *,
    runtime_family: str | None = None,
    model: str | None = None,
) -> CodingAgentConfig:
    family = runtime_family or name
    return CodingAgentConfig(
        name=name,
        runtime_family=family,
        binary="echo",
        agent_config_env="CLAUDE_CONFIG_DIR",
        session_log_dir="${CLAUDE_CONFIG_DIR}/projects",
        session_log_glob="*.jsonl",
        normalizer="claude",
        required_env=(),
        max_time=None,
        project_prompt=None,
        model=model if model is not None else ("opus" if family == "claude" else None),
    )
```

For the other helper constructors in `tests/quorum/test_runner.py`, set:

```python
runtime_family="antigravity", model=None
runtime_family="gemini", model=None
runtime_family="opencode", model=None
runtime_family="pi", model=None
runtime_family="copilot", model=None
runtime_family="kimi", model=None
```

Update `tests/quorum/test_runner.py::_make_coding_agent` so temporary Claude-family YAMLs remain valid:

```python
def _make_coding_agent(coding_agents_dir: Path, name: str, session_log_dir: Path) -> None:
    coding_agents_dir.mkdir(parents=True, exist_ok=True)
    doc = {
        "name": name,
        "binary": "echo",  # we never actually run the real CLI in tests
        "agent_config_env": "CLAUDE_CONFIG_DIR",
        "session_log_dir": str(session_log_dir),
        "session_log_glob": "*.jsonl",
        "normalizer": "claude",
        "required_env": [],
    }
    if name in {"claude", "claude-haiku"}:
        doc["runtime_family"] = "claude"
        doc["model"] = "opus" if name == "claude" else "claude-haiku-4-5-20251001"
    (coding_agents_dir / f"{name}.yaml").write_text(yaml.safe_dump(doc))
```

Update `tests/quorum/test_runner_always_verdict.py::_make_coding_agent` the same way. For one-off YAML literals in `tests/quorum/test_runner.py` that create `claude.yaml`, add:

```python
"runtime_family": "claude",
"model": "opus",
```

- [ ] **Step 5: Verify config tests pass**

Run:

```bash
uv run pytest tests/quorum/test_coding_agent_config.py -q
```

Expected: all tests in the file pass.

---

### Task 2: Add Claude and Claude Haiku Target Configs

**Files:**
- Modify: `coding-agents/claude.yaml`
- Create: `coding-agents/claude-haiku.yaml`
- Modify: `tests/quorum/test_coding_agent_config.py`

- [ ] **Step 1: Add failing checked-in config tests**

Add these top-level tests to `tests/quorum/test_coding_agent_config.py` near the existing checked-in config tests:

```python
def test_claude_config_exposes_runtime_family_and_model(monkeypatch, tmp_path):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-anthropic-key")
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "superpowers"))

    cfg = load_coding_agent_config(
        Path(__file__).resolve().parents[2] / "coding-agents" / "claude.yaml"
    )

    assert cfg.name == "claude"
    assert cfg.runtime_family == "claude"
    assert cfg.model == "opus"


def test_claude_haiku_config_loads(monkeypatch, tmp_path):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-anthropic-key")
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "superpowers"))

    cfg = load_coding_agent_config(
        Path(__file__).resolve().parents[2] / "coding-agents" / "claude-haiku.yaml"
    )

    assert cfg.name == "claude-haiku"
    assert cfg.runtime_family == "claude"
    assert cfg.binary == "claude"
    assert cfg.agent_config_env == "CLAUDE_CONFIG_DIR"
    assert cfg.normalizer == "claude"
    assert cfg.model == "claude-haiku-4-5-20251001"
    assert cfg.project_prompt == (
        Path(__file__).resolve().parents[2]
        / "coding-agents"
        / "claude.project-prompt.md"
    ).resolve()
```

- [ ] **Step 2: Run the checked-in config tests and confirm failure**

Run:

```bash
uv run pytest tests/quorum/test_coding_agent_config.py::test_claude_config_exposes_runtime_family_and_model tests/quorum/test_coding_agent_config.py::test_claude_haiku_config_loads -q
```

Expected: `claude.yaml` lacks model fields and `claude-haiku.yaml` does not exist.

- [ ] **Step 3: Update `claude.yaml`**

Change `coding-agents/claude.yaml` to:

```yaml
name: claude
runtime_family: claude
binary: claude
agent_config_env: CLAUDE_CONFIG_DIR
session_log_dir: "${CLAUDE_CONFIG_DIR}/projects"
session_log_glob: "**/*.jsonl"
normalizer: claude
required_env:
  - ANTHROPIC_API_KEY
  - SUPERPOWERS_ROOT
max_time: 10m
project_prompt: claude.project-prompt.md
model: opus
```

- [ ] **Step 4: Create `claude-haiku.yaml`**

Create `coding-agents/claude-haiku.yaml`:

```yaml
name: claude-haiku
runtime_family: claude
binary: claude
agent_config_env: CLAUDE_CONFIG_DIR
session_log_dir: "${CLAUDE_CONFIG_DIR}/projects"
session_log_glob: "**/*.jsonl"
normalizer: claude
required_env:
  - ANTHROPIC_API_KEY
  - SUPERPOWERS_ROOT
max_time: 10m
project_prompt: claude.project-prompt.md
model: claude-haiku-4-5-20251001
```

- [ ] **Step 5: Verify checked-in config tests pass**

Run:

```bash
uv run pytest tests/quorum/test_coding_agent_config.py -q
```

Expected: all config-loader tests pass.

---

### Task 3: Make Runner Provisioning Runtime-Family Aware

**Files:**
- Modify: `quorum/runner.py`
- Modify: `tests/quorum/test_runner.py`

- [ ] **Step 1: Add failing runner tests for Claude-family provisioning**

Add these tests to `TestSeedAgentConfigDir` in `tests/quorum/test_runner.py`:

```python
    def test_claude_family_variant_uses_claude_skeleton_and_auth(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-long-test-key-for-haiku")
        skel = tmp_path / "claude-home-skeleton"
        skel.mkdir()
        (skel / ".claude.json").write_text(json.dumps({"hasCompletedOnboarding": True}))
        workdir = tmp_path / "workdir"
        workdir.mkdir()
        dest = tmp_path / "agent-config"
        cfg = _tcfg(
            "claude-haiku",
            runtime_family="claude",
            model="claude-haiku-4-5-20251001",
        )

        runtime = _seed_agent_config_dir(
            cfg,
            tmp_path,
            dest,
            workdir,
            run_dir=tmp_path / "run-dir",
        )

        claude_config = json.loads((dest / ".claude.json").read_text())
        assert claude_config["hasCompletedOnboarding"] is True
        assert claude_config["projects"][str(workdir.resolve())]["hasTrustDialogAccepted"] is True
        assert (dest / CLAUDE_ENV_FILE_NAME).read_text() == (
            "ANTHROPIC_API_KEY='sk-long-test-key-for-haiku'\n"
        )
        assert runtime.substitutions["$CLAUDE_ENV_FILE"] == str(
            dest / CLAUDE_ENV_FILE_NAME
        )
```

Add this test near other `run_scenario` setup/preflight tests:

```python
    def test_claude_family_missing_binary_fails_before_writing_env(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-key")
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "sp"))
        monkeypatch.setattr("quorum.runner.shutil.which", lambda _binary: None)
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        coding_agents_dir.mkdir()
        (coding_agents_dir / "claude-haiku.yaml").write_text(
            yaml.safe_dump(
                {
                    "name": "claude-haiku",
                    "runtime_family": "claude",
                    "binary": "claude",
                    "agent_config_env": "CLAUDE_CONFIG_DIR",
                    "session_log_dir": str(session_log_dir),
                    "session_log_glob": "*.jsonl",
                    "normalizer": "claude",
                    "required_env": ["ANTHROPIC_API_KEY", "SUPERPOWERS_ROOT"],
                    "model": "claude-haiku-4-5-20251001",
                }
            )
        )
        sd = _make_scenario(scenarios_dir, "x", with_checks=False)
        (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")

        with patch("quorum.runner.invoke_gauntlet") as mock_g:
            run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="claude-haiku",
                coding_agents_dir=coding_agents_dir,
                out_root=tmp_path / "results",
                skeleton_root=_empty_skeleton(tmp_path),
            )

        mock_g.assert_not_called()
        assert verdict.final == "indeterminate"
        assert verdict.error is not None
        assert verdict.error.stage == "setup"
        assert "Claude Code is not on PATH" in verdict.error.message
        assert not (run_dir / "coding-agent-config" / CLAUDE_ENV_FILE_NAME).exists()
```

- [ ] **Step 2: Run the new runner tests and confirm failure**

Run:

```bash
uv run pytest tests/quorum/test_runner.py::TestSeedAgentConfigDir::test_claude_family_variant_uses_claude_skeleton_and_auth tests/quorum/test_runner.py::TestRunScenario::test_claude_family_missing_binary_fails_before_writing_env -q
```

Expected: the variant does not use Claude skeleton/auth yet, and the missing-binary preflight does not exist.

- [ ] **Step 3: Add a Claude binary preflight helper**

In `quorum/runner.py`, add near other setup helpers:

```python
def _preflight_coding_agent_binary(tcfg: CodingAgentConfig) -> None:
    if tcfg.runtime_family != "claude":
        return
    if shutil.which(tcfg.binary) is None:
        raise RunnerError(
            f"Claude Code is not on PATH: {tcfg.binary!r}",
            stage="setup",
        )
```

Call it in `_run_scenario_inner` after directive gating and before creating/writing the agent config dir:

```python
    _preflight_coding_agent_binary(tcfg)
```

Place the call before:

```python
    workdir = run_dir / "coding-agent-workdir"
```

- [ ] **Step 4: Switch Claude provisioning checks to `runtime_family`**

In `_seed_agent_config_dir`, replace the skeleton calculation with:

```python
    runtime_family = coding_agent.runtime_family
    skeleton = skeleton_root / f"{runtime_family}-home-skeleton"
```

Replace the two Claude checks:

```python
    if coding_agent.name == "claude" and seeded:
```

and:

```python
    if coding_agent.name == "claude" and "ANTHROPIC_API_KEY" in coding_agent.required_env:
```

with:

```python
    if runtime_family == "claude" and seeded:
```

and:

```python
    if runtime_family == "claude" and "ANTHROPIC_API_KEY" in coding_agent.required_env:
```

Do not change the non-Claude branches in this task.

- [ ] **Step 5: Verify provisioning tests pass**

Run:

```bash
uv run pytest tests/quorum/test_runner.py::TestSeedAgentConfigDir::test_claude_family_variant_uses_claude_skeleton_and_auth tests/quorum/test_runner.py::TestRunScenario::test_claude_family_missing_binary_fails_before_writing_env -q
```

Expected: both tests pass.

---

### Task 4: Make Claude Context and Model Substitution Runtime-Family Aware

**Files:**
- Modify: `quorum/runner.py`
- Modify: `coding-agents/claude-context/launch-agent`
- Modify: `coding-agents/claude-context/HOWTO.md`
- Modify: `tests/quorum/test_runner.py`

- [ ] **Step 1: Add failing context/model tests**

Add this test near the existing context substitution tests in `tests/quorum/test_runner.py`:

```python
    def test_claude_family_variant_uses_shared_context_model_and_project_prompt(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-key")
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "sp"))
        monkeypatch.setattr(
            "quorum.runner.shutil.which",
            lambda binary: "/usr/bin/claude" if binary == "claude" else None,
        )
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        coding_agents_dir.mkdir()
        (coding_agents_dir / "claude.project-prompt.md").write_text("shared prompt")
        (coding_agents_dir / "claude-haiku.yaml").write_text(
            yaml.safe_dump(
                {
                    "name": "claude-haiku",
                    "runtime_family": "claude",
                    "binary": "claude",
                    "agent_config_env": "CLAUDE_CONFIG_DIR",
                    "session_log_dir": str(session_log_dir),
                    "session_log_glob": "*.jsonl",
                    "normalizer": "claude",
                    "required_env": ["ANTHROPIC_API_KEY", "SUPERPOWERS_ROOT"],
                    "project_prompt": "claude.project-prompt.md",
                    "model": "claude-haiku-4-5-20251001",
                }
            )
        )
        claude_context = coding_agents_dir / "claude-context"
        claude_context.mkdir()
        (claude_context / "HOWTO.md").write_text(
            "model=$CLAUDE_MODEL launcher=$QUORUM_LAUNCH_AGENT\n"
        )
        (claude_context / "launch-agent").write_text(
            "#!/usr/bin/env bash\n"
            'echo "model=$CLAUDE_MODEL config=$CLAUDE_CONFIG_DIR"\n'
        )
        sd = _make_scenario(scenarios_dir, "x", with_checks=False)
        (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")
        captured: dict[str, Path | None] = {}

        def stub(*, run_dir, project_prompt, **kwargs):
            captured["project_prompt"] = project_prompt
            (session_log_dir / "session.jsonl").write_text(_claude_log_line())
            (run_dir / ".gauntlet" / "results").mkdir(parents=True, exist_ok=True)
            return GauntletResult(status="pass")

        with patch("quorum.runner.invoke_gauntlet", side_effect=stub):
            run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="claude-haiku",
                coding_agents_dir=coding_agents_dir,
                out_root=tmp_path / "results",
                skeleton_root=_empty_skeleton(tmp_path),
            )

        assert verdict.final == "pass"
        ctx = run_dir / "gauntlet-agent" / "context"
        assert not (coding_agents_dir / "claude-haiku-context").exists()
        assert "claude-haiku-4-5-20251001" in (ctx / "HOWTO.md").read_text()
        assert "$CLAUDE_MODEL" not in (ctx / "HOWTO.md").read_text()
        assert "claude-haiku-4-5-20251001" in (ctx / "launch-agent").read_text()
        assert captured["project_prompt"] == (
            coding_agents_dir / "claude.project-prompt.md"
        ).resolve()
```

Add this missing-context test near it:

```python
    def test_claude_family_missing_shared_context_is_setup_indeterminate(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-key")
        monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "sp"))
        monkeypatch.setattr(
            "quorum.runner.shutil.which",
            lambda binary: "/usr/bin/claude" if binary == "claude" else None,
        )
        coding_agents_dir = tmp_path / "coding-agents"
        scenarios_dir = tmp_path / "scenarios"
        session_log_dir = tmp_path / "logs"
        session_log_dir.mkdir()
        coding_agents_dir.mkdir()
        (coding_agents_dir / "claude-haiku.yaml").write_text(
            yaml.safe_dump(
                {
                    "name": "claude-haiku",
                    "runtime_family": "claude",
                    "binary": "claude",
                    "agent_config_env": "CLAUDE_CONFIG_DIR",
                    "session_log_dir": str(session_log_dir),
                    "session_log_glob": "*.jsonl",
                    "normalizer": "claude",
                    "required_env": ["ANTHROPIC_API_KEY", "SUPERPOWERS_ROOT"],
                    "model": "claude-haiku-4-5-20251001",
                }
            )
        )
        sd = _make_scenario(scenarios_dir, "x", with_checks=False)
        (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")

        with patch("quorum.runner.invoke_gauntlet") as mock_g:
            run_dir, verdict = run_scenario(
                scenario_dir=sd,
                coding_agent="claude-haiku",
                coding_agents_dir=coding_agents_dir,
                out_root=tmp_path / "results",
                skeleton_root=_empty_skeleton(tmp_path),
            )

        mock_g.assert_not_called()
        assert verdict.final == "indeterminate"
        assert verdict.error is not None
        assert verdict.error.stage == "setup"
        assert "claude-context" in verdict.error.message
        assert (run_dir / "verdict.json").exists()
```

- [ ] **Step 2: Run the new tests and confirm failure**

Run:

```bash
uv run pytest tests/quorum/test_runner.py::TestRunScenario::test_claude_family_variant_uses_shared_context_model_and_project_prompt tests/quorum/test_runner.py::TestRunScenario::test_claude_family_missing_shared_context_is_setup_indeterminate -q
```

Expected: context lookup still uses `claude-haiku-context`, and `$CLAUDE_MODEL` is not substituted.

- [ ] **Step 3: Update `_populate_context_dir` to support required shared context**

Change the function signature in `quorum/runner.py`:

```python
def _populate_context_dir(
    coding_agents_dir: Path,
    coding_agent: str,
    run_dir: Path,
    substitutions: dict[str, str] | None = None,
    *,
    required: bool = False,
    forbidden_placeholders: tuple[str, ...] = (),
) -> None:
```

Inside the function, replace the missing-source return with:

```python
    if not src.exists():
        if required:
            raise RunnerError(f"required coding-agent context missing: {src}", stage="setup")
        return
```

After copying files, add:

```python
    for path in dst.rglob("*"):
        if not path.is_file():
            continue
        try:
            content = path.read_text()
        except UnicodeDecodeError:
            continue
        unresolved = [p for p in forbidden_placeholders if p in content]
        if unresolved:
            raise RunnerError(
                f"unresolved placeholder(s) in generated context {path}: {unresolved}",
                stage="setup",
            )
```

- [ ] **Step 4: Pass runtime family and model into context population**

In `_run_scenario_inner`, add Claude model substitution:

```python
        if tcfg.runtime_family == "claude":
            substitutions["$CLAUDE_MODEL"] = tcfg.model or ""
```

Then replace the `_populate_context_dir` call with:

```python
        context_family = tcfg.runtime_family
        _populate_context_dir(
            coding_agents_dir,
            context_family,
            run_dir,
            substitutions=substitutions,
            required=context_family == "claude",
            forbidden_placeholders=("$CLAUDE_MODEL",) if context_family == "claude" else (),
        )
```

Keep `coding_agent` unchanged everywhere else in `_run_scenario_inner`; it remains the run identity.

- [ ] **Step 5: Update Claude context templates**

In `coding-agents/claude-context/launch-agent`, replace the debug comment command and final exec line so both use `$CLAUDE_MODEL`:

```bash
#   cd "$QUORUM_AGENT_CWD" && source "$CLAUDE_ENV_FILE" && env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR" ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" claude --dangerously-skip-permissions --plugin-dir "$SUPERPOWERS_ROOT" --model "$CLAUDE_MODEL"
```

```bash
exec env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR" ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" claude --dangerously-skip-permissions --plugin-dir "$SUPERPOWERS_ROOT" --model "$CLAUDE_MODEL" "$@"
```

In `coding-agents/claude-context/HOWTO.md`, replace the generated command example with:

```text
cd <prepared-workdir> && source <per-run-claude-env> && CLAUDE_CONFIG_DIR=<per-run-isolated-dir> claude --dangerously-skip-permissions --plugin-dir <superpowers-root> --model "$CLAUDE_MODEL"
```

- [ ] **Step 6: Update checked-in launcher tests**

In `tests/quorum/test_runner.py`, update `test_checked_in_claude_launcher_sources_env_file_and_stays_non_bare` to assert model substitution:

```python
        assert '--model "$CLAUDE_MODEL"' in content
        assert "--model opus" not in content
```

- [ ] **Step 7: Verify context/model tests pass**

Run:

```bash
uv run pytest tests/quorum/test_runner.py::TestRunScenario::test_claude_family_variant_uses_shared_context_model_and_project_prompt tests/quorum/test_runner.py::TestRunScenario::test_claude_family_missing_shared_context_is_setup_indeterminate tests/quorum/test_runner.py::TestRunScenario::test_checked_in_claude_launcher_sources_env_file_and_stays_non_bare -q
```

Expected: all selected tests pass.

---

### Task 5: Preserve Target Identity in Directives and Matrix

**Files:**
- Modify: `tests/quorum/test_runner_gating.py`
- Modify: `tests/quorum/test_run_all.py`

- [ ] **Step 1: Add directive tests for literal `claude-haiku` identity**

In `tests/quorum/test_runner_gating.py`, update `_make_coding_agent` so Claude-family names include the required config fields:

```python
def _make_coding_agent(coding_agents_dir: Path, name: str, session_log_dir: Path) -> None:
    coding_agents_dir.mkdir(parents=True, exist_ok=True)
    doc = {
        "name": name,
        "binary": "echo",
        "agent_config_env": "CLAUDE_CONFIG_DIR",
        "session_log_dir": str(session_log_dir),
        "session_log_glob": "*.jsonl",
        "normalizer": "claude",
        "required_env": [],
    }
    if name in {"claude", "claude-haiku"}:
        doc["runtime_family"] = "claude"
        doc["model"] = "opus" if name == "claude" else "claude-haiku-4-5-20251001"
    (coding_agents_dir / f"{name}.yaml").write_text(yaml.safe_dump(doc))
```

Update `_run` so `claude-haiku` can use shared Claude context:

```python
    context_name = "claude" if coding_agent == "claude-haiku" else coding_agent
    (coding_agents_dir / f"{context_name}-context").mkdir(parents=True, exist_ok=True)
```

Add these tests to `TestCodingAgentGating`:

```python
    def test_claude_directive_does_not_include_claude_haiku(self, tmp_path, monkeypatch):
        monkeypatch.setattr(
            "quorum.runner.shutil.which",
            lambda binary: "/bin/echo" if binary == "echo" else None,
        )
        scen = _scenario(
            tmp_path / "s",
            checks_body="# coding-agents: claude\npre() { :; }\npost() { :; }\n",
        )

        with patch("quorum.runner.invoke_gauntlet") as mock_g:
            verdict = _run(tmp_path, scen, coding_agent="claude-haiku")

        mock_g.assert_not_called()
        assert verdict.final == "indeterminate"
        assert "requires coding-agents" in verdict.final_reason

    def test_explicit_claude_haiku_directive_proceeds(self, tmp_path, monkeypatch):
        monkeypatch.setattr(
            "quorum.runner.shutil.which",
            lambda binary: "/bin/echo" if binary == "echo" else None,
        )
        scen = _scenario(
            tmp_path / "s",
            checks_body="# coding-agents: claude,claude-haiku\npre() { :; }\npost() { :; }\n",
        )
        invoked = []

        def fake_gauntlet(*, run_dir, **kwargs):
            invoked.append(True)
            (run_dir / ".gauntlet" / "results").mkdir(parents=True, exist_ok=True)
            return "pass"

        fake_verdict = FinalVerdict(final="pass")
        with (
            patch("quorum.runner.invoke_gauntlet", side_effect=fake_gauntlet),
            patch("quorum.runner.compose", return_value=fake_verdict),
        ):
            _run(tmp_path, scen, coding_agent="claude-haiku")

        assert invoked
```

- [ ] **Step 2: Add run-all matrix test for separate target identity**

Add this test to `tests/quorum/test_run_all.py` near the existing directive tests:

```python
def test_build_matrix_treats_claude_haiku_as_distinct_literal_agent(tmp_path):
    scenarios = tmp_path / "scenarios"
    agents = tmp_path / "agents"
    _scenario(scenarios, "claude_only", directive="claude")
    _scenario(scenarios, "open")
    _agent(agents, "claude")
    _agent(agents, "claude-haiku")

    entries = build_matrix(scenarios_root=scenarios, coding_agents_dir=agents)

    skipped = {(e.scenario, e.coding_agent) for e in entries if not e.runnable}
    runnable = {(e.scenario, e.coding_agent) for e in entries if e.runnable}
    assert ("claude_only", "claude-haiku") in skipped
    assert ("claude_only", "claude") in runnable
    assert ("open", "claude") in runnable
    assert ("open", "claude-haiku") in runnable
```

- [ ] **Step 3: Run identity tests**

Run:

```bash
uv run pytest tests/quorum/test_runner_gating.py tests/quorum/test_run_all.py::test_build_matrix_treats_claude_haiku_as_distinct_literal_agent -q
```

Expected: all selected tests pass.

---

### Task 6: Update README and Run Verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README target list and safety prose**

In `README.md`, update the Quick Start target list from:

```markdown
Agent names are `claude`, `codex`, `antigravity`, `gemini`, `kimi`,
`opencode`, `pi`, and `copilot`; not every scenario is valid for every agent.
```

to:

```markdown
Agent names are `claude`, `claude-haiku`, `codex`, `antigravity`, `gemini`,
`kimi`, `opencode`, `pi`, and `copilot`; not every scenario is valid for every
agent.
```

In "Live Eval Risk", replace:

```markdown
- Claude uses `--dangerously-skip-permissions`.
```

with:

```markdown
- Claude and Claude Haiku use Claude Code with `--dangerously-skip-permissions`.
```

Replace:

```markdown
Claude, `CODEX_HOME` for Codex,
```

with:

```markdown
Claude and Claude Haiku, `CODEX_HOME` for Codex,
```

Add a trusted-maintainer smoke block after the first single-scenario example:

````markdown
Trusted-maintainer Claude Haiku smoke:

```bash
export SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers
export ANTHROPIC_API_KEY=...
uv run quorum run scenarios/00-quorum-smoke-hello-world \
  --coding-agent claude-haiku \
  --out-root results/claude-haiku-smoke
uv run quorum show <run-dir>
```

Do not wire Claude Haiku live evals to public CI; it uses the same Anthropic
API-key path and broad Claude Code execution permissions as the `claude` target.
````

- [ ] **Step 2: Run targeted static tests**

Run:

```bash
uv run pytest tests/quorum/test_coding_agent_config.py -q
uv run pytest tests/quorum/test_runner.py -q
uv run pytest tests/quorum/test_runner_gating.py tests/quorum/test_run_all.py tests/quorum/test_token_usage.py -q
```

Expected: all selected tests pass.

- [ ] **Step 3: Run repo static verification**

Run:

```bash
uv run ruff check
uv run ty check
uv run quorum check
uv run pytest
```

Expected: all commands pass. If `ty` or full `pytest` reveals pre-existing unrelated failures, capture exact output and ask Drew before broadening scope.

- [ ] **Step 4: Run the live Claude Haiku smoke**

Run only from a trusted maintainer shell with the required env:

```bash
export SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers
export ANTHROPIC_API_KEY=...
uv run quorum run scenarios/00-quorum-smoke-hello-world \
  --coding-agent claude-haiku \
  --out-root results/claude-haiku-smoke
```

Expected: command prints a run id and writes one run directory under `results/claude-haiku-smoke/`.

- [ ] **Step 5: Inspect smoke verdict and artifacts**

Set `RUN_DIR` to the actual run directory, then run:

```bash
export RUN_DIR=results/claude-haiku-smoke/<actual-run-dir>
uv run quorum show "$RUN_DIR"
python - <<'PY'
import json
import os
from pathlib import Path

run = Path(os.environ["RUN_DIR"])
verdict = json.loads((run / "verdict.json").read_text())
assert verdict["final"] == "pass", verdict
assert (run / "coding-agent-tool-calls.jsonl").read_text().strip()
usage = json.loads((run / "coding-agent-token-usage.json").read_text())
assert usage["models"], usage
models = [usage.get("model", ""), *usage["models"].keys()]
assert all("haiku" in model for model in models), models
assert not any("opus" in model or "sonnet" in model for model in models), models
assert usage.get("est_cost_usd") is not None, usage
assert not usage.get("has_unpriced_model", False), usage
launcher = (run / "gauntlet-agent" / "context" / "launch-agent").read_text()
howto = (run / "gauntlet-agent" / "context" / "HOWTO.md").read_text()
assert "--model claude-haiku-4-5-20251001" in launcher
assert "--model opus" not in launcher
assert "claude-haiku-4-5-20251001" in howto
PY
```

Expected: the Python assertions complete without output.

- [ ] **Step 6: Scan smoke artifacts for full key leakage**

Run:

```bash
python - <<'PY'
import os
import stat
from pathlib import Path

run = Path(os.environ["RUN_DIR"])
key = os.environ["ANTHROPIC_API_KEY"]
allowed = run / "coding-agent-config" / ".claude-env"
assert allowed.is_file(), allowed
assert stat.S_IMODE(allowed.stat().st_mode) == 0o600, oct(allowed.stat().st_mode)
hits = []
for path in run.rglob("*"):
    if not path.is_file() or path == allowed:
        continue
    try:
        content = path.read_text(errors="ignore")
    except OSError:
        continue
    if key in content:
        hits.append(str(path))
assert not hits, hits
print("full ANTHROPIC_API_KEY appears only in", allowed)
PY
```

Expected: prints only the allowed `.claude-env` location. Treat the whole run directory as sensitive even when this passes.

- [ ] **Step 7: If smoke fails for auth/session reasons, run the documented `--bare` retry**

Do not edit the checked-in launcher for this retry. Use a temporary coding-agent directory:

```bash
tmp_agents="$(mktemp -d)"
export TMP_AGENTS="$tmp_agents"
cp -R coding-agents/. "$tmp_agents/"
python - <<'PY'
import os
from pathlib import Path

launcher = Path(os.environ["TMP_AGENTS"]) / "claude-context" / "launch-agent"
text = launcher.read_text()
text = text.replace(
    "claude --dangerously-skip-permissions",
    "claude --bare --dangerously-skip-permissions",
)
launcher.write_text(text)
PY
uv run quorum run scenarios/00-quorum-smoke-hello-world \
  --coding-agent claude-haiku \
  --coding-agents-dir "$tmp_agents" \
  --out-root results/claude-haiku-smoke-bare
```

Expected: this retry is only diagnostic. If it is required for success, stop and update the implementation notes with Drew before landing a checked-in `--bare` change.

---

## Final Review Checklist

- [ ] `coding-agents/claude-haiku.yaml` exists and loads.
- [ ] `coding-agents/claude.yaml` still loads and still pins `model: opus`.
- [ ] `claude-haiku` run dirs and run-all rows use `claude-haiku`, not `claude`.
- [ ] `runtime_family: claude` is used for Claude provisioning and context.
- [ ] `normalizer: claude` still drives capture strictness.
- [ ] `claude-context` is shared; no `claude-haiku-context` directory is required.
- [ ] Generated launcher and HOWTO include `claude-haiku-4-5-20251001`.
- [ ] The checked-in Claude launcher remains non-bare unless Drew approves a documented change.
- [ ] The full smoke secret scan passes.
- [ ] No live eval artifacts are staged.
