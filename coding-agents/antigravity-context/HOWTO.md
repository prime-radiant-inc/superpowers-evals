# How to drive Google Antigravity (the agent under test)

You are driving Google Antigravity in a bash shell inside tmux.
Antigravity is itself an AI agent; what appears on screen is its work.

## Launch Antigravity with one command

Your bash starts in a scratch directory, NOT the workdir quorum prepared.
quorum has generated a launcher that handles everything: it cds into the
prepared workdir, pins a throwaway `$HOME` for the run, sets the per-run
isolated `ANTIGRAVITY_CONFIG_DIR` (which equals that throwaway home),
disables auto-update, points `agy` at the isolated `.gemini` directory,
starts Antigravity with dangerous permissions, and registers the prepared
workdir as an Antigravity workspace via `--add-dir`. When the real result path
contains a hidden directory, quorum substitutes a visible symlink that points
at the same workdir. Type this one line, verbatim, as your first action:

```
"$QUORUM_LAUNCH_AGENT"
```

That path is burned into this HOWTO at runtime by quorum; it points at a
generated executable that runs, in effect:

```
cd <prepared-workdir-or-visible-alias> && HOME=<per-run-throwaway-home> ANTIGRAVITY_CONFIG_DIR=<per-run-throwaway-home> AGY_CLI_DISABLE_AUTO_UPDATE=true agy --gemini_dir=<per-run-throwaway-home>/.gemini --add-dir=<prepared-workdir-or-visible-alias> --dangerously-skip-permissions --log-file <per-run-throwaway-home>/agy.log
```

Because the `cd`, throwaway `$HOME`, isolated config directory, `.gemini` path,
auto-update disable, log file, and dangerous permission flag live inside the
launcher, do not hand-type a bare `agy` or reconstruct the command yourself.
Just run the one line above. (agy reads its live OAuth token from
`$HOME/.gemini/oauth_creds.json` at runtime, so the throwaway `$HOME` must hold
the creds quorum seeded — keep the launcher's `HOME` pin.)

## Observing what Antigravity is doing

Antigravity writes raw transcripts as JSONL files under:

```
$ANTIGRAVITY_CONFIG_DIR/.gemini/antigravity-cli/brain/**/transcript.jsonl
```

The CLI log is written to:

```
$ANTIGRAVITY_CONFIG_DIR/agy.log
```

The transcripts are ground truth for Antigravity tool calls and agent actions.
`agy.log` is useful for CLI lifecycle and debugging details. The screen can
lag, scroll off the top, or stay frozen during long-running work even while the
agent is still active. When the screen and logs disagree, trust the logs.

Find the newest transcript:

```
find "$ANTIGRAVITY_CONFIG_DIR/.gemini/antigravity-cli/brain" -name transcript.jsonl -exec ls -t {} + 2>/dev/null | head -1
```

Tail that file or `$ANTIGRAVITY_CONFIG_DIR/agy.log` to inspect recent activity.

## Waiting for Antigravity to work

When Antigravity is busy, do not poll the screen with repeated sleeps. Register
the transcript glob once after launch, then block-wait:

```
watch_logs(glob="$ANTIGRAVITY_CONFIG_DIR/.gemini/antigravity-cli/brain/**/transcript.jsonl")
wake_on_idle_log(idle_ms=60000, timeout_ms=240000)
```

Use `wake_on_idle_log(...)` to spend one inference turn waiting until the log
goes idle, a new transcript appears, or the timeout expires. After waking, use
an ad-hoc shell command such as `tail` or `jq` if you need to inspect what
changed.

## Tool mapping notes

Antigravity may expose Superpowers skill reads through `view_file`.
Subagents may appear as `invoke_subagent` or `manage_subagents`. Task
artifacts are useful evidence, but they are not native task behavior by
themselves.

Antigravity may create `.antigravitycli/` in the workdir. Treat it as runtime
metadata, not user-requested work. Do not count it as satisfying a requested
file edit or artifact unless the user explicitly asked for that metadata.

## Shutdown

Type `/quit` or `/exit` and press Enter to end the session cleanly.
