import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { acquireLock, withMutationLocks } from '../src/appliance/locks.ts';
import {
  cancelCampaign,
  completeControllerTermination,
  observeCampaignStatus,
  publishLauncherRelease,
} from '../src/campaign/cancellation.ts';
import { readProjection } from '../src/campaign/execution-journal.ts';
import {
  acquireLiveSpendLock,
  realProcessIdentityProbe,
} from '../src/campaign/locks.ts';
import {
  currentProcessIdentity,
  publishCancelIntent,
  publishHostClaim,
  readHostClaim,
} from '../src/campaign/ownership.ts';
import {
  jcsCanonicalize,
  sha256Hex,
} from '../src/contracts/campaign/digest.ts';
import type { ProcessIdentity } from '../src/contracts/campaign/execution.ts';
import { RealClock } from '../src/scheduler/clock.ts';
import {
  blockActivation,
  evidenceRef,
  observation,
  transition,
} from './fixtures/core-comparison/factory.ts';
import { lifecycleFixture } from './fixtures/core-comparison/lifecycle.ts';

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const f = lifecycleFixture();
  cleanup.push(f.root);
  return f;
}
const dead = { observe: () => 'dead' as const, stop: async () => true };
const noRuntime = () => ({
  create: async () => {
    throw Error('create forbidden');
  },
  start: async () => {
    throw Error('start forbidden');
  },
  inspectOwned: async () => ({ kind: 'absent' as const }),
  stop: async () => {
    throw Error('no bound attempts');
  },
});
function started(f: ReturnType<typeof fixture>, bound = false) {
  const w = f.elect();
  w.commitTransition(
    transition(
      'started',
      {
        campaign_id: f.experiment.campaign_id,
        input_digest: f.experiment.input_digest,
        start_id: 'start',
        launcher: currentProcessIdentity(),
        claimed_at: '2026-09-04T00:00:01.000Z',
      },
      1,
    ),
  );
  if (bound) claimStart(f).release();
  if (bound)
    w.commitTransition(
      transition(
        'controller_bound',
        { start_id: 'start', controller: currentProcessIdentity() },
        2,
      ),
    );
  w.release();
}
function claimStart(f: ReturnType<typeof fixture>) {
  const lease = acquireLiveSpendLock({
    lockPath: f.loaded.config.live_spend_lock!,
    clock: new RealClock(),
    identity: realProcessIdentityProbe,
  });
  publishHostClaim(
    { ...readProjection(f.campaignDir).start!, campaign_dir: f.campaignDir },
    { lockPath: f.loaded.config.live_spend_lock! },
  );
  return lease;
}
for (const childState of ['live', 'unknown'] as const) {
  test(`controller bound during launcher stop must settle its exact ${childState} identity before takeover`, async () => {
    const f = fixture();
    started(f);
    const launcher = currentProcessIdentity();
    const child = { ...launcher, pid: launcher.pid + 100_000, birth: '123' };
    claimStart(f).release();
    const writer = f.elect();
    let launcherDead = false;
    let childDead = false;
    let allowChildStop = false;
    const stopped: ProcessIdentity[] = [];
    let runtimes = 0;
    const deps = {
      runtime: () => {
        runtimes++;
        return noRuntime();
      },
      processes: {
        observe: (identity: ProcessIdentity) => {
          if (identity.pid === launcher.pid)
            return launcherDead ? ('dead' as const) : ('live' as const);
          expect(identity).toEqual(child);
          return childDead
            ? ('dead' as const)
            : allowChildStop
              ? ('live' as const)
              : childState;
        },
        stop: async (identity: ProcessIdentity) => {
          stopped.push(identity);
          if (identity.pid === launcher.pid) {
            writer.commitTransition(
              transition(
                'controller_bound',
                {
                  start_id: 'start',
                  controller: child,
                },
                2,
              ),
            );
            launcherDead = true;
            return true;
          }
          expect(identity).toEqual(child);
          childDead = allowChildStop;
          return childDead;
        },
      },
    };
    try {
      const refused = await cancelCampaign(f, deps);
      expect(refused.kind).toBe('unresolved');
      expect(refused.reason).toContain('controller death');
      expect(stopped).toEqual([launcher, child]);
      expect(() => writer.assertCurrentOwner()).not.toThrow();
      expect(runtimes).toBe(0);
      expect(readProjection(f.campaignDir).termination).toBeNull();
      expect(
        readdirSync(f.campaignDir).filter((name) =>
          name.startsWith('termination-processes-'),
        ),
      ).toEqual([]);
      expect(
        readHostClaim({ lockPath: f.loaded.config.live_spend_lock! }),
      ).not.toBeNull();
    } finally {
      writer.release();
    }
    allowChildStop = true;
    const settled = await cancelCampaign(f, deps);
    expect(settled.kind).toBe('terminated');
    expect(settled.status.state).toBe('cancelled');
    expect(childDead).toBe(true);
    expect(runtimes).toBe(1);
    const proof = readProjection(f.campaignDir).termination!
      .process_evidence[0]!;
    expect(
      JSON.parse(readFileSync(join(f.campaignDir, proof.path), 'utf8')),
    ).toMatchObject({ controller: child, controller_dead: true });
    expect(
      readHostClaim({ lockPath: f.loaded.config.live_spend_lock! }),
    ).toBeNull();
  });
}

test('unknown first controller probe is not persisted as established loss', async () => {
  const f = fixture();
  started(f, true);
  let probes = 0;
  let stopped = false;
  const processes = {
    observe: () =>
      stopped
        ? ('dead' as const)
        : ++probes === 1
          ? ('unknown' as const)
          : ('live' as const),
    stop: async () => {
      expect(processes.observe()).toBe('live');
      stopped = true;
      return true;
    },
  };
  const result = await cancelCampaign(f, { processes, runtime: noRuntime });
  expect(
    JSON.parse(readFileSync(join(f.campaignDir, 'cancel-intent.json'), 'utf8'))
      .controller_loss_established,
  ).toBe(false);
  expect(result.kind).toBe('terminated');
  expect(result.status.state).toBe('cancelled');
});

test('conclusively dead controller preserves established loss and interrupted outcome', async () => {
  const f = fixture();
  started(f, true);
  const result = await cancelCampaign(f, {
    processes: dead,
    runtime: noRuntime,
  });
  expect(
    JSON.parse(readFileSync(join(f.campaignDir, 'cancel-intent.json'), 'utf8'))
      .controller_loss_established,
  ).toBe(true);
  expect(result.kind).toBe('terminated');
  expect(result.status.state).toBe('interrupted');
});

test('unknown launcher without a bound controller does not establish loss', async () => {
  const f = fixture();
  started(f);
  const result = await cancelCampaign(f, {
    processes: { observe: () => 'unknown', stop: async () => false },
    runtime: noRuntime,
  });
  expect(result.kind).toBe('unresolved');
  expect(
    JSON.parse(readFileSync(join(f.campaignDir, 'cancel-intent.json'), 'utf8'))
      .controller_loss_established,
  ).toBe(false);
  expect(readProjection(f.campaignDir).termination).toBeNull();
});

test('known live controller stays running through launcher lease and empty handoff gap', () => {
  const f = fixture();
  started(f);
  const lease = claimStart(f);
  const launcher = currentProcessIdentity();
  const controller = { ...launcher, pid: launcher.pid + 100_000, birth: '123' };
  const writer = f.elect();
  writer.commitTransition(
    transition('controller_bound', { start_id: 'start', controller }, 2),
  );
  writer.release();
  const running = {
    state: 'running',
    next_action: 'status',
    progress: { prepared: 0, stopped: 0 },
  } as const;
  const processes = {
    observe: (identity: ProcessIdentity) => {
      expect(identity).toEqual(controller);
      return 'live' as const;
    },
  };
  const lockPath = f.loaded.config.live_spend_lock!;
  const ownerFile = readdirSync(lockPath).find((name) =>
    name.startsWith('owner-'),
  )!;
  try {
    expect(observeCampaignStatus(f, processes)).toEqual(running);
  } finally {
    lease.release();
  }
  expect(observeCampaignStatus(f, processes)).toEqual(running);
  expect(observeCampaignStatus(f, { observe: () => 'unknown' })).toEqual({
    state: 'unresolved',
    next_action: 'cancel',
  });
  expect(observeCampaignStatus(f, dead)).toEqual({
    state: 'interrupted',
    next_action: 'cancel',
  });
  // Valid protocol tokens model the child's acquisition and a foreign holder.
  mkdirSync(lockPath);
  writeFileSync(
    join(lockPath, ownerFile),
    `${controller.pid}\n${controller.birth}\n${Date.now()}\n`,
  );
  expect(observeCampaignStatus(f, processes)).toEqual(running);
  writeFileSync(
    join(lockPath, ownerFile),
    `${controller.pid + 1}\n123\n${Date.now()}\n`,
  );
  expect(observeCampaignStatus(f, processes)).toEqual({
    state: 'interrupted',
    next_action: 'cancel',
  });
});

test('read-only status preserves consumed start and terminal outcome precedence', async () => {
  const f = fixture();
  expect(observeCampaignStatus(f, dead)).toMatchObject({
    state: 'registered',
    next_action: 'run',
  });
  started(f);
  expect(observeCampaignStatus(f, dead)).toMatchObject({
    state: 'interrupted',
    next_action: 'cancel',
  });
  const w = f.elect();
  w.commitTransition(
    transition(
      'ended',
      { outcome: 'interrupted', reason: 'lost', cancel_intent: null },
      3,
    ),
  );
  w.release();
  publishCancelIntent(f.campaignDir, {
    campaign_id: f.experiment.campaign_id,
    input_digest: f.experiment.input_digest,
    start_id: 'start',
    requested_at: new Date().toISOString(),
    controller_loss_established: true,
    reason: 'cancel',
  });
  expect(observeCampaignStatus(f, dead)).toMatchObject({
    state: 'interrupted',
    next_action: 'cancel',
  });
});
test('consumed start before claim can terminate without inventing a claim or behavior', async () => {
  const f = fixture();
  started(f);
  const result = await cancelCampaign(f, {
    processes: dead,
    runtime: noRuntime,
  });
  expect(result.kind).toBe('terminated');
  const p = readProjection(f.campaignDir);
  expect(p.ended?.outcome).toBe('interrupted');
  expect(p.termination?.stopped).toEqual([]);
  expect(
    (await cancelCampaign(f, { processes: dead, runtime: noRuntime })).kind,
  ).toBe('terminated');
  expect(observeCampaignStatus(f, dead)).toMatchObject({
    state: 'interrupted',
    next_action: 'register',
  });
});
test('cancellation writes intent before stopping and never takes writer while controller is alive', async () => {
  const f = fixture();
  started(f, true);
  const w = f.elect();
  let observedIntent = false;
  const result = await cancelCampaign(f, {
    runtime: noRuntime,
    processes: {
      observe: () => 'live',
      stop: async () => {
        observedIntent =
          JSON.parse(
            readFileSync(join(f.campaignDir, 'cancel-intent.json'), 'utf8'),
          ).start_id === 'start';
        return false;
      },
    },
  });
  expect(result.kind).toBe('unresolved');
  expect(observedIntent).toBe(true);
  expect(() => w.assertCurrentOwner()).not.toThrow();
  w.release();
});
test('unbound orphan accounting never accepts behavior or reconstructs dispatch', async () => {
  const f = fixture();
  started(f, true);
  const w = f.elect();
  w.commitTransition(
    transition('block_activated', blockActivation(f.experiment), 3),
  );
  w.release();
  const result = await cancelCampaign(f, {
    processes: dead,
    runtime: noRuntime,
  });
  expect(result.kind).toBe('terminated');
  const p = readProjection(f.campaignDir);
  expect(
    [...p.attempts.values()].every(
      (a) => a.accounting !== null && a.observation === null,
    ),
  ).toBe(true);
});

test('uncertain start retains ownership while cancellation still visits every intent', async () => {
  const f = fixture();
  started(f, true);
  const w = f.elect();
  const activation = blockActivation(f.experiment);
  w.commitTransition(transition('block_activated', activation, 3));
  const first = activation.attempts[0]!;
  w.commitTransition(
    transition(
      'runtime_bound',
      {
        execution_attempt_id: first.identity.execution_attempt_id,
        container_id: '1'.repeat(64),
        runtime_spec_digest: first.runtime_spec_digest,
      },
      4,
    ),
  );
  w.release();
  const inspected: string[] = [];
  let delayedStart = false;
  const result = await cancelCampaign(f, {
    processes: dead,
    runtime: (settlement) => ({
      ...noRuntime(),
      inspectOwned: async ({ intent }) => {
        inspected.push(intent.identity.execution_attempt_id);
        return { kind: 'absent' };
      },
      stop: async (bound) => {
        expect(settlement(bound)).toBe('uncertain');
        delayedStart = true;
        return { kind: 'unresolved', reason: 'start response outstanding' };
      },
    }),
  });
  expect(result.kind).toBe('unresolved');
  expect(inspected).toHaveLength(2);
  expect(delayedStart).toBe(true);
  expect(
    readHostClaim({ lockPath: f.loaded.config.live_spend_lock! }),
  ).not.toBeNull();
  expect(readProjection(f.campaignDir).termination).toBeNull();
});
test('journal failure stops all intents before emergency evidence and never releases claim', async () => {
  const f = fixture();
  started(f, true);
  const w = f.elect();
  w.commitTransition(
    transition('block_activated', blockActivation(f.experiment), 3),
  );
  w.release();
  const db = new Database(join(f.campaignDir, 'journal.db'));
  db.exec(
    `CREATE TRIGGER disk_full BEFORE INSERT ON execution_transitions WHEN json_extract(NEW.body, '$.type')='accounting_observed' BEGIN SELECT RAISE(FAIL, 'SQLITE_FULL'); END`,
  );
  db.close();
  const inspected: string[] = [];
  const result = await cancelCampaign(f, {
    processes: dead,
    runtime: () => ({
      ...noRuntime(),
      inspectOwned: async ({ intent }) => {
        inspected.push(intent.identity.execution_attempt_id);
        return { kind: 'absent' };
      },
    }),
  });
  expect(result.kind).toBe('unresolved');
  expect(inspected).toHaveLength(2);
  const emergency = JSON.parse(
    readFileSync(join(f.campaignDir, 'storage-interruption.json'), 'utf8'),
  );
  expect(emergency.stopped).toHaveLength(2);
  expect(emergency.unresolved_attempt_ids).toEqual([]);
  expect(
    readHostClaim({ lockPath: f.loaded.config.live_spend_lock! }),
  ).not.toBeNull();
});

test('supported source and bundle mutations refuse unresolved ownership before effects', async () => {
  const f = fixture();
  started(f, true);
  let effects = 0;
  await expect(
    withMutationLocks(f.loaded, 'mutation', 'prepare', async () => {
      effects++;
    }),
  ).rejects.toThrow(/claim/);
  expect(effects).toBe(0);
});

for (const diskFull of [false, true])
  test(`stopped orphan publication records accounting with disk full ${diskFull}`, async () => {
    const f = fixture();
    started(f, true);
    const w = f.elect();
    const activation = blockActivation(f.experiment);
    mkdirSync(f.loaded.config.container.results_root, { recursive: true });
    for (const a of activation.attempts) {
      a.output_root = join(f.root, a.identity.execution_attempt_id);
      a.runtime_spec.public_env.QUORUM_ATTEMPT_DIR = a.output_root;
      a.runtime_spec_digest = sha256Hex(jcsCanonicalize(a.runtime_spec));
      const dir = join(
        a.output_root,
        'staging',
        a.identity.execution_attempt_id,
      );
      mkdirSync(dir, { recursive: true });
      const body = '{"cost":1}\n';
      writeFileSync(join(dir, 'usage.json'), body);
      writeFileSync(
        join(dir, 'manifest.json'),
        JSON.stringify({
          schema_version: 1,
          run_id: a.identity.execution_attempt_id,
          campaign: a.identity,
          files: [
            {
              path: 'usage.json',
              size: Buffer.byteLength(body),
              sha256: sha256Hex(body),
            },
          ],
        }),
      );
    }
    w.commitTransition(transition('block_activated', activation, 3));
    w.release();
    const result = await cancelCampaign(f, {
      processes: dead,
      ...(diskFull
        ? {
            publicationFs: {
              renameSync,
              openSync,
              closeSync,
              fsyncSync: () => {
                throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
              },
            },
          }
        : {}),
      runtime: () => ({
        ...noRuntime(),
        inspectOwned: async ({ intent }) => ({
          kind: 'matching-stopped',
          container_id: (intent.identity.sample_id === 'sample-base'
            ? '1'
            : '2'
          ).repeat(64),
          runtime_spec_digest: intent.runtime_spec_digest,
        }),
        stop: async (bound) => ({
          kind: 'dead',
          stopped: {
            execution_attempt_id: bound.intent.identity.execution_attempt_id,
            container_id: bound.container_id,
            proof: 'inspected_stopped',
            observed_at: new Date().toISOString(),
          },
        }),
      }),
    });
    if (diskFull) {
      expect(result.kind).toBe('unresolved');
      expect(
        readHostClaim({ lockPath: f.loaded.config.live_spend_lock! }),
      ).not.toBeNull();
      const e = JSON.parse(
        readFileSync(join(f.campaignDir, 'storage-interruption.json'), 'utf8'),
      );
      expect(e.stopped).toHaveLength(2);
      return;
    }
    expect(result.kind).toBe('terminated');
    for (const a of readProjection(f.campaignDir).attempts.values()) {
      expect(a.observation).toBeNull();
      expect(a.accounting?.artifacts).toHaveLength(2);
      for (const ref of a.accounting!.artifacts) {
        const body = readFileSync(
          join(f.loaded.config.container.results_root, ref.path),
        );
        expect(body.length).toBe(ref.bytes);
        expect(sha256Hex(body.toString())).toBe(ref.sha256);
      }
    }
  });

test('invalid launcher evidence and unknown controller identity are unresolved', () => {
  const f = fixture();
  started(f, true);
  expect(observeCampaignStatus(f, { observe: () => 'unknown' })).toMatchObject({
    state: 'unresolved',
    next_action: 'cancel',
  });
  writeFileSync(join(f.campaignDir, 'launcher-released.json'), '{broken');
  expect(observeCampaignStatus(f, dead)).toMatchObject({
    state: 'unresolved',
    next_action: 'cancel',
  });
});

test('live controller settlement during stop is reread without taking stale authority', async () => {
  const f = fixture();
  started(f, true);
  let alive = true;
  const processes = {
    observe: () => (alive ? ('live' as const) : ('dead' as const)),
    stop: async () => {
      const settled = await cancelCampaign(f, {
        processes: dead,
        runtime: noRuntime,
      });
      expect(settled.kind).toBe('terminated');
      alive = false;
      return true;
    },
  };
  const result = await cancelCampaign(f, { processes, runtime: noRuntime });
  expect(result.kind).toBe('terminated');
  expect(result.status).toMatchObject({
    state: 'cancelled',
    next_action: 'report',
  });
});

test('current ended controller can settle its role without killing its live launcher process', () => {
  const f = fixture();
  started(f, true);
  const before = readProjection(f.campaignDir);
  const claim = readHostClaim({ lockPath: f.loaded.config.live_spend_lock! })!;
  publishLauncherRelease(f, claim, before.controller!);
  const runLock = acquireLock({
    loaded: f.loaded,
    name: 'run.lock',
    jobId: f.jobId,
    command: 'campaign-run',
  });
  const liveSpend = acquireLiveSpendLock({
    lockPath: f.loaded.config.live_spend_lock!,
    clock: new RealClock(),
    identity: realProcessIdentityProbe,
    authority: {
      ...claim,
      kind: 'controller',
      process: currentProcessIdentity(),
    },
  });
  const writer = f.elect();
  const activation = blockActivation(f.experiment);
  writer.commitTransition(transition('block_activated', activation, 3));
  writer.commitTransition(
    transition(
      'attempt_observed',
      { observation: observation(activation, 0, 4), excluded_block: null },
      4,
    ),
  );
  writer.commitTransition(
    transition(
      'attempt_observed',
      { observation: observation(activation, 1, 5), excluded_block: null },
      5,
    ),
  );
  writer.commitTransition(
    transition(
      'block_validated',
      { block_id: activation.block_id, evidence_refs: [evidenceRef] },
      6,
    ),
  );
  writer.commitTransition(
    transition(
      'ended',
      {
        outcome: 'completed',
        reason: 'all blocks audited',
        cancel_intent: null,
      },
      7,
    ),
  );
  expect(observeCampaignStatus(f, dead)).toMatchObject({
    state: 'completed',
    next_action: 'cancel',
  });
  expect(() =>
    completeControllerTermination({
      ...f,
      runLock,
      liveSpend,
      writer,
      assertNoUnsettledStarts: () => {
        throw Error('uncertain start');
      },
    }),
  ).toThrow('uncertain start');
  expect(readProjection(f.campaignDir).termination).toBeNull();
  try {
    completeControllerTermination({
      ...f,
      runLock,
      liveSpend,
      writer,
      assertNoUnsettledStarts: () => {},
    });
    expect(readProjection(f.campaignDir).termination).not.toBeNull();
    expect(
      readHostClaim({ lockPath: f.loaded.config.live_spend_lock! }),
    ).toBeNull();
    expect(() => writer.assertCurrentOwner()).not.toThrow();
    expect(observeCampaignStatus(f, dead)).toMatchObject({
      state: 'completed',
      next_action: 'report',
    });
  } finally {
    writer.release();
    liveSpend.release();
    runLock.release();
  }
});

test('launcher cannot publish role release while its admission leases remain held', () => {
  const f = fixture();
  started(f, true);
  const p = readProjection(f.campaignDir);
  const claim = readHostClaim({ lockPath: f.loaded.config.live_spend_lock! })!;
  const writer = f.elect();
  try {
    expect(() => publishLauncherRelease(f, claim, p.controller!)).toThrow(
      /lease/,
    );
  } finally {
    writer.release();
  }
});

for (const type of ['ended', 'termination_verified'] as const) {
  test(`${type} publication failure leaves durable emergency evidence after stops`, async () => {
    const f = fixture();
    started(f, true);
    const db = new Database(join(f.campaignDir, 'journal.db'));
    db.exec(
      `CREATE TRIGGER disk_full BEFORE INSERT ON execution_transitions WHEN json_extract(NEW.body, '$.type')='${type}' BEGIN SELECT RAISE(FAIL, 'SQLITE_FULL'); END`,
    );
    db.close();
    expect(
      (await cancelCampaign(f, { processes: dead, runtime: noRuntime })).kind,
    ).toBe('unresolved');
    const emergency = JSON.parse(
      readFileSync(join(f.campaignDir, 'storage-interruption.json'), 'utf8'),
    );
    expect(emergency.start_id).toBe('start');
    expect(emergency.stopped).toEqual([]);
  });
}

test('a resolved historical campaign is not reopened by a different host campaign claim', async () => {
  const f = fixture();
  started(f);
  expect(
    (await cancelCampaign(f, { processes: dead, runtime: noRuntime })).kind,
  ).toBe('terminated');
  const prior = readProjection(f.campaignDir).start!;
  writeFileSync(
    `${f.loaded.config.live_spend_lock}.claim.json`,
    JSON.stringify({
      ...prior,
      campaign_id: 'another-campaign',
      campaign_dir: join(f.root, 'another-campaign'),
      start_id: 'another-start',
    }),
  );
  expect(observeCampaignStatus(f, dead)).toMatchObject({
    state: 'interrupted',
    next_action: 'register',
  });
  writeFileSync(
    `${f.loaded.config.live_spend_lock}.claim.json`,
    JSON.stringify({ ...prior, campaign_dir: join(f.root, 'wrong-directory') }),
  );
  expect(observeCampaignStatus(f, dead)).toMatchObject({
    state: 'unresolved',
    next_action: 'cancel',
  });
});

for (const claimed of [false, true]) {
  test(`unbound ${claimed ? 'claimed' : 'unclaimed'} start reports exact launcher authority without inferring loss`, () => {
    const f = fixture();
    started(f);
    const lease = claimed
      ? claimStart(f)
      : acquireLiveSpendLock({
          lockPath: f.loaded.config.live_spend_lock!,
          clock: new RealClock(),
          identity: realProcessIdentityProbe,
        });
    const live = {
      observe: (identity: ProcessIdentity) => {
        expect(identity).toEqual(currentProcessIdentity());
        return 'live' as const;
      },
    };
    try {
      expect(observeCampaignStatus(f, live)).toEqual({
        state: 'running',
        next_action: 'status',
        progress: { prepared: 0, stopped: 0 },
      });
      expect(observeCampaignStatus(f, { observe: () => 'unknown' })).toEqual({
        state: 'unresolved',
        next_action: 'cancel',
      });
      expect(observeCampaignStatus(f, dead)).toEqual({
        state: 'interrupted',
        next_action: 'cancel',
      });
    } finally {
      lease.release();
    }
    expect(observeCampaignStatus(f, live)).toEqual({
      state: 'unresolved',
      next_action: 'cancel',
    });
  });
}
