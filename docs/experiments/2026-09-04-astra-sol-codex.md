# Astra and Sol through Codex: representative comparison

Tracking: PRI-3088. Status: prepared; no measured runs launched.

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

No behavioral result is claimed until job IDs, exact provenance and readout
artifacts are recorded here. Negative results and measurement defects receive
the same treatment as positive results.
