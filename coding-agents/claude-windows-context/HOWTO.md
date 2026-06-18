# How to drive Claude Code on Windows (the agent under test)

You are driving Claude Code through a bash shell inside tmux on Linux. That
shell SSHes into a Windows VM where Claude Code actually runs. What appears on
screen is Claude's native-Windows session.

## Launch Claude with one command

Your bash starts in a scratch directory. quorum has generated a launcher that
SSHes into the Windows guest and starts Claude in the prepared workdir with a
per-run throwaway home, the plugin dir, model, and permission flag already set.
Type **this one line, verbatim** as your first action:

```
"$QUORUM_LAUNCH_AGENT"
```

Do NOT hand-type `claude` or reconstruct the line. The cd, auth, plugin-dir, and
flags all live inside the per-run Windows launch script the launcher runs.

## Observing what Claude is doing

Claude writes its session log as JSONL under the guest path
`$WIN_LOG_DIR\<derived>\<UUID>.jsonl`. The screen is a rendering that can lag.
The log is ground truth. quorum captures it back to Linux after the run; during
the run you can peek with a one-off SSH if needed, but prefer waiting on screen
progress over polling.

## Shutdown

Type `/exit` and press Enter to end the session cleanly.
