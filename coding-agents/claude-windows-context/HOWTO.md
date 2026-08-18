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

## Env isolation exception

Every Linux-local launcher walls off the host environment with an `env -i`
allowlist (F13). This agent is the documented exception: the local wrapper
delegates the agent's environment to the Windows guest's `launch.cmd`, which
applies additive `set` on top of the guest session env — host-env isolation on
that path is guest-side work owned by the Windows trusted-maintainer path (the
platform spec's Windows carve-out). The exception covers ONLY that guest-side
launch path: the local subprocesses quorum runs against the guest are already
scoped to the non-secret provisioning env allowlist. The wrapper also burns
the SSH password into argv (`sshpass -p`) and into the installed launcher
file — a known residual tracked by the F13 filesystem follow-up.
