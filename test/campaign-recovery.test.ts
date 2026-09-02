import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { SidecarLine } from '../src/campaign/contention.ts';
import type {
  GroupSignaler,
  SubjectHostProbe,
} from '../src/campaign/dispatcher.ts';
import { type EventInput, replayEvents } from '../src/campaign/journal.ts';
import type { ProcessIdentityProbe } from '../src/campaign/locks.ts';
import {
  killJournaledPgids,
  planRecovery,
  quarantineActions,
  RecoveryError,
  readRunDirIdentities,
  rederiveContentionSuffix,
  terminalEvidenceActions,
  unverifiedSubjectHosts,
} from '../src/campaign/recovery.ts';
import type { Campaign } from '../src/contracts/campaign/campaign.ts';
import type { CampaignUniverse } from '../src/contracts/campaign/crash-windows.ts';
import type { JournalEvent } from '../src/contracts/campaign/journal-events.ts';
import { FakeClock } from '../src/scheduler/clock.ts';

const CAMPAIGN_ID = 'c'.repeat(64);

const UNIVERSE: CampaignUniverse = {
  samples: [
    { sample_id: 's1', arm: 'base', cell: 'c1:scn' },
    { sample_id: 's2', arm: 'treat', cell: 'c1:scn' },
  ],
  blocks: [{ block_id: 'b1', sample_ids: ['s1', 's2'] }],
};

let SEQ = 0;
function ev(type: JournalEvent['type'], payload: unknown): JournalEvent {
  SEQ += 1;
  return { seq: SEQ, ts_ms: SEQ * 1000, type, payload } as JournalEvent;
}

// ---------------------------------------------------------------------------
// R-RCV-1: identity-guarded kill with verified death
// ---------------------------------------------------------------------------

/** The campaign child's real argv shape (spawn.ts buildCampaignChildArgv):
 *  the persisted identity travels on `--campaign-identity`. */
function childCommandLine(attemptId: string): string {
  return `bun /snap/src/cli/index.ts run /scn --coding-agent claude --campaign-identity {"campaign_id":"${CAMPAIGN_ID}","comparison_id":"c1","block_id":"b1","sample_id":"s1","execution_attempt_id":"${attemptId}"}`;
}

const ALIVE_AT_5: ProcessIdentityProbe = {
  exists: () => 'alive',
  startTimeMs: () => 5,
};

/** Never read: the subject-host seam is faked, so no run dir is probed. */
const RESULTS_ROOT = '/results';
/** Nothing hosts any run — for tests that are not about the subject host. */
const NO_SUBJECT_HOST: SubjectHostProbe = { find: () => null, kill: () => {} };
/** C10 subject-host fake: every run dir is hosted by its own private
 *  gauntlet server (`gauntlet-<runId>-subject`) until killed, unless
 *  `immortal`. Fake servers never reach real tmux. */
function fakeSubjectHost(
  opts: { immortal?: boolean } = {},
): SubjectHostProbe & { finds: string[]; kills: string[] } {
  const dead = new Set<string>();
  const finds: string[] = [];
  const kills: string[] = [];
  return {
    finds,
    kills,
    find: (runDir) => {
      finds.push(runDir);
      const name = `gauntlet-${basename(runDir)}-subject`;
      return dead.has(name) ? null : name;
    },
    kill: (server) => {
      kills.push(server);
      if (opts.immortal !== true) dead.add(server);
    },
  };
}
/** The child dies on TERM and answers ESRCH thereafter. */
function mortalGroup(): GroupSignaler {
  const dead = new Set<number>();
  return (pgid, sig) => {
    if (dead.has(pgid)) return 'esrch';
    if (sig === 'SIGTERM') dead.add(pgid);
    return 'ok';
  };
}

function inFlightEvents(): JournalEvent[] {
  SEQ = 0;
  return [
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev('run_allocated', {
      attempt_id: 'a1',
      run_id: 'r1',
      pgid: 111,
      key_grants: [],
    }),
    ev('attempt_created', { sample_id: 's2', attempt_id: 'a2' }),
    ev('run_allocated', {
      attempt_id: 'a2',
      run_id: 'r2',
      pgid: 222,
      key_grants: [],
    }),
    ev('run_completed', { attempt_id: 'a2', outcome: 'pass' }), // a2 terminaled
  ];
}

test('killJournaledPgids: every journaled pgid without a terminal is TERMed and VERIFIED dead, identity-guarded', async () => {
  const signalled: [number, NodeJS.Signals | 0][] = [];
  const dead = new Set<number>();
  const signal: GroupSignaler = (pgid, sig) => {
    signalled.push([pgid, sig]);
    if (dead.has(pgid)) return 'esrch';
    if (sig === 'SIGTERM') dead.add(pgid); // the child dies on TERM
    return 'ok';
  };
  const report = await killJournaledPgids({
    events: inFlightEvents(),
    campaignId: CAMPAIGN_ID,
    resultsRoot: RESULTS_ROOT,
    subjectHost: NO_SUBJECT_HOST,
    identity: ALIVE_AT_5,
    child: {
      commandLine: (pgid) => (pgid === 111 ? childCommandLine('a1') : null),
    },
    signal,
    clock: new FakeClock(),
    graceSeconds: 5,
  });
  expect(report.killed).toEqual([111]); // only the non-terminal attempt
  expect(report.survived).toEqual([]);
  expect(report.reclaimedUnsafe).toEqual([]);
  expect(report.reclaimedBenign).toEqual([]);
  // Verified death, not fire-and-forget: TERM then a 0-probe that proved it.
  expect(signalled).toEqual([
    [111, 'SIGTERM'],
    [111, 0],
  ]);
});

test('killJournaledPgids: a recycled pgid and an uninspectable group are reclaimed-without-kill — never signaled blind (R-RCV-1)', async () => {
  const run = async (
    commandLine: (pgid: number) => string | null,
    groupAnswer: 'ok' | 'esrch' = 'ok',
  ) => {
    const signalled: [number, NodeJS.Signals | 0][] = [];
    const loud: string[] = [];
    const report = await killJournaledPgids({
      events: inFlightEvents(),
      campaignId: CAMPAIGN_ID,
      resultsRoot: RESULTS_ROOT,
      subjectHost: NO_SUBJECT_HOST,
      identity: ALIVE_AT_5,
      child: { commandLine },
      signal: (pgid, sig) => {
        signalled.push([pgid, sig]);
        return groupAnswer;
      },
      clock: new FakeClock(),
      stream: { write: (s) => loud.push(s) },
    });
    return { report, signalled, loud: loud.join('') };
  };
  // A different process now owns the pgid, but the GROUP still answers: a
  // reused leader is not proof our child is gone (the same group-level
  // evidence killGroupVerified demands for its 'stale' arm).
  const recycled = await run(() => 'ps aux');
  expect(recycled.report.reclaimedUnsafe).toEqual([111]);
  expect(recycled.report.reclaimedBenign).toEqual([]);
  expect(recycled.signalled).toEqual([[111, 0]]); // group probe only
  expect(recycled.loud).toMatch(/reclaimed-without-kill \(unsafe\)/);
  // Reused leader AND a group that is provably gone: BENIGN — no campaign
  // child can still be spending under this pgid, so callers may proceed.
  const reused = await run(() => 'ps aux', 'esrch');
  expect(reused.report.reclaimedBenign).toEqual([111]);
  expect(reused.report.reclaimedUnsafe).toEqual([]);
  expect(reused.loud).toMatch(/reclaimed-without-kill \(benign\)/);
  // Command line unreadable: identity UNKNOWN, still never signaled, and
  // never assumed dead.
  const opaque = await run(() => null);
  expect(opaque.report.reclaimedUnsafe).toEqual([111]);
  expect(opaque.signalled).toEqual([]);
  expect(opaque.loud).toMatch(/reclaimed-without-kill \(unsafe\)/);
});

test('killJournaledPgids: a group surviving TERM+KILL is reported survived (never "killed"), and signal errors are never swallowed', async () => {
  const loud: string[] = [];
  const survivor = await killJournaledPgids({
    events: inFlightEvents(),
    campaignId: CAMPAIGN_ID,
    resultsRoot: RESULTS_ROOT,
    subjectHost: NO_SUBJECT_HOST,
    identity: ALIVE_AT_5,
    child: { commandLine: () => childCommandLine('a1') },
    signal: () => 'ok', // never dies
    clock: new FakeClock(),
    graceSeconds: 0,
    stream: { write: (s) => loud.push(s) },
  });
  expect(survivor.survived).toEqual([111]);
  expect(survivor.killed).toEqual([]);
  expect(loud.join('')).toMatch(/survived TERM\+KILL/);
  await expect(
    killJournaledPgids({
      events: inFlightEvents(),
      campaignId: CAMPAIGN_ID,
      resultsRoot: RESULTS_ROOT,
      subjectHost: NO_SUBJECT_HOST,
      identity: ALIVE_AT_5,
      child: { commandLine: () => childCommandLine('a1') },
      signal: () => {
        throw new Error('EPERM');
      },
      clock: new FakeClock(),
    }),
  ).rejects.toThrow(/EPERM/);
});

test('killJournaledPgids: a dead LEADER is not a dead group — a leaderless group with live descendants is never reported dead (R-RCV-1)', async () => {
  const leaderGone: ProcessIdentityProbe = {
    exists: () => 'esrch',
    startTimeMs: () => null,
  };
  // The leader exited; grandchildren in the group are still running (and
  // still spending), so the group answers the 0-probe.
  const signalled: [number, NodeJS.Signals | 0][] = [];
  const loud: string[] = [];
  const live = await killJournaledPgids({
    events: inFlightEvents(),
    campaignId: CAMPAIGN_ID,
    resultsRoot: RESULTS_ROOT,
    subjectHost: NO_SUBJECT_HOST,
    identity: leaderGone,
    child: { commandLine: () => null }, // no leader to inspect
    signal: (pgid, sig) => {
      signalled.push([pgid, sig]);
      return 'ok';
    },
    clock: new FakeClock(),
    stream: { write: (s) => loud.push(s) },
  });
  expect(live.alreadyDead).toEqual([]);
  expect(live.killed).toEqual([]);
  expect(live.reclaimedUnsafe).toEqual([111]);
  expect(signalled).toEqual([[111, 0]]); // probed, never signaled blind
  expect(loud.join('')).toMatch(/without its leader/);

  // Only an ESRCH on the GROUP is evidence of death.
  const gone = await killJournaledPgids({
    events: inFlightEvents(),
    campaignId: CAMPAIGN_ID,
    resultsRoot: RESULTS_ROOT,
    subjectHost: NO_SUBJECT_HOST,
    identity: leaderGone,
    child: { commandLine: () => null },
    signal: () => 'esrch',
    clock: new FakeClock(),
  });
  expect(gone.alreadyDead).toEqual([111]);
  expect(gone.reclaimedUnsafe).toEqual([]);
  expect(gone.reclaimedBenign).toEqual([]);
});

test('killJournaledPgids: a leader that dies between the identity check and the kill is never recorded killed — the group proves its own death (R-RCV-1 race)', async () => {
  let probeCount = 0;
  const dyingLeader: ProcessIdentityProbe = {
    // Alive for the outer campaign-child check, gone by the time the
    // verified kill re-checks it.
    exists: () => (probeCount++ === 0 ? 'alive' : 'esrch'),
    startTimeMs: () => 5,
  };
  const signalled: (NodeJS.Signals | 0)[] = [];
  const loud: string[] = [];
  const report = await killJournaledPgids({
    events: inFlightEvents(),
    campaignId: CAMPAIGN_ID,
    resultsRoot: RESULTS_ROOT,
    subjectHost: NO_SUBJECT_HOST,
    identity: dyingLeader,
    child: { commandLine: () => childCommandLine('a1') },
    signal: (_pgid, sig) => {
      signalled.push(sig);
      return 'ok'; // the group still answers: descendants outlived the leader
    },
    clock: new FakeClock(),
    stream: { write: (s) => loud.push(s) },
  });
  expect(report.killed).toEqual([]);
  expect(report.alreadyDead).toEqual([]);
  expect(report.reclaimedUnsafe).toEqual([111]);
  expect(signalled).toEqual([0]); // group probe only — no TERM, no KILL
  expect(loud.join('')).toMatch(/still answers/);
});

// The group's death never reaches the subject (C10): gauntlet hosts every
// Coding-Agent in a private tmux server that setsid()s out of the child's
// group, so verified death must ALSO reach the run's tmux subject host.
test("killJournaledPgids: after the group is verified dead, the run's tmux subject host is killed and VERIFIED gone", async () => {
  const host = fakeSubjectHost();
  const report = await killJournaledPgids({
    events: inFlightEvents(),
    campaignId: CAMPAIGN_ID,
    identity: ALIVE_AT_5,
    child: {
      commandLine: (pgid) => (pgid === 111 ? childCommandLine('a1') : null),
    },
    signal: mortalGroup(),
    clock: new FakeClock(),
    graceSeconds: 5,
    resultsRoot: RESULTS_ROOT,
    subjectHost: host,
  });
  expect(report.killed).toEqual([111]);
  expect(report.subjectHostsKilled).toEqual([
    { attempt_id: 'a1', run_id: 'r1', server: 'gauntlet-r1-subject' },
  ]);
  expect(report.subjectHostsSurvived).toEqual([]);
  expect(host.kills).toEqual(['gauntlet-r1-subject']);
  // Only the non-terminal attempt's run is probed: a terminaled run's
  // gauntlet ran its own teardown.
  expect(host.finds.length).toBeGreaterThan(0);
  expect(host.finds.every((d) => d === join(RESULTS_ROOT, 'r1'))).toBe(true);
});

test('killJournaledPgids: a group that was already dead STILL gets its tmux subject host killed — the crash-path orphan (R-RCV-1)', async () => {
  // The dispatcher crashed and the child died with it; gauntlet's tmux
  // server (ppid 1) kept the subject running and spending.
  const host = fakeSubjectHost();
  const report = await killJournaledPgids({
    events: inFlightEvents(),
    campaignId: CAMPAIGN_ID,
    identity: { exists: () => 'esrch', startTimeMs: () => null },
    child: { commandLine: () => null },
    signal: () => 'esrch',
    clock: new FakeClock(),
    resultsRoot: RESULTS_ROOT,
    subjectHost: host,
  });
  expect(report.alreadyDead).toEqual([111]);
  expect(report.subjectHostsKilled).toEqual([
    { attempt_id: 'a1', run_id: 'r1', server: 'gauntlet-r1-subject' },
  ]);
  expect(host.kills).toEqual(['gauntlet-r1-subject']);
  // A run nothing hosts is simply not a subject-host kill.
  const unhosted = await killJournaledPgids({
    events: inFlightEvents(),
    campaignId: CAMPAIGN_ID,
    identity: { exists: () => 'esrch', startTimeMs: () => null },
    child: { commandLine: () => null },
    signal: () => 'esrch',
    clock: new FakeClock(),
    resultsRoot: RESULTS_ROOT,
    subjectHost: NO_SUBJECT_HOST,
  });
  expect(unhosted.subjectHostsKilled).toEqual([]);
  expect(unhosted.subjectHostsSurvived).toEqual([]);
});

test('killJournaledPgids: a tmux subject host surviving kill-server is reported survived (never counted killed) and blocks both verbs like a surviving group', async () => {
  const host = fakeSubjectHost({ immortal: true });
  const loud: string[] = [];
  const report = await killJournaledPgids({
    events: inFlightEvents(),
    campaignId: CAMPAIGN_ID,
    identity: ALIVE_AT_5,
    child: { commandLine: () => childCommandLine('a1') },
    signal: mortalGroup(),
    clock: new FakeClock(),
    graceSeconds: 0,
    resultsRoot: RESULTS_ROOT,
    subjectHost: host,
    stream: { write: (s) => loud.push(s) },
  });
  expect(report.killed).toEqual([111]); // the group did die...
  expect(report.subjectHostsKilled).toEqual([]);
  expect(report.subjectHostsSurvived).toEqual([
    { attempt_id: 'a1', run_id: 'r1', server: 'gauntlet-r1-subject' },
  ]);
  expect(unverifiedSubjectHosts(report)).toEqual([
    'tmux server gauntlet-r1-subject (attempt a1, run r1)',
  ]);
  expect(loud.join('')).toMatch(/subject verify-death FAILED/);
});

// ---------------------------------------------------------------------------
// R-RCV-2 / R-RCV-5: the crash-window plan
// ---------------------------------------------------------------------------

test('planRecovery: superseded predecessor gets no action; missing dispositions completed; minted successor re-admitted as itself', () => {
  SEQ = 0;
  const events = [
    ev('block_admitted', { block_id: 'b1', pools: ['p'] }),
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev('run_allocated', {
      attempt_id: 'a1',
      run_id: 'r1',
      pgid: 111,
      key_grants: [],
    }),
    ev('instrument_failure', { attempt_id: 'a1', cause: 'grader_crashed' }),
    // Mint landed, then crash: s2's disposition never journaled, successor never admitted.
    ev('block_replaced', {
      block_id: 'b1',
      replacement_block_id: 'x1',
      reason: 'grader_crashed',
      kind: 'replacement',
      reserve_activation: true,
      roster: [
        { sample_id: 'x1s1', arm: 'base', supersedes: 's1' },
        { sample_id: 'x1s2', arm: 'treat', supersedes: 's2' },
      ],
    }),
  ];
  const universe: CampaignUniverse = {
    samples: [
      { sample_id: 's1', arm: 'base', cell: 'c1:scn' },
      { sample_id: 's2', arm: 'treat', cell: 'c1:scn' },
      { sample_id: 'x1s1', arm: 'base', cell: 'c1:scn' },
      { sample_id: 'x1s2', arm: 'treat', cell: 'c1:scn' },
    ],
    blocks: [
      { block_id: 'b1', sample_ids: ['s1', 's2'] },
      { block_id: 'x1', sample_ids: ['x1s1', 'x1s2'], slot: 'reserve' },
    ],
  };
  const plan = planRecovery({ universe, events });
  // The superseded predecessor's attempt gets NO readmit/rerun action.
  expect(plan.kills.map((k) => k.attempt_id)).toEqual([]);
  // s2 was admitted at mint time -> its disposition is completed from the roster.
  expect(plan.dispositionCompletions).toEqual([
    { block_id: 'x1', sample_id: 's2', superseded_by: 'x1s2' },
  ]);
  // The minted-but-unadmitted successor admits as THAT successor.
  expect(plan.successorReadmissions).toEqual([{ block_id: 'x1' }]);
  expect(plan.campaign).toBe('none');
});

test('planRecovery: a pre-run_allocated crash window voids the attempt and re-admits its block (R-RCV-5 second resolution)', () => {
  SEQ = 0;
  const events = [
    ev('block_admitted', { block_id: 'b1', pools: ['p'] }),
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev('run_allocated', {
      attempt_id: 'a1',
      run_id: 'r1',
      pgid: 111,
      key_grants: [],
    }),
    ev('attempt_created', { sample_id: 's2', attempt_id: 'a2' }), // never allocated
  ];
  const plan = planRecovery({ universe: UNIVERSE, events });
  expect(plan.kills).toEqual([{ attempt_id: 'a1', pgid: 111 }]);
  // The pre-allocation window is EXECUTED, not discarded: void + re-admit.
  expect(plan.voidReadmissions).toEqual([
    { attempt_id: 'a2', sample_id: 's2', block_id: 'b1' },
  ]);
});

test('planRecovery: the post-seal-predicate pre-report window is carried as the campaign action (R-RCV-5 third resolution)', () => {
  SEQ = 0;
  const events = [
    ev('block_admitted', { block_id: 'b1', pools: ['p'] }),
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev('run_allocated', {
      attempt_id: 'a1',
      run_id: 'r1',
      pgid: 111,
      key_grants: [],
    }),
    ev('exposure_started', { sample_id: 's1', ts: 4000 }),
    ev('run_completed', { attempt_id: 'a1', outcome: 'pass' }),
    ev('attempt_created', { sample_id: 's2', attempt_id: 'a2' }),
    ev('run_allocated', {
      attempt_id: 'a2',
      run_id: 'r2',
      pgid: 222,
      key_grants: [],
    }),
    ev('exposure_started', { sample_id: 's2', ts: 8000 }),
    ev('run_completed', { attempt_id: 'a2', outcome: 'fail' }),
  ];
  expect(() => replayEvents(UNIVERSE, events)).not.toThrow();
  const plan = planRecovery({ universe: UNIVERSE, events });
  expect(plan.campaign).toBe('regenerate_report');
  expect(plan.kills).toEqual([]);
  expect(plan.voidReadmissions).toEqual([]);
});

// ---------------------------------------------------------------------------
// Decision D-13 + C11: terminal evidence over the admitted instance chain
// ---------------------------------------------------------------------------

test('terminal-evidence rule: a complete verdict journals terminal; a missing run dir re-enters via rerun', () => {
  SEQ = 0;
  const events = [
    ev('block_admitted', { block_id: 'b1', pools: ['p'] }),
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev('run_allocated', {
      attempt_id: 'a1',
      run_id: 'r1',
      pgid: 111,
      key_grants: [],
    }),
  ];
  const withEvidence = terminalEvidenceActions({
    events,
    universe: UNIVERSE,
    cooldownsOf: () => [],
    suiteKind: 'gating',
    nowMs: 10_000,
    evidenceOf: (runId) =>
      runId === 'r1'
        ? {
            outcome: 'pass' as const,
            costUsd: 0.5,
            exposureTsMs: 1_000,
            sensor: null,
            poolBlocks: [],
          }
        : null,
  });
  // The FULL fate-table bundle, in replay-legal order: exposure lifts the
  // sample out of `spawned` (a bare run_completed from there is illegal),
  // then the terminal, then the ACTUAL spend.
  expect(withEvidence.terminals.map((e) => e.type)).toEqual([
    'exposure_started',
    'run_completed',
    // Every spend carries the receipt naming its attempt — the universal
    // shape, so "already paid" is readable per attempt on a later resume.
    'adjudication',
    'budget_event',
  ]);
  expect(withEvidence.terminals[2]?.payload).toMatchObject({
    disposition: 'spend_recovered',
    rationale: expect.stringContaining('attempt=a1;'),
  });
  expect(withEvidence.terminals[3]?.payload).toEqual({
    kind: 'spend',
    amount_usd: 0.5,
  });
  const withoutRunDir = terminalEvidenceActions({
    events,
    universe: UNIVERSE,
    cooldownsOf: () => [],
    suiteKind: 'gating',
    nowMs: 10_000,
    evidenceOf: () => null,
  });
  expect(withoutRunDir.terminals).toEqual([]);
  expect(withoutRunDir.rerunBlockIds).toEqual(['b1']);
});

test('terminal-evidence rule: a gating sample whose exposure never established gets NO terminal — the instance re-enters via rerun', () => {
  SEQ = 0;
  const events = [
    ev('block_admitted', { block_id: 'b1', pools: ['p'] }),
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev('run_allocated', {
      attempt_id: 'a1',
      run_id: 'r1',
      pgid: 111,
      key_grants: [],
    }),
  ];
  const actions = terminalEvidenceActions({
    events,
    universe: UNIVERSE,
    cooldownsOf: () => [],
    suiteKind: 'gating',
    nowMs: 10_000,
    evidenceOf: () => ({
      outcome: 'pass' as const,
      costUsd: 0.5,
      exposureTsMs: null, // never established
      sensor: null,
      poolBlocks: [],
    }),
  });
  // No terminal — there is no legal edge — but the run RAN and SPENT, so its
  // actual cost is ACCOUNTED (receipt first, then the spend it records)
  // before the instance re-enters. Blind-rerunning would drop that money and
  // pay for the same work twice.
  expect(actions.terminals.map((e) => e.type)).toEqual([
    'adjudication',
    'budget_event',
  ]);
  expect(actions.terminals[0]?.payload).toMatchObject({
    disposition: 'spend_recovered',
    rationale: expect.stringContaining('attempt=a1;'),
  });
  expect(actions.terminals[1]?.payload).toEqual({
    kind: 'spend',
    amount_usd: 0.5,
  });
  expect(actions.rerunBlockIds).toEqual(['b1']);
});

test('terminal-evidence rule: rate-limit evidence re-declares its pool cooldown alongside the terminal (D-13 fate table)', () => {
  SEQ = 0;
  const events = [
    ev('block_admitted', { block_id: 'b1', pools: ['p'] }),
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev('run_allocated', {
      attempt_id: 'a1',
      run_id: 'r1',
      pgid: 111,
      key_grants: [],
    }),
  ];
  const rateLimited = {
    outcome: 'indeterminate' as const,
    costUsd: 0.25,
    exposureTsMs: 1_000,
    sensor: { role: 'subject' as const, evidence: '429-match' as const },
    poolBlocks: [{ poolKey: 'cred|anthropic|m', cooldownMs: 60_000 }],
  };
  const actions = terminalEvidenceActions({
    events,
    universe: UNIVERSE,
    cooldownsOf: () => rateLimited.poolBlocks,
    suiteKind: 'gating',
    nowMs: 10_000,
    evidenceOf: () => rateLimited,
  });
  // The spend follows the terminal IMMEDIATELY: that adjacency is what lets
  // a later resume tell a complete bundle from a crash-truncated one.
  // The cooldown precedes the receipt: a lost cooldown then implies a lost
  // receipt, which is what makes "did THIS attempt's row land?" decidable at
  // all once a sibling row exists for the same pool.
  expect(actions.terminals.map((e) => e.type)).toEqual([
    'exposure_started',
    'instrument_failure',
    'pool_blocked',
    'adjudication', // the spend receipt naming the attempt
    'budget_event',
  ]);
  expect(actions.terminals[2]?.payload).toEqual({
    pool_key: 'cred|anthropic|m',
    until_ts_ms: 70_000,
  });
});

test('a crash before the cooldown also loses the receipt, and the repair re-runs whole — exactly once', () => {
  SEQ = 0;
  // Under the pinned ordering the reachable cut is HERE: the terminal
  // landed, and the cooldown + receipt + spend that follow it did not. The
  // attempt is therefore not `recovered`, so the repair re-runs in full.
  const events = [
    ev('block_admitted', { block_id: 'b1', pools: ['p'] }),
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev('run_allocated', {
      attempt_id: 'a1',
      run_id: 'r1',
      pgid: 111,
      key_grants: [],
    }),
    ev('exposure_started', { sample_id: 's1', ts: 1_000 }),
    ev('run_completed', { attempt_id: 'a1', outcome: 'pass' }),
  ];
  const terminalTs = events[4]!.ts_ms;
  const call = (extra: JournalEvent[] = []) =>
    terminalEvidenceActions({
      events: [...events, ...extra],
      universe: UNIVERSE,
      cooldownsOf: () => [{ poolKey: 'cred|anthropic|m', cooldownMs: 60_000 }],
      suiteKind: 'gating',
      nowMs: terminalTs + 1_000,
      evidenceOf: () => ({
        outcome: 'pass' as const,
        costUsd: 0.25,
        exposureTsMs: 1_000,
        sensor: null,
        poolBlocks: [{ poolKey: 'cred|anthropic|m', cooldownMs: 60_000 }],
      }),
    });
  const repaired = call();
  expect(repaired.terminals.map((e) => e.type)).toEqual([
    'pool_blocked',
    'adjudication',
    'budget_event',
  ]);
  expect(repaired.terminals[0]?.payload).toEqual({
    pool_key: 'cred|anthropic|m',
    until_ts_ms: terminalTs + 60_000,
  });

  // A crash between the cooldown and the receipt re-runs too — and the
  // deterministic candidate no longer exceeds what it just wrote, so the
  // cooldown is suppressed while the spend still lands exactly once.
  SEQ = events.length;
  const again = call([
    ev('pool_blocked', {
      pool_key: 'cred|anthropic|m',
      until_ts_ms: terminalTs + 60_000,
    }),
  ]);
  expect(again.terminals.map((e) => e.type)).toEqual([
    'adjudication',
    'budget_event',
  ]);
});

test('a cooldown whose window has already passed is not resurrected', () => {
  SEQ = 0;
  const events = [
    ev('block_admitted', { block_id: 'b1', pools: ['p'] }),
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev('run_allocated', {
      attempt_id: 'a1',
      run_id: 'r1',
      pgid: 111,
      key_grants: [],
    }),
    ev('run_completed', { attempt_id: 'a1', outcome: 'pass' }),
    ev('adjudication', {
      cell: 'c1:scn',
      disposition: 'spend_recovered',
      rationale: 'attempt=a1; actual cost of run r1 at terminal',
    }),
    ev('budget_event', { kind: 'spend', amount_usd: 0.25 }),
  ];
  const actions = terminalEvidenceActions({
    events,
    universe: UNIVERSE,
    cooldownsOf: () => [{ poolKey: 'cred|anthropic|m', cooldownMs: 60_000 }],
    suiteKind: 'gating',
    // Long past the window: an expired cooldown blocks no admission, so
    // restoring one would be a fabricated block, not a repair.
    nowMs: events[3]!.ts_ms + 10 * 60_000,
    evidenceOf: () => null,
  });
  expect(actions.terminals).toEqual([]);
});

test('two attempts crash-cut in the SAME pool: the later window is appended, the covered one is suppressed (D-10 max)', () => {
  SEQ = 0;
  const universe: CampaignUniverse = {
    samples: [
      { sample_id: 's1', arm: 'base', cell: 'c1:scn' },
      { sample_id: 's2', arm: 'treat', cell: 'c1:scn' },
    ],
    blocks: [{ block_id: 'b1', sample_ids: ['s1', 's2'] }],
  };
  const events = [
    ev('block_admitted', { block_id: 'b1', pools: ['p'] }),
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev('run_allocated', {
      attempt_id: 'a1',
      run_id: 'r1',
      pgid: 111,
      key_grants: [],
    }),
    ev('attempt_created', { sample_id: 's2', attempt_id: 'a2' }),
    ev('run_allocated', {
      attempt_id: 'a2',
      run_id: 'r2',
      pgid: 222,
      key_grants: [],
    }),
    ev('exposure_started', { sample_id: 's1', ts: 1_000 }),
    ev('run_completed', { attempt_id: 'a1', outcome: 'pass' }),
    ev('exposure_started', { sample_id: 's2', ts: 1_000 }),
    ev('run_completed', { attempt_id: 'a2', outcome: 'pass' }),
  ];
  const actions = terminalEvidenceActions({
    events,
    universe,
    // Both runs' evidence names the SAME pool.
    cooldownsOf: () => [{ poolKey: 'shared|anthropic|m', cooldownMs: 60_000 }],
    suiteKind: 'gating',
    nowMs: 2_000,
    evidenceOf: () => ({
      outcome: 'pass' as const,
      costUsd: 0.25,
      exposureTsMs: 1_000,
      sensor: null,
      poolBlocks: [{ poolKey: 'shared|anthropic|m', cooldownMs: 60_000 }],
    }),
  });
  // a1 declares its window; a2's terminal is later, so its window strictly
  // exceeds a1's and is appended too — D-10's max, applied on append. A
  // sibling's row never stands in for an attempt whose own window is later.
  const cooldowns = actions.terminals.filter((e) => e.type === 'pool_blocked');
  const terminalTs = events
    .filter((e) => e.type === 'run_completed')
    .map((e) => e.ts_ms);
  expect(cooldowns.map((e) => e.payload)).toEqual([
    { pool_key: 'shared|anthropic|m', until_ts_ms: terminalTs[0]! + 60_000 },
    { pool_key: 'shared|anthropic|m', until_ts_ms: terminalTs[1]! + 60_000 },
  ]);
});

test('an attempt with no admitted instance REFUSES recovery loudly — an unattributable in-flight run is never silently dropped (C11)', () => {
  SEQ = 0;
  const events = [
    // No block_admitted at all: membership for s1 is unknown at this seq.
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev('run_allocated', {
      attempt_id: 'a1',
      run_id: 'r1',
      pgid: 111,
      key_grants: [],
    }),
  ];
  expect(() =>
    terminalEvidenceActions({
      events,
      universe: UNIVERSE,
      cooldownsOf: () => [],
      suiteKind: 'gating',
      nowMs: 0,
      evidenceOf: () => null,
    }),
  ).toThrow(RecoveryError);
});

test('crash-cut in-flight mapping resolves against the ADMITTED INSTANCE CHAIN — primary, reserve, and rerun instances each rerun under their own id (C11)', () => {
  // The cut: three instances are admitted BEFORE their in-flight attempts are
  // created, so "the most recently admitted block" attributes every attempt to
  // the last instance admitted (b3:i1). Only lineage-aware attribution
  // (universe blocks UNION mint rosters, latest admission at or before the
  // attempt) reruns each instance under its own id.
  const universe: CampaignUniverse = {
    samples: [
      { sample_id: 's1', arm: 'base', cell: 'c1:scn' },
      { sample_id: 's2', arm: 'treat', cell: 'c1:scn' },
      { sample_id: 's3', arm: 'base', cell: 'c2:scn' },
      { sample_id: 's4', arm: 'treat', cell: 'c2:scn' },
      { sample_id: 's5', arm: 'base', cell: 'c3:scn' },
      { sample_id: 's6', arm: 'treat', cell: 'c3:scn' },
      { sample_id: 'x2s1', arm: 'base', cell: 'c2:scn' },
      { sample_id: 'x2s2', arm: 'treat', cell: 'c2:scn' },
    ],
    blocks: [
      { block_id: 'b1', sample_ids: ['s1', 's2'] },
      { block_id: 'b2', sample_ids: ['s3', 's4'] },
      { block_id: 'b3', sample_ids: ['s5', 's6'] },
      { block_id: 'x2', sample_ids: ['x2s1', 'x2s2'], slot: 'reserve' },
    ],
  };
  SEQ = 0;
  const events = [
    ev('block_admitted', { block_id: 'b1', pools: ['p'] }),
    ev('block_admitted', { block_id: 'b2', pools: ['p'] }),
    ev('block_admitted', { block_id: 'b3', pools: ['p'] }),
    ev('attempt_created', { sample_id: 's3', attempt_id: 'a0' }),
    ev('run_allocated', {
      attempt_id: 'a0',
      run_id: 'r0',
      pgid: 100,
      key_grants: [],
    }),
    ev('instrument_failure', { attempt_id: 'a0', cause: 'grader_crashed' }),
    // …with the accounting tail the writer appends in the same critical
    // section: the receipt naming the attempt, then its spend. Without the
    // receipt the attempt reads as never paid.
    ev('adjudication', {
      cell: 'c2:scn',
      disposition: 'spend_recovered',
      rationale: 'attempt=a0; actual cost of run r0 at terminal',
    }),
    ev('budget_event', { kind: 'spend', amount_usd: 0.5 }),
    ev('budget_event', { kind: 'estimate_inflight', amount_usd: 0 }),
    // The complete E7.1 mint bundle: s3 keeps instrument_failed, s4 (admitted)
    // takes its disposition, THEN the successor is admitted.
    ev('block_replaced', {
      block_id: 'b2',
      replacement_block_id: 'x2',
      reason: 'grader_crashed',
      kind: 'replacement',
      reserve_activation: true,
      roster: [
        { sample_id: 'x2s1', arm: 'base', supersedes: 's3' },
        { sample_id: 'x2s2', arm: 'treat', supersedes: 's4' },
      ],
    }),
    ev('sample_disposition', {
      sample_id: 's4',
      disposition: 'excluded_block_replaced',
      superseded_by: 'x2s2',
    }),
    ev('block_admitted', { block_id: 'x2', pools: ['p'] }),
    // E7.1 rerun re-entry: the block is aborted FIRST, then re-entered.
    ev('aborted', { block_id: 'b3' }),
    ev('block_replaced', {
      block_id: 'b3',
      replacement_block_id: 'b3:i1',
      reason: 'dispatcher_restart',
      kind: 'rerun',
      reserve_activation: false,
      roster: [
        { sample_id: 's5', arm: 'base' },
        { sample_id: 's6', arm: 'treat' },
      ],
    }),
    ev('block_admitted', { block_id: 'b3:i1', pools: ['p'], rerun_of: 'b3' }),
    // All three in-flight attempts are created AFTER the last admission.
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a1' }), // primary b1
    ev('run_allocated', {
      attempt_id: 'a1',
      run_id: 'r1',
      pgid: 111,
      key_grants: [],
    }),
    ev('attempt_created', { sample_id: 'x2s1', attempt_id: 'a2' }), // reserve x2
    ev('run_allocated', {
      attempt_id: 'a2',
      run_id: 'r2',
      pgid: 222,
      key_grants: [],
    }),
    ev('attempt_created', { sample_id: 's5', attempt_id: 'a3' }), // rerun b3:i1
    ev('run_allocated', {
      attempt_id: 'a3',
      run_id: 'r3',
      pgid: 333,
      key_grants: [],
    }),
  ];
  // The prefix is a LEGAL journal: replay accepts every edge in this order.
  expect(() => replayEvents(universe, events)).not.toThrow();
  const actions = terminalEvidenceActions({
    events,
    universe,
    cooldownsOf: () => [],
    suiteKind: 'gating',
    nowMs: 0,
    evidenceOf: () => null, // no run dirs survived the crash
  });
  expect(actions.rerunBlockIds).toEqual(['b1', 'x2', 'b3:i1']);
});

// ---------------------------------------------------------------------------
// R-RCV-3 / R-RCV-4: the run-dir identity sweep
// ---------------------------------------------------------------------------

test('quarantine by attempt-id / campaign mismatch from the persisted identity', () => {
  SEQ = 0;
  const events = [
    ev('run_allocated', {
      attempt_id: 'a1',
      run_id: 'r1',
      pgid: 1,
      key_grants: [],
    }),
  ];
  const actions = quarantineActions({
    runDirIdentities: [
      {
        runId: 'r1',
        identity: {
          campaign_id: 'OTHER',
          comparison_id: 'c1',
          block_id: 'b',
          sample_id: 's',
          execution_attempt_id: 'a1',
        },
      },
      {
        runId: 'r2',
        identity: {
          campaign_id: CAMPAIGN_ID,
          comparison_id: 'c1',
          block_id: 'b',
          sample_id: 's',
          execution_attempt_id: 'aX',
        },
      },
    ],
    events,
    campaignId: CAMPAIGN_ID,
  });
  expect(actions).toEqual([
    {
      type: 'quarantined',
      payload: { run_id: 'r1', attempt_id: 'a1', reason: 'campaign_mismatch' },
    },
    // aX is no journaled attempt of this campaign: nothing to attribute it to.
    { type: 'quarantined', payload: { run_id: 'r2', reason: 'late_terminal' } },
  ]);
});

test('readRunDirIdentities: absent identity files are skipped; a MALFORMED one is loud, never silently dropped', () => {
  const root = mkdtempSync(join(tmpdir(), 'results-'));
  mkdirSync(join(root, 'run-a'), { recursive: true });
  writeFileSync(
    join(root, 'run-a', 'campaign-identity.json'),
    JSON.stringify({
      campaign_id: CAMPAIGN_ID,
      comparison_id: 'c1',
      block_id: 'b1',
      sample_id: 's1',
      execution_attempt_id: 'a1',
    }),
  );
  mkdirSync(join(root, 'run-b'), { recursive: true }); // no identity file: not campaign evidence
  mkdirSync(join(root, 'run-c'), { recursive: true });
  writeFileSync(join(root, 'run-c', 'campaign-identity.json'), '{not json');
  // A PARTIAL identity (sample_id missing) is not an identity: an incomplete
  // shape cannot be correlated against the journal, so it is malformed too.
  mkdirSync(join(root, 'run-d'), { recursive: true });
  writeFileSync(
    join(root, 'run-d', 'campaign-identity.json'),
    JSON.stringify({
      campaign_id: CAMPAIGN_ID,
      comparison_id: 'c1',
      block_id: 'b1',
      execution_attempt_id: 'a1',
    }),
  );
  const scan = readRunDirIdentities(root);
  expect(scan.identities).toHaveLength(1);
  expect(scan.identities[0]!.runId).toBe('run-a');
  expect(scan.identities[0]!.identity.execution_attempt_id).toBe('a1');
  expect(scan.malformed.map((m) => m.runId)).toEqual(['run-c', 'run-d']);
  const missing = readRunDirIdentities(join(root, 'missing'));
  expect(missing.identities).toEqual([]);
  expect(missing.malformed).toEqual([]);

  // Loud: unclassifiable evidence is quarantined, never dropped.
  const loud: string[] = [];
  const actions = quarantineActions({
    runDirIdentities: scan.identities,
    malformed: scan.malformed,
    events: [],
    campaignId: CAMPAIGN_ID,
    stream: { write: (s) => loud.push(s) },
  });
  expect(actions).toContainEqual({
    type: 'quarantined',
    payload: { run_id: 'run-c', reason: 'campaign_mismatch' },
  });
  expect(loud.join('')).toMatch(/run-c/);
});

test('the spawn-to-run_allocated orphan window resolves by attempt-id correlation against the journal chain (R-RCV-4)', () => {
  const campaignId = CAMPAIGN_ID;
  const root = mkdtempSync(join(tmpdir(), 'results-'));
  const identity = (runId: string, attemptId: string) => {
    mkdirSync(join(root, runId), { recursive: true });
    writeFileSync(
      join(root, runId, 'campaign-identity.json'),
      JSON.stringify({
        campaign_id: campaignId,
        comparison_id: 'c1',
        block_id: 'b1',
        sample_id: 's1',
        execution_attempt_id: attemptId,
      }),
    );
  };
  identity('run-orphan', 'a2'); // journaled attempt, allocation never landed
  identity('run-mismatch', 'a-old'); // the journal binds this run to another attempt
  SEQ = 0;
  const events = [
    ev('block_admitted', { block_id: 'b1', pools: ['p'] }),
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a2' }),
    ev('attempt_created', { sample_id: 's2', attempt_id: 'a-new' }),
    ev('run_allocated', {
      attempt_id: 'a-new',
      run_id: 'run-mismatch',
      pgid: 7,
      key_grants: [],
    }),
  ];
  const actions = quarantineActions({
    runDirIdentities: readRunDirIdentities(root).identities,
    events,
    campaignId,
  });
  // Scan order is the results root's directory order.
  expect(actions).toEqual([
    {
      type: 'quarantined',
      payload: {
        run_id: 'run-mismatch',
        attempt_id: 'a-new',
        reason: 'attempt_mismatch',
      },
    },
    // The residual R-RCV-4 window: attempt journaled, run dir written, the
    // dispatcher died before run_allocated.
    {
      type: 'quarantined',
      payload: {
        run_id: 'run-orphan',
        attempt_id: 'a2',
        reason: 'attempt_mismatch',
      },
    },
  ]);
});

test('a superseded-era run dir is a LATE terminal: its evidence never retires the re-entered attempt (R-RCV-3)', () => {
  const universe: CampaignUniverse = {
    samples: [
      { sample_id: 's1', arm: 'base', cell: 'c1:scn' },
      { sample_id: 's2', arm: 'treat', cell: 'c1:scn' },
    ],
    blocks: [{ block_id: 'c1:scn:b1', sample_ids: ['s1', 's2'] }],
  };
  SEQ = 0;
  const events = [
    ev('block_admitted', { block_id: 'c1:scn:b1', pools: ['p'] }),
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a1' }),
    ev('run_allocated', {
      attempt_id: 'a1',
      run_id: 'r1',
      pgid: 111,
      key_grants: [],
    }),
    ev('aborted', { block_id: 'c1:scn:b1' }),
    ev('block_replaced', {
      block_id: 'c1:scn:b1',
      replacement_block_id: 'c1:scn:b1:i1',
      reason: 'dispatcher_restart',
      kind: 'rerun',
      reserve_activation: false,
      roster: [
        { sample_id: 's1', arm: 'base' },
        { sample_id: 's2', arm: 'treat' },
      ],
    }),
    ev('block_admitted', {
      block_id: 'c1:scn:b1:i1',
      pools: ['p'],
      rerun_of: 'c1:scn:b1',
    }),
    ev('attempt_created', { sample_id: 's1', attempt_id: 'a2' }), // the current attempt
  ];
  expect(() => replayEvents(universe, events)).not.toThrow();
  const actions = quarantineActions({
    runDirIdentities: [
      {
        runId: 'r1',
        identity: {
          campaign_id: CAMPAIGN_ID,
          comparison_id: 'c1',
          block_id: 'c1:scn:b1',
          sample_id: 's1',
          execution_attempt_id: 'a1',
        },
      },
    ],
    events,
    campaignId: CAMPAIGN_ID,
  });
  expect(actions).toEqual([
    {
      type: 'quarantined',
      payload: { run_id: 'r1', attempt_id: 'a1', reason: 'late_terminal' },
    },
  ]);
});

// ---------------------------------------------------------------------------
// Interrupted closed-window contention batches (ratified OQ-11)
// ---------------------------------------------------------------------------

function campaignDoc(overrides: Record<string, unknown> = {}): Campaign {
  return {
    schema_version: 1,
    campaign_id: CAMPAIGN_ID,
    suite: {
      schema_version: 1,
      name: 'testsuite',
      kind: 'gating',
      budget_usd: 50,
      profile: 'release_gate_v1',
      reserve: 1,
      max_exposure_skew: 60,
      profile_params: {
        alpha: 0.05,
        determinate_n_floor: 1,
        completion_divergence_max: 0.5,
        mde_by_scenario: {},
      },
      comparisons: [
        { baseline: 'arm_a', treatment: 'arm_b', scenarios: ['scn'], n: 1 },
      ],
    },
    refs: {
      superpowers_by_arm: { arm_a: null, arm_b: null },
      evals: 'e'.repeat(40),
      gauntlet: '9'.repeat(40),
    },
    grader: { credential: 'grader_cred', model: 'grader-model' },
    cells: [
      {
        scenario: 'scn',
        comparison_id: 'c1',
        arms: ['arm_a', 'arm_b'],
        n: 1,
        class: 'confirmatory',
        coupling: 'arm-independent',
        estimates_by_arm: {
          arm_a: { duration_s: 100, cost_usd: 1, confidence: 'high' },
          arm_b: { duration_s: 200, cost_usd: 2, confidence: 'high' },
        },
      },
    ],
    excluded_cells: [],
    samples: [
      {
        sample_id: 'c1:scn:arm_a:r1',
        cell: 'c1:scn',
        arm: 'arm_a',
        replicate: 1,
      },
      {
        sample_id: 'c1:scn:arm_b:r1',
        cell: 'c1:scn',
        arm: 'arm_b',
        replicate: 1,
      },
      {
        sample_id: 'c1:scn:arm_a:x1',
        cell: 'c1:scn',
        arm: 'arm_a',
        replicate: 1,
      },
      {
        sample_id: 'c1:scn:arm_b:x1',
        cell: 'c1:scn',
        arm: 'arm_b',
        replicate: 1,
      },
    ],
    comparisons: [
      { comparison_id: 'c1', baseline: 'arm_a', treatment: 'arm_b' },
    ],
    blocks: [
      {
        block_id: 'c1:scn:b1',
        comparison_id: 'c1',
        sample_ids: ['c1:scn:arm_a:r1', 'c1:scn:arm_b:r1'],
      },
      {
        block_id: 'c1:scn:x1',
        comparison_id: 'c1',
        sample_ids: ['c1:scn:arm_a:x1', 'c1:scn:arm_b:x1'],
        slot: 'reserve',
      },
    ],
    budget: {
      usd_all_in: 50,
      surcharge_applied: 0,
      priced_coverage: 1,
      surcharge_formula_version: 1,
    },
    registered_at: '2026-08-26T00:00:00Z',
    registered_by: 'test',
    digest: 'c'.repeat(64),
    contention: {
      host_fingerprint: {
        cpu_model: 'test',
        cpu_cores: 4,
        mem_bytes: 16 * 2 ** 30,
        disk_total_bytes: 100 * 2 ** 30,
      },
      global_run_cap: 2,
      thresholds: [
        { metric: 'load1_per_core', source: 'host', op: 'gt', value: 2 },
      ],
      cadence_ms: 10_000,
      sustain_k: 3,
      coverage_n: 4,
      mem_tolerance_pct: 10,
      disk_tolerance_pct: 10,
    },
    execution_surface: [
      {
        name: 'arm_a',
        agent: 'claude',
        credential: 'cred_a',
        auth: 'api-key',
        api: 'anthropic',
        model: 'm',
        key_env_names: ['KEY_A'],
      },
      {
        name: 'arm_b',
        agent: 'claude',
        credential: 'cred_b',
        auth: 'api-key',
        api: 'anthropic',
        model: 'm',
        key_env_names: ['KEY_B'],
      },
    ],
    ...overrides,
    // Fixture-literal cast, justified: this is a full valid document already
    // exercised against CampaignSchema in the task 5 registration tests; the
    // cast only bridges the untyped `overrides` spread.
  } as unknown as Campaign;
}

function sample(ts_ms: number, load1: number): SidecarLine {
  return {
    ts_ms,
    load1,
    mem_available_bytes: 8 * 2 ** 30,
    swap_used_bytes: 0,
    process_count: 100,
    disk_free_bytes: 90 * 2 ** 30,
    breach: [],
  };
}
function everyHalfSecond(from: number, to: number): number[] {
  const out: number[] = [];
  for (let t = from; t <= to; t += 500) out.push(t);
  return out;
}
/** load1 9 over 4 cores breaches `load1_per_core > 2`; sustain_k = 3, so the
 *  window opens at the third crossing (2500) and CLOSES at 17500 (three
 *  consecutive in-bounds samples). Every executed block below sits inside
 *  it. */
const CLOSED_WINDOW_SIDECAR: SidecarLine[] = [
  ...everyHalfSecond(1500, 16_000).map((t) => sample(t, 9)),
  ...everyHalfSecond(16_500, 18_000).map((t) => sample(t, 0)),
];
/** The same breach still OPEN at the crash: no closure, so no resolution. */
const OPEN_WINDOW_SIDECAR: SidecarLine[] = [
  ...[1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000].map((t) => sample(t, 9)),
];

function contentionEvents(): JournalEvent[] {
  SEQ = 0; // ts_ms = seq * 1000: the block interval lands inside the breach
  return [
    ev('campaign_opened', { campaign_id: CAMPAIGN_ID, digest: 'c'.repeat(64) }),
    ev('block_admitted', { block_id: 'c1:scn:b1', pools: ['p'] }),
    ev('attempt_created', {
      sample_id: 'c1:scn:arm_a:r1',
      attempt_id: 'a1',
    }),
    ev('attempt_created', {
      sample_id: 'c1:scn:arm_b:r1',
      attempt_id: 'a2',
    }),
    ev('run_allocated', {
      attempt_id: 'a1',
      run_id: 'r1',
      pgid: 11,
      key_grants: [],
    }),
    ev('run_allocated', {
      attempt_id: 'a2',
      run_id: 'r2',
      pgid: 22,
      key_grants: [],
    }),
    ev('exposure_started', { sample_id: 'c1:scn:arm_a:r1', ts: 7000 }),
    ev('exposure_started', { sample_id: 'c1:scn:arm_b:r1', ts: 8000 }),
    ev('run_completed', { attempt_id: 'a1', outcome: 'pass' }),
    ev('run_completed', { attempt_id: 'a2', outcome: 'pass' }),
  ];
}

const CONTENTION_MINT: EventInput = {
  type: 'block_replaced',
  payload: {
    block_id: 'c1:scn:b1',
    replacement_block_id: 'c1:scn:x1',
    reason: 'contention',
    kind: 'replacement',
    reserve_activation: true,
    roster: [
      {
        sample_id: 'c1:scn:arm_a:x1',
        arm: 'arm_a',
        supersedes: 'c1:scn:arm_a:r1',
      },
      {
        sample_id: 'c1:scn:arm_b:x1',
        arm: 'arm_b',
        supersedes: 'c1:scn:arm_b:r1',
      },
    ],
  },
};

test('rederiveContentionSuffix: the missing suffix of a CLOSED window is re-derived from the durable sidecar in the frozen obligation order', () => {
  const events = contentionEvents();
  expect(() => replayEvents(universeOfDoc(), events)).not.toThrow();
  const batch = rederiveContentionSuffix({
    events,
    sidecarLines: CLOSED_WINDOW_SIDECAR,
    truncatedTail: false,
    campaign: campaignDoc(),
  });
  expect(batch).toEqual([
    CONTENTION_MINT,
    {
      type: 'sample_disposition',
      payload: {
        sample_id: 'c1:scn:arm_a:r1',
        disposition: 'excluded_block_replaced',
        superseded_by: 'c1:scn:arm_a:x1',
      },
    },
    {
      type: 'sample_disposition',
      payload: {
        sample_id: 'c1:scn:arm_b:r1',
        disposition: 'excluded_block_replaced',
        superseded_by: 'c1:scn:arm_b:x1',
      },
    },
  ]);
});

function universeOfDoc(): CampaignUniverse {
  const doc = campaignDoc();
  return {
    samples: doc.samples.map((s) => ({
      sample_id: s.sample_id,
      arm: s.arm,
      cell: s.cell,
    })),
    blocks: doc.blocks.map((b) => ({
      block_id: b.block_id,
      sample_ids: b.sample_ids,
      ...(b.slot !== undefined ? { slot: b.slot } : {}),
    })),
  };
}

test('rederiveContentionSuffix: a breach still OPEN at the crash mints nothing — an unclosed window is D4 backstop work, never an immediate reserve activation', () => {
  expect(
    rederiveContentionSuffix({
      events: contentionEvents(),
      sidecarLines: OPEN_WINDOW_SIDECAR,
      truncatedTail: false,
      campaign: campaignDoc(),
    }),
  ).toEqual([]);
});

test('rederiveContentionSuffix: a landed contention mint is authoritative (never re-minted); a durable budget stop suppresses the obligation instead', () => {
  const landed = [
    ...contentionEvents(),
    ev('block_replaced', CONTENTION_MINT.payload),
  ];
  expect(
    rederiveContentionSuffix({
      events: landed,
      sidecarLines: CLOSED_WINDOW_SIDECAR,
      truncatedTail: false,
      campaign: campaignDoc(),
    }),
  ).toEqual([]);

  const stopped = [
    ...contentionEvents(),
    ev('budget_stopped', { sample_ids: [] }),
  ];
  expect(
    rederiveContentionSuffix({
      events: stopped,
      sidecarLines: CLOSED_WINDOW_SIDECAR,
      truncatedTail: false,
      campaign: campaignDoc(),
    }),
  ).toEqual([
    {
      type: 'adjudication',
      payload: {
        cell: 'c1:scn',
        disposition: 'replacement_suppressed',
        rationale: 'budget_stopped',
      },
    },
  ]);
});

test('rederiveContentionSuffix: a budget raise after the stop lifts the durable suppression — only the stopped samples are permanent (E7.6/R-DSP-6)', () => {
  const raised = [
    ...contentionEvents(),
    ev('budget_stopped', { sample_ids: [] }),
    ev('amendment', { kind: 'budget_raise', amount_usd: 100, ts: 1 }),
  ];
  expect(
    rederiveContentionSuffix({
      events: raised,
      sidecarLines: CLOSED_WINDOW_SIDECAR,
      truncatedTail: false,
      campaign: campaignDoc(),
    })[0],
  ).toEqual(CONTENTION_MINT);
});

test('rederiveContentionSuffix: landed resolutions that are not a PREFIX of the obligation order refuse — recovery never fills an interior hole', () => {
  // Two invalid blocks in the cell; only the SECOND carries a landed mint.
  const twoBlocks = campaignDoc({
    samples: [
      ...campaignDoc().samples,
      {
        sample_id: 'c1:scn:arm_a:r2',
        cell: 'c1:scn',
        arm: 'arm_a',
        replicate: 2,
      },
      {
        sample_id: 'c1:scn:arm_b:r2',
        cell: 'c1:scn',
        arm: 'arm_b',
        replicate: 2,
      },
    ],
    blocks: [
      ...campaignDoc().blocks,
      {
        block_id: 'c1:scn:b2',
        comparison_id: 'c1',
        sample_ids: ['c1:scn:arm_a:r2', 'c1:scn:arm_b:r2'],
      },
    ],
  });
  const events = [
    ...contentionEvents(),
    ev('block_admitted', { block_id: 'c1:scn:b2', pools: ['p'] }),
    ev('attempt_created', {
      sample_id: 'c1:scn:arm_a:r2',
      attempt_id: 'a3',
    }),
    ev('run_allocated', {
      attempt_id: 'a3',
      run_id: 'r3',
      pgid: 33,
      key_grants: [],
    }),
    ev('exposure_started', { sample_id: 'c1:scn:arm_a:r2', ts: 12_000 }),
    ev('run_completed', { attempt_id: 'a3', outcome: 'pass' }),
    // The LATER obligation resolved while the earlier one did not: no append
    // order produces this, so the journal is not a batch prefix.
    ev('block_replaced', {
      block_id: 'c1:scn:b2',
      replacement_block_id: 'c1:scn:x1',
      reason: 'contention',
      kind: 'replacement',
      reserve_activation: true,
      roster: [
        {
          sample_id: 'c1:scn:arm_a:x1',
          arm: 'arm_a',
          supersedes: 'c1:scn:arm_a:r2',
        },
        {
          sample_id: 'c1:scn:arm_b:x1',
          arm: 'arm_b',
          supersedes: 'c1:scn:arm_b:r2',
        },
      ],
    }),
  ];
  expect(() =>
    rederiveContentionSuffix({
      events,
      sidecarLines: CLOSED_WINDOW_SIDECAR,
      truncatedTail: false,
      campaign: twoBlocks,
    }),
  ).toThrow(RecoveryError);
});
