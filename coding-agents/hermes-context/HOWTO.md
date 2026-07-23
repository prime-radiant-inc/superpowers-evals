# Driving Hermes Agent

Hermes Agent is a terminal REPL. Provisioning has already seeded
`$HOME/.hermes/` (config.yaml with the OpenRouter model, `.env` with the API
key) and staged + enabled the Superpowers plugin — do not install or
configure anything yourself.

## Launch

From the scenario workdir, run:

    hermes --yes --no-memory

- `--yes` auto-approves command execution so the run never blocks on an
  approval prompt.
- `--no-memory` disables cross-session memory; each eval run must be
  memoryless.

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
