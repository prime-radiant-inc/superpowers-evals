# 2026-08-17 — Adversarial review of the campaign-platform spec (rev 1 → rev 2)

Research campaign: a seven-seat, two-round adversarial review of
`docs/superpowers/specs/2026-08-17-quorum-campaign-platform-design.md`
revision 1 (@ `6b8adc7`). Round 1 = independent attack (no anchoring);
round 2 = cross-examination against the full room. Same read-only rules
as the direction panel. All seats filed **changes requested**; none
proposed reverting to the superseded program; revision 2 folds in every
convergent finding (zero vetoes recorded).

## Seats

| Seat | Model | Lens |
|---|---|---|
| Fable A | claude-fable-5 (xhigh) | Requirements & goal audit |
| Fable B | claude-fable-5 (xhigh) | Mechanism correctness (incl. the predicate killer test) |
| Sol A | gpt-5.6-sol (max) | Simpler-architecture challenge |
| Sol B | gpt-5.6-sol (max) | Operational failure-modes red team |
| K3 A | kimi-k3 (max) | Completeness (incl. the grader-pool probe) |
| K3 B | kimi-k3 (max) | Supersession audit (drop-list diff) |
| Grok | grok-code | Cold implementability read (spec-only first) |

## Round-1 headline findings (all repaired in rev 2)

1. **The suite schema could not express the real release gate** — scalar
   n, no per-arm participation, no cell classes, single global baseline;
   the drop-for-all-arms rule would delete the 08-08 gate's asymmetric
   cells. Three seats independently. → `comparisons[]` with per-cell
   n/class; classes = C/P/T/D restored.
2. **The predicate grammar failed the killer test** — Fable B attempted
   the real 08-08 decision rule clause-by-clause: per-cell Fisher,
   per-cell floors, tripwire adjudication, and the collapse rule were
   all inexpressible, and pooled `fisher_p` is the statistic the gate's
   own pre-registration forbade headlining. The example predicate also
   encoded non-inferiority via a difference test. → decision profiles.
3. **Per-arm superpowers materialization and `superpowers: none` had no
   implementation path** (all 9 adapters hard-require the host-global
   root) — four seats independently. → named kernel provisioning scope.
4. **The Gauntlet-Agent was absent from the whole capacity model** —
   388 × 75s ≈ 8.1 serial grader-hours defeats the 8h criterion alone;
   Phase 0 couldn't validate the criterion by construction; grader 429s
   would burn reserves into a NO-SHIP capacity artifact. Three seats. →
   grader pool in admission/Phase 0/budget/provenance.
5. **Quota caps stopped at the process boundary** (in-process scheduler
   state; two campaigns or campaign+run-all double-subscribe pools). →
   campaign flock + host-wide live-spend lock + designated gating host.
6. **The typed-failure doctrine's plumbing did not exist** — named
   stages absent from the real `RunError` enum; grader billing-death
   composes to never-replaced `indeterminate`; rate-limit detection was
   Antigravity-only. → scheduled kernel work + the <5% first-gate bar.
7. **The runner could not honor the identity promises** (run-id printed
   at exit; orphan processes unhandled) → `run_allocated` at allocation,
   pgid journaling, kill-before-rerun.
8. **The supersession had been executed by name-list, not by diff**
   (K3 B's 22-row drop-list; ~a dozen receipt-backed mechanisms had
   evaporated without disposition, three breaking rev 1's own stated
   invariants) → Appendix A.
9. Cold-read blockers: no implementable schemas, undefined digest
   canonical form, no operator surface after `register`. → Appendix B +
   lifecycle verbs.

## Round-2 resolutions (eleven explicit mind-changes)

- **Decision profiles over any predicate grammar — unanimous** (Fable B
  abandoned its own grammar extension; Grok: "that is how hand
  statistics return through YAML"). `release_gate_v1` semantics include
  the three-valued verdict and per-cell MDE rendering.
- **`comparisons[]` of one-or-two arms — unanimous**; all-k atomic
  blocks rejected by every seat.
- **Skew**: clock = first generation request (unanimous); registration
  rejects infeasible pairs (unanimous); runtime breach in gating =
  exclude-from-pairing + refill (6–1; **Grok dissents**, caveat-only —
  minutes-scale slip ≠ hours-scale drift; recorded).
- **SQLite journal** (Sol A flipped once the operator surface was
  priced; Fable B/Grok declined to fight; the journal *contract* is the
  binding artifact).
- **Budget: counts-hard / dollars-soft — unanimous**; amendments split
  **3–2** (delete: Sol A, Sol B, Grok; keep-with-guards: K3 B, Fable A).
  **Drew ruled 2026-08-17: raise-only amendments with guards** (pre-seal,
  append-only, rendered at seal, status shows no outcome data pre-seal) —
  deciding argument: aborting a nearly-complete campaign over an estimate
  error destroys contemporaneous paired evidence that re-registration
  cannot recreate, to prevent a bias the frozen grid already prevents.
- **Contention guard** replaces per-run resource classes (host
  fingerprint + fixed concurrency + floor preflight + telemetry with
  thresholds).
- **Qualification campaign** (~⅓ gate scale) inserted before the first
  release-blocking gate — proves the instrument, not the makespan
  (Sol A flipped to K3 B's position; the $650→$850 double-gate is the
  receipt).
- **Executor: two schedulers, one execution primitive** — thin campaign
  dispatcher on existing seams; `runSchedule` untouched; unification
  decided post-first-seal (Sol A and Grok converged).

## Dissents on record

- Grok: runtime skew breach should remain caveat-only in gating.
- Sol A/Sol B/Grok: budget amendments should not exist (overruled by
  Drew's raise-only ruling; the guard set was accepted as closing their
  outcome-conditioning objection).

## Disposition

Revision 2 committed same day with all sixteen convergent items, the
eight fight resolutions, Appendix A (dispositions) and Appendix B
(contracts). Kernel estimate grew from ~4–6 weeks to ~5–7 weeks, almost
entirely the provisioning and typed-failure scope — the price of the
platform's two headline questions being real. Full seat reports live in
the Paseo workspace "evals-overhaul research panel" (round-1 and round-2
messages per agent).
