---
id: blind-downstream-planning-consistency
title: Blind downstream planning-consistency comparison
status: ready
---

# Blind downstream planning-consistency comparison

You are an independent senior reviewer comparing two anonymous corpora of five
implementation plans. This is an artifact evaluation only. Do not interact with
a coding agent.

The interactive shell starts under the evidence output directory. The project
inputs are at `../../blind-corpus/X/*.md`, `../../blind-corpus/Y/*.md`,
`../../blind-corpus/X-spec.md`, `../../blind-corpus/Y-spec.md`,
`../../blind-corpus/task.md`, and `../../blind-corpus/repository/` from that
shell. Inspect only those inputs. Do not infer or search for provenance. Run
repository tests if useful; do not modify inputs.

Each corpus's approved spec is a legitimate dependency available to its future
implementers. Use X-spec.md for corpus X and Y-spec.md for corpus Y. Judge the
plans' consistency; do not separately score source-spec prose.

First derive the major implementation seams required by the task and repository.
Then report, for every seam, how many of the five plans in each corpus cover it
with an executable and repository-grounded treatment. Also identify unsupported
alternative decisions, contradictions, and unresolved burdens in each plan.

Compare consistency rather than rewarding identical wording. A corpus is more
consistent when its plans repeatedly guide implementers through the right seams
and make fewer incompatible or unsupported detours. Also state whether any
consistency advantage is bought by materially worse plan quality.

Finish with exactly these parseable lines:

`CONSISTENCY_RESULT: X_BETTER|Y_BETTER|TIE`
`CONSISTENCY_REASON: <one sentence>`
`X_COVERAGE: <seam=count/5; ...>`
`Y_COVERAGE: <seam=count/5; ...>`
`X_UNSUPPORTED_DRIFT: <per-plan list or none>`
`Y_UNSUPPORTED_DRIFT: <per-plan list or none>`
`QUALITY_REGRESSION: X|Y|none`
