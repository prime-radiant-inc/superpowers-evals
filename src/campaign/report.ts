import { jcsCanonicalize, sha256Hex } from '../contracts/campaign/digest.ts';
import type { Experiment } from '../contracts/campaign/experiment.ts';
import {
  type ComparisonReport,
  ComparisonReportSchema,
} from '../contracts/campaign/report.ts';
import type { CampaignProjection } from './execution-state.ts';
import {
  type AttemptEvidence,
  missingAttemptEvidence,
  type ValidityEvidence,
} from './report-evidence.ts';

const QUANTITIES = [
  'subject_cost_usd',
  'grader_cost_usd',
  'wall_seconds',
  'subject_tokens',
  'grader_tokens',
] as const;
type Quantity = (typeof QUANTITIES)[number];
// Frozen prices have decimal precision; suppress binary summation noise only at
// the final arithmetic boundary, without introducing a pricing operation.
const stable = (n: number) => Number(n.toPrecision(15));
function measured(e: AttemptEvidence, q: Quantity): number | null {
  if (q === 'subject_cost_usd' && !e.subject_cost_complete) return null;
  if (q === 'grader_cost_usd' && !e.grader_cost_complete) return null;
  return e[q];
}
function paired(pairs: readonly (readonly [number | null, number | null])[]) {
  const matched = pairs.filter(
    (p): p is readonly [number, number] => p[0] !== null && p[1] !== null,
  );
  const n = matched.length;
  return {
    n,
    baseline_mean: n ? stable(matched.reduce((s, p) => s + p[0], 0) / n) : null,
    treatment_mean: n
      ? stable(matched.reduce((s, p) => s + p[1], 0) / n)
      : null,
    mean_delta: n
      ? stable(matched.reduce((s, p) => s + p[1] - p[0], 0) / n)
      : null,
  };
}
function accounting(evidence: AttemptEvidence[]) {
  const sum = (
    known: (e: AttemptEvidence) => number | null,
    complete: (e: AttemptEvidence) => boolean,
  ) => {
    const observed = evidence.filter(complete).length;
    return {
      known_subtotal: stable(evidence.reduce((s, e) => s + (known(e) ?? 0), 0)),
      observed,
      attempts: evidence.length,
      complete: observed === evidence.length,
    };
  };
  const quantity = (q: Quantity) =>
    sum(
      (e) => e[q],
      (e) => measured(e, q) !== null,
    );
  return {
    subject_cost_usd: quantity('subject_cost_usd'),
    grader_cost_usd: quantity('grader_cost_usd'),
    combined_cost_usd: sum(
      (e) =>
        e.subject_cost_usd === null && e.grader_cost_usd === null
          ? null
          : (e.subject_cost_usd ?? 0) + (e.grader_cost_usd ?? 0),
      (e) => e.subject_cost_complete && e.grader_cost_complete,
    ),
    wall_seconds: quantity('wall_seconds'),
    subject_tokens: quantity('subject_tokens'),
    grader_tokens: quantity('grader_tokens'),
  };
}
/** Pure measurement fold. The caller authenticates evidence; the shared journal
 * fold alone decides selected blocks, accepted outcomes, and permanent exclusion. */
export function foldComparisonReport(args: {
  experiment: Experiment;
  state: CampaignProjection;
  evidenceByAttempt: ReadonlyMap<string, AttemptEvidence>;
  validityByBlock: ReadonlyMap<string, ValidityEvidence>;
  interrupted?: boolean;
}): ComparisonReport {
  const { experiment, state } = args;
  if (jcsCanonicalize(experiment) !== jcsCanonicalize(state.experiment))
    throw new Error('report experiment differs from projection');
  const behavior = state.ended !== null || args.interrupted === true;
  const status =
    state.ended?.outcome ?? (args.interrupted ? 'interrupted' : 'active');
  const attempts: ComparisonReport['attempts'] = [];
  for (const [id, a] of state.attempts) {
    const slot = experiment.planned_slots.find(
      (s) => s.sample_id === a.intent.identity.sample_id,
    );
    const block = state.blocks.get(a.intent.identity.block_id);
    if (!slot || !block)
      throw new Error('report projection lacks its frozen slot or block');
    const selected =
      state.selected_blocks.get(a.intent.primary_block_id) ===
      block.activation.block_id;
    const evidence = structuredClone(
      args.evidenceByAttempt.get(id) ??
        missingAttemptEvidence(
          a.accounting?.evidence_missing ??
            a.observation?.evidence_missing ??
            'no authenticated publication',
        ),
    );
    const validity = args.validityByBlock.get(block.activation.block_id);
    const reasons = [
      ...(!selected ? ['superseded block'] : []),
      ...(block.excluded ? [`block excluded: ${block.excluded}`] : []),
      ...(!validity?.available
        ? (validity?.reasons ?? ['positive validity support unavailable'])
        : []),
      ...(!a.observation ? ['no accepted observation'] : []),
      ...(!evidence.publication_valid
        ? ['publication authentication unavailable']
        : []),
    ];
    const supported =
      a.observation?.outcome === 'indeterminate' ||
      (a.observation !== null &&
        evidence.observed_outcome === a.observation.outcome);
    if (!supported)
      reasons.push('accepted behavior lacks authenticated supporting verdict');
    const usable =
      supported &&
      behavior &&
      selected &&
      !block.excluded &&
      Boolean(validity?.available) &&
      Boolean(a.observation) &&
      evidence.publication_valid;
    if (!behavior) {
      evidence.observed_outcome = null;
      evidence.gauntlet = null;
      evidence.checks = null;
    }
    attempts.push({
      execution_attempt_id: id,
      sample_id: slot.sample_id,
      block_id: block.activation.block_id,
      primary_block_id: slot.primary_block_id,
      comparison_id: slot.comparison_id,
      arm: slot.arm,
      selected,
      accepted_outcome: behavior ? (a.observation?.outcome ?? null) : null,
      analysis_usable: usable,
      reasons: behavior
        ? reasons
        : ['behavior hidden while session is active or unresolved'],
      evidence,
    });
  }
  const comparisons: ComparisonReport['comparisons'] = [];
  if (behavior)
    for (const cell of experiment.cells) {
      const comparison = experiment.comparisons.find(
        (c) => c.comparison_id === cell.comparison_id,
      );
      if (!comparison)
        throw new Error('report cell lacks its frozen comparison');
      const slots = experiment.planned_slots.filter(
        (s) =>
          s.comparison_id === cell.comparison_id &&
          s.scenario === cell.scenario,
      );
      const selected = (sampleId: string) =>
        attempts.find((a) => a.sample_id === sampleId && a.analysis_usable);
      const arms = cell.arms.map((arm) => {
        const armSlots = slots.filter((s) => s.arm === arm);
        const members = armSlots.map((s) => selected(s.sample_id));
        const count = (outcome: string) =>
          members.filter((a) => a?.accepted_outcome === outcome).length;
        const determinate = members.filter(
          (a) =>
            a?.accepted_outcome === 'pass' || a?.accepted_outcome === 'fail',
        );
        const values = (q: Quantity) =>
          determinate.flatMap((a) => {
            const value = a ? measured(a.evidence, q) : null;
            return value === null ? [] : [value];
          });
        const mean = (q: Quantity) => {
          const data = values(q);
          return data.length
            ? stable(data.reduce((a, b) => a + b, 0) / data.length)
            : null;
        };
        return {
          arm,
          pass_rate: {
            n: determinate.length,
            rate: determinate.length
              ? count('pass') / determinate.length
              : null,
          },
          means: {
            subject_cost_usd: mean('subject_cost_usd'),
            grader_cost_usd: mean('grader_cost_usd'),
            wall_seconds: mean('wall_seconds'),
            subject_tokens: mean('subject_tokens'),
            grader_tokens: mean('grader_tokens'),
          },
          denominator: armSlots.length,
          pass: count('pass'),
          fail: count('fail'),
          indeterminate: count('indeterminate'),
          no_usable_result: members.filter((a) => !a).length,
          available: {
            subject_cost_usd: values('subject_cost_usd').length,
            grader_cost_usd: values('grader_cost_usd').length,
            wall_seconds: values('wall_seconds').length,
            subject_tokens: values('subject_tokens').length,
            grader_tokens: values('grader_tokens').length,
          },
        };
      });
      const cohort: [
        ComparisonReport['attempts'][number],
        ComparisonReport['attempts'][number],
      ][] = [];
      if ('baseline' in comparison)
        for (const slot of slots.filter((s) => s.arm === comparison.baseline)) {
          const b = selected(slot.sample_id);
          const tSlot = slots.find(
            (s) =>
              s.primary_block_id === slot.primary_block_id &&
              s.arm === comparison.treatment,
          );
          const t = tSlot ? selected(tSlot.sample_id) : undefined;
          if (
            b &&
            t &&
            b.block_id === t.block_id &&
            (b.accepted_outcome === 'pass' || b.accepted_outcome === 'fail') &&
            (t.accepted_outcome === 'pass' || t.accepted_outcome === 'fail')
          )
            cohort.push([b, t]);
        }
      const q = (quantity: Quantity) =>
        paired(
          cohort.map(([b, t]) => [
            measured(b.evidence, quantity),
            measured(t.evidence, quantity),
          ]),
        );
      comparisons.push({
        comparison_id: cell.comparison_id,
        scenario: cell.scenario,
        roles:
          'arm' in comparison
            ? { arm: comparison.arm }
            : {
                baseline: comparison.baseline,
                treatment: comparison.treatment,
              },
        arms,
        paired: {
          pass_rate: paired(
            cohort.map(([b, t]) => [
              b.accepted_outcome === 'pass' ? 1 : 0,
              t.accepted_outcome === 'pass' ? 1 : 0,
            ]),
          ),
          subject_cost_usd: q('subject_cost_usd'),
          grader_cost_usd: q('grader_cost_usd'),
          wall_seconds: q('wall_seconds'),
          subject_tokens: q('subject_tokens'),
          grader_tokens: q('grader_tokens'),
        },
      });
    }
  const records = attempts.map((a) => a.evidence);
  const complete =
    status === 'completed' &&
    experiment.planned_slots.every((slot) =>
      attempts.some((a) => a.sample_id === slot.sample_id && a.analysis_usable),
    );
  // The transition fold retains canonical transition bytes, including the ended
  // timestamp after later accounting/termination transitions advance last_at.
  const endedAt: string | null =
    [...state.transitions.values()]
      .map((bytes) => JSON.parse(bytes) as { type: string; at: string })
      .find((t) => t.type === 'ended')?.at ?? null;
  const startedAt = state.start?.claimed_at ?? null;
  return ComparisonReportSchema.parse({
    schema_version: 'quorum.comparison-report/v1',
    fold_version: 1,
    campaign_id: experiment.campaign_id,
    input_digest: experiment.input_digest,
    status,
    behavior_available: behavior,
    complete,
    termination_verified: state.termination !== null,
    comparisons,
    accounting: accounting(records),
    arm_accounting: [
      ...new Set(experiment.execution_surface.map((a) => a.name)),
    ]
      .sort()
      .map((arm) => ({
        arm,
        accounting: accounting(
          attempts.filter((a) => a.arm === arm).map((a) => a.evidence),
        ),
      })),
    elapsed: {
      started_at: startedAt,
      ended_at: endedAt,
      seconds:
        startedAt !== null && endedAt !== null
          ? (Date.parse(endedAt) - Date.parse(startedAt)) / 1000
          : null,
    },
    excluded_accounting: {
      superseded: accounting(
        attempts.filter((a) => !a.selected).map((a) => a.evidence),
      ),
      unaccepted: accounting(
        attempts
          .filter(
            (a) => !state.attempts.get(a.execution_attempt_id)?.observation,
          )
          .map((a) => a.evidence),
      ),
      analytically_unusable: accounting(
        attempts.filter((a) => !a.analysis_usable).map((a) => a.evidence),
      ),
    },
    attempts,
    caveats: [
      ...(!complete
        ? [
            'Report is incomplete; planned slots retain missing or unusable results.',
          ]
        : []),
      ...(!state.termination
        ? [
            'Termination is not verified at this journal prefix; accounting may be missing.',
          ]
        : []),
      'Run wall seconds sum frozen run intervals; campaign elapsed is start claimed_at through the ended transition, excluding later termination work. Missing endpoints remain missing.',
      'Per-arm means and pass rates use selected usable determinate outcomes; each quantity has independent availability.',
      'Excluded accounting categories overlap; do not add them to total accounting.',
      'Unsupported subject lifecycle/error claims remain conservative accepted indeterminate outcomes.',
    ],
  });
}
export const comparisonReportDigest = (report: ComparisonReport) =>
  sha256Hex(jcsCanonicalize(ComparisonReportSchema.parse(report)));
