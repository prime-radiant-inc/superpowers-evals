# PR 2258: recover the canonical experiment path

Drew approved preserving the experimental observer work, extracting useful
campaign fixes, and preparing the comparison through the existing campaign
system. He then requested integrating those fixes directly into main and
continuing from a clean main, without another development branch.

## What is retained on main

The recovery starts from `672a0ad2580b75153e1a954ae3a8cad4c1e97b90`, verified
against GitHub main on September 6. It preserves the existing runner, harness
adapters, scenarios, historical pilot, and finite campaign controller.

The following independent fixes are extracted from the experimental branch:

| Behavior | Original commit |
| --- | --- |
| Consider first repetitions across comparisons before later repetitions when dispatch priorities tie | `fbee7c97` |
| Keep check subprocess HOME outside subject HOME and publishable run artifacts | `acf15356` |
| Report unreadable campaign entries individually without breaking the whole listing | `2931ddbf` |
| Freeze an optional pricing table and deliver its verified bytes to workers | `b42cf5a0`, `19f52646` |
| Register the executing installed Evals revision instead of a potentially stale configured ref | `00798a4c` |
| Permit the explicitly declared shared Mantle subject/grader source | Runtime and projection tests from `4635f4ae` |

These changes retain their behavioral regressions. No experimental observer
parser, live guard, publication gate, qualification script, diagnostic suite,
or completion plan is brought into main.

## Preserved research and negative evidence

The archive tag `archive/pr2258-observer-2026-09-06` identifies
`a9d34304d45a9e02b2972e4ccec71dee2e469aeb`, including the earlier design and
implementation history. A verified local Git bundle also preserves both the
implementation and spec refs. Existing worktrees and private evidence remain
in place. The archive is research, not a qualified runtime or an active plan.

The archive contains the dated parallel-comparison experiment and completion
receipts, native-log fixtures, tests, and the strict observer implementation.
Both six-arm diagnostics remain negative instrument evidence:
`d3871573-98b6-41f1-ae27-737f84c7658c` and
`4e5de280-cab9-4bdc-bda6-4620dd325e68`. Neither supplied a valid comparison
pair. Their original results and cost missingness must not be repaired or
counted as new samples.

The [completed historical Codex pilot](2026-09-04-pr2258-astra-sol-brainstorming.md)
retains its eight samples: purpose discovery was 1/4 on base and 4/4 on head;
canonical strict pass was 1/4 on both. It does not establish Claude or parallel
campaign readiness.

Continuous inode identity, exhaustive native-record parsing before every actor
reply, and the archive's bespoke qualification sequence are dropped from the
new experiment's requirements. The old strict scenario remains available with
its existing Codex restriction and scoring contract; its scores are unchanged.

## Next experiment

Use the [canonical campaign commands](../campaign-comparisons.md) with pinned
base/head revisions within Codex Astra, Codex Sol, and Claude Opus 5. Select
existing relevant brainstorming scenarios and a separately named ordinary
purpose-discovery scenario using the hidden React-learning motivation. Grade
purpose elicitation and incorporation with the existing Gauntlet-Agent and
captured evidence. This is a different measurement from strict saved-revision
approval chronology and must be reported as such.

Commit the arm/suite declarations and scenario, use the existing Mantle grader,
validate the source, and install the selected main revision through the shared
appliance helper. Register fresh attempts with explicit repetitions, runtime
limits, and concurrency up to six. Valid attempts from that registered
experiment count; a separate bespoke diagnostic campaign is not a prerequisite.

Main integration does not update the shared appliance. At the last operational
inspection before this recovery, its source was still experimental `2375580d`;
recheck its source, locks, and configuration before installing main. This
recovery performs no appliance mutation or paid eval launch.
