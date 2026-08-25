import { expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmdirSync,
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

// Race A, deterministically: a contender observing a stale lock must
// remove ONLY the stale owner file it observed — never a lock another
// owner freshly holds. The lock dir is planted with one stale and one
// fresh owner file; the contender reclaims the stale one and must then
// patiently poll behind the fresh owner until it releases.
test('real FS: reclaim removes only the observed stale owner, never a fresh one', async () => {
  const destParent = tmp();
  const dest = join(destParent, `superpowers-${SHA_A}`);
  const lock = `${dest}.lock`;
  const staleName = 'owner-00000000-0000-0000-0000-00000000dead';
  const freshName = 'owner-11111111-2222-3333-4444-5555555555alive';
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, staleName), '');
  utimesSync(join(lock, staleName), new Date(0), new Date(0));
  writeFileSync(join(lock, freshName), ''); // mtime = now: a live owner

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

  // Let the contender run its reclaim pass (well past startup + one poll).
  // try/finally: a failed assertion must never leak the child process.
  let handedOver = false;
  try {
    Bun.sleepSync(800);
    // It reclaimed the stale owner but must NOT have touched the fresh one,
    // the lock dir, or entered the critical section.
    expect(existsSync(join(lock, staleName))).toBe(false);
    expect(existsSync(join(lock, freshName))).toBe(true);
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(log, 'utf8').trim()).toBe(''); // no git call yet

    // The fresh owner releases; the contender may now take over.
    rmSync(join(lock, freshName));
    try {
      rmdirSync(lock);
    } catch {
      // the contender may already be mid-retry
    }
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
