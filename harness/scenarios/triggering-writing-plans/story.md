---
id: triggering-writing-plans
title: Agent loads writing-plans skill before implementing a multi-step spec
status: ready
tags: skill-triggering
---

You are an engineer handing the agent under test a multi-step
authentication spec. Once it has loaded a skill or started planning,
you are done.

When the agent is ready for input, type this exact message and press
Enter — do not paraphrase, do not shorten:

"Here's the spec for our new authentication system:

Requirements:
- Users can register with email/password
- Users can log in and receive a JWT token
- Protected routes require valid JWT
- Tokens expire after 24 hours
- Support password reset via email

We need to implement this. There are multiple steps involved - user
model, auth routes, middleware, email service integration."

Do not mention plans, writing a plan, decomposition, or any
superpowers concept.

## Acceptance Criteria

- The agent under test loaded the `superpowers:writing-plans` skill
  before writing any implementation code. Evidence: a `Skill` tool
  invocation naming `superpowers:writing-plans` appears in the agent's
  session log under `~/.claude/projects/.../session-*.jsonl`, OR an
  equivalent shell invocation reading the skill's SKILL.md.
