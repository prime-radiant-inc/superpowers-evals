# Kernel Deliverable 4b — Decision Readout (gating seal + `release_gate_v1` fold + operator verbs): Design

**Date:** 2026-09-04 (revision 2, post round-1 four-seat review)
**Status:** design — draft for review
**Review record:** `docs/experiments/2026-09-04-kernel-d4b-spec-review.md`
  (round 1: fable 5.1 / qwen / sol / k3 — four of four NOT-READY on
  revision 1; the converged spine and adjudications are recorded there)
**Parent spec:** `docs/superpowers/specs/2026-08-17-quorum-campaign-platform-design.md`
  (the campaign platform design, **revision 3** — "the parent" below)
**Prerequisites:**
  - Kernel D1 contracts (main @ `41b9e2b`) — this deliverable amends three
    of them (§Contract amendments); nothing in revision 1's prerequisite
    claim "the shipped schema is sufficient" survives review.
  - Kernel D4a (implemented, main @ `3cbb8d6`; revision 3 scope amendment at
    `f8e1889c`) — the seal act, the descriptive fold, deterministic
    publication, the tamper-guarded `campaign report`.
**Program ticket:** PRI-2874 umbrella (kernel build, order-of-operations
  item 3, deliverable 4 of 4 — second and final increment, D4b of D4a+D4b)

## Source aliases used in citations

| Alias | File |
|---|---|
| **PAR** | `docs/superpowers/specs/2026-08-17-quorum-campaign-platform-design.md` (revision 3) |
| **D1** | `docs/superpowers/specs/2026-08-24-kernel-d1-contracts-design.md` |
| **D3** | `docs/superpowers/specs/2026-08-26-kernel-d3-campaign-engine-design.md` |
| **D4A** | `docs/superpowers/specs/2026-08-31-kernel-d4a-descriptive-readout-design.md` (revision 3) |
| **AGR** | `docs/experiments/2026-08-09-fresh-release-gate-readout.md` — the hand-run gate this profile formalizes |

## Purpose and place in the program

D4b closes deliverable 4. Per PAR revision 3 and D4A revision 3 (the D-1
amendment), D4b ships **the decision core and nothing else**:

1. **The gating seal path** — gating campaigns seal exactly as exploratory
   ones do; D4A's typed refusal is deleted.
2. **The `release_gate_v1` fold branch** — the fold computes the
   pre-registered grid (per-cell Fisher exact, determinate-n floors, MDE,
   the tripwire table) and mints the three-valued verdict.
3. **Tripwire adjudication** — append-only rulings on the journal, then a
   deterministic superseding re-render into a new publication generation.
4. **The operator verbs** — `campaign adjudicate`, `campaign list`, and
   `campaign status`.

Per PAR revision 3's framing: the verdict is a pre-registered,
machine-computed **readout** — it binds nothing. A human reads the report
and decides; the profile exists so the evidence under that judgment is
tamper-evident and cheap to re-check (per-arm counts live in the sealed
artifact for exactly this reason, amendment A-2).

Round-1 review established that three of these require contract
amendments the revision-1 draft did not name. Revision 2 names them
(§Contract amendments). Naming them is what keeps D4b the final increment:
the only remaining amendment-class triggers are recorded in §Leftovers.

## Decisions

- **D-1 — Scope is the decision core; the speculative surfaces do not
  transfer.** Ratified by the D4A revision-3 amendment (Drew, 2026-09-04).
  Cut: the general supersedes/errata apparatus (built on first need — the
  only sanctioned supersede path is §Tripwire adjudication's);
  tags/declared-metrics aggregation (no consumer); the second live Fisher
  implementation (exact arithmetic + golden tables carry the cross-check);
  `budget_raise` stays deferred (D4A D-6, §Leftovers). Revision-2
  correction: D4A's D-9 **section stays in `report.md`** (still empty,
  still named) — deleting it would change every descriptive render and
  trip the tamper guard on the two already-sealed D4A campaigns, and PAR
  §Report engine item 4 was never retired (review record, fable C1 / k3
  C5). The trim is the aggregation machinery, not the section heading.
- **D-2 — One terminus; the refusal is deleted; the fold dispatches on
  profile at every call site.** There are three fold call sites, not one:
  the terminus (`src/campaign/seal.ts` step 6), `campaign report`
  (`src/cli/campaign.ts`), and the sealed-tail resume
  (`src/campaign/recovery.ts` — `resumeSealedTail`). One exported
  dispatcher (`foldReport(campaign, events, evidenceOf)`) maps profile →
  branch — absent profile defaults to `descriptive_v1`, the existing
  convention — and all three call sites consume it. Deletion list (each
  with its tests): `GATING_REFUSAL_MESSAGE` and the `refused_gating`
  terminus outcome (seal.ts); the R-RCV-5 hand-off's awaits-D4b refusal
  (recovery.ts); the CLI refusal row (`src/cli/campaign.ts`); the
  fold-internal gating guard (`src/campaign/report.ts` — the
  "awaits D4b" `ReportFoldError`, which becomes a dead guard with a stale
  message if left); the resume/refusal tests including
  `test/campaign-resume.test.ts`'s two rows.
- **D-3 — Fisher exact in exact rational arithmetic; golden tables are the
  cross-check.** One module (`src/campaign/fisher.ts`): hypergeometric
  probabilities as exact numerator/denominator pairs over BigInt
  binomials; two-sided p by the minimum-probability convention — the sum
  of every table with the observed margins whose probability is ≤ the
  observed table's, compared **exactly** (cross-multiplied integers, no
  epsilon); zero-margin tables return 1. Exact arithmetic makes summation
  order irrelevant and the cross-host determinism claim true by
  construction. The oracle is a committed Python-stdlib generator
  (`fractions.Fraction`; it extends AGR's lineage script
  `docs/experiments/2026-08-08-fresh-release-gate-power.py`, already
  stdlib-only) emitting exact fractions; tests assert **exact equality**,
  not a tolerance. Fixtures span the gate's real shapes (0–12 determinate
  per arm, including all-zero margins) plus a named set of large and
  asymmetric tables. Rendering stays REPORT_RENDERING's
  shortest-round-trip double.
- **D-4 — The verdict is one exhaustive state table.** See §The
  `release_gate_v1` fold. Three-valued — `SHIP` / `NO_SHIP` /
  `UNDERPOWERED_OR_INVESTIGATE` — naming readout values, not platform acts
  (PAR revision 3). An unresolved or unevaluable tripwire fire, or a
  corruption-class seal-time integrity finding, dominates: the campaign
  seals `UNDERPOWERED_OR_INVESTIGATE` (PAR's mint-investigate-at-seal;
  AGR's different surface order is an artifact of the hand-run readout
  resolving its fire before rendering the verdict — adjudicated, review
  record). An upheld fire or a treatment-unfavorable significant
  confirmatory cell at/above floor is `NO_SHIP`. A nonempty
  `cannot_answer` — computed independently of the precedence walk — is
  `UNDERPOWERED_OR_INVESTIGATE`. A grid with **zero confirmatory cells**
  is `UNDERPOWERED_OR_INVESTIGATE` (the vacuous-SHIP pin; registration
  separately refuses new zero-confirmatory gating suites, §Registration).
  Otherwise `SHIP`.
- **D-5 — Rulings are append-only and latest-wins; the guard, not the
  verb, is the integrity boundary.** A ruling rides D1's existing
  `adjudication` event (`{cell, disposition, rationale}`) with exactly two
  new disposition values: `tripwire_resolved` (instrument artifact — the
  fire does not stand) and `tripwire_upheld` (behavioral — `NO_SHIP`
  pressure). Multiple rulings per fire are legal; the **latest** governs
  (refusal only on an identical repeat — a wrong ruling must be
  correctable, review record qwen C-8). `campaign adjudicate` is the
  journaled operator verb. Every re-render first re-verifies the pre-seal
  prefix (recomputed fold digest == `sealed.report_digest`), then
  validates the ruling suffix by content: each ruling must name a member
  of the fired set re-derived from the prefix. The sealed report's digest
  is never edited; superseding generations are new immutable artifacts
  (amendment A-3).
- **D-6 — `list` and `status` ship with PAR's information barrier.**
  `campaign status` pre-seal renders progress and spend **only** — never
  outcome data; post-seal it adds the verdict read from the published
  latest generation (refold verification belongs to `report`). States:
  `registered` (published campaign.json, no `campaign_opened`),
  `running`, `predicate-holds`, `sealed`, `cancelled`, `storage_paused`,
  with drift-refusals marked. `campaign list` enumerates campaign dirs
  with those states and spend-to-date. Both are journal-read-only.
- **D-7 — Deletions are the refusal sites only** (D-2's list). The
  descriptive fold and renderer are otherwise byte-stable; D4A's
  golden-oracle fixtures are **not** regenerated (revision-1's fixture
  regeneration is retracted with the tags-section deletion, D-1).

## Contract amendments

Three amendments, each additive, each with its test matrix in §Testing.
They are this deliverable's own — naming them is the round-1 correction.

**A-1 — Journal grammar: the sealed terminus gains one self-loop.**
Grammar becomes: *pre-seal events → exactly one `sealed` → zero or more
tripwire rulings*. `JournalWriter.appendOne`'s post-seal check admits an
`adjudication` event **iff its disposition is `tripwire_resolved` or
`tripwire_upheld`**, keeping the blanket rejection for everything else —
including other adjudication dispositions. The state machine gains the
`sealed → sealed` self-loop on exactly those payloads. `replayEvents`
accepts exactly that suffix; anything after `sealed` that fails the
disposition check remains corruption. One shared validator
(`validatePostSealSuffix`) serves the writer, replay/rebuild, the report
verb, recovery, `status`, and `adjudicate`. D4A's post-seal rejection
test pin (`test/campaign-seal.test.ts`) is amended to the new invariant —
the rejection is now disposition-keyed, and a test proves the allowlist
is exactly those two values. The crash-window fold and the writer's
election-time reseed already tolerate a post-seal suffix and are named
unaffected.

**A-2 — ReportSchema gains the gating grid (D-8-convention, additive).**
Per cell: `arms: [{arm, n, determinate, pass, fail}]` (the Fisher 2×2 is
auditable from the sealed artifact; AGR's grid is per-arm and so is
ours). Per comparison: `completion: {per-arm completion shares, fired}`.
A top-level `tripwires` block:
`[{identity, expect, fired, unevaluable, ruling?: {disposition, seq}}]`,
where `identity` is `<comparison>:<scenario>` for cell fires and
`<comparison>:completion-collapse` for the comparison-level family (the
`:` delimiter is reserved and `completion-collapse` is reserved against
scenario names). A top-level `params` echo of the registered profile
parameters, so the digest covers the parameters the verdict was computed
under. `cannot_answer[]` gains a required `reason` string; `mde` stays
required for confirmatory entries (R-REG-18 guarantees it) — unevaluable
tripwires live in the `tripwires` block, not `cannot_answer`.
`supersedes` is pinned as the prior report's digest (64 lowercase hex) —
a D1 erratum, since D1's prose typed it as a campaign id. The
descriptive branch never populates the new fields (optional-only;
`stamp`/`verdict` bijection unchanged).

**A-3 — Publication is digest-addressed generations plus a latest
pointer.** Artifacts publish as immutable `report.<digest>.{json,md}`;
`report.json`/`report.md` become the latest-generation copy, updated
last, atomically. Each ruling prefix yields exactly one deterministic
revision (its digest), independent of how many times `report` runs. Crash
windows: generation files are staged and renamed before the pointer
moves; a crash leaves the prior generation intact and the pointer
consistent; `resumeSealedTail` folds the permitted suffix before its
digest comparisons so a sealed campaign with landed rulings completes
publication of the correct generation. The original sealed generation is
preserved on disk, satisfying PAR §Identity's "with the original
preserved" by construction rather than by recomputation.

## Registration

Two tightenings, both fail-closed at registration time:

- A `release_gate_v1` suite must declare **at least one confirmatory
  cell** (R-REG-18 extension). The fold keeps the D-4 zero-confirmatory
  pin regardless, because pre-existing registrations (the parked
  campaign) predate the rule.
- `declared_metrics` is refused non-empty at registration — it has no
  consumer (D-1) and accepting it silently was a lie of omission.

## The gating seal path

`src/campaign/seal.ts` step 1's profile refusal is deleted (D-2). Step 6
calls the shared dispatcher. Everything else in the terminus is shared
and unchanged: the predicate check, the pre-seal verify, the integrity
audit, the contention backstop (whose `unknown_coverage` mints feed the
fold's denominators exactly as in D4A — a mid-terminus crash blinding the
final block's tail surfaces as cannot-answer pressure in a gating report,
D4A's carried-forward observation), the single `sealed` append, and
staged publication (now through A-3's generations).

Resume symmetry: the R-RCV-5 hand-off no longer refuses gating campaigns;
a gating campaign found at predicate-holds on resume proceeds to the
terminus like any other.

## The `release_gate_v1` fold

`foldGatingReport` consumes the same inputs as the descriptive fold (the
frozen campaign document, the journal event stream up to but excluding
`sealed`, per-sample run-dir evidence through the same fail-closed
reader) and shares D4A's cell accounting: `contention_invalidated` and
`unknown_coverage` blocks drop from comparison denominators; every
included cell renders, zero-determinate cells included. Cell classification
— including `tripwire_expect` — derives from the frozen campaign
document's embedded suite (the registration-time source of truth).

Per comparison, per cell, the gating branch computes: `fisher_p`
(two-sided, D-3, over the per-arm 2×2), `delta` (treatment minus control
pass rate; negative is treatment-unfavorable), and for confirmatory cells
`mde` (the registered `mde_by_scenario` value; R-REG-18 guarantees
coverage). A quantity that should exist but is neither computable nor
classifiable throws `ReportFoldError` — fail-closed, as in D4A. The
class-by-status matrix: confirmatory unevaluable (provenance-excluded —
D4A's `failed_cells`) ⇒ `cannot_answer` with its registered MDE; tripwire
unevaluable ⇒ fired-equivalent (below); probe/descriptive unavailable
statistic ⇒ explicit `n/a`, no verdict pressure; missing registered
confirmatory MDE or a broken invariant ⇒ `ReportFoldError`.

**Floors.** A confirmatory cell with either arm's determinate n below
`determinate_n_floor` reads UNDERPOWERED: it joins `cannot_answer`
(cell, MDE, reason) and cannot RED the gate (PAR §Decision profiles).

**Tripwires.** A determinate tripwire cell fires iff its treatment arm
shows any outcome contrary to the registered `tripwire_expect` (any fail
under `pass`, any pass under `fail` — AGR's structural-blocks fire was
exactly one treatment fail). A tripwire cell with zero determinate
treatment samples is **fired-equivalent**: untestable evidence pressures
`UNDERPOWERED_OR_INVESTIGATE`, never reads clean (D1's
indeterminate-fires-fail-closed rule). The completion-collapse family
evaluates per comparison: it fires iff the arms' completion shares
(determinate samples over included samples; contention/unknown-coverage
blocks excluded, consistent with the shared accounting) differ by more
than `completion_divergence_max`. Its identity is the reserved
pseudo-scenario `<comparison>:completion-collapse` (A-2). Lineage: v1
deliberately generalizes AGR's fractals-per-column completion rule to any
comparison — a named departure, not a silent one.

**The verdict (D-4), exhaustive:**

| Condition | Verdict |
|---|---|
| Any fired tripwire (cell or completion-collapse) with no governing ruling, or any unevaluable tripwire, or any seal-time `integrity_finding` (corruption class) | `UNDERPOWERED_OR_INVESTIGATE` |
| Any `tripwire_upheld` governing ruling, or any treatment-unfavorable significant confirmatory cell (`fisher_p < alpha`, `delta < 0`) at/above floor | `NO_SHIP` |
| `cannot_answer` nonempty (below-floor or provenance-excluded confirmatory cells), or zero confirmatory cells | `UNDERPOWERED_OR_INVESTIGATE` |
| Otherwise | `SHIP` |

Rows evaluate top to bottom; the first matching row decides.
`cannot_answer` is computed independently and rendered regardless of the
verdict. Integrity caveats (attribution unknowns, D4A's classes) render
in accounting and exert no verdict pressure. Every report renders the
per-confirmatory-cell MDE table ("what this gate cannot answer", PAR) and
the `cannot_answer` list — never elided. Probe and descriptive cells
render with their statistics and never gate (PAR).

**Rendering.** Gating reports carry `verdict` and no `stamp` (D1's
superRefine bijection, unchanged). `renderReportMd` gains the gating
layout — verdict first; the grid with per-arm counts, p, delta, MDE per
cell; the tripwire table with firing state and ruling status (both now
schema-carried, A-2 — the renderer stays `{report, campaign}`-only); the
accounting block; provenance — deterministic for identical inputs,
per-host byte-stability per REPORT_RENDERING.

## Tripwire adjudication and the superseding re-render

Operator flow:

```
quorum campaign adjudicate campaigns/<id>/ \
  --cell <comparison>:<scenario>|`<comparison>:completion-collapse` \
  --disposition tripwire_resolved|tripwire_upheld \
  --rationale "<what the transcript showed>"
quorum campaign report campaigns/<id>/   # re-renders the next generation
```

- `adjudicate` refuses: a non-gating campaign; an unsealed campaign; an
  identity that is not in the sealed report's fired set (the refusal
  names the fired set); an identical repeat of the governing ruling; any
  disposition outside the two pinned values. It appends through the
  restrict-mode writer election (`restrict: ['adjudication']`) as amended
  by A-1 — crash-safe and single-writer like the seal.
- Every `report` on a sealed gating campaign runs the two-stage guard
  (D-5): (1) recompute the pre-seal prefix fold and require digest
  equality with `sealed.report_digest`; (2) validate the post-seal suffix
  by content against the re-derived fired set. Only then does it fold the
  ruling overlay and publish the next generation (A-3), carrying
  `supersedes: <prior report digest>`. There is exactly one journaled
  digest — the seal's; superseding generations are verified by
  deterministic recomputation, not by an anchored chain.
- A `tripwire_upheld` ruling needs no special path: the re-render
  recomputes the fold with the ruling overlay, and the upheld fire
  contributes `NO_SHIP` through the state table's second row.

## CLI

- `quorum campaign adjudicate <dir> --cell <id> --disposition <d>
  --rationale <r>` — above.
- `quorum campaign list` — one row per campaign dir: id, suite, profile,
  state (D-6's six), spend to date, opened ts. Journal-read-only.
- `quorum campaign status <id>` — `<id>` resolves by digest-prefix scan
  over `campaigns/`; ambiguity and absence are typed refusals. Pre-seal:
  registered vs terminal sample counts per cell, spend vs budget, lock
  holder, last event age — **no outcome data** (PAR's barrier). Post-seal:
  the verdict and the latest-generation pointer.
- `quorum campaign report <dir>` — on any unsealed campaign, prints the
  standard unsealed diagnostic (D4A's; it carries no outcome data and PAR
  pins the behavior for all campaigns). Post-seal, renders; post-ruling,
  re-renders per §Tripwire adjudication.

## Refusal table

| Case | Behavior |
|---|---|
| `report` on an unsealed campaign (either profile) | The standard unsealed diagnostic, exit 1 |
| `adjudicate` on non-gating / unsealed campaign | Typed refusal, exit 1 |
| `adjudicate` naming an identity outside the fired set | Typed refusal naming the sealed report's fired set |
| `adjudicate` identical repeat of the governing ruling | Typed refusal naming the governing ruling's event seq |
| `adjudicate` disposition outside the pinned two | Typed refusal naming the two |
| Post-`sealed` event failing A-1's disposition check | Writer rejection; replay treats it as corruption |
| Re-render whose prefix fold digest ≠ `sealed.report_digest` | The D4A tamper refusal, unchanged |
| Ruling suffix naming non-fired / non-tripwire identities | The guard refuses; `report` exits 1 naming the offenders |
| Registration: gating suite with zero confirmatory cells, or non-empty `declared_metrics` | Typed registration refusal |
| Gating fold hits an uncomputable, unclassifiable quantity | `ReportFoldError` — never silent (D4A's rule) |

## Testing

Hermetic (the portable matrix, `bun run check`):

- Fisher: exact-equality golden parity (the committed stdlib generator's
  fixtures; 0–12/arm full lattice, named large/asymmetric tables,
  zero-margin edges); the two-sided convention's tie behavior pinned by
  construction (exact comparison — no tolerance to specify).
- A-1: the writer/replay/state-machine invariant matrix — the sealed
  self-loop admits exactly the two dispositions; every other post-seal
  payload rejects at the writer and corrupts at replay; the shared
  validator is provably the one used by all six consumers.
- A-2: schema round-trips; the descriptive branch never populates the new
  fields; D4A's golden fixtures pass **unregenerated** (D-7).
- A-3: generation publication crash windows (crash before pointer move
  leaves the prior generation intact; crash after is complete); one
  deterministic revision per ruling prefix.
- The gating fold: golden-oracle tests over synthetic journal + run-dir
  fixtures (D4A's harness), one per state-table row, plus floors,
  unevaluable confirmatory/tripwire cells, the completion-collapse
  family, and the zero-confirmatory pin.
- The two-stage guard: prefix tamper + legal-looking ruling refuses;
  suffix naming non-fired identities refuses; the legitimate ruling
  re-render publishes a new generation with the original preserved.
- The dispatcher: all three call sites × both profiles, including the
  sealed-tail crash window with a landed ruling.
- `adjudicate`: every refusal-row case; storage-full at the ruling append
  leaves nothing journaled.
- `list`/`status`: the pre-seal information barrier is asserted by
  scanning rendered output for outcome vocabulary.

Live (trusted-maintainer, appliance; nothing to public CI), recorded in a
dated experiment-log entry:

1. **Retroactive seal (seal-transport proof):** resume the parked
   2026-09-01 gating campaign (`1fc57f5d…`) under the new code. Its suite
   declares no confirmatory cells (frozen before the registration
   tightening), so the expected verdict is `UNDERPOWERED_OR_INVESTIGATE`
   via the zero-confirmatory pin — it proves the seal path, the dispatch,
   and the vacuous-SHIP guard, not the decision rule. Preconditions
   verified in the log recipe: the frozen `campaign.json` (not the
   committed suite file, which has drifted) carries complete registered
   params; the three source checkouts still reach the registered refs for
   pre-seal verify; resume's reconcile may append pre-seal prefix events,
   which the hand recomputation folds in; the R-REG-19 key-env preflight
   needs the campaign's credentials exported.
2. **Decision proof:** a small gating suite — hello-world scale, one
   explicit confirmatory cell and one `tripwire_expect: fail` tripwire
   cell that fires deterministically at zero fixture cost — registered
   with `determinate_n_floor: 1` so n=1 meets the floor and the
   post-ruling re-render can actually leave UOI. The campaign seals
   `UNDERPOWERED_OR_INVESTIGATE` on the fire; `adjudicate …
   tripwire_resolved`; `report` re-renders generation two with
   `supersedes` set and the recomputed verdict (`SHIP`: no unfavorable
   significance at n=1, floor met, no standing fire); the original
   generation is intact on disk.

## Exit criteria

- `bun run check` and `bun run quorum check` green on the merge commit,
  including the A-1 invariant matrix, the guard-content tests, and the
  dispatcher matrix (named here so their absence fails review, not just
  CI).
- Fisher exact-equality golden parity green in the portable matrix.
- The two live runs above recorded in the experiment log.
- After exit: flip this spec's status line to `implemented (main @ <merge
  commit>)` — the standing convention (a status stamp, never a semantic
  edit).

## Leftovers (explicitly not this deliverable)

- **The general supersedes/errata apparatus** — built on its first real
  correction, not before (PAR §Identity, revision 3). Named trigger: the
  first *non-tripwire* correction to a sealed report forces it. That
  class is real, not speculative — AGR itself needed one (the luna
  CORRECTION, 7 hours post-publication). Rulings are correctable in
  scope (D-5 latest-wins), so a wrong ruling is not such a trigger.
- **`budget_raise`** — deferred (D4A D-6). Named trigger: the first real
  gate that budget-stops has no in-campaign recourse without the append
  surface; the event and accounting already exist, so it lands on first
  need.
- **Tags/declared-metrics aggregation** — on its first named consumer.
- D3's owed debt (mid-block crash-resume evidence, cancel live evidence,
  the Linux-gated integration matrix, the D3 stamp) is unchanged by this
  deliverable.

## Revision history

- **Revision 1** (2026-09-04): initial spec, scoped by PAR revision 3 and
  the D4A revision-3 D-1 amendment.
- **Revision 2** (2026-09-04): post round-1 four-seat review (fable 5.1 /
  qwen / sol / k3 — four of four NOT-READY; record:
  `docs/experiments/2026-09-04-kernel-d4b-spec-review.md`). The spec now
  names its three contract amendments (A-1 journal grammar, A-2 report
  schema, A-3 publication generations); the verdict rule is an exhaustive
  state table; Fisher is exact rational arithmetic with exact-equality
  golden parity; the tamper guard is the two-stage integrity boundary;
  rulings are latest-wins; the vacuous-SHIP hole is closed at
  registration and in the fold; the tags-section deletion is retracted;
  live run 1 is restated as seal-transport evidence with an expected UOI
  verdict.
