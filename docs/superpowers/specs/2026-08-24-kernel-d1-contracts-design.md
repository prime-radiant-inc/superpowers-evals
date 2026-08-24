# Kernel Deliverable 1 — Campaign Platform Contracts: Design

**Date:** 2026-08-24 (revision 2, post three-seat review)
**Status:** proposed
**Parent spec:** `docs/superpowers/specs/2026-08-17-quorum-campaign-platform-design.md`
  (the campaign platform design; "the parent" below)
**Prerequisite:** Phase 0 capacity simulation (merged `f93e95b`;
  `docs/experiments/2026-08-24-phase0-capacity-simulation.md`)
**Review record:** `docs/experiments/2026-08-24-kernel-d1-spec-review.md`
**Program ticket:** PRI-2874 umbrella (kernel build, order-of-operations item 3)

## Purpose and place in the program

The parent's order of operations item 3 (kernel build, ~5–7 weeks) names
four deliverables in fixed order: **contracts → provisioning + instrument
snapshot → dispatcher + journal + locks → profiles + report engine**. This
document is the implementation-level spec of deliverable 1: every contract
of Appendix B as zod schemas and pure functions, TDD-able, with no storage,
dispatch, or reporting logic.

The parent already pins the contracts (Appendix B is field lists, state
machines, and the digest definition "an implementer can TDD against").
This spec therefore adds exactly these things the parent does not contain:

1. **The grader-pool credential shape decision** (Decision D-1) — forced
   by Phase 0, which proved a single-key grader pool defeats the 8h gate
   and promoted grader de-SPOF (PRI-2524) to gate-blocker. Proposed parent
   erratum E4.
2. **The kernel-wide seam map** — the module/interface decomposition of
   all four deliverables, written here so boundaries are designed and
   test-enforced before D2–D4 start, not discovered mid-build. (Review
   feedback, Jesse, 2026-08-24: the D3 scope as previously presented read
   as a monolith; the seam map is the correction.)
3. **Pins the parent left open**, each marked **(pinned here)**: the JCS
   digest implementation contract (SHA-256 + RFC 8785 semantics), the
   journal envelope and event→edge mappings, the tripwire v1 firing
   criterion and the pre-registered MDE parameters ("deltas"), the
   late-event policy of the state machines, the `campaign_cancelled`
   event (proposed parent erratum E5), the exposure-measurement source
   contract, and the `run_allocated` journaling order.
4. **The validation strategy** binding every contract to a test class.

Everything else is faithful transcription of the parent's pinned text into
implementation contracts, including the parent-pinned `run_allocated`
mechanism (child-protocol emission at the `onRunDir` seam — see Decision
D-3). Where this spec deviates from parent text it says so and proposes
an erratum (Errata section).

## Inputs that shape this design

- **Phase 0 headline:** 18/36 simulated dispatch configurations clear the
  8h gate, all of them with the grader pool at cap ≥15; at a single-key
  grader cap every configuration pins at ~16h with 7.6h of attributed
  grader wait. One Anthropic key cannot express 15 concurrent grader
  drives. The grader credential shape must therefore support a pool of
  keys **without** changing the campaign identity chain, which the parent
  pins as singular (`grader: {credential, model}`).
- **Jesse's boundary feedback (2026-08-24):** the kernel presentation did
  not exhibit loosely coupled pieces with clean boundaries. Verified
  assessment: D3's scope was presented as nine concerns with no internal
  seams (fair); the parent spec itself is boundary-driven — thin
  dispatcher over shared execution primitives, journal contract over
  storage, read-only report engine, `command-runner` and injectable-clock
  seams (cited in the seam map). The seam map makes those boundaries
  explicit and testable.
- **Repo idiom:** injectable seams are the established pattern
  (`src/scheduler/clock.ts` `FakeClock` for the legacy scheduler,
  `src/agents/command-runner.ts` for subprocess projection, the
  `QUORUM_RECORD_SINK` env sink in `src/check/record.ts`). Phase 0's
  simulator is a related-but-distinct idiom: a pure synchronous
  discrete-event engine over internal virtual time (no clock injection).
  D1's pure functions (digest, transition tables, crash-window
  resolvers) follow the latter: direct-test pure code, no mocks.

## Scope

In scope, all TDD:

1. zod schemas for every Appendix B document: Arm, Suite, Campaign
   (`campaign.json`), Report (`report.json`).
2. The JCS digest canonical form as a pure function with an
   implementation contract (Digest canonical form section) and golden
   vectors.
3. The journal **event vocabulary** as schemas (envelope + 20 event
   types — the parent's 19 plus `campaign_cancelled`, pinned here,
   proposed erratum E5) and both **state machines** as transition tables
   with pure validators. No storage: the SQLite journal (including its
   `schema_version` row), flock writer, and recovery executor are D3.
4. The `campaign:` extension on `FinalVerdictSchema`; the CheckRecord
   extensions (`score`, `metrics`, `tags`, `notes`) with the write-side
   unknown-key fold rule.
5. `CredentialSchema` amendments: `quota_pool` (parent-pinned) and
   `key_pool` (Decision D-1, proposed erratum E4).
6. Scenario frontmatter: `requires_superpowers`, `coupling` — schema,
   static-scan defaults, override rules.
7. The v1 pool-derivation function `poolKey`, the key-selector type, and
   the typed-failure codomain + initial instrument-cause vocabulary.
8. Profile **parameter schemas** + a registry, so `quorum check`
   validates suite files "including profile parameters" (parent Testing).
   Profile evaluation logic is D4.
9. `quorum check` validation for arm and suite files, with discovery
   conventions pinned below.
10. The `run_allocated` emission at the parent-pinned `onRunDir` seam.

## Non-goals

- No SQLite journal store, writer, or recovery executor (D3).
- No dispatcher, admission, cooldown, replacement, or budget enforcement
  logic (D3).
- No provisioning adapters, worktree materialization, or instrument
  snapshot (D2).
- No profile evaluation, sealing predicate, or report rendering (D4).
  D1 ships the Report schema and rendering-rule constants, not the
  renderer.
- No change to `run-all`, `run`, the dashboard, or the legacy
  `limiterKey` scheduler path. The legacy scheduler keeps keying its
  concurrency cap on `limiterKey`; campaigns key on `poolKey`. Two
  derivations coexist by design until `run-all` retirement is decided
  (parent: coexistence and sequencing).
- No credential migration. Existing `credentials.yaml` entries parse
  unchanged; `quota_pool` and `key_pool` are optional additions.
- No container pgid translation: v1 gating campaigns spawn host-direct
  on the designated host (parent Execution). The appliance's two-tier
  `host_pgid`/`container_pgid` model (`src/appliance/types.ts`) is the
  recorded restart point if campaign runs ever spawn containerized.

## Decision D-1: grader-pool credential shape

**Decision:** multi-key credential. `CredentialSchema` gains optional
`key_pool`: a non-empty array of env-var names (same regex as
`api_key_env`: `^[A-Za-z_][A-Za-z0-9_]*$`), subject to:

- mutually exclusive with `api_key_env` (at most one of the two);
- only valid with `auth: api-key` (subscription, oauth, and
  bedrock-bearer credentials have no key material to pool —
  validation error);
- `max_concurrency` on such a credential is the **pool-level** cap.

This is a second credential amendment beyond the parent's pinned one
(`quota_pool`); it is proposed as **parent erratum E4** for ratification
on PRI-2874.

At spawn time one key env is selected from the pool per child; the
selected key is injected through the existing per-child credential
projection (F13 machinery; the explicit minimal env projection seam in
`src/agents/command-runner.ts`). The dispatcher never sees individual
keys.

**Alternatives rejected:**

- *N separate grader credentials + campaign-level pool:* forces the
  digest-frozen `grader: {credential, model}` to become a set — a
  parent-text deviation requiring an erratum (like estimates keying
  E1/E2), churns grader provenance readback, and pushes key-choice into
  the dispatcher's admission path. Rejected: it moves a spawn-time
  concern up into identity.
- *Defer; ship singular, bump schema version later:* Phase 0 already
  proved the singular shape insufficient for the gate criterion.
  Building registration and digest around a known-insufficient shape
  purchases certain rework. Rejected.

**Why the multi-key shape is the clean boundary:**

- Campaign identity, digest, admission, and grader provenance stay
  singular — the grader fields of the Campaign and Report schemas are
  transcribed unchanged.
- Admission accounts one pool (cap ≥15, the Phase 0 requirement); key
  selection lives strictly below it, at spawn, where F13 already injects
  per-child credential env. The dispatcher's view of the grader is
  unchanged.
- Model ⇔ credential coupling (parent §"Known coupling") is intact: one
  credential entry, one model field, one pricing authority. All pooled
  keys are the same model/endpoint **by operator discipline** — the
  schema cannot verify which account an env var holds (the same
  discipline `api_key_env` already relies on); the registered-vs-observed
  grader identity readback at seal is the guard.

**New invariant introduced (documented, not enforced in D1):** the
pool-level cap must not exceed the sum of per-key sustainable
concurrency. This is operator calibration, exactly the work PRI-2524
owns (key acquisition or calibrated Bedrock grader); the qualification
campaign measures whether the calibration holds.

**Registration-time warning (pinned here as a D3 requirement):**
registration renders a warning — not a rejection, since per-key capacity
is not knowable from config — when a `key_pool` credential's
`max_concurrency` exceeds `key_pool.length × 5` (the single-key cap 5
Phase 0 modeled as the current effective grader concurrency).
Registration is D3; D1 pins the requirement.

**Key selection is pinned as a contract, implemented in D3:**

```ts
export interface KeyGrant { envName: string; }
export type KeySelector = (
  cred: Credential,                       // must carry key_pool
  inFlight: Record<string, number>,       // env var name -> running children
) => { kind: 'use'; grant: KeyGrant } | { kind: 'wait' };
```

Policy contract: least-loaded key; `wait` when every key's in-flight
count is at or above the per-key share
(`ceil(max_concurrency / key_pool.length)`). **Authority relationship
(pinned):** the pool-level admission cap is authoritative; since
`len × ceil(cap/len) ≥ cap`, the `wait` branch is unreachable under
honest admission and exists as a guard for miscalibration and recovery
rebuild. D3 supplies the implementation.

**Resolution fail-loud requirement (pinned here as a D3 requirement):**
`resolveApiKeyEnvName` (`src/credentials/resolve.ts`) currently falls
back to the harness-conventional env when `api_key_env` is absent — for
a `key_pool` credential that would silently resolve the single key the
pool replaces. Credential resolution **must fail loud** for `key_pool`
credentials lacking a selected grant; the conventional-env fallback is
forbidden for them.

## Decision D-2: contracts live in `src/contracts/campaign/`

`src/contracts/` is the established home of zod schemas (11 files
including Phase 0's campaign-domain contracts: `src/contracts/replay.ts`
and `src/contracts/estimates.ts` — the actual Phase 0 precedent). D1's
contract family is large enough (~12 files) that a `campaign/`
subdirectory keeps it cohesive and its boundaries visible without
splitting the schema home. Cross-cutting schemas stay in their existing
homes and are amended there. Layout in "Artifact layout" below.

## Decision D-3: `run_allocated` rides the parent-pinned `onRunDir` seam

The parent (Identity) pins the mechanism: "the runner emits
`run_allocated: <run_id>` on its child protocol at run-dir allocation
(today it prints run-id only at exit; this is the one required runner
change, `src/cli/run-command.ts` / `src/runner/index.ts` `onRunDir`
seam)." The seam exists (`src/runner/index.ts:409,957-960`, firing
immediately after `allocateRunDir`). D1 transcribes this pin; the full
contract — including pgid ownership by the dispatcher, which the parent
leaves implicit — is in "The `run_allocated` contract" below.

## Decision D-4: `poolKey` golden fixtures are hermetic

The gate replay manifest's pool IDs were curated against the
**gate-era** credentials (`git show 64b99fc:credentials.yaml`, frozen
2026-08-07 per the Phase 0 plan) and never recomputed from today's
credentials. D1 therefore commits that credential snapshot as a fixture;
the golden test derives pool IDs from fixture credentials and asserts
they equal the **gate manifest's** pool IDs
(`src/campaign/replay-manifest.gate-20260808.json`). The copilot
extension manifest is excluded from this test: its curated pool IDs are
two-segment `base_url|model` and do not follow the v1 formula (a Phase 0
curation deviation, recorded, not papered over).

## Kernel-wide seam map

The module decomposition of all four deliverables. Columns: module —
deliverable — responsibility — consumes — produces — test strategy.
Interfaces named here are D1 contracts unless marked otherwise.

| Module | Del. | Responsibility | Consumes | Produces | Test strategy |
|---|---|---|---|---|---|
| `contracts` | D1 | Every document schema, digest, state machines, pool derivation, typed-failure codomain, profile parameter schemas | parent Appendix B (this spec) | all interfaces below | round-trips, golden vectors, transition tables |
| `provisioning` | D2 | One immutable worktree per distinct `superpowers:` SHA; `none` mode; per-child root injection through all adapters | Arm.superpowers refs, `command-runner` seam | per-child `SUPERPOWERS_ROOT`, provenance readback | black-box: `verdict.json .provenance.superpowers_rev` equals registered SHA (or absent for `none`), per adapter |
| `instrument-snapshot` | D2 | Campaign-local materialization of the registered evals SHA; drift detection vs registered digests | Campaign.refs.evals | frozen story/checks/prelude/configs/lockfile; drift → admission halt | digest drift fixtures |
| `registration` | D3 | Grid expansion (incl. `tier=` selector expansion), eligibility filters, pricing from estimates, digest, staging → atomic commit of `campaign.json` | suite/arm files, estimates artifact (`quorum.estimates/v1`), `credentials.yaml`, `poolKey` | `campaign.json` + `campaign_opened` | golden campaigns; digest stability; rejection matrix |
| `journal` | D3 | Event persistence (SQLite, including the `schema_version` row the parent's journal contract lists), single writer under campaign-dir flock, fsync per transition, rebuildable materialized tables | journal event vocabulary (D1) | ordered event read API | replay-determinism; crash-window prefixes |
| `dispatcher` | D3 | Atomic per-block admission (subject pools + grader pool + global cap), longest-expected-first ordering, 429 cooldowns, backfill, replacement rule, budget enforcement, cancellation | `campaign.json`, journal, estimates, `poolKey` | journal events | injectable clock + fake runner seam; adversarial arrivals |
| `spawn/key-select` | D3 | Child spawn as process-group leader (pinned below), with projected credential + selected key + per-child superpowers root; supplies campaign identity to the runner for verdict stamping **before the first provider token** (parent Identity); journals `run_allocated` | admission decisions, `KeySelector` (D1), `onRunDir` protocol emission | running children, journaled pgids | spawn fixtures; key-grant accounting |
| `sensors` | D3 | Provider-broad 429/rate-limit classification over subject CLIs and the gauntlet child; **owns the exposure measurement** — `analysis_exposure_started_at` per sample (contract below) | child stderr/result/event-stream artifacts | `pool_blocked` events, `exposure_started` inputs | fixture streams per provider marker; exposure-source fixtures |
| `failure-classifier` | D3 | Closed map `RunErrorStage` → typed codomain (D1 below); grader billing-exhaustion and grader 429 as typed instrument causes | `RunErrorStage` (existing, `src/contracts/verdict.ts`), sensor output | `instrument_failure` causes | table-driven over the full enum; unknown stays `indeterminate`, never replaced |
| `locks` | D3 | Campaign-dir flock; host-wide live-spend lock shared by `campaign run`, `run-all`, direct `run` | — | cross-process mutual exclusion | two-process contention tests |
| `recovery` | D3 | Crash restart: kill journaled pgids first, reconcile journal vs run dirs, rerun in-flight blocks whole, quarantine by attempt-id mismatch | journal, run dirs | reconciled state | kill-mid-block tests |
| `profiles` | D4 | `release_gate_v1`, `descriptive_v1` evaluation; tripwires; `investigate` minting | parameter schemas (D1), sealed campaign data | verdict inputs, MDE lines | golden oracles; independent Fisher cross-check |
| `report-engine` | D4 | Deterministic `report.md` then `report.json` (temp+fsync+rename) over journal + immutable run dirs; sealing predicate | Report schema (D1), journal, run dirs | sealed report | byte-stability golden reports |
| `status` | D4 | Mid-run surface; never renders outcome data pre-seal | journal | operator view | no-outcome-pre-seal tests |

Boundary settlements from the parent that this map enforces: the thin
dispatcher over shared execution primitives (two schedulers, one
execution primitive); the journal *contract* over its storage; the
read-only report engine; the recovery unit equals the validity unit
(blocks rerun whole). Essential coupling kept deliberately: atomic
admission across pools is one transactional invariant, and journal ↔
process-group lifecycle is one concern (pgid-kill-before-rerun,
no-double-spend) — neither decomposes further without breaking its
invariant.

## Contracts

Field lists are the parent's Appendix B, transcribed; where the parent is
skeletal or silent, this spec pins the exact shape and marks it
**(pinned here)**.

### Arm

```
{ schema_version: 1,
  name: string,                       // [a-z0-9_]+ (pinned here, matching
                                      // credential-name discipline)
  agent: string,                      // coding-agent name (claude, codex, …)
  credential: string,                 // credentials.yaml key
  superpowers: <full-sha> | <tag> | "none",
  os?: string,                        // validated against the os-target
                                      // vocabulary (src/contracts/os-target.ts,
                                      // os-targets/<name>.yaml, linux built in);
                                      // "windows" parses but is a registration
                                      // error (parent non-goal)
  labels?: Record<string, string> }   // (pinned here) free-form, reporting only
```

Registration resolves `superpowers` tags to full SHAs into
`Campaign.refs.superpowers_by_arm`, and **rejects `none`/ref arms for
agents whose adapter has not implemented the mode** (parent
Provisioning; D2 adapter capability registry — D1 pins the registry
seam, D2 fills it).

### Suite

```
{ schema_version: 1,
  name: string,
  kind: "gating" | "exploratory",
  budget_usd: number,                 // all-in soft ceiling: subject +
                                      // grader + reserves
  profile?: "release_gate_v1" | "descriptive_v1",
  profile_params?: <validated against the profile's parameter schema
                    (see Profile parameter schemas + registry)>,
  reserve?: number,                   // spare blocks per cell; optional in
                                      // BOTH kinds, default 0 (parent
                                      // Concepts)
  max_exposure_skew?: <duration s>,
  attempt_bounds?: { max_time_s?: number, max_attempts?: number },
                                      // defaults from scenario quorum_max_time
                                      // (src/story-meta.ts)
  declared_metrics?: [{ name, unit, aggregation }],
  comparisons: [<comparison>...] }

<comparison>:
{ baseline: <arm-ref>, treatment: <arm-ref>,          // two-arm
  | arm: <arm-ref>,                                    // single-arm
  scenarios: [string...] | "tier=sentinel" | "tier=full" | "tier=adhoc",
  n: int ≥ 1,
  cells?: { <scenario>: { n?: int,
                          class?: "confirmatory" | "probe" | "tripwire"
                                  | "descriptive",
                          tripwire_expect?: "pass" | "fail" } } }
```

**Scenario selector grammar (parent Concepts):** an explicit scenario
list or a `tier=<sentinel|full|adhoc>` token read by the existing
`readQuorumTier` machinery (`src/story-meta.ts`); no other selector
syntax in v1. The suite file carries either form; **registration expands
tier tokens to explicit lists** — the Campaign document always stores
the expanded form.

**Cell classes** are the closed 08-08 vocabulary (parent Concepts):
`confirmatory | probe | tripwire | descriptive`.

**Tripwire criterion (pinned here, parent gap):** the parent names two
v1 tripwire-family rules — "fired tripwire cells" and the completion-
collapse rule — and pins the latter's parameter but not the former's
criterion. Pinned: a tripwire cell in a gating suite declares
`tripwire_expect: "pass" | "fail"` (schema-required when
`class: tripwire`); it **fires** iff its determinate outcome diverges
from the expectation, and an unevaluable (indeterminate) outcome fires
it too — the fail-closed doctrine applied.

k-arm comparisons are out by parent non-goal: the schema structurally
admits exactly one or two arms. Gating suites require `profile:
release_gate_v1`, `reserve`, `max_exposure_skew`, and a registered
grader credential (parent Concepts: gating suites carry all three).
`reserve` is optional in both kinds (default 0); gating exhaustion is
the typed terminal `exhausted`, visible to the profile as reduced
determinate n (parent Execution).

### Campaign (`campaign.json`)

```
{ schema_version: 1,
  campaign_id: string,                // minted at registration; excluded
                                      // from digest
  suite: <embedded resolved Suite copy>,
  refs: { superpowers_by_arm: { <arm>: <full-sha>|null },
          evals: <full-sha>,
          gauntlet: <full-sha> },
  grader: { credential: string, model: string },
  cells: [{ scenario, comparison_id, arms, n, class, coupling,
            estimates_by_arm: { <arm>: { duration_s, cost_usd,
                                         confidence } } }],
  excluded_cells: [{ cell, reason }],
  samples: [{ sample_id, cell, arm, replicate }],
  comparisons: [{ comparison_id, baseline, treatment }   // two-arm
                | { comparison_id, arm }],               // single-arm
                                      // comparison_id: digest-scoped ordinal
                                      // minted at registration
  blocks: [{ block_id, comparison_id,
             sample_ids: [sample_id, ...] }],            // non-empty; one
                                      // entry per arm of the comparison
  pricing_overrides?: [{ arm, scenario?, per_token_usd, rationale }],
                                      // (pinned here) the operator-declared
                                      // per-token escape for unpriced gating
                                      // models — parent Concepts records it in
                                      // campaign.json; Appendix B's field list
                                      // omits it, so this reconciles the two
  budget: { usd_all_in: number, surcharge_applied: number,
            priced_coverage: number },
  registered_at: <iso8601>, registered_by: string,
  digest: string }
```

Block/sample cardinality invariants (parent Identity, transcribed): a
two-arm comparison's block holds two samples; a single-arm unit's block
holds one; every sample belongs to exactly one block. Enforced by schema
refinement.

### Digest canonical form

JCS-canonicalized (RFC 8785) JSON of the Campaign document **minus**:
`estimates_by_arm` (in every cell), `budget.surcharge_applied`,
`budget.priced_coverage`, `registered_at`, `registered_by`,
`campaign_id`, and `digest` itself (parent Appendix B, transcribed).
`budget.usd_all_in` (the registered figure) stays in. Digest algorithm:
SHA-256 over the JCS bytes, hex-encoded (pinned here; the parent defines
the canonical bytes and delegates the hash choice). The exclusion list
is the parent's own; estimates staying out is the re-derivability
settlement.

**Implementation contract (pinned here):** no JCS library exists in the
dependency set (obol, commander, yaml, zod) and the repo's culture is
minimal-deps, so D1 ships a hand-rolled `digest.ts` (~40 lines) with the
RFC 8785 semantics pinned: recursive key sort by UTF-16 code units at
every depth; ES6 number serialization (JS semantics already match JCS
for finite doubles); strings per ES6 quoting; **NaN/Infinity rejected**
(loud, at digest input validation). Golden vectors: the RFC 8785
Appendix test vectors committed as fixtures, plus campaign-level golden
vectors (Validation strategy section). Known failure mode this replaces:
`src/appliance/container.ts:979` hashes non-canonicalized
`JSON.stringify` — the digest must never do that.

### Journal event vocabulary

Envelope **(pinned here)**: every journaled row is
`{ seq: int (monotonic, single-writer), ts_ms: int, type: <event type>,
payload: <event-specific object> }`. Replay in `seq` order
deterministically reconstructs state; materialized tables are rebuildable
(parent Journal). The parent's journal contract also lists a
`schema_version` row — that is a storage-schema obligation of the D3
journal module, named in its seam row. Event types and payloads (parent
Appendix B, 19 events; the 20th is pinned here):

| Event | Payload |
|---|---|
| `campaign_opened` | `{ campaign_id, digest }` |
| `block_admitted` | `{ block_id, pools: [pool_key...] }` |
| `attempt_created` | `{ sample_id, attempt_id }` |
| `run_allocated` | `{ attempt_id, run_id, pgid, key_env? }` — `key_env` (name only, never value) pinned here so D3 key-grant accounting is reconstructable |
| `exposure_started` | `{ sample_id, ts }` — ts IS `analysis_exposure_started_at` (contract below) |
| `run_completed` | `{ attempt_id, outcome }` |
| `instrument_failure` | `{ attempt_id, cause }` (typed, see Typed failures) |
| `block_replaced` | `{ block_id, replacement_block_id, cause }` |
| `sample_disposition` | `{ sample_id, disposition, superseded_by? }` |
| `slot_exhausted` | `{ sample_id }` |
| `budget_stopped` | `{ sample_ids: [...] }` |
| `skew_excluded` | `{ block_id }` |
| `pool_blocked` | `{ pool_key, until_ts_ms }` |
| `budget_event` | `{ kind: "spend" \| "estimate_inflight", amount_usd }` (kinds pinned here) |
| `amendment` | `{ kind: "budget_raise", amount_usd, ts }` |
| `adjudication` | `{ cell, disposition, rationale }` |
| `aborted` | `{ block_id }` |
| `storage_paused` | `{}` |
| `campaign_cancelled` | `{ reason? }` — **(pinned here, proposed parent erratum E5)** the parent's campaign machine has a `cancelled` terminal but its Appendix B vocabulary contains no event driving it; replay determinism requires one |
| `sealed` | `{ report_digest }` |

### State machines

Block/attempt:

```
planned → admitted → spawned → exposed → terminal
terminal ∈ { completed, instrument_failed, aborted, skew_excluded,
             excluded_block_replaced, exhausted, budget_stopped }
```

The transition function is **three-valued** — `apply | ignore-late |
reject` (pinned here) — because the parent's retained-evidence design
guarantees late events: a skew-excluded sample's run still completes
(runs are retained as evidence), and the innocent arm of a replaced
block may already be `completed` — or still `spawned` — when its sibling
fails. A pure two-valued table would make the parent's canonical event
streams illegal.

Edge → driving-event mapping (pinned):

- `planned → admitted`: `block_admitted` (all samples of the block)
- `attempt_created`: binding only (sample ↔ attempt), no state change;
  journaled **before spawn** (parent Identity: attempt ids are journaled
  before spawn)
- `admitted → spawned`: `run_allocated`
- `spawned → exposed`: `exposure_started`
- `exposed → completed`: `run_completed`
- `spawned | exposed → instrument_failed`: `instrument_failure`
- `admitted | spawned | exposed → aborted`: `aborted`
- `exposed → skew_excluded`: `skew_excluded` (samples of the excluded
  block; skew is measured at exposure)
- `sample_disposition` (disposition `excluded_block_replaced`):
  `spawned | exposed | completed → excluded_block_replaced` — the
  innocent arm's override; `superseded_by` set; its run dir is retained
  (parent replacement rule)
- `planned → exhausted`: `slot_exhausted`
- `planned | admitted → budget_stopped`: `budget_stopped` — the parent's
  admission-bypass edge is `planned → budget_stopped`; extension to
  admitted-but-not-yet-spawned samples is pinned here and proposed as
  **parent erratum E3** (under the parent's budget rule, spawning an
  admitted-but-idle block after budget-stop would add a second spend
  wave on top of the in-flight one, violating the stated overshoot bound)

**Late-event policy (pinned here, per terminal state):** after any
terminal, `run_completed` is `ignore-late` (retained-evidence semantics
— the run dir is kept and journal-referenced either way); `instrument_
failure` is `ignore-late` after `excluded_block_replaced` (the cause was
already adjudged) and `reject` after every other terminal; `exposure_
started` is `ignore-late` after `skew_excluded` (fast-arm ordering: the
first arm can expose after the block is already excluded) and `reject`
otherwise; everything else is `reject`. D3's replay treats
`ignore-late` as recorded-but-non-mutating.

Campaign:

```
registered → running → sealing → sealed
running → cancelled
running ⇄ storage_paused → running
```

Edge → driving-event mapping (pinned): `registered → running`:
`campaign_opened`; `running → cancelled`: `campaign_cancelled`;
`sealing → sealed`: `sealed`; `running → storage_paused`:
`storage_paused`; `storage_paused → running`: derivation rule — the
first subsequent `block_admitted`, `attempt_created`, or `budget_event`
(pinned here; no dedicated resume event in the vocabulary). `sealing`
is a transient computation state (completeness predicate running)
witnessed by `sealed`; the crash window post-predicate pre-report
regenerates the report idempotently (below). `sealed` and `cancelled`
are terminal.

Crash-window resolutions (parent Appendix B), pinned as a pure function
over a journal prefix: pre-`run_allocated` → attempt void, re-admit;
post-`run_allocated` without terminal → kill pgid, block rerun;
post-seal-predicate pre-report → regenerate report (idempotent).

**Journaling order (pinned here):** `attempt_created` before spawn
(parent Identity); `run_allocated` immediately after spawn in the same
dispatch critical section. Residual window: if the dispatcher dies
between spawn and `run_allocated`, the orphan child is unjournaled; it
is bounded by `attempt_bounds.max_time_s` and its run dir is
quarantined at reconciliation by attempt-id mismatch (documented
residual, matching the parent's worst-case accounting).

### The exposure-measurement contract (`analysis_exposure_started_at`)

The parent restored this field precisely because the easy proxies are
wrong ("spawn and Gauntlet boot are not arm start"), and Phase 0
confirmed the hazard: its skew evidence used a pre-exposure proxy whose
bias direction is unknown. Contract:

- **Name:** `analysis_exposure_started_at` — the journal's
  `exposure_started.ts` carries exactly this quantity; the name appears
  in provenance readback.
- **Definition:** the sample's first Coding-Agent generation request.
- **Owner:** the sensors module (D3), per the seam map.
- **Source precedence (pinned here):** (1) the gauntlet child's event
  stream, where the harness marks the coding agent's first generation;
  (2) the coding-agent session log's earliest request timestamp,
  tail-observed at runtime and re-derived at capture. Spawn time and
  Gauntlet-boot time are **forbidden sources**.
- **Absence is fail-closed:** in a gating campaign a sample whose
  exposure cannot be established by exclusion-decision time is treated
  as a skew breach (excluded from the paired comparison, refilled from
  reserve per the parent's rule); in an exploratory campaign it renders
  as a caveat.

### Typed failures (contract surface)

The parent makes the closed map composer-outcome → {instrument
(replace), evidence (indeterminate/pass/fail), aborted, shortfall} "a
published kernel deliverable"; the classifier implementation is D3, but
the **type surface is a D1 contract** shared by the journal schema, the
classifier, and report accounting:

- codomain enum: `instrument | evidence | aborted | shortfall`
  (pinned here as the parent's four classes);
- `InstrumentCause` union, initial vocabulary (pinned here):
  `grader_billing_exhausted | grader_rate_limited | subject_spawn_failed
  | subject_crashed | capture_failed | checks_crashed`;
  the **closed** cause set is completed by the D3 classifier's
  `RunErrorStage`-table-driven mapping (table-driven over the full
  8-stage enum, `src/contracts/verdict.ts`); unknown causes stay
  `indeterminate` and are **never** replaced (parent Typed failures).

### Verdict extension

`FinalVerdictSchema` gains optional:

```
campaign?: { campaign_id, comparison_id, block_id, sample_id,
             execution_attempt_id }
```

Readers tolerate absence; the dashboard is unaffected (parent).
**Stamping obligation (parent Identity):** the block is stamped by the
runner **before the first provider token**; the spawn/key-select seam
row carries the requirement that campaign identity is supplied to the
runner at launch for exactly this. Back-compat: the schema is non-strict
and the addition optional, so back-compat is structural; the regression
baseline is the committed inline verdict shapes (`test/contracts.test.ts`
et al.) plus one newly created complete fixture — the four on-disk
`verdict.json` fixtures are deliberately partial/legacy-shaped (seats
fixtures, dashboard fixtures) and are outside `FinalVerdictSchema` by
design.

### CheckRecord extension

The collected record keeps `{ phase, check, args, negated, passed,
detail }` (`phase` load-bearing; injected by the collection layer in
`src/checks/index.ts`, whose `SinkRecordSchema` is the emitter shape
minus `phase`) and gains optional `score: number`,
`metrics: Record<string, number>`, `tags: string[]`, `notes: string`.
**Fold rule (parent Checks):** unknown keys fold into `detail` — a
write-side rule implemented in the collection layer (`readRecords` /
`SinkRecordSchema` amendment), not a zod default; today unknown keys
are silently stripped by the parse. Fold format (pinned here): folded
pairs render as `key=value`, joined by `; `, appended after the existing
detail with a ` | ` separator when detail is non-null (detail is
`string | null`). Metric aggregation stays registration-scoped (declared
metrics only); D1 ships the schema, not aggregation. The expected-check
manifest shape (`src/contracts/check-manifest.ts`) is
`{ phase, check, args: string[] | null (null = wildcard), negated,
count }` — unchanged by this work; manifests pin identity fields only,
and `compareRecords` (`src/check/manifest.ts`) keys only on
`[phase, check, negated, args]`, so the extensions cannot break
multiset matching.

### Report (`report.json`)

```
{ schema_version: 1,
  campaign_id,
  profile: "release_gate_v1" | "descriptive_v1",
  stamp?: "DESCRIPTIVE",              // present iff descriptive_v1
  verdict?: "SHIP" | "NO_SHIP" | "UNDERPOWERED_OR_INVESTIGATE",
                                      // present iff gating; structurally
                                      // absent for descriptive_v1
  cannot_answer: [{ cell, mde }],
  comparisons: [{ comparison_id,
                  cells: [{ scenario, class, n, delta?, fisher_p?, mde? }] }],
  accounting: { instrument_errors, indeterminates, replacements,
                reserve_draws, skew_exclusions, skew_caveats,
                budget_events, amendments, denominators },
  provenance: { arms: [{ arm, registered_model, observed_model_set }],
                grader: { credential, model, observed } },
  supersedes?: <campaign_id>,
  errata: [...] }
```

Byte-stability contract (parent): shortest round-trip doubles, sorted
keys, LF line endings. D1 ships the schema plus these rendering rules as
named constants/predicates; the D4 renderer is tested against them.
MDE rendering consumes the pre-registered `mde_by_scenario` parameters
(below) — MDE is registration-frozen, per the parent's "pre-registered"
wording.

### Credential amendments

`CredentialSchema` (strict) gains:

- `quota_pool?: string` — `^[a-z0-9_]+$` (parent-pinned field; regex
  pinned here).
- `key_pool?: string[]` — per Decision D-1 (proposed parent erratum E4).

`quorum check` gains static validations (home: `src/credentials/check.ts`,
precedent `checkCredentials`): `key_pool`/`api_key_env` mutual
exclusion; `key_pool` requires `auth: api-key`; regex checks. Env
presence is **not** a `quorum check` concern (CI-safe discipline,
matching existing behavior); registration preflight fails fast on unset
key envs, and spawn fails loud on an exhausted/unset key.

### Scenario frontmatter

`story.md` frontmatter gains:

- `requires_superpowers: bool` — default from static scan;
- `coupling: "pins-skill-names" | "embeds-skill-fixtures" |
  "arm-independent"` — default from static scan, overridable.

Static-scan heuristics (pinned here; **no skill inventory and no
`SUPERPOWERS_ROOT` requirement** — `quorum check` must not need it):
path-shaped matching only — references shaped like
`skills/<name>/SKILL.md` or `superpowers:`-prefixed skill refs in
`story.md`, `setup.sh`, or `checks.sh` → `pins-skill-names`; fixture
paths shaped like shipped skill fixture directories →
`embeds-skill-fixtures`; neither → `arm-independent`. Committed
frontmatter always wins; `quorum check` (home: `src/story-meta.ts` /
`src/scaffold.ts`) validates declared values against the enum and warns
when an explicit override contradicts the scan.

### `poolKey` — v1 derivation

```ts
export function poolKey(cred: Credential, name: string): string {
  return cred.quota_pool ?? `${cred.base_url ?? name}|${cred.api}|${cred.model}`;
}
```

The parent's v1 derivation: per-model splitting without merging distinct
endpoints or orgs; the explicit `quota_pool` covers entries genuinely
sharing one provider bucket. `limiterKey` is untouched (legacy
scheduler). Golden fixtures per Decision D-4: the committed gate-era
credential snapshot → derived pool IDs must equal the gate manifest's
curated pool IDs, so the canonical function cannot drift from what
Phase 0 measured.

### Profile parameter schemas + registry

`quorum check` must validate suite files "including profile parameters"
(parent Testing), which requires profile parameter schemas in D1 even
though evaluation logic is D4. D1 ships:

- a **frozen built-in registry** — a plain map value passed as an
  argument (injectable, deterministic for tests), with an explicit
  extension point for platform PRs; no mutable global registration;
- `release_gate_v1` parameters (pinned as data, covering the parent's
  "alphas, floors, deltas"):
  - `alpha` — per-cell two-sided significance level, 0 < alpha < 1;
  - `determinate_n_floor` — positive integer, per confirmatory cell;
  - `completion_divergence_max` — the 08-08 completion-collapse
    tripwire threshold, 0 < x ≤ 1;
  - `mde_by_scenario: Record<scenario, number>` — the pre-registered
    minimum-detectable-effect per confirmatory scenario ("deltas");
    registration validates coverage of every scenario carrying
    confirmatory cells;
  - tripwire expectations ride in the suite's `cells:` overrides
    (`tripwire_expect`), validated at registration — the firing
    criterion is pinned above (Tripwire criterion);
- `descriptive_v1` parameters: empty object schema.

Growing the profile list stays a platform PR (parent Decision profiles).

## The `run_allocated` contract

The journal must bind attempt → run-dir → pgid before run completion so
crash recovery can reconcile run dirs against journaled state. The
run-id is minted inside the runner at run-dir allocation; the pgid is
known to the spawner. The contract, on the parent-pinned seam:

- **Emission (parent Identity, transcribed):** the runner emits
  `run_allocated: <run_id>` on its child protocol at run-dir allocation
  — extending the existing `onRunDir` seam
  (`src/runner/index.ts:409,957-960`, fired immediately after
  `allocateRunDir`; consumed today by `src/cli/run-command.ts:97`).
  One allocation per run ⇒ one emission. The runner reports only what
  it uniquely knows (the run-id); legacy `quorum run` output is
  unchanged for humans (the protocol line is machine-facing).
- **pgid ownership (pinned here):** the journaled pgid is the
  dispatcher's, not the runner's. D3's spawn contract requires each
  campaign run to be spawned as a **process-group leader**
  (setsid/detached — the appliance's existing discipline,
  `src/appliance/process.ts`; current non-detached spawn sites in
  `src/run-all/` must not be copied), so pgid = spawned child pid; the
  dispatcher validates pgid == child pid before journaling
  `run_allocated`. v1 is host-direct (no container pgid translation;
  see Non-goals). Windows is a registration error, so POSIX semantics
  suffice.
- **Correlation:** the dispatcher correlates the emitted run-id to its
  attempt by launch identity (it spawned the child); the journal payload
  is `{ attempt_id, run_id, pgid, key_env? }`.
- **Journaling order:** per the State machines section (attempt_created
  pre-spawn; run_allocated immediately post-spawn, same critical
  section); residual orphan window documented there.

## Artifact layout

```
src/contracts/campaign/            (new subdirectory; Decision D-2)
  arm.ts                           ArmSchema
  suite.ts                         SuiteSchema, comparison/cell shapes,
                                   selector grammar
  campaign.ts                      CampaignSchema, cardinality refinements
  digest.ts                        JCS canonicalization + SHA-256 digest
  journal-events.ts                envelope + 20 event payload schemas
  state-machine.ts                 three-valued transition tables (pure)
  crash-windows.ts                 journal-prefix → resolution (pure)
  report.ts                        ReportSchema + byte-stability constants
  pool.ts                          poolKey, KeySelector type
  typed-failures.ts                codomain enum + InstrumentCause union
  scenario-meta.ts                 frontmatter schema + static-scan defaults
  check-record.ts                  collected CheckRecord schema
  profile-params.ts                frozen registry + v1 parameter schemas
src/contracts/credential.ts        + quota_pool, key_pool (amended in place)
src/contracts/verdict.ts           + optional campaign block (amended)
src/runner/ (+ src/cli/run-command.ts)
                                   + run_allocated protocol emission at the
                                     onRunDir seam
src/credentials/check.ts           + key_pool static validations
src/story-meta.ts / src/scaffold.ts
                                   + frontmatter validation + scan warnings
src/cli/ (quorum check)            + arm/suite discovery and validation
arms/, suites/                     arm and suite YAML documents live here
                                   (parent Concepts examples); campaigns/
                                   holds campaign dirs (D3)
test/campaign-contracts-*.test.ts  (per module; siblings of the existing
                                    campaign-*.test.ts family)
test/fixtures/jcs/                 RFC 8785 appendix vectors + campaign
                                   golden vectors
test/fixtures/gate-era-credentials-64b99fc.yaml
                                   hermetic poolKey golden input (D-4)
```

## Validation strategy

- **Round-trips:** every document parses from JSON, re-serializes, and
  re-parses byte-identically under the rendering rules.
- **Digest:** RFC 8785 Appendix test vectors (committed fixtures) for
  the canonicalizer; campaign-level golden vectors (fixed campaign
  objects → expected SHA-256); byte-stability across key orderings;
  exclusion-list tests (mutating any excluded field leaves the digest
  invariant; mutating any included field changes it); NaN/Infinity
  rejection tests.
- **State machines:** exhaustive (state × event type) table tests —
  every `apply` edge lands, every `ignore-late` case is recorded
  non-mutating, every `reject` rejects; the retained-evidence late
  sequences (sibling-completes-after-replacement, run-completes-after-
  skew-exclusion) are explicit golden streams. Campaign-machine mapping
  tested likewise, including the storage_paused derivation rule.
  Crash-window resolution tested over journal prefixes for each window.
- **`poolKey`:** hermetic golden test per Decision D-4, plus unit cases
  for `quota_pool`, `base_url`, and name fallback.
- **Credential amendments:** strictness (unknown keys reject), mutual
  exclusion, auth compatibility, regexes.
- **Backward compatibility:** the committed inline verdict shapes and a
  newly created complete verdict fixture parse unchanged; the campaign
  block and CheckRecord extensions are absence-tolerant (structurally:
  non-strict objects, optional additions).
- **`run_allocated` seam:** emission at allocation (one line per run),
  legacy human output unchanged, pgid validation rule unit-tested.
- **`quorum check`:** arm/suite discovery from `arms/` + `suites/`;
  profile parameters validate against the registry; tier-selector
  grammar accepted; scenario frontmatter enum + scan contradiction
  warning; cross-references against `coding-agents/` and
  `credentials.yaml` at check time (precedent: `checkCredentials`).

No mocked-behavior tests (repo culture): schemas are tested against
real fixture JSON; the transition tables, crash-window resolvers, and
digest are pure functions under direct test.

## Interfaces handed downstream

- **D2 (provisioning/snapshot):** `ArmSchema.superpowers`, the adapter
  capability registry seam, `Campaign.refs`, the per-child env injection
  contract over `command-runner`.
- **D3 (dispatcher/journal/locks):** every contract above — document
  schemas, digest, event vocabulary, three-valued state machines,
  `poolKey`, `KeySelector` (with the fail-loud resolution requirement),
  the `run_allocated` contract (setsid spawn + pgid validation), the
  exposure-measurement contract, the typed-failure type surface,
  profile parameter registry — plus the D-1 registration-warning
  requirement.
- **D4 (profiles/report):** `ReportSchema`, byte-stability constants,
  parameter schemas (including `mde_by_scenario` and the tripwire
  criterion), verdict vocabulary.

## Errata and open items

Proposed parent errata for ratification on PRI-2874 (alongside Phase 0's
E1/E2, which remain unaffected-by and orthogonal to D1):

- **E3 — `budget_stopped` edge extension:** admitted-but-not-yet-spawned
  samples also reach `budget_stopped` (State machines); without it the
  parent's overshoot bound is violated.
- **E4 — `key_pool` credential amendment:** second credential amendment
  beyond `quota_pool`, forced by Phase 0's grader-cap finding (Decision
  D-1).
- **E5 — `campaign_cancelled` event:** the parent's campaign machine has
  a `cancelled` terminal its event vocabulary cannot drive; replay
  determinism requires the 20th event.
- **SHA-256 note:** the parent delegates the digest hash choice; this
  spec's SHA-256 selection completes the identity record (no parent
  text change strictly required).
- **Parent inconsistency reconciled (not an erratum):** Concepts says
  operator-declared per-token pricing overrides are "recorded in
  `campaign.json`"; Appendix B's field list omits them — D1 adds
  `pricing_overrides?` (Campaign section).

Other open items:

- **Windows/Antigravity:** `os: windows` parses in `ArmSchema` and is a
  registration error until the parent's named support lands.
- **Key-selection wait accounting:** D3 decides how `wait` time is
  journaled (pool-blocked analog or spawn-wait class); D1 pins only the
  selector contract and its authority relationship.
- **Grader calibration:** Decision D-1's pool-cap invariant is
  documented, not machine-enforced; PRI-2524 owns the calibration
  evidence, and the qualification campaign measures it.
