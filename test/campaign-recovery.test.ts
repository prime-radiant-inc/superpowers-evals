import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SidecarLine } from '../src/campaign/contention.ts';
import {
  killJournaledPgids,
  planRecovery,
  quarantineActions,
  readRunDirIdentities,
  rederiveContentionSuffix,
  terminalEvidenceActions,
} from '../src/campaign/recovery.ts';
import type { Campaign } from '../src/contracts/campaign/campaign.ts';
import type { CampaignUniverse } from '../src/contracts/campaign/crash-windows.ts';
import type { JournalEvent } from '../src/contracts/campaign/journal-events.ts';

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

test('killJournaledPgids: kills every journaled pgid without a terminal; identity-guarded', () => {
  const events = [
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
  const killed: number[] = [];
  const report = killJournaledPgids({
    events,
    inspectGroup: () => 'ok',
    kill: (pgid) => killed.push(pgid),
  });
  expect(report.killed).toEqual([111]); // only the non-terminal attempt
  expect(killed).toEqual([111]);
  // A failed sanity check: recorded reclaimed-without-kill, never signaled.
  const loud: string[] = [];
  const guarded = killJournaledPgids({
    events,
    inspectGroup: (pgid) => (pgid === 111 ? 'failed' : 'ok'),
    kill: (pgid) => killed.push(pgid),
    stream: { write: (s) => loud.push(s) },
  });
  expect(guarded.reclaimedWithoutKill).toEqual([111]);
  expect(loud.join('')).toMatch(/reclaimed-without-kill/);
});

test('planRecovery: superseded predecessor gets no action; missing dispositions completed; minted successor re-admitted as itself', () => {
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
});

test('planRecovery: a pre-run_allocated crash window voids the attempt and re-admits its block (R-RCV-5 second resolution)', () => {
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

test('terminal-evidence rule: a complete verdict journals terminal; a missing run dir re-enters via rerun', () => {
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
  const withVerdict = terminalEvidenceActions({
    events,
    verdictOf: (runId) => (runId === 'r1' ? { final: 'pass' } : null),
  });
  expect(withVerdict.terminals).toEqual([
    { type: 'run_completed', payload: { attempt_id: 'a1', outcome: 'pass' } },
  ]);
  const withoutRunDir = terminalEvidenceActions({
    events,
    verdictOf: () => null,
  });
  expect(withoutRunDir.terminals).toEqual([]);
  expect(withoutRunDir.rerunBlockIds).toEqual(['b1']);
});

test('crash-cut in-flight mapping resolves against the ADMITTED INSTANCE CHAIN — primary, reserve, and rerun instances each rerun under their own id (C11)', () => {
  // The cut: three instances are admitted BEFORE their in-flight attempts are
  // created, so "the most recently admitted block" attributes every attempt to
  // the last instance admitted. Only lineage-aware attribution (universe
  // blocks UNION mint rosters, latest admission at or before the attempt)
  // reruns each instance under its own id.
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
    ev('block_admitted', { block_id: 'x2', pools: ['p'] }),
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
  const actions = terminalEvidenceActions({
    events,
    universe,
    verdictOf: () => null, // no run dirs survived the crash
  });
  expect(actions.rerunBlockIds).toEqual(['b1', 'x2', 'b3:i1']);
});

test('quarantine by attempt-id / campaign mismatch from the persisted identity', () => {
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
          campaign_id: 'c'.repeat(64),
          comparison_id: 'c1',
          block_id: 'b',
          sample_id: 's',
          execution_attempt_id: 'aX',
        },
      },
    ],
    events,
    campaignId: 'c'.repeat(64),
  });
  expect(actions).toEqual([
    {
      type: 'quarantined',
      payload: { run_id: 'r1', attempt_id: 'a1', reason: 'campaign_mismatch' },
    },
    { type: 'quarantined', payload: { run_id: 'r2', reason: 'late_terminal' } },
  ]);
});
test('readRunDirIdentities: scans run dirs for persisted identities; non-campaign dirs are skipped', () => {
  const root = mkdtempSync(join(tmpdir(), 'results-'));
  mkdirSync(join(root, 'run-a'), { recursive: true });
  writeFileSync(
    join(root, 'run-a', 'campaign-identity.json'),
    JSON.stringify({
      campaign_id: 'c'.repeat(64),
      comparison_id: 'c1',
      block_id: 'b1',
      sample_id: 's1',
      execution_attempt_id: 'a1',
    }),
  );
  mkdirSync(join(root, 'run-b'), { recursive: true }); // no identity file: not campaign evidence
  const found = readRunDirIdentities(root);
  expect(found).toHaveLength(1);
  expect(found[0]!.runId).toBe('run-a');
  expect(found[0]!.identity.execution_attempt_id).toBe('a1');
  expect(readRunDirIdentities(join(root, 'missing'))).toEqual([]);
});

test('the run-dir identity sweep is the residual evidence a pgid list cannot hold: a run allocated but never journaled quarantines by attempt-id mismatch (R-RCV-3/R-RCV-4)', () => {
  const campaignId = 'c'.repeat(64);
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
  identity('run-mismatch', 'a-old'); // the run dir names a SUPERSEDED attempt
  identity('run-unjournaled', 'a2'); // 8b suppressed its run_allocated
  const events = [
    ev('run_allocated', {
      attempt_id: 'a-new',
      run_id: 'run-mismatch',
      pgid: 7,
      key_grants: [],
    }),
  ];
  const actions = quarantineActions({
    runDirIdentities: readRunDirIdentities(root),
    events,
    campaignId,
  });
  expect(actions).toEqual([
    {
      type: 'quarantined',
      payload: {
        run_id: 'run-mismatch',
        attempt_id: 'a-new',
        reason: 'attempt_mismatch',
      },
    },
    {
      type: 'quarantined',
      payload: { run_id: 'run-unjournaled', reason: 'late_terminal' },
    },
  ]);
});

// ---------------------------------------------------------------------------
// Interrupted closed-window contention batches (ratified OQ-11)
// ---------------------------------------------------------------------------

function campaignDoc(overrides: Record<string, unknown> = {}): Campaign {
  return {
    schema_version: 1,
    campaign_id: 'c'.repeat(64),
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

/** Every sample breaches (load1 9 over 4 cores > 2), so one window opens at
 *  the third crossing and stays open to the horizon. */
function breachingSidecar(tsList: readonly number[]): SidecarLine[] {
  return tsList.map((ts_ms) => ({
    ts_ms,
    load1: 9,
    mem_available_bytes: 8 * 2 ** 30,
    swap_used_bytes: 0,
    process_count: 100,
    disk_free_bytes: 90 * 2 ** 30,
    breach: [],
  }));
}

function contentionEvents(): JournalEvent[] {
  SEQ = 0; // ts_ms = seq * 1000: the block interval lands inside the breach
  return [
    ev('campaign_opened', {
      campaign_id: 'c'.repeat(64),
      digest: 'c'.repeat(64),
    }),
    ev('block_admitted', { block_id: 'c1:scn:b1', pools: ['p'] }),
    ev('attempt_created', { sample_id: 'c1:scn:arm_a:r1', attempt_id: 'a1' }),
    ev('attempt_created', { sample_id: 'c1:scn:arm_b:r1', attempt_id: 'a2' }),
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

const CONTENTION_SIDECAR = breachingSidecar([
  1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500, 6000, 6500,
]);

test('rederiveContentionSuffix: the missing suffix is re-derived from the durable sidecar in the frozen obligation order', () => {
  const batch = rederiveContentionSuffix({
    events: contentionEvents(),
    sidecarLines: CONTENTION_SIDECAR,
    truncatedTail: false,
    campaign: campaignDoc(),
  });
  expect(batch).toEqual([
    {
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
    },
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

test('rederiveContentionSuffix: a landed contention mint is authoritative (never re-minted); a durable budget stop suppresses the obligation instead', () => {
  const landed = [
    ...contentionEvents(),
    ev('block_replaced', {
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
    }),
  ];
  expect(
    rederiveContentionSuffix({
      events: landed,
      sidecarLines: CONTENTION_SIDECAR,
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
      sidecarLines: CONTENTION_SIDECAR,
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
