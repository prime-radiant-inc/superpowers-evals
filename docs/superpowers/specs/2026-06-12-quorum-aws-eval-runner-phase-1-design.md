# Quorum AWS Eval Runner Phase 1 - design specification

**Status:** Draft for Drew review.
**Date:** 2026-06-12
**Tracker:** PRI-2205
**Parent spec:** `docs/superpowers/specs/2026-06-12-quorum-aws-eval-runner-design.md`

---

## Goal

Phase 1 creates the smallest useful shared AWS runner for trusted Quorum live
evals.

The outcome is a remote Quorum workstation, not a full eval platform:

- agents SSH to a Terminus-managed host;
- agents operate through first-class `uv run quorum ...` commands;
- live runs have durable job records, durable logs, and host-global locks;
- every target has a host-managed, key-backed readiness contract;
- results remain ordinary Quorum artifacts that `quorum show` can render.

Phase 1 should be platform-shaped without being a platform service. The command
surface should survive later queue, API, UI, Slack, or disposable-worker
backends, but those backends are not built now.

## Non-goals

- Web UI.
- Slack submission bot.
- Long-running queue daemon.
- Custom scheduler service.
- Multi-host parallelism.
- S3 archive, promotion, compare, cleanup, or private result index.
- Public CI live evals.
- Running untrusted PRs or generated scenario code on the shared host.
- Strong per-run sandbox isolation.
- Personal OAuth, browser, keyring, or subscription auth as supported runtime
  dependencies.

## Current Constraints

The local repository already has the primitive run surface:

- `quorum run` runs one scenario against one Coding-Agent.
- `quorum run-all` runs a scenario-by-agent matrix and writes
  `results/batches/<batch-id>/`.
- `quorum show` renders run and batch verdicts from local artifacts.

Phase 1 should wrap those primitives rather than replace them.

Important current behavior:

- `run-all --jobs` is a process-local worker-pool size. It is not a host-wide
  live-cell cap.
- Agents with `max_concurrency` in `coding-agents/*.yaml` get dedicated lanes
  beside the shared `--jobs` pool. A broad `run-all` can therefore exceed the
  numeric `--jobs` count.
- `max_concurrency` is process-local. Two SSH sessions can currently violate
  the same target cap unless Quorum adds host-global locks.
- `run-all` excludes `status: draft` scenarios unless `--include-drafts` is
  set. A target smoke command must include draft smoke scenarios deliberately
  when the target's bootstrap smoke is still draft.
- Current target auth is mixed:
  - Claude-family targets are API-key-backed through `ANTHROPIC_API_KEY`.
  - Gemini is API-key-backed by default through `GEMINI_API_KEY`.
  - Kimi is API-key-backed through `KIMI_MODEL_API_KEY`.
  - Pi is API-key-backed through `PI_PROVIDER`, `PI_MODEL`, and `PI_API_KEY`.
  - Copilot has provider-mode support through `COPILOT_PROVIDER_*`.
  - OpenCode runs from provider key env such as `OPENAI_API_KEY`.
  - Codex currently requires copied ChatGPT subscription auth and strips
    OpenAI API-key env in its launcher.
  - Antigravity currently preflights Code Assist browser/keyring auth.

Phase 1 must make that mixed auth reality explicit. It should not quietly call
a target supported because a developer happened to be logged in on the host.

## Direction

Use one long-lived Terminus host plus a small Quorum managed-job layer.

The split is:

- **Terminus owns the host.** Terraform creates the EC2 instance, EBS volume,
  IAM role, SSM parameter inventory, Tailscale access, backup tags, and
  bootstrap.
- **Quorum owns live-eval operation.** Quorum creates job metadata, logs,
  target readiness checks, sanitized env files, host-global locks, and the
  managed command wrappers over `run` / `run-all`.

There is no separate `qrun` command, HTTP API, daemon, or queue in Phase 1.

## Operator Workflow

The happy path should look like this:

```bash
ssh quorum-evals
cd /opt/quorum/repos/superpowers-evals

uv run quorum doctor --all
uv run quorum smoke claude
uv run quorum column claude
uv run quorum batch --profile sentinel-default
uv run quorum status
uv run quorum tail <job-id>
uv run quorum show <batch-id> --results-root /opt/quorum/results
```

Managed live commands print the job id and durable log path early. If the SSH
session disconnects, the run continues under its supervisor. Another agent can
later use `status`, `tail`, and `show` to recover.

## Terminus Host

Create a single service root in the Terminus repo for the Phase 1 host:

```text
terraform/quorum-evals/
```

The Terraform state should be scoped to the Quorum eval runner and not mixed
into an unrelated service root.

Use the existing `machine-westworld` module for the named EC2 instance:

- Region: `us-west-1`.
- Instance name: `quorum-evals`.
- Instance type: `m6i.2xlarge` on-demand.
- Root volume: 100 GB encrypted gp3.
- Security group: outbound only, no inbound application ports.
- Access: Tailscale SSH and SSM Session Manager.
- Managed policies: SSM managed instance support.
- IAM: SSM read for `/quorum-evals/*` and no broader secret prefixes.

Add the data volume in the service root, following the existing Brainstorm and
monitoring EBS patterns:

- 500 GB encrypted gp3 data volume.
- Attached to the `quorum-evals` instance.
- Mounted at `/opt/quorum`.
- `prevent_destroy = true`.
- Backup/discovery tags for snapshot policy.
- A backup freshness check in the operational runbook before the host is
  considered durable.

Use on-demand for Phase 1. Spot and stop/start scheduling are later cost
optimizations once interruption behavior is measured.

## Host Layout

The host keeps mutable eval state under `/opt/quorum`:

```text
/opt/quorum/
├── repos/
│   ├── superpowers/
│   └── superpowers-evals/
├── worktrees/
├── results/
├── state/
│   ├── jobs/
│   ├── locks/
│   └── logs/
└── secrets-runtime/
```

Default paths:

- `SUPERPOWERS_ROOT=/opt/quorum/repos/superpowers`
- eval repo: `/opt/quorum/repos/superpowers-evals`
- results root: `/opt/quorum/results`
- state root: `/opt/quorum/state`

Local development and tests may use a repo-local state root such as
`<out-root>/.quorum/`, but the AWS host must use `/opt/quorum/state` so locks
cannot be bypassed by changing `--out-root`.

Set `QUORUM_STATE_ROOT=/opt/quorum/state` in the host Quorum environment. The
managed-command implementation should prefer that env var when present and
fall back to local state only outside the host.

## User And Process Model

Team members should have separate Unix accounts. Phase 1 jobs run as the
invoking Unix user.

This preserves basic auditability and avoids same-UID process snooping between
operators. Phase 1 does not need a shared `quorum-runner` service account.

Operator accounts should not have:

- passwordless `sudo`;
- wheel/admin group membership;
- Docker socket access.

Bootstrap and secret sync can run as root through cloud-init, SSM, or an
explicit operator action. Live eval child processes should run as the operator.

## Target Readiness Contract

Phase 1 supports all targets through host-managed eval credentials, but a
target is usable only after `doctor` proves the target's key-backed path works.

Definition of ready:

```bash
uv run quorum doctor <target>
```

must prove that:

- the target binary exists;
- required Superpowers files exist under `SUPERPOWERS_ROOT`;
- required provider credentials are available from the host-managed profile;
- a sanitized run environment can be built without inheriting personal shell
  secrets;
- the target can authenticate without personal OAuth, browser, keyring, or
  subscription state;
- any target-specific preflight passes or fails with a redacted diagnostic.

`doctor --all` reports every target as `ready`, `blocked`, or `failed`.

Meanings:

- `ready`: the target can run from host-managed eval credentials.
- `blocked`: Quorum does not yet have a key-backed adapter for this target, or
  the provider CLI does not expose one that has been verified locally.
- `failed`: the target has a key-backed adapter, but this host is missing a
  binary, secret, repo file, or provider preflight.

Blocked targets are still in Phase 1 scope. They are not counted as supported
until their key-backed adapter work lands.

### Phase 1 Credential Profiles

Use SSM SecureString parameters under `/quorum-evals/*`. Terraform owns the
parameter inventory with placeholder values and ignores secret value changes.

Initial credential families:

| Target | Credential contract |
| --- | --- |
| `claude` | `ANTHROPIC_API_KEY`, `SUPERPOWERS_ROOT` |
| `claude-haiku` | `ANTHROPIC_API_KEY`, `SUPERPOWERS_ROOT` |
| `claude-sonnet` | `ANTHROPIC_API_KEY`, `SUPERPOWERS_ROOT` |
| `gemini` | `GEMINI_API_KEY`, `SUPERPOWERS_ROOT`, `GEMINI_AUTH_TYPE=gemini-api-key` |
| `kimi` | `KIMI_MODEL_API_KEY`, optional `KIMI_MODEL_NAME`, `SUPERPOWERS_ROOT` |
| `pi` | `PI_PROVIDER`, `PI_MODEL`, `PI_API_KEY`, optional provider extras, `SUPERPOWERS_ROOT` |
| `copilot` | provider-mode `COPILOT_PROVIDER_*`, `SUPERPOWERS_ROOT` |
| `opencode` | explicit provider key env and pinned model, `SUPERPOWERS_ROOT` |
| `codex` | key-backed Codex mode to be implemented and verified; no ChatGPT subscription auth |
| `antigravity` | key-backed Antigravity mode to be implemented and verified; no Code Assist browser/keyring auth |

For `codex` and `antigravity`, the implementation must verify the current CLI
auth surface before choosing exact env names or flags. Until that is done,
`doctor codex` and `doctor antigravity` should return `blocked`, not silently
fall back to personal login state.

## Secrets Runtime

The host materializes restricted target env files under:

```text
/opt/quorum/secrets-runtime/<target>.env
```

Recommended ownership:

- `root:quorum-operators`
- mode `0640`

Managed Quorum commands copy the selected target profile into a per-job env
file with mode `0600`, preferably under a tmpfs location. The per-job env file
is deleted when the job finishes.

Live child processes receive an allowlisted environment, not the invoking
shell's full `os.environ`.

Allowed env classes:

- `PATH`, `HOME`, `TERM`, locale, certificate, and proxy variables required by
  the CLI;
- Quorum runtime paths such as `SUPERPOWERS_ROOT`, `QUORUM_STATE_ROOT`, and the
  per-target config-dir env;
- selected provider credentials for the target being run;
- target-specific non-secret model/provider config.

Disallowed Phase 1 runtime dependencies:

- `~/.codex/auth.json` ChatGPT subscription auth;
- `~/.gemini/oauth_creds.json`;
- browser cookies;
- macOS keychain or Linux keyring state;
- a developer's personal GitHub/Copilot login;
- credentials embedded in proxy URLs.

## Managed Job Model

Every managed live command creates a job record before launching the child run:

```text
/opt/quorum/state/jobs/<job-id>.json
/opt/quorum/state/logs/<job-id>.log
```

Job ids use a sortable timestamp and short random suffix:

```text
job-20260612T190000Z-a1b2
```

Initial states:

- `planned`: metadata written, locks not yet acquired.
- `running`: supervisor is active and locks are held.
- `succeeded`: child command exited successfully.
- `failed`: child command exited with a nonzero managed-command failure.
- `interrupted`: supervisor observed interruption or child termination.
- `orphaned`: metadata exists, but the recorded supervisor is gone and the
  final child state cannot be determined.

Phase 1 should fail fast on lock conflict. It should not implement a queue.
Queued/waiting states belong to a later platform phase.

Minimum `job.json` schema:

```json
{
  "schema_version": 1,
  "id": "job-20260612T190000Z-a1b2",
  "state": "running",
  "owner": "drew",
  "host": "quorum-evals",
  "command": ["quorum", "batch", "--profile", "sentinel-default"],
  "managed_command": "batch",
  "profile": "sentinel-default",
  "coding_agents": ["claude", "gemini"],
  "scenario_filter": null,
  "tier": "sentinel",
  "include_drafts": false,
  "out_root": "/opt/quorum/results",
  "log_path": "/opt/quorum/state/logs/job-20260612T190000Z-a1b2.log",
  "locks": ["global:broad-batch", "target:claude", "target:gemini"],
  "env_profiles": ["claude", "gemini"],
  "evals_repo": {
    "path": "/opt/quorum/repos/superpowers-evals",
    "branch": "main",
    "sha": "abc123",
    "dirty": false
  },
  "superpowers_repo": {
    "path": "/opt/quorum/repos/superpowers",
    "branch": "main",
    "sha": "def456",
    "dirty": false
  },
  "supervisor": {
    "kind": "tmux",
    "name": "quorum-job-20260612T190000Z-a1b2",
    "pid": 12345
  },
  "children": [],
  "started_at": "2026-06-12T19:00:00Z",
  "finished_at": null,
  "final_exit_code": null
}
```

The schema is intentionally additive. Existing `batch.json`, `results.jsonl`,
and `verdict.json` readers should not need to understand job records.

## Supervisor

Use a host-native supervisor for Phase 1, preferably `tmux` because the eval
workflow already uses terminal sessions and it is easy for agents to inspect.

Requirements:

- the supervisor process, not the initiating CLI process, holds lock file
  descriptors for the lifetime of the child run;
- stdout and stderr from the child command append to the durable job log;
- the initiating CLI can stream the log while connected;
- SSH disconnect does not terminate the child run;
- `status` can detect whether the supervisor is still alive.

`systemd-run --user` or transient system services are acceptable only if they
meet the same lock and log requirements without adding a custom daemon.

## Locking And Concurrency

Host-global locks live under:

```text
/opt/quorum/state/locks/
```

Use `fcntl.flock` or an equivalent open-file-descriptor lock. JSON sidecars may
be written for diagnostics, but the open descriptor is the source of truth so
killed supervisors release locks automatically.

Acquire locks in deterministic order:

1. global locks;
2. provider locks;
3. target locks.

Initial locks:

| Lock | Purpose |
| --- | --- |
| `global:broad-batch` | Prevent overlapping broad campaigns. |
| `provider:anthropic` | Conservative Claude-family coordination. |
| `provider:openai` | Codex/OpenCode/OpenAI-backed provider coordination. |
| `provider:google` | Gemini/Antigravity coordination. |
| `provider:kimi` | Kimi provider coordination. |
| `provider:copilot` | Copilot provider coordination. |
| `target:<name>` | Prevent same-target overlap across SSH sessions. |

Phase 1 locking policy:

- `doctor`: no locks unless it performs a live provider preflight.
- `smoke <target>`: `target:<target>` plus provider lock.
- `column <target>`: `target:<target>` plus provider lock.
- `batch sentinel-default`: `global:broad-batch` plus selected target/provider
  locks.

On conflict, Quorum exits nonzero and reports:

- lock name;
- owning job id if known;
- owning user if known;
- owning command if known;
- job log path if known.

No queueing is required in Phase 1.

## Commands

### `quorum doctor`

Purpose: report whether the host can run one or more targets from key-backed
eval credentials.

Shape:

```bash
uv run quorum doctor <target>
uv run quorum doctor --all
uv run quorum doctor <target> --json
```

Checks:

- repo path and `SUPERPOWERS_ROOT`;
- target YAML loads and required Superpowers files exist;
- target binary exists;
- host state root and output root are writable;
- required secret profile exists;
- target env can be sanitized and materialized;
- target auth mode is not personal login state;
- target-specific preflight passes when safe to run.

`doctor` should redact secret values in all output.

### `quorum smoke`

Purpose: run the canonical smoke/bootstrap scenario for one target.

Shape:

```bash
uv run quorum smoke <target>
```

Behavior:

- runs as a managed job;
- validates `doctor <target>` first;
- acquires target/provider locks;
- uses `jobs=1`;
- includes draft smoke scenarios deliberately when the target's smoke scenario
  is still draft;
- writes the job log;
- prints job id, run id, final verdict, and the `quorum show` command.

Smoke mapping should be explicit and tested. Claude-family and Codex targets
use `00-quorum-smoke-hello-world` unless a target-specific bootstrap scenario
is configured. Targets with bootstrap scenarios use those scenarios.

### `quorum column`

Purpose: run all runnable scenarios for one target.

Shape:

```bash
uv run quorum column <target>
```

Behavior:

- validates `doctor <target>` first;
- previews the matrix before starting;
- prints runnable, skipped, draft, and long-time cell counts;
- acquires target/provider locks;
- invokes existing `run-all` with `--coding-agents <target>`;
- defaults to `--jobs 1` when the target YAML has `max_concurrency: 1`;
- defaults uncapped targets to `--jobs 1` before measurement;
- may raise the configured uncapped default after the AWS dry run confirms the
  host and provider can sustain more parallelism;
- writes the job log;
- prints job id, batch id, final rollup, and the `quorum show` command.

### `quorum batch --profile sentinel-default`

Purpose: run the day-one shared sentinel campaign.

Shape:

```bash
uv run quorum batch --profile sentinel-default
```

Behavior:

- profile is configured in Quorum, not in shell aliases;
- target list contains only doctor-ready targets;
- default tier is `sentinel`;
- profile is small enough for routine team use;
- acquires `global:broad-batch` plus target/provider locks;
- invokes one or more existing `run-all` child commands;
- records child batch ids in `job.json`;
- prints job id, child batch ids, rollup, and `quorum show` commands.

Phase 1 does not need `sentinel-all`, `full-short`, or long-haul profiles.

### `quorum status`

Purpose: show active and recent managed jobs.

Shape:

```bash
uv run quorum status
uv run quorum status --json
```

Reports:

- job id;
- state;
- owner;
- age;
- managed command;
- targets;
- locks;
- repo SHAs;
- log path;
- child run or batch ids when known.

`status` should mark jobs orphaned when job metadata exists but the recorded
supervisor is gone and the final state was not written.

### `quorum tail`

Purpose: follow a job's durable command log.

Shape:

```bash
uv run quorum tail <job-id>
```

It should resolve full ids and unambiguous prefixes. It does not need to tail
raw target transcripts in Phase 1.

## Branch And Root Metadata

Phase 1 records repo identity; it does not need to implement per-job worktree
creation.

Every managed job records:

- evals repo path, branch, SHA, dirty state;
- `SUPERPOWERS_ROOT` path, branch, SHA, dirty state;
- current command argv;
- results root.

If either repo is dirty, the managed command should print a clear warning and
record `dirty: true`. It may still run, because Phase 1 is an operator tool,
but the resulting batch must not be presented as a clean baseline.

Per-job `--superpowers-ref`, `--evals-ref`, and immutable worktree preparation
are Phase 2 work. Phase 1 can still run against an operator-prepared
`SUPERPOWERS_ROOT`; it records the path, branch, SHA, and dirty state rather
than creating the checkout itself.

## Results And Artifacts

Phase 1 keeps using the existing Quorum result layout under:

```text
/opt/quorum/results/
```

No archive or cleanup command is required in Phase 1.

Phase 1 should avoid making future cleanup impossible:

- job metadata records child run and batch ids;
- managed commands print artifact paths;
- target env files are excluded from copied artifacts when possible;
- secret-bearing diagnostics are redacted;
- `quorum show` remains the verdict front door.

Disk pressure is handled manually in Phase 1. `doctor --all` should warn when
free space under `/opt/quorum` is below a conservative threshold, initially 100
GB.

## Data Flow

Managed smoke, column, and sentinel batch follow this flow:

1. Resolve host paths and state root.
2. Run `doctor` checks for selected targets.
3. Create `job.json` in `planned` state.
4. Build sanitized per-target env profiles.
5. Acquire required locks.
6. Start the supervisor.
7. Supervisor updates `job.json` to `running` and holds lock descriptors.
8. Supervisor invokes existing `quorum run` or `quorum run-all`.
9. Child writes normal run/batch artifacts under `/opt/quorum/results`.
10. Supervisor records child ids, final state, exit code, and finish time.
11. Initiating CLI streams the durable log while connected.

## Error Handling

`doctor` failures are non-destructive and should be actionable.

Managed command failures:

- missing secret profile: fail before job launch;
- blocked key-backed adapter: fail before job launch;
- lock conflict: fail before job launch with owner/log details;
- child `run` / `run-all` nonzero exit: mark job `failed`;
- SSH disconnect: no state change; supervisor continues;
- supervisor gone before final state: `status` marks job `orphaned`;
- malformed `job.json`: `status` reports the file path and continues listing
  other jobs.

Secret values must never appear in command logs, job JSON, or failure messages.

## Testing

Static checks remain safe for CI:

```bash
uv run ruff check
uv run ty check
uv run quorum check
uv run pytest
```

Add unit tests for:

- state-root discovery;
- job id allocation and `job.json` schema;
- job state transitions;
- durable log path creation;
- lock acquisition, release, deterministic ordering, and conflict reporting;
- target-to-provider lock mapping;
- `doctor` ready/blocked/failed output;
- secret redaction;
- smoke scenario mapping, including draft bootstrap scenarios;
- `column` command expansion over existing `run-all`;
- `sentinel-default` profile expansion;
- `status --json`;
- orphan detection;
- `tail` id/prefix resolution.

Use fake child invocations for command tests. Live Quorum evals and AWS
provisioning are manual/dry-run verification, not public CI.

## AWS Dry-Run Verification

Before Phase 1 is considered usable:

1. Terraform plan shows no unrelated replacement of existing Terminus
   resources.
2. The host appears in Tailscale as `quorum-evals`.
3. SSM Session Manager can reach the instance.
4. `/opt/quorum` is mounted from the persistent encrypted data volume.
5. Data volume has `prevent_destroy` and backup tags.
6. Required binaries are installed.
7. Repos are cloned at expected branches.
8. `uv sync --extra dev` succeeds in the eval repo.
9. `uv run quorum doctor --all` reports ready, blocked, or failed for every
   target with no unclassified target.
10. At least one key-backed target smoke passes.
11. At least one target column starts and writes a batch artifact.
12. `sentinel-default` completes with its configured ready target set.
13. A disconnected SSH session does not kill the managed job.
14. A second SSH session can run `status`, `tail`, and `show`.
15. A deliberate lock conflict exits clearly and does not start a second live
   run.

Record dry-run measurements:

- wall time;
- runnable cell count;
- p50/p90/p99 cell duration when available;
- active live-cell count;
- CPU, memory, disk free, and network observations;
- artifact bytes written;
- provider rate-limit/auth failures;
- rough provider/model cost from existing Quorum economics where available.

## Phase 1 Exit Criteria

Phase 1 is complete when:

- Terminus provisions `quorum-evals` through Terraform.
- `/opt/quorum` host layout exists on persistent EBS.
- host-managed secret profiles exist for every target family.
- `doctor --all` classifies every target and at least the intended day-one
  target set is `ready`.
- key-backed adapter work lands for any target counted as supported.
- `smoke <target>`, `column <target>`, and `batch --profile sentinel-default`
  run as managed jobs.
- managed jobs survive SSH disconnect.
- `status` and `tail` recover job state from a fresh SSH session.
- host-global locks prevent target/provider conflicts across sessions.
- job metadata records owner, command, repo SHAs, dirty states, locks, log
  path, out root, child ids, and final state.
- results remain inspectable through `quorum show`.
- dry-run measurements are captured and used to adjust default parallelism.

## Deferred To Later Phases

- `rerun`
- `compare`
- `promote`
- `archive`
- `cleanup`
- S3 artifact manifests
- private result index
- branch/ref worktree creation
- queueing and scheduling
- web or Slack submission
- Cloud Build / Stockyard isolation
- multi-host parallelism
- per-run spend attribution
