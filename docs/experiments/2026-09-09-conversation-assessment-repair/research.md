# Conversation assessor research follow-up

Date: 2026-09-09 Pacific. Research only; no provider evals or remote executions.
The [failed candidate and both stopped allocations](results.md) remain unchanged.
The proposed next work is defined in the [reliability spec](../../superpowers/specs/2026-09-09-conversation-assessor-reliability-design.md).

## Findings

Astra and Fable independently reviewed the source, retained evidence and primary
provider documentation, then cross-reviewed each other's conclusions.

The missing `criteria` array is already absent in retained SDK-returned content.
The grading rows appear inside the `reasoning` string instead. Gauntlet copies
that input and correctly rejects it. Existing intercepted-fetch tests verify the
local SDK/adapter contract for fixtures; they are not historical HTTP captures.

The same symptom occurred in an older three-criterion grading run. It produced
four missing-array reports, a native one-row probe, and finally a valid
three-row report on its sixth submission, about 74.8 seconds after start.
Its accepted final report hid these earlier failures in the prior completion
summary. The final grading remained wrong on the disputed relationship.

Ten-row expansion and the latest prompt changes are therefore not necessary
causes. A successful ten-row report used 4,092 output tokens, more than any of
the five recent malformed reports. A simple output-token cutoff does not fit.
The nine compared histories differ in case, schema, evidence and timing; they
do not support a failure-rate estimate.

The latest first report returned at 78.5 seconds, its correction at 108.1.
The next request had 11.9 seconds before termination. Equal inner and outer
120-second allowances create a finalization race around awaited requests.
This amplifies failure and explains missing normal finalization; it does not
explain the first malformed report.

The latest grader drafts also credit an unstated all-tasks-watched policy.
That remains an unsupported substitution under the frozen rubric. An explicit,
permissible all-tasks agreement could satisfy the relationship without a special
UI. Clarification and proposal quality are independently judged. The scenario's
hidden preference raises a separate validity question about future cases.

## External corroboration and limits

[Claude Code issue 49747](https://github.com/anthropics/claude-code/issues/49747)
reports a close string/array boundary symptom on Opus 4.7/direct Anthropic,
including repeated shortening before recovery.
[SDK issue 1607](https://github.com/anthropics/anthropic-sdk-python/issues/1607)
reports nesting sensitivity and later corrects its initial batch-only diagnosis.
These are first-hand reports on other configurations, not confirmed causes here.

[Anthropic's generic tool prompt](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools#tool-use-system-prompt)
describes a representation/parsing mechanism consistent with the symptom.
It does not identify Sonnet 5/Mantle's deployed internals.
[AWS's Sonnet 5 model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5.html)
lists structured outputs as unsupported on both Bedrock surfaces. A strict-mode
switch is not an established available fix.

The committee withdrew definitive parser attribution, failure-rate and gate-odds
claims, a guaranteed USD 3 experiment cost, a fixed retry recommendation, and
claims that recovery proved feedback irrelevant. The current schema already
places `criteria` before `reasoning` in `properties`; that swap is not a new
intervention. An exact provider-internal diagnosis remains unavailable.

## Retained research evidence

Private records remain under
`.superpowers/sdd/2026-09-09-conversation-assessment-repair/research-20260909/`:

- `committee-synthesis.md`, SHA-256
  `c928050cc197fede316f4d55347429c46208760af5bdae7c3eb21b2b6d6c7614`.
- `working-failing-matrix.json`, nine authenticated raw logs, SHA-256
  `87258946b13855f485f652c24b83add080f1a1341b7a8be09cf1b8cf5b382810`.
- `argument-reuse-audit.json`, both initial committee reports, both cross-reviews,
  primary-source notes and `research-closure.json`.

The matrix digest above must match the retained artifact before use; private
bodies and expectations do not enter public fixtures or runtime prompts.
