# Kernel Deliverable 1 — Campaign Platform Contracts: Design

**Date:** 2026-08-24
**Status:** proposed
**Parent spec:** `docs/superpowers/specs/2026-08-17-quorum-campaign-platform-design.md`
  (the campaign platform design; "the parent" below)
**Prerequisite:** Phase 0 capacity simulation (merged `f93e95b`;
  `docs/experiments/2026-08-24-phase0-capacity-simulation.md`)
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
This spec therefore adds exactly four things the parent does not contain:

1. **The grader-pool credential shape decision** (Decision D-1) — forced
   by Phase 0, which proved a single-key grader pool defeats the 8h gate
   and promoted grader de-SPOF (PRI-2524) to gate-blocker.
2. **The kernel-wide seam map** — the module/interface decomposition of
   all four deliverables, written here so boundaries are designed and
   test-enforced before D2–D4 start, not discovered mid-build. (Review
   feedback, Jesse, 2026-08-24: the D3 scope as previously presented read
   as a monolith; the seam map is the correction.)
3. **The artifact layout** and the `run_allocated` runner seam.
4. **The validation strategy** binding every contract to a test class.

Everything else is faithful transcription of the parent's pinned text into
implementation contracts, with the one runtime formula the parent
delegates: the v1 quota-pool derivation (Contracts: `poolKey`).

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
  seams (verified, cited in the seam map). The seam map makes those
  boundaries explicit and testable.
- **Repo idiom:** injectable seams are the established pattern
  (`src/scheduler/clock.ts`, `src/agents/command-runner.ts`, the
  `QUORUM_RECORD_SINK` env sink in `src/check/record.ts`, Phase 0's
  simulator over `FakeClock`). D1 follows it.

## Scope

In scope, all TDD:

1. zod schemas for every Appendix B document: Arm, Suite, Campaign
   (`campaign.json`), Report (`report.json`).
2. The JCS digest canonical form as a pure function with golden vectors.
3. The journal **event vocabulary** as schemas (envelope + 19 event
   types) and both **state machines** as transition tables with pure
   validators. No storage: the SQLite journal, flock writer, and recovery
   executor are D3.
4. The `campaign:` extension on `FinalVerdictSchema`; the CheckRecord
   extensions (`score`, `metrics`, `tags`, `notes`) with the write-side
   unknown-key fold rule.
5. `CredentialSchema` amendments: `quota_pool` (parent-pinned) and
   `key_pool` (decision D-1).
6. Scenario frontmatter: `requires_superpowers`, `coupling` — schema,
   static-scan defaults, override rules.
7. The v1 pool-derivation function `poolKey` and the key-selector type.
8. Profile **parameter schemas** + a registry seam, so `quorum check`
   validates suite files "including profile parameters" (parent Testing).
   Profile evaluation logic is D4.
9. `quorum check` validation for arm and suite files.
10. The `run_allocated` emission seam in the runner.

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

## Decision D-1: grader-pool credential shape

**Decision:** multi-key credential. `CredentialSchema` gains optional
`key_pool`: a non-empty array of env-var names (same regex as
`api_key_env`: `^[A-Za-z_][A-Za-z0-9_]*$`), subject to:

- mutually exclusive with `api_key_env` (at most one of the two);
- only valid with `auth: api-key` (subscription, oauth, and
  bedrock-bearer credentials have no key material to pool —
  validation error);
- `max_concurrency` on such a credential is the **pool-level** cap.

At spawn time one key env is selected from the pool per child; the
selected key is injected through the existing per-child credential
projection (F13 machinery). The dispatcher never sees individual keys.

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
  singular — zero deviation from parent-pinned contract text.
- Admission accounts one pool (cap ≥15, the Phase 0 requirement); key
  selection lives strictly below it, at spawn, where F13 already injects
  per-child credential env. The dispatcher's view of the grader is
  unchanged.
- Model ⇔ credential coupling (parent §"Known coupling") is intact: one
  credential, one model, one pricing authority; all pooled keys are the
  same model/endpoint by construction.

**New invariant introduced (documented, not enforced in D1):** the
pool-level cap must not exceed the sum of per-key sustainable
concurrency. This is operator calibration, exactly the work PRI-2524
owns (key acquisition or calibrated Bedrock grader); the qualification
campaign measures whether the calibration holds.

**Registration-time warning (pinned here as a D3 requirement):**
registration renders a warning — not a rejection, since per-key capacity
is not knowable from config — when a `key_pool` credential's
`max_concurrency` exceeds `key_pool.length × 5` (the probed single-key
Anthropic concurrency). Registration is D3; D1 pins the requirement.

**Key selection is pinned as a contract, implemented in D3:**

```ts
export interface KeyGrant { envName: string; }
export type KeySelector = (
  cred: Credential,                       // must carry key_pool
  inFlight: Record<string, number>,       // env var name -> running children
) => { kind: 'use'; grant: KeyGrant } | { kind: 'wait' };
```

D1 pins the type and the policy contract: least-loaded key; `wait` when
every key's in-flight count is at or above the per-key share
(`ceil(max_concurrency / key_pool.length)`). D3 supplies the
implementation and the journal-visible wait accounting.

## Decision D-2: contracts live in `src/campaign/contracts/`

Campaign-domain schemas live with the campaign module — the Phase 0
precedent (`src/campaign/{replay,estimates,simulate}.ts` carry their own
zod contracts). Cross-cutting schemas stay in their existing homes and
are amended there. Layout in "Artifact layout" below.

## Decision D-3: `run_allocated` rides an env sink seam

The env-var JSONL sink pattern of `QUORUM_RECORD_SINK` is copied
verbatim: append-only, no-op when unset, no dependency added to the
runner. See "The `run_allocated` seam" below.

## Decision D-4: `poolKey` is a contract function with Phase 0 golden fixtures

The Phase 0 replay manifests curated pool IDs with the v1 formula;
committed manifest pool IDs are the golden fixtures, so the canonical
function cannot drift from what Phase 0 measured. See the `poolKey`
contract below.

## Kernel-wide seam map

The module decomposition of all four deliverables. Columns: module —
deliverable — responsibility — consumes — produces — test strategy.
Interfaces named here are D1 contracts unless marked otherwise.

| Module | Del. | Responsibility | Consumes | Produces | Test strategy |
|---|---|---|---|---|---|
| `contracts` | D1 | Every document schema, digest, state machines, pool derivation, profile parameter schemas | parent Appendix B (this spec) | all interfaces below | round-trips, golden vectors, transition tables |
| `provisioning` | D2 | One immutable worktree per distinct `superpowers:` SHA; `none` mode; per-child root injection through all adapters | Arm.superpowers refs, `command-runner` seam | per-child `SUPERPOWERS_ROOT`, provenance readback | black-box: `verdict.json .provenance.superpowers_rev` equals registered SHA (or absent for `none`), per adapter |
| `instrument-snapshot` | D2 | Campaign-local materialization of the registered evals SHA; drift detection vs registered digests | Campaign.refs.evals | frozen story/checks/prelude/configs/lockfile; drift → admission halt | digest drift fixtures |
| `registration` | D3 | Grid expansion, eligibility filters, pricing from estimates, digest, staging → atomic commit of `campaign.json` | suite/arm files, estimates artifact (`quorum.estimates/v1`), `credentials.yaml`, `poolKey` | `campaign.json` + `campaign_opened` | golden campaigns; digest stability; rejection matrix |
| `journal` | D3 | Event persistence (SQLite), single writer under campaign-dir flock, fsync per transition, rebuildable materialized tables | journal event vocabulary (D1) | ordered event read API | replay-determinism; crash-window prefixes |
| `dispatcher` | D3 | Atomic per-block admission (subject pools + grader pool + global cap), longest-expected-first ordering, 429 cooldowns, backfill, replacement rule, budget enforcement, cancellation | `campaign.json`, journal, estimates, `poolKey` | journal events | injectable clock + fake runner seam; adversarial arrivals |
| `spawn/key-select` | D3 | Child spawn with projected credential + selected key + per-child superpowers root; emits `run_allocated` | admission decisions, `KeySelector` (D1), run_allocated sink | running children, pgids | spawn fixtures; key-grant accounting |
| `sensors` | D3 | Provider-broad 429/rate-limit classification over subject CLIs and the gauntlet child | child stderr/result artifacts | `pool_blocked` events | fixture streams per provider marker |
| `failure-classifier` | D3 | Closed map `RunErrorStage` → {instrument (replace) \| evidence \| aborted \| shortfall}; grader billing-exhaustion and grader 429 as typed instrument causes | `RunErrorStage` (existing, `src/contracts/verdict.ts`), sensor output | `instrument_failure` causes | table-driven over the full enum; unknown stays `indeterminate`, never replaced |
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
skeletal, this spec pins the exact shape and marks it **(pinned here)**.

### Arm

```
{ schema_version: 1,
  name: string,                       // [a-z0-9_]+
  agent: string,                      // coding-agent name (claude, codex, …)
  credential: string,                 // credentials.yaml key
  superpowers: <full-sha> | <tag> | "none",
  os?: "linux" | "windows",           // default "linux"; "windows" is a
                                      // registration error (parent non-goal)
  labels?: Record<string, string> }   // (pinned here)
```

Registration resolves `superpowers` tags to full SHAs into
`Campaign.refs.superpowers_by_arm`; `none` arms are rejected for agents
whose adapter has not implemented the mode (D2 adapter capability
registry — D1 pins the registry seam, D2 fills it).

### Suite

```
{ schema_version: 1,
  name: string,
  kind: "gating" | "exploratory",
  budget_usd: number,                 // all-in: subject + grader + reserves
  profile?: "release_gate_v1" | "descriptive_v1",
  profile_params?: <validated against the profile's parameter schema
                    (see Profile parameter schemas + registry)>,
  reserve?: number,                   // reserve blocks per cell (gating only)
  max_exposure_skew?: <duration s>,
  attempt_bounds?: { max_time_s?: number, max_attempts?: number },
                                      // defaults from scenario quorum_max_time
  declared_metrics?: [{ name, unit, aggregation }],
  comparisons: [<comparison>...] }

<comparison> (two-arm):
{ baseline: <arm-ref>, treatment: <arm-ref>, scenarios: [string...],
  n: int ≥ 1, cells?: { <scenario>: { n?: int, class?: string } } }

<comparison> (single-arm):
{ arm: <arm-ref>, scenarios: [string...], n: int ≥ 1,
  cells?: { <scenario>: { n?: int, class?: string } } }
```

k-arm comparisons are out by parent non-goal: the schema structurally
admits exactly one or two arms. Gating suites require `profile:
release_gate_v1`, a registered `reserve`, and a registered grader
credential. `reserve` is gating-only: registration rejects it on
exploratory suites, whose reserve exhaustion is rendered as reduced n
(descriptive) and whose skew breaches render as caveats (parent
Execution).

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
  comparisons: [{ comparison_id, baseline, treatment? , arm? }],
                                      // comparison_id: digest-scoped ordinal
                                      // minted at registration
  blocks: [{ block_id, comparison_id, sample_ids: [sample_id, sample_id] }],
  budget: { usd_all_in: number, surcharge_applied: number,
            priced_coverage: number },
  registered_at: <iso8601>, registered_by: string,
  digest: string }
```

Block/sample cardinality invariants (pinned here, enforced by schema
refinement): every block carries exactly the sample_ids of its cell's
arms for one replicate; every sample belongs to exactly one block;
single-arm comparisons degenerate to one-sample blocks.

### Digest canonical form

JCS-canonicalized (RFC 8785) JSON of the Campaign document **minus**:
`estimates_by_arm` (in every cell), `budget.surcharge_applied`,
`budget.priced_coverage`, `registered_at`, `registered_by`,
`campaign_id`, and `digest` itself. `budget.usd_all_in` (the registered
figure) stays in. Digest algorithm: SHA-256 over the JCS bytes,
hex-encoded (pinned here; the parent says "JCS-canonicalized JSON" and
delegates the hash choice).

Estimates and estimate-derived pricing are advisory and re-derivable;
refreshing them never forks campaign identity — the Phase 0 settlement,
now expressed as exclusion list.

### Journal event vocabulary

Envelope **(pinned here)**: every journaled row is
`{ seq: int (monotonic, single-writer), ts_ms: int, type: <event type>,
payload: <event-specific object> }`. Replay in `seq` order
deterministically reconstructs state; materialized tables are rebuildable
(parent Journal). Event types and payloads (parent Appendix B, with
payload fields pinned):

| Event | Payload |
|---|---|
| `campaign_opened` | `{ campaign_id, digest }` |
| `block_admitted` | `{ block_id, pools: [pool_key...] }` |
| `attempt_created` | `{ sample_id, attempt_id }` |
| `run_allocated` | `{ attempt_id, run_id, pgid }` |
| `exposure_started` | `{ sample_id, ts }` (first Coding-Agent generation request) |
| `run_completed` | `{ attempt_id, outcome }` |
| `instrument_failure` | `{ attempt_id, cause }` (typed, see seam map: failure-classifier) |
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
| `sealed` | `{ report_digest }` |

### State machines

Block/attempt:

```
planned → admitted → spawned → exposed → terminal
terminal ∈ { completed, instrument_failed, aborted, skew_excluded,
             excluded_block_replaced, exhausted, budget_stopped }
```

Edge → driving-event mapping (pinned; every edge is driven by exactly
one journal event type, and the transition table — (state, event type) →
state or reject — is a D1 pure function with exhaustive table tests):

- `planned → admitted`: `block_admitted` (all samples of the block)
- `attempt_created`: binding only (sample ↔ attempt); no state change
- `admitted → spawned`: `run_allocated`
- `spawned → exposed`: `exposure_started`
- `exposed → completed`: `run_completed`
- `spawned | exposed → instrument_failed`: `instrument_failure`
- `admitted | spawned | exposed → aborted`: `aborted`
- `exposed → skew_excluded`: `skew_excluded` (samples of the excluded
  block; skew is measured at exposure)
- `exposed → excluded_block_replaced`: `sample_disposition` (the
  innocent arm of a replaced block; `superseded_by` set)
- `planned → exhausted`: `slot_exhausted`
- `planned | admitted → budget_stopped`: `budget_stopped` — the parent's
  admission-bypass edge is `planned → budget_stopped`; extension to
  admitted-but-not-yet-spawned samples is pinned here (the overshoot
  bound is one in-flight wave, so admitted samples that never spawned
  stop too)

Campaign:

```
registered → running → sealing → sealed
running → cancelled
running ⇄ storage_paused → running
```

`sealed` and `cancelled` are terminal.

Crash-window resolutions (parent Appendix B), pinned as a pure function
over a journal prefix: pre-`run_allocated` → attempt void, re-admit;
post-`run_allocated` without terminal → kill pgid, block rerun;
post-seal-predicate pre-report → regenerate report (idempotent).

### Verdict extension

`FinalVerdictSchema` gains optional:

```
campaign?: { campaign_id, comparison_id, block_id, sample_id,
             execution_attempt_id }
```

Readers tolerate absence; the dashboard is unaffected (parent). Existing
verdict fixtures must parse unchanged — a D1 regression test.

### CheckRecord extension

The collected record keeps `{ phase, check, args, negated, passed,
detail }` (`phase` load-bearing) and gains optional `score: number`,
`metrics: Record<string, number>`, `tags: string[]`, `notes: string`.
Unknown keys fold into `detail` — a write-side rule implemented in the
record collection layer with tests, not a zod default (parent Checks).
Metric aggregation stays registration-scoped (declared metrics only);
D1 ships the schema, not aggregation. The expected-check manifest shape
(`src/check/manifest.ts`: `{phase, check, args, negated, multiplicity}`)
is unchanged — manifests pin identity fields only; the extensions are
runtime values (pinned here).

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

### Credential amendments

`CredentialSchema` (strict) gains:

- `quota_pool?: string` — `^[a-z0-9_]+$` (parent-pinned field; regex
  pinned here).
- `key_pool?: string[]` — per Decision D-1.

`quorum check` gains static validations: `key_pool`/`api_key_env`
mutual exclusion; `key_pool` requires `auth: api-key`; regex checks.
Env presence is **not** a `quorum check` concern (CI-safe discipline,
matching existing behavior); registration preflight fails fast on unset
key envs, and spawn fails loud on an exhausted/unset key.

### Scenario frontmatter

`story.md` frontmatter gains:

- `requires_superpowers: bool` — default from static scan;
- `coupling: "pins-skill-names" | "embeds-skill-fixtures" |
  "arm-independent"` — default from static scan, overridable.

Static-scan heuristics, pinned (conservative; committed frontmatter
always wins): references to skill paths/names in `story.md`, `setup.sh`,
or `checks.sh` → `pins-skill-names`; fixture files matching shipped skill
fixture names → `embeds-skill-fixtures`; neither → `arm-independent`.
`quorum check` validates declared values against the enum and warns when
an explicit override contradicts the scan.

### `poolKey` — v1 derivation

```ts
export function poolKey(cred: Credential, name: string): string {
  return cred.quota_pool ?? `${cred.base_url ?? name}|${cred.api}|${cred.model}`;
}
```

The parent's v1 derivation: per-model splitting without merging distinct
endpoints or orgs; the explicit `quota_pool` covers entries genuinely
sharing one provider bucket. `limiterKey` is untouched (legacy
scheduler). Golden fixtures: pool IDs curated into
`src/campaign/replay-manifest.gate-20260808.json` were derived with this
formula during Phase 0; a D1 test asserts the function reproduces them,
so the canonical implementation cannot drift from what Phase 0 measured.

### Profile parameter schemas + registry

`quorum check` must validate suite files "including profile parameters"
(parent Testing), which requires profile parameter schemas in D1 even
though evaluation logic is D4. D1 ships:

- a registry seam: `registerProfileParams(name, zod schema)`;
- `release_gate_v1` parameters (pinned as data): `alpha` (per-cell
  two-sided significance level, 0 < alpha < 1), `determinate_n_floor`
  (positive integer), `completion_divergence_max` (the 08-08
  completion-collapse tripwire threshold, 0 < x ≤ 1). Tripwire-family
  growth is a platform PR extending this schema (parent Decision
  profiles);
- `descriptive_v1` parameters: empty object schema.

## The `run_allocated` seam

The journal must bind attempt → run-dir → pgid before run completion so
crash recovery can reconcile run dirs against journaled state. The
run-id is minted inside the runner at run-dir allocation; the pgid is
known to the spawner. The seam:

- env var `QUORUM_RUN_ALLOCATED_SINK` (name pinned here);
- when set, the runner appends exactly one JSON line at run-dir
  allocation: `{"run_id", "pgid", "allocated_at_ms"}`;
- when unset, no-op — identical discipline to `QUORUM_RECORD_SINK` in
  `src/check/record.ts`;
- the campaign dispatcher (D3) supplies the sink and correlates by pgid
  to journal `run_allocated(attempt_id, run_id, pgid)`.

D1 ships the seam, the emission, and unit tests (sink set/unset, one
line per run, allocation-time timing). Legacy `quorum run` is unaffected
(sink unset).

## Artifact layout

```
src/campaign/contracts/          (new directory; decision D-2)
  arm.ts                         ArmSchema
  suite.ts                       SuiteSchema, comparison/cell shapes
  campaign.ts                    CampaignSchema, cardinality refinements
  digest.ts                      JCS canonicalization + SHA-256 digest
  journal-events.ts              envelope + 19 event payload schemas
  state-machine.ts               transition tables (pure validators)
  crash-windows.ts               journal-prefix → resolution (pure)
  report.ts                      ReportSchema + byte-stability constants
  pool.ts                        poolKey, KeySelector type
  scenario-meta.ts               frontmatter schema + static-scan defaults
  check-record.ts                collected CheckRecord schema
  profile-params.ts              registry seam + v1 parameter schemas
src/contracts/credential.ts      + quota_pool, key_pool (amended in place)
src/contracts/verdict.ts         + optional campaign block (amended)
src/runner/                      + run_allocated sink emission at the
                                   run-dir allocation site
src/cli/ (quorum check)          + arm/suite file validation,
                                   credential amendment checks
test/campaign-contracts-*.test.ts   (per module)
```

## Validation strategy

- **Round-trips:** every document parses from JSON, re-serializes, and
  re-parses byte-identically under the rendering rules.
- **Digest golden vectors:** fixed campaign objects → expected JCS bytes
  and SHA-256; byte-stability across key orderings; exclusion-list tests
  (mutating any excluded field leaves the digest invariant; mutating any
  included field changes it).
- **State machines:** exhaustive (state × event type) table tests —
  every legal edge lands, every illegal edge rejects. Crash-window
  resolution tested over journal prefixes for each window.
- **`poolKey`:** reproduces Phase 0 manifest pool IDs plus unit cases
  for `quota_pool`, `base_url`, and name fallback.
- **Credential amendments:** strictness (unknown keys reject), mutual
  exclusion, auth compatibility, regexes.
- **Backward compatibility:** every existing verdict fixture and check
  record parses unchanged; `campaign:` block and CheckRecord extensions
  are absence-tolerant.
- **`run_allocated` seam:** sink-set/unset, one line per allocation,
  pgid correctness.
- **`quorum check`:** arm/suite files validate; profile parameters
  validate against the registry; scenario frontmatter enum + scan
  contradiction warning.

No mocked-behavior tests (repo culture): schemas are tested against
real fixture JSON; the transition tables and crash-window resolvers are
pure functions under direct test.

## Interfaces handed downstream

- **D2 (provisioning/snapshot):** `ArmSchema.superpowers`, the adapter
  capability registry seam, `Campaign.refs`, the per-child env injection
  contract over `command-runner`.
- **D3 (dispatcher/journal/locks):** every contract above — document
  schemas, digest, event vocabulary, state machines, `poolKey`,
  `KeySelector`, the `run_allocated` sink, profile parameter registry —
  plus the D-1 registration-warning requirement.
- **D4 (profiles/report):** `ReportSchema`, byte-stability constants,
  parameter schemas, verdict vocabulary.

## Errata and open items

- **Parent errata E1/E2** (estimates keying scenario×agent×credential×os;
  cost medians at every fallback tier) await ratification on PRI-2874.
  D1 is unaffected either way: the Campaign document carries per-arm
  estimate values, never artifact keys.
- **Windows/Antigravity:** `os: windows` parses in `ArmSchema` and is a
  registration error until the parent's named support lands.
- **Key-selection wait accounting:** D3 decides how `wait` time is
  journaled (pool-blocked analog or spawn-wait class); D1 pins only the
  selector contract.
- **Grader calibration:** Decision D-1's pool-cap invariant is
  documented, not machine-enforced; PRI-2524 owns the calibration
  evidence, and the qualification campaign measures it.
