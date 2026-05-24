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
CODEX_HOME="$CODEX_HOME" codex --dangerously-bypass-approvals-and-sandbox
```

The `CODEX_HOME` value is burned into this HOWTO at runtime — it points
at a per-run isolated config dir so no user-installed Codex plugins or
prior sessions affect this run.

For superpowers tool-mapping scenarios that use the legacy `.agents`
symlink path, the setup step creates `.agents/skills/superpowers/` in
the workdir before you start.

## Observing what Codex is doing

Codex writes rollout logs as JSONL files under
`$CODEX_HOME/sessions/rollout-*.jsonl`. Because this run has its own
isolated `CODEX_HOME`, anything in there is from this session. Find the
newest file:

```
ls -t "$CODEX_HOME/sessions"/rollout-*.jsonl | head -1
```

`tail` or `jq` it to see Codex's tool invocations.

## Shutdown

Press Ctrl+D to end the session cleanly.
