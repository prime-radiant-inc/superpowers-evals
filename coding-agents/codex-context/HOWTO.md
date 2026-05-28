# How to drive Codex (the agent under test)

You are driving Codex in a bash shell inside tmux. Codex is itself an
AI agent; what appears on screen is its work.

## Launch Codex with one command

Your bash starts in a scratch directory, NOT the workdir quorum
prepared. quorum has generated a launcher that handles everything — it
cds into the prepared workdir, sets the per-run isolated `CODEX_HOME`,
and starts codex with the bypass flag. Type **this one line, verbatim**
as your first action:

```
"$QUORUM_LAUNCH_AGENT"
```

That path is burned into this HOWTO at runtime by quorum; it points at a
generated executable that runs, in effect:

```
cd <prepared-workdir> && CODEX_HOME=<per-run-isolated-dir> codex --dangerously-bypass-approvals-and-sandbox
```

Because the `cd` and the flags live inside the launcher, you cannot skip
them. Do NOT hand-type a bare `codex` or reconstruct the `cd … && codex`
line yourself — launching codex from the scratch dir lands its rollouts
off-workdir and quorum discards the run as misconfigured. Just run the
one line above. (The isolated `CODEX_HOME` ensures no user-installed
Codex plugins or prior sessions affect this run.)

For superpowers tool-mapping scenarios that use the legacy `.agents`
symlink path, the setup step creates `.agents/skills/superpowers/` in
the workdir before you start.

## Observing what Codex is doing

Codex writes rollout logs as JSONL files under
`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` — one file per
(sub)agent, organized by date. Because this run has its own isolated
`CODEX_HOME`, anything in there is from this session.

The rollout JSONL is **ground truth** for what Codex has done — every
tool call, every reasoning step, every shell invocation lands there.
The screen is a rendering that can lag, scroll off the top, or stay
frozen while subagents do long work. Trust the log over the screen
when the two disagree.

To peek at recent activity:

```
ls -t "$CODEX_HOME"/sessions/**/rollout-*.jsonl | head -1
```

`tail` or `jq` that file to see Codex's tool invocations.

## Waiting for Codex to work

When Codex is busy (especially when it dispatches subagents — every
subagent appends its own rollout file under the same `sessions/`
hierarchy), do **not** poll the screen with `sleep`. That pattern
burns one inference turn per ~25 seconds of real time and can drive
the agent into a degenerate empty-turn state on long-haul runs.

Instead, register the rollout glob once after launch, then block-wait:

```
watch_logs(glob="$CODEX_HOME/sessions/**/rollout-*.jsonl")
wake_on_idle_log(idle_ms=60000, timeout_ms=240000)
```

`wake_on_idle_log` blocks **one inference turn** until any of:

* **idle** — no log activity for `idle_ms` (60s here). Probably a good
  moment to check in.
* **new_file** — a new subagent rollout appeared. Qualitatively new
  state worth a glance.
* **timeout** — 240s ceiling. Don't raise this; the model context
  cache expires past 5 minutes.

One turn per ~4 minutes of real time, vs. one turn per 25s for
`sleep`-and-poll. Use ad-hoc `bash tail -n` *after* waking if you want
to see what changed.

## Shutdown

Press Ctrl+D to end the session cleanly.
