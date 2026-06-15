# Quorum AWS Eval Runner - design specification

**Status:** Draft, revised after staff review.
**Date:** 2026-06-12
**Tracker:** PRI-2205
**Context:** Quorum live evals currently run from Drew's Mac Studio. Drew wants
a team-accessible AWS node so he can ask Codex or another agent to run smoke
tests, grid columns, baseline campaigns, reruns, and triage without relying on
a local desktop.

This document is the roadmap-level design. The normative Phase 1 implementation
contract is `docs/superpowers/specs/2026-06-12-quorum-aws-eval-runner-phase-1-design.md`.
When the two differ, the Phase 1 spec controls current implementation scope.

---

## Goal

Create a team-accessible AWS runner for trusted Quorum live evals.

The v1 runner should:

- let agents operate Quorum through the normal Quorum CLI rather than a new
  eval-runner product API;
- preserve Quorum's current local workflow for smoke runs, columns, grouped
  batches, triage, and artifact inspection;
- provide a durable managed-job model so `status`, `tail`, handoff, recovery,
  archive, and cleanup do not depend on shell history;
- prevent accidental cross-session concurrency, quota collisions, and artifact
  confusion when multiple humans or agents use the same host;
- support reproducible branch and `SUPERPOWERS_ROOT` comparisons;
- keep live eval secrets and raw transcripts off laptops where practical;
- fit the existing Terminus Terraform, Tailscale, SSM, EBS, and S3 patterns;
- leave a clear path to stronger Cloud Build / Stockyard isolation later.

## Non-goals

- Public CI live evals. Static checks remain the only public-CI-safe path.
- Running untrusted PR scenarios or generated `setup.sh` / `checks.sh` on the
  shared host.
- Providing strong per-run sandbox isolation in v1. The shared host is a
  trusted-operator tool, not a multi-tenant security boundary.
- Building a web UI, queue daemon, Slack bot, or separate `qrun` command
  surface for job submission.
- Replacing Quorum's existing `run`, `run-all`, `show`, capture, or verdict
  model.
- Solving provider-key proxy nonces, untrusted code execution, or per-run
  spend attribution before the Cloud Build / Stockyard phase.

## Direction

Use a long-lived Terminus-managed EC2 host for v1, and put the operator-facing
run affordances inside Quorum.

The important split is:

- **Terminus owns the workstation.** Terraform provisions EC2, EBS, IAM,
  Tailscale, SSM parameter inventory, backups, host bootstrap, and host-level
  secret materialization.
- **Quorum owns the eval operation.** Quorum exposes safe commands for smoke
  runs, columns, batch profiles, managed jobs, locks, logs, status, and tails
  in Phase 1. Archive, cleanup, reruns, comparisons, and handoff are roadmap
  work for later phases.

This avoids a second command surface. Agents should be able to SSH to the host
and run `uv run quorum ...` with first-class Quorum subcommands. Host-local
glue can still exist for provisioning and secret materialization, but it should
not become the user-facing eval API.

## Current Constraints

The current repository shape matters for the AWS runner design:

- Quorum has 10 Coding-Agent targets and 55 scenario directories.
- The current ready matrix has hundreds of runnable cells.
- Several targets are serial-capped with `max_concurrency: 1`.
- `run-all --jobs` is not a hard global live-cell cap when capped agents are
  included. Uncapped agents share the `--jobs` pool, while capped agents run in
  dedicated lanes beside it.
- `max_concurrency` is process-local today. Two separate SSH sessions can
  violate the same target cap unless Quorum adds host-global locks.
- Some scenarios have long `quorum_max_time` overrides. A broad `full` profile
  can include 60 minute and 90 minute cells.
- Run artifacts can be large and secret-bearing. Local `results/` already has
  tens of GB of ignored artifacts on the Mac Studio.

These constraints mean the v1 runner is not just "a bigger machine." It needs a
managed job layer and conservative scheduling semantics.

## Terminus Host

Add a dedicated `quorum-evals` host in the Terminus repo using the existing
`machine-westworld` pattern.

Recommended v1 defaults:

- Region: `us-west-1`, matching Terminus.
- Instance: `m6i.2xlarge` on-demand.
- Root volume: 100 GB encrypted gp3.
- Data volume: 500 GB encrypted gp3 mounted at `/opt/quorum`.
- Access: Tailscale and SSM only; no public inbound application ports.
- Tailscale identity: `quorum-evals`.
- Tailscale ACL: dedicated `tag:quorum-evals`, not a reused broad service tag.
  SSH should allow eval operators to non-root Unix accounts only.
- IAM: minimal SSM read access for `/quorum-evals/*`, plus S3 access only for
  the private Quorum artifact archive prefix.
- IMDS: block access to `169.254.169.254` from eval users and eval child
  processes, or remove runtime instance-credential dependency before jobs
  start.
- Data durability: `prevent_destroy` on the data volume, backup tags, DLM or
  AWS Backup coverage, and a backup freshness verification step.
- Operators: no `sudo`, no wheel group, and no Docker socket access for eval
  users or agent processes.

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

`SUPERPOWERS_ROOT` defaults to `/opt/quorum/repos/superpowers`.
`superpowers-evals` defaults to `/opt/quorum/results` as the AWS host output
root.

Team members should have separate Unix accounts. V1 managed jobs run as the
invoking Unix user, not a shared `quorum-runner` account. This preserves audit
and prevents same-UID sibling process snooping across operators. Shared
handoff should happen through sanitized job metadata and promoted artifacts,
not through a shared raw run directory.

Host-managed source secret profiles should be root-only. Managed jobs
materialize only the selected target credentials into a per-job `0600` runtime
file for the invoking operator. Personal OAuth/subscription state must not be
shared through the host.

## Managed Job Model

Add a Quorum-managed job model. In Phase 1 this is the central seam for locks,
logs, status, tail, and recovery. Later phases can reuse the same seam for
archive, cleanup, reruns, comparisons, and handoff.

Every managed command creates a job record before it starts side effects:

```text
/opt/quorum/state/jobs/<job-id>.json
/opt/quorum/state/logs/<job-id>.log
```

Local development may use `<out-root>/.quorum/` as a fallback state root, but
the AWS host uses `/opt/quorum/state` so locks cannot be bypassed by changing
`--out-root`.

### Job States

Initial states:

- `planned`: job record exists, locks not yet acquired.
- `running`: supervisor process is active.
- `succeeded`: managed command completed cleanly.
- `failed`: managed command failed.
- `interrupted`: supervisor or child process died unexpectedly.
- `orphaned`: job metadata exists, but the recorded supervisor is gone and the
  final state is unknown.

Phase 1 should fail fast on lock conflicts and cooldowns rather than adding a
queue. `waiting` and richer `finishing` substates belong to later platform
phases if a queue or archive finalizer is added.

### `job.json`

`job.json` should include at least the Phase 1 operational fields:

```json
{
  "schema_version": 1,
  "id": "job-20260612T183000Z-abcd",
  "state": "running",
  "owner": "drew",
  "host": "quorum-evals",
  "command": ["quorum", "batch", "--profile", "sentinel-default"],
  "profile": "sentinel-default",
  "coding_agents": ["claude", "kimi"],
  "scenario_filter": null,
  "tier": "sentinel",
  "include_drafts": false,
  "out_root": "/opt/quorum/results",
  "log_path": "/opt/quorum/state/logs/job-...log",
  "locks": ["global:broad-batch", "target:claude", "target:kimi"],
  "env_profile": "api-key",
  "evals_repo": {
    "path": "/opt/quorum/repos/superpowers-evals",
    "ref": "main",
    "sha": "...",
    "dirty": false
  },
  "superpowers_repo": {
    "path": "/opt/quorum/repos/superpowers",
    "ref": "main",
    "sha": "...",
    "dirty": false
  },
  "supervisor": {
    "kind": "tmux",
    "session": "quorum-job-...",
    "pid": 12345
  },
  "children": [
    {
      "kind": "batch",
      "id": "batch-...",
      "coding_agents": ["claude", "kimi"],
      "status": "running"
    }
  ],
  "artifact_bytes": null,
  "result_rollup": null,
  "tainted": false,
  "started_at": "2026-06-12T18:30:00Z",
  "finished_at": null
}
```

Later phases can add archive URIs, handoff notes, cleanup state, and comparison
metadata without requiring current `batch.json`, `results.jsonl`, or
`verdict.json` readers to understand them.

Foreground commands should stream the durable log, but the job itself should
survive SSH disconnect via `tmux`, `systemd-run`, or another simple host-native
supervisor. The supervisor must hold locks until all child `run-all` processes
exit.

## Quorum CLI Additions

Add Quorum subcommands that express maintainer workflows directly.

Phase 1 command surface:

```bash
uv run quorum doctor
uv run quorum smoke claude
uv run quorum column copilot
uv run quorum batch --profile sentinel-default
uv run quorum status
uv run quorum status --json
uv run quorum tail <run-or-batch-or-job>
```

Later platform phases can add:

```bash
uv run quorum rerun --from-batch <batch-id> --final fail,indeterminate
uv run quorum compare <batch-a> <batch-b>
uv run quorum promote <run-or-batch>
uv run quorum handoff <job-id> --note "what the next agent should know"
uv run quorum archive <run-or-batch>
uv run quorum cleanup --dry-run
```

Use `--coding-agents` as the canonical flag name, matching existing Quorum.
`--agents` can be an alias if useful, but it should not be the primary
documented spelling.

These commands are convenience and safety affordances over `quorum run`,
`run-all`, and `show`, not a replacement for the underlying primitives. On the
AWS host, raw live `run` and `run-all` should still fail closed outside the
managed worker so they cannot bypass locks by accident.

### `quorum doctor`

Checks whether the AWS host can run the selected target before launching a live
eval:

- required binary exists;
- required env or host-managed secret exists;
- `SUPERPOWERS_ROOT` exists and has the expected files;
- repo SHAs and dirty states are recorded;
- lock root and output root are writable;
- target-specific auth mode is supported on this host.

### `quorum smoke`

Runs the canonical smoke scenario for one Coding-Agent at `jobs=1`.

The command should know the current smoke mapping:

- `claude`, `claude-haiku`, `claude-sonnet`, and `codex` use
  `00-quorum-smoke-hello-world`.
- target-specific bootstrap scenarios such as `copilot-superpowers-bootstrap`,
  `gemini-superpowers-bootstrap`, `kimi-superpowers-bootstrap`,
  `opencode-superpowers-bootstrap`, `pi-superpowers-bootstrap`, and
  `antigravity-superpowers-bootstrap` are used when present.

If the canonical smoke scenario is `status: draft`, `smoke` must include it
deliberately. It should not inherit `run-all`'s default draft exclusion by
accident.

### `quorum column`

Runs all runnable scenarios for one Coding-Agent.

It should:

- preview the matrix before starting;
- print worst-case cell-minutes from `quorum_max_time`;
- acquire the target and provider locks before starting;
- respect the target's `max_concurrency`;
- default to `--jobs 1` for serial-capped targets and `--jobs 4` for uncapped
  targets after AWS dry-run measurement confirms the host can sustain it;
- write a durable command log;
- print the resulting job id, batch id, and next triage command.

### `quorum batch`

`quorum batch` should be a profile orchestrator. It should not treat one broad
all-agent `run-all` as the scheduler for v1.

Profiles expand into one or more child `run-all` batches and a meta-job
manifest that records all child batch ids.

Initial profiles:

- `sentinel-default`: a small configured target pair at `--tier sentinel
  --jobs 1` per child. Prefer `claude,codex` only when a dedicated Codex eval
  identity exists; otherwise use `claude` plus another Tier 1 target. This is
  the day one low-risk campaign profile.
- `sentinel-all`: split into one uncapped child batch and serial capped child
  columns. Antigravity stays separate from Gemini.
- `uncapped-group`: `claude,claude-haiku,claude-sonnet,codex,kimi --jobs 4`.
- `capped-column`: one serial-capped target at `--jobs 1`.
- `full-short`: `quorum_tier: full` scenarios whose effective max time is below
  the long-haul threshold, initially 20 minutes or less.
- `full-long-sdd`: long-haul full-tier scenarios, including 60 minute and 90
  minute cells. This requires explicit confirmation.
- `adhoc`: explicit scenario list only.

A raw `full` profile should not be the default safe option. If supported, it
must print target list, scenario count, runnable cell count, worst-case
cell-minutes, long-haul cells, estimated artifact impact, and require an
explicit confirmation flag.

## Locking And Concurrency

Quorum currently coordinates concurrency within one `run-all` process, but not
across separate shells. The AWS host needs host-global locks.

Use `/opt/quorum/state/locks`, not the configured output root, for AWS host
locks. Use `fcntl.flock` or an equivalent open-file-descriptor lock so killed
supervisors release locks automatically. JSON sidecars should exist only for
diagnostics.

Lock acquisition must be deterministic to avoid deadlocks. Acquire locks in
this order:

1. global locks;
2. provider-family locks;
3. target locks;
4. artifact/archive locks.

Initial lock names:

- `global:broad-batch`;
- `provider:google-code-assist`;
- `provider:copilot`;
- `provider:anthropic`;
- `provider:openai`;
- `provider:kimi`;
- `target:<coding-agent>`;
- `archive:<run-or-batch>`;
- `cleanup`.

Provider locks are intentionally conservative in v1. They can be relaxed only
after measured AWS dry runs show that a provider and target can tolerate more
parallelism.

### Command Lock Table

| Command | Locks |
| --- | --- |
| `doctor` | none unless checking a live auth flow |
| `smoke <target>` | `target:<target>` plus provider lock when target is capped or quota-sensitive |
| `column <target>` | `target:<target>` plus provider lock; capped targets force `jobs=1` |
| `batch sentinel-default` | `global:broad-batch` plus target/provider locks for the configured target pair |
| `batch sentinel-all` | `global:broad-batch`; each child takes its target/provider locks |
| `batch uncapped-group` | `global:broad-batch` plus target/provider locks for the group |
| `batch capped-column` | target/provider locks for the selected target |
| `batch full-short` | `global:broad-batch` plus selected target/provider locks |
| `batch full-long-sdd` | `global:broad-batch` plus selected target/provider locks |
| `rerun` | locks for the target/provider set being rerun |
| `archive` / `promote` | `archive:<id>` |
| `cleanup` | `cleanup`, and it must skip active jobs |

When a lock cannot be acquired, Quorum should report the owning job id, owner,
command, start time, lock path, and log path.

Promote the current in-memory rate-limit latch to host state for quota-sensitive
targets. For example, if Antigravity trips a rate-limit marker, Quorum should
record a host-level cooldown under `/opt/quorum/state/cooldowns` and skip or
delay subsequent Antigravity work until the cooldown expires or an operator
clears it.

## Branch And Root Selection

The AWS runner must support reproducible RED/GREEN comparisons and baseline
campaigns.

Managed commands should record both repository states:

- `superpowers-evals` path, ref, SHA, and dirty state;
- `SUPERPOWERS_ROOT` path, ref, SHA, and dirty state.

The default roots are:

```text
/opt/quorum/repos/superpowers-evals
/opt/quorum/repos/superpowers
```

Managed commands should support:

- `--superpowers-root <path>` for an already prepared checkout;
- `--superpowers-ref <ref>` to create a per-job worktree under
  `/opt/quorum/worktrees/`;
- `--evals-ref <ref>` to create a per-job evals worktree when needed;
- explicit refusal when a managed job would mutate a shared checkout while
  another active job is using it.

Never let one session `git checkout` a shared repo while another managed job is
active against that checkout. Per-job worktrees or immutable prepared checkouts
are the safe path.

## Target Auth Tiers

V1 must decide target support by auth mode, not by wishful target list.

### Tier 1: API-key / SSM friendly

These targets can run first if their provider keys are available through the
host's secret materialization path:

- Claude-family targets using `ANTHROPIC_API_KEY`;
- Gemini in API-key mode;
- Kimi using `KIMI_MODEL_API_KEY`;
- Pi using `PI_PROVIDER`, `PI_MODEL`, and `PI_API_KEY`;
- OpenCode with an explicit provider key/model config;
- Copilot provider-mode, when backed by explicit provider credentials rather
  than personal GitHub auth.

### Tier 2: dedicated eval identity required

These targets are allowed only after creating dedicated eval identities with
visible quota, spend ownership, and documented refresh/recovery:

- Codex subscription/OAuth auth;
- Antigravity browser/keyring auth;
- Gemini OAuth;
- Copilot GitHub auth.

### Tier 3: disallowed on the shared host

Do not use personal OAuth, personal subscription auth, or a developer's normal
browser/keyring state on the shared host.

The first AWS dry run should use Tier 1 targets and any Tier 2 target whose
dedicated eval identity is already set up. If no dedicated Codex identity
exists, do not include Codex in the default first dry run.

## Secrets And Environment

Use SSM SecureString parameters under `/quorum-evals/*`. Terraform owns the
parameter inventory and ignores values.

Initial parameter families:

- provider API keys needed for Tier 1 targets;
- Tailscale auth key for the host;
- GitHub read token or app material if the host needs to clone private repos
  without relying on a person's shell auth;
- optional S3 archive settings.

Host bootstrap or a root-owned sync step should materialize target-specific env
files under `/opt/quorum/secrets-runtime` with restrictive permissions. Managed
Quorum commands should copy only the selected target's required values into a
per-job `0600` env file, preferably under tmpfs, then remove it when the job
finishes.

Managed commands must construct a sanitized environment. They should not pass
the invoking shell's full `os.environ` to live evals on the AWS host. Only
allowlisted variables and the selected target's credential material should be
present.

The shared host is not a secret isolation boundary against a malicious eval.
Do not run untrusted scenario code there. Strong host-secret isolation belongs
in a later Cloud Build / Stockyard design.

## Artifacts

Treat `results/` as sensitive.

The host should keep full local artifacts for short-term triage:

- default: 14 days or 150 GB, whichever is hit first;
- longer retention for selected promoted baselines and failure bundles;
- dry-run cleanup before deletion.

Cleanup must not break `quorum show`. Current batch rendering depends on local
run `verdict.json` files, so either:

- keep thin local summaries for every archived run; or
- make `quorum show` archive-aware before deleting local summaries.

### Promotion

Add `quorum promote <run-or-batch>` to freeze important evidence before cleanup.

Promoted artifacts can include:

- full raw run directory;
- Gauntlet-Agent event streams;
- Coding-Agent session logs;
- normalized tool calls;
- token usage;
- command log;
- archive manifest;
- operator note explaining why the artifact is retained.

Promotion should be explicit because raw artifacts may contain secrets or
sensitive transcript content.

### Archive Manifest

Completed runs and batches should be archivable to a private encrypted S3
prefix. Each archive should write a manifest with:

- source run or batch id;
- source job id;
- archive URI;
- repo SHAs and dirty states;
- command/profile;
- created time and operator;
- included file list;
- excluded sensitive file classes;
- byte counts by component;
- whether the artifact is promoted.

Default long-term archive should prioritize:

- `batch.json`;
- `results.jsonl`;
- each run's `verdict.json`;
- `coding-agent-token-usage.json`;
- normalized `coding-agent-tool-calls.jsonl` when needed for behavior triage;
- command log;
- thin local summaries required by `quorum show`.

Raw transcripts, config homes, workdirs, and Gauntlet-Agent event streams
should be retained only when promoted or when actively triaging a failure.

## Observability, Handoff, And Recovery

Quorum should make remote operation easy for agents:

- every managed command writes a command log;
- `quorum status` lists active jobs, active locks, recent batches, owner, age,
  command, repo SHAs, out root, and log path;
- `quorum status --json` provides the same state for agents;
- `quorum tail <id>` follows the relevant command log;
- `quorum show <id>` remains the verdict front door;
- `quorum handoff <job-id> --note ...` appends a note to `job.json`;
- stale-lock cleanup is explicit and auditable;
- interrupted SSH sessions do not kill managed jobs;
- orphan detection reports jobs whose supervisor is gone before cleanup.

Use `tmux`, a transient `systemd-run` service, or another simple host-native
mechanism for surviving SSH disconnects. Do not introduce a custom daemon in v1
unless the simple mechanism cannot provide status and cleanup.

## Rerun And Compare

Add first-class support for common triage loops:

```bash
uv run quorum rerun --from-batch <batch-id> --final fail,indeterminate
uv run quorum rerun --from-batch <batch-id> --coding-agents claude --scenarios a,b
uv run quorum compare <batch-a> <batch-b>
```

`rerun` should preserve the original batch metadata and record what changed:
repo SHA, `SUPERPOWERS_ROOT`, target, scenario, profile, and effective command.

`compare` should work on summary artifacts when raw artifacts have been cleaned
up. It should report per-cell final verdict changes, missing cells, cost/time
changes when available, and links to promoted artifacts.

## Cost Controls

EC2 cost is meaningful but not the dominant risk. Model/API spend, long-haul
scenarios, and accidental parallelism are larger risks.

V1 controls:

- default to smoke or sentinel-tier commands;
- default `sentinel-default` to a small configured target pair, not all targets;
- require explicit confirmation or a flag for `sentinel-all`, `full-short`, and
  `full-long-sdd`;
- split long-haul SDD-style scenarios out of ordinary `full`;
- print matrix size, runnable cells, skipped cells, long-haul cells, and
  worst-case cell-minutes before starting;
- record estimated cost from verdict economics after each run;
- summarize batch cost when available;
- keep provider-specific concurrency conservative;
- add CloudWatch/AWS budget alerts for EC2, EBS, snapshots, and S3;
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
- a failed or malicious eval must not be able to inspect sibling artifacts,
  host secrets, or instance credentials.

The v1 Quorum command design should survive that migration. A later isolated
runner can execute the same `quorum smoke`, `column`, `batch`, `rerun`, and
`compare` commands inside a disposable box.

Do not overclaim Cloud Build nonce isolation for Quorum until the current
Cloud Build path is freshly validated for this use case.

## Implementation Seams

This should remain one umbrella design, but it needs two implementation plans.

### Quorum CLI / Ops Plan

Likely Quorum work:

- add managed-job state under `.quorum` locally and `/opt/quorum/state` on the
  AWS host;
- add lock helpers with `fcntl.flock`, JSON sidecars, deterministic acquisition,
  ownership reporting, and stale/orphan detection;
- add Phase 1 command modules for `doctor`, `smoke`, `column`, `batch`,
  `status`, and `tail`;
- extend batch metadata additively with `job_id`, command, profile, user, host,
  repo SHAs, out root, log path, locks, tier, scenario filter, env profile,
  effective concurrency, result rollup, taint state, and artifact byte counts;
- preserve compatibility with current `batch.json` consumers and tests;
- document the AWS-host workflow in the README or a runbook.

### Terminus Infra Plan

Likely Terminus work:

- add a `terraform/quorum-evals/` service root;
- instantiate `machine-westworld`;
- add an encrypted persistent data volume with `prevent_destroy`, backup tags,
  DLM or AWS Backup policy, and backup freshness verification;
- add SSM parameter inventory under `/quorum-evals/*`;
- add least-privilege IAM for SSM read. Private S3 artifact archive access is a
  later phase;
- block IMDS for eval users/processes;
- add dedicated Tailscale tag and SSH ACLs;
- add cloud-init bootstrap for uv, Python, Node, agent CLIs, Gauntlet,
  Tailscale, repo checkout, filesystem layout, budgets, and secret
  materialization;
- verify Terraform plans do not replace existing Terminus hosts or persistent
  volumes.

## Implementation Sequence

Phase 1a:

1. Add managed-job state, locks, logs, `status`, and `tail` locally without
   changing live eval execution.
2. Make AWS host-mode raw live `run` / `run-all` fail closed outside the
   managed worker.
3. Add sanitized run-environment plumbing and selected-target secret
   materialization.
4. Add `doctor`, `smoke`, and sentinel `column` wrappers over existing `run` /
   `run-all`.
5. Write the Terminus infra plan.
6. Provision the AWS host.
7. Run the Phase 1a AWS dry run with one ready key-backed target.

Phase 1b:

1. Add the explicit `sentinel-default` batch profile manifest.
2. Run the provider-diverse sentinel campaign after a second key-backed target is
   honestly `doctor`-ready.
3. Adjust defaults from measured data.

Later phases:

- branch/root pinning and per-job worktree creation;
- `rerun`, `compare`, `promote`, `archive`, `handoff`, and `cleanup`;
- S3/private index, queueing, Slack/web submission, and multi-host workers.

## Testing Strategy

Static/unit checks remain safe for CI:

```bash
uv run ruff check
uv run ty check
uv run quorum check
uv run pytest
```

Add Quorum tests for:

- lock ownership, conflict reporting, deterministic acquisition, and orphan
  detection;
- job state transitions and `status --json`;
- durable log creation and `tail`;
- smoke mapping, including draft smoke scenarios;
- profile expansion into child batches;
- additive batch metadata;
- branch/root metadata capture.

Use `CliRunner` with fake `run_batch` or fake child invocations for command API
tests. AWS verification stays manual/runbook-level.

## AWS Dry-Run Verification

Before treating the AWS runner as usable:

1. Terminus Terraform plan shows no unrelated replacement of existing hosts or
   persistent volumes.
2. Tailscale identity, ACL, SSH behavior, IAM, IMDS blocking, data-volume mount,
   backup tags, and backup policy are verified.
3. Host bootstrap installs required binaries and clones the expected repo SHAs.
4. `quorum doctor claude` passes.
5. `quorum smoke claude` passes.
6. `quorum column claude` starts as a managed sentinel column and writes a batch
   artifact.
7. `status`, `tail`, and `show` work from a fresh SSH session.
8. `quorum batch --profile sentinel-default` completes only after a second
   key-backed target is ready.
9. The run records p50/p90/p99 cell duration, lock conflicts/cooldowns, active
   live cells, CPU, memory, EBS IOPS/throughput/queue, network, artifact bytes
   by component, provider 429s/quota errors, and cost coverage.

## Open Questions

- Which Tier 2 dedicated eval identities do we want before day one?
- Should the first archive path be S3-only, or should it also publish a small
  private index for easier browsing over Tailscale?
- What raw transcript retention is acceptable: 7 days, 14 days, or manual
  promotion only?
- What is the first measured threshold for relaxing any provider-family lock?
