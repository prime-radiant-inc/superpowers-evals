# Kernel Deliverable 3 — Campaign Engine (dispatcher + journal + locks): Design

**Date:** 2026-08-26 (revision 4, post revision-3 verify round)
**Status:** ratified — revision 4 + editorial minors (2026-08-26; user
ratification: proposed D1 erratum E7, the ENOSPC fail-stop of Decision
D-13, and the additive schema amendments of the contract-additions list).
**One facet re-opened by the user at ratification:** Decision D-5's
contention-invalidation timing (seal-time vs dispatch-time refill; skeleton
OQ-11) returns to a second approaches-gate round — Decisions D-3/D-5 stand
until that round's adjudication lands as a spec amendment.
**Review record:** `docs/experiments/2026-08-26-kernel-d3-spec-review.md`
  (round 1: two-seat review, Blockers A–E + Important bundle → landed in
  revision 2; round 2: delta re-review, Rev-3 patch list P-1…P-7 → revision
  3; final section "Revision-3 verify round," Round-4 fix list S-1…S-13 →
  this revision)
**Parent spec:** `docs/superpowers/specs/2026-08-17-quorum-campaign-platform-design.md`
  (the campaign platform design; "the parent" below)
**Prerequisites:**
  - Kernel D1 contracts (merged to main @ `41b9e2b`; spec
    `docs/superpowers/specs/2026-08-24-kernel-d1-contracts-design.md`, revision 2)
  - Kernel D2 provisioning + instrument snapshot (implemented, main @ `f230698`;
    spec `docs/superpowers/specs/2026-08-25-kernel-d2-provisioning-instrument-snapshot-design.md`)
**Approaches gate:** `docs/experiments/2026-08-26-kernel-d3-approaches-gate.md`
  (committee + user ratification, 2026-08-26; Decisions D-1…D-3 transcribe the
  adjudications; revision 2 amends their text only where the review record
  authorizes a clarification, never their substance)
**Spec skeleton:** `.superpowers/drafts/2026-08-25-kernel-d3-spec-skeleton.md`
  (77 cited pinned requirements across the eight D3 modules; every R-XXX-N below
  keeps the skeleton's identifier and source citation)
**Program ticket:** PRI-2874 umbrella (kernel build, order-of-operations item 3,
  deliverable 3 of 4)

## Source aliases used in citations

| Alias | File |
|---|---|
| **D1** | `docs/superpowers/specs/2026-08-24-kernel-d1-contracts-design.md` |
| **D2** | `docs/superpowers/specs/2026-08-25-kernel-d2-provisioning-instrument-snapshot-design.md` |
| **PAR** | `docs/superpowers/specs/2026-08-17-quorum-campaign-platform-design.md` |
| **P0** | `docs/superpowers/specs/2026-08-20-phase0-capacity-simulation-design.md` |
| **D1R** | `docs/experiments/2026-08-24-kernel-d1-spec-review.md` |
| **D2R** | `docs/experiments/2026-08-25-kernel-d2-spec-review.md` |
| **P0R** | `docs/experiments/2026-08-20-phase0-spec-multiharness-review.md` |
| **GATE** | `docs/experiments/2026-08-26-kernel-d3-approaches-gate.md` |
| **REV** | `docs/experiments/2026-08-26-kernel-d3-spec-review.md` |

## Purpose and place in the program

The parent's order of operations item 3 (kernel build) names four deliverables in
fixed order: **contracts → provisioning + instrument snapshot → dispatcher +
journal + locks → profiles + report engine** (PAR §"Coexistence and sequencing"
→ "Order of operations"; D1 §"Purpose and place in the program"). D1 shipped the
contracts; D2 shipped the provisioning + instrument-snapshot libraries and the
runner threading primitive. This document is the implementation-level spec of
deliverable 3: **the campaign engine** — the first deliverable with storage,
processes, and concurrency.

D3's scope is the eight D3-owned rows of the D1 kernel-wide seam map
(D1 §"Kernel-wide seam map"): `registration`, `journal`, `dispatcher`,
`spawn/key-select`, `sensors`, `failure-classifier`, `locks`, `recovery`. The
boundary settlements D3 inherits from the parent through that map: the **thin
dispatcher over shared execution primitives** (two schedulers, one execution
primitive — `runSchedule` is not generalized in v1); the **journal contract over
its storage** (SQLite is subordinate to the D1 vocabulary, envelope, state
machines, and fsync discipline); and **the recovery unit equals the validity
unit** (blocks rerun whole). Essential coupling kept deliberately: atomic
admission across pools is one transactional invariant, and journal ↔
process-group lifecycle is one concern (pgid-kill-before-rerun,
no-double-spend) — neither decomposes further without breaking its invariant
(D1 §"Kernel-wide seam map", paragraph after the table; PAR §"Coexistence and
sequencing").

Three architectural questions the sources did not pin — global cap semantics
(skeleton OQ-2), KeySelector `wait` accounting (OQ-1), and contention-guard
ownership (OQ-11) — were settled at the approaches gate before revision 1
(GATE). Decisions D-1…D-3 transcribe those adjudications; they are closed.
The remaining skeleton open questions (OQ-3…OQ-10) settle in this spec from
source constraints, drafted as decisions D-6…D-13 for the spec-review gate to
challenge, per the gate's process note.

**Revision history.** Revision 2 landed round 1's Blockers A–E and the
Important bundle (layout fixed to the shipped reconstruction reality; first
draft of proposed D1 erratum E7; ENOSPC fail-stop; mechanism pins; release
timing, drift affected-set, contention hardening, journal precision,
exposure probes, registration determinism, snapshot-first registration,
identity intake, cancellation ordering, recovery guards). The delta
re-review adjudicated NOT-READY on both seats — revision 2 held everywhere
the record asked, but introduced or left latent defects concentrated in E7's
lifecycle core and the mechanism rewrite. **What revision 3 changes** (Rev-3
patch list P-1…P-7, all adopted): **P-1** rebuilds E7.1–E7.3 around
instance-scoped state — membership rides `block_replaced`, fan-out returns
`ignore-late` from terminals, partial predecessors enter via
`excluded_block_replaced`, the seal obligation begins at mint, the reason
set gains `skew_refill`/`exposure_audit`, `superseded_by` invariants pinned,
E7.5/E7.7 tightened; **P-2** replaces the lapsed `BEGIN IMMEDIATE` election
with a verified lock-dir lease + in-transaction generation fencing; **P-3**
forbids mtime-only staleness (heartbeat + dead-holder-with-birth-identity);
**P-4** un-collides publication from the snapshot (`campaign.json` staged +
renamed LAST as readiness marker); **P-5** makes the ENOSPC reservation real
(ballast), fixes the step order, and completes the fate table over the
vocabulary; **P-6** makes breach edges symmetric; **P-7** delivers the owed
literals (429 registry rows, classifier rows + final `InstrumentCause` set,
ID algorithms, CLI table, schema homes) and the minors. Nothing in
D-1/D-2/D-3's adjudicated substance moves. Mechanism claims sol could not
reproduce from checked-in evidence are marked asserted-not-proven and routed
to checked-in tests / the Linux matrix (Mechanism verification).

**Revision 4** is the final surgical pass from REV's "Revision-3 verify
round" → "Round-4 fix list (S-1…S-13)." It gives `block_replaced` its own
non-reducer replay route; closes the mint window with ordered roster
dispositions, superseded-predecessor recovery, and successor-local terminal
witnesses; makes the grants matrix and absolute-total budget snapshots
total; verifies process birth identity before reclaim or cancel signaling;
finishes the campaign.json-last, incomplete-registration, ballast, matcher,
ID, and reserve-exhaustion agreement sweeps; and records both-seat
ratification of roster-on-mint and `subject_rate_limited`. D-1/D-2/D-3,
their numbering, and all 77 R-identifiers remain unchanged. The
absolute-total netting merger stands with the Round-4 atomicity pin: every
spend or budget-exposure membership change journals the superseding
`estimate_inflight` snapshot in the same dispatch critical section.

**Repo idiom D3 follows** (D1 §"Inputs that shape this design"; PAR §"Testing"):
injectable seams — `src/scheduler/clock.ts` `FakeClock` (one Clock seam named
uniformly for journal timestamps, registration, cancellation, cooldowns,
recovery, and sampler cadence), the `src/agents/command-runner.ts`
`CommandRunner` subprocess projection, the `QUORUM_RECORD_SINK` env-sink
precedent. D3 adds two more seams in the same style: a child spawner seam
(the dispatcher observes fake children in tests) and a host-stats probe
(preflight, fingerprint, and the contention sampler share one injectable
probe). No new dependencies: SQLite is Bun built-in (`bun:sqlite`);
detached process-group spawn is `node:child_process`; host-wide locking is
the D2 lock-dir protocol over `node:fs` (Mechanism verification below —
`flock(1)`/`setsid(1)` do not exist on the Darwin dev host, and "POSIX
built-ins" is not an implementation).

## Code and contract reality this design builds on (verified 2026-08-26)

- **D1's contract family is on main** in `src/contracts/campaign/` (12 files):
  `journal-events.ts` (envelope + the 20 event payload schemas),
  `state-machine.ts` (the three-valued transition tables), `crash-windows.ts`
  (journal-prefix → resolution, pure), `digest.ts` (JCS + SHA-256), `pool.ts`
  (`poolKey` + the `KeySelector` type), `typed-failures.ts` (codomain +
  initial `InstrumentCause` vocabulary), plus the Arm/Suite/Campaign/Report
  schemas, profile-parameter registry, and scenario frontmatter.
- **D2's modules are on main**: `src/campaign/provisioning.ts`
  (`materializeSuperpowersWorktree`, single-flight, failure cleanup),
  `src/campaign/instrument-snapshot.ts` (`materializeEvalsSnapshot`,
  `verifySnapshot`, `SnapshotHandle` with `gauntletBin` and
  `superpowersWorktrees`), the `SuperpowersSpec` runner channel threaded
  through both Commander parsers, and the default-deny capability registry
  `superpowersCapability` (`src/agents/index.ts`).
- **Phase 0's engine and estimates are on main**: `src/campaign/simulate.ts`
  (the synchronous discrete-event engine — exact demand-vector algebra,
  per-sample release, greedy backfill, wait attribution) and
  `src/campaign/estimates.ts` (`buildEstimates`, `lookupEstimate` with the
  pinned dimension-drop fallback chain, `serializeEstimates`); the artifact
  ships at `estimates/v1.json`. D3's dispatcher is the live counterpart of
  that engine; D3's registration consumes that artifact.
- **The historical global cap** the ratified semantics inherit:
  `src/scheduler/index.ts` enforces "a TRUE global cap" of `jobs` concurrent
  runs (`DEFAULT_JOBS = 8`) across all pools — one slot per run, matching P0's
  "Global cap counts runs (one slot per sample), matching historical `--jobs`
  semantics" (P0 §"Simulation engine").
- **The spawn model**: `run-all` spawns `quorum run` children via
  `buildChildRunArgs` (`src/run-all/index.ts:190`) against an internal
  run-child entry (`INTERNAL_RUN_ENTRY`, `src/run-all/index.ts:59`); it does
  not call `runScenario` in-process. D2 amended the child-argv surface to
  address the snapshot's own entrypoint (D2 §"Decision D-5"); D3 uses that
  surface. `run-all`'s spawn is **non-detached** — D1 forbids copying that
  site; the detached/process-group discipline to copy is the appliance's
  (`src/appliance/process.ts`: `host_pgid` tracking, `process.kill(-pgid, …)`
  group signaling).
- **The `run_allocated:` protocol line already exists**: `runAllocatedLine`
  at `src/cli/run-command.ts:73`, emitted at run-dir allocation via the
  `onRunDir` seam (`src/runner/index.ts:416,1029-1032`). **Campaign-identity
  intake is new work**: `RunScenarioArgs` (`src/runner/index.ts:387`) carries
  no campaign block today; revision 2 names identity intake as a threading
  surface (Scope item 9; Decision D-8; R-SPN-4).
- **Reconstruction reality (REV verification items 1–2)**: shipped
  `reconstructSnapshot(destDir, runner)` derives `evals/`, `gauntlet/`,
  `bin/gauntlet`, the `.quorum-snapshot-ok` completion marker, **and** the
  `superpowers-<sha>` enumeration all from ONE `destDir`
  (`src/campaign/instrument-snapshot.ts:57,250-274`); it re-reads expected
  SHAs from current worktree HEADs (`:263,271-272`), so a moved HEAD
  verifies against itself unless the caller cross-checks against
  `Campaign.refs` (R-RCV-6 pins the cross-check). Decision D-6's layout is
  the shipped one: destDir = the campaign dir.
- **State-machine reality (REV verification items 3–4)**:
  `applySampleEvent` (`src/contracts/campaign/state-machine.ts`) has no legal
  continuation for any post-`run_allocated` rerun — `attempt_created` applies
  only from `admitted`; every terminal is a dead end — while
  `crash-windows.ts` pins `kill_pgid_rerun_block` as a required resolution:
  shipped D1 names a recovery its own state machine cannot journal (the
  pre-spawn path `void_attempt_readmit` IS expressible). `sealPredicateHolds`
  (`crash-windows.ts:152-170`) iterates only the frozen universe's samples,
  so replacement/rerun instances minting fresh ids are invisible to sealing,
  and `CampaignSchema` freezes blocks/samples with every-sample-in-exactly-
  one-block integrity and no reserve-slot representation. **E7 (Errata) is
  the proposed D1 erratum closing both holes.**
- **Vocabulary reality (REV verification item 5)**: 20 events, no quarantine
  carrier; `sample_disposition` admits only `included |
  excluded_block_replaced`; `block_replaced.cause` is
  `z.enum(INSTRUMENT_CAUSES)` (abort/drift re-entry inexpressible);
  `run_allocated.key_env` is singular, optional, untagged (cannot
  reconstruct subject + grader grants); `budget_stopped` is terminal with no
  resurrection edge. E7 items 1, 2, 4, 5, 6 address these exactly.
- **Reducer routing reality (REV verification item 6)**: the campaign reducer
  rejects sample-scoped events and vice versa **by design** ("callers fan
  them out", `state-machine.ts` header + `applySampleEvent` default arm).
  Replay's event→machine routing is pinned in Decision D-7 so canonical
  streams never read as corruption.
- **SHA-length contracts**: D1 pins 40-hex at the campaign layer
  (`FULL_SHA_RE = /^[0-9a-f]{40}$/`, `src/contracts/campaign/campaign.ts:6`);
  D2's materializers accept 40/64 (`FULL_HEX_SHA_RE`,
  `src/campaign/provisioning.ts`; `SUPERPOWERS_DIR_RE`,
  `src/campaign/instrument-snapshot.ts:58`). D3 pins **40 at the campaign
  layer**; D2's 64-hex acceptance stays dormant (unused, not removed).
- **Sensor reality, verified**: rate-limit detection exists for exactly one
  harness — `ANTIGRAVITY_RATE_LIMIT_MARKER` (`src/agents/antigravity.ts`),
  the `AgyRateLimitWatcher` (`src/agents/agy-watch.ts`), and the runner's
  mid-run/terminal short-circuits (`src/runner/index.ts:1758-1823`) plus the
  `run-all` rate-limit latch (`src/run-all/index.ts:498,550`). Provider-broad
  classification over this surface is D3's sensors work (R-SNS-1).
- **Ref resolution mechanics exist**: `resolveSuperpowersRef`
  (`src/appliance/git.ts:161`) — remote-branch / tag / full-SHA candidates,
  loud `ref_ambiguous` / `ref_not_found` rejections, through `CommandRunner`.
  D3 registration consumes these semantics (R-REG-8).
- **D2's lock-dir protocol exists** (`withDestLock`,
  `src/campaign/provisioning.ts`): the lock is a directory (atomic `mkdir`
  acquire — `EEXIST` = contended); ownership is an unforgeable `owner-<uuid>`
  file with a parseable pid body; staleness is mtime-based (10 min); release
  and reclamation sever via rename-to-unique-trash then delete only beneath
  the severed name — never unlink a locked path in place. D3's host-wide
  live-spend lock reuses this idiom (R-LCK-2).
- **The existing `quorum campaign` CLI** hosts `acquire | estimates | simulate`
  (`src/cli/campaign.ts`); D3 adds `register | run | cancel` there. `report |
  list | status` are D4 (the `report-engine` and `status` seam rows).
- **Run dirs stay in `results/`** (PAR §"Storage semantics"); a campaign
  directory references runs by `run_id` — it never contains or moves them.

### Mechanism verification (Bun 1.3.14, Darwin dev host, rounds of
2026-08-26)

REV Blocker D forbids asserting unverified mechanisms; the REV-2 delta
review (P-2) additionally requires that only what a checked-in test can
reproduce counts as proven — agent-session observations are
**asserted-not-proven** until their test lands. Current standing:

- **`flock(1)` and `setsid(1)` do not exist** on the Darwin dev host
  (`which` finds neither); revision 1's "exclusive `flock(2)`" language is
  retired — Bun exposes no `flock(2)` binding regardless.
- **`BEGIN IMMEDIATE` is per-append atomicity, NOT election — VERIFIED
  (including the negative).** Two Bun processes on one WAL database: a
  contender's `BEGIN IMMEDIATE` is refused with `SQLITE_BUSY` while the
  holder's write transaction is open (t≈1–2ms), **and acquires immediately
  after the holder's COMMIT** (reproduced at t≈6ms with the holder process
  still alive). The revision-2 election claim is withdrawn: transaction
  locks lapse at every COMMIT. `BEGIN IMMEDIATE` keeps its real job —
  serializing one event-append (and its fencing check, below) atomically.
- **Session election = lock-dir lease + in-transaction generation fencing —
  VERIFIED.** The journal writer holds a D2-idiom lock-dir lease beside the
  database (`<campaignDir>/journal.lease.d`, R-LCK-1/P-3 staleness rules);
  election bumps the `meta` row `writer_generation` inside a transaction;
  every append transaction re-reads the generation and rolls back loudly on
  mismatch. Demonstrated: writer A (gen 1) appends; writer B takes the lease
  (gen 2) and appends; **A's next append fails loudly (deposed), B is
  unaffected, the event sequence stays gapless.** A deposed-but-alive
  writer cannot land another event. D4's sealer takes the same lease
  (R-JRN-3).
- **Detached process-group spawn — VERIFIED (child level).**
  `node:child_process` `spawn(..., { detached: true })` under Bun on
  Darwin: child pid == pgid (setsid semantics; observed 91453 == 91453) and
  `process.kill(-pid, 'SIGTERM')` kills the group (observed dead after
  1.5s). This is R-SPN-1's implementation. **Grandchild membership is
  asserted-not-proven** (observed once in the drafting session; the
  checked-in test lands with the kill-mid-block suite).
- **Asserted-not-proven, owed checked-in tests (REV-2 sol audit):** (1)
  GC-finalizer lock release — a `bun:sqlite` connection released to GC
  closes and drops its transaction lock (the journal writer therefore keeps
  its `Database` reachable for the process lifetime); (2) `kill -9` of a
  WAL-mode writer — the next process re-acquires (observed, not checked
  in); (3) grandchild group membership (above); (4) `O_CLOEXEC` on the
  journal FD — campaign children must not inherit it (an inherited FD
  shares the lock and outlives the writer); the spawner pins `stdio` to
  ignore/pipe, and the Linux-gated integration matrix asserts a spawned
  child does not hold the journal lease or lock. None of these is pinned as
  fact anywhere a test cannot reach it.

## Scope

All TDD, repo gates (`bun run check`, `bun run quorum check`) green per commit;
fail-closed throughout: every unresolvable state refuses loudly rather than
proceeding on a surrogate.

1. **`locks` module** — journal writer election (session lease beside
   `journal.db` + in-transaction generation fencing, verified above), the
   host-wide live-spend lock on D2's lock-dir protocol with
   heartbeat + ESRCH/OS-birth-identity dead-holder staleness through an
   injectable process-identity probe, shared by cancel signaling, and the
   resource-floor preflight +
   fingerprint-match obligations (Decision D-3/D-4), stale-lock reclamation
   without unlink-a-locked-path races, and the children-never-acquire
   discipline.
2. **`journal` module** — SQLite persistence in the campaign dir, single
   writer via the verified election, fsync per event, the 20-event vocabulary
   over D1 schemas, ordered read API, replay with the three-valued transition
   function over the pinned event→machine routing table (Decision D-7),
   rebuildable materialized tables (including the spawn-gap stat of Decision
   D-2), and final-path initialization with `campaign.json` marker-file
   publication (Decision D-7).
3. **`registration` module** — **snapshot-first** (REV Blocker C): refs
   resolve, the evals+gauntlet snapshot materializes, and registration reads
   scenarios, agent YAMLs, and `credentials.yaml` from the snapshot's evals
   tree; grid expansion, eligibility rejection matrix, capability rejection,
   pricing from the estimates artifact (E1/E2 keying, ratified; grader-match
   restriction), digest, final-path init → atomic `campaign.json` commit,
   `campaign_opened`, and the
   contention-guard declarations (host fingerprint, `global_run_cap`,
   thresholds, frozen sampler parameters).
4. **`dispatcher` module** — atomic per-block admission across subject pools,
   grader pool, and the per-sample global cap; longest-expected-first
   ordering (block priority = max expected sample duration) + backfill; 429
   cooldowns; replacement rule and E7 rerun entry; budget enforcement;
   cancellation; the materializer/`verifySnapshot` call sites and the drift
   gate; live breach and drift halts.
5. **`spawn/key-select` module** — detached process-group-leader spawn over
   the child-spawner seam (verified mechanism), pgid validation,
   `KeySelector` implementation with derive-only wait accounting and loud
   warnings, campaign-identity intake and stamping before the first provider
   token, role-tagged key grants (E7), `run_allocated` journaling.
6. **`sensors` module** — provider-broad 429/rate-limit classification over
   subject children and the gauntlet child (exact shipped Antigravity
   predicate plus anchored structured new-family matchers, Decision D-10);
   the exposure measurement (`analysis_exposure_started_at`)
   with pinned source precedence and the per-harness `ExposureProbe` contract
   (Decision D-9); and, as lead owner of the contention guard (Decision D-3),
   the timer-driven host sampler, sidecar evidence file with coverage
   predicate, and breach detection with liveness guard.
7. **`failure-classifier` module** — the closed table-driven
   `ClassificationInput → {class, cause?}` map over verdict/outcome × stage ×
   exit/signal × role × sensor evidence, completing D1's `InstrumentCause`
   set (additions join E7).
8. **`recovery` module** — kill-journaled-pgids-first with the pgid identity
   guard, journal↔run-dir reconciliation, whole-block rerun via E7,
   quarantine by attempt-id mismatch (E7 `quarantined` event), crash-window
   resolutions, `SnapshotHandle` reconstruction with the `Campaign.refs`
   cross-check, idempotent `campaign run` resume, cancel-request precedence.
9. **CLI + threading surfaces (minimal, named — three of them)** —
   (a) live-spend-lock acquisition at the `run-all` entry and the direct
   `quorum run` entry (R-LCK-2 — the lock is meaningless unless all three
   verbs take it); (b) **campaign-identity intake**: campaign-identity argv →
   `RunScenarioArgs` → **persisted at run-dir allocation** (this is what
   makes R-RCV-3's attempt-id-mismatch quarantine possible at all) → stamped
   on every verdict/error/stopped path; (c) `quorum campaign register | run |
   cancel` in `src/cli/campaign.ts`. No other file outside `src/campaign/`
   changes behavior.

## Non-goals

- **No journal vocabulary amendments in the gate-adjudicated areas.** D3
  ships zero amendments for key-wait accounting (Decision D-2) and zero for
  the contention guard (Decision D-3) — that is what the approaches gate
  adjudicated, and the claims are scoped to exactly that (REV Blocker A).
  Separately, **proposed D1 erratum E7** (Errata) bundles the lifecycle
  expressibility the shipped D1 state machine cannot journal — PROPOSED
  here, ratified with Drew after the narrow verify pass per the E1–E6
  precedent; until ratified, the writer rejects anything beyond the D1
  20-event vocabulary.
- **No profiles, sealing predicate, report renderer, or `campaign status`
  surface** (D4: `profiles`, `report-engine`, `status` seam rows). D3 hands
  D4 the journal read API, the materialized tables, the contention sidecar +
  coverage predicate, the sealer-writer API, and the pre-seal `verifySnapshot`
  call site.
- **No `campaign report | list | status` verbs** in D3 (same reason); D3's CLI
  surface is `register | run | cancel`.
- **No cross-host pool leases** (PAR §"Execution" → "Cross-process
  enforcement"; R-LCK-3). v1 gating campaigns run on one designated host with
  the blessed bundle; workstation use of that bundle during a gate is
  forbidden by policy, enforced mechanically only by the host-wide lock.
- **No containerized campaign children.** v1 is host-direct on the designated
  host (D1 §"The `run_allocated` contract"); the appliance's two-tier
  `host_pgid`/`container_pgid` model stays the recorded restart point.
- **No `run-all` behavior change beyond lock acquisition**, no legacy
  scheduler change, no dashboard change, no appliance change.
- **No new dependencies.** `bun:sqlite`, `node:child_process`, and `node:fs`
  lock-dir mechanics over the existing dependency set only.

## Decisions

D-1…D-3 were adjudicated at the approaches gate (GATE) — committee
(`gpt-5.6-sol`, `qwen3.8-max-preview`) plus user ratification, 2026-08-26.
They are recorded here, not re-opened; revision 2 amends their text only
where REV authorizes a clarification (D-1's release timing → service end;
the "zero journal vocabulary amendments" claims → scoped to what the gate
adjudicated). D-4…D-5 are the sub-decisions the gate handed to this draft;
D-6…D-13 settle the remaining skeleton open questions from source
constraints. All are written as decisions so the spec-review gate can
challenge them precisely.

### Decision D-1: the global cap is per-sample (OQ-2; USER-RATIFIED)

**Decision:** one global slot per sample — where sample = run = one
historical `--jobs` slot — released per-sample **at service end**.
Registration freezes `global_run_cap` (G) into the campaign document
(Decision D-4 makes it a digest member) and prints the derived max-block
reading for operators (`global_run_cap = G` per-sample slots; max
contemporaneous two-arm blocks = `floor(G/2)`); the dispatcher enforces G as
the third component of R-DSP-1's per-sample demand vector.

**Release timing (REV-authorized clarification of "its own terminal"):**
slots release at **service end — the child's death — not the analytical
terminal**: P0's ratified occupancy model holds each sample's subject,
grader, and global slots until that sample's own service end (P0
§"Simulation engine" → "Occupancy"), and retained-evidence exclusions follow
the same rule — a `skew_excluded` or `excluded_block_replaced` sample holds
its subject/global slots until its process exits and its grader slot until
grader completion (its `gauntlet_ms`, fallback `wall_ms`). The analytical
terminals (`skew_excluded`, `excluded_block_replaced`) retire the sample from
validity accounting without freeing slots early; this clarifies the
transcription, it does not re-open the adjudication (REV §"Important
bundle" → Release timing).

**Ratification record.** Phase 0 flagged this term — "Global cap counts runs
(one slot per sample), matching historical `--jobs` semantics" — as "a
proposed contract term for kernel deliverable 3, not silently settled"
(P0 §"Simulation engine"). Both gate seats independently recommended
per-sample; the user ratified. The stakes the ratification settled:
**per-block semantics would have silently doubled effective concurrency
against every simulated configuration (G=24 per-block ≈ 48 concurrent runs),
invalidated the Phase 0 sweep verdicts and the 8-hour determinations the
program already paid for, and doubled the dollar overshoot bound** ("one
in-flight wave" would have meant 2G samples). The global cap's unique
protective function is host pressure + aggregate throughput; provider quota
and grader capacity have their own pool caps (GATE §"OQ-2").

**Admission-unit and release-timing are one decision.** The gate settled them
jointly: per-sample admission **and** per-sample release — P0's validated
primary model. Splitting the two (per-sample admission, per-block release, or
vice versa) would re-open exactly the confound the sweep measured against.

**G is unamendable by construction:** G is a digest member, so a changed G is
a new digest, which is a new campaign. There is no amendment path and none is
added. Fragmentation (a stranded global slot that no waiting block can use)
is bounded at ≤1 stranded slot per admission instant and is already
structurally present in subject pools; R-REG-13 rejects the structurally
infeasible cases pre-spend (GATE §"OQ-2").

### Decision D-2: KeySelector `wait` is derive-only — zero journal amendments for key-wait (OQ-1)

**Decision:** no journal event for key-wait — **this zero-amendment claim is
scoped to key-wait accounting, which is what the gate adjudicated** (REV
Blocker A). Wait duration is derivable as `run_allocated.ts_ms −
attempt_created.ts_ms` — both events pinned, both journaled in the same
dispatch critical section (R-JRN-8) — and D3 surfaces that difference as a
materialized stat **honestly labeled "spawn-gap"** in every rendering (never
claimed as pure key-wait: it also contains spawn latency and run-dir
allocation). spawn/key-select emits a **loud operator-visible warning on
every wait entry and every resolution, naming the credential and the
duration** (entry names the credential; resolution names credential +
measured wait).

**Rejected alternative — `pool_blocked` reuse — explicitly:** its payload
demands an `until_ts_ms` that key-wait cannot know (forged values corrupt
replay); reuse would corrupt the 429 provider-health signal by mixing
provider throttling with self-inflicted calibration saturation — precisely
the attribution PRI-2524 needs; and it smuggles in an admission-authority
relationship D1 explicitly did not pin ("the pool-level admission cap is
authoritative; key selection lives strictly below admission," D1 §"Decision
D-1") (GATE §"OQ-1").

**Rejected alternative — a `key_wait_ms` field on `run_allocated` — recorded**
(gate seat sol's proposal): exact sealed attribution, but an amendment; the
derive-only answer wins because `wait` is unreachable under honest admission
(`len × ceil(cap/len) ≥ cap`, D1 §"Decision D-1"), exists only as a guard for
miscalibration and recovery rebuild, and the digest covers `campaign.json`,
not the journal — so only replay semantics were ever at stake, and they are
untouched.

**Named escalation path:** if qualification or a live campaign shows `wait`
firing with durations the confounded spawn-gap cannot attribute, and PRI-2524
needs sealed per-credential wait evidence, add a 22nd event via D1 erratum —
the E5 pattern: a binding-only event with `attempt_created`-style semantics
(no state change), admitted by D1's transition tables as recorded-but-
non-mutating (D1 §"Errata and open items"; GATE §"OQ-1"). (Numbered 22nd:
E7's `quarantined` is the proposed 21st, should both ratify.)

### Decision D-3: the contention guard splits ownership — sensors lead, in D3 (OQ-11)

**Decision (gate-adjudicated, qwen's split):**

- **Registration declares** (task 5 in revision 2's ordering): the
  designated host's fingerprint (CPU/mem/disk shape), `global_run_cap`, the
  invalidation thresholds, **and the frozen sampler parameters
  (`cadence_ms`, `sustain_k`)** — all frozen into `campaign.json`'s
  `contention` block, all digest members (Decision D-4).
- **Locks run the resource-floor preflight at host-wide live-spend-lock
  acquisition** (task 2): every `campaign run` — including every resume —
  re-acquires the lock, so the preflight re-checks for free on every entry;
  the dispatcher stays off the telemetry critical path.
- **Sensors own the timer-driven sampler + telemetry sidecar + breach
  detection** (task 7, lead): a periodic host-stats sample appended to a
  sidecar evidence file under the campaign directory.

**Raw telemetry never enters the fsync-per-event journal.** The parent pins
telemetry as "recorded," not "journaled" (PAR §"Execution" → "Contention
guard"), and the D1 20-event vocabulary has no telemetry surface. **D3 ships
zero journal vocabulary amendments for the contention guard — scoped to the
contention guard, which is what the gate adjudicated** (REV Blocker A). The
sidecar — `<campaignDir>/contention-telemetry.jsonl` (Decision D-6) — is
evidence like run dirs: retained under the campaign directory, cited by the
sealed report's accounting block (D4 renders the breach windows), and **not**
replay-required — nothing in the journal references it today, and nothing
needs to. The journal stays self-sufficient for replay; losing the sidecar
degrades seal-time attribution, never recovery correctness (GATE §"OQ-11",
sub-decision list; REV minors — wording fixed).

**Hardening bundle (REV Important, fable I-2…I-5, sol #16/#19, M-8):**

- **Coverage predicate, handed to D4:** the sidecar must cover
  `[campaign_opened.ts_ms, last sample terminal ts_ms]` within N× cadence
  (N registered in the `contention` block, default 4). Any uncovered window
  adjudicates every overlapping block **unknown** — never clean — at seal
  (fail-closed). A torn tail (crash mid-append) truncates at the last
  complete line with a loud note; the truncated interval counts as uncovered.
- **Frozen sampler parameters:** `cadence_ms` and `sustain_k` are digest
  members (registration-declared; defaults 10 000 ms and 3, drafted for gate
  challenge). Breach-window edges are **symmetric and complete (REV-2 P-6):**
  entry = `sustain_k` consecutive threshold crossings; exit = `sustain_k`
  consecutive samples back inside every breached threshold — one shared
  predicate function computes both edges, so the runtime halt and seal-time
  invalidation can never diverge. `sustain_k` (in samples) is the only
  hysteresis; there is no time-based hysteresis field.
- **Dead-sampler liveness:** at every admission wave the dispatcher checks
  the sidecar's last-sample age; staleness > 2× `cadence_ms` halts admission
  (a dead sampler must not look like a quiet host).
- **Missing-sample policy:** a missed sample (probe error, scheduler stall)
  records a gap line `{ ts_ms, missing: true }`; gaps count against coverage
  and neither extend nor interrupt a sustain run.
- **Metric sources pinned:** load1 (`os.loadavg()`), available/total memory
  and swap (host probe), process count (host probe), disk free on the
  campaign/results volume (host probe) — all through the one injectable
  host-stats probe seam.

**Breach handling:** a live breach **halts admission** — no new blocks while
the breach persists; in-flight samples run to service end (admission-only
halt). The operator sees the loud breach warning and the sidecar; recovery is
either the breach clearing (sampler resumes admission automatically, loud at
both edges) or SIGINT → `campaign run` resume, whose lock-acquisition
preflight re-checks for free. Precedent: R-DSP-11's snapshot-drift admission
halt. **Seal-time invalidation** of blocks executed inside a breach window
renders via the already-pinned `adjudication { cell, disposition, rationale
}` event (D1 §"Journal event vocabulary"); D4 applies the registered
thresholds at seal over sidecar breach windows × journal block windows, with
the coverage predicate above.

**Accepted cost (REV Important, records sol #7 without re-opening the gate):**
seal-time invalidation means invalidated blocks are **shortfall, not
refilled** — dispatch is over by then. Named here so reserve guidance is
sized accordingly: a campaign expecting contention buys reserve for expected
instrument replacement, and understands contention invalidation reduces n
rather than consuming reserve.

**Finding recorded (GATE §"OQ-11", sub-decision list):** the D1 seam map
assigns the contention guard to **no module** — it is absent from the D3 rows
and from D2/D4 alike, despite the parent's imperative text ("are registered …
gates launch … is recorded"). This is a seam-map defect, surfaced here as an
erratum/finding on PRI-2874 in exactly the pattern Phase 0 used to surface
parent errata E1/E2: recorded at the first deliverable that hits it, not
silently absorbed (see Errata).

### Decision D-4: contention-guard declarations are digest members

**Decision:** `campaign.json` gains a `contention` block —
`{ host_fingerprint: { cpu_model, cpu_cores, mem_bytes, disk_total_bytes },
global_run_cap: int ≥ 1, thresholds: [{ metric, source, op, value,
relative_of? }], cadence_ms: int, sustain_k: int, coverage_n: int,
mem_tolerance_pct: number, disk_tolerance_pct: number }` — computed and
declared at registration, and **included in the digest**: it is not in
R-REG-4's exclusion list, and inclusion is the default for everything the
exclusion list does not name (D1 §"Digest canonical form").

**Threshold shape:** each threshold pairs an **absolute floor** with an
optional **relative band** (`relative_of` names the fingerprint quantity,
e.g. available memory `lt` max(2 GiB absolute, 10% of `mem_bytes`));
hysteresis is carried solely by the frozen `sustain_k` sample count,
applied symmetrically at both breach edges (Decision D-3, REV-2 P-6).
Registration defaults derive both parts from the fingerprint (initial
defaults flagged for gate challenge: load1-per-core `gt` 2.0; available
memory `lt` max(2 GiB, 10%); swap-used `gt` 25% of swap total; disk-free
`lt` max(5 GiB, 15%) of the results volume; process count `gt` 80% of the
PID table). The parent pins the obligation, not the numbers (PAR
§"Execution" → "Contention guard").

**Fingerprint match policy (REV sol #19):** at resume, exact match on
`cpu_model` and `cpu_cores`; registered tolerance bands
(`mem_tolerance_pct`, `disk_tolerance_pct`) on `mem_bytes`/`disk_total_bytes`
(hardware replacement within tolerance is the same host; outside tolerance is
a new host). **Honest forfeiture text:** v1 host migration = a new full
campaign; completed evidence on the old host is forfeited — there is no
cross-campaign adoption contract, and none is invented here.

**Rationale:** the designated host and its pressure envelope are part of the
campaign's validity conditions — the gate's paired comparisons were bought
under *this* host's contention regime, and Phase 0's makespan verdicts under
*this* G. Host fingerprint and thresholds therefore behave like the frozen
grid: changing them changes what the campaign measures.

**Trade-off documented:** host membership in the digest means **re-
registration after host migration is a new campaign** (new fingerprint → new
digest → new campaign directory). Accepted: cross-host comparability is not
claimed in v1 (R-LCK-3), a migrated campaign is exactly the "changed validity
conditions" case the digest exists to catch, and the parent's recovery answer
to host loss is "new host, rerun incomplete blocks" — which a fresh
registration on the new host expresses honestly (PAR §"Journal and
recovery"). G's membership is the same decision from the admission side
(Decision D-1: "G is unamendable by construction").

**Enforcement:** `campaign run` resume compares the live host fingerprint
(the host-stats probe, Decision D-3) against the registered fingerprint at
lock acquisition per the match policy above; mismatch refuses launch loudly,
naming both fingerprints (R-LCK-2 preflight; fail-closed).

### Decision D-5: contention-invalidated blocks surface at seal via `adjudication` — no new disposition value

**Decision:** blocks invalidated by a contention breach window get **no new
disposition value and no new event** in D3. They surface at seal through the
already-pinned `adjudication { cell, disposition, rationale }` event
(D1 §"Journal event vocabulary"): the rationale names the breach window from
the sidecar, and the disposition marks the cell validity-compromised with
evidence retained — structurally `skew_excluded`-like (the parent's own
analogy for validity-compromised-but-retained data, PAR §"Execution" →
"Skew" rule 3). Blocks overlapped by an **uncovered** sidecar window
adjudicate *unknown*, never clean (Decision D-3 coverage predicate). D4
applies the thresholds and writes the adjudications at seal; D3's obligation
ends at sampler + sidecar + coverage + breach detection + admission halt +
evidence retention.

**Accepted cost (restated from D-3):** invalidated blocks are shortfall at
seal, not refilled — dispatch has ended; reserve guidance is sized for
instrument replacement, not contention invalidation (REV Important bundle).

**Open item handed to D4:** the disposition vocabulary has no
`contention_invalidated` or `unknown_coverage` term, and D3 neither invents
one nor amends the schema; the gap is recorded for D4's sealing/report
vocabulary work (see Open items).

### Decision D-6: campaign-dir layout = the shipped reconstruction layout (OQ-3; REV Blocker B)

The parent pins the top level — `campaigns/<digest-prefix>-<suite>/` holding
`campaign.json`, the journal, and the sealed reports, referencing runs by
`run_id` (PAR §"Storage semantics") — and worktrees "under the campaign
directory" (PAR §"Provisioning"). Revision 1 invented a `snapshot/` subdir;
**revision 2 drops it**: shipped `reconstructSnapshot(destDir)` derives
`evals/`, `gauntlet/`, `bin/gauntlet`, the completion marker, **and** the
`superpowers-<sha>` enumeration from ONE `destDir`
(`src/campaign/instrument-snapshot.ts:57,250-274`), so **destDir = the
campaign dir itself** — exactly what the shipped code, the D2 spec, and D2's
crash-resume contract require. Pinned layout (sol #20's entries included):

```
campaigns/<digest-prefix>-<suite-name>/
  campaign.json                atomic readiness-marker publication
                               (Decision D-7; renamed last)
  journal.db                   SQLite event store + materialized tables
  journal.db-wal               WAL file (present while the WAL is non-empty;
  journal.db-shm               shared-memory index — both documented entries,
                               never hand-edited, checkpointed by writers)
  contention-telemetry.jsonl   sidecar evidence (Decision D-3) — appended by
                               the sampler, fsync per sample, never
                               replay-required
  cancel-request               O_EXCL marker written by `campaign cancel`
                               (Decision D-12); absence-checked first on resume
  .storage-paused              durable ENOSPC marker (Decision D-13)
  .ballast                     physically allocated control-plane reserve;
                               created + fsynced before campaign.json publish
  .quorum-snapshot-ok          snapshot completion marker (D2's contract)
  evals/                       SnapshotHandle.evalsRoot (registered evals SHA)
  gauntlet/                    SnapshotHandle.gauntletRoot
  bin/gauntlet                 SnapshotHandle.gauntletBin (wrapper script)
  superpowers-<sha>/           one worktree per distinct arm SHA, siblings of
                               evals/ — the shipped enumeration shape
```

**Directory naming and collision handling (REV minors; Round-4 S-8):** the
dir name uses the first 8 digest hex chars + suite name. Existing published
`campaign.json` supplies the candidate's full digest; for an incomplete dir,
the first `campaign_opened` event supplies it when readable. A different
digest extends the prefix by 4 chars and retries (verified expansion, loud),
never overwrites. A dir with neither identity carrier is **digest-less**, not
silently equal: under the registration lease it may be reused only when
`campaign.json` is absent, the journal has no event, and no run/cancel/pause
artifact records spend; snapshot/ballast debris is then an unowned
incomplete-registration shell repaired per Decision D-7. Otherwise it is an
ambiguous collision, left untouched while the prefix extends, with a loud
orphan note. The lease prevents a live registration from being mistaken for
debris. Runs remain in `results/`; the journal references them by `run_id`
(R-JRN-9, R-JRN-10). Nothing moves; quarantine is a journal classification
(R-RCV-3) carried by E7's `quarantined` event. **SHA length:** 40-hex at the
campaign layer (D1's `FULL_SHA_RE`); D2's 64-hex acceptance is dormant.

### Decision D-7: journal storage — precision without DDL walls (OQ-4; REV sol #10)

`bun:sqlite`, one database at `<campaignDir>/journal.db`. Precision pinned at
the level REV demands (columns, uniqueness, transaction shape, PRAGMAs,
cursor semantics); index tuning stays implementation-owned under the
replay-determinism byte-agreement tests (REV §"Rejected/disposed" — no
normative DDL walls).

**Tables (columns + uniqueness):**

- `meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)` — carries the
  **`schema_version` row** (R-JRN-2) and the **`writer_generation` row**
  (election fencing, below).
- `events(seq INTEGER PRIMARY KEY, ts_ms INTEGER NOT NULL, type TEXT NOT
  NULL, payload TEXT NOT NULL)` — payload is JCS-canonical JSON of the D1
  payload object; PK gives seq uniqueness and ordering.
- Materialized projections, rebuildable by drop + replay: `blocks(block_id
  PRIMARY KEY, comparison_id TEXT NOT NULL, state TEXT NOT NULL,
  slot TEXT NOT NULL DEFAULT 'primary', instance_of TEXT NULL, mint_seq
  INTEGER NULL, reserve_activation INTEGER NOT NULL DEFAULT 0)`
  (`instance_of`/`mint_seq`/`reserve_activation` maintained from
  `block_replaced` chains, E7); `block_rosters(block_id TEXT NOT NULL,
  sample_id TEXT NOT NULL, arm TEXT NOT NULL, supersedes TEXT NULL, PRIMARY
  KEY(block_id, sample_id))` (the mint-carried successor membership; E7);
  `attempts(attempt_id PRIMARY KEY, sample_id TEXT NOT
  NULL, block_id TEXT NOT NULL, state TEXT NOT NULL, run_id TEXT NULL, pgid
  INTEGER NULL, key_grants TEXT NULL, spawn_gap_ms INTEGER NULL,
  UNIQUE(run_id))`; `pools(pool_key PRIMARY KEY, blocked_until_ms INTEGER
  NULL)`; `spend(seq INTEGER PRIMARY KEY REFERENCES events(seq), kind TEXT
  NOT NULL, amount_usd REAL NOT NULL)`; `amendments(seq INTEGER PRIMARY KEY
  REFERENCES events(seq), amount_usd REAL NOT NULL)`; `adjudications(seq
  INTEGER PRIMARY KEY REFERENCES events(seq), cell TEXT NOT NULL,
  disposition TEXT NOT NULL, rationale TEXT NOT NULL)`; `quarantine(run_id
  TEXT PRIMARY KEY, attempt_id TEXT NULL, reason TEXT NOT NULL, detail TEXT
  NULL)` (E7's projection; present from task 3 so the schema is stable
  across E7 ratification).

**Writer election (session-scoped; verified, Mechanism verification; REV-2
P-2):** revision 2's `BEGIN IMMEDIATE` election is withdrawn — transaction
locks lapse at every COMMIT (sol reproduced a contender appending at t≈6ms
right after the holder's commit; re-verified for revision 3). Election is
**session-scoped, two cooperating parts**: (1) a **lease** — the D2
lock-dir protocol (`withDestLock` idiom, `src/campaign/provisioning.ts`) at
`<campaignDir>/journal.lease.d`, with P-3's heartbeat + dead-holder
staleness rules; exactly one process holds the lease at a time. (2)
**In-transaction fencing** — election bumps `meta.writer_generation` (read,
+1, write, all inside one transaction); **every append transaction re-reads
the generation first and rolls back loudly on mismatch**, so a
deposed-but-alive writer fails its next append rather than interleaving
events (verified: A gen 1 → B gen 2 → A's append refused, B unaffected,
sequence gapless). `BEGIN IMMEDIATE` remains inside each append for
per-append atomicity and to serialize the fencing read+insert. D4's sealer
takes the same lease (R-JRN-3). The journal process keeps its `Database`
connection reachable for the process lifetime (GC-finalizer release is
asserted-not-proven but fail-safe on crash; forbidden in flight).

**Append shape:** one transaction per event — `BEGIN IMMEDIATE` → **fencing
check** (`writer_generation` matches the lease holder's) → `INSERT` into
`events` (`seq = max(seq)+1`) → projection updates → `COMMIT` — so the
event row and every projection it drives land atomically (fsync per event,
R-JRN-4). **PRAGMAs on every writer connection:** `journal_mode = WAL`,
`synchronous = FULL`, `busy_timeout = 0`. **Readers** use separate
connections, never write, never checkpoint. **WAL/checkpoint:** writers
checkpoint at session end and before seal. **`readEvents(afterSeq)` cursor
exclusivity:** returns rows with `seq > afterSeq`; a caller advancing its
cursor after a newly committed event continues exactly from its last
observed seq — no gaps, no re-reads. **Directory fsync** after the
publication rename (below).

**Publication closes the publish-then-journal crash window without moving
the snapshot (REV fable M-1 ≡ sol; REV-2 P-4):** revision 2's whole-dir
staging is withdrawn — it relocated a non-relocatable snapshot (D2's
gauntlet wrapper embeds the absolute `gauntletRoot` and
`assertSnapshotComplete` byte-compares it at the final path,
`src/campaign/instrument-snapshot.ts:126-130,166-172`; git-worktree
registrations don't survive moves). The record's other option is pinned,
restoring R-REG-5's original "publication atomic last": (1) materialize the
snapshot trees **at the final campaign-dir path**; (2) initialize the
journal (schema, `meta`, `writer_generation`, the committed
`campaign_opened` event) and the empty sidecar; (3) create, physically
allocate, and fsync `.ballast` per Decision D-13; (4) **stage
`campaign.json` (`campaign.json.stage.<pid>`, fsync) and rename it into
place LAST, then fsync the campaign directory** — `campaign.json` is the
readiness marker.

**Incomplete-registration re-entry (Round-4 S-8):** a directory without
`campaign.json` is incomplete, not published. Registration first classifies
its digest per Decision D-6 and takes the same registration/writer lease;
only a matching digest or a digest-less, no-spend shell may be repaired.
Exact-clean worktrees reuse D2's idempotent path, and an absent completion
marker re-runs install/wrapper steps. D2 does **not** repair an existing
wrong-HEAD, dirty, non-git, or crash-partial destination — shipped
`ensureWorktreeAt` refuses it — so D3 owns this bounded exception only before
publication: under the destination's D2 lock, no-follow verify the expected
direct-child path, attempt `git worktree remove --force` and `git worktree
prune`, and, for unregistered debris left behind, identity-check then rename
that direct child to a unique sibling and recursively delete only the
severed name. Remove the completion marker through the same no-follow
boundary, recreate the expected SHA with the shipped materializer, and emit
a loud repair record naming the old observed identity. Any failed identity
check or cleanup refuses registration; a published campaign never takes
this repair path. Re-entry creates the journal/event only when absent,
verifies an existing `campaign_opened.digest`, verifies/recreates the
ballast, and **never re-journals** `campaign_opened`. Re-opening an existing
published directory validates digest equality only.

**Replay routing table (REV orchestrator catch, verification item 6):** the
D1 reducer rejects cross-machine events by design ("callers fan them out"),
so replay pins the routing explicitly — a `reject` is corruption **only after
correct routing**:

| Event class | Events | Replay route |
|---|---|---|
| sample-scoped | `attempt_created`, `run_allocated`, `exposure_started`, `run_completed`, `instrument_failure`, `sample_disposition`, `slot_exhausted`, `budget_stopped` | `applySampleEvent` on each named sample (`budget_stopped` names a list; the rest name one) (E7: plus `quarantined` → quarantine projection only) |
| block fan-out | `block_admitted`, `aborted`, `skew_excluded` | fan out per sample of the named block over **frozen universe blocks ∪ E7 mint rosters**; E7 fan-out returns `ignore-late` from terminal states where specified |
| instance mint | `block_replaced` | validate and record the predecessor→successor chain, `mint_seq`, reserve activation, and successor roster in the `blocks`/`block_rosters` projections; **never call `applySampleEvent`** |
| campaign-scoped | `campaign_opened`, `campaign_cancelled`, `storage_paused`, `sealed` | `applyCampaignEvent` |
| accounting | `pool_blocked`, `budget_event`, `amendment`, `adjudication` | materialized projections only (no state machine) |

`ignore-late` stays recorded-but-non-mutating (R-JRN-7).

### Decision D-8: spawn mechanics — CLI-argv children of the snapshot entrypoint, over a spawner seam (OQ-5)

The dispatcher spawns campaign children exactly as `run-all` spawns
`quorum run` children — CLI argv, no in-process `runScenario` — with the
D2-amended child-argv construction addressing the **snapshot's own
entrypoint** (`bun run <evalsRoot>/src/cli/index.ts run …`, cwd inside the
snapshot; R-SPN-8; D2 §"Decision D-5"). Two deviations from copying
`run-all`, both pinned upstream: each child spawns **detached as a
process-group leader** — `node:child_process` `spawn(..., { detached: true })`,
the verified setsid equivalent (Mechanism verification; R-SPN-1 — the
appliance discipline, not run-all's non-detached sites) — and each child's
argv carries the explicit superpowers mode, `gauntletBin`, and the campaign
identity block (R-SPN-9; R-SPN-4 identity intake).

**Supervision:** spawn goes through a **child-spawner seam** (production
implementation wraps detached spawn; tests inject fake children with
scripted protocol lines, exit codes, and run-dirs — the repo's fake-runner
seam pattern, PAR §"Testing"). The dispatcher reads each child's stdout for
the parent-pinned `run_allocated: <run_id>` protocol line (D1 §"Decision
D-3"; PAR §"Identity"; `src/cli/run-command.ts:73`) and observes lifecycle
via child exit; stderr feeds the sensors (Decision D-10). One allocation per
child ⇒ one protocol line ⇒ one `run_allocated` journal event (R-SPN-5).

**Identity intake (REV Blocker C; the named third threading surface):**
campaign identity travels argv → `RunScenarioArgs.campaign` (new optional
field) → **persisted at run-dir allocation** as
`<runDir>/campaign-identity.json` (atomic write, fired at the same seam as
the existing `run_allocated:` emission) → stamped on **every** verdict,
error, and stopped path. The persisted file is what makes R-RCV-3's
attempt-id-mismatch quarantine possible: recovery reads a run dir's identity
without trusting the dispatcher's memory. New work — the protocol line
already exists; the intake does not (Code reality).

### Decision D-9: exposure observation (OQ-6; REV sol #11 ≡ fable I-11)

D1 pins the quantity, definition, owner, source precedence, and fail-closed
absence (D1 §"The exposure-measurement contract"). D3's mechanism is a
per-harness **`ExposureProbe` contract**: each probe (keyed by the harness's
session-log shape knowledge already encoded in `src/normalize/`) is
tail-safe — truncation or rotation re-reads from the file start; rewrites are
detected by shrinking size/inode change and re-derived; emission is
**monotonic and single** per sample (the first observed request timestamp
wins; later observations never move it). The journal's `exposure_started
ts` is the log's own timestamp, not the observation time (R-SNS-5).

**Decision point:** exposure absence/presence is decided **at block
terminal** — a sample whose runtime probe never fired may still take a
**capture-derived value** if the final log yields the earliest-request
timestamp by then (fail-closed applies only when neither source produces one
by decision time). An audit divergence that **changes inclusion** (runtime
value included the sample in the paired comparison; the re-derived value
would exclude it, or vice versa) **invalidates the block**: dispatch-live,
it re-enters via E7 as `block_replaced { kind: 'replacement', reason:
'exposure_audit' }` (E7.2's validity-replacement reason; the invalidated
block's samples take `excluded_block_replaced` with `superseded_by` per
E7.1's partial-predecessor rule); post-dispatch, it is adjudicated at seal.
Per-harness mid-run exposure observability joins the qualification campaign
checklist.

**Source precedence (D1)** is retained — (1) a harness first-generation mark
in the gauntlet child's event stream; (2) the session-log probe above — with
revision 1's dead source-(1) fixtures **trimmed to the precedence hook**
(REV fable M-9, YAGNI): one synthetic-mark test proving the branch wins when
a mark exists, no per-harness (1)-fixtures until a harness emits real marks.

### Decision D-10: provider rate-limit marker table — shipped Antigravity truth + anchored new-family matchers (OQ-7; REV sol #12)

Sensors classify against a **closed, table-driven marker registry**. Each
entry carries `{ family, provider/api predicate (which credential shapes
this entry applies to), evidence source (child stderr | verdict reason text
| gauntlet result | event stream), role attribution (subject | grader — by
child role, so `pool_blocked` names the right pool), retry-after parsing +
units + clamps (parsed value clamped to [from 5s, to per-family max]; absent
→ per-family default cooldown), typed cause mapping (feeds R-CLS-3's grader
causes) }`. **Anchored provider-shaped structure is mandatory for the new
families (rows 2–5); row 1 deliberately preserves the broader shipped
Antigravity predicate rather than claiming structure it does not have.**
Seeded from that one detection (the Antigravity marker,
`src/agents/antigravity.ts` + `src/agents/agy-watch.ts`, ported as the first
entry) plus an initial vocabulary for the families the registered arms and
grader can reach: anthropic, openai-compatible endpoints, gemini, and a
generic-HTTP-429 fallback. **Vocabulary is initial** — qualification is the
live receipt; additions are platform PRs with fixtures.

**The v1 rows (REV-2 P-7: literals delivered, not shapes; cooldown numbers
flagged as drafted defaults):**

| # | family | provider/API predicate | evidence source | anchor (structured, case-insensitive) | retry-after | default / max cooldown |
|---|---|---|---|---|---|---|
| 1 | antigravity | agent runtime = antigravity | agy.log tail, verdict reason, gauntlet result | case-insensitive substring `resource_exhausted` ∣ `ratelimitexceeded` ∣ word-boundaried `\b429\b` — exact shipped `agyLogShowsRateLimit` behavior, `src/agents/agy-watch.ts:16-36`; bare `429` and prose `rate limit 429` match, while embedded hex such as `e4291` does not | none in signal → default | 60s / 15min |
| 2 | anthropic | `api: anthropic` or base_url host `api.anthropic.com` | child stderr, gauntlet result error text | JSON error body `"type":"rate_limit_error"` | parse `retry-after` from the structured error when present, else default | 60s / 15min |
| 3 | openai-compatible | `api: openai-chat` family | child stderr, gauntlet result error text | JSON error body `"code":"rate_limit_exceeded"` ∣ HTTP payload carrying status `429` with `Rate limit` text | parse `retry-after` when present, else default | 60s / 15min |
| 4 | gemini | `api: gemini` family (API-key/OAuth) | child stderr, gauntlet result error text | structured `RESOURCE_EXHAUSTED` in the error payload | parse when present, else default | 60s / 15min |
| 5 | generic-http-429 | any credential (lowest precedence) | child stderr, gauntlet result | structured HTTP status only: `"status":429` ∣ `"status_code":429` ∣ a status line — never prose | none → default | 30s / 5min (weak signal, conservative) |

**Precedence and duplicate arbitration:** the most specific predicate wins
(credential `api` match > base_url host match > generic fallback); one
match per child event (first in stream order); repeated matches inside an
active cooldown coalesce into a single `pool_blocked` whose `until_ts_ms`
is the **max** of the computed untils; subject/grader attribution is by
child role (row shape carries no role override — the dispatcher supplies
the role). All rows feed `until` through the same clamp: parsed retry-after
clamped to [5s, family max]; absent → family default.

**False-positive discipline:** rows 2–5 include model-authored 429 text (a
coding agent discussing "rate limit 429" in its own output, a scenario
fixture containing the string) as non-matching near misses because those
rows require provider-shaped structure. The Antigravity fixture instead
pins shipped truth: prose/bare `429` **does match**, and an embedded hex
trace fragment does not. That broader legacy false-positive surface is a
qualification caveat, not silently withdrawn here. Unmatched suspected
throttling stays visible as a rendered sensor caveat so the <5%
indeterminate bar (R-CLS-6) can see what the registry misses.

### Decision D-11: drift → affected-block mapping (OQ-8; REV sol #6)

D2 hands D3 the cadence — `verifySnapshot` per admission wave, at block
terminal, and pre-seal (D2 §"instrument-snapshot module" → "Calling contract
handed to D3 (cadence)") — and pins that "drift detected at any point
invalidates the affected block range per D3's mapping." Revision 1's
"spawned after the last clean verify" missed long blocks spawned earlier
that consume drifted content mid-run and can terminal-verify clean after
re-materialization. **Revised mapping:** affected = **every block in flight
at any point during [last clean verify, re-materialization complete], plus
every block admitted-but-unspawned in the failing wave** (wave verification
runs before wave admission, so the latter are simply never admitted — halt).
**All affected are killed** (pgids, identity-guarded per R-RCV-1); blocks
whose own terminal verify was clean before the window opened are unaffected.

**Handling, in order:** (1) admission halts (R-DSP-11; PAR §"Instrument
snapshot"); (2) affected in-flight blocks' pgids are killed and journaled
`aborted`; (3) **authorized repair operation (composition with D2's re-entry
contract, REV-2 M-N4)**: each drifted tree is removed through the
`CommandRunner` seam — `git worktree remove --force` + `git worktree prune`
on the source checkout (never `rm -rf`; the worktree registrations live in
the source's `.git/worktrees`) — and re-created by re-invoking the D2
materializer at the same dest. The composition is exactly D2's contracts:
`ensureWorktreeAt` refuses dirty/wrong-HEAD reuse by design
(`src/campaign/provisioning.ts`), its failure-cleanup removes half-created
worktrees, and `materializeEvalsSnapshot` re-runs install/wrapper steps
when the completion marker is absent — so repair is one remove + one
idempotent re-materialize, never a hand-edit. The repair is loud on stderr
naming tree + drift, and its record lands at seal in the `adjudication`
rationale (there is no separate operator-log artifact — REV fable M-3);
(4) admission resumes only after re-materialization succeeds and
`verifySnapshot` is clean; (5) the affected cells re-enter via E7 rerun
instances (`block_replaced { kind: 'rerun', reason: 'snapshot_drift' }` —
reserve- and count-neutral); (6) the incident renders at seal via
`adjudication`. **Pre-seal drift (REV fable M-5, pinned
for D4):** a pre-seal verify failure renders a caveat and **refuses to seal
pending operator acknowledgement** — never seals over a known-drift
instrument. Accepted residual (D2, transcribed): drift landing between a
run's story read and its post-checks within one block interval remains
possible and is bounded by the block-terminal verify + manifest multiset
guard + dirty provenance.

### Decision D-12: cancellation mechanics — one pinned order for both paths (OQ-9; REV sol #8d, fable I-10)

Two verbs, two machines, kept strictly apart; **the kill/journal order is
pinned once and relied upon**. Signal/cancel handling does not interleave an
E7 mint critical section: a live dispatcher finishes the mint + required
roster dispositions before handling the signal. After a crash that left a
partial mint bundle, cancellation kills first to stop spend, then completes
the missing dispositions from pre-mint state before it journals `aborted`;
otherwise `aborted` would destroy the disposition's legal source state.

- **SIGINT/SIGTERM/SIGHUP to the running dispatcher** (R-DSP-7): the
  dispatcher stops admitting, kills every campaign process group (SIGTERM to
  the group, wait, escalate to SIGKILL, verify dead — the pgid identity
  guard of R-RCV-1 applies), journals `aborted` per in-flight block, exits.
  The campaign stays `running` in the state machine — `campaign run` is the
  idempotent resume verb and reruns those blocks whole (R-RCV-2, via E7).
- **`quorum campaign cancel <id>`** (the operator terminal, driving
  `campaign_cancelled` and the `running → cancelled` machine edge):
  marker first — `<campaignDir>/cancel-request` (O_EXCL) — then, whether a
  dispatcher is live or not, the same sequence: **stop admission → kill +
  verify dead (SIGTERM first; I-10c) → complete any partial E7 mint bundle
  → journal `aborted` per in-flight block → journal `campaign_cancelled {
  reason? }` last**. With a live
  dispatcher, the command signals it (pid from the live-spend lock's owner
  token) **only after the same R-LCK-2 process-identity check**: pid exists
  and its OS start time equals the token's `birth_ts_ms`. ESRCH or a birth
  mismatch means the recorded dispatcher is gone (a reused pid is never
  signaled), so the command follows the post-crash path; EPERM, another
  kill error, or unreadable OS start time refuses loudly as identity
  unknown. The dispatcher then performs the sequence; post-crash (no live
  dispatcher), the command takes writer election itself and performs it,
  including the `aborted` journaling (I-10a). `cancelled` is terminal —
  there is no resume of a cancelled campaign (D1 §"State machines").
- **Resume checks `cancel-request` first** (I-10b): a `campaign run` that
  finds the marker completes the cancellation sequence instead of resuming.

**Replay legality note:** the sample machine admits `aborted` regardless of
campaign state, so replay is legal whether `aborted` lands before or after
`campaign_cancelled`; the order is pinned for crash-consistency (a kill
whose journaling never lands is still a kill recovery can reconcile), and it
is relied upon. Fail-closed throughout: cancel never mutates state outside
the journal and process kills; a cancel request against a sealed campaign is
refused loudly.

### Decision D-13: storage pause (ENOSPC) is fail-stop (OQ-10; REV Blocker E; REV-2 P-5)

Revision 1's children-keep-running pause cannot preserve durable truth (REV
sol #9): the journal that cannot write cannot record spend, letting spend
continue unrecorded against the journaled-spend budget invariant, and the
children's own evidence shares the full volume and is doomed anyway.
**Rewritten as fail-stop, with the reservation made real:**

**The control-plane reserve is a ballast, not a preflight floor (REV-2 P-5:
a floor is a prediction, a reservation is bytes).** Before the
`campaign.json` publication rename (Decision D-7 ballast step), D3 creates
`<campaignDir>/.ballast` — an operator-visible file of the reserved size
(**pinned default 8 MiB**, flagged for gate challenge). Creation is
non-sparse and durable: open exclusively; write non-zero buffers through the
entire length (never truncate-only); fsync the file; verify allocated blocks
cover the requested length through the platform filesystem probe; close;
then fsync the campaign directory. Failure or an unverifiable sparse
allocation refuses publication. Idempotent re-entry verifies the same
properties or recreates the ballast before publishing. On ENOSPC the pause
path **releases the ballast (unlink)** and lands the marker, the journal
tail, and cancellation evidence in the freed blocks. The ballast is never
recreated mid-campaign; its absence at any resume is journaled as an
accounting note (the reserve was spent).

**Honest limits:** one ballast reserves its allocated data blocks and frees
one inode/directory entry when unlinked; it does not reserve arbitrary extra
inodes, defeat a filesystem that lies about sparse allocation, or prove that
SQLite WAL/journal amplification fits inside 8 MiB. Registration therefore
records the filesystem probe and rejects a sparse/unverifiable reserve;
inode exhaustion and WAL amplification beyond the freed extent remain
fail-stop limits, named in the pause error and qualification receipt rather
than claimed away. Forcing ENOSPC on the Darwin dev host is not possible
without a quota-bearing tmpfs, so the complete release→write guarantee is
**asserted-not-proven until the Linux-gated matrix passes** (quota-bounded
tmpfs campaign dir, including inode and WAL-amplification cases); the
non-sparse write/fsync checks are portable hermetic tests.

**Pause sequence (step order pinned; REV-2 P-5 contradiction fixed):**

1. **Detect:** SQLITE_FULL/ENOSPC on a journal commit — **or ENOSPC on a
   sidecar append** (the sampler plausibly hits the full volume first; the
   sampler reports the failure and the dispatcher enters the same pause
   path).
2. **Halt admission** immediately.
3. **Release the ballast** (unlink `.ballast`, then fsync the campaign
   directory).
4. **Journal `storage_paused {}`** in the freed space (best-effort — the
   write that fails is the one recording the failure; retries ride the
   freed bytes; if it still cannot land, step 6's marker is the durable
   record and resume journals it retroactively, ordering below).
5. **Kill the campaign children** (group TERM→KILL, verify dead — the
   R-RCV-1 identity guard applies); in-flight spend stops. (Kill follows
   the pause journal, so the pause is durable before the evidence producers
   die — no child keeps spending unrecorded.)
6. **Durable marker:** `.storage-paused` in the campaign dir (atomic
   create) if step 4's event did not land.
7. **Resume reconciliation** (`campaign run`): preflight re-checks the
   floor; the marker is removed only after the first successful commit; the
   spent-ballast note journals.

**Per-event-class fate table (REV fable I-1; REV-2 P-5 completed over the
vocabulary):**

| Fate at pause | Events |
|---|---|
| **Roll back** — admission-section, uncommitted wave | `block_admitted`, `attempt_created`, `run_allocated`; likewise `budget_stopped` (nothing admits during the pause, so the stop decision re-derives at resume) |
| **Buffer in memory + retry with original `ts_ms`** — post-fact evidence from children that terminaled before the kill landed | `run_completed`, `instrument_failure`, `exposure_started`, `budget_event` (each spend for those children lands with its run evidence and the superseding absolute `estimate_inflight` snapshot in one recovery critical section), `pool_blocked` (sensor classification racing the kill) |
| **Recomputed/completed at resume** — block-terminal decisions racing the kill | `skew_excluded`, `sample_disposition`, `slot_exhausted`, `adjudication` (including `replacement_suppressed`/`reserve_exhausted`) re-derive from evidence. A missing `block_replaced` decision may re-derive; an already-landed mint is authoritative, never duplicated, and only its missing roster dispositions are completed (E7.1/R-RCV-2). |
| **Journaled at resume** — killed-mid-run partial blocks | `aborted` per in-flight block (**E7 rerun entry requires it** — the re-entry edge only applies from `aborted`) |
| **Blocked during pause** | `amendment` (refused loudly until resume), `sealed` (impossible — sealing requires `running`), `campaign_opened` (impossible mid-campaign), `quarantined` (recovery-only, post-resume) |
| **Control-plane-reserved retry** | `campaign_cancelled` — a cancel during pause journals `aborted` + `campaign_cancelled` from the freed ballast extent before the storage marker. Under the qualified filesystem/reserve envelope this must land; inode/WAL amplification beyond D-13's honest limits returns a loud storage-fatal result with children already dead, never a fabricated terminal. |
| **Itself** | `storage_paused` (step 4 / retroactive) |

**Terminal-evidence-without-journal rule:** at resume, every journaled
non-terminal attempt whose run dir holds a complete verdict is journaled
terminal from the evidence (outcome-derived, loud); every journaled attempt
with no run dir at all re-enters via E7 rerun. **Retroactive ordering (REV
fable M-6):** if `storage_paused` itself never persisted, resume journals it
**before** the first buffered activity event (resume-time `ts_ms`; envelope
`seq` preserves causality). Resume carries no dedicated resume event:
`storage_paused → running` is D1's derivation rule — the first subsequent
`block_admitted`, `attempt_created`, or `budget_event` (R-JRN-11). Replay
never sees a half-written event.

## Module contracts

Each module section expands the skeleton's pinned requirements into contract
prose; every requirement keeps its R-XXX-N identifier and source citation.
"Fail-closed" below always means: refuse loudly, journal nothing fabricated,
leave the operator a named next step.

### locks

**R-LCK-1 — Journal writer election** (D1 §"Kernel-wide seam map";
PAR §"Execution" → "Cross-process enforcement"; PAR §"Journal and
recovery"). The parent pins "the journal writer holds an exclusive flock on
the campaign dir"; D3's verified session-scoped mechanism for that contract
is the **lock-dir lease + in-transaction generation fencing** of Decision
D-7 (`<campaignDir>/journal.lease.d` + `meta.writer_generation`): one lease
holder at a time; a deposed-but-alive writer fails its next append loudly
(revision 2's `BEGIN IMMEDIATE` election lapsed at every COMMIT —
withdrawn; Mechanism verification). All journal writes and all
state-mutating campaign operations go through the journal writer API.
Registration is the writer during publication (campaign.json renamed last —
the lease is taken at journal init, step 2); `campaign cancel` becomes the
writer only when no dispatcher holds the lease (Decision D-12); D4's sealer
is a writer (R-JRN-3).

**R-LCK-2 — Host-wide live-spend lock.** One lock shared by `campaign run`,
`run-all`, and direct `quorum run` (D1 §"Kernel-wide seam map"; PAR
§"Execution" → "Cross-process enforcement"). Mechanism: **D2's lock-dir
protocol** (`withDestLock` idiom, `src/campaign/provisioning.ts`) at a
host-wide path — atomic `mkdir` acquire; ownership = uniquely-named
`owner-<uuid>` token; release/reclaim rename-then-delete, **never unlink a
locked path in place**. **Staleness (REV-2 P-3 — mtime-only forbidden for
hours-lived locks):** the owner token body is `pid\nbirth_ts_ms\n
last_heartbeat_ts_ms`; the holder **heartbeats** by atomically rewriting
its own token at a pinned cadence (default 30s, injectable clock);
reclamation requires **both** a stale heartbeat (`now − last_heartbeat >
stale threshold`, default 5× cadence — flagged) **and** a dead holder
under the following total identity check. `birth_ts_ms` is the holder's
OS-reported process start time, read through an injectable
`ProcessIdentityProbe` at token creation — never `Clock.now()`. On inspection:
(a) only `kill(pid, 0)` failing with **ESRCH** proves no process exists;
(b) success requires the probe's current OS start time to equal the token's
`birth_ts_ms` exactly (the same probe/normalization produces both); (c) a
different start time proves PID reuse — the recorded holder is dead, but the
replacement process is never signaled; (d) EPERM, any other kill error, or
an unreadable start time is **identity unknown**, not dead, and reclamation
refuses loudly. A same-birth live pid is never reclaimed even against a
stale heartbeat. Reclamation itself still requires stale heartbeat plus
dead/reused identity and uses rename-then-delete severance, never in-place
unlink. The journal lease uses the same predicate.
**Path:** `$QUORUM_LIVE_SPEND_LOCK` env is authoritative; the default is
user-wide (`$HOME/.quorum/live-spend.lock.d`); **production appliance
deployments set the env to the appliance-owned shared path — pinned here;
updating `docs/appliance-runbook.md` to match is an implementation
obligation, not a spec dependency** (REV sol #22/M13 corrected). Contention
refuses launch loudly, **naming the live holder** — pid, heartbeat age, and
(when readable from the token's campaign-id sidecar entry) the campaign id.
This lock is the single authority that makes pool caps meaningful across
processes — v1 admits exactly one top-level spender per host, which the
parent's designated-host discipline already requires. The journal lease
(R-LCK-1) follows the same heartbeat + dead-holder rules; D2's shipped
provisioning lock keeps its own short-operation mtime staleness (shipped
code, out of D3 scope).

**Ownership and children (REV sol #8a, fable M-2):** the FD/owner is the
**dispatcher process only** (the verb that acquired it); the lock-dir
protocol carries no inheritable FD, and where any FD-based mechanism is used
it is CLOEXEC. Children are covered by the holder's accounting and **marked
via an explicit channel** (env/argv flag), never acquiring. Preflight
obligation (Decision D-3): acquisition runs the resource-floor preflight —
live host stats (the injectable host-stats probe) against absolute floors
(free disk for journal + run dirs + control-plane headroom, available
memory, PID headroom) — and, for `campaign run` resume, additionally the
host-fingerprint match of Decision D-4 and key-env presence for every arm +
grader credential (REV fable I-14). Preflight failure fails the acquisition
→ launch refused, fail-closed. **Recovery ordering (REV sol #8c): acquire
lock → kill/reconcile → preflight → admit** — preflight failure refuses
admission but **never blocks cleanup of orphan spenders**: cleanup happens
before the preflight gate, because an orphaned child keeps spending while
the floor is debated.

**R-LCK-3 — One designated host in v1.** Gating campaigns run on the
designated host with the blessed bundle; cross-host pool leases are deferred
until simultaneous multi-host campaigns exist (PAR §"Execution" →
"Cross-process enforcement"). The fingerprint-in-digest decision (D-4) is the
mechanical expression: a campaign is bound to the host it registered on.

### journal

**R-JRN-1 — SQLite persistence in the campaign directory**
(D1 §"Kernel-wide seam map"; PAR §"Journal and recovery"; PAR Appendix B
Journal events). Storage shape per Decision D-7.

**R-JRN-2 — The `schema_version` row.** The parent's journal contract lists
it; D1 names it "a storage-schema obligation of the D3 journal module"
(D1 §"Kernel-wide seam map"; D1 §"Journal event vocabulary"; PAR Appendix B;
D1R Seat 2 P2-5). Written at database creation, checked at open: a
`schema_version` the code cannot read refuses to open (fail-closed).

**R-JRN-3 — Single writer; readers and the sealer** (D1 seam map; PAR
§"Journal and recovery"; PAR §"Execution" → "Cross-process enforcement";
REV sol #7c, fable M-10). Writer election per R-LCK-1. **Status/report
readers never write.** The **sealer is a writer**: D4's sealing act acquires
the writer election through the same explicit journal writer API D3 ships,
for exactly `adjudication` and `sealed` appends. (The shipped
`state-machine.ts` `beginSealing` comment says "the D3 sealer calls this"
while the D1 seam map assigns sealing to D4 — the reconciliation rides the
PRI-2874 seam-map erratum note, Findings.)

**R-JRN-4 — fsync per transition / per event** (D1 seam map; PAR §"Journal
and recovery"; PAR Appendix B). One transaction per event, `synchronous =
FULL` (Decision D-7); an event is either durably on disk with its `seq` or
does not exist.

**R-JRN-5 — Envelope + replay + ordered read** (D1 §"Journal event
vocabulary"; PAR §"Journal and recovery"). Envelope `{ seq, ts_ms, type,
payload }`; `seq` monotonic under single-writer assignment; replay in `seq`
order deterministically reconstructs all materialized state; materialized
tables rebuildable (Decision D-7); `readEvents(afterSeq?)` returns
envelopes in order with cursor exclusivity (Decision D-7) — the D4 read
surface. **Field-name normalization (REV minors):** D1's envelope/event
field names are kept exactly (`ts_ms` on the envelope; `ts` inside
`exposure_started`/`amendment` payloads); D3-internal records (sidecar
lines, `spawn_gap_ms`, probe samples) standardize on the `_ms` suffix.

**R-JRN-6 — The full 20-event vocabulary** (D1 §"Journal event vocabulary"):
the parent's 19 + `campaign_cancelled` (D1 erratum E5, ratified). The writer
validates every payload against the D1 schemas in
`src/contracts/campaign/journal-events.ts` before append; an unknown type or
malformed payload is a loud programming error, never a silent drop. E7's
`quarantined` (21st) is rejected until E7 ratifies (Errata).

**R-JRN-7 — Three-valued replay over the pinned routing table** (D1 §"State
machines"; REV verification item 6). Replay applies `apply | ignore-late |
reject` exactly as D1's pure tables define, with events routed per Decision
D-7's table — sample-scoped to `applySampleEvent`, block fan-out over frozen
membership plus mint rosters, **`block_replaced` to the instance-chain and
roster projections only**, campaign-scoped to `applyCampaignEvent`, and
accounting to projections only. The reducer's by-design cross-machine
rejection is expected behavior, never corruption; `reject` on replay is a
loud journal-corruption finding only after correct routing, never silently
skipped. `ignore-late` is recorded-but-non-mutating (retained-evidence
semantics).

**R-JRN-8 — Journaling order** (D1 §"State machines" → "Journaling order";
D1R C1, S3-P2-6): `attempt_created` before spawn; `run_allocated`
immediately after spawn, in the same dispatch critical section. Residual
orphan window (dispatcher dies between spawn and journal): documented,
bounded by `attempt_bounds.max_time_s`, reconciled by quarantine (R-RCV-4).

**R-JRN-9 — `run_allocated` payload** `{ attempt_id, run_id, pgid, key_env?
}`; `key_env` is the env-var **name only, never the value**, pinned so
key-grant accounting is reconstructable (D1 §"Journal event vocabulary";
D1R C1, S3-P2-3). **E7 extends the parse schema with two explicit arms:** a
legacy arm permits `key_env` only or neither grant field; the D3-emitted arm
requires `key_grants: [{ role: 'subject' | 'grader', env }]` (0–2 entries)
and forbids `key_env`. D3 emits only the new arm. Role presence follows the
registered credentials exactly (Errata E7.5); readers prefer `key_grants`
and fall back to legacy `key_env` as the subject grant.

**R-JRN-10 — Row coverage** (PAR §"Journal and recovery"): block/attempt
state, attempt→run bindings, process-group ids, pool cooldowns, spend,
amendments, adjudications, instance chains, and mint-carried rosters —
realized as the materialized tables of Decision D-7, each rebuildable from
events; E7 adds the quarantine projection.

**R-JRN-11 — Storage-pause state rule** (D1 §"State machines" campaign
mapping; PAR §"Journal and recovery"): ENOSPC → `storage_paused`; resume is
derived from the first subsequent `block_admitted`, `attempt_created`, or
`budget_event` — no dedicated resume event. Mechanics per the rewritten
Decision D-13 (fail-stop).

**R-JRN-12 — `budget_event` kinds** `"spend" | "estimate_inflight"`
(D1 §"Journal event vocabulary"). `spend` rows carry actuals journaled as
children terminal; `estimate_inflight` rows carry the current absolute
remaining exposure snapshot the budget rule consumes (R-DSP-6).
**Absolute-total supersession (Round-4 S-6):** each
`estimate_inflight.amount_usd` replaces every earlier estimate with the
total remaining estimated exposure of the current budget-exposure set; each
`spend.amount_usd` is an actual-cost increment. The rebuild-deterministic
position is exactly `Σ spend + latest estimate_inflight` (zero before the
first estimate). There is no identity netting. **Atomicity pin:** every
`spend` append and every change to the budget-exposure membership appends a
fresh superseding `estimate_inflight` snapshot **last in the same dispatch
critical section**. When one critical section contains both spend and a
membership change, one final snapshot after both changes satisfies both
triggers; it is not duplicated. Membership starts at admission and ends only
at service end or identity-verified kill/release; an analytical terminal
whose child still runs does not remove exposure. No admission or budget
decision may observe the between-event prefix. If the process crashes inside the
critical section, recovery recomputes and appends the superseding snapshot
before any preflight/admission decision. This keeps Decision D-7's
per-event transactions while eliminating the stable double-count window.

**Emitters (REV fable I-6):** child exit + verdict read → the dispatcher
journals `run_completed`; a classifier `instrument` verdict →
`instrument_failure`. Both journal inside the dispatcher's writer session;
sensors and the classifier produce evidence, never journal directly.

**Decision D-2 materialization:** the `attempts` table maintains
`spawn_gap_ms = run_allocated.ts_ms − attempt_created.ts_ms`, labeled
"spawn-gap" in every surface that reads it.

### registration

**Snapshot-first intake (REV Blocker C, sol #3):** registration's order is
resolve refs → choose/lock the final campaign-dir path → **materialize the
evals+gauntlet snapshot at that final path** → read scenarios, agent YAMLs
(`coding-agents/`), and
`credentials.yaml` **from the snapshot's evals tree**, never from the
mutable host checkout. `campaign.json` stores the resolved grid plus the
scrubbed (secret-free) arm/credential execution surface — env-var names and
credential shape, never key material. **Resume authority = `campaign.json`
+ the snapshot**: everything dispatch needs re-derives from those two
without re-reading the host checkout. **Child-contract compatibility (REV
fable I-12):** before committing, registration probes the snapshot CLI for
the child contract — `bun <evalsRoot>/src/cli/index.ts --version` must
succeed, and the evals SHA must contain the minimum child-contract commit
(D2's implementation merge, `f230698`; verified via `git merge-base
--is-ancestor` through the CommandRunner seam). An incompatible evals ref is
rejected loudly, naming the minimum.

**Grid construction.**

**R-REG-1 — Grid expansion incl. `tier=` selectors** (D1 §"Kernel-wide seam
map" registration row; D1 §"Suite"; D1R C6). Comparisons expand into cells
(scenario × comparison) and samples (cell × arm × replicate); `tier=<sentinel
|full|adhoc>` tokens expand to explicit scenario lists via the existing
`readQuorumTier` machinery (`src/story-meta.ts`); the Campaign document
stores the expanded form only.

**R-REG-8 — Ref resolution to SHAs** (D1 §"Arm"; PAR §"Concepts" →
"Registered campaign"; D2 §"Code reality" + §"Non-goals"). Every ref resolves
to a full SHA: superpowers per arm into `Campaign.refs.superpowers_by_arm`
(`null` for `none`), plus evals and gauntlet. Tag-vs-SHA disambiguation is
registration's job, pinned by `arm.ts` (`resolveSuperpowersRef`); D3 reuses
the resolution mechanics of `src/appliance/git.ts:161` through the
`CommandRunner` seam — branch/tag/full-SHA candidates, ambiguous → loud
`ref_ambiguous`, missing → loud `ref_not_found`. **Refs never reach the
runner or the materializers** (D2 §"Non-goals"). **40-hex at the campaign
layer** (D1's `FULL_SHA_RE`; Decision D-6).

**Determinism bundle (REV sol #15, fable M-4):** expansion order is
canonical (comparisons in suite order → cells by scenario sort order → arms
in comparison order → replicate ascending), so re-registration reproduces
byte-identical grids; typed `RegisterArgs` / `RegisterResult` carry the
surface; digest-prefix collision extends the prefix (Decision D-6), never
overwrites.

**ID derivation algorithms (REV-2 P-7; Round-4 S-11 injectivity).** Every
external component interpolated into an id — suite name, scenario name, arm
name — must match `^[a-z0-9][a-z0-9._-]*$`; registration rejects a component
outside it. `:` is **not** a component character: it is reserved exclusively
as the generated delimiter. Existing `ArmSchema`/`SuiteSchema` names already
match a stricter subset; the scenario/campaign component refinement is the
additive schema amendment listed in Contract additions. Full generated ids
therefore use lowercase alphanumerics plus `-`, `_`, `.`, and delimiter `:`,
and are **injective by grammar — no hashing**. A duplicate at construction
is a loud programming error. With `<cell-key> =
<comparison_id>:<scenario-name>`:

| id | algorithm |
|---|---|
| `comparison_id` | `c<N>` — N = 1-based ordinal of the comparison in suite order |
| `<cell-key>` | `<comparison_id>:<scenario-name>` |
| `sample_id` (primary) | `<cell-key>:<arm-name>:r<replicate>` — replicate 1-based ascending |
| `block_id` (primary) | `<cell-key>:b<replicate>` — the block holding that cell's replicate across the comparison's arms |
| reserve block / sample | `<cell-key>:x<k>` / `<cell-key>:<arm-name>:x<k>` — k-th reserve of the cell (E7.0's `slot: 'reserve'`) |
| rerun instance block | `<lineage-root-block-id>:i<seq>` — root = the first non-rerun block in this rerun-only lineage; seq = 1 + the greatest already-minted seq for that root. Thus the successor of `B:i1` is `B:i2`, never `B:i1:i2`; same `sample_ids` as the immediate predecessor (E7.1) |
| `attempt_id` | `<sample_id>:a<seq>` — seq incrementing per `attempt_created` binding of that sample |
| `campaign_id` | the full registration digest hex (identity = digest); the directory name is `<digest-prefix>-<suite-name>` per Decision D-6 |
| `run_id` | runner-minted, unchanged (bound via `run_allocated`) |

**CLI option/default table (REV-2 P-7):**

| verb | positional | option | default | behavior |
|---|---|---|---|---|
| `register` | suite path (required) | `--estimates <path>` | `estimates/v1.json` | artifact consumed (staleness checked, R-REG-21) |
| | | `--global-cap <int>` | 8 (historical `DEFAULT_JOBS`, `src/scheduler/index.ts:6`) | freezes `global_run_cap` |
| | | `--confirm` | off | required to publish; without it the verb prints grid + digest and exits 0 |
| | | `--dry-run` | off | grid + exclusions + digest only, never writes |
| | | | | noninteractive: no tty prompt, ever — absent `--confirm`, publication is refused (the print-and-exit path) |
| `run` | campaign dir (required) | — (none in v1) | | start/resume semantics (R-RCV-7; cancel-request checked first) |
| `cancel` | campaign dir (required) | `--reason <text>` | absent | marker + the pinned Decision D-12 sequence |

**Eligibility rejection matrix** (all fail-closed, all loud-recorded):

**R-REG-2 — Apply the eligibility filters** with reject + loud record
(D1 §"Kernel-wide seam map"; PAR §"Concepts" → "Registered campaign");
rejections land in `excluded_cells` with reasons.
**R-REG-9 — Reject `none`/ref arms for unproven adapters** by reading the D2
default-deny capability registry `superpowersCapability` (D1 §"Arm";
PAR §"Provisioning"; D2 §"Decision D-4").
**R-REG-10 — `os: windows` is a registration error** — parses, then rejects
(D1 §"Errata and open items"; PAR §"Non-goals").
**R-REG-11 — Reject gating cells on obol-unpriced models**; the
operator-declared per-token override (`pricing_overrides?`, recorded in
`campaign.json`, D1 §"Campaign (`campaign.json`)") is the only escape
(PAR §"Concepts" → "Registered campaign").
**R-REG-12 — Reject usd-denominated profile parameters when any arm is
unpriceable** (PAR §"Concepts" → "Registered campaign").
**R-REG-13 — Reject comparisons whose minimum feasible launch cannot meet the
registered exposure-skew bound** — cap-1 pools facing two-arm same-pool
demand, spacing that cannot co-launch; refused pre-spend (PAR §"Concepts" →
"Registered campaign"; P0 §"Simulation engine" → "Demand vector").
**R-REG-14 — Reject arm `os` unsupported by the agent, credential, or
scenario directives** (PAR §"Concepts" → "Registered campaign").
**R-REG-15 — Reject seat/subscription-auth credentials in gating suites**,
enforced mechanically — `CredentialSchema.auth ≠ api-key` in a gating suite
is a registration error, no operator override (PAR §"Concepts" → "Registered
campaign").
**R-REG-16 — Filter `requires_superpowers` conflicts with `superpowers:
none` arms**: the scenario is dropped for that comparison, named in
`excluded_cells` (PAR §"Concepts" → "Registered campaign"; D2 §"Runner
threading" site 4 — this filter does not exist when D2 ships; D3 supplies
it).
**R-REG-20 — Record the grader credential and model singular** (`grader:
{ credential, model }`); registration rejects `--grader-model` overrides on
campaign runs — the dispatcher refuses the flag (PAR §"Concepts" →
"Registered campaign"; PAR §"Execution"). **Grader-cap warning (REV fable
M-3):** registration warns — does not reject — when the grader pool cap is
below 15 in a gating suite (every 8h-clearing Phase 0 configuration had
cap ≥15).

**Pricing and estimates.**

**R-REG-3 — Pricing from the estimates artifact** `quorum.estimates/v1`
(D1 §"Kernel-wide seam map"; PAR §"Concepts" → "Registered campaign";
P0 §"Estimate artifact" + erratum E2; P0R #7): per-arm-within-cell duration
and cost estimates, keyed **scenario×agent×credential×os** (ratified E1/E2
keying — Errata), consumed through `lookupEstimate`'s dimension-drop
fallback chain with per-tier cost; low-confidence estimates take the declared
surcharge into `budget.surcharge_applied`. Estimates and estimate-derived
pricing fields stay **out of the digest** (advisory, re-derivable;
D1 §"Digest canonical form").

**Grader pricing restriction (REV sol #14):** v1 requires the registered
grader credential to **match the estimates artifact's grader** — a different
grader is a registration rejection unless covered by an explicit
token-volume-based `pricing_overrides` entry with rationale. **Surcharge
formula is defined and versioned:** `surcharge_applied = Σ over cells with
confidence < high of (estimated cost × (confidence == 'medium' ? 0.10 :
0.25))`, recorded with a `surcharge_formula_version` constant (v1) in the
`budget` block so a formula change is visible in the sealed accounting; the
constants are drafted for gate challenge.

**R-REG-21 — Estimate staleness check** (P0 §"Estimate artifact"; P0R §"P3
dispositions"): the refresh rule (rebuild after every sealed gating campaign,
or when the newest included run is >30 days older than the build) is checked
at registration; a stale artifact refuses registration fail-closed, naming
the rebuild command.

**Validation.**

**R-REG-17 — Coupling flags for PR-ref arms**: each scenario's registered
`coupling` class is recorded per cell so the report can segregate coupled
cells (PAR §"Concepts" → "Registered campaign").
**R-REG-18 — Profile parameter validation against the D1 registry**:
parameters validate against `src/contracts/campaign/profile-params.ts`;
`mde_by_scenario` must cover every scenario carrying confirmatory cells;
`tripwire_expect` validated on tripwire cells (D1 §"Profile parameter
schemas + registry"; D1 §"Suite").
**R-REG-19 — Preflight fails fast on unset key envs** — every arm credential
and the grader credential: `api_key_env` (or every `key_pool` entry) present
in the environment, else registration refuses (D1 §"Credential amendments");
**and again at every live-spend-lock acquisition** (REV fable I-14), so a
lost env between registration and resume fails before any spend. Spawn
separately fails loud on an exhausted/unset key (R-SPN-7).

**Identity, commitment, operator surface.**

**R-REG-4 — Digest** (D1 §"Digest canonical form"; PAR §"Concepts" →
"Registered campaign"; PAR Appendix B Campaign): JCS-canonicalized (RFC 8785)
JSON of the Campaign document minus `estimates_by_arm`,
`budget.surcharge_applied`, `budget.priced_coverage`, `registered_at`,
`registered_by`, `campaign_id`, and `digest`; SHA-256 over the JCS bytes,
hex-encoded. The digest is the campaign's identity; a changed grid is a new
campaign. **The `contention` block — fingerprint, G, thresholds, and frozen
sampler parameters — is a digest member** (Decision D-4 — absent from the
exclusion list, inclusion is the default).

**R-REG-5 — Final-path initialization → marker-file publication** (D1 seam
map; PAR §"Journal and recovery"): registration initializes the snapshot,
journal, sidecar, and fsynced non-sparse ballast at the **final campaign-dir
path**, then stages and renames `campaign.json` last (Decision D-7). A crash
before that rename leaves an explicitly incomplete, non-runnable directory;
lease-held idempotent re-entry validates its digest class and repairs or
reuses its worktrees by Decision D-7. No whole-directory rename occurs.

**R-REG-6 — `campaign_opened`** `{ campaign_id, digest }` as the
`registered → running` edge, journaled by registration as the first event —
committed in `journal.db` at the final path before `campaign.json` is renamed
into place, never re-journaled on idempotent re-registration (Decision D-7;
D1 §"Journal event vocabulary"; D1 §"State machines" campaign mapping).

**R-REG-7 — key_pool over-capacity warning** (D1 §"Decision D-1:
grader-pool credential shape"; pinned there as a D3 requirement): warn — do
not reject — when a `key_pool` credential's `max_concurrency` exceeds
`key_pool.length × 5` (the single-key cap 5 Phase 0 modeled).

**R-REG-22 — Idempotent re-registration** (PAR §"Concepts" → "Registered
campaign"): unchanged suite + unchanged resolution → same digest → same
campaign directory (no duplicate registration). Published re-opening
validates digest equality only; incomplete re-entry uses Decision D-6's
digest/digest-less classification and Decision D-7's lease-held repair,
never guesses through an ambiguous directory. Registration prints the
priced grid, exclusions, flags, the
digest, **and the derived max-block reading (Decision D-1)** to stdout and
asks for confirmation before publication.

**Contention declarations (Decision D-3, task 5 obligation):** registration
computes the host fingerprint from the host-stats probe (registration runs on
the designated host — the fingerprint *defines* the designated host),
freezes `global_run_cap` from the operator-supplied G (historical `--jobs`
default semantics per P0), declares invalidation thresholds (shape and
defaults per Decision D-4), and freezes `cadence_ms` / `sustain_k` /
`coverage_n` / tolerance bands into the same digest-member block. The
parent pins the obligation, not the numbers (PAR §"Execution" → "Contention
guard").

**Ratification records (task 5 obligation):** registration implements the
E1/E2-ratified estimate keying, and this spec's Errata section records the
D-OQ-2 ratification alongside E1/E2 (GATE §"OQ-2": "settled here by explicit
user ratification and recorded alongside the E1/E2 errata in the D3 spec").

### dispatcher

**R-DSP-1 — Atomic per-block admission** (D1 §"Kernel-wide seam map";
PAR §"Execution"; P0 §"Simulation engine" → "Demand vector"): a block's
demand vector is, **per sample**, 1 slot in the sample-arm's subject pool +
1 slot in the grader pool + **1 global slot (Decision D-1: per-sample)** —
aggregated by pool key (a two-arm block on one credential demands 2 slots
from one subject pool), all granted atomically at one instant, or the block
waits. Admission is one transactional critical section: pool accounting,
`block_admitted` journal event, the superseding absolute
`estimate_inflight` snapshot, and dispatch handoff commit together — the
snapshot is last before handoff and no budget decision interleaves. A crash
mid-admission is reconciled and re-snapshotted before any admission
(fail-closed). **Slots release
at service end — child death — per Decision D-1's occupancy clarification,
including retained-evidence exclusions.**

**R-DSP-2 — Longest-expected-first ordering** (D1 seam map; PAR §"Execution";
P0 §"Simulation engine" → "Ordering"): a block's dispatch priority is the
**max** expected duration across its samples (REV sol #15 — a two-arm block
is as long as its longest arm), where expected = the estimate artifact's
duration median for the sample's (scenario, agent, credential, os) through
the fallback chain — the same frozen estimates registration attached; ties
break deterministically by (comparison, cell, replicate ordinal). Not
clairvoyant: service times are unknown at dispatch.

**R-DSP-3 — 429 cooldowns** (D1 seam map; PAR §"Execution"; D1 §"Journal
event vocabulary"): a sensor-classified 429 puts its pool into a journaled
cooldown — `pool_blocked { pool_key, until_ts_ms }`, `until` from the
marker's retry-after parse with clamps, else the per-family default
(Decision D-10); blocks wait and resume when the cooldown expires; the
legacy terminal-skip latch (`src/run-all/`) is retired for campaign runs and
never copied.

**R-DSP-4 — Backfill** (D1 seam map; P0 §"Simulation engine" → "Admission
rule"): at each admission instant, greedy scan of the waiting queue in
longest-expected-first order — admit every block whose full demand vector
fits, skip blocks that don't fit at this instant (backfill allowed). No
starvation: every admission instant is bounded by the longest in-flight
occupancy and the queue is finite (P0's argument, transcribed).

**R-DSP-5 — Replacement rule** (D1 seam map; PAR §"Execution"; D1 §"State
machines"): a typed instrument failure activates a fresh full block — never
a single arm, never outcome-conditioned; gating suites draw from the
registered `reserve:` (innocent until exhaustion). The innocent arm of a
replaced block gets disposition `excluded_block_replaced` with
`superseded_by`; its run dir is retained and journal-referenced (conservation
rule: one included outcome per primary slot, the report proves it).
**Journal expression is E7's** (`block_replaced { kind: 'replacement',
reason ∈ InstrumentCause }`; Errata). If no unactivated reserve exists, the
obligation resolves only through `adjudication { disposition:
'reserve_exhausted' }`, never `slot_exhausted`/sample `exhausted` (E7.1,
R-DSP-9). **Post-budget-stop replacement resolution (REV fable I-8):** once
a durable budget stop has fired, a not-yet-minted replacement obligation is
not activated — the affected cell seals as **named shortfall** through
E7.1's `adjudication { disposition: 'replacement_suppressed', rationale:
'budget_stopped' }`. `budget_stopped` still terminalizes any separately
planned/admitted samples selected by the budget stop and is never resurrected
(E7.6); it is not the zero-witness replacement carrier.

**R-DSP-6 — Budget enforcement** (D1 seam map; PAR §"Execution"; D1 §"State
machines" + §"Errata" E3): counts are the hard bound (the frozen grid +
reserve), dollars soft — the dispatcher stops admitting new blocks when
journaled `Σ spend + latest estimate_inflight` would exceed `budget_usd`
(all-in: subject + grader + reserves); overshoot is bounded ≈ one in-flight
wave and named at seal. **E3 implemented:** `budget_stopped` reaches
admitted-but-not-yet-spawned samples too — spawning them after budget-stop
would add a second spend wave on top of the in-flight one, violating the
overshoot bound. **Pin (REV sol Q3):** a budget raise **never resurrects**
`budget_stopped` samples; it only prevents future stops (no state-machine
edge exists; E7.6 pins it; tested). Every admission, service-end/verified
kill release, and spend append follows R-JRN-12/E7.7's same-critical-section
superseding-snapshot rule before this budget predicate may run again.

**R-DSP-7 — Cancellation** (D1 seam map; PAR §"Execution"; D1 §"Journal
event vocabulary" campaign_cancelled / erratum E5): SIGINT/SIGTERM/SIGHUP
follows Decision D-12's pinned order (stop admission → kill + verify dead →
journal `aborted` → exit resumable); the live signal path cannot observe a
partial bundle because it never interleaves the mint critical section. The
post-crash operator-cancel path inserts partial-mint completion after kill
and before `aborted`. `campaign run` is the idempotent resume verb and reruns
aborted/in-flight blocks whole via E7; `campaign_cancelled` drives `running →
cancelled` (operator path, Decision D-12).

**R-DSP-8 — Grader pool first-class** (PAR §"Execution"; D1 §"Decision
D-1"): the grader credential is registered, pooled (pool key via `poolKey`),
capped, admitted, priced into `budget_usd`, and recorded in provenance.
Admission accounts **one pool** with cap ≥15 (the Phase 0 requirement —
every 8h-clearing configuration had it; registration warns below it,
R-REG-20); key selection lives strictly below admission, at spawn.

**R-DSP-9 — Runtime skew rule** (PAR §"Execution" → "Skew"; D1 §"State
machines"): in gating campaigns, a block whose exposure skew exceeds the
registered `max_exposure_skew` bound is excluded from the paired comparison
(`skew_excluded`) and refilled from reserve; in exploratory campaigns a
breach is a rendered caveat. Skew is decided at block terminal from the
sensors' timestamps
(R-SNS-2; Decision D-9 decision point). **Journal expression (E7.2):** the
refill is `block_replaced { kind: 'replacement', reason: 'skew_refill' }`
activating a frozen reserve block of the same cell; the excluded block's
samples keep their `skew_excluded` terminal and the conservation link rides
the event chain (no `excluded_block_replaced` disposition for skew — the
block-level event carries it). If no unactivated reserve exists, **the sole
carrier is** `adjudication { cell, disposition: 'reserve_exhausted',
rationale: 'reserve_exhausted' }`; no unreachable `slot_exhausted`/
sample-`exhausted` transition is attempted. The cell seals as named
shortfall under E7.3.

**R-DSP-10 — Budget amendment** (PAR §"Execution"; D1 §"Journal event
vocabulary"): raise-only, pre-seal only, append-only `amendment { kind:
"budget_raise", amount_usd, ts }` in the journal, rendered in the sealed
accounting. No other amendment exists; the frozen grid cannot change by any
path (PAR §"Non-goals"); a raise never resurrects stopped samples (R-DSP-6
pin).

**R-DSP-11 — Snapshot-drift admission gate** (D2 §"instrument-snapshot
module" semantics + §"Error handling"; PAR §"Instrument snapshot"): the
dispatcher calls `verifySnapshot` per admission wave, at block terminal, and
pre-seal (D2's cadence contract); `SnapshotDriftError` — and a
re-materialization `ProvisioningError` on resume/per-wave — map to admission
halt + affected-block invalidation per the revised Decision D-11 (affected =
everything in flight across the window + admitted-unspawned; kill all;
authorized repair = removal + re-create under D2's lock; E7 rerun re-entry).
Same halt semantics serve the contention live breach (Decision D-3):
admission-only halt, in-flight runs to service end, loud at entry and
resolution; plus the dead-sampler liveness halt (>2× cadence staleness).

**Spawn-failure pool halt (REV fable I-14):** N consecutive spawn failures
attributed to one pool (default N=3, flagged) halt admission for that pool
with a loud one-line banner (admission-halt semantics, cleared by operator
resume) — a lost key env cannot burn the reserve. **Halt/resume banner (REV
M-9):** every halt and resume transition prints one line from `campaign run`
naming the cause and the admission state.

**R-DSP-12 — Dispatcher is the materializer's caller** (D2 §"Decision D-1";
PAR §"Provisioning"; PAR §"Instrument snapshot"): materialize one immutable
worktree per distinct arm superpowers SHA (`materializeSuperpowersWorktree`,
`destParent` = campaign dir) and the evals+gauntlet snapshot
(`materializeEvalsSnapshot`, **`destDir` = the campaign dir itself**,
Decision D-6); populate `SnapshotHandle.superpowersWorktrees` with one entry
per distinct arm SHA; materialize before first admission (snapshot-first
registration lands the snapshot at registration; dispatch re-materializes
only under the drift gate's authorized repair).

**R-DSP-13 — Thin dispatcher** (PAR §"Coexistence and sequencing"): the
campaign dispatcher shares the execution primitive (child-arg construction,
credential projection, run spawn) with `run-all`; `runSchedule` is not
generalized in v1; two schedulers coexist until a post-first-seal
unification decision. Campaigns key pools on `poolKey`; the legacy scheduler
keeps `limiterKey` (D1 §"Non-goals").

### spawn/key-select

**R-SPN-1 — Process-group-leader spawn** (D1 seam map; D1 §"The
`run_allocated` contract" → "pgid ownership"; D1R C1, S3-P1-3; PAR
§"Execution"): every campaign run spawns detached as a process-group leader
— **`node:child_process` `spawn(..., { detached: true })`, verified under
Bun on Darwin to give pgid == child pid with group kill working**
(Mechanism verification). The discipline is the appliance's
(`src/appliance/process.ts`); the current non-detached spawn sites in
`src/run-all/` must not be copied.

**R-SPN-2 — pgid ownership and validation** (D1 §"The `run_allocated`
contract"): the journaled pgid is the dispatcher's; it validates pgid ==
child pid before journaling `run_allocated` (a mismatch is a loud spawn
failure, never journaled). v1 is host-direct — no container pgid translation;
Windows is a registration error, so POSIX semantics suffice.

**R-SPN-3 — Projected credential + selected key + per-child superpowers
root** (D1 seam map; D1 §"Decision D-1"): for each child, the subject and
grader roles independently select one env from their credential's pool when
that role uses API-key auth (or resolve its singular API-key env) and inject
it through the existing per-child credential projection (F13 machinery,
`src/agents/command-runner.ts`); the dispatcher never sees individual keys
— key material enters the child's env only. Grants journal under E7.5's
total role-presence matrix; non-API-key roles produce no grant entry.

**R-SPN-4 — Campaign identity before the first provider token** (D1 seam
map; D1 §"Verdict extension"; PAR §"Identity"; D1R S2-P2-6): the spawner
supplies the campaign identity block (`campaign_id, comparison_id, block_id,
sample_id, execution_attempt_id`) to the runner at launch so the verdict is
stamped before the first provider token. **Intake path (Decision D-8):**
campaign-identity argv → `RunScenarioArgs.campaign` → persisted at run-dir
allocation (`<runDir>/campaign-identity.json`, atomic, at the existing
`onRunDir` seam) → stamped on every verdict/error/stopped path. New work;
the `run_allocated:` protocol line already exists (`src/cli/run-command.ts:73`).

**R-SPN-5 — run_allocated correlation** (D1 §"The `run_allocated` contract";
PAR §"Identity"; D1R C1): the dispatcher correlates the runner-emitted run-id
to its attempt by launch identity (it spawned the child; it consumes the
parent-pinned `onRunDir` child-protocol emission, Decision D-8); journals
`run_allocated` exactly once per run (R-JRN-9 payload, E7.5 grants).

**R-SPN-6 — KeySelector implementation** (D1 §"Decision D-1" → "Key
selection is pinned as a contract, implemented in D3"): least-loaded key;
`wait` when every key's in-flight count ≥ `ceil(max_concurrency /
key_pool.length)`. The pool-level admission cap is authoritative — under
honest admission the `wait` branch is unreachable; it exists as a guard for
miscalibration and recovery rebuild, and D3 implements it as such, not as a
second admission authority.

**R-SPN-7 — Resolution fail-loud** (D1 §"Decision D-1"; D1 §"Credential
amendments"; D1R S3-P2-4): credential resolution fails loud for `key_pool`
credentials lacking a selected grant — the harness-conventional-env fallback
in `resolveApiKeyEnvName` is forbidden for them; spawn fails loud on an
exhausted or unset key (registration preflight already failed fast on unset
envs, R-REG-19; this is the runtime guard).

**R-SPN-8 — Snapshot-entrypoint child argv** (D2 §"Decision D-5";
D2 §"Non-goals"): child argv addresses the snapshot's own entrypoint (`bun
run <evalsRoot>/src/cli/index.ts run …`, cwd inside the snapshot); a
PATH-resolved or host-checkout quorum binary is forbidden for campaign
children. D2 built and verified the snapshot and amended the child-arg
surface; D3 owns spawn.

**R-SPN-9 — Explicit superpowers + gauntletBin threading** (D2 §"Decision
D-6"; D2 §"instrument-snapshot module" gauntletBin threading; D2 §"Runner
threading"): the per-child superpowers root travels as an explicit runner
argument — `RunScenarioArgs.superpowers` `{mode:'root', root}` |
`{mode:'none'}` — never ambient env (parent erratum E6);
`RunScenarioArgs.gauntletBin` threads `SnapshotHandle.gauntletBin` so the
child resolves gauntlet from the snapshot.

**Lock discipline of children:** campaign children are marked via the
explicit env/argv channel as covered by the live-spend lock holder's
accounting; they never acquire; journal FDs do not reach them (CLOEXEC
discipline + `stdio` pinning; integration-tested, Mechanism verification).

**Decision D-2 mechanics:** when `KeySelector` returns `wait`, spawn/key-select
prints a loud operator-visible warning naming the credential (entry), waits
(injectable clock), and on resolution prints the warning again with
credential + measured wait duration. The `attempts` materialized stat
`spawn_gap_ms` surfaces in every read API output under the honest
"spawn-gap" label. The escalation path to a later event is recorded, not
implemented (Decision D-2).

### sensors

**R-SNS-1 — Provider-broad 429/rate-limit classification** (D1 seam map;
PAR §"Execution" → "Sensor reality"; PAR §"Typed failures"): classification
over subject CLIs **and** the gauntlet child's stderr/result/event-stream —
preserving the one detection that exists today (Antigravity) exactly while
extending it with Decision D-10's anchored structured rows 2–5. Without this,
cooldowns have
nothing to trip them and grader exhaustion burns reserves silently (the
parent's receipt). Inputs: campaign-child stderr (Decision D-8), run-dir
artifacts tailed live and read at terminal (verdict reason text, gauntlet
result), and the gauntlet event stream; outputs: `pool_blocked` events
(subject pool or grader pool, by the matcher's role attribution) and
typed-cause evidence for the classifier (R-CLS-3). Emitters: the dispatcher
journals; sensors classify (R-JRN emitters).

**R-SNS-2 — Own the exposure measurement** (D1 seam map; D1 §"The
exposure-measurement contract"; PAR §"Execution" → "Skew" rule 1; D1R
S2-P1-2): `analysis_exposure_started_at` per sample, defined as the sample's
first Coding-Agent generation request; the sensors module is the named owner.

**R-SNS-3 — Source precedence** (D1 §"The exposure-measurement contract";
PAR §"Execution" → "Skew" rule 1): (1) the gauntlet child's event stream
where the harness marks the coding agent's first generation; (2) the
coding-agent session log's earliest request timestamp, tail-observed at
runtime and re-derived at capture. Spawn time and Gauntlet-boot time are
forbidden sources. Mechanism per Decision D-9 (per-harness `ExposureProbe`,
tail-safe, monotonic single emission; decision point at block terminal;
capture-derived value permitted by decision time; inclusion-changing audit
divergence invalidates the block).

**R-SNS-4 — Absence is fail-closed** (D1 §"The exposure-measurement
contract"; PAR §"Execution" → "Skew" rule 3): a gating sample whose exposure
cannot be established by the decision point is a skew breach — excluded from
the paired comparison, refilled from reserve; exploratory renders a caveat.

**R-SNS-5 — Emission** (D1 §"Journal event vocabulary"; D1 seam map produces
column): `exposure_started { sample_id, ts }` where `ts` IS
`analysis_exposure_started_at`; `pool_blocked { pool_key, until_ts_ms }` on
classified provider throttling.

**Contention telemetry (Decision D-3; sensors lead, task 7 obligation):**
the timer-driven sampler reads the host-stats probe at the registered
`cadence_ms` (injectable clock; default 10 000 ms) and appends one JSON line
per sample to `<campaignDir>/contention-telemetry.jsonl`, fsynced per
sample: `{ ts_ms, load1, mem_available_bytes, swap_used_bytes,
process_count, disk_free_bytes, breach: [] }` (a missed sample writes the
`missing` gap line instead). Breach detection: a declared threshold crossed
for `sustain_k` consecutive samples (registered; default 3) sets a non-empty
`breach` list, signals the dispatcher to halt admission (R-DSP-11 halt
semantics; loud warning naming the breached metrics at breach entry and
resolution), and records the breach window for seal-time attribution
(Decision D-5). Edge semantics are identical at runtime and seal;
dead-sampler liveness halts admission on staleness > 2× cadence; the
coverage predicate (window `[campaign_opened, last sample terminal]` within
`coverage_n × cadence_ms`; uncovered ⇒ blocks adjudicated unknown) is handed
to D4 with the sidecar. The sidecar is evidence, not replay-required; the
journal remains self-sufficient (Decision D-3). Raw telemetry never enters
the journal — zero amendments for the contention guard (scoped per REV).

### failure-classifier

**R-CLS-1 — Closed map, D3 implementation** (D1 seam map; D1 §"Typed
failures"; PAR §"Typed failures"): the codomain `instrument | evidence |
aborted | shortfall` is D1's contract surface; D3 implements the closed map
from the code's real outcomes into it.

**R-CLS-2 — Table-driven over the full 8-stage enum** (D1 seam map;
D1 §"Typed failures"; PAR §"Typed failures"): `setup | gauntlet | capture |
checks | compose | qa-agent-misconfigured | stopped | unknown`
(`src/contracts/verdict.ts` `RunErrorStage`); one table, exhaustively tested,
no per-call branching.

**Classification input (REV sol #13; REV-2 P-7: rows delivered):** the
table is exhaustive over the product `ClassificationInput = { verdict
outcome (pass | fail | indeterminate), RunErrorStage?, exit class (clean |
signal | crash | spawn-failed), child role (subject | grader), sensor
evidence (none | 429-match | billing-exhaustion | manifest-mismatch) }` →
`{ class ∈ codomain, cause?: InstrumentCause }`. First matching row wins;
the final default row makes exhaustiveness structural. **The v1 rows:**

| # | match (first-wins, top-down) | class | cause |
|---|---|---|---|
| 1 | role=grader ∧ sensor evidence 429-match | instrument | `grader_rate_limited` |
| 2 | role=grader ∧ sensor evidence billing-exhaustion | instrument | `grader_billing_exhausted` |
| 3 | stage=qa-agent-misconfigured | instrument | `grader_misconfigured` |
| 4 | role=subject ∧ sensor evidence 429-match | instrument | `subject_rate_limited` |
| 5 | stage=setup | instrument | `setup_failed` |
| 6 | exit class=spawn-failed | instrument | `subject_spawn_failed` |
| 7 | stage=gauntlet ∧ exit class ∈ {signal, crash} | instrument | `grader_crashed` |
| 8 | role=subject ∧ exit class ∈ {signal, crash} ∧ no stage | instrument | `subject_crashed` |
| 9 | stage=capture | instrument | `capture_failed` |
| 10 | stage=checks | instrument | `checks_crashed` |
| 11 | stage=compose ∧ sensor evidence manifest-mismatch | instrument | `checks_crashed` (composer false-pass guard, parent Checks) |
| 12 | stage=stopped | aborted | — |
| 13 | outcome ∈ {pass, fail} ∧ no stage error | evidence | — (determinate, included) |
| 14 | **default — every other combination** | evidence | — (indeterminate; **never** instrument, R-CLS-4) |

**Final `InstrumentCause` set (pinned here so task 1 adds the vocabulary
before task 7 builds the classifier):** D1's initial six
(`grader_billing_exhausted | grader_rate_limited | subject_spawn_failed |
subject_crashed | capture_failed | checks_crashed`) plus four additions
this table requires: **`grader_crashed`** (gauntlet-child crash, row 7),
**`grader_misconfigured`** (row 3), **`setup_failed`** (row 5), and
**`subject_rate_limited`** (row 4 — symmetric treatment of a throttled
subject run; without it a provider-throttled run would sit
`indeterminate`-never-replaced, violating the outcome-independence
doctrine it was instrument fault). Both revision-3 verify seats ratified
this cause (Round-4 S-13): row 4 precedes determinate evidence deliberately,
so a recovered/pass outcome does not condition whether the instrument fault
is replaced. Closed set of ten; additions beyond it remain platform PRs
(R-CLS-5 wording reconciled).

**R-CLS-3 — Grader billing-exhaustion and grader 429 become typed instrument
causes** (D1 seam map; PAR §"Typed failures"): today they compose to
`indeterminate` with no error (hit 2 of the last 3 batteries); the
classifier, fed by the sensors' grader-child classification (R-SNS-1), emits
them as instrument causes — replacement-eligible, outcome-independent.

**R-CLS-4 — Unknown stays `indeterminate`, never replaced** (D1 seam map;
D1 §"Typed failures"; PAR §"Typed failures"): outcome-independence lives or
dies on this trigger set; the classifier's default arm is `evidence`
(indeterminate), never `instrument`.

**R-CLS-5 — Complete the closed `InstrumentCause` set** (D1 §"Typed
failures"): the closed set is completed by the pinned classification table
above — D1's initial six plus the four additions it requires
(`grader_crashed`, `grader_misconfigured`, `setup_failed`,
`subject_rate_limited`), ten total, delivered via E7 before the classifier
builds (task 1 before task 7). Further additions remain platform PRs with
table rows and fixtures, never campaign-time extensions.

**R-CLS-6 — Acceptance bar context** (PAR §"Typed failures"): an
indeterminate share above 5% in the first gating campaign's accounting block
triggers a reliability fix before any campaign is relied on for a release.
The classifier keeps that rate honest and visible; D3 ships the accounting
inputs, D4 renders them.

### recovery

**R-RCV-1 — Kill journaled pgids first, identity-guarded** (D1 seam map;
PAR §"Journal and recovery"; PAR §"Testing"; REV fable I-13 ≡ sol): on crash
restart, recovery kills every journaled pgid **of an attempt without a
journaled terminal** before any re-admission — an orphaned child keeps
spending and races its replacement (the no-double-spend invariant).
**Guard:** kill only groups whose existence and command-line sanity check
pass (the group exists and its leader matches the campaign-child shape where
inspectable); a group that fails sanity is **recorded
reclaimed-without-kill** (loud), never signaled blind — the same pid-reuse
caution that governs lock reclamation and cancel signaling.

**R-RCV-2 — Reconcile and rerun whole** (D1 seam map; PAR §"Journal and
recovery"; PAR §"Execution"): reconcile the journal against run dirs; keep
completed blocks (evidence intact); rerun in-flight blocks **whole** — the
recovery unit equals the validity unit. Rerun entry is **E7's journal
path**: killed/aborted blocks re-enter via `block_replaced { kind: 'rerun',
reason: 'dispatcher_restart' | 'snapshot_drift' | 'storage_failure' }` —
**reserve- and count-neutral** (same samples, fresh block instance; REV
fable I-9) — then `block_admitted { rerun_of }` re-admits from `aborted`
(E7.1's single new edge). Operator-cancelled campaigns never resume
(`cancelled` terminal, Decision D-12). Terminal-evidence-without-journal
reconciles per Decision D-13. **Mint override (Round-4 S-2): before applying
either crash-window resolver action, recovery folds every `block_replaced`.
A named predecessor is superseded and receives no readmit/rerun action;
recovery completes any missing roster dispositions from that mint's
pre-mint states, then continues from the already-minted successor. A
minted-but-unadmitted successor is admitted as that same successor: the
mint's reserve/budget decision is already durable and is not re-evaluated
into a zero-witness suppression on resume. An
in-flight successor killed during recovery may itself mint one rerun
successor. No prefix can mint a second successor for the original
predecessor.**

**R-RCV-3 — Quarantine by attempt-id mismatch** (D1 seam map; PAR §"Journal
and recovery"; PAR §"Storage semantics"): late or orphaned run dirs are
journal-classified via **E7's binding-only `quarantined` event** (`{ run_id,
attempt_id?, reason }` — attempt mismatch, late terminal, or campaign
mismatch against the run dir's persisted campaign identity, Decision D-8) —
never a filesystem move; nothing moves. The identity file persisted at
run-dir allocation is what makes the mismatch detectable at all.

**R-RCV-4 — Residual orphan window bounded** (D1 §"State machines" →
"Journaling order"): the spawn-to-`run_allocated` window is bounded by
`attempt_bounds.max_time_s`; an orphan landing in it is quarantined at
reconciliation by attempt-id mismatch. Documented residual, matching the
parent's worst-case accounting.

**R-RCV-5 — Crash-window resolutions** (D1 §"State machines"; PAR
Appendix B): D1's pure journal-prefix resolvers, executed: pre-
`run_allocated` → attempt void, re-admit; post-`run_allocated` without
terminal → kill pgid, block rerun (E7's journal path); post-seal-predicate
pre-report → regenerate report idempotently (the last window is D4's act;
D3 hands it the resolver plus E7's instance-complete seal predicate).
**Resolver override:** both attempt resolutions are ignored for any block
already named as a `block_replaced.block_id`; R-RCV-1 still kills an
identity-matching live pgid, but recovery completes that mint bundle and
resolves its successor instead (R-RCV-2). For rerun rosters that reuse
sample ids, predecessor-era terminals do not satisfy the successor's
post-mint obligation.

**R-RCV-6 — `SnapshotHandle` reconstruction + refs cross-check** (D2
§"instrument-snapshot module" semantics; D2 §"Exit criteria"; REV Blocker
B): on resume, D3 calls `reconstructSnapshot(<campaignDir>, runner)` —
destDir = the campaign dir itself (Decision D-6): roots and `gauntletBin`
re-derive from the shipped layout, SHAs re-read from per-tree worktree
HEADs, `superpowersWorktrees` re-enumerated from the `superpowers-<sha>`
siblings. Because reconstruction reads expected SHAs from current HEADs,
resume then **cross-checks the handle against `Campaign.refs`** — evals SHA,
gauntlet SHA, and the exact set of arm superpowers SHAs — and refuses
loudly on any mismatch; **expected identity never derives from current HEAD
alone**. Then `verifySnapshot` (R-DSP-11) before admitting anything.

**R-RCV-7 — `campaign run` is the idempotent resume verb** (PAR §"How to
read this document" operator surface; PAR §"Execution"): the same command
starts and resumes. **Pinned resume order:** check `cancel-request` first
(complete cancellation instead of resuming — Decision D-12) → acquire the
live-spend lock → kill/reconcile (identity-guarded; complete any partial
mint bundle before crash-window resolver actions) → preflight (floors +
fingerprint + key envs) → reconstruct handle + refs cross-check +
`verifySnapshot` → admit. Every resume prints the one-line state banner
(REV M-9).

## Interfaces handed to D4

- The journal's ordered read API + rebuildable materialized tables
  (block/sample/attempt state incl. rerun/replacement instance chains,
  mint seq/rosters and successor-local witnesses, spend with absolute-total
  estimate supersession, amendments, adjudications, spawn-gap, quarantine)
  — the report engine's read surface; the sealing predicate runs over the
  journal with **E7's instance-complete form** (PAR §"Execution" →
  "Sealing").
- **The sealer-writer API:** D4's sealing act writes `adjudication` and
  `sealed` through D3's journal writer election (R-JRN-3).
- The contention sidecar + registered thresholds + frozen cadence/sustain +
  **coverage predicate** (Decision D-3/D-5): D4 applies thresholds at seal
  over breach windows × block windows, adjudicates uncovered-window blocks
  unknown, and writes the `adjudication` entries; the disposition vocabulary
  question is D4's open item.
- The pre-seal `verifySnapshot` call site (R-DSP-11 cadence) — D4's sealing
  invokes it; D3 owns the mapping of its failure, including the
  refuse-to-seal-pending-operator-acknowledgement handling (Decision D-11).
- The typed-failure accounting inputs (classifier output, sensor caveats)
  for the report's accounting block and the <5% bar rendering.
- The budget-event/amendment trail (with the never-resurrects pin) for the
  sealed accounting.
- The `campaign report | list | status` verbs themselves (D4 seam rows),
  over these surfaces.

## Artifact layout

```
src/campaign/
  locks.ts               journal writer election (lease beside journal.db +
                         writer_generation fencing); host-wide live-spend
                         lock on the D2 lock-dir protocol with heartbeat +
                         ESRCH/OS-birth-identity dead-holder staleness;
                         injectable ProcessIdentityProbe shared by cancel;
                         resource-floor preflight + fingerprint match +
                         key-env check; stale reclamation
  host-stats.ts          injectable host probe (load/mem/swap/process count/
                         disk) — shared by preflight, fingerprint, sampler
  journal.ts             SQLite store; lease + fenced one-transaction
                         append; ordered read API; routed replay over
                         universe-plus-instance membership with a dedicated
                         block_replaced→chain/roster route; successor-local
                         mint state; absolute-total budget snapshots;
                         materialized tables; rebuildMaterialized(); P-4/S-8
                         publication (final-path repair, fsynced ballast,
                         campaign.json staged + renamed last)
  registration.ts        snapshot-first intake, child-contract probe, grid
                         expansion, rejection matrix, ref resolution,
                         pricing + grader restriction, delimiter-safe ID
                         determinism, digest, incomplete-dir classification
                         + repair, marker-file publication, contention
                         declarations
  dispatcher.ts          admission, ordering (max-sample priority),
                         backfill, cooldowns, replacement/rerun entry,
                         ordered mint bundle + superseded-predecessor rule,
                         absolute budget snapshots + never-resurrects,
                         cancellation protocol, spawn-failure pool halt, halts,
                         materializer/verifySnapshot call sites
  spawn.ts               detached process-group-leader spawn over the
                         spawner seam; pgid validation; child-argv
                         construction incl. campaign identity;
                         run_allocated correlation + journaling
  key-select.ts          KeySelector implementation (least-loaded; wait
                         guard; loud warnings; spawn-gap accounting)
  sensors.ts             marker-table classification; ExposureProbe
                         measurement; decision point at block terminal
  contention.ts          sampler, sidecar writer + coverage predicate,
                         breach detection, liveness guard (leads the guard
                         per Decision D-3)
  classifier.ts          ClassificationInput → {class, cause?} table
                         (closed map)
  recovery.ts            identity-guarded pgid kill, reconciliation, E7
                         mint-bundle completion + predecessor resolver
                         override + rerun entry, quarantine, crash windows,
                         handle reconstruction + refs cross-check,
                         cancel-request precedence
src/contracts/campaign/  E7 amendments (Errata; PROPOSED, ratified with
                         Drew after the narrow verify pass):
                         journal-events.ts (+ quarantined; block_replaced
                         reason/kind/roster widening; block_admitted
                         rerun_of; run_allocated legacy/new grant union),
                         state-machine.ts (re-entry edges from aborted/
                         completed/instrument_failed; admitted replacement
                         disposition; terminal-tolerant fan-out for
                         aborted/skew_excluded), crash-windows.ts
                         (instance-aware fold + successor-local seal
                         predicate from mint),
                         typed-failures.ts (four cause additions),
                         campaign.ts (BlockSchema.slot, execution_surface,
                         surcharge_formula_version, grader-capable
                         PricingOverrideSchema, ID-component refinement)
src/runner/index.ts      + RunScenarioArgs.campaign (identity intake,
                         Scope 9b); persisted at run-dir allocation;
                         stamped on verdict/error/stopped paths
src/cli/run-command.ts   + campaign-identity persistence at the onRunDir
                         seam (existing run_allocated: line unchanged)
src/cli/campaign.ts      + register / run / cancel verbs
src/run-all/index.ts     + live-spend-lock acquisition (named threading
                         surface; no other behavior change)
src/cli/run-command.ts   + live-spend-lock acquisition for direct quorum run
                         (named threading surface; children never acquire)
test/campaign-*.test.ts  hermetic tests per module (siblings of the existing
                         campaign-*.test.ts family); E7 lifecycle golden
                         streams; portable hermetic matrix
test/integration/        Linux-gated integration matrix (Validation
                         strategy)
test/fixtures/campaign/  golden campaigns, rejection-matrix suites, marker
                         streams incl. false positives, crash prefixes,
                         fake host-stats series, exposure fixtures
campaigns/               campaign directories (gitignored)
```

## Validation strategy

Repo culture: no mocked-behavior tests. Seams carry the fiction; everything
else runs against real fixtures, real tmp git repos, real subprocesses. The
Clock seam (`FakeClock`) is named uniformly across journal timestamps,
registration, cancellation, cooldowns, recovery, and sampler cadence.

**Portable hermetic matrix (runs on the Darwin dev host):**

- **locks:** journal-lease acquisition via two same-host processes (one
  lease; contender refused naming the live holder; dead holder + stale
  heartbeat → reclaim; `BEGIN IMMEDIATE` append serialization asserted
  separately); live-spend lock-dir contention, stale reclamation requiring
  stale-heartbeat AND
  dead-holder (a merely-old token with a live pid is never reclaimed;
  heartbeat cadence on the injectable clock), rename-then-delete teardown
  leaves successors untouched; **deposed-writer fencing** (writer A gen 1,
  writer B gen 2 — A's next append fails loudly, B unaffected, sequence
  gapless; the verified scenario of Decision D-7); preflight failure
  refuses acquisition (fake host-stats probe below floor); fingerprint
  mismatch on resume refuses; injected process-identity cases (ESRCH,
  matching birth, reused pid/different birth, EPERM, unreadable start time)
  prove only ESRCH/mismatch count dead and cancel never signals a reused or
  unknown pid; children never acquire (marking channel asserted).
- **journal:** replay-determinism (rebuild materialized tables twice,
  byte-identical; incremental == rebuilt); crash-window prefixes (truncated
  event streams replay to the D1 crash-window resolutions); the routing
  table (cross-machine events rejected by design are not corruption;
  `block_replaced` updates instance/roster projections without touching the
  sample reducer; misrouted/corrupt rows are); fsync-per-event commit shape;
  spawn-gap correctness; the P-4/S-8 publication order (snapshot at final
  path → journal init → non-sparse fsynced ballast → `campaign.json` renamed
  last), with crash prefixes for exact-clean reuse, wrong-identity
  remove/recreate under lock, digest-less shell reuse, ambiguous-shell prefix
  extension, and cleanup refusal; `budget_event` netting (absolute-total
  rule: latest `estimate_inflight` supersedes, `spend` increments, position
  = Σ spend + latest estimate) plus crash injection after either event of a
  spend/membership critical section — recovery snapshots before admission.
- **E7 lifecycle golden streams:** post-`run_allocated` crash → aborted →
  rerun instance → terminal (reserve-neutral accounting); **partial-block
  abort over a completed sibling (fan-out `ignore-late` from `completed` —
  the shipped reject case)**; `excluded_block_replaced` from `admitted` plus
  the shipped `spawned | exposed | completed` sources; rerun re-entry from
  each of `aborted |
  completed | instrument_failed` and REJECT from the non-re-entry
  terminals; instrument replacement chain → conservation
  (`excluded_block_replaced` + `superseded_by` → included superseder);
  `superseded_by` enforcement phases (structural graph violations reject at
  replay; same-cell/arm rejects against Campaign; a live dangling chain
  replays but refuses seal; exact roster/disposition correspondence);
  membership derived from events only (replay with the frozen document alone
  cannot see rerun instances); budget-stop +
  raise → never-resurrects; drift-kill rerun; skew refill (`skew_refill`
  reason) and exposure-audit replacement; ENOSPC rerun;
  mutually exclusive `replacement_suppressed` / `reserve_exhausted`
  adjudications sealing named-shortfall cells;
  `quarantined` binding-only rows replay non-mutating; the
  instance-complete seal predicate (primaries + activated reserves only;
  successor obligation from mint; same-id rerun requires post-mint terminal
  witnesses; unactivated reserve imposes nothing).
- **Round-4 S-2 hand-replay fixtures (each assertion is journal-prefix
  exact):** (1) mid-replacement crash after mint/before an innocent-sibling
  disposition → kill, complete that disposition from the roster, suppress
  predecessor rerun, admit the minted successor; (2) drift kills an in-flight
  replacement → abort the replacement, repair, mint its lineage-root rerun,
  require post-mint terminals; (3) SIGINT during a partial rerun → completed
  sibling ignores late abort, other sibling aborts, resume mints the next
  root-local rerun seq; (4) reserve exhaustion races budget stop → the
  critical-section precedence emits exactly one cell adjudication; (5)
  cancel between mint and admission → no successor spawn, complete any mint
  bundle, `campaign_cancelled` last, refuse resume; (6) same-id rerun mint
  before admission → predecessor terminals do not satisfy successor, so seal
  rejects until post-mint terminal witnesses land.
- **registration:** golden campaigns (fixed suite + arms + estimates fixture
  → expected `campaign.json` bytes + digest); digest stability (excluded
  fields mutate, digest invariant; included fields — including the full
  `contention` block — mutate, digest changes); the full rejection matrix
  (R-REG-9…16, 19, 20 each with accept and reject fixtures); E1/E2 keying
  through `lookupEstimate` tiers; grader-match restriction; staleness
  refusal; idempotent re-registration; digest-prefix collision extension
  including digest-less incomplete dirs; ID-component delimiter rejection
  and collision vectors; rerun lineage `B:i1 → B:i2`;
  child-contract probe rejection (evals SHA below the minimum);
  snapshot-first intake (scenarios/configs read from the snapshot tree).
- **dispatcher:** injectable clock + fake spawner; adversarial arrivals
  (mixed-size comparisons sharing pools, PAR §"Testing"); per-sample global
  cap accounting with **service-end release incl. retained-evidence
  exclusions** (Decision D-1 clarification); atomicity under crash
  injection; cooldown wait-and-resume with retry-after clamps; replacement +
  reserve draw; budget stop incl. the E3 admitted-edge and the
  post-budget-stop `replacement_suppressed` shortfall resolution; skew
  exclusion at block terminal;
  drift-halt (affected-set correctness across the window) and breach-halt;
  spawn-failure pool halt.
- **spawn/key-select:** spawn fixtures over the spawner seam — detached
  spawn asserted (pgid == child pid, validated before journaling); the
  snapshot-entrypoint argv (a hostile originating-checkout fixture proves
  only snapshot content executes, D2's test pattern); campaign-identity
  intake (persisted at allocation, stamped on verdict/error/stopped paths);
  role-tagged grant schema matrix (legacy key_env-only/neither parse;
  post-E7 key_grants required and key_env forbidden; empty, subject-only,
  grader-only, both; duplicate role rejects; dispatcher sees names only);
  fail-loud resolution; wait-guard loud warnings + spawn-gap derivation.
- **sensors:** fixture streams per pinned matcher row (all five of
  Decision D-10's table, each with its anchor + a non-matching near-miss)
  including the exact Antigravity receipt (bare/prose `429` trips; embedded
  hex `e4291` does not) and new-family false-positive streams
  (model-authored 429 text without provider structure never trips rows
  2–5); retry-after parse + clamp behavior;
  precedence/duplicate arbitration (specific beats generic; coalesced
  `pool_blocked` takes the max until); ExposureProbe semantics (truncation
  re-read, monotonic single emission, capture-derived value by decision
  time, inclusion-changing divergence invalidates); fail-closed absence;
  sampler cadence + sidecar content + missing-sample gaps + **symmetric
  K-sustained breach entry and exit** over fake host-stats series; coverage
  predicate windows; dead-sampler liveness halt; sidecar-append ENOSPC
  signaling; sidecar never replay-required (journal replays with the
  sidecar absent).
- **failure-classifier:** exhaustive `ClassificationInput` table over the
  product; grader billing-exhaustion and grader 429 typed as instrument
  causes; unknown combinations stay `evidence` and never replace.
- **recovery:** kill-mid-block tests — crash between spawn and
  `run_allocated` (orphan window, quarantined at reconciliation via
  `quarantined`), mid-block (identity-guarded pgid kill before rerun, no
  double spend), post-terminal (nothing rerun); refs cross-check refusal on
  a moved HEAD; idempotent `campaign run` resume converges on the same
  terminal state; cancelled campaigns refuse resume (cancel-request
  precedence).

**Linux-gated integration matrix (trusted-maintainer, separate from the
portable suite):** real two-process locking on a shared filesystem; the
production process-start-time reader compared against owner-token
`birth_ts_ms` under a recycled pid (reclaim and cancel never signal the
replacement; non-ESRCH probe failures refuse); detached
group TERM→KILL escalation against real grandchildren (asserted-not-proven
debt); pid-reuse defense (lock reclamation and cancel signaling under a
recycled pid); kill -9 SQLite reopen (WAL recovery; asserted-not-proven
debt) and GC-finalizer lock release (asserted-not-proven debt); forced
`SQLITE_FULL` on a quota-bounded tmpfs campaign dir exercising publication
refusal for sparse/unfsynced ballast, ballast-before-campaign.json ordering,
byte exhaustion, inode exhaustion, and SQLite WAL amplification; the
qualified full fail-stop path is **ballast release → marker/tail/
cancel-evidence landing → kill → retroactive `storage_paused` ordering →
resume reconciliation** (the ENOSPC fault injection the Darwin host cannot
run); sidecar-append ENOSPC
as the first detector; partial sidecar / torn tail truncation; exposure
races (log appears at terminal); D2 reconstruction drift (moved HEAD →
refs cross-check refuses); direct `quorum run` and `run-all`
live-spend-lock integration (all three verbs contend); campaign-child FD
non-inheritance of the journal lease (asserted-not-proven debt).

## Errata and open items

### Ratifications and inherited errata

- **Revision-3 verify judgments (Round-4 S-13):** both verify seats ratified
  roster-on-mint (`block_replaced` remains the membership carrier) and the
  `subject_rate_limited` `InstrumentCause`; neither is reopened in revision
  4. The orchestrator-adjudicated S-6 merger also stands: absolute-total
  netting plus a superseding `estimate_inflight` snapshot in the same
  dispatch critical section as every spend or exposure-membership change.
- **E1/E2 — estimate keying + fallback content (P0) — RATIFIED in revision
  1, unchanged.** Registration consumes the scenario×agent×credential×os
  artifact with the cost-carrying fallback chain; the parent's "keyed
  scenario × agent" is superseded as of D3 (P0 §"Parent-spec errata
  surfaced"; D1 §"Errata and open items"). The D-OQ-2 ratification
  (per-sample global cap, user-ratified) stands recorded alongside E1/E2.
- **E3 — `budget_stopped` admitted-edge extension** (D1 §"Errata"):
  implemented by the dispatcher (R-DSP-6).
- **E4 — `key_pool` credential amendment** (D1 §"Errata"): consumed by
  spawn/key-select (R-SPN-3, R-SPN-6, R-SPN-7) and the registration warning
  (R-REG-7).
- **E5 — `campaign_cancelled` event** (D1 §"Errata"): implemented by
  journal + cancellation (R-JRN-6, R-DSP-7, Decision D-12).
- **E6 — per-child superpowers delivery as explicit runner argument**
  (D2 §"Decision D-6"): consumed by spawn (R-SPN-9).
- **Contract additions this spec makes (flagged for the review gate;
  REV-2 sol I9 homes named):** amendments in existing D1 schema homes; all
  are additive except the pre-D3 ID-component refinement named below. None
  amends the journal vocabulary except via E7 itself.
  - `CampaignSchema` + `contention` block — fingerprint, `global_run_cap`,
    thresholds, frozen sampler parameters (Decisions D-3, D-4).
  - `CampaignSchema` + `execution_surface` block — the scrubbed,
    secret-free arm/credential execution surface snapshot-first
    registration stores: per arm `{ name, agent, credential, auth, api,
    base_url?, model, key_env_names[] }` (env-var names only, never key
    material; Blocker C intake). Home: `src/contracts/campaign/campaign.ts`.
  - `CampaignSchema.budget` + `surcharge_formula_version: int` (v1 = 1)
    beside the existing `surcharge_applied` (Registration → Pricing).
    Home: `src/contracts/campaign/campaign.ts`.
  - `BlockSchema` + `slot?: 'primary' | 'reserve'` (default `'primary'`)
    — E7.0's frozen slot representation. Home:
    `src/contracts/campaign/campaign.ts`.
  - Campaign ID components + `^[a-z0-9][a-z0-9._-]*$` refinement for every
    interpolated suite/scenario/arm component; `:` remains a generated
    delimiter only (Round-4 S-11). Existing arm/suite names already satisfy
    stricter schemas; registration applies the new refinement to resolved
    scenario names before any D3 campaign exists. Homes:
    `src/contracts/campaign/campaign.ts` and `src/contracts/campaign/suite.ts`.
  - `PricingOverrideSchema` + grader-capable overrides: `arm` becomes
    optional and `applies_to_grader?: boolean` joins, refined to exactly
    one of the two — the grader-match restriction's escape (R-REG-3
    grader pricing restriction). Home:
    `src/contracts/campaign/campaign.ts`.
  - `RunScenarioArgs.campaign` identity-intake field (Decision D-8).
    Home: `src/runner/index.ts`.
  - E7's amendments (payloads, edges, seal predicate, `quarantined`,
    `InstrumentCause` additions) as drafted below — PROPOSED, ratified with
    Drew after the narrow verify pass.

### Proposed D1 erratum E7 — rerun/replacement lifecycle expressibility (PROPOSED; ratification with Drew after the narrow verify pass, E1–E6 precedent)

**Why:** REV's orchestrator verification (items 3–5, re-verified against
main) confirmed that shipped D1 names a recovery its own state machine
cannot journal: `crash-windows.ts` pins `kill_pgid_rerun_block` while
`applySampleEvent` offers no post-`run_allocated` continuation; the seal
predicate cannot see replacement/rerun instances; the vocabulary cannot
carry quarantine, block-scoped replacement reasons, or role-tagged grants.
E7 closes the holes precisely and together — drafted to be ratifiable with
zero underdetermined choices for an implementer against
`state-machine.ts`/`crash-windows.ts`/`journal-events.ts`/`campaign.ts`
(REV-2 P-1). Until ratified, the D3 writer rejects everything beyond the D1
20-event vocabulary, and task 1's dependent tests are gated on
ratification.

**Design shift (REV-2 P-1):** revision 2's single rerun edge could not
express instrument replacement (fresh successor samples had no membership
carrier — routing fan-out was universe-only), rejected canonical
partial-block aborts (shipped `aborted` REJECTs from `completed`,
`state-machine.ts:131-135`, while D1's own retained-evidence design makes a
completed-sibling partial abort canonical), and left a seal race in the
mint→admit window. E7 is therefore rebuilt around **instance-scoped state**:
successor membership rides the events, block-scoped fan-out is
terminal-tolerant, and the seal obligation begins at mint.

**E7.0 — Frozen primary/reserve slot representation (CampaignSchema
additive amendment).** Reserve blocks are pre-registered, count-hard, and
priced (parent Execution: "Registration fixes primary + reserve block
counts … exactly — that is the enforceable cap"), so they live in the
frozen grid: `BlockSchema` gains optional `slot?: 'primary' | 'reserve'`
(default `'primary'`; old documents parse unchanged); registration mints
`reserve:` blocks per cell as frozen blocks with their own frozen samples
(ID grammar, Registration determinism: reserve block `<cell-key>:x<k>`, its
samples `<cell-key>:<arm>:x<k>`). The shipped every-sample-in-exactly-one-
block refinement is unchanged. Replacement then **activates a frozen reserve
block by id** — no out-of-band minting for the replacement path.

**E7.1 — Lifecycle core: membership carrier, fan-out, re-entry edges.**

- **Membership carrier = `block_replaced` (rides the mint event, so the seal
  obligation and the roster exist at the same instant).** Payload:
  `{ block_id, replacement_block_id, reason: BlockReplacementReason, kind:
  'replacement' | 'rerun', reserve_activation: boolean, roster: [{
  sample_id, arm, supersedes?: sample_id }] }`. Replay's block→samples map
  is **universe blocks ∪ rerun-instance rosters** — membership derives from
  events, never from out-of-band state. `block_replaced` itself updates only
  the instance-chain and roster projections (Decision D-7); it is **never
  fanned through `applySampleEvent`**. Both revision-3 verify seats ratified
  roster-on-mint (Round-4 S-13); later admission is not a membership carrier.
  - `kind: 'replacement'`: `replacement_block_id` names an **unactivated
    frozen reserve block of the same cell**; roster entries are that
    reserve block's samples, each with `supersedes` naming the predecessor
    sample it replaces (**same-arm required** — a cell holds one sample per
    arm, so the pairing is total); `reserve_activation: true`.
  - `kind: 'rerun'`: `replacement_block_id` is a fresh instance id
    (`<lineage-root-block-id>:i<seq>`; the root is the first non-rerun block
    in this rerun-only lineage and seq increments across that root, so
    `B:i1` reruns as `B:i2`); roster = the immediate predecessor's
    `sample_ids` (same samples — **reserve- and count-neutral**), no
    `supersedes`; `reserve_activation: false`.
- **Fan-out rule (transition-table change):** the block fan-out events
  (`block_admitted`, `aborted`, `skew_excluded`) use the named block's
  frozen-or-minted roster. `aborted` and `skew_excluded` return
  `ignore-late` from **every terminal state** — shipped `aborted` REJECTs
  from `completed`
  (`state-machine.ts:131-135`), which rejects the canonical partial-block
  abort (one arm completes, the dispatcher aborts the block). Fan-out
  routing runs over universe-plus-instance-chains (Decision D-7's routing
  table, amended).
- **Re-entry edge (rerun):** `block_admitted { …, rerun_of?: block_id }`
  (additive optional; absent → shipped planned→admitted semantics only)
  applies per roster sample of the rerun instance: from `aborted`,
  `completed`, **and** `instrument_failed` → `admitted` — the three states
  a live block's samples can hold at kill time (partial predecessors
  included: a completed arm re-enters; its retained run dir keeps its
  evidence reference); from `planned | admitted | spawned | exposed` →
  REJECT (the pinned kill→journal-`aborted` order was violated —
  corruption); from `skew_excluded | excluded_block_replaced | exhausted |
  budget_stopped` → REJECT (validity/shortfall terminals never re-enter;
  E7.6). `attempt_created` is unchanged (binds from `admitted`, which the
  re-entry edge restores).
- **Partial-predecessor entry (replacement):** the cause sample keeps its
  attempt-terminal (`instrument_failure` stands — it consumed the
  activation); **every other predecessor sample receives
  `sample_disposition excluded_block_replaced` with `superseded_by` naming
  its roster successor**. E7 adds `admitted` to the shipped legal sources,
  making the full source set `admitted | spawned | exposed | completed`:
  admission is block-atomic, but one sibling can fail after spawning while
  another is still admitted. A predecessor already `instrument_failed` or
  `skew_excluded` keeps that terminal fact instead of receiving a
  disposition.
- **Mint bundle and crash order (Round-4 S-2):** replacement/rerun minting
  holds one dispatch critical section. It (1) validates the complete roster
  and frozen cell/arm identities; (2) appends `block_replaced` **first**,
  making the successor and its seal obligation durable; then (3) in the
  serialized roster order appends exactly the required predecessor
  `sample_disposition` rows — one for each roster `supersedes` pair whose
  predecessor state immediately before the mint was `admitted | spawned |
  exposed | completed`. Rerun rosters have no `supersedes` pairs and emit no
  dispositions. Each event retains Decision D-7's per-event transaction;
  the critical section forbids admission, sealing, or another mint from
  interleaving. A crash may therefore leave the durable mint followed by
  only a prefix of its dispositions. Resume replays the pre-mint states and
  roster, appends exactly the missing dispositions idempotently in the same
  order, and does so before any admission or crash-window resolution.
- **A minted predecessor is superseded, never rerun:** once a valid
  `block_replaced` names `block_id` as predecessor, R-RCV-2/R-RCV-5 suppress
  both resolver actions (`void_attempt_readmit` and
  `kill_pgid_rerun_block`) for that predecessor. Recovery still kills any
  live journaled pgid under R-RCV-1, but it never mints a second successor
  or re-admits the predecessor; it completes the mint bundle above and then
  resolves the already-minted successor.
- **Seal obligation begins at mint and is successor-local:** a successor is
  a pending obligation from the `block_replaced.seq` — not from admission —
  and stays pending until its samples terminal or an explicit
  replacement-impossible resolution. The fold keys the obligation by
  `(replacement_block_id, sample_id, mint_seq)`. For a rerun successor that
  deliberately reuses predecessor sample ids, only a terminal witness
  **after its own mint** counts: either a terminal attempt whose
  `attempt_created.seq > mint_seq` and whose binding follows that
  successor's `block_admitted`, or a post-mint block-terminal event naming
  that successor. Predecessor-era terminal attempts and block facts never
  satisfy it. A minted-but-unadmitted rerun therefore has zero witnesses and
  refuses seal; admission adds no new obligation and merely enables the
  post-mint witnesses that discharge the existing one.
  **Zero-witness budget-suppressed carrier:** when a replacement cannot
  activate (budget stopped), dispatch journals `adjudication { cell,
  disposition: 'replacement_suppressed', rationale: 'budget_stopped' }` —
  the pinned machine disposition convention on the existing event, no
  vocabulary change (accounting-class routing; the same carrier serves
  `rationale: 'reserve_exhausted'` when no unactivated reserve block
  remains). These cell resolutions are mutually exclusive for one
  obligation: inside the same critical section, an already-durable budget
  stop wins as `replacement_suppressed`; otherwise an empty reserve wins as
  `reserve_exhausted`. Once either adjudication lands, a later budget or
  reserve observation cannot add the other.

**E7.2 — Reason set (widened `block_replaced`).**
`BlockReplacementReason = InstrumentCause | 'dispatcher_restart' |
'snapshot_drift' | 'storage_failure' | 'skew_refill' | 'exposure_audit'` —
the closed block-scoped set, completed by the validity-replacement reasons
this spec itself requires: runtime skew refill from reserve (R-DSP-9) and
exposure-audit invalidation (Decision D-9), both `kind: 'replacement'`.
Additions remain platform PRs. **Legacy round-trip rule:** shipped rows
(`cause ∈ z.enum(INSTRUMENT_CAUSES)`) parse as `{ reason: cause, kind:
'replacement' }`; absent `roster`/`reserve_activation` replay with
`reserve_activation: kind === 'replacement'` and `supersedes` derived by
same-arm pairing (total — one sample per arm per cell). New rows carry the
full shape; the round-trip is a pinned test.

**E7.3 — Seal-predicate completeness over instances.**
`sealPredicateHolds` (`crash-windows.ts`) is rewritten over the
instance-aware fold (`blockSamples` = universe ∪ rerun rosters; a block is
**activated** iff named `replacement_block_id` by some `block_replaced`).
Holds iff: (1) every **frozen primary sample and every activated frozen
reserve sample** is accounted — its current-attempt chain terminal, a
sample/block terminal fact, `excluded_block_replaced` whose `superseded_by`
chain resolves (invariant-checked, below) to an included terminal sample, or
covered by a `replacement_suppressed`/`reserve_exhausted` adjudication for
its cell (shortfall accounting, named at seal); (2) every **activated
successor** — reserve block or rerun instance, from its mint regardless of
admission state — has all samples discharged by the successor-local,
post-mint witnesses defined in E7.1 (a same-id predecessor terminal never
counts; a minted non-terminal successor refuses seal); (3) every
`instrument_failure` is followed before seal by its `block_replaced`, a
`replacement_suppressed` adjudication, or the sole reserve-exhaustion carrier
`adjudication { disposition: 'reserve_exhausted' }` for its cell — else seal
refuses; (4) **unactivated reserve blocks impose no obligation** (reserve is
capacity, not a promise — distinguished from required samples by E7.0's
`slot` field); (5) `budget_stopped` samples count terminal-shortfall forever
(E7.6). Throughout, **"included terminal sample" is the derived property** —
a completed, non-superseded, successor-local (post-mint where a mint
applies) terminal — never a required `sample_disposition { included }`
event: R-JRN-3 restricts the sealer's writes to exactly `adjudication` +
`sealed`, so the `included` disposition remains D4's optional seal-time
record. For a superseded sample, E7.3a's chain check is the binding arm of
clause 1. The `CampaignUniverse` input keeps the frozen document shape
(including E7.0's reserve blocks).

**E7.3a — `superseded_by` invariants (enforcement phase pinned).** The
roster is the canonical supersession graph: a
`sample_disposition.superseded_by` pair must match exactly one
`roster { sample_id: successor, supersedes: predecessor }` pair, and every
roster pair whose predecessor's pre-mint state was `admitted | spawned |
exposed | completed` must gain exactly that disposition (E7.1's resume
completion rule). During replay, violation of the graph-structural rules —
predecessor uniqueness, successor one-to-one, acyclicity, or a disposition
pair absent from the roster — is corruption. Replay also validates
same-cell and same-arm preservation against the frozen `Campaign` (those
facts are not derivable from journal content alone). **Termination is a
seal-time check, not replay corruption:** live successors legitimately
dangle; at seal every chain must end at an `included` successor-local
terminal or a typed cell resolution (`replacement_suppressed` or
`reserve_exhausted`), never dangling. A sample-level `budget_stopped`
terminal is accounted separately by E7.3 clause 5; it is not a
cell-resolution value.

**E7.4 — Quarantine carrier (21st event, binding-only, E5 pattern).**
`quarantined { run_id: string, attempt_id?: string, reason:
'attempt_mismatch' | 'late_terminal' | 'campaign_mismatch' }` — strict
payload, no state-machine edges (binding-only like `attempt_created`;
routed to the `quarantine` projection only). This gives R-RCV-3's
journal-classification a real carrier (vocabulary check confirmed none
exists) and recovery a durable mismatch record keyed by the persisted
campaign-identity file (Decision D-8).

**E7.5 — Role-tagged key grants (tightened, REV-2 sol I8).**
`run_allocated` gains `key_grants: [{ role: 'subject' | 'grader', env:
EnvVarNameSchema }]` (names only, never values) through a total two-arm
schema union:

- **Legacy parse-only arm:** `key_grants` absent; `key_env` may be present
  or both fields may be absent, exactly as the shipped optional
  `journal-events.ts` field allows. D3 never emits this arm after E7.
- **New emission arm:** `key_grants` is required (array length 0–2) and
  `key_env` is forbidden. At most one entry per role; the same env name may
  appear once for each role when both deliberately share a credential.

**Per-role presence derives from D1 Decision D-1:** include exactly one
`subject` entry iff the subject credential supplied an API-key env grant to
this child, and exactly one `grader` entry iff the grader credential supplied
one. For a `key_pool`, this is the selected pool member; for a singular
API-key credential, it is the resolved env name. A non-API-key credential
contributes no entry. An API-key role with no selected/resolved grant fails
spawn loudly before `run_allocated`, per D1's resolution rule; omission is
not a fallback. Thus the required new array is empty, subject-only,
grader-only, or both-role — no fifth case. Readers prefer `key_grants` and
fall back to legacy `key_env` as the subject grant.

**E7.6 — Pin, no vocabulary change: a budget raise never resurrects
`budget_stopped` samples.** It only prevents future stops. No edge exists,
none is added; pinned here with an explicit test (raise after stop; stopped
samples stay stopped; later blocks admit against the raised ceiling).

**E7.7 — `budget_event` netting semantics (pin, no vocabulary change;
deterministic rule, REV-2 sol I8):** the **absolute-total rule** — an
`estimate_inflight` event's `amount_usd` is the **total estimated exposure
of the current budget-exposure set at that instant** (admitted samples that
have not reached service end or identity-verified kill/release;
state-replacing: each supersedes every earlier `estimate_inflight`); a
`spend` event's
amount is the increment for one terminaled run; the live budget position is
`Σ spend + latest estimate_inflight (0 if none)`. Deterministic over the
event stream with the shipped payload; no additive field. Per-sample spend
attribution still derives at seal from run-dir evidence
(`coding-agent-token-usage.json` per run), not the journal. R-JRN-12's
wording is reconciled to this rule (the materialized `spend` table computes
the position; no identity netting). **Round-4 atomicity pin:** whenever
actual spend lands or the budget-exposure set changes, the dispatcher
recomputes the absolute remainder and appends its superseding
`estimate_inflight` snapshot last in that same critical section. Admission,
service-end release, verified abort/kill, and terminal spend are covered;
retained-evidence analytical terminals remain in the set until service end.
A crash between the paired events cannot admit work: recovery writes the
reconciled snapshot before it evaluates the budget. Example: prior
`estimate_inflight=10`, then a terminal run with `spend=9` and no remaining
work journals `spend=9` followed in the same critical section by
`estimate_inflight=0`; the next admissible position is 9, never 19.

**Transition-table change summary:** re-entry edges from `aborted |
completed | instrument_failed` via `block_admitted{rerun_of}` (E7.1);
`sample_disposition excluded_block_replaced` gains the `admitted` source;
block-scoped fan-out (`aborted`, `skew_excluded`) `ignore-late` from every
terminal (E7.1); `block_replaced` gets **no** sample transition and routes
only to instance-chain/roster projection; campaign machine untouched; late
policy extended — `quarantined` is never `reject` (binding-only), everything
else unchanged.
**Event count:** 21 (20 + `quarantined`).

### Findings (PRI-2874)

- **D1 seam-map defect — the contention guard is assigned to no module.**
  Surfaced in revision 1 (GATE §"OQ-11"); unchanged. D3 absorbs the work via
  Decision D-3; the seam-map correction is a D1-doc note for PRI-2874.
- **`beginSealing` ownership note (REV D4-writer bundle):** the shipped
  `state-machine.ts` comment names "the D3 sealer" while the D1 seam map
  assigns sealing to D4's report engine. Revision 2 pins the sealer as a
  D4 writer over D3's writer API (R-JRN-3); the comment reconciliation rides
  the same PRI-2874 seam-map erratum note.
- **D1 rerun-lifecycle gap:** revision 1's open item ("aborted → re-plan
  reading — confirm no D1 erratum is needed") is **closed by evidence**: the
  gap is real and requires one — E7 above.

### Open items

- **Contention disposition vocabulary (D4).** `adjudication` renders the
  invalidation, but the disposition vocabulary has no contention or
  unknown-coverage term; D4's sealing/report vocabulary work owns the
  addition (Decision D-5).
- **Marker vocabulary is initial** (Decision D-10): seeded from the one live
  detection plus declared families; qualification is the live receipt;
  unmatched throttle evidence renders as caveats (the <5% bar sees the
  misses).
- **Source-(1) exposure marks:** no harness emits a first-generation mark
  today; Decision D-9 trims the fixtures to the precedence hook; whether any
  harness already emits one is a qualification-time verification (source
  ambiguity noted rather than invented around).
- **Threshold/sampler defaults** (Decisions D-3/D-4): cadence 10s, sustain
  K=3, coverage N=4, and the fingerprint-derived threshold defaults and
  surcharge constants are D3-drafted numbers the parent does not pin; they
  are registered, digest-frozen, and the spec-review gate and qualification
  own challenging them.
- **Host-wide lock production path:** `$QUORUM_LIVE_SPEND_LOCK` is
  authoritative; D3 ships the user-wide default; production deployments set
  the env to the appliance-owned shared path, and updating
  `docs/appliance-runbook.md` to match is an implementation obligation
  (REV sol #22/M13; R-LCK-2).
- **Minimum child-contract evals SHA:** pinned here as D2's implementation
  merge (`f230698`); task 1 hardens it into a named constant with the
  merge-base test.
- **Asserted-not-proven debt (REV-2 sol audit):** four mechanism claims
  rest on drafting-session observation, not checked-in evidence —
  GC-finalizer lock release, kill-9 WAL re-acquire, grandchild group
  membership, `O_CLOEXEC` child FD non-inheritance. Each is owed a checked-in
  test (portable hermetic where possible; the FD assertion rides the
  Linux-gated integration matrix). If the FD assertion fails, the fallback
  is explicit close-on-spawn in the spawner seam — named, not built
  speculatively. **Ballast ENOSPC behavior** joins the same debt class:
  the non-sparse write/fsync contract is portable, but release sufficiency,
  inode behavior, and SQLite WAL amplification are proven only by the
  Linux-gated matrix (no quota-bearing tmpfs exists on the Darwin dev host).
  **Round-4 process birth identity**
  also joins: the `ProcessIdentityProbe` contract and fake cases are pinned,
  but the production OS start-time reader and recycled-pid behavior are not
  shipped or proven until the Linux matrix lands; an unreadable value must
  remain identity-unknown and refuse.
- **Anthropic `overloaded_error` (HTTP 529):** capacity, not quota — row 2
  of the marker table matches `rate_limit_error` only; whether overloaded
  responses should trip cooldowns is a qualification-time extension with its
  own fixture, not a silent widen.
- **OQ-12 (estimate-keying ratification)** is closed by the E1/E2
  ratification — it was a ratification step, never an open design choice.

## Task decomposition

Rebuilt to the review record's converged nine-task order (REV sol #17 ≡
fable I-7; fable I-7's split honored — materializer call-site wiring stays
early in task 4, the halt/kill/replacement mapping lands with the dispatcher
in task 8). Requirements in parentheses.

1. **E7 + contract additions + typed seams.** Land the E7 contract bundle as
   proposed (journal-events payloads incl. `quarantined`, the widened
   `block_replaced` shape + dedicated non-reducer route, the re-entry and
   admitted-disposition edges + terminal-tolerant fan-out, ordered mint
   bundle, instance-aware successor-local crash-windows fold + seal
   predicate, the four pinned
   `InstrumentCause` additions — vocabulary before task 7 builds the
   classifier), E7.0's `BlockSchema.slot` representation, the additive
   campaign contention/execution-surface fields, and the typed seams
   (spawner, host-stats probe, uniform Clock naming). Dependent tests gated
   on E7 ratification. (E7; REV Blocker A; REV-2 P-1)
2. **Locks + host probe.** Journal writer election = lock-dir lease beside
   `journal.db` + in-transaction `writer_generation` fencing (verified);
   host-wide live-spend lock on the D2 lock-dir protocol with heartbeat +
   ESRCH-only/OS-start-time dead-holder identity (never mtime-only or generic
   kill-failure-as-dead), injectable `ProcessIdentityProbe` shared by cancel;
   resource-floor preflight + fingerprint match + key-env check; stale
   reclamation without unlink races; children-never-acquire discipline;
   recovery-ordering contract. Two-process contention tests incl. the
   deposed-writer fencing test. (R-LCK-1..3; Decisions D-3/D-4 obligations;
   REV-2 P-2/P-3)
3. **Journal + marker-file publication.** Store, one-transaction append (fencing
   check first), projection tables incl. quarantine + spawn-gap + instance
   columns/rosters, routed three-valued replay over universe-plus-instance
   membership with `block_replaced` projection-only, ordered read API with
   cursor exclusivity, `schema_version`, absolute-total snapshot critical
   sections, emitters contract, and the P-4/S-8 publication order (snapshot
   at final path → journal init → fsynced ballast → `campaign.json` staged +
   renamed LAST, directory fsync) plus incomplete-dir repair/classification.
   Replay-determinism + crash-window-prefix + routing tests.
   (R-JRN-1..12; Decisions D-2, D-7; REV-2 P-4)
4. **Snapshot integration/reconstruction + refs cross-check.** Call the D2
   materializers with campaign-dir destinations; `reconstructSnapshot` +
   `Campaign.refs` cross-check; `verifySnapshot` cadence call sites
   (per-wave, block-terminal, pre-seal); authorized repair operation;
   drift → affected-set mapping plumbed for task 8. (R-DSP-11, R-DSP-12,
   R-RCV-6; Decision D-11)
5. **Registration from the snapshot.** Snapshot-first intake; child-contract
   probe; grid expansion + delimiter-safe ID/lineage determinism bundle;
   rejection matrix; ref→SHA
   resolution; capability rejection; pricing (E1/E2 keying, grader-match
   restriction, versioned surcharge); profile-parameter/MDE validation;
   digest; final-path incomplete-dir handling + campaign.json-last
   publication; `campaign_opened`; contention declarations
   (fingerprint, G, thresholds, frozen sampler parameters); ratification
   records; confirmation + collision handling. Golden campaigns +
   digest-stability + rejection-matrix tests. (R-REG-1..22; REV Blocker C)
6. **Spawn/identity/grants.** Detached process-group-leader spawn over the
   spawner seam (verified mechanism); pgid==pid validation; campaign-
   identity intake (argv → `RunScenarioArgs` → run-dir-allocation
   persistence → verdict/error/stopped stamping); `KeySelector` + fail-loud
   resolution + D-2 loud warnings; E7's legacy/new `run_allocated` union and
   exact 0–2-entry per-role `key_grants` presence matrix; snapshot-
   entrypoint child argv; explicit superpowers/gauntletBin threading;
   children-never-acquire marking. (R-SPN-1..9; REV Blocker C identity
   intake)
7. **Sensors + contention + classifier.** Exact shipped Antigravity matcher
   plus anchored structured rows 2–5 and their distinct false-positive
   fixtures; `ExposureProbe` per harness + decision
   point at block terminal + fail-closed absence; sampler + sidecar +
   coverage predicate + frozen cadence/sustain + dead-sampler liveness +
   breach edge semantics; exhaustive `ClassificationInput` table.
   (R-SNS-1..5, R-CLS-1..6; Decisions D-3, D-9, D-10)
8. **Dispatcher.** Atomic per-block admission with per-sample global cap and
   service-end release; max-sample priority ordering + backfill; cooldowns;
   replacement + **halt/kill/replacement mapping incl. E7 ordered mint
   bundle, superseded-predecessor rule, successor-local rerun entry, and
   sole reserve-exhaustion adjudication** (fable I-7 split); budget
   enforcement + atomic absolute snapshots + never-resurrects +
   post-budget-stop `replacement_suppressed` shortfall; spawn-failure pool
   halt; drift/breach/liveness
   halts wired to task 4's mapping; cancellation signal handling; state
   banner. Adversarial-arrival + accounting tests. (R-DSP-1..13)
9. **Recovery + cancellation + CLI threading + D4 handoff.**
   Identity-guarded pgid kill; journal↔run-dir reconciliation incl.
   terminal-evidence rule; partial-mint disposition completion;
   superseded-predecessor resolver override; E7 successor-local rerun
   re-entry; quarantine via `quarantined`; crash-window execution; refs
   cross-check on resume; ENOSPC ballast-release/fail-stop reconciliation;
   cancel protocol both paths in the pinned order;
   `campaign register | run | cancel` verbs;
   `run-all` + direct-`run` live-spend-lock threading; sealer-writer API +
   D4 handoff surfaces. Kill-mid-block + no-double-spend + cancel-refuse-
   resume tests. (R-RCV-1..7; Decisions D-12, D-13)

**Cross-cutting obligations, explicit:**

- E7 ratification gates task 1's dependent tests; tasks 6/8/9 consume its
  payloads — none of them journals a pre-ratification event beyond the D1
  20.
- Decision D-1 (global cap + service-end release) binds tasks 5 and 8
  jointly — registration freezes G, dispatcher enforces it with the release
  tests.
- Decision D-2 (wait accounting) binds task 6's journaling and task 3's
  materialized stat; both use the "spawn-gap" label.
- Decision D-3 splits across tasks 2 (preflight), 5 (declarations), and
  7 (sampler/sidecar/breach/coverage/liveness) — task 7 is lead; the
  host-stats probe built in task 2 is the shared seam all three consume.
- The lock threading into `run-all` and direct `quorum run` ships with
  task 9's CLI threading (it is meaningless before task 8 exists to hold
  it).

## Exit criteria

- The full portable hermetic matrix passes; `bun run check` and `bun run
  quorum check` green on the merge commit; the Linux-gated integration
  matrix passes on the designated host (separately recorded, trusted-
  maintainer).
- **Three separate live campaigns** (REV sol #18 — the single combined
  lifecycle is impossible), each trusted-maintainer, per the parent's
  safe-checks doctrine, nothing to public CI:
  1. **Completion:** a registered small gating suite runs registration →
     dispatch → all-samples-terminal → seal predicate holds (D4's report
     act follows on its own deliverable).
  2. **Crash-resume:** kill mid-block; `campaign run` resumes —
     identity-guarded pgid-kill-before-rerun evidenced, any landed mint is
     reused rather than duplicated, same-id successor witnesses are
     post-mint, refs cross-check passes, no double spend, replay converges on
     the same materialized state.
  3. **Cancel-and-refuse-resume:** `campaign cancel` completes the pinned
     order (marker → stop → kill+verify → complete any partial mint bundle →
     `aborted` → `campaign_cancelled` last); a subsequent `campaign run`
     refuses to resume, citing the cancel-request.
- E7, the ENOSPC fail-stop override (Decision D-13), and the additive
  D1-schema amendments (the contract-additions list) are ratified with Drew
  after the narrow verify pass (or the dependent tests stay gated).
- D4 is handed, unblocked: the journal read API + instance-aware
  materialized tables, the sealer-writer API, the contention sidecar +
  coverage predicate + frozen sampler parameters, the pre-seal
  `verifySnapshot` call site with refuse-to-seal handling, the typed-
  failure accounting inputs, and the budget/amendment trail with the
  never-resurrects pin (Interfaces handed to D4).
