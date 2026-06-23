# Shared eval appliance and remote supervisor

**Date:** 2026-06-18
**Status:** design approved
**Builds on:**
`2026-06-15-container-runtime-design.md`,
`2026-06-15-run-all-resilience-design.md`,
`2026-06-18-dashboard-decoupling-design.md`

## Problem

Live quorum evals need to run from a shared machine that has the credentials and
tooling required for real Coding-Agent launches. Local workstation runs are too
dependent on individual shell state, auth freshness, installed CLIs, and
checkout drift. Public CI is still the wrong place for live evals because live
runs launch agent CLIs in permissive modes and preserve sensitive transcripts,
tool calls, run homes, and token/cost artifacts.

The current codebase is now ready for a simpler remote design than earlier
remote-runner sketches:

- the container runtime already gives quorum a rich, reproducible Linux
  workspace with explicit read-only credential inputs;
- `run-all` already writes durable batch artifacts, heartbeats while running,
  and handles interruption gracefully;
- the dashboard is intentionally read-only and can watch shared `results/`
  without becoming a launcher;
- per-run home isolation means the Coding-Agent config/auth state is copied
  into `results/<run>/home` for the run rather than read directly from an
  operator's real home.

We need a design that lets agents run shared evals on behalf of maintainers
soon, while leaving a clean path to a small queue/supervisor once the appliance
workflow proves itself.

## Constraints

The whole `quorum run` lifecycle must execute on the shared box. Splitting
"local quorum" from a "remote Coding-Agent" fights current assumptions:
`setup.sh`, pre-checks, Gauntlet, generated launchers, session-log snapshot/diff,
capture, post-checks, and verdict composition all expect one filesystem and
absolute paths under the run directory.

Live runs remain trusted-maintainer operations, but the routine caller is an
agent acting on a maintainer's behalf. The shared machine is an eval appliance,
not public CI.

`quorum run` and `quorum run-all` must not implicitly change Git checkouts or
credentials. Repository sync and preflight are explicit agent actions before
launch.

The dashboard remains read-only. Phase 2 may add launch/status/cancel APIs, but
the dashboard package should continue consuming filesystem artifacts rather than
owning process control.

## Decision

Build this in two milestones:

1. **Phase 1: shared eval appliance.** A trusted shared host runs the existing
   containerized quorum workflow through a noninteractive, agent-friendly CLI
   with one blessed credential bundle, explicit repo sync/preflight, lightweight
   job state, and provenance capture.
2. **Phase 2: thin remote supervisor.** A small queue/control layer on the same
   host submits and supervises the same containerized quorum commands. It
   upgrades Phase 1 job records into a durable store, keeps status/cancel/audit
   metadata stable, and later adds credential-bundle selection without replacing
   the quorum artifact model.

## Phase 1: shared eval appliance

Phase 1 is an agent-operated wrapper around today's runtime, not a new runner.
Agents reach the appliance through an approved private remote execution channel
and call one installed helper. Provider-specific access details live in the
private ops runbook, not this public design. The helper is designed for agents:
noninteractive, idempotent where possible, structured-output capable, and safe
to re-run after a dropped session.

### Host layout

The appliance has one configured root, defaulting to:

```text
/srv/quorum/
  bin/
    evals-appliance       installed trusted helper entrypoint
  config/
    appliance.json        host-local config; not in the repo
  superpowers-evals/      quorum repo; appliance branch, normally main
  superpowers/            system under test; branch/tag/SHA selected per run
  gauntlet/               Gauntlet checkout; appliance branch, normally main
  credentials/blessed/
    credentials.env       env credential file mounted read-only
    metadata.json         non-secret bundle id/generation/provider list
    codex/                optional Codex auth source
    gemini/               optional Gemini/Antigravity auth source
    kimi-code/            optional Kimi auth source
    pi/                   optional Pi auth source
  state/
    jobs/                 Phase 1 file-backed job records
    locks/                sync/run locks
    provenance/           preflight and run provenance snapshots
```

The root may be overridden per host, but the helper configuration must name the
three repository paths and the blessed credential bundle path explicitly. The
runtime still writes quorum artifacts under the evals checkout's `results/`
directory, which is host-visible and treated as sensitive.

The helper entrypoint and host config are installed outside the mutable evals
repo. The installed helper may dispatch to repo code only after verifying the
repo checkout is clean and at the configured trusted ref. Live runs should mount
the evals, Superpowers, and Gauntlet code read-only wherever the container
wrapper supports that; only `results/` should be writable. Until the container
wrapper has first-class read-only code mounts, preflight and postflight must
dirty-check the repos, and a dirty postflight marks the job `quarantined` for
human review rather than silently continuing to use the mutated checkout.

### Host and access boundary

The Phase 1 box lives as an organization-managed cloud host with no public
interactive ingress. Normal agent access is through the approved private access
path. Provider break-glass access is reserved for recovery when that normal path
is unavailable.

Security posture:

- Remote access is limited to named maintainer and agent identities.
- The appliance runs live evals as a dedicated `quorum-runner` Unix user.
- The runner user does not have broad sudo and does not expose general
  Docker-group access to operators; the helper owns the narrow container
  lifecycle commands needed for evals.
- The instance profile is least-privilege: host management and telemetry basics,
  optional read access to exact secret references if bootstrap fetches
  credentials, and no broad object-storage, secret-store, or admin permissions.
- IMDSv2 is required. Container access to IMDS is blocked unless a future design
  explicitly needs it; credentials should be fetched outside the agent runtime
  and materialized as the blessed bundle.
- `/srv/quorum` lives on encrypted EBS. Snapshots, if enabled, are encrypted and
  governed by the same retention policy as raw artifacts.
- The dashboard binds only to loopback or the approved private network. It is
  read-only, but still exposes scenario names, timing, failure, and cost
  metadata, so it is not public.

This is a trusted-operator box, not a sandbox for untrusted PRs or scenarios.

### Credential model

Phase 1 uses exactly one credential bundle: `blessed`.

The bundle is mounted into the container using the existing container interface.
Gauntlet is built into the image, so `--gauntlet-root` belongs to `build`, not
`up`:

```bash
scripts/evals-container \
  --gauntlet-root /srv/quorum/gauntlet \
  build

scripts/evals-container \
  --superpowers-root /srv/quorum/superpowers \
  --env-file /srv/quorum/credentials/blessed/credentials.env \
  --auth codex=/srv/quorum/credentials/blessed/codex \
  --auth gemini=/srv/quorum/credentials/blessed/gemini \
  --auth kimi=/srv/quorum/credentials/blessed/kimi-code \
  --auth pi=/srv/quorum/credentials/blessed/pi \
  up
```

Missing auth-source directories may be omitted for agents that do not use them.
The credential bundle is not copied into the repo and is not committed. Run
artifacts may contain copied per-run credentials under `results/<run>/home`, so
artifact access remains sensitive.

`credentials/blessed/metadata.json` is required and contains only non-secret
inventory:

```json
{
  "bundle_id": "blessed-2026-06-18-a",
  "rotated_at": "2026-06-18T00:00:00Z",
  "providers": ["anthropic", "openai", "kimi", "pi"],
  "note": "initial shared appliance bundle"
}
```

Provenance records both the bundle name and this generation id. Do not hash raw
secret values for evidence unless a separate security review explicitly chooses
that policy.

Antigravity is not considered remote-appliance-ready until a live container
smoke proves that its `agy` auth path works without hidden dependence on a
human desktop/keyring session. Installing `agy` in the image is not enough by
itself.

Credential incident response for Phase 1 is deliberately blunt:

1. acquire the run lock if possible and stop active process groups;
2. run `scripts/evals-container down`;
3. disable remote access to the runner user;
4. mark the current bundle generation revoked;
5. quarantine raw `results/` and preserve only reviewed summaries;
6. rotate every provider token/OAuth source in the bundle;
7. require `doctor --json` to pass before re-enabling live jobs.

### Repository sync and refs

Phase 1 installs an explicit sync/preflight helper named `evals-appliance`
under `/srv/quorum/bin`. The installed wrapper is the public appliance command;
it may dispatch into repo code only after verifying the trusted evals checkout.

The host-local appliance config names the managed refs, remotes, container
identity, credential bundle, and results root:

```json
{
  "root": "/srv/quorum",
  "evals": {
    "path": "/srv/quorum/superpowers-evals",
    "remote": "origin",
    "ref": "main"
  },
  "superpowers": {
    "path": "/srv/quorum/superpowers",
    "remote": "origin"
  },
  "gauntlet": {
    "path": "/srv/quorum/gauntlet",
    "remote": "origin",
    "ref": "main"
  },
  "credential_bundle": {
    "name": "blessed",
    "path": "/srv/quorum/credentials/blessed"
  },
  "container": {
    "name": "quorum-appliance",
    "results_root": "/srv/quorum/superpowers-evals/results"
  }
}
```

The helper exposes an agent-safe CLI surface:

```text
doctor    [--json]
prepare   [--json] --superpowers-ref <ref>
run       [--json] [--detach] --superpowers-ref <ref> --scenario <name> --coding-agent <agent>
run-all   [--json] [--detach] --superpowers-ref <ref> -- <quorum run-all args...>
status    [--json] <job-id>
cancel    [--json] <job-id>
show      [--json] <job-id-or-artifact-id>
costs     [--json] <job-id-or-artifact-id>
```

All appliance flags, including `--json`, belong before the `--` separator.
Everything after the separator is passed verbatim to `quorum run-all`; do not
invent a `quorum run-all --json` flag in Phase 1.

`run` and `run-all` may execute in the foreground for short jobs, but detached
mode is the default for agent-run batches. A detached invocation creates a
durable job record, starts a host-side supervisor process, returns the job id
while the job is still `preflighting`, writes stdout/stderr to stable log paths,
and lets the calling agent recover with `status` after SSH loss. Foreground mode
runs the same preflight and launch path inline. Phase 1 does not need a general
queue: one active live or mutating preflight job at a time is enough, guarded by
a run lock. The lock prevents two agents from accidentally launching competing
live batches against the same blessed credential bundle or mutating a shared
checkout while a live batch is using it.

`doctor` is read-only. It validates host config shape, required paths, bundle
metadata presence, container existence/health when present, lock records, and
whether referenced processes still exist. It must not fetch, checkout, build,
start/recreate containers, source the credential env, remove locks, or mutate
job records.

`prepare --superpowers-ref <ref>` performs the same repo sync, exact-ref
resolution, container validation/reconciliation, `evals-tool-versions`, and
`quorum check` preflight used by a live launch, then exits without starting a
live eval. Because it may mutate shared checkouts or container mounts, it must
acquire the same run-lock gate as `run`/`run-all` for the duration of the
prepare. If a live job is active, `prepare` fails with `lock_busy`; it must not
change refs underneath an active containerized eval. A successful JSON response
includes the requested/ref-resolved SHAs, credential bundle generation, image
identity, mount signature, and the path to captured tool-version/preflight
evidence.

`superpowers-evals` and `gauntlet` are appliance-managed checkouts. They should
normally track configured branches such as `main`. The helper must require clean
worktrees, run `git fetch --prune --tags`, and fast-forward only from the
configured remote. It must not silently merge, rebase, or discard local changes.
If the configured `gauntlet` ref changes, the helper rebuilds the image and
recreates the container before live launch; the SHA to record is the Gauntlet
SHA built into the image, not merely the current host checkout.

`superpowers` is the system under test and may be selected per run with a branch,
tag, or SHA. Agents may pass a mutable ref such as a feature branch. The helper
must resolve it against the configured remote, fail closed on ambiguous
branch/tag names, and then check out the exact commit in detached-head state
before launch. The run evidence records both:

```json
{
  "superpowers_requested_ref": "drew/my-feature",
  "superpowers_resolved_sha": "abc123..."
}
```

The checked-out `superpowers` worktree must match the resolved SHA before a live
run starts. Recording only a branch or tag name is not acceptable evidence.

### Job and lock records

Phase 1 stores one directory per command under
`/srv/quorum/state/jobs/<job-id>/`. The canonical job record is
`job.json` inside that directory, with stdout/stderr logs beside it. Writes must
be atomic: write a temporary file in the same directory, fsync where practical,
and rename into place.

Minimum schema:

```json
{
  "schema_version": 1,
  "job_id": "job-20260618T220102Z-a1b2",
  "kind": "run-all",
  "status": "running",
  "created_at": "2026-06-18T22:01:02Z",
  "updated_at": "2026-06-18T22:03:11Z",
  "started_at": "2026-06-18T22:01:25Z",
  "finished_at": null,
  "requester": {
    "agent": "codex",
    "thread": "optional-thread-id",
    "task": "optional-task-id",
    "host_user": "quorum-runner",
    "remote_identity": "private-access-identity"
  },
  "command": {
    "argv": ["quorum", "run-all", "--tier", "sentinel"],
    "sanitized": true
  },
  "refs": {
    "superpowers_requested_ref": "drew/my-feature",
    "superpowers_resolved_sha": "abc123...",
    "evals_ref": "main",
    "evals_resolved_sha": "def456...",
    "gauntlet_ref": "main",
    "gauntlet_built_sha": "789abc..."
  },
  "credential_bundle": {
    "name": "blessed",
    "bundle_id": "blessed-2026-06-18-a"
  },
  "container": {
    "name": "quorum-appliance",
    "id": "docker-container-id",
    "image_id": "sha256:...",
    "mount_signature": "sha256:..."
  },
  "process": {
    "host_pid": 12345,
    "host_pgid": 12345,
    "container_pid": 456,
    "container_pgid": 456
  },
  "artifacts": {
    "run_id": null,
    "batch_id": "batch-20260618T220125Z-a1b2",
    "stdout_log": "/srv/quorum/state/jobs/job-.../stdout.log",
    "stderr_log": "/srv/quorum/state/jobs/job-.../stderr.log",
    "provenance": "/srv/quorum/state/provenance/job-....json"
  },
  "progress": {
    "last_heartbeat_at": "2026-06-18T22:03:11Z",
    "running": 4,
    "done": 7,
    "queued": 12
  },
  "result": {
    "exit_code": null,
    "summary": null
  },
  "error": null
}
```

Allowed job statuses are `preflighting`, `queued`, `running`, `stopping`,
`done`, `failed`, `cancelled`, `lost`, and `quarantined`. A completed batch with
failing cells is `done` with a failing summary, not `failed`; `failed` means the
appliance command itself crashed or preflight failed. `status --json` and
`show --json` derive batch outcomes from `batch.json`, `results.jsonl`, and each
cell's `verdict.json`, not from the `run-all` process exit code alone.

Locks are separate:

- `run.lock` gates live eval launch and every command that can mutate shared
  checkouts or container mounts. Live `run`/`run-all` jobs hold it until the job
  reaches a terminal status. `prepare` holds it only for its preflight window.
- `sync.lock` gates repo fetch, fast-forward, checkout, image build, and
  container mount reconciliation while a command already owns or has been
  admitted through `run.lock`.

All mutating commands acquire locks in one order: `run.lock` first, then
`sync.lock`. They release `sync.lock` before launching the live quorum command,
but live `run`/`run-all` keep `run.lock` until completion, cancellation,
quarantine, or loss is recorded. This avoids the shared-checkout race where one
agent prepares or checks out a new Superpowers ref while another agent's live
container is still executing against the mounted tree.

`status`, `show`, `costs`, and `doctor` are lock-free reads and must not source
the blessed credential env. Lock records include the job id, host, pid/pgid,
started_at, command, and resolved refs. `doctor --json` reports stale locks but
must not remove them while a matching live process or container exec is still
present.

### Preflight

The Phase 1 helper performs preflight before live runs:

1. acquire `run.lock` or report the active job holding it;
2. acquire `sync.lock` or report the active job holding it;
3. verify all configured repository paths exist;
4. verify the three worktrees are clean before changing refs;
5. fetch all three repositories;
6. fast-forward `superpowers-evals` and `gauntlet` to their configured appliance
   refs;
7. resolve the requested `superpowers` ref to a SHA and check out that SHA;
8. build or validate the container image when runtime inputs changed, including
   Gauntlet ref changes;
9. inspect the current container mount signature and start or recreate the
   container when desired mounts changed, as part of the command that already
   holds `run.lock`;
10. run `scripts/evals-container exec evals-tool-versions`;
11. run `scripts/evals-container exec quorum check`;
12. write a job-scoped provenance snapshot before launching any live run or
    batch;
13. release `sync.lock`;
14. for live `run`/`run-all`, launch while continuing to hold `run.lock`; for
    `prepare`, release `run.lock` after recording the preflight result.

If any preflight step fails, the helper stops before launching a live eval.
Failures must be machine-readable under `--json`, including a stable error code,
the failed step, and enough detail for the calling agent to decide whether to
retry, ask for help, or stop. Failed preflight releases both locks after the job
record captures the failure.

Stable Phase 1 error codes include `config_invalid`, `lock_busy`,
`repo_dirty`, `fetch_failed`, `ref_ambiguous`, `ref_not_found`,
`checkout_failed`, `image_build_failed`, `container_recreate_required`,
`container_unhealthy`, `tool_versions_failed`, `quorum_check_failed`,
`unsupported_os`, `job_not_found`, `job_not_running`, `cancel_failed`, and
`artifact_missing`.

### Provenance

Every appliance run or batch has a small provenance artifact. In Phase 1 the
authoritative pre-launch artifact is job-scoped under
`state/provenance/<job-id>.json`, because current `quorum run` allocates the
final run directory internally. After a run id or batch id is known, the helper
copies or links the job provenance beside the final artifact.

It records:

- `superpowers-evals` requested ref and resolved SHA;
- `superpowers` requested ref and resolved SHA;
- `gauntlet` requested ref and the SHA built into the image;
- credential bundle name (`blessed`) and non-secret bundle id;
- container image tag, image id, and digest when available;
- mount signature and whether code mounts were read-only;
- `evals-tool-versions` output path or captured text;
- requesting agent/thread/task identity when supplied, plus the host account
  and remote identity that executed the helper;
- command line used for the live quorum invocation;
- UTC timestamp.

Provenance supplements `verdict.json`; it does not change the existing verdict
schema in Phase 1.

### Running evals

Agents run existing quorum commands through the installed appliance helper
rather than typing raw container-wrapper commands by default:

```bash
evals-appliance run-all --json --detach \
  --superpowers-ref drew/my-feature \
  -- --tier sentinel \
     --coding-agents claude,claude-haiku,claude-sonnet,codex,kimi \
     --jobs 4
```

The helper shells out to `scripts/evals-container exec quorum ...` after
preflight and records the launched process/job metadata. Detached jobs must run
under a tracked host process group, with enough container process identity to
send SIGINT to the in-container `quorum run` or `run-all` process group. The
current `run-all` heartbeat and graceful signal handling remain the Phase 1
liveness and stop model, but the appliance owns the outer job record and log
files.

`cancel` sends SIGINT to the tracked process group, marks the job `stopping`,
polls for stopped verdicts or a batch footer, and then records `cancelled`.
After a bounded grace period it may report `lost`, but Phase 1 should not jump
straight to SIGKILL unless a human uses the break-glass path.

Agents inspect batches through the helper:

```bash
evals-appliance status --json <job-id>
evals-appliance show --json <job-id>
evals-appliance costs --json <job-id>
```

Raw `scripts/evals-container exec quorum ...` remains the break-glass escape
hatch, but it is not the default agent entry point. The read-only dashboard may
run on the host against the shared `results/` and `grid-manifest.json`, but it
does not submit or stop jobs.

Phase 1 is Linux-container-only for `run-all`. Single-run Windows evals remain a
separate trusted-maintainer path until the appliance helper grows explicit
Windows VM preflight and `run-all --os` support. Requests outside the supported
OS set return `unsupported_os`.

### Artifact lifecycle

Raw `results/` are secret-bearing. Phase 1 should start with conservative local
retention rather than pretending these artifacts are harmless:

- `/srv/quorum/credentials`, `state/jobs`, `state/provenance`, and raw
  `results/` are readable only by the runner/admin group; helper-created files
  use `umask 077` unless a summary is intentionally shared.
- Raw homes, transcripts, tool-call traces, and credential copies are not backed
  up to broad storage by default.
- If EBS snapshots are enabled, they are encrypted and have an explicit short
  retention window.
- Phase 2 adds `archive`/`prune`; Phase 1 must at least keep cleanup from
  breaking `quorum show` by preserving `batch.json`, `results.jsonl`,
  `verdict.json`, and cost summaries before deleting raw homes/logs.

## Phase 2: remote supervisor

Phase 2 upgrades the Phase 1 file-backed job handle into a small control plane
around the same appliance runtime. It should not replace `quorum run`,
`run-all`, the scheduler, or the results layout.

The supervisor owns:

- a durable SQLite job table, replacing the Phase 1 file-backed job records;
- job submission with requested refs, scenarios, agents, tier, jobs, and OS;
- server-side ref resolution and preflight gating;
- process groups for each launched containerized quorum command;
- status and cancel;
- audit metadata: submitter, requested refs, resolved SHAs, credential bundle,
  command, timestamps, pid/process group, final run or batch id;
- safe summary reads over `batch.json`, `results.jsonl`, `verdict.json`, and
  cost artifacts.

The supervisor shells out to the same container wrapper and quorum CLI that
Phase 1 uses. This keeps the implementation honest: the appliance workflow is
the break-glass escape hatch and the supervisor is the durable agent-facing
surface.

Phase 2 can introduce named credential bundles, but the first supervisor slice
may still allow only `blessed`.

### Supervisor API shape

The first API is CLI-first. HTTP can be added later after the job model is
proven. The required CLI operations are:

```text
submit   requested refs + quorum run/run-all arguments -> job id
status   job id -> queued/running/stopping/done/failed + artifact ids
cancel   job id -> SIGINT process group, then surface stopped verdicts
show     job id -> summarized batch/run view
costs    job id -> summarized cost view
```

Raw transcripts, run homes, and tool-call artifacts are not exposed by default.
The summary path reads the same safe surfaces as `quorum show` and `quorum
costs`.

## Non-goals

- No public CI live evals.
- No distributed worker pool in Phase 1.
- No general multi-job queue in Phase 1; one active live job at a time is
  sufficient.
- No branch mutation inside `quorum run` or `quorum run-all`.
- No new results layout.
- No dashboard launch/stop UI in this design.
- No multi-tenant credential isolation in Phase 1.
- No Antigravity appliance support until the auth path is proven with a live
  container smoke.
- No Windows `run-all` appliance support in Phase 1.
- No untrusted PR/scenario execution on the shared credential appliance.

## Implementation outline

### Phase 1

Infra/bootstrap:

1. Provision the organization-managed cloud host, encrypted state volume,
   `quorum-runner` Unix user, private remote access, least-privilege instance
   profile, and dashboard bind policy.
2. Install host-local appliance config and the helper entrypoint outside the
   mutable repo.

Repo/helper:

1. Implement config loading plus `doctor --json` as a read-only inspection path.
2. Implement clean-worktree, fetch, fast-forward, and ref-resolution checks,
   including ambiguous-ref failures.
3. Implement the `run.lock`/`sync.lock` ordering and cover the no-checkout-
   mutation-while-live invariant with tests.
4. Wire the helper to the existing `scripts/evals-container` flags using the
   blessed credential bundle.
5. Prove process control with a small detached container command before live eval
   integration: capture host/container pid or pgid, send SIGINT through the
   tracked process group, and observe a recorded terminal job state.
6. Add file-backed job records, lock inspection, stale lock reporting, `prepare`,
   `status`, `cancel`, `show`, and `costs`.
7. Capture `evals-tool-versions`, repo SHAs, command line, image identity, and
   credential bundle generation into job-scoped provenance artifacts.
8. Document agent workflows in `docs/appliance-runbook.md` for sentinel, full,
   single-scenario, stop, show, costs, dashboard, and break-glass.
9. Fix documentation drift found during scouting: explicit `SUPERPOWERS_ROOT`
   language, current Antigravity container status, per-agent auth matrix, and
   current run-directory shape.
10. Add post-run repo dirty checks and quarantine status.

### Phase 2

1. Add a SQLite-backed job store.
2. Add submit/status/cancel/show/costs commands around the Phase 1 helper.
3. Launch containerized quorum commands in tracked process groups.
4. Persist job metadata and artifact IDs.
5. Add tests for ref resolution, preflight failure, process cancellation, and
   summary rendering.

## Verification

Phase 1 is ready when:

- a clean appliance can sync `superpowers-evals`, `gauntlet`, and a selected
  `superpowers` branch/tag/SHA;
- `prepare` and live launch commands cannot mutate shared checkouts while a live
  job holds `run.lock`;
- the helper records requested refs and resolved SHAs;
- provenance records the Gauntlet SHA built into the image and the credential
  bundle generation id;
- `evals-tool-versions` and `quorum check` pass through the container;
- a sentinel batch runs with the blessed credential bundle;
- an agent can start a detached long-running batch, lose the shell session, and
  recover the job with `status`;
- `cancel` sends SIGINT through the tracked process group and produces recorded
  stopped/indeterminate cells rather than orphaned unrecorded work;
- helper `status --json` distinguishes running, crashed, cancelled, completed
  with failing cells, and lost jobs from artifacts rather than process exit alone;
- helper `show`, helper `costs`, `quorum show <batch-id>`,
  `quorum costs <batch-id>`, and the read-only dashboard can inspect the shared
  results without sourcing live credentials;
- post-run dirty repos produce `quarantined` status;
- the resulting provenance is enough to reproduce which code and credentials
  were used.

Phase 2 is ready when:

- jobs can be submitted without an interactive shell;
- job status survives process restarts;
- cancel maps to the same graceful SIGINT behavior as current `run-all`;
- completed jobs point to existing run or batch artifacts;
- summary reads do not expose raw sensitive artifacts by default.
