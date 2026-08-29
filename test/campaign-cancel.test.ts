import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GroupSignaler } from '../src/campaign/dispatcher.ts';
import { electWriter, initJournalDb } from '../src/campaign/journal.ts';
import type { ProcessIdentityProbe } from '../src/campaign/locks.ts';
import {
  type CampaignChildProbe,
  cancelCampaign,
  RecoveryError,
  resumeCampaign,
} from '../src/campaign/recovery.ts';
import type { Campaign } from '../src/contracts/campaign/campaign.ts';
import { FakeClock } from '../src/scheduler/clock.ts';

/** No campaign child is alive, and no dispatcher holds the live-spend lock.
 *  This process (the cancel/resume command itself) keeps a readable identity
 *  so it can take the journal lease — the same probe serves both roles. */
const IDENTITY: ProcessIdentityProbe = {
  exists: (pid) => (pid === process.pid ? 'alive' : 'esrch'),
  startTimeMs: (pid) => (pid === process.pid ? 1 : null),
};

const WRITER_IDENTITY: ProcessIdentityProbe = {
  exists: () => 'alive',
  startTimeMs: () => 1,
};

const CAMPAIGN_ID = 'd'.repeat(64);
const LIVE_PGID = 999999999;

function lockDir(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'lock-')), name);
}

function publishedCampaign(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cancel-'));
  // Minimal published layout: campaign.json (with the block/sample universe
  // the in-flight derivation and planRecovery read) + journal.
  const doc = {
    digest: 'd'.repeat(64),
    campaign_id: CAMPAIGN_ID,
    blocks: [{ block_id: 'b1', comparison_id: 'c1', sample_ids: ['s1'] }],
    samples: [{ sample_id: 's1', cell: 'c1:scn', arm: 'a', replicate: 1 }],
    contention: {
      host_fingerprint: {
        cpu_model: 't',
        cpu_cores: 1,
        mem_bytes: 1,
        disk_total_bytes: 1,
      },
      global_run_cap: 1,
      thresholds: [{ metric: 'load1', source: 'host', op: 'gt', value: 1 }],
      cadence_ms: 1000,
      sustain_k: 1,
      coverage_n: 1,
      mem_tolerance_pct: 1,
      disk_tolerance_pct: 1,
    },
  };
  writeFileSync(join(dir, 'campaign.json'), JSON.stringify(doc));
  initJournalDb(dir);
  // The writer holds the frozen membership: attempt_created resolves its
  // block from it (a campaign-less writer refuses to fabricate one).
  const w = electWriter({
    campaignDir: dir,
    clock: new FakeClock(0),
    identity: WRITER_IDENTITY,
    campaign: doc as unknown as Campaign,
  });
  w.appendEvent({
    type: 'campaign_opened',
    payload: { campaign_id: doc.campaign_id, digest: doc.digest },
  });
  w.appendEvent({
    type: 'block_admitted',
    payload: { block_id: 'b1', pools: ['p'] },
  });
  w.appendEvent({
    type: 'attempt_created',
    payload: { sample_id: 's1', attempt_id: 'a1' },
  });
  w.appendEvent({
    type: 'run_allocated',
    payload: {
      attempt_id: 'a1',
      run_id: 'r1',
      pgid: LIVE_PGID,
      key_grants: [],
    },
  });
  w.release();
  return dir;
}

function journaledTypes(dir: string, atSeconds: number): string[] {
  const r = electWriter({
    campaignDir: dir,
    clock: new FakeClock(atSeconds),
    identity: WRITER_IDENTITY,
  });
  try {
    return r.readEvents().map((e) => e.type);
  } finally {
    r.release();
  }
}

/** A group that answers every probe and never dies: killGroupVerified
 *  escalates TERM->KILL and reports 'alive'. */
const IMMORTAL_GROUP: GroupSignaler = () => 'ok';

const ALIVE_AT_5: ProcessIdentityProbe = {
  exists: () => 'alive',
  startTimeMs: () => 5,
};

/** The campaign child's real argv shape (spawn.ts buildCampaignChildArgv). */
const CAMPAIGN_CHILD: CampaignChildProbe = {
  commandLine: () =>
    `bun /snap/src/cli/index.ts run /scn --campaign-identity {"campaign_id":"${CAMPAIGN_ID}","comparison_id":"c1","block_id":"b1","sample_id":"s1","execution_attempt_id":"a1"}`,
};

test('post-crash cancel: marker first, kill, aborted, campaign_cancelled LAST', async () => {
  const dir = publishedCampaign();
  const result = await cancelCampaign({
    campaignDir: dir,
    reason: 'operator test',
    clock: new FakeClock(1),
    identity: IDENTITY, // no live holder
    lockPath: lockDir('live.lock.d'),
    stream: { write: () => {} },
  });
  expect(result.cancelled).toBe(true);
  expect(result.postCrash).toBe(true);
  expect(existsSync(join(dir, 'cancel-request'))).toBe(true);
  const w = electWriter({
    campaignDir: dir,
    clock: new FakeClock(2),
    identity: WRITER_IDENTITY,
  });
  const events = w.readEvents();
  w.release();
  const types = events.map((e) => e.type);
  expect(types[types.length - 1]).toBe('campaign_cancelled'); // LAST
  expect(types).toContain('aborted');
  const cancelled = events[events.length - 1];
  expect(cancelled?.payload).toEqual({ reason: 'operator test' });
  // aborted precedes campaign_cancelled (pinned crash-consistency order).
  expect(types.indexOf('aborted')).toBeLessThan(
    types.indexOf('campaign_cancelled'),
  );
});

test('post-crash cancel is idempotent against a partial live sequence: an already-aborted block is never re-aborted', async () => {
  const dir = publishedCampaign();
  // The live dispatcher journaled aborted for b1 before dying mid-sequence.
  const w = electWriter({
    campaignDir: dir,
    clock: new FakeClock(1),
    identity: WRITER_IDENTITY,
  });
  w.appendEvent({ type: 'aborted', payload: { block_id: 'b1' } });
  w.release();
  await cancelCampaign({
    campaignDir: dir,
    reason: 'finish the interrupted cancel',
    clock: new FakeClock(2),
    identity: IDENTITY,
    lockPath: lockDir('l3.d'),
    stream: { write: () => {} },
  });
  const types = journaledTypes(dir, 3);
  expect(types.filter((t) => t === 'aborted').length).toBe(1); // never duplicated
  expect(types[types.length - 1]).toBe('campaign_cancelled'); // still LAST
});

test('post-crash cancel re-run after campaign_cancelled landed journals nothing more', async () => {
  const dir = publishedCampaign();
  const args = {
    campaignDir: dir,
    reason: 'operator test',
    clock: new FakeClock(1),
    identity: IDENTITY,
    lockPath: lockDir('l4.d'),
    stream: { write: () => {} },
  };
  await cancelCampaign(args);
  const first = journaledTypes(dir, 2);
  const again = await cancelCampaign({ ...args, clock: new FakeClock(3) });
  expect(again).toEqual({ cancelled: true, postCrash: true });
  expect(journaledTypes(dir, 4)).toEqual(first);
});

test('post-crash cancel reads the reason from a PRE-EXISTING marker (C11), not just its own argument', async () => {
  const dir = publishedCampaign();
  // An earlier `quorum campaign cancel` landed the marker and died before
  // journaling; resume/cancel completes it under the ORIGINAL reason.
  writeFileSync(join(dir, 'cancel-request'), '1000\nthe original reason\n');
  await cancelCampaign({
    campaignDir: dir,
    clock: new FakeClock(2),
    identity: IDENTITY,
    lockPath: lockDir('l5.d'),
    stream: { write: () => {} },
  });
  const w = electWriter({
    campaignDir: dir,
    clock: new FakeClock(3),
    identity: WRITER_IDENTITY,
  });
  const events = w.readEvents();
  w.release();
  const last = events[events.length - 1];
  expect(last?.type).toBe('campaign_cancelled');
  expect(last?.payload).toEqual({ reason: 'the original reason' });
});

test('post-crash cancel REFUSES to journal aborted/campaign_cancelled when a group survives TERM+KILL', async () => {
  const dir = publishedCampaign();
  const loud: string[] = [];
  const result = await cancelCampaign({
    campaignDir: dir,
    reason: 'operator test',
    clock: new FakeClock(1),
    identity: ALIVE_AT_5,
    child: CAMPAIGN_CHILD,
    signal: IMMORTAL_GROUP,
    graceSeconds: 0,
    lockPath: lockDir('l6.d'),
    stream: { write: (s) => loud.push(s) },
  });
  expect(result.cancelled).toBe(false);
  const types = journaledTypes(dir, 2);
  expect(types).not.toContain('aborted');
  expect(types).not.toContain('campaign_cancelled');
  expect(loud.join('')).toMatch(/survived TERM\+KILL/);
  // The marker stays, so re-running the cancel completes the sequence.
  expect(existsSync(join(dir, 'cancel-request'))).toBe(true);
});

test('resume REFUSES when a journaled process group survives TERM+KILL (live spend)', async () => {
  const dir = publishedCampaign();
  await expect(
    resumeCampaign({
      campaignDir: dir,
      credentials: {},
      evalsCheckout: dir,
      gauntletCheckout: dir,
      superpowersCheckout: dir,
      clock: new FakeClock(1),
      identity: ALIVE_AT_5,
      child: CAMPAIGN_CHILD,
      signal: IMMORTAL_GROUP,
      graceSeconds: 0,
      lockPath: lockDir('l7.d'),
      stream: { write: () => {} },
    }),
  ).rejects.toThrow(RecoveryError);
  // Nothing was journaled: no rerun re-entry against a still-spending child.
  expect(journaledTypes(dir, 2)).not.toContain('block_replaced');
});

test('resume refuses a cancelled campaign (cancel-request precedence)', async () => {
  const dir = publishedCampaign();
  await cancelCampaign({
    campaignDir: dir,
    clock: new FakeClock(1),
    identity: IDENTITY,
    lockPath: lockDir('l.d'),
    stream: { write: () => {} },
  });
  const outcome = await resumeCampaign({
    campaignDir: dir,
    credentials: {},
    evalsCheckout: dir,
    gauntletCheckout: dir,
    superpowersCheckout: dir,
    clock: new FakeClock(2),
    identity: IDENTITY,
    lockPath: lockDir('l2.d'),
    stream: { write: () => {} },
  });
  expect(outcome.status).toBe('cancelled');
});
