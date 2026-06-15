# Container Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Docker-native, rich Ubuntu 26.04 workspace container for running quorum while keeping evals code, the Superpowers checkout under test, and all run artifacts bind-mounted on the host.

**Architecture:** A host-side `scripts/evals-container` wrapper builds and manages one long-lived workspace container. The container bind-mounts evals at `/workspace/evals`, Superpowers at `/workspace/superpowers`, and writes quorum results to `/workspace/evals/results`. Secrets enter only through read-only mounts: one dotenv file at `/run/evals/credentials.env` and optional auth source directories under `/auth/*`. A `/usr/local/bin/quorum` shim sources the credential file only for quorum invocations, exports the auth source variables, exports `SUPERPOWERS_ROOT`, and execs the existing Bun CLI.

**Tech Stack:** Docker, Bash, Ubuntu 26.04 via `mcr.microsoft.com/devcontainers/base:ubuntu-26.04`, Bun/TypeScript tests for wrapper behavior, existing quorum TypeScript CLI.

**Spec:** `docs/superpowers/specs/2026-06-15-container-runtime-design.md`

---

## Guardrails

- No `.devcontainer/devcontainer.json`.
- No Docker socket mount, even behind a flag.
- No dashboard-specific container support.
- No desktop IDE stack: no Cursor desktop, Kiro, Trae, Antigravity desktop, Xvfb, VNC, or noVNC.
- No automatic live evals in static validation.
- No host `$HOME` mount. Per-agent homes remain quorum's per-run homes under `results/<run>/home`.
- Do not pass the host environment wholesale into Docker. Only mount the credential dotenv file read-only, then source it inside the quorum shim.
- Kimi is container-ready through `KIMI_OAUTH_HOME=/auth/kimi-code`; the adapter resolves the binary from that source home's `bin/` when OAuth auth is used. Do not invent a second Kimi installer in the Dockerfile.
- Antigravity credentials use `AGY_OAUTH_HOME=/auth/gemini`. Treat `antigravity` as unavailable in the container unless `agy` is present on PATH from a non-desktop installer; do not install the desktop `.deb` to get it.

## File Structure

Create:

- `container/Dockerfile` - rich devcontainer-style image and agent CLI installs.
- `container/bin/quorum` - in-container quorum shim copied to `/usr/local/bin/quorum`.
- `container/bin/evals-tool-versions` - diagnostic version report for toolchains and agent CLIs.
- `scripts/evals-container` - host wrapper for `build`, `up`, `down`, `status`, `shell`, and `exec`.
- `test/evals-container.test.ts` - wrapper tests using a fake `docker` executable.
- `test/container-shims.test.ts` - shell syntax and minimal public-contract tests for container scripts.

Modify only if needed:

- `README.md` or an existing operator doc with short container usage notes. Keep it terse; the design spec remains the detailed explanation.

## Task 1: Confirm the Base Image and Current Runtime Assumptions

**Files:** none

- [ ] Run:

```bash
docker manifest inspect mcr.microsoft.com/devcontainers/base:ubuntu-26.04 >/tmp/quorum-devcontainer-base.json
```

- [ ] Expected: exit 0. If it fails, stop and inspect the Microsoft devcontainer tags for an explicit Ubuntu 26.04-compatible tag. Do not silently switch to 24.04.
- [ ] Run:

```bash
rg -n "CODEX_AUTH_HOME|GEMINI_OAUTH_HOME|KIMI_OAUTH_HOME|PI_OAUTH_HOME|AGY_OAUTH_HOME" src/agents test
```

- [ ] Expected: current adapters already expose these auth source seams. If any seam disappears, update this plan before implementation.
- [ ] Run:

```bash
git status --short --branch
```

- [ ] Expected: clean worktree on the container runtime branch.

## Task 2: Add Wrapper Tests with a Fake Docker Boundary

**Files:**

- Create: `test/evals-container.test.ts`

**Test approach:** Execute the real `scripts/evals-container` script with a temporary `PATH` whose first `docker` executable records argv and returns canned success. Do not assert the entire generated command. Assert only public contracts: selected subcommand, critical mounts, read-only markers, path validation, and that `exec` passes trailing args directly.

- [ ] Write tests for these behaviors before implementing the wrapper:
  - `build` calls Docker with `build`, `-f container/Dockerfile`, and the repo root as context.
  - `up` includes bind mounts for `/workspace/evals`, `/workspace/superpowers`, and `/workspace/evals/results`.
  - `up --env-file <file>` mounts that file at `/run/evals/credentials.env` with `readonly`.
  - missing explicit `--env-file` fails before Docker is called.
  - `up --auth codex=<dir>` mounts the directory at `/auth/codex` with `readonly`.
  - missing explicit `--auth name=<dir>` fails before Docker is called.
  - `up` never includes `/var/run/docker.sock`.
  - `exec quorum run-all --jobs 1` calls `docker exec <container> quorum run-all --jobs 1`; no `--` sentinel is required.

- [ ] Use a fake Docker script like this in the test tempdir:

```bash
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$EVALS_CONTAINER_DOCKER_LOG"
case "$1" in
  build|run|exec|start|stop|rm|ps|inspect)
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
```

- [ ] In tests, set `EVALS_CONTAINER_DOCKER_LOG` and prepend the fake directory to `PATH`. Keep the rest of the environment inherited so the wrapper sees normal `id`, `pwd`, and shell behavior.
- [ ] Run the new test and expect failure because `scripts/evals-container` does not exist:

```bash
bun test test/evals-container.test.ts
```

## Task 3: Implement `scripts/evals-container`

**Files:**

- Create: `scripts/evals-container`

**Interface:**

```bash
scripts/evals-container [--name <container-name>] [--superpowers-root <dir>] [--env-file <file>] [--auth <name=dir>] <command> [args...]
```

Commands:

```bash
build
up
down
status
shell
exec <command> [args...]
```

Required behavior:

- Resolve the evals repo root from the script location, not from the caller's current directory.
- Default `--superpowers-root` to the parent directory when evals is checked out as `superpowers/evals`.
- Default env file discovery: `.env.container`, then `.env`, then no env file. Missing default env files are allowed. A missing explicit `--env-file` is a hard error.
- Default auth mounts only when these host dirs exist:
  - `~/.codex` to `/auth/codex`
  - `~/.gemini` to `/auth/gemini`
  - `~/.kimi-code` to `/auth/kimi-code`
  - `~/.pi` to `/auth/pi`
- Explicit `--auth codex=<dir>`, `--auth gemini=<dir>`, `--auth kimi=<dir>`, and `--auth pi=<dir>` override defaults and must exist as directories.
- Container name defaults to a deterministic hash of the evals root path, for example `superpowers-evals-$(printf '%s' "$evals_root" | shasum | awk '{print substr($1,1,12)}')`.
- Image tag defaults to `superpowers-evals:local`.
- `up` creates host `results/` if needed, then starts a detached long-lived container with:
  - `/workspace/evals` read-write bind mount.
  - `/workspace/superpowers` read-write bind mount.
  - working directory `/workspace/evals`.
  - user id and group id matching the host user.
  - read-only credential mounts.
  - command `sleep infinity`.
- `up` should reuse an existing stopped container by starting it. If a running container already exists, print its name and exit 0.
- `down` stops and removes the named container.
- `status` prints whether the named container exists and whether it is running.
- `shell` runs `docker exec -it <name> bash`.
- `exec` passes all trailing args directly to `docker exec <name> ...`.

Implementation sketch:

```bash
#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
usage: scripts/evals-container [options] <build|up|down|status|shell|exec> [args...]

options:
  --name <name>
  --superpowers-root <dir>
  --env-file <file>
  --auth <codex|gemini|kimi|pi>=<dir>
USAGE
}
```

- [ ] Implement option parsing before the subcommand. After `exec`, stop parsing wrapper options.
- [ ] Use Docker `--mount` syntax rather than `-v`, so `readonly` is explicit in command args.
- [ ] Do not include `/var/run/docker.sock` anywhere in the wrapper.
- [ ] Run:

```bash
bash -n scripts/evals-container
bun test test/evals-container.test.ts
```

- [ ] Commit:

```bash
git add scripts/evals-container test/evals-container.test.ts
git commit -F - <<'EOF'
feat(container): add evals container wrapper

Adds the host-side Docker wrapper for the quorum workspace container. The
wrapper owns the stable image tag, deterministic container name, bind mounts,
read-only credential mounts, and direct `exec quorum ...` command shape.

The tests exercise the wrapper through a fake Docker executable so static gates
can validate mount and argument behavior without requiring a local Docker daemon.
EOF
```

## Task 4: Add the Quorum Shim and Version Report

**Files:**

- Create: `container/bin/quorum`
- Create: `container/bin/evals-tool-versions`
- Create: `test/container-shims.test.ts`

**Quorum shim behavior:**

- `cd /workspace/evals`
- Source `/run/evals/credentials.env` if present.
- Export:
  - `SUPERPOWERS_ROOT=/workspace/superpowers`
  - `CODEX_AUTH_HOME=/auth/codex` when `/auth/codex` exists
  - `GEMINI_OAUTH_HOME=/auth/gemini` when `/auth/gemini` exists
  - `AGY_OAUTH_HOME=/auth/gemini` when `/auth/gemini` exists
  - `KIMI_OAUTH_HOME=/auth/kimi-code` when `/auth/kimi-code` exists
  - `PI_OAUTH_HOME=/auth/pi` when `/auth/pi` exists
- Exec `bun run src/cli/index.ts "$@"`.

Use Bash's export-all mode only around the credential source:

```bash
set -a
# shellcheck disable=SC1091
source /run/evals/credentials.env
set +a
```

Do not print the credential file or any values.

**Version report behavior:** print versions for core tools and agent CLIs, but never fail the whole report because one optional agent is missing. This script is diagnostic, not a gate.

Core commands to report:

```text
bash
zsh
git
gh
node
npm
bun
python3
uv
go
rustc
cargo
ruby
mise
quorum
```

Agent commands to report where present:

```text
claude
codex
gemini
opencode
pi
copilot
droid
qodercli
qwen
kilo
openclaw
amp
auggie
cn
cline
cursor-agent
aider
goose
agy
kimi
```

- [ ] Test with `bash -n` for both scripts.
- [ ] Add minimal contract assertions that `container/bin/quorum` references `/run/evals/credentials.env`, exports `SUPERPOWERS_ROOT=/workspace/superpowers`, exports the five auth source variables above, and execs `bun run src/cli/index.ts`.
- [ ] Run:

```bash
bash -n container/bin/quorum container/bin/evals-tool-versions
bun test test/container-shims.test.ts
```

- [ ] Commit:

```bash
git add container/bin/quorum container/bin/evals-tool-versions test/container-shims.test.ts
git commit -F - <<'EOF'
feat(container): add quorum runtime shims

Adds the in-container quorum launcher and tool version report. The launcher is
the only place that sources the read-only credential dotenv file, then exports
the explicit auth-source variables used by the existing quorum adapters.
EOF
```

## Task 5: Add the Rich Ubuntu 26.04 Dockerfile

**Files:**

- Create: `container/Dockerfile`

**Base:**

```dockerfile
FROM mcr.microsoft.com/devcontainers/base:ubuntu-26.04
```

**System packages:** install with `apt-get` and `--no-install-recommends`:

```text
bash
zsh
git
gh
curl
wget
ca-certificates
jq
yq
ripgrep
fd-find
tmux
less
unzip
zip
xz-utils
build-essential
pkg-config
libssl-dev
libsqlite3-dev
zlib1g-dev
libbz2-dev
libreadline-dev
libffi-dev
liblzma-dev
python3
python3-pip
python3-venv
ruby-full
golang-go
```

Add `/usr/local/bin/fd` symlink to `fdfind` when Ubuntu installs the binary under the Debian name.

**Toolchains and package managers:**

- Install Node LTS from NodeSource or the devcontainer-supported apt source already present in the base image. Verify `node --version` and `npm --version`.
- Install Bun with the official installer into `/usr/local/bun`, then symlink `bun` into `/usr/local/bin`.
- Install `uv` with Astral's installer into `/usr/local/bin`.
- Install Rust through `rustup` into `/usr/local/rustup` and `/usr/local/cargo`, then expose `rustc` and `cargo` on PATH.
- Install `mise` with its release installer into `/usr/local/bin`.

**Agent CLIs to install from npm:**

```text
opencode-ai
@factory/cli
@github/copilot
@google/gemini-cli
@kilocode/cli
@openai/codex
@anthropic-ai/claude-code
@qoder-ai/qodercli
@qwen-code/qwen-code
@mariozechner/pi-coding-agent
openclaw
@sourcegraph/amp
@augmentcode/auggie
@continuedev/cli
cline
```

**Agent CLIs to install outside npm:**

- Cursor CLI: use the official `https://cursor.com/install` script with `HOME=/opt/cursor-agent`, then symlink the installed `cursor-agent` binary to `/usr/local/bin/cursor-agent`.
- Aider: install `aider-chat` with `uv tool install --tool-dir /opt/uv-tools --python 3.12 aider-chat`, then symlink `/opt/uv-tools/aider` to `/usr/local/bin/aider`.
- Goose: install pinned `.deb` `https://github.com/aaif-goose/goose/releases/download/v1.31.1/goose_1.31.1_amd64.deb`.

**Do not install:**

- Cursor desktop `.deb`
- Kiro `.deb`
- Trae `.deb`
- Antigravity desktop `.deb`
- Xvfb/VNC/noVNC packages

**Copy scripts:**

```dockerfile
COPY container/bin/quorum /usr/local/bin/quorum
COPY container/bin/evals-tool-versions /usr/local/bin/evals-tool-versions
RUN chmod +x /usr/local/bin/quorum /usr/local/bin/evals-tool-versions
WORKDIR /workspace/evals
CMD ["sleep", "infinity"]
```

- [ ] Run a syntax/build smoke:

```bash
docker build --progress=plain -t superpowers-evals:local -f container/Dockerfile .
```

- [ ] If the build fails because an external installer moved or a package name changed, root-cause the specific failing install. Do not remove the agent from the image just to get a green build; either fix the installer or explicitly document that the current upstream has no non-interactive Linux install path.
- [ ] Commit:

```bash
git add container/Dockerfile
git commit -F - <<'EOF'
feat(container): add rich evals Dockerfile

Adds the Ubuntu 26.04 devcontainer-style image for quorum evals. The image
includes broad implementation toolchains plus the current known headless coding
agent CLIs from quorum and the earlier harness install catalog.

Desktop IDE packages and VNC/X11 support remain intentionally out of scope.
EOF
```

## Task 6: Wire Container Build and Runtime Verification

**Files:**

- Modify: `test/evals-container.test.ts` if wrapper behavior needs adjustment from the real Dockerfile.
- Modify: `scripts/evals-container` only for real-runtime fixes found by this task.

- [ ] Run:

```bash
scripts/evals-container build
scripts/evals-container up
scripts/evals-container status
scripts/evals-container exec bash -lc 'pwd && test "$(pwd)" = /workspace/evals'
scripts/evals-container exec bash -lc 'test -w /workspace/evals/results'
scripts/evals-container exec bash -lc 'test -d /workspace/superpowers'
scripts/evals-container exec quorum list
scripts/evals-container exec quorum check
scripts/evals-container exec quorum show --help
scripts/evals-container exec evals-tool-versions
```

- [ ] Expected:
  - `quorum list` prints scenarios.
  - `quorum check` validates scenarios.
  - `quorum show --help` exits 0.
  - `evals-tool-versions` prints versions and marks missing optional CLIs without exiting nonzero.
  - Results write probe succeeds at `/workspace/evals/results`.
- [ ] Verify raw shell commands do not receive sourced credentials automatically:

```bash
tmp_env="$(mktemp)"
printf 'QUORUM_CONTAINER_SECRET_PROBE=present\n' > "$tmp_env"
scripts/evals-container down || true
scripts/evals-container --env-file "$tmp_env" up
scripts/evals-container exec bash -lc 'test -z "${QUORUM_CONTAINER_SECRET_PROBE:-}"'
scripts/evals-container exec quorum list >/tmp/quorum-container-secret-probe.out
```

The final `quorum list` should still work. The shell probe should prove raw `exec bash ...` does not inherit the sourced dotenv file.

- [ ] Verify the credential file is mounted read-only:

```bash
scripts/evals-container exec bash -lc 'if [ -e /run/evals/credentials.env ]; then ! test -w /run/evals/credentials.env; fi'
```

- [ ] Commit any fixes:

```bash
git add scripts/evals-container test/evals-container.test.ts
git commit -F - <<'EOF'
fix(container): align wrapper with real Docker runtime

Adjusts the wrapper based on the first real container build/up verification,
while preserving the same bind-mounted results and read-only credential model.
EOF
```

Skip this commit if no files changed.

## Task 7: Add Terse Operator Docs

**Files:**

- Modify: `README.md` or the closest existing operator doc.

Add a short section with only the commands operators need:

```bash
scripts/evals-container build
scripts/evals-container up
scripts/evals-container exec quorum list
scripts/evals-container exec quorum check
scripts/evals-container exec quorum run scenarios/<name> --coding-agent <agent>
scripts/evals-container exec quorum run-all --coding-agents codex --jobs 1
scripts/evals-container down
```

Mention:

- Evals mounts at `/workspace/evals`.
- Superpowers mounts at `/workspace/superpowers`.
- Results land in host-visible `results/`.
- Optional credentials come from `.env.container` or `--env-file <path>`.
- Auth sources can be overridden with `--auth name=path`.
- Dashboard stays host-side.
- Docker socket is intentionally not mounted.

- [ ] Run:

```bash
bun run check
bun run quorum check
```

- [ ] Commit:

```bash
git add README.md
git commit -F - <<'EOF'
docs(container): document evals container workflow

Documents the Docker wrapper commands, mount layout, credential inputs, and the
intentional non-goals for dashboard and Docker socket support.
EOF
```

## Task 8: Final Static and Container Gates

- [ ] Run static gates:

```bash
bun run check
bun run quorum check
```

- [ ] Run container gates:

```bash
scripts/evals-container build
scripts/evals-container up
scripts/evals-container status
scripts/evals-container exec quorum list
scripts/evals-container exec quorum check
scripts/evals-container exec bash -lc 'test -w /workspace/evals/results'
scripts/evals-container exec quorum show --help
```

- [ ] Do not run a live agent eval unless Jesse explicitly asks. A live smoke needs real credentials and can capture sensitive artifacts.
- [ ] If Jesse asks for a live smoke, use one cheap scenario and one explicitly credentialed agent, then confirm the run directory exists under host `results/` with:

```bash
find results -maxdepth 2 -name verdict.json | tail -n 5
```

- [ ] Commit final verification-only fixes if any.

## Self-Review Checklist

- [ ] Spec coverage: wrapper commands, bind mounts, results path, read-only dotenv mount, read-only auth mounts, `quorum` shim, rich Ubuntu 26.04 image, no dashboard, no Docker socket, no devcontainer metadata, no desktop IDE stack.
- [ ] Marker scan:

```bash
rg -n "TO[D]O|FIX[M]E|TB[D]|[P]LACEHOLDER" container scripts test README.md docs/superpowers/specs/2026-06-15-container-runtime-design.md
```

Every hit must be either pre-existing or intentionally user-facing.

- [ ] Runtime secret check: raw `exec bash ...` does not see env-file secrets; `exec quorum ...` does.
- [ ] Artifact check: any quorum run evidence lands under host-visible `results/`, not only inside container-local state.
- [ ] Git check:

```bash
git status --short --branch
git log --oneline origin/main..HEAD
```

Expected: only container runtime design/plan/implementation commits on this branch.
