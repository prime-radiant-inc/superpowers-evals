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
function fixture(
  options: {
    reserve?: number;
    maxAttempts?: number;
    price?: number | null;
    fail?: boolean;
    stage?: string;
    missingTelemetry?: boolean;
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
          steps: [{ timestamp: fixtureTime(3) }],
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
  expect(await run).toEqual({
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
  await run;
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
    await run;
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
  await run;
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
  await run;
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
  await run;
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
