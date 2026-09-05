# Task 8 implementation report

Status: DONE_WITH_CONCERNS — implementation and affected local gates complete; Task 9 public cutover/full gate and previously declared platform evidence remain outstanding.

Base: `d188b3f47480b41ab74b7cf9d4e9ea376aa28926`.
Source commits:

- `cc088f23` — authenticated comparison fold, evidence reader, raw-byte seam, literal oracle, strict contract, anchored publication, and explicit temporary Budgeted source separation.
- `016122f3c49dbe54e25e3682ee1ae56b5e35b3e6` — producer/prefix integration, per-artifact reference damage, final-prefix seal authentication, shared status correction, strict coverage checks and renderer inspection corrections.

Work was confined to the approved `codex/core-comparison` worktree and local temporary fixtures. No subagents, Docker commands, provider/live evals, credentials, remote/appliance/installed actions, historical campaign/results/corpus mutation, push, merge, or artifact migration occurred. Root owns design/plan/checkpoint bookkeeping; those files were not edited.

## Canonical interfaces and contract

- `src/campaign/report-evidence.ts`: `readAttemptEvidence({resultsRoot, expectedIdentity, artifacts}): AttemptEvidence`; `missingAttemptEvidence(reason?)`; `readBlockValidity({campaignDir,state,block}): {available,reasons}`. The evidence reader imports no Budgeted dispatcher/recovery leaf reader.
- `src/campaign/report.ts`: pure `foldComparisonReport({experiment,state,evidenceByAttempt,validityByBlock,interrupted?}): ComparisonReport`. `interrupted` is the read-side caller's conclusive-loss decision; the production reader establishes it against the exact measurement-prefix process. `comparisonReportDigest` is available for the measurement-only JSON.
- `src/campaign/execution-journal.ts`: minimal `readCommittedPrefix(campaignDir): {projection,committed}` exposes the existing authenticated replay result. No second fold or journal policy was added. Existing `readCommittedTransitions` remains unchanged.
- `src/campaign/report-publication.ts`: `readComparisonReadout(args, processes?)`, `readComparisonReport(args, processes?)`, `canonicalReportBytes(report)`, `digestReportBytes(bytes)`, `renderReportMd(report)`, `publishReport({campaignDir,report})`. Read arguments extend `CampaignLifecycleArgs` with required explicit absolute `resultsRoot`. The readout is the shared status/cost/report measurement seam; report refuses an active/registered/unresolved readout. `publishReportFile` is restricted to the three report filenames and reuses `createDurableMarker`.
- `src/campaign/seal.ts`: `sealReport({campaignDir,report})` requires completed usable selected analysis and verified termination, rereads and matches the exact final committed prefix, reauthenticates all anchored artifact bytes, publishes the report, then writes the immutable `report-seal.json` with its digest and identical anchor.
- `src/contracts/campaign/report.ts`: strict `ComparisonReportSchema`, `ReportSchema`, `ReportAnchorSchema`, `AttemptEvidenceSchema`, `PairedQuantitySchema`, and `AccountingQuantitySchema`.

The canonical report envelope is `{report,anchor}`. `report` carries `schema_version: "quorum.comparison-report/v1"`, `fold_version: 1`, campaign/input identity, lifecycle status, `behavior_available`, analytical `complete`, `termination_verified`, per-comparison/scenario summaries, all-attempt accounting, excluded accounting, attempt records, and caveats. The version names this report format; it is not a runtime V1 campaign reader or selector.

Each arm preserves `denominator`, `pass`, `fail`, `indeterminate`, `no_usable_result`, and available counts for subject/grader USD, run wall seconds, and subject/grader token totals. Each paired quantity is `{n,baseline_mean,treatment_mean,mean_delta}`. Empty cohorts have `n:0` and three nulls. Arithmetic means and within-pair treatment-minus-baseline differences are used, with the final floating arithmetic normalized to 15 significant digits to remove binary summation noise. No independent-arm mean subtraction is used.

Accounting quantities are `{known_subtotal,observed,attempts,complete}`. Here `observed` counts fully observed totals for the quantity, not partial-role subtotals. Known partial spend still contributes to `known_subtotal`. Combined coverage requires complete prices for both roles. Missing quantities never become measured zero; an empty known subtotal is explicitly accompanied by missing coverage. Excluded accounting categories `superseded`, `unaccepted`, and `analytically_unusable` overlap and are labeled as nonadditive.

Attempt records retain accepted journal outcomes, selection, analytical eligibility/reasons and authenticated evidence. Evidence includes raw observed outcome, parsed Gauntlet layer (including valid frozen `process_exit`), deterministic checks, run wall seconds, role cost and completeness, role token totals, captured subject `TokenUsage`, versions, missingness, and artifact refs. Strict checks reject nonfinite/negative quantities, complete-null role prices, invalid denominator counts, impossible available counts, duplicate report attempt identity, unknown report fields, and nonnull empty-cohort means.

## Authority, accounting, and evidence decisions

`Experiment` and the shared `CampaignProjection`/`foldTransition` remain the sole execution authority. The reader's projection and anchor come from one `readCommittedPrefix` result. An independent lifecycle observation can precede it, but contributes no measurement identity, transitions, accounting, or anchor. A regression advances the real SQLite prefix during the lifecycle observation and verifies the emitted state and prefix both describe the later committed rows.

Selected coherent block membership is mapped to original primary slots. Reserve attempts replace a whole selected block; they never add planned samples. Paired summaries require both selected members to be analytically usable and determinate. Every quantity then independently requires both matched values. Indeterminate members stay visible in arm outcome counts and all-attempt accounting but exclude the entire pair from conditional quantities. A passing raw artifact never promotes an intentionally accepted indeterminate outcome. A determinate accepted observation also needs authenticated supporting verdict outcome evidence; missing/corrupt verdict bytes cannot support a behavioral result.

Every execution-attempt identity is accounted once, even when both `attempt_observed` and `accounting_observed` carry references. Repeated baseline arms stay separate by comparison/scenario. Superseded and orphan work retains independently authenticated frozen spend and duration. Accounting-only orphan artifacts never acquire accepted behavior. Completion checks original selected slots, so superseded attempts do not prevent an otherwise completed replacement comparison from being complete.

Attempt references are `<runId>/<file>` beneath the supplied shared `resultsRoot`; control/validity refs remain beneath `campaignDir`. The authenticated manifest must have the exact expected campaign/comparison/block/sample/execution-attempt identity and matching run directory. Only recognized role paths inside that manifest supply measurements.

Root confirmed the following interpretation of the approved oracle during final self-review:

- Missing/corrupt/malformed/ambiguous manifest or wrong bound publication identity invalidates the whole publication.
- A non-manifest reference's wrong path/size/digest, missing listed reference, or changed artifact bytes makes only that artifact unavailable. Independent authenticated artifacts survive.
- Unlisted refs provide no values. They never substitute for recognized verdict or usage files.
- An optional malformed role price/duration affects that quantity, not independent fields in otherwise authenticated bytes.

This replaces the first increment's overbroad inventory-equality rejection. Separate regressions cover reference metadata/path/missingness, disk corruption, shared-artifact corruption, whole-manifest/identity failure, and independent optional-field damage.

The shared pinned no-follow descriptor walk now has `readPinnedNoFollowBytes`. `readPinnedNoFollowFile` preserves its text API by decoding those bytes. `readPublishedArtifactBytes` authenticates raw byte length/SHA-256; `readPublishedArtifact` performs fatal UTF-8 decoding only after authentication. A real `writeAttemptManifest` → `publishExecution` → reader test inventories non-UTF-8 bytes and verifies every published reference under a custom-named results root. Binary output is never decoded before hashing. Credential-scope tests remain green.

Prices and usage come only from frozen verdict economics and the independently authenticated capture sidecar. No transcript reads, present-day price tables, or new estimator are used. A real `mergeEstimates` → `buildRunEconomics` → manifest/publisher → reader regression uses one priced and one unpriced model inside the subject role: the known $3 survives, role completeness is false, and tokens remain observed. Such a subtotal contributes to accounting and is excluded from matched role-cost totals.

Run wall seconds use only valid finite nonnegative `finished_at - started_at` from the frozen verdict. Missing timestamps remain missing. Role `duration_ms` never substitutes for run wall duration or campaign elapsed time. Malformed optional captured usage price/duration is normalized to null without erasing independent captured usage counts.

Positive final block validity is independently authenticated beneath `campaignDir`, including ref path/bytes/digest, exact campaign/input/start/block identity, `verdict:"valid"`, exposure inventory, and narrow details shape. Missing or corrupt positive support makes the block unusable with an explicit reason while preserving journal outcomes and independent accounting. The integration regression exposed an incorrect use of the path-based `parseSidecar` API on receipt text; the final reader instead shares the existing pure `isValidSidecarLine` predicate from `contention.ts`. It does not read a current sidecar or invent another validator/evaluator.

Actual settled grader `process_exit` facts remain frozen evidence; reporting never reclassifies accepted outcomes from signal/exit values. Malformed optional process facts remain unknown without erasing an independently parseable Gauntlet judgment. Unsupported subject actor/lifecycle/error claims continue to yield the producer's conservative accepted indeterminate outcomes. Drew's requested subject reporting work remains deferred.

## Lifecycle, anchor, publication and seal

Active/read-only cost output clears accepted outcomes, raw observed outcomes, Gauntlet judgments and deterministic checks. It retains authenticated prices, token counts, artifact references and missingness. No raw passing orphan becomes behavior through this route.

An unended prefix is reportable only after conclusive loss of its exact controller, or its launcher when unbound. Missing binding and unknown process state are insufficient. Root explicitly authorized the narrow shared `observeCampaignStatus` correction in `cancellation.ts`: a known-live bound controller with conflicting host lease authority now returns `unresolved/cancel`; only conclusive death returns `interrupted/cancel`. The report also retains its own exact-prefix death check because lifecycle and measurement reads may observe different prefixes. The existing cancellation regression that expected `interrupted` for this live conflict was updated to the corrected contract; a direct new status/report regression verifies the edge.

The anchor contains campaign/input identity, last committed sequence, prefix digest, the two explicit storage roots, and sorted/deduplicated referenced artifact metadata with a root discriminator. Sorting uses code-unit order, not host locale. A mixed-case artifact regression exposed and fixed locale-dependent ordering.

Canonical JSON uses the existing single JCS implementation plus one newline. The temporary Budgeted renderer also uses that shared canonicalizer. Markdown is derived from the same validated JSON and is excluded from the measurement digest. JSON fixes the anchor before Markdown is published. Existing identical bytes are idempotent; a different prefix, identity, report, or rendering yields a concrete immutable-publication conflict. The existing exclusive durable marker uses staged/fsynced bytes, atomic exclusive hard-link publication and directory fsync; no overwrite/rename fallback was added.

Interrupted/cancelled reports are available without a completed seal and remain explicitly incomplete. Publishing one reserves that report filename/anchor: a later accounting prefix conflicts rather than silently overwriting it. A completed seal requires the exact final completed/terminated journal prefix and all anchored raw bytes to still authenticate. A corrupted termination artifact fails sealing. The seal carries the report digest and the same anchor; it introduces no replay transition or session-replacement authority.

## Literal oracle and manual inspection

The checked-in fixture files are `test/fixtures/core-comparison/{campaign.json,transitions.json,evidence.json,expected-report.json}`. `report-fixture.ts` loads them and uses the Task 2 factory-compatible accepted transition fold. Identifier grammar requires lowercase `b/t1/t2`; these represent the brief's B/T1/T2. Expected numeric summaries were written from the literal oracle, not obtained from production aggregation. The fixture is a pure aggregation/accepted-fold fixture, not runtime/platform proof; real artifact/journal integration is exercised separately.

Exact inspected results:

| Quantity | Result |
|---|---|
| C1/b planned outcomes | denominator 4; pass 1; fail 1; indeterminate 1; no usable 1 |
| C1/t1 planned outcomes | denominator 4; pass 3; no usable 1 |
| C2/b planned outcomes | denominator 2; pass 1; no usable 1 |
| C2/t2 planned outcomes | denominator 2; fail 1; no usable 1 |
| C1 paired pass rate | n=2; baseline .5; treatment 1; delta +.5 |
| C2 paired pass rate | n=1; baseline 1; treatment 0; delta -1 |
| C1 matched subject USD | n=1; 1 vs 2; delta +1 |
| C1 matched grader USD | n=2; .55 vs .30; delta -.25 |
| C1 matched wall seconds | n=2; 55 vs 30; delta -25 |
| All subject USD | known 136; 9/12 complete prices; incomplete |
| All grader USD | known 5.90; 11/12 complete prices; incomplete |
| Combined USD | known 141.90; 9/12 complete combined totals; incomplete |
| Run wall seconds | known 500; 10/12 observed; incomplete |
| Superseded work | 7.70 USD and 70 seconds |
| Unaccepted work | .90 known grader USD; zero accepted behavior; incomplete |

C1/r3 contributes no conditional pair quantities because the selected baseline is indeterminate. The independently available subject means 50.5 and 4 are never compared. Empty token pair cohorts render `missing`, not zero means. All 12 attempt records remain present; never-executed C1/r4 remains in denominators only.

Manual artifacts: `/tmp/task8-rendered/report.json` and `/tmp/task8-rendered/report.md`, produced by `/tmp/task8-render.ts`. I read the full Markdown and independently inspected the JSON counts, paired means, accounting, coverage and attempt inventory. The preview includes links to the actual checked-in fixture inputs with their hashes; its synthetic fixture prefix/input identity is explicitly not an authenticated live publication receipt. The production integration separately opens/hashes every real publisher-returned ref, uses the two real temporary roots, renders/publishes Markdown, and checks the sealed anchor.

An independent Python `Decimal` calculation from twelve literal rows (no production imports) returned subject 136, grader 5.9, combined 141.9 and wall 500, then checked the rendered JSON against all literal counts and matched means. It passed. The Markdown explicitly labels USD, run wall seconds, pair counts, coverage, missing values, incomplete role prices, validity reasons and nonadditive excluded accounting.

## Regression and verification receipts

Initial feature RED: the comparison/publication tests failed on missing new exports/functions. Subsequent functional RED/GREEN receipts were observed for:

- missing authenticated verdict support still entering determinate analysis;
- optional evidence missingness omitted and negative captured price/duration retained;
- superseded attempts incorrectly preventing completed replacement analysis;
- live controller with foreign lease being exposed as interrupted (both reader guard and direct shared status);
- non-manifest reference damage incorrectly invalidating independent artifacts;
- real positive validity receipt rejected by the mistaken path-based sidecar invocation;
- corrupted termination bytes accepted by seal;
- mixed-case reference ordering varying through locale collation;
- complete-null role cost accepted by the report contract.

GREEN producer checks cover custom results-root round trip, binary artifacts, real manifest/publisher output, real captured economics/merge, frozen Gauntlet process facts, authenticated validity, actual SQLite committed-prefix advancement, active behavior hiding, completed comparison, immutable conflict and final-byte/prefix sealing. Shared transition tests reject foreign/reused reserve and duplicate/cross-arm selections before report aggregation; report-level fixtures additionally exercise cross-arm/foreign-reserve/duplicate-attempt corruption.

First increment: 83 affected report/evidence/contract/publisher tests passed, plus lint/typecheck before `cc088f23`.

Final fresh command:

```sh
bun test test/campaign-comparison-contract.test.ts test/campaign-comparison-report.test.ts test/campaign-comparison-evidence.test.ts test/campaign-comparison-publication.test.ts test/campaign-report.test.ts test/campaign-report-evidence.test.ts test/campaign-contracts-report.test.ts test/campaign-attempt-publish.test.ts test/campaign-execution-state.test.ts test/campaign-cancellation.test.ts test/campaign-contention.test.ts test/appliance-credential-scope.test.ts test/campaign-journal-publication.test.ts
```

Result: **250 pass, 0 fail, 1129 expect calls, 13 files, 2.51 seconds**. Full local log: `/tmp/task8-final-focused.log`.

- `bun run lint`: 558 files checked, no fixes/errors, exit 0.
- `bun run typecheck`: exit 0.
- `git diff --check`: exit 0.
- Independent Decimal/rendered JSON assertions: pass.
- Full Markdown inspection: counts/units/coverage/reasons/links reviewed as above.

These are local source/fake-process/temporary-publication receipts, not Docker, real Linux appliance, provider, installed, or live-operation proof. No timeouts were raised. The full repository gate is reserved for Task 9.

## Exact temporary Task 9 cutover inventory

Canonical new modules consume only Experiment/V2 projection and authenticated evidence. Old code was moved, not wrapped in a runtime schema selector:

- `src/campaign/budgeted-report.ts`
- `src/campaign/budgeted-report-evidence.ts`
- `src/campaign/budgeted-seal.ts`
- `src/contracts/campaign/budgeted-report.ts`

Remaining production callers:

- `src/cli/campaign.ts` imports Budgeted report and sample-evidence APIs.
- `src/campaign/recovery.ts` imports Budgeted report, sample evidence and seal APIs.
- Budgeted seal imports Budgeted report, evidence and report contract.
- Budgeted report imports the Budgeted contract. Budgeted evidence retains its old dispatcher/sensor imports until deletion.

Temporary test imports updated to keep the staged cutover compiling:

- `test/campaign-cli-verbs.test.ts`
- `test/campaign-contracts-report.test.ts`
- `test/campaign-report-evidence.test.ts`
- `test/campaign-report.test.ts`
- `test/campaign-resume.test.ts`
- `test/campaign-run-spawner-injection.test.ts`
- `test/campaign-seal.test.ts`

Task 9 must remove the Budgeted implementation/callers and finish public/helper wiring. Public status/costs should use `readComparisonReadout`; behavioral report should use `readComparisonReport`; immutable publication uses `publishReport`; completed final sealing uses `sealReport`. Resolve/pass the actual resultsRoot once. An active readout must never be published as a behavioral report. No resume/restart path is introduced.

## Remaining concerns

- Task 7's expanded Gauntlet environment group remains **99 pass / 2 timeouts**, unresolved. It was not rerun here, is not claimed green, and is not attributed to baseline without evidence. Task 9 owns the full gate and that debt.
- Public/helper cutover and complete V1 removal remain Task 9; the canonical Task 8 functions are implemented and tested but those old public callers are still explicit temporary Budgeted paths.
- Unsupported subject lifecycle/provider-error attribution and richer subject reporting remain deferred by Drew's explicit decision. Reporting preserves conservative accepted outcomes.
- Interrupted publication intentionally conflicts with a later accounting prefix rather than replacing prior anchored evidence. Operators/callers need to surface this conflict.
- No operational cutover, real appliance qualification, installed verification or paid/live validation was attempted.


## Review fix round 1

The independent review at `task-8-review.md` found two Important issues at frozen HEAD `6c9de8229f68dd8c9851fb89bca190f065ad58ed`. Both accepted findings are addressed; fresh independent review is pending. Detailed receipts are in `task-8-fix-1-report.md`.

- `15b691f6c2fde65305d1e2d9620909fb316aef64` addresses I-1. New shared `readComparisonFromPrefix({campaignDir,resultsRoot,prefix,interrupted?})` derives the measurement and complete sorted anchor from the supplied authenticated committed-prefix result. It performs no independent journal read. The existing readout and seal reuse this helper. The seal compares canonical report bytes against the rederived report before writing anything, authenticates the full journal-derived inventory as raw bytes, and publishes that canonical report. Caller-selected inventory, finite subtotal edits, completeness edits, and omitted refs cannot authorize a seal. Exact-prefix and full-byte authentication are both retained.
- `ca888c5e1129b8454fb859b3b8554d81fdefa769` addresses I-2. Every comparison now requires strict `roles: {baseline,treatment}` or `roles: {arm}` copied from the frozen Experiment. The mapping must identify exactly the reported arm inventory; single arms cannot claim pairs. Markdown labels each arm's role and names the baseline/treatment means and signed delta. A treatment-first `variant-b`/`variant-a` fixture retains baseline `variant-a`, treatment `variant-b`, pass means 0/1 and delta +1, and subject means 1/4 and delta +3. Single-arm rendering is explicit.

Regression-first receipts: I-1 initially **7 pass / 6 fail** (all six shape-valid tamper cases incorrectly sealed); its committed focused gate was **28 pass / 0 fail**. I-2 initially **8 pass / 2 fail** (named and single-arm roles absent). The final affected gate after both fixes was **101 pass / 0 fail / 448 assertions / 6 files**, with `bun run lint` (558 files), `bun run typecheck`, and `git diff --check` all passing. Exact commands and logs are recorded in the fix receipt. No full repository gate or Task 7 timeout group was rerun.

The `/tmp/task8-rendered/report.json` and `report.md` preview was refreshed and manually inspected, including both comparison role labels and every accounting table. Both files explicitly identify this as a synthetic fixture preview, not live campaign evidence. An independent Python Decimal check verified unchanged literal totals 136 / 5.9 / 141.9 / 500, coverage, outcome counts, pair means/deltas, and all 12 attempts. Comparing the checked-in expected JSON to the review base after removing only the newly added roles proves the numerical oracle is unchanged. The shared `isValidSidecarLine` validity predicate, raw binary authentication, active behavior hiding, exact-prefix interruption guard, temporary Task 9 imports, and all declared deferrals remain unchanged.
