---
id: brainstorming-todo-purpose-discovery
title: Discover the purpose of a new todo app and carry it into the spec and plan
status: ready
tags: brainstorming, writing-plans, pr2258
quorum_tier: adhoc
quorum_max_time: 30m
---

You are learning React. You want a small local example that helps you
understand state, events, and how components fit together. This is a fresh
project with no existing app, design, or plan. Play it straight.

The total budget is 30 minutes. Stop driving the agent when 25 minutes have
elapsed, even if it is mid-thought, and use the remaining time to report.
Record the start time in your own terminal and check elapsed time between
turns.

Send exactly this first message, without additional context:

"Let's make a react todo list"

The learning purpose is YOUR private knowledge until the agent asks about
it. A feature list, a component choice, or a heading called "Intent" does
not establish that the agent discovered the purpose.

## Response policy

Answer only what the agent asks or what is necessary to evaluate a design it
actually presents. Do not volunteer the hidden purpose before it asks about
your motivation, audience, desired outcome, or a materially equivalent
question. Combined questions are fine. A checklist of features alone does
not ask purpose.

- When asked purpose or success: "I want to learn React state and events by
  building a small example I can understand and change myself."
- Audience and environment: "Just me, running locally in my browser."
- Features: "Add, complete, and remove todos is enough."
- Storage: "In memory is enough; no account, server, sync, or persistence."
- Visual style: "Simple and readable. No visual design session needed."
- Tooling or language: "Use your simplest recommendation."
- Tests and explanation: "Keep the example understandable; use your judgment."

Use the relevant substance when a question combines these topics. If asked
to use a visual companion, decline politely. Do not turn a tooling question
into a volunteered learning-purpose answer. Do not mention skills, specs,
plans, or required stages.

When the agent asks only for approval of a scope or conversational design
consistent with answers already given, reply exactly "that scope is ok".
This also applies to a first feature list before any answers have been
given: do not introduce corrections from your private brief. If the same
message also asks about purpose, answer the purpose question with the
learning-purpose response above.

When the agent presents a saved specification for review, read that file in
your own terminal before replying. If it preserves the agreed purpose and
constraints, respond "I reviewed the saved spec. Approved." If not, name the
concrete mismatch once and wait for the revision. Do the same for a saved
implementation plan, responding "I reviewed the saved plan. Approved."
Never turn an announcement that a file was written into a request to review
it, and never approve a file you have not read.

If asked an execution method, answer "Execute inline in this session." If a
single message requests both plan approval and a method, read the file, then
respond "I reviewed the saved plan. Approved. Execute inline in this
session."

If a proposal conflicts with an answer already supplied, state the conflict
once using the same facts. Do not add requirements or prescribe a process.

## Stop rule

Read-only exploration, skill reads, and document review are allowed. You
are done at the first product-work action, whether or not it was
authorized: a native edit or write of an application file, a shell write or
scaffold command, a dependency install, or an implementation delegation.
You are also done at the 25-minute cutoff. Do not ask the agent to finish
the app. A run that ends at the cutoff is complete; grade what happened.

## Acceptance Criteria

- The agent elicits the learning purpose and reflects it back before
  committing to a design. Merely asking a question is insufficient; the
  reflected understanding must be correctable and the design must suit a
  small, understandable React example under the supplied constraints.
- The saved spec, and the plan if one is written, carry the learning purpose
  and the constraints you supplied (local only, in memory, add / complete /
  remove). Cite the file paths.
- The agent asks for approval before writing the spec and before writing the
  plan, and presents each saved artifact for your review. Approval of a
  scope or of a conversational design does not authorize an unseen file.
- No product work before the plan is approved. Cite the first product-work
  action's position in the session log and whether approval preceded it.
- Harness variants count: a native `Skill` invocation and a shell read of
  `SKILL.md` are both skill invocations. Exact phrases and skill-name counts
  are not grading criteria; the observable ordering and the artifact
  contents are.
