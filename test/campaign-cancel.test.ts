import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GroupSignaler } from '../src/campaign/dispatcher.ts';
import { electWriter, openJournalRead } from '../src/campaign/journal.ts';
import {
  readLiveSpendHolder,
  realProcessIdentityProbe,
} from '../src/campaign/locks.ts';
import {
  type CampaignChildProbe,
  cancelCampaign,
  RecoveryError,
  resumeCampaign,
} from '../src/campaign/recovery.ts';
import { FakeClock, RealClock } from '../src/scheduler/clock.ts';
import {
  ALIVE_AT_5,
  BLOCK_A,
  childCommandLine,
  journaledTypes,
  lockDir,
  NO_LIVE_CHILD,
  publishedCampaign,
  WRITER_IDENTITY,
} from './campaign-recovery-fixtures.ts';

/** A group that answers every probe and never dies: killGroupVerified
 *  escalates TERM->KILL and reports 'alive'. */
const IMMORTAL_GROUP: GroupSignaler = () => 'ok';

/** A group that dies on the first real signal and answers ESRCH thereafter —
 *  the nominal kill these verbs are supposed to perform. */
function mortalGroup(): { signal: GroupSignaler; sent: NodeJS.Signals[] } {
  const dead = new Set<number>();
  const sent: NodeJS.Signals[] = [];
  return {
    sent,
    signal: (pgid, sig) => {
      if (dead.has(pgid)) return 'esrch';
      if (sig === 0) return 'ok';
      sent.push(sig);
      dead.add(pgid);
      return 'ok';
    },
  };
}

const CAMPAIGN_CHILD: CampaignChildProbe = {
  commandLine: () => childCommandLine('a1'),
};

function lastEvent(dir: string): { type: string; payload: unknown } | null {
  const r = openJournalRead(dir);
  try {
    const events = r.readEvents();
    return events[events.length - 1] ?? null;
  } finally {
    r.close();
  }
}

// ---------------------------------------------------------------------------
// Decision D-12: the pinned post-crash sequence
// ---------------------------------------------------------------------------

test('post-crash cancel: marker first, a REAL kill, aborted, campaign_cancelled LAST', async () => {
  const { dir } = publishedCampaign();
  const group = mortalGroup();
  const result = await cancelCampaign({
    campaignDir: dir,
    reason: 'operator test',
    clock: new FakeClock(1),
    identity: ALIVE_AT_5, // the orphan is alive and must be killed
    child: CAMPAIGN_CHILD,
    signal: group.signal,
    graceSeconds: 0,
    lockPath: lockDir('live.lock.d'),
    stream: { write: () => {} },
  });
  expect(result.cancelled).toBe(true);
  expect(result.postCrash).toBe(true);
  // The orphan was really killed — SIGTERM first (I-10c), not a bare probe.
  expect(group.sent[0]).toBe('SIGTERM');
  expect(existsSync(join(dir, 'cancel-request'))).toBe(true);
  const r = openJournalRead(dir);
  const events = r.readEvents();
  r.close();
  const types = events.map((e) => e.type);
  expect(types[types.length - 1]).toBe('campaign_cancelled'); // LAST
  expect(types).toContain('aborted');
  expect(events[events.length - 1]?.payload).toEqual({
    reason: 'operator test',
  });
  // aborted precedes campaign_cancelled (pinned crash-consistency order).
  expect(types.indexOf('aborted')).toBeLessThan(
    types.indexOf('campaign_cancelled'),
  );
});

test('post-crash cancel is idempotent against a partial live sequence: an already-aborted block is never re-aborted', async () => {
  const { dir } = publishedCampaign();
  // The live dispatcher journaled aborted for the block before dying
  // mid-sequence.
  const w = electWriter({
    campaignDir: dir,
    clock: new FakeClock(1),
    identity: WRITER_IDENTITY,
  });
  w.appendEvent({ type: 'aborted', payload: { block_id: BLOCK_A } });
  w.release();
  await cancelCampaign({
    campaignDir: dir,
    reason: 'finish the interrupted cancel',
    clock: new FakeClock(2),
    identity: NO_LIVE_CHILD,
    lockPath: lockDir('l3.d'),
    stream: { write: () => {} },
  });
  const types = journaledTypes(dir, 3);
  expect(types.filter((t) => t === 'aborted').length).toBe(1); // never duplicated
  expect(types[types.length - 1]).toBe('campaign_cancelled'); // still LAST
});

test('post-crash cancel re-run after campaign_cancelled landed journals nothing more', async () => {
  const { dir } = publishedCampaign();
  const args = {
    campaignDir: dir,
    reason: 'operator test',
    clock: new FakeClock(1),
    identity: NO_LIVE_CHILD,
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
  const { dir } = publishedCampaign();
  // An earlier `quorum campaign cancel` landed the marker and died before
  // journaling; the completion uses the ORIGINAL reason.
  writeFileSync(join(dir, 'cancel-request'), '1000\nthe original reason\n');
  await cancelCampaign({
    campaignDir: dir,
    clock: new FakeClock(2),
    identity: NO_LIVE_CHILD,
    lockPath: lockDir('l5.d'),
    stream: { write: () => {} },
  });
  const last = lastEvent(dir);
  expect(last?.type).toBe('campaign_cancelled');
  expect(last?.payload).toEqual({ reason: 'the original reason' });
});

test('an UNREADABLE cancel-request refuses rather than losing the original attribution (C11 fail-closed)', async () => {
  const { dir } = publishedCampaign();
  const marker = join(dir, 'cancel-request');
  // A marker that exists but cannot be read: its operator attribution is
  // unknown, and a later --reason must not silently replace it.
  writeFileSync(marker, '1000\noriginal\n');
  chmodSync(marker, 0o000);
  try {
    await expect(
      cancelCampaign({
        campaignDir: dir,
        reason: 'a different operator',
        clock: new FakeClock(2),
        identity: NO_LIVE_CHILD,
        lockPath: lockDir('l8.d'),
        stream: { write: () => {} },
      }),
    ).rejects.toThrow(RecoveryError);
  } finally {
    chmodSync(marker, 0o600);
  }
  expect(journaledTypes(dir, 3)).not.toContain('campaign_cancelled');
});

// ---------------------------------------------------------------------------
// R-RCV-1: verified death is a hard precondition on BOTH verbs
// ---------------------------------------------------------------------------

test('post-crash cancel REFUSES to journal aborted/campaign_cancelled when a group survives TERM+KILL', async () => {
  const { dir } = publishedCampaign();
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

test('post-crash cancel REFUSES on an UNSAFE reclamation — a leaderless group with live descendants is not verified dead', async () => {
  const { dir } = publishedCampaign();
  const loud: string[] = [];
  const result = await cancelCampaign({
    campaignDir: dir,
    reason: 'operator test',
    clock: new FakeClock(1),
    // The recorded leader is gone, but the group still answers: live
    // descendants keep spending and nothing was ever signaled.
    identity: NO_LIVE_CHILD,
    child: { commandLine: () => null },
    signal: IMMORTAL_GROUP,
    graceSeconds: 0,
    lockPath: lockDir('l9.d'),
    stream: { write: (s) => loud.push(s) },
  });
  expect(result.cancelled).toBe(false);
  const types = journaledTypes(dir, 2);
  expect(types).not.toContain('aborted');
  expect(types).not.toContain('campaign_cancelled');
  expect(loud.join('')).toMatch(/reclaim/i);
  expect(existsSync(join(dir, 'cancel-request'))).toBe(true);
});

test('post-crash cancel PROCEEDS past a BENIGN reclamation — a reused leader pid whose group is provably gone', async () => {
  const { dir } = publishedCampaign();
  const result = await cancelCampaign({
    campaignDir: dir,
    reason: 'operator test',
    clock: new FakeClock(1),
    identity: ALIVE_AT_5, // the pid lives...
    child: { commandLine: () => 'ps aux' }, // ...but it is not our child
    signal: () => 'esrch', // ...and the process GROUP is provably gone
    graceSeconds: 0,
    lockPath: lockDir('l10.d'),
    stream: { write: () => {} },
  });
  expect(result.cancelled).toBe(true);
  const types = journaledTypes(dir, 2);
  expect(types).toContain('aborted');
  expect(types[types.length - 1]).toBe('campaign_cancelled');
});

test('resume REFUSES when a journaled process group survives TERM+KILL (live spend)', async () => {
  const { dir } = publishedCampaign();
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

test('resume REFUSES on an UNSAFE reclamation — identity unknown is not verified death', async () => {
  const { dir } = publishedCampaign();
  await expect(
    resumeCampaign({
      campaignDir: dir,
      credentials: {},
      evalsCheckout: dir,
      gauntletCheckout: dir,
      superpowersCheckout: dir,
      clock: new FakeClock(1),
      // kill(pid,0) is inconclusive: identity UNKNOWN, never signaled.
      identity: { exists: () => 'unknown', startTimeMs: () => 5 },
      child: CAMPAIGN_CHILD,
      signal: IMMORTAL_GROUP,
      graceSeconds: 0,
      lockPath: lockDir('l11.d'),
      stream: { write: () => {} },
    }),
  ).rejects.toThrow(/reclaim/i);
  expect(journaledTypes(dir, 2)).not.toContain('block_replaced');
});

// ---------------------------------------------------------------------------
// Fail-closed intake + cancel-request precedence
// ---------------------------------------------------------------------------

test('both verbs REFUSE a schema-corrupt campaign.json (fail-closed intake)', async () => {
  const { dir } = publishedCampaign();
  writeFileSync(
    join(dir, 'campaign.json'),
    JSON.stringify({ campaign_id: 'x', blocks: 'not-an-array' }),
  );
  await expect(
    cancelCampaign({
      campaignDir: dir,
      clock: new FakeClock(1),
      identity: NO_LIVE_CHILD,
      lockPath: lockDir('l12.d'),
      stream: { write: () => {} },
    }),
  ).rejects.toThrow();
  await expect(
    resumeCampaign({
      campaignDir: dir,
      credentials: {},
      evalsCheckout: dir,
      gauntletCheckout: dir,
      superpowersCheckout: dir,
      clock: new FakeClock(1),
      identity: NO_LIVE_CHILD,
      lockPath: lockDir('l13.d'),
      stream: { write: () => {} },
    }),
  ).rejects.toThrow();
  expect(journaledTypes(dir, 2)).not.toContain('campaign_cancelled');
});

test('the cancel marker lands BEFORE the document is parsed (D-12 marker-first intent)', async () => {
  const { dir } = publishedCampaign();
  writeFileSync(join(dir, 'campaign.json'), '{"not":"a campaign"}');
  await expect(
    cancelCampaign({
      campaignDir: dir,
      reason: 'stop it anyway',
      clock: new FakeClock(1),
      identity: NO_LIVE_CHILD,
      lockPath: lockDir('l14.d'),
      stream: { write: () => {} },
    }),
  ).rejects.toThrow();
  // Admission is stopped even though the campaign document is unusable:
  // resume refuses while the marker is present.
  expect(existsSync(join(dir, 'cancel-request'))).toBe(true);
});

test('resume refuses a cancelled campaign (cancel-request precedence)', async () => {
  const { dir } = publishedCampaign();
  await cancelCampaign({
    campaignDir: dir,
    clock: new FakeClock(1),
    identity: NO_LIVE_CHILD,
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
    identity: NO_LIVE_CHILD,
    lockPath: lockDir('l2.d'),
    stream: { write: () => {} },
  });
  expect(outcome.status).toBe('cancelled');
});

// ---------------------------------------------------------------------------
// Decision D-12 live path: a REAL second process holds the live-spend lock
// ---------------------------------------------------------------------------

/** A real local Bun process that takes the live-spend lock for this campaign
 *  and, on SIGTERM, performs the dispatcher's half of the pinned sequence
 *  (journal `campaign_cancelled` last). Exercises the live arm end to end:
 *  real process identity, a real signal, the real read-only poll. */
function holderScript(repoRoot: string): string {
  const mod = (rel: string) => JSON.stringify(join(repoRoot, rel));
  return `
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireLiveSpendLock, realProcessIdentityProbe } from ${mod('src/campaign/locks.ts')};
import { electWriter } from ${mod('src/campaign/journal.ts')};
import { RealClock } from ${mod('src/scheduler/clock.ts')};

const [campaignDir, lockPath, readyPath, handleSignal] = process.argv.slice(2);
const clock = new RealClock();
const identity = realProcessIdentityProbe;
const campaign = JSON.parse(readFileSync(join(campaignDir, 'campaign.json'), 'utf8'));
acquireLiveSpendLock({ lockPath, campaignId: campaign.campaign_id, clock, identity });
if (handleSignal === 'yes') {
  process.on('SIGTERM', () => {
    const marker = readFileSync(join(campaignDir, 'cancel-request'), 'utf8');
    const reason = (marker.split('\\n')[1] ?? '').trim();
    const writer = electWriter({ campaignDir, clock, identity, campaign });
    writer.appendEvents([
      { type: 'aborted', payload: { block_id: ${JSON.stringify(BLOCK_A)} } },
      { type: 'campaign_cancelled', payload: reason === '' ? {} : { reason } },
    ]);
    writer.release();
    process.exit(0);
  });
}
writeFileSync(readyPath, 'ready');
setInterval(() => {}, 1000);
`;
}

async function startHolder(
  campaignDir: string,
  lockPath: string,
  handleSignal: 'yes' | 'no',
): Promise<{ proc: Bun.Subprocess; scratch: string }> {
  const scratch = mkdtempSync(join(tmpdir(), 'holder-'));
  const scriptPath = join(scratch, 'holder.ts');
  writeFileSync(scriptPath, holderScript(join(import.meta.dir, '..')));
  const readyPath = join(scratch, 'ready');
  const proc = Bun.spawn(
    ['bun', scriptPath, campaignDir, lockPath, readyPath, handleSignal],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  for (let i = 0; i < 400 && !existsSync(readyPath); i += 1) {
    await Bun.sleep(25);
  }
  if (!existsSync(readyPath)) {
    proc.kill('SIGKILL');
    const stderr = await new Response(proc.stderr as ReadableStream).text();
    throw new Error(`live-spend lock holder never became ready: ${stderr}`);
  }
  return { proc, scratch };
}

test('live-dispatcher cancel: the holder is identity-checked, signalled, and its campaign_cancelled is polled for (D-12)', async () => {
  const { dir } = publishedCampaign();
  const lockPath = lockDir('live-holder.lock.d');
  const holder = await startHolder(dir, lockPath, 'yes');
  try {
    const result = await cancelCampaign({
      campaignDir: dir,
      reason: 'signal the live one',
      clock: new RealClock(),
      identity: realProcessIdentityProbe,
      lockPath,
      stream: { write: () => {} },
    });
    // The LIVE path completed it: the command never took writer election.
    expect(result).toEqual({ cancelled: true, postCrash: false });
    const last = lastEvent(dir);
    expect(last?.type).toBe('campaign_cancelled');
    expect(last?.payload).toEqual({ reason: 'signal the live one' });
  } finally {
    holder.proc.kill('SIGKILL');
    await holder.proc.exited;
    rmSync(holder.scratch, { recursive: true, force: true });
  }
}, 60_000);

test('a holder that dies between the identity check and the signal falls through to the post-crash path (D-12 ESRCH race)', async () => {
  const { dir } = publishedCampaign();
  const lockPath = lockDir('ghost.lock.d');
  const holder = await startHolder(dir, lockPath, 'no');
  const token = readLiveSpendHolder(lockPath);
  expect(token?.pid).toBe(holder.proc.pid);
  // SIGKILL: the holder never runs a handler and never releases — its token
  // stays behind naming a pid that is now gone.
  holder.proc.kill('SIGKILL');
  await holder.proc.exited;
  rmSync(holder.scratch, { recursive: true, force: true });
  // A probe that still believes the holder is alive with its recorded birth:
  // cancel takes the live branch, and the real process.kill raises ESRCH.
  const ghostPid = token?.pid ?? -1;
  const result = await cancelCampaign({
    campaignDir: dir,
    reason: 'ghost dispatcher',
    clock: new RealClock(),
    identity: {
      exists: (pid) =>
        pid === ghostPid ? 'alive' : realProcessIdentityProbe.exists(pid),
      startTimeMs: (pid) =>
        pid === ghostPid
          ? (token?.birth_ts_ms ?? null)
          : realProcessIdentityProbe.startTimeMs(pid),
    },
    lockPath,
    stream: { write: () => {} },
  });
  expect(result).toEqual({ cancelled: true, postCrash: true });
  expect(lastEvent(dir)?.type).toBe('campaign_cancelled');
}, 60_000);
