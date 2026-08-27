import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COVERED_BY_LOCK_ENV } from '../src/campaign/locks.ts';
import {
  assertProcessGroupExists,
  buildCampaignChildArgv,
  childCoveredEnv,
  DetachedChildSpawner,
  keyGrantsPayload,
  parseRunAllocatedLine,
  SpawnError,
} from '../src/campaign/spawn.ts';
import { getEnv } from '../src/env.ts';

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
  expect(child.pid).toBeGreaterThan(0);
  // Detached setsid: the child IS its process-group leader (R-SPN-1/2).
  expect(() => assertProcessGroupExists(child.pid)).not.toThrow();
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
