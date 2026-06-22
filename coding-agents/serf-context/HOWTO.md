# How to drive serf (the agent under test)

You are driving **serf** in a bash shell inside tmux. serf is itself an AI
coding agent; its output is its work.

serf is **non-interactive and one-shot**: you give it the task as a single
argument, and it runs the entire task autonomously — reading files, writing
files, running commands, and calling tools in a loop — until the work is done,
then it exits back to the shell prompt. There is no REPL to type into
turn-by-turn.

## Launch serf with the task as one argument

Your bash starts in a scratch directory, NOT the workdir quorum prepared.
quorum has generated a launcher that handles everything: it cds into the
prepared workdir, pins an isolated `$HOME` for the run, points serf's
`--plugin-dir` at the Superpowers plugin, pins the model, writes serf's native
ATIF trajectory via `--export-atif`, and isolates serf's provider config and
state. Pass the task you want serf to do as a single quoted argument:

```
"$QUORUM_LAUNCH_AGENT" 'Describe the task here, e.g. build a React todo list'
```

That path is burned into this HOWTO at runtime by quorum; it points at a
generated executable that runs, in effect:

```
cd <prepared-workdir> && env -i PATH=<path> HOME=<per-run-isolated-home> ... \
  SERF_PROVIDERS_CONFIG=<home>/.serf/providers.toml \
  serf --model <model> --plugin-dir <superpowers-root> \
       --export-atif <home>/.serf/exports/trajectory.json \
       --dir <prepared-workdir> --state-dir <home>/.serf \
       'Describe the task here'
```

Do not hand-type a bare `serf` or reconstruct the command yourself — the cd,
isolated environment, plugin dir, model, and export path live inside the
launcher. Pass only your task string as the argument.

## Following up (answering serf's questions or giving more direction)

serf may finish a turn by asking you a question or reporting back (for example,
a brainstorming step will ask clarifying questions before writing code). serf
runs one-shot, so it exits after the turn. To continue the same session —
answering its questions or steering it — run the launcher again with
`--resume-last` before your reply:

```
"$QUORUM_LAUNCH_AGENT" --resume-last 'Your answer or next instruction'
```

`--resume-last` resumes the most recent serf session from the same isolated
state, so the conversation continues with full context. Repeat as needed until
the scenario objective is met.

## Observing what serf is doing

serf streams its progress (thinking, tool calls, results) to the terminal while
it runs. Wait for it to finish and return to the shell prompt rather than
interrupting it.

serf writes its native ATIF v1.7 trajectory to:

```
$QUORUM_AGENT_HOME/.serf/exports/trajectory.json
```

Each invocation (including `--resume-last`) rewrites that file with the full
session, so after the final turn it holds the complete trajectory. That file is
the ground truth for tool calls and is what quorum normalizes into the run's
`trajectory.json`.

## Shutdown

serf exits on its own after each turn. Once the scenario objective is complete,
no explicit shutdown is needed.
