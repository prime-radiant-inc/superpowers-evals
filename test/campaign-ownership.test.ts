import { afterEach, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ExecutionJournalWriter,
  initExecutionJournal,
} from '../src/campaign/execution-journal.ts';
import {
  createBallast,
  DEFAULT_BALLAST_BYTES,
} from '../src/campaign/journal.ts';
import {
  acquireLiveSpendLock,
  defaultLiveSpendLockPath,
  realProcessIdentityProbe,
} from '../src/campaign/locks.ts';
import {
  clearHostClaim,
  currentProcessIdentity,
  publishCancelIntent,
  publishHostClaim,
  readHostClaim,
  type TerminationReceipt,
} from '../src/campaign/ownership.ts';
import { sha256Hex } from '../src/contracts/campaign/digest.ts';
import { experimentDigest } from '../src/contracts/campaign/experiment-digest.ts';
import { RealClock } from '../src/scheduler/clock.ts';
import {
  blockActivation,
  fixtureTime,
  transition,
  twoArmExperiment,
} from './fixtures/core-comparison/factory.ts';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'ownership-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'campaign');
  mkdirSync(dir);
  const lockPath = join(root, 'live-spend.lock.d');
  const experiment = twoArmExperiment();
  experiment.input_digest = experimentDigest(experiment);
  initExecutionJournal({ campaignDir: dir, experiment });
  writeFileSync(join(dir, 'campaign.json'), JSON.stringify(experiment));
  createBallast(dir, DEFAULT_BALLAST_BYTES);
  const acquire = (
    authority?: Parameters<typeof acquireLiveSpendLock>[0]['authority'],
  ) =>
    acquireLiveSpendLock({
      lockPath,
      clock: new RealClock(),
      identity: realProcessIdentityProbe,
      ...(authority ? { authority } : {}),
    });
  const lease = acquire();
  cleanup.push(() => lease.release());
  const writer = ExecutionJournalWriter.elect({
    campaignDir: dir,
    experiment,
    clock: new RealClock(),
    identity: realProcessIdentityProbe,
  });
  cleanup.push(() => writer.release());
  writer.commitTransition(
    transition('registered', {
      campaign_id: experiment.campaign_id,
      input_digest: experiment.input_digest,
    }),
  );
  const claim = {
    campaign_id: experiment.campaign_id,
    input_digest: experiment.input_digest,
    campaign_dir: dir,
    start_id: 'start',
    launcher: currentProcessIdentity(),
    claimed_at: fixtureTime(1),
  };
  const { campaign_dir: _dir, ...start } = claim;
  writer.commitTransition(transition('started', start, 1));
  return { root, dir, lockPath, experiment, lease, writer, claim, acquire };
}

test('durable claim excludes a new spender across the parent release gap', () => {
  const fx = fixture();
  publishHostClaim(fx.claim, { lockPath: fx.lockPath });
  fx.lease.release();
  expect(readHostClaim({ lockPath: fx.lockPath })).toEqual(fx.claim);
  expect(() => fx.acquire()).toThrow(/claim/);
  expect(() =>
    fx.acquire({
      kind: 'controller',
      ...fx.claim,
      process: currentProcessIdentity(),
    }),
  ).toThrow();
  fx.writer.commitTransition(
    transition(
      'controller_bound',
      { start_id: 'start', controller: currentProcessIdentity() },
      2,
    ),
  );
  const matching = fx.acquire({
    kind: 'controller',
    ...fx.claim,
    process: currentProcessIdentity(),
  });
  matching.release();
  expect(() =>
    fx.acquire({
      kind: 'controller',
      ...fx.claim,
      process: { ...currentProcessIdentity(), pid: 999999 },
    }),
  ).toThrow();
});

test('claim publication requires committed matching start and a physically allocated reserve', () => {
  const fx = fixture();
  expect(() =>
    publishHostClaim(
      { ...fx.claim, start_id: 'other' },
      { lockPath: fx.lockPath },
    ),
  ).toThrow();
  rmSync(join(fx.dir, '.ballast'));
  writeFileSync(join(fx.dir, '.ballast'), 'short');
  expect(() => publishHostClaim(fx.claim, { lockPath: fx.lockPath })).toThrow(
    /reserve/,
  );
  expect(readHostClaim({ lockPath: fx.lockPath })).toBeNull();
});

test('termination clearing authenticates journal anchor and process evidence bytes', () => {
  const fx = fixture();
  publishHostClaim(fx.claim, { lockPath: fx.lockPath });
  fx.writer.commitTransition(
    transition(
      'controller_bound',
      { start_id: 'start', controller: currentProcessIdentity() },
      2,
    ),
  );
  fx.writer.commitTransition(
    transition(
      'ended',
      { outcome: 'interrupted', reason: 'storage_full', cancel_intent: null },
      3,
    ),
  );
  const body = '{"controller":"stopped"}\n';
  writeFileSync(join(fx.dir, 'process.json'), body);
  const committed = fx.writer.commitTransition(
    transition(
      'termination_verified',
      {
        start_id: 'start',
        stopped: [],
        process_evidence: [
          {
            path: 'process.json',
            sha256: sha256Hex(body),
            bytes: Buffer.byteLength(body),
          },
        ],
      },
      4,
    ),
  );
  const receipt: TerminationReceipt = {
    campaign_id: fx.claim.campaign_id,
    input_digest: fx.claim.input_digest,
    start_id: 'start',
    transition_id: committed.transition.transition_id,
    transition_digest: committed.transition_digest,
    stopped: [],
  };
  expect(() =>
    clearHostClaim(
      { ...receipt, transition_digest: 'f'.repeat(64) },
      { lockPath: fx.lockPath },
    ),
  ).toThrow();
  writeFileSync(join(fx.dir, 'process.json'), 'forged');
  expect(() => clearHostClaim(receipt, { lockPath: fx.lockPath })).toThrow();
  expect(readHostClaim({ lockPath: fx.lockPath })).not.toBeNull();
  writeFileSync(join(fx.dir, 'process.json'), body);
  clearHostClaim(receipt, { lockPath: fx.lockPath });
  expect(readHostClaim({ lockPath: fx.lockPath })).toBeNull();
});

test('malformed and symlinked host claims never fall back to unclaimed', () => {
  const fx = fixture();
  const path = `${fx.lockPath}.claim.json`;
  writeFileSync(path, '{');
  fx.lease.release();
  expect(() => fx.acquire()).toThrow();
  rmSync(path);
  writeFileSync(join(fx.root, 'other.json'), JSON.stringify(fx.claim));
  symlinkSync(join(fx.root, 'other.json'), path);
  expect(() => fx.acquire()).toThrow();
});

test('cancellation authority must match the durable intent, never an environment assertion', () => {
  const fx = fixture();
  publishHostClaim(fx.claim, { lockPath: fx.lockPath });
  fx.lease.release();
  const intent = {
    campaign_id: fx.claim.campaign_id,
    input_digest: fx.claim.input_digest,
    start_id: 'start',
    requested_at: fixtureTime(2),
    controller_loss_established: true,
    reason: 'operator',
  };
  expect(() => fx.acquire({ kind: 'cancellation', intent })).toThrow();
  publishCancelIntent(fx.dir, intent);
  const cancel = fx.acquire({ kind: 'cancellation', intent });
  cancel.release();
  expect(() =>
    fx.acquire({
      kind: 'cancellation',
      intent: { ...intent, reason: 'forged' },
    }),
  ).toThrow();
});

function applianceConfig(root: string, lockPath: string) {
  return {
    root,
    evals: { path: join(root, 'evals'), remote: 'origin', ref: 'main' },
    superpowers: { path: join(root, 'superpowers'), remote: 'origin' },
    gauntlet: { path: join(root, 'gauntlet'), remote: 'origin', ref: 'main' },
    credential_bundle: { name: 'blessed', path: join(root, 'DO-NOT-READ') },
    container: { name: 'quorum', results_root: join(root, 'results') },
    live_spend_lock: lockPath,
  };
}
test('canonical appliance config controls env-unset raw lock resolution without reading credentials', () => {
  const fx = fixture();
  const canonicalConfigPath = join(fx.root, 'canonical.json');
  writeFileSync(
    canonicalConfigPath,
    JSON.stringify(applianceConfig(fx.root, fx.lockPath)),
  );
  expect(
    defaultLiveSpendLockPath({
      canonicalConfigPath,
      env: { HOME: join(fx.root, 'throwaway') },
    }),
  ).toBe(fx.lockPath);
  expect(() =>
    defaultLiveSpendLockPath({
      canonicalConfigPath,
      env: {
        HOME: fx.root,
        QUORUM_LIVE_SPEND_LOCK: join(fx.root, 'other.lock'),
      },
    }),
  ).toThrow();
  const explicit = join(fx.root, 'explicit.json');
  writeFileSync(
    explicit,
    JSON.stringify(applianceConfig(fx.root, join(fx.root, 'other.lock'))),
  );
  expect(() =>
    defaultLiveSpendLockPath({
      canonicalConfigPath,
      env: { EVALS_APPLIANCE_CONFIG: explicit },
    }),
  ).toThrow();
  writeFileSync(canonicalConfigPath, '{');
  expect(() =>
    defaultLiveSpendLockPath({ canonicalConfigPath, env: { HOME: fx.root } }),
  ).toThrow();
});
test('a symlinked canonical configuration refuses, while absent workstation config permits HOME', () => {
  const fx = fixture();
  const canonicalConfigPath = join(fx.root, 'canonical.json');
  expect(
    defaultLiveSpendLockPath({ canonicalConfigPath, env: { HOME: fx.root } }),
  ).toBe(join(fx.root, '.quorum', 'live-spend.lock.d'));
  const explicit = join(fx.root, 'other.json');
  writeFileSync(
    explicit,
    JSON.stringify(applianceConfig(fx.root, fx.lockPath)),
  );
  symlinkSync(explicit, canonicalConfigPath);
  expect(() =>
    defaultLiveSpendLockPath({ canonicalConfigPath, env: { HOME: fx.root } }),
  ).toThrow();
});

test('an unknown worker remains owned after durable emergency interruption evidence', async () => {
  const { persistStorageInterruption } = await import(
    '../src/campaign/ownership.ts'
  );
  const fx = fixture();
  publishHostClaim(fx.claim, { lockPath: fx.lockPath });
  fx.writer.commitTransition(
    transition(
      'controller_bound',
      { start_id: 'start', controller: currentProcessIdentity() },
      2,
    ),
  );
  const activation = blockActivation(fx.experiment);
  fx.writer.commitTransition(transition('block_activated', activation, 3));
  const result = persistStorageInterruption(fx.dir, {
    campaign_id: fx.claim.campaign_id,
    input_digest: fx.claim.input_digest,
    start_id: 'start',
    at: fixtureTime(4),
    stopped: [],
    unresolved_attempt_ids: activation.attempts.map(
      (attempt) => attempt.identity.execution_attempt_id,
    ),
  });
  expect(result.kind).toBe('durable');
  expect(readHostClaim({ lockPath: fx.lockPath })).toEqual(fx.claim);
  fx.lease.release();
  expect(() => fx.acquire()).toThrow(/claim/);
});

test('ENOSPC while writing emergency evidence leaves an unresolved ownership guard', async () => {
  const { persistStorageInterruption } = await import(
    '../src/campaign/ownership.ts'
  );
  const { journalFsOps } = await import('../src/campaign/journal.ts');
  const fx = fixture();
  publishHostClaim(fx.claim, { lockPath: fx.lockPath });
  const result = persistStorageInterruption(
    fx.dir,
    {
      campaign_id: fx.claim.campaign_id,
      input_digest: fx.claim.input_digest,
      start_id: 'start',
      at: fixtureTime(2),
      stopped: [],
      unresolved_attempt_ids: [],
    },
    {
      ...journalFsOps,
      write: () => {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      },
    },
  );
  expect(result.kind).toBe('unresolved');
  expect(readHostClaim({ lockPath: fx.lockPath })).toEqual(fx.claim);
});

test('a caller-supplied lock path cannot split the canonical appliance authority', () => {
  const fx = fixture();
  const canonicalConfigPath = join(fx.root, 'canonical.json');
  writeFileSync(
    canonicalConfigPath,
    JSON.stringify(applianceConfig(fx.root, fx.lockPath)),
  );
  expect(() =>
    acquireLiveSpendLock({
      lockPath: join(fx.root, 'second.lock'),
      location: { canonicalConfigPath },
      clock: new RealClock(),
      identity: realProcessIdentityProbe,
    }),
  ).toThrow(/disagree/);
});

test('dead controller lease reclamation preserves the claim while worker state is unknown', () => {
  const fx = fixture();
  publishHostClaim(fx.claim, { lockPath: fx.lockPath });
  fx.writer.commitTransition(
    transition(
      'controller_bound',
      {
        start_id: 'start',
        controller: { pid: 999999, birth: 'gone', boot_id: 'previous-boot' },
      },
      2,
    ),
  );
  fx.writer.commitTransition(
    transition('block_activated', blockActivation(fx.experiment), 3),
  );
  fx.lease.release();
  mkdirSync(fx.lockPath);
  writeFileSync(
    join(fx.lockPath, 'owner-00000000-0000-0000-0000-000000000000'),
    '999999\n0\n0\n',
  );
  expect(() => fx.acquire()).toThrow(/claim/);
  expect(readHostClaim({ lockPath: fx.lockPath })).toEqual(fx.claim);
  expect(fx.writer.readProjection().attempts.size).toBe(2);
});

for (const changed of [
  'campaign',
  'input',
  'launcher',
  'claimed_at',
] as const) {
  test(`claim clearing refuses a replacement journal with a different ${changed} and the same start ID`, () => {
    const fx = fixture();
    publishHostClaim(fx.claim, { lockPath: fx.lockPath });
    fx.writer.release();
    renameSync(fx.dir, join(fx.root, 'original-campaign'));
    mkdirSync(fx.dir);
    const experiment = structuredClone(fx.experiment);
    if (changed === 'campaign') experiment.campaign_id = 'campaign-two';
    if (changed === 'input') experiment.refs.evals = '1'.repeat(40);
    experiment.input_digest = experimentDigest(experiment);
    initExecutionJournal({ campaignDir: fx.dir, experiment });
    writeFileSync(join(fx.dir, 'campaign.json'), JSON.stringify(experiment));
    const replacement = ExecutionJournalWriter.elect({
      campaignDir: fx.dir,
      experiment,
      clock: new RealClock(),
      identity: realProcessIdentityProbe,
    });
    cleanup.push(() => replacement.release());
    const { campaign_dir: _dir, ...originalStart } = fx.claim;
    const start = {
      ...originalStart,
      campaign_id: experiment.campaign_id,
      input_digest: experiment.input_digest,
      ...(changed === 'launcher'
        ? { launcher: { ...originalStart.launcher, birth: 'different-birth' } }
        : {}),
      ...(changed === 'claimed_at' ? { claimed_at: fixtureTime(0) } : {}),
    };
    replacement.commitTransition(
      transition('registered', {
        campaign_id: experiment.campaign_id,
        input_digest: experiment.input_digest,
      }),
    );
    replacement.commitTransition(transition('started', start, 1));
    replacement.commitTransition(
      transition(
        'controller_bound',
        { start_id: 'start', controller: currentProcessIdentity() },
        2,
      ),
    );
    replacement.commitTransition(
      transition(
        'ended',
        { outcome: 'interrupted', reason: 'stopped', cancel_intent: null },
        3,
      ),
    );
    const body = '{"controller":"stopped"}\n';
    writeFileSync(join(fx.dir, 'process.json'), body);
    const committed = replacement.commitTransition(
      transition(
        'termination_verified',
        {
          start_id: 'start',
          stopped: [],
          process_evidence: [
            {
              path: 'process.json',
              sha256: sha256Hex(body),
              bytes: Buffer.byteLength(body),
            },
          ],
        },
        4,
      ),
    );
    const receipt: TerminationReceipt = {
      campaign_id: fx.claim.campaign_id,
      input_digest: fx.claim.input_digest,
      start_id: fx.claim.start_id,
      transition_id: committed.transition.transition_id,
      transition_digest: committed.transition_digest,
      stopped: [],
    };
    expect(() => clearHostClaim(receipt, { lockPath: fx.lockPath })).toThrow();
    expect(readHostClaim({ lockPath: fx.lockPath })).toEqual(fx.claim);
  });
}
