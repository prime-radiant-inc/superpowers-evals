import { mock } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { FakeClock } from '../../src/scheduler/clock.ts';

const real = { ...fs };
const [mode, directory] = process.argv.slice(2) as [string, string];
const dest = join(directory, 'worktree');
const lockPath =
  mode === 'provision' ? `${dest}.lock` : join(directory, 'lease');
if (mode === 'contend') real.mkdirSync(lockPath);
let swapped = false;
mock.module('node:fs', () => ({
  ...real,
  openSync: (...args: Parameters<typeof fs.openSync>) => {
    if (args[0] === lockPath && !swapped) {
      swapped = true;
      real.rmSync(lockPath, { recursive: true });
      const fifo = spawnSync('mkfifo', [lockPath]);
      if (fifo.status !== 0) throw new Error('could not plant FIFO');
    }
    return real.openSync(...args);
  },
}));

let failed = false;
try {
  if (mode === 'provision') {
    const { ensureWorktreeAt } = await import(
      '../../src/campaign/provisioning.ts'
    );
    ensureWorktreeAt({
      sourceCheckout: '/source',
      sha: 'a'.repeat(40),
      dest,
      runner: {
        run() {
          throw new Error('entered guarded operation');
        },
      },
    });
  } else {
    const { acquireLease } = await import('../../src/campaign/locks.ts');
    acquireLease({
      lockPath,
      clock: new FakeClock(10),
      label: 'test',
      identity: { exists: () => 'esrch', startTimeMs: () => 1_000 },
      scheduler: { every: () => () => {} },
    });
  }
} catch (err) {
  failed = /ENOTDIR|not a directory/.test(String(err));
}
if (!swapped || !failed)
  throw new Error('directory replacement was not refused');
