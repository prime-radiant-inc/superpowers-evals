import { expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireLease,
  formatLockToken,
  type LeaseHandle,
  LockError,
} from '../src/campaign/locks.ts';
import { ensureWorktreeAt } from '../src/campaign/provisioning.ts';
import { FakeClock } from '../src/scheduler/clock.ts';

const real = { ...fs };

/** Run real filesystem operations with an allocator that immediately reuses
 *  an unreferenced inode. macOS normally delays reuse; Linux may not. Open
 *  descriptors keep their objects alive, so only unpinned identities recycle. */
function withInodeReuse(
  run: (replace: (path: string, create: () => void) => void) => void,
): void {
  const open = new Set<number>();
  const aliases = new Map<string, fs.Stats>();
  const key = (st: fs.Stats) => `${st.dev}:${st.ino}`;
  const remap = (st: fs.Stats): fs.Stats => {
    const reused = aliases.get(key(st));
    return reused === undefined
      ? st
      : Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
          dev: reused.dev,
          ino: reused.ino,
        });
  };
  const spies = [
    spyOn(fs, 'openSync').mockImplementation(
      (...args: Parameters<typeof fs.openSync>) => {
        const fd = real.openSync(...args);
        open.add(fd);
        return fd;
      },
    ),
    spyOn(fs, 'closeSync').mockImplementation((fd) => {
      real.closeSync(fd);
      open.delete(fd);
    }),
    spyOn(fs, 'lstatSync').mockImplementation(((
      ...args: Parameters<typeof fs.lstatSync>
    ) => remap(real.lstatSync(...args) as fs.Stats)) as typeof fs.lstatSync),
    spyOn(fs, 'fstatSync').mockImplementation(((
      ...args: Parameters<typeof fs.fstatSync>
    ) => remap(real.fstatSync(...args) as fs.Stats)) as typeof fs.fstatSync),
  ];
  try {
    run((path, create) => {
      const original = real.lstatSync(path);
      const pinned = [...open].some(
        (fd) => key(real.fstatSync(fd)) === key(original),
      );
      real.rmSync(path, { recursive: true });
      create();
      if (!pinned) aliases.set(key(real.lstatSync(path)), original);
    });
    // Real resource assertion: no descriptor opened by a completed lock
    // operation may remain usable after release or failed acquisition.
    for (const fd of open) {
      expect(() => real.fstatSync(fd)).toThrow();
    }
  } finally {
    for (const spy of spies) spy.mockRestore();
    for (const fd of open) real.closeSync(fd);
  }
}

const identity = {
  exists: (pid: number) =>
    pid === process.pid ? ('alive' as const) : ('esrch' as const),
  startTimeMs: (pid: number) => (pid === process.pid ? 1_000 : null),
};
const scheduler = { every: () => () => {} };

test('inode reuse: a replacement token cannot receive a heartbeat', () => {
  const dir = real.mkdtempSync(join(tmpdir(), 'lock-inode-'));
  try {
    withInodeReuse((replace) => {
      const clock = new FakeClock(10);
      const lease = acquireLease({
        lockPath: join(dir, 'lease'),
        clock,
        identity,
        scheduler,
        label: 'test',
      });
      const bytes = real.readFileSync(lease.ownerFile, 'utf8');
      replace(lease.ownerFile, () =>
        real.writeFileSync(lease.ownerFile, bytes),
      );
      clock.advance(30);
      try {
        expect(() => lease.heartbeat()).toThrow(LockError);
        expect(real.readFileSync(lease.ownerFile, 'utf8')).toBe(bytes);
      } finally {
        lease.release();
      }
    });
  } finally {
    real.rmSync(dir, { recursive: true, force: true });
  }
});

test('inode reuse: a stale contender preserves the successor lock', () => {
  const dir = real.mkdtempSync(join(tmpdir(), 'lock-inode-'));
  try {
    withInodeReuse((replace) => {
      const lockPath = join(dir, 'lease');
      real.mkdirSync(lockPath);
      real.writeFileSync(
        join(lockPath, 'owner-00000000-0000-4000-8000-000000000000'),
        formatLockToken({
          pid: 424_242,
          birth_ts_ms: 1_000,
          last_heartbeat_ts_ms: 10_000,
        }),
      );
      const clock = new FakeClock(210);
      let successor: LeaseHandle | undefined;
      const delayed = {
        ...identity,
        exists(pid: number) {
          if (pid === 424_242 && successor === undefined) {
            replace(lockPath, () => {
              successor = acquireLease({
                lockPath,
                clock,
                identity,
                scheduler,
                label: 'successor',
              });
            });
          }
          return identity.exists(pid);
        },
      };
      try {
        expect(() =>
          acquireLease({
            lockPath,
            clock,
            identity: delayed,
            scheduler,
            label: 'delayed',
          }),
        ).toThrow(LockError);
        expect(successor).toBeDefined();
        expect(real.existsSync(successor!.ownerFile)).toBe(true);
        expect(() => successor!.heartbeat()).not.toThrow();
      } finally {
        successor?.release();
      }
    });
  } finally {
    real.rmSync(dir, { recursive: true, force: true });
  }
});

test('inode reuse: a materializer release preserves the successor lock', () => {
  const dir = real.mkdtempSync(join(tmpdir(), 'lock-inode-'));
  try {
    withInodeReuse((replace) => {
      const dest = join(dir, 'worktree');
      const lockPath = `${dest}.lock`;
      const successorName = 'owner-11111111-1111-4111-8111-111111111111';
      let replaced = false;
      ensureWorktreeAt({
        sourceCheckout: '/source',
        sha: 'a'.repeat(40),
        dest,
        runner: {
          run() {
            if (!replaced) {
              replaced = true;
              replace(lockPath, () => {
                real.mkdirSync(lockPath);
                real.writeFileSync(
                  join(lockPath, successorName),
                  `${process.pid}\n`,
                );
              });
            }
            return { status: 0, stdout: '', stderr: '' };
          },
        },
      });
      expect(real.existsSync(join(lockPath, successorName))).toBe(true);
    });
  } finally {
    real.rmSync(dir, { recursive: true, force: true });
  }
});

test('lock descriptors close after acquisition fails and contenders refuse', () => {
  const dir = real.mkdtempSync(join(tmpdir(), 'lock-inode-'));
  try {
    withInodeReuse(() => {
      const lockPath = join(dir, 'lease');
      const args = {
        lockPath,
        clock: new FakeClock(10),
        identity,
        scheduler,
        label: 'test',
      };
      expect(() =>
        acquireLease({
          ...args,
          scheduler: {
            every() {
              throw new Error('scheduler unavailable');
            },
          },
        }),
      ).toThrow('scheduler unavailable');
      expect(real.existsSync(lockPath)).toBe(false);
      const lease = acquireLease(args);
      try {
        expect(() => acquireLease(args)).toThrow(LockError);
      } finally {
        lease.release();
      }
    });
  } finally {
    real.rmSync(dir, { recursive: true, force: true });
  }
});

test('lock descriptors close when a heartbeat discovers directory displacement', () => {
  const dir = real.mkdtempSync(join(tmpdir(), 'lock-inode-'));
  try {
    withInodeReuse((replace) => {
      const lockPath = join(dir, 'lease');
      const lease = acquireLease({
        lockPath,
        clock: new FakeClock(10),
        identity,
        scheduler,
        label: 'test',
      });
      replace(lockPath, () => real.mkdirSync(lockPath));
      expect(() => lease.heartbeat()).toThrow(LockError);
      expect(() => lease.heartbeat()).toThrow(LockError);
      // The failed heartbeat itself closes its descriptors; callers need
      // not release an already-displaced directory to free resources.
    });
  } finally {
    real.rmSync(dir, { recursive: true, force: true });
  }
});

test('materializer descriptors close when the guarded operation throws', () => {
  const dir = real.mkdtempSync(join(tmpdir(), 'lock-inode-'));
  try {
    withInodeReuse(() => {
      expect(() =>
        ensureWorktreeAt({
          sourceCheckout: '/source',
          sha: 'a'.repeat(40),
          dest: join(dir, 'worktree'),
          runner: {
            run() {
              throw new Error('git unavailable');
            },
          },
        }),
      ).toThrow('git unavailable');
    });
  } finally {
    real.rmSync(dir, { recursive: true, force: true });
  }
});

test.each([
  'acquire',
  'contend',
  'provision',
])('directory open refuses a swapped FIFO: %s', (mode) => {
  const dir = real.mkdtempSync(join(tmpdir(), 'lock-fifo-'));
  try {
    const child = spawnSync(
      process.execPath,
      [
        join(import.meta.dir, 'helpers', 'lock-directory-open-swap.ts'),
        mode,
        dir,
      ],
      { timeout: 2_000, encoding: 'utf8' },
    );
    expect(child.status).toBe(0);
  } finally {
    real.rmSync(dir, { recursive: true, force: true });
  }
});

test('heartbeat inspection failure keeps release retryable after filesystem recovery', () => {
  const dir = real.mkdtempSync(join(tmpdir(), 'lock-inspect-'));
  try {
    withInodeReuse(() => {
      const lockPath = join(dir, 'lease');
      const lease = acquireLease({
        lockPath,
        clock: new FakeClock(10),
        identity,
        scheduler,
        label: 'test',
      });
      // Remove search permission on the parent so even lstat(lockPath)
      // fails. Restoring access must allow this same handle to release.
      real.chmodSync(dir, 0o000);
      try {
        expect(() => lease.heartbeat()).toThrow(LockError);
      } finally {
        real.chmodSync(dir, 0o700);
      }
      lease.release();
      expect(real.existsSync(lockPath)).toBe(false);
    });
  } finally {
    real.chmodSync(dir, 0o700);
    real.rmSync(dir, { recursive: true, force: true });
  }
});
