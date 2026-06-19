import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { ApplianceError } from './errors.ts';
import { atomicWriteJson, mkdirPrivate } from './fs.ts';
import {
  type ApplianceCommandKind,
  type LoadedApplianceConfig,
  type LockRecord,
  LockRecordSchema,
  type RefSnapshot,
} from './types.ts';

export interface AcquireLockArgs {
  readonly loaded: LoadedApplianceConfig;
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
  mkdirPrivate(args.loaded.paths.locks);

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

  return {
    name: args.name,
    path: lockDir,
    jobId: args.jobId,
    record,
    release() {
      const current = readLockRecord(lockDir);
      if (current?.job_id !== args.jobId) {
        return;
      }
      rmSync(lockDir, { recursive: true, force: true });
    },
  };
}

export async function withMutationLocks<T>(
  loaded: LoadedApplianceConfig,
  jobId: string,
  command: ApplianceCommandKind,
  fn: () => Promise<T>,
): Promise<T> {
  const run = acquireLock({ loaded, name: 'run.lock', jobId, command });
  let sync: LockHandle | null = null;
  try {
    sync = acquireLock({ loaded, name: 'sync.lock', jobId, command });
    return await fn();
  } finally {
    sync?.release();
    run.release();
  }
}
