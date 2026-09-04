import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  acquireLiveSpendLock,
  type LiveSpendLock,
  realProcessIdentityProbe,
} from '../campaign/locks.ts';
import type { ProcessIdentity } from '../contracts/campaign/execution.ts';
import { RealClock } from '../scheduler/clock.ts';
import { ApplianceError } from './errors.ts';
import { atomicWriteJson } from './fs.ts';
import { ensurePrivateDirNoFollow } from './safe-fs.ts';
import {
  type ApplianceCommandKind,
  type LoadedApplianceStateConfig,
  type LockRecord,
  LockRecordSchema,
  type RefSnapshot,
} from './types.ts';

export interface AcquireLockArgs {
  readonly loaded: LoadedApplianceStateConfig;
  readonly name: LockRecord['name'];
  readonly jobId: string;
  readonly command: ApplianceCommandKind;
  readonly refs?: RefSnapshot | null;
}

export interface LockHandle {
  readonly name: LockRecord['name'];
  readonly path: string;
  readonly jobId: string;
  readonly record: LockRecord;
  assertCurrentOwner(): void;
  release(): void;
}

export type LockInspection =
  | { readonly state: 'missing'; readonly record: null }
  | { readonly state: 'active' | 'stale'; readonly record: LockRecord | null };

function readLockRecord(lockDir: string): LockRecord | null {
  try {
    const raw = JSON.parse(readFileSync(join(lockDir, 'lock.json'), 'utf8'));
    return LockRecordSchema.parse(raw);
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ESRCH'
    ) {
      return false;
    }
    return true;
  }
}

function lockBusyError(
  name: LockRecord['name'],
  lockDir: string,
): ApplianceError {
  const record = readLockRecord(lockDir);
  const holder = record ? ` by ${record.job_id}` : '';
  return new ApplianceError('lock_busy', 'lock', `${name} is held${holder}`);
}

export function inspectLock(path: string): LockInspection {
  if (!existsSync(path)) {
    return { state: 'missing', record: null };
  }

  const record = readLockRecord(path);
  if (record === null) {
    return { state: 'active', record: null };
  }

  return {
    state: isProcessAlive(record.pid) ? 'active' : 'stale',
    record,
  };
}

export function acquireLock(args: AcquireLockArgs): LockHandle {
  const lockDir = join(args.loaded.paths.locks, args.name);
  // The locks root is a mutable namespace boundary: a symlinked component
  // would place the lock (and its later recursive release) wherever the
  // link points, so it is validated no-follow before anything is created.
  ensurePrivateDirNoFollow(
    args.loaded.config.root,
    args.loaded.paths.locks,
    'state/locks',
  );

  try {
    mkdirSync(lockDir, { mode: 0o700 });
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'EEXIST'
    ) {
      throw lockBusyError(args.name, lockDir);
    }
    throw error;
  }

  const record = LockRecordSchema.parse({
    job_id: args.jobId,
    name: args.name,
    host: hostname(),
    pid: process.pid,
    pgid: process.pid,
    started_at: new Date().toISOString(),
    command: args.command,
    refs: args.refs ?? null,
  });

  try {
    atomicWriteJson(join(lockDir, 'lock.json'), record);
  } catch (error) {
    rmSync(lockDir, { recursive: true, force: true });
    throw error;
  }

  const inode = lstatSync(lockDir);
  let released = false;
  return {
    name: args.name,
    path: lockDir,
    jobId: args.jobId,
    record,
    assertCurrentOwner() {
      const currentInode = lstatSync(lockDir, { throwIfNoEntry: false });
      const current = readLockRecord(lockDir);
      if (
        released ||
        !currentInode ||
        currentInode.dev !== inode.dev ||
        currentInode.ino !== inode.ino ||
        current?.job_id !== record.job_id ||
        current.pid !== record.pid ||
        current.started_at !== record.started_at
      )
        throw new Error('appliance lock ownership lost');
    },
    release() {
      if (released) return;
      released = true;
      const currentInode = lstatSync(lockDir, { throwIfNoEntry: false });
      if (
        !currentInode ||
        currentInode.dev !== inode.dev ||
        currentInode.ino !== inode.ino
      )
        return;
      const current = readLockRecord(lockDir);
      if (current?.job_id !== args.jobId) {
        return;
      }
      rmSync(lockDir, { recursive: true, force: true });
    },
  };
}

export function updateLockRefs(handle: LockHandle, refs: RefSnapshot): void {
  try {
    handle.assertCurrentOwner();
  } catch {
    return;
  }
  const current = readLockRecord(handle.path);
  if (current?.job_id !== handle.jobId) {
    return;
  }
  atomicWriteJson(join(handle.path, 'lock.json'), { ...current, refs });
}

export async function withMutationLocks<T>(
  loaded: LoadedApplianceStateConfig,
  jobId: string,
  command: ApplianceCommandKind,
  fn: () => Promise<T>,
): Promise<T> {
  const run = acquireLock({ loaded, name: 'run.lock', jobId, command });
  let sync: LockHandle | null = null;
  let host: LiveSpendLock | undefined;
  try {
    host = acquireMutationLease(loaded);
    sync = acquireLock({ loaded, name: 'sync.lock', jobId, command });
    return await fn();
  } finally {
    sync?.release();
    host?.release();
    run.release();
  }
}

/** Cancellation-only reclamation after authenticated process-role settlement. */
export function reclaimStoppedRunLock(
  loaded: LoadedApplianceStateConfig,
  owners: readonly ProcessIdentity[],
): void {
  const path = join(loaded.paths.locks, 'run.lock');
  const before = lstatSync(path, { throwIfNoEntry: false });
  if (!before) return;
  const record = readLockRecord(path);
  if (
    !before.isDirectory() ||
    !record ||
    record.command !== 'campaign-run' ||
    !owners.some((owner) => owner.pid === record.pid) ||
    realProcessIdentityProbe.exists(record.pid) !== 'esrch'
  )
    throw new Error('campaign run lock death unresolved');
  const trash = `${path}.stopped.${randomUUID()}`;
  renameSync(path, trash);
  const moved = lstatSync(trash);
  if (
    moved.dev !== before.dev ||
    moved.ino !== before.ino ||
    JSON.stringify(readLockRecord(trash)) !== JSON.stringify(record)
  ) {
    if (!lstatSync(path, { throwIfNoEntry: false })) renameSync(trash, path);
    throw new Error('campaign run lock changed during reclamation');
  }
  rmSync(trash, { recursive: true });
}

/** All supported source, helper, and credential mutation callers hold this lease. */
export function acquireMutationLease(
  loaded: LoadedApplianceStateConfig,
): LiveSpendLock {
  if (!loaded.config.live_spend_lock)
    throw new Error('helper mutation requires configured live-spend lock');
  return acquireLiveSpendLock({
    lockPath: loaded.config.live_spend_lock,
    clock: new RealClock(),
    identity: realProcessIdentityProbe,
  });
}
