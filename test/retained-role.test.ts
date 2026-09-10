import { afterEach, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireQualificationLease,
  createRoleHeartbeatScheduler,
  runChild,
} from '../src/runner/retained-role.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
test('child-only runner waits for forced termination and preserves private output', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'retained-'));
  dirs.push(cwd);
  const start = Date.now();
  const result = await runChild({
    args: [
      '-e',
      "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
    ],
    cwd,
    env: {},
    signal: new AbortController().signal,
    timeoutMs: 250,
  });
  expect(result).toEqual({
    code: null,
    signal: 'SIGKILL',
    timedOut: true,
    spawnError: false,
  });
  expect(Date.now() - start).toBeLessThan(4000);
  expect(readFileSync(join(cwd, 'child.stdout.log'), 'utf8')).toContain(
    'ready',
  );
  expect(statSync(join(cwd, 'child.stdout.log')).mode & 0o777).toBe(0o600);
});
test('heartbeat routes ownership loss to cancellation without an uncaught exception', async () => {
  let lost = false;
  const cancel = createRoleHeartbeatScheduler(() => {
    lost = true;
  }).every(5, () => {
    throw Error('lost');
  });
  try {
    await Bun.sleep(20);
    expect(lost).toBe(true);
  } finally {
    cancel();
  }
});

for (const name of ['run.lock', 'sync.lock', 'unresolved host claim'])
  test(`qualification refuses ${name} without clearing it`, () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'qual-lease-')));
    dirs.push(root);
    const loaded = {
      configPath: join(root, 'config.json'),
      config: {
        root,
        live_spend_lock: join(root, 'spend'),
        evals: { path: join(root, 'evals'), remote: 'origin', ref: 'main' },
        gauntlet: {
          path: join(root, 'gauntlet'),
          remote: 'origin',
          ref: 'main',
        },
        superpowers: { path: join(root, 'superpowers'), remote: 'origin' },
        credential_bundle: {
          name: 'blessed' as const,
          path: join(root, 'credentials'),
        },
        container: {
          name: 'quorum-appliance',
          results_root: join(root, 'results'),
        },
      },
      paths: {
        jobs: join(root, 'jobs'),
        locks: join(root, 'locks'),
        provenance: join(root, 'provenance'),
      },
    };
    let retained: string;
    if (name === 'unresolved host claim') {
      retained = `${loaded.config.live_spend_lock}.claim.json`;
      writeFileSync(retained, '{"unresolved":true}');
    } else {
      mkdirSync(join(loaded.paths.locks, name), { recursive: true });
      retained = join(loaded.paths.locks, name, 'foreign');
      writeFileSync(retained, 'keep');
    }
    const before = readFileSync(retained, 'utf8');
    expect(() => acquireQualificationLease(loaded, () => {})).toThrow();
    expect(readFileSync(retained, 'utf8')).toBe(before);
  });
