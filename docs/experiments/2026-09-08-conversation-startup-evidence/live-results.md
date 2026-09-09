# Conversation startup and Pi evidence live qualification

Date: 2026-09-08 Pacific (2026-09-09 UTC)
Status: all three engine gates passed; both deliverables promoted directly to
main and installed for canonical campaign execution.

## Execution contract

Drew approved the [three-cell qualification](live-qualification.md) after the
offline candidate and isolated pilot staging passed review. The new allocation
was $10 in observed costs, with a 60-minute wall limit, global concurrency one,
one attempt per cell and no reserve, retries, replacements or continuations.
Pi review was launched only after Pi pricing passed root and independent engine
reviews. Previous campaigns and allocations stayed closed.

First launch was requested at `2026-09-09T01:50:26.458093Z`; the absolute cutoff
was `2026-09-09T02:50:26.458093Z` (7:50 p.m. Pacific). The installed pilot helper
owned registration, execution, status, costs and reports. No new orchestrator,
background automation or image build was introduced.

All three registrations froze the source, arm and pricing inputs below. The
runtime image was verified separately before launch and after execution.

- Quorum: `f83fc39dfba2aef5f95b8d413219407129a27d30`.
- Gauntlet: `f5d66447ce4234fd5c0901fad372935332003491`.
- Superpowers: `b36e0829c6d0140e93cfef2ca599b1b07d4a7797`.
- Runtime image: `sha256:01fb1cd08f1e31c82fccedbaadead09e6ff97bca1f5d66f2f0904728ad536e8c`; Claude 2.1.209 and Pi 0.80.7.
- Pricing snapshot: `2026-09-06`, SHA-256 `6423a36bd98e01653824967834f114c71a1f4f03eeab595e511ad91a1ec37d8b`.
- Simulated user and assessor: `sonnet5_bedrock`, `anthropic.claude-sonnet-5`.

## Standard report outcomes

| Cell | Campaign | Execution | Behavioral result | Engine gate | Campaign seconds | Total estimated USD |
| --- | --- | --- | --- | --- | ---: | ---: |
| Claude / `opus5_bedrock` pricing | `2a5ce64a-620e-4a40-97c0-a265bd5b9d98` | Completed delivery and assessment | Pass | Pass | 202.969 | 1.11100825 |
| Pi / `pi_gpt56_sol` pricing | `9daa258e-6694-4dc8-aaf5-67184e99c7da` | Completed delivery and assessment | Pass | Pass | 187.616 | 0.52173680 |
| Pi / `pi_gpt56_sol` review | `83fd7717-62a0-4af3-8861-f5e952999994` | Completed delivery and assessment | Pass | Pass | 215.044 | 0.90430060 |

All three reports have complete accounting, authenticated usable evidence and
verified termination. Their combined estimate is **$2.53704565**. The last
campaign ended at `02:06:48.713Z`, before the `02:50:26.458093Z` cutoff. Exactly
three attempts ran; no cancellation, retry or replacement was needed.

Costs are estimates under the frozen pricing table, not
provider invoices. Campaign seconds include controller finalization; worker
seconds are reported separately by the standard report.

## Engine evidence

Claude reached the recognized composer without startup input. Its ready event
and first simulated-user request share `01:50:31.109Z` at millisecond precision;
the frozen code persists ready before requesting the first model call. First
terminal submission was `01:50:35.865Z`. The completed run retained 31 native
assistant rows, 17 timestamped normalized steps, 39 visible captures and source
and test outputs. Both evaluation roles exited zero with no stop cause. The
independent audit authenticated all 233 manifest files and 89 indexed evidence
files, with valid exposure at `01:50:35.876Z`.

Pi pricing retained 14 native assistant messages and 27 normalized steps. Every
step's timestamp and source session ID matched its native message. Native and
normalized usage matched exactly at 254532 tokens, with no duplicated tool-step
usage. The custom provider's placeholder cost was absent from normalized
metrics, and independent frozen arithmetic reproduced the $0.2918688 subject
estimate. Both evaluation roles had complete priced usage. The independent
audit authenticated all 213 manifest files and 79 indexed evidence files, with
valid exposure at `01:57:14.550Z`.

Pi review retained the main session and a nested reviewer session: 13 native
assistant messages and 27 normalized steps. Every step's timestamp and source
identity matched native evidence, and native and normalized usage matched at
211393 tokens. Independent frozen arithmetic reproduced the $0.3452366 subject
estimate. The delivered review and merge recommendation remained visible; both
evaluation roles exited zero and had complete accounting. The independent audit
authenticated all 225 manifest files and 88 indexed evidence files, with valid
exposure at `02:03:26.462Z`.

Each independent review also authenticated the campaign's validity and
termination artifacts against its standard report anchor. No gate required
changing the original assessment or rerunning the subject.

## Promotion and installed verification

After all gates passed, ordinary non-force pushes advanced Gauntlet main to
`f5d66447ce4234fd5c0901fad372935332003491` and Quorum main to
`f83fc39dfba2aef5f95b8d413219407129a27d30`. Drew had explicitly requested direct
main integration without PRs. GitHub accepted Quorum's push with notices about
the repository's PR, linear-history and pending required-check rules. No local
hook was disabled. Subsequent result-record commits change documentation only.

The promoted runtime passed Quorum's
[full check and scenario validation](https://github.com/prime-radiant-inc/superpowers-evals/actions/runs/34302138161)
and [main analysis workflow](https://github.com/prime-radiant-inc/superpowers-evals/actions/runs/34302136828),
and Gauntlet's [check workflow](https://github.com/prime-radiant-inc/gauntlet/actions/runs/34302117209).
The earlier offline checks and actual paired CLI tests are recorded separately
in [candidate validation](results.md#candidate-validation).

At `2026-09-09T02:11:09.975092Z`, the canonical appliance's clean main checkouts
were verified at that exact pair after source fast-forwards. Superpowers and
the qualified image digest were unchanged. The installed canonical helper's
doctor passed; run/sync/spend locks were absent and only the base appliance
container was running. The pilot and its immutable campaign evidence remain
preserved.

This updates canonical **campaign** execution: registration installs frozen
source snapshots that workers mount into the pinned image. `prepare` was not
run because it rebuilds and retags the image. The generic legacy job path's
image-baked Gauntlet was not refreshed. The deployment receipt is retained as
`canonical-runtime-update.json` beside the private live qualification receipts.

## Evidence locations and limits

Unmodified standard reports and native logs, outputs, exchanges and captures
remain on the private appliance. Campaigns live beneath
`/srv/quorum/pilots/conversation-assessment/superpowers-evals-startup-f83fc39d/campaigns/`;
published runs live beneath the pilot's `results/` directory. Local full report
copies, approval and launch receipts, status/cost observations and root gate
checks are in ignored `results/conversation-startup-evidence/live-qualification-20260909/`.
Independent gate reviews are in the existing private SDD ledger.

These are engine qualifications for the declared Claude and Pi cells. The
official behavioral grades remain unchanged and do not establish grader
accuracy, broad harness/model support or parallel capacity. Held grader and
simulated-user prompt candidates remain unpromoted. The following bounded
increment is the grading contract discussed in the startup/evidence spec.
