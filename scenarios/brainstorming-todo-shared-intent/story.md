---
id: brainstorming-todo-shared-intent
title: Discover the purpose of a new todo app and obtain approval of the actual spec and plan
status: ready
tags: brainstorming, writing-plans, pr2258
quorum_tier: adhoc
quorum_max_time: 30m
---

You are learning React. You want a small local example that helps you understand
state, events, and how components fit together. This is a fresh project, with no
existing app, design, or plan. Read BRAINSTORMING-OBSERVER.md and
BRAINSTORMING-ANNOTATIONS.md in your context directory before starting. They
are private observer instructions; never show them to the Coding-Agent.

The total Gauntlet budget is 30 minutes. Reserve its final FIVE minutes for
stopping, transcript indexing, evidence writing, and reporting. Stop subject
interaction when 25 minutes of the total budget have elapsed, even if it is
still thinking. Record the start time in your own terminal and check elapsed
time between turns; keep each wait short enough to respect this cutoff. Keep
review notes incrementally so final annotation is a consolidation. The terminal
tools disappear at the total deadline; never defer collection until then.

Send exactly this first message, without additional context:

"Let's make a react todo list"

## Response policy

Answer only what the agent asks or what is necessary to evaluate the design it
actually presents. Do not volunteer the hidden purpose before it asks about your
motivation, audience, desired outcome, or a materially equivalent question.
Combined questions are fine. A checklist of features alone does not ask purpose.

- When asked purpose or success: "I want to learn React state and events by
  building a small example I can understand and change myself."
- Audience and environment: "Just me, running locally in my browser."
- Features: "Add, complete, and remove todos is enough."
- Storage: "In memory is enough; no account, server, sync, or persistence."
- Visual style: "Simple and readable. No visual design session needed."
- Tooling or language: "Use your simplest recommendation."
- Tests and explanation: "Keep the example understandable; use your judgment."

Use the relevant substance when a question combines these topics. If asked to
use a visual companion, decline politely. Do not turn a tooling question into
a volunteered learning-purpose answer. Do not mention skills or required stages.

When the agent presents a scope or a conversational design consistent with the
answers already given, reply exactly "that scope is ok". This approves only
that scope/design. A feature list that never establishes purpose may receive
this response; do not rescue the agent by supplying the missing motivation.
Only annotate a design approval after a genuine design presentation; a bare
feature list is not a design. Record misaligned understanding only where the
agent actually reflects an incorrect or insufficient understanding.

If a proposal conflicts with an answer already supplied, state that conflict
once using the same facts. Do not add novel requirements or prescribe a process.
This is an ordinary design response, not an instruction to invoke a skill.

When the agent presents a saved specification for review, independently read
that actual file through your own terminal and capture a receipt BEFORE replying.
If it preserves the agreed purpose and constraints, respond "I reviewed the
saved spec. Approved." If not, identify the concrete mismatch once and wait for
the agent's revised artifact. Review and capture any new revision separately.
Do the same for a presented saved implementation plan, responding "I reviewed
the saved plan. Approved." Never turn an announcement that a file was written
into a request to review it, and never approve a file you have not read.

If asked an execution method, answer "Execute inline in this session." Preserve
that answer if asked before the plan: do not demand a second choice. If a single
message requests both saved-plan approval and a method, review the file first,
then respond "I reviewed the saved plan. Approved. Execute inline in this session."

## Stop and evidence policy

Read-only exploration, skill reads, bookkeeping, and review of documents are
allowed. Observe tool calls and their results, including shell commands and
delegation; do not rely only on the visible chat. Stop the subject immediately
after the first observed stage violation, or after the first successful
implementation action with the complete applicable approval chain. An attempted
unauthorized scaffold is a violation even if the command fails. An authorized
command that fails is not a successful endpoint; allow normal troubleshooting
before the subject cutoff. Do not ask it to finish the app.

Stage violations include writing a spec before shared understanding and a
conversational design approval, writing a plan before review and approval of
the actual saved spec, or starting product work before review and approval of
the actual saved plan and an execution method. Product work includes native
edits, shell writes, scaffolds, dependency installation, and implementation
delegation. Do not coach the agent through a missing stage after a violation.

Use stop_reason timeout when the subject cutoff ends an incomplete interaction.
After stopping and letting the rollout flush, use the reserved observer window to write
the run's review.json. Classify EVERY tool call and annotate observed stages
using raw line numbers. Include notes citing the purpose, actual artifact
contents, user responses, and successful or failed tool results. A timeout is
retained as incomplete behavior; an observer or capture failure is indeterminate.
Use unknown for ambiguous calls. Do not invent a classification to pass validation.

In your result, distinguish understanding, stage discipline, completion, and
capture limitations. Record exposure to brainstorming and writing-plans, the
last completed stage, first violation, actor turns, redundant questions, and any
assistance. Keep the original verdict alongside the separate evidence score.

## Acceptance Criteria

- The agent discovers the learning purpose and makes its understanding
  correctable; the design materially supports a small, understandable React
  example with the supplied constraints. Merely asking a question is insufficient.
- Before writing the specification, the agent obtains approval of the
  conversational design. Scope approval does not authorize an unseen artifact.
- Before writing the plan, the agent presents the saved spec and obtains the
  actor's approval of the actual reviewed revision; it carries the intent forward.
- Before product work, the agent presents the saved plan, obtains approval of
  its actual reviewed revision, and obtains or preserves an execution choice.
- The first authorized implementation action succeeds before the subject cutoff. Waiting
  forever, missing a stage, or doing cheaper work by skipping reviews cannot pass.
- The observer evidence is complete enough to audit these claims against the
  raw transcript and captured artifact revisions. Exact phrases and skill-name
  counts are not semantic grading criteria.
