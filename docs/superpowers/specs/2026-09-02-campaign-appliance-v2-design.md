# Campaign Appliance V2 Design

**Status:** In-chat design approved by Drew on 2026-09-02; written-spec review
pending.

**Supersedes for new campaigns:** the V1 campaign execution and budget-bearing
contracts in the 2026-08-17 campaign-platform design and its D1-D4a child
specifications. Existing V1 artifacts remain untouched but are not readable,
resumable, or otherwise supported by V2.

**Related designs:**

- `2026-08-12-quorum-overhaul-program-design.md`
- `2026-08-17-quorum-campaign-platform-design.md`
- `2026-08-26-kernel-d3-campaign-engine-design.md`
- `2026-08-31-kernel-d4a-descriptive-readout-design.md`
- `2026-06-18-shared-eval-appliance-design.md`

## Decision

Quorum will gain a first-class appliance campaign path with a host-side durable
controller and one fresh, scope-isolated worker container per execution
attempt.

The host owns campaign identity, journal state, authoritative telemetry,
credential projection, worker lifecycle, recovery, report publication, and
cost aggregation. A worker receives only the frozen inputs and the two role
credentials required for its one attempt. It cannot read the credential
bundle, campaign journal, sibling inputs, sibling results, or mutable source
checkouts.

V2 is intentionally narrow:

- Linux appliance only;
- exploratory campaigns using `descriptive_v1` only;
- environment-backed API-key credentials, including the current Bedrock/Mantle
  route, only;
- explicit operator resume after interruption;
- no automatic release decision;
- no OAuth or subscription credentials;
- no fleet, remote worker, or multi-operator control plane;
- no dollar budget, budget admission, or dollar-based stop behavior;
- no V1 reader or migration path.

Cost is a measurement, never an execution control. V2 records and aggregates
all observable subject and grader cost, including failed, excluded, retried,
and replacement attempts. Missing cost is explicit and never reads as zero.

## Why this is the right restart point

The 2026-08-12 overhaul proposed a durable supervisor, pre-execution identity
binding, and per-attempt worker isolation. The 2026-08-17 direction review
correctly rejected its fleet, multi-operator, distributed-durability, and
availability machinery as unproven for a two-operator lab. The replacement
campaign design deliberately kept the appliance unchanged and made V1
campaign children host-direct.

That replacement design also named the reason to return to the earlier W2
boundary: per-attempt credential isolation becoming a real requirement. The
campaign kernel now exists, but routine appliance execution requires multiple
subject credentials plus a grader credential. The existing appliance can
safely project only one `(agent, credential)` cell, while the break-glass
campaign path puts the dispatcher and concurrent children in one container.

This design restores only the control and isolation slice that current use
requires. It does not revive the original supervisor program.

## Goals

1. Make `evals-appliance campaign ...` the routine production interface for
   registering, running, resuming, cancelling, inspecting, reporting, costing,
   and cleaning up campaigns.
2. Preserve one durable campaign identity across multiple appliance command
   invocations and controller processes.
3. Give every attempt exactly its subject credential, its distinct grader
   credential, and its frozen input trees.
4. Bind campaign, sample, attempt, run, and immutable worker-container identity
   before the worker can make a provider request.
5. Preserve useful structured evidence and raw logs when workers or controllers
   exit, crash, time out, are OOM-killed, or disappear.
6. Make same-volume process and host restart recoverable without automatically
   restarting paid work.
7. Keep exact cost attribution available during and after a campaign without
   allowing price or cost to change scheduling or execution.
8. Keep durable data outside any repository tree that a checkout refresh may
   replace.
9. Permit manual, evidence-aware removal of expanded checkouts, generated code,
   run homes, caches, and stopped workers after a campaign is terminal.

## Non-goals

- Supporting or migrating V1 campaign documents, journals, or reports.
- Supporting `release_gate_v1` or producing `SHIP`/`NO_SHIP` decisions.
- Supporting OAuth, subscription, or ambient-home credentials.
- Automatically resuming work after a process exit, host restart, or container
  failure.
- Running campaign workers directly on the appliance host.
- Sharing one credential-bearing container among multiple attempts.
- A queueing service, fleet scheduler, cross-host lease, recovery epoch, or
  distributed control plane.
- Resuming paid work from an older volume snapshot.
- Dashboard campaign controls or campaign rendering.
- Automatic deletion of measurement evidence.
- Backward-compatible reads by an older helper after V2 deployment.

## Trust boundary

Live evals remain trusted-maintainer operations. Scenarios and agent CLIs run
in permissive modes and can produce sensitive transcripts and filesystem
artifacts. V2 reduces intentional credential delivery; it does not make live
evals safe for untrusted public submissions.

The boundaries are:

1. **Host appliance adapter:** accepts operator commands, validates paths and
   IDs, records invocation jobs, and dispatches the campaign-frozen controller.
2. **Host campaign controller:** is the sole journal writer during execution,
   owns admission and recovery, and has no Coding-Agent toolchain requirement.
3. **Host credential broker:** reads one pinned bundle generation and stages
   only the two role scopes for one attempt.
4. **Attempt worker container:** executes one Quorum run using frozen inputs and
   one isolated output directory.
5. **Coding-Agent subject:** runs without the grader credential and without
   privilege to inspect the grader process or files.
6. **Gauntlet/grader:** runs without the subject credential and without access
   to the host bundle or campaign journal.

The Docker socket is host-only. Workers receive no Docker socket, no host PID
namespace, no ambient provider environment, no full credential bundle, and no
Linux capability not required by the selected Coding-Agent.

## Architecture

```text
operator
   |
   v
evals-appliance campaign ...
   |
   +--> immutable invocation job -------------------------+
   |                                                      |
   v                                                      |
host campaign controller                                  |
   |  campaign journal, locks, status, telemetry, costs   |
   |                                                      |
   +--> credential broker --> attempt role files          |
   |                                                      |
   +--> docker create --> persist container identity      |
   |                         |                            |
   |                         v                            |
   |                  one attempt worker                  |
   |                  /                 \                 |
   |             Gauntlet              Coding-Agent      |
   |            grader scope           subject scope      |
   |                         |                            |
   +<-- structured events, logs, result staging ---------+
   |
   +--> durable result publication --> journal terminal
```

The appliance adapter and campaign controller are separate responsibilities.
The adapter uses the current installed helper to authenticate the appliance
configuration, create a job record, and dispatch a command. Campaign logic runs
from the evals snapshot frozen at registration, so a later mutable checkout
does not silently change an in-progress campaign's execution semantics.

Each mutating invocation gets a new appliance job ID. All such jobs link to one
full campaign ID. The campaign journal, not the latest invocation job, is the
authority for logical campaign state.

## Durable namespaces

The production paths are separate by purpose:

```text
/srv/quorum/repos/                 managed source repositories
/srv/quorum/data/campaigns/        V2 campaign authorities and snapshots
/srv/quorum/data/results/          published run artifacts
/srv/quorum/state/jobs/            appliance invocation jobs and logs
/srv/quorum/state/credentials/     immutable credential generations
/srv/quorum/runtime/               disposable staging and worker state
```

All durable paths live on the persistent `/srv/quorum` data volume. No durable
campaign or result path is nested beneath a Git checkout. Terminus repository
refresh may fetch, repair, or replace only paths beneath `/srv/quorum/repos`.

The configured paths are canonicalized and checked with no-follow filesystem
operations. External IDs are closed basename components. CLI callers provide a
full campaign ID, never an arbitrary campaign-directory path.

The appliance config gains explicit `campaigns_root`, `results_root`,
`repos_root`, `runtime_root`, `credential_generations_root`, and
`live_spend_lock` fields. `doctor` refuses overlapping namespaces, paths that
escape `/srv/quorum`, symlinked path components, unsafe ownership or modes, a
results mount that disagrees with the worker mount, or a live-spend lock that
is not shared by every top-level spender.

## Source repositories and frozen inputs

`/srv/quorum/repos/{evals,gauntlet,superpowers}` are persistent source
repositories. Sync fetches refs and fast-forwards only configured mutable
branches. It never runs while an appliance live-job lock is active.

Registration resolves these identities to full SHAs:

- evals;
- Gauntlet;
- every Superpowers arm, or the literal `none`.

The campaign ID covers the resolved ref set, suite, expanded cells and samples,
scenario/check identities, concurrency declaration, execution surface, and
other behavioral inputs. Cost forecasts, registration time, operator label,
and observed cost do not affect identity.

Registration creates self-contained frozen trees under the campaign directory.
They must not use linked-worktree metadata owned by a replaceable source
checkout. A source repository can therefore be repaired without invalidating a
registered campaign. The frozen trees include executable evals and Gauntlet
code, scenario/check inputs, agent configuration, and one Superpowers tree per
distinct arm SHA.

Before publication, registration re-reads the frozen trees, verifies their
commit and tree identities, reconstructs the campaign digest, initializes the
journal, and publishes `campaign.json` last as the registration-complete
marker.

## V2 campaign contracts

V2 is a clean schema break. V2 code rejects `schema_version: 1` with a typed
`unsupported_campaign_version` error. It does not attempt to parse or restamp
V1 artifacts.

### Suite

The V2 suite retains comparisons, cells, sample counts, reserves, attempt time
and count bounds, declared measurements, and descriptive profile parameters.
It requires:

- `schema_version: 2`;
- `kind: exploratory`;
- `profile: descriptive_v1`;
- one- or two-arm comparisons only.

V2 removes `budget_usd`. No replacement dollar-control field exists.

### Campaign

The V2 campaign retains the frozen suite, refs, grader identity, cells,
samples, comparisons, blocks, contention declaration, execution surface,
registration metadata, and digest.

It removes the V1 `budget` object and budget-authorizing pricing overrides.
Optional cost-rate overrides may exist only as measurement metadata. They must
state a rate, target, source, and rationale, and no dispatcher code may read
them.

The execution surface expands the grader into the same closed public delivery
shape as a subject arm: credential name, role, auth kind, API, endpoint, model,
and destination environment names. Secret values never enter `campaign.json`.

### Journal

The V2 journal removes budget stops, budget events, and budget-raise
amendments. It retains durable sample/attempt/run identity, admission,
exposure, completion, typed instrument failures, replacement, cancellation,
storage pause, cost observation references, and sealing.

`run_allocated` gains a closed execution handle containing:

- run ID;
- immutable container ID;
- image digest;
- host boot ID;
- creation timestamp;
- subject and grader credential names;
- credential-generation ID and manifest digest;
- secret-free mount/input manifest digest.

The container is created without starting. `run_allocated` and its execution
handle commit before `docker start`, closing the pre-provider identity window.

### Job records

Appliance job records add the mutating kinds:

- `campaign-register`;
- `campaign-start`;
- `campaign-resume`;
- `campaign-cancel`;
- `campaign-report`;
- `campaign-cleanup`.

Each records a full campaign ID when one exists, canonical campaign directory,
controller process identity when applicable, requested action, sanitized argv,
resolved evals/helper/image identity, stdout/stderr paths, and terminal
invocation result. Attempt and run membership remain in the campaign journal;
the job record does not duplicate an ever-growing run list.

Old helpers are not expected to parse V2 job records. Deployment is a one-way
minimum-version transition.

## Credential generations and campaign authority

Terminus materializes credentials as immutable generation directories. An
atomic `current` pointer selects the generation for new work. A generation
contains:

- a strict, non-secret manifest;
- a strict secret data file parsed without shell evaluation;
- any supported role projection files;
- a generation ID and manifest digest.

The helper never executes the secret data file with `source`. Authority to
update secret storage is not authority to execute arbitrary shell as
`quorum-runner`.

Registration validates public credential definitions but reads no secret
values. First start pins the current immutable generation to the campaign and
journals the secret-free campaign authority before admission. Rotation creates
a new generation for future campaigns; it does not alter a pinned campaign.
Pinned generations cannot be removed until every referencing campaign is
terminal.

The authority is the intersection of:

1. the campaign's frozen execution surface;
2. the credential registry frozen in the evals snapshot;
3. the appliance policy allowlist;
4. the pinned generation manifest.

Any missing or mismatched member refuses the entire campaign before a worker
starts. The adapter never silently drops a cell or substitutes a default
credential.

V2 accepts only credentials with environment-backed API-key delivery. It
rejects OAuth, subscription, ambient-home, and unrecognized auth kinds during
registration. Subject and grader credentials must be separately named, and
their resolved secret values must differ. This comparison occurs in broker
memory; values and value-derived hashes are never logged or persisted.

## Per-attempt credential projection

For each admitted attempt, the broker creates a private staging directory with
fixed subject and grader slots. The slots contain only the values and public
configuration needed for that attempt. Files are mode `0400`; the directory is
mode `0700`; ownership matches the role identity inside the container.

Secret values are never placed in:

- process argv;
- Docker environment configuration;
- container labels;
- job JSON;
- campaign JSON or journal events;
- provenance or cost records;
- structured phase events;
- sanitized status output.

The worker receives the two slots as read-only file mounts at fixed paths. A
role launcher supplies subject values only to the Coding-Agent and grader
values only to Gauntlet. The subject and grader execute under distinct
unprivileged identities. The subject cannot inspect the grader's environment,
credential files, or process state; the grader cannot inspect the subject's
credential file. The container has no privilege-escalation path available to
either role.

The role launcher is a closed mechanism, not a general privileged command
server. Its allowed commands, identities, environment destinations, and paths
come from the frozen attempt manifest. It rejects all caller-supplied command
or path substitution.

The private staging directory is removed only after the exact immutable
container is confirmed stopped and crash evidence has been captured.

## Worker input and filesystem contract

One fresh worker container executes one attempt. It receives:

- the frozen evals and Gauntlet trees required by the runner;
- the selected arm's frozen Superpowers tree, or an explicit no-Superpowers
  configuration;
- the selected scenario and check inputs;
- the secret-free attempt manifest and complete campaign identity;
- one isolated writable attempt/run staging directory;
- the subject and grader credential slots;
- declared attempt time and count limits.

All frozen inputs are read-only. The attempt directory is the only general
writable bind. Container temporary files use an attempt-local runtime mount or
bounded tmpfs and never a shared campaign directory.

The worker does not receive:

- the campaign journal or writer lease;
- sibling arm trees not needed by the selected attempt;
- sibling results or attempt directories;
- mutable source repositories;
- the appliance jobs directory;
- host credential generations;
- the Docker socket;
- host runtime or lock directories.

## Artifact commit protocol

Worker exit is not campaign completion. Exit code zero is not sufficient to
retire a sample.

The worker writes artifacts into its attempt staging directory. Required
artifacts are schema-validated and include the run identity, campaign identity,
verdict or typed error/stopped artifact, trajectory, check records, model
readback, token usage where available, cost source data, and a result manifest.

The commit order is:

1. Write each artifact completely.
2. Fsync every required artifact.
3. Write and fsync a manifest containing relative paths, sizes, and SHA-256
   digests.
4. Rename the manifest into place last and fsync the staging directory.
5. Let the worker exit.
6. Have the host re-parse the manifest and schemas, verify all digests and
   identities, and reject unexpected path types or symlinks.
7. Atomically publish the staged run directory under
   `/srv/quorum/data/results/<run-id>` and fsync the results directory.
8. Append the terminal journal event and cost-record references in one fenced
   journal transaction.

A crash before step 8 leaves an incomplete attempt or a published-but-not-
journaled result. Reconciliation identifies the exact prefix and either reuses
the verified publication or records the appropriate typed failure; it never
blindly launches another attempt.

## Logs and crash evidence

Every attempt writes directly to its host-mounted attempt directory from
startup. The evidence set contains:

- raw stdout and stderr in separate mode-`0600` files;
- a structured append-only worker phase log;
- tool, image, runner, agent, and model readback;
- resource samples and high-water marks;
- partial trajectory, token, and result artifacts as they become available;
- the sanitized container-exit record.

The minimum phase vocabulary is:

- `container_created`;
- `container_started`;
- `worker_ready`;
- `run_allocated`;
- `subject_exposure_started`;
- `gauntlet_started`;
- `runner_finished`;
- `artifacts_committed`;
- `container_exited`.

The host persists an allowlisted exit snapshot containing container and image
identity, start/finish times, exit code, signal, OOM status, Docker error,
resource limits, and observed resource high-water marks. It never stores raw
`docker inspect`, because that surface may contain sensitive configuration.

Raw logs are sensitive evidence. Routine commands return a sanitized diagnosis
and paths, never raw log contents. A Coding-Agent or provider can still print a
secret despite correct intentional delivery; storage permissions and operator
handling must assume that possibility.

If the worker crashes, times out, is OOM-killed, or disappears, the controller
preserves the attempt directory, captures all available Docker evidence,
records the last phase, measures available cost, and classifies the attempt
without manufacturing a verdict. Retry or replacement follows only the closed
typed-failure table.

## Host telemetry

The host controller, not a worker container, samples authoritative appliance
CPU, memory, swap, PID, filesystem, and load state. Attempt workers additionally
record cgroup-local CPU, memory, PID, and I/O observations.

Telemetry can invalidate or explain measurement evidence according to the
campaign's descriptive contention contract. It is not a cost or budget control.
Missing required telemetry remains visible and cannot be silently treated as a
clean host.

## Locks and concurrency

The lock authorities remain distinct:

- the appliance live-job lock prevents `prepare`, `run`, `run-all`, repository
  refresh, and another campaign controller from mutating the shared runtime;
- the host-wide live-spend lock excludes every other top-level spender,
  including break-glass commands;
- the campaign-local journal lease fences journal writers.

Spend-producing start/resume commands acquire locks in this fixed order:

1. appliance live-job lock;
2. host-wide live-spend lock;
3. campaign journal lease.

Attempt workers are children covered by the controller and never acquire the
host-wide lock.

`campaign cancel` is the deliberate exception to live-job-lock acquisition. It
must remain able to write durable cancellation intent while a controller holds
that lock. Cancel writes the marker first, signals the exact controller, then
uses the campaign's fenced post-crash path to stop and verify workers and append
the terminal event. It never admits or starts work.

Read-only status, show, and costs take no writer or live-job lock.

## Operator commands

The V2 surface is nested under `evals-appliance campaign`.

### `register`

```text
evals-appliance campaign register \
  --suite <repo-relative-path> \
  --estimates <repo-relative-path> \
  --global-cap <n> \
  [--dry-run] [--json]
```

Paths must resolve beneath configured, frozen input roots. A normal invocation
registers; `--dry-run` performs validation, ref resolution, eligibility, grid
expansion, capacity checks, and cost forecasting without writing a campaign.
Registration never starts a worker.

### `start`

```text
evals-appliance campaign start <full-campaign-id> [--foreground] [--json]
```

Start accepts only a registered, never-started campaign. It is detached by
default. Exit zero from detached submission means the invocation job and
controller identity were durably recorded, not that the campaign completed.

### `resume`

```text
evals-appliance campaign resume <full-campaign-id> [--foreground] [--json]
```

Resume accepts only a nonterminal campaign whose reconciliation reports
`resumable: true`. It is detached by default. It refuses while worker safety is
unverified, the frozen snapshot fails verification, the pinned credential
generation is unavailable, or another spender owns the host lock.

### `cancel`

```text
evals-appliance campaign cancel <full-campaign-id> \
  [--reason <text>] [--json]
```

Cancel is campaign-aware and remains available after controller loss. It writes
intent before signaling anything. Success means every exact worker and subject
host is verified stopped and `campaign_cancelled` is the terminal journal
event. Wrapper exit alone is not cancellation.

### `status`

```text
evals-appliance campaign status <full-campaign-id> [--json]
```

Status is read-only, credential-independent, and reconstructs state from the
authenticated campaign document, journal, invocation jobs, execution handles,
Docker state, and report artifacts. It never repairs or resumes work.

### `show`

```text
evals-appliance campaign show <full-campaign-id> [--json]
```

Show is read-only. It renders a sealed descriptive report. Before sealing it
returns the operational state and states that no report is available; it does
not publish or regenerate artifacts.

### `costs`

```text
evals-appliance campaign costs <full-campaign-id> [--json]
```

Costs is read-only and available during execution. It reports observed and
unknown cost without changing campaign state.

### `report`

```text
evals-appliance campaign report <full-campaign-id> [--json]
```

Report verifies the sealed digest and existing peers. It may regenerate a
missing report peer from the sealed journal and retained evidence, but refuses
any divergence. It cannot seal an unsealed campaign.

### `cleanup`

```text
evals-appliance campaign cleanup <full-campaign-id> [--apply] [--json]
```

Cleanup defaults to a dry run. `--apply` is accepted only for a sealed or
successfully cancelled campaign with no live controller or worker and a
complete measurement-evidence manifest.

No V2 `list` command, automatic cleanup, or standalone `seal` command is added.

## Status model

Status keeps independent axes instead of flattening process state into campaign
state.

### Campaign state

- `registered`
- `running`
- `interrupted`
- `storage_paused`
- `cancel_requested`
- `cancelled`
- `sealed`
- `corrupt`

### Controller state

- `none`
- `starting`
- `running`
- `exited`
- `lost`

### Worker safety

- `none`
- `live`
- `reconciling`
- `safe`
- `unverified`

### Report state

- `absent`
- `publishing`
- `published`
- `divergent`

### Cleanup state

- `not_requested`
- `eligible`
- `pending`
- `complete`
- `failed`

`resumable` is a derived permission, not a campaign state. It is true
only when the campaign is nonterminal, no worker may still be running, every
execution handle has been reconciled, the snapshot and journal authenticate,
the credential generation remains available, and no cancel marker exists.

Every JSON response is schema-versioned and returns the full campaign ID,
latest relevant invocation job ID, all five state axes, `resumable`, sanitized
summary, cost coverage, and any required operator action.

## Cancellation and interruption

Workers use no Docker restart policy. Docker or host restart never starts paid
work automatically.

On controller interruption, an already-started worker may still be live. Status
reports that fact without claiming the campaign is resumable. Explicit resume
performs the pinned recovery order:

1. honor a cancel marker first;
2. authenticate campaign and journal;
3. acquire the live locks;
4. inspect each immutable execution handle;
5. capture remaining logs and exit state;
6. stop and verify surviving workers rather than adopting them;
7. reconcile published or partial artifacts;
8. validate snapshot and credential generation;
9. only then admit replacement or remaining work.

Cancellation follows marker first, stop admission, signal controller, stop
exact worker containers, verify role processes dead, reconcile partial
artifacts, append attempt/block dispositions, and append
`campaign_cancelled` last. If any worker cannot be verified dead, cancellation
returns nonzero and does not append the terminal event.

## Cost measurement

Cost has no authority over execution. Dispatch modules may not import the cost
aggregation or price-table modules except to emit raw usage references.

Each attempt can produce multiple role cost records with this identity:

```text
campaign_id
comparison_id
cell_id
arm
sample_id
execution_attempt_id
run_id | null
role = subject | grader
credential
endpoint
registered_model
observed_model | null
```

Each record carries available input/output/cache/total token counts, duration,
USD amount when known, source artifact references, and one basis:

- `provider_reported`
- `usage_priced`
- `estimated`
- `unknown`

The basis is not a confidence hierarchy that silently replaces one value with
another. Raw observations stay available, and the aggregation policy is
versioned. Invalid or missing inputs yield `unknown`, not zero.

The campaign costs view reports:

- gross total for all attempts;
- included-evidence total;
- excluded/replaced/failed-attempt total;
- subject and grader totals;
- per-arm, cell, credential, model, and attempt breakdowns;
- unknown record count and the affected identities;
- registration forecast, clearly labelled as a forecast;
- measured-minus-forecast difference, with no pass/fail meaning.

Report generation may include the same descriptive totals, but report outcome
and campaign execution never depend on them.

## Sealing and reports

V2 supports only `descriptive_v1`. The controller seals after all required
sample dispositions and integrity obligations are terminal. Sealing verifies
the frozen snapshot, journal, measurement evidence, cost-record references,
contention coverage, and report fold before appending one irreversible sealed
event containing the report digest.

Report publication remains recoverable: Markdown may land before JSON, but the
canonical JSON peer is the publication-complete marker. Reconciliation may
regenerate missing peers only when the refolded digest matches the sealed
digest. Divergent peers produce `report_state: divergent` and are never
overwritten.

Sealing does not clean up inputs, workers, or generated code.

## Manual cleanup

Cleanup is an explicit destructive operation with a dry-run default. Before
`--apply`, it authenticates the campaign and journal, verifies terminal state,
proves no related process or container live, verifies reports or cancellation
evidence, and verifies the measurement-evidence manifest.

The retained measurement closure contains:

- campaign document and journal;
- report and provenance;
- verdict/error/stopped artifacts;
- trajectories and check records;
- token and cost sidecars;
- raw stdout/stderr;
- structured worker and controller phase logs;
- resource observations and sanitized exit records;
- a cleanup receipt recording removed artifact classes, counts, and bytes;
- a compact, digest-verified archive of frozen evals, Gauntlet, Superpowers,
  scenario, check, and agent-config inputs.

Cleanup may remove:

- expanded frozen Git trees after archive round-trip verification;
- Coding-Agent workdirs and generated code;
- run homes and agent-local state;
- dependency and tool caches;
- temporary staging and runtime files;
- stopped worker containers;
- any unreferenced artifact omitted from the retained-evidence allowlist.

The compact input archive records each path, type, mode, link target, and
content digest. Cleanup restores it into a temporary directory and re-runs the
snapshot verifier before deleting expanded trees.

If any step fails, cleanup stops, retains the source material, returns nonzero,
and leaves an idempotent `cleanup.json` sidecar with state `cleanup_pending`.
The sidecar is operational metadata rather than a journal event because the
campaign journal is immutable after sealing. Cleanup failure does not
invalidate a sealed campaign. A repeated dry run or apply resumes from durable
cleanup state without broad recursive deletion.

After cleanup, `status`, `show`, `costs`, and report verification must still
work. Start and resume remain impossible because cleanup is terminal-only.

## Repository refresh and deployment

The feature spans two repositories:

- `superpowers-evals` owns V2 schemas, campaign controller changes, worker
  image/runtime, credential projection, appliance commands, status, costs,
  reports, cleanup, and tests.
- Terminus owns persistent paths, volume and mount configuration, immutable
  credential generation materialization, host packages, helper installation,
  refresh, backup configuration, and the private deployment runbook.

Refresh acquires the appliance mutation lock and refuses while a controller or
worker is active. It records current and target helper SHA, image digest, repo
SHAs, config digest, and credential-generation pointer before changing
anything. It never deletes a durable namespace.

A registered but never-started campaign can survive refresh because its
behavioral inputs and campaign controller are frozen. Start revalidates the
current appliance adapter's V2 support and dispatches the frozen controller.
An active or resumable campaign blocks refresh until it seals or is cancelled.

Terminus user-data changes are not deployment proof for the existing host.
Deployment must explicitly install refreshed scripts/configuration or replace
the instance according to the approved Terraform plan, then verify the live
host through the routine helper.

## Backup and restore

The campaign, results, jobs, credential generations, and retained evidence live
on the snapshotted `/srv/quorum` data volume. `doctor` reports snapshot policy
and freshness when the host has read authority, but absence of that authority
is distinguished from a healthy snapshot.

V2 recovery classes are:

1. **Same attached volume after process/container/host restart:** reconcile
   durable state and permit explicit resume when every safety predicate holds.
2. **Older snapshot restore:** read-only inspection, report verification, cost
   reading, and export only. Every unsealed campaign is recovery-unknown and
   cannot start or resume.

The restore drill opens every campaign journal, checks SQLite and WAL
integrity, replays projections, authenticates campaign documents, verifies
sealed reports and referenced result manifests, reads cost totals, and proves
that unsealed restored campaigns refuse resume.

## Error handling

Every command supports a stable JSON error envelope containing `code`, `step`,
`message`, campaign/job IDs when safely known, state axes when readable, and a
sanitized operator action. Human output is rendered from the same structured
error.

Important refusal classes include:

- unsupported campaign version/profile/auth;
- unsafe ID or path;
- campaign digest or journal-anchor mismatch;
- snapshot/ref drift;
- credential-generation unavailable or mismatched;
- subject/grader credential equality;
- live-job or live-spend lock busy;
- worker identity unverified;
- result manifest incomplete or corrupt;
- report divergence;
- storage pause or unsafe capacity;
- campaign not startable, resumable, cancellable, reportable, or cleanable.

Nonterminal controller outcomes return structured state rather than generic
success. `storage_paused`, `resumable`, and `cancel_requested` cannot be
reported as completed. Missing cost does not fail execution, but it degrades
cost coverage visibly.

## Verification strategy

### Portable no-provider tests

Tests exercise real schemas and filesystem/process behavior through injected
Docker and clock seams. They cover:

- V2 suite, campaign, journal, job, cost, and status round trips;
- loud V1 rejection;
- removal of budget fields, events, states, and dispatcher imports;
- cost aggregation across all attempt dispositions and explicit unknowns;
- full-ID lookup and no-follow path confinement;
- registration publication and digest idempotence;
- credential authority intersection and immutable-generation pinning;
- subject/grader equality rejection without value disclosure;
- exact worker input and mount manifests;
- every crash cut in job creation, registration, worker binding, result
  publication, journal terminal append, sealing, reporting, and cleanup;
- recovery from published-but-unjournaled results;
- status over every valid durable prefix and malformed/tampered state;
- manual cleanup allowlisting and archive round-trip verification.

Tests validate behavior and structured records, not rendered scripts or broad
string snapshots.

### Linux container integration tests

A Linux-only suite uses fake subject, grader, and provider executables but the
real appliance parser, job writer, worker image, Docker runtime, filesystem,
locks, and campaign journal. It proves:

- the subject cannot read grader, sibling, unused-bundle, host, or Docker
  credentials;
- the grader cannot read the subject credential;
- Docker metadata, structured events, job records, provenance, and sanitized
  output contain no credential values;
- parallel attempts receive only their selected snapshots and credentials;
- real exit, signal, timeout, OOM, missing-container, Docker-daemon restart, and
  controller-SIGKILL cases retain the promised logs and state;
- run publication is durable before terminal journaling;
- no process, file descriptor, mount, or credential stage leaks across worker
  teardown;
- campaign, `run`, `run-all`, `prepare`, refresh, and break-glass commands
  neither overlap nor deadlock;
- marker-first cancellation reaches real child processes and refuses completion
  while anything survives;
- cleanup removes generated work while preserving status, show, costs, and
  report verification.

### Terminus deployment verification

Before provider spend:

1. Drain the appliance and verify no live jobs or workers.
2. Snapshot the data volume and record current helper, image, config, repository,
   and credential-generation identities.
3. Apply the reviewed Terraform/bootstrap changes through the normal Terminus
   workflow.
4. Install the exact evals helper and worker image revision.
5. Run `doctor --json` and verify durable roots, mounts, source repositories,
   lock authority, image digest, credential generation, and checkout cleanliness.
6. Register the planned release-effect suite in dry-run and real no-spend modes.
7. Verify the returned full campaign ID, frozen refs, credential authority, and
   cost forecast.

### Live qualification through the adapter

Live acceptance is split so one happy-path receipt cannot hide a missing crash
boundary:

1. **Parallel completion:** multiple API-key/Bedrock arms plus the grader run
   concurrently, seal, publish, and remain inspectable after SSH disconnect.
2. **Worker crash:** kill a worker mid-attempt; preserve logs and partial
   evidence, classify it, replace it, and reconcile all measured cost.
3. **Controller crash/reboot:** kill the controller and reboot the host with a
   nonterminal campaign; prove no worker auto-restarts, status reconciles, and
   explicit resume completes without duplicate attempt/run identity.
4. **Cancellation:** request cancellation with live workers, prove marker-first
   verified death and terminal cancellation, then prove resume refusal.
5. **Cost reconciliation:** independently sum every subject and grader attempt
   source, including the failed/replaced attempt, and match `campaign costs`
   while preserving any unknowns.

The release-effect campaign starts only after all five qualifications pass.

## Rollout and rollback

V2 is a one-way compatibility floor. Rollout must drain V1-era live activity,
preserve existing files without migrating them, deploy the V2-aware helper and
worker together, and record the deployed minimum version.

Rollback begins by stopping admission. If any campaign may still be active,
the V2 helper performs marker-first cancellation or safe reconciliation before
code or container changes. Campaigns, results, logs, jobs, and credential
generations are snapshotted and preserved.

An older campaign-unaware helper must not be installed while V2 job records
exist. Rollback of implementation defects therefore rolls forward to a fixed
V2 helper or reverts within the V2 schema floor; it does not re-enable V1.

## Implementation boundaries

This parent architecture is too large for one implementation plan. It must be
decomposed into five ordered child specifications, each with its own approval,
implementation plan, test-first delivery, and review gate:

1. **V2 contracts and measurement:** campaign, journal, status, and cost
   contracts; clean V1 rejection; removal of budget behavior.
2. **Durable evidence:** namespace separation, self-contained snapshots,
   artifact commit protocol, crash logs, retained evidence, and cleanup.
3. **Isolated attempt executor:** immutable credential generations, exact
   per-role projection, role separation, and one-container-per-attempt
   execution.
4. **Appliance control surface:** campaign-aware jobs, commands, locks, status,
   cancellation, recovery, reporting, costs, and Linux integration coverage.
5. **Terminus delivery and qualification:** paths, mounts, refresh, bundle
   materialization, deployment, rollback, no-spend proof, and the five live
   qualification campaigns.

The child specifications and plans must name exact files, tests, ownership, and
commit boundaries. No child implementation begins until Drew reviews and
approves this parent specification and that child's design.
