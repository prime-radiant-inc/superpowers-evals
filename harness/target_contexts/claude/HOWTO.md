# How to drive Claude Code (the agent under test)

You are driving Claude Code in a bash shell inside tmux. Claude Code is
itself an AI agent; what appears on screen is its work.

## First: cd into the scenario's prepared workdir

Your bash starts in a scratch directory, NOT the workdir the harness
prepared. Always start with:

```
cd "$HARNESS_AGENT_CWD"
```

`HARNESS_AGENT_CWD` is set in the inherited environment by the harness.
It points at the git repo the setup step prepared.

## Invocation

After `cd`, run:

```
claude --dangerously-skip-permissions --plugin-dir "$SUPERPOWERS_ROOT" --model opus
```

`$SUPERPOWERS_ROOT` is set in the inherited environment.

## Observing what Claude is doing

Claude writes its session log as JSONL files under
`~/.claude/projects/<derived-path>/<UUID>.jsonl`. The `<derived-path>`
is the launch cwd with every `/` replaced by `-`. The filename itself
is a UUIDv4 (e.g. `7206a2c2-95f3-46e9-9bc8-8f6a863fcfc6.jsonl`).

You can `tail` or `jq` this file to see what tools Claude has invoked —
useful when the screen is mid-render or you want ground truth on tool
usage. To find the file Claude just wrote:

```
find ~/.claude/projects -name '*.jsonl' -mmin -5 -print
```

## Shutdown

Type `/exit` and press Enter to end the session cleanly.
