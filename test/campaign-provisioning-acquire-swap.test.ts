// Deterministic coverage for the acquire-window symlink redirect (kernel D2,
// provisioning review round 4, Finding 1).
//
// tryAcquireLock creates the lock dir with mkdir, then writes its owner token,
// then re-checks by dev+ino that the lock path STILL identifies the directory
// it created. A concurrent attacker that swaps the lock path for a symlink to
// an external directory inside that mkdir->check window makes the owner write
// land through the link, and the identity check then detects the mismatch.
// The hazard: deleting that stray back through the still-mutable lock path
// redirects the unlink into the attacker's target. The fix is to leave the
// uniquely named stray inert.
//
// The window is microseconds wide, so a real multi-process storm cannot
// deterministically land the swap inside it (and, having landed it, cannot
// deterministically hold the link across the cleanup) — measured: fixed and
// mutant leave overlapping stray counts, so a storm cannot discriminate. This
// test instead injects the attacker's swap at exactly the vulnerable instant
// by interposing on the single owner-file write at the node:fs seam. Every
// filesystem operation is real; the double only fixes the attacker's timing,
// so a regression is caught deterministically rather than probabilistically.
import { expect, mock, test } from 'bun:test';
import * as realFsNS from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix, win32 } from 'node:path';

// Snapshot the real fs BEFORE mocking, so the double calls through to real
// operations instead of recursing into itself.
const REAL = { ...realFsNS };

const SHA = 'a'.repeat(40);
const OWNER_BASE_RE = /^owner-[0-9a-f-]+$/;

/** The owner-token write inside tryAcquireLock, identified by path SHAPE, not
 *  separator: an `owner-<uuid>` file inside a `<...>.lock` directory. The path
 *  is built with platform-native `join`, so it is decomposed with the matching
 *  platform's `basename`/`dirname` (defaulting to the host's, which is what the
 *  module's `join` produced). Returns the lock dir to swap, or null. The
 *  `sep`-aware `pth` parameter lets the tests below prove BOTH conventions arm. */
function ownerLockWrite(
  path: string,
  pth: Pick<typeof posix, 'basename' | 'dirname'>,
): string | null {
  const parent = pth.dirname(path);
  if (
    OWNER_BASE_RE.test(pth.basename(path)) &&
    pth.basename(parent).endsWith('.lock')
  ) {
    return parent;
  }
  return null;
}

let trap = '';
let aside = '';
let swapArmed = false;
let swapped = false;

mock.module('node:fs', () => ({
  ...REAL,
  writeFileSync: (path: unknown, data: unknown, opts: unknown) => {
    // Fire once, on the owner-token write inside tryAcquireLock, and BEFORE
    // the real write: steal the just-created lock dir aside and plant a
    // symlink to the trap at the lock path. The real write then lands in the
    // trap through the link, reproducing exactly the state the attacker
    // creates by winning the mkdir->check race.
    const lockDir =
      swapArmed && !swapped && typeof path === 'string'
        ? ownerLockWrite(path, { basename, dirname })
        : null;
    if (lockDir !== null) {
      swapped = true;
      REAL.renameSync(lockDir, aside);
      REAL.symlinkSync(trap, lockDir);
    }
    return REAL.writeFileSync(
      path as string,
      data as string,
      opts as Parameters<typeof REAL.writeFileSync>[2],
    );
  },
}));

test('injector arms on both separator conventions (POSIX + Windows paths)', () => {
  // The module builds the owner path with platform-native `join`; the matcher
  // must recognize it under either separator. Prove both by pairing each
  // path-module with its own `join`/`basename`/`dirname` — the old hardcoded
  // `/` matcher never armed on the Windows shape, so the finding went
  // unexercised on Windows.
  const posixPath = posix.join(
    '/tmp/w/superpowers-abc.lock',
    'owner-dead-beef',
  );
  const winPath = win32.join(
    'C:\\Users\\w\\superpowers-abc.lock',
    'owner-dead-beef',
  );
  expect(posixPath).toContain('/');
  expect(winPath).toContain('\\');
  expect(ownerLockWrite(posixPath, posix)).toBe('/tmp/w/superpowers-abc.lock');
  expect(ownerLockWrite(winPath, win32)).toBe(
    'C:\\Users\\w\\superpowers-abc.lock',
  );
  // A non-owner write is ignored under either separator.
  expect(
    ownerLockWrite(posix.join('/tmp/w/superpowers-abc', 'HEAD'), posix),
  ).toBeNull();
  expect(
    ownerLockWrite(win32.join('C:\\w\\superpowers-abc', 'HEAD'), win32),
  ).toBeNull();
});

test('acquire-window swap: mismatch cleanup never unlinks through the lock path', async () => {
  // Imported dynamically AFTER the mock so its `import { writeFileSync }`
  // binds to the double.
  const { materializeSuperpowersWorktree, ProvisioningError } = await import(
    '../src/campaign/provisioning.ts'
  );
  const destParent = REAL.mkdtempSync(join(tmpdir(), 'prov-acq-'));
  trap = REAL.mkdtempSync(join(tmpdir(), 'prov-acq-trap-'));
  aside = join(REAL.mkdtempSync(join(tmpdir(), 'prov-acq-aside-')), 'lock');
  // A differently named bystander in the redirect target: it must never be
  // touched regardless of the fix shape.
  REAL.writeFileSync(join(trap, 'precious.txt'), 'keep\n');
  const runner = { run: () => ({ status: 0, stdout: '', stderr: '' }) };

  swapArmed = true;
  let err: unknown;
  try {
    materializeSuperpowersWorktree({
      sourceCheckout: '/src/sp',
      sha: SHA,
      destParent,
      runner,
    });
  } catch (e) {
    err = e;
  }

  // The swap fired at the owner write; the post-write identity check saw the
  // planted symlink (mismatch), and the subsequent reclaim refused the
  // symlinked lock path loudly.
  expect(swapped).toBe(true);
  expect(err).toBeInstanceOf(ProvisioningError);
  expect((err as Error).message).toContain(
    'non-directory or symlinked lock path',
  );

  // THE confinement assertion: the owner token the module wrote THROUGH the
  // link into the trap was left inert — never unlinked back through the
  // mutable lock path. A regressed build (rmSync(ownerFile) in the mismatch
  // branch) deletes it, emptying the trap of owner tokens; the fixed build
  // leaves the uniquely named stray in place.
  const strays = REAL.readdirSync(trap).filter((n: string) =>
    n.startsWith('owner-'),
  );
  expect(strays).toHaveLength(1);
  // The bystander sentinel is untouched.
  expect(REAL.readFileSync(join(trap, 'precious.txt'), 'utf8')).toBe('keep\n');
});
