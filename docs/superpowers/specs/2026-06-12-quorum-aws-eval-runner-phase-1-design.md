# Quorum AWS Eval Runner Phase 1 - design specification

**Status:** Draft for Drew review.
**Date:** 2026-06-12
**Tracker:** PRI-2205
**Parent spec:** `docs/superpowers/specs/2026-06-12-quorum-aws-eval-runner-design.md`

This Phase 1 spec is the normative implementation contract for the first
shared AWS runner. The parent spec is the broader roadmap and should not be
read as permission to pull later platform work into Phase 1.

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

Phase 1 has two delivery milestones:

- **Phase 1a: first useful remote runner.** One Terminus host can run at least
  one ready key-backed target through managed `smoke` and sentinel `column`
  commands, survive SSH disconnect, enforce host locks, and recover through
  `status`, `tail`, and `show`.
- **Phase 1b: shared sentinel campaign.** `batch --profile sentinel-default`
  runs the configured ready target set, starting with `claude` plus at least one
  non-Anthropic key-backed target when that target is honestly `ready`.

Blocked targets should not delay Phase 1a. They must be classified with stable
reasons and excluded from supported target counts until their key-backed path
actually works.

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

On the AWS host, those live primitives must not remain an accidental side door.
Raw `quorum run` and `quorum run-all` should either be invoked by the managed
worker under the same state, lock, and sanitized-env contract, or fail closed
with an instruction to use `smoke`, `column`, or `batch`.

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
- IAM: SSM read for `/quorum-evals/*` and no broader secret prefixes, using
  exact `us-west-1` account-scoped parameter ARNs rather than wildcard
  region/account ARNs.
- IAM: `kms:Decrypt` must be scoped to SSM use, matching the existing
  Brainstorm/Claw Eng pattern. The service root should include
  `kms:ViaService = ssm.us-west-1.amazonaws.com` and parameter encryption
  context constraints where the account KMS policy supports them.
- IMDS: eval users and eval child processes must not be able to reach
  `169.254.169.254` or the IPv6 IMDS endpoint if IPv6 metadata is enabled.
  The existing `machine-westworld` module enables IMDSv2, so the service root
  or bootstrap must add an explicit host firewall, unit sandbox, or equivalent
  control and verify it in the dry run.

SSM Session Manager is break-glass and bootstrap access, not the normal
operator path. The runbook must define who can start sessions or send commands,
require MFA/timeboxed access where available, enable encrypted session logging,
and scope allowed SSM documents/actions to bootstrap, secret sync, and
emergency recovery. Normal live eval operation uses Tailscale SSH into non-root
operator accounts.

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
- Bootstrap writes a volume identity manifest under `/opt/quorum/state` with
  the expected EBS volume id and filesystem UUID. Steady-state boot and Quorum
  host-mode commands refuse to run if `/opt/quorum` is not the expected mounted
  volume.
- DLM or AWS Backup policy is created for the data volume, not only tags.
- Dry-run verification checks that the backup policy is enabled and at least
  one recent snapshot exists before the host is considered durable.
- The runbook includes replacement-host restore steps for `/opt/quorum` and a
  restore drill: create a temporary volume from a snapshot, mount it read-only
  or on a scratch host, verify `/opt/quorum/state` and representative results,
  and run `quorum show` against restored artifacts.

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
/quorum-evals/targets/copilot/hooks/ANTHROPIC_API_KEY
/quorum-evals/targets/copilot/hooks/OPENAI_API_KEY
/quorum-evals/targets/copilot/hooks/OPENAI_BASE_URL
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
│   ├── cooldowns/
│   ├── jobs/
│   ├── locks/
│   ├── logs/
│   └── volume-identity.json
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

Shared filesystem permissions are part of the Phase 1 contract:

- `/opt/quorum`, `/opt/quorum/state`, `/opt/quorum/results`, and their
  non-secret children are `root:quorum-operators` with setgid directories and a
  default umask of `0027`.
- shared mutable directories that operators write through Quorum, including
  `/opt/quorum/state/jobs`, `/opt/quorum/state/logs`,
  `/opt/quorum/state/locks`, `/opt/quorum/state/cooldowns`, and
  `/opt/quorum/results`, use mode `2770`.
- ordinary readable artifacts use modes like `0640` for files and `0750` for
  directories unless a stricter target-specific path requires less access.
- lock files are pre-created by bootstrap or forced to `0660` on creation so
  different operators can open the same path for `flock` diagnostics and
  conflict checks.
- job JSON, durable command logs, lock sidecars, batch summaries, and result
  metadata are readable by `quorum-operators` so a second trusted operator can
  recover a job with `status`, `tail`, and `show`.
- raw transcripts and run artifacts are also inside the trusted
  `quorum-operators` boundary in Phase 1; they must never be world-readable or
  exposed outside Tailscale/SSM without an explicit later archive/promotion
  flow.
- `/opt/quorum/secrets-runtime` is root-only and is not readable by
  `quorum-operators`.

Phase 1 is a trusted-maintainer host, not a sandbox against malicious eval code.
The permissions above support auditability and handoff between trusted
operators; they do not claim strong per-run secret isolation.

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
membership, `/opt/quorum` directory permissions, and
`/opt/quorum/secrets-runtime` permissions. Bootstrap must not add eval
operators to `sudo`, `wheel`, or `docker`.

Shared root checkouts under `/opt/quorum/repos` should not be writable by eval
operator accounts. Repo updates happen through an explicit bootstrap/sync
action that first checks for active jobs referencing the checkout. Operator
prepared writable worktrees can live under `/opt/quorum/worktrees/<user>/`, but
managed commands must record and lock those paths while jobs are active.

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

`doctor <target>` exit semantics:

- exit 0 when the target is `ready`;
- exit 1 when the target is `failed`;
- exit 2 when the doctor command itself cannot complete;
- exit 3 when the target is `blocked`.

`doctor --json` and `doctor --all --json` must use stable machine-readable
states and reason codes. Initial reason codes include
`missing-binary`, `missing-secret`, `placeholder-secret`, `missing-repo-file`,
`personal-auth`, `unsupported-key-backed-mode`, `preflight-failed`,
`cooldown-active`, and `config-error`.

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
| `copilot` | provider-mode `COPILOT_PROVIDER_BASE_URL`, `COPILOT_PROVIDER_TYPE`, and either `COPILOT_PROVIDER_API_KEY` or `COPILOT_PROVIDER_BEARER_TOKEN`; any Superpowers hook/provider credentials required by the checked-in Copilot path, currently including Anthropic/OpenAI hook env; `SUPERPOWERS_ROOT` |
| `opencode` | `OPENAI_API_KEY`, pinned model `openai/gpt-5.5`, narrowed launcher and capture env, `SUPERPOWERS_ROOT` |
| `codex` | key-backed Codex mode to be implemented and verified; no ChatGPT subscription auth |
| `antigravity` | key-backed Antigravity mode to be implemented and verified; no Code Assist browser/keyring auth |

Readiness has two credential surfaces:

- the target CLI/provider credentials needed by the Coding-Agent under test;
- any Superpowers hook/provider credentials needed by the target integration.

Both surfaces must come from host-managed profiles. Each credential is passed
only to the process that needs it. A target is `blocked` when the checked-in
launcher or capture path would require unrelated ambient provider credentials.

For `codex` and `antigravity`, the implementation must verify the current CLI
auth surface before choosing exact env names or flags. Until that is done,
`doctor codex` and `doctor antigravity` should return `blocked`, not silently
fall back to personal login state.

On the AWS host, `doctor copilot` is `ready` only in provider mode. Copilot
GitHub-token auth, `gh auth token`, and personal Copilot login state are
`blocked` unless a later phase introduces a dedicated eval identity with an
explicit credential contract.

On the AWS host, `doctor opencode` is `ready` only after the OpenCode launcher
and session export allowlist are narrowed to the selected OpenAI profile plus
non-secret runtime env. The current broad OpenCode allowances for Anthropic,
OpenRouter, Gemini, Google, and AWS env must be removed or blocked before
OpenCode counts as supported.

On the AWS host, `doctor gemini` must hard-block `GEMINI_AUTH_TYPE=oauth-personal`.
Only `GEMINI_AUTH_TYPE=gemini-api-key` is Phase-1-ready.

## Secrets Runtime

The host materializes restricted target env files under:

```text
/opt/quorum/secrets-runtime/<target>.env
```

Source profile ownership:

- directory: `root:root`, mode `0700`;
- source profile files: `root:root`, mode `0600`;
- eval operator accounts and live eval child processes cannot read source
  profiles directly.

Managed Quorum commands use a narrow root-owned materializer, SSM action, or
equivalent bootstrap helper to copy only the selected target's required values
into a per-job env file. The per-job env file is owned by the invoking operator,
mode `0600`, outside `/opt/quorum/results`, and preferably under a job-scoped
tmpfs directory such as `/run/quorum/secrets/<job-id>/`.

The per-job env directory is deleted when the job finishes, fails, or is
interrupted. `status` and `doctor` must flag stale per-job env directories when
the recorded supervisor is gone. Secret rotation during a running job does not
affect that job because it uses the copied per-job env file; the job metadata
records only the profile name and version or last-sync timestamp.

Phase 1 includes a narrow secret-runtime cleanup action or runbook step for
stale per-job env directories. This is separate from general result cleanup,
which remains deferred.

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

Implement this as an explicit sanitized run environment, not ad hoc subprocess
kwargs. The implementation should introduce a shared `RunEnvironment` or
equivalent value and thread it through `run_batch`, child `quorum run`
invocation, `run_scenario`, `setup.sh`, `checks.sh`, target preflights,
Gauntlet, launcher seeding, and session export/capture helpers. Tests must use
poison env variables to prove unallowlisted values do not reach those surfaces.

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
- `orphaned`: derived status when metadata exists, the recorded supervisor is
  gone or stale, and the final child state cannot be determined.

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
    "pid": 12345,
    "pid_started_at": "2026-06-12T19:00:01Z",
    "last_heartbeat_at": "2026-06-12T19:05:01Z",
    "worker_command": ["quorum", "managed-worker", "job-20260612T190000Z-a1b2"]
  },
  "children": [
    {
      "kind": "batch",
      "id": "batch-20260612T190010Z-a1b2",
      "state": "running",
      "path": "/opt/quorum/results/batches/batch-20260612T190010Z-a1b2"
    }
  ],
  "result_rollup": null,
  "tainted": false,
  "started_at": "2026-06-12T19:00:00Z",
  "finished_at": null,
  "final_exit_code": null
}
```

The schema is intentionally additive. Existing `batch.json`, `results.jsonl`,
and `verdict.json` readers should not need to understand job records.

The worker updates `children` as soon as a child run or batch directory is
allocated, before waiting for the child to complete. Child states are
`starting`, `running`, `finalizing`, `complete`, `failed`, or `unknown`. This
lets `status` and handoffs point at partial artifacts after crashes.

The worker owns terminal state writes. `status` may present `orphaned` as a
derived view when the heartbeat is stale and the supervisor is gone, but it must
not race a finishing worker by blindly overwriting a terminal state. Any durable
orphan-state write needs an atomic compare-and-swap from a still-running state.

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
- `status` can detect whether the supervisor is still alive;
- the worker writes a heartbeat while the child command is active.

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

Target, provider, and global locks are exclusive. Checkout locks are shared for
live eval jobs and exclusive for repo sync, branch switching, or other checkout
maintenance. A maintenance action must fail fast while active jobs hold a shared
lease for that checkout path.

Acquire locks in deterministic order:

1. global locks;
2. checkout locks;
3. provider locks;
4. target locks.

Live jobs and repo maintenance use the same order. Maintenance commands acquire
checkout locks exclusively; live jobs acquire them shared.

Initial locks:

| Lock | Purpose |
| --- | --- |
| `global:broad-batch` | Prevent overlapping broad campaigns. |
| `checkout:evals:<hash>` | Prevent mutation of an evals checkout while active jobs reference it. |
| `checkout:superpowers:<hash>` | Prevent mutation of a Superpowers checkout while active jobs reference it. |
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
- all managed live commands: shared checkout locks for the evals and
  Superpowers paths recorded in job metadata.

On conflict, Quorum exits nonzero and reports:

- lock name;
- owning job id if known;
- owning user if known;
- owning command if known;
- job log path if known.

No queueing is required in Phase 1.

Cooldowns are also fail-fast state, not a queue. When Quorum detects a known
provider or target quota/rate-limit marker, it writes
`/opt/quorum/state/cooldowns/<provider-or-target>.json` with source job, reason,
expiry, and recovery guidance. `doctor`, `smoke`, `column`, and `batch` fail
fast while an active cooldown applies and print the source job, expiry, and
next recovery command.

Raw `quorum run` and `quorum run-all` remain low-level primitives for local
development and for the managed worker to call internally. On the AWS host,
when `QUORUM_STATE_ROOT=/opt/quorum/state` or host mode is otherwise active,
raw live commands must fail closed unless invoked by the managed worker. The
error should point agents to `smoke`, `column`, or `batch`.

An emergency raw-command path, if implemented, must be explicit and noisy:
`--unsafe-bypass-host-locks --reason <text>`, restricted to root or a
break-glass SSM path, recorded in durable state/status, and excluded from normal
Phase 1 operator docs.

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
- invokes direct `quorum run` for the mapped smoke scenario rather than
  `run-all`;
- includes draft smoke scenarios deliberately when the target's smoke scenario
  is still draft;
- writes the job log;
- prints job id, run id, final verdict, and the `quorum show` command.

Smoke mapping should be explicit and tested. Claude-family and Codex targets
use `00-quorum-smoke-hello-world` unless a target-specific bootstrap scenario
is configured. Targets with bootstrap scenarios use those scenarios.

### `quorum column`

Purpose: run the standard column for one target.

Shape:

```bash
uv run quorum column <target>
uv run quorum column <target> --tier full --confirm-long-haul
```

Behavior:

- validates `doctor <target>` first;
- previews the matrix before starting;
- prints runnable, skipped, draft, and long-time cell counts;
- acquires target/provider locks;
- invokes existing `run-all` with `--coding-agents <target>`;
- defaults to `--tier sentinel`;
- requires an explicit non-default tier and `--confirm-long-haul` when the
  effective matrix includes scenarios above the long-haul threshold, initially
  20 minutes;
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
- Phase 1a may run a one-target `claude` sentinel column as the first useful
  remote-runner milestone;
- Phase 1b requires `claude` plus at least one non-Anthropic key-backed target
  in `sentinel-default`;
- default tier is `sentinel`;
- profile is small enough for routine team use;
- acquires `global:broad-batch` plus target/provider locks;
- starts with an explicit manifest of provider-diverse child `run-all` commands,
  one target per child at `--tier sentinel --jobs 1`;
- records each child target list, provider lock, `jobs`, expected capped lanes,
  computed max live cells, batch id, state, and artifact path;
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

`status --json` returns a stable object with `schema_version`, `generated_at`,
`state_root`, `jobs`, `active_locks`, `cooldowns`, and `malformed_records`.
Jobs are sorted newest first by job id and may be limited by a future `--limit`
flag. Malformed job records are reported with file path and parse error instead
of aborting the whole status command.

`status` should report jobs as orphaned when job metadata exists but the
heartbeat is stale, the recorded supervisor is gone, and the final state was not
written. Orphaned is a status view unless an atomic compare-and-swap safely
updates the job record.

### `quorum tail`

Purpose: follow a job's durable command log.

Shape:

```bash
uv run quorum tail <job-id>
```

It should resolve full ids and unambiguous prefixes. Ambiguous prefixes fail
with a list of matching job ids. It does not need to tail raw target
transcripts in Phase 1.

If the input is a child run id or batch id, `tail` should resolve it back to the
owning job through job metadata when possible. If multiple jobs reference the
same child id because of malformed or copied state, it fails with the matching
job ids.

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

Managed commands must record active shared checkout paths in job metadata and
hold shared checkout locks for the evals and Superpowers roots. Repo sync,
branch switching, `git pull`, or other mutation of a shared checkout must go
through a Quorum-aware maintenance command or runbook step that first acquires
the exclusive checkout lock. `doctor`, managed commands, and maintenance steps
warn or fail clearly when active jobs reference the current checkout.

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
- every managed job runs a lightweight secret-leak scan during finalization over
  job logs, job JSON, verdict JSON, Gauntlet transcripts, target logs, exported
  sessions, and run artifacts before it can be marked `succeeded`;
- the scan checks exact selected secret values plus high-signal token patterns.
  On a match, the job is `failed`, `tainted: true`, and the artifact paths are
  preserved for trusted-operator triage without printing the matched secret;
- `quorum show` remains the verdict front door.

Disk pressure is handled manually in Phase 1. `doctor --all` should warn when
free space under `/opt/quorum` is below a conservative threshold, initially 100
GB. If a managed job encounters disk-full or log-write errors mid-run, it marks
the job `failed`, preserves whatever child ids are known, and reports the
operator recovery command in the durable log when it can.

Before child launch, managed commands must create and fsync the initial
`job.json` and durable log, verify conservative free space, and keep a small
reserved recovery file or stderr fallback so ENOSPC failures still leave an
operator breadcrumb.

## Data Flow

Managed smoke, column, and sentinel batch follow this flow:

1. Resolve host paths and state root.
2. Run `doctor` checks for selected targets.
3. Create and fsync `job.json` in `planned` state and create the durable log.
4. Start the supervisor with an internal managed-worker command.
5. Managed worker asks the root-owned materializer for selected per-job env
   profiles outside results.
6. Managed worker acquires required locks.
7. Managed worker updates `job.json` to `running` and holds lock descriptors.
8. Managed worker invokes existing `quorum run` or `quorum run-all`.
9. Child writes normal run/batch artifacts under `/opt/quorum/results`.
10. Managed worker records child ids as soon as child artifact directories are
    allocated, using atomic `job.json` writes.
11. Managed worker scans artifacts for selected secrets and high-signal token
    patterns.
12. Managed worker records command state, verdict rollup, taint state, exit
    code, and finish time using atomic `job.json` writes.
13. Initiating CLI streams the durable log while connected.

## Error Handling

`doctor` failures are non-destructive and should be actionable.

Managed command failures:

- missing secret profile: fail before job launch;
- blocked key-backed adapter: fail before job launch;
- active cooldown: fail before job launch with source job and expiry;
- lock conflict: fail before child `quorum run` / `quorum run-all` launch with
  owner/log details;
- raw live `run` / `run-all` on the AWS host outside the managed worker: fail
  closed with the supported managed command to use;
- child `run` / `run-all` process crash, missing expected artifacts, or
  managed-command failure: mark job `failed`;
- secret-leak scan match: mark job `failed` and `tainted: true`;
- child `run` returns a non-passing verdict or `run-all` records failing cells:
  mark job `succeeded` if artifacts were written correctly, and record the
  eval verdict rollup separately;
- SSH disconnect: no state change; supervisor continues;
- stale heartbeat and supervisor gone before final state: `status` reports the
  job as `orphaned`;
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
- AWS host-mode raw `run` / `run-all` fail-closed behavior;
- shared directory and lock-file mode enforcement;
- job id allocation and `job.json` schema;
- job state transitions;
- heartbeat and stale-worker detection;
- durable log path creation;
- atomic `job.json` writes and recovery from malformed job records;
- lock acquisition, release, deterministic ordering, and conflict reporting;
- shared/exclusive checkout locks;
- cooldown read/write and fail-fast reporting;
- fake-supervisor behavior proving the managed worker, not the initiating CLI,
  holds locks through the child lifetime;
- early child run/batch registration for crash recovery;
- target-to-provider lock mapping;
- `doctor` ready/blocked/failed output;
- `doctor <target>` and `doctor --all` exit codes when targets are ready,
  blocked, failed, or unclassifiable;
- secret redaction;
- root-only source profiles and selected-target per-job materialization;
- stale per-job env detection and cleanup;
- secret-bearing env files staying outside result artifacts;
- poison-env tests for setup, checks, preflights, Gauntlet, child `quorum run`,
  launchers, and capture helpers;
- generic secret-leak scan coverage;
- tainted job finalization;
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
3. Tailscale ACL validation proves `tag:quorum-evals` allows only non-root
   operator SSH and denies root.
4. SSM Session Manager can reach the instance through the documented
   break-glass path, with encrypted session logging enabled.
5. `/opt/quorum` is mounted from the persistent encrypted data volume.
6. Steady-state boot mounts the data volume by expected identity and does not
   auto-format it.
7. Data volume has `prevent_destroy`, backup policy coverage, and at least one
   recent snapshot.
8. A restore drill mounts a snapshot and `quorum show` can inspect
   representative restored artifacts.
9. Eval users cannot reach IMDS.
10. Eval users have no sudo, wheel, or Docker socket access.
11. Source secret profiles are root-only; a live eval child can read only its
   selected per-job env file.
12. Required binaries are installed.
13. Repos are cloned at expected branches.
14. `uv sync --extra dev` succeeds in the eval repo.
15. `uv run quorum doctor --all` reports ready, blocked, or failed for every
   target with no unclassified target.
16. Raw `uv run quorum run` and `uv run quorum run-all` fail closed on the AWS
   host outside the managed worker.
17. At least one key-backed target smoke passes.
18. At least one sentinel target column starts and writes a batch artifact.
19. A disconnected SSH session does not kill the managed job.
20. A second SSH session can run `status`, `tail`, and `show`.
21. A deliberate lock conflict exits clearly and does not start a second live
   run.
22. Secret-leak scan passes for job metadata, logs, and result artifacts.

Before Phase 1b is considered complete:

1. `sentinel-default` completes with `claude` and at least one non-Anthropic
   key-backed target.
2. The profile manifest records each child target, provider lock, batch id,
   computed max live cells, and artifact path.
3. The AWS dry-run captures enough measurements to decide whether any
   configured concurrency should rise above one live cell per provider.

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

Phase 1a is usable when:

- Terminus provisions `quorum-evals` through Terraform.
- `/opt/quorum` host layout exists on persistent EBS.
- IMDS is blocked for eval users and eval child processes.
- eval operators have no sudo, wheel, or Docker socket access.
- data volume mount is fail-closed, backup policy coverage is verified, and a
  restore drill has passed.
- SSM break-glass is scoped and logged; Tailscale SSH maps only to non-root
  operator accounts.
- host-managed source secret profiles are root-only and selected per-job env
  materialization works.
- host-managed secret profiles exist for at least one day-one ready target.
- `doctor --all` classifies every target, reports blocked targets with
  actionable reason codes, and marks at least one key-backed target as `ready`.
- key-backed adapter work lands for any target counted as supported.
- `smoke <target>` and sentinel `column <target>` run as managed jobs.
- managed jobs survive SSH disconnect.
- `status` and `tail` recover job state from a fresh SSH session.
- host-global locks prevent target/provider conflicts across sessions.
- raw live `run` / `run-all` fail closed on the AWS host outside the managed
  worker.
- job metadata records owner, command, repo SHAs, dirty states, locks, log
  path, out root, child ids, heartbeats, final command state, taint state, and
  verdict rollup.
- secret-bearing env files stay outside result artifacts and leak scans pass.
- results remain inspectable through `quorum show`.

Phase 1b is complete when:

- `batch --profile sentinel-default` runs as a managed job.
- `sentinel-default` includes `claude` plus at least one non-Anthropic
  key-backed target that is `doctor`-ready.
- the batch profile manifest and job metadata expose child batches, locks,
  computed max live cells, result rollup, and `quorum show` commands.
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
