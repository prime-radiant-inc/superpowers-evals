import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  campaignDecision,
  qualificationFits,
} from '../docs/experiments/2026-09-08-conversation-routine-use/envelope.ts';
import {
  observationChild,
  verifySettledRoles,
} from '../docs/experiments/2026-09-08-conversation-routine-use/observe.ts';
import {
  checkOperationHistory,
  hash,
  marker,
  parseRoutineManifest,
  prepareOperation,
} from '../docs/experiments/2026-09-08-conversation-routine-use/operation.ts';
import {
  prepareQualification,
  runQualificationSet,
} from '../docs/experiments/2026-09-08-conversation-routine-use/qualify.ts';
import {
  campaignChild,
  type MonitorEffects,
  monitorCampaign,
} from '../docs/experiments/2026-09-08-conversation-routine-use/run.ts';
import type { ArtifactRef } from '../src/contracts/campaign/execution.ts';
import { getEnv } from '../src/env.ts';
import { FakeClock } from '../src/scheduler/clock.ts';

const observation = {
  campaignId: 'one',
  knownUsd: 20,
  pendingAttempts: 4,
  settledFault: null as string | null,
  ownership: 'safe' as const,
  terminal: false,
};
test('pending usage and repeat snapshots are not new spend', () => {
  const e = {
    firstPaidAtMs: 0,
    qualificationKnownUsd: 10,
    campaigns: new Map([['one', 20]]),
  };
  expect(campaignDecision(e, 30_000, observation)).toEqual({
    action: 'observe',
    reason: null,
    knownUsd: 30,
  });
  expect(
    campaignDecision(e, 30_000, {
      ...observation,
      settledFault: 'missing returned usage',
    }).action,
  ).toBe('cancel');
  expect(
    campaignDecision(e, 30_000, { ...observation, knownUsd: 15 }).knownUsd,
  ).toBe(30);
});
test('a repair preserves the original cutoff and earlier cohort cost', () => {
  const e = {
    firstPaidAtMs: 0,
    qualificationKnownUsd: 30,
    campaigns: new Map([['one', 90]]),
  };
  const o = { ...observation, campaignId: 'two', knownUsd: 30 };
  expect(campaignDecision(e, 60_000, o)).toEqual({
    action: 'cancel',
    reason: 'observed cost',
    knownUsd: 150,
  });
  expect(campaignDecision(e, 21_540_000, { ...o, knownUsd: 25 }).reason).toBe(
    'cutoff',
  );
  expect(qualificationFits(0, 21_418_000)).toBe(true);
  expect(qualificationFits(0, 21_418_001)).toBe(false);
});
test('verified terminal faults remain faults and unsafe ownership has priority', () => {
  const e = {
    firstPaidAtMs: 0,
    qualificationKnownUsd: 0,
    campaigns: new Map<string, number>(),
  };
  expect(
    campaignDecision(e, 0, {
      ...observation,
      terminal: true,
      settledFault: 'missing usage',
    }),
  ).toEqual({ action: 'done', reason: 'settled accounting', knownUsd: 20 });
  expect(
    campaignDecision(e, 0, {
      ...observation,
      ownership: 'unsafe',
      settledFault: 'missing usage',
    }).reason,
  ).toBe('ownership');
});
for (const n of [NaN, Infinity, -1])
  test('invalid amounts, clocks, and pending counts fail closed', () => {
    const e = {
      firstPaidAtMs: 0,
      qualificationKnownUsd: 0,
      campaigns: new Map<string, number>(),
    };
    expect(() =>
      campaignDecision(e, 0, { ...observation, knownUsd: n }),
    ).toThrow();
    expect(() =>
      campaignDecision({ ...e, qualificationKnownUsd: n }, 0, observation),
    ).toThrow();
    expect(() =>
      campaignDecision(
        { ...e, campaigns: new Map([['prior', n]]) },
        0,
        observation,
      ),
    ).toThrow();
    expect(() => campaignDecision(e, n, observation)).toThrow();
    expect(() =>
      campaignDecision(e, 0, { ...observation, pendingAttempts: n }),
    ).toThrow();
    expect(() => qualificationFits(n, 0)).toThrow();
  });

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function monitorFixture(start = 0) {
  const clock = new FakeClock(start);
  const heldObservation = deferred<typeof observation>();
  const cancellation = deferred<typeof observation>();
  const signal = new AbortController();
  const events: string[] = [];
  const effects: MonitorEffects = {
    clock,
    signal: signal.signal,
    releaseQualificationLease() {
      events.push('release');
    },
    async launch() {
      events.push('launch');
    },
    observe(abort) {
      events.push('observe');
      abort.addEventListener('abort', () => events.push('observation aborted'));
      return heldObservation.promise;
    },
    cancel(reason) {
      events.push(`cancel:${reason}`);
      return cancellation.promise;
    },
    record() {
      events.push('record');
    },
  };
  const running = monitorCampaign(
    { firstPaidAtMs: 0, qualificationKnownUsd: 0, campaigns: new Map() },
    'one',
    effects,
  );
  return { clock, heldObservation, cancellation, signal, events, running };
}
test('cutoff cancels while observation is held and preserves cancellation ownership past ten seconds', async () => {
  const f = monitorFixture(21_539);
  await tick();
  expect(f.events.slice(0, 3)).toEqual(['release', 'launch', 'observe']);
  f.clock.advance(1);
  await tick();
  expect(f.events.filter((v) => v.startsWith('cancel:'))).toEqual([
    'cancel:cutoff',
  ]);
  f.clock.advance(20);
  f.signal.abort();
  await tick();
  expect(f.events.filter((v) => v.startsWith('cancel:'))).toHaveLength(1);
  f.cancellation.resolve({ ...observation, terminal: true });
  expect((await f.running).reason).toBe('cutoff');
});
test('observation timeout and cutoff racing invoke exactly one cancellation', async () => {
  const f = monitorFixture(21_530);
  await tick();
  f.clock.advance(10);
  await tick();
  expect(f.events.filter((v) => v.startsWith('cancel:'))).toHaveLength(1);
  expect(f.events).toContain('observation aborted');
  f.cancellation.resolve({ ...observation, terminal: true });
  await f.running;
});
test('a ten second observation timeout cancels and never resumes the campaign', async () => {
  const f = monitorFixture();
  await tick();
  f.clock.advance(10);
  await tick();
  expect(f.events).toContain('cancel:observation timeout');
  f.cancellation.resolve({ ...observation, terminal: true });
  await f.running;
  expect(f.events.filter((v) => v === 'launch')).toHaveLength(1);
});
test('active unknown usage continues but newly settled missing usage cancels', async () => {
  const f = monitorFixture();
  await tick();
  f.heldObservation.resolve(observation);
  await tick();
  expect(f.events.filter((v) => v.startsWith('cancel:'))).toEqual([]);
  f.signal.abort();
  await tick();
  f.cancellation.resolve({
    ...observation,
    terminal: true,
    settledFault: 'missing returned usage',
  });
  const result = await f.running;
  expect(result.observation.settledFault).toBe('missing returned usage');
  expect(result.reason).not.toBeNull();
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function roleArtifacts(started = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'observe-')));
  roots.push(root);
  const refs: ArtifactRef[] = [];
  const put = (path: string, body: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
    refs.push({
      path,
      bytes: Buffer.byteLength(body),
      sha256: createHash('sha256').update(body).digest('hex'),
    });
  };
  const role = {
    out_dir: 'driver',
    model: 'anthropic.claude-sonnet-5',
    started_at: started ? '2026-09-09T00:00:00Z' : null,
    finished_at: started ? '2026-09-09T00:00:01Z' : null,
    process_exit: started ? { code: 0, signal: null } : null,
    stop_cause: null,
  };
  put(
    'run/gauntlet-roles.json',
    JSON.stringify({
      conversation: role,
      assessment: {
        ...role,
        out_dir: 'assessment',
        started_at: null,
        finished_at: null,
        process_exit: null,
      },
    }),
  );
  if (started) {
    put(
      'run/driver/run.jsonl',
      '{"type":"llm_request","turn":1}\n{"type":"llm_response","turn":1}\n',
    );
    put(
      'run/driver/usage.jsonl',
      '{"type":"obol.usage","v":"2026-06-08","provider":"anthropic","model":"anthropic.claude-sonnet-5","usage":{"input_tokens":3,"output_tokens":2}}\n',
    );
  }
  return { root, refs };
}
test('settled started roles require authenticated covered usage', () => {
  const f = roleArtifacts();
  expect(verifySettledRoles(f.root, f.refs)).toEqual({
    returnedTurns: 1,
    startedRoles: 1,
  });
  expect(() =>
    verifySettledRoles(
      f.root,
      f.refs.filter((r) => !r.path.endsWith('usage.jsonl')),
    ),
  ).toThrow();
  writeFileSync(join(f.root, 'run/driver/usage.jsonl'), 'changed');
  expect(() => verifySettledRoles(f.root, f.refs)).toThrow();
});
test('a role that never started is not missing billed usage', () => {
  const f = roleArtifacts(false);
  expect(verifySettledRoles(f.root, f.refs)).toEqual({
    returnedTurns: 0,
    startedRoles: 0,
  });
});

test('qualification consumes exclusive ordinals and finishes the diagnostic set after a semantic miss', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qual-set-')));
  roots.push(root);
  const calls: string[] = [];
  const result = await runQualificationSet({
    role: 'driver',
    outputRoot: root,
    now: () => 0,
    firstPaidAtMs: 0,
    stopped: () => false,
    validate() {},
    execute: async (id, _out) => {
      calls.push(id);
      return {
        knownUsd: 0.1,
        complete: true,
        semanticMatch: id !== 'preferences',
        fault: null,
      };
    },
  });
  expect(calls).toEqual([
    'preferences',
    'preferences',
    'engineering',
    'engineering',
    'authorization',
    'authorization',
    'plan-delivery',
    'plan-delivery',
    'feedback-endpoint',
    'feedback-endpoint',
    'partial-refusal',
    'partial-refusal',
  ]);
  expect(result).toMatchObject({
    consumed: 12,
    complete: true,
    semanticMatch: false,
  });
  await expect(
    runQualificationSet({
      role: 'driver',
      outputRoot: root,
      now: () => 0,
      firstPaidAtMs: 0,
      stopped: () => false,
      validate() {},
      execute: async () => {
        throw Error('must not run');
      },
    }),
  ).rejects.toThrow();
});
test('spawn failure consumes one ordinal and an accounting fault stops further admission', async () => {
  for (const throws of [true, false]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'qual-stop-')));
    roots.push(root);
    let calls = 0;
    const result = await runQualificationSet({
      role: 'driver',
      outputRoot: root,
      now: () => 0,
      firstPaidAtMs: 0,
      stopped: () => false,
      validate() {},
      execute: async () => {
        calls++;
        if (throws) throw Error('spawn failed');
        return {
          knownUsd: 0.2,
          complete: false,
          semanticMatch: false,
          fault: 'missing usage',
        };
      },
    });
    expect(calls).toBe(1);
    expect(result.consumed).toBe(1);
    expect(result.complete).toBe(false);
    expect(result.knownUsd).toBe(throws ? 0 : 0.2);
  }
});

test('the historical assessment wrapper keeps its nine-case order and two repetitions', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qual-retained-')));
  roots.push(root);
  const calls: string[] = [];
  const result = await runQualificationSet({
    role: 'assessment',
    outputRoot: root,
    firstPaidAtMs: 0,
    now: () => 0,
    stopped: () => false,
    validate() {},
    async execute(id) {
      calls.push(id);
      return {
        knownUsd: 0.1,
        complete: true,
        semanticMatch: true,
        fault: null,
      };
    },
  });
  expect(calls).toEqual([
    'claude-design',
    'claude-design',
    'known-claude-design',
    'known-claude-design',
    'known-codex-review',
    'known-codex-review',
    'codex-design',
    'codex-design',
    'known-claude-review',
    'known-claude-review',
    'claude-debugging-history',
    'claude-debugging-history',
    'codex-debugging-history',
    'codex-debugging-history',
    'control-e',
    'control-e',
    'control-f',
    'control-f',
  ]);
  expect(result).toEqual({
    knownUsd: 1.8,
    complete: true,
    semanticMatch: true,
    fault: null,
    consumed: 18,
  });
});

test('private manifest binds finite operations and refuses arbitrary commands or later envelope bootstrap', () => {
  const ref = { path: '/private/frozen.json', sha256: 'a'.repeat(64) };
  const manifest = {
    qRoot: '/private/q',
    qSha: 'b'.repeat(40),
    gRoot: '/private/g',
    gSha: 'c'.repeat(40),
    config: ref,
    stateRoot: '/private/state',
    caseRoot: '/private/cases',
    outputRoot: '/private/output',
    round: 1,
    mode: 'assessment',
    operationId: 'assessment-1',
    operationReceipt: '/private/output/operation.json',
    privateLog: '/private/output/operator.log',
    releaseEnvelope: { path: '/private/release/envelope.json' },
    frozenInputs: [ref],
    admissionRefs: [ref],
  };
  expect(parseRoutineManifest(manifest).mode).toBe('assessment');
  expect(() =>
    parseRoutineManifest({ ...manifest, command: ['anything'] }),
  ).toThrow();
  expect(() => parseRoutineManifest({ ...manifest, round: 2 })).toThrow();
  expect(() => parseRoutineManifest({ ...manifest, mode: 'driver' })).toThrow();
  expect(() =>
    parseRoutineManifest({ ...manifest, mode: 'campaign' }),
  ).toThrow();
  expect(
    parseRoutineManifest({ ...manifest, mode: 'driver', releaseEnvelope: ref })
      .mode,
  ).toBe('driver');
});

test('observation abort interrupts synchronous work in a real owned child', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'obs-child-')));
  roots.push(root);
  const script = join(root, 'blocked.ts');
  writeFileSync(script, "process.on('SIGTERM', () => {}); while (true) {}\n");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  try {
    await expect(
      observationChild([script], controller.signal),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1000);
  } finally {
    clearTimeout(timer);
  }
});

test('a failed campaign launcher still causes exactly one cancellation and no retry', async () => {
  const clock = new FakeClock(0);
  const actions: string[] = [];
  const result = await monitorCampaign(
    { firstPaidAtMs: 0, qualificationKnownUsd: 0, campaigns: new Map() },
    'one',
    {
      clock,
      signal: new AbortController().signal,
      releaseQualificationLease() {},
      async launch() {
        actions.push('run');
        throw Error('partial launch');
      },
      async observe() {
        throw Error('must cancel');
      },
      async cancel() {
        actions.push('cancel');
        return { ...observation, terminal: true };
      },
      record() {},
    },
  );
  expect(actions).toEqual(['run', 'cancel']);
  expect(result.reason).not.toBeNull();
});

test('observer process output rejects grades and malformed accounting fields', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'obs-output-')));
  roots.push(root);
  for (const extra of [{ grades: ['pass'] }, { knownUsd: -1 }]) {
    const script = join(root, `${Object.keys(extra)[0]}.ts`);
    writeFileSync(
      script,
      `console.log(${JSON.stringify(JSON.stringify({ ...observation, verified: [], ...extra }))});\n`,
    );
    await expect(
      observationChild([script], new AbortController().signal),
    ).rejects.toThrow();
  }
});

test('controlled driver uses real role supervision, capture validation, and credential-free subject', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qual-driver-')));
  roots.push(root);
  const gRoot = join(root, 'g');
  mkdirSync(join(gRoot, 'src/format'), { recursive: true });
  mkdirSync(join(gRoot, 'src/util'));
  writeFileSync(
    join(gRoot, 'src/format/story-card.ts'),
    'export const parseStoryCard = () => ({ id: "unused", acceptanceCriteria: [] });',
  );
  writeFileSync(
    join(gRoot, 'src/util/id.ts'),
    'export const makeRunId = id => id + "-run";',
  );
  writeFileSync(
    join(gRoot, 'src/index.ts'),
    [
      "import { spawn, spawnSync } from 'node:child_process';",
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import { join, relative } from 'node:path';",
      'const args = process.argv.slice(2); const get = flag => args[args.indexOf(flag) + 1];',
      "if (args[0] !== 'converse' || args.includes('--startup') || get('--max-time') !== '2m' || get('--model') !== 'agent=anthropic.claude-sonnet-5' || !get('--workspace') || !get('--tmux-socket')) throw Error('wrong controlled driver argv');",
      "const child = spawn(get('--launcher'), [], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });",
      "try { await new Promise(done => child.stdout.once('data', done)); const seen = spawnSync('ps', ['eww', '-p', String(child.pid)], { encoding: 'utf8' }).stdout;",
      "writeFileSync(join(process.cwd(), 'boundary.json'), JSON.stringify({ leaked: seen.includes('offline-secret-marker'), privateHome: seen.includes(join(process.cwd(), 'subject-home')), argv: args }));",
      "} finally { child.kill('SIGKILL'); await new Promise(done => child.once('close', done)); }",
      "const out = get('--out'); mkdirSync(join(out, 'captures'));",
      "writeFileSync(join(out, 'captures/final.ansi'), 'Delivered disposition');",
      "writeFileSync(join(out, 'captures/final.json'), JSON.stringify({ cells: [Array.from('Delivered disposition', ch => ({ ch }))] }));",
      "writeFileSync(get('--completion'), JSON.stringify({ status: 'completed', endpoint: 'delivery', reason: 'Delivered', timestamp: new Date().toISOString(), evidence: { path: relative(process.cwd(), join(out, 'captures/final.ansi')), quote: 'Delivered disposition' } }));",
      'writeFileSync(join(out, \'run.jsonl\'), \'{"type":"llm_request","turn":1}\\n{"type":"llm_response","turn":1}\\n\');',
      'writeFileSync(join(out, \'usage.jsonl\'), \'{"type":"obol.usage","v":"2026-06-08","provider":"anthropic","model":"anthropic.claude-sonnet-5","usage":{"input_tokens":3,"output_tokens":2}}\\n\');',
    ].join('\n'),
  );
  const ref = { path: join(root, 'ref'), sha256: 'a'.repeat(64) };
  const m = parseRoutineManifest({
    qRoot: root,
    qSha: 'a'.repeat(40),
    gRoot,
    gSha: 'b'.repeat(40),
    config: ref,
    stateRoot: root,
    caseRoot: root,
    outputRoot: root,
    round: 1,
    mode: 'driver',
    operationId: 'driver-1',
    operationReceipt: join(root, 'operation.json'),
    privateLog: join(root, 'log'),
    releaseEnvelope: ref,
    frozenInputs: [ref],
    admissionRefs: [ref],
  });
  const execute = await prepareQualification(
    m,
    { PATH: getEnv('PATH'), ANTHROPIC_API_KEY: 'offline-secret-marker' },
    () => false,
  );
  const out = join(root, 'out');
  mkdirSync(out);
  const result = await execute('feedback-endpoint', out);
  expect(
    JSON.parse(readFileSync(join(out, 'boundary.json'), 'utf8')),
  ).toMatchObject({ leaked: false, privateHome: true });
  const record = JSON.parse(
    readFileSync(join(out, 'gauntlet-roles.json'), 'utf8'),
  ).conversation;
  expect(record.started_at).not.toBeNull();
  expect(record.process_exit).toEqual({ code: 0, signal: null });
  expect(result.semanticMatch).toBe(true);
});

test('release history forbids round reuse, candidate drift, and progression after terminal faults', () => {
  const base = {
    round: 1 as const,
    mode: 'assessment' as const,
    qSha: 'a',
    gSha: 'b',
  };
  const history = [{ manifest: base, complete: true, fault: null }];
  expect(() => checkOperationHistory(base, history)).toThrow();
  expect(() =>
    checkOperationHistory({ ...base, mode: 'campaign' }, history),
  ).toThrow();
  expect(() =>
    checkOperationHistory(
      { ...base, mode: 'driver', qSha: 'changed' },
      history,
    ),
  ).toThrow();
  expect(() =>
    checkOperationHistory({ ...base, mode: 'driver' }, [
      { ...history[0]!, complete: false },
    ]),
  ).toThrow();
  expect(() =>
    checkOperationHistory({ ...base, mode: 'driver' }, [
      { ...history[0]!, fault: 'settled accounting' },
    ]),
  ).toThrow();
  expect(() =>
    checkOperationHistory({ ...base, round: 2, mode: 'driver' }, []),
  ).toThrow();
  expect(() =>
    checkOperationHistory(
      { ...base, round: 2, mode: 'driver', qSha: 'repair' },
      history,
    ),
  ).not.toThrow();
});

test.skipIf(!getEnv('OBOL_PRICING_DIR'))(
  'operation receipts preserve original envelope and consumed qualification spend across modes',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'operation-')));
    roots.push(root);
    const qRoot = join(root, 'q'),
      gRoot = join(root, 'g'),
      release = join(root, 'release'),
      out = join(root, 'assessment');
    for (const dir of [qRoot, gRoot, release, out])
      mkdirSync(dir, { mode: 0o700 });
    const git = (cwd: string, ...argv: string[]) => {
      const r = spawnSync('git', argv, { cwd, encoding: 'utf8' });
      if (r.status !== 0) throw Error('fixture git failed');
      return r.stdout.trim();
    };
    for (const repo of [qRoot, gRoot]) {
      git(repo, 'init', '-q');
      git(repo, 'config', 'user.email', 'offline@example.invalid');
      git(repo, 'config', 'user.name', 'Offline');
      writeFileSync(join(repo, 'source'), 'fixed');
      git(repo, 'add', 'source');
      git(repo, 'commit', '-qm', 'fixture');
    }
    const pricing = join(qRoot, 'docs/experiments/2026-09-06-pr2258-pricing');
    mkdirSync(pricing, { recursive: true });
    copyFileSync(
      join(getEnv('OBOL_PRICING_DIR')!, 'current.json'),
      join(pricing, 'current.json'),
    );
    git(qRoot, 'add', '.');
    git(qRoot, 'commit', '-qm', 'pricing');
    const config = join(root, 'config.json');
    writeFileSync(
      config,
      JSON.stringify({
        root,
        evals: { path: qRoot, remote: 'origin', ref: 'main' },
        gauntlet: { path: gRoot, remote: 'origin', ref: 'main' },
        superpowers: { path: join(root, 's'), remote: 'origin' },
        credential_bundle: { name: 'blessed', path: join(root, 'bundle') },
        container: {
          name: 'quorum-appliance',
          results_root: join(root, 'results'),
        },
        live_spend_lock: join(root, 'spend'),
      }),
    );
    writeFileSync(join(out, 'operator.log'), '', { mode: 0o600 });
    const ref = { path: config, sha256: hash(readFileSync(config)) };
    const m = {
      qRoot,
      qSha: git(qRoot, 'rev-parse', 'HEAD'),
      gRoot,
      gSha: git(gRoot, 'rev-parse', 'HEAD'),
      config: ref,
      stateRoot: join(root, 'state'),
      caseRoot: join(root, 'cases'),
      outputRoot: out,
      round: 1,
      mode: 'assessment',
      operationId: 'assessment-1',
      operationReceipt: join(out, 'operation.json'),
      privateLog: join(out, 'operator.log'),
      releaseEnvelope: { path: join(release, 'envelope.json') },
      frozenInputs: [ref],
      admissionRefs: [ref],
    };
    const path = join(root, 'manifest.json');
    writeFileSync(path, JSON.stringify(m));
    const op = prepareOperation(path, () => {}, {
      executingRoot: qRoot,
      assertDetached() {},
      pricingDirectory: pricing,
    });
    try {
      op.bootstrap();
      const first = op.envelope().firstPaidAtMs;
      const result = await runQualificationSet({
        role: 'assessment',
        outputRoot: out,
        firstPaidAtMs: first,
        now: () => first,
        stopped: () => false,
        validate() {},
        execute: async () => ({
          knownUsd: 0.1,
          complete: true,
          semanticMatch: true,
          fault: null,
        }),
      });
      marker(join(out, 'settled.json'), result);
      expect(op.envelope().qualificationKnownUsd).toBeCloseTo(1.8, 10);
      expect(() => op.bootstrap()).toThrow();
      const originalBytes = readFileSync(m.releaseEnvelope.path);
      writeFileSync(
        m.releaseEnvelope.path,
        JSON.stringify({ firstPaidAtMs: first + 1000 }),
      );
      expect(() => op.envelope()).toThrow();
      writeFileSync(m.releaseEnvelope.path, originalBytes);
    } finally {
      op.lease.release();
    }
    await expect(
      Promise.resolve().then(() =>
        prepareOperation(path, () => {}, {
          executingRoot: qRoot,
          assertDetached() {},
          pricingDirectory: pricing,
        }),
      ),
    ).rejects.toThrow();
    const driverOut = join(root, 'driver');
    mkdirSync(driverOut, { mode: 0o700 });
    writeFileSync(join(driverOut, 'operator.log'), '', { mode: 0o600 });
    const driverManifest = {
      ...m,
      mode: 'driver',
      operationId: 'driver-1',
      outputRoot: driverOut,
      operationReceipt: join(driverOut, 'operation.json'),
      privateLog: join(driverOut, 'operator.log'),
      releaseEnvelope: {
        path: m.releaseEnvelope.path,
        sha256: hash(readFileSync(m.releaseEnvelope.path)),
      },
    };
    const driverPath = join(root, 'driver-manifest.json');
    writeFileSync(driverPath, JSON.stringify(driverManifest));
    const originalFirstPaid = JSON.parse(
      readFileSync(m.releaseEnvelope.path, 'utf8'),
    ).firstPaidAtMs;
    const originalManifest = readFileSync(path);
    writeFileSync(
      path,
      originalManifest.toString('utf8').replace('assessment-1', 'tampered'),
    );
    let unexpectedOperation: ReturnType<typeof prepareOperation> | undefined;
    try {
      expect(() => {
        unexpectedOperation = prepareOperation(driverPath, () => {}, {
          executingRoot: qRoot,
          assertDetached() {},
          pricingDirectory: pricing,
        });
      }).toThrow();
    } finally {
      unexpectedOperation?.lease.release();
    }
    writeFileSync(path, originalManifest);
    const envelopeBytes = readFileSync(m.releaseEnvelope.path);
    writeFileSync(
      m.releaseEnvelope.path,
      JSON.stringify({ firstPaidAtMs: originalFirstPaid + 1000 }),
    );
    writeFileSync(
      driverPath,
      JSON.stringify({
        ...driverManifest,
        releaseEnvelope: {
          path: m.releaseEnvelope.path,
          sha256: hash(readFileSync(m.releaseEnvelope.path)),
        },
      }),
    );
    const replacedEnvelope: {
      operation?: ReturnType<typeof prepareOperation>;
    } = {};
    try {
      expect(() => {
        replacedEnvelope.operation = prepareOperation(driverPath, () => {}, {
          executingRoot: qRoot,
          assertDetached() {},
          pricingDirectory: pricing,
        });
      }).toThrow();
    } finally {
      replacedEnvelope.operation?.lease.release();
    }
    writeFileSync(m.releaseEnvelope.path, envelopeBytes);
    writeFileSync(driverPath, JSON.stringify(driverManifest));
    const driverOp = prepareOperation(driverPath, () => {}, {
      executingRoot: qRoot,
      assertDetached() {},
      pricingDirectory: pricing,
    });
    try {
      driverOp.bootstrap();
      expect(driverOp.envelope().firstPaidAtMs).toBe(originalFirstPaid);
      expect(driverOp.envelope().qualificationKnownUsd).toBeCloseTo(1.8, 10);
    } finally {
      driverOp.lease.release();
    }
  },
);

test('a terminal observation racing cutoff cannot abandon an already owned cancellation child', async () => {
  const f = monitorFixture(21_539);
  await tick();
  let returned = false;
  void f.running.then(() => {
    returned = true;
  });
  f.clock.advance(1);
  f.heldObservation.resolve({ ...observation, terminal: true });
  await tick();
  expect(f.events.filter((v) => v.startsWith('cancel:'))).toHaveLength(1);
  expect(returned).toBe(false);
  f.cancellation.resolve({ ...observation, terminal: true });
  await f.running;
});

test('failed cancellation receipt publication retains the actual child until settlement', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cancel-owned-')));
  roots.push(root);
  const helper = join(root, 'helper');
  writeFileSync(helper, '#!/bin/sh\nsleep 0.4\n', { mode: 0o700 });
  writeFileSync(join(root, 'cancel-launch.json'), 'preexisting');
  let settled = false;
  const pending = campaignChild(helper, 'cancel', 'one', root).finally(() => {
    settled = true;
  });
  void pending.catch(() => {});
  await Bun.sleep(80);
  expect(settled).toBe(false);
  await expect(pending).rejects.toThrow();
  expect(
    JSON.parse(readFileSync(join(root, 'cancel-settled.json'), 'utf8')),
  ).toEqual({ code: 0, signal: null });
});
