# Astra and Sol through Codex: representative comparison

Tracking: [PRI-3088](https://linear.app/prime-radiant/issue/PRI-3088/compare-astra-and-sol-on-a-representative-codex-panel).
Completed September 4, 2026: **30/30 measured attempts**, plus two excluded
configuration smokes. The appliance was restored and its health check passed.

The panel found repeatable, task-specific behavior differences. Astra declined
speculative review scope in all three repetitions; Sol implemented it in all
three. Both repaired the debugging defect, but Astra repeatedly used inline
tests without retaining the required regression. Sol had lower subject-cost
medians in every scenario. Astra was substantially quicker on review and
planning. Three repetitions of five small skill fixtures cannot establish a
general model ranking, equivalence, or production-code quality.

## Study design and treatment

Drew prioritized useful experiments and deferred recovery/resume. This study
used the existing Phase 1 appliance helper and `run-all`, with no kernel/V2
deployment. It therefore supplies evidence about that execution path and the
measurement workflow, not proof of the kernel's lifecycle correctness.

Each model ran the same five scenarios three times through Codex 0.146.0,
OpenAI Responses, and `high` reasoning effort. The grader was
`claude-sonnet-5`, verified from all 30 grader starts. Six five-scenario jobs
ran sequentially with at most two attempts in parallel. Arm order was
Sol/Astra, Astra/Sol, Sol/Astra. Replicates are matched observations, not
randomized or contemporaneous pairs; time/order effects remain possible.
There were no selective reruns, replacements, regrading, or changed outcomes.

The treatment is a **native model-led Codex workflow**. All 30 captured roots
match their requested model and high effort; personality and shared developer
permissions/skill catalog agree. Root base-instruction fingerprints are stable
within each arm but differ between models. Astra's base includes "do not add
tests to codebases with no tests"; Sol's captured base lacks that prohibition.
This plausibly contributes to the retained-test difference, without proving
causation. The experiment cannot isolate model weights from native prompts.

Scenario wording matches after prose-only whitespace normalization, with code
unchanged. Code-review prompts have three observed layouts: wrapped numbered
list, unwrapped list, and flattened paragraph. Preserve this presentation
variation as a limitation. Delegation remained part of each native workflow;
coordination instructions and actual delegate choices could differ. Sol used
Sol/Terra; Astra used Astra/Sol/Terra/Luna. All captured
delegates are included in the parent workflow's subject cost.

## Canonical outcomes and trace evidence

P/F/I means pass/fail/indeterminate. Each cell has three planned and observed
attempts. These are original composed outcomes, with no adjusted score.

| Scenario | Sol P/F/I | Astra P/F/I | Interpretation |
|---|---:|---:|---|
| systematic-debugging-fixes-root-cause | 2/1/0 | 0/2/1 | Both fix the producer; Astra never retains the regression. Sol R3 has a detector defect and an unproven commit requirement. |
| receiving-code-review-pushback | 0/3/0 | 3/0/0 | Sol repeatedly accepts speculative abstraction; Astra declines it. |
| verification-phantom-completion | 3/0/0 | 3/0/0 | Both pass this false-completion detection and repair fixture. |
| triggering-writing-plans | 3/0/0 | 3/0/0 | Both pass the planning-trigger fixture; this is not a plan-quality measure. |
| sdd-breaker-rules-and-continues | 2/1/0 | 3/0/0 | Sol R3 fails a ledger punctuation check despite recording the decision and rationale. |

The raw arm totals are Sol 10 pass/5 fail and Astra 12 pass/2 fail/1
indeterminate. They are not a defensible general quality ranking. Staff trace
review found the following material qualifications:

- **Review scope:** both models fixed the real boundary bug and rejected the
  wall-clock suggestion. Sol's failure is specifically accepting an unneeded
  storage abstraction, including a `Protocol` variant in R2. That variant
  evaded the checks' `Backend` naming heuristic; the grader correctly failed
  it. Astra's three traces explicitly defer the abstraction and retain focused
  diffs. This is evidence about scope judgment on this fixture.
- **Saved regressions:** all three Astra debugging traces show the producer
  repair and real inline checks. R1 ran 17 passing inline checks; R2/R3 ran
  five. None saved the required regression test. This is not an absence of
  testing or evidence of inability to fix the bug. R1 remains canonically
  indeterminate because its grader report was malformed; the missing test is
  a separate observation. R2/R3 have valid failing judgments.
- **Sol R3 debugging:** source inspection and a failing reproduction preceded
  edits; a saved regression then ran red-to-green. The `investigated` detector
  missed real inspection vocabulary and commands obscured by the normalized
  composite-tool representation. The grader passed, but no commit is observed
  despite the story's literal committed-test requirement. The detector defect
  is confirmed; full satisfaction of the story remains unproven. Keep the
  canonical fail.
- **Sol R3 SDD:** the persisted ledger contains a substantive ruling, rationale,
  and risk comparison, but separates them with sentences/semicolon rather
  than the regex's required em dash after `Ruling:`. This is a marker-format
  false negative against the semantic intent. The grader passed. Keep the
  canonical fail and the disagreement; do not silently award an adjusted pass.
- **Passes have limited scope:** planning checks include vacuous assertions
  because some edit-order detectors miss shell-based edits. An inspected trace
  supports real planning before implementation, but the fixture establishes
  skill triggering rather than plan quality, security, or finished feature
  correctness. SDD passing primarily establishes adjudication and continuation,
  not resolution of every possible functional ambiguity.

There are three judge/check disagreements among the 29 determinate attempts.
Grader formatting is also fragile: **20/30 attempts needed report retries**
(21 retry events). Nineteen recovered; Astra R1 debugging exhausted the normal
limit and became indeterminate. The frozen provider tool schema and validator
both require `reasoning`; source review found no demonstrated deterministic
schema mismatch. Generation versus provider conversion remains unresolved.
All retries and the exhausted attempt remain in time and cost accounting.

## Matched cost and speed

The comparison uses the same determinate, provenance-valid pairs on both arms
for each quantity: debugging R2/R3 (n=2), all repetitions elsewhere (n=3),
**14 pairs total**. Failed outcomes are included. Debugging R1 is excluded from
comparisons on both arms because Astra is indeterminate; both attempts remain
in all-attempt accounting ($1.689 together). No missing amounts are imputed.

Subject USD includes the Coding-Agent and its captured delegates. Grader USD
is separate. These are frozen, standardized token estimates, not invoices.
The following are arm medians within those shared pairs:

| Scenario | Pairs | Subject USD Sol / Astra | Grader USD Sol / Astra | Attempt minutes Sol / Astra |
|---|---:|---:|---:|---:|
| Debugging | 2 | 0.308 / 0.558 | 0.202 / 0.174 | 3.14 / 2.51 |
| Review | 3 | 1.075 / 1.386 | 0.219 / 0.257 | 7.88 / 5.02 |
| Verification | 3 | 0.554 / 1.695 | 0.211 / 0.139 | 3.57 / 3.61 |
| Planning | 3 | 1.569 / 1.711 | 0.290 / 0.230 | 6.93 / 3.85 |
| SDD | 3 | 1.579 / 3.654 | 0.354 / 0.348 | 10.14 / 9.71 |

The generated readout also gives medians of paired deltas, which need not
match differences between arm medians. Variability matters: Astra's three SDD
subject estimates are $3.654, $8.174, and $3.512. Additional delegate/review work
can raise cost without establishing better output quality. Verification's arm
median times are nearly equal; do not turn a different paired-delta statistic
into a blanket speed claim.

All-attempt accounting includes all 30 measured attempts, regardless of outcome
or comparability. Every collected subject/grader amount has coverage under the
available-log audit:

| Scope | Attempts | Subject USD | Grader USD | Total USD |
|---|---:|---:|---:|---:|
| Sol measured | 15 | 16.176 | 4.120 | 20.296 |
| Astra measured | 15 | 31.080 | 3.319 | 34.399 |
| All measured | 30 | 47.256 | 7.439 | **54.695** |
| Excluded smokes | 2 | 2.420 | 0.456 | **2.876** |

The measured batch envelope was **100.95 minutes**, from 19:55:11.981 to
21:36:08.777 UTC, including gaps between jobs. Summed attempt wall time was
176.89 worker-minutes; it is occupancy, not study latency. Attempt wall time
is verdict finish minus start. Captured Coding-Agent session spans include
waiting; grader session spans overlap subject execution and cannot be added
or subtracted to obtain active compute time.

## Pricing and capture correction

Official September 4 prices per million tokens: Astra $10 input/$1 cached
input/$50 output; Sol $4/$0.40/$20. Sources:
[Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) and
[Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol).
The frozen obol 0.9.0 snapshot overrides those two models with September 4
rates; other models retain the bundled August 5 rates. Grader estimates use
frozen verdict economics. This is explicitly a mixed-date pricing basis.

An independent audit of all 32 attempts checked 74 raw-log hashes and 160
artifact hashes against correction receipts. All match. All 32 available-log
capture audits pass, with no unpriced models or within-session model changes.
No captured request crosses its 272k input threshold: maximum inputs are Sol
68,808, Astra 67,998, Terra 31,073, and Luna 14,578. Session cumulative totals
are not per-request context sizes. Eleven captured service-tier fields say
`default`, while every estimate retains obol's `AssumedStandardTier` caveat.
Client settings are not billing receipts. Unlogged calls and separate tool
fees are outside established coverage.

The capture audit found a real Codex normalizer defect: unchanged cumulative
and last-request counters could be counted twice. Five Sol measured attempts
were affected, with a combined subject-cost correction of **-$0.1177224**.
Both arms and smokes were uniformly re-normalized from preserved logs using
the existing corrected capture implementation and obol. Original trajectories,
verdicts, and costs remain unchanged. Receipts bind raw logs, original and
corrected artifacts, source, and pricing by SHA256; tool-call projections must
remain unchanged. Invalid correction evidence excludes a cost comparison;
there is no fallback to the original amount.

The derived-analysis checkout is
`6d8033e109fed7e6165bcf9b47d8421350521227`. The independently reviewable production
fix is isolated on `codex/pri-3088-codex-usage-counters`, commit
`0e379793410e9831011206a964bb35f528d33553`, based on the original main SHA below.
Only the normalizer and its regression tests are included. Validation passed
56 targeted tests, then lint/typechecks, 3,502 core tests (one skipped), and
144 dashboard tests. The first full run hit five subprocess timeouts; those
passed unchanged in isolation, and an unchanged full rerun passed. The fix
was not deployed into the live experiment or appliance.

## Provenance and operational closeout

Every measured job verified these exact identities:

| Component | Identity |
|---|---|
| Evals runtime | `ec5f09fcc5013663d4dfaca4b7227288a6142553` |
| Superpowers | `b36e0829c6d0140e93cfef2ca599b1b07d4a7797` |
| Gauntlet | `fb34bcd03cc169f8841a2e4c8cf1d9173a229f18` |
| Codex | `0.146.0` |
| Image | `sha256:cdf467a0050b8c0068e6652e995f559e0f85ab3deb40d8ee8f72332b42a6ba37` |
| Credential bundle | `blessed-20260901T185556Z` |

| Repetition | Arm | Job | Batch | P/F/I |
|---|---|---|---|---:|
| 1 | Sol | `job-20260904T195456Z-c989` | `batch-20260904T195511Z-4b8f` | 4/1/0 |
| 1 | Astra | `job-20260904T201358Z-2136` | `batch-20260904T201413Z-1dc1` | 4/0/1 |
| 2 | Astra | `job-20260904T202910Z-8b0c` | `batch-20260904T202926Z-1129` | 4/1/0 |
| 2 | Sol | `job-20260904T204552Z-d6a3` | `batch-20260904T204608Z-b5c8` | 4/1/0 |
| 3 | Sol | `job-20260904T210520Z-1696` | `batch-20260904T210536Z-8555` | 2/3/0 |
| 3 | Astra | `job-20260904T212338Z-df3e` | `batch-20260904T212354Z-038a` | 4/1/0 |

The excluded planning smokes both passed:
`job-20260904T194426Z-a94a` (Astra) and `job-20260904T195025Z-9b14` (Sol).

At **21:36:57.669 UTC**, under the helper's run/sync mutation locks, the
appliance returned to `main` at
`c89d6e2b94e08d70134d446a37847a520eb45b29`. Its exact original configuration
bytes and 0644 mode were restored; the SHA256 is
`7833695b75490ca99950b5adeca0e9055ee25a943a557e231880bee489aa8dc7`.
All six jobs were terminal, and the container contained only `docker-init`
and `sleep`. The subsequent read-only `doctor` passed, with no run/sync lock
and the container running. No helper installation or credential change was
made. Private restoration receipts are retained with the experiment data.

## Reproduction and next work

The dated offline readout has 18 passing contract tests. The experiment's
omitted Astra credential-delivery test row was repaired after live execution;
all 69 credential-scope tests pass. These analysis/test commits do not change
the recorded runtime SHA. The five high-effort scenario fragments belong to
this experiment branch; do not merge them as ordinary scenario defaults.

Regenerate from the private collected data in this worktree:

```sh
python3 docs/experiments/2026-09-04-astra-sol-readout.py \
  --data-root results/pri-3088 \
  --output-dir results/pri-3088/analysis
```

`results/pri-3088/analysis/summary.{md,json}` contains every planned slot,
per-attempt references, common pair IDs, cost deltas, coverage and input hashes.
Private audit notes are `quality-evidence-review.md`,
`native-codex-instructions.md`, `pricing-assumptions.md`,
`grader-format-findings.md`, and `product-lessons.md` in that directory.
Raw logs remain private and uncommitted.

Frozen manifest SHA256:
`07605a29cf1d5b739864fa9365556e5e5ed526e0612c8a6ae07fc4883bb0c52c`.
Pricing snapshot SHA256:
`647411e47e9fcd2c4436b639a80aed528cadf82fed0bae1b0f869ff1f62120d6`.
Root instruction SHA256s: Astra
`ac8ae107a0d72fe3476b430afb161ea4e67da2e446d778aefc44828160559807`;
Sol `cbefa6b0bede0e332d957fca70ccacf9f12f4c0ecdf81b819e5cbe1a3b16e265`.

The existing runner can produce a useful study within a workday. Configuring
and interpreting it still required too much custom engineering. The next
product increment should make one finite configure/run/report journey work:
explicit model/effort treatments without scenario edits, one planned inventory,
one execution owner, and a canonical report with common denominators,
accounting coverage, and visible grader/check disagreements. Repair the
specific measurement contracts alongside that workflow. Keep termination,
ownership, and cancellation guarantees; recovery/resume can remain deferred.

This evidence supports the earlier recommendation to retain the kernel's
useful experiment contracts and consolidate execution/persistence ownership.
It does not justify a wholesale rewrite, validate kernel/V2 execution, or
support promising that one more increment will finish the architecture.
