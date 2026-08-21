// test/campaign-estimates.test.ts
import { expect, test } from 'bun:test';
import {
  buildEstimates,
  type EstimateInput,
  lookupEstimate,
  serializeEstimates,
} from '../src/campaign/estimates.ts';
import type { ReplayRecord } from '../src/contracts/replay.ts';

function rec(over: Partial<ReplayRecord>): ReplayRecord {
  return {
    run_id: 'r',
    scenario: 'sdd-escalates',
    agent: 'claude',
    credential: 'opus_bedrock',
    os: 'linux',
    pool_id: 'p',
    arm: 'baseline',
    wall_ms: 600_000,
    coding_ms: 500_000,
    gauntlet_ms: 660_000,
    pre_exposure_ms: 30_000,
    cost_subject_usd: 1.0,
    cost_grader_usd: 0.1,
    cost_total_usd: 1.1,
    ...over,
  };
}

function input(
  record: ReplayRecord,
  finished_at = '2026-08-08T01:00:00.000Z',
): EstimateInput {
  return { record, finished_at };
}

test('medians: odd n picks middle, even n averages two middles', () => {
  const inputs = [
    input(rec({ run_id: 'a', wall_ms: 100_000 })),
    input(rec({ run_id: 'b', wall_ms: 200_000 })),
    input(rec({ run_id: 'c', wall_ms: 300_000 })),
    input(rec({ run_id: 'd', wall_ms: 400_000 })),
  ];
  const art = buildEstimates(inputs, { sources: ['fixture'] });
  expect(art.entries).toHaveLength(1);
  expect(art.entries[0]!.duration_s_median).toBe(250); // (200+300)/2, in s
  expect(art.entries[0]!.duration_n).toBe(4);
  expect(art.entries[0]!.confidence).toBe('medium'); // 3..7
  expect(art.entries[0]!.priced_n).toBe(4);
});

test('cost medians skip nulls; priced_n=0 yields null cost, not 0', () => {
  const inputs = [
    input(
      rec({
        run_id: 'a',
        cost_total_usd: null,
        cost_subject_usd: null,
        cost_grader_usd: null,
      }),
    ),
    input(rec({ run_id: 'b', cost_total_usd: 2.0 })),
  ];
  const art = buildEstimates(inputs, { sources: ['fixture'] });
  expect(art.entries[0]!.priced_n).toBe(1);
  expect(art.entries[0]!.cost_total_usd_median).toBe(2.0);
  const onlyNull = buildEstimates(
    [input(rec({ run_id: 'a', cost_total_usd: null }))],
    { sources: ['fixture'] },
  );
  expect(onlyNull.entries[0]!.cost_total_usd_median).toBeNull();
});

test('fallback chain: credential-specific, then scenario_agent, scenario, corpus', () => {
  const inputs = [
    // 8 runs for claude/opus_bedrock (high-confidence tier-1)
    ...Array.from({ length: 8 }, (_, i) =>
      input(rec({ run_id: `ob${i}`, wall_ms: 600_000 + i * 1000 })),
    ),
    // 1 run for claude/opus5_bedrock (low-confidence tier-1)
    input(
      rec({ run_id: 'o5', credential: 'opus5_bedrock', wall_ms: 3_000_000 }),
    ),
    // 1 run for codex on another scenario
    input(
      rec({
        run_id: 'cx',
        scenario: 'other-scenario',
        agent: 'codex',
        credential: 'openai_responses_56sol',
        wall_ms: 900_000,
      }),
    ),
  ];
  const art = buildEstimates(inputs, { sources: ['fixture'] });

  const direct = lookupEstimate(art, {
    scenario: 'sdd-escalates',
    agent: 'claude',
    credential: 'opus_bedrock',
    os: 'linux',
  });
  expect(direct.tier).toBe('scenario_agent_credential_os');
  expect(direct.confidence).toBe('high');
  expect(direct.duration_s).toBe(603.5);

  const lowConf = lookupEstimate(art, {
    scenario: 'sdd-escalates',
    agent: 'claude',
    credential: 'opus5_bedrock',
    os: 'linux',
  });
  expect(lowConf.tier).toBe('scenario_agent_credential_os');
  expect(lowConf.confidence).toBe('low');

  // Unknown credential on a known scenario×agent falls to scenario_agent.
  const sa = lookupEstimate(art, {
    scenario: 'sdd-escalates',
    agent: 'claude',
    credential: 'never_seen',
    os: 'linux',
  });
  expect(sa.tier).toBe('scenario_agent');
  // Resolve the entry by identity, not array index: fallback tiers are
  // sorted by key, so other-scenario/codex sorts before sdd-escalates/claude.
  expect(sa.duration_s).toBe(
    art.fallbacks.scenario_agent.find(
      (e) => e.scenario === 'sdd-escalates' && e.agent === 'claude',
    )!.duration_s_median,
  );

  // Unknown agent on a known scenario falls to scenario.
  const sc = lookupEstimate(art, {
    scenario: 'sdd-escalates',
    agent: 'gemini',
    credential: 'x',
    os: 'linux',
  });
  expect(sc.tier).toBe('scenario');

  // Unknown scenario falls to corpus.
  const co = lookupEstimate(art, {
    scenario: 'nope',
    agent: 'gemini',
    credential: 'x',
    os: 'linux',
  });
  expect(co.tier).toBe('corpus');
  expect(co.duration_s).toBe(art.fallbacks.corpus_median.duration_s);
});

test('duplicate run_id: first input wins, duplicates excluded from stats', () => {
  const dup = rec({ run_id: 'a', wall_ms: 100_000 });
  const art = buildEstimates(
    [input(dup), input(rec({ run_id: 'a', wall_ms: 9_000_000 }))],
    { sources: ['fixture'] },
  );
  expect(art.entries[0]!.duration_n).toBe(1);
  expect(art.entries[0]!.duration_s_median).toBe(100);
  expect(art.corpus.run_count).toBe(1);
});

test('generated_at is max finished_at; serialization is byte-stable', () => {
  const inputs = [
    input(rec({ run_id: 'a' }), '2026-08-08T01:00:00.000Z'),
    input(rec({ run_id: 'b' }), '2026-08-09T02:00:00.000Z'),
  ];
  const a1 = buildEstimates(inputs, { sources: ['fixture'] });
  const a2 = buildEstimates(inputs, { sources: ['fixture'] });
  expect(a1.generated_at).toBe('2026-08-09T02:00:00.000Z');
  expect(serializeEstimates(a1)).toBe(serializeEstimates(a2));
  expect(serializeEstimates(a1).endsWith('\n')).toBe(true);
});
