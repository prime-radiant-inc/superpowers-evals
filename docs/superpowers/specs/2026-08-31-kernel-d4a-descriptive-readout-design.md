# Kernel Deliverable 4a — Descriptive Readout (seal act + report engine): Design

**Forward direction (2026-09-04):** the accepted
[campaign consolidation direction](2026-09-04-campaign-consolidation-design.md)
pauses the V1-specific D4b hand-off below. D4a's implementation and historical
artifact contract remain unchanged; future reports use the surviving V2
measurement model. The detailed consolidation design is pending written review.

**Date:** 2026-08-31 (revision 3, 2026-09-04: post-implementation scope
amendment per PAR revision 3 — the revision-2 implementation stamp is
untouched)
**Status:** implemented (main @ `3cbb8d6`; exit runs recorded in
`docs/experiments/2026-08-31-kernel-d4a-implementation-validation.md`)
**Review record:** `docs/experiments/2026-08-31-kernel-d4a-spec-review.md`
  (round 1: four-seat panel — sol, fable, glm, k3 — four of four NOT-READY on
  revision 1; five converged blockers + criticals bundle; adjudication incl.
  the qualification decision (D-7) and the ratification ledger)
**Parent spec:** `docs/superpowers/specs/2026-08-17-quorum-campaign-platform-design.md`
  (the campaign platform design; "the parent" below)
**Prerequisites:**
  - Kernel D1 contracts (merged to main @ `41b9e2b`; spec
    `docs/superpowers/specs/2026-08-24-kernel-d1-contracts-design.md`) —
    `ReportSchema`, `REPORT_RENDERING` byte-stability constants, suite/profile
    compatibility refinements, the journal event vocabulary (D1 shipped 20
    payload schemas; `quarantined` arrived as the 21st via D3's ratified E7
    erratum), including `adjudication` and `sealed`.
  - Kernel D2 provisioning + instrument snapshot (implemented, main @ `f230698`;
    spec `docs/superpowers/specs/2026-08-25-kernel-d2-provisioning-instrument-snapshot-design.md`).
  - Kernel D3 campaign engine (implemented pending its exit criteria; spec
    `docs/superpowers/specs/2026-08-26-kernel-d3-campaign-engine-design.md`,
    plan `docs/superpowers/plans/2026-08-26-kernel-d3-campaign-engine.md`) —
    the seal predicate (E7), journal read API + materialized tables,
    restrict-mode sealer-writer, shared contention evaluator + sidecar parser,
    `verifyCampaignSnapshot`, the typed-failure classifier, and the R-RCV-5
    hand-off (resume detects "predicate holds, no `sealed` event").
**Program ticket:** PRI-2874 umbrella (kernel build, order-of-operations item 3,
  deliverable 4 of 4 — this spec is the first of two increments, D4a of D4a+D4b;
  see Decision D-1)

## Source aliases used in citations

| Alias | File |
|---|---|
| **PAR** | `docs/superpowers/specs/2026-08-17-quorum-campaign-platform-design.md` |
| **D1** | `docs/superpowers/specs/2026-08-24-kernel-d1-contracts-design.md` |
| **D3** | `docs/superpowers/specs/2026-08-26-kernel-d3-campaign-engine-design.md` |
| **D3P** | `docs/superpowers/plans/2026-08-26-kernel-d3-campaign-engine.md` |
| **D3PR** | `docs/experiments/2026-08-27-kernel-d3-plan-review.md` |
| **D4R** | `docs/experiments/2026-08-31-kernel-d4a-spec-review.md` |

## Purpose and place in the program

The parent's order of operations item 3 (kernel build) names four deliverables
in fixed order: contracts → provisioning + instrument snapshot → dispatcher +
journal + locks → **profiles + report engine** (PAR §"Coexistence and
sequencing" → "Order of operations"). D1–D3 shipped the first three. This
document specs deliverable 4 — split into two increments, D4a (this spec) and
D4b (a later spec) — per Decision D-1.

D3 ends campaigns at "all samples terminal + the E7 instance-complete seal
predicate holds" (D3 §Exit criteria, completion campaign). D4a converts
*finished* into *closed evidence*: it performs the seal act (pre-seal snapshot
verify → seal-time integrity audit + contention backstop → render →
`sealed(report_digest)` → durable publication), then renders the
**descriptive report** — `quorum campaign report` — deterministically over the
journal plus the referenced immutable run dirs (PAR §"Report engine").

**What D4a buys, stated honestly** (revision 2, post round-1 review): live
full-lifecycle proof of engine + readout on exploratory campaigns, D3's owed
live debt burned down (§Exit criteria), and a seal act proven before D4b
builds decision machinery on top of it. **D4a does NOT open the qualification
window**: the parent pins the qualification campaign as gating-registered
exercising skew *exclusion* — gating-only machinery (PAR §"Qualification
before the first gate"; R-DSP-9) — and gating ⇒ `release_gate_v1` ⇒ D4b
(Decision D-7). D4b sits on the qualification critical path; D4a de-risks it.

**Boundary:** gating suites register and run today — registration is D3's
shipped verb and validates `release_gate_v1` parameters against the D1
registry (`src/campaign/registration.ts`, `src/contracts/campaign/profile-params.ts`).
What awaits D4b is **sealing and reporting** a gating campaign: D4a refuses
both, loudly and typed (§Refusal table). Under D4a, a gating campaign runs to
predicate-holds and stops there — which is exactly D3 exit-criteria item 1's
bar (Decision D-5).

## Decisions

- **D-1 — Deliverable 4 splits into D4a (readout) and D4b (decision).**
  Ratified (Drew, 2026-08-31). D4a ships the seal act + `descriptive_v1`
  reporting; D4b ships `release_gate_v1` (Fisher exact + independent
  cross-check, MDE rendering, determinate-n floors, tripwires incl. the
  completion-collapse rule, seal-time UNDERPOWERED-or-INVESTIGATE minting,
  adjudication entries, the supersedes/errata chain) plus the gating report
  branch and the `campaign list`/`campaign status` verbs (Decision D-9,
  §Hand-off). Rationale (revision 2): the split de-risks D4b and reaches live
  exploratory campaigns fastest; it is NOT a shortcut to qualification (D-7).
  The parent named deliverable 4 as one unit; the split is recorded here per
  the program's sequencing convention (cf. the `budget_raise` deferral, D3PR).

  Amendment (revision 3, 2026-09-04, per PAR revision 3): D4b trims to
  the decision core — the gating seal path (gating campaigns seal as
  exploratory ones do; the D4a refusal is deleted), a fold branch
  computing the pre-registered grid (Fisher, floors, MDE, the tripwire
  table), tripwire ruling as one append-only journal event with a
  journaled superseding re-render, and the `campaign list`/`status`
  verbs. Cut as speculative: the general supersedes/errata apparatus (no
  errata event has ever occurred; corrections land in the experiment
  log), tags/declared-metrics aggregation (no consumer), and the second
  live Fisher implementation (independently generated golden tables carry
  the cross-check). The verdict remains a computed readout; it binds no
  release (PAR revision 3). Correction (2026-09-04, per the D4b round-1
  review, fable C1 / k3 C5): D-9's named empty report section STAYS —
  deleting it would change every descriptive render and trip the tamper
  guard on the already-sealed D4a campaigns. The cut is the aggregation
  machinery, not the section heading.

- **D-2 — All statistics defer to D4b.** Ratified (Drew, 2026-08-31). D4a
  renders rates and signed deltas only; per-cell Fisher exact (PAR §"Report
  engine", vocabulary item 1), MDE, and the cross-check requirement land with
  D4b. Schema grounding, stated precisely (round-1 finding B5): the shipped
  `ReportSchema` makes `fisher_p`, `mde`, and `delta` optional per cell
  (`src/contracts/campaign/report.ts`) — statistics-less cells are schema-
  legal today. Rates and medians are NOT optional-but-absent; they are
  absent-full-stop and join via the D-8 amendment. Until D4b, descriptive
  reports carry the `DESCRIPTIVE` stamp prominently — no rendered quantity
  may be read as a decision. Vocabulary deferral, never change: D4b adds
  statistics to the same closed vocabulary.

- **D-3 — `campaign run` owns the seal act.** Ratified (Drew, 2026-08-31).
  The dispatch loop seals when the predicate holds, before exit; the resume
  path completes a seal act a crash interrupted (the R-RCV-5 hand-off already
  detects the window: `src/campaign/recovery.ts` — "resume: the
  instance-complete seal predicate holds with no `sealed` event — report
  regeneration is owed"). Resume semantics are pinned in §The seal act.
  `quorum campaign report` is a journal-read-only verb with deterministic
  artifact publication (it materializes a missing `report.json`/`report.md`;
  it never journals). Rejected alternative: sealing inside `report` would put
  a write act inside the verb PAR defines as a deterministic read, and would
  leave finished campaigns unsealed until a human asks — "done" must not be
  observer-dependent. No new CLI verb: `report` is named by PAR §"Report
  engine"; a dedicated `seal` verb would contradict the pinned CLI table
  (D3PR open-item rationale; pinned table: D3 §registration CLI
  option/default table; shipped `src/cli/index.ts` — positional-only `run`).

- **D-4 — The seal-time contention backstop mints the two ratified
  dispositions.** Revision 2 (round-1 blocker B2): `contention_invalidated`
  ONLY for blocks the evaluator verdicts `invalid` from a breach still open
  at campaign end; `unknown_coverage` for blocks verdicts `unknown` from
  uncovered intervals — exactly D3's ratified OQ-11 narrowing (D3 §Open
  items; §Interfaces handed to D4; the evaluator's own pin "uncovered overlap
  -> unknown (NEVER contention)", `src/campaign/contention.ts`). Revision 1's
  single-disposition collapse was a drafting error, not a ratified deviation
  (D4R ledger). Both classes drop from comparison denominators — contention
  is an instrument-integrity matter, kind-blind in exploratory campaigns
  exactly as in gating ones, consistent with D3's kind-blind dispatch-time
  resolution (`resolveClosedWindow`, `src/campaign/dispatcher.ts`); the
  PAR's caveat regime is pinned for **skew** in exploratory campaigns (PAR
  §"Execution"; D3 R-DSP-9), and PAR never extended it to contention. Both
  classes are named separately in the accounting (D-8 counters).

- **D-5 — Two live runs close the owed campaigns; no subsumption.** Revision
  2 (round-1 blocker B3): revision 1's "one run proves both" claim is
  retracted — D3 §Exit criteria item 1 pins "a registered small **gating**
  suite", and one campaign cannot be both kinds (`src/contracts/campaign/suite.ts`
  bijection). D4a's exit runs BOTH in one appliance session: (1) an
  exploratory campaign through the full terminus to `sealed` + published
  report (D4a's own proof); (2) a small gating suite to predicate-holds —
  which closes D3 §Exit criteria item 1 exactly as pinned, its seal/report
  awaiting D4b by D3's own wording ("D4's report act follows on its own
  deliverable"). Recorded in the D4a experiment-log entry and stamped on the
  D3 record. D3's remaining debt is listed in §Exit criteria.

- **D-6 — The `budget_raise` operator surface stays deferred.** Carried over
  from D3PR (DECIDED, Drew 2026-08-27): D3 shipped the consumer side dormant;
  D4a renders the budget/amendment trail but adds no append surface. Revisit
  only with operator evidence from the first campaigns.

- **D-7 — Qualification stays gating; no parent amendment.** Ratified (Drew,
  2026-08-31, post round-1 review). The parent's qualification campaign stays
  "registered like any gating campaign but not release-binding" (PAR
  §"Qualification before the first gate"), exercising skew exclusion and
  reserve draw — gating-only machinery the rehearsal exists to practice.
  Consequence: D4b is on the qualification critical path; D4a is repositioned
  per §Purpose. Rejected alternative: an exploratory-registered qualification
  would reach sealing under D4a but cannot practice skew exclusion/refill —
  the failure mode the parent's "$650 discredited gate followed by the $850
  re-gate" receipt exists to prevent.

- **D-8 — Additive `ReportSchema` amendment (D1 erratum, D4a-scoped).**
  Adopted 2026-08-31 from round-1's unanimous blocker B5 (D4R ledger). The
  shipped schema is `.strict()` and cannot carry PAR's descriptive vocabulary
  items; D4a amends it additively (no existing field changes;
  `REPORT_RENDERING` constants re-affirmed):
  - cells gain `pass` and `fail` (non-negative integers) and `coverage`
    (finite, 0–1) — rates derive deterministically and render in `report.md`
    (PAR: "every number carries n, denominator, coverage, and cell class");
  - comparisons gain `medians: { tokens?, usd? }` (finite, optional) — token
    and dollar medians over matched determinate cells (per comparison);
  - accounting gains `contention_invalidated` and `unknown_coverage`
    counters (non-negative integers) alongside the D1 eight;
  - provenance gains `failed_cells` (array of
    `{ comparison_id, scenario, reason }`, strict) and `grader.observed`
    becomes optional — absence is the pinned empty-evidence case, rendered
    loud (§The report engine, item 4), never a terminus wedge.

- **D-9 — Tags/declared-metrics defer to D4b.** Adopted 2026-08-31 (D4R
  ledger). PAR names them descriptive vocabulary item 4, but no schema home
  exists, no aggregation registry is pinned (PAR's `aggregation` is an
  unrestricted string), and the values' sources (suite declarations + check
  records, NOT scenario frontmatter — `src/contracts/campaign/suite.ts`,
  `src/contracts/verdict.ts`) need their own contract work. D4a renders the
  deferral in `report.md` (a named empty section); D4b lands the section with
  a pinned aggregator set. Same staging convention as Fisher (D-2): the
  vocabulary stays closed and named; delivery stages.

## Scope

In scope for D4a:

- The seal act (§The seal act), owned by `campaign run` (D-3).
- The descriptive report engine (§The report engine): `descriptive_v1` fold +
  byte-stable `report.md`/`report.json` publication + human rendering.
- The D-8 `ReportSchema` amendment.
- Regeneration discipline (§Regeneration).
- The `quorum campaign report` verb (§CLI).
- Golden-oracle + crash-window + refusal tests (§Testing).

Out of scope, named:

- Everything in D4b (D-1/D-2): statistics, floors, tripwires, verdicts, the
  gating report branch, adjudication entries beyond the contention backstop,
  the supersedes/errata chain (D4a reports carry no `supersedes` and empty
  `errata`), tags/declared-metrics (D-9), `campaign list`/`campaign status`
  (§Hand-off).
- The `budget_raise` append surface (D-6).
- Dashboard campaign views — deliberately absent per PAR §"Report engine"
  (decision, Drew 2026-08-17).

## The seal act

Performed by `campaign run` when the E7 instance-complete seal predicate holds
(all samples terminal, dispositions settled, supersession conservation
satisfied — D3). **Gating campaigns refuse here**: predicate-holds +
`profile: release_gate_v1` is a typed loud refusal — "sealing gating campaigns
awaits D4b" — and the campaign remains at predicate-holds (Decision D-5,
closing D3 item 1). For exploratory campaigns, the terminus sequence, in
pinned order:

1. **Pre-seal snapshot verify.** `verifyCampaignSnapshot`
   (`src/campaign/snapshot.ts`; D3 comments pin "D4 invokes pre-seal") over
   the campaign-local materialization against the registered digests. Drift
   at the terminus is a **refuse-to-seal**, loud, naming the drifted trees.
   No block reruns exist at the terminus; authorized tree repair on a
   subsequent resume remains D3's mechanism (`repairDriftedTrees`). The
   re-run after repair is the operator-acknowledgement act; the drift
   incident is recorded at the eventual seal via an `adjudication` rationale
   (D3 D-11's seal-time recording pin) so the incident never vanishes from
   the sealed record.
2. **Seal-time integrity audit** (D3 Decision D-5's first seal-time role).
   The shared evaluator re-compares available sidecar evidence against
   closed-window landed mints: a recompute mismatch is a **corruption-class
   integrity finding** — recorded loud, never a disposition reversal; sidecar
   evidence lost after a mint is an **attribution caveat**. Both classes
   render in `report.md` and the accounting.
3. **Seal-time contention backstop** (D-4, D3 D-5's second seal-time role).
   `evaluateContention` re-reads the durable sidecar with the journal's real
   `campaign_opened` ts and `lastTerminalTsMs` = the final terminal ts;
   blocks verdicted `invalid` receive `contention_invalidated` adjudications,
   blocks verdicted `unknown` receive `unknown_coverage` adjudications — one
   `adjudication` event per block through the sealer-writer, block identity
   riding the rationale in the pinned encoding `block=<block_id>; <detail>`
   (per the `attemptScopedRationale` convention,
   `src/contracts/campaign/journal-events.ts` — a reader never has to guess).
   Dedupe: a block whose encoded adjudication already exists is skipped, so
   crash-and-resume never duplicates a disposition. Both classes leave the
   comparison denominators; both are named in the accounting (D-8 counters).
   No refill exists at the terminus — reduced n is the honest outcome,
   rendered loudly.
4. **Render the fold in memory** (§The report engine) to the canonical
   `report.json` bytes, schema-validated (D-8 schema) — fold input is the
   journal up to BUT NOT INCLUDING the `sealed` event, so no digest cycle.
5. **Digest + write `sealed`.** `report_digest` = SHA-256 (lowercase hex,
   64 chars — the shipped `SealedEvent` grammar) of the canonical
   `report.json` bytes; appended via the restrict-mode sealer-writer
   (`electWriter({ restrict: ['adjudication', 'sealed'] })`, R-JRN-3
   hand-off). State machine: `running → sealing → sealed`. The journal then
   accepts no dispatch events (the state machine admits no transitions out of
   `sealed`; §Testing pins a proof).
6. **Publish.** `report.md` first, `report.json` last as the completion
   marker (PAR §"Execution" → "Sealing") — each via temp-file + fsync +
   atomic rename; the human-readable rendering also goes to stdout.

**Crash windows.** Every cut is resumable via the R-RCV-5 hand-off on the
resume path, idempotently: died after verify → re-verify; mid-adjudications →
re-evaluate, dedupe by encoded rationale, continue; after `sealed` before
publication → **resume completes publication and exits clean** (digest-
verified — never refused: a sealed-without-report campaign is owed its
report); mid-publication → orphan temps removed, publication re-attempted,
digest-verified. Resume against a sealed campaign WITH its report refuses,
citing the sealed state (guidance: `campaign report` regenerates/verifies).
Resume against a cancel marker refuses citing the cancel-request (D3).

**Storage and concurrency at the terminus.** ENOSPC mid-terminus inherits
D-13's fail-stop discipline: the writer enters `storage_paused`; `sealed`
never lands during pause; resume re-attempts after remediation. Every
terminus step checks the cancel marker before acting — a cancel requested
mid-terminus wins: the campaign never seals, the pinned D-12 cancel order
completes. Temp-file cleanup on resume is pinned above.

## The report engine

`quorum campaign report` folds the journal plus the referenced immutable run
dirs into the D1 `ReportSchema` as amended by D-8 (descriptive branch:
`stamp: 'DESCRIPTIVE'`, no verdict slot — enforced by the schema
superRefine). Deterministic over those inputs per PAR §"Report engine";
byte-stability per the D1 `REPORT_RENDERING` constants (sorted keys,
shortest-round-trip doubles, LF).

**Evidence authorities (pinned source table).** Fold inputs are exactly: the
journal (events before `sealed`); `campaign.json`; and per included attempt's
run dir — `verdict.json` (final verdict + economics), `trajectory.json`
(observed models, exposure), the frozen token-usage sidecar (tokens/costs),
and the Gauntlet `result.json` (grader identity: its recorded config model).
Precedence within a source is the source's own contract; a malformed or
missing authority is fail-closed: the affected sample joins its typed class
(instrument-failed / indeterminate) and is counted in the accounting — never
silently dropped, never fabricated.

**Input allowlist.** Nothing outside the table above is a report input.
Append-only additions elsewhere in a run dir (future errata material is D4b's
contract) cannot alter regeneration output; tamper detection is
digest-anchored (§Regeneration), so legitimate additions never false-positive.

The fold, per comparison:

1. **Included set.** Derived from the journal's materialized state — the
   sealer's restrict list cannot write `sample_disposition`, and D3 pins
   `included` as never-required (derivation, not journaling, D3 §Interfaces).
   Primary-slot block instances: successors where a replacement landed;
   superseded instances excluded with their `superseded_by` refs cross-
   checked — one included outcome per primary slot is the conservation rule
   the report proves. Dispositions honored: `contention_invalidated`,
   `unknown_coverage`, instrument-failed, and indeterminate samples never
   silently vanish — each class is counted in the accounting (D-8 counters
   name the two contention classes separately) and named.
2. **Rates.** Per cell: `n`, `pass`, `fail`, `coverage` (determinate over
   total) per arm over determinate samples (verdict `pass`/`fail`); rates
   render in `report.md`/stdout with their n and denominator on every number.
   Signed delta (treatment − baseline) per two-arm cell — descriptive only
   (D-2). **Single-arm comparisons** (schema-legal descriptive/qualification
   units): per-arm rates render without a delta (`delta` absent —
   schema-legal); medians over that arm's determinate samples.
3. **Medians.** Token and dollar medians per comparison over matched
   determinate cells (PAR's wording), sourced from the frozen terminal
   evidence bundles. Unpriced arms render **tokens-only with a named coverage
   caveat** (PAR §"Report engine" — exploratory only; gating rejects unpriced
   arms at registration). Missing price data is fail-closed: a sample without
   a complete terminal bundle contributes to no median and is counted where
   its class belongs.
4. **Provenance.** Validated **per run**: each included sample's trajectory
   must contain its arm's registered model; a sample whose observed set lacks
   it is a provenance failure of its cell — cells with failures are marked in
   `provenance.failed_cells`, excluded from rate/median aggregation, and
   rendered loudly. Model identities compare on the **native id**: a
   Bedrock/Mantle credential registers the vendor-prefixed request id
   (`anthropic.claude-opus-4-8`) while the transcript records the native id
   the API answered with (`claude-opus-4-8`) — the same model, not a
   mismatch; observed sets still render verbatim. The per-arm observed model **union** (a set, never a
   singular field — codex parents routinely invoke subagent models, PAR
   §"Report engine") is drawn from every sample with a trajectory, included
   or not (invalidated-but-ran samples still ran), and renders for display.
   Grader: registered credential/model vs the observed grader identity from
   the Gauntlet `result.json` config model; a mismatch fails every cell the
   grader graded, loudly. **Empty evidence:** a campaign with no Gauntlet
   identity at all (e.g., every sample instrument-failed before grading)
   renders `grader.observed` absent (D-8 nullable) plus a pinned loud caveat
   — the terminus never wedges on an empty-evidence campaign.
5. **Accounting block** — always rendered, never elidable (PAR §"Report
   engine"): instrument errors, indeterminates, replacements, reserve draws,
   skew exclusions and caveats (exploratory skew is caveat-only per D3
   R-DSP-9, so exclusions render 0 in D4a — the field exists for D4b),
  `contention_invalidated`, `unknown_coverage` (D-8), budget events,
   amendments, and per-cell denominators. This block is the surface PAR's
   reliability bar reads (PAR §"Typed failures", acceptance bar).
6. **Tags/declared-metrics.** Deferred to D4b (D-9): `report.md` renders a
   named empty section ("deferred to D4b — no aggregation registry pinned").

`cannot_answer` is always empty in D4a (MDE belongs to D4b).

## Regeneration

`report.md`/`report.json` are regenerable from the sealed inputs with
**per-host byte-stability** (PAR §"Report engine" — the parent's pin; no
stronger cross-host claim is made). Discipline:

- The trust anchor is the journaled `sealed.report_digest`. `campaign report`
  re-renders from the pinned input allowlist and compares the regenerated
  canonical bytes' SHA-256 against the journaled digest: match → success;
  divergence → **loud evidence-tampering incident** naming the divergence.
  Never a silent overwrite. This distinguishes "inputs moved" from
  "report.json moved": the digest sits inside the sealed journal, not on
  disk next to the artifact.
- Against a sealed campaign missing either artifact, the verb republishes
  (digest-verified). Against an unsealed campaign, it refuses with PAR's
  pinned diagnostic (§CLI).
- The terminus step 4–6 renderer and this verb share one code path; there is
  exactly one implementation that produces the artifacts.

## CLI

- **`quorum campaign run`** gains the terminus sequence. No new options — the
  pinned table stands (`run` takes no options in v1; D3 §registration CLI
  option/default table; shipped `src/cli/index.ts` positional-only).
- **`quorum campaign report <campaign-dir>`** — new verb, named by PAR
  §"Report engine". No options in v1 (YAGNI; options accrue only with
  operator evidence, per the D-6 rationale). Behavior: sealed + artifacts
  present → digest-verified regeneration; sealed + artifacts missing →
  republication; unsealed → **prints exactly which samples block sealing and
  why** (PAR §"Execution" → "Sealing"), non-zero exit; gating campaign →
  typed refusal "sealing/reporting gating campaigns awaits D4b".

## Refusal table

| Condition | Behavior |
|---|---|
| Seal: gating campaign at predicate-holds | Typed loud refusal — "sealing gating campaigns awaits D4b"; campaign stays at predicate-holds |
| Seal: snapshot drift at terminus | Refuse to seal; fail loud naming drifted trees; drift incident recorded at eventual seal via adjudication rationale |
| Seal: campaign not registered/published | Typed refusal (existing registration errors) |
| Seal: cancel marker present | Cancel wins; the campaign never seals; D-12 order completes |
| Resume: sealed without artifacts | Complete publication, digest-verified, exit clean (never refuse) |
| Resume: sealed with artifacts | Refuse, citing the sealed state; guidance: `campaign report` regenerates |
| Resume: cancel marker | Refuse, citing the cancel-request (D3) |
| Report: campaign not sealed | Print exactly which samples block sealing and why (PAR pin) |
| Report: regenerated digest diverges from journal | Loud evidence-tampering incident; never overwrite |
| Report: schema-invalid fold output | Refuse to write (validated before write) |
| Report: gating campaign | Typed refusal — "sealing/reporting gating campaigns awaits D4b" |

## Testing

The repo's discipline: no mocked-behavior tests.

- **Golden oracles** over synthetic journal + run-dir fixtures (extending
  D3's fixture builders): full fold → byte-exact expected `report.md` and
  `report.json`, covering replacements/supersession, both contention
  dispositions, the integrity audit's two outcome classes, skew caveats,
  unpriced arms, provenance mismatch (per-cell: arm-model and grader),
  single-arm comparisons, missing-profile exploratory suites, the empty-
  evidence grader case, and zero-determinate cells.
- **Digest round-trip**: render → digest → `sealed(report_digest)` →
  regenerate → digest-equal, including the sealed-without-artifacts crash
  window.
- **Byte-stability**: repeated renders byte-identical per host; serialization
  honors `REPORT_RENDERING` exactly; the post-`sealed` journal rejects
  dispatch events (state-machine proof).
- **Seal-act crash-window matrix**: every cut of the terminus sequence resumes
  idempotently to the same journal suffix and the same artifact bytes — no
  duplicated adjudications, no double seal, orphan temps cleaned.
- **Storage/concurrency**: ENOSPC mid-terminus enters `storage_paused`
  without landing `sealed`, resumes after remediation; cancel requested at
  every terminus step wins.
- **Refusal matrix**: every row of the refusal table.
- **Cross-check requirement status**: the Fisher independent-implementation
  cross-check (PAR §"Report engine") is a D4b obligation (D-2); D4a ships no
  statistics. Named here so review gates see the deferral, not a gap.

## Exit criteria

- `bun run check` and `bun run quorum check` green on the merge commit (the
  full portable hermetic matrix).
- Golden-oracle + digest-round-trip suites green in the portable matrix.
- **Live runs** (trusted-maintainer, appliance; nothing to public CI per PAR
  safe-checks doctrine), one session, recorded in the D4a experiment-log
  entry:
  1. **Exploratory lifecycle:** a registered small exploratory suite runs
     registration → dispatch → all-samples-terminal → terminus → `sealed` +
     published artifacts, with digest-verified regeneration proven on
     re-render. (D4a's own proof.)
  2. **Gating completion:** a registered small **gating** suite runs to
     predicate-holds and receives the typed D4a refusal — **this closes D3
     §Exit criteria item 1 as pinned** (Decision D-5); its seal/report await
     D4b.
  3. **Terminus crash:** kill mid-terminus-sequence; `campaign run` resumes
     and completes seal + publication idempotently (same journal suffix,
     digest-equal artifacts). Recommended economy: back-to-back with D3's
     owed crash-resume campaign (D3 item 2) — different crash windows
     (mid-block vs mid-terminus), separately recorded.
- After exit: flip this spec's status line to `implemented (main @ <merge
  commit>)` — the D2/D3 convention (D3P §Task 9c Step 12), a status stamp,
  never a semantic edit.

**D3 debt after D4a ships** (the verification/confirmation runs): D3 item 2
(crash-resume campaign), item 3 (cancel-and-refuse-resume campaign), the
Linux-gated integration matrix (`test/integration/` does not exist yet; D3P
§"Trusted-maintainer validation" lists its 13 asserted-not-proven debt
items), and the D3 spec status stamp. Item 1 closes via exit run 2 (D-5).

## Hand-off to D4b

**Trimmed (revision 3, 2026-09-04):** the enumeration below is the
pre-reframe hand-off, kept as the record. What D4b actually ships is the
decision core listed in D-1's revision-3 amendment; the errata chain,
tags/declared-metrics, and the `budget_raise` surface do not transfer.

D4b (`release_gate_v1` — a separate spec) plugs into seams D4a establishes:

- **Profile dispatch seam** in the report fold: the descriptive branch is one
  arm of a per-profile dispatch; D4b adds the gating branch (Fisher +
  cross-check into the optional `fisher_p`/`mde` cell fields, floors,
  tripwires, the three-valued verdict, `cannot_answer`).
- **The gating terminus refusal becomes the gating seal path** — same
  predicate, same audit/backstop mechanics (profile-agnostic by D-3), gating
  report branch.
- **Tags/declared-metrics** (D-9): schema home + pinned aggregator set.
- **`campaign list` and `campaign status`**: D3 handed all three verbs
  (`report | list | status`) to deliverable 4 (D3 §Interfaces); D4a ships
  `report` only. D4b lands `list` and `status` — PAR's "mid-run surface of
  record" (PAR §"Report engine"), including its pre-seal amendment guard
  (PAR §"Execution"). Until then, seal state is readable by direct journal
  inspection only; no operator verb exists.
- **Adjudication vocabulary** beyond the contention backstop (tripwire
  firings, UNDERPOWERED-or-INVESTIGATE minting) and the supersedes/errata
  amendment chain (schema already shipped by D1, dormant in D4a).
- **The deferred `budget_raise` append surface** (D-6), revisited with
  operator evidence.

## Revision history

- **Revision 1** (2026-08-31, @ `b6d31b7`): initial spec from the
  brainstorming session; ratified decisions D-1…D-6.
- **Revision 2** (2026-08-31): post round-1 four-seat review (D4R) — five
  converged blockers fixed (seal order + digest anchoring; the two ratified
  backstop dispositions restored; subsumption retracted for two live runs;
  qualification decision D-7 recorded; ReportSchema amendment D-8); the
  criticals bundle landed (integrity audit, publication discipline, unsealed
  diagnostic, adjudication identity encoding, gating refusals, provenance
  per-run validation, evidence allowlist, storage/concurrency pins,
  list/status assignment, resume semantics, drift-incident recording,
  profile/single-arm rendering); tags/deferred via D-9; minors fixed
  (per-host byte-stability wording, 20+1 event attribution, CLI citations,
  "matched determinate cells" vocabulary).
- **Revision 3** (2026-09-04): post-implementation scope amendment per PAR
  revision 3 — D4b trimmed to the decision core (D-1 amendment, §Hand-off
  trim note); release-binding framing retired. No change to what D4a built
  or to the revision-2 implementation stamp.
