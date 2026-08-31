// test/campaign-contracts-report.test.ts
import { expect, test } from 'bun:test';
import {
  REPORT_RENDERING,
  ReportSchema,
} from '../src/contracts/campaign/report.ts';

function gatingReport(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    campaign_id: 'cmp-0001',
    profile: 'release_gate_v1',
    verdict: 'SHIP',
    cannot_answer: [{ cell: 'scn@c1', mde: 0.12 }],
    comparisons: [
      {
        comparison_id: 'c1',
        cells: [
          {
            scenario: 'scn',
            class: 'confirmatory',
            n: 10,
            delta: 0.02,
            fisher_p: 0.4,
            mde: 0.12,
            pass: 8,
            fail: 2,
            coverage: 0.8,
          },
        ],
        medians: {},
      },
    ],
    accounting: {
      instrument_errors: 1,
      indeterminates: 0,
      replacements: 1,
      reserve_draws: 1,
      skew_exclusions: 0,
      skew_caveats: 0,
      budget_events: 3,
      amendments: 0,
      contention_invalidated: 0,
      unknown_coverage: 0,
      denominators: { scored: 386, planned: 388 },
    },
    provenance: {
      arms: [
        { arm: 'treat_arm', registered_model: 'm', observed_model_set: ['m'] },
      ],
      grader: {
        credential: 'grader_fx',
        model: 'claude-opus-5',
        observed: 'claude-opus-5',
      },
      failed_cells: [],
    },
    errata: [],
    ...overrides,
  };
}

function cell(overrides: Record<string, unknown> = {}) {
  return {
    scenario: 'scn',
    class: 'descriptive',
    n: 5,
    pass: 4,
    fail: 1,
    coverage: 0.8,
    ...overrides,
  };
}

/** Deep-merges cells/accounting/provenance overrides into a minimal valid
 * descriptive report; other keys override at the top level. The
 * grader_observed provenance key maps onto grader.observed (undefined
 * removes it). */
function descriptiveReport(overrides: Record<string, unknown> = {}) {
  const { cells, medians, accounting, provenance, ...topLevel } = overrides as {
    cells?: Array<Record<string, unknown>>;
    medians?: Record<string, unknown>;
    accounting?: Record<string, unknown>;
    provenance?: Record<string, unknown>;
  } & Record<string, unknown>;

  const { grader_observed: graderObserved, ...provenanceRest } = (provenance ??
    {}) as Record<string, unknown>;
  const grader: { credential: string; model: string; observed?: string } = {
    credential: 'grader_fx',
    model: 'claude-opus-5',
    observed: 'claude-opus-5',
  };
  if (provenance !== undefined && 'grader_observed' in provenance) {
    if (graderObserved === undefined) {
      delete grader.observed;
    } else {
      grader.observed = graderObserved as string;
    }
  }

  return {
    schema_version: 1,
    campaign_id: 'cmp-0001',
    profile: 'descriptive_v1',
    stamp: 'DESCRIPTIVE',
    cannot_answer: [],
    comparisons: [
      {
        comparison_id: 'c1',
        cells: cells ?? [cell()],
        medians: medians ?? {},
      },
    ],
    accounting: {
      instrument_errors: 0,
      indeterminates: 0,
      replacements: 0,
      reserve_draws: 0,
      skew_exclusions: 0,
      skew_caveats: 0,
      budget_events: 0,
      amendments: 0,
      contention_invalidated: 0,
      unknown_coverage: 0,
      denominators: { scored: 5, planned: 5 },
      ...accounting,
    },
    provenance: {
      arms: [
        { arm: 'treat_arm', registered_model: 'm', observed_model_set: ['m'] },
      ],
      failed_cells: [],
      grader,
      ...provenanceRest,
    },
    errata: [],
    ...topLevel,
  };
}

test('a gating report round-trips', () => {
  expect(ReportSchema.parse(gatingReport())).toMatchObject({ verdict: 'SHIP' });
});

test('report numbers are finite (byte-stable rendering cannot carry Infinity)', () => {
  const infDelta = gatingReport();
  (infDelta.comparisons as Array<{ cells: Array<{ delta?: number }> }>)[0]!
    .cells[0]!.delta = Number.POSITIVE_INFINITY;
  expect(() => ReportSchema.parse(infDelta)).toThrow();
  expect(() =>
    ReportSchema.parse(
      gatingReport({
        cannot_answer: [{ cell: 'scn@c1', mde: Number.POSITIVE_INFINITY }],
      }),
    ),
  ).toThrow();
});

test('verdict is present iff gating; stamp iff descriptive', () => {
  // Descriptive: stamp present, verdict structurally absent.
  const descriptive = descriptiveReport();
  expect(ReportSchema.parse(descriptive)).toMatchObject({
    stamp: 'DESCRIPTIVE',
  });
  // Gating report with a stamp rejects.
  expect(() =>
    ReportSchema.parse(gatingReport({ stamp: 'DESCRIPTIVE' })),
  ).toThrow();
  // Descriptive report with a verdict rejects.
  expect(() =>
    ReportSchema.parse({ ...descriptive, verdict: 'SHIP' }),
  ).toThrow();
});

test('verdict vocabulary is three-valued', () => {
  expect(() => ReportSchema.parse(gatingReport({ verdict: 'GO' }))).toThrow();
  expect(
    ReportSchema.parse(
      gatingReport({ verdict: 'UNDERPOWERED_OR_INVESTIGATE' }),
    ),
  ).toBeTruthy();
});

test('provenance carries the observed model SET per arm and singular grader', () => {
  const parsed = ReportSchema.parse(gatingReport());
  expect(parsed.provenance.arms[0]!.observed_model_set).toEqual(['m']);
  expect(parsed.provenance.grader.model).toBe('claude-opus-5');
});

test('byte-stability rules are pinned constants', () => {
  expect(REPORT_RENDERING).toEqual({
    line_ending: '\n',
    key_order: 'sorted',
    numbers: 'shortest-round-trip',
  });
});

test('supersedes and errata support the amendment chain', () => {
  const superseding = gatingReport({
    verdict: 'SHIP',
    supersedes: 'cmp-0000',
    errata: [{ note: 'adjudication resolved tripwire fire' }],
  });
  expect(ReportSchema.parse(superseding).supersedes).toBe('cmp-0000');
});

test('gating report without a verdict rejects', () => {
  const gating = gatingReport();
  delete (gating as Record<string, unknown>)['verdict'];
  expect(() => ReportSchema.parse(gating)).toThrow();
});

test('descriptive report without a stamp rejects', () => {
  const descriptive = descriptiveReport() as Record<string, unknown>;
  delete descriptive['stamp'];
  expect(() => ReportSchema.parse(descriptive)).toThrow();
});

test('D-8: cells carry pass/fail counts and coverage', () => {
  const report = descriptiveReport({
    cells: [
      {
        scenario: 'scn',
        class: 'descriptive',
        n: 5,
        pass: 3,
        fail: 1,
        coverage: 0.8,
      },
    ],
  });
  expect(ReportSchema.parse(report).comparisons[0]!.cells[0]!.pass).toBe(3);
});

test('D-8: negative counts and coverage outside [0,1] reject', () => {
  expect(() =>
    ReportSchema.parse(descriptiveReport({ cells: [cell({ pass: -1 })] })),
  ).toThrow();
  expect(() =>
    ReportSchema.parse(descriptiveReport({ cells: [cell({ coverage: 1.2 })] })),
  ).toThrow();
});

test('D-8: comparisons carry a (possibly empty) medians object', () => {
  const parsed = ReportSchema.parse(
    descriptiveReport({ medians: { tokens: 1234, usd: 5.6 } }),
  );
  expect(parsed.comparisons[0]!.medians).toEqual({ tokens: 1234, usd: 5.6 });
  const empty = ReportSchema.parse(descriptiveReport({}));
  expect(empty.comparisons[0]!.medians).toEqual({});
});

test('D-8: accounting names both contention dispositions', () => {
  const parsed = ReportSchema.parse(
    descriptiveReport({
      accounting: { contention_invalidated: 2, unknown_coverage: 1 },
    }),
  );
  expect(parsed.accounting.contention_invalidated).toBe(2);
  expect(parsed.accounting.unknown_coverage).toBe(1);
});

test('D-8: provenance carries failed_cells; grader.observed is nullable', () => {
  const parsed = ReportSchema.parse(
    descriptiveReport({
      provenance: {
        failed_cells: [
          {
            comparison_id: 'c1',
            scenario: 'scn',
            reason: 'arm model absent from observed set',
          },
        ],
        grader_observed: undefined,
      },
    }),
  );
  expect(parsed.provenance.failed_cells).toHaveLength(1);
  expect(parsed.provenance.grader.observed).toBeUndefined();
});

test('D-8: strictness survives — unknown keys still reject', () => {
  expect(() =>
    ReportSchema.parse(descriptiveReport({ extra_top_level: 1 } as never)),
  ).toThrow();
});
