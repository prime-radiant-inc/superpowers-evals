---
id: codex-subagent-wait-mapping
title: Codex uses wait_agent (not wait) when collecting subagent results
status: ready
tags: codex, tool-mapping
quorum_max_time: 30m
---

You are an engineer testing whether the Codex agent follows the
Superpowers tool-mapping reference. When Codex is ready, type this
exact message and press Enter — do not paraphrase:

"Read .agents/skills/superpowers/using-superpowers/references/codex-tools.md.
Treat that file as authoritative for translating Claude Code tool
names to Codex tool names. Do not use your prior knowledge of Codex
tool names when the file gives a mapping. Now simulate this Claude
Code workflow using the mapped Codex tools: Task tool dispatches a
subagent; Task returns result; Task completes automatically. The
subagent's whole job is to answer exactly PR963_OK. Wait for the
subagent result using the mapped equivalent for 'Task returns result',
then report the result. Do not edit files."

If Codex asks a short clarifying question, answer briefly and tell it
to follow the mapping file. Once it reports PR963_OK or says it
cannot complete the mapped wait step, you are done.

## Acceptance Criteria

- Codex invoked `spawn_agent` (the subagent-spawn tool).
- Codex invoked `wait_agent` (the mapped equivalent of "Task returns
  result").
- Codex did NOT invoke the bare `wait` tool.
- `spawn_agent` was invoked before `wait_agent`.
