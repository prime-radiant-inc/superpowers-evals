# Windows eval runtime

Runs quorum scenarios with the Coding-Agent executing natively on Windows 11.
**Linux+KVM hosts only** — dockur requires `/dev/kvm`, unavailable on macOS.

## Prerequisites

1. Create the dockur Windows VM using the `windows-vm` skill recipe (guides first-time setup).
2. Confirm VM is running: `scripts/evals-windows-vm status`

## Environment

Export before running:

```bash
export WIN_EVAL_PASSWORD=<guest-password>      # defaults to "password"
export ANTHROPIC_API_KEY=<your-api-key>
export SUPERPOWERS_ROOT=/path/to/superpowers
# Optional overrides (see defaults in scripts/evals-windows-vm):
# WIN_EVAL_CONTAINER=windows11
# WIN_EVAL_HOST=127.0.0.1
# WIN_EVAL_PORT=2222
# WIN_EVAL_USER=user
# WIN_EVAL_SUPERPOWERS_DIR=C:\eval-superpowers
```

## Run a scenario

```bash
scripts/evals-windows-vm up
scripts/evals-windows-vm sync-superpowers
bun run quorum run scenarios/sdd-go-fractals-opus48 --coding-agent claude-windows
bun run quorum show <run-dir>
```

Results land in `results/<run>/`, using the same layout as a Linux run:
- `results/<run>/home/.claude/projects/**` — session logs (captured via SSH)
- `results/<run>/coding-agent-workdir/**` — workdir artifacts
- `results/<run>/verdict.json` — verdict and economics

## Authentication

The guest session uses `ANTHROPIC_API_KEY` (API-key auth), not the operator's OAuth. This ensures evals are reproducible and not tied to personal subscriptions.

## SSH ControlMaster note

Guest SSH connections must disable `ControlMaster` muxing (dockur multiplexes `ssh -p 2222` back to the host). The wrapper (`scripts/evals-windows-vm`) and quorum handle this automatically.

For detailed design and architecture, see `docs/superpowers/specs/2026-06-17-windows-eval-runtime-design.md`.
