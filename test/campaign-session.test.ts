import { afterEach, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttemptPublicationStorageError } from '../src/campaign/attempt-publish.ts';
import {
  runCampaignDispatch,
  type SessionDependencies,
} from '../src/campaign/controller.ts';
import {
  ExecutionJournalWriter,
  initExecutionJournal,
} from '../src/campaign/execution-journal.ts';
import { realProcessIdentityProbe } from '../src/campaign/locks.ts';
import { credentialAuthorityDigest } from '../src/campaign/registration.ts';
import { compileResourcePolicy } from '../src/campaign/resource-policy.ts';
import {
  jcsCanonicalize,
  sha256Hex,
} from '../src/contracts/campaign/digest.ts';
import type {
  AttemptMonitor,
  BoundExecution,
  VerifiedStopped,
} from '../src/contracts/campaign/execution.ts';
import { experimentDigest } from '../src/contracts/campaign/experiment-digest.ts';
import type { Credential } from '../src/contracts/credential.ts';
import { FakeClock, RealClock } from '../src/scheduler/clock.ts';
import {
  blockActivation,
  fixtureTime,
  sessionTransitions,
  twoArmExperiment,
} from './fixtures/core-comparison/factory.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean();
});
async function flush() {
  for (let n = 0; n < 40; n++) await Promise.resolve();
}
async function settle(f: ReturnType<typeof fixture>, run: Promise<unknown>) {
  let done = false;
  let result: unknown;
  void run.then((value) => {
    done = true;
    result = value;
  });
  for (let i = 0; i < 30 && !done; i++) {
    await flush();
    if (done) break;
    const next = f.clock.earliestWaiter();
    if (next === null) throw Error('session made no progress');
    f.clock.setTo(next);
    await flush();
  }
  expect(done).toBe(true);
  return result;
}
function fixture(
  options: {
    reserve?: number;
    maxAttempts?: number;
    price?: number | null;
    fail?: boolean;
    stage?: string;
    missingTelemetry?: boolean;
    n?: number;
    spacing?: number;
    sharedKeyPool?: boolean;
    aliasCap?: boolean;
    extraScenario?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'session-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const resultsRoot = join(root, 'measurements');
  mkdirSync(resultsRoot);
  const experiment = twoArmExperiment();
  experiment.suite.reserve = options.reserve ?? 1;
  if (!experiment.suite.reserve) experiment.reserve_slots = [];
  experiment.suite.attempt_bounds.max_attempts = options.maxAttempts ?? 2;
  experiment.contention.thresholds = [
    { metric: 'load1', source: 'host', op: 'gt', value: 3 },
  ];
  const registry: Record<string, Credential> = {
    subject: {
      auth: 'api-key',
      api: 'anthropic',
      model: 'model',
      api_key_env: 'SUBJECT',
      max_concurrency: 2,
      harnesses: ['claude'],
      compat: {},
    },
    grader: {
      auth: 'api-key',
      api: 'anthropic',
      model: 'model',
      api_key_env: 'GRADER',
      max_concurrency: 2,
      harnesses: ['claude'],
      compat: {},
    },
  };
  if (options.n === 2) {
    experiment.suite.comparisons[0]!.n = 2;
    experiment.cells[0]!.n = 2;
    experiment.planned_slots.push(
      ...experiment.planned_slots.map((slot) => ({
        ...slot,
        sample_id: `${slot.sample_id}-second`,
        primary_block_id: 'second',
        replicate: 2,
      })),
    );
  }
  if (options.spacing)
    registry['subject']!.launch_spacing_seconds = options.spacing;
  if (options.sharedKeyPool) {
    for (const credential of Object.values(registry)) {
      delete credential.api_key_env;
      credential.key_pool = ['KEY_A', 'KEY_B'];
    }
  }
  if (options.aliasCap) {
    registry['subject']!.max_concurrency = 4;
    registry['subject']!.quota_pool = 'shared_subject';
    registry['alias'] = { ...registry['subject']!, max_concurrency: 2 };
    registry['grader']!.max_concurrency = 4;
    experiment.contention.global_run_cap = 4;
  }
  if (options.extraScenario) {
    experiment.suite.comparisons[0]!.scenarios = ['scenario', 'slow'];
    experiment.cells.push({ ...experiment.cells[0]!, scenario: 'slow' });
    experiment.planned_slots.push(
      ...experiment.planned_slots.map((slot) => ({
        ...slot,
        sample_id: `${slot.sample_id}-slow`,
        primary_block_id: 'z-last',
        scenario: 'slow',
      })),
    );
    experiment.estimates = {
      scenario: {
        base: { duration_s: 1, cost_usd: 999, confidence: 'high' },
        candidate: { duration_s: 1, cost_usd: 999, confidence: 'high' },
      },
      slow: {
        base: { duration_s: 10, cost_usd: 1, confidence: 'high' },
        candidate: { duration_s: 10, cost_usd: 1, confidence: 'high' },
      },
    };
  }
  experiment.pool_policy = [
    ...compileResourcePolicy(registry, ['subject', 'grader']).values(),
  ];
  experiment.credential_authority_digest = credentialAuthorityDigest(registry, [
    'subject',
    'grader',
  ]);
  experiment.input_digest = experimentDigest(experiment);
  initExecutionJournal({ campaignDir: root, experiment });
  writeFileSync(join(root, 'campaign.json'), JSON.stringify(experiment));
  const writer = ExecutionJournalWriter.elect({
    campaignDir: root,
    experiment,
    clock: new RealClock(),
    identity: realProcessIdentityProbe,
  });
  cleanups.push(() => writer.release());
  for (const t of sessionTransitions(experiment)) writer.commitTransition(t);
  const clock = new FakeClock(Date.parse(fixtureTime(3)) / 1000);
  const started: BoundExecution[] = [];
  const monitors = new Map<
    string,
    { stopped?: (s: VerifiedStopped) => void; failed?: (s: string) => void }
  >();
  const alive = new Set<string>();
  const cuts: string[] = [];
  let guards: Parameters<SessionDependencies['runtime']>[0];
  let finish = false;
  const deps: SessionDependencies = {
    clock,
    registry: () => registry,
    verifySnapshot() {},
    prepare(args) {
      const template = blockActivation(
        experiment,
        args.attemptNumber > 1,
      ).attempts.find((a) => a.identity.sample_id === args.slot.sample_id)!;
      template.identity.block_id = args.blockId;
      template.attempt_number = args.attemptNumber;
      template.output_root = join(root, template.identity.execution_attempt_id);
      template.runtime_spec.public_env.QUORUM_ATTEMPT_DIR =
        template.output_root;
      template.runtime_spec_digest = sha256Hex(
        jcsCanonicalize(template.runtime_spec),
      );
      return { intent: template };
    },
    runtime(authorize) {
      guards = authorize;
      return {
        async create(prepared) {
          guards.assertCreateAuthorized(prepared);
          return {
            ...prepared,
            container_id: sha256Hex(
              prepared.intent.identity.execution_attempt_id,
            ),
          };
        },
        async start(bound) {
          guards.assertStartAuthorized(bound);
          started.push(bound);
          alive.add(bound.intent.identity.execution_attempt_id);
          const callbacks = {};
          monitors.set(bound.intent.identity.execution_attempt_id, callbacks);
          return {
            startedAt: new Date(clock.now() * 1000).toISOString(),
            onStopped(fn) {
              Object.assign(callbacks, { stopped: fn });
            },
            onMonitorFailure(fn) {
              Object.assign(callbacks, { failed: fn });
            },
          } satisfies AttemptMonitor;
        },
        async inspectOwned(prepared) {
          const id = prepared.intent.identity.execution_attempt_id;
          const a = writer.readProjection().attempts.get(id);
          if (!a?.container_id) return { kind: 'absent' as const };
          return {
            kind: alive.has(id)
              ? ('matching-running' as const)
              : ('matching-stopped' as const),
            container_id: a.container_id,
            runtime_spec_digest: prepared.intent.runtime_spec_digest,
          };
        },
        async stop(bound) {
          const id = bound.intent.identity.execution_attempt_id;
          cuts.push(`stop:${id}`);
          alive.delete(id);
          return { kind: 'dead' as const, stopped: stopped(bound) };
        },
        assertNoUnsettledStarts() {
          expect(alive.size).toBe(0);
        },
      };
    },
    publish({ bound }) {
      const id = bound.intent.identity.execution_attempt_id;
      const runRoot = join(resultsRoot, id);
      mkdirSync(runRoot);
      const verdict = {
        schema: 1,
        final:
          options.stage && bound.intent.attempt_number === 1
            ? 'indeterminate'
            : options.fail
              ? 'fail'
              : 'pass',
        final_reason: 'fixture',
        gauntlet: null,
        checks: [],
        error:
          options.stage && bound.intent.attempt_number === 1
            ? { stage: options.stage, message: 'typed failure' }
            : null,
        campaign: bound.intent.identity,
        economics: { observed_cost: options.price ?? null },
      };
      const files = {
        'verdict.json': JSON.stringify(verdict),
        'trajectory.json': JSON.stringify({
          steps: [
            {
              timestamp: writer.readProjection().attempts.get(id)!.prepared_at,
            },
          ],
        }),
      };
      return {
        runId: id,
        artifacts: Object.entries(files).map(([file, body]) => {
          writeFileSync(join(runRoot, file), body);
          return {
            path: `${id}/${file}`,
            bytes: Buffer.byteLength(body),
            sha256: sha256Hex(body),
          };
        }),
      };
    },
    probe: {
      sample(now) {
        if (options.missingTelemetry) throw new Error('probe missing');
        clock.advance(0.001);
        return {
          ts_ms: now,
          load1: 0,
          mem_available_bytes: 1000,
          mem_total_bytes: 4096,
          swap_used_bytes: 0,
          swap_total_bytes: 0,
          process_count: 1,
          pid_max: 999,
          disk_free_bytes: 1000,
          disk_total_bytes: 8192,
        };
      },
    },
    cancelIntent: () => null,
    finish(runtime) {
      runtime.assertNoUnsettledStarts();
      finish = true;
    },
    storageFailure() {
      cuts.push('storage');
    },
  };
  const context = {
    campaignDir: root,
    experiment,
    writer,
    resultsRoot,
    assertAdmission() {
      writer.assertCurrentOwner();
      if (writer.readProjection().ended) throw Error('ended');
    },
  };
  function stopped(bound: BoundExecution): VerifiedStopped {
    return {
      execution_attempt_id: bound.intent.identity.execution_attempt_id,
      container_id: bound.container_id,
      proof: 'inspected_stopped',
      observed_at: new Date(clock.now() * 1000).toISOString(),
    };
  }
  function complete(index: number) {
    const b = started[index]!;
    alive.delete(b.intent.identity.execution_attempt_id);
    monitors.get(b.intent.identity.execution_attempt_id)!.stopped!(stopped(b));
  }
  return {
    context,
    deps,
    registry,
    clock,
    started,
    writer,
    alive,
    cuts,
    monitors,
    complete,
    get finished() {
      return finish;
    },
  };
}

test('the session admits a coherent block, commits death before release, and validates completion', async () => {
  const f = fixture();
  const run = runCampaignDispatch(f.context, f.deps);
  await flush();
  expect(f.started).toHaveLength(2);
  expect(f.writer.readProjection().attempts.size).toBe(2);
  f.complete(0);
  await flush();
  expect(
    f.writer
      .readProjection()
      .attempts.get(f.started[0]!.intent.identity.execution_attempt_id)
      ?.stopped,
  ).not.toBeNull();
  f.complete(1);
  await flush();
  expect(await settle(f, run)).toEqual({
    outcome: 'completed',
    reason: 'planned comparison resolved',
  });
  expect(
    f.writer.readProjection().blocks.get('primary')?.validity_receipt,
  ).not.toBeNull();
  expect(f.finished).toBe(true);
});

test('a typed instrument failure stops every predecessor before bounded whole-block replacement', async () => {
  const f = fixture({ stage: 'capture' });
  const run = runCampaignDispatch(f.context, f.deps);
  await flush();
  f.complete(0);
  await flush();
  expect(f.cuts).toContain('stop:sample-candidate-1');
  expect(f.started).toHaveLength(4);
  const p = f.writer.readProjection();
  expect(p.consumed_reserves.size).toBe(1);
  expect(
    [...p.attempts.values()]
      .filter((a) => a.intent.attempt_number === 1)
      .every((a) => a.stopped),
  ).toBe(true);
  f.complete(2);
  f.complete(3);
  await flush();
  await settle(f, run);
  expect(f.writer.readProjection().attempts.size).toBe(4);
});

test('unknown price and behavioral failure change observations but never admission', async () => {
  const identities: string[][] = [];
  for (const price of [1, null]) {
    const f = fixture({ price, fail: true, reserve: 0 });
    const run = runCampaignDispatch(f.context, f.deps);
    await flush();
    f.complete(0);
    f.complete(1);
    await flush();
    await settle(f, run);
    identities.push(
      f.started.map((b) => b.intent.identity.execution_attempt_id),
    );
    expect(
      [...f.writer.readProjection().attempts.values()].map(
        (a) => a.observation?.outcome,
      ),
    ).toEqual(['fail', 'fail']);
  }
  expect(identities[0]).toEqual(identities[1]);
});

test('a permanent grader configuration failure ends the session and stops its sibling', async () => {
  const f = fixture({ stage: 'qa-agent-misconfigured' });
  const run = runCampaignDispatch(f.context, f.deps);
  await flush();
  f.complete(0);
  await flush();
  expect((await run).outcome).toBe('interrupted');
  expect(f.started).toHaveLength(2);
  expect(f.alive.size).toBe(0);
  expect(f.writer.readProjection().consumed_reserves.size).toBe(0);
  expect(f.finished).toBe(true);
});

test('a missing required host sample excludes the block and exhausts finite allowance', async () => {
  const f = fixture({ missingTelemetry: true, reserve: 0 });
  const run = runCampaignDispatch(f.context, f.deps);
  await flush();
  f.complete(0);
  f.complete(1);
  await flush();
  await settle(f, run);
  const p = f.writer.readProjection();
  expect(p.blocks.get('primary')?.excluded).toBe('missing_telemetry');
  expect(p.blocks.get('primary')?.validity_receipt).toBeNull();
  expect(p.exhausted_blocks.get('primary')).toBe('missing_telemetry');
  expect(f.started).toHaveLength(2);
});

test('attempt allowance can prevent replacement even when a reserve remains', async () => {
  const f = fixture({ stage: 'capture', maxAttempts: 1 });
  const run = runCampaignDispatch(f.context, f.deps);
  await flush();
  f.complete(0);
  await flush();
  await settle(f, run);
  expect(f.writer.readProjection().exhausted_blocks.get('primary')).toBe(
    'capture_failed',
  );
  expect(f.writer.readProjection().consumed_reserves.size).toBe(0);
  expect(f.started).toHaveLength(2);
});

test('unknown runtime state retains the claim and capacity without replacing', async () => {
  const f = fixture();
  const factory = f.deps.runtime;
  f.deps.runtime = (guards) => {
    const runtime = factory(guards);
    runtime.inspectOwned = async () => ({
      kind: 'unresolved',
      reason: 'daemon unknown',
    });
    runtime.stop = async () => ({
      kind: 'unresolved',
      reason: 'daemon unknown',
    });
    runtime.assertNoUnsettledStarts = () => {
      throw Error('start unsettled');
    };
    return runtime;
  };
  const run = runCampaignDispatch(f.context, f.deps);
  await flush();
  f.monitors.get('sample-base-1')!.failed!('wait client timed out');
  await flush();
  expect((await run).outcome).toBe('interrupted');
  expect(f.finished).toBe(false);
  expect(
    [...f.writer.readProjection().attempts.values()].every(
      (a) => a.stopped === null,
    ),
  ).toBe(true);
  expect(f.writer.readProjection().consumed_reserves.size).toBe(0);
});

test('a fence cut after create prevents binding/start and still stops discovered owned work', async () => {
  const f = fixture();
  const factory = f.deps.runtime;
  let fenced = false;
  f.context.assertAdmission = () => {
    if (fenced) throw Error('fence lost');
  };
  f.deps.runtime = (guards) => {
    const runtime = factory(guards);
    const create = runtime.create.bind(runtime);
    runtime.create = async (prepared) => {
      const bound = await create(prepared);
      fenced = true;
      return bound;
    };
    return runtime;
  };
  const result = await runCampaignDispatch(f.context, f.deps);
  expect(result.outcome).toBe('interrupted');
  expect(f.started).toHaveLength(0);
  expect(
    [...f.writer.readProjection().attempts.values()].every(
      (a) => a.stopped !== null,
    ),
  ).toBe(true);
});

test('journal storage failure stops all workers before the emergency evidence path', async () => {
  const f = fixture();
  const commit = f.writer.commitTransition.bind(f.writer);
  f.writer.commitTransition = (input) => {
    if (
      input.type === 'attempt_observed' ||
      input.type === 'accounting_observed'
    )
      throw Error('SQLITE_FULL');
    return commit(input);
  };
  f.deps.storageFailure = (stopped, unresolved) => {
    expect(f.alive.size).toBe(0);
    expect(stopped).toHaveLength(2);
    expect(unresolved).toHaveLength(0);
    f.cuts.push('storage');
  };
  const run = runCampaignDispatch(f.context, f.deps);
  await flush();
  f.complete(0);
  await flush();
  await settle(f, run);
  expect(f.cuts).toContain('storage');
  expect(f.started).toHaveLength(2);
  expect(f.finished).toBe(false);
});

test('cancellation during a successful start preserves the start receipt and adds accounting only', async () => {
  const f = fixture();
  const factory = f.deps.runtime;
  let cancelled = false;
  f.deps.cancelIntent = () =>
    cancelled
      ? {
          ref: {
            path: 'cancel-intent.json',
            sha256: 'a'.repeat(64),
            bytes: 12,
          },
          controllerLoss: false,
        }
      : null;
  f.deps.runtime = (guards) => {
    const runtime = factory(guards);
    const start = runtime.start.bind(runtime);
    runtime.start = async (bound) => {
      const result = await start(bound);
      cancelled = true;
      return result;
    };
    return runtime;
  };
  const result = await runCampaignDispatch(f.context, f.deps);
  expect(result.outcome).toBe('cancelled');
  const attempts = [...f.writer.readProjection().attempts.values()];
  expect(attempts[0]?.started_at).not.toBeNull();
  expect(attempts.every((a) => a.observation === null)).toBe(true);
  expect(attempts.every((a) => a.accounting !== null)).toBe(true);
  expect(f.started).toHaveLength(1);
});

test('opaque publication storage failure stops every worker before emergency evidence', async () => {
  const f = fixture();
  f.deps.publish = () => {
    throw new AttemptPublicationStorageError(
      'directory sync failed',
      Error('opaque'),
    );
  };
  f.deps.storageFailure = (stopped, unresolved) => {
    expect(f.alive.size).toBe(0);
    expect(stopped).toHaveLength(2);
    expect(unresolved).toHaveLength(0);
    f.cuts.push('storage');
  };
  const run = runCampaignDispatch(f.context, f.deps);
  await flush();
  f.complete(0);
  await settle(f, run);
  expect(f.cuts).toContain('storage');
  expect(f.started).toHaveLength(2);
  expect(f.finished).toBe(false);
});

test('key grants remain per credential beneath aggregate pools', async () => {
  const f = fixture({ sharedKeyPool: true });
  const run = runCampaignDispatch(f.context, f.deps);
  await flush();
  expect(f.started).toHaveLength(2);
  f.complete(0);
  f.complete(1);
  await flush();
  await settle(f, run);
});

test('a follower death latched before the start continuation keeps producer time ordering', async () => {
  const f = fixture();
  const factory = f.deps.runtime;
  let receiptAt: string | undefined;
  f.deps.runtime = (guards) => {
    const runtime = factory(guards);
    const start = runtime.start.bind(runtime);
    runtime.start = async (bound) => {
      const monitor = await start(bound);
      receiptAt ??= monitor.startedAt;
      const stopped: VerifiedStopped = {
        execution_attempt_id: bound.intent.identity.execution_attempt_id,
        container_id: bound.container_id,
        proof: 'inspected_stopped',
        observed_at: new Date(f.clock.now() * 1000).toISOString(),
      };
      f.alive.delete(stopped.execution_attempt_id);
      f.clock.advance(1);
      return {
        ...monitor,
        onStopped(callback) {
          callback(stopped);
        },
      };
    };
    return runtime;
  };
  const run = runCampaignDispatch(f.context, f.deps);
  await settle(f, run);
  const p = f.writer.readProjection();
  expect(p.attempts.get('sample-base-1')?.started_at).toBe(receiptAt);
  expect([...p.attempts.values()].every((a) => a.observation !== null)).toBe(
    true,
  );
  expect(p.ended?.outcome).toBe('completed');
  expect(f.cuts).not.toContain('storage');
});

test('whole-block capacity remains occupied until both predecessor deaths commit', async () => {
  const f = fixture({ n: 2, reserve: 0 });
  const run = runCampaignDispatch(f.context, f.deps);
  await flush();
  expect(f.started.map((a) => a.intent.primary_block_id)).toEqual([
    'primary',
    'primary',
  ]);
  f.complete(0);
  await flush();
  expect(f.started).toHaveLength(2);
  f.complete(1);
  await flush();
  expect(f.started.map((a) => a.intent.primary_block_id)).toEqual([
    'primary',
    'primary',
    'second',
    'second',
  ]);
  f.complete(2);
  f.complete(3);
  await flush();
  await settle(f, run);
});

test('pool launch spacing is preserved within an atomically admitted block', async () => {
  const f = fixture({ spacing: 1, reserve: 0 });
  const run = runCampaignDispatch(f.context, f.deps);
  await flush();
  expect(f.started).toHaveLength(1);
  expect(f.writer.readProjection().attempts.size).toBe(2);
  f.clock.advance(0.5);
  await flush();
  expect(f.started).toHaveLength(1);
  f.clock.advance(0.5);
  await flush();
  expect(f.started).toHaveLength(2);
  f.complete(0);
  f.complete(1);
  await flush();
  await settle(f, run);
});

test('a terminal instrument failure during sibling spacing prevents that sibling start', async () => {
  const f = fixture({ spacing: 1, stage: 'capture', reserve: 0 });
  const run = runCampaignDispatch(f.context, f.deps);
  await flush();
  expect(f.started).toHaveLength(1);
  f.complete(0);
  await flush();
  expect(
    f.writer.readProjection().attempts.get('sample-candidate-1')?.stopped,
  ).not.toBeNull();
  expect(f.started).toHaveLength(1);
  await settle(f, run);
});

test('positive validity waits for telemetry closing every worker interval', async () => {
  const f = fixture({ reserve: 0 });
  const run = runCampaignDispatch(f.context, f.deps);
  await flush();
  f.complete(0);
  f.complete(1);
  await flush();
  expect(f.writer.readProjection().ended).toBeNull();
  expect(
    f.writer.readProjection().blocks.get('primary')?.validity_receipt,
  ).toBeNull();
  await settle(f, run);
  expect(f.writer.readProjection().ended?.outcome).toBe('completed');
});

test('verified death after monitor failure retains an indeterminate observation without a replacement', async () => {
  const f = fixture();
  const run = runCampaignDispatch(f.context, f.deps);
  await flush();
  f.monitors.get('sample-base-1')!.failed!('client timeout 124');
  await flush();
  await settle(f, run);
  const p = f.writer.readProjection();
  expect(p.attempts.get('sample-base-1')?.observation?.outcome).toBe(
    'indeterminate',
  );
  expect(p.attempts.get('sample-base-1')?.observation?.cause).toBeNull();
  expect(p.consumed_reserves.size).toBe(0);
  expect(f.finished).toBe(true);
});

test('a replacement followed by cancellation leaves the next primary never activated', async () => {
  const f = fixture({ n: 2, stage: 'capture' });
  const factory = f.deps.runtime;
  let cancelled = false;
  f.deps.cancelIntent = () =>
    cancelled
      ? {
          ref: { path: 'cancel-intent.json', bytes: 1, sha256: 'a'.repeat(64) },
          controllerLoss: false,
        }
      : null;
  f.deps.runtime = (guards) => {
    const runtime = factory(guards);
    const start = runtime.start.bind(runtime);
    runtime.start = async (bound) => {
      const monitor = await start(bound);
      if (f.started.length === 4) cancelled = true;
      return monitor;
    };
    return runtime;
  };
  const run = runCampaignDispatch(f.context, f.deps);
  await flush();
  f.complete(0);
  await flush();
  await settle(f, run);
  const p = f.writer.readProjection();
  expect(p.consumed_reserves.size).toBe(1);
  expect(p.attempts.size).toBe(4);
  expect(p.selected_blocks.has('second')).toBe(false);
  expect(p.ended?.outcome).toBe('cancelled');
});

test('a stricter unused credential alias limits aggregate session admission', async () => {
  const f = fixture({ n: 2, aliasCap: true, reserve: 0 });
  const run = runCampaignDispatch(f.context, f.deps);
  await flush();
  expect(f.started).toHaveLength(2);
  f.complete(0);
  await flush();
  expect(f.started).toHaveLength(2);
  f.complete(1);
  await flush();
  expect(f.started).toHaveLength(4);
  f.complete(2);
  f.complete(3);
  await settle(f, run);
});

test('greedy session admission retains longest duration priority independently of cost', async () => {
  const f = fixture({ extraScenario: true, reserve: 0 });
  const run = runCampaignDispatch(f.context, f.deps);
  await flush();
  expect(f.started.map((a) => a.intent.primary_block_id)).toEqual([
    'z-last',
    'z-last',
  ]);
  f.complete(0);
  f.complete(1);
  await flush();
  expect(f.started.map((a) => a.intent.primary_block_id)).toEqual([
    'z-last',
    'z-last',
    'primary',
    'primary',
  ]);
  f.complete(2);
  f.complete(3);
  await settle(f, run);
});

test('corrupt published verdict bytes can never promote a passing observation', async () => {
  const f = fixture({ reserve: 0 });
  const publish = f.deps.publish;
  f.deps.publish = (args) => {
    const result = publish(args);
    const ref = result.artifacts.find((a) => a.path.endsWith('/verdict.json'))!;
    writeFileSync(join(f.context.resultsRoot, ref.path), '{}');
    return result;
  };
  const run = runCampaignDispatch(f.context, f.deps);
  await flush();
  f.complete(0);
  f.complete(1);
  await settle(f, run);
  expect(
    [...f.writer.readProjection().attempts.values()].map(
      (a) => a.observation?.outcome,
    ),
  ).toEqual(['indeterminate', 'indeterminate']);
  expect(
    [...f.writer.readProjection().attempts.values()].every(
      (a) => a.observation?.evidence_missing !== null,
    ),
  ).toBe(true);
});

test('late exposure corruption permanently excludes retained observations when no reserve remains', async () => {
  const f = fixture({ reserve: 0 });
  const run = runCampaignDispatch(f.context, f.deps);
  await flush();
  f.complete(0);
  await flush();
  const ref = f.writer
    .readProjection()
    .attempts.get('sample-base-1')!
    .observation!.artifacts.find((a) => a.path.endsWith('/trajectory.json'))!;
  writeFileSync(join(f.context.resultsRoot, ref.path), '{}');
  f.complete(1);
  await settle(f, run);
  const p = f.writer.readProjection();
  expect(p.blocks.get('primary')?.excluded).toBe('exposure');
  expect(p.exhausted_blocks.get('primary')).toBe('exposure');
  expect(p.attempts.get('sample-base-1')?.observation?.outcome).toBe('pass');
});

test('a cancellation signal wakes a long pool spacing wait before another start', async () => {
  const f = fixture({ spacing: 120, reserve: 0 });
  const cancel = new AbortController();
  f.deps.signal = cancel.signal;
  f.deps.cancelIntent = () =>
    cancel.signal.aborted
      ? {
          ref: { path: 'cancel-intent.json', bytes: 1, sha256: 'a'.repeat(64) },
          controllerLoss: false,
        }
      : null;
  const run = runCampaignDispatch(f.context, f.deps);
  await flush();
  expect(f.started).toHaveLength(1);
  cancel.abort();
  await flush();
  expect(f.alive.size).toBe(0);
  expect((await run).outcome).toBe('cancelled');
  expect(f.started).toHaveLength(1);
});

test('final audit invalidation keeps real telemetry alive for a legal reserve', async () => {
  const f = fixture();
  let invalidatedAfterPositive = false;
  const verify = f.deps.verifySnapshot;
  f.deps.verifySnapshot = () => {
    verify();
    const p = f.writer.readProjection();
    if (
      p.blocks.get('primary')?.validity_receipt &&
      !invalidatedAfterPositive
    ) {
      invalidatedAfterPositive = true;
      const ref = p.attempts
        .get('sample-base-1')!
        .observation!.artifacts.find((a) =>
          a.path.endsWith('/trajectory.json'),
        )!;
      writeFileSync(join(f.context.resultsRoot, ref.path), '{}');
    }
  };
  const sample = f.deps.probe.sample.bind(f.deps.probe);
  const sampledAt: number[] = [];
  f.deps.probe.sample = (at) => {
    sampledAt.push(at);
    return sample(at);
  };
  const run = runCampaignDispatch(f.context, f.deps);
  await flush();
  f.complete(0);
  f.complete(1);
  for (let i = 0; i < 10 && f.started.length < 4; i++) {
    const next = f.clock.earliestWaiter();
    if (next !== null) f.clock.setTo(next);
    await flush();
  }
  expect(invalidatedAfterPositive).toBe(true);
  expect(f.started).toHaveLength(4);
  f.clock.advance(0.02);
  await flush();
  f.complete(2);
  f.complete(3);
  const stoppedAt = f.clock.now() * 1000;
  await settle(f, run);
  const p = f.writer.readProjection();
  expect(sampledAt.some((at) => at >= stoppedAt)).toBe(true);
  expect(p.blocks.get('primary')?.validity_receipt).not.toBeNull();
  expect(p.blocks.get('primary')?.excluded).toBe('exposure');
  const selected = p.blocks.get(p.selected_blocks.get('primary')!)!;
  expect(selected.activation.block_id).not.toBe('primary');
  expect(selected.validity_receipt).not.toBeNull();
  expect(selected.excluded).toBeNull();
  expect(p.ended?.outcome).toBe('completed');
});

function publishedSensor(
  f: ReturnType<typeof fixture>,
  file: string,
  body: string,
  omitVerdict = false,
) {
  const publish = f.deps.publish;
  f.deps.publish = (args) => {
    const result = publish(args);
    if (args.bound.intent.attempt_number === 1) {
      const path = `${result.runId}/gauntlet-agent/results/grader/${file}`;
      mkdirSync(
        join(
          f.context.resultsRoot,
          result.runId,
          'gauntlet-agent/results/grader',
        ),
        { recursive: true },
      );
      writeFileSync(join(f.context.resultsRoot, path), body);
      result.artifacts.push({
        path,
        bytes: Buffer.byteLength(body),
        sha256: sha256Hex(body),
      });
      if (omitVerdict)
        result.artifacts = result.artifacts.filter(
          (ref) => !ref.path.endsWith('/verdict.json'),
        );
    }
    return result;
  };
}

test('authenticated grader rate limits latch the shared pool before whole-block replacement', async () => {
  const f = fixture();
  publishedSensor(
    f,
    'result.json',
    JSON.stringify({
      summary: '{"type":"rate_limit_error"}',
      reasoning: 'retry-after: 5',
    }),
  );
  const run = runCampaignDispatch(f.context, f.deps);
  await flush();
  f.complete(0);
  await flush();
  expect(
    f.writer.readProjection().attempts.get('sample-base-1')?.observation?.cause,
  ).toBe('grader_rate_limited');
  expect(f.started).toHaveLength(2);
  f.clock.advance(4);
  await flush();
  expect(f.started).toHaveLength(2);
  f.clock.advance(2);
  await flush();
  expect(f.started).toHaveLength(4);
  f.complete(2);
  f.complete(3);
  await settle(f, run);
});

test('authenticated stream billing failure is permanent even without a verdict file', async () => {
  const f = fixture();
  publishedSensor(
    f,
    'run.jsonl',
    `${JSON.stringify({ type: 'run_error', message: '{"message":"Your credit balance is too low"}' })}\n`,
    true,
  );
  const run = runCampaignDispatch(f.context, f.deps);
  await flush();
  f.complete(0);
  await flush();
  await settle(f, run);
  expect(
    f.writer.readProjection().attempts.get('sample-base-1')?.observation?.cause,
  ).toBe('grader_billing_exhausted');
  expect(f.writer.readProjection().ended?.reason).toBe(
    'grader_billing_exhausted',
  );
  expect(f.started).toHaveLength(2);
});

test('an exposure timestamp outside the owned attempt interval cannot validate a block', async () => {
  const f = fixture({ reserve: 0 });
  const publish = f.deps.publish;
  f.deps.publish = (args) => {
    const result = publish(args);
    const ref = result.artifacts.find((a) =>
      a.path.endsWith('/trajectory.json'),
    )!;
    const body = JSON.stringify({ steps: [{ timestamp: fixtureTime(-30) }] });
    writeFileSync(join(f.context.resultsRoot, ref.path), body);
    ref.bytes = Buffer.byteLength(body);
    ref.sha256 = sha256Hex(body);
    return result;
  };
  const run = runCampaignDispatch(f.context, f.deps);
  await flush();
  f.complete(0);
  f.complete(1);
  await settle(f, run);
  expect(f.writer.readProjection().blocks.get('primary')?.excluded).toBe(
    'exposure',
  );
});

test('mixed Quorum stderr cannot attribute a rate limit or throttle either actor pool', async () => {
  const f = fixture({ n: 2 });
  const publish = f.deps.publish;
  f.deps.publish = (args) => {
    const result = publish(args);
    const body = '{"type":"rate_limit_error"}\n';
    mkdirSync(args.bound.intent.output_root, { recursive: true });
    writeFileSync(join(args.bound.intent.output_root, 'stderr.log'), body);
    const path = `${result.runId}/stderr.log`;
    writeFileSync(join(f.context.resultsRoot, path), body);
    result.artifacts.push({
      path,
      bytes: Buffer.byteLength(body),
      sha256: sha256Hex(body),
    });
    return result;
  };
  const run = runCampaignDispatch(f.context, f.deps);
  await flush();
  f.complete(0);
  f.complete(1);
  await flush();
  expect(
    f.writer.readProjection().attempts.get('sample-base-1')?.observation?.cause,
  ).toBeNull();
  expect(f.started.map((a) => a.intent.primary_block_id)).toEqual([
    'primary',
    'primary',
    'second',
    'second',
  ]);
  f.complete(2);
  f.complete(3);
  await settle(f, run);
  expect(f.writer.readProjection().consumed_reserves.size).toBe(0);
});
