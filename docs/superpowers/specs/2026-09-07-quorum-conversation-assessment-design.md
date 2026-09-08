# Quorum: separate conversation from assessment

**Status:** Approved by Drew for implementation planning on 2026-09-07.
**Implementation:** Completed offline; [handoff and next pilot](../../experiments/2026-09-07-conversation-assessment-implementation.md). Live appliance proof remains pending.
**Implementation plan:** [Seven scoped tasks](../plans/2026-09-07-quorum-conversation-assessment.md).
**Scope:** One complete scenario on Linux Claude and Codex, using current Quorum
workers and appliance execution. This is the next increment, not a replacement
architecture for Superpowers Evals.

## Outcome and scope

A scenario describes a user and their request in prose. A simulated user drives
the real coding harness, answers questions, and stops when the Coding-Agent
delivers an answer or refuses. Quorum retains the conversation and output, runs
independent checks, and obtains a separate assessment. A bad implementation or
refusal is still a completed interaction and remains visible in the result.

Keep existing provisioning, model/effort selection, credentials, launchers,
per-attempt containers, check execution, verdicts, and appliance ownership.
One worker performs conversation, capture, checks and assessment sequentially;
its existing reservation remains held throughout. Existing scheduling overlaps
workers. Both Gauntlet roles initially use the same configured controller model
and credential, with separate histories and tool access.

This increment does not change campaign admission, publication, validity,
replacement or sealing policy. It adds no scheduler, grading queue, service,
credential registry, generic eval interface, regrading system or dashboard.
It does not migrate the scenario catalog or repair the Go scenario. The first
appliance proof uses credential routes the campaign already supports.

The [focused review](../../experiments/2026-09-07-focused-quorum-review.md)
explains the later campaign-policy simplification. That work is separate.

## Scenario and first example

Keep `story.md`, its existing frontmatter and `## Acceptance Criteria` section,
plus the existing `setup.sh`/`checks.sh`/generated checks-manifest convention.
Add the scalar `quorum_mode: conversation` to select this flow. Validate it in
`quorum check` and before launch; unknown values are errors. Absence continues
to select the current QA flow. Only the new scenario opts in initially, and its
existing coding-agent directive restricts it to Claude/Codex. Other harnesses
must not silently fall back to QA for a conversation-mode scenario.

The text before the AC section is the simulated user's brief: their request,
private background facts and relevant preferences. The AC section is private
to assessment. Project each separately; never send the conversation actor the
original story/raw card, grading criteria, QA project prompt or HOWTO tree.
The existing story parser already separates description and criteria; no new
scenario language or authored dialogue protocol is needed.

Create `conversation-pricing` using the existing tiny pricing fixture, with its
answer-revealing BUG comments removed. Its public opening is:

> Unknown discount codes make our checkout total NaN. Can you fix that? Please
> check with me how unknown codes should behave before choosing the fix.

The user privately wants unknown codes to charge full price and known discounts
to keep working. They answer naturally and do not suggest where to edit or which
skill to invoke. Stop at a final delivery claim or refusal, even if nothing was
fixed. This deliberately exercises question handling; it does not measure
spontaneous discovery of an unstated requirement.

The rubric assesses whether the agent obtained and followed the user's policy,
and whether its delivered answer is supported by the output and verification
evidence. The independent oracle tests `finalPrice` using prices 0, 37.5 and 100,
the three existing discount codes, and at least two unknown codes. It rejects
unchanged NaN behavior and fixes hard-coded to one example. A valid solution may
change either internal function; this scenario does not impose an unstated
producer API or require a particular Superpowers skill. Subject-written tests
remain evidence, not the correctness oracle.

## Execution boundary

Quorum owns provisioning, mode selection, input projection, phase order,
evidence selection and final composition. Gauntlet owns the two model-driven
roles, terminal interaction and its existing logging/provider machinery.

Add two explicit Gauntlet entrypoints, `converse` and `assess`. These are new
commands to implement, not current CLI capabilities. Their inputs are:

| Invocation | Quorum supplies | Available behavior |
|---|---|---|
| `converse` | Projected user brief, exact generated launcher path, workspace, output location, selected model and time limit | Launch prepared subject once; observe and respond as the user; finish without a grade |
| `assess` | Private rubric, selected retained evidence/check results, output location, selected model and time limit | Read evidence and return the existing cited criterion/result shape |

Use small role-specific functions over Gauntlet's existing client, logger and
TUI adapter. Do not route an AC-stripped card through the unchanged QA loop:
that loop still adds grading tools, reflection and deadline instructions. Do
not generalize it into a policy-plugin framework.

The conversation runtime executes Quorum's generated launcher as the terminal's
initial command. It preserves the selected HOME, provider, model, effort and
Superpowers activation. The model does not type a launch command. The terminal
must not fall back to an interactive shell after the subject exits, and input
is rejected after subject exit or conversation completion.

The user actor has terminal screen/input controls and activity waiting. It can
answer native questions while a turn is pending. A dedicated read-only file tool
may read files the subject presents, within the small scenario workspace scope;
it rejects paths/symlinks escaping that scope. It exposes neither credentials,
private criteria nor raw internal session logs. No general shell, credential
fetch or log-inspection tool is callable, including through dispatch of an
unadvertised tool. Existing internal log-activity waiting may be reused without
feeding log contents to the model.

The actor's finish action cites the visible delivery/refusal it observed. Gauntlet
validates and persists that endpoint before cleanup. Quorum retains it even if
cleanup, capture or judging later fails. An unexplained exit, timeout or cancelled
conversation is not inferred to be a completed answer. This small record is not
an early slot-release signal or new campaign transition protocol.

After stopping the subject, Quorum captures evidence and snapshots the small
scenario output. The independent oracle executes against that snapshot inside
the existing attempt container, with the existing restricted check environment
and private scratch. The assessor starts with a fresh history and only evidence
reading/reporting tools. It creates no terminal and cannot send another message
to the subject or execute its generated code.

Retain native source logs selected by the existing harness capture rules, the
user-visible exchange, the output checked by the oracle, and check/assessment
results. Do not copy credential HOMEs as assessment input. The oracle consumes
the same captured output the assessor sees; its own script stays outside the
subject-writable workspace. Full repository reconstruction and historical
artifact-version recording are outside this scenario's needs.

## Completion, assessment and accounting

Persist `conversation.json` at the run root. It records `status`
(`completed | stopped | timed_out | errored`), `endpoint`
(`delivery | refusal | null`), a reason, timestamp and reference to the saved
visible evidence. Completed records require a delivery/refusal reference.
Project this record into `verdict.json`; setup failure before conversation may
leave it absent. No later error may overwrite an already observed completion.

Keep the existing outer verdict: `pass | fail | indeterminate`, check records,
identity/provenance, economics, and corresponding worker exit codes. For this
mode, its `gauntlet` field is the actual independent assessor's result, including
the existing per-criterion verdict/evidence array. Render it as **Assessment**.
Never synthesize a driver pass to satisfy the composer. A recorded assessor
`process_exit` must come from that assessor child, not the conversation child.

| Observed situation | Result |
|---|---|
| Completed delivery, required checks and assessment pass | Completed conversation; final pass |
| Completed bad delivery or refusal; required checks/assessment fail | Completed conversation; final fail |
| Completed delivery/refusal; required capture, checker or assessor is broken | Completed conversation; final indeterminate with the failing stage |
| Assessor returns `investigate` | Assessment inconclusive; preserve conversation status |
| Conversation stops, times out or errors before an endpoint | Preserve partial evidence; final indeterminate; no claim of completed interaction |

In this slice, incomplete interaction does not start a semantic assessment.
Preserve ordinary failed check records; invalid/missing subject output is a
behavioral failure, whereas a missing checker interpreter or killed checker is
an assessment error. Do not turn a malformed output into an infrastructure
exception merely because it cannot be imported. Keep expected-check matching.

Fix message-only capture throughout the exercised Claude/Codex path: retain
message-bearing trajectories, distinguish unavailable capture from zero tools,
and carry that distinction through retries, strict capture and transcript checks.
Surface normalization failures for selected sources. Do not silently treat lost
sources as proof of absence. This is not a redesign of every normalizer or a
cross-session causal model. Also correct `command-succeeds` so a signalled child
cannot pass through its current null-exit-status fallback.

Keep separate conversation and assessment logs/usage. The assessor writes to
the existing Gauntlet assessment-result location; the conversation uses its own
role directory and must not be selected as a grading result. Explicitly combine
both usage streams in the existing Gauntlet economics total, while retaining
the raw per-role amounts. Missing usage for a started role makes coverage partial;
a role that never started is recorded as not run, rather than missing usage.
The existing reader selects only one sidecar today, so this summation is required
by the split. No new provider or accounting service is needed.

The conversation uses the existing `quorum_max_time` setting; set the small
scenario to 10 minutes. Assessment has a two-minute bound. Each duration begins
when its Gauntlet child is launched and includes startup/model waits. Quorum
enforces the child deadline outside model/tool promises, stops the exact active
role/runtime on timeout or cancellation, and starts no later phase after cancel.
The existing outer attempt deadline remains authoritative and is never extended.
If cleanup cannot complete, that outer runtime termination remains the final
bound. A hung model request must not require a provider-wide cancellation redesign.

Current campaign readers must still accept the worker's real verdict, identity,
usage and publication artifacts. The initial proof reads the per-run result;
the campaign's existing aggregate remains subject to its existing validity policy.
This spec does not promise a replacement batch report or historical conversion.

## Acceptance and implementation boundary

Meaningful offline tests must establish:

- Brief/criteria separation and restricted dispatch, a real question/answer
  exchange through the terminal seam, one prepared launch, and no input after exit.
- A valid fix passes; unchanged/hard-coded fixes fail; a refusal with zero tools
  remains completed and assessable; missing capture and a broken/killed oracle
  remain explicit errors. Check actual outcomes, not rendered command strings.
- A fresh assessor cannot continue the subject; missing/contradictory criterion
  results cannot produce a pass. Both Gauntlet invocations contribute usage.
- Cancellation, a hung role and an assessor failure preserve the already written
  completion fact and existing termination boundaries.

After implementation, the live proof inspects this scenario on Claude and Codex,
then overlaps copies within and across those harnesses using existing appliance
execution. Select models, finite sample counts and spending bounds in the run
plan. This spec authorizes no live calls by itself. Proof of the interaction path
is distinct from a Superpowers treatment comparison or eight/sixteen-run capacity
qualification. Separate grading may add latency/cost; no speedup is presumed.

The implementation plan should cover Gauntlet's two role entrypoints and terminal
startup/dispatch; Quorum story metadata, runner/capture/composer/economics/rendering;
and the single fixture/oracle. Keep that as one vertical capability. Do not begin
with an unrelated runner-file reorganization or a campaign state-machine rewrite.

Source anchors: [story metadata](../../../src/story-meta.ts),
[runner](../../../src/runner/index.ts:1963),
[composer](../../../src/composer.ts:72),
[economics](../../../src/economics.ts:316),
[checker](../../../src/check/fs-verbs.ts:327),
[Gauntlet prompt](/Users/drewritter/prime-rad/gauntlet/src/agent/prompts.ts:59),
[Gauntlet TUI](/Users/drewritter/prime-rad/gauntlet/src/adapters/tui/adapter.ts:129).
Sources were inspected at Quorum `2975440a` and Gauntlet `588a81e8`.
