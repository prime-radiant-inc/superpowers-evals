# OS-target Dimension (core) + Windows Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-agent `claude-windows` shape with a first-class `--os` dimension (`scenario × agent × os`), reusing all the proven Windows transport code, and fix the 7 issues an adversarial review found in the v1 provisioning/capture.

**Architecture:** A new os-target config layer (`os-targets/<name>.yaml`, `linux` built-in) carries the remote-SSH connection; agents declare `os_support`. `resolveAgent(cfg, os)` selects a per-`(family, os)` provisioner — the v1 `WindowsClaudeAgent` becomes the `(claude, windows)` one. The runner gates on `os === 'windows'` (was `cfg.remote`), run-ids include os, and provisioning/capture get per-run plugin dirs, base64 (quoting-safe, secret-safe) guest writes, guest-side teardown, and capture safe-swap/no-log tolerance.

**Tech Stack:** Bun/TypeScript (Zod, the existing quorum CLI + `CommandRunner`/`WindowsHost` seam), Biome, `bun test`. Bash for the wrapper. Live target: dockur Windows 11 over SSH.

**Spec:** `docs/superpowers/specs/2026-06-18-os-target-dimension-design.md`

> **Scope:** This is Plan 1 of 2. Plan 2 (the `run-all` matrix + dashboard os dimension) is a separate plan written after this lands; it depends on the run-id/os threading delivered here. Plan 1 delivers a working, hardened single-run `quorum run … --coding-agent claude --os windows`.

## Global Constraints

Copied from the spec; every task inherits these.

- **`--os` default is `linux`** (today's local execution; no config file). `windows` = remote SSH to a dockur guest.
- **Linux behavior must be byte-for-byte unchanged** except the run-id now includes `-linux-`. Every os-gated branch is skipped when `os === 'linux'`.
- **All SSH/scp to the guest keeps the mux-off flags** and the `-tt` discipline already in `WindowsHost`/the launcher (launcher keeps `-tt`; `WindowsHost.ssh` has none).
- **Per-run isolation on the guest:** every guest path lives under `<win_run_root>\<runId>` — including the plugin dir (`…\<runId>\superpowers`). No shared guest paths across runs.
- **No secret in argv-that-can-be-thrown:** `ANTHROPIC_API_KEY` is written to the guest only inside base64'd file content; provisioning errors must redact file payloads.
- **Quoting-safe guest writes:** file contents go to the guest via base64 decode, never inlined into `powershell -Command "… -Value '<content>'"`.
- **Run-id format:** `<scenario>-<agent>-<os>-<stamp>-<nonce>`.
- `checks.sh` must not have the executable bit set (repo convention). Run `bun run check` (biome+tsc+full suite) before every commit.
- `erasableSyntaxOnly` + `exactOptionalPropertyTypes` are on: no TS constructor parameter-property shorthand; optional fields typed `T | undefined`.

## File Structure

Create:
- `src/contracts/os-target.ts` — `OsTargetSchema`/`OsTarget` (the moved `RemoteConfig`) + `loadOsTarget` + the built-in `linux` target.
- `os-targets/windows.yaml` — the windows remote connection block.
- `test/os-target.test.ts`, `test/windows-host-writefile.test.ts`.

Modify:
- `src/contracts/agent-config.ts` — drop `remote`, add `os_support`; validate os ∈ os_support.
- `src/agents/windows-host.ts` — add `writeFileBase64` (quoting-safe, redacting).
- `src/agents/claude-windows.ts` — per-run plugin dir; base64 writes; capture safe-swap/no-log; take the remote block as a constructor arg (from the os-target).
- `src/agents/index.ts` — `resolveAgent(cfg, os, osTarget)`.
- `src/runner/index.ts` — thread os + os-target; `allocateRunDir` includes os; `contextDirName(cfg, os)`; os-gated hooks; guest teardown in `finally`; capture-back → capture-stage indeterminate.
- `src/cli/*` — `--os` on `run`/`show`/`costs`.
- `coding-agents/claude.yaml` — `os_support: [linux, windows]`.
- Delete `coding-agents/claude-windows.yaml`.

---

## Task 1: os-target contracts + agent `os_support` + config migration

**Files:**
- Create: `src/contracts/os-target.ts`, `os-targets/windows.yaml`, `test/os-target.test.ts`
- Modify: `src/contracts/agent-config.ts` (move `RemoteConfigSchema` out; drop `remote`; add `os_support`), `coding-agents/claude.yaml`
- Delete: `coding-agents/claude-windows.yaml`

**Interfaces:**
- Produces: `OsTargetSchema`/`OsTarget` (`{ name: string; remote?: RemoteConfig }`); `loadOsTarget(osTargetsDir: string, name: string): OsTarget` (returns `{name:'linux'}` for `linux` with no file); `RemoteConfig` re-exported from `os-target.ts`. `AgentConfig.os_support: string[]` (default `['linux']`); `AgentConfig.remote` REMOVED.

- [ ] **Step 1: Write failing test** `test/os-target.test.ts`

```ts
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { loadOsTarget, OsTargetSchema } from '../src/contracts/os-target.ts';

describe('os-target', () => {
  test('linux is a built-in no-remote target', () => {
    const t = loadOsTarget(join(import.meta.dir, '..', 'os-targets'), 'linux');
    expect(t.name).toBe('linux');
    expect(t.remote).toBeUndefined();
  });
  test('windows loads the remote block from os-targets/windows.yaml', () => {
    const t = loadOsTarget(join(import.meta.dir, '..', 'os-targets'), 'windows');
    expect(t.name).toBe('windows');
    expect(t.remote?.port).toBe(2222);
    expect(t.remote?.win_run_root).toBe('C:\\eval-runs');
  });
  test('schema rejects an unknown os-target shape', () => {
    expect(() => OsTargetSchema.parse({ name: 123 })).toThrow();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `bun test test/os-target.test.ts` → module missing.

- [ ] **Step 3: Create `src/contracts/os-target.ts`** (move `RemoteConfigSchema` here from `agent-config.ts`; note `win_superpowers_dir` is REMOVED — the plugin dir is now per-run, derived under `win_run_root`):

```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// SSH connection to a remote OS guest (windows). win_run_root is the base for
// per-run guest dirs (<win_run_root>\<runId>\{home,coding-agent-workdir,superpowers,launch.cmd}).
export const RemoteConfigSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).default(2222),
  user: z.string().default('user'),
  password_env: z.string().default('WIN_EVAL_PASSWORD'),
  win_run_root: z.string().default('C:\\eval-runs'),
});
export type RemoteConfig = z.infer<typeof RemoteConfigSchema>;

export const OsTargetSchema = z.object({
  name: z.string(),
  remote: RemoteConfigSchema.optional(),
});
export type OsTarget = z.infer<typeof OsTargetSchema>;

export class OsTargetError extends Error {
  constructor(message: string) { super(message); this.name = 'OsTargetError'; }
}

// linux is built-in (no remote, local execution). Other names read
// os-targets/<name>.yaml and must carry a remote block.
export function loadOsTarget(osTargetsDir: string, name: string): OsTarget {
  if (name === 'linux') return { name: 'linux' };
  const path = join(osTargetsDir, `${name}.yaml`);
  if (!existsSync(path)) {
    throw new OsTargetError(`unknown os target '${name}': ${path} not found`);
  }
  const raw: unknown = parseYaml(readFileSync(path, 'utf8'));
  const parsed = OsTargetSchema.parse(raw);
  if (parsed.name !== name) {
    throw new OsTargetError(`${path}: name must match file stem; got '${parsed.name}'`);
  }
  if (parsed.remote === undefined) {
    throw new OsTargetError(`${path}: non-linux os target requires a remote block`);
  }
  return parsed;
}
```

- [ ] **Step 4: Create `os-targets/windows.yaml`**

```yaml
name: windows
remote:
  password_env: WIN_EVAL_PASSWORD
```

- [ ] **Step 5: Edit `src/contracts/agent-config.ts`** — remove the `RemoteConfigSchema`/`RemoteConfig` definitions and the `remote:` field from `AgentConfigSchema`; re-export the type from os-target for back-compat of imports; add `os_support`. In the schema object add:

```ts
  os_support: z.array(z.string()).default(['linux']),
```
Remove the `remote: RemoteConfigSchema.optional(),` line and the `RemoteConfigSchema`/`RemoteConfig` block (now in os-target.ts). Add at top: `import { RemoteConfigSchema, type RemoteConfig } from './os-target.ts';` only if something here still needs it (it does not after the move — delete the local copy). Add a loader check in `loadAgentConfig` is NOT here (os validation happens in the runner where os is known); leave `loadAgentConfig` otherwise unchanged.

- [ ] **Step 6: `coding-agents/claude.yaml`** — add `os_support: [linux, windows]` (after `model: opus`).

- [ ] **Step 7: Delete `coding-agents/claude-windows.yaml`** — `git rm coding-agents/claude-windows.yaml`.

- [ ] **Step 8: Run + check** — `bun test test/os-target.test.ts` PASS; `bun run check` clean. (Other tests that imported `RemoteConfigSchema` from `agent-config.ts` must be updated to import from `os-target.ts` — grep `RemoteConfigSchema` and fix import paths.)

- [ ] **Step 9: Commit**
```bash
git add src/contracts/os-target.ts os-targets/windows.yaml src/contracts/agent-config.ts coding-agents/claude.yaml test/os-target.test.ts
git rm coding-agents/claude-windows.yaml
git commit -m "feat(os): os-target contracts + agent os_support; migrate claude-windows config"
```

---

## Task 2: `writeFileBase64` on WindowsHost (quoting-safe + secret-safe)

**Files:**
- Modify: `src/agents/windows-host.ts`
- Test: `test/windows-host-writefile.test.ts`

**Interfaces:**
- Produces: `WindowsHost.writeFileBase64(winPath: string, content: string, opts?: { secret?: boolean }): void` — writes `content` to the guest path via base64 decode (no shell-quoting hazard). Throws on non-zero status; when `opts.secret` the error message must NOT include the content or its base64.

**Why:** fixes /par #2 (secret in argv/error) and #3 (JSON quoting). Base64 is `[A-Za-z0-9+/=]` only, so it's safe inside the PowerShell single-quoted literal, and the file content (JSON with `"`/`'`, the API key) never appears in argv unencoded.

- [ ] **Step 1: Write failing test** `test/windows-host-writefile.test.ts`

```ts
import { describe, expect, test } from 'bun:test';
import type { CommandResult, CommandRunner } from '../src/agents/command-runner.ts';
import { RemoteConfigSchema } from '../src/contracts/os-target.ts';
import { WindowsHost } from '../src/agents/windows-host.ts';

class FakeRunner implements CommandRunner {
  calls: { command: string; args: string[] }[] = [];
  result: CommandResult = { status: 0, stdout: '', stderr: '' };
  run(command: string, args: readonly string[]): CommandResult {
    this.calls.push({ command, args: [...args] });
    return this.result;
  }
}
const remote = RemoteConfigSchema.parse({ password_env: 'WIN_EVAL_PASSWORD' });

describe('WindowsHost.writeFileBase64', () => {
  test('sends base64 (not raw content) and a FromBase64String decode', () => {
    process.env.WIN_EVAL_PASSWORD = 'password';
    const r = new FakeRunner();
    const json = '{"a":"b\'c"}'; // contains both quote kinds
    new WindowsHost(remote, r).writeFileBase64('C:\\x\\f.json', json);
    const argv = r.calls[0]!.args.join(' ');
    expect(argv).toContain('FromBase64String');
    expect(argv).toContain(Buffer.from(json, 'utf8').toString('base64'));
    expect(argv).not.toContain(json); // raw content never in argv
  });
  test('secret write redacts content from the thrown error', () => {
    process.env.WIN_EVAL_PASSWORD = 'password';
    const r = new FakeRunner();
    r.result = { status: 1, stdout: '', stderr: 'boom' };
    const secret = 'sk-ant-SECRET';
    expect(() =>
      new WindowsHost(remote, r).writeFileBase64('C:\\x\\launch.cmd', `set KEY=${secret}`, { secret: true }),
    ).toThrow();
    try {
      new WindowsHost(remote, r).writeFileBase64('C:\\x\\launch.cmd', `set KEY=${secret}`, { secret: true });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(secret);
      expect(String((e as Error).message)).not.toContain(Buffer.from(`set KEY=${secret}`).toString('base64'));
    }
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `bun test test/windows-host-writefile.test.ts`.

- [ ] **Step 3: Implement** in `src/agents/windows-host.ts` (add the method to the class; reuse the existing `toScpRemotePath` for forward slashes is NOT needed here — this runs over `ssh`, so use backslash paths as PowerShell wants):

```ts
  // Write file content to the guest, quoting-safe + secret-safe: base64 the
  // content on Linux, decode on the guest. Base64 is [A-Za-z0-9+/=] only, so it
  // never breaks the PowerShell single-quoted literal, and raw content (JSON,
  // API keys) never appears in argv. With opts.secret, errors omit the payload.
  writeFileBase64(winPath: string, content: string, opts?: { secret?: boolean }): void {
    const b64 = Buffer.from(content, 'utf8').toString('base64');
    const ps =
      `powershell -NoProfile -Command "` +
      `$d=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'));` +
      `[IO.File]::WriteAllText('${winPath}', $d)"`;
    const r = this.ssh(ps);
    if (r.status !== 0) {
      const where = opts?.secret ? `<redacted> -> ${winPath}` : ps;
      throw new Error(`guest writeFile failed (${r.status}) ${where}\n${r.stderr}`);
    }
  }
```

- [ ] **Step 4: Run + check** — `bun test test/windows-host-writefile.test.ts` PASS; `bun run check` clean.

- [ ] **Step 5: Commit**
```bash
git add src/agents/windows-host.ts test/windows-host-writefile.test.ts
git commit -m "feat(windows): WindowsHost.writeFileBase64 (quoting-safe + secret-safe guest writes)"
```

---

## Task 3: `(claude, windows)` provisioner — per-run plugin dir + base64 writes + remote-from-os-target

**Files:**
- Modify: `src/agents/claude-windows.ts`
- Test: `test/claude-windows-agent.test.ts`

**Interfaces:**
- Consumes: `WindowsHost.writeFileBase64` (Task 2); `RemoteConfig`/`OsTarget` (Task 1).
- Produces: `WindowsClaudeAgent` constructed with the **remote block** (from the os-target), not read from `cfg.remote` (removed). `winPaths` gains `superpowers: winJoin(runRoot, 'superpowers')` (per-run, fix /par #1). `provision` writes `.claude.json` + `launch.cmd` via `writeFileBase64` (fixes /par #2/#3), scp's superpowers into the per-run dir (no shared dir, no `Remove-Item`), and returns the same `$WIN_*` substitutions. `RemoteExecution` constructed with the remote block.

- [ ] **Step 1: Update the test** `test/claude-windows-agent.test.ts` to the new construction + assertions (remote passed in; per-run superpowers; base64 writes; no shared-dir Remove-Item):

```ts
// (replace the provision success test body)
const remote = RemoteConfigSchema.parse({ password_env: 'WIN_EVAL_PASSWORD' });
const cfg = loadAgentConfig(join(import.meta.dir, '..', 'coding-agents'), 'claude');
const runDir = mkdtempSync(join(tmpdir(), 'myscenario-claude-windows-run-'));
const runId = runDir.split('/').pop()!;
const home = { configDir: join(runDir,'home','.claude'), workdir: join(runDir,'coding-agent-workdir'), skeletonRoot: undefined };
const runner = new FakeRunner();
const subs = new WindowsClaudeAgent(cfg, remote).provision(home, runner) as Record<string,string>;
// per-run superpowers dir under the run root (no shared C:\eval-superpowers)
expect(subs['$WIN_LAUNCH_CMD']).toContain(`eval-runs\\${runId}\\launch.cmd`);
const all = runner.calls.map((c) => c.args.join(' ')).join('\n');
expect(all).toContain('FromBase64String');           // base64 writes
expect(all).not.toContain('Remove-Item -Recurse -Force C:\\eval-superpowers'); // no shared dir wipe
expect(all).toContain(`eval-runs\\${runId}\\superpowers`); // scp target is per-run
```
(Keep the missing-`ANTHROPIC_API_KEY` throw test; construct with `(cfg, remote)`.)

- [ ] **Step 2: Run, expect FAIL** — the constructor signature + behavior changed.

- [ ] **Step 3: Implement** in `src/agents/claude-windows.ts`:
  - `winPaths`: add `superpowers: winJoin(runRoot, 'superpowers')` (remove the `remote.win_superpowers_dir` reference).
  - Constructor: `constructor(private config…, remote)` is banned (erasableSyntaxOnly) → explicit fields `config` + `remote: RemoteConfig`, assigned in the body. Drop the `this.remote()` getter that read `cfg.remote`.
  - `provision`: 
    - Step 1 `New-Item` of `…\home\.claude` (unchanged; still no workdir pre-create per the earlier C2 fix).
    - Step 2 `.claude.json`: build the JSON string, then `host.writeFileBase64(\`${p.home}\\.claude\\.claude.json\`, claudeJson)`.
    - Step 3 `launch.cmd`: build the `launchCmd` string (it has `set "ANTHROPIC_API_KEY=…"`), then `host.writeFileBase64(p.launchCmd, launchCmd, { secret: true })`. The `--plugin-dir` in the launch.cmd now points at `p.superpowers` (per-run).
    - Step 4 superpowers: REMOVE the shared-dir `Remove-Item` + rsync/scp-to-shared. Instead `const sync = host.scpTo(sp, p.runRoot)` is wrong (lands `runRoot\<basename(sp)>`); use a per-run dir: create it then scp. Simplest deterministic: `host.scpTo(sp, p.superpowers)` where `p.superpowers` does not pre-exist → scp lands the CONTENTS at `p.superpowers` (validated live: scp -r into an absent dest = contents-at-dest). Keep the `SUPERPOWERS_ROOT` guard + status check.
  - `RemoteExecution` constructor: takes `remote` (already does) — no change beyond it now coming from the os-target.

- [ ] **Step 4: Run + check** — focused test PASS; `bun run check` clean.

- [ ] **Step 5: Commit**
```bash
git add src/agents/claude-windows.ts test/claude-windows-agent.test.ts
git commit -m "feat(windows): per-run plugin dir + base64 guest writes; remote from os-target (/par #1,#2,#3)"
```

---

## Task 4: Capture hardening — safe-swap, no-log tolerance (/par #5, #7)

**Files:**
- Modify: `src/agents/claude-windows.ts` (`RemoteExecution.captureBack`)
- Test: `test/claude-windows-agent.test.ts`

**Interfaces:**
- Produces: `captureBack(localRunHomeDir, localWorkdir, runId)` that (a) creates the local `.claude` then pulls logs but treats a MISSING guest `projects` as empty (no throw); (b) pulls the guest workdir into a temp sibling and atomically swaps, so a failed pull leaves the pre-run workdir intact; (c) still throws on a genuine transport error that isn't "source missing".

- [ ] **Step 1: Add tests** for: (i) a `scpFrom` whose stderr says the source doesn't exist → captureBack does NOT throw and leaves no partial state; (ii) the local workdir is only replaced after a successful pull (simulate failure → original workdir contents still present).

```ts
test('captureBack tolerates a missing guest projects dir (no-log run)', () => {
  process.env.WIN_EVAL_PASSWORD = 'password';
  const home = mkdtempSync(join(tmpdir(),'h-')); const wd = mkdtempSync(join(tmpdir(),'w-'));
  writeFileSync(join(wd,'fixture.txt'),'orig');
  const r = new (class implements CommandRunner {
    run(_c:string,a:readonly string[]):CommandResult{
      return a.join(' ').includes('projects')
        ? { status:1, stdout:'', stderr:'scp: ...projects: No such file or directory' }
        : { status:0, stdout:'', stderr:'' };
    }
  })();
  expect(() => new RemoteExecution(remote, r).captureBack(home, wd, 'abc')).not.toThrow();
  expect(readFileSync(join(wd,'fixture.txt'),'utf8')).toBe('orig'); // workdir untouched on log-miss path
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** — rewrite `captureBack`:

```ts
  captureBack(localRunHomeDir: string, localWorkdir: string, runId: string): void {
    const p = winPaths(this.remote, runId);
    // Session logs: missing guest projects (no-log run) is empty capture, not fatal.
    mkdirSync(join(localRunHomeDir, '.claude'), { recursive: true });
    const logs = this.host.scpFrom(winJoin(p.home, '.claude', 'projects'), join(localRunHomeDir, '.claude'));
    if (logs.status !== 0 && !/no such file|not exist/i.test(logs.stderr)) {
      throw new Error(`capture session logs from guest failed: ${logs.stderr}`);
    }
    // Workdir: pull to a temp sibling; swap only on success so a failed pull
    // leaves the pre-run fixture intact.
    const tmp = `${localWorkdir}.incoming-${runId}`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const wd = this.host.scpFrom(p.workdir, tmp);
    if (wd.status !== 0) {
      rmSync(tmp, { recursive: true, force: true });
      if (/no such file|not exist/i.test(wd.stderr)) return; // no workdir on guest: leave local as-is
      throw new Error(`capture workdir from guest failed: ${wd.stderr}`);
    }
    rmSync(localWorkdir, { recursive: true, force: true });
    renameSync(join(tmp, 'coding-agent-workdir'), localWorkdir);
    rmSync(tmp, { recursive: true, force: true });
  }
```
Add `renameSync` to the `node:fs` import.

- [ ] **Step 4: Run + check** — PASS; `bun run check` clean.

- [ ] **Step 5: Commit**
```bash
git add src/agents/claude-windows.ts test/claude-windows-agent.test.ts
git commit -m "fix(windows): capture safe-swap + no-log tolerance (/par #5,#7)"
```

---

## Task 5: Runner — os threading, run-id, context-dir, os-gating, capture-stage, guest teardown (/par #4, #6)

**Files:**
- Modify: `src/runner/index.ts`
- Test: `test/runner-windows-hooks.test.ts`, `test/runner-unit.test.ts`

**Interfaces:**
- Consumes: `loadOsTarget` (Task 1), `resolveAgent(cfg, os, osTarget)` (Task 6 — sequence Task 6 before this if implementing strictly; or stub the resolve call and let Task 6 finalize). `RemoteExecution` (Task 4).
- Produces: `RunScenarioArgs` gains `os: string`; `allocateRunDir(outRoot, scenario, agent, os)` includes os in the id; `contextDirName(cfg, os)`; the three hooks gate on `os === 'windows'`; the run `finally` tears down the guest run root when `os === 'windows'`; capture-back is wrapped to return a `capture`-stage indeterminate (preserving gauntlet + pre-checks) instead of throwing.

- [ ] **Step 1: Tests.** In `test/runner-unit.test.ts` extend `contextDirName` tests for the `(cfg, os)` signature: `contextDirName({name:'claude',runtime_family:'claude'}, 'windows')` → `'claude-windows'`; `…, 'linux'` → `'claude'`. In `test/runner-windows-hooks.test.ts` add a test that `allocateRunDir('/out','sc','claude','windows')` produces an id containing `-claude-windows-`.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** the runner edits:
  - `allocateRunDir`: add an `os` param; id = `` `${scenario}-${agent}-${os}-${nowStampUtc()}-${hexNonce()}` ``. Update the call site (`runDir = allocateRunDir(a.outRoot, scenario, a.codingAgent, a.os)`).
  - `RunScenarioArgs`: add `readonly os: string`.
  - Load the os-target: `const osTarget = loadOsTarget(osTargetsDir, a.os)` (osTargetsDir = repo `os-targets/`); validate `a.os ∈ cfg.os_support` else a setup `RunnerError`.
  - `resolveAgent(cfg, a.os, osTarget)` (Task 6).
  - `contextDirName(cfg, os)`: `os === 'linux' ? (cfg.runtime_family ?? cfg.name) : `${cfg.runtime_family ?? cfg.name}-${os}``. Replace the v1 `contextDirName(cfg)`/`isRemote = cfg.remote !== undefined` with `isRemote = a.os !== 'linux'` and `contextDirName(cfg, a.os)`.
  - The three hooks: replace `cfg.remote !== undefined` with `a.os !== 'linux'`; construct `RemoteExecution(osTarget.remote!, defaultCommandRunner)`.
  - Capture-back wrap (fixes /par #6): wrap the `captureBack(...)` call in try/catch; on throw, `return writeIndeterminate({ finalReason: \`capture: ${e.message}\`, gauntlet, checks: pre.records, error: { stage: 'capture', message: e.message } })`.
  - Guest teardown (fixes /par #4): in the `finally` (line ~927) after `cleanupAgentRuntime(cleanupDirs)`, when `a.os !== 'linux'` and `osTarget.remote` is set, best-effort `new WindowsHost(osTarget.remote, defaultCommandRunner).ssh(\`powershell -NoProfile -Command "Remove-Item -Recurse -Force '<win_run_root>\\<runId>' -ErrorAction SilentlyContinue"\`)` wrapped in try/catch (teardown failure must not mask the verdict). runId = `basename(runDir)`.

- [ ] **Step 4: Run + check** — `bun run check` clean (full suite green — confirms linux path unchanged).

- [ ] **Step 5: Commit**
```bash
git add src/runner/index.ts test/runner-windows-hooks.test.ts test/runner-unit.test.ts
git commit -m "feat(os): runner os threading, run-id+context-dir by os, capture-stage + guest teardown (/par #4,#6)"
```

---

## Task 6: `resolveAgent(cfg, os, osTarget)` — per-`(family, os)` selection

**Files:**
- Modify: `src/agents/index.ts`
- Test: `test/agent-config.test.ts` or a focused `test/resolve-agent.test.ts`

**Interfaces:**
- Produces: `resolveAgent(config, os, osTarget)`. For `os === 'linux'` → today's resolution (claude/codex/…). For `os === 'windows'` + family `claude` → `new WindowsClaudeAgent(config, osTarget.remote!)`. For `os !== 'linux'` + an unsupported family → throw a `ProvisionError(\`agent ${config.name} has no ${os} provisioner\`)`.

- [ ] **Step 1: Test** — `resolveAgent(claudeCfg, 'windows', {name:'windows',remote})` returns a `WindowsClaudeAgent`; `resolveAgent(codexCfg, 'windows', …)` throws.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the `(family, os)` branch (windows registry currently only `claude`).
- [ ] **Step 4: Run + check** — clean.
- [ ] **Step 5: Commit** `feat(os): resolveAgent by (family, os)`.

---

## Task 7: CLI `--os` flag on `run`/`show`/`costs`

**Files:**
- Modify: `src/cli/*` (the `run` command parser; `show`/`costs` only need to tolerate the os in run-dir names — verify their parsers split on the new id shape)
- Test: the CLI/runner test that drives `run`

**Interfaces:**
- Produces: `quorum run <scenario> --coding-agent <a> --os <linux|windows>` (default `linux`), threaded into `RunScenarioArgs.os`.

- [ ] **Step 1: Test** — a parser/unit test that `--os windows` reaches `RunScenarioArgs.os`; default is `linux`.
- [ ] **Step 2–4:** add the flag (find where `--coding-agent` is parsed in `src/cli/`), default `linux`; thread to `runScenario`. Confirm `show`/`costs` run-dir-name parsing still works with the longer id (audit any `split('-')` on run ids).
- [ ] **Step 5: Commit** `feat(cli): --os flag on run/show/costs`.

---

## Task 8: Docs + live re-validation

**Files:**
- Modify: `docs/windows/eval-runtime.md` (now `--coding-agent claude --os windows`, per-run dirs, the live deployment notes: Mac + sshpass + tunnel, rsync-absent→scp, the `-tt` rule); `README.md` pointer.
- Create: `docs/experiments/2026-06-18-os-target-windows-bringup.md`.

- [ ] **Step 1:** Rewrite the operator doc for the `--os` interface + the live-validated facts (no `claude-windows` agent; it's `--coding-agent claude --os windows`).
- [ ] **Step 2: Static gates** — `bun run check`, `bun run quorum check`.
- [ ] **Step 3: Live (trusted-maintainer, Mac orchestrator + tunnel)** — re-run the two smokes on the new interface:
```bash
export WIN_EVAL_PASSWORD=password ANTHROPIC_API_KEY=… SUPERPOWERS_ROOT=<staged .git-free tree>
# tunnel: ssh -fN -L 127.0.0.1:2222:127.0.0.1:2222 <kvm-host>
bun run quorum run scenarios/00-quorum-smoke-hello-world --coding-agent claude --os windows
bun run quorum run scenarios/triggering-test-driven-development --coding-agent claude --os windows
```
Expected: both `final pass`; run-ids contain `-claude-windows-`; the guest `C:\eval-runs\<id>` is gone after each run (teardown); no API key in `verdict.json`.
- [ ] **Step 4:** Record results in the experiment doc; commit.

---

## Self-Review

**1. Spec coverage:** os-target config + linux built-in (T1); `os_support` + migration/delete (T1); `resolveAgent(cfg,os)` (T6); runner os-gating + run-id + context-dir (T5); CLI `--os` (T7). The 7 /par fixes: #1 per-run plugin dir (T3), #2 secret-safe + #3 quoting-safe writes (T2+T3), #4 guest teardown (T5), #5 capture safe-swap + #7 no-log (T4), #6 capture-stage indeterminate (T5). Live re-validation (T8). run-all/dashboard os dimension is explicitly Plan 2.

**2. Placeholder scan:** no TBD/TODO; each code step shows the code; commands show expected results. Task 5/7 reference exact seams (`allocateRunDir` :95-102, the `finally` :927, the CLI `--coding-agent` parser) the implementer reads — flagged as "find/audit" with the concrete target, not vague.

**3. Type consistency:** `RemoteConfig`/`OsTarget` (T1) consumed in T2/T3/T5/T6 identically; `WindowsClaudeAgent(config, remote)` (T3) matches the `resolveAgent` construction (T6); `writeFileBase64(winPath, content, opts?)` (T2) matches the T3 calls; `contextDirName(cfg, os)` (T5) matches T5 tests; `winPaths(...).superpowers` per-run is the single source used by provision + the launch.cmd `--plugin-dir`.

**Sequencing note:** Tasks 1→2→3→4 are bottom-up. Task 6 (`resolveAgent`) is consumed by Task 5 (runner) — implement Task 6 before Task 5, or stub the resolve call in Task 5 and finalize in Task 6. Task 7 (CLI) and Task 8 (docs/live) last.
