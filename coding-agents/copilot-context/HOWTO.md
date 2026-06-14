# How to drive GitHub Copilot CLI (the agent under test)

You are driving GitHub Copilot CLI in a bash shell inside tmux. Copilot is
itself an AI agent; what appears on screen is its work.

## Launch Copilot with one command

Your bash starts in a scratch directory, NOT the workdir quorum prepared.
quorum has generated a launcher that handles everything: it cds into the
prepared workdir, sources the private Copilot env file, sets an isolated
`COPILOT_HOME`, points Copilot at the staged Superpowers plugin, assigns the
run-specific session id, disables auto-update and remote/builtin MCPs, marks
secret env vars for Copilot, and writes logs inside the isolated home. Type
this one line, verbatim, as your first action:

```
$QUORUM_LAUNCH_AGENT_SH
```

That path is burned into this HOWTO at runtime by quorum; it points at a
generated executable that runs, in effect:

```
cd <prepared-workdir> && . <private-copilot-env-file> && env -i PATH=<path> HOME=<per-run-isolated-home> COPILOT_HOME=<per-run-isolated-home> COPILOT_CACHE_HOME=<per-run-isolated-home>/.cache COPILOT_CLI=1 COPILOT_AUTO_UPDATE=false copilot --plugin-dir <per-run-isolated-home>/plugins/superpowers --session-id <run-session-id> --allow-all --no-auto-update --no-remote --disable-builtin-mcps --secret-env-vars=<secret-env-var-names> --log-dir <per-run-isolated-home>/logs
```

Because the cd, env file source, isolated home, plugin directory, session id,
permission flags, secret env var list, and log directory live inside the
launcher, do not hand-type a bare `copilot` or reconstruct the command
yourself. Run only the one line above as your first action.

## Observing what Copilot is doing

Copilot writes session-state events under the isolated home:

```
$COPILOT_HOME/session-state/**/events.jsonl
```

For this run, the launcher passes the session id that quorum generated, so the
expected event file is under:

```
$COPILOT_HOME/session-state/$QUORUM_COPILOT_SESSION_ID/events.jsonl
```

Copilot CLI logs are written under:

```
$COPILOT_HOME/logs
```

The session-state `events.jsonl` files are the ground truth for tool calls and
are what quorum normalizes into `trajectory.json`. The log
directory is useful for CLI lifecycle and debugging details.

## Waiting for Copilot to work

When Copilot is busy, wait for it to finish rather than repeatedly polling the
screen. If you need to inspect local state, use the isolated paths:

```
find $COPILOT_HOME_SH/session-state -name events.jsonl -type f -print 2>/dev/null
find $COPILOT_HOME_SH/logs -type f -print 2>/dev/null
```

## Shutdown

End the session cleanly once the scenario objective is complete.
