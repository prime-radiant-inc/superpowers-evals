# Astra and Sol through Codex: representative comparison

Tracking: PRI-3088. Status: running; 15/30 measured attempts complete. Sol
repetition 2 is active. Snapshot: 2026-09-04 20:50 UTC.

Drew prioritized usable evals and experiments and deferred campaign recovery
and resume. This experiment uses the supported appliance helper and existing
runner. Interrupted work remains explicitly incomplete.

## Question and interpretation

At the same Codex configuration, how do Astra-led and Sol-led workflows differ
in behavior, correctness, elapsed time, and observed cost on five practical
Superpowers tasks? This is a small exploratory comparison, not a model ranking
or release gate. Three repetitions cannot establish equivalence or a general
superiority claim.

The treatment is `gpt-6-astra`; the baseline is `gpt-5.6-sol`. Both use Codex,
the OpenAI Responses API, and `high` reasoning effort. The scenario config
fragments pin effort for every Codex run of these five scenarios; they do not
change other harnesses. Keep these fragments on the pinned experiment branch;
changing the ordinary scenario defaults is outside this experiment. Effective
model and effort must be checked in the
captured turn metadata. Delegation policy is shared; any other models used by
subagents are reported and charged to their respective parent workflow.

## Planned observations

| Scenario | Behavior measured | Repetitions per model |
|---|---|---:|
| systematic-debugging-fixes-root-cause | Fix the actual producer defect and retain a regression test. | 3 |
| receiving-code-review-pushback | Act on sound feedback and reject incorrect or speculative changes. | 3 |
| verification-phantom-completion | Detect false completion, repair the work, and verify it. | 3 |
| triggering-writing-plans | Select planning before implementation. | 3 |
| sdd-breaker-rules-and-continues | Resolve an SDD workflow contradiction and complete implementation. | 3 |

There are 30 planned measured attempts. Transport/configuration smokes, if
needed, are recorded separately and do not enter those denominators. Keep
unfavorable behavioral outcomes; do not selectively rerun them. Missing or
interrupted observations retain their planned slots and explicit reasons.

## Execution controls

The Phase 1 helper permits one `(agent, credential)` selection per job. Use
six five-scenario `run-all` jobs, one per model and repetition, with `--jobs 2`.
Pair observations by scenario and repetition for analysis; these are sequential
matched jobs, not contemporaneous campaign blocks. Model order is Sol/Astra,
Astra/Sol, Sol/Astra across the three repetitions. Report possible time/order
effects; do not describe the launch schedule as randomized or fully balanced.

Every job uses the same exact evals, Gauntlet and Superpowers SHAs, container
image and Codex version. Record the helper's resolved provenance before
accepting a job into the comparison. The provisional Superpowers SHA already
present on the appliance is `b36e0829c6d0140e93cfef2ca599b1b07d4a7797`; the
Gauntlet SHA observed at preparation is
`fb34bcd03cc169f8841a2e4c8cf1d9173a229f18`. These are observations, not proof of
the identities a future job will use. Fix the grader model and route across
all jobs and record its actual identity and configuration.

Use `evals-appliance prepare`, `run-all`, `status`, `show`, `costs`, and
`cancel`. No raw campaign launch, lock bypass, V2 deployment, or resume is
required. Stop subsequent submission on infrastructure failure or provenance
drift; preserve any completed and partial results.

## Pricing and readout

Official pricing checked on 2026-09-04:

| Model | Uncached input / MTok | Cached input / MTok | Output / MTok |
|---|---:|---:|---:|
| gpt-6-astra | $10 | $1 | $50 |
| gpt-5.6-sol | $4 | $0.40 | $20 |

Sources: [Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)
and [Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol).
Long-context, cache-write and service-tier adjustments also apply where
observed. Freeze the pricing source used in analysis. The existing registry's
Sol pricing comment and bundled obol snapshot predate these published rates;
do not reuse them as current prices or overwrite historical captured costs.
Reuse obol for any separately labeled repricing of captured trajectories.
Unpriced models or unknown usage remain explicit; no partial subtotal is a
complete bill.

Report one row per scenario/model with planned, pass, fail, indeterminate and
unobserved counts; Gauntlet/check disagreements; observed model/effort;
attempt wall time; subject and grader costs separately; contributing counts;
and artifact references. Comparative behavioral deltas use complete determinate
scenario/replicate pairs. Comparative cost and duration summaries use the same
contributing pairs on both arms and state any conditioning on determinate
outcomes. Also report all-attempt known spend, missing coverage, discarded work,
and campaign elapsed time. Summed attempt durations measure occupied worker
time, not elapsed time for Drew.

## Evidence and results

Read-only preflight confirmed both exact model IDs are available to the
appliance's OpenAI account. `doctor` reported healthy configuration, no run or
sync lock, and a running appliance container. Model discovery is not a
successful inference or an eval result.

The paid run was explicitly approved on the experiment appliance branch.
The live evals source remains `ec5f09fcc5013663d4dfaca4b7227288a6142553`.
Every submitted measured job has so far verified the same Superpowers and
Gauntlet SHAs above, Codex 0.146.0, credential bundle
`blessed-20260901T185556Z`, and container image
`sha256:cdf467a0050b8c0068e6652e995f559e0f85ab3deb40d8ee8f72332b42a6ba37`.
Root model and effective `high` effort are verified from session metadata.
The original appliance branch/configuration is recorded for restoration after
the study; it has not yet been restored while jobs remain active.

Both excluded planning smokes passed. Their job IDs are
`job-20260904T194426Z-a94a` (Astra) and `job-20260904T195025Z-9b14` (Sol).

| Repetition | Arm | Job | Batch | Current outcome |
|---|---|---|---|---|
| 1 | Sol | `job-20260904T195456Z-c989` | `batch-20260904T195511Z-4b8f` | 4 pass, 1 fail |
| 1 | Astra | `job-20260904T201358Z-2136` | `batch-20260904T201413Z-1dc1` | 4 pass, 1 indeterminate |
| 2 | Astra | `job-20260904T202910Z-8b0c` | `batch-20260904T202926Z-1129` | 4 pass, 1 fail |
| 2 | Sol | `job-20260904T204552Z-d6a3` | `batch-20260904T204608Z-b5c8` | Running |

The first review-judgment pair differs: Sol fixed the real bug and rejected
the wall-clock suggestion, but implemented the speculative storage abstraction.
Astra declined it and passed. Both passed SDD continuation, planning, and
phantom-completion verification. Sol passed root-cause debugging. Astra's
debugging attempt has a malformed grader report and is canonically
`indeterminate`; a separate deterministic check failed because no test file
was saved. An independent workdir inspection confirmed the absence of a saved
regression test. Keep that observation distinct from canonical composition.

The grader failure reached Gauntlet's normal report-validation limit. An
all-attempt diagnostic pass found report-format retries in 11/15 completed
attempts: ten recovered within the frozen grader's built-in retry policy and
one exhausted it. All captured grader starts identify `claude-sonnet-5`.
This is common format fragility, not an isolated malformed response. There
is no demonstrated environment or configuration fault; continuing the frozen
slots was independently reviewed as defensible. Preserve original outcomes
and retry time/cost; do not replace or regrade attempts. Reassess before new
submission on another exhausted validation failure. Do not assume the missing
judgment is random or convert the embedded malformed `fail` into a canonical
verdict.

Astra repetition 2 again fixed the debugging producer defect without saving
a regression test; this time the valid grader report and deterministic check
both failed. Captured native Codex base instructions differ by model: Astra's
include "do not add tests to codebases with no tests," while Sol's captured
base does not contain that prohibition. This plausibly contributes to the
behavior but does not establish causation. The root base fingerprints were
stable within each arm across the first 13 completed runs inspected; main
scenario prompts matched by scenario after whitespace normalization, and
personality/effort settings matched. The models' native instructions are part
of this workflow treatment. The result cannot isolate underlying model
weights from prompts or delegation choices. Do not change those instructions
after seeing outcomes.

The Astra base SHA256 is
`ac8ae107a0d72fe3476b430afb161ea4e67da2e446d778aefc44828160559807`;
Sol's is `cbefa6b0bede0e332d957fca70ccacf9f12f4c0ecdf81b819e5cbe1a3b16e265`.
Private evidence links are in
`results/pri-3088/analysis/native-codex-instructions.md`.

## Accounting correction

An audit reconciles every available session log against the merged trajectory,
including delegates. It found repeated Codex usage snapshots in two first-Sol
runs. The normalizer counted their unchanged cumulative/last-request counters
twice. This is a real accounting defect, not an additional model request.

The isolated fix is commit `26334578f719b6c098742ff4fa8038d2220d303d`.
Commit `6d8033e109fed7e6165bcf9b47d8421350521227` separately adds the omitted
Astra row to the credential-delivery test matrix. The final combined check
passed lint/typechecks, 3,508 core tests (one skipped), and 144 dashboard tests.
The first full check exposed only that missing test row. Nothing was pushed
or installed into the running instrument.

Derived analysis uses the existing fixed `captureToolCalls` and obol at
checkout `6d8033e109fed7e6165bcf9b47d8421350521227`. Original trajectories,
verdicts, and costs remain preserved. Correction receipts bind the original
trajectory, raw logs, fixed source, pricing snapshot, and derived outputs by
SHA256; the tool-call projection must remain unchanged. Corrected costs are
selected only when the receipt and coverage audit validate, with no fallback
to uncorrected amounts. This rule applies to both arms and smokes.

The corrected subject estimates for the affected Sol runs are $0.6733014
(debugging; correction -$0.0273032) and $0.554361 (phantom completion;
correction -$0.0203324). All fifteen completed measured attempts currently reconcile
against available logs. These remain standard-tier token estimates; native
tool fees and unlogged provider usage are not established invoice coverage.

At this interim snapshot, measured all-attempt token estimates total
$31.3899901, with smokes separately $2.875729. Four complete determinate pairs
contribute to comparisons; both debugging attempts remain in accounting.
No general model ranking or completed-study conclusion is available yet.
The second Astra SDD attempt passed with a subject estimate of $8.173847,
compared with $3.6540152 in its first repetition; the final report must retain
per-attempt variation rather than only averages.

The dated offline analysis and its 18 contract tests are committed alongside
this log. To regenerate from the private collected data:

```sh
python3 docs/experiments/2026-09-04-astra-sol-readout.py \
  --data-root results/pri-3088 \
  --output-dir results/pri-3088/analysis
```

Private collected artifacts and the reproducible readout are under the
experiment worktree's gitignored `results/pri-3088/` directory. The frozen
30-slot manifest SHA256 is
`07605a29cf1d5b739864fa9365556e5e5ed526e0612c8a6ae07fc4883bb0c52c`.
The selected price snapshot SHA256 is
`647411e47e9fcd2c4436b639a80aed528cadf82fed0bae1b0f869ff1f62120d6`;
Astra/Sol rates are dated September 4 and other model rates retain the
bundled August 5 table. Raw logs are not committed.
