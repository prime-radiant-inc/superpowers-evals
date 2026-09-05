import {
  foldTransition,
  initialProjection,
} from '../../../src/campaign/execution-state.ts';
import type { AttemptEvidence } from '../../../src/campaign/report-evidence.ts';
import { missingAttemptEvidence } from '../../../src/campaign/report-evidence.ts';
import { CampaignTransitionSchema } from '../../../src/contracts/campaign/execution.ts';
import { ExperimentSchema } from '../../../src/contracts/campaign/experiment.ts';
import campaign from './campaign.json';
import evidenceJson from './evidence.json';
import expected from './expected-report.json';
import {
  blockActivation,
  evidenceRef,
  observation,
  sessionTransitions,
  transition,
  twoArmExperiment,
} from './factory.ts';
import transitionsJson from './transitions.json';
export function mixedComparisonFixture() {
  const experiment = ExperimentSchema.parse(campaign);
  const transitions = transitionsJson.map((t) =>
    CampaignTransitionSchema.parse(t),
  );
  return {
    experiment,
    transitions,
    expected,
    state: transitions.reduce(foldTransition, initialProjection(experiment)),
    evidenceByAttempt: new Map(
      Object.entries(structuredClone(evidenceJson)) as [
        string,
        AttemptEvidence,
      ][],
    ),
    validityByBlock: new Map(
      ['c1-r1', 'c1-r2', 'c1-r3-reserve', 'c2-r1'].map((id) => [
        id,
        { available: true, reasons: [] as string[] },
      ]),
    ),
  };
}

export function singleArmComparisonFixture() {
  const experiment = twoArmExperiment();
  experiment.execution_surface = experiment.execution_surface.filter(
    (a) => a.name === 'base',
  );
  experiment.suite.comparisons = [
    { arm: 'base', scenarios: ['scenario'], n: 3 },
  ];
  experiment.comparisons = [{ comparison_id: 'comparison', arm: 'base' }];
  experiment.cells = [{ ...experiment.cells[0]!, arms: ['base'], n: 3 }];
  const slot = experiment.planned_slots[0]!;
  experiment.planned_slots = [1, 2, 3].map((n) => ({
    ...slot,
    sample_id: `single-${n}`,
    primary_block_id: `single-block-${n}`,
    replicate: n,
  }));
  const intents = blockActivation(experiment).attempts;
  const blocks = intents.map((intent, index) => {
    const blockId = `single-block-${index + 1}`;
    intent.identity.block_id = blockId;
    return {
      block_id: blockId,
      primary_block_id: blockId,
      reserve_id: null,
      predecessor_block_id: null,
      attempts: [intent],
    };
  });
  const outcomes = ['pass', 'fail', 'indeterminate'] as const;
  const stops = [11, 15, 23];
  const observations = blocks.map((block, i) =>
    observation(block, 0, stops[i]!, { outcome: outcomes[i]! }),
  );
  const transitions = [
    ...sessionTransitions(experiment),
    ...blocks.map((block, i) =>
      transition('block_activated', block, 3, `activate-${i}`),
    ),
    ...observations.map((obs, i) =>
      transition(
        'attempt_observed',
        { observation: obs, excluded_block: null },
        stops[i]!,
        `observe-${i}`,
      ),
    ),
    ...blocks.map((block, i) =>
      transition(
        'block_validated',
        { block_id: block.block_id, evidence_refs: [evidenceRef] },
        24,
        `validate-${i}`,
      ),
    ),
    transition(
      'ended',
      { outcome: 'completed', reason: 'done', cancel_intent: null },
      25,
    ),
  ];
  const evidenceByAttempt = new Map(
    observations.map((obs, i) => [
      obs.execution_attempt_id,
      {
        ...missingAttemptEvidence(),
        publication_valid: true,
        observed_outcome: outcomes[i]!,
        subject_cost_usd: [2, 8, 100][i]!,
        subject_cost_complete: true,
        grader_cost_usd: [1, 0.5, 9][i]!,
        grader_cost_complete: i !== 1,
        wall_seconds: [8, 12, 20][i]!,
        subject_tokens: [10, null, 1000][i]!,
        grader_tokens: [null, 40, 900][i]!,
      },
    ]),
  );
  return {
    experiment,
    state: transitions.reduce(foldTransition, initialProjection(experiment)),
    evidenceByAttempt,
    validityByBlock: new Map(
      blocks.map((b) => [b.block_id, { available: true, reasons: [] }]),
    ),
  };
}
