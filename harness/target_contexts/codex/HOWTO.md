# How to drive Codex (the agent under test)

You are driving Codex in a bash shell inside tmux. Codex is itself an
AI agent; what appears on screen is its work.

## First: cd into the scenario's prepared workdir

Your bash starts in a scratch directory, NOT the workdir the harness
prepared. Always start with:

```
cd "$HARNESS_AGENT_CWD"
```

`HARNESS_AGENT_CWD` is set in the inherited environment by the harness.

## Invocation

After `cd`, run:

```
codex --dangerously-bypass-approvals-and-sandbox
```

For superpowers tool-mapping scenarios that use the legacy `.agents`
symlink path, the setup step creates `.agents/skills/superpowers/` in
the workdir before you start.

## Observing what Codex is doing

Codex writes rollout logs as JSONL files under
`~/.codex/sessions/rollout-*.jsonl`. Multiple Codex sessions across all
projects share this directory. Find the newest file:

```
ls -t ~/.codex/sessions/rollout-*.jsonl | head -1
```

`tail` or `jq` it to see Codex's tool invocations.

## Shutdown

Press Ctrl+D to end the session cleanly.
