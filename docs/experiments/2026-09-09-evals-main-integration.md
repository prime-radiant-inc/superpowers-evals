# Evals workstream integration

The maintainer requested both eval workstreams and the matching Gauntlet changes
on main, with the bespoke assessor diagnostic launcher removed. This source
integration supersedes the earlier plans' live-qualification-before-merge gates.
It grants no new paid allocation, deployment, or claim of assessor reliability.

Quorum remains the eval runner and campaign owner. Gauntlet remains its driver
and assessor. Shared appliance runs continue through the installed
`evals-appliance campaign` commands documented in [the runbook](../appliance-runbook.md).

The integrated work includes conversation scenarios, controls, retained-corpus
validation, assessment completion/deadline and accounting fixes, and the PR2236
session-discovery/full-diagnosis fixtures and independent report checks. The
historical experiment results remain recorded, including negative results and
unqualified candidates. Source integration does not turn those experiments into
successful qualifications. Private runtime histories, gold packages, and local
review receipts remain in their original worktrees.

The overlap between the two source branches required these reconciliations:

- Capture retains per-source trajectories and native provenance alongside the
  merged trajectory. Tolerantly parsed malformed lines remain explicit capture
  errors. Seeded historical sessions stay outside new-run capture and billing.
- A message-only delivery is valid evidence. Usage-only evidence stays
  unavailable for a behavioral verdict but remains priceable, including
  cumulative usage in `final_metrics`. Conversation cancellation and capture
  failures retain incurred Coding-Agent costs.
- Pi's existing launcher pins the private session root; native settings use the
  same directory. Both regular and conversation execution pass the qualified
  provider/model context for placeholder-zero pricing. Other recorded costs,
  including real zeroes, remain unchanged.

Independent integration review found and verified fixes for three cost seams:
missing Pi context in conversation mode, pricing after early capture returns,
and deletion of cumulative-only usage. The associated regressions failed before
the fixes and passed afterward. A preexisting limitation remains: merging
multiple cumulative-only sibling trajectories uses the first source envelope;
complete per-source cumulative accounting is separate follow-up work.

The Gauntlet Linux check also exposed a fixture that signalled cancellation at
response headers while asserting that the entire body had already returned.
A split-body localhost fixture reproduced the failure. The corrected test
establishes full body delivery before its synthetic report-boundary cancellation
or clock expiry. Separate pending/stalled-body cancellation tests remain intact.

Final source identities and verification results are recorded in the delivery
PRs. Implementation commits and private verification logs are preserved in the
integration worktrees; no original experiment evidence is rewritten.
