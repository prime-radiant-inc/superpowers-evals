# Container runtime for superpowers evals

**Status:** design (2026-06-15)
**Builds on:** `2026-06-15-per-run-home-isolation.md`

## Problem

Live evals currently run directly on the operator host. Quorum already isolates
each Coding-Agent inside a per-run throwaway home at
`results/<run>/home`, but the outer process still depends on host-installed
toolchains, host-installed agent CLIs, and host shell state. That makes runs
harder to reproduce and makes it too easy for a local workstation difference to
become an eval result.

We need a rich container runtime that can run the existing quorum suite while
keeping the system under test and the run evidence outside the container:

- the evals checkout stays bind-mounted and editable;
- the superpowers checkout under test stays bind-mounted as `SUPERPOWERS_ROOT`;
- all run artifacts stay under the host-visible `results/` directory;
- credentials enter through explicit read-only inputs, not through ambient host
  home or full environment inheritance.

The prior `prime-radiant-inc/superpowers-test-harness` image is useful as an
agent-install catalog, but its model is not the target. It used one shared image
plus long-lived per-harness containers and auth volumes, with a driver outside
the container. Quorum's model is different: it owns per-run homes and captures
the run directory as the evidence root. The new runtime should preserve quorum's
existing artifact contract instead of adding a second results layout.

## Decisions

1. **Use a long-lived workspace container.** The container is a stable dev
   workstation for the bind-mounted checkout. It may keep caches and shell
   state, but quorum still creates a fresh `<run>/home` for every Coding-Agent
   run under `results/`.
2. **Bind-mount both code roots.** The evals repo mounts at `/workspace/evals`.
   The superpowers checkout under test mounts at `/workspace/superpowers`, and
   the runtime exports `SUPERPOWERS_ROOT=/workspace/superpowers` when running
   quorum.
3. **Use `/workspace/evals/results` as the container results path.** The wrapper
   runs from `/workspace/evals`, so quorum's default `--out-root results`
   writes to the host-visible results directory without extra flags.
4. **Use read-only credential inputs.** Env credentials come from a read-only
   mounted dotenv file sourced inside the container. File/OAuth credential
   sources mount read-only under `/auth/<agent>` and are exposed through
   explicit source variables such as `CODEX_AUTH_HOME` or `GEMINI_OAUTH_HOME`.
5. **Use `container/Dockerfile`, not a devcontainer spec.** The image is a rich
   devcontainer-style workstation, but there is no `.devcontainer/devcontainer.json`
   in this design. The interface is Docker-native via a repo-owned wrapper.
6. **Do not support the dashboard in the container.** Dashboard usage stays a
   host-side workflow.
7. **Do not mount the Docker socket.** Agents in this container must not get
   root-equivalent access to the host through `/var/run/docker.sock`.
8. **Skip desktop IDE agents for v1.** No Cursor desktop, Kiro, Trae,
   Antigravity desktop, Xvfb, VNC, or noVNC stack in the first image.

## Runtime layout

The wrapper starts a named container with these paths:

```text
/workspace/evals          bind-mounted evals checkout
/workspace/superpowers    bind-mounted superpowers checkout under test
/workspace/evals/results  host-visible quorum results directory
/run/evals/credentials.env  optional read-only dotenv credential file
/auth/codex               optional read-only Codex auth source
/auth/gemini              optional read-only Gemini/agy OAuth source
/auth/kimi-code           optional read-only Kimi OAuth/install source
/auth/pi                  optional read-only Pi OAuth source
```

Container-local state is allowed for toolchain caches and workstation
convenience: npm, Bun, Go, Rust, Python, Ruby, `mise`, shell history, and other
non-evidence state. Container-local state must never be the only copy of quorum
run evidence. The following must always land under `/workspace/evals/results`:

- `verdict.json`;
- `gauntlet-agent/results/**`;
- `coding-agent-workdir/**`;
- `home/**`;
- `trajectory.json`;
- token/cost artifacts.

The wrapper should probe `/workspace/evals/results` for writeability and
host-visible mount behavior before any live eval command. A missing or
unwritable results path is a hard error.

## Image

The image should be a rich Ubuntu 26.04 dev workstation based on Microsoft's
devcontainer base image. The verified 26.04 tag is:

```dockerfile
FROM mcr.microsoft.com/devcontainers/base:3.0.1-ubuntu26.04
```

Do not silently fall back to Ubuntu 24.04. If the tag is unavailable during
implementation, check the available Microsoft devcontainer tags and choose an
explicit 26.04-compatible tag.

The image should include broad implementation tooling because coding agents will
use it for real development work, not only eval runner work:

- system basics: `bash`, `zsh`, `git`, `gh`, `curl`, `wget`, `ca-certificates`,
  `jq`, `yq`, `ripgrep`, `fd`, `tmux`, `less`, `unzip`, `zip`, `xz-utils`;
- build basics: `build-essential`, `pkg-config`, common SSL, sqlite, zlib, and
  compression development libraries;
- language/toolchain stack: Go, Rust, Node/npm, Bun, Python, `uv`, `mise`, Ruby;
- quorum requirements: Bun compatible with this repo, Gauntlet CLI, and the
  normal shell tools used by scenarios and checks.

Install current quorum Coding-Agent CLIs plus old-harness CLI-only candidates
where the install path is known:

- current quorum targets: Claude Code, Codex CLI, Gemini CLI, Kimi Code,
  OpenCode, Pi, Copilot CLI, and Antigravity CLI if the CLI can be installed
  without bringing in the desktop IDE stack;
- future CLI candidates from the old harness: aider, amp, auggie, cline,
  continue-cli, cursor-agent, factory droid, goose, kilocode, openclaw, qoder,
  qwen.

Desktop IDE agents are out of scope for v1.

Version pinning should be pragmatic. Pin base image and non-package-manager
downloads. Pin CLI package versions where practical, but do not block the first
runtime slice on perfect pinning for every fast-moving agent CLI. The built image
tag or digest is the reproducibility handle for a run.

## Credentials

The runtime has two credential channels.

### Env credentials

The wrapper mounts one dotenv file read-only at `/run/evals/credentials.env`.
The `quorum` shim sources that file immediately before running quorum. The file
is outside `results/` and is never copied into a run artifact by the wrapper.

Default discovery:

1. `.env.container` in the evals checkout;
2. `.env` in the evals checkout;
3. no env file.

Missing default env files are not errors, because many operations (`quorum list`,
`quorum check`, `quorum show`) do not need live credentials. An explicitly passed
`--env-file <path>` must exist and be readable or `up` fails.

The wrapper must not pass the host environment wholesale. Raw Docker `-e` or
`--env-file` credential injection is intentionally avoided because those values
become Docker metadata. A read-only mount sourced inside the container is the
default.

### File/OAuth credential sources

The wrapper mounts known auth source directories read-only when they exist by
default, and exposes them through source variables:

```text
/auth/codex      -> CODEX_AUTH_HOME
/auth/gemini     -> GEMINI_OAUTH_HOME; Antigravity should use the same mounted
                    source through an explicit adapter-supported source var
/auth/kimi-code  -> KIMI_OAUTH_HOME
/auth/pi         -> PI_OAUTH_HOME
```

If the Antigravity adapter does not yet expose an OAuth source override, add one
before treating Antigravity as container-ready. Do not let Antigravity fall back
to the container user's long-lived `$HOME` as an implicit credential source.

Missing default auth dirs are not errors. Explicit `--auth name=path` values
must exist and be directories or `up` fails.

Quorum adapters may copy credentials from these read-only sources into each
run's isolated `<run>/home`, matching the current per-agent provisioning
contract. That is acceptable because run directories are already sensitive
live-eval artifacts.

## Wrapper

Add `scripts/evals-container` as the Docker-native interface. It owns the image
tag, container name, mounts, UID/GID mapping, and path defaults.

Commands:

```bash
scripts/evals-container build
scripts/evals-container up
scripts/evals-container down
scripts/evals-container status
scripts/evals-container shell
scripts/evals-container exec <command> [args...]
```

Common usage:

```bash
scripts/evals-container up
scripts/evals-container exec quorum list
scripts/evals-container exec quorum check
scripts/evals-container exec quorum run scenarios/foo --coding-agent codex
scripts/evals-container exec quorum run-all --coding-agents codex --jobs 1
scripts/evals-container exec quorum show
scripts/evals-container exec bash -lc 'go test ./...'
```

Defaults:

- evals checkout: the repo containing the wrapper, mounted at
  `/workspace/evals`;
- superpowers checkout: the parent of evals when the repo is checked out as
  `superpowers/evals`, mounted at `/workspace/superpowers`;
- results: `/workspace/evals/results`;
- env file: first existing `.env.container`, then `.env`, then absent;
- auth mounts: existing host defaults for Codex, Gemini, Kimi, and Pi;
- container name: deterministic from the evals checkout path hash.

Wrapper flags before the subcommand override defaults:

```bash
--name <container-name>
--superpowers-root <dir>
--env-file <file>
--auth codex=<dir>
--auth gemini=<dir>
--auth kimi=<dir>
--auth pi=<dir>
```

The `exec` command stops wrapper option parsing: after `exec`, arguments are
passed directly to `docker exec`.

## Quorum shim

Install a small `/usr/local/bin/quorum` shim in the image. It should:

1. `cd /workspace/evals`;
2. source `/run/evals/credentials.env` when present, without echoing values;
3. export `SUPERPOWERS_ROOT=/workspace/superpowers`;
4. export auth source variables for mounted auth dirs that exist;
5. `exec bun run src/cli/index.ts "$@"`.

Only the `quorum` shim sources credentials. A raw shell command through
`scripts/evals-container exec bash ...` should not automatically source secrets.
This keeps arbitrary development commands from receiving live eval credentials
unless the user explicitly opts in.

## Non-goals

- No alternate quorum results layout.
- No dashboard support in the container wrapper.
- No Docker socket mount.
- No `.devcontainer/devcontainer.json`.
- No desktop IDE agent support or VNC stack in v1.
- No automatic live eval in static validation.
- No copying credential env files into `results/`.

## Verification

Static repo gates after implementation:

```bash
bun run check
bun run quorum check
```

Container gates after implementation:

```bash
scripts/evals-container build
scripts/evals-container up
scripts/evals-container status
scripts/evals-container exec quorum list
scripts/evals-container exec quorum check
scripts/evals-container exec bash -lc 'test -w /workspace/evals/results'
scripts/evals-container exec quorum show --help
```

Credential and mount behavior should have focused wrapper tests where possible:

- missing explicit `--env-file` fails;
- absent default env file is allowed;
- missing explicit `--auth name=path` fails;
- absent default auth dirs are allowed;
- `/workspace/evals/results` write probe fails closed;
- `exec quorum ...` sees `SUPERPOWERS_ROOT=/workspace/superpowers`;
- raw `exec bash ...` does not source the credential env file automatically.

Trusted live smoke is separate and opt-in. A minimal live smoke should run one
cheap scenario against one explicitly credentialed agent and confirm that the
run directory appears under host-visible `results/` with a populated `<run>/home`
and `verdict.json`.

## Implementation phases

### Phase 1: runtime MVP

- Add `container/Dockerfile`.
- Add the `quorum` shim.
- Add `scripts/evals-container` with `build`, `up`, `down`, `status`, `shell`,
  and `exec`.
- Install the rich Ubuntu 26.04 dev toolchain.
- Install current quorum agent CLIs and CLI-only future candidates where the
  install path is known.
- Implement default bind mounts, read-only env file mount, read-only auth source
  mounts, and results write probe.

Phase 1 should be useful without live credentials: build, up, shell,
`exec quorum list`, and `exec quorum check` must work without secrets.

### Phase 2: hardening

- Pin more agent CLI versions where practical.
- Emit an image/runtime version report listing key toolchains and agent CLI
  versions.
- Add focused wrapper tests for argument parsing and mount validation.
- Add one opt-in live smoke script or documented command, kept out of public CI.
