"""Per-run orchestration. One scenario, one target, one verdict.

Important context for understanding the cwd dance:

- Gauntlet's TUI adapter spawns `tmux new-session -c <run-dir>/scratch bash`.
  The QA agent's bash starts in <run-dir>/scratch, NOT quorum's workdir.
- quorum's workdir (where setup.sh ran and `git init` happened) is at a
  separate /tmp path the QA agent can't infer.
- Bridge: the runner exports QUORUM_AGENT_CWD into the gauntlet subprocess
  env. tmux inherits → bash inherits. Per-target HOWTOs tell the QA agent
  to `cd $QUORUM_AGENT_CWD` before invoking the target binary.
- Default QUORUM_AGENT_CWD = workdir. Setup.sh can override by writing the
  absolute desired launch path into <workdir>/.quorum-launch-cwd. The
  worktree-already-inside scenario uses this to point at the sibling
  existing-worktree.

Also: setup.sh helpers (in setup_helpers/) need to know where quorum
checkout lives so they can find fixtures/template-repo. Runner exports
QUORUM_REPO_ROOT for that purpose.

Single-run-at-a-time only in Phase 1. Multiple quorum processes against the
same target's session-log dir cross-contaminate via snapshot/diff. Enforced
with a sentinel lockfile that refuses (rather than silently falling back).

checks.sh is required for every scenario. If a scenario is missing checks.sh,
the runner writes an indeterminate verdict immediately.
"""

from __future__ import annotations

import contextlib
import dataclasses
import datetime as _dt
import json
import os
import re
import secrets
import shlex
import shutil
import stat
import subprocess
import tempfile
import uuid
from collections.abc import Callable, Mapping
from pathlib import Path
from urllib.parse import urlsplit

from quorum import agy_creds
from quorum.agy_teardown import kill_run_tmux_server
from quorum.capture import (
    capture_token_usage,
    capture_tool_calls,
    detect_misplaced_codex_rollouts,
    detect_misplaced_pi_sessions,
    detect_unusable_pi_sessions,
    diagnose_kimi_unmatched_logs,
    snapshot_dir,
)
from quorum.checks import parse_coding_agents_directive, run_phase
from quorum.coding_agent_config import (
    CodingAgentConfig,
    CodingAgentConfigError,
    load_coding_agent_config,
)
from quorum.composer import (
    FinalVerdict,
    GauntletLayer,
    GauntletStatus,
    RunError,
    RunErrorStage,
    compose,
)
from quorum.economics import build_run_economics
from quorum.kimi import (
    KimiConfigError,
    build_kimi_subprocess_env,
    effective_kimi_model_env,
    install_kimi_superpowers_plugin,
    kimi_logs_have_superpowers_session_start,
    resolve_kimi_binary,
    run_kimi_auth_preflight,
    sanitize_kimi_diagnostic,
    validate_kimi_preflight_sentinel,
    write_effective_kimi_config,
    write_kimi_runtime_env_file,
)
from quorum.opencode_capture import (
    OpenCodeCaptureError,
    export_opencode_sessions,
    opencode_run_env,
    snapshot_opencode_sessions,
)
from quorum.setup_step import SetupError, run_setup
from quorum.story_meta import StoryMetaError, read_quorum_max_time
from setup_helpers.worktree import install_codex_superpowers_plugin_hooks

LAUNCH_CWD_SENTINEL = ".quorum-launch-cwd"
CODING_AGENT_CONFIG_SUBDIR = "coding-agent-config"
ANTIGRAVITY_VISIBLE_WORKSPACE_ROOT_ENV = "QUORUM_ANTIGRAVITY_VISIBLE_WORKSPACE_ROOT"
ANTIGRAVITY_VISIBLE_LAUNCH_RECORD = "antigravity-visible-launch-cwd.json"
GEMINI_ENV_FILE_NAME = ".gemini-env"
COPILOT_ENV_FILE_NAME = ".copilot-env"
GEMINI_REQUIRED_SUPERPOWERS_FILES = (
    "gemini-extension.json",
    "GEMINI.md",
    "skills/using-superpowers/SKILL.md",
    "skills/using-superpowers/references/gemini-tools.md",
)
COPILOT_REQUIRED_SUPERPOWERS_FILES = (
    ".claude-plugin/plugin.json",
    "hooks/hooks.json",
    "hooks/run-hook.cmd",
    "hooks/session-start",
    "skills/using-superpowers/SKILL.md",
    "skills/brainstorming/SKILL.md",
    "skills/using-superpowers/references/copilot-tools.md",
)
COPILOT_PROVIDER_ENV_NAMES = (
    "COPILOT_PROVIDER_BASE_URL",
    "COPILOT_PROVIDER_TYPE",
    "COPILOT_PROVIDER_API_KEY",
    "COPILOT_PROVIDER_BEARER_TOKEN",
    "COPILOT_PROVIDER_WIRE_API",
    "COPILOT_PROVIDER_AZURE_API_VERSION",
    "COPILOT_PROVIDER_MODEL_ID",
    "COPILOT_PROVIDER_WIRE_MODEL",
    "COPILOT_PROVIDER_MAX_PROMPT_TOKENS",
    "COPILOT_PROVIDER_MAX_OUTPUT_TOKENS",
    "COPILOT_OFFLINE",
    "COPILOT_MODEL",
)
COPILOT_SECRET_ENV_NAMES = (
    "COPILOT_GITHUB_TOKEN",
    "COPILOT_PROVIDER_API_KEY",
    "COPILOT_PROVIDER_BEARER_TOKEN",
)
COPILOT_PROXY_ENV_NAMES = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
)
COPILOT_GAUNTLET_ENV_ALLOWLIST = (
    "PATH",
    "TERM",
    "LANG",
    "GH_HOST",
    "COPILOT_GH_HOST",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_LOG",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORG_ID",
    "OPENAI_PROJECT",
    "COPILOT_MODEL",
    "COPILOT_OFFLINE",
)
OPENCODE_EXPORT_SUBDIR = Path(".quorum/session-exports")


@dataclasses.dataclass(frozen=True)
class CopilotProvisioning:
    session_id: str
    env_file: Path
    secret_names: tuple[str, ...]
    secret_values: tuple[str, ...]


class RunnerError(RuntimeError):
    """Raised on non-recoverable errors before verdict composition."""

    def __init__(self, message: str, *, stage: RunErrorStage = "unknown"):
        super().__init__(message)
        self.stage = stage


@dataclasses.dataclass(frozen=True)
class AgentRuntime:
    env_file: Path | None = None
    substitutions: dict[str, str] = dataclasses.field(default_factory=dict)
    cleanup_dirs: tuple[Path, ...] = ()


@dataclasses.dataclass(frozen=True)
class GauntletResult:
    """Outcome of an `invoke_gauntlet` call.

    `rate_limited` is True only when the agy rate-limit watcher tripped during
    the run and tore gauntlet down (antigravity only). The caller uses it to
    short-circuit to a rate-limit verdict before the capture cascade (Task 6).
    """

    status: GauntletStatus
    rate_limited: bool = False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _quorum_bin_dir() -> Path:
    """Return the repo's bin/ directory (where check tools live)."""
    return Path(__file__).resolve().parent.parent / "bin"


def _allocate_run_dir(*, out_root: Path, scenario_name: str, coding_agent: str) -> Path:
    """Create and return <out_root>/<scenario>-<coding-agent>-<utc>-<nonce>/.

    UTC matches gauntlet.run_id so the two timestamps in a run-dir don't read
    ~7h apart. The 4-hex nonce sidesteps second-precision collisions when
    sweep-N support eventually runs the same (scenario, coding-agent) pair
    concurrently.
    """
    timestamp = _dt.datetime.now(_dt.UTC).strftime("%Y%m%dT%H%M%SZ")
    nonce = secrets.token_hex(2)
    run_dir = out_root / f"{scenario_name}-{coding_agent}-{timestamp}-{nonce}"
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
    """Build an indeterminate verdict, persist it to verdict.json, and return it."""
    v = FinalVerdict(
        final="indeterminate",
        final_reason=final_reason,
        gauntlet=gauntlet,
        checks=checks or [],
        error=error,
    )
    (run_dir / "verdict.json").write_text(json.dumps(v.to_dict(), indent=2))
    return v


def _cleanup_agent_runtime(runtime: AgentRuntime) -> None:
    for path in runtime.cleanup_dirs:
        try:
            shutil.rmtree(path)
        except FileNotFoundError:
            pass
        except OSError as e:
            raise RunnerError(
                f"agent runtime cleanup failed for {path}: {str(e)[:200]}",
                stage="setup",
            ) from e
    leftovers = []
    if runtime.env_file is not None and runtime.env_file.exists():
        leftovers.append(runtime.env_file)
    leftovers.extend(path for path in runtime.cleanup_dirs if path.exists())
    if leftovers:
        paths = ", ".join(str(path) for path in leftovers)
        raise RunnerError(f"agent runtime cleanup failed; path remains: {paths}", stage="setup")


# ---------------------------------------------------------------------------


def _seed_codex_auth(codex_home: Path) -> None:
    """Seed codex auth.json so the agent boots past the sign-in picker.

    Codex gates its TUI auth picker on auth.json, not on $OPENAI_API_KEY:
    `codex login status` reports "Not logged in" for an env-var-only
    setup. Piping the key through `codex login --with-api-key` writes a
    logged-in auth.json into CODEX_HOME. Seeded per-run from the env
    rather than from a checked-in fixture, so the API key is never
    persisted outside the environment and the gitignored run dir.
    """
    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key:
        raise RunnerError("OPENAI_API_KEY not set; cannot seed codex auth")
    result = subprocess.run(
        ["codex", "login", "--with-api-key"],
        input=api_key,
        text=True,
        capture_output=True,
        env={**os.environ, "CODEX_HOME": str(codex_home)},
    )
    if result.returncode != 0:
        raise RunnerError(
            f"codex login --with-api-key failed (exit {result.returncode}): {result.stderr.strip()}"
        )


def _seed_codex_plugin_hooks(codex_home: Path, workdir: Path) -> None:
    """Stage Superpowers as a trusted Codex plugin hook in the per-run home.

    The codex home already exists and is logged in (see _seed_codex_auth).
    This copies Superpowers in as a plugin and trusts its SessionStart hook
    so the agent boots with Superpowers available — the codex equivalent of
    the Superpowers access every claude run gets. The install ceremony is
    the shared setup_helpers function, pointed at the per-run CODEX_HOME.
    """
    superpowers_root = os.environ.get("SUPERPOWERS_ROOT", "")
    if not superpowers_root:
        raise RunnerError("SUPERPOWERS_ROOT not set; cannot install codex plugin hooks")
    install_codex_superpowers_plugin_hooks(workdir, superpowers_root, codex_home=codex_home)


def _gemini_transcripts(config_dir: Path) -> list[Path]:
    tmp_dir = config_dir / ".gemini" / "tmp"
    if not tmp_dir.exists():
        return []
    return sorted(tmp_dir.glob("**/chats/**/*.json*"))


def _write_gemini_settings(gemini_home: Path) -> None:
    settings_path = gemini_home / ".gemini" / "settings.json"
    settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
    security = settings.setdefault("security", {})
    auth = security.setdefault("auth", {})
    auth["selectedType"] = "gemini-api-key"
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings_path.write_text(json.dumps(settings, indent=2))


def _shell_single_quote(value: str) -> str:
    return "'" + value.replace("'", "'\"'\"'") + "'"


def _gemini_stderr_excerpt(stderr: str) -> str:
    api_key = os.environ.get("GEMINI_API_KEY", "")
    excerpt = stderr.strip()
    if api_key:
        excerpt = excerpt.replace(api_key, "[redacted]")
    return excerpt[:300]


def _gemini_extension_list_shows_superpowers(stdout: str) -> bool:
    return any(
        re.match(r"^\s*superpowers(?:\s|\(|$)", line, flags=re.IGNORECASE)
        for line in stdout.splitlines()
    )


def _write_gemini_env_file(gemini_home: Path) -> Path:
    api_key = os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        raise RunnerError("GEMINI_API_KEY not set; cannot seed Gemini auth", stage="setup")
    env_file = gemini_home / GEMINI_ENV_FILE_NAME
    env_file.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(env_file, flags, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write("GEMINI_API_KEY=" + _shell_single_quote(api_key) + "\n")
        f.flush()
        os.fchmod(f.fileno(), 0o600)
    return env_file


def _copilot_offline_requested(env: Mapping[str, str]) -> bool:
    return env.get("COPILOT_OFFLINE", "").strip().lower() in {"1", "true", "yes"}


def _gh_auth_token() -> str | None:
    if shutil.which("gh") is None:
        return None
    try:
        result = subprocess.run(
            ["gh", "auth", "token"],
            text=True,
            capture_output=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    token = result.stdout.strip()
    return token or None


def _resolve_copilot_auth_env(
    env: Mapping[str, str] | None = None,
) -> tuple[dict[str, str], tuple[str, ...], tuple[str, ...]]:
    host_env = os.environ if env is None else env
    if _copilot_offline_requested(host_env) and not host_env.get("COPILOT_PROVIDER_BASE_URL"):
        raise RunnerError(
            "COPILOT_OFFLINE=true requires COPILOT_PROVIDER_BASE_URL",
            stage="setup",
        )

    if host_env.get("COPILOT_PROVIDER_BASE_URL"):
        provider_values = {
            name: host_env[name]
            for name in COPILOT_PROVIDER_ENV_NAMES
            if host_env.get(name)
        }
        secret_names = tuple(
            name
            for name in ("COPILOT_PROVIDER_API_KEY", "COPILOT_PROVIDER_BEARER_TOKEN")
            if provider_values.get(name)
        )
        secret_values = tuple(provider_values[name] for name in secret_names)
        return provider_values, secret_names, secret_values

    token_value = ""
    for name in ("COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"):
        value = host_env.get(name, "")
        if value:
            token_value = value
            break
    if not token_value:
        token_value = _gh_auth_token() or ""
    if not token_value:
        raise RunnerError(
            "no Copilot auth found; set COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN, "
            "or COPILOT_PROVIDER_BASE_URL",
            stage="setup",
        )
    return {"COPILOT_GITHUB_TOKEN": token_value}, ("COPILOT_GITHUB_TOKEN",), (token_value,)


def _write_copilot_env_file(copilot_home: Path, values: Mapping[str, str]) -> Path:
    env_file = copilot_home / COPILOT_ENV_FILE_NAME
    env_file.parent.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(env_file, flags, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as f:
        for key in sorted(values):
            f.write(f"{key}={_shell_single_quote(values[key])}\n")
        f.flush()
        os.fchmod(f.fileno(), 0o600)
    return env_file


def _require_gemini_superpowers_root(superpowers_root: str) -> Path:
    if not superpowers_root:
        raise RunnerError(
            "SUPERPOWERS_ROOT not set; cannot install Gemini Superpowers extension",
            stage="setup",
        )
    root = Path(superpowers_root).expanduser()
    missing = [rel for rel in GEMINI_REQUIRED_SUPERPOWERS_FILES if not (root / rel).exists()]
    if missing:
        raise RunnerError(
            "SUPERPOWERS_ROOT is missing required Gemini Superpowers files: "
            + ", ".join(missing),
            stage="setup",
        )
    return root


def _seed_gemini_config(gemini_home: Path, workdir: Path) -> None:
    """Install Superpowers into an isolated Gemini CLI home without invoking the model."""
    del workdir
    superpowers_root = _require_gemini_superpowers_root(os.environ.get("SUPERPOWERS_ROOT", ""))
    if shutil.which("gemini") is None:
        raise RunnerError(
            "gemini not found on PATH; cannot run Gemini evals",
            stage="setup",
        )

    gemini_home.mkdir(parents=True, exist_ok=True)
    _write_gemini_settings(gemini_home)
    _write_gemini_env_file(gemini_home)

    env = {
        **os.environ,
        "GEMINI_CLI_HOME": str(gemini_home),
        "GEMINI_CLI_TRUST_WORKSPACE": "true",
        "GEMINI_DEFAULT_AUTH_TYPE": "gemini-api-key",
    }
    link_cmd = ["gemini", "extensions", "link", str(superpowers_root), "--consent"]
    link = subprocess.run(
        link_cmd,
        cwd=gemini_home,
        text=True,
        capture_output=True,
        env=env,
    )
    if link.returncode != 0:
        raise RunnerError(
            "gemini extensions link failed "
            f"(exit {link.returncode}); stderr: {_gemini_stderr_excerpt(link.stderr)}",
            stage="setup",
        )

    list_cmd = ["gemini", "extensions", "list"]
    listing = subprocess.run(
        list_cmd,
        cwd=gemini_home,
        text=True,
        capture_output=True,
        env=env,
    )
    if listing.returncode != 0:
        raise RunnerError(
            "gemini extensions list failed "
            f"(exit {listing.returncode}); stderr: {_gemini_stderr_excerpt(listing.stderr)}",
            stage="setup",
        )
    if not _gemini_extension_list_shows_superpowers(listing.stdout):
        raise RunnerError(
            "gemini extensions list did not show Superpowers extension",
            stage="setup",
        )

    metadata = [
        gemini_home / ".gemini" / "extensions" / "superpowers" / ".gemini-extension-install.json",
        gemini_home / ".gemini" / "extensions" / "extension-enablement.json",
        gemini_home / ".gemini" / "extension_integrity.json",
    ]
    missing_metadata = [str(p.relative_to(gemini_home)) for p in metadata if not p.exists()]
    if missing_metadata:
        raise RunnerError(
            "gemini extension link completed but expected metadata files are missing: "
            + ", ".join(missing_metadata),
            stage="setup",
        )

    transcripts = _gemini_transcripts(gemini_home)
    if transcripts:
        rel = [str(p.relative_to(gemini_home)) for p in transcripts]
        raise RunnerError(
            "gemini provisioning unexpectedly wrote transcripts before "
            "capture snapshot: " + ", ".join(rel),
            stage="setup",
    )


def _seed_kimi_config(kimi_home: Path, *, run_dir: Path, binary: str) -> AgentRuntime:
    """Seed an isolated Kimi home with env-overlay auth and local Superpowers plugin."""
    superpowers_root = os.environ.get("SUPERPOWERS_ROOT", "")
    if not superpowers_root:
        raise RunnerError(
            "SUPERPOWERS_ROOT not set; cannot install Kimi Superpowers plugin",
            stage="setup",
        )
    preflight_sentinel = os.environ.get("QUORUM_KIMI_PREFLIGHT_SENTINEL")
    preflight_token = os.environ.get("QUORUM_KIMI_PREFLIGHT_TOKEN")

    try:
        kimi_binary = resolve_kimi_binary(binary)
        kimi_env = effective_kimi_model_env(os.environ)
        if preflight_sentinel:
            validate_kimi_preflight_sentinel(
                Path(preflight_sentinel),
                kimi_binary=kimi_binary,
                kimi_model_env=kimi_env,
                preflight_token=preflight_token,
            )
        else:
            run_kimi_auth_preflight(
                kimi_binary=kimi_binary,
                kimi_model_env=kimi_env,
                base_env=os.environ,
        )
        install_kimi_superpowers_plugin(kimi_home, superpowers_root)
    except KimiConfigError as e:
        raise RunnerError(sanitize_kimi_diagnostic(e), stage="setup") from e

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
    runtime = AgentRuntime(
        env_file=env_file,
        substitutions={
            "$KIMI_ENV_FILE": str(env_file),
            "$KIMI_BINARY": shlex.quote(kimi_binary),
        },
        cleanup_dirs=(env_file.parent,),
    )
    try:
        write_effective_kimi_config(
            kimi_home,
            runtime_env,
            kimi_binary=kimi_binary,
            kimi_version=None,
        )
        return runtime
    except Exception:
        _cleanup_agent_runtime(runtime)
        raise


def _antigravity_transcripts(config_dir: Path) -> list[Path]:
    brain = config_dir / ".gemini" / "antigravity-cli" / "brain"
    if not brain.exists():
        return []
    return sorted(brain.glob("**/transcript.jsonl"))


def _preflight_response_ok(stdout: str) -> bool:
    """Accept the auth-preflight reply tolerantly.

    The preflight asks agy to "Reply with EXACTLY OK." A compliant model
    occasionally appends punctuation ("OK.") or differs in case; a strict
    equality check rejected those and produced false setup failures. Normalize
    trailing punctuation, whitespace, and case — but still reject empty
    (rate-limited / dead) or verbose replies.
    """
    return stdout.strip().rstrip(".!").strip().upper() == "OK"


ANTIGRAVITY_RATE_LIMIT_MARKER = "Code Assist rate limit"

# Substrings agy writes to its log/stderr when the Gemini Code Assist backend
# throttles. RESOURCE_EXHAUSTED is the definitive 429 signal; the others
# corroborate. Matched case-insensitively.
# Substrings that unambiguously signal a Code Assist rate limit.
_AGY_RATE_LIMIT_SUBSTRINGS = ("resource_exhausted", "ratelimitexceeded")
# A bare "429" matches hex trace IDs (e.g. 0x...e4291...), ports, and byte counts
# that pepper agy's streaming log, false-tripping the mid-run watcher into killing
# a healthy run. Require a word-boundaried HTTP-status 429 instead.
_AGY_429_RE = re.compile(r"\b429\b")


def _agy_log_shows_rate_limit(*texts: str) -> bool:
    blob = "\n".join(t for t in texts if t).lower()
    return any(sig in blob for sig in _AGY_RATE_LIMIT_SUBSTRINGS) or bool(
        _AGY_429_RE.search(blob)
    )


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
        # A failed preflight — non-zero exit OR an empty/garbled reply — is
        # most often the Gemini Code Assist quota/rate window being exhausted,
        # which agy surfaces as an empty reply plus 429 / RESOURCE_EXHAUSTED in
        # its log. Diagnose that distinctly so triage doesn't chase a phantom
        # auth bug, and so run-all can stop hammering the throttled window.
        if result.returncode != 0 or not _preflight_response_ok(result.stdout):
            log_text = ""
            with contextlib.suppress(OSError):
                log_text = log_path.read_text(errors="replace")
            if _agy_log_shows_rate_limit(log_text, result.stderr):
                raise RunnerError(
                    f"{ANTIGRAVITY_RATE_LIMIT_MARKER}: agy returned no usable "
                    "response and its log shows Code Assist 429 / "
                    "RESOURCE_EXHAUSTED. The Gemini Code Assist rate/quota "
                    "window is exhausted; wait for it to refresh before "
                    "re-running antigravity.",
                    stage="setup",
                )
            if result.returncode != 0:
                raise RunnerError(
                    "antigravity auth preflight failed "
                    f"(exit {result.returncode}); check agy browser/keyring auth. "
                    f"stderr: {result.stderr.strip()[:300]}",
                    stage="setup",
                )
            raise RunnerError(
                "antigravity auth preflight did not return OK; "
                f"stdout: {result.stdout.strip()[:300]}",
                stage="setup",
            )
        transcripts = sorted((gemini_dir / "antigravity-cli" / "brain").glob("**/transcript.jsonl"))
        if not transcripts:
            raise RunnerError(
                "antigravity auth preflight produced no transcript under isolated --gemini_dir",
                stage="setup",
            )


def _write_antigravity_settings(
    antigravity_config_dir: Path,
    workdir: Path,
) -> None:
    """Persist no-prompt settings for the isolated Antigravity run."""
    settings_path = antigravity_config_dir / ".gemini" / "antigravity-cli" / "settings.json"
    settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}

    trusted = settings.setdefault("trustedWorkspaces", [])
    for trusted_workspace in (str(workdir), str(workdir.resolve())):
        if trusted_workspace not in trusted:
            trusted.append(trusted_workspace)

    settings["toolPermission"] = "always-proceed"
    settings["artifactReviewPolicy"] = "always-proceed"
    settings["permissions"] = {
        "allow": [
            "command(*)",
            "unsandboxed(*)",
            "read_file(*)",
            "write_file(*)",
            "read_url(*)",
            "execute_url(*)",
            "mcp(*)",
        ],
        "ask": [],
        "deny": [],
    }
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings_path.write_text(json.dumps(settings, indent=2))


def _seed_antigravity_config(antigravity_config_dir: Path, workdir: Path) -> None:
    """Install Superpowers into an isolated Antigravity .gemini tree."""
    superpowers_root = os.environ.get("SUPERPOWERS_ROOT", "")
    if not superpowers_root:
        raise RunnerError(
            "SUPERPOWERS_ROOT not set; cannot install antigravity Superpowers plugin",
            stage="setup",
        )
    if shutil.which("agy") is None:
        raise RunnerError(
            "agy not found on PATH; cannot run antigravity evals",
            stage="setup",
        )

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
            "agy plugin install completed but expected Superpowers plugin files "
            "are missing: " + ", ".join(missing),
            stage="setup",
        )

    _write_antigravity_settings(antigravity_config_dir, workdir)

    transcripts = _antigravity_transcripts(antigravity_config_dir)
    if transcripts:
        rel = [str(p.relative_to(antigravity_config_dir)) for p in transcripts]
        raise RunnerError(
            "antigravity provisioning unexpectedly wrote transcripts before "
            "capture snapshot: " + ", ".join(rel),
            stage="setup",
        )


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
    if root.is_symlink():
        raise RunnerError(f"{label} contains unsupported symlink: {root}", stage="setup")
    for path in root.rglob("*"):
        if path.is_symlink():
            raise RunnerError(f"{label} contains unsupported symlink: {path}", stage="setup")


def _require_under_home(path: Path, opencode_home: Path) -> None:
    if not path.resolve().is_relative_to(opencode_home.resolve()):
        raise RunnerError(
            f"staged OpenCode Superpowers path escapes isolated home: {path}",
            stage="setup",
        )


def _require_copilot_superpowers_root(superpowers_root: str) -> Path:
    if not superpowers_root:
        raise RunnerError(
            "SUPERPOWERS_ROOT not set; cannot install Copilot Superpowers plugin",
            stage="setup",
        )
    root = Path(superpowers_root).expanduser()
    _reject_copilot_staging_source_symlinks(root)
    missing = [rel for rel in COPILOT_REQUIRED_SUPERPOWERS_FILES if not (root / rel).is_file()]
    if missing:
        raise RunnerError(
            "SUPERPOWERS_ROOT is missing required Copilot Superpowers files: "
            + ", ".join(missing),
            stage="setup",
        )
    return root


def _require_copilot_path_under_home(path: Path, copilot_home: Path) -> None:
    if not path.resolve().is_relative_to(copilot_home.resolve()):
        raise RunnerError(
            f"staged Copilot Superpowers path escapes isolated home: {path}",
            stage="setup",
        )


def _reject_copilot_staging_source_symlinks(sp_root: Path) -> None:
    _reject_symlinks(sp_root / "skills", label="SUPERPOWERS_ROOT skills")
    _reject_symlinks(sp_root / ".claude-plugin", label="SUPERPOWERS_ROOT .claude-plugin")
    for rel in ("hooks/hooks.json", "hooks/run-hook.cmd", "hooks/session-start"):
        path = sp_root / rel
        if path.is_symlink():
            raise RunnerError(
                f"SUPERPOWERS_ROOT Copilot hook contains unsupported symlink: {path}",
                stage="setup",
            )


def _stage_copilot_superpowers_plugin(sp_root: Path, copilot_home: Path) -> Path:
    _reject_copilot_staging_source_symlinks(sp_root)
    plugin_root = copilot_home / "plugins" / "superpowers"
    if plugin_root.exists() or plugin_root.is_symlink():
        if plugin_root.is_dir() and not plugin_root.is_symlink():
            shutil.rmtree(plugin_root)
        else:
            plugin_root.unlink()

    (plugin_root / "hooks").mkdir(parents=True)
    shutil.copytree(sp_root / ".claude-plugin", plugin_root / ".claude-plugin")
    shutil.copy2(sp_root / "hooks" / "hooks.json", plugin_root / "hooks" / "hooks.json")
    shutil.copy2(sp_root / "hooks" / "run-hook.cmd", plugin_root / "hooks" / "run-hook.cmd")
    shutil.copy2(sp_root / "hooks" / "session-start", plugin_root / "hooks" / "session-start")
    shutil.copytree(sp_root / "skills", plugin_root / "skills")

    missing = [
        rel for rel in COPILOT_REQUIRED_SUPERPOWERS_FILES if not (plugin_root / rel).is_file()
    ]
    if missing:
        raise RunnerError(
            "staged Copilot Superpowers plugin is missing required files: "
            + ", ".join(missing),
            stage="setup",
        )

    _require_copilot_path_under_home(plugin_root, copilot_home)
    for path in plugin_root.rglob("*"):
        _require_copilot_path_under_home(path, copilot_home)
    return plugin_root


def _seed_copilot_config(
    copilot_home: Path,
    workdir: Path,
    session_id: str,
) -> CopilotProvisioning:
    """Stage Superpowers and prepare isolated Copilot CLI state."""
    del workdir
    sp_root = _require_copilot_superpowers_root(os.environ.get("SUPERPOWERS_ROOT", ""))
    if shutil.which("copilot") is None:
        raise RunnerError("copilot not found on PATH; cannot run Copilot evals", stage="setup")

    env_values, secret_names, secret_values = _resolve_copilot_auth_env()
    env_file = _write_copilot_env_file(copilot_home, env_values)
    for path in (
        copilot_home / ".quorum",
        copilot_home / ".cache",
        copilot_home / "logs",
        copilot_home / "plugins",
        copilot_home / "session-state",
    ):
        path.mkdir(parents=True, exist_ok=True)

    expected_events = copilot_home / "session-state" / session_id / "events.jsonl"
    if expected_events.exists():
        raise RunnerError(
            f"pre-existing Copilot session-state before capture snapshot: {expected_events}",
            stage="setup",
        )

    _stage_copilot_superpowers_plugin(sp_root, copilot_home)
    return CopilotProvisioning(
        session_id=session_id,
        env_file=env_file,
        secret_names=secret_names,
        secret_values=secret_values,
    )


def _copilot_gauntlet_env(host_env: Mapping[str, str]) -> dict[str, str]:
    env: dict[str, str] = {}
    for name in COPILOT_GAUNTLET_ENV_ALLOWLIST:
        value = host_env.get(name)
        if value is None:
            continue
        if name in COPILOT_PROXY_ENV_NAMES and _proxy_url_has_userinfo(value):
            raise RunnerError(
                f"{name} contains credentialed proxy URL; remove proxy userinfo",
                stage="setup",
            )
        env[name] = value
    return env


def _proxy_url_has_userinfo(value: str) -> bool:
    candidate = value.strip()
    if not candidate:
        return False
    parse_value = candidate if "://" in candidate else f"//{candidate}"
    try:
        parsed = urlsplit(parse_value)
    except ValueError:
        after_scheme = candidate.split("://", 1)[-1]
        authority = after_scheme.split("/", 1)[0]
        return bool(authority.split("@", 1)[0]) and "@" in authority
    return bool(parsed.username or parsed.password)


def _scan_copilot_secret_leaks(
    run_dir: Path,
    *,
    secret_values: tuple[str, ...],
    excluded_paths: tuple[Path, ...],
) -> tuple[Path, ...]:
    secret_bytes = tuple(value.encode() for value in secret_values if value)
    if not secret_bytes:
        return ()

    excluded_resolved = {path.resolve() for path in excluded_paths}
    leaks: list[Path] = []
    for path in run_dir.rglob("*"):
        if path.is_symlink() or not path.is_file():
            continue
        try:
            if path.resolve() in excluded_resolved:
                continue
            content = path.read_bytes()
        except OSError:
            continue
        if any(secret in content for secret in secret_bytes):
            leaks.append(path)
    return tuple(leaks)


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
    if not os.environ.get("AZURE_OPENAI_BASE_URL") and not os.environ.get(
        "AZURE_OPENAI_RESOURCE_NAME"
    ):
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
    lines = [
        f"export PI_PROVIDER={shlex.quote(provider)}",
        f"export PI_MODEL={shlex.quote(model)}",
        f"export PI_API_KEY={shlex.quote(api_key)}",
        *[f"export {name}={shlex.quote(value)}" for name, value in sorted(extra_env.items())],
        "",
    ]
    env_path.write_text("\n".join(lines))
    env_path.chmod(0o600)
    return env_path


def _seed_pi_config(pi_config_dir: Path) -> None:
    superpowers_raw = _require_env("SUPERPOWERS_ROOT", "load Pi Superpowers extension")
    provider = _require_env("PI_PROVIDER", "configure Pi provider")
    model = _require_env("PI_MODEL", "configure Pi model")
    api_key = _require_env("PI_API_KEY", "configure Pi API-key auth")
    extra_env = _pi_provider_extra_env(provider)

    superpowers_root = Path(superpowers_raw).expanduser()
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


def _seed_agent_config_dir(
    coding_agent: CodingAgentConfig,
    skeleton_root: Path,
    dest: Path,
    workdir: Path,
    *,
    run_dir: Path,
) -> AgentRuntime:
    """Allocate a fresh per-run agent-config dir.

    If skeleton_root/skeleton-<coding-agent>-home/ exists, copy it; otherwise
    mkdir empty. For claude, then inject hasTrustDialogAccepted for the
    workdir's canonical path (claude keys per-project trust by
    process.cwd(), which is symlink-resolved on macOS) so the workspace-
    trust dialog stays off-screen. The claude skeleton itself carries
    onboarding / API-key dialog-bypass state (see
    bin/refresh-claude-home-skeleton).

    For codex, _seed_codex_auth runs `codex login --with-api-key` against
    the fresh dir so the agent boots past the "Welcome to Codex / Sign in"
    picker, then _seed_codex_plugin_hooks stages Superpowers as a trusted
    plugin hook — the codex equivalent of the Superpowers access every
    claude run gets.

    For kimi, _seed_kimi_config keeps auth/model env and plugins isolated while
    registering the local Superpowers checkout as the only enabled plugin.
    """
    runtime = AgentRuntime()
    skeleton = skeleton_root / f"{coding_agent.name}-home-skeleton"
    seeded = skeleton.exists()
    if seeded:
        shutil.copytree(skeleton, dest)
    else:
        dest.mkdir(parents=True)
    if coding_agent.name == "claude" and seeded:
        config_path = dest / ".claude.json"
        config = json.loads(config_path.read_text())
        config.setdefault("projects", {})[str(workdir.resolve())] = {
            "hasTrustDialogAccepted": True,
            "projectOnboardingSeenCount": 1,
            "hasClaudeMdExternalIncludesApproved": True,
            "hasClaudeMdExternalIncludesWarningShown": True,
        }
        config_path.write_text(json.dumps(config))
    if coding_agent.name == "codex":
        _seed_codex_auth(dest)
        _seed_codex_plugin_hooks(dest, workdir)
    if coding_agent.name == "kimi":
        runtime = _seed_kimi_config(dest, run_dir=run_dir, binary=coding_agent.binary)
    if coding_agent.name == "antigravity":
        _seed_antigravity_config(dest, workdir)
    if coding_agent.name == "gemini":
        _seed_gemini_config(dest, workdir)
    if coding_agent.name == "opencode":
        _seed_opencode_config(dest)
    if coding_agent.name == "pi":
        _seed_pi_config(dest)
    return runtime


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


def _resolve_launch_cwd(workdir: Path) -> Path:
    """Read <workdir>/.quorum-launch-cwd if setup.sh wrote one.

    Returns workdir if no sentinel exists. Raises if the sentinel points at
    a non-existent path.
    """
    sentinel = workdir / LAUNCH_CWD_SENTINEL
    if not sentinel.exists():
        return workdir
    resolved_path = Path(sentinel.read_text().strip())
    if not resolved_path.exists():
        raise RunnerError(
            f"setup.sh wrote {LAUNCH_CWD_SENTINEL}={resolved_path} but that path doesn't exist"
        )
    return resolved_path


def _path_has_hidden_component(path: Path) -> bool:
    return any(part.startswith(".") and part not in {".", ".."} for part in path.parts)


def _prepare_antigravity_launch_cwd(launch_cwd: Path, run_dir: Path) -> Path:
    """Return an Antigravity-safe launch cwd.

    Antigravity rejects `--add-dir` workspaces whose path contains hidden
    components. Quorum runs often live under `.codex/`, so expose the same
    directory through a visible temp symlink while leaving the real run evidence
    co-located under run_dir.
    """
    if not _path_has_hidden_component(launch_cwd):
        return launch_cwd

    configured_root = os.environ.get(ANTIGRAVITY_VISIBLE_WORKSPACE_ROOT_ENV)
    visible_root = (
        Path(configured_root)
        if configured_root
        else Path(tempfile.gettempdir()) / "quorum-antigravity-workspaces"
    )
    visible_root = visible_root.expanduser()
    if not visible_root.is_absolute():
        visible_root = visible_root.resolve()
    if _path_has_hidden_component(visible_root):
        raise RunnerError(
            f"{ANTIGRAVITY_VISIBLE_WORKSPACE_ROOT_ENV}={visible_root} contains a "
            "hidden path component; Antigravity would reject it as a workspace",
            stage="setup",
        )

    alias_parent = visible_root / run_dir.name
    alias_parent.mkdir(parents=True, exist_ok=True)
    alias = alias_parent / (launch_cwd.name or "workspace")
    if alias.exists() or alias.is_symlink():
        if alias.is_symlink() and alias.resolve() == launch_cwd.resolve():
            return alias
        raise RunnerError(
            f"cannot prepare Antigravity visible launch cwd; {alias} already exists",
            stage="setup",
        )

    alias.symlink_to(launch_cwd.resolve(), target_is_directory=True)
    (run_dir / ANTIGRAVITY_VISIBLE_LAUNCH_RECORD).write_text(
        json.dumps(
            {
                "launch_cwd": str(launch_cwd),
                "visible_launch_cwd": str(alias),
                "reason": "Antigravity rejects --add-dir paths with hidden components",
            },
            indent=2,
        )
    )
    return alias


def _gauntlet_status_from_run_dir(run_dir: Path) -> GauntletStatus:
    """Read gauntlet's verdict from <run-dir>/gauntlet-agent/results/<runId>/result.json.

    Phase 1 is one gauntlet invocation per run-dir, so there should be exactly
    one runId directory. If we find more (shouldn't happen), use the newest.
    """
    _valid: set[GauntletStatus] = {"pass", "fail", "investigate"}
    results_root = run_dir / "gauntlet-agent" / "results"
    if not results_root.exists():
        return "investigate"
    candidates = sorted(p for p in results_root.iterdir() if p.is_dir())
    for run_id_dir in reversed(candidates):
        result_path = run_id_dir / "result.json"
        if result_path.exists():
            try:
                raw = json.loads(result_path.read_text()).get("status", "investigate")
                return raw if raw in _valid else "investigate"
            except (OSError, json.JSONDecodeError):
                continue
    return "investigate"


def _build_gauntlet_layer_from_run_dir(run_dir: Path) -> GauntletLayer | None:
    """Build a GauntletLayer from the run dir.

    Reads result.json from <run-dir>/gauntlet-agent/results/<runId>/ and
    populates status, summary, reasoning, and run_id. Returns None if no
    result file can be found.
    """
    results_root = run_dir / "gauntlet-agent" / "results"
    if not results_root.exists():
        return None
    candidates = sorted(p for p in results_root.iterdir() if p.is_dir())
    for run_id_dir in reversed(candidates):
        result_path = run_id_dir / "result.json"
        if result_path.exists():
            try:
                data = json.loads(result_path.read_text())
                _valid: set[GauntletStatus] = {"pass", "fail", "investigate"}
                raw_status = data.get("status", "investigate")
                status: GauntletStatus = raw_status if raw_status in _valid else "investigate"
                return GauntletLayer(
                    status=status,
                    summary=data.get("summary", "") or "",
                    reasoning=data.get("reasoning", "") or "",
                    run_id=run_id_dir.name,
                )
            except (OSError, json.JSONDecodeError):
                continue
    return None


def _quorum_repo_root() -> Path:
    """Return the repo root (where bin/, scenarios/, coding-agents/ live).

    Resolved from this module's location: quorum/runner.py → ../.
    """
    return Path(__file__).resolve().parent.parent


def _kill_gauntlet_tmux_for_run(run_dir: Path) -> bool:
    """Kill the gauntlet tmux server driving agy for *run_dir*.

    Gauntlet runs agy inside a private tmux server whose pane cwd is
    `<run_dir>/gauntlet-agent/results/<runId>/scratch`. The `runId` is minted
    inside gauntlet (`orchestrator.makeRunId`), so quorum cannot pre-compute it
    — but quorum is single-run-per-run-dir, so there is exactly one such
    `results/<runId>/scratch` to discover by glob. We resolve that exact path
    and hand it to `kill_run_tmux_server`, which matches the server by strict
    pane-path equality (Task 3). The glob runs at teardown time, by which point
    gauntlet is well into the run and the scratch dir exists.
    """
    results_root = run_dir / "gauntlet-agent" / "results"
    scratch_dirs = sorted(results_root.glob("*/scratch"))
    if not scratch_dirs:
        return False
    return kill_run_tmux_server(scratch_dirs[-1])


def invoke_gauntlet(
    *,
    story_path: Path,
    target_binary: str,
    launch_cwd: Path,
    run_dir: Path,
    max_time: str | None,
    coding_agent: str,
    project_prompt: Path | None = None,
    extra_env: dict[str, str] | None = None,
    env_base: Mapping[str, str] | None = None,
    teardown: Callable[[Path], object] | None = None,
) -> GauntletResult:
    """Subprocess-invoke `gauntlet run`. Returns status + rate_limited flag.

    Sets QUORUM_AGENT_CWD in the env so the QA agent's bash (which starts
    in <run-dir>/scratch, NOT in our launch_cwd) can `cd` there before
    invoking the target. Per-target HOWTO files instruct the agent to do so.

    extra_env (per-target config-dir vars like CLAUDE_CONFIG_DIR) is also
    plumbed in. Note that today tmux strips arbitrary env from new sessions
    (see _populate_context_dir docstring), so the agent reads the value
    from the substituted HOWTO rather than from inheritance — but the env
    is set here too for belt-and-suspenders + future Gauntlet `-e` support.

    For antigravity, an AgyRateLimitWatcher tails the main-run agy.log while
    gauntlet drives the run. On a confirmed Code Assist rate-limit it kills
    gauntlet's private tmux server (teardown) so the cell fails fast instead of
    hanging to its budget, and the returned GauntletResult.rate_limited is True.
    Other coding-agents run with no watcher and rate_limited stays False.
    `teardown` is a test seam; production leaves it None to use the real kill.
    """
    cmd = [
        "gauntlet",
        "run",
        str(story_path),
        "--adapter",
        "tui",
        # Gauntlet's own --target flag; not quorum's vocabulary — keep.
        "--target",
        target_binary,
        "--project-dir",
        str(run_dir),
        "--state-dir",
        "gauntlet-agent",
        "--silent",
    ]
    if max_time:
        cmd += ["--max-time", max_time]
    if project_prompt:
        cmd += ["--project-prompt", str(project_prompt)]
    base_env = dict(env_base) if env_base is not None else dict(os.environ)
    env = {
        **base_env,
        "QUORUM_AGENT_CWD": str(launch_cwd),
        **(extra_env or {}),
    }

    # Import here, not at module scope: agy_watch imports from this module, so a
    # top-level import would be circular.
    from quorum.agy_watch import AgyRateLimitWatcher

    watcher: AgyRateLimitWatcher | None = None
    if coding_agent == "antigravity":
        agent_config_dir = run_dir / CODING_AGENT_CONFIG_SUBDIR
        agy_log = agent_config_dir / "agy.log"
        # Pre-touch for a stable inode: agy (not quorum) creates the log when
        # the QA agent runs the launcher, which races the watcher's first poll.
        agy_log.parent.mkdir(parents=True, exist_ok=True)
        agy_log.touch(exist_ok=True)
        watcher = AgyRateLimitWatcher(
            agy_log,
            run_dir,
            teardown=teardown or _kill_gauntlet_tmux_for_run,
        )
        watcher.start()

    # --silent prints runId on stderr; we don't disambiguate by runId in
    # Phase 1 (one invocation per run-dir = at most one runId subdirectory).
    try:
        proc = subprocess.Popen(cmd, env=env)
        proc.wait()
    finally:
        # Always stop the watcher thread, even if gauntlet errored, so it never
        # outlives the run.
        if watcher is not None:
            watcher.stop()

    rate_limited = watcher is not None and watcher.tripped
    return GauntletResult(
        status=_gauntlet_status_from_run_dir(run_dir),
        rate_limited=rate_limited,
    )


def _populate_context_dir(
    coding_agents_dir: Path,
    coding_agent: str,
    run_dir: Path,
    substitutions: dict[str, str] | None = None,
) -> None:
    """Copy per-coding-agent HOWTOs into <run-dir>/gauntlet-agent/context/.

    Per-agent context lives at `<coding_agents_dir>/<name>-context/` alongside
    the agent's YAML config and home-skeleton.

    `substitutions` maps placeholders (e.g. `$QUORUM_AGENT_CWD`) to literal
    values. Applied to every text file via plain string replace. This is the
    quorum workaround for tmux stripping arbitrary env vars from new
    sessions: rather than relying on the QA agent's bash inheriting our env,
    we burn the resolved values into the HOWTO at runtime so the agent reads
    a concrete path instead of an env-var reference.

    Phase 2 / upstream: Gauntlet should pass `-e VAR=value` to
    `tmux new-session` so user env vars actually reach the agent's shell.
    When that lands, this templating becomes unnecessary.
    """
    src = coding_agents_dir / f"{coding_agent}-context"
    dst = run_dir / "gauntlet-agent" / "context"
    dst.mkdir(parents=True, exist_ok=True)
    subs = substitutions or {}
    if not src.exists():
        return
    for entry in src.iterdir():
        if entry.is_file():
            _copy_with_substitutions(entry, dst / entry.name, subs)
        elif entry.is_dir():
            _copytree_with_substitutions(entry, dst / entry.name, subs)


def _copy_with_substitutions(src: Path, dst: Path, subs: dict[str, str]) -> None:
    try:
        content = src.read_text()
    except UnicodeDecodeError:
        # Non-text fixture file (image, binary). Copy as-is.
        shutil.copy2(src, dst)
        return
    for placeholder, value in sorted(subs.items(), key=lambda item: len(item[0]), reverse=True):
        content = content.replace(placeholder, value)
    dst.write_text(content)
    # A shebang'd template (e.g. the launch-agent shim) must stay executable
    # after substitution — write_text drops the mode. The QA agent invokes
    # the shim by absolute path, so it needs +x.
    if content.startswith("#!"):
        dst.chmod(dst.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _copytree_with_substitutions(src: Path, dst: Path, subs: dict[str, str]) -> None:
    dst.mkdir(parents=True, exist_ok=True)
    for entry in src.iterdir():
        if entry.is_file():
            _copy_with_substitutions(entry, dst / entry.name, subs)
        elif entry.is_dir():
            _copytree_with_substitutions(entry, dst / entry.name, subs)


def _run_scenario_inner(
    *,
    run_dir: Path,
    scenario_dir: Path,
    coding_agent: str,
    coding_agents_dir: Path,
    out_root: Path,
    skeleton_root: Path | None = None,
) -> tuple[Path, FinalVerdict]:
    """Inner implementation — run_dir is pre-allocated by the wrapper.

    checks.sh is required. If absent, returns an indeterminate verdict immediately.
    Runs checks.sh pre() before the agent, post() after capture.
    """
    # 1. Parse coding-agent config.
    coding_agent_path = coding_agents_dir / f"{coding_agent}.yaml"
    if not coding_agent_path.exists():
        raise RunnerError(f"unknown coding-agent {coding_agent!r}: no {coding_agent_path}")
    tcfg = load_coding_agent_config(coding_agent_path)

    story_path = scenario_dir / "story.md"
    if not story_path.exists():
        raise RunnerError(f"{scenario_dir}: story.md missing")

    # Per-scenario duration override (PRI-1869). Strict-override: a story's
    # quorum_max_time replaces the coding-agent default (up or down). Lets the
    # agent default stay low while slow SDD scenarios crank it up.
    try:
        story_max_time = read_quorum_max_time(story_path)
    except StoryMetaError as e:
        raise RunnerError(str(e)) from e
    effective_max_time = story_max_time if story_max_time is not None else tcfg.max_time

    # 2. checks.sh is required.
    checks_sh = scenario_dir / "checks.sh"
    if not checks_sh.exists():
        return run_dir, _write_indeterminate(
            run_dir,
            final_reason="scenario missing checks.sh",
            error=RunError(stage="setup", message="checks.sh not found"),
        )

    # Coding-Agent gating — read magic comment before any side effect.
    allowed = parse_coding_agents_directive(checks_sh)
    if allowed and coding_agent not in allowed:
        return run_dir, _write_indeterminate(
            run_dir,
            final_reason=f"requires coding-agents: {', '.join(allowed)}",
        )

    # 3. Create workdir (inside run_dir) + per-run coding-agent-config dir.
    #    Both live inside run_dir so they persist with the rest of the
    #    evidence; resolved session_log_dir points at its log subpath.
    workdir = run_dir / "coding-agent-workdir"
    workdir.mkdir()
    agent_config_dir = run_dir / CODING_AGENT_CONFIG_SUBDIR
    agent_runtime = AgentRuntime()
    copilot_provisioning: CopilotProvisioning | None = None
    if tcfg.name == "copilot":
        copilot_provisioning = _seed_copilot_config(
            agent_config_dir,
            workdir,
            str(uuid.uuid4()),
        )
    else:
        agent_runtime = _seed_agent_config_dir(
            tcfg,
            skeleton_root=skeleton_root or (_quorum_repo_root() / "coding-agents"),
            dest=agent_config_dir,
            workdir=workdir,
            run_dir=run_dir,
        )
    try:
        session_log_dir = tcfg.resolve_session_log_dir(agent_config_dir)
        env_extra = {"QUORUM_REPO_ROOT": str(_quorum_repo_root())}

        # 4. Run setup.sh (build the fixture).
        # SetupError propagates directly to the run_scenario wrapper, which maps it
        # to an indeterminate verdict with error.stage="setup".
        run_setup(scenario_dir, workdir, env_extra=env_extra)

        # 4b. Run checks.sh pre() — verifies the fixture is in the expected state.
        pre_records, pre_exit = run_phase(
            checks_sh=checks_sh,
            phase="pre",
            workdir=workdir,
            quorum_bin=_quorum_bin_dir(),
            tool_calls_path=run_dir / "coding-agent-tool-calls.jsonl",
            run_dir=run_dir,
        )
        if pre_exit != 0:
            return run_dir, _write_indeterminate(
                run_dir,
                final_reason=f"checks.sh pre() crashed (exit {pre_exit})",
                error=RunError(stage="checks", message=f"pre exit {pre_exit}"),
            )

        # 5. Resolve launch cwd (defaults to workdir; setup.sh may
        #    override via .quorum-launch-cwd sentinel).
        launch_cwd = _resolve_launch_cwd(workdir)
        if tcfg.name == "antigravity":
            _exclude_antigravity_project_marker(launch_cwd)
            launch_cwd = _prepare_antigravity_launch_cwd(launch_cwd, run_dir)
            _write_antigravity_settings(agent_config_dir, launch_cwd)

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

        # 6. Populate gauntlet-agent/context/ with HOWTOs, substituting
        #    $QUORUM_AGENT_CWD, $SUPERPOWERS_ROOT, and the per-coding-agent
        #    agent-config env var (e.g. $CLAUDE_CONFIG_DIR) with resolved
        #    absolute paths. tmux strips arbitrary env vars from new
        #    sessions, so we burn the values into the HOWTO instead of
        #    relying on env-var inheritance. See _populate_context_dir
        #    docstring.
        # $QUORUM_LAUNCH_AGENT resolves to the generated launcher shim's absolute
        # path. The shim is the `launch-agent` template in <name>-context/: it
        # bakes the `cd $QUORUM_AGENT_CWD` + env + flags into one executable so the
        # QA agent can launch the target with a single token and cannot skip the
        # cd (the qa-agent-misconfigured failure mode). HOWTOs reference it by this
        # placeholder; the destination path is deterministic.
        launch_agent_path = run_dir / "gauntlet-agent" / "context" / "launch-agent"
        substitutions = {
            "$QUORUM_AGENT_CWD": str(launch_cwd),
            "$QUORUM_AGENT_CWD_SH": _shell_single_quote(str(launch_cwd)),
            "$SUPERPOWERS_ROOT": os.environ.get("SUPERPOWERS_ROOT", ""),
            "$QUORUM_LAUNCH_AGENT": str(launch_agent_path),
            "$QUORUM_LAUNCH_AGENT_SH": _shell_single_quote(str(launch_agent_path)),
            f"${tcfg.agent_config_env}": str(agent_config_dir),
            f"${tcfg.agent_config_env}_SH": _shell_single_quote(str(agent_config_dir)),
            **agent_runtime.substitutions,
        }
        if tcfg.name == "gemini":
            substitutions["$GEMINI_ENV_FILE"] = str(agent_config_dir / GEMINI_ENV_FILE_NAME)
            substitutions["$GEMINI_ENV_FILE_SH"] = _shell_single_quote(
                str(agent_config_dir / GEMINI_ENV_FILE_NAME)
            )
        if tcfg.name == "copilot":
            if copilot_provisioning is None:
                raise RunnerError(
                    "Copilot provisioning missing before context setup",
                    stage="setup",
                )
            substitutions["$COPILOT_ENV_FILE"] = str(copilot_provisioning.env_file)
            substitutions["$COPILOT_ENV_FILE_SH"] = _shell_single_quote(
                str(copilot_provisioning.env_file)
            )
            substitutions["$QUORUM_COPILOT_SESSION_ID"] = copilot_provisioning.session_id
        if tcfg.name == "pi":
            substitutions["$PI_ENV_FILE"] = str(agent_config_dir / "pi.env")
        _populate_context_dir(
            coding_agents_dir,
            coding_agent,
            run_dir,
            substitutions=substitutions,
        )

        # 7. Snapshot session-log dir.
        snap = snapshot_dir(session_log_dir, tcfg.session_log_glob)

        # 8. Invoke gauntlet. For antigravity this also runs the agy rate-limit
        #    watcher, which may SIGKILL/kill-server agy mid-run — a kill during a
        #    token refresh can corrupt the shared ~/.gemini/oauth_creds.json. Back
        #    it up before the run and verify/restore in a finally after it returns
        #    (A4). Antigravity only; no overhead for other agents.
        gauntlet_env_base = _copilot_gauntlet_env(os.environ) if tcfg.name == "copilot" else None
        cb = agy_creds.backup_credential() if coding_agent == "antigravity" else None
        try:
            gauntlet_result = invoke_gauntlet(
                story_path=story_path,
                target_binary=tcfg.binary,
                launch_cwd=launch_cwd,
                run_dir=run_dir,
                max_time=effective_max_time,
                coding_agent=coding_agent,
                project_prompt=tcfg.project_prompt,
                extra_env={tcfg.agent_config_env: str(agent_config_dir)},
                env_base=gauntlet_env_base,
            )
        finally:
            if cb is not None:
                cb.verify_or_restore()
        gauntlet_status = gauntlet_result.status

        # 8a. Mid-run rate-limit short-circuit (A1/A3). When the watcher tripped,
        #     agy was killed and the run dir has no usable antigravity transcript.
        #     Intercept BEFORE the capture cascade and its strict-capture guard so
        #     this surfaces as a recognizable rate-limit verdict (carrying
        #     ANTIGRAVITY_RATE_LIMIT_MARKER for run_all's latch) rather than a
        #     generic empty-trace capture indeterminate.
        if coding_agent == "antigravity" and gauntlet_result.rate_limited:
            return run_dir, _write_indeterminate(
                run_dir,
                final_reason=(
                    "antigravity hit a Code Assist rate limit mid-run; agy was "
                    "killed and produced no usable transcript"
                ),
                gauntlet=_build_gauntlet_layer_from_run_dir(run_dir),
                checks=pre_records,
                error=RunError(
                    stage="gauntlet",
                    message=(
                        f"{ANTIGRAVITY_RATE_LIMIT_MARKER}: agy hit "
                        "RESOURCE_EXHAUSTED mid-run; killed"
                    ),
                ),
            )

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

        # 9. Capture + normalize logs.
        capture_result = capture_tool_calls(
            log_dir=session_log_dir,
            log_glob=tcfg.session_log_glob,
            snapshot=snap,
            normalizer=tcfg.normalizer,
            run_dir=run_dir,
            launch_cwd=launch_cwd,
        )

        # 9b. Capture token usage — measurement only, written to
        #     coding-agent-token-usage.json. Does not affect the verdict (see
        #     docs/migration-notes.md, cost / measurement decision).
        capture_token_usage(
            log_dir=session_log_dir,
            log_glob=tcfg.session_log_glob,
            snapshot=snap,
            normalizer=tcfg.normalizer,
            run_dir=run_dir,
            launch_cwd=launch_cwd,
        )

        # 10. Build Gauntlet layer from run dir before capture short-circuits or
        # post-checks, so early indeterminate verdicts still preserve QA context.
        gauntlet_layer = _build_gauntlet_layer_from_run_dir(run_dir)
        if gauntlet_layer is None:
            # Fallback: synthesise from the status returned by invoke_gauntlet.
            gauntlet_layer = GauntletLayer(
                status=gauntlet_status,
                summary="",
                reasoning="",
                run_id=None,
            )

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
                error=RunError(
                    stage="capture",
                    message="OpenCode export/capture snapshot mismatch",
                ),
            )

        if tcfg.normalizer == "copilot" and copilot_provisioning is not None:
            expected_log = (
                agent_config_dir
                / "session-state"
                / copilot_provisioning.session_id
                / "events.jsonl"
            )
            source_logs = {path.resolve() for path in capture_result.source_logs}
            expected_resolved = expected_log.resolve()
            leaks = _scan_copilot_secret_leaks(
                run_dir,
                secret_values=copilot_provisioning.secret_values,
                excluded_paths=(copilot_provisioning.env_file,),
            )
            if leaks:
                rel = [
                    str(path.relative_to(run_dir)) if path.is_relative_to(run_dir) else str(path)
                    for path in leaks
                ]
                return run_dir, _write_indeterminate(
                    run_dir,
                    final_reason=(
                        "Copilot secret value appeared in non-secret run artifact: "
                        + ", ".join(rel)
                    ),
                    gauntlet=gauntlet_layer,
                    checks=pre_records,
                    error=RunError(
                        stage="capture",
                        message="Copilot secret value leaked into run artifact",
                    ),
                )
            if capture_result.source_logs and expected_resolved not in source_logs:
                return run_dir, _write_indeterminate(
                    run_dir,
                    final_reason=(
                        "expected Copilot session-state log did not appear: "
                        f"{expected_log}"
                    ),
                    gauntlet=gauntlet_layer,
                    checks=pre_records,
                    error=RunError(
                        stage="capture",
                        message="expected Copilot session-state log missing",
                    ),
                )
            unexpected_logs = [
                path
                for path in capture_result.source_logs
                if path.resolve() != expected_resolved
            ]
            if unexpected_logs:
                rel = [
                    str(path.relative_to(session_log_dir))
                    if path.is_relative_to(session_log_dir)
                    else str(path)
                    for path in unexpected_logs
                ]
                return run_dir, _write_indeterminate(
                    run_dir,
                    final_reason=(
                        "unexpected Copilot session-state log(s) appeared: "
                        + ", ".join(rel)
                    ),
                    gauntlet=gauntlet_layer,
                    checks=pre_records,
                    error=RunError(
                        stage="capture",
                        message="unexpected Copilot session-state log captured",
                    ),
                )

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
                    final_reason="unusable Pi session header(s): " + ", ".join(unusable_rel),
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
                final_reason=(
                    "OpenCode export(s) normalized to zero tool-call rows: "
                    + ", ".join(rel)
                ),
                gauntlet=gauntlet_layer,
                checks=pre_records,
                error=RunError(stage="capture", message="OpenCode capture normalized to zero rows"),
            )

        strict_capture_names = {
            "antigravity": "Antigravity",
            "copilot": "Copilot",
            "gemini": "Gemini",
            "opencode": "OpenCode",
        }
        strict_capture_name = strict_capture_names.get(tcfg.normalizer)
        if strict_capture_name and not capture_result.source_logs:
            return run_dir, _write_indeterminate(
                run_dir,
                final_reason=(
                    f"no {strict_capture_name} transcript appeared under isolated "
                    f"{session_log_dir}; cannot evaluate this run"
                ),
                gauntlet=gauntlet_layer,
                checks=pre_records,
                error=RunError(
                    stage="capture",
                    message=f"no {strict_capture_name} transcript captured",
                ),
            )

        if (
            strict_capture_name
            and capture_result.source_logs
            and capture_result.row_count == 0
        ):
            rel = [str(p.relative_to(session_log_dir)) for p in capture_result.source_logs]
            return run_dir, _write_indeterminate(
                run_dir,
                final_reason=(
                    f"{strict_capture_name} transcript(s) normalized to zero tool-call rows: "
                    + ", ".join(rel)
                ),
                gauntlet=gauntlet_layer,
                checks=pre_records,
                error=RunError(
                    stage="capture",
                    message=f"{strict_capture_name} capture normalized to zero rows",
                ),
            )

        if tcfg.normalizer == "kimi":
            if not capture_result.source_logs:
                unmatched = diagnose_kimi_unmatched_logs(
                    log_dir=session_log_dir,
                    log_glob=tcfg.session_log_glob,
                    snapshot=snap,
                    launch_cwd=launch_cwd,
                )
                if unmatched is not None:
                    rel = [str(p.relative_to(session_log_dir)) for p in unmatched.paths]
                    if unmatched.stage == "qa-agent-misconfigured":
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
                            "Kimi wrote wire logs, but session_index.jsonl did not "
                            "map them to the launch cwd; cannot evaluate this run"
                        ),
                        gauntlet=gauntlet_layer,
                        checks=pre_records,
                        error=RunError(
                            stage="capture",
                            message=(
                                "Kimi wire logs were not indexed/mappable to launch cwd: "
                                f"{rel}"
                            ),
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
                    final_reason=(
                        "Kimi wire log(s) normalized to zero tool-call rows: "
                        + ", ".join(rel)
                    ),
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
                        message=(
                            "missing plugin_session_start plugin=superpowers "
                            "skill=using-superpowers"
                        ),
                    ),
                )

        # 11. Run checks.sh post().
        post_records, post_exit = run_phase(
            checks_sh=checks_sh,
            phase="post",
            workdir=workdir,
            quorum_bin=_quorum_bin_dir(),
            tool_calls_path=run_dir / "coding-agent-tool-calls.jsonl",
            run_dir=run_dir,
        )
        if post_exit != 0:
            return run_dir, _write_indeterminate(
                run_dir,
                final_reason=f"checks.sh post() crashed (exit {post_exit})",
                error=RunError(stage="checks", message=f"post exit {post_exit}"),
            )

        # 12. Built-in empty-capture check.
        capture_empty = capture_result.row_count == 0

        # 12b. QA-agent-misconfigured short-circuit.
        #      An empty capture *plus* a codex rollout sitting under run_dir but
        #      launched in some subdir other than launch_cwd means the QA agent
        #      skipped `cd $QUORUM_AGENT_CWD` from the codex HOWTO before typing
        #      `codex`. Surface that as its own indeterminate stage — otherwise
        #      downstream tool-called checks all report "never called" and the
        #      real cause stays buried.
        if capture_empty and tcfg.normalizer == "codex":
            misplaced = detect_misplaced_codex_rollouts(
                log_dir=session_log_dir,
                log_glob=tcfg.session_log_glob,
                snapshot=snap,
                run_dir=run_dir,
                launch_cwd=launch_cwd,
            )
            if misplaced:
                misplaced_rel = [str(p.relative_to(session_log_dir)) for p in misplaced]
                return run_dir, _write_indeterminate(
                    run_dir,
                    final_reason=(
                        "QA agent launched codex from the wrong cwd — likely skipped "
                        "`cd $QUORUM_AGENT_CWD` in the codex HOWTO. See "
                        f"{misplaced_rel} for the misplaced rollout(s)."
                    ),
                    error=RunError(
                        stage="qa-agent-misconfigured",
                        message=f"misplaced codex rollouts: {misplaced_rel}",
                    ),
                )

        verdict = compose(
            gauntlet=gauntlet_layer,
            checks=pre_records + post_records,
            capture_empty=capture_empty,
            error=None,
        )
        economics = build_run_economics(run_dir)
        if economics is not None:
            verdict = dataclasses.replace(verdict, economics=economics)

        # 13. Persist.
        (run_dir / "verdict.json").write_text(json.dumps(verdict.to_dict(), indent=2))

        return run_dir, verdict
    finally:
        _cleanup_agent_runtime(agent_runtime)


def run_scenario(
    *,
    scenario_dir: Path,
    coding_agent: str,
    coding_agents_dir: Path,
    out_root: Path,
    skeleton_root: Path | None = None,
) -> tuple[Path, FinalVerdict]:
    """Run one scenario against one Coding-Agent, always writing verdict.json.

    Allocates run_dir before the try block so that any exception (setup crash,
    checks failure, Gauntlet/capture error, or unexpected quorum crash) can
    still write a verdict.json into that directory.  No more husk dirs.

    Returns (run_dir, verdict) so callers can log the run directory path.
    """
    run_dir = _allocate_run_dir(
        out_root=out_root,
        scenario_name=scenario_dir.name,
        coding_agent=coding_agent,
    )
    try:
        return _run_scenario_inner(
            run_dir=run_dir,
            scenario_dir=scenario_dir,
            coding_agent=coding_agent,
            coding_agents_dir=coding_agents_dir,
            out_root=out_root,
            skeleton_root=skeleton_root,
        )
    except CodingAgentConfigError as e:
        v = _write_indeterminate(
            run_dir,
            final_reason=f"coding-agent config failed: {e}",
            error=RunError(stage="setup", message=str(e)[:500]),
        )
        return run_dir, v
    except SetupError as e:
        v = _write_indeterminate(
            run_dir,
            final_reason=f"setup failed: {e}",
            error=RunError(stage="setup", message=str(e)[:500]),
        )
        return run_dir, v
    except RunnerError as e:
        v = _write_indeterminate(
            run_dir,
            final_reason=f"runner error: {e}",
            error=RunError(stage=e.stage, message=str(e)[:500]),
        )
        return run_dir, v
    except Exception as e:  # last-resort: unexpected quorum crash
        v = _write_indeterminate(
            run_dir,
            final_reason=f"unexpected quorum crash: {e}",
            error=RunError(stage="unknown", message=str(e)[:500]),
        )
        return run_dir, v
