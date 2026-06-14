# Security Policy

quorum is a security-sensitive eval runner. It can launch real agent CLIs in
permissive modes, collect transcripts, read local session logs, and send run
artifacts to an LLM verifier.

## Reporting a Vulnerability

Do not file public issues or pull requests containing exploitable details,
tokens, session logs with secrets, or private filesystem paths.

Report security issues privately through GitHub private vulnerability reporting
when available. If that is not available, contact a Prime Radiant maintainer
privately and share only the minimum detail needed to reproduce the issue.

## Sensitive Data

Never commit:

- `.env` files or API keys
- `results/` output
- raw `session.log`, `trajectory.json`, `filesystem.json`, `verdict.json`, or
  `meta.json` from real runs
- local agent config directories such as `.claude/`, `.codex/`, or `.gemini/`

If a real run prints or captures a secret, rotate the secret before sharing any
artifact derived from that run.

## CI Boundary

Public CI must run only static/unit checks. Live `quorum run ...` evals require
credentials and permissive agent CLIs, so they belong in trusted local or
maintainer-controlled environments only.

## Kimi Live Evals

Kimi live evals launch `kimi --yolo` inside a Quorum-prepared workdir. Quorum
uses a fresh `KIMI_CODE_HOME`, installs only the local Superpowers plugin via
`plugins/installed.json`, and supplies model auth through a temporary runtime
env file that is deleted by the launcher and runner cleanup paths.

Treat Kimi `results/` artifacts as sensitive. Raw `wire.jsonl` logs may contain
model outputs, tool arguments, and provider env until Kimi tool-subprocess env
scrubbing is verified. Do not run live Kimi evals in public CI or against
untrusted PR scenarios.
