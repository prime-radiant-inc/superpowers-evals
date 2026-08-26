# Kernel D3 — Approaches Gate Record (2026-08-26)

Gate: settle the three architectural open questions from the D3 spec skeleton
before spec drafting. Committee: `gpt-5.6-sol` (fast mode, max thinking) and
`qwen3.8-max-preview(openai)`, adversarial, read-only, briefed independently on
the same artifact. Artifact:
`.superpowers/drafts/2026-08-25-kernel-d3-spec-skeleton.md` (523 lines; 77 cited
pinned requirements across 8 D3 modules, 12 OQs, 9-task decomposition, errata
E1–E6) — mined from the parent platform design, Phase 0, D1, D2 rev 2, and the
three prior review records.

Related: D1 spec review (`2026-08-24-kernel-d1-spec-review.md`), D2 spec review
(`2026-08-25-kernel-d2-spec-review.md`), Phase 0 multiharness review
(`2026-08-20-phase0-spec-multiharness-review.md`).

## OQ-2 — Global cap semantics → per-sample, ratified (USER-RATIFIED)

Both seats independently recommended **per-sample** (one global slot per sample,
released per sample), the model Phase 0 simulated and historical `--jobs`
implements. Decisive shared ground: per-block semantics silently doubles
effective concurrency against every simulated configuration (G=24 per-block ≈ 48
concurrent runs), invalidates the Phase 0 sweep verdicts and 8-hour
determinations the program already paid for, and doubles the dollar overshoot
bound ("one in-flight wave" = 2G samples). The global cap's unique protective
function is host pressure + aggregate throughput; provider quota and grader
capacity have their own pool caps.

Qwen additions adopted: admission-unit and release-timing settle jointly
(per-sample release — P0's validated primary model); G is unamendable by
construction (new G = new digest = new campaign); registration prints the
derived max-block reading for operators. Fragmentation bounded at ≤1 stranded
slot and already structurally present in subject pools (R-REG-13 covers the
infeasible case).

Phase 0 flagged this "a proposed contract term for kernel deliverable 3, not
silently settled" — settled here by explicit user ratification and recorded
alongside the E1/E2 errata in the D3 spec.

## OQ-1 — KeySelector `wait` accounting → derive, zero amendment

Both seats rejected reusing `pool_blocked` outright: its payload demands an
`until_ts_ms` key-wait cannot know, reuse corrupts the 429 provider-health
signal (provider throttling vs self-inflicted calibration saturation — the
attribution PRI-2524 needs), and it smuggles in an admission-authority
relationship D1 explicitly did not pin ("pool-level admission cap is
authoritative; key selection lives strictly below admission").

The seats diverged on the positive answer:

- **Sol:** extend `run_allocated` with optional `key_wait_ms` — exact sealed
  attribution, old journal rows remain representable, no new event type.
- **Qwen:** no amendment at all — derive the "spawn-gap"
  (`run_allocated.ts_ms − attempt_created.ts_ms`, both pinned) as a materialized
  stat honestly labeled (never claimed as pure key-wait), plus a loud
  operator-visible warning on every wait entry/resolution naming credential +
  duration. Key facts: `wait` is unreachable under honest admission
  (`len × ceil(cap/len) ≥ cap`); it exists as a guard for miscalibration and
  recovery rebuild; the digest covers `campaign.json`, not the journal, so only
  replay semantics were ever at stake.

**Adjudicated: qwen's derive-only** (committee convergence absent; user did not
override). D3 ships zero journal vocabulary amendments. Named escalation path
recorded in the spec: if qualification or a live campaign shows `wait` firing
with durations the confounded gap cannot attribute and PRI-2524 needs sealed
per-credential wait evidence, add a 21st event via D1 erratum (E5 pattern,
binding-only semantics like `attempt_created`).

## OQ-11 — Contention-guard ownership → split, sensors lead, in D3

Both seats: **do not defer.** Full deferral requires a parent erratum
(imperative text: "are registered … gates launch … is recorded"), and deferring
telemetry past qualification is circular — qualification is the very campaign
that must detect contention-induced drift. The guard's economic function:
convert a whole-campaign rerun (~$850, one night — the parent's named worst
case) into a few blocks' reserve draw, because without telemetry + thresholds
you cannot localize invalidation to the blocks inside the contention window.
Whose verdicts die without it: the gating campaign's paired comparisons — the
release-gate decision itself.

Both seats chose split ownership; details differed:

- **Sol:** registration freezes config; dispatcher runs live preflight per
  admission wave, owns monitoring + halt; journal persists breach evidence.
- **Qwen:** registration declares fingerprint + G + thresholds; locks run
  preflight at live-spend-lock acquisition (every `campaign run` resume
  re-checks for free); sensors lead (sampler + sidecar + breach detection); no
  new journal events — telemetry in a sidecar evidence file (parent pins
  "recorded," not "journaled"; the 20-event vocabulary has no telemetry
  surface), seal-time invalidation renders via the pinned `adjudication` event,
  D4 applies thresholds.

**Adjudicated: qwen's split, sensors lead.** Sol's own unstated list
independently converged on the sidecar (raw high-rate samples must not enter
the fsync-per-event journal; sidecar + journaled summary needs an explicit
recovery contract). Locks-acquisition preflight re-runs free on every resume;
dispatcher stays off the telemetry critical path (blind spots at contention
peaks are exactly when sampling must not lag).

## Sub-decisions handed to the spec draft (from the seats' unstated lists)

- Host fingerprint digest membership: lean include (designated host is part of
  campaign validity conditions; R-REG-4's exclusion list doesn't name it) —
  drafted as a decision, spec-review gate challenges.
- Breach semantics: live breach halts admission (operator inspects/resumes;
  R-DSP-11 drift-halt precedent); invalidation applied at seal via
  `adjudication`; no runtime cancel, no new disposition value (the
  contention-invalidated disposition-vocabulary gap is noted as a D4 open item).
- Telemetry sidecar recovery contract: sidecar is evidence, not replay-required;
  journal self-sufficient for replay.
- D1 seam-map defect (contention guard assigned to no module): surfaced as an
  erratum/finding on PRI-2874, same pattern as P0 surfacing E1/E2.
- OQ-2 and OQ-11 share the term "fixed global concurrency" — settled jointly
  (per-sample unit).

## Two-bounce / process notes

- Gate ran once, no rejections; both seats composed with the pinned
  requirements rather than re-litigating them.
- The skeleton's OQ-1 framing ("how is wait journaled") pre-narrowed the option
  space; qwen's derive-only answer came from challenging the presupposition.
  Worth checking framing bias in future skeleton OQs.
- Remaining OQs (OQ-3..OQ-10) settle from source constraints during spec
  drafting; the spec-review gate is their check.

## Artifacts

- Skeleton: `.superpowers/drafts/2026-08-25-kernel-d3-spec-skeleton.md`
- Spec draft (next): `docs/superpowers/specs/2026-08-26-kernel-d3-campaign-engine-design.md`
- Committee seats: sol `913d710d`, qwen `14b6367f` (both reports in Paseo history)

---

# OQ-11 second round — invalidation timing (2026-08-26, post-ratification)

At ratification of the D3 spec (revision 4, main @ `4f1782c`), Drew
**re-opened one facet** of the OQ-11 adjudication: when
contention-breach-overlapping blocks are invalidated. Everything else in
D-3/D-4/D-5 stood (admission-only halt, sensors-lead split, sidecar +
coverage predicate, digest-frozen parameters). The material change since
round 1: ratified erratum E7 built the full replacement/refill lifecycle,
reducing dispatch-time refill's marginal cost to one enum literal.

**Seats (fresh, independent):** sol (`aa13aa36`, fast mode, max) and
fable (`8da477cb`, xhigh). **Both converge on (b): dispatch-time
invalidation + reserve refill at breach RESOLUTION (window closed), with
seal-time application retained only as the backstop for still-open-at-end
breaches and coverage-unknown blocks.** Both independently reject (c)
(hybrid confirm) on the same ground: a `block_replaced` mint is
irreversible — "confirmation" is either an inexpressible rollback, a new
hard recovery dependency on non-replay evidence, or a redundant audit.
Both state the honest cost: the sidecar (non-replay evidence) now feeds an
irreversible spend decision, and a correlated breach can exhaust many
per-cell reserves at once — (b) changes the bound (spend only
already-priced reserve capacity) but does not guarantee the "few blocks"
outcome.

**Merged pins (union of the seats' conditions; adjudicated convergent):**
refill is `block_replaced { kind: 'replacement', reason: 'contention' }`
— never rerun-kind (reserve count is the recurring-breach loop
terminator); invalidation instant = breach resolution only; live
overlapped blocks are superseded analytically, never killed — slots held
to service end (admission-only halt untouched); exit sample fsynced
before the dispatcher receives the closed-window notification; one pure
evaluator owns edges/coverage/overlap/tri-state, shared verbatim by
dispatcher and D4; tri-state precedence: breach overlap → invalid, else
uncovered overlap → unknown (never contention), else clean; landed mints
are journal-authoritative — later sidecar loss renders an attribution
caveat, never rollback (D4 recompute mismatch = corruption-class
integrity finding, no reversal; (c) not reintroduced through the back
door); correlated obligations processed in frozen
comparison/cell/replicate + lineage-mint order, lowest reserve ordinal
first — never completion/outcome order; one shared per-cell reserve
across instrument/skew/exposure-audit/contention (no partitions;
registration guidance updated); contention refill is NOT reserve-neutral
and passes R-DSP-6; durable budget stop → `replacement_suppressed`,
raises never resurrect; crash mid-batch: one writer critical section,
idempotent prefix completion, remaining mints re-derived from the sidecar
(landed mints never duplicated); block interval =
journal-reconstructable conservative span (earliest roster
`attempt_created.ts_ms` → latest service-end terminal, clipped at breach
closure for still-live samples); registration warns on zero-reserve
suites ("contention invalidation will be shortfall-only"); operator
output at resolution prints affected/refilled/exhausted/suppressed counts
before "admission resumed".

**Amendment scope:** per the seats' converged lists — D-3 (breach
handling + accepted-cost paragraph replaced with shared-reserve
guidance), D-5 (rewritten), scope/non-goals rescope ("no new event type;
one additive E7 reason"), E7.2 `+ 'contention'`, R-DSP-5/6/11 (+ mirror
requirement for the resolution batch), sensors handoff, R-RCV-2/R-RCV-7 +
fate-table row extension, D4 handoff narrowed (authoritative mints;
backstop only for open/uncovered), D4 open item narrowed
(`contention_invalidated` → open-at-end shortfall; `unknown_coverage`
for gaps), validation fixtures (refill, correlated draw, deterministic
exhaustion, crash mid-batch, sidecar loss, open-at-seal backstop), task
1/7/8/9 one-liners. D-4 unchanged. Historical records append-only.

**User ratification:** RATIFIED (b) with the merged pins, 2026-08-26.
