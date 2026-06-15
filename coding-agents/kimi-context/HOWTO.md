# How to drive Kimi Code (the agent under test)

You are driving Kimi Code in a bash shell inside tmux. Kimi Code is itself
an AI agent; what appears on screen is its work.

## Launch Kimi with one command

Your bash starts in a scratch directory, NOT the workdir quorum prepared.
quorum has generated a launcher that handles everything: it cds into the
prepared workdir, pins a throwaway `$HOME` for the run, and starts Kimi
with automatic permissions. Type this one line, verbatim, as your first action:

```
"$QUORUM_LAUNCH_AGENT"
```

That path is burned into this HOWTO at runtime by quorum.

Because the `cd`, throwaway `$HOME`, auth settings, and permission flags live inside the
launcher, do not hand-type a bare `kimi` or reconstruct the command yourself.
Just run the one line above.

The launcher pins HOME but sets no `KIMI_CODE_HOME`; Kimi defaults
`KIMI_CODE_HOME` to `$HOME/.kimi-code`, the per-run isolated Kimi home. quorum
registers the local Superpowers checkout as the only enabled Kimi plugin in that
home. Auth and model settings are supplied by quorum through its generated
launcher; do not hand-type provider env vars, use a local Kimi login, or
reconstruct the command yourself.

## Observing what Kimi is doing

Kimi writes session metadata under:

```
$KIMI_CODE_HOME/session_index.jsonl
```

The active session's wire log lives under:

```
$KIMI_CODE_HOME/sessions/**/agents/main/wire.jsonl
```

The wire log is ground truth for Kimi tool calls and agent actions. The screen
can lag, scroll off the top, or stay frozen during long-running work. When the
screen and logs disagree, trust the log.

Find the newest wire log:

```
find "$KIMI_CODE_HOME/sessions" -name wire.jsonl -exec ls -t {} + 2>/dev/null | head -1
```

Tail that file to inspect recent activity.

## Waiting for Kimi to work

When Kimi is busy, do not poll the screen with repeated sleeps. Register the
wire-log glob once after launch, then block-wait:

```
watch_logs(glob="$KIMI_CODE_HOME/sessions/**/wire.jsonl")
wake_on_idle_log(idle_ms=60000, timeout_ms=240000)
```

Use `wake_on_idle_log(...)` to spend one inference turn waiting until the log
goes idle, a new transcript appears, or the timeout expires. After waking, use
an ad-hoc shell command such as `tail` or `jq` if you need to inspect what
changed.

## Shutdown

Type `/exit` and press Enter to end the session cleanly.
