# Campaign Appliance V2 Child 1 — Attempt Worker Skeleton Design

**Date:** 2026-09-02

**Status:** draft for Drew's review

**Parent:** `docs/superpowers/specs/2026-09-02-campaign-appliance-v2-design.md`
(re-cut revision, `98b3afd`)

**Delivery order:** child 1 of 4

## Decision

Child 1 moves the existing campaign controller onto the appliance host and
replaces its process spawner with a container spawner. Every attempt runs in
one fresh Docker container whose command is the attempt itself, whose init is
PID 1 with Quorum as its direct child, and whose lifetime is exactly the
attempt's lifetime. The existing Quorum -> Gauntlet -> private tmux ->
generated launcher -> Coding-Agent chain runs unchanged inside it.

The controller is reached through one new helper verb,
`evals-appliance campaign run <campaign-id>`. Registration stays the raw
host-side `quorum campaign register` for this child.

V1 contracts are untouched except for one additive change: the journal's
`run_allocated` event gains a container-identity payload alongside the
existing process-group payload. Child 3 deletes both with the rest of V1.

The child is complete when one real attempt runs on the appliance through the
helper, its worker commits a manifest, and the host publishes a real verdict
from that manifest.

## Why this comes first

The parent makes claims it has not observed: that PID-1 exit tears down a
daemonized tmux server, that a SIGKILLed Quorum still leaves readable durable
logs, that container labels are enough to reconcile a created-but-unbound
worker, that the existing chain works when its inputs are read-only mounts
rather than a writable checkout. Every one of those feeds the journal
vocabulary and status observations child 3 will freeze. Building the executor
first turns them into observed facts before they are written into contracts.

It is also the thinnest end-to-end path. Today the helper has no `campaign`
verb at all; the campaign controller has only ever run inside the long-lived
appliance container, spawning attempts as sibling host processes of itself,
and nothing in `src/campaign/` has ever invoked Docker. Child 1 touches every
layer once, thinly, and leaves a runnable path behind.

## Present state this child changes

- `evals-appliance` is a generated bash wrapper that sanitizes its environment
  and runs `bun run src/appliance/cli.ts` on the host as `quorum-runner`, who is
  in the `docker` group. Bun is installed on the host. The helper's verbs are
  `doctor`, `prepare`, `run`, `run-all`, `status`, `cancel`, `show`, `costs`,
  `import`, and `prune`; there is no `campaign` verb.
- `quorum campaign run` is reachable only by hand. Its dispatcher builds a
  `CampaignChildSpec` for `bun <snapshot>/src/cli/index.ts run ...` and hands it
  to a `ChildSpawner`; production is `DetachedChildSpawner`, a detached
  process-group-leader spawn. The child mints its own run directory and emits
  `run_allocated: <run_id>` on stdout, which the dispatcher latches and
  journals with the child's `pgid`.
- Verified death is two-part: kill the process group, then find and kill the
  tmux server hosting the run directory and re-probe until it is gone.
- The live appliance container is created once with `sleep infinity`, `--init`,
  and `docker exec` per job. The selected agent's credential arrives as one
  read-only bind of `agent.env` at `/run/evals/credentials.env`, sourced by the
  in-container `quorum` shim. The grader credential never touches disk in the
  container; it crosses as `docker exec --env-file` under `QUORUM_GRADER_*`
  alias names with `QUORUM_GRADER_SOURCE_MODE=appliance-scoped`, and the runner
  maps the aliases back when building the Gauntlet child environment.
- Campaign snapshots already run `bun install --frozen-lockfile`, so a frozen
  evals tree carries its own dependencies and can be mounted read-only.

## Scope

### In scope

1. A `ContainerAttemptSpawner` implementing `ChildSpawner` over the existing
   `CommandRunner` seam, using `docker create` then `docker start`.
2. A spawned-child handle that is either a process group or a container, and
   a `run_allocated` journal payload carrying `container_id` and image digest
   in place of `pgid`.
3. The attempt entrypoint script, shipped in the frozen evals snapshot, that
   opens the durable log files and `exec`s Quorum.
4. Durable per-attempt raw stdout and stderr files, created mode `0600` by the
   controller before `docker start`, with the controller following them for the
   `run_allocated` protocol line and sensor lines.
5. Exact per-attempt subject and grader credential files, projected on the
   host from the blessed bundle into a private staging directory and delivered
   as two read-only binds.
6. Read-only binds of the frozen evals, Gauntlet, and Superpowers trees; one
   writable durable attempt directory; an attempt-private tmpfs runtime root
   carrying `TMUX_TMPDIR` and `TMPDIR`.
7. Worker-side artifact staging and manifest commit (parent protocol steps 1
   through 5) at the end of a run.
8. Minimal host-side publication: re-parse the manifest, verify digests, rename
   the artifact set into the results root, then journal the terminal event.
9. Container-based stop for the existing `cancel` verb and recovery path:
   `docker stop` with the existing grace, escalation to `docker kill`, death
   verified by inspecting the exact container ID.
10. The `evals-appliance campaign run <campaign-id>` verb with a
    `campaign-run` job record, launching the controller detached on the host.
11. A Linux-only Docker integration suite with fake subject, grader, and
    provider executables.
12. One live attempt on the appliance through the helper.

### Non-goals

- Host-side verification of crash cuts, published-but-unjournaled recovery,
  created-but-unbound reconciliation by label, marker-first cancellation, or
  controller-death fencing; child 2 owns them. Child 1's cancel works only
  while the controller that created the container is alive.
- Any V2 schema, journal vocabulary, status, cost, or namespace change; child
  3 owns them. Campaign directories stay under the evals checkout's
  `campaigns/`, results stay under its `results/`.
- Credential generations, pinning, revocation, authority intersection, or the
  V2 delivery refinement in which Quorum rather than the entrypoint consumes
  the grader file; child 4 owns them. Child 1 reuses the current projection
  code and the current in-container delivery model.
- Helper verbs other than `campaign run`. Registration, listing, status,
  costs, report, abandon, and cleanup stay raw or are owed to child 4.
- Instance-metadata and host-control-route egress blocking; child 4.
- Host cgroup sampling per container and the allowlisted exit snapshot beyond
  exit code, signal, and OOM flag; child 2.
- Preallocated run identities. The worker still mints its run directory and
  emits the protocol line.
- Any change to ordinary `quorum run`, `run-all`, or the Phase 1 appliance
  job path.

## Architecture

```text
operator
   |
   v
evals-appliance campaign run <campaign-id>        (host, quorum-runner)
   |
   +--> job record kind=campaign-run
   |
   +--> setsid bun src/cli/index.ts campaign run <dir> --worker-image <ref>
                     |
                     v
          campaign controller (unchanged dispatcher, on the host)
                     |
                     +--> attempt-projection: subject.env, grader.env  (0700/0400 stage)
                     |
                     +--> ContainerAttemptSpawner
                     |        docker create --init --label ... --mount ...
                     |        docker start <id>
                     |        follow <attempt>/stdout.log, stderr.log
                     |        docker wait <id>; docker inspect <id>
                     |
                     |     [container]
                     |       docker-init (PID 1)
                     |         attempt-entrypoint.sh  --exec-->  bun <snapshot>/src/cli/index.ts run ...
                     |                                              Gauntlet -> tmux -> launcher -> Coding-Agent
                     |                                              staging/ + manifest.json
                     |
                     +--> attempt-publish: verify manifest, rename into results/<run-id>
                     |
                     +--> journal run_completed / typed failure
```

The controller process, dispatcher, journal, locks, sensors, classifier, and
recovery logic are the existing D3 engine. The only new behavior inside the
engine is that a spawned child may be a container.

## Controller placement

The helper's new verb launches the controller on the host exactly as
`run-all --detach` launches its supervisor today: a `setsid` process-group
leader whose pid is recorded in the job record, with stdout and stderr
redirected to the job's log files. The command is
`bun <evals-checkout>/src/cli/index.ts campaign run <campaign-dir>
--worker-image <image-ref>`, run from the evals checkout the wrapper already
verified clean and on the configured ref.

The verb holds `run.lock` for the controller's lifetime through the same
mechanism `run-all --detach` uses, and passes `QUORUM_LIVE_SPEND_LOCK` from the
appliance configuration so the controller contends for the shared host-wide
live-spend lock. The controller's environment is the wrapper's sanitized
environment plus those two values; it carries no credential material.

`--worker-image` selects the container spawner. Without it, `quorum campaign
run` keeps the process spawner for local development and tests. The raw
process path is never used on the appliance.

The image reference is the tag `scripts/evals-container build` produces from
`container/Dockerfile`. The verb resolves it to a digest with
`docker image inspect` before launch and records the digest in the job record.
The controller records the same digest in every `run_allocated` event.

## Container spawner

`ContainerAttemptSpawner` receives the attempt's `CampaignChildSpec` and an
`AttemptMounts` description, and returns a `SpawnedCampaignChild` whose handle
is `{ kind: 'container', container_id, image_digest }`.

Creation and start are separate so the controller can persist the container
identity before any process runs:

1. `docker create` with the arguments below. Capture the full container ID
   from stdout. Verify it by `docker inspect` of that exact ID.
2. Create the durable log files `stdout.log` and `stderr.log` mode `0600` in
   the attempt directory.
3. `docker start <id>`.
4. Follow the two log files on the injected clock, delivering complete lines
   to subscribers with the same latch-and-replay semantics as
   `DetachedChildSpawner`, so a fast worker can never lose its `run_allocated`
   line.
5. `docker wait <id>` for the exit code, then `docker inspect <id>` for
   `OOMKilled`, `FinishedAt`, and the exit code. Publish the terminal exit
   only after both log files have reached end of file.

`docker create` arguments:

- `--init`, so Docker's bundled init is PID 1. It forwards signals, reaps
  children, and exits with its child's status when the entrypoint's `exec`ed
  Quorum exits. It does not linger for reparented tmux or Coding-Agent
  processes; PID-1 exit lets the runtime destroy the namespace. The parent's
  "minimal init such as tini" is satisfied by this without shipping a second
  init.
- `--name quorum-attempt-<campaign-id>-<attempt-id>`.
- `--label quorum.campaign_id=<id> --label quorum.attempt_id=<id>
  --label quorum.evals_sha=<sha>`. Labels carry identities only.
- `--user <uid>:<gid>` of `quorum-runner`, with the synthesized `passwd` and
  `group` files the appliance already generates, bound read-only.
- `--workdir <snapshot-evals>`.
- `--env HOME=<attempt-dir>/home --env TMPDIR=/run/quorum/attempt
  --env TMUX_TMPDIR=/run/quorum/attempt --env XDG_*` beneath `home`. No secret
  value ever appears in `--env`.
- `--tmpfs /run/quorum/attempt:rw,noexec,nosuid,size=<bounded>` and
  `--tmpfs /tmp:rw,size=<bounded>`. The attempt-private `TMUX_TMPDIR` means a
  shared bind can never couple two attempts' tmux servers.
- Mounts, all `type=bind`:

  | source (host) | target | mode |
  |---|---|---|
  | `<campaign>/evals` | same absolute path | ro |
  | `<campaign>/gauntlet` and `<campaign>/bin` | same absolute paths | ro |
  | `<campaign>/superpowers-<sha>` for the selected arm only | same path | ro |
  | `<campaign>/attempts/<attempt-id>` | same path | rw |
  | `<stage>/subject.env` | `/run/quorum/subject.env` | ro |
  | `<stage>/grader.env` | `/run/quorum/grader.env` | ro |
  | synthesized `passwd`, `group` | `/etc/passwd`, `/etc/group` | ro |

  Frozen trees keep their host paths inside the container so every path the
  dispatcher already computes (`--gauntlet-bin`, `--superpowers-root`,
  `--coding-agents-dir`, `--credentials-file`) is valid unchanged. Sibling arm
  trees, the campaign journal, the campaign directory root, the results root,
  other attempts, the mutable checkouts, the Docker socket, and the blessed
  bundle are not mounted. `docker inspect` of the created container is checked
  against exactly this mount list before `docker start`; any extra or missing
  mount removes the exact container ID and fails the attempt typed.
- The command: `<snapshot-evals>/container/attempt-entrypoint.sh` followed by
  the dispatcher's existing argv, with `--out-root` pointed at
  `<attempt-dir>/staging` rather than the results root.

Networking is the default bridge, as today.

## Attempt entrypoint

`container/attempt-entrypoint.sh` lives in the evals tree and therefore in
every frozen snapshot. It:

1. Redirects its own stdout and stderr to `<attempt-dir>/stdout.log` and
   `stderr.log` in append mode. The controller created them; the entrypoint
   never creates or truncates them.
2. Exports the subject delivery into its environment with the same
   `set -a; source; set +a` the current in-container `quorum` shim uses on
   `/run/evals/credentials.env`, and the grader delivery the same way. Both
   files are controller-written with a fixed `NAME=value` grammar and mode
   `0400`; this child keeps the existing shell-sourced model deliberately and
   child 4 replaces it with non-shell parsing.
3. `exec`s `bun <snapshot-evals>/src/cli/index.ts run ...`.

After step 3 the process tree is `docker-init -> bun (Quorum)`, and Quorum
builds the Gauntlet child environment from the `QUORUM_GRADER_*` aliases
exactly as it does under the Phase 1 `docker exec --env-file` path. The subject
launcher's `env -i` allowlist is unchanged. The grader values sit in Quorum's
and Gauntlet's environment inside the container, which is the accepted Phase 1
residual and the parent's stated non-boundary.

## Credential projection

For each admitted attempt the controller writes a private staging directory
`<campaign>/attempts/<attempt-id>/.stage` mode `0700` containing:

- `subject.env`: the env names and values the selected `(agent, credential)`
  cell projects, produced by the same code path that builds `agent.env` for a
  Phase 1 job, plus `GEMINI_AUTH_TYPE` when the scope pins it. Mode `0400`.
- `grader.env`: the `QUORUM_GRADER_*` aliases and
  `QUORUM_GRADER_SOURCE_MODE=appliance-scoped`, produced by the same code path
  that builds `supervisor.exec.env`. Mode `0400`.

Both are owned by `quorum-runner`, which is also the container user. The
existing all-pairs check that no delivered subject value equals any grader
value runs before the files are written; equality refuses the attempt typed
without naming a value.

The controller reads the blessed bundle the appliance configuration names, as
Phase 1 does. It does not read the bundle into its own environment, and the
dispatcher's existing `composeCampaignChildEnv` key-value injection is bypassed
on the container path: `CampaignChildSpec.env` carries names only, and the
values travel in the two files. The journal's key-grant record is unchanged
because it already records names, never values.

OAuth directory projections are out of scope; the parent's V2 accepts only
`api-key` and `bedrock-bearer`. A campaign cell whose credential needs an
OAuth home refuses at admission with a typed error.

The stage directory is removed after the container is confirmed stopped and
the attempt's terminal event is journaled. Child 2 adds removal by
reconciliation when the controller dies between those steps.

## Durable attempt directory

```text
<campaign>/attempts/<attempt-id>/
  stdout.log          controller-created 0600, worker-appended raw stdout
  stderr.log          controller-created 0600, worker-appended raw stderr
  home/               the run's throwaway $HOME (sensitive, never published)
  staging/            the worker's --out-root; holds the run dir
    <run-id>/
      verdict.json, trajectory.json, ... (existing runner artifacts)
      manifest.json   written last
  exit.json           controller-written: exit code, signal, OOM flag, times
  .stage/             credential files; removed after terminal journaling
```

`attempts/` sits inside the campaign directory, which sits inside the evals
checkout beside `results/`. Both are on the same filesystem, so publication is
an atomic rename. Moving durable data out of the checkout is child 3's
namespace work.

## Manifest commit and publication

At the end of a run whose `--campaign-identity` is present, the runner writes
`manifest.json` into the run directory as its final act:

1. Write and fsync every artifact it already produces.
2. Write `manifest.json` listing each file's relative path, size, and
   lowercase SHA-256, plus the campaign identity and run ID.
3. Fsync it, rename it into place, fsync the run directory.
4. Exit.

Worker exit is not completion. After `docker wait`, the controller:

1. Requires exactly one run directory under `staging/` and a `manifest.json`
   inside it. Absence is a typed `instrument_failure` with the exit record and
   logs retained.
2. Re-parses the manifest, verifies every digest and size, and rejects any
   listed path that is absolute, contains `..`, or is not a regular file.
3. Renames `staging/<run-id>` to `results/<run-id>` and fsyncs `results/`.
4. Journals the existing terminal event with the run ID.

Rename after journal, or journal after rename, each leaves a distinct crash
cut. Child 2 defines the reconciliation; child 1 records the order so the
observed cuts are real.

The `home/` directory is never part of the manifest and never moves. It stays
in the attempt directory until manual cleanup.

## Cancellation and verified death

The existing `cancel` verb and the recovery path call the D3 verified-death
routine, which today kills the process group and then the tmux subject host.
For a container handle the same routine becomes:

1. `docker stop --time <grace> <id>`. Docker sends SIGTERM to PID 1, the init
   forwards it to Quorum, and Quorum's existing graceful stopped-evidence path
   runs.
2. If the container is still running after the grace, `docker kill <id>`.
3. `docker inspect <id>` until `State.Running` is false or the verification
   window expires. A container that remains running past the window is
   reported `alive` and the enclosing operation aborts loudly, as today.

Because the container is the process namespace, a stopped container is
verified death for Quorum, Gauntlet, the tmux server, and the Coding-Agent
together. No tmux probe is needed on the container path. The Linux integration
suite proves this directly: a Coding-Agent that survives Quorum's cooperative
cleanup is dead after `docker stop`.

Child 1's cancel operates only through the live controller. A cancel issued
after controller death is child 2.

## Host telemetry

The V1 host sampler keeps running in the controller, now on the host, so the
contention evaluator sees true appliance load rather than the load visible
from inside the long-lived container. No per-container cgroup sampling is
added.

## Appliance verb

```text
evals-appliance campaign run <campaign-id> [--json]
```

- `<campaign-id>` must be a closed basename that exists as
  `<evals-checkout>/campaigns/<campaign-id>/campaign.json`. Prefixes and
  labels are child 4.
- The verb refuses with the existing typed `lock_busy` when `run.lock` is
  held, and with a typed refusal when `doctor`'s Docker checks fail, when the
  worker image is absent, or when the blessed bundle is unavailable.
- It writes a job record of kind `campaign-run` carrying the campaign ID,
  canonical campaign directory, controller pid, sanitized argv, evals SHA,
  helper SHA, image digest, and stdout/stderr log paths.
- It launches the controller detached and returns the job ID. Exit zero means
  the job record and controller identity were recorded, not that the campaign
  completed.
- `status`, `cancel`, and the log paths work through the existing job-record
  commands. `cancel` on a `campaign-run` job signals the controller's process
  group with SIGINT, as `run-all` cancel does, and the controller runs its own
  container stop path.

## Exact source layout

### New files

- `src/campaign/container-spawner.ts`: `ContainerAttemptSpawner`,
  `AttemptMounts`, the create/start/follow/wait sequence, mount verification,
  and the container stop routine. All Docker calls go through `CommandRunner`.
- `src/campaign/attempt-projection.ts`: stage directory creation, subject and
  grader file writing over the existing `credential-scope.ts` projection
  functions, the all-pairs equality refusal, and stage removal.
- `src/campaign/attempt-publish.ts`: manifest re-parse, digest and path
  verification, atomic rename into the results root.
- `src/runner/manifest.ts`: worker-side manifest writer, invoked from the
  runner's terminal path when a campaign identity is present.
- `src/appliance/campaign-run.ts`: the verb, job record kind, controller
  launch.
- `container/attempt-entrypoint.sh`.
- `test/campaign-container-spawner.test.ts`,
  `test/campaign-attempt-projection.test.ts`,
  `test/campaign-attempt-publish.test.ts`, `test/runner-manifest.test.ts`,
  `test/appliance-campaign-run.test.ts`: portable, fake-runner tests.
- `test/linux/campaign-attempt-docker.test.ts`: the Linux integration suite,
  skipped unless `QUORUM_DOCKER_INTEGRATION=1`.

### Modified files

- `src/campaign/spawn.ts`: `SpawnedCampaignChild.handle` becomes the
  process-or-container discriminated union; `assertProcessGroupExists` applies
  to process handles only.
- `src/contracts/campaign/journal-events.ts`: additive `run_allocated`
  container payload (`attempt_id`, `run_id`, `container_id`, `image_digest`,
  `key_grants`), strict, alongside the two existing payloads.
- `src/campaign/dispatcher.ts`: select the spawner from the worker-image
  option, route `--out-root` to the attempt staging directory, pass the
  attempt mounts, journal the container payload, publish after exit, and
  dispatch verified death by handle kind.
- `src/campaign/recovery.ts`: verified death by handle kind.
- `src/cli/campaign.ts`: `run --worker-image <ref>`.
- `src/appliance/cli.ts`: register the `campaign` group and `run` verb.
- `src/appliance/jobs.ts`: job-record kind `campaign-run`.
- `docs/appliance-runbook.md`: a `campaign run` section.

## Test strategy

### Portable tests

All run under `bun test` on any host with a fake `CommandRunner` and no
Docker:

- exact `docker create` argv for a given attempt, including label set, user,
  workdir, env allowlist, tmpfs flags, and the complete mount list in order;
- mount verification rejects an extra mount, a missing mount, a `rw` where
  `ro` is required, and a source inside the bundle or another attempt;
- create-then-start ordering, with log files existing mode `0600` before
  `start`;
- line delivery from the followed files, including a line that arrives
  before a late subscriber and a final unterminated tail flushed exactly once
  at exit;
- exit publication waits for both files to reach end of file;
- `run_allocated` container payload round-trips and its schema rejects a
  secret-shaped value in every string field;
- the dispatcher journals `container_id` and never `pgid` on the container
  path, and never calls `assertProcessGroupExists`;
- projection writes exactly the expected names to each file, mode `0400`
  under `0700`, refuses subject/grader value equality without printing either,
  and refuses an OAuth-requiring cell typed;
- `CampaignChildSpec.env` on the container path contains no credential value;
- the manifest writer lists every artifact with correct digests and writes
  the manifest last;
- publication verifies digests, rejects `..`, absolute paths, symlinks, and a
  digest mismatch, and performs exactly one rename;
- container stop escalates on the injected clock, reports `alive` after the
  window, and never probes tmux;
- the appliance verb refuses `lock_busy`, a missing campaign, an absent image,
  and a bundle fault before writing a job record, and writes a complete
  `campaign-run` record otherwise.

### Linux Docker integration suite

Gated by `QUORUM_DOCKER_INTEGRATION=1`, run on the appliance host before the
live proof and on the Linux devbox during development. Uses the real image,
real Docker, real filesystem, real locks, real journal, and the real
Quorum -> Gauntlet -> tmux -> launcher path with fake subject, grader, and
provider executables. It proves:

- the container's PID 1 is the init, Quorum is its direct child, and the
  container exits with Quorum's status;
- a fake Coding-Agent left alive under a daemonized tmux server does not keep
  the container alive after Quorum exits;
- `docker stop` drives Quorum's graceful stopped path and the container is
  dead afterward with the fake Coding-Agent gone;
- SIGKILL of Quorum inside the container leaves `stdout.log` and `stderr.log`
  readable on the host with the bytes written before the kill;
- the worker sees exactly the listed mounts and nothing else, cannot see the
  bundle, the journal, or a sibling attempt, and has no Docker socket;
- two parallel attempts have distinct `TMUX_TMPDIR` roots and stopping one
  leaves the other's tmux server and fake Coding-Agent running;
- the fake subject observes only its subject values and the fake grader only
  its grader values;
- `docker inspect` of the created container, the journal, the job record, and
  the log paths contain no credential value;
- a complete run commits a manifest, the host publishes it, and
  `results/<run-id>/verdict.json` exists with the journal's terminal event.

### Live proof

On the appliance, through the helper, with a real subject and grader
credential:

1. `evals-appliance doctor --json` clean.
2. Raw host-side `quorum campaign register` of a one-cell, one-sample
   exploratory suite. This is also the first host-side registration; its
   snapshot `bun install` must succeed as `quorum-runner`.
3. `evals-appliance campaign run <campaign-id> --json` returns a job ID.
4. `evals-appliance status <job-id>` shows the controller live; `docker ps`
   shows exactly one `quorum-attempt-*` container with the expected labels.
5. The container exits; `results/<run-id>/verdict.json` and `manifest.json`
   exist; the journal holds `run_allocated` with the container ID and the
   terminal event with the run ID.
6. `docker ps -a` shows the container exited, not running; the stage directory
   is gone; `stdout.log` and `stderr.log` are mode `0600` and non-empty.
7. `quorum campaign report` seals the one-sample campaign.

The verdict's pass or fail is irrelevant; a real verdict of either kind from a
real model is the proof.

## Implementation order and commit boundaries

Tests precede each production change and the tree is green at every commit:

1. Handle union in `spawn.ts` and the additive `run_allocated` payload.
2. `ContainerAttemptSpawner` with fake-runner tests.
3. Attempt entrypoint, durable logs, file-followed lines.
4. Credential projection to the stage directory and the mount list.
5. Dispatcher and recovery routing by handle kind, including container stop.
6. Worker manifest writer and host publication.
7. `campaign run --worker-image` in the quorum CLI.
8. `evals-appliance campaign run` verb and job record.
9. Linux Docker integration suite.
10. Runbook section; live proof; experiment-log entry with the observed
    behaviors child 3 must honor.

## Acceptance criteria

Child 1 is complete when:

1. Every attempt on the appliance path runs in a fresh container whose
   command is the attempt and whose PID 1 is the init with Quorum as its
   direct child.
2. No `docker exec` occurs on the campaign path.
3. The journal records a container ID and image digest for every allocated
   attempt on the container path, and no `pgid`.
4. Each worker receives exactly the mount list in this document; the
   integration suite proves nothing else is visible.
5. No credential value appears in argv, Docker configuration, labels, job
   records, journal events, or log paths.
6. Subject and grader values are delivered as two separate `0400` files and
   the equality refusal runs before either is written.
7. Raw stdout and stderr survive Quorum SIGKILL and controller death, mode
   `0600`, in the attempt directory.
8. A completed run publishes only through a verified manifest, and
   `results/<run-id>` never exists without one.
9. `docker stop` of the exact container is verified death for the whole
   attempt, including a tmux-hosted Coding-Agent.
10. `bun run check`, `bun run quorum check`, and `git diff --check` pass on
    every commit; the Docker suite passes on the appliance host before the
    live proof.
11. The live proof above completes and its observations are recorded in
    `docs/experiments/`.
12. Ordinary `quorum run`, `run-all`, and Phase 1 appliance jobs are
    unchanged.

## Interfaces handed to child 2

Child 2 receives the container handle, the label scheme, the attempt
directory layout, the `exit.json` record, the manifest format, the
publication order, the container stop routine, and the integration-suite
harness with its fake executables. It adds the crash cuts, reconciliation,
marker-first cancellation, and controller-death paths over exactly those
objects, and must not change the mount list or the delivery model.

## Open questions

- **`run.lock` for a detached controller.** The verb must hold `run.lock` for
  the controller's lifetime the way `run-all --detach` does. The exact
  mechanism was not confirmed in this design pass; the implementation plan
  must read the `run-all --detach` path and reuse it rather than add a second
  lock holder.
- **Host-side registration.** Registration has only been exercised inside the
  long-lived container. The live proof's step 2 is the first host-side run;
  if snapshot `bun install` fails as `quorum-runner`, that failure is fixed in
  this child, not worked around.
- **Docker init sufficiency.** `--init` uses Docker's bundled `docker-init`.
  If the integration suite shows it lingering on reparented children, this
  child ships `tini` in the image explicitly. The parent permits either.

## Resolved questions

- **Controller inside or outside the container?** Outside, on the host, as
  `quorum-runner`. Workers never hold the Docker socket.
- **Preallocate run IDs?** No. The worker mints its run directory and emits
  the existing protocol line; the controller reads it from the durable log.
- **Who consumes the credential files?** The entrypoint, by shell sourcing,
  exactly as the Phase 1 shim does. Non-shell parsing and Quorum-side
  consumption are child 4.
- **Separate init binary?** Not unless observed necessary.
- **Where do attempts live?** Under the campaign directory, on the same
  filesystem as `results/`. Namespaces move in child 3.
- **Does child 1 spend?** Yes, one attempt, for the live proof.
