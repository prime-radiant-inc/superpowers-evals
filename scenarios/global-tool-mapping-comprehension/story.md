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
for example, 'dispatch a subagent'. If YOUR platform has a Superpowers
tool-mapping reference (a platform-specific *-tools.md file under the
using-superpowers skill's references/ directory), find it and treat it
as authoritative for translating an action into the concrete tool to
call; if your platform has no such file, use your native equivalent for
the action. Map the action 'dispatch a subagent' to the concrete tool
and use it to dispatch exactly one subagent whose entire job is to reply
with exactly the token GLOBALMAP_OK. Then report that token back to me.
Do not edit files."

If the agent asks a short clarifying question, answer briefly and tell
it to follow its own platform's mapping file if it has one, otherwise
its native tool. Once it reports GLOBALMAP_OK (or says it cannot
complete the step), you are done.

## Acceptance Criteria

- Before dispatching, the agent resolved the tool for "dispatch a
  subagent" from its platform's Superpowers tool mapping. If a
  platform-specific *-tools.md reference exists for the agent's platform
  under the using-superpowers references/ directory (e.g. codex-tools.md,
  pi-tools.md, antigravity-tools.md), the agent must have consulted it
  first — evidence is a native Read of that file OR a shell cat/grep/rg
  of it in the session log before the dispatch. If the agent's platform
  has NO reference file (e.g. Claude Code — the native platform the
  action language is written for — or any harness not listed under
  using-superpowers' Platform Adaptation), the agent satisfies this
  criterion by recognizing that no mapping file applies and dispatching
  via its native subagent tool, not by inventing a file or some other
  mechanism.
- The agent dispatched a subagent using the tool its mapping resolves to
  for "dispatch a subagent" (the normalized tool is `Agent`), not some
  other mechanism — no shell loop, no doing the work inline, no asking
  the human to do it.
- The agent reported the token GLOBALMAP_OK produced by the subagent.
- For a platform that HAS a mapping file, reading it only after
  dispatching — or never reading it — fails the first criterion; the
  mapping is meant to drive the choice, not annotate it afterward. A
  platform with no reference file is not penalized for not reading one.
