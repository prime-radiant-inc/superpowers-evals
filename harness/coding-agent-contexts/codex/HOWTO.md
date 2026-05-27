# How to drive Codex (the agent under test)

You are driving Codex in a bash shell inside tmux. Codex is itself an
AI agent; what appears on screen is its work.

## Launch Codex with one command

Your bash starts in a scratch directory, NOT the workdir the harness
prepared. You MUST cd into the workdir before launching codex, and you
MUST set CODEX_HOME and the bypass flag. The simplest way to avoid
skipping any of these is to type **this one line, verbatim** as your
first action:

```
cd "$HARNESS_AGENT_CWD" && CODEX_HOME="$CODEX_HOME" codex --dangerously-bypass-approvals-and-sandbox
```

`HARNESS_AGENT_CWD` is set in the inherited environment by the harness.
The `CODEX_HOME` value is burned into this HOWTO at runtime — it points
at a per-run isolated config dir so no user-installed Codex plugins or
prior sessions affect this run. Splitting this into multiple commands,
or shortening it to a bare `codex`, will cause the harness to discard
the run as misconfigured.

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
