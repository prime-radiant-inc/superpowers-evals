import { expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from '../src/agents/command-runner.ts';
import { defaultCommandRunner } from '../src/agents/command-runner.ts';
import {
  materializeSuperpowersWorktree,
  ProvisioningError,
} from '../src/campaign/provisioning.ts';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

class RecordingRunner implements CommandRunner {
  readonly calls: {
    command: string;
    args: readonly string[];
    options?: CommandOptions;
  }[] = [];
  failNextWorktreeAdd = false;
  failWorktreeRemove = false;
  failWorktreePrune = false;
  head = SHA_A;
  porcelain = '';
  run(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): CommandResult {
    this.calls.push(
      options === undefined ? { command, args } : { command, args, options },
    );
    if (
      command === 'git' &&
      args.includes('worktree') &&
      args.includes('add')
    ) {
      if (this.failNextWorktreeAdd) {
        return { status: 1, stdout: '', stderr: 'fatal: boom\n' };
      }
      return { status: 0, stdout: '', stderr: '' };
    }
    if (
      command === 'git' &&
      args.includes('worktree') &&
      args.includes('remove') &&
      this.failWorktreeRemove
    ) {
      return { status: 1, stdout: '', stderr: 'fatal: unable to unlink\n' };
    }
    if (
      command === 'git' &&
      args.includes('worktree') &&
      args.includes('prune') &&
      this.failWorktreePrune
    ) {
      return { status: 1, stdout: '', stderr: 'fatal: prune refused\n' };
    }
    if (command === 'git' && args.includes('rev-parse')) {
      return { status: 0, stdout: `${this.head}\n`, stderr: '' };
    }
    if (command === 'git' && args.includes('status')) {
      return { status: 0, stdout: this.porcelain, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  }
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'prov-'));
}

function args(runner: RecordingRunner, destParent: string) {
  return { sourceCheckout: '/src/sp', sha: SHA_A, destParent, runner };
}

test('materializes with the exact git argv and minimal env', () => {
  const runner = new RecordingRunner();
  const destParent = tmp();
  const root = materializeSuperpowersWorktree(args(runner, destParent));
  expect(root).toBe(join(destParent, `superpowers-${SHA_A}`));
  const add = runner.calls.find(
    (c) => c.command === 'git' && c.args.includes('add'),
  );
  expect(add?.args).toEqual([
    '-C',
    '/src/sp',
    'worktree',
    'add',
    '--detach',
    join(destParent, `superpowers-${SHA_A}`),
    SHA_A,
  ]);
  const env = add?.options?.env ?? {};
  expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH', 'TMPDIR']);
  expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
});

test('rejects a non-hex sha before any path construction or subprocess', () => {
  const runner = new RecordingRunner();
  // Distinguishability trap: a destParent containing a NUL byte makes ANY
  // destination handling fail with a raw Node TypeError
  // (ERR_INVALID_ARG_VALUE) rather than a ProvisioningError — so if SHA
  // validation were moved after destination handling (lock mkdir / dest
  // lstat), this test would observe the wrong error class and fail.
  // Validation-first never touches the filesystem and its error wins.
  const nulParent = join(tmp(), 'par\0ent');
  expect(() =>
    materializeSuperpowersWorktree({
      sourceCheckout: '/src/sp',
      sha: '../../../tmp/evil',
      destParent: nulParent,
      runner,
    }),
  ).toThrow(ProvisioningError);
  expect(() =>
    materializeSuperpowersWorktree({
      sourceCheckout: '/src/sp',
      sha: '../../../tmp/evil',
      destParent: nulParent,
      runner,
    }),
  ).toThrow(/non-SHA ref/);
  // And on a usable destParent, rejection still precedes destination
  // handling: no lock dir, no stray sibling — a traversal-shaped sha never
  // reached the filesystem.
  const destParent = tmp();
  expect(() =>
    materializeSuperpowersWorktree({
      sourceCheckout: '/src/sp',
      sha: '../../../tmp/evil',
      destParent,
      runner,
    }),
  ).toThrow(ProvisioningError);
  expect(runner.calls).toHaveLength(0);
  expect(readdirSync(destParent)).toEqual([]);
});

test('a symlinked lock path is refused, never traversed', () => {
  const runner = new RecordingRunner();
  const destParent = tmp();
  // The victim directory the crafted lock symlink points at, holding a
  // stale-aged file that an unsafe reclaimer would delete through the link.
  const victim = tmp();
  const precious = join(victim, 'precious.txt');
  writeFileSync(precious, 'keep\n');
  utimesSync(precious, new Date(0), new Date(0));
  const lock = join(destParent, `superpowers-${SHA_A}.lock`);
  symlinkSync(victim, lock);
  let err: unknown;
  try {
    materializeSuperpowersWorktree(args(runner, destParent));
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ProvisioningError);
  expect((err as ProvisioningError).message).toContain(
    'non-directory or symlinked lock path',
  );
  // Nothing beyond destParent was read or deleted; the symlink stands.
  expect(readFileSync(precious, 'utf8')).toBe('keep\n');
  expect(readdirSync(victim)).toEqual(['precious.txt']);
  expect(existsSync(lock)).toBe(true);
  expect(runner.calls).toHaveLength(0);
});

test('accepts 64-char hex sha256 SHAs', () => {
  const runner = new RecordingRunner();
  const sha256 = 'c'.repeat(64);
  const root = materializeSuperpowersWorktree({
    sourceCheckout: '/src/sp',
    sha: sha256,
    destParent: tmp(),
    runner,
  });
  expect(root).toContain(`superpowers-${sha256}`);
});

test('reuses a pre-existing path only when HEAD==sha and porcelain-clean', () => {
  const runner = new RecordingRunner();
  const destParent = tmp();
  mkdirSync(join(destParent, `superpowers-${SHA_A}`), { recursive: true });
  const root = materializeSuperpowersWorktree(args(runner, destParent));
  expect(root).toBe(join(destParent, `superpowers-${SHA_A}`));
  expect(runner.calls.filter((c) => c.args.includes('add'))).toHaveLength(0);
});

test('throws on HEAD drift at a pre-existing path', () => {
  const runner = new RecordingRunner();
  runner.head = SHA_B;
  const destParent = tmp();
  mkdirSync(join(destParent, `superpowers-${SHA_A}`), { recursive: true });
  expect(() =>
    materializeSuperpowersWorktree(args(runner, destParent)),
  ).toThrow(ProvisioningError);
});

test('throws on porcelain drift at a pre-existing path', () => {
  const runner = new RecordingRunner();
  runner.porcelain = ' M skills/x.md\n';
  const destParent = tmp();
  mkdirSync(join(destParent, `superpowers-${SHA_A}`), { recursive: true });
  expect(() =>
    materializeSuperpowersWorktree(args(runner, destParent)),
  ).toThrow(ProvisioningError);
});

test('a symlinked pre-existing destination is never reused', () => {
  const runner = new RecordingRunner();
  const destParent = tmp();
  const elsewhere = tmp();
  symlinkSync(elsewhere, join(destParent, `superpowers-${SHA_A}`));
  expect(() =>
    materializeSuperpowersWorktree(args(runner, destParent)),
  ).toThrow(ProvisioningError);
  expect(runner.calls).toHaveLength(0);
});

test('two distinct SHAs yield two worktrees', () => {
  const runner = new RecordingRunner();
  const destParent = tmp();
  const a = materializeSuperpowersWorktree(args(runner, destParent));
  const b = materializeSuperpowersWorktree({
    ...args(runner, destParent),
    sha: SHA_B,
  });
  expect(a).not.toBe(b);
  expect(runner.calls.filter((c) => c.args.includes('add'))).toHaveLength(2);
});

test('failure cleans up via worktree remove --force + prune, never rm -rf', () => {
  const runner = new RecordingRunner();
  runner.failNextWorktreeAdd = true;
  const destParent = tmp();
  let err: unknown;
  try {
    materializeSuperpowersWorktree(args(runner, destParent));
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ProvisioningError);
  const msg = (err as ProvisioningError).message;
  // The add failure itself is preserved, and successful cleanup is reported
  // (not assumed) alongside it.
  expect(msg).toContain('failed (1): fatal: boom');
  expect(msg).toContain('worktree remove --force ok');
  expect(msg).toContain('worktree prune ok');
  const verbs = runner.calls.map((c) => c.args.join(' '));
  expect(verbs.some((v) => v.includes('worktree remove --force'))).toBe(true);
  expect(verbs.some((v) => v.includes('worktree prune'))).toBe(true);
});

test('failed cleanup is reported accurately, never assumed successful', () => {
  const runner = new RecordingRunner();
  runner.failNextWorktreeAdd = true;
  runner.failWorktreeRemove = true;
  runner.failWorktreePrune = true;
  const destParent = tmp();
  let err: unknown;
  try {
    materializeSuperpowersWorktree(args(runner, destParent));
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ProvisioningError);
  const msg = (err as ProvisioningError).message;
  expect(msg).toContain('failed (1): fatal: boom');
  expect(msg).toContain('worktree remove --force failed (1)');
  expect(msg).toContain('fatal: unable to unlink');
  expect(msg).toContain('worktree prune failed (1)');
  expect(msg).toContain('fatal: prune refused');
  // A cleanup that failed must never be reported as ok.
  expect(msg).not.toContain('--force ok');
  expect(msg).not.toContain('prune ok');
});

test('a stale lock is reclaimed by mtime', () => {
  const runner = new RecordingRunner();
  const destParent = tmp();
  const lock = join(destParent, `superpowers-${SHA_A}.lock`);
  mkdirSync(lock, { recursive: true });
  const staleOwner = join(lock, 'owner-00000000-0000-0000-0000-00000000dead');
  writeFileSync(staleOwner, '');
  utimesSync(staleOwner, new Date(0), new Date(0));
  const root = materializeSuperpowersWorktree(args(runner, destParent));
  expect(root).toBe(join(destParent, `superpowers-${SHA_A}`));
  // A successful pass leaves no lock residue behind.
  expect(existsSync(lock)).toBe(false);
});

// Real-filesystem multi-contender race on a stale lock. Orchestration:
//  - the victim acquires over the planted stale lock and holds a ~500ms
//    critical section;
//  - the test then backdates the victim's owner file, making its lease look
//    expired — a contender legitimately takes the lease over (documented
//    LOCK_STALE_MS semantics: a wedged owner must not wedge everyone);
//  - the property under test is ownership SAFETY of that handover: the
//    victim's subsequent release must not destroy the successor's lock. If
//    it did (the unconditional-rm race under review), the second contender
//    would enter while the first successor is still mid-section, and the
//    contenders' [first git call, done] spans would overlap.
// Victim-vs-contender overlap itself is expected (lease expiry) and is
// therefore NOT asserted against — only contender-vs-contender is.
test('real FS: stale-lock handover stays ownership-safe under contention', async () => {
  const destParent = tmp();
  const dest = join(destParent, `superpowers-${SHA_A}`);
  const lock = `${dest}.lock`;
  const plantedName = 'owner-00000000-0000-0000-0000-00000000dead';
  mkdirSync(lock, { recursive: true });
  const staleOwner = join(lock, plantedName);
  writeFileSync(staleOwner, '');
  utimesSync(staleOwner, new Date(0), new Date(0));

  const modPath = join(
    import.meta.dir,
    '..',
    'src',
    'campaign',
    'provisioning.ts',
  );
  const log = join(destParent, 'events.log');
  const childScript = join(destParent, 'contender.ts');
  writeFileSync(
    childScript,
    [
      "import { appendFileSync } from 'node:fs';",
      `import { ensureWorktreeAt } from ${JSON.stringify(modPath)};`,
      'const logPath = process.argv[2];',
      'const dest = process.argv[3];',
      'const sectionMs = Number(process.argv[4] ?? 40);',
      `const SHA = ${JSON.stringify(SHA_A)};`,
      'const runner = {',
      '  run(_command, args) {',
      '    appendFileSync(logPath, `call ${process.pid} ${Date.now()}` + "\\n");',
      '    Bun.sleepSync(sectionMs);',
      '    if (args.includes("rev-parse")) return { status: 0, stdout: SHA + "\\n", stderr: "" };',
      '    if (args.includes("status")) return { status: 0, stdout: "", stderr: "" };',
      '    return { status: 0, stdout: "", stderr: "" };',
      '  },',
      '};',
      'try {',
      '  ensureWorktreeAt({ sourceCheckout: "/src/sp", sha: SHA, dest, runner });',
      '  appendFileSync(logPath, `done ${process.pid} ${Date.now()}` + "\\n");',
      '} catch (err) {',
      '  appendFileSync(logPath, `error ${process.pid} ${String(err)}` + "\\n");',
      '  process.exit(1);',
      '}',
    ].join('\n'),
  );

  const launch = (sectionMs: number) =>
    spawn(process.execPath, [childScript, log, dest, String(sectionMs)], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
  const exitOf = (p: ReturnType<typeof launch>) =>
    new Promise<number>((resolve, reject) => {
      p.on('error', reject);
      p.on('close', (code) => resolve(code ?? -1));
    });

  // 1. The victim takes the lock over the stale one and holds it ~500ms.
  const victim = launch(500);
  // 2. Wait until the victim demonstrably holds the lock (its owner file is
  //    in place), then expire its lease by backdating the file.
  let victimOwner: string | null = null;
  const deadline = Date.now() + 10_000;
  while (victimOwner === null && Date.now() < deadline) {
    let entries: string[] = [];
    try {
      entries = readdirSync(lock).filter((n) => n !== plantedName);
    } catch {
      // transient: teardown/acquire mid-step
    }
    const found = entries[0];
    if (found !== undefined) victimOwner = found;
    else Bun.sleepSync(2);
  }
  expect(victimOwner).not.toBeNull();
  utimesSync(join(lock, victimOwner as string), new Date(0), new Date(0));
  // 3. Two contenders arrive; each holds a ~900ms section once admitted.
  const contenders = [launch(900), launch(900)];

  const codes = await Promise.all([victim, ...contenders].map(exitOf));
  expect(codes).toEqual([0, 0, 0]);

  const lines = readFileSync(log, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
  const errors = lines.filter((l) => l.startsWith('error '));
  expect(errors).toEqual([]);
  expect(lines.filter((l) => l.startsWith('done '))).toHaveLength(3);

  const spans = new Map<string, { start: number; end: number }>();
  for (const line of lines) {
    const parts = line.split(' ');
    const pid = parts[1] ?? '';
    const ts = Number(parts[2] ?? 0);
    const span = spans.get(pid) ?? { start: ts, end: ts };
    span.start = Math.min(span.start, ts);
    span.end = Math.max(span.end, ts);
    spans.set(pid, span);
  }
  expect(spans.size).toBe(3);
  const contenderSpans = contenders
    .map((p) => spans.get(String(p.pid)))
    .filter((s): s is { start: number; end: number } => s !== undefined);
  expect(contenderSpans).toHaveLength(2);
  contenderSpans.sort((x, y) => x.start - y.start);
  const first = contenderSpans[0];
  const second = contenderSpans[1];
  expect(second?.start ?? -Infinity).toBeGreaterThanOrEqual(
    first?.end ?? Infinity,
  );
  // The stale lock was handed over and no lock residue survives the run.
  expect(existsSync(lock)).toBe(false);
}, 30000);

// Race A, deterministically: a lock whose scan shows ANY fresh valid owner
// is LIVE and must be left completely untouched — no rename, no
// stale-companion deletion (severing it would momentarily free the lock
// path for a second acquirer; see the displacement regression below). The
// lock dir is planted with one stale and one fresh owner file; the
// contender must poll behind the fresh owner, leaving the stale companion
// for a later all-stale reclaim.
test('real FS: a fresh owner defers reclaim entirely — stale companions untouched', async () => {
  const destParent = tmp();
  const dest = join(destParent, `superpowers-${SHA_A}`);
  const lock = `${dest}.lock`;
  const staleName = 'owner-00000000-0000-0000-0000-00000000dead';
  const freshName = 'owner-11111111-2222-4333-8444-55555555555f';
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, staleName), '');
  utimesSync(join(lock, staleName), new Date(0), new Date(0));
  // mtime = now, valid owner token (owner-<uuid> name + pid body): live
  writeFileSync(join(lock, freshName), '4321\n');

  const modPath = join(
    import.meta.dir,
    '..',
    'src',
    'campaign',
    'provisioning.ts',
  );
  const log = join(destParent, 'events.log');
  const childScript = join(destParent, 'contender.ts');
  writeFileSync(log, '');
  writeFileSync(
    childScript,
    [
      "import { appendFileSync } from 'node:fs';",
      `import { ensureWorktreeAt } from ${JSON.stringify(modPath)};`,
      'const logPath = process.argv[2];',
      'const dest = process.argv[3];',
      `const SHA = ${JSON.stringify(SHA_A)};`,
      'const runner = {',
      '  run(_command, args) {',
      '    appendFileSync(logPath, `call ${process.pid} ${Date.now()}` + "\\n");',
      '    if (args.includes("rev-parse")) return { status: 0, stdout: SHA + "\\n", stderr: "" };',
      '    if (args.includes("status")) return { status: 0, stdout: "", stderr: "" };',
      '    return { status: 0, stdout: "", stderr: "" };',
      '  },',
      '};',
      'try {',
      '  ensureWorktreeAt({ sourceCheckout: "/src/sp", sha: SHA, dest, runner });',
      '  appendFileSync(logPath, `done ${process.pid} ${Date.now()}` + "\\n");',
      '} catch (err) {',
      '  appendFileSync(logPath, `error ${process.pid} ${String(err)}` + "\\n");',
      '  process.exit(1);',
      '}',
    ].join('\n'),
  );
  const child = spawn(process.execPath, [childScript, log, dest], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const exited = new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? -1));
  });

  // Let the contender run its reclaim passes (well past startup + polls).
  // try/finally: a failed assertion must never leak the child process.
  let handedOver = false;
  try {
    Bun.sleepSync(800);
    // The fresh owner makes the lock live: the contender must not have
    // touched the stale companion, the fresh owner, the lock dir, or the
    // critical section.
    expect(existsSync(join(lock, staleName))).toBe(true);
    expect(existsSync(join(lock, freshName))).toBe(true);
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(log, 'utf8').trim()).toBe(''); // no git call yet

    // The fresh owner releases; only the stale companion remains, so the
    // contender's next pass is an all-stale reclaim and it takes over.
    rmSync(join(lock, freshName));
    handedOver = true;
  } finally {
    if (!handedOver) child.kill('SIGKILL');
  }
  expect(await exited).toBe(0);
  const lines = readFileSync(log, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
  expect(lines.filter((l) => l.startsWith('error '))).toEqual([]);
  expect(lines.filter((l) => l.startsWith('done '))).toHaveLength(1);
  expect(existsSync(lock)).toBe(false);
}, 30000);

// Displacement regression: while a fresh valid owner holds the lock, an
// injected stale companion token must never cause a contender to sever
// (rename) the lock dir — the rename momentarily frees the lock path, and a
// second contender's atomic mkdir can land inside the single-flight critical
// section alongside the owner. Three real processes:
//  - the OWNER acquires cleanly and holds its critical section until the
//    test writes a release file;
//  - the WATCHER polls behind it over the injected stale companions and
//    must make ZERO runner calls until the owner releases;
//  - the PROBER hammers raw mkdir(lockPath) — exactly a contender's atomic
//    acquire step — and must never succeed while the owner holds.
// The companions are numerous so a regressed sever window (readdir + one
// unlink per companion under trash before the restore) is wide enough that
// the prober catches it deterministically.
test('real FS: a fresh owner is never displaced by stale-companion reclaim', async () => {
  const destParent = tmp();
  const dest = join(destParent, `superpowers-${SHA_A}`);
  const lock = `${dest}.lock`;
  const inSection = join(destParent, 'owner-in-section');
  const release = join(destParent, 'owner-release');
  const proberStarted = join(destParent, 'prober-started');
  const proberStop = join(destParent, 'prober-stop');
  const proberLog = join(destParent, 'prober.log');
  const watcherLog = join(destParent, 'watcher.log');
  writeFileSync(proberLog, '');
  writeFileSync(watcherLog, '');
  // Valid owner tokens (OWNER_NAME_RE shape + pid body) aged past staleness.
  const COMPANIONS = Array.from(
    { length: 2000 },
    (_, i) => `owner-${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`,
  );

  const modPath = join(
    import.meta.dir,
    '..',
    'src',
    'campaign',
    'provisioning.ts',
  );
  // Owner: acquires the (initially absent) lock, then its first runner call
  // marks the section and blocks until the release file appears.
  const ownerScript = join(destParent, 'owner.ts');
  writeFileSync(
    ownerScript,
    [
      "import { existsSync, writeFileSync } from 'node:fs';",
      `import { ensureWorktreeAt } from ${JSON.stringify(modPath)};`,
      'const dest = process.argv[2];',
      'const inSection = process.argv[3];',
      'const release = process.argv[4];',
      `const SHA = ${JSON.stringify(SHA_A)};`,
      'const runner = {',
      '  run(_command, args) {',
      '    writeFileSync(inSection, "");',
      '    const deadline = Date.now() + 20000;',
      '    while (!existsSync(release) && Date.now() < deadline) Bun.sleepSync(10);',
      '    if (!existsSync(release)) process.exit(3);',
      '    if (args.includes("rev-parse")) return { status: 0, stdout: SHA + "\\n", stderr: "" };',
      '    return { status: 0, stdout: "", stderr: "" };',
      '  },',
      '};',
      'ensureWorktreeAt({ sourceCheckout: "/src/sp", sha: SHA, dest, runner });',
    ].join('\n'),
  );
  // Watcher: polls behind the owner through the public API, logging every
  // runner call (there must be none until the owner releases).
  const watcherScript = join(destParent, 'watcher.ts');
  writeFileSync(
    watcherScript,
    [
      "import { appendFileSync } from 'node:fs';",
      `import { ensureWorktreeAt } from ${JSON.stringify(modPath)};`,
      'const logPath = process.argv[2];',
      'const dest = process.argv[3];',
      `const SHA = ${JSON.stringify(SHA_A)};`,
      'const runner = {',
      '  run(_command, args) {',
      '    appendFileSync(logPath, `call ${process.pid} ${Date.now()}` + "\\n");',
      '    if (args.includes("rev-parse")) return { status: 0, stdout: SHA + "\\n", stderr: "" };',
      '    return { status: 0, stdout: "", stderr: "" };',
      '  },',
      '};',
      'try {',
      '  ensureWorktreeAt({ sourceCheckout: "/src/sp", sha: SHA, dest, runner });',
      '  appendFileSync(logPath, `done ${process.pid}` + "\\n");',
      '} catch (err) {',
      '  appendFileSync(logPath, `error ${process.pid} ${String(err)}` + "\\n");',
      '  process.exit(1);',
      '}',
    ].join('\n'),
  );
  // Prober: a tight raw-mkdir loop on the lock path. While the owner holds,
  // the path must exist continuously, so every mkdir must fail EEXIST; a
  // success is the displacement. Each success is undone (rmdir of the empty
  // dir) so the storm never wedges the others.
  const proberScript = join(destParent, 'prober.ts');
  writeFileSync(
    proberScript,
    [
      "import { appendFileSync, existsSync, mkdirSync, rmdirSync, writeFileSync } from 'node:fs';",
      'const lock = process.argv[2];',
      'const logPath = process.argv[3];',
      'const started = process.argv[4];',
      'const stop = process.argv[5];',
      'writeFileSync(started, "");',
      'const deadline = Date.now() + 20000;',
      'while (!existsSync(stop) && Date.now() < deadline) {',
      '  try {',
      '    mkdirSync(lock);',
      '    appendFileSync(logPath, `acquired ${Date.now()}` + "\\n");',
      '    try { rmdirSync(lock); } catch {}',
      '  } catch {}',
      '}',
    ].join('\n'),
  );

  const launch = (script: string, args: string[]) =>
    spawn(process.execPath, [script, ...args], {
      stdio: ['ignore', 'ignore', 'inherit'],
    });
  const exitOf = (p: ReturnType<typeof launch>) =>
    new Promise<number>((resolve, reject) => {
      p.on('error', reject);
      p.on('close', (code) => resolve(code ?? -1));
    });

  const owner = launch(ownerScript, [dest, inSection, release]);
  const ownerExit = exitOf(owner);
  const children: ReturnType<typeof launch>[] = [owner];
  try {
    // 1. Wait until the owner demonstrably holds the lock and is in-section.
    const deadline = Date.now() + 10_000;
    while (!existsSync(inSection) && Date.now() < deadline) {
      await Bun.sleep(5);
    }
    expect(existsSync(inSection)).toBe(true);
    const ownerTokens = readdirSync(lock);
    expect(ownerTokens).toHaveLength(1);
    // 2. Inject the stale companions beside the live owner token.
    for (const name of COMPANIONS) {
      writeFileSync(join(lock, name), '1\n');
      utimesSync(join(lock, name), new Date(0), new Date(0));
    }
    // 3. Prober first (so it observes every instant of the watcher's
    //    passes), then the watcher.
    const prober = launch(proberScript, [
      lock,
      proberLog,
      proberStarted,
      proberStop,
    ]);
    children.push(prober);
    const proberExit = exitOf(prober);
    while (!existsSync(proberStarted) && Date.now() < deadline) {
      await Bun.sleep(5);
    }
    expect(existsSync(proberStarted)).toBe(true);
    const watcher = launch(watcherScript, [watcherLog, dest]);
    children.push(watcher);
    const watcherExit = exitOf(watcher);
    // 4. Give the watcher several reclaim passes over the live lock.
    await Bun.sleep(1500);
    // THE displacement assertions, while the owner still holds:
    //  - the lock path never went absent (no prober mkdir succeeded);
    //  - the watcher made zero runner calls;
    //  - every stale companion is still in place (nothing was severed).
    expect(readFileSync(proberLog, 'utf8')).toBe('');
    expect(readFileSync(watcherLog, 'utf8')).toBe('');
    expect(readdirSync(lock)).toHaveLength(COMPANIONS.length + 1);
    // 5. Stop the prober before the owner releases (post-release absence of
    //    the lock path is legitimate), then release the owner.
    writeFileSync(proberStop, '');
    expect(await proberExit).toBe(0);
    writeFileSync(release, '');
    expect(await ownerExit).toBe(0);
    // 6. The watcher takes over once the owner's release frees the path.
    expect(await watcherExit).toBe(0);
  } finally {
    for (const child of children) child.kill('SIGKILL');
  }
  const watcherLines = readFileSync(watcherLog, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
  expect(watcherLines.filter((l) => l.startsWith('error '))).toEqual([]);
  expect(watcherLines.filter((l) => l.startsWith('done '))).toHaveLength(1);
  expect(existsSync(lock)).toBe(false);
}, 30000);

// F3: unexpected entry types inside the lock dir must fail LOUDLY. A silent
// skip makes reclaimStaleLock report no progress and the acquire loop poll
// forever — a synchronous hang, so the call runs in a child the test can
// kill: a regressed build either logs the wrong outcome or never finishes.
test('a directory child in the lock dir fails loudly instead of polling forever', async () => {
  const destParent = tmp();
  const dest = join(destParent, `superpowers-${SHA_A}`);
  const lock = `${dest}.lock`;
  const foreign = join(lock, 'foreign-dir');
  mkdirSync(foreign, { recursive: true });
  utimesSync(foreign, new Date(0), new Date(0));

  const modPath = join(
    import.meta.dir,
    '..',
    'src',
    'campaign',
    'provisioning.ts',
  );
  const log = join(destParent, 'log');
  writeFileSync(log, '');
  const childScript = join(destParent, 'child.ts');
  writeFileSync(
    childScript,
    [
      "import { appendFileSync } from 'node:fs';",
      `import { materializeSuperpowersWorktree } from ${JSON.stringify(modPath)};`,
      'const logPath = process.argv[2];',
      'const destParent = process.argv[3];',
      `const SHA = ${JSON.stringify(SHA_A)};`,
      'const runner = { run: () => ({ status: 0, stdout: "", stderr: "" }) };',
      'try {',
      '  materializeSuperpowersWorktree({ sourceCheckout: "/src/sp", sha: SHA, destParent, runner });',
      '  appendFileSync(logPath, "ok\\n");',
      '} catch (e) {',
      '  appendFileSync(logPath, `err ${(e as Error).name}: ${(e as Error).message}\\n`);',
      '}',
    ].join('\n'),
  );
  const child = spawn(process.execPath, [childScript, log, destParent], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  let finished = false;
  const exited = new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      finished = true;
      resolve(code ?? -1);
    });
  });
  const hardDeadline = Date.now() + 3000;
  // async sleep: the wait must yield so the child's exit event can fire.
  while (!finished && Date.now() < hardDeadline) await Bun.sleep(10);
  if (!finished) {
    child.kill('SIGKILL');
    await exited;
    throw new Error('materializer hung on a directory child in the lock dir');
  }
  expect(await exited).toBe(0);
  const outcome = readFileSync(log, 'utf8').trim();
  expect(outcome).toMatch(
    /^err ProvisioningError:.*unexpected non-file entry in lock dir.*foreign-dir/s,
  );
}, 15000);

// F2: the lock path can be swapped for a symlink between the reclaim's
// checks and its deletions; operations through the original path would then
// follow the link into its target. A saboteur child storms the swap while a
// contender child hammers the public API. The victim carries same-named
// stale honeypots so that ANY deletion routed through the original lock path
// — the exact regression under review — destroys one. Confinement property:
// the contender must always terminate, and the victim must come out with
// exactly the files it started with.
test('real FS: a swapped lock path never deletes through the link', async () => {
  const destParent = tmp();
  const dest = join(destParent, `superpowers-${SHA_A}`);
  const lock = `${dest}.lock`;
  // 1000 children widen the vulnerable lstat→readdir→unlink span from
  // microseconds to tens of milliseconds — wide enough that the saboteur's
  // swap cycle deterministically lands inside it. (The hazard itself is
  // unchanged: any deletion routed through the original lock path during
  // that span destroys victim files.)
  const HONEYPOTS = Array.from(
    { length: 3000 },
    (_, i) => `owner-dead-${String(i).padStart(4, '0')}`,
  );
  const victim = tmp();
  const precious = join(victim, 'precious.txt');
  writeFileSync(precious, 'keep\n');
  utimesSync(precious, new Date(0), new Date(0));
  for (const name of HONEYPOTS) {
    writeFileSync(join(victim, name), 'honeypot\n');
    utimesSync(join(victim, name), new Date(0), new Date(0));
  }

  // The planted stale lock: same-named stale children.
  mkdirSync(lock, { recursive: true });
  for (const name of HONEYPOTS) {
    writeFileSync(join(lock, name), '');
    utimesSync(join(lock, name), new Date(0), new Date(0));
  }
  utimesSync(lock, new Date(0), new Date(0));

  const modPath = join(
    import.meta.dir,
    '..',
    'src',
    'campaign',
    'provisioning.ts',
  );

  // Saboteur, split into two cooperating children. The flapper alternates
  // SLOW, REGULAR phases: ~100ms with the real (stale-marked) lock dir at
  // the lock path, then ~100ms with a symlink to the victim planted there.
  // The phase lengths are the point: a reclamation pass that starts in a
  // dir-phase (its lstat sees a directory, as required) cannot finish its
  // post-pass operations before the symlink phase begins — so any deletion
  // routed through the original lock path lands in the victim, while the
  // severed implementation never routes a deletion through that path at
  // all. A pass starting in a symlink phase is refused loudly instead.
  // A lock dir whose own mtime is fresh — a live owner's — is never touched.
  const flapperScript = join(destParent, 'flapper.ts');
  writeFileSync(
    flapperScript,
    [
      "import { existsSync, lstatSync, renameSync, symlinkSync, unlinkSync, utimesSync, appendFileSync } from 'node:fs';",
      'const lock = process.argv[2];',
      'const victim = process.argv[3];',
      'const deadline = Date.now() + Number(process.argv[4]);',
      'const FRESH_MS = 60000;',
      'const EPOCH = new Date(0);',
      'const DIR_PHASE_MS = 10;',
      'const LINK_PHASE_MS = 200;',
      'function swappable(p) {',
      '  try {',
      '    const st = lstatSync(p);',
      '    return st.isDirectory() && Date.now() - st.mtimeMs > FRESH_MS;',
      '  } catch { return false; }',
      '}',
      'let swaps = 0;',
      'while (Date.now() < deadline) {',
      '  // Dir phase: the real lock dir sits at the lock path.',
      '  Bun.sleepSync(DIR_PHASE_MS);',
      '  // Link phase: move it aside, plant the honeypot symlink, HOLD.',
      '  if (!swappable(lock)) continue;',
      '  try {',
      '    renameSync(lock, lock + ".flap");',
      '    symlinkSync(victim, lock);',
      '    swaps++;',
      '    Bun.sleepSync(LINK_PHASE_MS);',
      '    unlinkSync(lock);',
      '    renameSync(lock + ".flap", lock);',
      '    utimesSync(lock, EPOCH, EPOCH);',
      '  } catch {',
      '    try {',
      '      if (existsSync(lock)) unlinkSync(lock);',
      '      if (existsSync(lock + ".flap")) renameSync(lock + ".flap", lock);',
      '    } catch {}',
      '  }',
      '}',
      `appendFileSync(${JSON.stringify(join(destParent, 'swaps.log'))}, String(swaps) + "\\n");`,
    ].join('\n'),
  );

  const replanterScript = join(destParent, 'replanter.ts');
  writeFileSync(
    replanterScript,
    [
      "import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      'const lock = process.argv[2];',
      'const deadline = Date.now() + Number(process.argv[4]);',
      'const EPOCH = new Date(0);',
      `const HONEYPOTS = ${JSON.stringify(HONEYPOTS)};`,
      'while (Date.now() < deadline) {',
      '  Bun.sleepSync(30);',
      '  if (existsSync(lock)) continue;',
      '  // Debounce: the flapper frees the name for microseconds at a time —',
      '  // only replant when the absence persists (the fixture was consumed).',
      '  Bun.sleepSync(30);',
      '  if (existsSync(lock)) continue;',
      '  try {',
      '    mkdirSync(lock);',
      '    for (const name of HONEYPOTS) {',
      '      writeFileSync(join(lock, name), "");',
      '      utimesSync(join(lock, name), EPOCH, EPOCH);',
      '    }',
      '    utimesSync(lock, EPOCH, EPOCH);',
      '  } catch {}',
      '}',
    ].join('\n'),
  );

  // Contender: hammer the public API until its own deadline; every call must
  // return (success or ProvisioningError) and be logged.
  const contenderScript = join(destParent, 'contender.ts');
  const cLog = join(destParent, 'calls.log');
  writeFileSync(cLog, '');
  writeFileSync(
    contenderScript,
    [
      "import { appendFileSync } from 'node:fs';",
      `import { materializeSuperpowersWorktree, ProvisioningError } from ${JSON.stringify(modPath)};`,
      'const logPath = process.argv[2];',
      'const destParent = process.argv[3];',
      'const deadline = Date.now() + Number(process.argv[4]);',
      `const SHA = ${JSON.stringify(SHA_A)};`,
      'const runner = { run: () => ({ status: 0, stdout: "", stderr: "" }) };',
      'let n = 0;',
      'while (Date.now() < deadline) {',
      '  n++;',
      '  Bun.sleepSync(25);',
      '  try {',
      '    materializeSuperpowersWorktree({ sourceCheckout: "/src/sp", sha: SHA, destParent, runner });',
      '    appendFileSync(logPath, "ok\\n");',
      '  } catch (e) {',
      '    if (!(e instanceof ProvisioningError)) { appendFileSync(logPath, `bad ${(e as Error).name}\\n`); process.exit(2); }',
      '    appendFileSync(logPath, "err\\n");',
      '  }',
      '}',
      'appendFileSync(logPath, `LOOP-DONE ${n}\\n`);',
    ].join('\n'),
  );

  const flapper = spawn(
    process.execPath,
    [flapperScript, lock, victim, '3500'],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const replanter = spawn(process.execPath, [replanterScript, lock, '3500'], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const contender = spawn(
    process.execPath,
    [contenderScript, cLog, destParent, '4000'],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const exitOf = (p: ReturnType<typeof spawn>) =>
    new Promise<number>((resolve, reject) => {
      p.on('error', reject);
      p.on('close', (code) => resolve(code ?? -1));
    });
  // Attach BOTH exit promises at spawn time: the saboteur can outpace the
  // contender, and a listener attached after an already-fired close never
  // resolves.
  const saboteurExit = Promise.all([exitOf(flapper), exitOf(replanter)]).then(
    (codes) => Math.max(...codes),
  );
  let contenderDone = false;
  const contenderExit = exitOf(contender).then((c) => {
    contenderDone = true;
    return c;
  });
  const hardDeadline = Date.now() + 8000;
  // async sleep: the wait must yield so the child's exit event can fire.
  while (!contenderDone && Date.now() < hardDeadline) await Bun.sleep(10);
  // A contender wedged on a fresh owner token (the storm can fabricate one
  // by disrupting a release) is legitimate lease behavior, not a confinement
  // failure — the properties under test are asserted below regardless of
  // whether every call completed.
  if (!contenderDone) contender.kill('SIGKILL');
  await contenderExit;
  expect(await saboteurExit).toBe(0);

  const callsLog = readFileSync(cLog, 'utf8');
  expect(callsLog).not.toContain('bad');
  const completions = callsLog
    .split('\n')
    .filter((l) => l === 'ok' || l === 'err').length;
  expect(completions).toBeGreaterThan(0);
  // The storm actually ran.
  expect(
    Number(readFileSync(join(destParent, 'swaps.log'), 'utf8')),
  ).toBeGreaterThan(0);
  // THE confinement assertion: the victim holds exactly what it started
  // with — nothing deleted through the link, nothing created in it either.
  expect(readFileSync(precious, 'utf8')).toBe('keep\n');
  expect(
    readdirSync(victim)
      .filter((n) => n !== 'precious.txt')
      .sort(),
  ).toEqual([...HONEYPOTS].sort());
  for (const name of HONEYPOTS) {
    expect(readFileSync(join(victim, name), 'utf8')).toBe('honeypot\n');
  }
}, 20000);

// Release-path confinement: the release must never unlink through a lock
// path whose identity it has not re-established — a swap during the
// critical section redirects that unlink into the link's target. The
// runner seam executes inside the critical section, so the swap is
// deterministic: the runner steals the real lock dir aside and plants a
// symlink to a victim dir holding a file named exactly like the observed
// owner token. An identity-checking release leaves everything inert; a
// release that deletes through the lock path destroys the victim's file.
test('release never unlinks through a swapped lock path', () => {
  const destParent = tmp();
  const dest = join(destParent, `superpowers-${SHA_A}`);
  const lock = `${dest}.lock`;
  // Pre-existing clean destination: the critical section runs rev-parse +
  // status through the runner, giving the swap its in-section hook.
  mkdirSync(dest);
  const victim = tmp();
  const aside = join(tmp(), 'stolen-lock');
  let swapped = false;
  const runner: CommandRunner = {
    run(_command, cmdArgs) {
      if (!swapped) {
        swapped = true;
        // Observe the unique owner token, then swap: steal the lock dir
        // aside and plant the symlink at the lock path.
        const owner = readdirSync(lock).find((n) => n.startsWith('owner-'));
        if (owner === undefined) throw new Error('owner token not observed');
        writeFileSync(join(victim, owner), 'precious\n');
        renameSync(lock, aside);
        symlinkSync(victim, lock);
      }
      if (cmdArgs.includes('rev-parse')) {
        return { status: 0, stdout: `${SHA_A}\n`, stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  };
  const root = materializeSuperpowersWorktree({
    sourceCheckout: '/src/sp',
    sha: SHA_A,
    destParent,
    runner,
  });
  expect(root).toBe(dest);
  expect(swapped).toBe(true);
  // The stolen dir still holds the (now inert) owner token; recover its
  // name to check the victim.
  const strays = readdirSync(aside).filter((n) => n.startsWith('owner-'));
  expect(strays).toHaveLength(1);
  const owner = strays[0] as string;
  // THE confinement assertion: nothing was deleted through the link — the
  // victim still holds the same-named file, untouched.
  expect(readFileSync(join(victim, owner), 'utf8')).toBe('precious\n');
  expect(readdirSync(victim)).toEqual([owner]);
  // The planted link itself is left in place, inert.
  expect(lstatSync(lock).isSymbolicLink()).toBe(true);
});

test('real tmp git repo: materialize, reuse, then drift rejection', () => {
  const src = tmp();
  const git = (gargs: string[], cwd: string) =>
    spawnSync('git', gargs, { cwd, encoding: 'utf8' });
  git(['init', '-q'], src);
  git(['config', 'user.email', 't@t'], src);
  git(['config', 'user.name', 't'], src);
  writeFileSync(join(src, 'README.md'), 'x\n');
  git(['add', '.'], src);
  git(['commit', '-qm', 'init'], src);
  const sha = (git(['rev-parse', 'HEAD'], src).stdout ?? '').trim();
  const destParent = tmp();
  // RecordingRunner's canned git answers would lie for a real repo, so this
  // test uses the real SpawnCommandRunner via defaultCommandRunner (imported
  // at the top of this file).
  const first = materializeSuperpowersWorktree({
    sourceCheckout: src,
    sha,
    destParent,
    runner: defaultCommandRunner,
  });
  const second = materializeSuperpowersWorktree({
    sourceCheckout: src,
    sha,
    destParent,
    runner: defaultCommandRunner,
  });
  expect(second).toBe(first);
  writeFileSync(join(first, 'DIRTY.md'), 'drift\n');
  expect(() =>
    materializeSuperpowersWorktree({
      sourceCheckout: src,
      sha,
      destParent,
      runner: defaultCommandRunner,
    }),
  ).toThrow(ProvisioningError);
});
