# Campaign Appliance V2 Design

**Status:** Amended after staff design review and operator process-topology
clarification on 2026-09-02; final written-spec review pending before child
implementation.

**Supersedes for new campaigns:** the V1 campaign execution and budget-bearing
contracts in the 2026-08-17 campaign-platform design and its D1-D4a child
specifications. Existing V1 artifacts remain byte-for-byte preserved, although
the drained V2 namespace migration may relocate them into a read-only legacy
root. They are not readable, resumable, or otherwise supported by V2.

**Related designs:**

- `2026-08-12-quorum-overhaul-program-design.md`
- `2026-08-17-quorum-campaign-platform-design.md`
- `2026-08-26-kernel-d3-campaign-engine-design.md`
- `2026-08-31-kernel-d4a-descriptive-readout-design.md`
- `2026-06-18-shared-eval-appliance-design.md`
- `../../experiments/2026-08-19-f13-filesystem-credential-scoping.md`

## Decision

Quorum will gain a first-class appliance campaign path with a host-side durable
controller and one fresh, attempt-isolated worker container per execution
attempt.

The host owns campaign identity, journal state, authoritative telemetry,
credential projection, worker lifecycle, recovery, report publication, and
cost aggregation. The installed host controller may roll forward within the
fixed V2 durable contract; the experimental payload and every policy that can
affect sample composition or readout remain frozen. A worker receives only the
frozen inputs and the subject and grader credentials required for its one
attempt. It cannot read the credential bundle, campaign journal, sibling
inputs, sibling results, or mutable source checkouts.

Inside an attempt, V2 deliberately creates no security boundary between
Gauntlet and the Coding-Agent and does not split them across containers. It
preserves the existing Gauntlet-managed process chain inside the worker. The
host manages the container as a whole, never the two logical roles as
independent workers.

One campaign may own live execution on an appliance at a time. That campaign
may run multiple attempts in parallel subject to the frozen campaign cap,
per-credential concurrency, and launch-spacing rules.

V2 is intentionally narrow:

- Linux appliance only;
- exploratory campaigns using `descriptive_v1` only;
- environment-backed `api-key` and `bedrock-bearer` credentials only;
- explicit operator `run` after interruption;
- no automatic release decision;
- no OAuth or subscription credentials;
- no fleet, remote worker, or multi-operator control plane;
- no dollar budget, budget admission, or dollar-based stop behavior;
- no V1 schema reader or artifact conversion.

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
boundary: per-attempt worker isolation and exact credential projection becoming
a real requirement. The campaign kernel now exists, but routine appliance
execution requires multiple subject credentials plus a grader credential. The
existing appliance can safely project only one `(agent, credential)` cell,
while the break-glass campaign path puts the dispatcher and concurrent children
in one container.

This design restores only the control and isolation slice that current use
requires. It does not revive the original supervisor program.

## Goals

1. Make `evals-appliance campaign ...` the routine production interface for
   registering, discovering, running, cancelling, inspecting, reporting,
   costing, abandoning, and cleaning up campaigns.
2. Preserve one durable campaign identity across multiple appliance command
   invocations and controller processes.
3. Give every attempt exactly its subject credential, its grader credential,
   and its frozen input trees, without projecting unused or sibling credentials.
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

- Supporting, parsing, or converting V1 campaign documents, journals, or
  reports.
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
- Provider-specific Internet egress allowlists.

## Trust boundary

Live evals remain trusted-maintainer operations. Scenarios and agent CLIs run
in permissive modes and can produce sensitive transcripts and filesystem
artifacts. V2 reduces intentional credential delivery; it does not make live
evals safe for untrusted public submissions.

The boundaries are:

1. **Host appliance adapter:** accepts operator commands, validates paths and
   IDs, records invocation jobs, and dispatches the installed V2 controller.
2. **Host campaign controller:** is the sole journal writer during execution,
   owns admission and recovery, executes only frozen measurement-policy
   versions, and has no Coding-Agent toolchain requirement.
3. **Host credential projector:** controller-owned code reads one pinned bundle
   generation and stages only the subject and grader projections for one
   attempt. It is not a separate service or daemon.
4. **Attempt worker container:** executes one Quorum run using frozen inputs,
   one isolated output directory, and the existing Quorum -> Gauntlet -> private
   tmux -> Coding-Agent process topology.
5. **Quorum:** provisions the run, starts Gauntlet, records measurement evidence,
   and attempts normal in-container cleanup.
6. **Gauntlet/grader:** starts and drives the Coding-Agent through the generated
   launcher in its private tmux server, then performs the normal cooperative
   stop path.
7. **Coding-Agent subject:** runs inside that same attempt container, receives
   no host-mounted data beyond its attempt inputs, and has only the attempt's
   declared host-backed writable space.

The Docker socket is host-only. Workers receive no Docker socket, host PID
namespace, ambient provider environment, full credential bundle, instance
metadata route, host-control route, or sibling-container network. Public
Internet access remains available because Coding-Agents and providers require
it. V2 does not claim provider-only egress confinement.

The attempt container is the isolation and lifecycle boundary. Quorum,
Gauntlet, tmux, and the Coding-Agent are cooperating components inside it, not
separate security principals. V2 does not claim that the subject cannot inspect
grader process state or credential material already delivered to the same
container. Separate subject and grader projections exist to prevent accidental
credential selection and environment collision, not to provide an intra-attempt
security boundary.

The boundary protects attempts from one another and protects the host bundle
and host control plane from every worker. It does not protect against a kernel
or container-runtime escape, side channels, denial of service, a hostile public
scenario, or exfiltration of either credential intentionally delivered to the
attempt.

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
   +--> credential projector -> exact attempt projections |
   |                                                      |
   +--> docker create --> persist container identity      |
   |                         |                            |
   |                         v                            |
   |                  one attempt worker                  |
   |                    tini / init                       |
   |                         |                            |
   |                       Quorum                         |
   |                         |                            |
   |                      Gauntlet                        |
   |                         |                            |
   |               private tmux + shell                   |
   |                         |                            |
   |              generated launch-agent                  |
   |                         |                            |
   |                   Coding-Agent                       |
   |                         |                            |
   +<-- structured events, logs, result staging ---------+
   |
   +--> durable result publication --> journal terminal
```

### Continuity with the existing runner

V2 does not redesign the interaction protocol inside an attempt. Before the
recent credential-scoping refactor, Quorum already spawned Gauntlet, Gauntlet's
TUI adapter already created a private tmux server and interactive shell, and the
Gauntlet-Agent already invoked a generated `launch-agent` that `exec`ed the
Coding-Agent. That topology remains current.

The outer container lifecycle does change. The current Phase 1 appliance boots
a long-lived container whose command is `sleep infinity` and enters it later
with `docker exec`. V2 does not reuse that model for campaign attempts. It
creates one fresh container whose configured command is the attempt, whose init
starts Quorum without a later `docker exec`, and whose lifetime is exactly the
attempt lifetime. When Quorum exits, the init exits with the same status and the
container runtime tears down any remaining process in that PID namespace.

The credential-scoping refactor changed what entered that chain, not who owned
it: it narrowed appliance credential mounts and supervisor environment, moved
the selected subject credential behind a per-run delivery path, and made agent
launchers construct an explicit `env -i` environment. Before that change, the
worker relied on broader credential-bundle mounts and ambient environment
inheritance. Neither version attempted to make Gauntlet and the Coding-Agent
separate security principals.

V2 retains the narrowed delivery model and places one complete existing chain
inside each fresh worker container. The new host-side responsibility is to own
the exact container identity and its durable evidence—not to replace Gauntlet's
internal process management.

The appliance adapter and campaign controller are separate responsibilities.
The adapter uses the current installed helper to authenticate the appliance
configuration, create a job record, and dispatch the installed V2 controller.
Each invocation records the exact helper and controller SHA.

The controller may be repaired and redeployed without abandoning dormant
campaigns, but it may not reinterpret their experiment. Registration freezes
the worker entrypoint, suite and expanded grid, scenarios and checks, agent
configurations, evals/Gauntlet/Superpowers inputs, dependency and tool
identities, worker image and hardening profile, failure-classification table,
contention policy, report fold, cost aggregation policy, and their digests.
Every V2 controller must replay every valid V2 durable prefix identically under
those frozen policy versions. A durable grammar or semantic break requires V3;
V2 has no migrations and no V1 reader.

Each mutating invocation gets a new appliance job ID. All such jobs link to one
full campaign ID. The campaign journal, not the latest invocation job, is the
authority for logical campaign state.

## Durable namespaces

The production paths are separate by purpose:

```text
/srv/quorum/repos/                 managed source repositories
/srv/quorum/data/campaigns/        V2 campaign authorities and snapshots
/srv/quorum/data/attempts/         durable in-progress attempt evidence
/srv/quorum/data/results/          published run artifacts
/srv/quorum/data/legacy-v1/        preserved, unsupported V1 artifacts
/srv/quorum/state/jobs/            appliance invocation jobs and logs
/srv/quorum/state/abandonments/    external terminal records for corrupt journals
/srv/quorum/state/credentials/     immutable credential generations
/srv/quorum/runtime/               disposable staging and worker state
```

All durable paths live on the persistent `/srv/quorum` data volume. Attempt and
results roots are on the same filesystem so publication can use an atomic
rename. No durable campaign, attempt, or result path is nested beneath a Git
checkout. Terminus repository refresh may fetch, repair, or replace only paths
beneath `/srv/quorum/repos`.

The configured paths are canonicalized and checked with no-follow filesystem
operations. External IDs are closed basename components. CLI callers provide a
full campaign ID, never an arbitrary campaign-directory path.

The appliance config gains explicit `campaigns_root`, `attempts_root`,
`results_root`, `repos_root`, `runtime_root`,
`credential_generations_root`, and `live_spend_lock` fields. `doctor` refuses
overlapping namespaces, paths that escape `/srv/quorum`, symlinked path
components, unsafe ownership or modes, attempt and results roots on different
filesystems, a results mount that disagrees with the worker mount, or a
live-spend lock that is not shared by every top-level spender.

## Source repositories and frozen inputs

`/srv/quorum/repos/{evals,gauntlet,superpowers}` are persistent source
repositories. Sync fetches refs and fast-forwards only configured mutable
branches. It never runs while the existing appliance `run.lock` is active.

Registration resolves these identities to full SHAs:

- evals;
- Gauntlet;
- every Superpowers arm, or the literal `none`.

Every successful registration receives a unique opaque campaign ID. A separate
deterministic `input_digest` covers the resolved ref set, suite, expanded cells
and samples, scenario/check identities, concurrency declaration, execution
surface, frozen measurement policies, and other behavioral inputs. Cost
forecasts, registration time, operator label, and observed cost affect neither
value. Registering the same inputs after cancellation therefore creates a new
campaign ID with the same `input_digest` rather than colliding with the old
campaign.

Registration creates self-contained frozen trees under the campaign directory.
They must not use linked-worktree metadata owned by a replaceable source
checkout. A source repository can therefore be repaired without invalidating a
registered campaign. The frozen trees include executable worker-side evals and
Gauntlet code, scenario/check inputs, agent configuration, and one Superpowers
tree per distinct arm SHA.

Registration also creates compact content-addressed archives before
publication: a verified Git bundle for every referenced Git object set and a
deterministic manifest/archive for non-Git inputs and materialized runtime
dependencies. Each archive is restored into a temporary directory and checked
against the same input manifest before it is trusted. Referenced archives and
the pinned worker image cannot be pruned while a campaign is nonterminal.

Before publication, registration re-reads the frozen trees, verifies their
commit and tree identities, verifies the compact archives, reconstructs the
input digest, initializes the journal, and publishes `campaign.json` last as
the registration-complete marker. The unique ID is preallocated before any
write. A directory without `campaign.json` is an incomplete registration, not
a campaign; `campaign list` reports it separately and cleanup may remove it
only through the incomplete-registration cleanup path.

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
registration metadata, unique campaign ID, and deterministic input digest.

It removes the V1 `budget` object and budget-authorizing pricing overrides.
Optional cost-rate overrides may exist only as measurement metadata. They must
state a rate, target, source, and rationale, and no dispatcher code may read
them.

The execution surface expands the grader into the same closed public delivery
shape as a subject arm: credential name, role, auth kind, API, endpoint, model,
and destination environment names. Secret values never enter `campaign.json`.

### Journal

The V2 journal is append-only and has this closed event vocabulary:

- `campaign_opened` and `credential_generation_pinned` establish authority;
- `block_admitted`, `attempt_created`, `run_allocated`, and
  `exposure_started` establish execution identity and exposure;
- `run_completed`, `instrument_failure`, `aborted`, `block_replaced`,
  `sample_disposition`, `slot_exhausted`, `skew_excluded`, `pool_blocked`,
  `adjudication`, and `quarantined` record evidence and experimental fate;
- `storage_paused` and `storage_resumed` record recovery-relevant control
  events;
- `cancel_requested`, `campaign_cancelled`, and `campaign_abandoned` record
  operator termination; and
- `sealed` records the irreversible complete-report digest.

No budget stop, budget event, budget amendment, or generic catch-all event
exists. Cost observation references are fields on the attempt evidence events,
not execution-authorizing events. Unknown event types fail closed.

The host allocates the attempt ID, run ID, deterministic container name,
credential-stage ID, and complete secret-free container-spec/input digest
before Docker creation. `attempt_created` durably records that pre-create
authority, including block/sample identity, image digest, container name,
credential-stage ID, container-spec digest, and input-manifest digest. The
controller then creates a stopped container with non-secret campaign, attempt,
and run labels, inspects its exact immutable ID, and commits `run_allocated`
with a closed execution handle containing:

- run ID;
- immutable container ID;
- image digest;
- host boot ID;
- creation timestamp;
- subject and grader credential names;
- credential-generation ID and manifest digest;
- secret-free mount/input manifest digest.

`run_allocated` commits before `docker start`, followed by a final cancellation
and credential-revocation check. Reconciliation uses the deterministic name and
labels to find a created-but-unbound container, verifies its complete spec
digest, and either binds that exact stopped container or removes it and its
credential stage. It never starts a container without matching durable
`attempt_created` authority.

The V2 contract includes an executable transition table and durable-prefix
corpus. For each event it specifies legal predecessor states, journal effects,
derived operator state, retry behavior, and the result of a crash immediately
before and after the append. Every installed V2 controller must pass that
corpus before deployment. The status and recovery rules below are the parent
contract that the executable table implements.

The closed parent transition rules are:

| Event | Required durable predecessor | Effect |
|---|---|---|
| `campaign_opened` | initialized empty journal matching unpublished registration | establishes the sole first anchor |
| `credential_generation_pinned` | opened, never-run campaign without an existing pin | pins one generation exactly once; a later `run` reuses the authentic existing pin without appending a duplicate event |
| `block_admitted` | pinned, nonterminal campaign with no pause/cancel marker | reserves the complete atomic block |
| `attempt_created` | admitted block with an available sample/attempt slot | preallocates immutable attempt/run/container-name authority |
| `run_allocated` | matching `attempt_created` and exact stopped container | binds immutable container/image/credential/input identity once |
| `exposure_started` | matching allocated container observed started | establishes paid exposure for that attempt |
| `run_completed` or `instrument_failure` | matching attempt without terminal evidence | closes worker evidence once |
| `aborted` | admitted block whose allocated workers are all verified stopped or absent and which lacks a completed block disposition | fans out over the frozen block roster, moving each nonterminal sample to re-enterable `aborted` while treating an already-terminal sibling as late retained evidence; preserves exposure history and permits replacement only under the frozen policy |
| replacement/adjudication/disposition events | closed attempt or blocked slot required by frozen policy | determine experimental inclusion without changing exposure history |
| `storage_paused` | any nonterminal state without cancel intent | blocks admission and requires verified worker stop |
| `storage_resumed` | most recent storage-control event is `storage_paused` and all recovery predicates pass | reopens admission |
| `cancel_requested` | any nonterminal campaign | permanently blocks new admission |
| `campaign_cancelled` | cancel intent plus verified controller/worker death and reconciled evidence | terminal incomplete outcome |
| `campaign_abandoned` | authenticated nonterminal, nonsealed campaign plus verified execution safety | terminal permanently incomplete outcome |
| external abandonment record | authenticated registration envelope, no authenticated terminal outcome, journal unable to accept `campaign_abandoned`, and verified execution safety | terminal permanently incomplete outcome without rewriting the journal |
| `sealed` | every frozen sample/integrity obligation terminal and report digest verified | terminal complete outcome |

An event with a missing predecessor, duplicate single-assignment identity,
post-terminal append, or impossible ordering fails closed. Reconciliation may
append only the event justified by already durable external evidence; it never
rewrites or deletes an event.

The minimum crash-prefix outcomes are:

| Durable cut | Recovery behavior |
|---|---|
| registration directory before `campaign.json` | list as incomplete registration; never runnable |
| `credential_generation_pinned` before first admission | reuse the authentic existing pin and continue; never append a second pin or select another generation |
| `attempt_created` before Docker create | reuse the same attempt/run authority and create once |
| Docker create before `run_allocated` | discover the stopped labelled container; bind only on exact spec match, otherwise remove |
| `run_allocated` before Docker start | start that exact stopped container only after cancel/revocation recheck |
| Docker start before `exposure_started` | stop and inspect; never claim exposure without provider evidence or the durable event |
| `exposure_started` before worker terminal | preserve partial evidence, stop the worker, and classify under the frozen table |
| result publication before terminal journal append | verify and reuse the exact published result before deciding replacement |
| stopped container and captured evidence before credential-stage removal | remove that attempt's exact stage during reconciliation; never remove it before evidence closure or while the container may be live |
| `sealed` before both report peers exist | regenerate only missing digest-matching peers |
| cancel marker before terminal cancellation | `run` refuses; repeated cancel continues the fenced stop/reconcile path |
| cleanup plan before or during apply | no deletion without the plan; repeated apply revalidates and resumes only named actions |

### Job records

Appliance job records add the mutating kinds:

- `campaign-register`;
- `campaign-run`;
- `campaign-cancel`;
- `campaign-abandon`;
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
values. First `run` pins the current immutable generation to the campaign and
journals the secret-free campaign authority before admission. Rotation creates
a new generation for future campaigns; it does not alter a pinned campaign.
The non-secret manifest of a referenced generation cannot be removed.

A generation may be marked revoked at any time. Revocation prevents new
attempt admission immediately, including admission by a controller that was
already running. A revoked or missing pinned generation makes `run` refuse.
V2 has no credential-repin operation: the recovery is cancellation followed by
registration of a new campaign. Secret bytes may be deleted only after no
controller or worker can still hold or use that generation; the non-secret
generation manifest and its campaign references remain durable.

The authority is the intersection of:

1. the campaign's frozen execution surface;
2. the credential registry frozen in the evals snapshot;
3. the appliance policy allowlist;
4. the pinned generation manifest.

Any missing or mismatched member refuses the entire campaign before a worker
starts. The adapter never silently drops a cell or substitutes a default
credential.

V2 accepts exactly the `api-key` and `bedrock-bearer` auth kinds, each delivered
from an environment-named value in the immutable generation. It rejects OAuth,
subscription, ambient-home, and unrecognized auth kinds during registration.
The grader credential must also have an API/auth shape supported by the frozen
Gauntlet adapter. Subject and grader delivery IDs are distinct, and every
delivery descriptor names its intended consumer. Destination environment names
may be the same because the subject launcher's clean environment replaces the
ambient grader value rather than inheriting it. The generation manifest
explicitly binds each delivered credential to a secret-member ID.

The subject and grader credentials may intentionally reference the same secret
member, as the current Bedrock bearer route does. Registration freezes and
provenance reports `secret_member_relation: distinct | shared`; it does not
compare, hash, or persist secret values. This is a provenance classification,
not an isolation claim. Both components share one attempt container, and a
shared member means they also hold equivalent provider authority. Distinct
provider authority requires distinct generation members and out-of-band key
provisioning; V2 does not infer it from byte inequality.

Credential concurrency remains part of execution safety rather than budget
control. The frozen public definition records the limiter key, maximum
concurrency, launch spacing, and any key-pool membership. Admission applies the
most restrictive matching campaign, credential, and appliance cap. No pricing
or observed-cost field participates in that decision.

## Per-attempt credential projection

For each admitted attempt, controller-owned projection code creates a private
staging directory with fixed subject and grader delivery files. They contain
only the values and public configuration needed for that attempt. Files are
mode `0400`, their directory is mode `0700`, and all are owned by the single
unprivileged worker identity used inside the container. The container receives
these exact files as read-only mounts; it never receives the
credential-generation parent, the full bundle, or any sibling attempt's
staging directory.

Secret values are never placed in:

- process argv;
- Docker environment configuration;
- container labels;
- job JSON;
- campaign JSON or journal events;
- provenance or cost records;
- structured phase events;
- sanitized status output;
- published run homes or published agent configuration.

The worker container runs as one unprivileged identity. A minimal init such as
`tini` is PID 1 to forward signals and reap children; it is not a credential
loader, command server, or privilege boundary. It starts Quorum as its direct
child, exits as soon as Quorum exits, and propagates Quorum's status. It never
lingers merely because a reparented tmux or Coding-Agent process remains alive;
PID-1 exit is what lets the runtime destroy the complete attempt namespace.

Quorum consumes the grader delivery when it constructs the Gauntlet child
environment. Quorum provisioning makes the subject delivery available to the
generated `launch-agent` through attempt-private delivery or agent configuration
files. Those files contain only the selected attempt's values and follow the
sensitive-home rules below. Gauntlet keeps its existing ownership of the
interaction: its TUI adapter creates the private tmux server and shell, the
Gauntlet-Agent invokes the generated launcher, and that launcher `exec`s the
Coding-Agent with `env -i` plus the explicit subject environment. The clean
environment is a configuration-correctness wall: it prevents the grader's
ambient variable from accidentally selecting or backfilling the subject
credential. It is not a security wall against another process in the same
container.

Every attempt sets `TMUX_TMPDIR` to its own disposable runtime directory. The
container filesystem and PID namespaces already isolate parallel attempts; the
attempt-specific socket root additionally prevents an accidentally shared bind
or future runtime change from coupling their private tmux servers.

No host-side service starts, drives, or independently adopts the internal
processes. Quorum and Gauntlet retain their normal cooperative shutdown logic.
If that logic fails, stopping the exact container terminates the complete
process namespace, including a daemonized tmux server and Coding-Agent.

The private credential staging directory is removed only after the exact
immutable container is confirmed stopped and crash evidence has been captured.
If the controller dies between those steps and removal, reconciliation removes
that exact stage. Stage removal does not make a retained attempt home
nonsensitive.

## Worker input and filesystem contract

One fresh worker container executes one attempt. It receives:

- the frozen evals and Gauntlet trees required by the runner;
- the selected arm's frozen Superpowers tree, or an explicit no-Superpowers
  configuration;
- the selected scenario and check inputs;
- the secret-free attempt manifest and complete campaign identity;
- one isolated writable durable attempt directory at
  `/srv/quorum/data/attempts/<campaign-id>/<attempt-id>`;
- one disposable attempt runtime directory beneath `/srv/quorum/runtime`;
- the subject and grader credential delivery files;
- declared attempt time and count limits.

All frozen inputs are read-only. The durable attempt directory is the only
general writable bind. Container temporary files use the attempt-local runtime
mount or bounded tmpfs and never a shared campaign directory. Only the durable
directory may satisfy an evidence obligation.

The worker does not receive:

- the campaign journal or writer lease;
- sibling arm trees not needed by the selected attempt;
- sibling results or attempt directories;
- mutable source repositories;
- the appliance jobs directory;
- host credential generations;
- the Docker socket;
- any other host runtime or lock directories.

Agent homes exist only inside the durable attempt's writable space. They may
contain the selected attempt's required auth or provider configuration, because
some supported agents require files in their home. They never contain an unused
or sibling credential. The whole home is sensitive ephemera: the runner extracts
declared transcript and measurement artifacts into the positive result manifest,
excludes the home and agent-auth configuration from publication, preserves the
crash-time home for diagnosis, and removes it only through explicit cleanup.
Quorum alone may derive an agent-required secret-bearing file from the mounted
delivery, and only beneath that attempt's `home/`, mode `0600`; agents that can
consume the read-only delivery directly receive no derived copy.
The host runs a secret-value scan over every proposed published artifact before
accepting the manifest. Because a model or provider may echo a secret into raw
logs, a match quarantines the artifact for restricted operator handling rather
than claiming that no sensitive evidence exists.

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
7. Atomically publish the positive-manifest artifact set under
   `/srv/quorum/data/results/<run-id>` and fsync the results directory.
8. Append the terminal journal event and cost-record references in one fenced
   journal transaction.

A crash before step 8 leaves an incomplete attempt or a published-but-not-
journaled result. Reconciliation identifies the exact prefix and either reuses
the verified publication or records the appropriate typed failure; it never
blindly launches another attempt.

## Logs and crash evidence

Every attempt writes directly to its durable host-mounted attempt directory
from process start. Before `docker start`, the controller creates the raw log
files mode `0600`. The attempt entrypoint opens them before it `exec`s Quorum,
and Quorum streams Gauntlet output to durable per-role sinks instead of retaining
the only copy in memory. Controller loss therefore cannot detach a live worker
from its log sink. The evidence set contains:

- raw stdout and stderr in separate mode-`0600` files;
- a structured append-only worker phase log;
- tool, image, runner, agent, and model readback;
- host-sampled cgroup resource observations and high-water marks;
- partial trajectory, token, and result artifacts as they become available;
- the sanitized container-exit record.

Phase ownership is explicit. The host lifecycle stream contains
`container_created`, `container_started`, and `container_exited`; the journal's
`run_allocated` event remains the sole durable container-binding authority. The
worker phase stream contains `worker_ready`, `subject_exposure_started`,
`gauntlet_started`, `runner_finished`, and `artifacts_committed`. Every record
names its writer and attempt identity. A host event is never synthesized from a
worker record, and a worker event is never inferred from Docker state.

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

If normalization cannot complete, the evidence manifest records the trajectory
or role log as unavailable rather than treating an empty file as evidence. The
exact crash-time home and session-log paths remain in the durable attempt
directory until manual cleanup so an operator can inspect them under sensitive
artifact handling. A cleanup plan must name their deletion explicitly, and the
partial report permanently retains the resulting missing-evidence disposition.

## Host telemetry

The host controller, not a worker process, samples authoritative appliance CPU,
memory, swap, PID, filesystem, load, and per-container cgroup state. V2 does not
add a second continuous sampler inside each worker; the host captures bounded
periodic observations and the final cgroup high-water/exit snapshot.

Telemetry can invalidate or explain measurement evidence according to the
campaign's descriptive contention contract. It is not a cost or budget control.
Missing required telemetry remains visible and cannot be silently treated as a
clean host.

## Storage exhaustion

The appliance maintains a small physically allocated emergency reserve on the
same filesystem as the journal and attempt evidence. Sparse allocation does not
satisfy this requirement. Its size and free-space admission floor are appliance
configuration, not campaign budgets.

On `ENOSPC`, `SQLITE_FULL`, or a failed durable fsync, the controller stops new
admission, releases the reserve, persists the smallest valid `storage_paused`
record and attempt dispositions it can, stops and verifies exact worker
containers, fsyncs the journal and evidence directories, and exits
nonterminal. If even the pause record cannot land, status reports
`recovery_required` with degraded storage evidence; it must not infer that a
durable pause exists.

An explicit `campaign run` may leave storage pause only after the configured
free-space floor is met, the reserve is recreated and verified physically
allocated, every prior handle is reconciled, and `storage_resumed` commits.

## Locks and concurrency

The design reuses the appliance's existing `run.lock`; it does not introduce a
third name for the same authority. The distinct authorities are:

- `run.lock`, which excludes `prepare`, direct `run`, `run-all`, repository
  refresh, registration, cleanup, and another campaign controller;
- `sync.lock`, acquired after `run.lock` when a command reads or mutates managed
  repository/image state;
- the host-wide live-spend lock, which excludes every other top-level spender,
  including break-glass commands; and
- the campaign-local journal lease, which fences journal writers.

One controller holds `run.lock` and the live-spend lock for the full period in
which any attempt could spend. Attempt workers are covered children and never
acquire host locks. The fixed acquisition order is `run.lock`, `sync.lock` when
needed, live-spend lock, then campaign journal lease.

Controller-PID death alone never makes the live-spend lock stealable. Its
campaign ownership remains effective while any durable execution handle may
still name a live container. Reclaim requires `run.lock` plus exact container
reconciliation; no other spender may enter between controller death and that
proof.

| Command | Lock behavior |
|---|---|
| `register` | `run.lock`, then `sync.lock`; no live-spend lock |
| `run` | `run.lock`, live-spend lock, journal lease; controller retains them while live |
| `cancel` | marker without those locks; signal/wait; after controller death acquire `run.lock`, live-spend lock, then journal lease |
| `abandon` | same fencing path as cancel, but only after execution safety is established |
| `report` | `run.lock`; journal is terminal and remains immutable |
| `cleanup` | `run.lock`; terminal journal remains immutable |
| `list`, `status`, `costs` | read-only; no writer or live-execution lock |

Before acquiring `run.lock`, `run` may inspect its authenticated holder. If the
holder is the same campaign's verified live controller, the command returns the
idempotent no-op status. Any other live holder produces the normal typed busy
response. After that observation, all mutation still requires normal lock
acquisition and revalidation.

Cancellation never fences a controller that may still be running. It first
atomically creates a campaign-local cancel-request sidecar without taking the
journal lease. The live controller observes that sidecar, stops admission, and
may append `cancel_requested`; after controller death the cancel invocation may
append the event itself under the lease. Cancel signals the exact recorded
process, waits for bounded cooperative exit, escalates, and verifies death.
Only then may it acquire the locks, stop and verify exact containers, reconcile
evidence, and append the terminal event. If controller death or worker safety
cannot be proved, the command returns nonzero with state `cancel_requested`;
it does not race a new writer or claim cancellation.

## Operator commands

The V2 surface is nested under `evals-appliance campaign`.

Every command accepts a selector that is a full campaign ID, an unambiguous ID
prefix, or an exact unambiguous operator label. Ambiguity is a typed refusal
that returns the matching IDs and labels. Human and JSON responses come from
the same structured result and include exactly one `next_action` when operator
work remains.

### `register`

```text
evals-appliance campaign register \
  --suite <repo-relative-path> \
  [--estimates <repo-relative-path>] \
  [--label <text>] \
  [--global-cap <n>] \
  [--include-drafts] \
  [--dry-run] [--json]
```

Paths must resolve beneath configured, frozen input roots. A normal invocation
registers; `--dry-run` performs validation, ref resolution, eligibility, grid
expansion, capacity checks, and optional cost forecasting without writing a
campaign. Estimates are never required. The global cap defaults to the
appliance configuration and an override may only lower it. Draft scenarios are
excluded unless `--include-drafts` is explicit, and their frozen draft status
is part of the input digest. Registration never starts a worker.

### `list`

```text
evals-appliance campaign list [--json]
```

List reports campaign ID, label, input-digest prefix, primary state, last
activity, known cost subtotal, unknown-cost count, and next action. It also
reports incomplete registration directories as non-campaign cleanup candidates
without inventing campaign state for them.

### `run`

```text
evals-appliance campaign run <selector> [--json]
```

Run is detached and idempotent. There is no foreground mode:

- `registered`: pin the credential generation if no pin exists, otherwise reuse
  the authentic existing pin, then durably record the invocation and controller
  identity and begin;
- `running` with the recorded controller live: return `changed: false` and the
  current status;
- `recovery_required`: acquire the locks, reconcile every durable execution
  handle, stop and verify any surviving worker rather than adopting it, then
  continue only if all safety predicates pass;
- `storage_paused`: perform the storage and reconciliation checks, append
  `storage_resumed`, then continue; and
- any terminal state or durable cancel marker: refuse and name the appropriate
  read, report, cleanup, or re-registration action.

Run does not require a pre-existing `resumable` assertion. Reconciliation is
the operation that determines whether continuation is safe. Exit zero from
submission means the invocation job and controller identity were durably
recorded, not that the campaign completed.

### `cancel`

```text
evals-appliance campaign cancel <selector> \
  [--reason <text>] [--json]
```

Cancel is campaign-aware and remains available after controller loss. It writes
intent before signaling anything. Success means every exact worker container
is verified stopped or absent and `campaign_cancelled` is the terminal journal
event. A stopped container is proof that its complete process namespace,
including tmux and the Coding-Agent, is dead. Wrapper exit alone is not
cancellation.

### `abandon`

```text
evals-appliance campaign abandon <selector> \
  --reason <text> --acknowledge-incomplete-evidence [--json]
```

Abandon is the terminal escape for a campaign whose journal, document,
evidence, or report cannot be completed. Identity must be established either
by the authenticated campaign document or by its immutable registration job
and published campaign-ID/input-digest envelope. It first uses the cancellation
fencing path and requires proof that no related controller or worker container
can still spend. That proof is exact-container state rather than inspection of
individual in-container PIDs. When the journal is writable it appends
`campaign_abandoned`; otherwise it writes one external append-only record under
`/srv/quorum/state/abandonments`, preserving the last authenticated journal
anchor, operator/job identity, reason, execution-safety proof, and evidence
digest. It never repairs or rewrites a corrupt journal and every resulting
report is permanently stamped `complete: false`.

### `status`

```text
evals-appliance campaign status <selector> [--json]
```

Status is read-only, credential-independent, and reconstructs state from the
authenticated campaign document, journal, invocation jobs, execution handles,
Docker state, and report artifacts. It never repairs or continues work.

### `costs`

```text
evals-appliance campaign costs <selector> [--json]
```

Costs is read-only and available during execution. It reports observed and
unknown cost without changing campaign state.

### `report`

```text
evals-appliance campaign report <selector> [--json]
```

Report verifies the terminal authority and existing peer digests. It may
regenerate a missing peer from a sealed journal or from a
cancelled/abandoned campaign's retained evidence, but refuses any divergence.
The sealed event is the authority for a complete report digest; a partial
report publishes its own immutable sidecar digest without altering the terminal
journal. Complete seals render `complete: true`; cancelled and abandoned
campaigns render descriptive partial reports with `complete: false`. Report
never seals or continues a campaign.

### `cleanup`

```text
evals-appliance campaign cleanup <selector> [--json]
evals-appliance campaign cleanup --apply <plan-id> [--json]
```

The selector form is always a dry run and writes a digest-bound cleanup plan.
Apply accepts only that plan ID, re-authenticates every source and retained
artifact, and refuses if paths, digests, state, or execution safety changed.
Cleanup is available for sealed, cancelled, or abandoned campaigns and for
identified incomplete registrations. It is never automatic. V2 has no
`start`, `resume`, `show`, foreground, standalone `seal`, or automatic-cleanup
command.

## Status model

Human status leads with one primary state:

- `registered`;
- `running`;
- `recovery_required`;
- `storage_paused`;
- `cancel_requested`;
- `sealing`;
- `sealed`;
- `cancelled`;
- `abandoned`; or
- `unknown` when campaign or journal authentication fails.

JSON preserves the facts behind that projection: authenticated journal state,
integrity (`ok | failed | unknown`), controller observation, exact worker
observations, report state, cleanup state, cost coverage, blockers, allowed
actions, and one `next_action`. Integrity failure is not a lifecycle state. It
prevents `run` and complete sealing while leaving status, costs, cancellation,
abandonment after execution-safety proof, and conservative cleanup available.

Projection uses this precedence:

1. an authenticated terminal `sealed` or `campaign_cancelled` event, or a valid
   external abandonment record, wins;
2. a durable cancel marker yields `cancel_requested`;
3. a most-recent storage-control event of `storage_paused` yields
   `storage_paused`;
4. a live controller yields `running` or `sealing` from its journal phase;
5. any nonterminal campaign with prior execution but no verified controller,
   an unbound handle, or an unverified worker yields `recovery_required`; and
6. a never-run campaign yields `registered`.

If authentication fails and no valid abandonment record exists, primary state
is `unknown`, integrity is `failed`, and the response names only actions safe
under the remaining evidence. A valid abandonment record projects `abandoned`
while retaining `integrity: failed`. Status never repairs. `run` performs
reconciliation and either continues or returns a typed blocking predicate.

Command idempotency is part of the V2 contract: repeated `run` against a live
controller is a no-op; repeated cancel after `campaign_cancelled` and repeated
abandon after `campaign_abandoned` or a valid external abandonment record return
their existing terminal identity; abandon against a sealed or cancelled
campaign refuses; report only restores
missing digest-matching peers; cleanup apply reuses its plan/receipt; and all
read commands are side-effect free.

## Cancellation and interruption

Workers use no Docker restart policy. Docker or host restart never starts paid
work automatically.

Inside a healthy worker, normal completion follows the existing cooperative
path: Quorum waits for Gauntlet, and Gauntlet attempts to close its private tmux
server and Coding-Agent. That close is best-effort. The authoritative teardown
is container exit: when Quorum completes or fails, its init exits with the same
status and the runtime destroys every remaining process in the namespace.

On external cancellation, the host sends `docker stop` to the immutable
container ID. The resulting `SIGTERM`, and an interactive `SIGINT`, enter one
idempotent Quorum stop path. Quorum forwards the established `SIGINT` stop signal
to Gauntlet, records any partial evidence that completes within the bounded grace
period, and exits. The host then uses `docker kill` if the container remains
live. The host never needs to discover or manage the tmux or Coding-Agent PID
separately.

On controller interruption, an already-started worker may still be live. Status
reports `recovery_required` without guessing that continuation is safe. An
explicit `run` performs the pinned recovery order:

1. honor a cancel marker first;
2. authenticate campaign and journal;
3. acquire the locks in their fixed order;
4. inspect each immutable execution handle;
5. capture remaining logs and exit state;
6. stop and verify surviving workers rather than adopting them;
7. reconcile published or partial artifacts;
8. validate frozen inputs, worker image, policies, and credential generation;
9. only then admit replacement or remaining work.

Cancellation follows marker first, stop admission, signal and wait/escalate the
controller, prove it dead, acquire the locks, stop exact worker containers,
verify every exact container stopped or absent, reconcile partial artifacts,
append attempt dispositions and `aborted` for each still-in-flight block whose
worker set is verified dead, and append `campaign_cancelled` last. If any
controller or worker container cannot be verified dead, cancellation returns
nonzero and does not append the terminal event. Abandonment uses the same
execution-safety proof.

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
credential_generation_id
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

The campaign costs view is timestamped and reports:

- known USD subtotal for all attempts as of that timestamp;
- included-evidence total;
- excluded/replaced/failed-attempt total;
- subject and grader totals;
- per-arm, cell, credential, model, and attempt breakdowns;
- pending and permanently unknown record counts and their affected identities;
- coverage as known records over expected role records; and
- an optional registration forecast, clearly labelled as non-authoritative,
  only when estimates were supplied.

The view never labels a partial known subtotal as a gross total and does not
compute measured-minus-forecast. A stable record identity prevents duplicate
ingestion across reconciliation. Credential generation is attribution metadata,
not a grouping that changes campaign identity.

Report generation may include the same descriptive totals, but report outcome
and campaign execution never depend on them.

## Sealing and reports

V2 supports only `descriptive_v1`. The controller seals after all required
sample dispositions and integrity obligations are terminal. Sealing verifies
the frozen inputs and policies, journal, measurement evidence, cost-record
references, contention coverage, and report fold before appending one
irreversible sealed event containing the report digest.

Report publication remains recoverable: Markdown may land before JSON, but the
canonical JSON peer is the publication-complete marker. Reconciliation may
regenerate missing peers only when the refolded digest matches the sealed
digest. Divergent peers produce `report_state: divergent` and are never
overwritten.

Cancellation and abandonment do not produce a complete seal. They may produce
a digest-bearing partial descriptive report from authenticated evidence, but it
is permanently marked `complete: false`, names every missing obligation, and
cannot be used as a release decision.

After host evidence closure, the controller removes the exact stopped worker
container and its credential staging immediately. Sealing does not remove
frozen inputs, generated code, homes, caches, or retained evidence.

## Manual cleanup

Cleanup is an explicit destructive operation with a mandatory plan/apply split.
Before planning and again before apply, it authenticates the campaign and
journal or valid abandonment record, verifies terminal state, proves no related
process or container live, verifies reports or termination evidence, and
verifies the measurement-evidence manifest. Apply must match the exact stored
plan digest and source facts.

The retained measurement closure contains each produced item below plus an
explicit unavailable disposition for every required item that could not be
produced:

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
- run homes, agent-auth configuration, and agent-local state;
- dependency and tool caches;
- temporary staging and runtime files;
- verified stopped container stragglers left by an earlier controller crash.

Those are the complete removable classes. Cleanup never derives deletion
authority from absence in an allowlist and never recursively sweeps an
unrecognized path. The compact input archive uses verified Git bundles for Git
objects and a deterministic positive manifest for non-Git inputs, recording
each path, type, mode, link target, and content digest. Cleanup restores it into
a temporary directory and re-runs the input verifier before deleting expanded
trees.

Incomplete-registration cleanup may remove only the exact preallocated
campaign directory and runtime paths proven to belong to that registration; it
cannot use campaign terminal-state claims because no published campaign exists.

If any step fails, cleanup stops, retains the source material, returns nonzero,
and leaves an idempotent `cleanup.json` sidecar with state `cleanup_pending`.
The sidecar is operational metadata rather than a journal event because the
campaign journal is immutable after sealing. Cleanup failure does not
invalidate a sealed campaign. A repeated dry run or apply resumes from durable
cleanup state without broad recursive deletion.

After cleanup, `list`, `status`, `costs`, and report verification must still
work. `run` remains impossible because cleanup is terminal-only.

## Repository refresh and deployment

The feature spans two repositories:

- `superpowers-evals` owns V2 schemas, campaign controller changes, worker
  image/runtime, credential projection, appliance commands, status, costs,
  reports, cleanup, and tests.
- Terminus owns persistent paths, volume and mount configuration, immutable
  credential generation materialization, host packages, helper installation,
  refresh, backup configuration, and the private deployment runbook.

Refresh acquires `run.lock` and then `sync.lock`, and refuses while a controller
or worker is active. It records current and target helper SHA, image digest,
repo SHAs, config digest, and credential-generation pointer before changing
anything. It never deletes a durable namespace.

A registered, interrupted, or storage-paused campaign can survive refresh
because its experimental inputs, measurement policies, archives, and worker
image are retained. Only a live controller or worker blocks refresh. Before
deployment, the new installed controller must pass the V2 durable-prefix replay
corpus; afterward `run` revalidates the retained inputs and image before
reconciliation. Image and archive garbage collection refuses every digest
referenced by a nonterminal campaign.

The initial V2 deployment is a drained namespace migration. Terminus snapshots
the volume, acquires `run.lock`, creates the new repositories and data roots,
and moves existing V1 result material out of the replaceable evals checkout
into a read-only `/srv/quorum/data/legacy-v1/` preservation root. V2 never
imports or reads those artifacts. Existing `state/jobs` remains preserved;
legacy credential-scoping staging must be empty before migration. A durable
migration plan and receipt name every moved or created path. Rollback restores
the pre-migration volume snapshot or stays within the V2 floor; it does not
guess at reverse path moves.

Terminus user-data changes are not deployment proof for the existing host.
Deployment must explicitly install refreshed scripts/configuration or replace
the instance according to the approved Terraform plan, then verify the live
host through the routine helper.

## Backup and restore

The campaign, results, jobs, credential generations, and retained evidence live
on the snapshotted `/srv/quorum` data volume. `doctor` reports snapshot policy
and freshness when the host has read authority, but absence of that authority
is distinguished from a healthy snapshot.

An older restored volume cannot identify itself using state stored on that same
volume. Terminus therefore materializes a root-owned
`/etc/quorum/volume-state.json` outside the data volume from deployment/restore
metadata. It names the attached volume ID, source snapshot when any, and mode
`current | restored`. The helper treats `restored` as authoritative read-only
mode and refuses live execution if the marker is missing, malformed, or
disagrees with the mounted volume. Normal same-volume host replacement is
explicitly materialized as `current`; V2 does not infer either class.

V2 recovery classes are:

1. **Same attached volume after process/container/host restart:** reconcile
   durable state and permit explicit `run` when every safety predicate holds.
2. **Older snapshot restore:** read-only inspection, report verification, cost
   reading, and export only. Every unsealed campaign is recovery-unknown and
   cannot run.

Docker live-restore and worker restart policies are disabled. The restore drill
also proves that no container from the source host can be adopted or restarted.

The restore drill opens every campaign journal, checks SQLite and WAL
integrity, replays projections, authenticates campaign documents, verifies
sealed reports and referenced result manifests, reads cost totals, and proves
that unsealed restored campaigns refuse `run`.

## Error handling

Every command supports a stable JSON error envelope containing `code`, `step`,
`message`, campaign/job IDs when safely known, state axes when readable, and a
sanitized operator action. Human output is rendered from the same structured
error.

Important refusal classes include:

- unsupported campaign version/profile/auth;
- unsafe ID or path;
- campaign document/input digest or journal-anchor mismatch;
- snapshot/ref drift;
- credential-generation unavailable or mismatched;
- missing or implicit subject/grader secret-member binding;
- `run.lock`, `sync.lock`, or live-spend lock busy;
- worker identity unverified;
- result manifest incomplete or corrupt;
- report divergence;
- storage pause or unsafe capacity;
- campaign not runnable, cancellable, abandonable, reportable, or cleanable.

Nonterminal controller outcomes return structured state rather than generic
success. `storage_paused`, `recovery_required`, and `cancel_requested` cannot
be reported as completed. Missing cost does not fail execution, but it degrades
cost coverage visibly.

## Verification strategy

### Portable no-provider tests

Tests exercise real schemas and filesystem/process behavior through injected
Docker and clock seams. They cover:

- V2 suite, campaign, journal, job, cost, and status round trips;
- loud V1 rejection;
- removal of budget fields, events, states, and dispatcher imports;
- cost aggregation across all attempt dispositions and explicit unknowns;
- full-ID, unique-prefix, label, ambiguity, and no-follow path behavior;
- registration publication and digest idempotence;
- incomplete-registration discovery and narrowly scoped cleanup;
- credential authority intersection and immutable-generation pinning;
- controller death after credential pinning but before first admission, followed
  by `run` reusing the authentic pin without a duplicate event or re-pin;
- credential revocation refusal and absence of any re-pin path;
- credential concurrency and launch spacing without price imports;
- explicit shared/distinct subject/grader member classification without value
  comparison, disclosure, or an intra-attempt isolation claim;
- exact worker input and mount manifests;
- every event transition, including `aborted`, every command idempotency rule,
  and every valid durable prefix;
- every crash cut in job creation, registration, Docker creation/binding, result
  publication, credential-stage teardown, journal terminal append, sealing,
  reporting, and cleanup;
- created-but-unbound container and credential-stage reconciliation by labels;
- explicit host-versus-worker phase ownership and refusal to infer one stream
  from the other;
- recovery from published-but-unjournaled results;
- status over every valid durable prefix and malformed/tampered state;
- physically allocated storage reserve and every storage-pause crash cut;
- cleanup positive deletion classes, plan revalidation, and archive round-trip;
- installed-controller compatibility against the frozen V2 replay corpus; and
- restored-volume marker refusal.

Tests validate behavior and structured records, not rendered scripts or broad
string snapshots.

### Linux container integration tests

A Linux-only suite uses fake subject, grader, and provider executables but the
real appliance parser, job writer, worker image, Docker runtime, filesystem,
locks, campaign journal, and Gauntlet process path. It proves:

- each worker receives exactly its selected subject and grader projections and
  no sibling, unused-bundle, host, or Docker credentials;
- the worker container command is the attempt itself rather than
  `sleep infinity` plus `docker exec`; its init starts Quorum as its direct child,
  propagates Quorum's status, and exits without waiting for leaked descendants;
- Quorum gives Gauntlet the grader projection while the generated subject
  launcher uses `env -i` and the selected subject projection, including when
  both credentials use the same destination environment name;
- the real Quorum -> Gauntlet -> private tmux -> generated launcher process path
  starts and completes a fake Coding-Agent without a new process supervisor or
  control proxy;
- workers cannot reach instance metadata, host control routes, or sibling
  containers, while declared provider access remains usable;
- Docker metadata, structured events, job records, provenance, and sanitized
  output contain no credential values;
- any required auth files in a retained attempt home contain only that
  attempt's selected credentials, remain outside publication, and proposed
  publications are secret-scanned, including a credential-echo quarantine case;
- parallel attempts receive only their selected snapshots and credentials, use
  attempt-private tmux socket roots, and stopping one container leaves the
  other's tmux server and Coding-Agent running;
- real exit, signal, timeout, OOM, missing-container, Docker-daemon restart,
  Quorum/Gauntlet failure, and controller-SIGKILL cases retain the promised logs
  and state;
- `docker stop` drives Quorum's graceful stopped-evidence path through SIGTERM,
  while direct SIGINT produces the same typed result, and both retain measured
  cost available before forced escalation;
- SIGKILL of Quorum after Gauntlet output begins still leaves directly written
  mode-`0600` stdout/stderr and honest unavailable dispositions in the durable
  attempt directory;
- run publication is durable before terminal journaling;
- no process, file descriptor, mount, or credential stage leaks across worker
  teardown;
- campaign, `run`, `run-all`, `prepare`, refresh, and break-glass commands
  neither overlap nor deadlock;
- Quorum/Gauntlet failure with cooperative tmux cleanup deliberately disabled,
  and marker-first `docker stop`/`docker kill` cancellation, leave no tmux server
  or Coding-Agent process after the exact container is stopped; cancellation
  refuses completion while the container remains live or unverified;
- an irrecoverable campaign can be abandoned only after execution safety is
  proved and remains permanently incomplete; and
- cleanup removes only planned artifact classes while preserving list, status,
  costs, and report verification.

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
7. Verify campaign discovery, the unique campaign ID and input digest, frozen
   refs/policies, credential authority, and optional forecast when supplied.

### Live qualification through the adapter

Live acceptance is split so one happy-path receipt cannot hide a missing crash
boundary:

1. **Parallel completion and contention:** multiple
   `api-key`/`bedrock-bearer` arms plus the grader run concurrently within all
   caps and remain inspectable after SSH disconnect. A bounded controlled
   contention window is detected; the contaminated pair is excluded and
   replaced before the campaign seals and publishes.
2. **Worker crash:** kill a worker mid-attempt; preserve logs and partial
   evidence, classify it, replace it, and reconcile all measured cost.
3. **Controller crash/reboot:** kill the controller and reboot the host with a
   nonterminal campaign, including once after pinning but before first admission;
   prove no worker auto-restarts, status reconciles, and explicit `run` completes
   without duplicate pin, attempt, or run identity.
4. **Cancellation:** request cancellation with live workers, prove marker-first
   graceful evidence capture, verified death, and terminal cancellation, then
   prove `run` refusal.
5. **Cost reconciliation:** independently sum every subject and grader attempt
   source, including failed, replaced, and cancelled attempts, and match
   `campaign costs` while preserving any unknowns.
6. **Cleanup and incomplete evidence:** publish a partial cancelled report,
   exercise an abandonment after an injected irrecoverable evidence fault, then
   apply a digest-bound cleanup plan while preserving measurement closure.

The release-effect campaign starts only after all six qualifications pass.

## Rollout and rollback

V2 is a one-way compatibility floor. Rollout must drain V1-era live activity,
preserve existing V1 files without translating their schema, relocate them
byte-for-byte only through the recorded namespace migration, deploy the
V2-aware helper and worker together, and record the deployed minimum version.

Rollback begins by stopping admission. If any campaign may still be active,
the V2 helper performs marker-first cancellation or safe reconciliation before
code or container changes. Campaigns, results, logs, jobs, and credential
generations are snapshotted and preserved.

An older campaign-unaware helper must not be installed while V2 job records
exist. Rollback of implementation defects therefore rolls forward to a fixed
V2-compatible helper or reverts to another helper that passes the complete V2
replay corpus; it does not re-enable V1.

## Implementation boundaries

This parent architecture is too large for one implementation plan. It is
decomposed into four ordered child specifications, each with its own approval,
implementation plan, test-first delivery, review gate, and live proof.

The children are vertical, not layered. Each one ends with a real attempt on
the appliance through the adapter, and no child may merge leaving the campaign
path unrunnable. The executor comes first because it is where this design makes
the most claims it has not yet observed: PID-1 exit with a daemonized tmux,
crash evidence under SIGKILL and OOM, Docker daemon restart, and container
reconciliation by label. The durable contracts are written after those
behaviors are observed facts, so the journal vocabulary and status observation
types describe what the executor produces rather than predict it.

1. **Attempt worker skeleton:** a thin `evals-appliance campaign run` job on
   the host, the current campaign engine as controller, one fresh container per
   attempt with a minimal init as PID 1 and Quorum as its direct child, the
   existing Gauntlet-managed process chain inside, the durable attempt directory,
   the attempt-private tmux socket root, and the worker-side staging and
   manifest commit. Subject and grader credentials are projected as two exact
   read-only files from the existing appliance bundle. V1 contracts are
   untouched. Live proof: one real attempt and one real verdict published from
   its manifest.
2. **Crash evidence and cancellation:** host-side manifest verification and
   atomic publication, created-but-unbound container and credential-stage
   reconciliation by label, recovery from published-but-unjournaled results,
   marker-first cancellation with verified container death, and crash-time home
   retention. Live proof: qualification cases 2, 3, and 4.
3. **Contracts, measurement, and durable namespaces:** the V2 suite, campaign,
   closed journal transition table, durable-prefix corpus, status, and cost
   contracts; clean V1 rejection; removal of budget behavior; namespace
   separation, self-contained snapshots, retained evidence, and cleanup. This is
   the one flag day in the sequence. It is written against the events children 1
   and 2 observed, and it lands in the same child that proves it live. Live
   proof: qualification case 5 plus a parallel two-arm completion.
4. **Credential generations and Terminus delivery:** immutable generations,
   pinning, revocation, authority intersection, paths, mounts, restored-volume
   marker, refresh, bundle materialization, image retention, deployment,
   rollback, no-spend proof, and the remaining controller surface (discovery,
   selectors, abandonment, reporting, costs, Linux integration coverage). Live
   proof: qualification cases 1 and 6, then all six together, then the
   release-effect campaign.

Child 1 adds container-identity events to the V1 journal so the skeleton can
run; child 3 deletes them with the rest of V1. That throwaway is deliberate and
small. The in-place V1 to V2 cutover cannot be made incremental, so child 3
remains a flag day, but it is a flag day with a proven executor underneath it.

The child specifications and plans must name exact files, tests, ownership, and
commit boundaries. No child implementation begins until Drew reviews and
approves this parent specification and that child's design.
