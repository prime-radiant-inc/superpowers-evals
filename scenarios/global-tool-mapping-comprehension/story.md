---
id: global-tool-mapping-comprehension
title: Agent finds and applies its platform's tool-mapping reference to dispatch a subagent
status: ready
tags: tool-mapping
quorum_tier: sentinel
---

You are an engineer verifying that the agent can find and apply ITS
platform's Superpowers tool-mapping reference. When the agent is ready,
type this exact message and press Enter — do not paraphrase, do not
shorten, and do NOT name a specific file or tool:

"Superpowers skills are written in platform-neutral action language —
for example, 'dispatch a subagent'. Find YOUR platform's Superpowers
tool-mapping reference (the platform-specific *-tools.md file under the
using-superpowers skill's references/ directory) and treat it as
authoritative for translating an action into the concrete tool to call.
Using the tool that file maps to the action 'dispatch a subagent',
dispatch exactly one subagent whose entire job is to reply with exactly
the token GLOBALMAP_OK. Then report that token back to me. Do not edit
files."

If the agent asks a short clarifying question, answer briefly and tell
it to follow its own platform's mapping file. Once it reports
GLOBALMAP_OK (or says it cannot complete the step), you are done.

## Acceptance Criteria

- The agent located and consulted its platform's *-tools.md mapping
  file under the using-superpowers references/ directory before
  dispatching — evidence is a native Read of that file OR a shell
  cat/grep/rg of it in the session log. (Each platform has its own file:
  claude-code-tools.md, codex-tools.md, gemini-tools.md,
  copilot-tools.md, pi-tools.md, antigravity-tools.md.)
- The agent dispatched a subagent using the tool its mapping file
  specifies for "dispatch a subagent" (the normalized tool is `Agent`),
  not some other mechanism — no shell loop, no doing the work inline,
  no asking the human to do it.
- The agent reported the token GLOBALMAP_OK produced by the subagent.
- Reading the file only after dispatching, or never reading it, fails
  the first criterion — the mapping is meant to drive the choice, not
  annotate it afterward.
