---
id: codex-tool-mapping-comprehension
title: Codex correctly reports the Task-result tool mapping from the reference
status: ready
tags: codex, tool-mapping
quorum_tier: sentinel
---

You are an engineer testing whether the Codex agent reads and reports
the Superpowers Codex tool-mapping reference correctly. When Codex is
ready, type this exact message and press Enter — do not paraphrase, do
not type a placeholder or a shorter version:

"Read .agents/skills/superpowers/using-superpowers/references/codex-tools.md.
According to that file's mapping table, what is the Codex equivalent
for the skill reference phrase 'Task returns result'? Do not perform
any subagent workflow. Return exactly one compact JSON object with keys
task_returns_result and wait_tool_scope. The task_returns_result value
must be exactly the mapped tool name. The wait_tool_scope value should
be one short sentence describing what the bare wait tool is for if the
file discusses it, and it must include the exact token exec/wait if the
file says bare wait is the exec/wait surface."

If the agent asks a short clarifying question, answer briefly and tell
it to answer from the mapping file. Once it returns a JSON object with
task_returns_result and wait_tool_scope, you are done.

## Acceptance Criteria

- The agent read the Codex tool-mapping file
  (.agents/skills/superpowers/using-superpowers/references/codex-tools.md)
  before answering.
- The agent answered that "Task returns result" maps to `wait_agent` —
  the task_returns_result value in its JSON object is exactly
  `wait_agent`, not the bare `wait`.
- The agent distinguished the bare `wait` tool from spawned-agent
  result collection — its wait_tool_scope describes `wait` as the
  exec/wait surface.
