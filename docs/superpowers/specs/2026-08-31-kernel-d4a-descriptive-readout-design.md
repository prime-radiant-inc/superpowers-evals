# Kernel Deliverable 4a — Descriptive Readout (seal act + report engine): Design

**Date:** 2026-08-31 (revision 1)
**Status:** draft — awaiting review
**Parent spec:** `docs/superpowers/specs/2026-08-17-quorum-campaign-platform-design.md`
  (the campaign platform design; "the parent" below)
**Prerequisites:**
  - Kernel D1 contracts (merged to main @ `41b9e2b`; spec
    `docs/superpowers/specs/2026-08-24-kernel-d1-contracts-design.md`) —
    `ReportSchema`, `REPORT_RENDERING` byte-stability constants, suite/profile
    compatibility refinements, the 21-event journal vocabulary including
    `adjudication` and `sealed`.
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

## Purpose and place in the program

The parent's order of operations item 3 (kernel build) names four deliverables
in fixed order: contracts → provisioning + instrument snapshot → dispatcher +
journal + locks → **profiles + report engine** (PAR §"Coexistence and
sequencing" → "Order of operations"). D1–D3 shipped the first three. This
document specs deliverable 4 — split into two increments, D4a (this spec) and
D4b (a later spec) — per Decision D-1, ratified by the user 2026-08-31 to reach
live qualification testing with the smallest honest increment.

D3 ends campaigns at "all samples terminal + the E7 instance-complete seal
predicate holds" (D3 §Exit criteria, completion campaign). D4a is the increment
that converts *finished* into *closed evidence*: it performs the seal act
(pre-seal snapshot verify → seal-time contention backstop → `sealed` via the
restrict-mode sealer-writer), then renders the **descriptive report** —
`quorum campaign report` — deterministically over the journal plus the
referenced immutable run dirs (PAR §"Report engine").

**Boundary settled by pinned code, not by this spec:** gating suites require
`profile: release_gate_v1` (`src/contracts/campaign/suite.ts` superRefine, D1).
D4a therefore serves **exploratory campaigns only**; a gating suite cannot
register against D4a's surface. The report schema's gating branch
(verdict-bearing, stampless) stays schema-legal but unreachable until D4b
ships `release_gate_v1`.

## Decisions

- **D-1 — Deliverable 4 splits into D4a (readout) and D4b (decision).**
  Ratified (Drew, 2026-08-31). D4a ships the seal act + `descriptive_v1`
  reporting; D4b ships `release_gate_v1` (Fisher exact + independent
  cross-check, MDE rendering, determinate-n floors, tripwires incl. the
  completion-collapse rule, seal-time UNDERPOWERED-or-INVESTIGATE minting,
  adjudication entries, the supersedes/errata chain). Rationale: qualification
  (PAR §"Qualification before the first gate") precedes the first gating
  campaign and needs the readout — accounting block, provenance, rates — but
  nothing acts on significance statistics there; D4b keeps the entire
  qualification window as slack. The parent named deliverable 4 as one unit
  ("profiles + report engine"); the split is recorded here as the program's
  sequencing convention requires (cf. the `budget_raise` deferral, D3PR).

- **D-2 — All statistics defer to D4b.** Ratified (Drew, 2026-08-31). D4a
  renders rates and signed deltas only; per-cell Fisher exact (PAR §"Report
  engine", vocabulary item 1), MDE, and the cross-check requirement land with
  D4b. The D1 `ReportSchema` already permits this: `fisher_p`, `mde`, and
  `delta` are optional per cell. Until D4b, descriptive reports carry the
  `DESCRIPTIVE` stamp prominently — no rendered quantity may be read as a
  decision. This is a vocabulary deferral, never a vocabulary change: D4b adds
  the statistics to the same closed descriptive vocabulary; nothing new is
  invented then.

- **D-3 — `campaign run` owns the seal act.** Ratified (Drew, 2026-08-31).
  The dispatch loop seals when the predicate holds, before exit; the resume
  path completes a seal act a crash interrupted (the R-RCV-5 hand-off already
  detects the window: `src/campaign/recovery.ts` — "resume: the
  instance-complete seal predicate holds with no `sealed` event — report
  regeneration is owed"). `quorum campaign report` is a pure read that refuses
  unsealed campaigns. Rejected alternative: sealing inside `report` would put
  a write act (adjudications change dispositions) inside the verb PAR defines
  as a deterministic read, and would leave finished campaigns unsealed until a
  human asks for output — "done" must not be observer-dependent. No new CLI
  verb is introduced: `report` is named by PAR §"Report engine"; a dedicated
  `seal` verb would contradict the pinned CLI table the same way inventing a
  fourth D3 verb would (D3PR, open-item rationale).

- **D-4 — The seal-time contention backstop is kind-blind invalidation.**
  Ratified (Drew, 2026-08-31). Blocks the shared evaluator verdicts `invalid`
  (known-breach overlap still open at campaign end) or `unknown` (uncovered
  interval — sampler gap, torn tail, zero evidence) receive
  `contention_invalidated` adjudications at seal, in exploratory campaigns
  exactly as in gating ones. Rationale: D3's dispatch-time resolution of
  closed breach windows is already kind-blind (no `suite.kind` branch in the
  `resolveClosedWindow` path, `src/campaign/dispatcher.ts`); the PAR's
  caveat-regime pin is for **skew** in exploratory campaigns (PAR §"Execution";
  D3 R-DSP-9), and PAR never extended it to contention. Contention distorts
  exactly what exploratory campaigns measure (durations, costs, behavior), so
  the backstop applies one doctrine at the terminus: drop what cannot be
  vouched for, name every drop in the accounting. Timing must not decide
  honesty — a block under a still-open breach at campaign end is treated
  identically to one under a closed window mid-run.

- **D-5 — D4a's exit campaign subsumes D3's owed completion campaign.**
  Ratified (Drew, 2026-08-31). D3 §Exit criteria item 1 (a registered small
  suite run through registration → dispatch → all-samples-terminal → seal
  predicate holds) is strictly contained in D4a's exit item 3 (the same
  lifecycle taken through `sealed` + report). One live campaign proves both;
  recorded in the D4a experiment-log entry and stamped onto the D3 spec status
  line when D3's remaining debt closes. D3's other owed items are NOT
  subsumed and remain D3's debt (see §Exit criteria below): the crash-resume
  campaign (item 2), the cancel-and-refuse-resume campaign (item 3), the
  Linux-gated integration matrix, and the D3 spec status stamp.

- **D-6 — The `budget_raise` operator surface stays deferred.** Carried over
  from D3PR (DECIDED, Drew 2026-08-27): D3 shipped the consumer side dormant;
  D4a renders the budget/amendment trail but adds no append surface. Revisit
  only with operator evidence from the first campaigns.

## Scope

In scope for D4a:

- The seal act (§The seal act), owned by `campaign run` (D-3).
- The descriptive report engine (§The report engine): `descriptive_v1` fold +
  byte-stable `report.json` + human-readable rendering.
- Regeneration discipline (§Regeneration).
- The `quorum campaign report` verb (§CLI).
- Golden-oracle + crash-window + refusal tests (§Testing).

Out of scope, named:

- Everything in D4b (D-1/D-2): statistics, floors, tripwires, verdicts,
  adjudication entries beyond the contention backstop, the supersedes/errata
  chain (D4a reports carry no `supersedes` and empty `errata`).
- The `budget_raise` append surface (D-6).
- Dashboard campaign views — deliberately absent per PAR §"Report engine"
  (decision, Drew 2026-08-17; campaign-reading surfaces build on the
  export-adapter side).
- `campaign status` changes: seal state is readable from the journal today;
  D4a adds nothing to the mid-run surface.

## The seal act

Performed by `campaign run` when the E7 instance-complete seal predicate holds
(all samples terminal, dispositions settled, supersession conservation
satisfied — D3). The terminus sequence, in pinned order:

1. **Pre-seal snapshot verify.** `verifyCampaignSnapshot`
   (`src/campaign/snapshot.ts`; D3 comments pin "D4 invokes pre-seal") over
   the campaign-local materialization against the registered digests. Drift at
   the terminus is a **refuse-to-seal**: the campaign ends unsealed, the run
   fails loud naming the drifted trees. There is no repair-and-rerun at the
   terminus (D3's D-11 repair order is a mid-run mechanism — at campaign end
   no blocks remain to rerun). The operator resolves the drift source and
   resumes; the terminus sequence re-attempts from the top.
2. **Seal-time contention backstop** (D-4). The shared pure evaluator
   (`evaluateContention`, `src/campaign/contention.ts`) re-reads the durable
   sidecar with the journal's real `campaign_opened` ts and `lastTerminalTsMs`
   = the final terminal ts; blocks verdicted `invalid` or `unknown` that were
   not already resolved mid-run receive one `adjudication` event each
   (`contention_invalidated`), appended through the sealer-writer. Idempotent
   on re-entry: the act checks journaled adjudications per block before
   appending, so a crash-and-resume never duplicates a disposition. Invalidated
   blocks' samples leave the comparison denominators and are named in the
   accounting (§The report engine). No refill exists at the terminus — the
   campaign is over; reduced n is the honest outcome, rendered loudly.
3. **Write `sealed`** through the restrict-mode sealer-writer
   (`electWriter({ restrict: ['adjudication', 'sealed'] })`,
   `src/campaign/journal.ts` — the R-JRN-3 hand-off). State machine:
   `running → sealing → sealed` (D3 replay already models the `sealing`
   transition). After this event the journal accepts no dispatch events and
   resume refuses, citing the sealed state.
4. **Render `report.json`** (§Regeneration) as the final terminus step, so a
   campaign that finished is also reported without a second operator gesture.

**Crash windows.** Every cut of the sequence is resumable, idempotently, via
the R-RCV-5 hand-off on the resume path: died after verify → re-verify; died
mid-adjudications → re-evaluate, dedupe, continue; died after `sealed` but
before `report.json` → regenerate (determinism makes regeneration exact,
§Regeneration). One recovery notice covers the whole tail: predicate holds
without `sealed` means the terminus sequence is owed; `sealed` without
`report.json` means regeneration is owed.

## The report engine

`quorum campaign report` folds the journal plus the referenced immutable run
dirs into the D1 `ReportSchema` (descriptive branch: `stamp: 'DESCRIPTIVE'`,
no verdict slot — enforced by the schema superRefine). Deterministic over
those inputs per PAR §"Report engine"; byte-stability per the D1
`REPORT_RENDERING` constants (sorted keys, shortest-round-trip doubles, LF).

The fold, per comparison:

1. **Included set.** Primary-slot block instances (successors where a
   replacement landed; superseded instances excluded with their
   `superseded_by` refs cross-checked — one included outcome per primary slot
   is the conservation rule the report proves). Dispositions honored:
   `contention_invalidated`, instrument-failed, and indeterminate samples
   never silently vanish — each class is counted in the accounting and named.
2. **Rates.** Per-cell pass/fail counts and rates per arm over determinate
   samples (verdict `pass`/`fail`), with n and denominator on every number.
   Signed delta (treatment − baseline) per cell — descriptive only (D-2): no
   significance quantity renders until D4b.
3. **Medians.** Token and dollar medians per comparison over matched
   determinate samples (paired within their block), sourced from the frozen
   terminal evidence bundles. Unpriced arms render **tokens-only with a named
   coverage caveat** (PAR §"Report engine" — exploratory only; gating rejects
   unpriced arms at registration). Missing price data is fail-closed: a sample
   without a complete terminal bundle contributes to no median and is counted
   where its class belongs.
4. **Provenance.** Per arm: the registered model vs the **observed model set**
   — the union of models recorded across the arm's ATIF trajectories (a set,
   never a singular field: codex parents routinely invoke subagent models, PAR
   §"Report engine"). Rule: the registered model must appear in the observed
   set; extra observed models are rendered, not failed. A missing registered
   model is a **loud provenance failure of the affected cells**: those cells
   are marked, excluded from rate/median aggregation, and named in the report
   and accounting. Samples without trajectories (typed instrument failures)
   contribute no observed models and are already accounted as instrument
   errors. Grader: the campaign's registered grader credential/model vs the
   observed grader identity from Gauntlet artifacts (D3 sensors attribute
   grader evidence to its producer); a grader mismatch fails every cell the
   grader graded, loudly.
5. **Accounting block** — always rendered, never elidable (PAR §"Report
   engine"): instrument errors, indeterminates, replacements, reserve draws,
   skew exclusions and caveats (exploratory skew is caveat-only per D3 R-DSP-9,
   so exclusions render 0 in D4a — the field exists for D4b), budget events,
   amendments, and per-cell denominators. This block is the surface PAR's
   reliability bar reads: the <5% indeterminate share of the qualification
   campaign is shown here (PAR §"Typed failures", acceptance bar).
6. **Tags and declared metrics.** Aggregated descriptively from scenario
   frontmatter via the scenario-meta contract where declared; absent
   declarations render an empty section, never invented quantities.

The rendered output is two artifacts: the canonical `report.json` (schema-
validated before it is written) and a human-readable rendering to stdout
(rates, deltas, accounting, provenance findings, the `DESCRIPTIVE` stamp).
`cannot_answer` is always empty in D4a (MDE belongs to D4b).

## Regeneration

`report.json` is regenerable byte-identically from the sealed inputs at any
time, on any host (PAR: sealed reports are deterministic over their run dirs;
pruning sealed-run dirs kills regeneration — that is why the parent's prune
guard never touches campaign-referenced runs). Discipline:

- `campaign report` against a sealed campaign with no `report.json` writes it.
- `campaign report` against a sealed campaign with a `report.json` re-renders
  from the inputs and byte-compares: identical → success; divergent →
  **loud evidence-tampering failure** naming the divergence. Never a silent
  overwrite: a sealed campaign's inputs are immutable, so divergence means
  something moved after sealing, and that is an incident, not a re-render.
- The terminus sequence's final step (§The seal act, step 4) and this verb
  share one renderer; there is exactly one code path that produces
  `report.json`.

## CLI

- **`quorum campaign run`** gains the terminus sequence. No new options — the
  pinned table stands (`run` takes no options in v1; D3P §Task 9c and D3
  §CLI).
- **`quorum campaign report <campaign-dir>`** — new verb, named by PAR
  §"Report engine". No options in v1 (YAGNI; options accrue only with
  operator evidence, per the D-6 rationale). Refusals: campaign dir absent or
  not a published campaign; campaign not sealed (cites the missing `sealed`
  event — "seal first via `campaign run`"); tampered inputs per §Regeneration.

## Refusal table

| Condition | Behavior |
|---|---|
| Seal: snapshot drift at terminus | Refuse to seal; fail loud naming drifted trees; resume re-attempts |
| Seal: campaign not registered/published | Typed refusal (existing registration errors) |
| Report: campaign not sealed | Refuse, citing the missing `sealed` event |
| Report: regenerated bytes diverge from existing `report.json` | Loud evidence-tampering failure; never overwrite |
| Report: provenance mismatch | Affected cells marked + excluded; rendered loudly (never silent) |
| Report: grader identity mismatch | Every graded cell failed, loudly |
| Report: schema-invalid fold output | Refuse to write (validated before write) |

## Testing

The repo's discipline: no mocked-behavior tests.

- **Golden oracles** over synthetic journal + run-dir fixtures (extending D3's
  fixture builders): full fold → byte-exact expected `report.json`, covering
  replacements/supersession, contention adjudications, skew caveats, unpriced
  arms, provenance mismatch (both arm-model and grader), empty edge cases
  (zero determinate samples in a cell; all samples invalidated).
- **Byte-stability**: the same fixture input renders byte-identically across
  repeated invocations; serialization honors `REPORT_RENDERING` exactly.
- **Seal-act crash-window matrix**: every cut of the terminus sequence (after
  verify; mid-adjudications; after `sealed` before `report.json`; mid-write)
  resumes idempotently to the same journal suffix and the same `report.json`
  bytes — no duplicated adjudications, no double seal.
- **Refusal matrix**: every row of the refusal table, including drift refusal
  and tamper detection.
- **Cross-check requirement status**: the Fisher independent-implementation
  cross-check (PAR §"Report engine") is a D4b obligation (D-2); D4a ships no
  statistics, so nothing to cross-check. Named here so review gates see the
  deferral, not a gap.

## Exit criteria

- `bun run check` and `bun run quorum check` green on the merge commit (the
  full portable hermetic matrix).
- Golden-oracle byte-stability suite green in the portable matrix.
- **Live campaign** (trusted-maintainer, appliance; nothing to public CI per
  PAR safe-checks doctrine): a registered small exploratory suite runs
  registration → dispatch → all-samples-terminal → seal act → `sealed` +
  `report.json`, with byte-identical regeneration proven on re-render. **Per
  Decision D-5 this campaign is simultaneously D3 §Exit criteria item 1 (the
  owed completion campaign); both specs' obligations close on this one run,
  recorded in the D4a experiment-log entry.**
- **Live crash at the terminus**: kill mid-terminus-sequence; `campaign run`
  resumes and completes seal + report idempotently (same journal suffix,
  same report bytes). Recommended economy: run back-to-back with D3's owed
  crash-resume campaign (D3 §Exit criteria item 2) in one appliance session —
  they exercise different crash windows (mid-block vs mid-terminus) and both
  remain separately recorded.
- After exit: flip this spec's status line to `implemented (main @ <merge
  commit>)` — the D2/D3 convention (D3P §Task 9c Step 12), a status stamp,
  never a semantic edit.

**D3 debt still owed after D4a ships** (the verification/confirmation runs):
D3 §Exit criteria item 2 (crash-resume campaign), item 3 (cancel-and-refuse-
resume campaign), the Linux-gated integration matrix (`test/integration/`
does not exist yet; D3P §"Trusted-maintainer validation" lists its 13
asserted-not-proven debt items), and the D3 spec status stamp. D4a closes
item 1 only, via D-5.

## Hand-off to D4b

D4b (`release_gate_v1` — a separate spec) plugs into seams D4a establishes:

- **Profile dispatch seam** in the report fold: the descriptive branch is one
  arm of a per-profile dispatch; D4b adds the gating branch (Fisher + cross-
  check into the optional `fisher_p`/`mde` cell fields, floors, tripwires,
  the three-valued verdict, `cannot_answer`).
- **The seal act is inherited unchanged**: pre-seal verify, backstop, and
  `sealed` write are profile-agnostic. D4b's seal-time additions (gating skew
  accounting at seal — dispatch-time exclusions already land mid-run per
  R-DSP-9; the completion-collapse tripwire) are adjudications and report
  quantities, not new lifecycle mechanics.
- **Adjudication vocabulary** beyond `contention_invalidated` (tripwire
  firings, UNDERPOWERED-or-INVESTIGATE minting) and the supersedes/errata
  amendment chain (schema already shipped by D1, dormant in D4a).
- **The deferred `budget_raise` append surface** (D-6), revisited with
  operator evidence.
