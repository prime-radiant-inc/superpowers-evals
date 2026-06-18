# Windows eval runtime

Runs quorum scenarios with the Coding-Agent executing natively on Windows 11.
**Linux+KVM hosts only** — dockur requires `/dev/kvm`, unavailable on macOS.

## First-Time VM Setup

Create the dockur Windows VM using the `windows-vm` skill recipe (guides initial creation and provisioning).

## Bring Up the VM

Use the wrapper script to manage the VM lifecycle:

```bash
scripts/evals-windows-vm up      # start and wait for sshd
scripts/evals-windows-vm down    # stop the VM
scripts/evals-windows-vm status  # check if running
scripts/evals-windows-vm ssh <cmd>  # run a command on the guest
scripts/evals-windows-vm sync-superpowers  # rsync Superpowers checkout to guest
```

The wrapper handles SSH connection setup, ControlMaster muxing (disabled), and password auth. Docker subcommands (`up`, `down`, `status`) only work when run on the Linux KVM host; from a different orchestrator host, use `ssh` and `sync-superpowers` over an SSH tunnel (`ssh -fN -L 127.0.0.1:2222:127.0.0.1:2222 <kvm-host>`). Requires `sshpass` on the orchestrator (`brew install sshpass` on macOS).

## Environment Setup

Export these before running evals:

```bash
export WIN_EVAL_PASSWORD=<guest-password>    # required; defaults to "password"
export ANTHROPIC_API_KEY=<your-api-key>      # required
export SUPERPOWERS_ROOT=/path/to/superpowers # required
```

Optional overrides (see `scripts/evals-windows-vm` for defaults):

```bash
export WIN_EVAL_CONTAINER=windows11
export WIN_EVAL_HOST=127.0.0.1
export WIN_EVAL_PORT=2222
export WIN_EVAL_USER=user
export WIN_EVAL_SUPERPOWERS_DIR=C:\eval-superpowers
```

## Run Scenarios

```bash
scripts/evals-windows-vm up
scripts/evals-windows-vm sync-superpowers
bun run quorum run scenarios/<name> --coding-agent claude --os windows
bun run quorum show <run-id>
```

Results land in `results/<run-id>/` with the same layout as Linux runs. Run IDs now include the OS dimension, e.g. `<scenario>-claude-windows-<timestamp>-<nonce>`. Per-run guest isolation: everything under `C:\eval-runs\<runId>\` (home, coding-agent-workdir, superpowers, launch.cmd); the run's teardown removes the per-run guest dir.

## Authentication

Guest sessions use `ANTHROPIC_API_KEY` (API-key auth), not the operator's OAuth, ensuring evals are reproducible and not tied to personal subscriptions.

## SSH ControlMaster Note

Guest SSH connections must disable `ControlMaster` muxing. The wrapper and quorum launcher handle this automatically.
