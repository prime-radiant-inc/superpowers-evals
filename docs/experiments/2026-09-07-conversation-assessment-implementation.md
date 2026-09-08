# Conversation and assessment implementation handoff

Status: offline implementation complete. Task reviews and final scoped re-review
accepted; no open findings within the approved scope. Live proof remains pending. Implements the approved
[design](../superpowers/specs/2026-09-07-quorum-conversation-assessment-design.md)
and [plan](../superpowers/plans/2026-09-07-quorum-conversation-assessment.md).

## What this increment does

The opt-in `conversation-pricing` scenario uses a prose user brief and private
acceptance criteria. Quorum prepares the existing harness launcher and gives it
to Gauntlet's simulated user. When the coding agent delivers or refuses, the
conversation endpoint is saved independently of output quality. Quorum stops the
subject, retains evidence/output, runs the trusted oracle, then invokes a fresh
Gauntlet assessor. The existing per-run verdict shows the conversation,
assessment criteria, deterministic checks and both role costs.

The scope is Linux Claude/Codex. Current provisioning, credentials, per-attempt
workers, appliance ownership, scheduling and campaign policy remain in use.
Existing scenarios continue through their current QA flow. This does not migrate
the catalog, add a generic eval interface or claim a speedup.

## Source and workspace handoff

Paired runtime revisions:

- Quorum: `d52b36be70dd2efc4289af9267ffa2e3e12762d9`, based on approved planning
  commit `2b7315ac` (runtime baseline `32b403be`).
- Gauntlet: `74d2037aed14f413db482b7635783e4e0498c316`, based on
  `588a81e80fe3cd7b7d3bc2c7f4207bed4ecb14df`.

Both repositories use branch `codex/conversation-assessment` in their own
`.worktrees/conversation-assessment` directory. This handoff's later docs commit
does not alter those tested runtime revisions. The primary checkouts were not
used for implementation. Worktrees remain for review; no integration is implied.
Gauntlet's required build left generated `ui/dist-static/` untracked and retained
for rendering, in addition to the ignored local UI dependency symlink.

Tracking: [PRI-3102](https://linear.app/prime-radiant/issue/PRI-3102/separate-simulated-user-conversation-from-assessment-in-quorum).

## Verified behavior and limits

- A real prepared tmux terminal exchanges a question and answer with scripted
  controller responses. No input follows finish or subject exit.
- Correct delivery, incorrect delivery and refusal exercise the actual Gauntlet
  CLI subprocesses through a loopback-only simulated provider endpoint.
- Completion remains present through later cleanup, capture, checker, assessor
  or cancellation failures. Invalid generated records cannot report success.
- Message-only Claude/Codex trajectories remain available; malformed or missing
  selected evidence cannot prove absence. Broken checkers remain instrument
  errors, including when negated.
- The oracle runs a scratch copy of retained output and distinguishes a bad
  subject implementation from a broken checker. Both roles retain usage;
  missing started-role usage makes coverage partial.
- Role deadlines stop the exact private runtime. Tests distinguish surviving
  process groups from stale socket files and preserve unrelated runtimes.

Required checks passed on Quorum `aa5006d0` and Gauntlet `74d2037`:

```sh
# Quorum implementation worktree, with the paired Gauntlet source selected
GAUNTLET_ROOT=/Users/drewritter/prime-rad/gauntlet/.worktrees/conversation-assessment bun run check
bun run quorum check
# Gauntlet implementation worktree
bun run check
```

| Check | Result |
|---|---|
| Quorum lint/typecheck/core tests | 3,660 passed; 14 expected environment skips |
| Dashboard checks | 144 passed |
| Scenario/credential/suite validation | Passed |
| Gauntlet core/UI typechecks, builds and tests | 1,345 passed; two provider-gated skips |
| Focused role/accounting/publication and actual CLI integration | 60 passed; no skips |

The controller inspected the successful command outputs. Local logs are
`/tmp/task7-q-check.log`, `/tmp/task7-q-scenarios.log`,
`/tmp/task7-g-check-reused-ui.log`, and `/tmp/task7-final-focused.log`.
These are pre-final-fix whole-suite receipts; final amended-code coverage is
recorded separately below rather than presented as another full-suite run.

The Quorum skips are a Windows hook case and 13 explicit Docker/Linux tests.
The Gauntlet skips are existing provider-client message-shape checks. New real
terminal and actual CLI tests ran. Gauntlet UI validation initially lacked a
reachable dependency directory; the worktree now reuses the existing matching
UI dependency installation through an ignored local symlink. No package,
lockfile or global link changed. The required UI build resolved an earlier
missing-template warning. An existing passing API test still logs its missing
Anthropic credential; no real key was supplied to silence it.

The final whole-branch review found three Important defects. The consolidated
fix passed scoped re-review, with all three findings addressed and no new
breakage or out-of-scope observations. No hosted provider,
Docker/appliance run, deployment, push or merge has occurred. Scripted responses
prove the machinery; live role quality and parallel capacity remain unmeasured.

## Integration findings resolved

The actual CLI check exposed two mismatches that isolated fixtures missed:
Gauntlet's valid failing assessment uses exit 1, and a stopped tmux server may
leave a socket inode. Quorum now interprets the assessor exit together with its
validated result and checks the exact server/process liveness. Neither a bad
implementation nor a stale socket is treated as a new behavioral protocol.

Task reviews also corrected orphan cleanup after launcher exit, malformed
trajectory exception handling, Codex wrong-directory attribution, and durable
completion ordering. These fixes are covered by behavioral regressions.

The final whole-branch review reproduced three additional defects: Q confused
criterion `unclear` with overall `investigate`; Q rewrote an already durable
completion using a truncating write; and subject `process.exit(0)` bypassed the
oracle assertions. The first was masked by a fixture using the wrong wire
vocabulary. The storage finding used controlled persistent ENOSPC injection,
not an actual host storage incident. The oracle finding was an actual Node
execution with missing exports, not a claim that the assessor also passed it.
These findings are included here as negative evidence, not erased by later fixes.

The correction in Quorum `d52b36be` accepts the actual criterion vocabulary,
retains valid persisted conversation bytes without reopening the root file, and
writes necessary fallback records through a private staging file and rename.
The oracle temporarily guards subject-requested process exit during import and
assertions, restores the process function afterward, and preserves real process
death as an instrument failure. This fixture guard is not an adversarial sandbox.

Final amended-code verification:

```sh
GAUNTLET_ROOT=/Users/drewritter/prime-rad/gauntlet/.worktrees/conversation-assessment bun run test test/conversation-pricing.test.ts test/runner-conversation.test.ts test/runner-conversation-gauntlet-integration.test.ts test/runner-stopped.test.ts
bun run typecheck
node --check scenarios/conversation-pricing/oracle.cjs
```

48 tests passed with no failures/skips, 330 assertions, across four files in
8.84 seconds. Changed-file Biome checked six files clean; tsc, oracle syntax and
diff checks passed. The tested tree `02322f21a1f8af5ba08ed3625f9bcdc38f180b85`
matches the fix commit's tree. Local receipts are `/tmp/final-fix-focused.log`,
`/tmp/final-fix-biome.log`, `/tmp/final-fix-typecheck-green.log` and
`/tmp/final-fix-oracle-syntax.log`. Full suites were not repeated after these
localized changes; Gauntlet source was unchanged.

The new regressions first failed on the old code, then passed with the correction:

- Five real CLI cases now include overall fail with mixed fail/unclear criteria
  and overall investigate with unclear evidence. An overall pass with a
  non-passing criterion still fails validation.
- Persistent write-fault tests retain byte-identical completed records in normal,
  cancellation and later-error paths. Failed staging writes and failed renames
  preserve prior root bytes and remove temporary files.
- Actual oracle executions reject early exit during import or finalPrice,
  including requested exit 0 and 127, while genuine SIGTERM remains a signal.

The final reviewer inspected both original net changes once, then the single
correction range `aa5006d0..d52b36be`. The final verdict is **ready for offline
handoff**. The relevant corrected code is the
[completion writer and criterion validation](../../src/runner/conversation.ts),
[pricing oracle](../../scenarios/conversation-pricing/oracle.cjs), and their
[actual CLI integration](../../test/runner-conversation-gauntlet-integration.test.ts),
[storage-fault controls](../../test/runner-conversation.test.ts) and
[oracle controls](../../test/conversation-pricing.test.ts).

RED receipts: `/tmp/final-fix-criteria-oracle-red.log` (33 pass, seven expected
failures) and `/tmp/final-fix-durability-red.log` (23 pass, six expected failures,
one overlapping the criterion case).

## Next finite appliance proof

This is a proposed next run plan, not launch authorization. Resolve the exact
reviewed Evals/Gauntlet revisions and a selected Superpowers revision through the
existing source snapshot, and use the current appliance registration/run/status
path. Do not switch a shared appliance checkout under active work.

Proposed routes from the current credential registry:

| Role | Harness / credential | Declared model |
|---|---|---|
| Subject | Claude / `opus5_bedrock` | `anthropic.claude-opus-5` |
| Subject | Codex / `openai_responses_56sol` | `gpt-5.6-sol` |
| Simulated user and assessor | `sonnet5_bedrock` for both roles | `anthropic.claude-sonnet-5` |

Use high subject effort and the same resolved Superpowers main revision for all
six runs. These are source declarations, not fresh claims of appliance/provider
readiness. Recheck the installed helper, source pins, credential routes, pricing
and current caps before registration; no additional credential system is needed.

1. Inspect one fresh `conversation-pricing` run on Claude and one on Codex,
   sequentially. Check the actual question/answer, endpoint, native transcript,
   output oracle, independent criterion evidence and complete two-role usage.
2. If both paths are useful and operationally valid, register fresh work with
   two copies per harness and a global cap of four. This overlaps copies within
   each harness and across both harnesses, subject to current credential caps.
3. Stop on an instrument failure, missing completion/evidence, unexpected model
   routing, unusable grader behavior or missing started-role usage. A completed
   bad implementation is a recorded behavioral result, not an automatic retry.

Total: six fresh runs, with no replacement/recovery campaign. Each conversation
has its ten-minute bound and assessment its two-minute bound; preserve the
existing attempt deadline. Proposed spend allocation is $40 total: $10 for the
two inspected runs and $30 for the four overlapping runs. Confirm that allocation
before any launch. Use current cost/status readouts and cancel remaining work if
the allocation is reached or usage coverage becomes unavailable. This is an
operator stop rule; current campaign code has no hard dollar limiter, and
in-flight requests may settle after cancellation. Do not claim a guaranteed
provider-billing ceiling. This proof tests the interaction path;
it is not a Superpowers treatment comparison or a throughput qualification.

## Implementation decisions

These are the controller's rulings, in execution order. They keep the context
needed to revisit a decision without reconstructing the task conversation.

| Decision | Reason and cost if wrong |
|---|---|
| Task 4 ran alongside Task 1 in the other repository. | The approved plan permits this independent work; possible integration rework. |
| Reused packages already reachable from parent directories. | Avoided installation changes; a missing dependency would require a setup retry. |
| Kept all seven tasks offline and retained campaign/scheduler policy. | The approved increment is one capability; live behavior remains unproved. |
| Task 5 ran alongside Task 4 with disjoint ownership. | It consumed fixed wire contracts; possible coordination or integration rework. |
| Task 4 also changed the check-tool CLI. | Negation must not hide a broken checker; a wrong exit classification would require focused correction. |
| Role CLIs initialize run-start logging with actual model/provider identity. | They own client setup and the role functions do not receive that identity; a wrong boundary would require an interface adjustment. |
| Updated the existing scenario-pinning test's expected set. | The new fixture intentionally restricts harnesses; a mistaken expectation could conceal a restriction error. |
| Task 6 began after Tasks 4/5 production contracts passed review, while isolated cleanup and G work continued. | Fixed subprocess contracts enabled independent implementation; possible later integration rework. |
| Converse exits 1 for incomplete records and 0 for completed records unless cleanup fails. | Its process status describes execution, not output quality; a mismatch would misclassify results. |
| Task 3 ran alongside Task 2's persistence-only fix. | Remaining paths were disjoint; possible cross-role integration rework. |
| Assessment uses the existing logger's free-string adapter label and omits optional result config. | Truthful role attribution without inventing an adapter/schema; readers requiring config would need reconsideration. |
| New-mode result cases live in runner-conversation tests. | The exact new result location differs from QA; a missed contract would require additional behavioral coverage. |
| Task 7 changed common new-mode finalization and the outer catch to attach economics. | All outcomes need both role costs; incorrect placement could omit or duplicate accounting. |
| Reconciled assessment exit validation with actual G status/exit behavior. | Fail and investigate legitimately exit 1; a mistaken mapping would turn behavioral results into instrument errors. |
| Replaced socket-inode existence with exact server/process liveness. | A dead tmux server can leave its socket file; a wrong probe could conceal surviving work. |
| Reused matching G UI dependencies through an ignored worktree-local symlink. | Manifest/lock equality was checked; undo the link and repeat G validation if that assumption fails. |
| Corrected the plan's oracle import behavior so premature exit cannot imply assertion success. | The spec requires invalid/missing output to fail; this is fixture-only correctness, not adversarial isolation. |
