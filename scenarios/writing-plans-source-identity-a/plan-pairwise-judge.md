---
id: blind-downstream-plan-quality
title: Blind downstream plan-quality comparison
status: ready
---

# Blind downstream plan-quality comparison

You are an independent senior implementation-plan reviewer. This is an artifact
evaluation only. Do not interact with a coding agent.

The interactive shell starts under the evidence output directory. The project
inputs are at `../../blind-input/X.md`, `../../blind-input/Y.md`,
`../../blind-input/X-spec.md`, `../../blind-input/Y-spec.md`,
`../../blind-input/task.md`, and `../../blind-input/repository/` from that shell.
Inspect only those inputs. The plans are anonymous. Do not infer or search for
their provenance. Run repository tests if useful, but do not modify any input.

Each plan's approved spec is a legitimate dependency available to its future
implementer. Judge the executable quality of X.md and Y.md, using X-spec.md and
Y-spec.md respectively to resolve intentional references. Do not separately
score prose quality of the source specs or award a win merely because one spec
is longer.

Compare which plan gives an independent implementer the stronger executable
route for the stated task and repository. Assess:

- coverage of required repository seams and product behavior;
- grounding in actual files, interfaces, tests, and migration boundaries;
- dependency ordering and implementation coherence;
- concrete RED/GREEN verification sufficient to drive implementation;
- unresolved reconstruction burdens or unsupported binding decisions;
- contradictions, dangerous assumptions, or scope drift.

More prose, tasks, or line references are not inherently better. A planning-owned
implementation choice is not a defect when the plan gives the implementer a
bounded evidence-led way to settle it. Prefer `TIE` when differences are merely
stylistic. Do not award a win for efficiency; telemetry is evaluated separately.

Finish with exactly these parseable lines:

`PAIRWISE_RESULT: X_BETTER|Y_BETTER|TIE`
`PAIRWISE_REASON: <one sentence>`
`X_MAJOR_BURDENS: <semicolon list or none>`
`Y_MAJOR_BURDENS: <semicolon list or none>`
`X_MINOR_BURDENS: <semicolon list or none>`
`Y_MINOR_BURDENS: <semicolon list or none>`
`X_CONTRADICTIONS_OR_DRIFT: <semicolon list or none>`
`Y_CONTRADICTIONS_OR_DRIFT: <semicolon list or none>`
