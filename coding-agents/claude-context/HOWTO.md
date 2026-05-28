# How to drive Claude Code (the agent under test)

You are driving Claude Code in a bash shell inside tmux. Claude Code is
itself an AI agent; what appears on screen is its work.

## First: cd into the scenario's prepared workdir

Your bash starts in a scratch directory, NOT the workdir barf
prepared. Always start with:

```
cd "$BARF_AGENT_CWD"
```

`BARF_AGENT_CWD` is set in the inherited environment by barf.
It points at the git repo the setup step prepared.

## Invocation

After `cd`, run:

```
CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR" claude --dangerously-skip-permissions --plugin-dir "$SUPERPOWERS_ROOT" --model opus
```

The `CLAUDE_CONFIG_DIR` and `SUPERPOWERS_ROOT` values are burned into
this HOWTO at runtime by barf — they look like env-var refs but
barf has already substituted absolute paths. tmux strips arbitrary
env from new sessions, which is why we don't rely on inheritance.

`CLAUDE_CONFIG_DIR` points at a per-run isolated `.claude` dir (seeded
with dialog-bypass state) so no user-installed plugins or projects from
the host machine affect this run.

## Observing what Claude is doing

Claude writes its session log as JSONL files under
`$CLAUDE_CONFIG_DIR/projects/<derived-path>/<UUID>.jsonl`. The
`<derived-path>` is the launch cwd with every `/` replaced by `-`. The
filename itself is a UUIDv4 (e.g.
`7206a2c2-95f3-46e9-9bc8-8f6a863fcfc6.jsonl`).

The log is **ground truth** for what Claude has done — every tool call,
every Skill load, every file edit lands there. The screen is a
rendering that can lag, scroll off the top, or stay frozen during long
subagent runs even while Claude is busy. When in doubt, trust the log
over the screen.

**Use the log, not just `read_screen`, when:**

- You need to verify a specific tool call or Skill load happened.
- The screen shows a spinner or "running" indicator with no detail.

For waiting on Claude to make progress, do not poll `read_screen` —
see "Waiting for Claude to work" below.

Find the active session file:

```
find "$CLAUDE_CONFIG_DIR/projects" -name '*.jsonl' -mmin -5 -print
```

Tail it as JSONL:

```
tail -20 <path> | jq -c '{type, name: (.message.content[0].name // .type)}'
```

If the log keeps growing while the screen stays still, Claude is still
working — keep watching the log; don't conclude the run is stuck.

## Waiting for Claude to work

When Claude is busy (especially when it dispatches subagents via
`Agent`, or runs a long bash command), do **not** poll the screen with
`sleep`. That pattern burns one inference turn per ~25 seconds of real
time and can drive the agent into a degenerate empty-turn state on
long-haul runs.

Instead, register the rollout glob once after launch, then block-wait:

```
watch_logs(glob="$CLAUDE_CONFIG_DIR/projects/**/*.jsonl")
wake_on_idle_log(idle_ms=60000, timeout_ms=240000)
```

`wake_on_idle_log` blocks **one inference turn** until any of:

* **idle** — no log activity for `idle_ms` (60s here). Probably a good
  moment to check in.
* **new_file** — a new session file appeared (fresh subagent thread or
  new conversation). Qualitatively new state worth a glance.
* **timeout** — 240s ceiling. Don't raise this; the model context
  cache expires past 5 minutes.

One turn per ~4 minutes of real time, vs. one turn per 25s for
`sleep`-and-poll. Use ad-hoc `bash tail -n` *after* waking if you want
to see what changed.

## Shutdown

Type `/exit` and press Enter to end the session cleanly.
