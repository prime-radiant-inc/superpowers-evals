# Security Policy

Drill is a security-sensitive eval harness. It can launch real agent CLIs in
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
- raw `session.log`, `tool_calls.jsonl`, `filesystem.json`, `verdict.json`, or
  `meta.json` from real runs
- local agent config directories such as `.claude/`, `.codex/`, or `.gemini/`

If a real run prints or captures a secret, rotate the secret before sharing any
artifact derived from that run.

## CI Boundary

Public CI must run only static/unit checks. Live `drill run ...` evals require
credentials and permissive agent CLIs, so they belong in trusted local or
maintainer-controlled environments only.
