# Kernel D4b spec review — round 1 (four-seat panel)

**Date:** 2026-09-04
**Spec under review:** `docs/superpowers/specs/2026-09-04-kernel-d4b-decision-readout-design.md`
revision 1 (uncommitted draft)
**Panel:** fable 5.1 (`claude/claude-fable-5-1`, xhigh), qwen
(`qwen-code/qwen3.8-max-preview(openai)`), sol (`codex/gpt-5.6-sol`, high),
k3 (`kimi/kimi-code/k3`, high) — identical briefing, independent seats,
Paseo subagents, read-only modes.
**Result:** 4 of 4 **NOT-READY**. Every seat verified claims against the
code (`main @ f8e1889c` + working tree); the failures concentrate where
revision 1 asserted contract sufficiency without checking.

## The converged spine

Five findings were landed independently by three or four seats, each with
the same code citations. These are the review's load-bearing output.

1. **Post-seal journal appends are illegal as specified** (fable B1, sol
   B3, k3 B1, qwen B-1). `JournalWriter.appendOne` rejects every append
   once a `sealed` row exists (`src/campaign/journal.ts:442`), the campaign
   state machine admits no event from `sealed`
   (`src/contracts/campaign/state-machine.ts:237`), `replayEvents` throws
   corruption on any post-seal row (`src/campaign/journal.ts:1163`), the
   fold refuses input containing `sealed` (`src/campaign/report.ts:150`),
   and D4A's own tests pin both boundaries (`test/campaign-seal.test.ts:1257`).
   Revision 1's "no new event types" hid a contract amendment.
   **Adjudication: ACCEPTED (all seats' fixes converge).** The spec gains
   an explicit amendment section: journal grammar becomes *pre-seal events
   → exactly one `sealed` → zero or more tripwire rulings*; the writer
   guard allowlists on **disposition** (exactly `tripwire_resolved` /
   `tripwire_upheld`), not type; replay accepts exactly that suffix and
   keeps the corruption throw otherwise; the fold input is the pre-seal
   prefix replayed plus the ruling suffix as an overlay, never containing
   `sealed`; one shared suffix validator serves append, replay, report,
   recovery, status, and adjudicate; D4A's post-seal test pin is amended
   and the writer/replay invariant matrix joins §Testing.

2. **`ReportSchema` cannot carry the gating grid** (fable B3, sol B5,
   k3 C2, qwen B-2). The schema is strict; cells pool pass/fail across
   arms (D4A's pinned convention, `src/campaign/report.ts:649`), so the
   Fisher 2×2 inputs are unrecoverable from the sealed artifact; there is
   no home for the tripwire table, firing state, ruling status, the
   completion-collapse result, or the applied params; `renderReportMd`
   receives only `{report, campaign}`; and `cannot_answer[].mde` is
   positive-required, so unevaluable tripwires have no entry shape.
   **Adjudication: ACCEPTED.** A D-8-convention additive amendment:
   per-cell per-arm `{n, determinate, pass, fail}` splits; a top-level
   `tripwires` block (`identity, expect, fired, unevaluable, ruling?`);
   a top-level `params` echo (so the digest covers the parameters the
   verdict was computed under); `cannot_answer[].reason`.

3. **The vacuous-SHIP hole, and the parked campaign sits in it** (fable
   B2, sol B2, qwen M-6/direct-answer). Registration defaults cell class
   to `descriptive` (`src/campaign/registration.ts:403`); the parked
   `1fc57f5d` suite declares no `cells:` override, so its one cell gates
   nothing and revision 1's precedence falls through to SHIP on n=1.
   **Adjudication: ACCEPTED.** Registration refuses a `release_gate_v1`
   suite with zero confirmatory cells (R-REG-18 extension), the fold pins
   zero-confirmatory ⇒ `UNDERPOWERED_OR_INVESTIGATE` (the fold-level pin
   is what covers pre-existing registrations), and live run 1 is restated:
   the parked campaign is seal-transport compatibility evidence with an
   expected verdict of UOI — the decision-proof live run is a new,
   explicitly confirmatory suite.

4. **The superseding re-render overwrites the sealed artifacts** (fable
   C2, sol B4, k3 C1, qwen C-5). `publishReport` renames over the fixed
   `report.md`/`report.json` paths, contradicting "never edited" and
   PAR §Identity's "with the original preserved", and leaves
   `resumeSealedTail`'s digest comparison with no determinate behavior
   after a ruling.
   **Adjudication: ACCEPTED — digest-addressed immutable generations.**
   Publication writes `report.<digest>.{json,md}` (immutable) plus an
   atomically-updated latest pointer; `supersedes` carries the prior
   report's digest (64-hex; D1 erratum — D1's prose typed it as a campaign
   id); one deterministic revision per ruling prefix, independent of how
   many times `report` is invoked; publication crash windows pinned
   (generation files first, pointer last — a crash leaves the prior
   generation intact and readable).

5. **The tamper guard must re-verify the prefix, and the guard — not the
   verb — is the integrity boundary** (k3 B2, fable C3, qwen C-4). Keying
   re-render permission on the post-seal suffix alone lets tampered
   pre-seal evidence plus one legal-looking ruling publish a fresh report
   wearing the original's digest chain; and a hand-inserted ruling naming
   a non-fired cell passes a type-only guard.
   **Adjudication: ACCEPTED.** Two-stage guard, pinned: (1) recompute the
   pre-seal prefix fold and require digest equality with
   `sealed.report_digest` — mandatory on every re-render; (2) validate the
   suffix by content: every ruling must name a cell/comparison in the
   fired set re-derived from the prefix, ruling out non-fired,
   non-tripwire, and duplicate-or-contradictory entries at the boundary.

## Verdict-rule findings (converged, accepted)

- **Exhaustive state table** (fable C5, sol B1, k3 C3, qwen C-1/C-2).
  Revision 2 replaces the precedence sentence with a table:
  unresolved or unevaluable tripwire, or a corruption-class integrity
  finding ⇒ `UNDERPOWERED_OR_INVESTIGATE`; an upheld fire or a
  treatment-unfavorable significant confirmatory cell (at/above floor —
  the floor qualifier moves into the verdict sentence, qwen M-1) ⇒
  `NO_SHIP`; nonempty `cannot_answer` (computed independently of the
  precedence walk, sol B1) ⇒ `UNDERPOWERED_OR_INVESTIGATE`; otherwise
  `SHIP`.
- **"Unevaluable" pinned** (qwen C-1): a provenance-excluded confirmatory
  cell (D4A's `failed_cells`) routes to `cannot_answer` with its
  registered MDE — closes the wrong-model fall-through to SHIP.
- **Unevaluable tripwire cells are fired-equivalent** (k3 C3, qwen C-2,
  sol B1 via D1's indeterminate-fires-fail-closed rule): zero determinate
  treatment samples pressures UOI through the tripwire table, never reads
  as clean.
- **Unresolved-fire dominance kept** (fable C5 asked; qwen verified
  PAR-consistency). PAR pins "a fired tripwire seals the campaign
  UNDERPOWERED-or-INVESTIGATE" — investigate dominates at seal; AGR's
  apparent NO_SHIP-first order is an artifact of the hand-run readout
  resolving its fire before rendering the verdict. Recorded as adjudicated,
  not a departure.
- **Completion-collapse identity and basis** (fable C4+C7, sol B1, k3 C4,
  qwen C-3): fires are comparison-level, addressed by the reserved
  pseudo-scenario token `completion-collapse`
  (`<comparison>:completion-collapse` — `:` is the reserved delimiter and
  the token is reserved against scenario names), uniformly in the report
  table, `adjudicate`, and refusal naming. Basis pinned: per comparison,
  per arm, included-set samples (contention/unknown-coverage blocks out,
  consistent with the shared accounting). Lineage named: v1 generalizes
  AGR's fractals-per-column rule (≥3/5 divergence) to any comparison — a
  deliberate generalization, stated as such.

## Fisher findings (converged, accepted)

(fable C6, sol B8, qwen C-7): revision 1 pinned the summation but not the
convention, named R and SciPy interchangeably, and claimed 1e-12 parity
against oracles that use 1e-9/1e-7 inclusion slack — unmeetable, and at
small n tie tables differ by whole terms. **Adjudication:** revision 2
pins **exact rational arithmetic** (BigInt binomials; probabilities as
exact numerator/denominator pairs; the two-sided minimum-probability
convention — sum of all tables with probability ≤ the observed table's,
R `fisher.test`'s definition — with *exact* comparison, no epsilon), a
Python-stdlib generator (`fractions.Fraction`; extends the AGR lineage
script, which was already stdlib-only), and parity by **exact equality**.
Cross-host determinism is then true by construction, not aspirational.
Golden fixtures span the gate's real shapes (0–12 per arm incl. all-zero
margins) plus a named set of large/asymmetric tables.

## Seat-specific criticals (accepted)

- **Three fold call sites, one dispatcher** (sol C6, qwen C-6):
  `foldDescriptiveReport` is called from the terminus, `campaign report`
  (`cli/campaign.ts:1169`), and `resumeSealedTail` (`recovery.ts:1949`).
  Revision 2 specifies one exported profile dispatcher consumed by all
  three, and adds the fold-internal gating guard (`report.ts:155`) to the
  D-2 deletion list — left in place, it becomes a dead guard with a stale
  message on the un-dispatched path.
- **Ruling immobility softens to latest-wins** (qwen C-8): a wrong ruling
  with no correction path is the most likely D4c-forcer. Append-only
  tolerates it cleanly: the **latest** ruling governs; refusal only on an
  identical repeat. Accepted — this keeps the trimmed errata scope while
  closing the wedge.
- **D-7's tags-section deletion retracted** (fable C1, k3 C5): deleting
  the named empty section changes every descriptive md render, so the
  byte-comparing guard would refuse the two already-sealed D4A live
  campaigns, and it drifts from PAR §Report engine item 4, which revision
  3 did not retire. The section stays (still empty, still named); the
  trim stands at "no aggregation machinery". The D4A revision-3 amendment
  line saying the section "is deleted" is corrected in the same commit.

## Minors

Accepted wholesale unless noted: fable M-1 (gating pre-seal `report`
prints the standard unsealed diagnostic), M-2 + qwen M-3 (`list` states
gain `registered`, `storage_paused`, and the drift-refused marker), M-3
(enumerate the five refusal-deletion sites incl.
`test/campaign-resume.test.ts:791,1131`), M-4 (`tripwire_expect` reaches
the fold through the embedded frozen suite — derivation pinned), M-5
(`declared_metrics` non-empty refused at registration), M-6 (`status`
post-seal reads the published latest report; refold verification stays
with `report`), M-7 (live run 2's suite shape pinned: hello-world-scale
with an explicit confirmatory cell and a `tripwire_expect: fail` cell that
fires deterministically at zero fixture cost; the "covers D3's owed
evidence" claim dropped), M-8 + qwen M-8 (live run 1 recipe notes: resume
reconcile may append pre-seal prefix events that the hand recomputation
must fold in; the R-REG-19 key-env preflight needs the campaign's
credentials on the appliance; frozen `campaign.json` params completeness
verified against the appliance copy — fable noted the committed suite file
now names opus arms while the validation record says haiku/sonnet46, which
makes the frozen document the only source of truth), M-9 (state-machine
proof + guard-content tests named in exit criteria); qwen M-2 (dispatch
default branch for omitted profile), M-4 (`status <id>` resolves by
digest-prefix scan over `campaigns/`), M-5 ("digest chain" reworded — one
journaled digest; superseding digests verified by deterministic
recomputation), M-7 ("only matched determinate cells enter the grid"
reworded — every included cell renders, zero-determinate included).

## The D4c question, answered honestly

The panel's consensus: the trim is defensible; two named triggers remain.
**`budget_raise`** (fable): the first real gate that budget-stops has no
in-campaign recourse without the append surface — the event and accounting
already exist, so it lands on first need. **The first non-tripwire
correction to a sealed report** (k3): AGR itself needed one (the luna
CORRECTION, 7 hours post-publication), so the class is real, not
speculative. Both are recorded in §Leftovers with their triggers named.
The revision-2 additions (journal grammar, report schema, publication
generations) are contract amendments, but they are *this* deliverable's
amendments — naming them is what keeps D4b the final increment.

## Disposition

Revision 2 addresses every finding above. Re-review is by the same panel
on the revised spec.
