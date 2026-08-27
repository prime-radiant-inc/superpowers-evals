// test/campaign-estimates.test.ts
import { expect, test } from 'bun:test';
import {
  buildEstimates,
  type EstimateInput,
  lookupEstimate,
  serializeEstimates,
} from '../src/campaign/estimates.ts';
import { EstimatesArtifactSchema } from '../src/contracts/estimates.ts';
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

test('duplicate run_id: first input wins, duplicates excluded from stats and counted', () => {
  const dup = rec({ run_id: 'a', wall_ms: 100_000 });
  const art = buildEstimates(
    [
      input(dup),
      input(rec({ run_id: 'a', wall_ms: 9_000_000 })),
      input(rec({ run_id: 'a', wall_ms: 5_000_000 })),
    ],
    { sources: ['fixture'] },
  );
  expect(art.entries[0]!.duration_n).toBe(1);
  expect(art.entries[0]!.duration_s_median).toBe(100);
  expect(art.corpus.run_count).toBe(1);
  // Merge rule "counts recorded": the artifact names how many duplicate
  // inputs were deduped away — never silently.
  expect(art.corpus.duplicates_excluded).toBe(2);
  // And the field survives the pinned serialization round-trip.
  expect(
    EstimatesArtifactSchema.parse(JSON.parse(serializeEstimates(art))).corpus
      .duplicates_excluded,
  ).toBe(2);
});

test('grouping is collision-safe across field boundaries', () => {
  // 'ab'+'c' and 'a'+'bc' pack to the same string under naive
  // concatenation; structural grouping must keep them distinct.
  const inputs = [
    input(rec({ run_id: 'p', scenario: 'ab', agent: 'c', wall_ms: 100_000 })),
    input(rec({ run_id: 'q', scenario: 'a', agent: 'bc', wall_ms: 300_000 })),
  ];
  const art = buildEstimates(inputs, { sources: ['fixture'] });
  expect(art.entries).toHaveLength(2);
  const ab = art.entries.find((e) => e.scenario === 'ab' && e.agent === 'c')!;
  const a = art.entries.find((e) => e.scenario === 'a' && e.agent === 'bc')!;
  expect(ab.duration_s_median).toBe(100);
  expect(a.duration_s_median).toBe(300);
  expect(art.fallbacks.scenario_agent).toHaveLength(2);
  const saAb = art.fallbacks.scenario_agent.find(
    (e) => e.scenario === 'ab' && e.agent === 'c',
  )!;
  expect(saAb.duration_s_median).toBe(100);
  // Fieldwise sort: at the scenario field, 'a' sorts before 'ab'.
  expect(art.entries[0]!.scenario).toBe('a');
});

test('NUL bytes in field values never corrupt grouping or fields', () => {
  const inputs = [
    input(rec({ run_id: 'n1', scenario: 'weird\u0000sc', wall_ms: 100_000 })),
    input(rec({ run_id: 'n2', scenario: 'weird\u0000sc', wall_ms: 300_000 })),
    input(
      rec({
        run_id: 'n3',
        scenario: 'weird',
        credential: 'sc\u0000x',
        wall_ms: 500_000,
      }),
    ),
  ];
  const art = buildEstimates(inputs, { sources: ['fixture'] });
  // Two entries: the NUL-scenario pair grouped together, plus the
  // NUL-credential single.
  expect(art.entries).toHaveLength(2);
  const nulScenario = art.entries.find((e) => e.scenario === 'weird\u0000sc')!;
  expect(nulScenario.agent).toBe('claude');
  expect(nulScenario.duration_n).toBe(2);
  expect(nulScenario.duration_s_median).toBe(200);
  const nulCredential = art.entries.find((e) => e.credential === 'sc\u0000x')!;
  expect(nulCredential.scenario).toBe('weird');
  expect(nulCredential.duration_s_median).toBe(500);
  // scenario_agent tier equally intact.
  expect(art.fallbacks.scenario_agent).toHaveLength(2);
  const sa = art.fallbacks.scenario_agent.find(
    (e) => e.scenario === 'weird\u0000sc',
  )!;
  expect(sa.agent).toBe('claude');
  expect(sa.duration_s_median).toBe(200);
  // NUL survives pinned serialization (JSON escape) and schema parse.
  const back = EstimatesArtifactSchema.parse(
    JSON.parse(serializeEstimates(art)),
  );
  expect(
    back.entries.find((e) => e.scenario === 'weird\u0000sc')?.duration_s_median,
  ).toBe(200);
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

test('tokens_total_median: median over observed sidecar volumes at every tier; absent when unobserved', () => {
  const inputs: EstimateInput[] = [
    {
      record: rec({ run_id: 't1', wall_ms: 100_000 }),
      finished_at: '2026-08-08T01:00:00.000Z',
      tokens_total: 100_000,
    },
    {
      record: rec({ run_id: 't2', wall_ms: 300_000 }),
      finished_at: '2026-08-08T01:00:00.000Z',
      tokens_total: 300_000,
    },
    {
      record: rec({ run_id: 't3', wall_ms: 500_000 }),
      finished_at: '2026-08-08T01:00:00.000Z',
      tokens_total: null,
    },
  ];
  const art = buildEstimates(inputs, { sources: ['fixture'] });
  // One group at every tier; the median skips the null observation.
  expect(art.entries[0]!.tokens_total_median).toBe(200_000);
  expect(art.fallbacks.scenario_agent[0]!.tokens_total_median).toBe(200_000);
  expect(art.fallbacks.scenario[0]!.tokens_total_median).toBe(200_000);
  expect(art.fallbacks.corpus_median.tokens_total_median).toBe(200_000);

  // Absent when no run observed a volume — the key is omitted, never 0
  // (a zero-volume would price an override at $0).
  const none = buildEstimates(
    [
      {
        record: rec({ run_id: 'n1' }),
        finished_at: '2026-08-08T01:00:00.000Z',
        tokens_total: null,
      },
    ],
    { sources: ['fixture'] },
  );
  expect('tokens_total_median' in none.entries[0]!).toBe(false);
  expect(none.fallbacks.corpus_median.tokens_total_median).toBeUndefined();

  // The optional field survives the pinned serialization + schema parse in
  // both directions (present and absent).
  const back = EstimatesArtifactSchema.parse(
    JSON.parse(serializeEstimates(art)),
  );
  expect(back.entries[0]!.tokens_total_median).toBe(200_000);
  expect(
    EstimatesArtifactSchema.parse(JSON.parse(serializeEstimates(none)))
      .entries[0]!.tokens_total_median,
  ).toBeUndefined();

  // First-wins run_id dedupe applies to the token volume too.
  const dup = buildEstimates(
    [
      {
        record: rec({ run_id: 'd' }),
        finished_at: '2026-08-08T01:00:00.000Z',
        tokens_total: 100,
      },
      {
        record: rec({ run_id: 'd' }),
        finished_at: '2026-08-08T01:00:00.000Z',
        tokens_total: 900,
      },
    ],
    { sources: ['fixture'] },
  );
  expect(dup.entries[0]!.tokens_total_median).toBe(100);
});

test('lookupEstimate surfaces tokens_total_median through the fallback chain', () => {
  const inputs: EstimateInput[] = [
    {
      record: rec({ run_id: 'a', wall_ms: 100_000 }),
      finished_at: '2026-08-08T01:00:00.000Z',
      tokens_total: 111_000,
    },
    {
      record: rec({ run_id: 'b', credential: 'other_cred', wall_ms: 300_000 }),
      finished_at: '2026-08-08T01:00:00.000Z',
      tokens_total: 222_000,
    },
  ];
  const art = buildEstimates(inputs, { sources: ['fixture'] });
  const direct = lookupEstimate(art, {
    scenario: 'sdd-escalates',
    agent: 'claude',
    credential: 'opus_bedrock',
    os: 'linux',
  });
  expect(direct.tokens_total_median).toBe(111_000);
  // Unknown credential on a known scenario×agent: scenario_agent tier.
  const sa = lookupEstimate(art, {
    scenario: 'sdd-escalates',
    agent: 'claude',
    credential: 'never_seen',
    os: 'linux',
  });
  expect(sa.tier).toBe('scenario_agent');
  expect(sa.tokens_total_median).toBe((111_000 + 222_000) / 2);
  // Unknown scenario: corpus tier.
  const corpus = lookupEstimate(art, {
    scenario: 'nope',
    agent: 'gemini',
    credential: 'x',
    os: 'linux',
  });
  expect(corpus.tier).toBe('corpus');
  expect(corpus.tokens_total_median).toBe((111_000 + 222_000) / 2);
});

test('tokens_total_median schema: negative volumes fail artifact parse; fractional medians stay valid', () => {
  // A negative observed volume must not survive artifact parsing — a
  // per-token override would price negative off it.
  const negative = buildEstimates(
    [
      {
        record: rec({ run_id: 'v' }),
        finished_at: '2026-08-08T01:00:00.000Z',
        tokens_total: -100,
      },
    ],
    { sources: ['fixture'] },
  );
  expect(
    EstimatesArtifactSchema.safeParse(JSON.parse(serializeEstimates(negative)))
      .success,
  ).toBe(false);
  // Even-n medians average two integers: fractional values are legitimate.
  const fractional = buildEstimates(
    [
      {
        record: rec({ run_id: 'f1' }),
        finished_at: '2026-08-08T01:00:00.000Z',
        tokens_total: 1,
      },
      {
        record: rec({ run_id: 'f2' }),
        finished_at: '2026-08-08T01:00:00.000Z',
        tokens_total: 2,
      },
    ],
    { sources: ['fixture'] },
  );
  expect(
    EstimatesArtifactSchema.parse(JSON.parse(serializeEstimates(fractional)))
      .entries[0]!.tokens_total_median,
  ).toBe(1.5);
});
