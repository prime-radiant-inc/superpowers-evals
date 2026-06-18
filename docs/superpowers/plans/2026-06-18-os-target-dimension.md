# OS-target Dimension (core) + Windows Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-agent `claude-windows` shape with a first-class `--os` dimension (`scenario × agent × os`), reusing all the proven Windows transport code, and fix the 7 issues an adversarial review found in the v1 provisioning/capture.

**Architecture:** A new os-target config layer (`os-targets/<name>.yaml`, `linux` built-in) carries the remote-SSH connection; agents declare `os_support`. `resolveAgent(cfg, os, osTarget)` selects a per-`(family, os)` provisioner — the v1 `WindowsClaudeAgent` becomes the `(claude, windows)` one. The runner gates on `os !== 'linux'` (was `cfg.remote`), run-ids include os, and provisioning/capture get per-run plugin dirs, base64 (quoting-safe, secret-safe) guest writes, guest-side teardown, and capture safe-swap/no-log tolerance.

**Tech Stack:** Bun/TypeScript (Zod, the existing quorum CLI + `CommandRunner`/`WindowsHost` seam), Biome, `bun test`. Bash for the wrapper. Live target: dockur Windows 11 over SSH.

**Spec:** `docs/superpowers/specs/2026-06-18-os-target-dimension-design.md`

> **GREENNESS RULE (read first):** This is a refactor of code with existing tests. Tasks are ordered **additive-first, removal-last**: every task ends with `bun run check` fully green. New params get `linux`/optional DEFAULTS so existing call sites keep compiling; the old `cfg.remote` path stays alive until Task 8 removes it once nothing reads it. NEVER remove `remote` from `AgentConfig` or delete `claude-windows.yaml` before Task 8.

> **Scope:** Plan 1 of 2. Plan 2 (the `run-all` matrix + dashboard os dimension) is separate, written after this lands. Plan 1 delivers a working, hardened single-run `quorum run … --coding-agent claude --os windows`.

## Global Constraints

- **`--os` default is `linux`**; `windows` = remote SSH to a dockur guest. Linux behavior stays byte-for-byte identical except run-ids now include `-linux-`.
- **Every os-gated branch is skipped when `os === 'linux'`.** New params (`os`, `osTarget`, `RunScenarioArgs.os`, `allocateRunDir`'s os) default to `linux`/optional so existing callers compile unchanged.
- **Per-run guest isolation:** every guest path lives under `<win_run_root>\<runId>`, including the plugin dir (`…\<runId>\superpowers`). No shared guest paths.
- **No secret in argv-that-can-be-thrown:** `ANTHROPIC_API_KEY` reaches the guest only inside base64'd file content; provisioning errors redact file payloads.
- **Quoting-safe guest writes:** file contents go via base64 decode, never inlined into `powershell -Command "… -Value '<content>'"`.
- **Run-id:** `<scenario>-<agent>-<os>-<stamp>-<nonce>`.
- Keep the mux-off flags + `-tt` discipline (`WindowsHost.ssh` no `-tt`; launcher keeps `-tt`).
- `erasableSyntaxOnly` + `exactOptionalPropertyTypes`: no constructor parameter-property shorthand; optional fields typed `T | undefined`.
- Run `bun run check` (biome+tsc+full suite) green before every commit. `checks.sh` stays non-executable.

## File Structure

Create: `src/contracts/os-target.ts`, `os-targets/windows.yaml`, `test/os-target.test.ts`, `test/windows-host-writefile.test.ts`.
Modify: `src/contracts/agent-config.ts` (add `os_support`; re-export RemoteConfig from os-target), `src/agents/windows-host.ts` (`writeFileBase64`), `src/agents/claude-windows.ts` (per-run plugin dir, base64 writes, `remote` as ctor arg, capture hardening), `src/agents/index.ts` (`resolveAgent(cfg,os,osTarget)`), `src/runner/index.ts` (os threading, run-id, context-dir, os-gating, teardown, capture-stage), `src/cli/*` (`--os`), `coding-agents/claude.yaml` (os_support).
Delete (Task 8 only): `coding-agents/claude-windows.yaml`; remove `remote` from `AgentConfig`.

---

## Task 1: Additive contracts — os-target + `os_support` (NO removals)

**Files:** Create `src/contracts/os-target.ts`, `os-targets/windows.yaml`, `test/os-target.test.ts`; Modify `src/contracts/agent-config.ts`, `coding-agents/claude.yaml`.

**Interfaces produced:** `RemoteConfigSchema`/`RemoteConfig` and `OsTargetSchema`/`OsTarget` + `loadOsTarget(dir,name): OsTarget` (linux built-in, no remote) + `OsTargetError`, all exported from `src/contracts/os-target.ts`. `AgentConfig.os_support: string[]` (default `['linux']`). `agent-config.ts` RE-EXPORTS `RemoteConfigSchema`/`RemoteConfig` from os-target (so existing imports keep working) and KEEPS its `remote` field.

- [ ] **Step 1: failing test** `test/os-target.test.ts`
```ts
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { loadOsTarget, OsTargetSchema } from '../src/contracts/os-target.ts';
const dir = join(import.meta.dir, '..', 'os-targets');
describe('os-target', () => {
  test('linux is built-in no-remote', () => {
    const t = loadOsTarget(dir, 'linux');
    expect(t.name).toBe('linux'); expect(t.remote).toBeUndefined();
  });
  test('windows loads remote block', () => {
    const t = loadOsTarget(dir, 'windows');
    expect(t.remote?.port).toBe(2222);
    expect(t.remote?.win_run_root).toBe('C:\\eval-runs');
  });
  test('schema rejects bad shape', () => { expect(() => OsTargetSchema.parse({ name: 1 })).toThrow(); });
});
```
- [ ] **Step 2: FAIL** — `bun test test/os-target.test.ts`.
- [ ] **Step 3: create `src/contracts/os-target.ts`** — MOVE the existing `RemoteConfigSchema`/`RemoteConfig` definition out of `agent-config.ts` to here, but DROP its `win_superpowers_dir` field (the plugin dir is now per-run, derived under `win_run_root`):
```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const RemoteConfigSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).default(2222),
  user: z.string().default('user'),
  password_env: z.string().default('WIN_EVAL_PASSWORD'),
  win_run_root: z.string().default('C:\\eval-runs'),
});
export type RemoteConfig = z.infer<typeof RemoteConfigSchema>;

export const OsTargetSchema = z.object({ name: z.string(), remote: RemoteConfigSchema.optional() });
export type OsTarget = z.infer<typeof OsTargetSchema>;

export class OsTargetError extends Error {
  constructor(m: string) { super(m); this.name = 'OsTargetError'; }
}

export function loadOsTarget(osTargetsDir: string, name: string): OsTarget {
  if (name === 'linux') return { name: 'linux' };
  const path = join(osTargetsDir, `${name}.yaml`);
  if (!existsSync(path)) throw new OsTargetError(`unknown os target '${name}': ${path} not found`);
  const parsed = OsTargetSchema.parse(parseYaml(readFileSync(path, 'utf8')));
  if (parsed.name !== name) throw new OsTargetError(`${path}: name must match file stem; got '${parsed.name}'`);
  if (parsed.remote === undefined) throw new OsTargetError(`${path}: non-linux os target requires a remote block`);
  return parsed;
}
```
- [ ] **Step 4: `os-targets/windows.yaml`**
```yaml
name: windows
remote:
  password_env: WIN_EVAL_PASSWORD
```
- [ ] **Step 5: edit `src/contracts/agent-config.ts`** — delete the local `RemoteConfigSchema`/`RemoteConfig` definition; add at top `import { RemoteConfigSchema, type RemoteConfig } from './os-target.ts';` and `export { RemoteConfigSchema, type RemoteConfig };` (re-export so `claude-windows.yaml`'s `remote` field still validates and existing importers keep working). KEEP the `remote: RemoteConfigSchema.optional()` field. Add `os_support: z.array(z.string()).default(['linux']),`. (The old `win_superpowers_dir` is gone from RemoteConfig; if `claude-windows.yaml`'s remote block sets it, zod will now reject the unknown key — so also remove `win_superpowers_dir`/`win_run_root` extras from `claude-windows.yaml`'s remote block if present, leaving only known keys. Verify by loading it.)
- [ ] **Step 6: `coding-agents/claude.yaml`** — add `os_support: [linux, windows]`.
- [ ] **Step 7: run + check** — `bun test test/os-target.test.ts` PASS; update any import of `RemoteConfigSchema` that should now point at os-target ONLY if it breaks (the re-export means it need not change); `bun run check` GREEN.
- [ ] **Step 8: commit** `feat(os): additive os-target contracts + agent os_support`.

---

## Task 2: `WindowsHost.writeFileBase64` (quoting-safe + secret-safe)

**Files:** Modify `src/agents/windows-host.ts`; Test `test/windows-host-writefile.test.ts`.
**Interfaces produced:** `writeFileBase64(winPath: string, content: string, opts?: { secret?: boolean }): void` — base64-decode write over `ssh`; throws on non-zero; `opts.secret` redacts content+b64 from the error.

- [ ] **Step 1: failing test** `test/windows-host-writefile.test.ts`
```ts
import { describe, expect, test } from 'bun:test';
import type { CommandResult, CommandRunner } from '../src/agents/command-runner.ts';
import { RemoteConfigSchema } from '../src/contracts/os-target.ts';
import { WindowsHost } from '../src/agents/windows-host.ts';
class FakeRunner implements CommandRunner {
  calls: { command: string; args: string[] }[] = [];
  result: CommandResult = { status: 0, stdout: '', stderr: '' };
  run(c: string, a: readonly string[]): CommandResult { this.calls.push({ command: c, args: [...a] }); return this.result; }
}
const remote = RemoteConfigSchema.parse({ password_env: 'WIN_EVAL_PASSWORD' });
describe('writeFileBase64', () => {
  test('sends base64 + FromBase64String, never raw content', () => {
    Bun.env['WIN_EVAL_PASSWORD'] = 'password';
    const r = new FakeRunner(); const json = '{"a":"b\'c"}';
    new WindowsHost(remote, r).writeFileBase64('C:\\x\\f.json', json);
    const argv = r.calls[0]!.args.join(' ');
    expect(argv).toContain('FromBase64String');
    expect(argv).toContain(Buffer.from(json, 'utf8').toString('base64'));
    expect(argv).not.toContain(json);
  });
  test('secret write redacts content + b64 from error', () => {
    Bun.env['WIN_EVAL_PASSWORD'] = 'password';
    const r = new FakeRunner(); r.result = { status: 1, stdout: '', stderr: 'boom' };
    const secret = 'sk-ant-SECRET'; const body = `set KEY=${secret}`;
    try { new WindowsHost(remote, r).writeFileBase64('C:\\x\\launch.cmd', body, { secret: true }); expect(true).toBe(false); }
    catch (e) {
      const m = String((e as Error).message);
      expect(m).not.toContain(secret); expect(m).not.toContain(Buffer.from(body).toString('base64'));
    }
  });
});
```
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: implement** (add to the class):
```ts
  // Quoting-safe + secret-safe guest write: base64 the content (chars [A-Za-z0-9+/=]
  // only, so it never breaks the PowerShell single-quote literal), decode on the
  // guest. Raw content/secrets never appear in argv. opts.secret redacts the error.
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
- [ ] **Step 4: run + check** — PASS; `bun run check` GREEN.
- [ ] **Step 5: commit** `feat(windows): WindowsHost.writeFileBase64 (quoting/secret-safe)`.

---

## Task 3: WindowsClaudeAgent — per-run plugin dir + base64 writes + `remote` as ctor arg (/par #1,#2,#3)

**Files:** Modify `src/agents/claude-windows.ts`, `src/agents/index.ts` (the ONE caller); Test `test/claude-windows-agent.test.ts`.
**Interfaces produced:** `new WindowsClaudeAgent(config, remote: RemoteConfig)` (was `(config)` reading `cfg.remote`). `winPaths(...).superpowers = winJoin(runRoot,'superpowers')` (per-run). `provision` writes `.claude.json` + `launch.cmd` via `writeFileBase64`, scp's superpowers into the per-run dir (no shared `Remove-Item`).

- [ ] **Step 1: update test** `test/claude-windows-agent.test.ts` — construct `new WindowsClaudeAgent(cfg, remote)` (cfg = load `claude-windows` for now, which still exists; or `claude` — either has a model). Assert: `$WIN_LAUNCH_CMD` contains `eval-runs\\${runId}\\launch.cmd`; the issued commands contain `FromBase64String` and `eval-runs\\${runId}\\superpowers`; and do NOT contain `Remove-Item -Recurse -Force C:\\eval-superpowers`.
- [ ] **Step 2: FAIL** (ctor signature changed).
- [ ] **Step 3: implement** `src/agents/claude-windows.ts`:
  - Constructor → explicit fields `config` + `remote: RemoteConfig`, assigned in body (erasableSyntaxOnly). Delete the `this.remote()` getter that read `cfg.remote`; use `this.remote`.
  - `winPaths`: `superpowers: winJoin(runRoot, 'superpowers')` (drop `remote.win_superpowers_dir`).
  - `provision` Step 1 New-Item unchanged (only `…\home\.claude`).
  - `.claude.json`: build the JSON string, then `host.writeFileBase64(winJoin(p.home,'.claude','.claude.json'), claudeJson)`.
  - `launch.cmd`: build the `launchCmd` string (its `--plugin-dir` now `p.superpowers`), then `host.writeFileBase64(p.launchCmd, launchCmd, { secret: true })`.
  - superpowers: REMOVE the shared-dir `Remove-Item` + the old rsync/scp-to-shared. Replace with `const sync = host.scpTo(sp, p.superpowers); if (sync.status !== 0) throw new ProvisionError(\`superpowers scp to guest failed: ${sync.stderr}\`);` (per-run dest absent + parent runRoot exists → scp lands contents at `p.superpowers`; validated live). Keep the `SUPERPOWERS_ROOT` guard.
  - `RemoteExecution` ctor already takes `remote` — unchanged.
  - `src/agents/index.ts`: the windows branch of resolveAgent (still keyed on `cfg.remote` here until Task 5/6) constructs `new WindowsClaudeAgent(config, config.remote!)`. (cfg.remote still exists → green.)
- [ ] **Step 4: run + check** — focused PASS; `bun run check` GREEN.
- [ ] **Step 5: commit** `feat(windows): per-run plugin dir + base64 writes; remote as ctor arg (/par #1,#2,#3)`.

---

## Task 4: Capture hardening — safe-swap + no-log tolerance (/par #5,#7)

**Files:** Modify `src/agents/claude-windows.ts` (`RemoteExecution.captureBack`); Test `test/claude-windows-agent.test.ts`.
**Interfaces produced:** `captureBack` tolerates a missing guest `projects` (empty capture, no throw) and pulls the workdir to a temp sibling, swapping only on success.

> **Controller resolution (test design):** the no-log test's FakeRunner must return `status:1, stderr:'... No such file or directory'` for BOTH the projects scp AND the workdir scp (a fully-crashed run), so captureBack returns early without a `renameSync` of a dir the fake never created. Add a SEPARATE happy-path test only if you make the fake actually create `<tmp>/coding-agent-workdir` on disk first.

- [ ] **Step 1: test** `test/claude-windows-agent.test.ts`
```ts
test('captureBack tolerates a fully-missing guest (no-log run), workdir untouched', () => {
  Bun.env['WIN_EVAL_PASSWORD'] = 'password';
  const home = mkdtempSync(join(tmpdir(),'h-')); const wd = mkdtempSync(join(tmpdir(),'w-'));
  writeFileSync(join(wd,'fixture.txt'),'orig');
  const r = new (class implements CommandRunner {
    run(_c:string,_a:readonly string[]):CommandResult{ return { status:1, stdout:'', stderr:'scp: No such file or directory' }; }
  })();
  expect(() => new RemoteExecution(remote, r).captureBack(home, wd, 'abc')).not.toThrow();
  expect(readFileSync(join(wd,'fixture.txt'),'utf8')).toBe('orig');
});
```
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: implement** — rewrite `captureBack` (add `mkdirSync`, `renameSync` to the `node:fs` import):
```ts
  captureBack(localRunHomeDir: string, localWorkdir: string, runId: string): void {
    const p = winPaths(this.remote, runId);
    mkdirSync(join(localRunHomeDir, '.claude'), { recursive: true });
    const logs = this.host.scpFrom(winJoin(p.home, '.claude', 'projects'), join(localRunHomeDir, '.claude'));
    if (logs.status !== 0 && !/no such file|not exist/i.test(logs.stderr)) {
      throw new Error(`capture session logs from guest failed: ${logs.stderr}`);
    }
    const tmp = `${localWorkdir}.incoming-${runId}`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    const wd = this.host.scpFrom(p.workdir, tmp);
    if (wd.status !== 0) {
      rmSync(tmp, { recursive: true, force: true });
      if (/no such file|not exist/i.test(wd.stderr)) return;
      throw new Error(`capture workdir from guest failed: ${wd.stderr}`);
    }
    rmSync(localWorkdir, { recursive: true, force: true });
    renameSync(join(tmp, 'coding-agent-workdir'), localWorkdir);
    rmSync(tmp, { recursive: true, force: true });
  }
```
- [ ] **Step 4: run + check** — PASS; `bun run check` GREEN.
- [ ] **Step 5: commit** `fix(windows): capture safe-swap + no-log tolerance (/par #5,#7)`.

---

## Task 5: `resolveAgent(cfg, os, osTarget)` — defaulted, green

**Files:** Modify `src/agents/index.ts`; Test `test/agent-config.test.ts` (or `test/resolve-agent.test.ts`).
**Interfaces produced:** `resolveAgent(config, os: string = 'linux', osTarget?: OsTarget)`. `os==='linux'` → today's resolution (unchanged). `os==='windows'` + family `claude` → `new WindowsClaudeAgent(config, osTarget!.remote!)`. `os!=='linux'` + unsupported family → throws `ProvisionError`. Default `os='linux'` keeps the existing `resolveAgent(cfg)` callers compiling.

- [ ] **Step 1: test** — `resolveAgent(claudeCfg)` (no os) → ClaudeAgent (linux); `resolveAgent(claudeCfg,'windows',{name:'windows',remote})` → WindowsClaudeAgent; `resolveAgent(codexCfg,'windows',{...})` → throws.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: implement** — add the `(family, os)` windows branch; keep the linux branch as the existing body. Remove the v1 `cfg.remote !== undefined` selection (the windows construction now comes via the `os` arg, not `cfg.remote`).
- [ ] **Step 4: run + check** — GREEN (existing `resolveAgent(cfg)` calls still compile via the default).
- [ ] **Step 5: commit** `feat(os): resolveAgent(cfg, os, osTarget)`.

---

## Task 6: Runner — os threading, run-id, context-dir, os-gating, capture-stage, teardown (/par #4,#6)

**Files:** Modify `src/runner/index.ts`; Test `test/runner-windows-hooks.test.ts`, `test/runner-unit.test.ts`.
**Interfaces produced:** `RunScenarioArgs.os?: string` (default `linux` in `runScenario`); `allocateRunDir(outRoot, scenario, agent, os = 'linux')` → id includes os; `contextDirName(cfg, os)`; the three hooks gate on `os !== 'linux'`; capture-back wrapped to a `capture`-stage indeterminate; guest teardown in `finally` when `os !== 'linux'`.

- [ ] **Step 1: tests** — `contextDirName({name:'claude',runtime_family:'claude'},'windows')` → `'claude-windows'`, `…,'linux'` → `'claude'`; `allocateRunDir('/out','sc','claude','windows')` id contains `-claude-windows-`.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: implement** (every new branch defaults to the linux/no-op path so the suite stays green):
  - `allocateRunDir`: add `os = 'linux'` param; id `` `${scenario}-${agent}-${os}-${nowStampUtc()}-${hexNonce()}` ``. Update the call → `allocateRunDir(a.outRoot, scenario, a.codingAgent, a.os ?? 'linux')`.
  - `RunScenarioArgs`: add `readonly os?: string`. In `runScenario` compute `const os = a.os ?? 'linux'`.
  - Load os-target: `const osTarget = loadOsTarget(join(repoRoot(),'os-targets'), os)`; validate `os ∈ cfg.os_support` else a setup `RunnerError`.
  - `resolveAgent(cfg, os, osTarget)`.
  - `contextDirName(cfg, os)`: `os === 'linux' ? (cfg.runtime_family ?? cfg.name) : `${cfg.runtime_family ?? cfg.name}-${os}``. Replace the v1 `isRemote = cfg.remote !== undefined` with `isRemote = os !== 'linux'`; the env-file/`$CLAUDE_MODEL` block gates on `!isRemote`; `forbiddenPlaceholders` `[]` when remote.
  - The three hooks: replace `cfg.remote !== undefined` with `os !== 'linux'`; construct `RemoteExecution(osTarget.remote!, defaultCommandRunner)`.
  - Capture-back (/par #6): wrap the `captureBack(...)` call in try/catch; on throw `return writeIndeterminate({ finalReason:\`capture: ${e.message}\`, gauntlet, checks: pre.records, error:{ stage:'capture', message:(e as Error).message } })`.
  - Guest teardown (/par #4): in the `finally` (line ~927) after `cleanupAgentRuntime(cleanupDirs)`, when `os !== 'linux'` && `osTarget.remote`, best-effort try/catch `new WindowsHost(osTarget.remote, defaultCommandRunner).ssh(\`powershell -NoProfile -Command "Remove-Item -Recurse -Force '${winJoin(osTarget.remote.win_run_root, basename(runDir))}' -ErrorAction SilentlyContinue"\`)`. (Import `winJoin`? It's in claude-windows.ts; either export it or inline `root + '\\' + basename(runDir)`.) Teardown failure must not mask the verdict.
- [ ] **Step 4: run + check** — GREEN (os defaults linux → all gates skip; existing tests unchanged).
- [ ] **Step 5: commit** `feat(os): runner os threading, run-id/context-dir by os, capture-stage + teardown (/par #4,#6)`.

---

## Task 7: CLI `--os` flag on `run`/`show`/`costs`

**Files:** Modify `src/cli/*` (the `run` parser); Test the CLI/runner test that drives `run`.
**Interfaces produced:** `quorum run <scenario> --coding-agent <a> --os <linux|windows>` (default `linux`) → `RunScenarioArgs.os`.

- [ ] **Step 1: test** — `--os windows` reaches `RunScenarioArgs.os`; default `linux`.
- [ ] **Step 2–4:** find where `--coding-agent` is parsed in `src/cli/` (grep `coding-agent`), add `--os` (default `linux`) beside it, thread to `runScenario`. Audit `show`/`costs` run-dir-name parsing for any `split('-')` assuming the old `<scenario>-<agent>-<stamp>` shape; adjust for the extra `-<os>-` segment. `bun run check` GREEN.
- [ ] **Step 5: commit** `feat(cli): --os flag on run/show/costs`.

---

## Task 8: Removal cleanup (NOW safe — nothing reads the old path)

**Files:** Modify `src/contracts/agent-config.ts` (remove `remote` + its re-export if unused elsewhere), `test/*` (retarget windows tests off `claude-windows.yaml`); Delete `coding-agents/claude-windows.yaml`.

- [ ] **Step 1:** grep `cfg.remote`, `\.remote` on AgentConfig, and `claude-windows.yaml` across `src/` + `test/`. Confirm NOTHING in `src/` reads `cfg.remote` anymore (resolveAgent uses the os arg; runner gates on os; WindowsClaudeAgent takes remote as ctor arg). Remove the `remote: RemoteConfigSchema.optional()` field from `AgentConfigSchema`. Keep the `RemoteConfigSchema` re-export only if a test still imports it from agent-config; otherwise drop it and fix imports to point at `os-target.ts`.
- [ ] **Step 2:** retarget tests that loaded `coding-agents/claude-windows.yaml` — `test/claude-windows-agent.test.ts` should load the `claude` agent + construct with an explicit `RemoteConfigSchema.parse(...)` remote (Task 3 already moved to `(cfg, remote)` construction). Remove the v1 `agent-config.test.ts` `remote`-block case (the block no longer exists on AgentConfig); keep/adjust the `os_support` cases.
- [ ] **Step 3:** `git rm coding-agents/claude-windows.yaml`.
- [ ] **Step 4: run + check** — `bun run check` GREEN; `bun run quorum check` (scenario validation) passes with no `claude-windows.yaml`.
- [ ] **Step 5: commit** `refactor(os): remove cfg.remote + claude-windows.yaml (migrated to --os)`.

---

## Task 9: Docs + live re-validation

**Files:** Modify `docs/windows/eval-runtime.md` (`--coding-agent claude --os windows`; per-run dirs; the live deployment facts: Mac + sshpass + tunnel, rsync-absent→scp, `-tt` rule), `README.md`; Create `docs/experiments/2026-06-18-os-target-windows-bringup.md`.

- [ ] **Step 1:** rewrite the operator doc for the `--os` interface + live-validated facts (no `claude-windows` agent).
- [ ] **Step 2: static gates** — `bun run check`, `bun run quorum check`.
- [ ] **Step 3: live (trusted-maintainer, Mac orchestrator + tunnel)** — re-run the two smokes:
```bash
export WIN_EVAL_PASSWORD=password ANTHROPIC_API_KEY=… SUPERPOWERS_ROOT=<staged .git-free tree>
# tunnel: ssh -fN -L 127.0.0.1:2222:127.0.0.1:2222 <kvm-host>
bun run quorum run scenarios/00-quorum-smoke-hello-world --coding-agent claude --os windows
bun run quorum run scenarios/triggering-test-driven-development --coding-agent claude --os windows
```
Expected: both `final pass`; run-ids contain `-claude-windows-`; the guest `C:\eval-runs\<id>` is gone after each run (teardown); no API key in any `verdict.json`.
- [ ] **Step 4:** record results in the experiment doc; commit.

---

## Self-Review

**Greenness:** Each task ends green — T1 is additive (re-export keeps `cfg.remote` valid); T3 changes the ctor but updates its one caller (still sourcing `cfg.remote`); T5 defaults `os='linux'`; T6 defaults `os`/`RunScenarioArgs.os` to linux so every gate is a no-op for existing callers/tests; removals are isolated to T8 once T5/T6/T3 have migrated every reader. Verified: after T7, the only `cfg.remote` reads remaining are eliminated (resolveAgent uses the os arg, runner gates on os, WindowsClaudeAgent takes remote as arg) — so T8's removal compiles.

**Spec coverage:** os-target + linux built-in (T1); os_support + migration/delete (T1/T8); `resolveAgent(cfg,os)` (T5); runner os-gating + run-id + context-dir (T6); CLI `--os` (T7). /par fixes: #1 per-run dir (T3), #2/#3 secret/quoting-safe writes (T2+T3), #4 teardown (T6), #5/#7 capture (T4), #6 capture-stage (T6). Live (T9). run-all/dashboard = Plan 2.

**Placeholder scan:** no TBD/TODO; code shown per step; seams cited (`allocateRunDir`, the `finally` ~:927, the CLI `--coding-agent` parser) as concrete find-targets.

**Type consistency:** `RemoteConfig`/`OsTarget` (T1) used identically in T2/T3/T5/T6; `WindowsClaudeAgent(config, remote)` (T3) matches the T5 construction; `writeFileBase64(winPath,content,opts?)` (T2) matches T3 calls; `contextDirName(cfg,os)` (T6) matches its tests; `winPaths(...).superpowers` per-run is the single source for provision + the launch.cmd `--plugin-dir`.
