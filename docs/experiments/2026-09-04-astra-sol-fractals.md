# Astra and Sol: Fractals head-to-head

Tracking: PRI-3088. Status: preparation; no Fractals attempts launched.

Drew requested a direct Fractals follow-up to the completed five-scenario
Astra/Sol panel. Start with one full build per model. Keep this two-attempt
study separate from the prior 30 measured attempts.

## Frozen comparison

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
