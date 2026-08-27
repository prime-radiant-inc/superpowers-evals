# Kernel D3 — plan-review record (gate rounds 1–2)

Companion to `2026-08-26-kernel-d3-spec-review.md` (the spec arc). This file is
the durable record of the D3 implementation-plan review arc. The artifact under
review: `docs/superpowers/plans/2026-08-26-kernel-d3-campaign-engine.md`
against the ratified spec `docs/superpowers/specs/2026-08-26-kernel-d3-campaign-engine-design.md`
(77 R-IDs, 13 Decisions, E7 amendment; ratified 2026-08-26, main @ `aa6296f`).

## Round 1 (2026-08-26, sol seat `6ecdfa9d`, fast mode, high thinking)

**Verdict: NOT-READY** — 10 Criticals, drafting-fidelity class, plus a
structural finding (only Task 4 executable-sized). The verbatim report was lost
with its session; the orchestrator re-derived and verified the list from the
plan text (5 carried over verbatim + 2 re-derived; classifier 14-row table
verified clean). The verified findings, as fixed in round 1 of corrections:

- **F1** — self-failing 429 matcher: plan's own test asserted
  `'the model said "rate limit 429"'` → null while its row-3 matcher
  (`/429/ && /rate limit/i`) matched that exact string.
- **F2** — `LeaseHandle.heartbeat()` never scheduled: zero
  `setInterval`/timer wiring anywhere; live-spend lock goes stale mid-campaign
  → reclaimable → double-spend hazard (REV-2 P-3).
- **F3** — `admitWave` iterated the longest-first-sorted queue backward
  (`for (i = waiting.length - 1 …`) → shortest-first, inverting R-DSP-2/4.
- **F4** — `performStoragePause` defined but never called from `SQLITE_FULL`/
  sidecar-ENOSPC paths (D-13 fail-stop unwired).
- **F5** — `(args.sampler as never).injectClosedWindow(...)` test seam +
  an implementer note instructing "wire the dispatcher's sampler handle".
- **F6** — snapshot verify cadence unwired: optional no-op-defaulted
  `snapshotVerify` injection fired per-wave only; sole production caller
  (`resumeCampaign`) didn't pass it; no block-terminal/pre-seal cadence;
  `SnapshotDriftError` catch halted on prose without the D-11 sequence
  (`driftAffectedBlockIds`/`repairDriftedTrees` never called).
- **F7** — live-cancel dead: dispatcher signal handler never journaled
  `campaign_cancelled` nor completed partial mint bundles (D-12 order
  incomplete); `cancelCampaign` live path always timed out into post-crash;
  no `aborted` idempotency.

**Adjudication (Drew):** fix round, not redraft. qwen corrector seats died 3×
on provider-side `-32603 terminated` (qwen-code was failing host-wide all day —
daemon log evidence), landing only F2. **Drew flipped the corrector to fable**
(seat `72006b9a`, bypassPermissions, xhigh; ~$243).

**Correction round 1 (fable) reported:** F1–F7 fixed (F2 verified + hardened);
re-split 9 tasks → 24 executable units (23 `####` sub-tasks + Task 4); sweeps
S1–S6 run (found/fixed: second self-failing matcher row (gemini), missing
`openJournalRead` impl, 4 missing event emitters (`exposure_started`,
`skew_excluded`+`skew_refill`, `quarantined`), sampler notify-before-append
ordering, fingerprint self-comparison, poll-hang main loop); 77/77 coverage
re-derived. One NEEDS_DECISION recorded in Task 9c: R-DSP-10 `budget_raise`
append surface — **DECIDED (Drew, 2026-08-27): defer to D4** (he almost never
sets a start budget; `budget_usd` is schema-required at `suite.ts:64` but
registration prices the grid; revisit with operator evidence, possibly bundling
estimate-derived defaults). Receipt edit to the 9c open item pending gate.

Orchestrator spot-check of round 1: F1 matcher/fixtures consistent, F7 handler
does full D-12 order via marker detection, coverage 77/77, `wire` notes zero,
`as never` 31→14. **Note:** the corrector's "every block parses" backstop claim
proved weak — round 2 immediately found a duplicate-`const` compile blocker its
parse step should have caught. Treat corrector self-verification as advisory.

## Round 2 (2026-08-27, sol seat `de8b2093`, fast mode, max thinking)

**Verdict: NOT-READY** — 12 Criticals + 2 minors. Sol executed the matcher
fixture matrix directly; the rest is a static gate (the artifact is a plan).
Orchestrator spot-verify of Critical 1's components: **4/4 confirmed**.

F-fix verification: F1 FIXED (residual minor: missing `/i` flags); F3 FIXED;
F5 FIXED locally; F2/F6/F7 PARTIAL; F4 not fixed end-to-end.

The 14 classifier rows, five marker-row order/defaults/maxima, ID regex, and
21-event vocabulary count match the pinned literals.

### Criticals (round 2 — verbatim, the fix-round-2 brief)

1. **The plan is not executable as written.** Location: `runCampaignDispatch`,
   `BlockReplacedPayload`, `rebuildMaterialized`, Task 9c Step 9. Defect:
   `runCampaignDispatch` declares `const tracker` twice; `BlockReplacedPayload`
   is an intersection that incorrectly requires the legacy `cause` field on
   fresh payloads; `rebuildMaterialized` calls unwritten
   `JournalWriter.rebuildProjectionsFrom()` and tests call unwritten
   `snapshotTables()`; `campaign-cli-verbs.test.ts` is promised but contains no
   test body. Whole-input `as never` casts still bypass the production types.
   Pin: E7.2, R-JRN-10, every-subtask-green-commit. Smallest fix: supply the
   missing implementations and CLI tests, make the payload type a validated
   legacy/fresh union, remove the duplicate declaration and production-shape
   casts, then execute every subtask's stated verification command.

2. **Registration still violates snapshot-first intake and has unsafe repair.**
   Location: `readSnapshotIntake`, `registerCampaign` steps 3/9/10,
   `repairDriftedTrees`. Defect: scenarios, agents, credentials, and arms are
   consumed through `git show` before the final campaign path is selected and
   materialized — explicitly the order the frozen spec forbids. Any
   materialization error then removes every tree, without first identifying
   the drifted direct children, and leaves `.quorum-snapshot-ok`; the D2
   materializer consequently skips install/wrapper reconstruction over newly
   recreated trees. Pin: snapshot-first registration, D-7/P-4/S-8, R-REG-5,
   R-DSP-12. Smallest fix: transcribe an explicit algorithm satisfying
   final-path materialization before intake, restrict repair to
   identity-checked drifted trees, remove the completion marker before
   rematerialization, and verify the rebuilt wrapper/tree set.

3. **Pricing overrides have no production intake or valid costing.** Location:
   `RegisterArgs`, `registerCampaign → prepareRegistration`, `preDigest`,
   grader-attestation tests. Defect: only internal `RegistrationInput` accepts
   `pricingOverrides`; public `RegisterArgs` does not, `registerCampaign` does
   not pass them, and `campaign.json` does not receive them. Gating
   registration therefore rejects unless a test bypasses typing. An unpriced
   arm with an override is assigned `cost_usd: 0`; `per_token_usd` is never
   multiplied by token volume. Pin: R-REG-3, R-REG-11/12, the frozen
   `pricing_overrides` campaign contract. Smallest fix: define spec-compliant
   override intake, persist it, and compute override costs from an identified
   token-volume source. If that source is not already pinned, this requires a
   decision before implementation.

4. **Campaign children cannot launch under the proposed lock/key/pool wiring.**
   Location: `buildCampaignChildArgv`, `childCoveredEnv`, Task 9c's
   `executeRunCommand` wrapper, `blockDemandVector`, `tryAdmit`,
   `releaseSample`, `superviseSample`. Defect: children invoke the snapshot's
   public `run` entry with `QUORUM_COVERED_BY_LIVE_SPEND_LOCK=1`; Task 9c makes
   that entry acquire a lock, while `acquireLease` deliberately refuses
   acquisition under that marker. Separately, `blockDemandVector` ignores its
   actual `graderPool`, releases use the reserved constant, key waits resolve
   immediately with zero wait, grader selection never occurs, per-key
   in-flight state is recreated empty per sample, and selected key values are
   not projected into child env. `DetachedChildSpawner` also does not replay
   stdout or an exit observed before callbacks are registered, so a fast child
   can lose `run_allocated` or terminal notification. Pin: R-LCK-2,
   R-DSP-1/8, R-SPN-3/5/6/7. Smallest fix: bypass top-level lock acquisition
   only for explicitly covered children, aggregate and release actual pool
   keys, maintain real per-key load and await `Clock`, select both roles and
   project their values, and latch/replay pre-subscription child output and
   exit.

5. **E7 replay and materialization do not enforce the frozen instance model.**
   Location: `BlockReplacedFreshPayload`, `RunAllocatedGrantPayload`,
   `foldPrefix`, `sealPredicateHolds`, `replayEvents`, `rebuildMaterialized`.
   Defect: schemas do not enforce replacement-versus-rerun roster/reserve
   rules or unique grant roles. The folds accept duplicate
   predecessors/successors, cycles, cross-cell or cross-arm links, and
   incomplete disposition rosters. `replayEvents` routes `sealed` directly
   from `running` through `applyCampaignEvent`, which rejects because `sealed`
   requires transient `sealing`; valid sealed journals therefore become
   corruption. Incremental/rebuild parity remains prose-only. Pin: E7.1–E7.3a,
   E7.5, R-JRN-7, R-JRN-10. Smallest fix: add cross-field schema refinements
   and one shared instance-graph validator, model the sealing transition
   correctly during replay, and implement/test byte-identical incremental
   versus rebuild projections.

6. **Contention evaluation and recovery can produce the wrong disposition.**
   Location: `thresholdViolations`, `parseSidecar`, `evaluateContention`,
   `resolveClosedWindow`, `contentionResolutionBatch`. Defect:
   `load1_per_core` compares raw load rather than load divided by CPU count.
   Live evaluation passes `campaignOpenedTsMs: 0`; torn-tail state is
   discarded; explicit gap lines do not directly create uncovered intervals;
   callers derive block intervals differently. Within a batch, activated
   reserves are not tracked locally, allowing multiple obligations in one cell
   to select the same reserve. Recovery treats any cell adjudication as
   resolved and omits the resolution-time budget gate. Pin: D-3/D-4/D-5,
   R-DSP-4/6/11. Smallest fix: normalize load using the frozen core count,
   pass the journal's actual `campaign_opened` time, make the shared evaluator
   own gap/tail/interval derivation, and make the shared batch maintain local
   activation and exact obligation-resolution state with the same budget
   predicate in recovery.

7. **The sensor and classifier tables are declared but not reachable from
   production evidence.** Location: `ExposureProbe`, `trajectoryExposureMs`,
   `sensorEvidenceBySample`, `superviseSample`, the implementer note saying no
   `exposure_audit` path exists. Defect: no per-harness runtime probe registry;
   only terminal capture is consulted. Inclusion-changing runtime/capture
   divergence cannot emit the mandatory `reason: 'exposure_audit'`. Rate
   limits consume only undifferentiated child stderr despite the registry
   naming verdict, gauntlet-result, and event-stream sources; testing the same
   line against both credentials can attribute grader evidence to the subject.
   Billing exhaustion is explicitly left without a detector, leaving
   classifier rows unreachable. Pin: D-9/D-10, R-SNS-1–5, R-CLS-3. Smallest
   fix: provide concrete per-harness runtime probes, capture re-derivation
   plus exposure-audit minting, and source/role-tagged rate-limit and billing
   evidence feeding the classifier.

8. **Heartbeat ownership and teardown are unsafe despite F2.** Location:
   `makeHandle.heartbeat`, `acquireLiveSpendLock`, `JournalWriter.release`,
   `runCampaignDispatch`, Task 9c's `executeRunCommand` wrapper. Defect: a
   reclaimed old holder can heartbeat into the successor's newly created lock
   directory because heartbeat never checks the captured directory identity.
   Campaign-id write, writer election, checkpoint, sampler, or dispatcher
   exceptions can leave the heartbeat active. `JournalWriter.release`
   checkpoints before closing/releasing, so checkpoint failure leaks the
   lease. The dispatcher lacks an outer `finally`; current `executeRunCommand`
   calls `process.exit`, which bypasses the proposed release `finally`. Lock
   polling also bypasses the injected `Clock`. Pin: R-LCK-1/2, D-7 lease
   semantics, the repo's Clock discipline. Smallest fix: identity-guard every
   heartbeat write, roll back every post-acquisition failure, make lease
   release unconditional even when checkpoint fails, wrap dispatcher resources
   in `finally`, return exit codes rather than calling `process.exit`, and use
   `Clock` for polling.

9. **F4 does not implement D-13 fail-stop or E7.7 budget truth.** Location:
   `appendCritical`, `enterStoragePause`, `tryAdmit`, `terminalEvidenceActions`,
   `mintReplacement`, resume reconciliation. Defect: after both
   admission-event writes fail, `appendCritical` returns normally; `tryAdmit`
   then installs live state and spawns children. The new block is not yet in
   `liveBlocks`, so the pause kill misses it. Recovery reconstructs only
   `run_completed`, not the fate table's instrument/exposure/spend/snapshot/
   pool evidence or recomputed skew/adjudication events. Spend uses the
   registration estimate rather than actual terminal cost, recovery does not
   write a reconciled absolute snapshot before admission, and non-contention
   replacements are minted without the dollar predicate. Pin: D-13's full fate
   table, R-JRN-12/E7.7, R-DSP-5/6. Smallest fix: make failed admission append
   abort and roll back the admission transaction before spawn; implement a
   typed fate-aware recovery reconciler; source actual costs from terminal
   artifacts; and budget-gate every replacement before minting.

10. **F6's D-11 sequence releases work before death is proven.** Location:
    `handleDrift`, `tryKillGroup`, `releaseSample`, `repairDriftedTrees`.
    Defect: the live drift path performs no R-RCV-1 identity guard, does not
    wait after SIGKILL or verify death, then immediately releases pools and
    queues reruns. Old callbacks may later journal terminal/spend against the
    superseded block while the replacement is already spending. The retained
    snapshot marker also prevents complete reconstruction. Tests use fake PIDs
    and only assert event order. Pin: D-11, R-DSP-11, R-RCV-1, service-end
    release. Smallest fix: use one awaited identity-guarded
    TERM→wait→KILL→verify helper, release and mint only after verified death,
    suppress stale callbacks, remove the marker during repair, and test with a
    real process group/grandchild.

11. **F7's live and post-crash cancellation paths are not equivalent or
    idempotent.** Location: `activeSection`, the signal handler,
    `killJournaledPgids`, `cancelCampaign`, `planRecovery`,
    `terminalEvidenceActions`. Defect: `activeSection` is never assigned
    around mint operations, so its awaited promise serializes nothing. Kill
    helpers do not perform wait/escalate/verify. Post-crash in-flight mapping
    scans only frozen blocks, so reserve/rerun instances can be aborted under
    the wrong ID. The marker reason is not recovered on the post-crash path.
    `planRecovery` discards `void_attempt_readmit`, leaving
    pre-`run_allocated` crash windows stuck. Existing tests cover only
    primary/happy-path prefixes. Pin: D-12, R-DSP-7, R-RCV-1/2/5/7. Smallest
    fix: introduce a real serialized control critical section, reuse the
    verified-kill primitive, resolve attempts against the admitted instance
    chain, read the marker reason on both paths, execute every resolver
    action, and test every crash cut for primary, reserve, and rerun
    instances.

12. **The CLI surface drifts from the pinned table and its test does not test
    the verbs.** Location: Task 9c `campaign run` registration,
    `campaign-lock-threading.test.ts`. Defect: the plan adds three forbidden
    `campaign run` options despite the pinned "none in v1" row. Conversely,
    `campaign register` needs evals/gauntlet/superpowers source checkouts but
    its registered options expose none and default gauntlet to the evals repo
    root. The lock-threading test invokes `acquireLiveSpendLock` directly; it
    never launches direct `quorum run` or `run-all`, so it cannot prove either
    integration. Pin: the exact CLI option/default table, R-RCV-7/R-LCK-2.
    Smallest fix: remove the extra run options, define the authoritative
    non-CLI checkout discovery mechanism, and add subprocess tests exercising
    the actual three spender entrypoints.

### Minors (round 2)

- M1: add `/i` to both HTTP status-line matcher branches (OpenAI row + generic
  row).
- M2: fix the suite-name intersection prose — the pinned ID grammar permits
  underscores.
- Structural: the re-split is only structural — Tasks 8b and 9b remain large
  multi-lifecycle implementations; the defined-but-unwired and `as never`
  classes therefore remain at reduced scope.

## Adjudication

Two consecutive gate rejections on the same artifact → **the two-bounce rule
fires**: stop gating; a top-tier model takes the phase conversationally, output
scribed back here. Diagnosis: the plan is 12.5k lines of uncompiled
code-as-prose; each static gate finds a new defect layer (round 1: drafting
fidelity; round 2: contract/semantics). The loop is not converging by review.

Path (per rule): no third dispatched gate. Round-2 findings are fixed by a
top-tier seat working from this record; the orchestrator verifies every landed
fix directly against the plan text (per-hunk, not per-claim). During SDD, each
unit's first step compiles the plan's code blocks, so any residue surfaces with
a compiler instead of a review round.
