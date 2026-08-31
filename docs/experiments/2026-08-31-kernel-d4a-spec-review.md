# Kernel D4a — spec-review record (round 1, four-seat panel)

Companion to `docs/superpowers/specs/2026-08-31-kernel-d4a-descriptive-readout-design.md`
(the D4a spec; revision 1 committed @ `b6d31b7`). This file is the durable
record of the D4a design-spec review — the convention the D1–D3 specs used
(their review records are cited from their headers).

## Panel (2026-08-31)

| Seat | Model | Mode | Constraint |
|---|---|---|---|
| sol | codex/gpt-5.6-sol | `auto` (codex reviewer ceiling) | read-only brief; high thinking, fast mode |
| fable | claude-fable-5 | `plan` (structurally read-only) | read-only brief; high thinking |
| glm | omp/zai/glm-5.3 | `write` (reads free, writes need approval) | read-only brief + prior-GLM-incident warning; high thinking |
| k3 | omp/openrouter/moonshotai/kimi-k3 | `write` | read-only brief; high thinking (native kimi-code quota exhausted; routed via openrouter) |

All four reviewed independently against the same charge: completeness (what
did we miss), direction (does D4a serve the path to live testing), scope
(honestly small / no over-engineering). All four verified claims against the
pinned sources (parent spec, D1 contracts code, D3 spec/plan/code, plan-
review record) under read-only constraints.

## Verdicts

**Four of four: NOT-READY.** The findings converged unusually tightly — the
same five defects surfaced independently in every report. All four seats
simultaneously endorsed the split's direction and scope ("the split is the
right move"; "honestly scoped small — confirmations, not cuts"; "the shape is
right"). No seat proposed a redesign; all fixes are revision-grade.

## Consolidated round-1 findings

Blockers (all four seats found each of B1–B5 independently):

- **B1 — Seal order unimplementable.** The pinned terminus order wrote
  `sealed` before rendering the report, but the shipped `SealedEvent`
  requires `report_digest` (`src/contracts/campaign/journal-events.ts:464-467`;
  PAR Appendix B `sealed(report_digest)`). The digest of bytes not yet
  produced cannot be appended; the spec also never exploited the digest as
  the regeneration trust anchor. (sol B3, fable B1, glm B3, k3 B2.)
- **B2 — Ratified backstop vocabulary collapsed.** D4a minted
  `contention_invalidated` for both evaluator verdicts; D3's ratified OQ-11
  narrowing pins two dispositions: `contention_invalidated` only for a known
  breach still open at campaign end, `unknown_coverage` for coverage gaps
  (D3 §Open items; evaluator comment "NEVER contention" in
  `src/campaign/contention.ts`). (sol B1, fable B2, glm B2, k3 B4.)
- **B3 — D-5 subsumption misquotes D3.** D3 exit-criteria item 1 pins a
  "registered small **gating** suite"; D-5 dropped "gating" and claimed one
  exploratory run closes both. One campaign cannot be both kinds
  (`src/contracts/campaign/suite.ts` bijection). (sol B4, fable B3, glm B1,
  k3 B3.)
- **B4 — D-1 rationale contradicts the parent's qualification pin.** PAR
  pins qualification as "registered like any **gating** campaign", exercising
  skew **exclusion** (gating-only, R-DSP-9). Gating ⇒ `release_gate_v1` ⇒
  D4b. D4a alone therefore does not open the qualification window.
  (sol B4, fable B4, glm B5, k3 C1.)
- **B5 — Strict `ReportSchema` cannot carry the descriptive report.** No
  rate/count, median, coverage, tag, or contention-counter fields exist in the
  shipped schema (`src/contracts/campaign/report.ts`, `.strict()`); the fold's
  outputs had no canonical home. (sol B2, glm B4, k3 B1; fable's fold
  analysis reached the same schema wall.)

Criticals/Importants (seat attribution at first mention):

- Seal-time **integrity audit** absent — D3 D-5 pins TWO seal-time evaluator
  roles (audit of landed mints vs sidecar + backstop); D4a specced only the
  backstop (fable C6, sol C1).
- `report.md`-first publication + temp/fsync/atomic-rename discipline dropped
  silently (PAR §Execution "Sealing") (fable I8, sol B3, glm C2, k3 I3).
- Unsealed-campaign diagnostic regressed: PAR pins "prints exactly which
  samples block sealing and why" (fable I9, glm C1, k3 I1).
- Adjudication dedupe impossible as written: payload is per-cell
  `{cell, disposition, rationale}` with no block field; block identity must
  ride the rationale-encoding convention (fable I10, sol C1, glm C3, k3 I2).
- Gating campaigns CAN register (registration validates
  `ReleaseGateV1ParamsSchema` today); terminus/report behavior for them was
  unspecified, and the boundary sentence claiming otherwise was false
  (fable C5, glm I3/M4, k3 C2).
- Contention-invalidated samples had no accounting slot in the fixed schema
  (glm C4).
- Provenance: arm-wide union could mask wrong-model cells — validate per
  run/cell, aggregate for display (sol C2); grader observed-identity source
  unpinned (fable C7, glm I2, k3 M5/OQ1); empty-evidence edge wedges the
  terminus since `grader.observed` is schema-required (fable C7).
- Regeneration evidence boundary: pin an exact input allowlist; PAR permits
  post-completion append-only additions that must not false-positive as
  tampering (sol C3).
- Storage/concurrency at the terminus: ENOSPC mid-terminus (D-13 fail-stop
  inheritance), cancel-vs-sealer race, temp-file cleanup (sol C4, k3 OQ3).
- Evidence authorities unpinned: verdict.json / trajectory.json /
  token-usage / gauntlet result.json precedence + malformed behavior
  (sol I1).
- Tags/declared-metrics: wrong source (scenario frontmatter carries only
  `requires_superpowers`/`coupling`), no aggregation registry, no schema home
  (sol I2, glm scope).
- Exploratory suites may omit `profile:` — derivation/refusal unpinned;
  single-arm comparison rendering unpinned (sol I3, k3 I4/OQ2).
- `campaign list` / `campaign status` orphaned — D3 handed all three verbs to
  D4; D4a took only `report` (fable M13, sol I4, glm C5).
- Resume-vs-sealed sentences disagreed (refusal vs regeneration owed)
  (fable I11, glm I4).
- Pre-seal drift incident vanished from the sealed record — D3 D-11 pins
  caveat + operator acknowledgement + repair incident recorded at seal
  (sol B5, fable M12).
- Minors: byte-stability overclaimed ("any host" vs PAR "per-host");
  "pure read" misleading for an artifact-publishing verb; 21-event
  attribution (D1 shipped 20; `quarantined` is D3's E7); CLI citation should
  be the pinned option table + shipped `src/cli/index.ts`, not D3P Task 9c's
  stale code block; "matched determinate cells" vocabulary (PAR) not
  "samples" (sol M1-2, glm M2-3, k3 M1-M5).

## Adjudication (Drew, 2026-08-31)

- **B4 resolution — qualification stays gating.** Option presented:
  (a) keep qualification gating-registered per PAR — D4b sits on the
  qualification critical path, D4a repositioned honestly; (b) amend the
  parent to an exploratory-registered qualification. **Drew ratified (a):
  the rehearsal does not get weakened to go faster.** Consequences, recorded
  as Decision D-7 of the D4a spec: no parent amendment; D4a's value
  proposition is exploratory full-lifecycle proof + D3 live-debt burn-down +
  a seal act proven before D4b builds on it; qualification follows D4b.
- **B3 resolution — two runs, one session.** D4a's exit adds a small GATING
  suite run to predicate-holds, which closes D3 exit-criteria item 1 exactly
  as pinned (gating registration/dispatch run to the seal predicate; its
  seal/report await D4b by D3's own exit-criteria wording). The false
  subsumption claim is retracted (Decision D-5 rewritten).
- **B5 resolution — amend the contract, don't shrink the report.** The D1
  `ReportSchema` receives an additive D4a erratum (Decision D-8): per-cell
  pass/fail counts + coverage, per-comparison medians, two contention
  accounting counters, provenance failed-cells, nullable grader.observed.
  Tags/declared-metrics are deferred to D4b (no schema home, no aggregation
  registry, lowest qualification value — Decision D-9).
- All remaining findings are adopted as revision-2 fixes (no dissent
  recorded on any seat's finding; the panel's convergence made per-finding
  adjudication unnecessary).

## Ratification ledger (durable record — answers k3 OQ4)

- D-1…D-6 (D4a spec revision 1): ratified by Drew 2026-08-31 in the
  brainstorming session preceding this review, with D-4's vocabulary
  collapse corrected in revision 2 (the collapse was a drafting error, not a
  ratified deviation — D3's OQ-11 narrowing stands untouched).
- D-7 (qualification stays gating, no parent amendment): ratified by Drew
  2026-08-31 after round 1 ("agreed on a").
- D-8 (ReportSchema erratum), D-9 (tags/metrics deferral to D4b): adopted
  2026-08-31 from the panel's unanimous B5 findings under the standing
  delegation for non-direction design decisions.

## Revision-2 patch list

| Finding | Fix in revision 2 |
|---|---|
| B1 | Terminus reordered: verify → audit → backstop → render → digest → `sealed(report_digest)` → publish `report.md` then `report.json` (temp+fsync+rename); digest = SHA-256 of canonical report.json bytes; fold excludes the `sealed` event; regeneration digest-verifies |
| B2 | Two dispositions restored: `contention_invalidated` / `unknown_coverage`; drop-from-denominators policy applies to both |
| B3 | D-5 rewritten: two runs in one appliance session; gating run closes D3 item 1 as pinned |
| B4 | D-1 rationale corrected; D-7 records the qualification decision |
| B5 | D-8 pins the additive schema amendment; fold items re-homed |
| Integrity audit | Seal act gains the audit step with its two outcome classes |
| Publication | `report.md` first, `report.json` last, temp+fsync+atomic-rename pinned |
| Unsealed diagnostic | Refusal table implements PAR's blocking-samples diagnostic |
| Adjudication identity | Block-scoped rationale encoding pinned (`block=<id>; <detail>`, per the `attemptScopedRationale` convention); one adjudication per block |
| Gating at terminus | Typed refusal ("sealing/reporting gating campaigns awaits D4b") at both verbs; boundary sentence corrected |
| Accounting | Contention counters added by the D-8 amendment |
| Provenance | Per-run validation, arm union for display only; grader identity pinned to Gauntlet `result.json` config/model; nullable `observed` + pinned empty-evidence rendering |
| Evidence boundary | Exact input allowlist pinned; additions outside it cannot tamper; divergence from journaled digest = loud incident |
| Storage/concurrency | ENOSPC inherits D-13 fail-stop; cancel marker checked at every terminus step (cancel wins); orphan temp cleanup on resume |
| list/status | Explicitly assigned to D4b with rationale |
| Resume-vs-sealed | Three rows: complete-regeneration, refuse-citing-sealed, refuse-citing-cancel |
| Drift incident | Terminus drift recorded at eventual seal via adjudication rationale |
| Profile/single-arm | Missing exploratory profile derives `descriptive_v1`; single-arm comparisons render per-arm rates without delta |
| Minors | Per-host byte-stability claim; artifact-publishing verb wording; 20+1 event attribution; CLI citation fixed; "matched determinate cells" |
