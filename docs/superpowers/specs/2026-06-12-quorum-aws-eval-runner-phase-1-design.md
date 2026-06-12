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
- IAM: `kms:Decrypt` must be scoped to SSM use, matching the existing
  Brainstorm/Claw Eng pattern.
- IMDS: eval users and eval child processes must not be able to reach
  `169.254.169.254` or the IPv6 IMDS endpoint if IPv6 metadata is enabled.
  The existing `machine-westworld` module enables IMDSv2, so the service root
  or bootstrap must add an explicit host firewall, unit sandbox, or equivalent
  control and verify it in the dry run.

Add the data volume in the service root, following the existing Brainstorm and
monitoring EBS patterns:

- 500 GB encrypted gp3 data volume.
- Data volume availability zone is derived from the selected subnet, not
  hardcoded independently.
- Attached to the `quorum-evals` instance.
- Mounted at `/opt/quorum`.
- `prevent_destroy = true`.
- Steady-state userdata is mount-only and must never auto-format an attached
  data volume. Blank-volume initialization is an explicit one-shot operator or
  SSM action.
- DLM or AWS Backup policy is created for the data volume, not only tags.
- Dry-run verification checks that the backup policy is enabled and at least
  one recent snapshot exists before the host is considered durable.
- The runbook includes replacement-host restore steps for `/opt/quorum`.

SSM parameter inventory for Phase 1:

```text
/quorum-evals/tailscale-auth-key
/quorum-evals/github-read-token
/quorum-evals/targets/claude/ANTHROPIC_API_KEY
/quorum-evals/targets/gemini/GEMINI_API_KEY
/quorum-evals/targets/kimi/KIMI_MODEL_API_KEY
/quorum-evals/targets/pi/PI_PROVIDER
/quorum-evals/targets/pi/PI_MODEL
/quorum-evals/targets/pi/PI_API_KEY
/quorum-evals/targets/copilot/COPILOT_PROVIDER_BASE_URL
/quorum-evals/targets/copilot/COPILOT_PROVIDER_TYPE
/quorum-evals/targets/copilot/COPILOT_PROVIDER_API_KEY
/quorum-evals/targets/copilot/COPILOT_PROVIDER_BEARER_TOKEN
/quorum-evals/targets/opencode/OPENAI_API_KEY
```

Terraform owns the inventory with placeholder values and `ignore_changes` on
secret values. Bootstrap or `doctor` must reject placeholder values before
running live evals.

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

Bootstrap owns creation of the `quorum-operators` group, operator account
membership, `/opt/quorum` directory permissions, and `/opt/quorum/secrets-runtime`
permissions. Bootstrap must not add eval operators to `sudo`, `wheel`, or
`docker`.

Tailscale must advertise a dedicated `tag:quorum-evals` identity. The Tailscale
ACL must allow SSH only to non-root operator accounts on this host. Root access
is reserved for SSM break-glass and bootstrap operations.

Bootstrap and secret sync can run as root through cloud-init, SSM, or an
explicit operator action. Live eval child processes should run as the operator.

## Target Readiness Contract

Phase 1 classifies every known target and supports targets only through
host-managed eval credentials. A target is usable only after `doctor` proves
the target's key-backed path works.

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

Blocked targets are still tracked by Phase 1, but they are not counted as
supported until their key-backed adapter work lands. Phase 1 does not require
materializing secret profiles for blocked targets before the first useful AWS
runner is available.

`doctor --all` exit semantics:

- exit 0 when every target is classified and no target is `failed`;
- exit 1 when any target is `failed`;
- exit 2 when the doctor command itself cannot complete classification, such
  as malformed YAML, unreadable state root, or invalid JSON output.

`blocked` targets do not make `doctor --all` fail. They are expected while
key-backed adapter work is still in progress, and the output must include the
blocking reason.

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
| `copilot` | provider-mode `COPILOT_PROVIDER_BASE_URL`, `COPILOT_PROVIDER_TYPE`, and either `COPILOT_PROVIDER_API_KEY` or `COPILOT_PROVIDER_BEARER_TOKEN`; `SUPERPOWERS_ROOT` |
| `opencode` | `OPENAI_API_KEY`, pinned model `openai/gpt-5.5`, `SUPERPOWERS_ROOT` |
| `codex` | key-backed Codex mode to be implemented and verified; no ChatGPT subscription auth |
| `antigravity` | key-backed Antigravity mode to be implemented and verified; no Code Assist browser/keyring auth |

For `codex` and `antigravity`, the implementation must verify the current CLI
auth surface before choosing exact env names or flags. Until that is done,
`doctor codex` and `doctor antigravity` should return `blocked`, not silently
fall back to personal login state.

On the AWS host, `doctor copilot` is `ready` only in provider mode. Copilot
GitHub-token auth, `gh auth token`, and personal Copilot login state are
`blocked` unless a later phase introduces a dedicated eval identity with an
explicit credential contract.

On the AWS host, `doctor gemini` must hard-block `GEMINI_AUTH_TYPE=oauth-personal`.
Only `GEMINI_AUTH_TYPE=gemini-api-key` is Phase-1-ready.

## Secrets Runtime

The host materializes restricted target env files under:

```text
/opt/quorum/secrets-runtime/<target>.env
```

Recommended ownership:

- `root:quorum-operators`
- mode `0640`

Managed Quorum commands copy the selected target profile into a per-job env
file with mode `0600` outside `/opt/quorum/results`, preferably under tmpfs.
The per-job env file is deleted when the job finishes, fails, or is
interrupted. Secret rotation during a running job does not affect that job
because it uses the copied per-job env file.

Secret-bearing env/profile files must never live under a run directory, batch
directory, copied Coding-Agent config directory, or other artifact path under
`/opt/quorum/results`. Current per-target env files such as `.claude-env`,
`.gemini-env`, `.copilot-env`, and `pi.env` must be moved out of result
artifacts or replaced with non-secret launch references before the target is
counted as supported on the AWS host.

Live child processes receive an allowlisted environment, not the invoking
shell's full `os.environ`.

This applies to every live-eval surface, not only the final Coding-Agent
launcher:

- scenario `setup.sh`;
- scenario `checks.sh`;
- target auth preflights;
- Gauntlet invocation;
- child `quorum run` processes launched by `run-all`;
- Coding-Agent launchers.

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
- `GEMINI_AUTH_TYPE=oauth-personal`;
- browser cookies;
- macOS keychain or Linux keyring state;
- a developer's personal GitHub/Copilot login;
- credentials embedded in proxy URLs.

Job JSON records env profile names only. It must not record secret file paths,
secret values, or shell snippets that could reveal credentials.

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
- `running`: supervised worker is active and locks are held.
- `succeeded`: managed command completed and wrote its expected artifacts.
- `failed`: managed command failed to complete, such as setup failure, child
  process crash, lock failure, or missing expected artifacts.
- `interrupted`: supervisor observed interruption or child termination.
- `orphaned`: metadata exists, but the recorded supervisor is gone and the
  final child state cannot be determined.

Job state is about managed-command execution, not eval success. A batch with
failing or indeterminate cells can still be a `succeeded` job if the managed
command completed normally and wrote the expected batch artifacts. Verdict
rollup is recorded separately. `result_rollup` must preserve existing
`results.jsonl` semantics, including skipped reasons such as `rate-limited`.

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
  "result_rollup": null,
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

Concrete Phase 1 shape:

1. The initiating CLI writes the `planned` job record and starts a supervised
   worker command, such as an internal `quorum managed-worker <job-id>` entry
   point.
2. The supervised worker materializes per-job env files, acquires lock file
   descriptors, updates `job.json` to `running`, invokes `quorum run` or
   `quorum run-all`, records child ids and rollup, and releases locks on exit.
3. The initiating CLI streams the durable log while connected, but it does not
   own the lock file descriptors.

Requirements:

- the supervised worker process, not the initiating CLI process, holds lock
  file descriptors for the lifetime of the child run;
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
killed supervised workers release locks automatically. Conflict reporting must
ignore stale sidecars when the underlying lock is no longer held.

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

Raw `quorum run` and `quorum run-all` remain available as low-level primitives,
but they are not the supported AWS-host live-run interface. The AWS runbook
should direct operators and agents to `doctor`, `smoke`, `column`, and
`batch`. Raw live commands are an explicit escape hatch and can bypass
host-global locks.

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
- target YAML metadata loads and required Superpowers files exist;
- target binary exists;
- host state root and output root are writable;
- required secret profile exists;
- target env can be sanitized and materialized;
- target auth mode is not personal login state;
- target-specific preflight passes when safe to run.

`doctor` should redact secret values in all output. When `doctor` performs a
live provider preflight, it must acquire the same provider or target locks that
the corresponding managed live command would acquire, or skip that preflight
with a clear conflict message.

Current `load_coding_agent_config()` validates `required_env` against ambient
`os.environ`. `doctor` must not use ambient shell env for readiness. It should
either load target YAML metadata without enforcing `required_env`, or
materialize the sanitized target env first and then load the full config under
that env.

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
- day-one completion requires `claude` plus at least one non-Anthropic
  key-backed target in `sentinel-default`; a one-target run is acceptable only
  as an infra smoke and does not complete Phase 1;
- default tier is `sentinel`;
- profile is small enough for routine team use;
- acquires `global:broad-batch` plus target/provider locks;
- starts with provider-diverse child `run-all` commands at `--tier sentinel
  --jobs 1`;
- may raise profile concurrency only after AWS dry-run measurements justify it;
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

It should resolve full ids and unambiguous prefixes. Ambiguous prefixes fail
with a list of matching job ids. It does not need to tail raw target
transcripts in Phase 1.

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

Managed commands must record active shared checkout paths in job metadata.
Quorum cannot prevent an operator from running raw `git` commands by hand, but
the Phase 1 runbook must forbid `git checkout`, `git pull`, branch switches, or
other mutations of a shared evals or Superpowers checkout while an active job
references it. `doctor` and managed commands should warn when active jobs
reference the current checkout.

## Results And Artifacts

Phase 1 keeps using the existing Quorum result layout under:

```text
/opt/quorum/results/
```

No archive or cleanup command is required in Phase 1.

Phase 1 should avoid making future cleanup impossible:

- job metadata records child run and batch ids;
- managed commands print artifact paths;
- target env files are kept outside result artifacts;
- secret-bearing diagnostics are redacted;
- managed commands run a lightweight pattern-based secret-leak scan over job
  logs, job JSON, verdict JSON, Gauntlet transcripts, target logs, exported
  sessions, and run artifacts before marking a target supported on the AWS
  host;
- `quorum show` remains the verdict front door.

Disk pressure is handled manually in Phase 1. `doctor --all` should warn when
free space under `/opt/quorum` is below a conservative threshold, initially 100
GB. If a managed job encounters disk-full or log-write errors mid-run, it marks
the job `failed`, preserves whatever child ids are known, and reports the
operator recovery command in the durable log.

## Data Flow

Managed smoke, column, and sentinel batch follow this flow:

1. Resolve host paths and state root.
2. Run `doctor` checks for selected targets.
3. Create `job.json` in `planned` state.
4. Start the supervisor with an internal managed-worker command.
5. Managed worker builds sanitized per-target env profiles outside results.
6. Managed worker acquires required locks.
7. Managed worker updates `job.json` to `running` and holds lock descriptors.
8. Managed worker invokes existing `quorum run` or `quorum run-all`.
9. Child writes normal run/batch artifacts under `/opt/quorum/results`.
10. Managed worker records child ids, command state, verdict rollup, exit code,
    and finish time using atomic `job.json` writes.
11. Initiating CLI streams the durable log while connected.

## Error Handling

`doctor` failures are non-destructive and should be actionable.

Managed command failures:

- missing secret profile: fail before job launch;
- blocked key-backed adapter: fail before job launch;
- lock conflict: fail before child `quorum run` / `quorum run-all` launch with
  owner/log details;
- child `run` / `run-all` process crash, missing expected artifacts, or
  managed-command failure: mark job `failed`;
- child `run` returns a non-passing verdict or `run-all` records failing cells:
  mark job `succeeded` if artifacts were written correctly, and record the
  eval verdict rollup separately;
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
- atomic `job.json` writes and recovery from malformed job records;
- lock acquisition, release, deterministic ordering, and conflict reporting;
- fake-supervisor behavior proving the managed worker, not the initiating CLI,
  holds locks through the child lifetime;
- target-to-provider lock mapping;
- `doctor` ready/blocked/failed output;
- `doctor --all` exit codes when targets are blocked versus failed;
- secret redaction;
- secret-bearing env files staying outside result artifacts;
- generic secret-leak scan coverage;
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
5. Steady-state boot mounts the data volume and does not auto-format it.
6. Data volume has `prevent_destroy`, backup policy coverage, and at least one
   recent snapshot.
7. Eval users cannot reach IMDS.
8. Eval users have no sudo, wheel, or Docker socket access.
9. Tailscale SSH maps only to non-root operator accounts.
10. Required binaries are installed.
11. Repos are cloned at expected branches.
12. `uv sync --extra dev` succeeds in the eval repo.
13. `uv run quorum doctor --all` reports ready, blocked, or failed for every
   target with no unclassified target.
14. At least one key-backed target smoke passes.
15. At least one target column starts and writes a batch artifact.
16. `sentinel-default` completes with `claude` and at least one non-Anthropic
   key-backed target.
17. A disconnected SSH session does not kill the managed job.
18. A second SSH session can run `status`, `tail`, and `show`.
19. A deliberate lock conflict exits clearly and does not start a second live
   run.
20. Secret-leak scan passes for job metadata, logs, and result artifacts.

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
- IMDS is blocked for eval users and eval child processes.
- eval operators have no sudo, wheel, or Docker socket access.
- data volume mount is fail-closed and backup policy coverage is verified.
- host-managed secret profiles exist for the day-one ready target set.
- `doctor --all` classifies every target, reports blocked targets with
  actionable reasons, and marks at least `claude` plus one non-Anthropic
  key-backed target as `ready`.
- key-backed adapter work lands for any target counted as supported.
- `smoke <target>`, `column <target>`, and `batch --profile sentinel-default`
  run as managed jobs.
- managed jobs survive SSH disconnect.
- `status` and `tail` recover job state from a fresh SSH session.
- host-global locks prevent target/provider conflicts across sessions.
- job metadata records owner, command, repo SHAs, dirty states, locks, log
  path, out root, child ids, final command state, and verdict rollup.
- secret-bearing env files stay outside result artifacts and leak scans pass.
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
