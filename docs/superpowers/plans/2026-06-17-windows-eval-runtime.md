# Windows Eval Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a quorum scenario with the Coding-Agent (Claude) executing natively on a dockur Windows 11 guest, driven over SSH, while keeping quorum's verdict/capture/check layers unchanged.

**Architecture:** Linux orchestrates; Windows executes. gauntlet's existing tmux `tui` adapter drives native-Windows Claude because the per-agent launcher shim is a Linux bash script that `ssh -tt`'s into the guest. A Windows run reproduces the *local* artifact layout (`<run>/home/.claude/projects/**`, `<run>/coding-agent-workdir/**`) by pushing the built workdir to Windows before the drive and scp'ing logs + workdir back after it, so capture/normalize/checks run unchanged on Linux.

**Tech Stack:** Bash, dockur/windows (QEMU/KVM), OpenSSH + sshpass, Bun/TypeScript (Zod, existing quorum CLI + `CommandRunner` seam), Biome, `bun test`.

**Spec:** `docs/superpowers/specs/2026-06-17-windows-eval-runtime-design.md`

## Global Constraints

Copied verbatim from the spec; every task inherits these.

- **Linux + `/dev/kvm` only.** dockur cannot run on macOS/Apple-Silicon Docker. Never hard-code one machine: host, SSH port, credentials, container name, and VM directory are configurable via flags/env.
- **SSH mux must be disabled on every connection to the guest:** `-o ControlMaster=no -o ControlPath=none -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`. (Without this, a host with `ControlMaster auto` silently runs the command on the host, not the guest.)
- **No gauntlet changes.** The `tui` adapter is used as-is.
- **No harness execution inside Windows** (no Bun/gauntlet/tmux in the guest).
- **No `\\host.lan\Data` shared folder.** SSH/scp is the only channel.
- **superpowers loads via `--plugin-dir`,** never the marketplace.
- **Auth is `ANTHROPIC_API_KEY`,** read through `getEnv` (the sanctioned env module), never the operator's OAuth, never committed.
- **Reproduce the local artifact layout.** Do not add an alternate results/verdict layout.
- **`checks.sh` must not have the executable bit set** (existing repo convention).
- v1 wires only `claude-windows`; the remote seam is built general but no second agent is implemented.

## Connection + path conventions (used throughout)

- Per-run Windows root: `C:\eval-runs\<runId>` where `<runId>` is `basename(runDir)` (already unique: `<scenario>-<agent>-<stamp>-<nonce>`). Subdirs: `\home` (HOME/USERPROFILE), `\workdir` (the agent's project), `\launch.cmd` (the Windows launch script).
- superpowers cache on the guest: `C:\eval-superpowers` (rsync target, refreshed only when changed).
- Default connection: host `127.0.0.1` (or `WIN_EVAL_HOST`), port `2222` (`WIN_EVAL_PORT`), user `user` (`WIN_EVAL_USER`), password `password` (`WIN_EVAL_PASSWORD`), container `windows11` (`WIN_EVAL_CONTAINER`), VM dir `~/windows-vm` (`WIN_EVAL_VM_DIR`).
- SSH prefix (call it `WIN_SSH` in prose):
  `sshpass -p "$WIN_EVAL_PASSWORD" ssh -tt -o ControlMaster=no -o ControlPath=none -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p "$WIN_EVAL_PORT" "$WIN_EVAL_USER@$WIN_EVAL_HOST"`

## File Structure

Create:
- `coding-agents/claude-windows.yaml` — Windows Claude agent config (adds a `remote` block).
- `coding-agents/claude-windows-context/launch-agent` — Linux bash launcher that `ssh -tt`'s into the guest and runs the per-run `launch.cmd`.
- `coding-agents/claude-windows-context/HOWTO.md` — Windows driving guide for the QA agent.
- `src/agents/windows-host.ts` — agent-neutral remote-host seam (`ssh`/`scpFrom`/`scpTo`/`rsyncTo`) over `CommandRunner`.
- `src/agents/claude-windows.ts` — `WindowsClaudeAgent` provisioning adapter + the `RemoteExecution` (pushWorkdir/captureBack) helper.
- `scripts/evals-windows-vm` — dockur VM lifecycle wrapper.
- `test/windows-host.test.ts`, `test/claude-windows-agent.test.ts`, `test/evals-windows-vm.test.ts`, `test/claude-windows-shims.test.ts` — unit tests with fakes (no live VM).
- `docs/windows/eval-runtime.md` — operator guide.

Modify:
- `src/contracts/agent-config.ts` — add the optional `remote` block to `AgentConfigSchema`.
- `src/agents/index.ts` — `resolveAgent` returns `WindowsClaudeAgent` when `cfg.remote` is present.
- `src/runner/index.ts` — two `remote`-gated call sites: push workdir (after `runSetup`, before drive) and capture-back (after `invokeGauntlet`, before `captureToolCallsWithRetry`); plus the Windows-path substitutions into the launcher.

---

## Task 1: Agent config `remote` block + `claude-windows.yaml` + agent selection

**Files:**
- Modify: `src/contracts/agent-config.ts:21-42` (schema)
- Modify: `src/agents/index.ts:198-208` (`resolveAgent`)
- Create: `coding-agents/claude-windows.yaml`
- Test: `test/agent-config.test.ts` (create if absent; else append)

**Interfaces:**
- Produces: `RemoteConfig` (zod) on `AgentConfig.remote?`, fields `host/port/user/password_env/win_run_root/win_superpowers_dir`. `resolveAgent(cfg)` returns a `WindowsClaudeAgent` (Task 5) when `cfg.remote !== undefined`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test** in `test/agent-config.test.ts`

```ts
import { describe, expect, test } from 'bun:test';
import { AgentConfigSchema } from '../src/contracts/agent-config.ts';

describe('AgentConfigSchema remote block', () => {
  test('parses a remote block with defaults', () => {
    const cfg = AgentConfigSchema.parse({
      name: 'claude-windows',
      runtime_family: 'claude',
      binary: 'claude',
      session_log_dir: '${QUORUM_AGENT_HOME}/.claude/projects',
      session_log_glob: '**/*.jsonl',
      normalizer: 'claude',
      home_config_subdir: '.claude',
      model: 'opus',
      remote: { password_env: 'WIN_EVAL_PASSWORD' },
    });
    expect(cfg.remote?.port).toBe(2222);
    expect(cfg.remote?.win_run_root).toBe('C:\\eval-runs');
  });

  test('absent remote block is undefined', () => {
    const cfg = AgentConfigSchema.parse({
      name: 'claude', binary: 'claude',
      session_log_dir: 'x', session_log_glob: 'y',
      normalizer: 'claude', home_config_subdir: '.claude',
    });
    expect(cfg.remote).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `bun test test/agent-config.test.ts` → FAIL (`remote` stripped / unknown).

- [ ] **Step 3: Add the schema** in `src/contracts/agent-config.ts`, immediately before `export const AgentConfigSchema`:

```ts
// Remote-execution block: present only for runtimes that run the Coding-Agent on
// another host over SSH (the Windows runtime). Its presence is what selects the
// remote provisioning/launcher/capture path; absence keeps the local model.
export const RemoteConfigSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).default(2222),
  user: z.string().default('user'),
  // Name of the env var holding the guest SSH password (read via getEnv at run
  // time, never stored in the config). The dockur default is 'password'.
  password_env: z.string().default('WIN_EVAL_PASSWORD'),
  // Windows-side roots (backslash paths). Per-run dir = <win_run_root>\<runId>.
  win_run_root: z.string().default('C:\\eval-runs'),
  win_superpowers_dir: z.string().default('C:\\eval-superpowers'),
});
export type RemoteConfig = z.infer<typeof RemoteConfigSchema>;
```

Then add one field inside the `AgentConfigSchema` object (after `launch_spacing_seconds`):

```ts
  remote: RemoteConfigSchema.optional(),
```

- [ ] **Step 4: Wire `resolveAgent`** in `src/agents/index.ts`. Add the import at the top with the other agent imports:

```ts
import { WindowsClaudeAgent } from './claude-windows.ts';
```

Change the body of `resolveAgent` so the remote block wins first:

```ts
export function resolveAgent(config: AgentConfig): CodingAgent {
  if (config.remote !== undefined) {
    return new WindowsClaudeAgent(config);
  }
  const name = config.runtime_family ?? config.name;
  if (name === 'claude') {
    return new ClaudeAgent(config);
  }
  const factory = CUSTOM_AGENTS[name];
  if (factory !== undefined) {
    return factory(config);
  }
  return new DefaultAgent(config);
}
```

(`WindowsClaudeAgent` lands in Task 5. To keep Task 1 compiling on its own, temporarily add a minimal stub class in `src/agents/claude-windows.ts` — `export class WindowsClaudeAgent { constructor(public config: AgentConfig){} provision(){return {};} }` — Task 5 replaces it.)

- [ ] **Step 5: Add `coding-agents/claude-windows.yaml`**

```yaml
name: claude-windows
runtime_family: claude
binary: claude
home_config_subdir: ".claude"
# After capture-back, logs land in the SAME local path a Linux run uses.
session_log_dir: "${QUORUM_AGENT_HOME}/.claude/projects"
session_log_glob: "**/*.jsonl"
normalizer: claude
required_env:
  - ANTHROPIC_API_KEY
  - SUPERPOWERS_ROOT
  - WIN_EVAL_PASSWORD
max_time: 15m
project_prompt: claude.project-prompt.md
model: opus
# coding-agents: claude-windows
remote:
  password_env: WIN_EVAL_PASSWORD
```

- [ ] **Step 6: Run tests, expect PASS** — `bun test test/agent-config.test.ts` → PASS. Then `bun run typecheck`.

- [ ] **Step 7: Commit**

```bash
git add src/contracts/agent-config.ts src/agents/index.ts src/agents/claude-windows.ts coding-agents/claude-windows.yaml test/agent-config.test.ts
git commit -m "feat(windows): add remote agent-config block + claude-windows config"
```

---

## Task 2: Remote-host seam (`src/agents/windows-host.ts`)

**Files:**
- Create: `src/agents/windows-host.ts`
- Test: `test/windows-host.test.ts`

**Interfaces:**
- Consumes: `CommandRunner` from `./command-runner.ts`; `RemoteConfig` from `../contracts/agent-config.ts`; `getEnv` from `../env.ts`.
- Produces: `class WindowsHost { constructor(remote: RemoteConfig, runner: CommandRunner); ssh(remoteCmd: string): CommandResult; scpFrom(winPath: string, localDir: string): CommandResult; scpTo(localPath: string, winPath: string): CommandResult; rsyncTo(localDir: string, winDir: string): CommandResult; }`. Each method must include the mux-off flags. `ssh`/`scp` use `sshpass -p <password>`; the password is read via `getEnv(remote.password_env)`.

- [ ] **Step 1: Write the failing test** in `test/windows-host.test.ts`

```ts
import { describe, expect, test } from 'bun:test';
import type { CommandResult, CommandRunner } from '../src/agents/command-runner.ts';
import { RemoteConfigSchema } from '../src/contracts/agent-config.ts';
import { WindowsHost } from '../src/agents/windows-host.ts';

class FakeRunner implements CommandRunner {
  calls: { command: string; args: string[] }[] = [];
  run(command: string, args: readonly string[]): CommandResult {
    this.calls.push({ command, args: [...args] });
    return { status: 0, stdout: '', stderr: '' };
  }
}

const remote = RemoteConfigSchema.parse({ password_env: 'WIN_EVAL_PASSWORD' });

describe('WindowsHost', () => {
  test('ssh disables mux and runs the remote command', () => {
    process.env.WIN_EVAL_PASSWORD = 'password';
    const r = new FakeRunner();
    new WindowsHost(remote, r).ssh('whoami');
    const { command, args } = r.calls[0];
    expect(command).toBe('sshpass');
    expect(args).toContain('-p');
    expect(args).toContain('password');
    expect(args.join(' ')).toContain('ssh -tt');
    expect(args).toContain('ControlMaster=no');
    expect(args).toContain('ControlPath=none');
    expect(args).toContain('user@127.0.0.1');
    expect(args[args.length - 1]).toBe('whoami');
  });

  test('scpFrom pulls a guest path to a local dir, mux off', () => {
    process.env.WIN_EVAL_PASSWORD = 'password';
    const r = new FakeRunner();
    new WindowsHost(remote, r).scpFrom('C:\\eval-runs\\x\\workdir', '/tmp/out');
    const { command, args } = r.calls[0];
    expect(command).toBe('sshpass');
    expect(args).toContain('scp');
    expect(args).toContain('-r');
    expect(args).toContain('ControlMaster=no');
    expect(args.join(' ')).toContain('user@127.0.0.1:');
    expect(args[args.length - 1]).toBe('/tmp/out');
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `bun test test/windows-host.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/agents/windows-host.ts`**

```ts
import type { RemoteConfig } from '../contracts/agent-config.ts';
import { getEnv } from '../env.ts';
import type { CommandResult, CommandRunner } from './command-runner.ts';

// Shared OpenSSH options. ControlMaster/ControlPath MUST be off: a host with
// `ControlMaster auto` otherwise multiplexes the connection back onto itself and
// runs the command on the host instead of the guest (observed on magic-kingdom).
const MUX_OFF = [
  '-o', 'ControlMaster=no',
  '-o', 'ControlPath=none',
  '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=/dev/null',
];

// Agent-neutral SSH/scp/rsync seam into a Windows guest, over the injectable
// CommandRunner so tests assert exact argv with a fake. A future non-Claude
// Windows agent reuses this unchanged.
export class WindowsHost {
  constructor(
    private readonly remote: RemoteConfig,
    private readonly runner: CommandRunner,
  ) {}

  private password(): string {
    const pw = getEnv(this.remote.password_env);
    if (pw === undefined || pw === '') {
      throw new Error(`guest SSH password env ${this.remote.password_env} not set`);
    }
    return pw;
  }

  private target(): string {
    return `${this.remote.user}@${this.remote.host}`;
  }

  ssh(remoteCmd: string): CommandResult {
    const args = [
      '-p', this.password(),
      'ssh', '-tt', ...MUX_OFF,
      '-p', String(this.remote.port),
      this.target(),
      remoteCmd,
    ];
    return this.runner.run('sshpass', args);
  }

  scpFrom(winPath: string, localDir: string): CommandResult {
    const args = [
      '-p', this.password(),
      'scp', '-r', ...MUX_OFF,
      '-P', String(this.remote.port),
      `${this.target()}:${winPath}`,
      localDir,
    ];
    return this.runner.run('sshpass', args);
  }

  scpTo(localPath: string, winPath: string): CommandResult {
    const args = [
      '-p', this.password(),
      'scp', '-r', ...MUX_OFF,
      '-P', String(this.remote.port),
      localPath,
      `${this.target()}:${winPath}`,
    ];
    return this.runner.run('sshpass', args);
  }

  // rsync over the same mux-off ssh. Used for the cached superpowers checkout.
  rsyncTo(localDir: string, winDir: string): CommandResult {
    const sshCmd = `sshpass -p ${this.password()} ssh -tt ${MUX_OFF.join(' ')} -p ${this.remote.port}`;
    const args = ['-a', '--delete', '-e', sshCmd, `${localDir}/`, `${this.target()}:${winDir}`];
    return this.runner.run('rsync', args);
  }
}
```

- [ ] **Step 4: Run tests, expect PASS** — `bun test test/windows-host.test.ts` → PASS. `bun run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/agents/windows-host.ts test/windows-host.test.ts
git commit -m "feat(windows): add WindowsHost ssh/scp/rsync seam"
```

---

## Task 3: `scripts/evals-windows-vm` VM lifecycle wrapper

**Files:**
- Create: `scripts/evals-windows-vm`
- Test: `test/evals-windows-vm.test.ts`

**Interfaces:**
- Produces a CLI: `up | down | status | ssh [cmd...] | sync-superpowers`. Reads `WIN_EVAL_*` env (see conventions). `up` runs `docker start <container>` (or fails clearly if the container is missing — creation stays the documented `windows-vm` skill recipe), then polls guest sshd with mux-off ssh. `ssh` runs one mux-off command on the guest. `sync-superpowers` rsyncs `$SUPERPOWERS_ROOT` → `WIN_EVAL_SUPERPOWERS_DIR` (default `C:\eval-superpowers`).

- [ ] **Step 1: Write the failing test** in `test/evals-windows-vm.test.ts` (fake `docker`/`sshpass`/`rsync` on PATH, mirroring `test/evals-container.test.ts`'s fake-executable approach)

```ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function fakeBinDir(): { dir: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'winvm-'));
  const log = join(dir, 'calls.log');
  for (const name of ['docker', 'sshpass', 'rsync']) {
    const p = join(dir, name);
    writeFileSync(p, `#!/usr/bin/env bash\nprintf '%s %s\\n' "${name}" "$*" >> "${log}"\nexit 0\n`);
    chmodSync(p, 0o755);
  }
  return { dir, log };
}

const script = join(import.meta.dir, '..', 'scripts', 'evals-windows-vm');

function run(args: string[], bin: string, log: string) {
  return spawnSync('bash', [script, ...args], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
           WIN_EVAL_CONTAINER: 'windows11', WIN_EVAL_PASSWORD: 'password',
           EVALS_WINVM_CALL_LOG: log },
    encoding: 'utf8',
  });
}

describe('evals-windows-vm', () => {
  test('status calls docker inspect on the configured container', () => {
    const { dir, log } = fakeBinDir();
    const res = run(['status'], dir, log);
    expect(res.status).toBe(0);
    expect(readFileSync(log, 'utf8')).toContain('docker container inspect windows11');
  });

  test('ssh issues a mux-off ssh to the guest', () => {
    const { dir, log } = fakeBinDir();
    run(['ssh', 'whoami'], dir, log);
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain('sshpass');
    expect(calls).toContain('ControlMaster=no');
    expect(calls).toContain('whoami');
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `bun test test/evals-windows-vm.test.ts` → FAIL (script missing).

- [ ] **Step 3: Implement `scripts/evals-windows-vm`** (do NOT set +x via git on test fixtures; the script itself is executable)

```bash
#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
usage: scripts/evals-windows-vm <up|down|status|ssh|sync-superpowers> [args...]

env (all optional, with defaults):
  WIN_EVAL_CONTAINER  (windows11)   docker container name
  WIN_EVAL_HOST       (127.0.0.1)   ssh host
  WIN_EVAL_PORT       (2222)        ssh port
  WIN_EVAL_USER       (user)        ssh user
  WIN_EVAL_PASSWORD   (password)    ssh password
  WIN_EVAL_SUPERPOWERS_DIR (C:\eval-superpowers)  guest superpowers cache
  SUPERPOWERS_ROOT                  source checkout (sync-superpowers only)
USAGE
}

die() { printf 'evals-windows-vm: %s\n' "$*" >&2; exit 1; }

container=${WIN_EVAL_CONTAINER:-windows11}
host=${WIN_EVAL_HOST:-127.0.0.1}
port=${WIN_EVAL_PORT:-2222}
user=${WIN_EVAL_USER:-user}
password=${WIN_EVAL_PASSWORD:-password}
win_sp_dir=${WIN_EVAL_SUPERPOWERS_DIR:-C:\\eval-superpowers}

mux=(-o ControlMaster=no -o ControlPath=none -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null)

guest_ssh() { sshpass -p "$password" ssh -tt "${mux[@]}" -p "$port" "$user@$host" "$@"; }

wait_for_sshd() {
  local i out
  for i in $(seq 1 48); do
    out=$(sshpass -p "$password" ssh "${mux[@]}" -o ConnectTimeout=4 -p "$port" "$user@$host" "echo READY" 2>/dev/null || true)
    [[ "$out" == READY ]] && { echo "guest sshd up"; return 0; }
    sleep 5
  done
  die "guest sshd did not answer on $host:$port after ~4min"
}

cmd=${1:-}; shift || true
case "$cmd" in
  up)
    docker container inspect "$container" >/dev/null 2>&1 || die "container $container missing; create it with the windows-vm skill recipe"
    docker start "$container" >/dev/null
    wait_for_sshd
    ;;
  down)   docker stop "$container" >/dev/null && echo "$container stopped" ;;
  status)
    if docker container inspect "$container" >/dev/null 2>&1; then
      running=$(docker container inspect -f '{{.State.Running}}' "$container")
      echo "$container: exists, running=$running"
    else
      echo "$container: missing"
    fi
    ;;
  ssh)    guest_ssh "$@" ;;
  sync-superpowers)
    [[ -n "${SUPERPOWERS_ROOT:-}" ]] || die "SUPERPOWERS_ROOT not set"
    [[ -d "$SUPERPOWERS_ROOT" ]] || die "SUPERPOWERS_ROOT not a dir: $SUPERPOWERS_ROOT"
    rsync -a --delete -e "sshpass -p $password ssh ${mux[*]} -p $port" "$SUPERPOWERS_ROOT/" "$user@$host:$win_sp_dir"
    ;;
  ''|-h|--help) usage ;;
  *) usage >&2; die "unknown command: $cmd" ;;
esac
```

- [ ] **Step 4: chmod + syntax check + tests**

```bash
chmod +x scripts/evals-windows-vm
bash -n scripts/evals-windows-vm
bun test test/evals-windows-vm.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/evals-windows-vm test/evals-windows-vm.test.ts
git commit -m "feat(windows): add evals-windows-vm lifecycle wrapper"
```

---

## Task 4: Windows launcher shim + HOWTO + substitution contract

**Files:**
- Create: `coding-agents/claude-windows-context/launch-agent`
- Create: `coding-agents/claude-windows-context/HOWTO.md`
- Test: `test/claude-windows-shims.test.ts`

**Interfaces:**
- Consumes (substitutions burned in by `populateContextDir` at run time, supplied by Task 5/6): `$WIN_SSH_PASSWORD`, `$WIN_SSH_PORT`, `$WIN_SSH_USER`, `$WIN_SSH_HOST`, `$WIN_LAUNCH_CMD` (guest path to the per-run `launch.cmd`), `$QUORUM_LAUNCH_AGENT`.
- Produces: a one-token launch contract identical in shape to the Linux claude HOWTO — the QA agent types `"$QUORUM_LAUNCH_AGENT"`.

- [ ] **Step 1: Write the failing contract test** in `test/claude-windows-shims.test.ts`

```ts
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ctx = join(import.meta.dir, '..', 'coding-agents', 'claude-windows-context');

describe('claude-windows launcher', () => {
  const launcher = readFileSync(join(ctx, 'launch-agent'), 'utf8');

  test('execs a mux-off ssh -tt into the guest and runs the win launch cmd', () => {
    expect(launcher).toContain('ssh -tt');
    expect(launcher).toContain('ControlMaster=no');
    expect(launcher).toContain('ControlPath=none');
    expect(launcher).toContain('$WIN_LAUNCH_CMD');
    expect(launcher.startsWith('#!/usr/bin/env bash')).toBe(true);
  });

  test('HOWTO tells the QA agent to type the one launch token', () => {
    const howto = readFileSync(join(ctx, 'HOWTO.md'), 'utf8');
    expect(howto).toContain('"$QUORUM_LAUNCH_AGENT"');
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `bun test test/claude-windows-shims.test.ts` → FAIL (files missing).

- [ ] **Step 3: Create `coding-agents/claude-windows-context/launch-agent`**

```bash
#!/usr/bin/env bash
# quorum-generated launcher for Claude Code running on a Windows guest.
#
# It SSHes (mux OFF — a ControlMaster host would otherwise run this on the host,
# not the guest) into the Windows VM with a real PTY (ssh -tt) and runs the
# per-run Windows launch script, which cds into the prepared workdir, pins
# HOME/USERPROFILE to the per-run throwaway home, exports ANTHROPIC_API_KEY, and
# starts Claude with --plugin-dir and --model. quorum substitutes the $… values
# below at runtime, so the installed copy contains literal connection values and
# the guest launch-cmd path.
#
# Equivalent manual command (for debugging):
#   sshpass -p "$WIN_SSH_PASSWORD" ssh -tt -o ControlMaster=no -o ControlPath=none \
#     -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
#     -p "$WIN_SSH_PORT" "$WIN_SSH_USER@$WIN_SSH_HOST" "$WIN_LAUNCH_CMD"
set -euo pipefail
exec sshpass -p "$WIN_SSH_PASSWORD" ssh -tt \
  -o ControlMaster=no -o ControlPath=none \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -p "$WIN_SSH_PORT" "$WIN_SSH_USER@$WIN_SSH_HOST" "$WIN_LAUNCH_CMD"
```

- [ ] **Step 4: Create `coding-agents/claude-windows-context/HOWTO.md`** (Windows variant of the Linux HOWTO — same one-token launch + watch-the-log shape; the log lives on the guest, reachable via the wrapper's `ssh`)

```markdown
# How to drive Claude Code on Windows (the agent under test)

You are driving Claude Code through a bash shell inside tmux on Linux. That
shell SSHes into a Windows VM where Claude Code actually runs. What appears on
screen is Claude's native-Windows session.

## Launch Claude with one command

Your bash starts in a scratch directory. quorum has generated a launcher that
SSHes into the Windows guest and starts Claude in the prepared workdir with a
per-run throwaway home, the plugin dir, model, and permission flag already set.
Type **this one line, verbatim** as your first action:

\`\`\`
"$QUORUM_LAUNCH_AGENT"
\`\`\`

Do NOT hand-type `claude` or reconstruct the line. The cd, auth, plugin-dir, and
flags all live inside the per-run Windows launch script the launcher runs.

## Observing what Claude is doing

Claude writes its session log as JSONL under the guest path
`$WIN_LOG_DIR\<derived>\<UUID>.jsonl`. The screen is a rendering that can lag.
The log is ground truth. quorum captures it back to Linux after the run; during
the run you can peek with a one-off SSH if needed, but prefer waiting on screen
progress over polling.

## Shutdown

Type `/exit` and press Enter to end the session cleanly.
```

- [ ] **Step 5: Run tests, expect PASS** — `bun test test/claude-windows-shims.test.ts` → PASS. (`launch-agent` keeps its `+x` after substitution because `populateContextDir` re-marks shebang files executable.)

- [ ] **Step 6: Commit**

```bash
git add coding-agents/claude-windows-context test/claude-windows-shims.test.ts
git commit -m "feat(windows): add claude-windows launcher shim + HOWTO"
```

---

## Task 5: `WindowsClaudeAgent` provisioning adapter

**Files:**
- Create/replace: `src/agents/claude-windows.ts` (replaces the Task 1 stub)
- Test: `test/claude-windows-agent.test.ts`

**Interfaces:**
- Consumes: `CodingAgent`, `RunHome`, `ProvisionError` from `./index.ts`; `WindowsHost` (Task 2); `agentConfigDir` (unused here); `getEnv`; `shellSingleQuote` from `./index.ts`.
- Produces: `class WindowsClaudeAgent implements CodingAgent { provision(home, runner): Record<string,string> }` that, over `WindowsHost`, (a) computes `<win_run_root>\<runId>` from `basename(home.workdir)`'s parent runId, (b) `ssh`-creates `\home`,`\workdir`, (c) seeds `\home\.claude\.claude.json` (trust + api-key approval), (d) writes `\launch.cmd`, (e) ensures `<win_superpowers_dir>` via `rsyncTo($SUPERPOWERS_ROOT)`, and returns the launcher substitutions `$WIN_SSH_*`, `$WIN_LAUNCH_CMD`. Also exposes the `RemoteExecution` helper consumed by Task 6: `pushWorkdir(home)` and `captureBack(home, runHomeDir)`.

- [ ] **Step 1: Write the failing test** in `test/claude-windows-agent.test.ts`

```ts
import { describe, expect, test, beforeEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandResult, CommandRunner } from '../src/agents/command-runner.ts';
import { loadAgentConfig } from '../src/contracts/agent-config.ts';
import { WindowsClaudeAgent } from '../src/agents/claude-windows.ts';

class FakeRunner implements CommandRunner {
  calls: { command: string; args: string[]; input?: string }[] = [];
  run(command: string, args: readonly string[], options?: { input?: string }): CommandResult {
    this.calls.push({ command, args: [...args], input: options?.input });
    return { status: 0, stdout: '', stderr: '' };
  }
}

describe('WindowsClaudeAgent.provision', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.WIN_EVAL_PASSWORD = 'password';
    process.env.SUPERPOWERS_ROOT = mkdtempSync(join(tmpdir(), 'sp-'));
  });

  test('creates the per-run guest tree and returns launcher substitutions', () => {
    const cfg = loadAgentConfig(join(import.meta.dir, '..', 'coding-agents'), 'claude-windows');
    const runDir = mkdtempSync(join(tmpdir(), 'myscenario-claude-windows-run-'));
    const runId = runDir.split('/').pop()!;
    const home = { configDir: join(runDir, 'home', '.claude'), workdir: join(runDir, 'coding-agent-workdir'), skeletonRoot: undefined };
    const runner = new FakeRunner();

    const subs = new WindowsClaudeAgent(cfg).provision(home, runner) as Record<string, string>;

    // mkdir of the per-run tree happened over ssh
    const sshCalls = runner.calls.filter((c) => c.command === 'sshpass' && c.args.includes('ssh'));
    expect(sshCalls.some((c) => c.args.join(' ').includes(`eval-runs\\${runId}`))).toBe(true);
    // rsync pushed superpowers to the cache
    expect(runner.calls.some((c) => c.command === 'rsync')).toBe(true);
    // launcher substitutions present
    expect(subs['$WIN_SSH_HOST']).toBe('127.0.0.1');
    expect(subs['$WIN_SSH_PORT']).toBe('2222');
    expect(subs['$WIN_LAUNCH_CMD']).toContain(`eval-runs\\${runId}\\launch.cmd`);
  });

  test('throws ProvisionError when ANTHROPIC_API_KEY is unset', () => {
    process.env.ANTHROPIC_API_KEY = '';
    const cfg = loadAgentConfig(join(import.meta.dir, '..', 'coding-agents'), 'claude-windows');
    const runDir = mkdtempSync(join(tmpdir(), 's-claude-windows-'));
    const home = { configDir: join(runDir, 'home', '.claude'), workdir: join(runDir, 'coding-agent-workdir'), skeletonRoot: undefined };
    expect(() => new WindowsClaudeAgent(cfg).provision(home, new FakeRunner())).toThrow();
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `bun test test/claude-windows-agent.test.ts` → FAIL (stub has no logic).

- [ ] **Step 3: Implement `src/agents/claude-windows.ts`**

```ts
import { basename, dirname } from 'node:path';
import type { AgentConfig, RemoteConfig } from '../contracts/agent-config.ts';
import { getEnv } from '../env.ts';
import type { CommandRunner } from './command-runner.ts';
import { ProvisionError, shellSingleQuote, type CodingAgent, type RunHome } from './index.ts';
import { WindowsHost } from './windows-host.ts';

// Join Windows path segments with backslashes (the guest is native Windows).
function winJoin(...parts: string[]): string {
  return parts.join('\\');
}

// Per-run Windows paths derived from the local runDir's basename (the runId).
function winPaths(remote: RemoteConfig, runId: string) {
  const runRoot = winJoin(remote.win_run_root, runId);
  return {
    runRoot,
    home: winJoin(runRoot, 'home'),
    workdir: winJoin(runRoot, 'workdir'),
    launchCmd: winJoin(runRoot, 'launch.cmd'),
    superpowers: remote.win_superpowers_dir,
  };
}

export class WindowsClaudeAgent implements CodingAgent {
  readonly config: AgentConfig;
  constructor(config: AgentConfig) {
    this.config = config;
  }

  private remote(): RemoteConfig {
    const r = this.config.remote;
    if (r === undefined) throw new ProvisionError('claude-windows config missing remote block');
    return r;
  }

  provision(home: RunHome, runner: CommandRunner): Record<string, string> {
    const remote = this.remote();
    const apiKey = getEnv('ANTHROPIC_API_KEY') ?? '';
    if (apiKey === '') throw new ProvisionError('ANTHROPIC_API_KEY not set; cannot provision Windows Claude');

    // runId = the local run dir name (parent of coding-agent-workdir).
    const runId = basename(dirname(home.workdir));
    const p = winPaths(remote, runId);
    const host = new WindowsHost(remote, runner);

    // 1. Fresh per-run guest tree.
    this.run(host, `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path '${p.home}\\.claude','${p.workdir}' | Out-Null"`);

    // 2. Seed .claude.json: trust the workdir + approve the API key fingerprint
    //    (same surface ClaudeAgent writes locally). Built as JSON on Linux and
    //    written to the guest via a here-string over ssh stdin-safe powershell.
    const claudeJson = JSON.stringify({
      projects: { [p.workdir]: {
        hasTrustDialogAccepted: true, projectOnboardingSeenCount: 1,
        hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true,
      } },
      customApiKeyResponses: { approved: [apiKey.slice(-20)], rejected: [] },
    });
    this.run(host, `powershell -NoProfile -Command "Set-Content -LiteralPath '${p.home}\\.claude\\.claude.json' -Value ${shellSingleQuote(claudeJson)} -Encoding utf8"`);

    // 3. Per-run launch.cmd: env + cd + claude. ANTHROPIC_API_KEY lives only on
    //    the guest (outside captured artifacts: capture pulls \workdir and
    //    \home\.claude\projects, not \launch.cmd).
    const launchCmd = [
      '@echo off',
      `set "HOME=${p.home}"`,
      `set "USERPROFILE=${p.home}"`,
      `set "ANTHROPIC_API_KEY=${apiKey}"`,
      'set "CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1"',
      `cd /d "${p.workdir}"`,
      `claude --dangerously-skip-permissions --plugin-dir "${p.superpowers}" --model ${this.config.model ?? 'opus'}`,
    ].join('\r\n');
    this.run(host, `powershell -NoProfile -Command "Set-Content -LiteralPath '${p.launchCmd}' -Value ${shellSingleQuote(launchCmd)} -Encoding ascii"`);

    // 4. Ensure the superpowers checkout is present on the guest (cached).
    const sp = getEnv('SUPERPOWERS_ROOT') ?? '';
    if (sp === '') throw new ProvisionError('SUPERPOWERS_ROOT not set');
    const rsync = host.rsyncTo(sp, p.superpowers);
    if (rsync.status !== 0) throw new ProvisionError(`superpowers rsync to guest failed: ${rsync.stderr}`);

    // 5. Launcher substitutions consumed by claude-windows-context/launch-agent.
    return {
      $WIN_SSH_PASSWORD: getEnv(remote.password_env) ?? '',
      $WIN_SSH_PORT: String(remote.port),
      $WIN_SSH_USER: remote.user,
      $WIN_SSH_HOST: remote.host,
      $WIN_LAUNCH_CMD: p.launchCmd,
      $WIN_LOG_DIR: winJoin(p.home, '.claude', 'projects'),
    };
  }

  private run(host: WindowsHost, cmd: string): void {
    const r = host.ssh(cmd);
    if (r.status !== 0) throw new ProvisionError(`guest command failed (${r.status}): ${cmd}\n${r.stderr}`);
  }
}

// Remote artifact movement, gated by the runner on cfg.remote (Task 6).
export class RemoteExecution {
  private readonly host: WindowsHost;
  constructor(private readonly remote: RemoteConfig, runner: CommandRunner) {
    this.host = new WindowsHost(remote, runner);
  }
  // After runSetup builds the local workdir, push it to the guest workdir.
  pushWorkdir(localWorkdir: string, runId: string): void {
    const p = winPaths(this.remote, runId);
    const r = this.host.scpTo(localWorkdir, p.runRoot); // lands as <runRoot>\workdir
    if (r.status !== 0) throw new Error(`push workdir to guest failed: ${r.stderr}`);
  }
  // After the drive, pull session logs + workdir back into the local run dir.
  captureBack(localRunHomeDir: string, localWorkdir: string, runId: string): void {
    const p = winPaths(this.remote, runId);
    this.host.scpFrom(winJoin(p.home, '.claude', 'projects'), `${localRunHomeDir}/.claude`);
    this.host.scpFrom(p.workdir, dirname(localWorkdir));
  }
}
```

- [ ] **Step 4: Run tests, expect PASS** — `bun test test/claude-windows-agent.test.ts` → PASS. `bun run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add src/agents/claude-windows.ts test/claude-windows-agent.test.ts
git commit -m "feat(windows): WindowsClaudeAgent provisioning + RemoteExecution"
```

---

## Task 6: Wire the two `remote`-gated runner hooks + substitutions

**Files:**
- Modify: `src/runner/index.ts` (three edits, all gated on `cfg.remote !== undefined`)
- Test: `test/runner-windows-hooks.test.ts`

**Interfaces:**
- Consumes: `RemoteExecution` (Task 5), `WindowsClaudeAgent.provision`'s substitutions (Task 5).
- Produces: at runtime, a Windows run pushes the workdir before drive, merges the `$WIN_*` substitutions into the launcher context, and captures artifacts back before `captureToolCallsWithRetry`.

- [ ] **Step 1: Add the substitutions merge.** In `src/runner/index.ts`, where per-agent substitutions are assembled (after the kimi block ~line 1176, before `populateContextDir` at ~1178), add:

```ts
  // Windows runtime: the WindowsClaudeAgent.provision return value carries the
  // $WIN_* launcher substitutions; merge them so the SSH launcher resolves.
  if (cfg.remote !== undefined) {
    Object.assign(substitutions, extraEnv);
  }
```
(`extraEnv` is already the provision() return value captured at line 1021.)

- [ ] **Step 2: Add the push-workdir hook.** Immediately after `runSetup(...)` (line ~1031) add:

```ts
  // Windows runtime: runSetup built the workdir locally; push it to the guest so
  // the SSH-launched agent works in it. (Local model: agent runs here, no push.)
  if (cfg.remote !== undefined) {
    new RemoteExecution(cfg.remote, defaultCommandRunner)
      .pushWorkdir(workdir, basename(runDir));
  }
```

- [ ] **Step 3: Add the capture-back hook.** After `invokeGauntlet(...)` resolves (the `{ gauntlet } = await invokeGauntlet(...)` at ~1223) and BEFORE `captureToolCallsWithRetry` (~1308) add:

```ts
  // Windows runtime: pull the guest's session logs + workdir into the local run
  // dir so the pre-run snapshot diff and post-checks see them (reproduce the
  // local artifact layout). Must precede the capture diff below.
  if (cfg.remote !== undefined) {
    new RemoteExecution(cfg.remote, defaultCommandRunner)
      .captureBack(runHomeDir, workdir, basename(runDir));
  }
```

Add the imports at the top of `src/runner/index.ts`:

```ts
import { basename } from 'node:path';
import { RemoteExecution } from '../agents/claude-windows.ts';
```
(If `basename` is already imported from `node:path`, extend the existing import instead of adding a duplicate.)

- [ ] **Step 4: Write a focused hook test** in `test/runner-windows-hooks.test.ts`. The full `runScenario` needs a live VM, so test the `RemoteExecution` ordering contract directly with a fake runner (the runner edits are exercised live in Phase 2):

```ts
import { describe, expect, test } from 'bun:test';
import type { CommandResult, CommandRunner } from '../src/agents/command-runner.ts';
import { RemoteConfigSchema } from '../src/contracts/agent-config.ts';
import { RemoteExecution } from '../src/agents/claude-windows.ts';

class FakeRunner implements CommandRunner {
  calls: string[] = [];
  run(command: string, args: readonly string[]): CommandResult {
    this.calls.push(`${command} ${args.join(' ')}`);
    return { status: 0, stdout: '', stderr: '' };
  }
}

const remote = RemoteConfigSchema.parse({ password_env: 'WIN_EVAL_PASSWORD' });

describe('RemoteExecution', () => {
  test('pushWorkdir scps local workdir to <runRoot> on the guest', () => {
    process.env.WIN_EVAL_PASSWORD = 'password';
    const r = new FakeRunner();
    new RemoteExecution(remote, r).pushWorkdir('/run/abc/coding-agent-workdir', 'abc');
    expect(r.calls[0]).toContain('scp');
    expect(r.calls[0]).toContain('coding-agent-workdir');
    expect(r.calls[0]).toContain('eval-runs\\abc');
  });

  test('captureBack pulls projects logs and workdir from the guest', () => {
    process.env.WIN_EVAL_PASSWORD = 'password';
    const r = new FakeRunner();
    new RemoteExecution(remote, r).captureBack('/run/abc/home', '/run/abc/coding-agent-workdir', 'abc');
    expect(r.calls.join('\n')).toContain('.claude\\projects');
    expect(r.calls.join('\n')).toContain('eval-runs\\abc\\workdir');
  });
});
```

- [ ] **Step 5: Run + verify** — `bun test test/runner-windows-hooks.test.ts` → PASS; `bun run typecheck`; `bun test` (full suite green — confirms the local path is untouched).

- [ ] **Step 6: Commit**

```bash
git add src/runner/index.ts test/runner-windows-hooks.test.ts
git commit -m "feat(windows): gate push-workdir + capture-back runner hooks on remote block"
```

---

## Task 7: Operator docs

**Files:**
- Create: `docs/windows/eval-runtime.md`
- Modify: `README.md` (one short pointer line under the container section)

- [ ] **Step 1: Write `docs/windows/eval-runtime.md`** — terse operator guide: the Linux+KVM-only constraint; bring the dockur VM up (point at the `windows-vm` skill recipe for first create); `export WIN_EVAL_PASSWORD=… ANTHROPIC_API_KEY=… SUPERPOWERS_ROOT=…`; `scripts/evals-windows-vm up`; `scripts/evals-windows-vm sync-superpowers`; `bun run quorum run scenarios/sdd-go-fractals-opus48 --coding-agent claude-windows`; where results land (`results/<run>/…`, same layout); the SSH-mux gotcha; that auth is API-key not OAuth. Keep it under ~40 lines; the spec is the detailed reference.

- [ ] **Step 2: Add a one-line pointer in `README.md`** near the existing container docs: "For evals against native Windows Claude, see `docs/windows/eval-runtime.md` (Linux+KVM hosts only)."

- [ ] **Step 3: Static gates + commit**

```bash
bun run check
bun run quorum check
git add docs/windows/eval-runtime.md README.md
git commit -m "docs(windows): document the Windows eval runtime"
```

---

## Task 8 (Phase 2): Live bring-up + resolve the four risks

**Prerequisite:** a Linux+KVM host with the dockur `windows11` container created (per the `windows-vm` skill) and reachable. This task is trusted-maintainer only; it uses real `ANTHROPIC_API_KEY` and captures live artifacts. Do not add it to CI.

- [ ] **Step 1: Bring up + sanity**

```bash
export WIN_EVAL_PASSWORD=password ANTHROPIC_API_KEY=… SUPERPOWERS_ROOT=/path/to/superpowers
scripts/evals-windows-vm up
scripts/evals-windows-vm status
scripts/evals-windows-vm sync-superpowers
scripts/evals-windows-vm ssh 'claude --version'
```
Expected: sshd up; superpowers rsynced; claude version prints.

- [ ] **Step 2: Resolve Risk #1 (HOME/USERPROFILE override).** Run a provisioned `launch.cmd` manually over `scripts/evals-windows-vm ssh` and confirm Claude writes its transcript under `<per-run-home>\.claude\projects\…`, not `C:\Users\user\.claude`. If only one of HOME/USERPROFILE is honored, the single fix is the `set` lines in `WindowsClaudeAgent`'s `launch.cmd` builder (Task 5, Step 3).

- [ ] **Step 3: Resolve Risk #2 (`--plugin-dir` + hooks).** Run the acceptance scenario:

```bash
bun run quorum run scenarios/sdd-go-fractals-opus48 --coding-agent claude-windows
bun run quorum show
```
Expected: a populated `results/<run>/home/.claude/projects/**` and `results/<run>/coding-agent-workdir/**` captured from the guest; a real `verdict.json`. **Success signal for the product claim:** the transcript shows a superpowers skill auto-triggering (e.g. `brainstorming` on a "make a react todo list" run), proving the bootstrap + `run-hook.cmd` fired on Windows.

- [ ] **Step 4: Risks #3/#4 are settled by Steps 1–3** (capture-back ordering produced non-empty capture; rsync succeeded). If capture comes back empty, claude is a strict-capture target → a loud `indeterminate(stage=capture)`, never a silent pass; debug the scp paths in `RemoteExecution.captureBack`.

- [ ] **Step 5: Record the campaign** in `docs/experiments/2026-06-17-windows-eval-bringup.md` per the experiment-log rule — hypotheses, the exact run dirs, verdicts, and any negative results at equal billing. Commit.

```bash
git add docs/experiments/2026-06-17-windows-eval-bringup.md
git commit -m "docs(experiments): Windows eval runtime live bring-up"
```

---

## Self-Review

**1. Spec coverage:**
- VM lifecycle wrapper → Task 3. Remote-host seam → Task 2. `claude-windows` config + context (HOWTO/launcher) → Tasks 1, 4. Windows provisioning adapter → Task 5. Capture-back (+ push-workdir) seam → Task 6. `--plugin-dir` superpowers + rsync cache → Tasks 3 (`sync-superpowers`), 5 (`rsyncTo`). API-key auth, no OAuth → Task 5 (`launch.cmd`, never captured). Per-run isolation (HOME/USERPROFILE) → Task 5 + verified Task 8/Step 2. scp-only capture, no shared folder → Tasks 2/5. Docs → Task 7. Linux+KVM-only → Global Constraints + Task 7. The four "risks to verify" → Task 8. All spec sections map to a task.

**2. Placeholder scan:** No "TBD/TODO/handle edge cases/similar to Task N". Every code step shows complete code; every command shows expected output. Task 8 verification steps are live-system checks with falsifiable expected results, not fabricated assertions about un-run Windows behavior (the spec explicitly lists these as unproven).

**3. Type consistency:** `RemoteConfig`/`RemoteConfigSchema` (Task 1) consumed identically in Tasks 2/5/6. `WindowsHost` methods `ssh/scpFrom/scpTo/rsyncTo` (Task 2) match calls in Task 5. `WindowsClaudeAgent.provision` returns the exact `$WIN_*` keys (Task 5) that `launch-agent` consumes (Task 4) and the runner merges (Task 6). `RemoteExecution.pushWorkdir/captureBack` signatures match Task 6 call sites. `winPaths` is the single source of the `<run_root>\<runId>\{home,workdir,launch.cmd}` layout used by provision, push, and capture.

**Note vs spec:** the spec said "exactly one new runner seam"; implementation needs **two** narrow `remote`-gated call sites (push-workdir after `runSetup`, capture-back after the drive) because `runSetup` builds the workdir locally after `provision`. Both are one-liners delegating to `RemoteExecution`; the local path stays byte-for-byte unchanged.
