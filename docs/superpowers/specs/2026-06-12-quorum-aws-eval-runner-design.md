# Quorum AWS Eval Runner - design specification

**Status:** Draft for Drew review.
**Date:** 2026-06-12
**Context:** Quorum live evals currently run from Drew's Mac Studio. Drew wants
a team-accessible AWS node so he can ask Codex or another agent to run smoke
tests, columns, and broader Quorum batches without relying on a local desktop.

---

## Goal

Create a team-accessible AWS runner for trusted Quorum live evals.

The v1 runner should:

- let agents operate Quorum through the normal Quorum CLI rather than a new
  eval-runner product API;
- preserve Quorum's current local workflow for smoke runs, columns, grouped
  batches, triage, and artifact inspection;
- prevent accidental cross-session concurrency, quota collisions, and artifact
  confusion when multiple humans or agents use the same host;
- keep live eval secrets and raw transcripts off laptops where practical;
- fit the existing Terminus Terraform, Tailscale, SSM, EBS, and S3 patterns;
- leave a clear path to stronger Cloud Build / Stockyard isolation later.

## Non-goals

- Public CI live evals. Static checks remain the only public-CI-safe path.
- Running untrusted PR scenarios or generated `setup.sh` / `checks.sh` on the
  shared host.
- Providing strong per-run sandbox isolation in v1. The shared host is a
  trusted-operator tool, not a multi-tenant security boundary.
- Building a web UI, queue daemon, or Slack bot for job submission.
- Replacing Quorum's existing `run`, `run-all`, `show`, capture, or verdict
  model.
- Moving all provider auth to Cloud Build proxy nonces in the first increment.

## Direction

Use a long-lived Terminus-managed EC2 host for v1, and put the operator-facing
run affordances inside Quorum.

The important split is:

- **Terminus owns the workstation.** Terraform provisions EC2, EBS, IAM,
  Tailscale, SSM parameter inventory, backups, and host bootstrap.
- **Quorum owns the eval operation.** Quorum exposes safe commands for smoke
  runs, columns, batch profiles, locks, logs, status, tails, archive, and
  cleanup.

This avoids a second command surface such as `qrun`. Agents should be able to
SSH to the host and run `uv run quorum ...` with first-class Quorum subcommands.
Host-local glue can still exist for provisioning and secret materialization,
but it should not become the user-facing eval API.

## Terminus Host

Add a dedicated `quorum-evals` host in the Terminus repo using the existing
`machine-westworld` pattern.

Recommended v1 defaults:

- Region: `us-west-1`, matching Terminus.
- Instance: `m6i.2xlarge` on-demand.
- Root volume: 100 GB gp3.
- Data volume: 500 GB encrypted gp3 mounted at `/opt/quorum`.
- Access: Tailscale and SSM only; no public inbound application ports.
- Tailscale identity: `quorum-evals`.
- IAM: minimal SSM read access for `/quorum-evals/*`, plus S3 access only for
  the private Quorum artifact archive.
- Backups: short-retention DLM snapshots for the persistent data volume.

Use on-demand for v1. Spot is attractive for cost, but Quorum runs can last for
hours, OAuth-style auth state can be awkward to recreate, and interruption
handling is not yet explicit.

## Host Layout

The host should keep mutable eval state under `/opt/quorum`:

```text
/opt/quorum/
├── repos/
│   ├── superpowers/
│   └── superpowers-evals/
├── results/
├── logs/
├── archive-staging/
└── secrets-runtime/
```

`SUPERPOWERS_ROOT` should point at `/opt/quorum/repos/superpowers`.
`superpowers-evals` should use `/opt/quorum/results` as the default or
documented runner output root on this host.

Team members should have separate Unix accounts. The host may also have a
dedicated unprivileged `quorum-runner` account for actual job execution if the
first implementation includes privilege separation. Users and agents should not
need `sudo` or Docker socket access to run evals.

## Quorum CLI Additions

Add Quorum subcommands that express maintainer workflows directly:

```bash
uv run quorum smoke claude
uv run quorum column copilot
uv run quorum batch --agents claude,codex --scenarios a,b --jobs 4
uv run quorum status
uv run quorum tail <run-or-batch>
uv run quorum archive <run-or-batch>
uv run quorum cleanup --dry-run
```

These are convenience and safety affordances over `quorum run`, `run-all`, and
`show`, not a replacement for the underlying primitives.

### `quorum smoke`

Runs the canonical smoke scenario for one Coding-Agent.

The command should know the current smoke mapping:

- `claude`, `claude-haiku`, `claude-sonnet`, and `codex` use
  `00-quorum-smoke-hello-world`.
- target-specific bootstrap scenarios such as `copilot-superpowers-bootstrap`,
  `gemini-superpowers-bootstrap`, `kimi-superpowers-bootstrap`,
  `opencode-superpowers-bootstrap`, `pi-superpowers-bootstrap`, and
  `antigravity-superpowers-bootstrap` are used when present.

### `quorum column`

Runs all runnable scenarios for one Coding-Agent.

It should:

- preview the matrix before starting;
- respect the target's `max_concurrency`;
- default to `--jobs 1` for serial-capped targets;
- write a durable command log under the batch directory or run log root;
- print the resulting batch id and next triage command.

### `quorum batch`

Wraps `run-all` with named, safe profiles.

Initial profiles:

- `sentinel`: only `quorum_tier: sentinel`.
- `full`: full target/scenario selection, explicit confirmation required.
- `uncapped-group`: `claude,claude-haiku,claude-sonnet,codex,kimi` with a
  default `--jobs 4`.
- `capped-column`: one serial-capped target at `--jobs 1`.

The command should keep the existing `run-all` behavior available. Profiles
only encode the documented maintainer patterns so agents do not have to
reconstruct them each time.

## Locking And Concurrency

Quorum currently coordinates concurrency within one `run-all` process, but not
across separate shells. The AWS host needs cross-process locks.

Add a lock layer under `/opt/quorum/locks` or the configured out root:

- one global broad-sweep lock;
- one lock per Coding-Agent target;
- optional provider-family locks for shared quota surfaces such as Gemini /
  Antigravity;
- stale-lock detection that reports the owning PID, command, user, start time,
  and log path before allowing manual cleanup.

Locks should be advisory but enforced by the new Quorum commands. Low-level
`quorum run` and `quorum run-all` can remain available for maintainers, but the
documented AWS-host workflow should use the locking commands.

The first policy should be conservative:

- one broad batch at a time;
- serial-capped targets run one column at a time;
- Antigravity stays separate from Gemini;
- full multi-agent grids require an explicit profile or confirmation.

## Secrets And Auth

Use SSM SecureString parameters under `/quorum-evals/*`. Terraform owns the
parameter inventory and ignores values.

Initial parameter families:

- provider API keys needed for Claude, Gemini API-key mode, Kimi, Pi, OpenCode,
  and Copilot provider mode;
- Tailscale auth key for the host;
- GitHub read token or app material if the host needs to clone private repos
  without relying on a person's shell auth;
- optional S3 archive settings.

Secrets should be materialized into per-run or per-command environment files
with mode `0600`, then removed when the command completes. Prefer a tmpfs
runtime directory for secret-bearing files.

Avoid personal OAuth or subscription auth on the shared host unless the account
is a dedicated eval identity with understood spend, quota, and audit blast
radius. This is especially important for Codex, Antigravity, Copilot, and any
tool that uses browser or keyring state.

The shared host is not a secret isolation boundary against a malicious eval.
Do not run untrusted scenario code there. Strong host-secret isolation belongs
in a later Cloud Build / Stockyard design.

## Artifacts

Treat `results/` as sensitive.

The host should keep full local artifacts for short-term triage:

- default: 14 days or 150 GB, whichever is hit first;
- longer retention for selected promoted baselines;
- dry-run cleanup before deletion.

Completed runs and batches should be archivable to a private encrypted S3
prefix. Long-term archive should prioritize:

- `batch.json`;
- `results.jsonl`;
- each run's `verdict.json`;
- `coding-agent-token-usage.json`;
- normalized `coding-agent-tool-calls.jsonl` when needed for behavior triage.

Raw transcripts, config homes, workdirs, and Gauntlet-Agent event streams
should be retained only when promoted or when actively triaging a failure.

## Observability And Recovery

Quorum should make remote operation easy for agents:

- every managed command writes a command log;
- `quorum status` lists active runs, active locks, recent batches, owner, age,
  command, and log path;
- `quorum tail <id>` follows the relevant command log;
- `quorum show <id>` remains the verdict front door;
- stale-lock cleanup is explicit and auditable;
- interrupted SSH sessions should not kill active jobs if they were launched
  through the managed command path.

Use `tmux`, `systemd-run --scope`, or another simple host-native mechanism for
surviving SSH disconnects. Do not introduce a custom daemon in v1 unless the
simple mechanism cannot provide status and cleanup.

## Cost Controls

EC2 cost is meaningful but not the dominant risk. Model/API spend and accidental
parallelism are the larger risks.

V1 controls:

- default to smoke or sentinel-tier commands;
- require explicit confirmation or a flag for full sweeps;
- print matrix size before starting;
- record estimated cost from verdict economics after each run;
- summarize batch cost when available;
- keep provider-specific concurrency conservative;
- add CloudWatch/AWS budget alerts for EC2 and S3;
- add provider-side spend alerts where available;
- schedule stop windows only if they do not interrupt active jobs.

## Cloud Build Graduation Path

Move from shared host to Cloud Build / Stockyard isolation when any of these
becomes true:

- the team needs multiple concurrent eval jobs with meaningful isolation;
- evals need to run untrusted PR branches or generated scenario code;
- provider keys must remain host-only with per-run proxy nonces;
- OAuth/browser/keyring targets need per-run identity rather than shared host
  state;
- spend attribution and cleanup need to be per-run rather than per-host;
- a failed or malicious eval must not be able to inspect sibling artifacts or
  host secrets.

The v1 Quorum command design should survive that migration. A later isolated
runner can execute the same `quorum smoke`, `column`, and `batch` commands
inside a disposable box.

## Implementation Seams

Likely Quorum work:

- add command modules for `smoke`, `column`, `batch`, `status`, `tail`,
  `archive`, and `cleanup`;
- add a small lock helper with tests for ownership, stale detection, and
  non-overlap;
- extend batch metadata with command, user, host, git SHAs, env profile, and
  log path;
- add archive and retention helpers;
- document the AWS-host workflow in the README or a runbook.

Likely Terminus work:

- add a `terraform/quorum/evals` or similar service root;
- instantiate `machine-westworld`;
- add an encrypted persistent data volume and DLM policy;
- add SSM parameter inventory under `/quorum-evals/*`;
- add least-privilege IAM for SSM read and private S3 artifact archive access;
- add cloud-init bootstrap for uv, Python, Node, agent CLIs, Gauntlet, Tailscale,
  repo checkout, and filesystem layout.

## Verification

Before treating the AWS runner as usable:

1. Static repo checks pass locally:

   ```bash
   uv run ruff check
   uv run ty check
   uv run quorum check
   uv run pytest
   ```

2. Terminus Terraform plan shows no unrelated replacement of existing hosts or
   persistent volumes.
3. Host bootstrap installs required binaries and clones the expected repo SHAs.
4. `quorum smoke claude` passes on the AWS host.
5. One serial-capped smoke or bootstrap target passes on the AWS host.
6. A small `quorum batch --profile sentinel --agents claude,codex` run completes
   and archives summaries.
7. `quorum status`, `tail`, `show`, archive, and cleanup paths work from a fresh
   SSH session.

## Open Questions

- Which targets should v1 support on day one: API-key-only targets first, or
  also OAuth/keyring targets with dedicated eval identities?
- Should the actual job process run as the invoking Unix user or as a dedicated
  `quorum-runner` account?
- Should the first archive path be S3-only, or should it also publish a small
  static index for easier browsing over Tailscale?
- What retention policy is acceptable for raw transcripts: 7 days, 14 days, or
  manual promotion only?

