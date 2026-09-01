// The descriptive fold (kernel D4a task 3): journal events (every event
// BEFORE sealed) + the injected per-run evidence callback → the D-8-amended
// ReportSchema. Every fixture is a FULL replay-legal event prefix from the
// shared builders; the evidence callback is wired directly (the seam the
// seal act will wire to readSampleEvidence). Expected values are computed
// by hand in each test body and commented.
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalReportBytes,
  cleanupOrphanTemps,
  digestReportBytes,
  foldDescriptiveReport,
  publishReport,
  REPORT_JSON_NAME,
  REPORT_MD_NAME,
  ReportFoldError,
  renderReportMd,
} from '../src/campaign/report.ts';
import type { SampleEvidence } from '../src/campaign/report-evidence.ts';
import {
  campaignDoc,
  REPORT_BLOCK_1,
  REPORT_BLOCK_2,
  type ReportStep,
  reportCampaign,
  reportEvents,
} from './campaign-recovery-fixtures.ts';

const NO_EVIDENCE: SampleEvidence = {
  outcome: null,
  observedModels: [],
  totalTokens: null,
  costUsd: null,
  graderModel: null,
};

function evidence(partial: Partial<SampleEvidence>): SampleEvidence {
  return { ...NO_EVIDENCE, ...partial };
}

/** evidenceOf keyed by runId — exactly the (runId, sampleId) pairs the fold
 *  derives from run_allocated events; an unlisted run reads as absent run
 *  dir (all-null, the reader's own fail-closed contract). */
function evidenceOf(
  table: Record<string, SampleEvidence>,
): (runId: string, sampleId: string) => SampleEvidence {
  return (runId: string) => table[runId] ?? NO_EVIDENCE;
}

/** The happy-path arm evidence: arm_a runs observe model-a, arm_b runs
 *  model-b, every run graded by grader-model. */
function happyEvidence(): Record<string, SampleEvidence> {
  return {
    'run-1': evidence({
      outcome: 'pass',
      observedModels: ['model-a'],
      totalTokens: 100,
      costUsd: 1,
      graderModel: 'grader-model',
    }),
    'run-2': evidence({
      outcome: 'pass',
      observedModels: ['model-b'],
      totalTokens: 300,
      costUsd: 3,
      graderModel: 'grader-model',
    }),
    'run-3': evidence({
      outcome: 'pass',
      observedModels: ['model-a'],
      totalTokens: 200,
      costUsd: 2,
      graderModel: 'grader-model',
    }),
    'run-4': evidence({
      outcome: 'fail',
      observedModels: ['model-b'],
      totalTokens: 400,
      costUsd: 4,
      graderModel: 'grader-model',
    }),
  };
}

/** The happy-path prefix: both replicates run to completion, baseline 2
 *  pass, treatment 1 pass 1 fail. */
function happySteps(): ReportStep[] {
  return [
    {
      kind: 'run',
      run: {
        sampleId: 'c1:scn:arm_a:r1',
        attemptId: 'att-1',
        runId: 'run-1',
        outcome: 'pass',
      },
    },
    {
      kind: 'run',
      run: {
        sampleId: 'c1:scn:arm_b:r1',
        attemptId: 'att-2',
        runId: 'run-2',
        outcome: 'pass',
      },
    },
    {
      kind: 'run',
      run: {
        sampleId: 'c1:scn:arm_a:r2',
        attemptId: 'att-3',
        runId: 'run-3',
        outcome: 'pass',
      },
    },
    {
      kind: 'run',
      run: {
        sampleId: 'c1:scn:arm_b:r2',
        attemptId: 'att-4',
        runId: 'run-4',
        outcome: 'fail',
      },
    },
  ];
}

describe('foldDescriptiveReport', () => {
  test('happy path: rates, delta, medians, accounting, provenance', () => {
    const campaign = reportCampaign();
    const events = reportEvents({ campaign, steps: happySteps() });
    const report = foldDescriptiveReport({
      campaign,
      events,
      evidenceOf: evidenceOf(happyEvidence()),
    });
    const cell = report.comparisons[0]!.cells[0]!;

    // Hand computation, n=2 cell (blocks b1, b2; one sample per arm each):
    //   baseline arm_a: run-1 pass, run-3 pass → 2 pass, 0 fail, rate 1.0
    //   treatment arm_b: run-2 pass, run-4 fail → 1 pass, 1 fail, rate 0.5
    //   pooled (both arms — the schema's single cell object carries the
    //   pooled counts; per-arm rates live in the delta): 3 pass, 1 fail
    //   coverage = determinate 4 / included 4 = 1
    //   n = included per arm = 2 (conservation: one outcome per primary slot)
    //   delta = 0.5 − 1.0 = −0.5
    expect(cell.pass).toBe(3);
    expect(cell.fail).toBe(1);
    expect(cell.coverage).toBe(1);
    expect(cell.n).toBe(2);
    expect(cell.delta).toBeCloseTo(-0.5);
    // cell denominator = 4 included samples across both arms
    expect(report.accounting.denominators['c1:scn']).toBe(4);
    expect(report.stamp).toBe('DESCRIPTIVE');
    expect(report.profile).toBe('descriptive_v1');
    expect(report.campaign_id).toBe(campaign.campaign_id);

    // medians over matched determinate blocks (b1 and b2, both arms
    // determinate in each): tokens [100,200,300,400] → even count →
    // (200+300)/2 = 250; usd [1,2,3,4] → (2+3)/2 = 2.5
    expect(report.comparisons[0]!.medians.tokens).toBe(250);
    expect(report.comparisons[0]!.medians.usd).toBeCloseTo(2.5);

    // clean accounting: nothing failed, nothing replaced, nothing skew
    expect(report.accounting.instrument_errors).toBe(0);
    expect(report.accounting.indeterminates).toBe(0);
    expect(report.accounting.replacements).toBe(0);
    expect(report.accounting.skew_caveats).toBe(0);
    expect(report.accounting.contention_invalidated).toBe(0);
    expect(report.accounting.unknown_coverage).toBe(0);

    // provenance: each arm's observed union is exactly its registered model;
    // the grader identity matches; nothing failed
    expect(report.provenance.arms).toEqual([
      {
        arm: 'arm_a',
        registered_model: 'model-a',
        observed_model_set: ['model-a'],
      },
      {
        arm: 'arm_b',
        registered_model: 'model-b',
        observed_model_set: ['model-b'],
      },
    ]);
    expect(report.provenance.grader.observed).toBe('grader-model');
    expect(report.provenance.failed_cells).toEqual([]);
  });

  test('replaced block: successor included, superseded excluded, replacement counted', () => {
    const campaign = reportCampaign();
    // b1 dies on the instrument (arm_a) after the innocent arm completed;
    // the mint activates frozen reserve x1 for BOTH arms (same-arm pairing
    // is total); b2 is untouched.
    const steps: ReportStep[] = [
      {
        kind: 'run',
        run: {
          sampleId: 'c1:scn:arm_a:r1',
          attemptId: 'att-1',
          runId: 'run-1',
          outcome: 'instrument_failure',
        },
      },
      {
        kind: 'run',
        run: {
          sampleId: 'c1:scn:arm_b:r1',
          attemptId: 'att-2',
          runId: 'run-2',
          outcome: 'pass',
        },
      },
      {
        kind: 'raw',
        event: {
          type: 'block_replaced',
          payload: {
            block_id: REPORT_BLOCK_1,
            replacement_block_id: 'c1:scn:x1',
            reason: 'grader_rate_limited',
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
      },
      {
        kind: 'raw',
        event: {
          type: 'sample_disposition',
          payload: {
            sample_id: 'c1:scn:arm_b:r1',
            disposition: 'excluded_block_replaced',
            superseded_by: 'c1:scn:arm_b:x1',
          },
        },
      },
      {
        kind: 'run',
        run: {
          sampleId: 'c1:scn:arm_a:x1',
          attemptId: 'att-5',
          runId: 'run-5',
          outcome: 'pass',
        },
      },
      {
        kind: 'run',
        run: {
          sampleId: 'c1:scn:arm_b:x1',
          attemptId: 'att-6',
          runId: 'run-6',
          outcome: 'pass',
        },
      },
      {
        kind: 'run',
        run: {
          sampleId: 'c1:scn:arm_a:r2',
          attemptId: 'att-7',
          runId: 'run-7',
          outcome: 'pass',
        },
      },
      {
        kind: 'run',
        run: {
          sampleId: 'c1:scn:arm_b:r2',
          attemptId: 'att-8',
          runId: 'run-8',
          outcome: 'fail',
        },
      },
    ];
    const events = reportEvents({ campaign, steps });
    const table = {
      // the instrument-failed run still RAN: its trajectory joins the arm
      // union, but its outcome is the journal's instrument class
      'run-1': evidence({ observedModels: ['model-a'] }),
      'run-2': evidence({
        outcome: 'pass',
        observedModels: ['model-b'],
        graderModel: 'grader-model',
      }),
      'run-5': evidence({
        outcome: 'pass',
        observedModels: ['model-a'],
        totalTokens: 500,
        costUsd: 5,
        graderModel: 'grader-model',
      }),
      'run-6': evidence({
        outcome: 'pass',
        observedModels: ['model-b'],
        totalTokens: 600,
        costUsd: 6,
        graderModel: 'grader-model',
      }),
      'run-7': evidence({
        outcome: 'pass',
        observedModels: ['model-a'],
        totalTokens: 200,
        costUsd: 2,
        graderModel: 'grader-model',
      }),
      'run-8': evidence({
        outcome: 'fail',
        observedModels: ['model-b'],
        totalTokens: 400,
        costUsd: 4,
        graderModel: 'grader-model',
      }),
    };
    const report = foldDescriptiveReport({
      campaign,
      events,
      evidenceOf: evidenceOf(table),
    });
    const cell = report.comparisons[0]!.cells[0]!;

    // Included = {arm_a:x1, arm_b:x1, arm_a:r2, arm_b:r2} — b1's samples
    // are superseded (arm_a:r1 via the roster supersedes cross-check,
    // arm_b:r1 via its journaled disposition), so the superseded outcomes
    // (run-1 instrument, run-2 pass) count NOWHERE in the rates.
    //   baseline: x1 pass + r2 pass = 2 pass → rate 1.0
    //   treatment: x1 pass + r2 fail = 1 pass 1 fail → rate 0.5
    //   pooled 3 pass, 1 fail; delta 0.5 − 1.0 = −0.5; denominator 4
    expect(cell.pass).toBe(3);
    expect(cell.fail).toBe(1);
    expect(cell.delta).toBeCloseTo(-0.5);
    expect(report.accounting.denominators['c1:scn']).toBe(4);

    // the replacement trail: one mint, one reserve activation, one typed
    // instrument failure (the event, replaced or not)
    expect(report.accounting.replacements).toBe(1);
    expect(report.accounting.reserve_draws).toBe(1);
    expect(report.accounting.instrument_errors).toBe(1);
    expect(report.accounting.indeterminates).toBe(0);

    // medians over the matched determinate live blocks x1 and b2:
    // tokens [500,600,200,400] → sorted [200,400,500,600] → 450;
    // usd [5,6,2,4] → sorted [2,4,5,6] → 4.5
    expect(report.comparisons[0]!.medians.tokens).toBe(450);
    expect(report.comparisons[0]!.medians.usd).toBeCloseTo(4.5);

    // the invalidated-but-ran sample still proves its arm's provenance
    expect(report.provenance.arms[0]!.observed_model_set).toEqual(['model-a']);
    expect(report.provenance.failed_cells).toEqual([]);
  });

  test('integrity adjudications are carried into distinct report classes', () => {
    const campaign = reportCampaign();
    const events = reportEvents({
      campaign,
      steps: [
        ...happySteps(),
        {
          kind: 'raw',
          event: {
            type: 'adjudication',
            payload: {
              cell: 'c1:scn',
              disposition: 'integrity_finding',
              rationale: 'block=c1:scn:b1; recompute mismatch',
            },
          },
        },
        {
          kind: 'raw',
          event: {
            type: 'adjudication',
            payload: {
              cell: 'c1:scn',
              disposition: 'integrity_caveat',
              rationale: 'block=c1:scn:b2; sidecar evidence lost',
            },
          },
        },
      ],
    });
    const report = foldDescriptiveReport({
      campaign,
      events,
      evidenceOf: evidenceOf(happyEvidence()),
    });

    expect(report.integrity).toEqual({
      findings: [
        {
          block_id: 'c1:scn:b1',
          rationale: 'block=c1:scn:b1; recompute mismatch',
        },
      ],
      caveats: [
        {
          block_id: 'c1:scn:b2',
          rationale: 'block=c1:scn:b2; sidecar evidence lost',
        },
      ],
    });
    expect(report.accounting.integrity_findings).toBe(1);
    expect(report.accounting.integrity_caveats).toBe(1);
    const md = renderReportMd({ report, campaign });
    expect(md).toContain('## Integrity');
    expect(md).toContain('integrity findings: 1');
    expect(md).toContain('integrity caveats: 1');
    expect(md).toContain('recompute mismatch');
    expect(md).toContain('sidecar evidence lost');
  });

  test('instrument-failed sample: counted in accounting, never in rates', () => {
    const campaign = reportCampaign();
    // arm_a:r1 fails the instrument and is NOT replaced: it keeps its
    // primary slot (included), but its outcome is the instrument class.
    const steps: ReportStep[] = [
      {
        kind: 'run',
        run: {
          sampleId: 'c1:scn:arm_a:r1',
          attemptId: 'att-1',
          runId: 'run-1',
          outcome: 'instrument_failure',
        },
      },
      ...happySteps().slice(1),
    ];
    const events = reportEvents({ campaign, steps });
    const table = happyEvidence();
    table['run-1'] = evidence({ observedModels: ['model-a'] });
    const report = foldDescriptiveReport({
      campaign,
      events,
      evidenceOf: evidenceOf(table),
    });
    const cell = report.comparisons[0]!.cells[0]!;

    // Included 4 samples (n per arm still 2), determinate 3:
    //   baseline: r1 instrument (never a rate), r2 pass → 1/1 rate 1.0
    //   treatment: 1 pass 1 fail → rate 0.5
    //   pooled pass 2, fail 1; coverage 3/4 = 0.75; delta −0.5
    expect(cell.pass).toBe(2);
    expect(cell.fail).toBe(1);
    expect(cell.coverage).toBeCloseTo(0.75);
    expect(cell.n).toBe(2);
    expect(cell.delta).toBeCloseTo(-0.5);
    expect(report.accounting.instrument_errors).toBe(1);
    expect(report.accounting.indeterminates).toBe(0);
    expect(report.accounting.denominators['c1:scn']).toBe(4);

    // medians: b1 is not a matched DETERMINATE block (r1 never became
    // determinate), so only b2 contributes: tokens [200,400] → 300,
    // usd [2,4] → 3
    expect(report.comparisons[0]!.medians.tokens).toBe(300);
    expect(report.comparisons[0]!.medians.usd).toBeCloseTo(3);
  });

  test('contention adjudications land in the two counters by disposition', () => {
    const campaign = reportCampaign();
    const steps: ReportStep[] = [
      ...happySteps(),
      {
        kind: 'raw',
        event: {
          type: 'adjudication',
          payload: {
            cell: 'c1:scn',
            disposition: 'contention_invalidated',
            rationale: 'block=c1:scn:b1; breach open at campaign end',
          },
        },
      },
      {
        kind: 'raw',
        event: {
          type: 'adjudication',
          payload: {
            cell: 'c1:scn',
            disposition: 'unknown_coverage',
            rationale: 'block=c1:scn:b2; uncovered interval',
          },
        },
      },
    ];
    const events = reportEvents({ campaign, steps });
    const report = foldDescriptiveReport({
      campaign,
      events,
      evidenceOf: evidenceOf(happyEvidence()),
    });
    const cell = report.comparisons[0]!.cells[0]!;

    // Both blocks leave the comparison denominators (D-4): included set is
    // empty → n 0, pooled counts 0, coverage pinned 0 for an empty
    // denominator, no delta (neither arm determinate), no medians.
    expect(report.accounting.contention_invalidated).toBe(1);
    expect(report.accounting.unknown_coverage).toBe(1);
    expect(report.accounting.denominators['c1:scn']).toBe(0);
    expect(cell.n).toBe(0);
    expect(cell.pass).toBe(0);
    expect(cell.fail).toBe(0);
    expect(cell.coverage).toBe(0);
    expect(cell.delta).toBeUndefined();
    expect(report.comparisons[0]!.medians).toEqual({});
    // the two counters name blocks, not samples: no sample joined a
    // missing-evidence class
    expect(report.accounting.indeterminates).toBe(0);
  });

  test('provenance mismatch fails the cell, excludes it, names it in failed_cells', () => {
    const campaign = reportCampaign();
    const events = reportEvents({ campaign, steps: happySteps() });
    const table = happyEvidence();
    // run-1's trajectory never invoked the registered model-a
    table['run-1'] = evidence({
      outcome: 'pass',
      observedModels: ['wrong-model'],
      totalTokens: 100,
      costUsd: 1,
      graderModel: 'grader-model',
    });
    const report = foldDescriptiveReport({
      campaign,
      events,
      evidenceOf: evidenceOf(table),
    });
    const cell = report.comparisons[0]!.cells[0]!;

    // The cell (its only run with a bad trajectory) is marked, excluded
    // from rate/median aggregation (facts still render: counts, coverage,
    // denominator), and named loudly.
    expect(report.provenance.failed_cells).toHaveLength(1);
    expect(report.provenance.failed_cells[0]!.comparison_id).toBe('c1');
    expect(report.provenance.failed_cells[0]!.scenario).toBe('scn');
    expect(report.provenance.failed_cells[0]!.reason).toMatch(
      /arm model absent from observed set/,
    );
    expect(report.provenance.failed_cells[0]!.reason).toContain('model-a');
    expect(cell.delta).toBeUndefined();
    expect(report.comparisons[0]!.medians).toEqual({});
    // the factual counts still render (schema-forced, honest accounting)
    expect(cell.pass).toBe(3);
    expect(cell.fail).toBe(1);
    expect(report.accounting.denominators['c1:scn']).toBe(4);
    // the arm union still shows what actually ran, including the wrong model
    expect(report.provenance.arms[0]!.observed_model_set).toEqual([
      'model-a',
      'wrong-model',
    ]);
  });

  test('grader mismatch fails every graded cell loudly', () => {
    const campaign = reportCampaign();
    const events = reportEvents({ campaign, steps: happySteps() });
    const table = happyEvidence();
    table['run-1'] = evidence({
      outcome: 'pass',
      observedModels: ['model-a'],
      totalTokens: 100,
      costUsd: 1,
      graderModel: 'rogue-grader',
    });
    const report = foldDescriptiveReport({
      campaign,
      events,
      evidenceOf: evidenceOf(table),
    });

    // A grader identity is campaign-global: one rogue grading fails EVERY
    // graded cell. observed renders the distinct set (sorted, display
    // string); the cell loses delta + medians and is named.
    expect(report.provenance.grader.observed).toBe(
      'grader-model, rogue-grader',
    );
    expect(report.provenance.failed_cells).toHaveLength(1);
    expect(report.provenance.failed_cells[0]!.reason).toMatch(
      /grader mismatch/,
    );
    expect(report.provenance.failed_cells[0]!.reason).toContain('rogue-grader');
    expect(report.comparisons[0]!.cells[0]!.delta).toBeUndefined();
    expect(report.comparisons[0]!.medians).toEqual({});
  });

  test('empty grader evidence renders observed absent with a loud caveat', () => {
    const campaign = reportCampaign();
    const events = reportEvents({ campaign, steps: happySteps() });
    const table = happyEvidence();
    for (const runId of ['run-1', 'run-2', 'run-3', 'run-4']) {
      table[runId] = evidence({ ...table[runId]!, graderModel: null });
    }
    const report = foldDescriptiveReport({
      campaign,
      events,
      evidenceOf: evidenceOf(table),
    });

    // All-null grader evidence: observed is ABSENT (D-8 optional), a
    // failed_cells-style caveat names the empty-evidence case — and the
    // terminus never wedges: the descriptive quantities still render (a
    // caveat, not a provenance failure).
    expect(report.provenance.grader.observed).toBeUndefined();
    expect(report.provenance.failed_cells).toHaveLength(1);
    expect(report.provenance.failed_cells[0]!.reason).toMatch(/empty/);
    expect(report.comparisons[0]!.cells[0]!.delta).toBeCloseTo(-0.5);
    expect(report.comparisons[0]!.medians.tokens).toBe(250);
  });

  test('all-instrument-failed campaign: empty-grader caveat fires with no graded samples', () => {
    const campaign = reportCampaign();
    // The spec's own canonical empty-evidence example (§The report engine,
    // item 4): EVERY sample fails the instrument before grading — zero
    // graded (determinate) samples, every run's gauntlet identity null.
    const steps: ReportStep[] = [
      {
        kind: 'run',
        run: {
          sampleId: 'c1:scn:arm_a:r1',
          attemptId: 'att-1',
          runId: 'run-1',
          outcome: 'instrument_failure',
        },
      },
      {
        kind: 'run',
        run: {
          sampleId: 'c1:scn:arm_b:r1',
          attemptId: 'att-2',
          runId: 'run-2',
          outcome: 'instrument_failure',
        },
      },
      {
        kind: 'run',
        run: {
          sampleId: 'c1:scn:arm_a:r2',
          attemptId: 'att-3',
          runId: 'run-3',
          outcome: 'instrument_failure',
        },
      },
      {
        kind: 'run',
        run: {
          sampleId: 'c1:scn:arm_b:r2',
          attemptId: 'att-4',
          runId: 'run-4',
          outcome: 'instrument_failure',
        },
      },
    ];
    const events = reportEvents({ campaign, steps });
    // The instrument runs still ran: trajectories prove the arms, but no
    // gauntlet identity exists anywhere in the campaign.
    const table = {
      'run-1': evidence({ observedModels: ['model-a'] }),
      'run-2': evidence({ observedModels: ['model-b'] }),
      'run-3': evidence({ observedModels: ['model-a'] }),
      'run-4': evidence({ observedModels: ['model-b'] }),
    };
    const report = foldDescriptiveReport({
      campaign,
      events,
      evidenceOf: evidenceOf(table),
    });

    // Zero graded samples, so the empty-grader case must key off the
    // ALL-evidence grader set, not the graded-only one: observed is ABSENT
    // and the loud caveat still names the empty-evidence case — an operator
    // can tell "no grader ever ran" from silent omission.
    expect(report.provenance.grader.observed).toBeUndefined();
    expect(report.provenance.failed_cells).toHaveLength(1);
    expect(report.provenance.failed_cells[0]!.reason).toMatch(/empty/);
    expect(report.provenance.failed_cells[0]!.comparison_id).toBe('c1');

    // The rest of the readout stays honest: 4 included instrument-classed
    // samples (4 instrument_failure events, 0 indeterminates — the class is
    // instrument, not indeterminate), no determinate outcome anywhere
    // (pass 0, fail 0, coverage 0/4 = 0, no delta, no medians), and the
    // arms are still proven by the trajectories that did run.
    expect(report.accounting.instrument_errors).toBe(4);
    expect(report.accounting.indeterminates).toBe(0);
    expect(report.accounting.denominators['c1:scn']).toBe(4);
    const cell = report.comparisons[0]!.cells[0]!;
    expect(cell.pass).toBe(0);
    expect(cell.fail).toBe(0);
    expect(cell.coverage).toBe(0);
    expect(cell.delta).toBeUndefined();
    expect(report.comparisons[0]!.medians).toEqual({});
    expect(report.provenance.arms[0]!.observed_model_set).toEqual(['model-a']);
  });

  test('single-arm comparison renders rates without delta', () => {
    const campaign = reportCampaign({ singleArm: true });
    const steps: ReportStep[] = [
      {
        kind: 'run',
        run: {
          sampleId: 'c1:scn:arm_a:r1',
          attemptId: 'att-1',
          runId: 'run-1',
          outcome: 'pass',
        },
      },
      {
        kind: 'run',
        run: {
          sampleId: 'c1:scn:arm_a:r2',
          attemptId: 'att-2',
          runId: 'run-2',
          outcome: 'fail',
        },
      },
    ];
    const events = reportEvents({ campaign, steps });
    const table = {
      'run-1': evidence({
        outcome: 'pass',
        observedModels: ['model-a'],
        totalTokens: 100,
        costUsd: 1,
        graderModel: 'grader-model',
      }),
      'run-2': evidence({
        outcome: 'fail',
        observedModels: ['model-a'],
        totalTokens: 200,
        costUsd: 2,
        graderModel: 'grader-model',
      }),
    };
    const report = foldDescriptiveReport({
      campaign,
      events,
      evidenceOf: evidenceOf(table),
    });
    const cell = report.comparisons[0]!.cells[0]!;

    // One arm, two included samples, 1 pass 1 fail → coverage 1, no delta
    // (there is no pairing), denominator 2, medians over the arm's two
    // determinate samples: tokens [100,200] → 150, usd [1,2] → 1.5.
    expect(cell.n).toBe(2);
    expect(cell.pass).toBe(1);
    expect(cell.fail).toBe(1);
    expect(cell.coverage).toBe(1);
    expect(cell.delta).toBeUndefined();
    expect(report.accounting.denominators['c1:scn']).toBe(2);
    expect(report.comparisons[0]!.medians.tokens).toBe(150);
    expect(report.comparisons[0]!.medians.usd).toBeCloseTo(1.5);
  });

  test('exploratory suite without a declared profile folds as descriptive_v1', () => {
    const campaign = reportCampaign({ profile: null });
    const events = reportEvents({ campaign, steps: happySteps() });
    const report = foldDescriptiveReport({
      campaign,
      events,
      evidenceOf: evidenceOf(happyEvidence()),
    });
    expect(campaign.suite.profile).toBeUndefined(); // fixture sanity
    expect(report.profile).toBe('descriptive_v1');
    expect(report.stamp).toBe('DESCRIPTIVE');
  });

  test('gating campaign refuses with the D4b-awaiting typed error', () => {
    // campaignDoc() is the fixtures' registered GATING campaign
    // (profile: release_gate_v1, kind: gating).
    const gatingCampaign = campaignDoc();
    const events = reportEvents({
      campaign: gatingCampaign,
      steps: [
        {
          kind: 'run',
          run: {
            sampleId: 'c1:scn:arm_a:r1',
            attemptId: 'a1',
            runId: 'r1',
            outcome: 'pass',
          },
        },
      ],
    });
    expect(() =>
      foldDescriptiveReport({
        campaign: gatingCampaign,
        events,
        evidenceOf: evidenceOf({}),
      }),
    ).toThrow(ReportFoldError);
    expect(() =>
      foldDescriptiveReport({
        campaign: gatingCampaign,
        events,
        evidenceOf: evidenceOf({}),
      }),
    ).toThrow(/awaits D4b/);
  });

  test('skew caveat events count as caveats; exclusions render 0 in exploratory', () => {
    const campaign = reportCampaign();
    // arm_b:r1 completes from spawned under the exploratory exposure caveat
    // (R-SNS-4): the journaled caveat is the exploratory skew expression —
    // exploratory NEVER journals skew_excluded (R-DSP-9).
    const hs = happySteps();
    const steps: ReportStep[] = [
      hs[0]!,
      {
        kind: 'run',
        run: {
          sampleId: 'c1:scn:arm_b:r1',
          attemptId: 'att-2',
          runId: 'run-2',
          outcome: 'pass',
          caveat: true,
        },
      },
      hs[2]!,
      hs[3]!,
    ];
    const events = reportEvents({ campaign, steps });
    const report = foldDescriptiveReport({
      campaign,
      events,
      evidenceOf: evidenceOf(happyEvidence()),
    });

    // one caveat-bearing terminal counted; zero exclusions in exploratory;
    // the caveated completion is still a determinate pass (rates unchanged)
    expect(report.accounting.skew_caveats).toBe(1);
    expect(report.accounting.skew_exclusions).toBe(0);
    expect(report.comparisons[0]!.cells[0]!.pass).toBe(3);

    // The fold still READS skew_excluded events (the counter is not
    // hard-wired to 0): the same prefix plus one late skew_excluded row —
    // replay-legal (retained evidence: the completed samples keep their
    // terminals) — counts 1.
    const withExclusion = reportEvents({
      campaign,
      steps: [
        ...steps,
        {
          kind: 'raw',
          event: {
            type: 'skew_excluded',
            payload: { block_id: REPORT_BLOCK_2 },
          },
        },
      ],
    });
    const reFolded = foldDescriptiveReport({
      campaign,
      events: withExclusion,
      evidenceOf: evidenceOf(happyEvidence()),
    });
    expect(reFolded.accounting.skew_exclusions).toBe(1);
    expect(reFolded.accounting.skew_caveats).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Task 4 — the render half: canonical bytes, digest, report.md, publication.
// ---------------------------------------------------------------------------

/** The happy-path fixture report every render-half test folds once: the same
 *  campaign/steps/evidence as the fold-half happy path (n=2 cell, baseline
 *  2/2 pass, treatment 1 pass 1 fail → pooled 3/1, coverage 1, delta −0.5,
 *  medians tokens 250 / usd 2.5). */
function goldenReport() {
  const campaign = reportCampaign();
  return foldDescriptiveReport({
    campaign,
    events: reportEvents({ campaign, steps: happySteps() }),
    evidenceOf: evidenceOf(happyEvidence()),
  });
}

/** FROZEN golden oracle: the canonical bytes of goldenReport(), captured ONCE
 *  by hand from the implementation and committed inline. Any serializer change
 *  — key order, number formatting, line ending, trailing newline — breaks this
 *  loudly. Do NOT regenerate to make it pass. */
const GOLDEN_REPORT_JSON =
  '{"accounting":{"amendments":0,"budget_events":0,"contention_invalidated":0,"denominators":{"c1:scn":4},"indeterminates":0,"instrument_errors":0,"integrity_caveats":0,"integrity_findings":0,"replacements":0,"reserve_draws":0,"skew_caveats":0,"skew_exclusions":0,"unknown_coverage":0},"campaign_id":"27e9b58a7a41794573b240289a4f6cf90eee1ee2ce354373c60b6ef6d6302a12","cannot_answer":[],"comparisons":[{"cells":[{"class":"descriptive","coverage":1,"delta":-0.5,"fail":1,"n":2,"pass":3,"scenario":"scn"}],"comparison_id":"c1","medians":{"tokens":250,"usd":2.5}}],"errata":[],"integrity":{"caveats":[],"findings":[]},"profile":"descriptive_v1","provenance":{"arms":[{"arm":"arm_a","observed_model_set":["model-a"],"registered_model":"model-a"},{"arm":"arm_b","observed_model_set":["model-b"],"registered_model":"model-b"}],"failed_cells":[],"grader":{"credential":"grader_cred","model":"grader-model","observed":"grader-model"}},"schema_version":1,"stamp":"DESCRIPTIVE"}\n';

describe('canonicalReportBytes / digestReportBytes', () => {
  test('canonical bytes: sorted keys, LF, trailing newline, stable across repeated renders', () => {
    const report = goldenReport();
    const a = canonicalReportBytes(report);
    const b = canonicalReportBytes(report);
    expect(a.equals(b)).toBe(true);
    expect(a.toString('utf8').endsWith('\n')).toBe(true);
    expect(a.toString('utf8').includes('\r')).toBe(false); // LF only
    const parsed = JSON.parse(a.toString('utf8'));
    expect(Object.keys(parsed)).toEqual(Object.keys(parsed).sort());
    // sorted at EVERY depth, not just the top level
    expect(Object.keys(parsed.comparisons[0])).toEqual(
      Object.keys(parsed.comparisons[0]).sort(),
    );
    expect(Object.keys(parsed.comparisons[0].cells[0])).toEqual(
      Object.keys(parsed.comparisons[0].cells[0]).sort(),
    );
    // round-trips: the bytes parse back to the report unchanged
    expect(JSON.parse(a.toString('utf8'))).toEqual(report);
  });

  test('digest is the 64-hex sha256 of the canonical bytes', () => {
    const bytes = canonicalReportBytes(goldenReport());
    expect(digestReportBytes(bytes)).toMatch(/^[0-9a-f]{64}$/);
    // cross-check against node:crypto directly in the test
    expect(digestReportBytes(bytes)).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
    // and it is a digest OF the bytes: different bytes, different digest
    const other = Buffer.concat([bytes, Buffer.from('x')]);
    expect(digestReportBytes(other)).not.toBe(digestReportBytes(bytes));
  });

  test('golden oracle: the full fixture report renders byte-exact', () => {
    const bytes = canonicalReportBytes(goldenReport());
    expect(bytes.toString('utf8')).toBe(GOLDEN_REPORT_JSON);
  });
});

describe('renderReportMd', () => {
  test('DESCRIPTIVE stamp first; every rate carries n/denominator/coverage; medians; full accounting; provenance; D-9 deferral', () => {
    const campaign = reportCampaign();
    const report = goldenReport();
    const md = renderReportMd({ report, campaign });

    // the stamp renders FIRST, before any comparison content
    expect(md).toContain('stamp: DESCRIPTIVE');
    expect(md.indexOf('DESCRIPTIVE')).toBeLessThan(
      md.indexOf('## Comparisons'),
    );
    expect(md).toContain(`# Campaign report — ${report.campaign_id}`);

    // pooled rates with n (per arm), denominator, and coverage on every
    // number; the signed delta names its two arms
    expect(md).toContain(
      '| scn | descriptive | 3 | 1 | 2 | 4 | 1 (4/4 determinate) | -0.5 (arm_b - arm_a) |',
    );
    // the pooled basis is stated, not implied
    expect(md).toContain('pool');

    expect(md).toContain('- c1: tokens 250; usd 2.5');

    // the accounting block renders in full
    expect(md).toContain('- instrument_errors: 0');
    expect(md).toContain('- indeterminates: 0');
    expect(md).toContain('- replacements: 0');
    expect(md).toContain('- reserve_draws: 0');
    expect(md).toContain('- skew_exclusions: 0');
    expect(md).toContain('- skew_caveats: 0');
    expect(md).toContain('- budget_events: 0');
    expect(md).toContain('- amendments: 0');
    expect(md).toContain('- contention_invalidated: 0');
    expect(md).toContain('- unknown_coverage: 0');
    expect(md).toContain('- c1:scn: 4');

    // provenance: arms, grader identity, no failures
    expect(md).toContain('- arm arm_a: registered model-a; observed [model-a]');
    expect(md).toContain('- arm arm_b: registered model-b; observed [model-b]');
    expect(md).toContain(
      '- grader: credential grader_cred, model grader-model, observed grader-model',
    );
    expect(md).toContain('- failed_cells:');
    expect(md).toContain('  - (none)');

    // Decision D-9's named empty section, verbatim
    expect(md).toContain(
      '## tags/declared metrics — deferred to D4b (no aggregation registry pinned)',
    );

    // deterministic for identical inputs
    expect(renderReportMd({ report, campaign })).toBe(md);
  });

  test('provenance failures render loud; absent grader observed is named, not silent', () => {
    const campaign = reportCampaign();
    const events = reportEvents({ campaign, steps: happySteps() });
    const table = happyEvidence();
    table['run-1'] = evidence({
      outcome: 'pass',
      observedModels: ['wrong-model'],
      totalTokens: 100,
      costUsd: 1,
      graderModel: 'grader-model',
    });
    const mismatched = foldDescriptiveReport({
      campaign,
      events,
      evidenceOf: evidenceOf(table),
    });
    const md = renderReportMd({ report: mismatched, campaign });
    expect(md).toContain('arm model absent from observed set');
    expect(md).toContain(
      '  - c1/scn: arm model absent from observed set: arm arm_a registered model-a, observed [wrong-model]',
    );

    const nullGrader = { ...table };
    for (const runId of ['run-1', 'run-2', 'run-3', 'run-4']) {
      nullGrader[runId] = evidence({
        ...nullGrader[runId]!,
        graderModel: null,
      });
    }
    const emptyEvidence = foldDescriptiveReport({
      campaign,
      events,
      evidenceOf: evidenceOf(nullGrader),
    });
    const mdEmpty = renderReportMd({ report: emptyEvidence, campaign });
    expect(mdEmpty).toContain('observed absent');
    expect(mdEmpty).toContain('empty-evidence');
  });

  test('unpriced arms: tokens-only medians carry the named caveat', () => {
    const campaign = reportCampaign();
    const events = reportEvents({ campaign, steps: happySteps() });
    const table = happyEvidence();
    for (const runId of ['run-1', 'run-2', 'run-3', 'run-4']) {
      table[runId] = evidence({ ...table[runId]!, costUsd: null });
    }
    const report = foldDescriptiveReport({
      campaign,
      events,
      evidenceOf: evidenceOf(table),
    });
    const md = renderReportMd({ report, campaign });
    expect(report.comparisons[0]!.medians.tokens).toBe(250); // sanity
    expect(report.comparisons[0]!.medians.usd).toBeUndefined(); // sanity
    expect(md).toContain('- c1: tokens 250');
    expect(md).toContain('unpriced arm');
    expect(md).not.toContain('usd 2.5');
  });

  test('single-arm comparison renders rates without a delta', () => {
    const campaign = reportCampaign({ singleArm: true });
    const steps: ReportStep[] = [
      {
        kind: 'run',
        run: {
          sampleId: 'c1:scn:arm_a:r1',
          attemptId: 'att-1',
          runId: 'run-1',
          outcome: 'pass',
        },
      },
      {
        kind: 'run',
        run: {
          sampleId: 'c1:scn:arm_a:r2',
          attemptId: 'att-2',
          runId: 'run-2',
          outcome: 'fail',
        },
      },
    ];
    const events = reportEvents({ campaign, steps });
    const report = foldDescriptiveReport({
      campaign,
      events,
      evidenceOf: evidenceOf({
        'run-1': evidence({
          outcome: 'pass',
          observedModels: ['model-a'],
          totalTokens: 100,
          costUsd: 1,
          graderModel: 'grader-model',
        }),
        'run-2': evidence({
          outcome: 'fail',
          observedModels: ['model-a'],
          totalTokens: 200,
          costUsd: 2,
          graderModel: 'grader-model',
        }),
      }),
    });
    const md = renderReportMd({ report, campaign });
    expect(md).toContain(
      '| scn | descriptive | 1 | 1 | 2 | 2 | 1 (2/2 determinate) | n/a |',
    );
    expect(md).toContain('- c1: tokens 150; usd 1.5');
  });
});

describe('publishReport / cleanupOrphanTemps', () => {
  test('publishReport writes md first, json last, both atomic; orphans cleaned', () => {
    const dir = mkdtempSync(join(tmpdir(), 'report-publish-'));
    try {
      // a crashed publication's leftovers, staged in exactly the shape
      // publication itself produces (<name>.tmp.<pid>) — plus junk content
      writeFileSync(join(dir, `${REPORT_MD_NAME}.tmp.999`), 'torn md');
      writeFileSync(join(dir, `${REPORT_JSON_NAME}.tmp.999`), 'torn json');

      const md = renderReportMd({
        report: goldenReport(),
        campaign: reportCampaign(),
      });
      const jsonBytes = canonicalReportBytes(goldenReport());
      publishReport({ campaignDir: dir, md, jsonBytes });

      // the orphans of the crashed publication are gone
      expect(existsSync(join(dir, `${REPORT_MD_NAME}.tmp.999`))).toBe(false);
      expect(existsSync(join(dir, `${REPORT_JSON_NAME}.tmp.999`))).toBe(false);

      // both artifacts present, contents byte-exact
      const mdPath = join(dir, REPORT_MD_NAME);
      const jsonPath = join(dir, REPORT_JSON_NAME);
      expect(existsSync(mdPath)).toBe(true);
      expect(existsSync(jsonPath)).toBe(true);
      expect(readFileSync(mdPath, 'utf8')).toBe(md);
      expect(readFileSync(jsonPath).equals(jsonBytes)).toBe(true);

      // md FIRST, json LAST (the completion marker): the md's timestamps can
      // never post-date the json's
      const mdStat = statSync(mdPath);
      const jsonStat = statSync(jsonPath);
      expect(mdStat.mtimeMs).toBeLessThanOrEqual(jsonStat.mtimeMs);
      expect(mdStat.birthtimeMs).toBeLessThanOrEqual(jsonStat.birthtimeMs);

      // atomic: no staged temp survives a completed publication
      const leftovers = readdirSync(dir).filter((name) =>
        name.includes('.tmp.'),
      );
      expect(leftovers).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('cleanupOrphanTemps removes exactly the publication temp shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'report-orphans-'));
    try {
      const orphanMd = join(dir, `${REPORT_MD_NAME}.tmp.123`);
      const orphanJson = join(dir, `${REPORT_JSON_NAME}.tmp.999`);
      const keepJson = join(dir, 'campaign.json');
      const keepStage = join(dir, `${REPORT_MD_NAME}.stage.7`); // NOT ours
      writeFileSync(orphanMd, 'torn');
      writeFileSync(orphanJson, 'torn');
      writeFileSync(keepJson, '{}');
      writeFileSync(keepStage, 'torn');

      cleanupOrphanTemps(dir);

      expect(existsSync(orphanMd)).toBe(false);
      expect(existsSync(orphanJson)).toBe(false);
      expect(existsSync(keepJson)).toBe(true); // real artifacts untouched
      expect(existsSync(keepStage)).toBe(true); // other writers' temps untouched
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
