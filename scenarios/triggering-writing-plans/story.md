---
id: triggering-writing-plans
title: Agent loads writing-plans skill before implementing a multi-step feature
status: ready
tags: skill-triggering
quorum_tier: sentinel
---

You are an engineer working in an existing app. You hand the agent
under test a multi-step feature to build on top of it. Once it has
loaded a skill or started planning, you are done.

When the agent is ready for input, type this exact message and press
Enter — preserve formatting, do not paraphrase, do not shorten:

"This app already has its scaffolding in place — Express, an in-memory
user store, and the usual route setup (see app.js). I need to build
out authentication on top of it. Make whatever assumptions you need to
get going. Err on the side of extreemly minimal POC. Use mocks. Use 
stdout. Do not ask me any questions. 

- Users can register with email/password
- Users can log in and receive a JWT token
- Protected routes require a valid JWT
- Tokens expire after 24 hours
- Support password reset via email

Let's build it."

Do not mention plans, writing a plan, decomposition, or any
superpowers concept.

## Acceptance Criteria

- The agent under test loaded the `superpowers:writing-plans` skill
  before writing any implementation code. Evidence: a `Skill` tool
  invocation naming `superpowers:writing-plans` appears in the agent's
  session log under `$CLAUDE_CONFIG_DIR/projects/.../*.jsonl`, OR an
  equivalent shell invocation reading the skill's SKILL.md. Loading the
  skill after writing implementation code does not satisfy this — the
  skill is meant to shape the work, not annotate it after the fact.
