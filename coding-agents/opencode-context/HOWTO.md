# How to drive OpenCode (the agent under test)

You are driving OpenCode in a bash shell inside tmux. OpenCode is itself an AI
agent; what appears on screen is its work.

## Launch OpenCode with one command

Your bash starts in a scratch directory, NOT the workdir quorum prepared.
quorum has generated a launcher that handles everything: it cds into the
prepared workdir, sets an isolated OpenCode home, sets XDG state/config/cache
directories, registers the isolated `OPENCODE_CONFIG_DIR`, and starts OpenCode
in direct interactive mode with dangerous permissions skipped. Type this one
line, verbatim, as your first action:

```
"$QUORUM_LAUNCH_AGENT"
```

That path is burned into this HOWTO at runtime by quorum; it points at a
generated executable that runs, in effect:

```
cd <prepared-workdir> && env -i PATH=<path> HOME=<per-run-isolated-home> XDG_CONFIG_HOME=<home>/.config XDG_DATA_HOME=<home>/.local/share XDG_STATE_HOME=<home>/.local/state XDG_CACHE_HOME=<home>/.cache TMPDIR=<home>/.tmp OPENCODE_CONFIG_DIR=<home>/.config/opencode opencode run -i --dangerously-skip-permissions
```

Because the cd and isolated environment live inside the launcher, do not
hand-type a bare `opencode` or reconstruct the command yourself. Just run the
one line above.

## Observing what OpenCode is doing

OpenCode writes runtime state under the isolated home:

```
$OPENCODE_QUORUM_HOME/.local/share/opencode/opencode.db
$OPENCODE_QUORUM_HOME/.local/share/opencode/log/
```

After the run, quorum exports matching sessions to:

```
$OPENCODE_QUORUM_HOME/.quorum/session-exports/[0-9]*-ses_*.json
```

Those exported JSON files are the ground truth for tool calls and are what
quorum normalizes into `coding-agent-tool-calls.jsonl`.

## Waiting for OpenCode to work

When OpenCode is busy, wait for it to finish rather than repeatedly polling the
screen. If you need to inspect local logs, use the isolated log directory:

```
find "$OPENCODE_QUORUM_HOME/.local/share/opencode/log" -maxdepth 1 -type f -print 2>/dev/null
```

## Shutdown

Type `/exit` and press Enter to end the session cleanly.
