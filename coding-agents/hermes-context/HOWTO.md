# Driving Hermes Agent

Hermes Agent is a terminal REPL. Provisioning has already seeded
`$HOME/.hermes/` (config.yaml with the OpenRouter model, `.env` with the API
key) and staged + enabled the Superpowers plugin — do not install or
configure anything yourself.

## Launch Hermes with one command

Your bash starts in a scratch directory, NOT the workdir quorum prepared.
quorum has generated a launcher that handles everything: it cds into the
prepared workdir, pins a throwaway `$HOME` for the run, and starts Hermes with
`--yolo` (auto-approves command execution and tool use so the run never
blocks on an approval prompt). Each eval run gets a fresh throwaway `$HOME`,
so there is no cross-session memory to disable. Type this one line, verbatim,
as your first action:

```
"$QUORUM_LAUNCH_AGENT"
```

That path is burned into this HOWTO at runtime by quorum.

Because the `cd`, throwaway `$HOME`, and launch flags live inside the
launcher, do not hand-type a bare `hermes` or reconstruct the command
yourself — that would run Hermes against the operator's real `~/.hermes`
instead of the isolated per-run home where provisioning seeded
`config.yaml`, `.env`, and the staged Superpowers plugin. Just run the one
line above.

Wait for the input prompt before typing. Type the story's message exactly and
press Enter.

## Observing progress

- Logs: `$HOME/.hermes/logs/agent.log` and `$HOME/.hermes/logs/errors.log`.
- Sessions live in a SQLite store (`$HOME/.hermes/state.db`), not files —
  there is nothing to tail. The harness exports the session to JSON after the
  run finishes (`hermes sessions export`), so progress must be read from the
  logs above and the terminal output itself, not a growing transcript file.

## Completion

The turn is complete when Hermes returns to its input prompt with no spinner
or streaming output. When the story's task is done, exit the REPL (`/exit`,
or Ctrl-D at the prompt) so the session is finalized before capture. (Whether
this exact exit sequence is required for hermes has not been verified
interactively — treat it as the safe default until confirmed.)

## Quirks

(Record real quirks discovered during live smokes here — startup banner
noise, prompt-detection strings, plugin-load messages worth waiting for.)
