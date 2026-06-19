import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireLock,
  inspectLock,
  withMutationLocks,
} from '../src/appliance/locks.ts';
import type { LoadedApplianceConfig } from '../src/appliance/types.ts';

function loaded(
  root = mkdtempSync(join(tmpdir(), 'appliance-locks-')),
): LoadedApplianceConfig {
  mkdirSync(join(root, 'state/locks'), { recursive: true });
  return {
    configPath: join(root, 'appliance.json'),
    config: {
      root,
      evals: { path: join(root, 'evals'), remote: 'origin', ref: 'main' },
      superpowers: { path: join(root, 'superpowers'), remote: 'origin' },
      gauntlet: { path: join(root, 'gauntlet'), remote: 'origin', ref: 'main' },
      credential_bundle: {
        name: 'blessed',
        path: join(root, 'credentials/blessed'),
      },
      container: {
        name: 'quorum-appliance',
        results_root: join(root, 'evals/results'),
      },
    },
    bundle: {
      bundle_id: 'blessed-2026-06-18-a',
      rotated_at: '2026-06-18T00:00:00Z',
      providers: [],
      note: 'test',
    },
    paths: {
      jobs: join(root, 'state/jobs'),
      locks: join(root, 'state/locks'),
      provenance: join(root, 'state/provenance'),
    },
  };
}

describe('appliance locks', () => {
  test('withMutationLocks acquires run.lock before sync.lock and releases both', async () => {
    const cfg = loaded();
    const seen: string[] = [];

    await withMutationLocks(cfg, 'job-1', 'prepare', async () => {
      seen.push(
        JSON.parse(
          readFileSync(join(cfg.paths.locks, 'run.lock/lock.json'), 'utf8'),
        ).name,
      );
      seen.push(
        JSON.parse(
          readFileSync(join(cfg.paths.locks, 'sync.lock/lock.json'), 'utf8'),
        ).name,
      );
    });

    expect(seen).toEqual(['run.lock', 'sync.lock']);
    expect(existsSync(join(cfg.paths.locks, 'run.lock'))).toBe(false);
    expect(existsSync(join(cfg.paths.locks, 'sync.lock'))).toBe(false);
  });

  test('existing run.lock fails before sync.lock is created', async () => {
    const cfg = loaded();
    acquireLock({
      loaded: cfg,
      name: 'run.lock',
      jobId: 'other',
      command: 'run-all',
    });

    await expect(
      withMutationLocks(cfg, 'job-2', 'prepare', async () => undefined),
    ).rejects.toThrow(/run.lock is held by other/);
    expect(existsSync(join(cfg.paths.locks, 'sync.lock'))).toBe(false);
  });

  test('acquireLock writes private lock directory and lock record', () => {
    const cfg = loaded();
    const handle = acquireLock({
      loaded: cfg,
      name: 'run.lock',
      jobId: 'job-private',
      command: 'prepare',
    });
    const lockDir = join(cfg.paths.locks, 'run.lock');
    const lockJson = join(lockDir, 'lock.json');

    expect(statSync(lockDir).mode & 0o777).toBe(0o700);
    expect(statSync(lockJson).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(lockJson, 'utf8')).job_id).toBe(
      'job-private',
    );

    handle.release();
  });

  test('release keeps a lock directory whose record changed owners', () => {
    const cfg = loaded();
    const handle = acquireLock({
      loaded: cfg,
      name: 'run.lock',
      jobId: 'job-owner',
      command: 'prepare',
    });
    const lockDir = join(cfg.paths.locks, 'run.lock');
    const record = JSON.parse(readFileSync(join(lockDir, 'lock.json'), 'utf8'));
    writeFileSync(
      join(lockDir, 'lock.json'),
      JSON.stringify({ ...record, job_id: 'job-other' }),
    );

    handle.release();

    expect(existsSync(lockDir)).toBe(true);
  });

  test('inspectLock reports stale when pid is not alive', () => {
    const cfg = loaded();
    const lockDir = join(cfg.paths.locks, 'run.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, 'lock.json'),
      JSON.stringify({
        name: 'run.lock',
        job_id: 'job-dead',
        host: 'test-host',
        pid: 99999999,
        pgid: 99999999,
        started_at: '2026-06-18T00:00:00.000Z',
        command: 'run-all',
        refs: null,
      }),
    );

    expect(inspectLock(join(cfg.paths.locks, 'run.lock')).state).toBe('stale');
  });
});
