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

import dataclasses
import datetime as _dt
import json
import os
import secrets
import shutil
import stat
import subprocess
from pathlib import Path

from quorum.capture import (
    capture_token_usage,
    capture_tool_calls,
    detect_misplaced_codex_rollouts,
    snapshot_dir,
)
from quorum.checks import parse_coding_agents_directive, run_phase
from quorum.coding_agent_config import CodingAgentConfig, load_coding_agent_config
from quorum.composer import FinalVerdict, GauntletLayer, GauntletStatus, RunError, compose
from quorum.economics import build_run_economics
from quorum.setup_step import SetupError, run_setup
from quorum.story_meta import StoryMetaError, read_quorum_max_time
from setup_helpers.worktree import install_codex_superpowers_plugin_hooks

LAUNCH_CWD_SENTINEL = ".quorum-launch-cwd"
CODING_AGENT_CONFIG_SUBDIR = "coding-agent-config"


class RunnerError(RuntimeError):
    """Raised on non-recoverable errors before verdict composition."""


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
            f"codex login --with-api-key failed (exit {result.returncode}): "
            f"{result.stderr.strip()}"
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
        raise RunnerError(
            "SUPERPOWERS_ROOT not set; cannot install codex plugin hooks"
        )
    install_codex_superpowers_plugin_hooks(
        workdir, superpowers_root, codex_home=codex_home
    )


def _seed_agent_config_dir(
    coding_agent: CodingAgentConfig,
    skeleton_root: Path,
    dest: Path,
    workdir: Path,
) -> None:
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
    """
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
            f"setup.sh wrote {LAUNCH_CWD_SENTINEL}={resolved_path} but that path "
            "doesn't exist"
        )
    return resolved_path


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


def invoke_gauntlet(
    *,
    story_path: Path,
    target_binary: str,
    launch_cwd: Path,
    run_dir: Path,
    max_time: str | None,
    project_prompt: Path | None = None,
    extra_env: dict[str, str] | None = None,
) -> GauntletStatus:
    """Subprocess-invoke `gauntlet run`. Returns the verdict status string.

    Sets QUORUM_AGENT_CWD in the env so the QA agent's bash (which starts
    in <run-dir>/scratch, NOT in our launch_cwd) can `cd` there before
    invoking the target. Per-target HOWTO files instruct the agent to do so.

    extra_env (per-target config-dir vars like CLAUDE_CONFIG_DIR) is also
    plumbed in. Note that today tmux strips arbitrary env from new sessions
    (see _populate_context_dir docstring), so the agent reads the value
    from the substituted HOWTO rather than from inheritance — but the env
    is set here too for belt-and-suspenders + future Gauntlet `-e` support.
    """
    cmd = [
        "gauntlet", "run", str(story_path),
        "--adapter", "tui",
        # Gauntlet's own --target flag; not quorum's vocabulary — keep.
        "--target", target_binary,
        "--project-dir", str(run_dir),
        "--state-dir", "gauntlet-agent",
        "--silent",
    ]
    if max_time:
        cmd += ["--max-time", max_time]
    if project_prompt:
        cmd += ["--project-prompt", str(project_prompt)]
    env = {
        **os.environ,
        "QUORUM_AGENT_CWD": str(launch_cwd),
        **(extra_env or {}),
    }
    # --silent prints runId on stderr; we don't disambiguate by runId in
    # Phase 1 (one invocation per run-dir = at most one runId subdirectory).
    subprocess.run(cmd, env=env, check=False)
    return _gauntlet_status_from_run_dir(run_dir)


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


def _copy_with_substitutions(
    src: Path, dst: Path, subs: dict[str, str]
) -> None:
    try:
        content = src.read_text()
    except UnicodeDecodeError:
        # Non-text fixture file (image, binary). Copy as-is.
        shutil.copy2(src, dst)
        return
    for placeholder, value in subs.items():
        content = content.replace(placeholder, value)
    dst.write_text(content)
    # A shebang'd template (e.g. the launch-agent shim) must stay executable
    # after substitution — write_text drops the mode. The QA agent invokes
    # the shim by absolute path, so it needs +x.
    if content.startswith("#!"):
        dst.chmod(dst.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _copytree_with_substitutions(
    src: Path, dst: Path, subs: dict[str, str]
) -> None:
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
    _seed_agent_config_dir(
        tcfg,
        skeleton_root=skeleton_root or (_quorum_repo_root() / "coding-agents"),
        dest=agent_config_dir,
        workdir=workdir,
    )
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
    _populate_context_dir(
        coding_agents_dir,
        coding_agent,
        run_dir,
        substitutions={
            "$QUORUM_AGENT_CWD": str(launch_cwd),
            "$SUPERPOWERS_ROOT": os.environ.get("SUPERPOWERS_ROOT", ""),
            "$QUORUM_LAUNCH_AGENT": str(launch_agent_path),
            f"${tcfg.agent_config_env}": str(agent_config_dir),
        },
    )

    # 7. Snapshot session-log dir.
    snap = snapshot_dir(session_log_dir, tcfg.session_log_glob)

    # 8. Invoke gauntlet.
    gauntlet_status = invoke_gauntlet(
        story_path=story_path,
        target_binary=tcfg.binary,
        launch_cwd=launch_cwd,
        run_dir=run_dir,
        max_time=effective_max_time,
        project_prompt=tcfg.project_prompt,
        extra_env={tcfg.agent_config_env: str(agent_config_dir)},
    )

    # 9. Capture + normalize logs.
    capture_tool_calls(
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

    # 10. Run checks.sh post().
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

    # 11. Built-in empty-capture check.
    tcp = run_dir / "coding-agent-tool-calls.jsonl"
    capture_empty = not tcp.exists() or tcp.stat().st_size == 0

    # 11b. QA-agent-misconfigured short-circuit.
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

    # 12. Build Gauntlet layer from run dir.
    gauntlet_layer = _build_gauntlet_layer_from_run_dir(run_dir)
    if gauntlet_layer is None:
        # Fallback: synthesise from the status returned by invoke_gauntlet.
        gauntlet_layer = GauntletLayer(
            status=gauntlet_status,
            summary="",
            reasoning="",
            run_id=None,
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
    (run_dir / "verdict.json").write_text(
        json.dumps(verdict.to_dict(), indent=2)
    )

    return run_dir, verdict


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
            error=RunError(stage="unknown", message=str(e)[:500]),
        )
        return run_dir, v
    except Exception as e:  # last-resort: unexpected quorum crash
        v = _write_indeterminate(
            run_dir,
            final_reason=f"unexpected quorum crash: {e}",
            error=RunError(stage="unknown", message=str(e)[:500]),
        )
        return run_dir, v
