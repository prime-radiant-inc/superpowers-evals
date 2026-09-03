import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COVERED_BY_LOCK_ENV } from '../src/campaign/locks.ts';
import {
  assertProcessGroupExists,
  buildCampaignChildArgv,
  childCoveredEnv,
  composeCampaignChildEnv,
  DetachedChildSpawner,
  keyGrantsPayload,
  parseRunAllocatedLine,
  SpawnError,
} from '../src/campaign/spawn.ts';
import { deleteProcessEnv, getEnv, setProcessEnv } from '../src/env.ts';

test('detached spawn: pid == pgid (setsid), protocol line observed, group exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spawn-'));
  const script = join(dir, 'child.ts');
  writeFileSync(
    script,
    "console.log('run_allocated: run-abc123');\nawait Bun.sleep(300);\nconsole.log('run-id: run-abc123');\n",
  );
  const spawner = new DetachedChildSpawner();
  const child = spawner.spawn({
    command: 'bun',
    args: [script],
    cwd: dir,
    env: { PATH: getEnv('PATH') ?? '' },
  });
  expect(child.handle.kind).toBe('process');
  if (child.handle.kind !== 'process')
    throw new Error('expected process child');
  expect(child.handle.pgid).toBeGreaterThan(0);
  const pgid = child.handle.pgid;
  // Detached setsid: the child IS its process-group leader (R-SPN-1/2).
  expect(() => assertProcessGroupExists(pgid)).not.toThrow();
  const lines: string[] = [];
  child.onStdoutLine((line) => lines.push(line));
  const exit = await new Promise<{ code: number | null }>((resolve) => {
    child.onExit((info) => resolve({ code: info.code }));
  });
  expect(exit.code).toBe(0);
  expect(lines.some((l) => parseRunAllocatedLine(l) === 'run-abc123')).toBe(
    true,
  );
});

test('assertProcessGroupExists throws SpawnError for a nonexistent group', () => {
  expect(() => assertProcessGroupExists(999999999)).toThrow(SpawnError);
});

test('detached spawner kind is process and the handle carries the pgid', async () => {
  const spawner = new DetachedChildSpawner();
  expect(spawner.kind).toBe('process');
  const dir = mkdtempSync(join(tmpdir(), 'spawn-kind-'));
  const script = join(dir, 'child.ts');
  writeFileSync(script, "console.log('run_allocated: run-k1');\n");
  const child = spawner.spawn({
    command: 'bun',
    args: [script],
    cwd: dir,
    env: { PATH: getEnv('PATH') ?? '' },
  });
  expect(child.handle.kind).toBe('process');
  if (child.handle.kind === 'process') {
    expect(child.handle.pgid).toBeGreaterThan(1);
  }
  await new Promise<void>((resolve) => child.onExit(() => resolve()));
});

test('parseRunAllocatedLine: exact protocol, nothing else', () => {
  expect(parseRunAllocatedLine('run_allocated: run-x')).toBe('run-x');
  expect(parseRunAllocatedLine('run-id: run-x')).toBeNull();
  expect(parseRunAllocatedLine('run_allocated:run-x')).toBeNull();
});

test('campaign child argv addresses the snapshot entrypoint with identity + threading flags', () => {
  const argv = buildCampaignChildArgv({
    evalsRoot: '/camp/evals',
    scenarioDir: '/camp/evals/scenarios/scn-a',
    codingAgent: 'claude',
    codingAgentsDir: '/camp/evals/coding-agents',
    outRoot: 'results',
    os: 'linux',
    credentialName: 'cred_a',
    credentialsFile: '/camp/evals/credentials.yaml',
    gauntletBin: '/camp/bin/gauntlet',
    graderModel: 'claude-sonnet-4-6',
    superpowers: { mode: 'root', root: '/camp/superpowers-abc' },
    identity: {
      campaign_id: 'c'.repeat(64),
      comparison_id: 'c1',
      block_id: 'c1:scn-a:b1',
      sample_id: 'c1:scn-a:arm_a:r1',
      execution_attempt_id: 'c1:scn-a:arm_a:r1:a1',
    },
  });
  expect(argv[0]).toBe('/camp/evals/src/cli/index.ts'); // bun <entry> run ...
  expect(argv[1]).toBe('run');
  expect(argv).toContain('--gauntlet-bin');
  expect(argv).toContain('/camp/bin/gauntlet');
  expect(argv).toContain('--superpowers-root');
  expect(argv).toContain('/camp/superpowers-abc');
  // The registered grader model is authoritative for campaign children —
  // without it the child silently grades with the runner's pinned default.
  expect(argv).toContain('--grader-model');
  expect(argv[argv.indexOf('--grader-model') + 1]).toBe('claude-sonnet-4-6');
  expect(argv).toContain('--campaign-identity');
  const idx = argv.indexOf('--campaign-identity');
  expect(JSON.parse(argv[idx + 1]!)).toEqual({
    campaign_id: 'c'.repeat(64),
    comparison_id: 'c1',
    block_id: 'c1:scn-a:b1',
    sample_id: 'c1:scn-a:arm_a:r1',
    execution_attempt_id: 'c1:scn-a:arm_a:r1:a1',
  });
  // A bare 'quorum' or PATH-resolved binary is forbidden (R-SPN-8).
  expect(argv.join(' ')).not.toMatch(/(^| )quorum( |$)/);
});

test('children-never-acquire marking rides the explicit env channel', () => {
  expect(childCoveredEnv()).toEqual({ [COVERED_BY_LOCK_ENV]: '1' });
});

test('keyGrantsPayload: E7.5 emission arm — 0-2 entries, names only, one per role', () => {
  expect(keyGrantsPayload({}).key_grants).toEqual([]);
  expect(keyGrantsPayload({ subjectEnv: 'S' }).key_grants).toEqual([
    { role: 'subject', env: 'S' },
  ]);
  expect(keyGrantsPayload({ graderEnv: 'G' }).key_grants).toEqual([
    { role: 'grader', env: 'G' },
  ]);
  expect(
    keyGrantsPayload({ subjectEnv: 'S', graderEnv: 'G' }).key_grants,
  ).toEqual([
    { role: 'subject', env: 'S' },
    { role: 'grader', env: 'G' },
  ]);
  // The shared-credential case: same env name may appear once per role.
  expect(
    keyGrantsPayload({ subjectEnv: 'K', graderEnv: 'K' }).key_grants,
  ).toEqual([
    { role: 'subject', env: 'K' },
    { role: 'grader', env: 'K' },
  ]);
});

test('C4: pre-subscription stdout and exit are latched and replayed to late subscribers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spawn-'));
  const script = join(dir, 'fast.ts');
  writeFileSync(script, "console.log('run_allocated: run-fast9');\n");
  const spawner = new DetachedChildSpawner();
  const child = spawner.spawn({
    command: 'bun',
    args: [script],
    cwd: dir,
    env: { PATH: getEnv('PATH') ?? '' },
  });
  // Early subscribers await the REAL events (line delivered AND exit
  // observed) — no guessed sleeps; by resolution both are latched.
  await Promise.all([
    new Promise<void>((resolve) => {
      child.onStdoutLine((line) => {
        if (parseRunAllocatedLine(line) === 'run-fast9') resolve();
      });
    }),
    new Promise<void>((resolve) => {
      child.onExit(() => resolve());
    }),
  ]);
  // Late subscribers registered AFTER the child exited must synchronously
  // receive the latched protocol line and terminal notification (C4: a fast
  // child never loses run_allocated or exit).
  const lateLines: string[] = [];
  child.onStdoutLine((line) => lateLines.push(line));
  const lateExit: { code: number | null }[] = [];
  child.onExit((info) => {
    lateExit.push({ code: info.code });
  });
  expect(lateLines.some((l) => parseRunAllocatedLine(l) === 'run-fast9')).toBe(
    true,
  );
  expect(lateExit.length).toBe(1);
  expect(lateExit[0]?.code).toBe(0);
});

test('R1 launch failure: nonexistent executable → exactly one typed SpawnError, caller survives', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spawn-'));
  const failures: unknown[] = [];
  try {
    new DetachedChildSpawner().spawn({
      command: join(dir, 'no-such-executable-xyz'),
      args: [],
      cwd: dir,
      env: {},
    });
  } catch (err) {
    failures.push(err);
  }
  expect(failures).toHaveLength(1);
  expect(failures[0]).toBeInstanceOf(SpawnError);
  // Turn the event loop: with the error listener installed only after the
  // throw, the async ENOENT fires unhandled HERE and fails the run (the
  // regression: spawning a missing binary crashed the parent after the
  // caller had already caught its SpawnError).
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(failures).toHaveLength(1);
});

test('R2 terminal coordination: unterminated stdout AND stderr tails flushed once; late replay complete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spawn-'));
  const script = join(dir, 'tails.ts');
  writeFileSync(
    script,
    "process.stdout.write('run_allocated: run-tail7-no-newline');" +
      "process.stderr.write('sensor-noise-stderr-tail');\n",
  );
  const child = new DetachedChildSpawner().spawn({
    command: 'bun',
    args: [script],
    cwd: dir,
    env: { PATH: getEnv('PATH') ?? '' },
  });
  // Exit must publish only after BOTH pipes closed and both tails flushed —
  // so once onExit fires, the record is complete (no post-exit races).
  const exit = await new Promise<{ code: number | null }>((resolve) => {
    child.onExit((info) => resolve({ code: info.code }));
  });
  expect(exit.code).toBe(0);
  expect(
    child.stdoutLines.some(
      (l) => parseRunAllocatedLine(l) === 'run-tail7-no-newline',
    ),
  ).toBe(true);
  expect(child.stderrLines.some((l) => l === 'sensor-noise-stderr-tail')).toBe(
    true,
  );
  // Late subscribers replay the complete record, stderr included.
  const lateOut: string[] = [];
  const lateErr: string[] = [];
  child.onStdoutLine((l) => lateOut.push(l));
  child.onStderrLine((l) => lateErr.push(l));
  expect(
    lateOut.some((l) => parseRunAllocatedLine(l) === 'run-tail7-no-newline'),
  ).toBe(true);
  expect(lateErr).toContain('sensor-noise-stderr-tail');
});

test('R3 env composition: marker + selected key VALUES projected; child env constructed, never inherited', async () => {
  const SUBJ = 'QR_TEST_SUBJ_KEY';
  const GRADER = 'QR_TEST_GRADER_KEY';
  const LEAK = 'QR_TEST_PARENT_LEAK';
  const prev = {
    [SUBJ]: getEnv(SUBJ),
    [GRADER]: getEnv(GRADER),
    [LEAK]: getEnv(LEAK),
  };
  setProcessEnv(SUBJ, 'subj-value-9');
  setProcessEnv(GRADER, 'grader-value-9');
  setProcessEnv(LEAK, 'ambient-leak');
  const dir = mkdtempSync(join(tmpdir(), 'spawn-'));
  const script = join(dir, 'env-print.ts');
  writeFileSync(
    script,
    `console.log(JSON.stringify({ marker: Bun.env['${COVERED_BY_LOCK_ENV}'] ?? null, subj: Bun.env['${SUBJ}'] ?? null, grader: Bun.env['${GRADER}'] ?? null, leak: Bun.env['${LEAK}'] ?? null }));\n`,
  );
  try {
    const env = composeCampaignChildEnv({
      base: { PATH: getEnv('PATH') ?? '', QR_TEST_UNDEFINED_BASE: undefined },
      grants: { subjectEnv: SUBJ, graderEnv: GRADER },
    });
    expect(env[COVERED_BY_LOCK_ENV]).toBe('1');
    expect(env[SUBJ]).toBe('subj-value-9');
    expect(env[GRADER]).toBe('grader-value-9');
    // Constructed env: parent-ambient values not in base/grants never reach
    // the child; undefined base entries are skipped entirely.
    expect(env[LEAK]).toBeUndefined();
    expect('QR_TEST_UNDEFINED_BASE' in env).toBe(false);
    // A REAL child receives exactly the composed environment.
    const child = new DetachedChildSpawner().spawn({
      command: 'bun',
      args: [script],
      cwd: dir,
      env,
    });
    const exit = await new Promise<{ code: number | null }>((resolve) => {
      child.onExit((info) => resolve({ code: info.code }));
    });
    expect(exit.code).toBe(0);
    const seen = JSON.parse(child.stdoutLines.at(-1) ?? '{}');
    expect(seen).toEqual({
      marker: '1',
      subj: 'subj-value-9',
      grader: 'grader-value-9',
      leak: null,
    });
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) deleteProcessEnv(key);
      else setProcessEnv(key, value);
    }
  }
});

test('R3 fail-loud: an unset OR EMPTY selected key refuses to compose (R-SPN-7)', () => {
  const MISSING = 'QR_TEST_DEFINITELY_UNSET_KEY';
  const prev = getEnv(MISSING);
  try {
    // undefined, empty, and whitespace-only are all unusable credentials —
    // exactly the unset/empty semantics of resolveApiKey and the
    // registration key preflight (src/credentials/resolve.ts,
    // src/campaign/registration.ts).
    for (const value of [undefined, '', '   '] as (string | undefined)[]) {
      if (value === undefined) deleteProcessEnv(MISSING);
      else setProcessEnv(MISSING, value);
      expect(() =>
        composeCampaignChildEnv({ base: {}, grants: { subjectEnv: MISSING } }),
      ).toThrow(SpawnError);
    }
  } finally {
    if (prev === undefined) deleteProcessEnv(MISSING);
    else setProcessEnv(MISSING, prev);
  }
});
