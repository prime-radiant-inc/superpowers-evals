# Kernel D4a implementation validation and live-validation debt

**Date:** 2026-08-31
**Classification:** Portable implementation and readiness record; this is not a live-run result.

## Local implementation ref

- **Worktree:** `/Users/drewritter/prime-rad/superpowers-evals/.qwen/worktrees/kernel-d4a`
- **Ref:** `220e421c015457b753b904e689de2e884a68aad5`
- **Branch:** `worktree-kernel-d4a`

## Portable evidence

The Task 5–9 implementation reports provide the portable evidence currently available:

| Report | Evidence recorded |
|---|---|
| `.superpowers/sdd/2026-08-31-kernel-d4a-descriptive-readout/task-5-report.md` | Seal-act implementation and focused verification are recorded. The report also preserves earlier full-gate timeout history, so it is not treated as a refreshed final gate. |
| `.superpowers/sdd/2026-08-31-kernel-d4a-descriptive-readout/task-6-report.md` | Resume-wiring implementation is recorded with successful repository and scenario-check receipts, and no live campaign. |
| `.superpowers/sdd/2026-08-31-kernel-d4a-descriptive-readout/task-7-report.md` | Campaign-report implementation is recorded with focused verification and scenario checks; the report notes the unchanged full-repository Serf timeout. |
| `.superpowers/sdd/2026-08-31-kernel-d4a-descriptive-readout/task-8-report.md` | Crash-window matrix implementation is recorded with successful full-gate and scenario-check receipts, and no live campaign. |
| `.superpowers/sdd/2026-08-31-kernel-d4a-descriptive-readout/task-9-report.md` | Documentation implementation and the corrected D3/D4a operator-label evidence are recorded; the status stamp and live criteria remain pending. |

The current final-gate claim is still a controller handoff item: the controller is to refresh the final gates before final handoff. Accordingly, the report receipts above are portable implementation evidence and historical gate claims, not a fresh final-gate assertion for this ref.

## Appliance readiness only

The supplied readiness receipt records that access via Tailscale SSH worked for `quorum-appliance`. The appliance helper doctor returned `ok=true`; the container was running; locks were missing; and the configured `evals_ref` was `main`.

No credential-bundle contents, credential values, or secrets are recorded here.

## Live validation

| Planned run | Result |
|---|---|
| Live run 1 exploratory | **NOT RUN** |
| Live run 2 gating | **NOT RUN** |
| Live run 3 terminus crash | **NOT RUN** |

The requested implementation exists only in the local worktree at ref `220e421c015457b753b904e689de2e884a68aad5`. `git ls-remote origin` exposes only `origin/main` at `114f7258`, while the appliance is configured for `evals_ref=main`. Running now would execute the wrong evals ref. No live spend or transcripts were created.

## Exit-criteria debt

- The D4a spec status remains `draft` (`revision 2 awaiting user review`); this document does not change the spec.
- D3 item 1 is not closed because the live gating run did not occur.
- D3 items 2 and 3, the Linux-gated integration matrix, and the D3 status stamp remain owed as specified.
- The controller still needs to refresh the final portable gates before final handoff.
