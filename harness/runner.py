"""Per-run orchestration. One scenario, one target, one verdict.

Important context for understanding the cwd dance:

- Gauntlet's TUI adapter spawns `tmux new-session -c <run-dir>/scratch bash`.
  The QA agent's bash starts in <run-dir>/scratch, NOT the harness's workdir.
- The harness's workdir (where setup.sh ran and `git init` happened) is at a
  separate /tmp path the QA agent can't infer.
- Bridge: the runner exports HARNESS_AGENT_CWD into the gauntlet subprocess
  env. tmux inherits → bash inherits. Per-target HOWTOs tell the QA agent
  to `cd $HARNESS_AGENT_CWD` before invoking the target binary.
- Default HARNESS_AGENT_CWD = workdir. Setup.sh can override by writing the
  absolute desired launch path into <workdir>/.harness-launch-cwd. The
  worktree-already-inside scenario uses this to point at the sibling
  existing-worktree.

Also: setup.sh helpers (in setup_helpers/) need to know where the harness
checkout lives so they can find fixtures/template-repo. Runner exports
HARNESS_REPO_ROOT for that purpose.

Single-run-at-a-time only in Phase 1. Multiple harness processes against the
same target's session-log dir cross-contaminate via snapshot/diff. Enforced
with a sentinel lockfile that refuses (rather than silently falling back).
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
from harness.composer import FinalVerdict, GauntletStatus, compose
from harness.scenario_config import (
    ScenarioConfigError,
    check_target_compatibility,
    load_scenario_config,
)
from harness.setup_step import SetupError, run_setup
from harness.target_config import load_target_config

LOCK_FILENAME = ".harness-run.lock"
LAUNCH_CWD_SENTINEL = ".harness-launch-cwd"


class RunnerError(RuntimeError):
    """Raised on non-recoverable errors before verdict composition."""


@contextmanager
def _single_run_lock(session_log_dir: Path):
    """Enforce one-harness-run-at-a-time per session-log root.

    Refuse loudly if locked. Refuse loudly if the parent dir doesn't exist
    (silent fallback to $HOME would let a typo'd session_log_dir leak a lock
    into the user's home directory).
    """
    parent = session_log_dir.parent
    if not parent.exists():
        raise RunnerError(
            f"session_log_dir parent does not exist: {parent}. "
            "Refusing to fall back to $HOME — fix the target config."
        )
    lock_path = parent / LOCK_FILENAME
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


def _resolve_launch_cwd(workdir: Path) -> Path:
    """Read <workdir>/.harness-launch-cwd if setup.sh wrote one.

    Returns workdir if no sentinel exists. Raises if the sentinel points at
    a non-existent path.
    """
    sentinel = workdir / LAUNCH_CWD_SENTINEL
    if not sentinel.exists():
        return workdir
    target = Path(sentinel.read_text().strip())
    if not target.exists():
        raise RunnerError(
            f"setup.sh wrote {LAUNCH_CWD_SENTINEL}={target} but that path "
            "doesn't exist"
        )
    return target


def _gauntlet_status_from_run_dir(run_dir: Path) -> GauntletStatus:
    """Read gauntlet's verdict from <run-dir>/.gauntlet/results/<runId>/result.json.

    Phase 1 is one gauntlet invocation per run-dir, so there should be exactly
    one runId directory. If we find more (shouldn't happen), use the newest.
    """
    _valid: set[GauntletStatus] = {"pass", "fail", "investigate"}
    results_root = run_dir / ".gauntlet" / "results"
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


def _harness_repo_root() -> Path:
    """Return the harness checkout root (where fixtures/, bin/, etc. live).

    Resolved from this module's location: harness/runner.py → ../.
    """
    return Path(__file__).resolve().parent.parent


def invoke_gauntlet(
    *,
    story_path: Path,
    target_binary: str,
    launch_cwd: Path,
    run_dir: Path,
    max_time: str | None,
) -> GauntletStatus:
    """Subprocess-invoke `gauntlet run`. Returns the verdict status string.

    Sets HARNESS_AGENT_CWD in the env so the QA agent's bash (which starts
    in <run-dir>/scratch, NOT in our launch_cwd) can `cd` there before
    invoking the target. Per-target HOWTO files instruct the agent to do so.
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
    env = {
        **os.environ,
        "HARNESS_AGENT_CWD": str(launch_cwd),
    }
    # --silent prints runId on stderr; we don't disambiguate by runId in
    # Phase 1 (one invocation per run-dir = at most one runId subdirectory).
    subprocess.run(cmd, env=env, check=False)
    return _gauntlet_status_from_run_dir(run_dir)


def _has_any_assertions(assertions_dir: Path) -> bool:
    """Drill engine.py:169-178 parity: empty-capture guard fires whenever
    the scenario declares any assertions at all, not just tool-named ones.
    """
    if not assertions_dir.exists():
        return False
    return any(
        p.is_file() and os.access(p, os.X_OK)
        for p in assertions_dir.iterdir()
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
    contexts_dir: Path,
    target: str,
    run_dir: Path,
    substitutions: dict[str, str] | None = None,
) -> None:
    """Copy per-target HOWTOs into <run-dir>/.gauntlet/context/.

    `substitutions` maps placeholders (e.g. `$HARNESS_AGENT_CWD`) to literal
    values. Applied to every text file via plain string replace. This is the
    harness workaround for tmux stripping arbitrary env vars from new
    sessions: rather than relying on the QA agent's bash inheriting our env,
    we burn the resolved values into the HOWTO at runtime so the agent reads
    a concrete path instead of an env-var reference.

    Phase 2 / upstream: Gauntlet should pass `-e VAR=value` to
    `tmux new-session` so user env vars actually reach the agent's shell.
    When that lands, this templating becomes unnecessary.
    """
    src = contexts_dir / target
    dst = run_dir / ".gauntlet" / "context"
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


def _copytree_with_substitutions(
    src: Path, dst: Path, subs: dict[str, str]
) -> None:
    dst.mkdir(parents=True, exist_ok=True)
    for entry in src.iterdir():
        if entry.is_file():
            _copy_with_substitutions(entry, dst / entry.name, subs)
        elif entry.is_dir():
            _copytree_with_substitutions(entry, dst / entry.name, subs)


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

    # 3. Create temp workdir; pass HARNESS_REPO_ROOT to setup.sh via subprocess
    #    env so setup.sh helpers can find fixtures/template-repo without leaking
    #    the var into the parent process env.
    workdir = Path(tempfile.mkdtemp(prefix="harness-wd-"))
    env_extra = {"HARNESS_REPO_ROOT": str(_harness_repo_root())}
    workdir_kept = False
    try:
        with _single_run_lock(tcfg.session_log_dir):
            # 4. Run setup.sh.
            try:
                run_setup(scenario_dir, workdir, env_extra=env_extra)
            except SetupError as e:
                raise RunnerError(f"setup failed: {e}") from e

            # 5. Resolve launch cwd (defaults to workdir; setup.sh may
            #    override via .harness-launch-cwd sentinel).
            launch_cwd = _resolve_launch_cwd(workdir)

            # 6. Populate .gauntlet/context/ with HOWTOs, substituting
            #    $HARNESS_AGENT_CWD and $SUPERPOWERS_ROOT placeholders with
            #    resolved absolute paths. tmux strips arbitrary env vars from
            #    new sessions, so we burn the values into the HOWTO instead
            #    of relying on env-var inheritance. See _populate_context_dir
            #    docstring.
            _populate_context_dir(
                contexts_dir,
                target,
                run_dir,
                substitutions={
                    "$HARNESS_AGENT_CWD": str(launch_cwd),
                    "$SUPERPOWERS_ROOT": os.environ.get("SUPERPOWERS_ROOT", ""),
                },
            )

            # 7. Snapshot session-log dir.
            snap = snapshot_dir(tcfg.session_log_dir, tcfg.session_log_glob)

            # 8. Invoke gauntlet.
            gauntlet_status = invoke_gauntlet(
                story_path=story_path,
                target_binary=tcfg.binary,
                launch_cwd=launch_cwd,
                run_dir=run_dir,
                max_time=tcfg.max_time,
            )

            # 9. Capture + normalize logs.
            tool_calls_path = capture_tool_calls(
                log_dir=tcfg.session_log_dir,
                log_glob=tcfg.session_log_glob,
                snapshot=snap,
                normalizer=tcfg.normalizer,
                run_dir=run_dir,
                workdir=workdir,
            )

            # 10. Run scenario assertions.
            results, _ = run_assertions(
                assertions_dir=scenario_dir / "assertions",
                run_dir=run_dir,
                workdir=workdir,
                bin_dir=bin_dir,
            )

            # 11. Empty-capture parity guard (Drill engine.py:169-178).
            if _has_any_assertions(scenario_dir / "assertions"):
                synth = _empty_capture_synthetic(tool_calls_path)
                if synth is not None:
                    results = [synth, *results]

            # 12. Compose final verdict.
            verdict = compose(
                gauntlet_status=gauntlet_status,
                assertion_results=results,
            )

            # 13. Persist.
            (run_dir / "verdict.json").write_text(
                json.dumps(verdict.to_dict(), indent=2)
            )

            # 14. Workdir disposition.
            if verdict.final != "pass":
                workdir_kept = True
                (run_dir / "workdir-path.txt").write_text(str(workdir))
            return verdict
    finally:
        if not workdir_kept:
            shutil.rmtree(workdir, ignore_errors=True)
