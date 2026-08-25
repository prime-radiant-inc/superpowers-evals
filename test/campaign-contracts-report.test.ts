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
          },
        ],
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
    },
    errata: [],
    ...overrides,
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
  const descriptive = {
    ...gatingReport({
      profile: 'descriptive_v1',
      verdict: undefined,
      stamp: 'DESCRIPTIVE',
    }),
  };
  delete (descriptive as Record<string, unknown>)['verdict'];
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
  const descriptive = gatingReport({
    profile: 'descriptive_v1',
    verdict: undefined,
    stamp: 'DESCRIPTIVE',
  });
  delete (descriptive as Record<string, unknown>)['verdict'];
  delete (descriptive as Record<string, unknown>)['stamp'];
  expect(() => ReportSchema.parse(descriptive)).toThrow();
});
