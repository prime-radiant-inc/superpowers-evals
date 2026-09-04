import { expect, test } from 'bun:test';
import {
  foldTransition,
  initialProjection,
} from '../src/campaign/execution-state.ts';
import {
  jcsCanonicalize,
  sha256Hex,
} from '../src/contracts/campaign/digest.ts';
import {
  replacementFixture,
  startTransition,
} from './fixtures/core-comparison/factory.ts';

test('replacement preserves observations and the primary denominator', () => {
  const { experiment, transitions, primary, successor } = replacementFixture();
  const state = transitions.reduce(
    foldTransition,
    initialProjection(experiment),
  );
  expect(experiment.planned_slots).toHaveLength(2);
  expect(
    state.attempts.get(primary.attempts[0]!.identity.execution_attempt_id)
      ?.observation?.outcome,
  ).toBe('pass');
  expect(state.selected_blocks.get(primary.primary_block_id)).toBe(
    successor.block_id,
  );
  expect(() => foldTransition(state, startTransition(experiment, 9))).toThrow();
});

import {
  ArtifactRefSchema,
  AttemptRuntimeSpecSchema,
  CampaignTransitionSchema,
} from '../src/contracts/campaign/execution.ts';
import {
  ExperimentSchema,
  SuiteSchema,
} from '../src/contracts/campaign/experiment.ts';
import {
  blockActivation,
  evidenceRef,
  fixtureTime,
  observation,
  sessionTransitions,
  transition,
  twoArmExperiment,
} from './fixtures/core-comparison/factory.ts';

function active() {
  const experiment = twoArmExperiment();
  const primary = blockActivation(experiment);
  const state = [
    ...sessionTransitions(experiment),
    transition('block_activated', primary, 3),
  ].reduce(foldTransition, initialProjection(experiment));
  return { experiment, primary, state };
}

test('only a registered bound session admits blocks and never restarts', () => {
  const e = twoArmExperiment();
  const empty = initialProjection(e);
  expect(() => foldTransition(empty, startTransition(e))).toThrow();
  const registered = foldTransition(empty, sessionTransitions(e)[0]!);
  expect(() =>
    foldTransition(
      registered,
      transition('block_activated', blockActivation(e), 3),
    ),
  ).toThrow();
  const { state } = active();
  expect(() => foldTransition(state, startTransition(e, 4))).toThrow();
  expect(() =>
    foldTransition(
      state,
      transition(
        'controller_bound',
        {
          start_id: 'start',
          controller: { pid: 999, birth: 'other', boot_id: 'boot' },
        },
        4,
      ),
    ),
  ).toThrow();
});

test.each([
  'missing arm',
  'duplicate attempt',
  'wrong sample',
  'wrong campaign',
  'wrong primary',
  'wrong comparison',
  'wrong block',
  'wrong ordinal',
  'wrong runtime digest',
])('atomic inventory rejects %s without modifying input', (problem) => {
  const e = twoArmExperiment();
  const state = sessionTransitions(e).reduce(
    foldTransition,
    initialProjection(e),
  );
  const block = blockActivation(e);
  if (problem === 'missing arm') block.attempts.pop();
  if (problem === 'duplicate attempt')
    block.attempts[1]!.identity.execution_attempt_id =
      block.attempts[0]!.identity.execution_attempt_id;
  if (problem === 'wrong sample')
    block.attempts[1]!.identity.sample_id = 'foreign';
  if (problem === 'wrong campaign')
    block.attempts[1]!.identity.campaign_id = 'foreign';
  if (problem === 'wrong primary')
    block.attempts[1]!.primary_block_id = 'foreign';
  if (problem === 'wrong comparison')
    block.attempts[1]!.identity.comparison_id = 'foreign';
  if (problem === 'wrong block')
    block.attempts[1]!.identity.block_id = 'foreign';
  if (problem === 'wrong ordinal') block.attempts[1]!.attempt_number = 2;
  if (problem === 'wrong runtime digest')
    block.attempts[1]!.runtime_spec_digest = '0'.repeat(64);
  expect(() =>
    foldTransition(state, transition('block_activated', block, 3)),
  ).toThrow();
  expect(state.attempts.size).toBe(0);
  expect(state.blocks.size).toBe(0);
  expect(state.selected_blocks.size).toBe(0);
});

test('replacement needs whole-block death, supported cause, and selected predecessor', () => {
  const { state, experiment } = active();
  expect(() =>
    foldTransition(
      state,
      transition(
        'block_replaced',
        {
          activation: blockActivation(experiment, true),
          reason: 'grader_rate_limited',
        },
        6,
      ),
    ),
  ).toThrow();
  const fixture = replacementFixture();
  const closed = fixture.transitions
    .slice(0, 6)
    .reduce(foldTransition, initialProjection(fixture.experiment));
  const successor = structuredClone(fixture.successor);
  successor.predecessor_block_id = 'foreign';
  expect(() =>
    foldTransition(
      closed,
      transition(
        'block_replaced',
        { activation: successor, reason: 'grader_rate_limited' },
        6,
      ),
    ),
  ).toThrow();
  expect(
    CampaignTransitionSchema.safeParse({
      ...transition(
        'block_replaced',
        { activation: fixture.successor, reason: 'grader_rate_limited' },
        6,
      ),
      payload: {
        activation: fixture.successor,
        reason: 'grader_billing_exhausted',
      },
    }).success,
  ).toBe(false);
});

test.each([
  'reserve',
  'attempts',
])('replacement obeys the independent %s bound', (limit) => {
  const fixture = replacementFixture();
  if (limit === 'reserve') {
    fixture.experiment.suite.reserve = 0;
    fixture.experiment.reserve_slots = [];
  } else fixture.experiment.suite.attempt_bounds.max_attempts = 1;
  const state = fixture.transitions
    .slice(0, 6)
    .reduce(foldTransition, initialProjection(fixture.experiment));
  expect(() => foldTransition(state, fixture.transitions[6]!)).toThrow();
  expect(state.attempts.size).toBe(2);
  const exhausted = foldTransition(
    state,
    transition(
      'block_exhausted',
      { primary_block_id: 'primary', reason: 'grader_rate_limited' },
      6,
    ),
  );
  expect(exhausted.exhausted_blocks.has('primary')).toBe(true);
});

test('cannot exhaust while a legal replacement exists or retry an unknown outcome', () => {
  const f = replacementFixture();
  const state = f.transitions
    .slice(0, 6)
    .reduce(foldTransition, initialProjection(f.experiment));
  expect(() =>
    foldTransition(
      state,
      transition(
        'block_exhausted',
        { primary_block_id: 'primary', reason: 'grader_rate_limited' },
        6,
      ),
    ),
  ).toThrow();
  const complete = f.transitions.reduce(
    foldTransition,
    initialProjection(f.experiment),
  );
  expect(() =>
    foldTransition(
      complete,
      transition(
        'block_exhausted',
        { primary_block_id: 'primary', reason: 'grader_rate_limited' },
        9,
      ),
    ),
  ).toThrow();
});

test('accepted outcomes cannot be changed and duplicate ids require identical canonical bytes', () => {
  const { state, primary } = active();
  const accepted = transition(
    'attempt_observed',
    { observation: observation(primary, 0, 4), excluded_block: null },
    4,
  );
  const next = foldTransition(state, accepted);
  expect(
    state.attempts.get(primary.attempts[0]!.identity.execution_attempt_id)
      ?.observation,
  ).toBeNull();
  expect(foldTransition(next, accepted)).toEqual(next);
  const changed = structuredClone(accepted);
  changed.payload.observation.outcome = 'fail';
  expect(() => foldTransition(next, changed)).toThrow();
  changed.transition_id = 'second-observation';
  expect(() => foldTransition(next, changed)).toThrow();
});

test('invalid validity must exclude the coherent block atomically and cannot be restored', () => {
  const { state, primary } = active();
  const invalid = observation(primary, 0, 4, {
    validity: 'unknown',
    outcome: 'indeterminate',
  });
  expect(() =>
    foldTransition(
      state,
      transition(
        'attempt_observed',
        { observation: invalid, excluded_block: null },
        4,
      ),
    ),
  ).toThrow();
  let next = foldTransition(
    state,
    transition(
      'attempt_observed',
      {
        observation: invalid,
        excluded_block: { block_id: 'primary', reason: 'missing_telemetry' },
      },
      4,
    ),
  );
  next = foldTransition(
    next,
    transition(
      'attempt_observed',
      { observation: observation(primary, 1, 5), excluded_block: null },
      5,
    ),
  );
  expect(next.blocks.get('primary')?.excluded).toBe('missing_telemetry');
  expect(() =>
    foldTransition(
      next,
      transition(
        'block_validated',
        { block_id: 'primary', evidence_refs: [evidenceRef] },
        6,
      ),
    ),
  ).toThrow();
});

test('completion waits for positive audits and late invalidation preserves outcomes', () => {
  const f = replacementFixture();
  const state = f.transitions.reduce(
    foldTransition,
    initialProjection(f.experiment),
  );
  const end = transition(
    'ended',
    { outcome: 'completed', reason: 'done', cancel_intent: null },
    11,
  );
  expect(() => foldTransition(state, end)).toThrow();
  const valid = foldTransition(
    state,
    transition(
      'block_validated',
      { block_id: 'successor', evidence_refs: [evidenceRef] },
      9,
    ),
  );
  expect(foldTransition(valid, end).ended?.outcome).toBe('completed');
  const invalid = foldTransition(
    valid,
    transition(
      'block_invalidated',
      { block_id: 'successor', reason: 'skew', evidence_refs: [evidenceRef] },
      10,
    ),
  );
  expect(
    invalid.attempts.get(f.successor.attempts[0]!.identity.execution_attempt_id)
      ?.observation?.outcome,
  ).toBe('pass');
  expect(() => foldTransition(invalid, end)).toThrow();
});

test('runtime binding and death identity are exact and monotonic', () => {
  const { state, primary } = active();
  const intent = primary.attempts[0]!;
  const id = intent.identity.execution_attempt_id;
  const container = 'c'.repeat(64);
  const bound = foldTransition(
    state,
    transition(
      'runtime_bound',
      {
        execution_attempt_id: id,
        container_id: container,
        runtime_spec_digest: intent.runtime_spec_digest,
      },
      4,
    ),
  );
  expect(() =>
    foldTransition(
      bound,
      transition(
        'runtime_bound',
        {
          execution_attempt_id: id,
          container_id: 'd'.repeat(64),
          runtime_spec_digest: intent.runtime_spec_digest,
        },
        5,
      ),
    ),
  ).toThrow();
  expect(() =>
    foldTransition(
      bound,
      transition(
        'attempt_observed',
        { observation: observation(primary, 0, 5), excluded_block: null },
        5,
      ),
    ),
  ).toThrow();
  const started = foldTransition(
    bound,
    transition(
      'runtime_started',
      {
        execution_attempt_id: id,
        observed_at: fixtureTime(5),
        receipt: 'docker_start_succeeded',
      },
      5,
    ),
  );
  expect(() =>
    foldTransition(
      started,
      transition(
        'accounting_observed',
        {
          execution_attempt_id: id,
          stopped: {
            execution_attempt_id: id,
            container_id: container,
            proof: 'inspected_stopped',
            observed_at: fixtureTime(4),
          },
          artifacts: [],
          evidence_missing: 'none',
        },
        6,
      ),
    ),
  ).toThrow();
});

test('interruption is final but permits accounting and exact termination inventory', () => {
  const { state, primary } = active();
  let next = foldTransition(
    state,
    transition(
      'ended',
      {
        outcome: 'interrupted',
        reason: 'controller lost',
        cancel_intent: null,
      },
      4,
    ),
  );
  expect(() =>
    foldTransition(
      next,
      transition(
        'attempt_observed',
        { observation: observation(primary, 0, 5), excluded_block: null },
        5,
      ),
    ),
  ).toThrow();
  expect(() =>
    foldTransition(
      next,
      transition(
        'ended',
        {
          outcome: 'cancelled',
          reason: 'operator',
          cancel_intent: evidenceRef,
        },
        5,
      ),
    ),
  ).toThrow();
  for (let i = 0; i < 2; i++) {
    const obs = observation(primary, i, 5 + i);
    next = foldTransition(
      next,
      transition(
        'accounting_observed',
        {
          execution_attempt_id: obs.execution_attempt_id,
          stopped: obs.stopped,
          artifacts: [],
          evidence_missing: 'not published',
        },
        5 + i,
      ),
    );
  }
  expect(() =>
    foldTransition(
      next,
      transition(
        'termination_verified',
        { start_id: 'start', stopped: [], process_evidence: [evidenceRef] },
        7,
      ),
    ),
  ).toThrow();
  const terminated = foldTransition(
    next,
    transition(
      'termination_verified',
      {
        start_id: 'start',
        stopped: [
          observation(primary, 0, 7).stopped,
          observation(primary, 1, 7).stopped,
        ],
        process_evidence: [evidenceRef],
      },
      7,
    ),
  );
  expect(terminated.termination).not.toBeNull();
  expect(() =>
    foldTransition(
      terminated,
      transition(
        'accounting_observed',
        {
          execution_attempt_id:
            primary.attempts[0]!.identity.execution_attempt_id,
          stopped: observation(primary, 0, 8).stopped,
          artifacts: [],
          evidence_missing: 'not published',
        },
        8,
      ),
    ),
  ).toThrow();
});

test('cancel end requires authenticated reference and stopped workers', () => {
  const f = replacementFixture();
  const state = f.transitions.reduce(
    foldTransition,
    initialProjection(f.experiment),
  );
  expect(() =>
    foldTransition(
      state,
      transition(
        'ended',
        { outcome: 'cancelled', reason: 'operator', cancel_intent: null },
        9,
      ),
    ),
  ).toThrow();
  expect(
    foldTransition(
      state,
      transition(
        'ended',
        {
          outcome: 'cancelled',
          reason: 'operator',
          cancel_intent: evidenceRef,
        },
        9,
      ),
    ).ended?.outcome,
  ).toBe('cancelled');
});

test('V2 schemas reject removed policy fields, ragged slots, and unsafe references', () => {
  const e = twoArmExperiment();
  expect(SuiteSchema.safeParse({ ...e.suite, budget_usd: 5 }).success).toBe(
    false,
  );
  expect(
    SuiteSchema.safeParse({ ...e.suite, reserve: undefined }).success,
  ).toBe(false);
  expect(
    SuiteSchema.safeParse({
      ...e.suite,
      attempt_bounds: { max_attempts: 1, max_time_s: Infinity },
    }).success,
  ).toBe(false);
  expect(
    ExperimentSchema.safeParse({
      ...e,
      planned_slots: e.planned_slots.slice(1),
    }).success,
  ).toBe(false);
  for (const path of [
    '/etc/passwd',
    '../other/outcome.json',
    'a/../b',
    'a//b',
    'C:\\secret',
    'a\\b',
  ])
    expect(ArtifactRefSchema.safeParse({ ...evidenceRef, path }).success).toBe(
      false,
    );
});

test('runtime records freeze public values and reject credential values', () => {
  const e = twoArmExperiment();
  const intent = blockActivation(e).attempts[0]!;
  const spec = intent.runtime_spec;
  expect(
    AttemptRuntimeSpecSchema.safeParse({ ...spec, public_env: undefined })
      .success,
  ).toBe(false);
  expect(
    AttemptRuntimeSpecSchema.safeParse({
      ...spec,
      public_env: { ...spec.public_env, ANTHROPIC_API_KEY: 'secret' },
    }).success,
  ).toBe(false);
  expect(
    AttemptRuntimeSpecSchema.safeParse({ ...spec, labels: undefined }).success,
  ).toBe(false);
  expect(
    AttemptRuntimeSpecSchema.safeParse({ ...spec, entrypoint: undefined })
      .success,
  ).toBe(false);
});

test('registration rejects normalized suite/cell disagreement', () => {
  const e = twoArmExperiment();
  e.suite.comparisons[0]!.n = 2;
  expect(ExperimentSchema.safeParse(e).success).toBe(false);
});

test('registration rejects duplicate comparison arms even in unused entries', () => {
  const e = twoArmExperiment();
  e.comparisons.push({
    comparison_id: 'unused',
    baseline: 'base',
    treatment: 'base',
  });
  expect(ExperimentSchema.safeParse(e).success).toBe(false);
});

test('registration rejects unresolved selectors in the frozen document', () => {
  const e = twoArmExperiment();
  e.suite.comparisons[0]!.scenarios = 'tier=full';
  expect(ExperimentSchema.safeParse(e).success).toBe(false);
});

test.each([
  'label',
  'output root',
])('authenticated runtime rejects another attempt %s', (field) => {
  const e = twoArmExperiment();
  const state = sessionTransitions(e).reduce(
    foldTransition,
    initialProjection(e),
  );
  const activation = blockActivation(e);
  const intent = activation.attempts[0]!;
  if (field === 'label')
    intent.runtime_spec.labels['quorum.attempt_id'] = 'other';
  else
    intent.runtime_spec.public_env.QUORUM_ATTEMPT_DIR =
      '/campaign/attempts/other';
  intent.runtime_spec_digest = sha256Hex(jcsCanonicalize(intent.runtime_spec));
  expect(() =>
    foldTransition(state, transition('block_activated', activation, 3)),
  ).toThrow();
});

test('replacement reserve belongs to the primary cell and is consumed once', () => {
  const f = replacementFixture();
  const closed = f.transitions
    .slice(0, 6)
    .reduce(foldTransition, initialProjection(f.experiment));
  const wrong = structuredClone(f.successor);
  wrong.reserve_id = 'foreign-reserve';
  expect(() =>
    foldTransition(
      closed,
      transition(
        'block_replaced',
        { activation: wrong, reason: 'grader_rate_limited' },
        6,
      ),
    ),
  ).toThrow();
  const replaced = foldTransition(closed, f.transitions[6]!);
  expect(replaced.consumed_reserves.has('reserve')).toBe(true);
  expect(closed.consumed_reserves.size).toBe(0);
  expect(() =>
    foldTransition(replaced, {
      ...f.transitions[6]!,
      transition_id: 'second-replacement',
    }),
  ).toThrow();
});

test('failed observation transaction leaves the accepted sibling and maps untouched', () => {
  const { state, primary } = active();
  const good = foldTransition(
    state,
    transition(
      'attempt_observed',
      { observation: observation(primary, 0, 4), excluded_block: null },
      4,
    ),
  );
  const bad = observation(primary, 1, 5, {
    validity: 'unknown',
    outcome: 'indeterminate',
  });
  expect(() =>
    foldTransition(
      good,
      transition(
        'attempt_observed',
        {
          observation: bad,
          excluded_block: { block_id: 'foreign', reason: 'missing_telemetry' },
        },
        5,
      ),
    ),
  ).toThrow();
  expect(
    good.attempts.get(primary.attempts[0]!.identity.execution_attempt_id)
      ?.observation?.outcome,
  ).toBe('pass');
  expect(
    good.attempts.get(primary.attempts[1]!.identity.execution_attempt_id)
      ?.observation,
  ).toBeNull();
  expect(good.blocks.get('primary')?.excluded).toBeNull();
});

test('fresh transitions cannot move the journal clock backward', () => {
  const { state, primary } = active();
  expect(() =>
    foldTransition(
      state,
      transition(
        'accounting_observed',
        {
          execution_attempt_id:
            primary.attempts[0]!.identity.execution_attempt_id,
          stopped: observation(primary, 0, 2).stopped,
          artifacts: [],
          evidence_missing: 'not recorded',
        },
        2,
      ),
    ),
  ).toThrow();
});
