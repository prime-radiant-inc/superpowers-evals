# Pi Quorum Coding-Agent Target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `pi` as a first-class Quorum Coding-Agent target that launches Pi with isolated API-key auth, loads Superpowers from local `SUPERPOWERS_ROOT`, captures Pi JSONL sessions, and passes a Pi-only Superpowers bootstrap scenario.

**Architecture:** Keep Pi inside the existing Coding-Agent adapter model: one YAML config, one generated launcher, runner-level config seeding, the existing Pi normalizer, and shared trace predicates. The runner gets small Pi-specific hooks for run-local auth files, context substitution, missing/empty transcript diagnostics, and wrong-cwd session diagnostics.

**Tech Stack:** Python 3.11+, uv, pytest, ty, ruff, Bash check tools, jq, Gauntlet TUI adapter, Pi CLI `0.78.0+`.

**Spec:** [docs/superpowers/specs/2026-06-03-pi-quorum-coding-agent-design.md](../specs/2026-06-03-pi-quorum-coding-agent-design.md)

---

## File Structure

**Create:**
- `coding-agents/pi.yaml` - Pi Coding-Agent config.
- `coding-agents/pi-context/HOWTO.md` - Gauntlet-Agent driver instructions.
- `coding-agents/pi-context/launch-agent` - generated launcher template for interactive Pi.
- `scenarios/pi-superpowers-bootstrap/story.md` - Pi bootstrap scenario.
- `scenarios/pi-superpowers-bootstrap/setup.sh` - base fixture setup.
- `scenarios/pi-superpowers-bootstrap/checks.sh` - Pi bootstrap checks.

**Modify:**
- `quorum/normalizers.py` - add wrong-cwd Pi session detection helper.
- `quorum/capture.py` - expose wrong-cwd Pi session detection to the runner.
- `quorum/runner.py` - seed Pi auth/config/env files, substitute `$PI_ENV_FILE`, and fail closed on missing/empty/misplaced Pi sessions.
- `tests/quorum/test_coding_agent_config.py` - Pi YAML coverage.
- `tests/quorum/test_normalizers.py` - sanitized Pi golden transcript and misplaced-session helper coverage.
- `tests/quorum/test_capture.py` - capture wrapper coverage for Pi misplaced-session detection.
- `tests/quorum/test_runner.py` - Pi seeding, launcher/context substitution, setup failures, and capture diagnostics.
- `tests/quorum/test_trace_tools.py` - Pi-named skill predicate coverage for canonical `Read` calls.
- `README.md` - Pi target docs, safety, required env, troubleshooting, and live-smoke command.
- `docs/superpowers/skills/triaging-a-failing-eval.md` - Pi capture troubleshooting notes.

**Do Not Change:**
- `quorum/token_usage.py`. Pi token/cost capture remains unsupported in v1.
- Public CI to launch Pi. Live Pi evals stay trusted-maintainer operations.
- Existing Claude, Codex, or Antigravity launchers except for shared tests that need to account for Pi.
- `bin/_skill_predicate.jq` unless Pi-specific tests expose a real gap. The current generic `Read` path predicate should already work.

---

## Task 1: Pi Config and Context Skeleton

**Why first:** Quorum needs a selectable `--coding-agent pi` target before runner seeding or live scenarios can exercise anything.

**Files:**
- Create: `coding-agents/pi.yaml`
- Create: `coding-agents/pi-context/HOWTO.md`
- Create: `coding-agents/pi-context/launch-agent`
- Test: `tests/quorum/test_coding_agent_config.py`

- [ ] **Step 1: Write failing config-loader coverage**

In `tests/quorum/test_coding_agent_config.py`, add:

```python
def test_pi_config_loads_when_env_set(monkeypatch, tmp_path):
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(tmp_path / "superpowers"))
    monkeypatch.setenv("PI_PROVIDER", "azure-openai-responses")
    monkeypatch.setenv("PI_MODEL", "gpt-5.4")
    monkeypatch.setenv("PI_API_KEY", "pi-test-key")

    cfg = load_coding_agent_config(
        Path(__file__).resolve().parents[2] / "coding-agents" / "pi.yaml"
    )

    assert cfg.name == "pi"
    assert cfg.binary == "pi"
    assert cfg.agent_config_env == "PI_CODING_AGENT_DIR"
    assert cfg.normalizer == "pi"
    assert cfg.session_log_glob == "*.jsonl"
    assert cfg.resolve_session_log_dir(tmp_path / "cfg") == tmp_path / "cfg" / "sessions"
```

Run: `uv run pytest tests/quorum/test_coding_agent_config.py::test_pi_config_loads_when_env_set -q`

Expected: FAIL because `coding-agents/pi.yaml` does not exist yet.

- [ ] **Step 2: Add `coding-agents/pi.yaml`**

Create `coding-agents/pi.yaml`:

```yaml
name: pi
binary: pi
agent_config_env: PI_CODING_AGENT_DIR
session_log_dir: "${PI_CODING_AGENT_DIR}/sessions"
session_log_glob: "*.jsonl"
normalizer: pi
required_env:
  - SUPERPOWERS_ROOT
  - PI_PROVIDER
  - PI_MODEL
  - PI_API_KEY
max_time: 10m
max_concurrency: 1
```

- [ ] **Step 3: Add the launcher template**

Create `coding-agents/pi-context/launch-agent`:

```bash
#!/usr/bin/env bash
# quorum-generated launcher for Pi (the agent under test).
#
# quorum substitutes the $... values below at runtime, so the installed copy
# contains literal absolute paths. The cd, auth env file, session dir, model,
# extension path, and tool allowlist are baked in so the QA agent launches Pi
# with one command and cannot accidentally start from the scratch directory.
set -euo pipefail

cd "$QUORUM_AGENT_CWD" || {
  echo "launch-agent: cannot cd to $QUORUM_AGENT_CWD" >&2
  exit 1
}

set -a
. "$PI_ENV_FILE"
set +a

exec env \
  PI_CODING_AGENT_DIR="$PI_CODING_AGENT_DIR" \
  PI_OFFLINE=1 \
  PI_TELEMETRY=0 \
  pi \
    --session-dir "$PI_CODING_AGENT_DIR/sessions" \
    --provider "$PI_PROVIDER" \
    --model "$PI_MODEL" \
    --no-extensions \
    --extension "$SUPERPOWERS_ROOT" \
    --no-skills \
    --skill "$SUPERPOWERS_ROOT/skills" \
    --no-context-files \
    --tools read,bash,edit,write,grep,find,ls \
    "$@"
```

- [ ] **Step 4: Add the HOWTO**

Create `coding-agents/pi-context/HOWTO.md`:

```markdown
# How to drive Pi (the agent under test)

You are driving Pi in a bash shell inside tmux. Pi is itself an AI agent; what appears on screen is its work.

## Launch Pi with one command

Your bash starts in a scratch directory, NOT the workdir quorum prepared. quorum has generated a launcher that handles everything: it cds into the prepared workdir, sources the run-local Pi auth env file, sets the isolated `PI_CODING_AGENT_DIR`, points Pi at the isolated session directory, selects the configured model, loads the Superpowers extension from `SUPERPOWERS_ROOT`, disables ambient skill and context-file discovery, explicitly loads `SUPERPOWERS_ROOT/skills`, and enables the built-in coding tools.

Type this one line, verbatim, as your first action:

```bash
"$QUORUM_LAUNCH_AGENT"
```

Do not hand-type a bare `pi` or reconstruct the command yourself. Launching from the scratch directory makes quorum discard the run as misconfigured.

## Observing what Pi is doing

Pi writes JSONL session logs under:

```text
$PI_CODING_AGENT_DIR/sessions/*.jsonl
```

The session JSONL is ground truth for tool calls and agent actions. The screen can lag, scroll off the top, or stay frozen while Pi is still working. When the screen and logs disagree, trust the logs.

Find the newest session:

```bash
ls -t "$PI_CODING_AGENT_DIR"/sessions/*.jsonl 2>/dev/null | head -1
```

Tail that file to inspect recent activity.

## Waiting for Pi to work

When Pi is busy, do not poll the screen with repeated sleeps. Register the session glob once after launch, then block-wait:

```text
watch_logs(glob="$PI_CODING_AGENT_DIR/sessions/*.jsonl")
wake_on_idle_log(idle_ms=60000, timeout_ms=240000)
```

Use `wake_on_idle_log(...)` to spend one inference turn waiting until the log goes idle, a new session appears, or the timeout expires.

## Tool mapping notes

Pi raw tool names are lowercase. quorum normalizes them to canonical names: `read` to `Read`, `write` to `Write`, `edit` to `Edit`, `bash` to `Bash`, `grep` to `Grep`, and `find` or `ls` to `Glob`.

Pi does not expose Claude Code's native `Skill` tool. Superpowers skill use may appear as Pi reading `skills/<name>/SKILL.md`; quorum recognizes those `Read` calls as skill invocations.

## Shutdown

Press Ctrl+D or type `/exit` if Pi accepts it.
```

- [ ] **Step 5: Run config tests**

Run: `uv run pytest tests/quorum/test_coding_agent_config.py::test_pi_config_loads_when_env_set -q`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add coding-agents/pi.yaml coding-agents/pi-context tests/quorum/test_coding_agent_config.py
git commit -m "quorum: add Pi coding-agent config"
```

---

## Task 2: Runner Pi Auth and Config Seeding

**Why next:** The launcher depends on run-local files that do not exist until the runner writes them.

**Files:**
- Modify: `quorum/runner.py`
- Test: `tests/quorum/test_runner.py`

- [ ] **Step 1: Write failing seeding tests**

In `tests/quorum/test_runner.py`, add a Pi config helper near the existing `_tcfg` helpers:

```python
def _pi_tcfg() -> CodingAgentConfig:
    return CodingAgentConfig(
        name="pi",
        binary="pi",
        agent_config_env="PI_CODING_AGENT_DIR",
        session_log_dir="${PI_CODING_AGENT_DIR}/sessions",
        session_log_glob="*.jsonl",
        normalizer="pi",
        required_env=("SUPERPOWERS_ROOT", "PI_PROVIDER", "PI_MODEL", "PI_API_KEY"),
        max_time="10m",
        project_prompt=None,
    )
```

Add:

```python
def _make_superpowers_pi_root(path: Path) -> Path:
    root = path / "superpowers"
    (root / ".pi" / "extensions").mkdir(parents=True)
    (root / "skills" / "using-superpowers" / "references").mkdir(parents=True)
    (root / "package.json").write_text('{"pi":{"extensions":["./.pi/extensions/superpowers.ts"],"skills":["./skills"]}}')
    (root / ".pi" / "extensions" / "superpowers.ts").write_text("export default function extension() {}")
    (root / "skills" / "using-superpowers" / "SKILL.md").write_text("---\nname: using-superpowers\n---\n")
    (root / "skills" / "using-superpowers" / "references" / "pi-tools.md").write_text("# Pi tools\n")
    return root
```

Add tests:

```python
def test_pi_target_seeds_run_local_auth_files(tmp_path, monkeypatch):
    superpowers = _make_superpowers_pi_root(tmp_path)
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(superpowers))
    monkeypatch.setenv("PI_PROVIDER", "azure-openai-responses")
    monkeypatch.setenv("PI_MODEL", "gpt-5.4")
    monkeypatch.setenv("PI_API_KEY", "secret-pi-key")
    monkeypatch.setenv("AZURE_OPENAI_BASE_URL", "https://example.openai.azure.com")
    monkeypatch.setattr("quorum.runner.shutil.which", lambda name: "/usr/bin/pi" if name == "pi" else None)

    dest = tmp_path / "cfg"
    _seed_agent_config_dir(_pi_tcfg(), tmp_path, dest, tmp_path / "wd")

    auth_path = dest / "auth.json"
    auth = json.loads((dest / "auth.json").read_text())
    assert auth == {
        "azure-openai-responses": {"type": "api_key", "key": "$PI_API_KEY"}
    }
    assert oct(auth_path.stat().st_mode & 0o777) == "0o600"
    assert "secret-pi-key" not in auth_path.read_text()
    settings = json.loads((dest / "settings.json").read_text())
    assert settings["defaultProvider"] == "azure-openai-responses"
    assert settings["defaultModel"] == "gpt-5.4"
    env_text = (dest / "pi.env").read_text()
    assert "secret-pi-key" in env_text
    assert "AZURE_OPENAI_BASE_URL=https://example.openai.azure.com" in env_text
    assert oct((dest / "pi.env").stat().st_mode & 0o777) == "0o600"
    assert (dest / "sessions").is_dir()


def test_pi_seed_requires_superpowers_root(tmp_path, monkeypatch):
    monkeypatch.delenv("SUPERPOWERS_ROOT", raising=False)
    monkeypatch.setenv("PI_PROVIDER", "azure-openai-responses")
    monkeypatch.setenv("PI_MODEL", "gpt-5.4")
    monkeypatch.setenv("PI_API_KEY", "secret-pi-key")

    with pytest.raises(RunnerError, match="SUPERPOWERS_ROOT"):
        _seed_agent_config_dir(_pi_tcfg(), tmp_path, tmp_path / "cfg", tmp_path / "wd")


def test_pi_seed_requires_api_key_env(tmp_path, monkeypatch):
    superpowers = _make_superpowers_pi_root(tmp_path)
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(superpowers))
    monkeypatch.setenv("PI_PROVIDER", "azure-openai-responses")
    monkeypatch.setenv("PI_MODEL", "gpt-5.4")
    monkeypatch.setenv("AZURE_OPENAI_BASE_URL", "https://example.openai.azure.com")
    monkeypatch.delenv("PI_API_KEY", raising=False)

    with pytest.raises(RunnerError, match="PI_API_KEY"):
        _seed_agent_config_dir(_pi_tcfg(), tmp_path, tmp_path / "cfg", tmp_path / "wd")


def test_pi_seed_requires_azure_endpoint_or_resource_name(tmp_path, monkeypatch):
    superpowers = _make_superpowers_pi_root(tmp_path)
    monkeypatch.setenv("SUPERPOWERS_ROOT", str(superpowers))
    monkeypatch.setenv("PI_PROVIDER", "azure-openai-responses")
    monkeypatch.setenv("PI_MODEL", "gpt-5.4")
    monkeypatch.setenv("PI_API_KEY", "secret-pi-key")
    monkeypatch.delenv("AZURE_OPENAI_BASE_URL", raising=False)
    monkeypatch.delenv("AZURE_OPENAI_RESOURCE_NAME", raising=False)
    monkeypatch.setattr("quorum.runner.shutil.which", lambda name: "/usr/bin/pi" if name == "pi" else None)

    with pytest.raises(RunnerError, match="AZURE_OPENAI_BASE_URL.*AZURE_OPENAI_RESOURCE_NAME"):
        _seed_agent_config_dir(_pi_tcfg(), tmp_path, tmp_path / "cfg", tmp_path / "wd")
```

Also add a full-run test named `test_pi_missing_required_env_is_setup_stage`:

- create a temporary `pi.yaml` whose `required_env` includes `PI_API_KEY`;
- leave `PI_API_KEY` unset;
- run `run_scenario(..., coding_agent="pi", ...)`;
- assert `verdict.final == "indeterminate"`;
- assert `verdict.error.stage == "setup"`;
- assert the final reason includes `required env vars not set`.

This test should fail before the implementation because `CodingAgentConfigError`
currently lands in the generic `unknown` exception handler.

Also add a full-run test named `test_pi_context_substitution_includes_env_file`
that mirrors `test_antigravity_launch_agent_is_interactive_and_substituted`:

- create a temporary `pi.yaml`;
- create `pi-context/HOWTO.md` and `pi-context/launch-agent` that include
  `$QUORUM_AGENT_CWD`, `$PI_CODING_AGENT_DIR`, `$PI_ENV_FILE`,
  `$SUPERPOWERS_ROOT`, and `$QUORUM_LAUNCH_AGENT`;
- patch `_seed_pi_config` and `invoke_gauntlet`;
- run `run_scenario(..., coding_agent="pi", ...)`;
- assert the copied `gauntlet-agent/context/launch-agent` is executable;
- assert the copied launcher and HOWTO contain resolved absolute paths;
- assert the copied launcher contains `--no-context-files`;
- assert the copied launcher and HOWTO do not contain `secret-pi-key` or any
  unresolved `$PI_ENV_FILE`, `$PI_CODING_AGENT_DIR`, `$SUPERPOWERS_ROOT`, or
  `$QUORUM_LAUNCH_AGENT` placeholders.

Run: `uv run pytest tests/quorum/test_runner.py -k 'pi_target_seeds or pi_seed or pi_missing_required_env or pi_context_substitution' -q`

Expected: FAIL because `_seed_agent_config_dir` has no Pi branch and config
loader errors are not yet classified as setup failures, and `$PI_ENV_FILE` has
not been added to the substitution map.

- [ ] **Step 2: Import `shlex` in the runner**

In `quorum/runner.py`, add:

```python
import shlex
```

- [ ] **Step 3: Add Pi seeding helpers**

In `quorum/runner.py`, add near the other seed helpers:

```python
def _require_env(name: str, purpose: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise RunnerError(f"{name} not set; cannot {purpose}", stage="setup")
    return value


def _require_pi_superpowers_source(superpowers_root: Path) -> None:
    required = [
        superpowers_root / "package.json",
        superpowers_root / ".pi" / "extensions" / "superpowers.ts",
        superpowers_root / "skills" / "using-superpowers" / "SKILL.md",
        superpowers_root / "skills" / "using-superpowers" / "references" / "pi-tools.md",
    ]
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise RunnerError(
            "SUPERPOWERS_ROOT is missing Pi support files: " + ", ".join(missing),
            stage="setup",
        )


PI_AZURE_ENV_NAMES = (
    "AZURE_OPENAI_BASE_URL",
    "AZURE_OPENAI_RESOURCE_NAME",
    "AZURE_OPENAI_API_VERSION",
    "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
)


def _pi_provider_extra_env(provider: str) -> dict[str, str]:
    if provider != "azure-openai-responses":
        return {}
    if not os.environ.get("AZURE_OPENAI_BASE_URL") and not os.environ.get("AZURE_OPENAI_RESOURCE_NAME"):
        raise RunnerError(
            "PI_PROVIDER=azure-openai-responses requires AZURE_OPENAI_BASE_URL "
            "or AZURE_OPENAI_RESOURCE_NAME",
            stage="setup",
        )
    return {name: os.environ[name] for name in PI_AZURE_ENV_NAMES if os.environ.get(name)}


def _write_pi_env_file(
    pi_config_dir: Path,
    *,
    provider: str,
    model: str,
    api_key: str,
    extra_env: dict[str, str],
) -> Path:
    env_path = pi_config_dir / "pi.env"
    env_path.write_text(
        "\n".join([
            f"export PI_PROVIDER={shlex.quote(provider)}",
            f"export PI_MODEL={shlex.quote(model)}",
            f"export PI_API_KEY={shlex.quote(api_key)}",
            *[
                f"export {name}={shlex.quote(value)}"
                for name, value in sorted(extra_env.items())
            ],
            "",
        ])
    )
    env_path.chmod(0o600)
    return env_path


def _seed_pi_config(pi_config_dir: Path) -> None:
    superpowers_raw = _require_env("SUPERPOWERS_ROOT", "load Pi Superpowers extension")
    provider = _require_env("PI_PROVIDER", "configure Pi provider")
    model = _require_env("PI_MODEL", "configure Pi model")
    api_key = _require_env("PI_API_KEY", "configure Pi API-key auth")
    extra_env = _pi_provider_extra_env(provider)

    superpowers_root = Path(superpowers_raw)
    _require_pi_superpowers_source(superpowers_root)

    if shutil.which("pi") is None:
        raise RunnerError("pi not found on PATH; cannot run Pi evals", stage="setup")

    pi_config_dir.mkdir(parents=True, exist_ok=True)
    (pi_config_dir / "sessions").mkdir(parents=True, exist_ok=True)

    auth_path = pi_config_dir / "auth.json"
    auth_path.write_text(
        json.dumps({provider: {"type": "api_key", "key": "$PI_API_KEY"}}, indent=2) + "\n"
    )
    auth_path.chmod(0o600)

    settings_path = pi_config_dir / "settings.json"
    settings_path.write_text(
        json.dumps(
            {
                "defaultProvider": provider,
                "defaultModel": model,
                "defaultThinkingLevel": "medium",
            },
            indent=2,
        )
        + "\n"
    )

    _write_pi_env_file(
        pi_config_dir,
        provider=provider,
        model=model,
        api_key=api_key,
        extra_env=extra_env,
    )
```

- [ ] **Step 4: Call Pi seeding from `_seed_agent_config_dir`**

In `_seed_agent_config_dir`, after the Codex and Antigravity branches, add:

```python
    if coding_agent.name == "pi":
        _seed_pi_config(dest)
```

- [ ] **Step 5: Substitute `$PI_ENV_FILE` in context population**

In `run_scenario`, before `_populate_context_dir(...)`, build the substitution dict as a local variable:

```python
    substitutions = {
        "$QUORUM_AGENT_CWD": str(launch_cwd),
        "$SUPERPOWERS_ROOT": os.environ.get("SUPERPOWERS_ROOT", ""),
        "$QUORUM_LAUNCH_AGENT": str(launch_agent_path),
        f"${tcfg.agent_config_env}": str(agent_config_dir),
    }
    if tcfg.name == "pi":
        substitutions["$PI_ENV_FILE"] = str(agent_config_dir / "pi.env")
```

Then pass `substitutions=substitutions` to `_populate_context_dir`.

- [ ] **Step 6: Classify Coding-Agent config errors as setup failures**

In `quorum/runner.py`, import `CodingAgentConfigError` and add an exception
handler before the generic `Exception` handler:

```python
    except CodingAgentConfigError as e:
        v = _write_indeterminate(
            run_dir,
            final_reason=f"coding-agent config failed: {e}",
            error=RunError(stage="setup", message=str(e)[:500]),
        )
        return run_dir, v
```

- [ ] **Step 7: Run runner seeding tests**

Run: `uv run pytest tests/quorum/test_runner.py -k 'pi_target_seeds or pi_seed or pi_missing_required_env or pi_context_substitution' -q`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add quorum/runner.py tests/quorum/test_runner.py
git commit -m "quorum: seed isolated Pi auth config"
```

---

## Task 3: Pi Capture Diagnostics

**Why next:** Broken Pi capture should be an invalid run, not a misleading Superpowers failure or a false-green file-only scenario.

**Files:**
- Modify: `quorum/normalizers.py`
- Modify: `quorum/capture.py`
- Modify: `quorum/runner.py`
- Test: `tests/quorum/test_normalizers.py`
- Test: `tests/quorum/test_capture.py`
- Test: `tests/quorum/test_runner.py`

- [ ] **Step 1: Write failing wrong-cwd helper tests**

In `tests/quorum/test_normalizers.py`, import
`find_misplaced_pi_sessions` and `find_unusable_pi_sessions`, then add inside
`TestNormalizePiLogs`:

```python
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
```

Run: `uv run pytest tests/quorum/test_normalizers.py -k 'misplaced_pi or unusable_pi' -q`

Expected: FAIL because the helper does not exist.

- [ ] **Step 2: Add `find_misplaced_pi_sessions`**

In `quorum/normalizers.py`, add after `filter_pi_logs_by_cwd`:

```python
def _pi_session_header_cwd(path: Path) -> str | None:
    try:
        with path.open() as f:
            first_line = f.readline()
        entry = json.loads(first_line)
    except (OSError, json.JSONDecodeError):
        return None
    if entry.get("type") != "session":
        return None
    cwd = entry.get("cwd", "")
    return cwd if isinstance(cwd, str) and cwd else None


def find_misplaced_pi_sessions(paths: list[Path], *, launch_cwd: Path) -> list[Path]:
    """New run-local Pi sessions that launched in the wrong cwd."""
    launch_cwd_real = os.path.realpath(launch_cwd)
    misplaced: list[Path] = []
    for path in paths:
        cwd = _pi_session_header_cwd(path)
        if cwd is None:
            continue
        cwd_real = os.path.realpath(cwd)
        if cwd_real != launch_cwd_real:
            misplaced.append(path)
    return misplaced


def find_unusable_pi_sessions(paths: list[Path]) -> list[Path]:
    """New Pi session files whose first row cannot identify a session cwd."""
    return [path for path in paths if _pi_session_header_cwd(path) is None]
```

- [ ] **Step 3: Expose the helpers through capture**

In `quorum/capture.py`, add `find_misplaced_pi_sessions` and
`find_unusable_pi_sessions` to the import list and add:

```python
def detect_misplaced_pi_sessions(
    *,
    log_dir: Path,
    log_glob: str,
    snapshot: set[str],
    launch_cwd: Path,
) -> list[Path]:
    """New run-local Pi sessions that launched in the wrong cwd."""
    new = new_files_since(log_dir, log_glob, snapshot)
    return find_misplaced_pi_sessions(new, launch_cwd=launch_cwd)


def detect_unusable_pi_sessions(
    *,
    log_dir: Path,
    log_glob: str,
    snapshot: set[str],
) -> list[Path]:
    """New Pi session files whose first row cannot identify a session cwd."""
    new = new_files_since(log_dir, log_glob, snapshot)
    return find_unusable_pi_sessions(new)
```

- [ ] **Step 4: Write failing capture wrapper tests**

In `tests/quorum/test_capture.py`, import `detect_misplaced_pi_sessions` and
`detect_unusable_pi_sessions`, then add tests that:

- create a snapshot on an empty run-local `sessions/` directory;
- write a new Pi JSONL whose first row has `cwd` different from `launch_cwd`;
- assert `detect_misplaced_pi_sessions(...)` returns that file;
- write a new Pi JSONL whose first row is malformed or lacks `cwd`;
- assert `detect_unusable_pi_sessions(...)` returns that file.

Run: `uv run pytest tests/quorum/test_capture.py -k pi_sessions -q`

Expected: FAIL because the capture helpers do not exist yet.

- [ ] **Step 5: Write failing runner diagnostics tests**

In `tests/quorum/test_runner.py`, add helpers mirroring the Antigravity fake-agent setup:

```python
def _make_pi_agent(coding_agents_dir: Path, session_log_dir: Path) -> None:
    coding_agents_dir.mkdir(parents=True, exist_ok=True)
    (coding_agents_dir / "pi.yaml").write_text(
        yaml.safe_dump({
            "name": "pi",
            "binary": "pi",
            "agent_config_env": "PI_CODING_AGENT_DIR",
            "session_log_dir": str(session_log_dir),
            "session_log_glob": "*.jsonl",
            "normalizer": "pi",
            "required_env": [],
        })
    )
    ctx = coding_agents_dir / "pi-context"
    ctx.mkdir(parents=True)
    (ctx / "HOWTO.md").write_text("run $QUORUM_LAUNCH_AGENT\n")
    (ctx / "launch-agent").write_text("#!/usr/bin/env bash\nset -euo pipefail\n")
```

Add:

```python
def test_pi_missing_session_is_indeterminate_even_without_trace_checks(tmp_path):
    coding_agents_dir = tmp_path / "agents"
    coding_agents_dir.mkdir()
    scenarios_dir = tmp_path / "scenarios"
    session_log_dir = tmp_path / "sessions"
    session_log_dir.mkdir()
    _make_pi_agent(coding_agents_dir, session_log_dir)
    sd = _make_scenario(scenarios_dir, "x", with_checks=False)
    (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")

    with patch("quorum.runner._seed_pi_config"), patch("quorum.runner.invoke_gauntlet") as gauntlet:
        gauntlet.return_value = "pass"
        run_dir, verdict = run_scenario(
            scenario_dir=sd,
            coding_agent="pi",
            out_root=tmp_path / "results",
            coding_agents_dir=coding_agents_dir,
            skeleton_root=_empty_skeleton(tmp_path),
        )

    assert verdict.final == "indeterminate"
    assert "no Pi session" in verdict.final_reason
    assert verdict.error.stage == "capture"


def test_pi_zero_normalized_rows_is_distinct_from_missing_session(tmp_path):
    coding_agents_dir = tmp_path / "agents"
    coding_agents_dir.mkdir()
    scenarios_dir = tmp_path / "scenarios"
    session_log_dir = tmp_path / "sessions"
    session_log_dir.mkdir()
    _make_pi_agent(coding_agents_dir, session_log_dir)
    sd = _make_scenario(scenarios_dir, "x", with_checks=False)
    (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")

    def write_empty_pi_session(*, run_dir, **kwargs):
        workdir = run_dir / "coding-agent-workdir"
        session_log_dir.joinpath("session.jsonl").write_text(
            json.dumps({"type": "session", "cwd": str(workdir)}) + "\n"
            + json.dumps({"type": "message", "message": {"role": "assistant", "content": [{"type": "text", "text": "done"}]}}) + "\n"
        )
        return "pass"

    with patch("quorum.runner._seed_pi_config"), patch("quorum.runner.invoke_gauntlet", side_effect=write_empty_pi_session):
        run_dir, verdict = run_scenario(
            scenario_dir=sd,
            coding_agent="pi",
            out_root=tmp_path / "results",
            coding_agents_dir=coding_agents_dir,
            skeleton_root=_empty_skeleton(tmp_path),
        )

    assert verdict.final == "indeterminate"
    assert "normalized to zero tool-call rows" in verdict.final_reason
    assert verdict.error.stage == "capture"


def test_pi_wrong_cwd_session_is_qa_agent_misconfigured(tmp_path):
    coding_agents_dir = tmp_path / "agents"
    coding_agents_dir.mkdir()
    scenarios_dir = tmp_path / "scenarios"
    session_log_dir = tmp_path / "sessions"
    session_log_dir.mkdir()
    _make_pi_agent(coding_agents_dir, session_log_dir)
    sd = _make_scenario(scenarios_dir, "x", with_checks=False)
    (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")

    def write_wrong_cwd_pi_session(*, run_dir, **kwargs):
        wrong_cwd = run_dir / "scratch"
        wrong_cwd.mkdir()
        session_log_dir.joinpath("session.jsonl").write_text(
            json.dumps({"type": "session", "cwd": str(wrong_cwd)}) + "\n"
        )
        return "pass"

    with patch("quorum.runner._seed_pi_config"), patch("quorum.runner.invoke_gauntlet", side_effect=write_wrong_cwd_pi_session):
        run_dir, verdict = run_scenario(
            scenario_dir=sd,
            coding_agent="pi",
            out_root=tmp_path / "results",
            coding_agents_dir=coding_agents_dir,
            skeleton_root=_empty_skeleton(tmp_path),
        )

    assert verdict.final == "indeterminate"
    assert "wrong cwd" in verdict.final_reason
    assert verdict.error.stage == "qa-agent-misconfigured"


def test_pi_malformed_session_header_is_capture_error(tmp_path):
    coding_agents_dir = tmp_path / "agents"
    coding_agents_dir.mkdir()
    scenarios_dir = tmp_path / "scenarios"
    session_log_dir = tmp_path / "sessions"
    session_log_dir.mkdir()
    _make_pi_agent(coding_agents_dir, session_log_dir)
    sd = _make_scenario(scenarios_dir, "x", with_checks=False)
    (sd / "checks.sh").write_text("pre() { :; }\npost() { :; }\n")

    def write_malformed_pi_session(**kwargs):
        session_log_dir.joinpath("session.jsonl").write_text("{not json}\n")
        return "pass"

    with patch("quorum.runner._seed_pi_config"), patch("quorum.runner.invoke_gauntlet", side_effect=write_malformed_pi_session):
        run_dir, verdict = run_scenario(
            scenario_dir=sd,
            coding_agent="pi",
            out_root=tmp_path / "results",
            coding_agents_dir=coding_agents_dir,
            skeleton_root=_empty_skeleton(tmp_path),
        )

    assert verdict.final == "indeterminate"
    assert "unusable Pi session header" in verdict.final_reason
    assert verdict.error.stage == "capture"
```

- [ ] **Step 6: Add Pi fail-closed diagnostics to runner**

In `quorum/runner.py`, import `detect_misplaced_pi_sessions` and
`detect_unusable_pi_sessions` from `quorum.capture`.

After building `gauntlet_layer` and before post-checks, add:

```python
    if tcfg.normalizer == "pi" and not capture_result.source_logs:
        misplaced = detect_misplaced_pi_sessions(
            log_dir=session_log_dir,
            log_glob=tcfg.session_log_glob,
            snapshot=snap,
            launch_cwd=launch_cwd,
        )
        if misplaced:
            misplaced_rel = [str(p.relative_to(session_log_dir)) for p in misplaced]
            return run_dir, _write_indeterminate(
                run_dir,
                final_reason=(
                    "QA agent launched Pi from the wrong cwd - likely skipped "
                    "`cd $QUORUM_AGENT_CWD` in the Pi launcher. See "
                    f"{misplaced_rel} for the misplaced session(s)."
                ),
                gauntlet=gauntlet_layer,
                checks=pre_records,
                error=RunError(
                    stage="qa-agent-misconfigured",
                    message=f"misplaced Pi sessions: {misplaced_rel}",
                ),
            )
        unusable = detect_unusable_pi_sessions(
            log_dir=session_log_dir,
            log_glob=tcfg.session_log_glob,
            snapshot=snap,
        )
        if unusable:
            unusable_rel = [str(p.relative_to(session_log_dir)) for p in unusable]
            return run_dir, _write_indeterminate(
                run_dir,
                final_reason=(
                    "unusable Pi session header(s): "
                    + ", ".join(unusable_rel)
                ),
                gauntlet=gauntlet_layer,
                checks=pre_records,
                error=RunError(
                    stage="capture",
                    message=f"unusable Pi session headers: {unusable_rel}",
                ),
            )
        return run_dir, _write_indeterminate(
            run_dir,
            final_reason=(
                "no Pi session appeared under isolated "
                f"{session_log_dir}; cannot evaluate this run"
            ),
            gauntlet=gauntlet_layer,
            checks=pre_records,
            error=RunError(stage="capture", message="no Pi session captured"),
        )

    if tcfg.normalizer == "pi" and capture_result.source_logs and capture_result.row_count == 0:
        rel = [str(p.relative_to(session_log_dir)) for p in capture_result.source_logs]
        return run_dir, _write_indeterminate(
            run_dir,
            final_reason="Pi session(s) normalized to zero tool-call rows: " + ", ".join(rel),
            gauntlet=gauntlet_layer,
            checks=pre_records,
            error=RunError(stage="capture", message="Pi capture normalized to zero rows"),
        )
```

- [ ] **Step 7: Run targeted diagnostics tests**

Run:

```bash
uv run pytest tests/quorum/test_normalizers.py -k 'misplaced_pi or unusable_pi' -q
uv run pytest tests/quorum/test_capture.py -k pi_sessions -q
uv run pytest tests/quorum/test_runner.py -k 'pi_missing_session or pi_zero_normalized or wrong_cwd or malformed_session' -q
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add quorum/normalizers.py quorum/capture.py quorum/runner.py tests/quorum/test_normalizers.py tests/quorum/test_capture.py tests/quorum/test_runner.py
git commit -m "quorum: fail closed on Pi capture problems"
```

---

## Task 4: Pi Golden Normalizer and Trace Predicate Coverage

**Why now:** Existing Pi normalizer tests cover the shape, but a sanitized live-style session guards against drift in Pi 0.78.0 logs.

**Files:**
- Modify: `tests/quorum/test_normalizers.py`
- Modify: `tests/quorum/test_trace_tools.py`

- [ ] **Step 1: Add a sanitized live-style Pi normalizer test**

In `tests/quorum/test_normalizers.py`, add to `TestNormalizePiLogs`. The
fixture should be based on the local Pi `0.78.0` JSONL shape and include:

- a first `session` row;
- `model_change` and `thinking_level_change` rows;
- assistant `toolCall` blocks for `read`, `write`, `edit`, `bash`, `find`,
  `ls`, and one unknown tool;
- a `toolResult` row;
- an assistant text-only row.

Assert the normalized tools are:

```python
["Read", "Write", "Edit", "Bash", "Glob", "Glob", "custom_tool"]
```

and assert non-tool rows are ignored:

```python
def test_normalizes_live_style_pi_session_with_model_and_tool_result_rows(self):
    lines = [
        json.dumps({"type": "session", "version": 3, "id": "session-1", "cwd": "/tmp/project"}),
        json.dumps({"type": "model_change", "provider": "openai-codex", "modelId": "gpt-5.5"}),
        json.dumps({"type": "thinking_level_change", "thinkingLevel": "medium"}),
        json.dumps({
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
        }),
        json.dumps({
            "type": "message",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "toolCall", "id": "call-write", "name": "write", "arguments": {"path": "out.md", "content": "ok"}},
                    {"type": "toolCall", "id": "call-edit", "name": "edit", "arguments": {"path": "out.md", "oldString": "ok", "newString": "done"}},
                    {"type": "toolCall", "id": "call-bash", "name": "bash", "arguments": {"command": "git status --short"}},
                    {"type": "toolCall", "id": "call-find", "name": "find", "arguments": {"path": ".", "pattern": "*.md"}},
                    {"type": "toolCall", "id": "call-ls", "name": "ls", "arguments": {"path": "."}},
                    {"type": "toolCall", "id": "call-custom", "name": "custom_tool", "arguments": {"x": 1}},
                ],
            },
        }),
        json.dumps({
            "type": "message",
            "message": {
                "role": "toolResult",
                "toolCallId": "call-read",
                "toolName": "read",
                "content": [{"type": "text", "text": "README"}],
            },
        }),
        json.dumps({
            "type": "message",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "done"}],
            },
        }),
    ]

    assert normalize_pi_logs("\n".join(lines)) == [
        {"tool": "Read", "args": {"path": "README.md"}, "source": "native"},
        {"tool": "Write", "args": {"path": "out.md", "content": "ok"}, "source": "native"},
        {"tool": "Edit", "args": {"path": "out.md", "oldString": "ok", "newString": "done"}, "source": "native"},
        {"tool": "Bash", "args": {"command": "git status --short"}, "source": "shell"},
        {"tool": "Glob", "args": {"path": ".", "pattern": "*.md"}, "source": "native"},
        {"tool": "Glob", "args": {"path": "."}, "source": "native"},
        {"tool": "custom_tool", "args": {"x": 1}, "source": "shell"},
    ]
```

Run: `uv run pytest tests/quorum/test_normalizers.py::TestNormalizePiLogs -q`

Expected: PASS if the current normalizer is already compatible.

- [ ] **Step 2: Add Pi-named trace predicate tests**

In `tests/quorum/test_trace_tools.py`, add:

```python
def test_skill_called_recognizes_pi_read_skill_md(tmp_path):
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(
        parent,
        {
            "tool": "Read",
            "args": {
                "path": "/tmp/run/superpowers/skills/brainstorming/SKILL.md",
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


def test_tool_arg_match_can_pin_pi_superpowers_skill_path(tmp_path):
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    skill_path = "/tmp/run/superpowers/skills/brainstorming/SKILL.md"
    trace = _trace(parent, {"tool": "Read", "args": {"path": skill_path}})
    sink = tmp_path / "s"
    assert (
        _run(
            "tool-arg-match",
            "Read",
            f'.path == "{skill_path}"',
            trace=trace,
            cwd=workdir,
            sink=sink,
        )
        == 0
    )


def test_skill_before_tool_recognizes_pi_read_skill_md(tmp_path):
    parent = tmp_path / "rundir"
    parent.mkdir()
    workdir = parent / "coding-agent-workdir"
    workdir.mkdir()
    trace = _trace(
        parent,
        {
            "tool": "Read",
            "args": {
                "path": "/tmp/run/superpowers/skills/brainstorming/SKILL.md",
            },
        },
        {"tool": "Write", "args": {"path": "PI_SUPERPOWERS_OK.md"}},
    )
    sink = tmp_path / "s"
    assert (
        _run(
            "skill-before-tool",
            "superpowers:brainstorming",
            "Write",
            trace=trace,
            cwd=workdir,
            sink=sink,
        )
        == 0
    )
```

Run: `uv run pytest tests/quorum/test_trace_tools.py -k 'pi_read_skill or pi_superpowers_skill_path' -q`

Expected: PASS without changing `bin/_skill_predicate.jq`. If it fails, update `_skill_predicate.jq` so it checks both `.args.path` and `.args.file_path`, then rerun.

- [ ] **Step 3: Commit**

```bash
git add tests/quorum/test_normalizers.py tests/quorum/test_trace_tools.py bin/_skill_predicate.jq
git commit -m "quorum: pin Pi trace normalization"
```

---

## Task 5: Pi Bootstrap Scenario

**Why now:** The target needs one live behavioral proof that Pi sees Superpowers bootstrap context and loads a relevant skill before editing.

**Files:**
- Create: `scenarios/pi-superpowers-bootstrap/story.md`
- Create: `scenarios/pi-superpowers-bootstrap/setup.sh`
- Create: `scenarios/pi-superpowers-bootstrap/checks.sh`

- [ ] **Step 1: Create the scenario story**

Create `scenarios/pi-superpowers-bootstrap/story.md`:

```markdown
---
id: pi-superpowers-bootstrap
title: Pi loads Superpowers skill context
---

# Story

You are testing Pi as the Coding-Agent under test. Launch Pi using the generated launcher from the Pi HOWTO.

Once Pi is ready, send this user message exactly:

> Create a file named `PI_SUPERPOWERS_OK.md` containing exactly `PI_SUPERPOWERS_OK`. This is a tiny feature-style change, so follow your Superpowers instructions before editing.

When Pi reports it is done, inspect its session log and the workdir before deciding the verdict.

## Acceptance Criteria

- Pi was launched through the generated quorum launcher.
- Pi created `PI_SUPERPOWERS_OK.md` in the prepared workdir.
- The file contains exactly `PI_SUPERPOWERS_OK`.
- Pi's normalized trace shows it loaded `superpowers:brainstorming` by reading
  `$SUPERPOWERS_ROOT/skills/brainstorming/SKILL.md`, not another global skill
  tree.
- Pi's normalized trace shows a `Write` call for `PI_SUPERPOWERS_OK.md`.
- The `superpowers:brainstorming` skill load appears before the `Write` call that creates `PI_SUPERPOWERS_OK.md`.
```

- [ ] **Step 2: Create setup**

Create `scenarios/pi-superpowers-bootstrap/setup.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

uv run setup-helpers run create_base_repo
```

Then ensure the setup file is executable:

```bash
chmod +x scenarios/pi-superpowers-bootstrap/setup.sh
```

- [ ] **Step 3: Create checks**

Create `scenarios/pi-superpowers-bootstrap/checks.sh`:

```bash
# coding-agents: pi
pre() {
    git-repo
    git-branch main
}

post() {
    file-exists "PI_SUPERPOWERS_OK.md"
    file-contains "PI_SUPERPOWERS_OK.md" "^PI_SUPERPOWERS_OK$"
    skill-called superpowers:brainstorming
    tool-arg-match Read ".path == \"$SUPERPOWERS_ROOT/skills/brainstorming/SKILL.md\""
    tool-arg-match Write '(.path // .file_path // "") | test("(^|/)PI_SUPERPOWERS_OK[.]md$")'
    # The target Write check above prevents a vacuous ordering pass. Since
    # skill-before-tool gates before the first Write, it also gates before the
    # target-file Write.
    skill-before-tool superpowers:brainstorming Write
}
```

Then remove the executable bit:

```bash
chmod -x scenarios/pi-superpowers-bootstrap/checks.sh
```

- [ ] **Step 4: Validate scenario structure**

Run: `uv run quorum check pi-superpowers-bootstrap`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scenarios/pi-superpowers-bootstrap
git commit -m "scenarios: add Pi Superpowers bootstrap eval"
```

---

## Task 6: README and Operator Docs

**Why now:** Operators need the exact env contract and troubleshooting path before running live Pi evals.

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/skills/triaging-a-failing-eval.md`

- [ ] **Step 1: Update top-level Coding-Agent references**

In `README.md`, change lists that currently say `claude`, `codex`, and `antigravity` so Pi appears where appropriate.

Update the required environment table to include:

```markdown
| `pi` | Pi CLI (`pi`) | `SUPERPOWERS_ROOT`, `PI_PROVIDER`, `PI_MODEL`, `PI_API_KEY` |
```

Add a note under the table: provider-specific non-key env may also be required.
For `PI_PROVIDER=azure-openai-responses`, set either `AZURE_OPENAI_BASE_URL` or
`AZURE_OPENAI_RESOURCE_NAME`; optional Azure env such as
`AZURE_OPENAI_API_VERSION` and `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` is copied into
the run-local `pi.env` when present.

- [ ] **Step 2: Add a Pi section after Antigravity**

Add:

```markdown
### Pi

`coding-agents/pi.yaml` launches Pi as `pi`. It requires `SUPERPOWERS_ROOT`, `PI_PROVIDER`, `PI_MODEL`, and `PI_API_KEY`.

The runner creates a per-run `PI_CODING_AGENT_DIR` under the run directory and writes:

```text
<run>/coding-agent-config/auth.json
<run>/coding-agent-config/settings.json
<run>/coding-agent-config/pi.env
<run>/coding-agent-config/sessions/*.jsonl
```

`auth.json` stores an API-key credential with `"key": "$PI_API_KEY"` so the secret is resolved from the sourced env file at runtime rather than embedded directly in the JSON auth file. `pi.env` contains the live secret and is chmod `0600`; Pi run directories are secret-bearing artifacts.

The generated launcher starts Pi with:

```bash
PI_CODING_AGENT_DIR="$PI_CODING_AGENT_DIR" \
PI_OFFLINE=1 \
PI_TELEMETRY=0 \
pi \
  --session-dir "$PI_CODING_AGENT_DIR/sessions" \
  --provider "$PI_PROVIDER" \
  --model "$PI_MODEL" \
  --no-extensions \
  --extension "$SUPERPOWERS_ROOT" \
  --no-skills \
  --skill "$SUPERPOWERS_ROOT/skills" \
  --no-context-files \
  --tools read,bash,edit,write,grep,find,ls
```

Pi loads the Superpowers extension and skills from the local
`SUPERPOWERS_ROOT`. Ambient extension and skill discovery is disabled so global
Pi packages or `~/.agents/skills` cannot satisfy the eval accidentally. Raw Pi
sessions are captured from:

```text
<run>/coding-agent-config/sessions/*.jsonl
```

Pi token/cost capture is unsupported in v1, so `coding-agent-token-usage.json` is not expected for Pi runs.
```

- [ ] **Step 3: Add Pi troubleshooting**

Add to the triage section:

```markdown
### Pi Troubleshooting

When a Pi run is non-passing or indeterminate:

1. Confirm `pi` is installed and reachable: `pi --version`.
2. Confirm required env is set: `SUPERPOWERS_ROOT`, `PI_PROVIDER`, `PI_MODEL`, and `PI_API_KEY`.
3. If using `azure-openai-responses`, confirm `AZURE_OPENAI_BASE_URL` or `AZURE_OPENAI_RESOURCE_NAME` is set.
4. Inspect `<run>/coding-agent-config/pi.env`; it should exist, be chmod `0600`, and include any required provider-specific non-key env.
5. Inspect `<run>/coding-agent-config/auth.json`; it should be chmod `0600` and contain the selected provider with `"type": "api_key"` and `"key": "$PI_API_KEY"`, not the raw key.
6. Confirm raw sessions exist under `<run>/coding-agent-config/sessions/*.jsonl`.
7. Confirm the first session row has `type: "session"` and `cwd` equal to the expected launch cwd.
8. If the verdict says `qa-agent-misconfigured`, look for a new Pi session whose `cwd` differs from the launch cwd; the QA agent likely skipped the generated launcher.
9. If the verdict says `unusable Pi session header`, inspect the first line of the raw JSONL for malformed JSON, missing `type: "session"`, or missing `cwd`.
10. Inspect normalized behavior in `<run>/coding-agent-tool-calls.jsonl`.
11. Render the verdict with `uv run quorum show <run-or-batch-id>`.
```

- [ ] **Step 4: Add Pi triage notes**

In `docs/superpowers/skills/triaging-a-failing-eval.md`, add a short Pi-specific
subsection under Pattern 6 or after the existing seven patterns:

```markdown
### Pi Capture Triage

Pi raw sessions are run-local at `<run>/coding-agent-config/sessions/*.jsonl`.
If a Pi run is indeterminate before post-checks, distinguish:

- no new `*.jsonl` file: Pi did not launch or wrote outside the isolated session dir;
- new `*.jsonl` with malformed first row, missing `type: "session"`, or missing
  `cwd`: Pi log shape/config changed;
- new `*.jsonl` whose first-row `cwd` differs from the launch cwd:
  `qa-agent-misconfigured`; the QA agent likely skipped the generated launcher;
- matching first-row `cwd` but empty `coding-agent-tool-calls.jsonl`: Pi ran but
  produced no normalized tool calls, or the normalizer no longer matches Pi's
  JSONL shape.
```

- [ ] **Step 5: Run docs-sensitive checks**

Run:

```bash
uv run quorum check
uv run pytest tests/quorum/test_coding_agent_config.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/superpowers/skills/triaging-a-failing-eval.md
git commit -m "docs: document Pi quorum target"
```

---

## Task 7: Static Verification

**Why now:** The full non-live suite should pass before spending API money on Pi.

**Files:**
- No new files

- [ ] **Step 1: Run format/lint/type/scenario checks**

Run:

```bash
uv run ruff check
uv run ty check
uv run quorum check
```

Expected: all PASS.

- [ ] **Step 2: Run focused tests**

Run:

```bash
uv run pytest \
  tests/quorum/test_coding_agent_config.py \
  tests/quorum/test_normalizers.py \
  tests/quorum/test_capture.py \
  tests/quorum/test_trace_tools.py \
  tests/quorum/test_runner.py \
  -q
```

Expected: PASS.

- [ ] **Step 3: Run full pytest**

Run:

```bash
uv run pytest
```

Expected: PASS.

- [ ] **Step 4: Commit any verification-only fixes**

If the verification commands required small fixes, stage only the actual fixed
files shown by `git status`, then commit them with
`git commit -m "quorum: finish Pi target verification"`.

If no fixes were needed, skip this commit.

---

## Task 8: Live Pi Bootstrap Acceptance

**Why last:** This spends model/API time and should only run after static coverage is clean.

**Files:**
- No source edits expected

- [ ] **Step 1: Run a one-shot Pi auth-only smoke in a temp directory**

This smoke intentionally disables extensions, skills, and context files. Its
only job is to prove run-local `PI_CODING_AGENT_DIR`, `auth.json`,
`settings.json`, and sourced `pi.env` work before spending time on the full
Quorum scenario.

Run:

```bash
tmp=$(mktemp -d /tmp/quorum-pi-auth.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/agent" "$tmp/sessions"
if [ "$PI_PROVIDER" = "azure-openai-responses" ] && \
   [ -z "${AZURE_OPENAI_BASE_URL:-}" ] && \
   [ -z "${AZURE_OPENAI_RESOURCE_NAME:-}" ]; then
  echo "azure-openai-responses requires AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE_NAME" >&2
  exit 1
fi
jq -n --arg provider "$PI_PROVIDER" \
  '{($provider): {"type": "api_key", "key": "$PI_API_KEY"}}' \
  > "$tmp/agent/auth.json"
chmod 600 "$tmp/agent/auth.json"
jq -n --arg provider "$PI_PROVIDER" --arg model "$PI_MODEL" \
  '{"defaultProvider": $provider, "defaultModel": $model, "defaultThinkingLevel": "medium"}' \
  > "$tmp/agent/settings.json"
{
  printf 'export PI_PROVIDER=%q\n' "$PI_PROVIDER"
  printf 'export PI_MODEL=%q\n' "$PI_MODEL"
  printf 'export PI_API_KEY=%q\n' "$PI_API_KEY"
  [ -n "${AZURE_OPENAI_BASE_URL:-}" ] && printf 'export AZURE_OPENAI_BASE_URL=%q\n' "$AZURE_OPENAI_BASE_URL"
  [ -n "${AZURE_OPENAI_RESOURCE_NAME:-}" ] && printf 'export AZURE_OPENAI_RESOURCE_NAME=%q\n' "$AZURE_OPENAI_RESOURCE_NAME"
  [ -n "${AZURE_OPENAI_API_VERSION:-}" ] && printf 'export AZURE_OPENAI_API_VERSION=%q\n' "$AZURE_OPENAI_API_VERSION"
  [ -n "${AZURE_OPENAI_DEPLOYMENT_NAME_MAP:-}" ] && printf 'export AZURE_OPENAI_DEPLOYMENT_NAME_MAP=%q\n' "$AZURE_OPENAI_DEPLOYMENT_NAME_MAP"
} > "$tmp/agent/pi.env"
chmod 600 "$tmp/agent/pi.env"
set -a
. "$tmp/agent/pi.env"
set +a
PI_CODING_AGENT_DIR="$tmp/agent" \
PI_OFFLINE=1 \
PI_TELEMETRY=0 \
pi \
  --session-dir "$tmp/sessions" \
  --provider "$PI_PROVIDER" \
  --model "$PI_MODEL" \
  --no-extensions \
  --no-skills \
  --no-context-files \
  --tools read \
  --print "Reply with exactly OK."
find "$tmp/sessions" -maxdepth 1 -name '*.jsonl' -print
```

Expected: stdout contains `OK` and a JSONL session file exists. If this fails, debug auth/provider/model before running Quorum.

- [ ] **Step 2: Run the Pi bootstrap scenario**

Run:

```bash
SUPERPOWERS_ROOT=/Users/drewritter/prime-rad/superpowers \
PI_PROVIDER="$PI_PROVIDER" \
PI_MODEL="$PI_MODEL" \
PI_API_KEY="$PI_API_KEY" \
AZURE_OPENAI_BASE_URL="${AZURE_OPENAI_BASE_URL:-}" \
AZURE_OPENAI_RESOURCE_NAME="${AZURE_OPENAI_RESOURCE_NAME:-}" \
uv run quorum run scenarios/pi-superpowers-bootstrap --coding-agent pi
```

Expected: exit 0 and final verdict `pass`.

- [ ] **Step 3: Inspect the run**

Run:

```bash
uv run quorum show <run>
find <run>/coding-agent-config/sessions -maxdepth 1 -name '*.jsonl' -print
jq -r '.tool + " " + (.args | tostring)' <run>/coding-agent-tool-calls.jsonl
```

Expected:
- raw Pi session exists;
- first JSONL row has `type: "session"` and the expected cwd;
- normalized trace contains `Read` for
  `$SUPERPOWERS_ROOT/skills/brainstorming/SKILL.md`;
- normalized trace contains `Write` for `PI_SUPERPOWERS_OK.md`;
- `coding-agent-token-usage.json` is absent.

Observed during implementation on 2026-06-03:
- auth-only smoke passed with `PI_PROVIDER=openai`, `PI_MODEL=gpt-5.5`, and
  `PI_API_KEY` sourced from the repo-local `OPENAI_API_KEY`;
- the first live Quorum run proved the file, skill path, write, and ordering
  behavior but failed because the plan over-asserted the internal extension
  marker in raw JSONL;
- Pi injects that marker into runtime context but does not persist it as an
  ordinary session row, so the scenario was corrected to use observable local
  skill reads as bootstrap evidence;
- the corrected live run passed at
  `results/pi-superpowers-bootstrap-pi-20260603T205822Z-ebd6`.

- [ ] **Step 4: Commit live-run doc fixes only if needed**

Do not commit run artifacts. If live acceptance reveals a docs-only correction, commit it:

```bash
git add README.md docs/superpowers/specs/2026-06-03-pi-quorum-coding-agent-design.md docs/superpowers/plans/2026-06-03-pi-quorum-coding-agent.md
git commit -m "docs: clarify Pi live eval setup"
```

---

## Self-Review

**Spec coverage:** The plan covers Pi YAML/context/launcher (Task 1), run-local API-key auth and isolation (Task 2), explicit Superpowers extension loading from `SUPERPOWERS_ROOT` (Tasks 1 and 2), session capture and wrong-cwd diagnostics (Task 3), existing normalizer drift coverage (Task 4), skill predicate parity through canonical `Read` rows (Task 4), bootstrap behavioral evidence (Task 5), README operator docs (Task 6), static verification (Task 7), and live acceptance (Task 8).

**Placeholder scan:** Clean. Each code-changing task includes the target files, code shape, command, and expected result.

**Type consistency:** The plan consistently uses `PI_CODING_AGENT_DIR`, `PI_PROVIDER`, `PI_MODEL`, `PI_API_KEY`, `PI_ENV_FILE`, `normalizer: pi`, and `sessions/*.jsonl`. Pi auth is always represented as an `api_key` credential with `"key": "$PI_API_KEY"` and the live secret in chmod-0600 `pi.env`.
