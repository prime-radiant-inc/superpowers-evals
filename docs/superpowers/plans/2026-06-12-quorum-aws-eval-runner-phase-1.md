# Quorum AWS Eval Runner Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` for this plan. Execute one task at a
> time, verify it, commit it, then continue. Use `superpowers:using-git-worktrees`
> before implementation if the main checkout is not already isolated.

**Goal:** Add the smallest useful managed remote runner for Quorum evals on a
single AWS host, with safe shared-team operation, key-backed targets, explicit
parallelism, and a clean path toward an eval platform.

**Architecture:** Keep Quorum as the only user-facing eval API. Add managed
Quorum commands that enqueue and run jobs on the AWS host; do not add a separate
service API in Phase 1. Store job state, run artifacts, lock files, and cooldown
markers on the host filesystem. Provision the host in Terminus Terraform using
the existing EC2 plus encrypted EBS plus SSM secret pattern.

**Tech Stack:** Python 3.11, Click, Quorum, uv, pytest, fcntl file locks, JSONL
job/event files, Terraform, Terminus `machine-westworld`, encrypted EBS, SSM
SecureString, DLM snapshots, SSM Session Manager.

**Specs:** This plan implements Phase 1a and Phase 1b from:

- `docs/superpowers/specs/2026-06-12-quorum-aws-eval-runner-design.md`
- `docs/superpowers/specs/2026-06-12-quorum-aws-eval-runner-phase-1-design.md`

**Important Current-State Note:** Quorum already has story `tier` and `status`
support in `quorum/story_meta.py`, `quorum/run_all.py`, and `quorum/cli.py`.
Do not reimplement suite tiering. Build the managed runner on top of the
existing `--tier` and `--include-drafts` seams.

## Repo Boundaries

Implement this as two coordinated changes:

1. `superpowers-evals`
   - Managed Quorum commands.
   - Runtime environment sanitization.
   - Job state and lock model.
   - Doctor/smoke/column/batch/status/tail behavior.
   - Unit and integration-style tests that do not launch live agent CLIs.

2. `brooks/terminus`
   - Terraform service root for the AWS runner.
   - Userdata/bootstrap scripts.
   - Persistent encrypted EBS, DLM backups, IAM, and SSM SecureString entries.
   - Operator runbook and bootstrap verification.

Keep Phase 1 intentionally filesystem-backed. Do not introduce a web service,
database, queue service, container orchestrator, or multi-host scheduling in this
plan.

## User-Facing Phase 1 Shape

The user-facing surface remains Quorum:

```bash
uv run quorum doctor --all
uv run quorum doctor claude
uv run quorum smoke claude
uv run quorum column claude --jobs 2
uv run quorum batch --tier sentinel --coding-agent claude --jobs 2
uv run quorum status
uv run quorum status <job-id>
uv run quorum tail <job-id>
uv run quorum tail <job-id> --child <child-id>
```

On the AWS host, raw live eval commands fail closed:

```bash
uv run quorum run scenarios/basic-follow-instructions --coding-agent claude
uv run quorum run-all --coding-agent claude --tier sentinel
```

Those raw commands are still valid on developer laptops. On the AWS host they
must exit with a message that points to `smoke`, `column`, or `batch`.

## Managed Runner Filesystem Contract

Use these defaults on the AWS host:

```text
/opt/quorum/current                 # repo checkout
/opt/quorum/state                   # active jobs, locks, cooldowns, taint markers
/opt/quorum/artifacts               # Quorum run artifacts and batch artifacts
/opt/quorum/worktrees               # per-job working copies for mutable checkout work
/opt/quorum/cache                   # uv/pip/npm/model helper cache
/etc/quorum/target-profiles.d       # root-owned target secret profiles
```

The local test defaults should stay inside a temp directory and be controlled by:

```text
QUORUM_MANAGED_HOST=1
QUORUM_STATE_ROOT=<path>
QUORUM_ARTIFACT_ROOT=<path>
QUORUM_TARGET_PROFILE_ROOT=<path>
QUORUM_MANAGED_WORKER=1
```

`QUORUM_MANAGED_HOST=1` means managed host behavior is active.
`QUORUM_MANAGED_WORKER=1` is set only for internal worker subprocesses and
allows the worker to call the raw `run` and `run-all` implementation.

## Job Schema

Write one JSON file per job under:

```text
$QUORUM_STATE_ROOT/jobs/<job-id>.json
```

Use an append-only event stream under:

```text
$QUORUM_STATE_ROOT/events/<job-id>.jsonl
```

Use this schema for the job file:

```json
{
  "schema_version": 1,
  "id": "job-20260612T170501Z-a1b2",
  "state": "planned",
  "created_at": "2026-06-12T17:05:01Z",
  "updated_at": "2026-06-12T17:05:01Z",
  "started_at": null,
  "finished_at": null,
  "owner": "drew",
  "host": "quorum-evals",
  "command": ["quorum", "column", "claude", "--jobs", "2"],
  "managed_command": "column",
  "profile": null,
  "coding_agents": ["claude"],
  "tier": "sentinel",
  "scenario_filter": null,
  "include_drafts": false,
  "out_root": "/opt/quorum/artifacts",
  "log_path": "/opt/quorum/state/logs/job-20260612T170501Z-a1b2.log",
  "locks": [],
  "env_profiles": ["claude"],
  "evals_repo": null,
  "superpowers_repo": null,
  "supervisor": null,
  "children": [],
  "result_rollup": null,
  "tainted": false,
  "taint_reason": null,
  "taint_matches": [],
  "artifact_bytes": null,
  "final_exit_code": null,
  "failure_reason": null
}
```

Use these durable managed job states only:

```text
planned
running
succeeded
failed
interrupted
```

`orphaned` is derived by `status` when metadata exists, the recorded supervisor
is gone or stale, and final state cannot be determined. Phase 1 fails fast on
lock conflict; it does not implement queued or waiting states.

Job state is about managed-command execution, not eval verdict. A managed batch
can be `succeeded` while its `result_rollup` contains failed or indeterminate
eval cells. Taint is represented with `tainted`, `taint_reason`, and
`taint_matches`; it is not a separate lifecycle state in Phase 1.

## Parallelism Model

The Phase 1 runner uses three layers of concurrency:

1. User jobs
   - Multiple users may enqueue jobs.
   - A global lock prevents overcommitting the host past configured capacity.

2. Batch children
   - A `batch` or `column` job owns a batch directory.
   - Each scenario/target cell becomes a child record in the parent job file.

3. Harness-specific `--jobs`
   - The `jobs` argument remains the child concurrency for one batch.
   - Do not treat it as global host capacity.

Add an explicit managed host capacity setting:

```text
QUORUM_MAX_ACTIVE_BATCH_JOBS=1
QUORUM_MAX_ACTIVE_CHILDREN=4
```

For Phase 1a, set production defaults to:

```text
QUORUM_MAX_ACTIVE_BATCH_JOBS=1
QUORUM_MAX_ACTIVE_CHILDREN=2
```

This is enough for shared use while preserving predictable API-key and machine
load. Phase 1b can raise child concurrency after sentinel evidence is clean.

## Lock Model

Use `fcntl.flock` on files under:

```text
$QUORUM_STATE_ROOT/locks
```

Acquire locks in this exact order:

```text
global
checkout
provider:<provider-name>
target:<target-name>
```

Locks:

- `global.active` limits total active managed jobs.
- `checkout` is exclusive when a command mutates the shared checkout; most eval
  runs should avoid this lock by using a fixed checkout or a job worktree.
- `provider:<provider-name>` protects API-key family rate limits.
- `target:<target-name>` prevents unsafe overlapping runs for targets that are
  not concurrency-safe.

Lock sidecar files contain the current holder:

```json
{
  "job_id": "job-20260612T170501Z-a1b2",
  "pid": 12345,
  "hostname": "quorum-evals",
  "started_at": "2026-06-12T17:05:01Z",
  "command": "column claude --jobs 2"
}
```

If a lock cannot be acquired, write the failed job record, append a lock-conflict
event, set state `failed`, and surface the conflicting holder in `quorum status`.
Phase 1 does not keep the job waiting for a later retry.

## Target Profiles

Target profiles are root-owned shell fragments:

```text
/etc/quorum/target-profiles.d/claude.env
/etc/quorum/target-profiles.d/codex.env
/etc/quorum/target-profiles.d/opencode.env
/etc/quorum/target-profiles.d/kimi.env
/etc/quorum/target-profiles.d/gemini.env
/etc/quorum/target-profiles.d/copilot.env
```

File permissions:

```text
owner: root
group: quorum
mode: 0640
```

A target profile contains only allowlisted variables for that target. Example:

```bash
ANTHROPIC_API_KEY=sk-ant-example
```

The managed runner reads a profile only inside the worker process. It must not
write the values to the job file, event stream, stdout, stderr, or artifact
metadata.

## Runtime Environment Policy

Managed commands must build a fresh environment for setup, checks, Gauntlet, and
child `quorum run` processes. Do not inherit ambient shell secrets on the host.

Always include:

```text
PATH
HOME
TMPDIR
LANG
LC_ALL
QUORUM_WORKDIR
QUORUM_RUN_DIR
QUORUM_ARTIFACT_ROOT
QUORUM_STATE_ROOT
SUPERPOWERS_ROOT
```

Allow target credentials only from the selected profile. Permit only the
variables explicitly mapped for the selected target. In tests, poison ambient
secret variables and assert they do not reach setup/check/child/Gauntlet envs.

## Implementation Tasks

### Task 1: Managed State Foundation

Files:

- Add `quorum/managed_state.py`
- Add `tests/quorum/test_managed_state.py`

Implement:

- `ManagedPaths`
  - `state_root`
  - `artifact_root`
  - `jobs_dir`
  - `events_dir`
  - `locks_dir`
  - `cooldowns_dir`
  - `taints_dir`
- `discover_managed_paths(env: Mapping[str, str]) -> ManagedPaths`
- `new_job_id(now: datetime, kind: str, target: str | None) -> str`
- `write_job_atomic(paths: ManagedPaths, job: ManagedJob) -> None`
- `read_job(paths: ManagedPaths, job_id: str) -> ManagedJob`
- `list_jobs(paths: ManagedPaths) -> JobListResult`
- `append_event(paths: ManagedPaths, job_id: str, event: Mapping[str, object])`
- `mark_job_state(paths: ManagedPaths, job_id: str, state: str, *, result_rollup: Mapping[str, object] | None = None, final_exit_code: int | None = None, failure_reason: str | None = None) -> ManagedJob`
- `heartbeat_job(paths: ManagedPaths, job_id: str, now: datetime) -> ManagedJob`
- `mark_job_tainted(paths: ManagedPaths, job_id: str, reason: str, matches: Sequence[Mapping[str, object]]) -> ManagedJob`

Use plain dataclasses plus JSON helpers.

Tests:

- Creates state directories lazily.
- Job IDs are unique, sortable, and use the spec shape
  `job-YYYYMMDDTHHMMSSZ-a1b2`.
- Atomic writes never leave partial JSON when replacing an existing file.
- `list_jobs` returns a `JobListResult`, ignores malformed files, and includes
  one diagnostic per malformed file.
- `heartbeat_job` updates `updated_at` without mutating immutable fields.
- `mark_job_tainted` sets `tainted=true`, preserves the previous `state`, and
  preserves the previous `result_rollup`.

Verification:

```bash
uv run pytest tests/quorum/test_managed_state.py -q
uv run ruff check quorum/managed_state.py tests/quorum/test_managed_state.py
uv run ty check quorum/managed_state.py tests/quorum/test_managed_state.py
```

Commit:

```bash
git add quorum/managed_state.py tests/quorum/test_managed_state.py
git commit -m "Add managed quorum job state"
```

### Task 2: Locks, Cooldowns, and Capacity

Files:

- Add `quorum/locks.py`
- Add `tests/quorum/test_locks.py`
- Add `tests/quorum/fixtures/lock_holder.py`

Implement:

- `ManagedLock`
- `LockRequest`
- `LockConflict`
- `acquire_locks(paths, requests, job_id, command, wait=False)`
- `release_locks(held: Sequence[ManagedLock]) -> None`
- `read_lock_holder(paths: ManagedPaths, lock_name: str) -> LockHolder | None`
- `write_cooldown(paths, provider, reason, until)`
- `read_active_cooldowns(paths, now)`

Rules:

- Sort lock acquisition by the fixed order in this plan.
- Use non-blocking acquisition for user-facing enqueue/start paths.
- Store sidecar JSON while the lock is held.
- Remove sidecar JSON on clean release.
- Treat stale sidecars as diagnostics only. The kernel lock is the source of
  truth.
- Cooldowns are JSON files under `$QUORUM_STATE_ROOT/cooldowns/<provider>.json`.

Tests:

- A second process cannot acquire an exclusive lock already held by a first
  process.
- Lock requests are acquired in deterministic order independent of caller order.
- Sidecar content includes job ID, pid, hostname, started time, and command.
- Cooldown read returns active cooldowns and drops expired cooldowns.
- Lock conflict objects are JSON serializable for status output.

Verification:

```bash
uv run pytest tests/quorum/test_locks.py -q
uv run ruff check quorum/locks.py tests/quorum/test_locks.py
uv run ty check quorum/locks.py tests/quorum/test_locks.py
```

Commit:

```bash
git add quorum/locks.py tests/quorum/test_locks.py tests/quorum/fixtures/lock_holder.py
git commit -m "Add managed quorum locks and cooldowns"
```

### Task 3: Sanitized Runtime Environment and Raw Command Gate

Files:

- Add `quorum/runtime_env.py`
- Add `tests/quorum/test_runtime_env.py`
- Modify `quorum/cli.py`
- Modify `quorum/runner.py`
- Modify `quorum/setup_step.py`
- Modify `quorum/checks.py`
- Modify `quorum/run_all.py`
- Modify `quorum/opencode_capture.py`
- Modify `coding-agents/opencode-context/launch-agent`
- Modify related existing tests:
  - `tests/quorum/test_cli.py`
  - `tests/quorum/test_runner.py`
  - `tests/quorum/test_setup_step.py`
  - `tests/quorum/test_checks.py`
  - `tests/quorum/test_run_all.py`
  - `tests/quorum/test_opencode_capture.py`

Implement:

- `is_managed_host(env) -> bool`
- `is_managed_worker(env) -> bool`
- `TargetProfile`
- `TargetProfileError`
- `load_target_profile(profile_root, target) -> TargetProfile`
- `build_managed_env(base_env, paths, target_profile, runtime_vars) -> dict[str, str]`
- `redact_env_for_logs(env) -> dict[str, str]`
- `assert_raw_command_allowed(command_name, env) -> None`

Raw command gate:

- If `QUORUM_MANAGED_HOST=1` and `QUORUM_MANAGED_WORKER` is not `1`, block
  `run` and `run-all`.
- Exit with code `2`.
- Print a short actionable message:

```text
raw live eval commands are disabled on the managed Quorum host; use quorum smoke, quorum column, or quorum batch
```

Environment threading:

- `setup_step._run_scenario_script` accepts `env_base` and uses it instead of
  `os.environ` when provided.
- `checks.run_phase` accepts `env_base` and uses it instead of `os.environ` when
  provided.
- `runner.run_scenario` and `_run_scenario_inner` accept a runtime environment
  object, then pass sanitized env to setup, checks, and Gauntlet.
- `run_all.run_batch` accepts `env_base` and passes it to child `quorum run`
  subprocesses.
- `opencode_capture` stops treating provider secrets as a broad global allowlist
  in managed mode. In managed mode, it receives the exact target env from
  `runtime_env`.
- `coding-agents/opencode-context/launch-agent` narrows env forwarding in
  managed mode to the selected profile variables.

Tests:

- On a managed host, `quorum run` exits `2` and does not invoke runner code.
- On a managed host, `quorum run-all` exits `2` and does not invoke batch code.
- With `QUORUM_MANAGED_WORKER=1`, raw commands are allowed.
- Poison ambient env values such as `OPENAI_API_KEY=ambient-poison` and
  `ANTHROPIC_API_KEY=ambient-poison` do not reach setup, checks, child
  `quorum run`, Gauntlet, or OpenCode launch env unless the selected target
  profile explicitly contains them.
- Redaction preserves key names and replaces values with `[redacted]`.

Verification:

```bash
uv run pytest tests/quorum/test_runtime_env.py tests/quorum/test_cli.py -q
uv run pytest tests/quorum/test_runner.py tests/quorum/test_setup_step.py tests/quorum/test_checks.py tests/quorum/test_run_all.py tests/quorum/test_opencode_capture.py -q
uv run ruff check quorum/runtime_env.py quorum/cli.py quorum/runner.py quorum/setup_step.py quorum/checks.py quorum/run_all.py quorum/opencode_capture.py tests/quorum
uv run ty check quorum/runtime_env.py quorum/cli.py quorum/runner.py quorum/setup_step.py quorum/checks.py quorum/run_all.py quorum/opencode_capture.py
```

Commit:

```bash
git add quorum/runtime_env.py quorum/cli.py quorum/runner.py quorum/setup_step.py quorum/checks.py quorum/run_all.py quorum/opencode_capture.py coding-agents/opencode-context/launch-agent tests/quorum
git commit -m "Sanitize managed quorum runtime environment"
```

### Task 4: Target Doctor

Files:

- Add `quorum/doctor.py`
- Add `tests/quorum/test_doctor.py`
- Modify `quorum/cli.py`
- Modify `coding-agents/*.yaml` only when a target lacks enough checked-in
  metadata to map it to provider/profile requirements

Implement:

- `DoctorStatus` enum with `ready`, `blocked`, `failed`.
- `DoctorCheck` record with `name`, `status`, `message`, and optional
  `remediation`.
- `run_target_doctor(target, paths, env) -> TargetDoctorResult`.
- `run_all_doctors(paths, env) -> list[TargetDoctorResult]`.

Doctor checks:

- Coding-agent config exists.
- Target profile file exists when managed host mode is active.
- Target profile file permissions are not group/world writable.
- Required credential variables for the target are present in the profile.
- Required local tools exist on `PATH`.
- Required context/home skeleton directories exist.
- Existing Quorum scenario metadata can select at least one runnable sentinel
  scenario for that target.

Exit codes:

- `quorum doctor <target>`
  - `0` when target is ready.
  - `3` when target is blocked by missing credentials or a known unavailable
    local tool.
  - `1` when the doctor itself fails.
- `quorum doctor --all`
  - `0` when every checked target is ready or blocked.
  - `1` when any target has doctor failure.

Output:

- Human-readable table by default.
- `--json` returns stable JSON for automation.

Tests:

- Ready target returns exit `0`.
- Missing profile on managed host returns blocked with exit `3` for one target.
- Missing profile under `--all` is reported as blocked while command exits `0`.
- Bad profile permissions are blocked and include remediation.
- Missing coding-agent YAML is failed and exits `1`.
- `--json` output includes target, status, checks, and remediation strings.

Verification:

```bash
uv run pytest tests/quorum/test_doctor.py tests/quorum/test_cli.py -q
uv run ruff check quorum/doctor.py quorum/cli.py tests/quorum/test_doctor.py
uv run ty check quorum/doctor.py quorum/cli.py
```

Commit:

```bash
git add quorum/doctor.py quorum/cli.py coding-agents tests/quorum/test_doctor.py tests/quorum/test_cli.py
git commit -m "Add quorum target doctor"
```

### Task 5: Managed Worker, Supervisor, Status, and Tail

Files:

- Add `quorum/managed_commands.py`
- Add `tests/quorum/test_managed_commands.py`
- Modify `quorum/cli.py`
- Modify `quorum/managed_state.py`

Implement:

- `create_job(kind, target, args, paths, owner) -> ManagedJob`
- `run_managed_worker(job_id, paths, env) -> int`
- `start_job(job, paths, supervisor) -> StartResult`
- `status_summary(paths, limit, include_finished) -> list[ManagedJob]`
- `tail_job(job_id, child_id=None, follow=False) -> Iterator[str]`

Supervisor:

- Create a small supervisor interface with two implementations:
  - `InlineSupervisor` for tests.
  - `TmuxSupervisor` for the AWS host.
- Use `tmux new-session -d -s quorum-<job-id> -- <worker command>` for Phase
  1. This avoids building a daemon and keeps SSH/SSM operations inspectable.
- The worker command is:

```bash
env QUORUM_MANAGED_WORKER=1 uv run quorum managed-worker <job-id>
```

CLI:

- Add public commands:
  - `status`
  - `tail`
- Add hidden/internal command:
  - `managed-worker`

Status behavior:

- `quorum status` shows active jobs first, then recent terminal jobs.
- `quorum status <job-id>` shows job detail and child records.
- `--json` emits stable JSON.

Tail behavior:

- Parent job tail reads `$QUORUM_STATE_ROOT/events/<job-id>.jsonl` and the
  parent stdout/stderr file if present.
- Child tail resolves from the child record to the underlying run or batch log.
- `--follow` follows appended bytes until the job reaches a terminal status.

Tests:

- Creating a job writes state `planned` and a creation event.
- Inline supervisor starts a worker and transitions `planned` to `running` to
  `succeeded`.
- Worker marks failed with exit code when the underlying command raises.
- Status sorts active before terminal jobs.
- Status JSON is parseable and contains child records.
- Tail returns parent events.
- Tail returns child log content when child ID is supplied.
- Hidden worker command is callable directly in tests.

Verification:

```bash
uv run pytest tests/quorum/test_managed_commands.py tests/quorum/test_cli.py -q
uv run ruff check quorum/managed_commands.py quorum/cli.py quorum/managed_state.py tests/quorum/test_managed_commands.py
uv run ty check quorum/managed_commands.py quorum/cli.py quorum/managed_state.py
```

Commit:

```bash
git add quorum/managed_commands.py quorum/cli.py quorum/managed_state.py tests/quorum/test_managed_commands.py tests/quorum/test_cli.py
git commit -m "Add managed quorum worker and status commands"
```

### Task 6: Smoke, Column, Batch, Children, and Result Rollup

Files:

- Modify `quorum/managed_commands.py`
- Modify `quorum/cli.py`
- Modify `quorum/run_all.py`
- Modify `quorum/runner.py`
- Add or extend `tests/quorum/test_managed_commands.py`
- Extend `tests/quorum/test_run_all.py`
- Extend `tests/quorum/test_runner.py`

Implement commands:

- `quorum smoke <target>`
  - Selects the configured smoke scenario for the target.
  - Runs one `quorum run` inside a managed worker.
  - Records `run_dir` in the job.
- `quorum column <target> --jobs N`
  - Equivalent to `quorum batch --coding-agent <target> --tier sentinel --jobs N`.
  - Records one child per scenario/target cell.
- `quorum batch`
  - Wraps existing `run-all`.
  - Requires at least one explicit target or `--all-ready-targets`.
  - Defaults to `--tier sentinel`.
  - Accepts `--include-drafts` only when explicitly passed.

Add run-all seams:

```python
def run_batch(
    *,
    scenarios_root: Path,
    coding_agents_dir: Path,
    out_root: Path,
    jobs: int,
    agent_filter: list[str] | None,
    scenario_filter: list[str] | None = None,
    tier: str | None = None,
    include_drafts: bool = False,
    invoke: Callable | None = None,
    stream: TextIO | None = None,
    use_cursor: bool = True,
    env_base: Mapping[str, str] | None = None,
    on_batch_allocated: Callable[[Path], None] | None = None,
    on_child_started: Callable[[str, MatrixEntry, list[str]], None] | None = None,
    on_child_finished: Callable[[str, ChildResult], None] | None = None,
) -> Path:
```

- Call `on_batch_allocated(batch_dir)` immediately after batch dir allocation.
- Call `on_child_started(child_id, matrix_entry, command)` before launching each
  child process.
- Call `on_child_finished(child_id, child_result)` after each child exits.
- Preserve current behavior when callbacks are not supplied.

Add runner seams:

- Expose a public helper that can run a scenario into a managed run directory
  chosen by the caller:

```python
def run_scenario_in_dir(
    *,
    run_dir: Path,
    scenario_dir: Path,
    coding_agent: str,
    coding_agents_dir: Path,
    out_root: Path,
    skeleton_root: Path | None = None,
    env_base: Mapping[str, str] | None = None,
) -> tuple[Path, FinalVerdict]:
```

Use it from the managed smoke command so the job can record the run directory
before the child completes.

Result rollup:

- Parent managed job state is `succeeded` when the batch command completes and
  writes expected artifacts, even when some eval cells fail.
- `result_rollup` is `pass` only when every child verdict passed.
- `result_rollup` is `fail` when any child verdict failed.
- `result_rollup` is `indeterminate` when no child failed and at least one child
  is indeterminate.
- Preserve skipped/rate-limited child reasons in `children`.
- If a provider cooldown is written, include it in the parent job `cooldowns`
  list.

Tests:

- `smoke claude` enqueues and runs one child with managed env.
- `column claude --jobs 2` calls `run_batch` with `tier=sentinel`,
  `coding_agent_filter=["claude"]`, and `jobs=2`.
- `batch --all-ready-targets` expands only doctor-ready targets.
- `batch` without a target or `--all-ready-targets` exits `2`.
- Child callbacks produce child job records with stable IDs.
- Mixed child verdicts roll up according to the result rollup rules.
- Rate-limit sentinel results write provider cooldown and preserve skipped
  child reason.
- Existing `run-all` tests still pass without callbacks.

Verification:

```bash
uv run pytest tests/quorum/test_managed_commands.py tests/quorum/test_run_all.py tests/quorum/test_runner.py tests/quorum/test_cli.py -q
uv run ruff check quorum/managed_commands.py quorum/cli.py quorum/run_all.py quorum/runner.py tests/quorum
uv run ty check quorum/managed_commands.py quorum/cli.py quorum/run_all.py quorum/runner.py
```

Commit:

```bash
git add quorum/managed_commands.py quorum/cli.py quorum/run_all.py quorum/runner.py tests/quorum
git commit -m "Add managed quorum smoke column and batch commands"
```

### Task 7: Secret Scan and Tainting

Files:

- Add `quorum/secret_scan.py`
- Add `tests/quorum/test_secret_scan.py`
- Modify `quorum/managed_commands.py`
- Modify `quorum/managed_state.py`

Implement:

- `SecretPattern`
- `build_secret_patterns(target_profile) -> list[SecretPattern]`
- `scan_path_for_secrets(path, patterns) -> SecretScanResult`
- `scan_job_artifacts(job, patterns) -> SecretScanResult`
- `taint_job_on_secret_match(paths, job, result) -> ManagedJob`

Patterns:

- Exact value match for each secret value loaded from the target profile.
- High-signal provider patterns:
  - OpenAI keys beginning with `sk-`.
  - Anthropic keys beginning with `sk-ant-`.
  - GitHub tokens beginning with `ghp_`, `github_pat_`, or `gho_`.
  - Gemini or Google API keys beginning with `AIza`.
  - AWS access key IDs beginning with `AKIA` or `ASIA`.

Redaction:

- Never write the matched secret value to the scan result.
- Store file path, byte offset, pattern name, and short digest:

```json
{
  "path": "/opt/quorum/artifacts/runs/example/stdout.txt",
  "offset": 128,
  "pattern": "ANTHROPIC_API_KEY",
  "digest": "sha256:12ab34cd"
}
```

Worker behavior:

- After every managed child and at parent finalization, scan the known run/batch
  artifacts.
- If a match is found, mark the job `tainted`, append a taint event, and exit
  nonzero.
- Do not delete artifacts in Phase 1. Operators need them for incident review.

Tests:

- Exact secret value is detected in nested artifact files.
- High-signal provider pattern is detected without a profile value.
- Redaction result does not contain the secret.
- Managed worker marks a `succeeded` job as tainted when scan finds a secret.
- Clean artifacts leave the original job state unchanged.

Verification:

```bash
uv run pytest tests/quorum/test_secret_scan.py tests/quorum/test_managed_commands.py -q
uv run ruff check quorum/secret_scan.py quorum/managed_commands.py quorum/managed_state.py tests/quorum/test_secret_scan.py
uv run ty check quorum/secret_scan.py quorum/managed_commands.py quorum/managed_state.py
```

Commit:

```bash
git add quorum/secret_scan.py quorum/managed_commands.py quorum/managed_state.py tests/quorum/test_secret_scan.py tests/quorum/test_managed_commands.py
git commit -m "Taint managed quorum jobs on secret leakage"
```

### Task 8: Terminus Terraform Service Root

Repository:

- `/Users/drewritter/prime-rad/brooks/terminus`

Files:

- Add `terraform/quorum-evals/backend.tf`
- Add `terraform/quorum-evals/data.tf`
- Add `terraform/quorum-evals/variables.tf`
- Add `terraform/quorum-evals/main.tf`
- Add `terraform/quorum-evals/dlm.tf`
- Add `terraform/quorum-evals/outputs.tf`
- Add `terraform/quorum-evals/templates/userdata.sh.tftpl`
- Add `terraform/quorum-evals/scripts/quorum-volume-bootstrap.sh`
- Add `terraform/quorum-evals/README.md`
- Add `docs/runbooks/quorum-evals-operations.md`
- Add bootstrap script tests using the existing Terminus shell-test pattern from
  the Brainstorm volume bootstrap coverage.

Terraform shape:

- Backend:
  - Bucket: existing Terminus state bucket from local convention.
  - Key: `quorum-evals/terraform.tfstate`.
  - Region: `us-west-1`.
- Remote state:
  - Reuse the existing infra state for VPC/subnet/security group references.
- Instance:
  - Use `module "quorum_evals"` with `../modules/machine-westworld`.
  - Instance type default is `c7i.4xlarge`: 16 vCPU and 32 GiB RAM.
  - Keep `var.instance_type` configurable for a measured Phase 1b resize.
  - Root volume encrypted.
  - IMDSv2 required by the module.
  - Tailscale enabled using the same pattern as existing Terminus machines.
- Persistent EBS:
  - Size: 500 GiB for Phase 1.
  - Type: `gp3`.
  - Encrypted: true.
  - `prevent_destroy`: true.
  - Tags:
    - `Backup = "dlm"`
    - `Service = "quorum-evals"`
    - `DataClass = "eval-artifacts"`
- Attachment:
  - Attach persistent EBS to the instance.
- Backups:
  - Add Terraform-managed DLM policy for the quorum evals volume.
  - Hourly or every-2-hours retention that matches current Terminus stateful
    machine patterns.
- SSM parameters:
  - Create initial `aws_ssm_parameter` resources with `ignore_changes =
    [value]` for each target profile secret.
  - Paths:

```text
/quorum-evals/targets/claude/ANTHROPIC_API_KEY
/quorum-evals/targets/codex/OPENAI_API_KEY
/quorum-evals/targets/opencode/OPENAI_API_KEY
/quorum-evals/targets/opencode/ANTHROPIC_API_KEY
/quorum-evals/targets/opencode/OPENROUTER_API_KEY
/quorum-evals/targets/kimi/KIMI_API_KEY
/quorum-evals/targets/gemini/GEMINI_API_KEY
/quorum-evals/targets/copilot/GITHUB_TOKEN
```

IAM:

- Add a service-specific policy in the `quorum-evals` root rather than relying
  only on the broad module SSM prefix.
- Permit `ssm:GetParameter`, `ssm:GetParameters`, and `ssm:GetParametersByPath`
  only for:

```text
arn:aws:ssm:us-west-1:<account-id>:parameter/quorum-evals/*
```

- Permit decrypt only via SSM in `us-west-1` using a `kms:ViaService`
  condition.
- Do not grant write access to SSM from the instance role.

Userdata:

- Install system packages required for Quorum and common scenario toolchains:
  - Python 3.11 or the distro-supported Python plus uv-managed Python.
  - Git.
  - uv.
  - Node.js/npm when required by current scenarios.
  - tmux.
  - jq.
  - ripgrep.
- Create:

```text
/opt/quorum/current
/opt/quorum/state
/opt/quorum/artifacts
/opt/quorum/worktrees
/opt/quorum/cache
/etc/quorum/target-profiles.d
```

- Create group `quorum`.
- Ensure target profiles are root-owned and group-readable by `quorum`.
- Mount persistent EBS using the bootstrap script.
- Fetch SSM parameters into target profile files on boot.
- Do not echo secret values.
- Sync or clone the `superpowers-evals` repo into `/opt/quorum/current`.
- Run `uv sync --extra dev` in `/opt/quorum/current`.

Bootstrap script requirements:

- Refuse to format an already formatted volume.
- Refuse to mount the root disk.
- Refuse unknown device identity.
- Mount by filesystem UUID after first initialization.
- Create directories with stable ownership and permissions.
- Be idempotent across reboots.

Runbook:

- How to connect through SSM Session Manager.
- How to check `quorum status`.
- How to run `doctor`, `smoke`, and `column`.
- How to update target secrets.
- How to check DLM snapshot freshness.
- How to restore the EBS volume into a replacement instance.
- How to respond to a tainted job.
- How to stop/start the instance without destroying state.

Verification:

```bash
cd /Users/drewritter/prime-rad/brooks/terminus/terraform/quorum-evals
terraform fmt -check
terraform init
terraform validate
terraform plan
```

Also run the bootstrap script tests added in the Terminus repo.

Commit in Terminus:

```bash
git add terraform/quorum-evals docs/runbooks/quorum-evals-operations.md
git commit -m "Add quorum evals runner infrastructure"
```

### Task 9: Managed Host Dry Run

Repositories:

- `/Users/drewritter/prime-rad/superpowers-evals`
- `/Users/drewritter/prime-rad/brooks/terminus`

Preconditions:

- Terraform plan reviewed.
- Target SSM SecureString parameters exist.
- At least one real target secret is written out of band.
- Instance role has read-only access to `/quorum-evals/*`.

Apply:

```bash
cd /Users/drewritter/prime-rad/brooks/terminus/terraform/quorum-evals
terraform plan -out=tfplan
terraform apply tfplan
```

On-host verification through SSM:

```bash
cd /opt/quorum/current
uv sync --extra dev
QUORUM_MANAGED_HOST=1 uv run quorum doctor --all
QUORUM_MANAGED_HOST=1 uv run quorum doctor claude
QUORUM_MANAGED_HOST=1 uv run quorum smoke claude
QUORUM_MANAGED_HOST=1 uv run quorum status
QUORUM_MANAGED_HOST=1 uv run quorum tail <job-id>
QUORUM_MANAGED_HOST=1 uv run quorum column claude --jobs 1
QUORUM_MANAGED_HOST=1 uv run quorum status <job-id> --json
```

Raw command gate smoke:

```bash
QUORUM_MANAGED_HOST=1 uv run quorum run-all --coding-agent claude --tier sentinel
```

Expected:

- Exit code `2`.
- Message points to managed commands.
- No Quorum run artifacts are created by the blocked raw command.

Lock smoke:

```bash
QUORUM_MANAGED_HOST=1 uv run quorum column claude --jobs 1
QUORUM_MANAGED_HOST=1 uv run quorum column claude --jobs 1
QUORUM_MANAGED_HOST=1 uv run quorum status
```

Expected:

- First job starts or runs.
- Second job queues or reports the conflicting holder.
- Host active child count does not exceed configured capacity.

Disconnect smoke:

1. Start a `column` job through SSM.
2. Close the SSM session.
3. Reconnect through SSM.
4. Run `quorum status` and `quorum tail <job-id>`.

Expected:

- Job continues after disconnect.
- Status and tail can find the job.

Evidence to capture in the implementation PR:

- Terraform plan summary.
- `doctor --all` output.
- One `smoke` job ID and result.
- One `column` job ID and result.
- Raw command gate output.
- Lock smoke output.
- DLM snapshot freshness check.

### Task 10: Phase 1b Sentinel Campaign

Phase 1b begins after one target completes Phase 1a smoke and column evidence.

Steps:

1. Add or verify secrets for a second key-backed target.
2. Run:

```bash
QUORUM_MANAGED_HOST=1 uv run quorum doctor --all
QUORUM_MANAGED_HOST=1 uv run quorum column claude --jobs 2
QUORUM_MANAGED_HOST=1 uv run quorum column codex --jobs 2
```

3. Increase `QUORUM_MAX_ACTIVE_CHILDREN` only after evidence shows CPU,
   memory, disk IO, and provider limits are healthy.
4. Run:

```bash
QUORUM_MANAGED_HOST=1 uv run quorum batch --all-ready-targets --tier sentinel --jobs 2
```

5. Record:
   - Total runtime.
   - Max active child count.
   - Rate-limit cooldowns.
   - Fail/indeterminate distribution.
   - Any target-specific environment or toolchain blockers.

Exit criteria:

- At least two key-backed targets are doctor-ready.
- Sentinel campaign can run without an interactive laptop session.
- Multiple user jobs are safe: one active batch at a time, bounded child
  concurrency, clear conflict status.
- Raw live eval commands fail closed on the AWS host.
- Job logs can be tailed after disconnect.
- No known secret leakage in managed logs or artifacts.

## Global Verification Before PR

In `superpowers-evals`:

```bash
uv run ruff check
uv run ty check
uv run quorum check
uv run pytest
```

In `brooks/terminus`:

```bash
cd /Users/drewritter/prime-rad/brooks/terminus/terraform/quorum-evals
terraform fmt -check
terraform validate
terraform plan
```

Run any Terminus bootstrap script tests added for `quorum-evals`.

## PR Description Checklist

Include:

- Link to the master story/ticket.
- Phase implemented: Phase 1a, Phase 1b, or both.
- Managed command examples.
- Concurrency defaults.
- Secret-profile behavior.
- Raw-command gate behavior.
- Terraform plan summary.
- Verification outputs.
- Known targets that are ready.
- Known targets that are blocked and why.

## Not In Phase 1

Do not build these in this implementation:

- Web UI.
- Database-backed job store.
- SQS, EventBridge, ECS, Batch, or Kubernetes scheduler.
- Multi-host sharding.
- Per-user authentication or authorization beyond AWS/SSM access.
- Long-term artifact retention policy beyond encrypted EBS plus DLM snapshots.
- Automatic eval result trend dashboards.
- Agent-issued arbitrary shell command API.

Those are platform evolution candidates after Phase 1 proves shared remote eval
runs are useful and safe.
