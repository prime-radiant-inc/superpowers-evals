# Driving Hermes Agent

Hermes Agent is a terminal REPL. Provisioning has already seeded
`$HOME/.hermes/` (config.yaml with the OpenRouter model, `.env` with the API
key) and staged + enabled the Superpowers plugin — do not install or
configure anything yourself.

## Launch Hermes with one command

Your bash starts in a scratch directory, NOT the workdir quorum prepared.
quorum has generated a launcher that handles everything: it cds into the
prepared workdir, pins a throwaway `$HOME` for the run, and starts Hermes with
`--yes` (auto-approves command execution so the run never blocks on an
approval prompt) and `--no-memory` (disables cross-session memory; each eval
run must be memoryless). Type this one line, verbatim, as your first action:

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

- The session transcript accumulates under `$HOME/.hermes/sessions/`.
- Errors and gateway traces: `$HOME/.hermes/logs/errors.log` and
  `$HOME/.hermes/logs/gateway.log`.

## Completion

The turn is complete when Hermes returns to its input prompt with no spinner
or streaming output. When the story's task is done, exit the REPL (`/exit`,
or Ctrl-D at the prompt) so the session file is finalized before capture.

## Quirks

(Record real quirks discovered during live smokes here — startup banner
noise, prompt-detection strings, plugin-load messages worth waiting for.)
