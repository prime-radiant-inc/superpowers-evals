# Astra and Sol: Fractals head-to-head

Tracking: PRI-3088. Status: cancelled at Drew's request; appliance restored.
One Sol attempt ran; Astra was never launched. No completed model comparison.

Drew requested a direct Fractals follow-up to the completed five-scenario
Astra/Sol panel. Start with one full build per model. Keep this two-attempt
study separate from the prior 30 measured attempts.

## Cancellation and retained evidence

Sol ran through the installed helper as `job-20260904T224135Z-b60f`, batch
`batch-20260904T224150Z-0bc5`, using evals commit
`edc3e23d219bfd87c581366839693a14999c493e`. Its observed run directory was
`sdd-go-fractals-opus48-codex-openai_responses_56sol-linux-20260904T224151Z-ae48`.
The batch started at 22:41:50.757 UTC and ended at 23:12:43.070 UTC.

The helper transitioned to `cancelled` during grading, before Drew's subsequent
instruction to cancel the comparison. Its outer exit code was zero, but the
batch's sole result row had `run_id: null`. The observed run had no canonical
verdict, normalized trajectory, native usage artifact, or terminal grader
result. The helper label alone does not establish what caused the interruption:
its `lost`-to-terminal-batch path can also classify a job as cancelled. No
timeout, external canceller, or model failure was established. Investigation
stopped with Drew's cancellation instruction; no replacement attempt,
regrading, or Astra launch followed.

The delivered Git repository was preserved from a clean `main` checkout at
`acbc5db8d8d9442485e385b5a7dd4c8ed8b7dacd`. Its archive SHA-256 is
`4a361c3a2006cf382c434727a28f3cd8370e5e958b0be0aa436b1ac253fe056f`;
15 source/module/fixture fingerprints match the preserved copy. A separate
archive retains 19 Codex session logs, the partial grader event/usage logs,
and phase metadata (22 files), SHA-256
`daafd6f369be6b5d23afa0a58d116504278072edd6a14c2dbfe5238d129d5bc8`.
Credential files are excluded. Private evidence and receipts are under
`results/pri-3088-fractals/measured/job-20260904T224135Z-b60f/`.

Sol reported completing implementation, reviews, repairs, tests, vet, build,
and main-checkout delivery. Repository identity and delivery were independently
verified; the prepared supplemental output probes were not run. These are
partial observations, not a canonical pass or independently established
product-quality result. Paid activity occurred; missing canonical accounting
must not be interpreted as zero cost. No final cost comparison was produced.

At 23:16:02.106 UTC the appliance was restored to its original `main` commit
`c89d6e2b94e08d70134d446a37847a520eb45b29` and exact configuration bytes/mode.
Configuration SHA-256:
`7833695b75490ca99950b5adeca0e9055ee25a943a557e231880bee489aa8dc7`.
Only container init/sleep processes remained. A subsequent helper doctor
reported healthy, `evals_ref: main`, and both run/sync locks absent. Restoration
receipts are `results/pri-3088-fractals/restoration.json` and
`restoration-doctor.json`.

## Why the arms were sequential

The installed Phase 1 helper accepts exactly one coding-agent/credential
selection per job and holds an appliance-wide run lock. It also recreates one
shared container around the selected credential scope. Its `--jobs` option
permits scenario concurrency within that selection; multiple model credentials
are rejected before launch. The underlying runner's model-matrix support does
not supply a supported parallel Sol/Astra path through this installed helper.
See `src/appliance/cli.ts`, `src/appliance/preflight.ts`,
`src/appliance/process.ts`, and the credential-scoping section of
`docs/appliance-runbook.md`. This is an experiment-workflow limitation; no
concurrency or credential safeguards were bypassed.

## Frozen comparison

The following protocol was recorded before launch. Cancellation prevented its
completion.

Use `sdd-go-fractals-opus48`: the existing seven-task, two-fractal Go CLI
fixture. `opus48` identifies the plan's author, not the tested model.
Both subjects use Codex 0.146.0, OpenAI Responses, high reasoning effort,
Superpowers `b36e0829c6d0140e93cfef2ca599b1b07d4a7797`, and grader
`claude-sonnet-5`. The requested root models are `gpt-5.6-sol` and
`gpt-6-astra`. Preserve native instructions, coordination behavior and
delegation choices, and capture actual model identities and effort.

Run Sol first, then Astra, one attempt per appliance job with `--jobs 1`.
The installed helper permits one credential selection per job. This is one
matched pair with sequential execution, not a randomized comparison or an
estimate of run-to-run variability. Each attempt retains the scenario's
120-minute limit. No extra configuration smokes are planned: the preceding
panel already exercised both exact model routes on this appliance.

Use the supported appliance helper and its locks, scoped credentials,
provenance, status and cancellation. Temporarily select the prepared
experiment branch, verify exact shared identities, and restore the original
checkout/configuration after both attempts. Stop subsequent submission on
infrastructure failure, identity drift, or exhausted grader-format failure.
Keep all outcomes and costs; no selective reruns or replacement judgments.

## What this fixture establishes

The plan includes substantial implementation code. Its canonical checks
require SDD/Agent evidence, tests passing, an entrypoint, main-branch delivery,
and commit count. They are weak evidence of output correctness by themselves.

The existing plan also contains design contradictions. Its Sierpinski
implementation ignores depth, and its bit-mask construction does not establish
the documented shape/base width. Supplied tests miss these properties.
Preserve the fixture and distinguish plan execution, detection/repair of its
defects, and conformance of the delivered CLI. A canonical pass is not proof
that every design requirement is satisfied.

Before inspecting either output, freeze supplemental checks of the finished
main checkout: actual build/tests, documented CLI commands and flags, invalid
input, render dimensions/characters, Sierpinski depth behavior, and repository
delivery. Report their observations separately from canonical judgments.
Do not rewrite original verdicts or coach either model with probe findings.

## Accounting and reporting

The instrument includes the previously reviewed Codex usage-counter fix,
cherry-picked as `2721329f`. This avoids the prior duplicate-snapshot defect
before these attempts start. Targeted normalizer and credential tests pass
(125 tests); the same normalizer patch already passed its full check on the
isolated integration branch. No model, fixture or check changes are made
after the first measured launch.

Reuse the prior frozen obol pricing snapshot:
`647411e47e9fcd2c4436b639a80aed528cadf82fed0bae1b0f869ff1f62120d6`.
Astra/Sol rates are dated September 4; other models retain August 5 rates.
Reprice captured trajectories separately, retaining original economics.
Include all captured delegates, separate subject/grader amounts, and audit
available-log coverage, model identity, service-tier evidence and per-request
context thresholds. These remain standardized token estimates rather than
complete bills; unknown usage and separate tool fees stay explicit.

Publish both original outcomes, supplemental output observations, workflow
behavior, elapsed attempt times, subject/grader costs, all-attempt accounting,
and source/job references. Compare costs/time only when both observations
have the required provenance and measurement coverage. With n=1 per model,
report observed differences without a general model ranking.

Private inputs and receipts live in `results/pri-3088-fractals/`. Reuse the
dated offline readout with that directory as `--data-root`; no raw transcripts
or credentials are committed.
