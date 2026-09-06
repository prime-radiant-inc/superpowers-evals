import { describe, expect, test } from 'bun:test';
import {
  type ObserverBinding,
  observerRequiredForAttempt,
  observerRequiredForScenario,
  validateObserverBinding,
} from '../src/experiments/observer/binding.ts';
import { twoArmExperiment } from './fixtures/core-comparison/factory.ts';

function binding(): ObserverBinding {
  return {
    schema_version: 2,
    run_id: 'run',
    campaign: null,
    runtime: 'codex',
    dialect: 'codex-jsonl',
    cli_version: '1.0',
    home: '/private/run/home',
    workdir: '/private/run/workdir',
    launch_cwd: '/private/run/workdir',
    roots: [
      {
        id: 'sessions',
        kind: 'transcripts',
        path: '/private/run/home/.codex/sessions',
      },
      { id: 'documents', kind: 'artifacts', path: '/private/run/workdir' },
    ],
    phase: 'bound',
    parent_source_id: 'parent',
    sources: [
      {
        source: {
          source_id: 'parent',
          runtime: 'codex',
          expected_session_id: 'session',
          expected_cwd: '/private/run/workdir',
          expected_cli_version: '1.0',
        },
        root_id: 'sessions',
        relative_path: 'parent.jsonl',
        device: '1',
        inode: '2',
        parent_link: null,
      },
    ],
  };
}

function attempt(required = true) {
  const experiment = twoArmExperiment();
  if (required) {
    const scenario = 'brainstorming-todo-shared-intent';
    experiment.suite.comparisons[0]!.scenarios = [scenario];
    experiment.cells[0]!.scenario = scenario;
    for (const slot of experiment.planned_slots) slot.scenario = scenario;
    experiment.reserve_slots = [];
    experiment.suite.reserve = 0;
    experiment.suite.attempt_bounds.max_attempts = 1;
  }
  return {
    experiment,
    identity: {
      campaign_id: experiment.campaign_id,
      comparison_id: 'comparison',
      block_id: 'primary',
      sample_id: 'sample-base',
      execution_attempt_id: 'sample-base:a1',
    },
  };
}

describe('authoritative observer binding', () => {
  test('round-trips selected and unbound identities', () => {
    expect(validateObserverBinding(binding()).parent_source_id).toBe('parent');
    expect(
      validateObserverBinding({
        ...binding(),
        phase: 'unbound',
        parent_source_id: null,
        sources: [],
      }).phase,
    ).toBe('unbound');
  });
  test('binds nested launch cwd while retaining the artifact workdir', () => {
    const candidate = binding();
    candidate.launch_cwd += '/nested';
    candidate.sources[0]!.source.expected_cwd = candidate.launch_cwd;
    expect(validateObserverBinding(candidate).roots[1]!.path).toBe(
      '/private/run/workdir',
    );
    candidate.launch_cwd = '/foreign';
    candidate.sources[0]!.source.expected_cwd = '/foreign';
    expect(() => validateObserverBinding(candidate)).toThrow();
  });
  test('refuses incomplete V2 bindings', () => {
    expect(() => validateObserverBinding({ schema_version: 2 })).toThrow();
  });
  test.each([
    '../parent.jsonl',
    '/parent.jsonl',
    'x//parent.jsonl',
    'x/./parent.jsonl',
  ])('refuses escaped source path %s', (path) => {
    const candidate = binding();
    candidate.sources[0]!.relative_path = path;
    expect(() => validateObserverBinding(candidate)).toThrow();
  });
  test('refuses ambiguous parent selection and duplicate source locations', () => {
    const candidate = binding();
    candidate.sources.push({
      ...candidate.sources[0]!,
      source: { ...candidate.sources[0]!.source, source_id: 'other' },
    });
    expect(() => validateObserverBinding(candidate)).toThrow();
  });
  test('refuses a source from another runtime, cwd or build', () => {
    for (const change of [
      { runtime: 'claude' },
      { expected_cwd: '/other' },
      { expected_cli_version: 'other' },
    ]) {
      const candidate = binding();
      Object.assign(candidate.sources[0]!.source, change);
      expect(() => validateObserverBinding(candidate)).toThrow();
    }
  });
  test('requires transcript roots below home and one artifact root at workdir', () => {
    for (const path of [
      '/private/run/home',
      '/private/run/workdir',
      '/foreign/sessions',
    ]) {
      const candidate = binding();
      candidate.roots[0]!.path = path;
      expect(() => validateObserverBinding(candidate)).toThrow();
    }
  });
  test('requires a coherent acyclic descendant link to the parent', () => {
    const candidate = binding();
    candidate.sources.push({
      ...candidate.sources[0]!,
      relative_path: 'child.jsonl',
      inode: '3',
      source: {
        ...candidate.sources[0]!.source,
        source_id: 'child',
        expected_session_id: 'child-session',
      },
      parent_link: {
        source_id: 'parent',
        call: { source_id: 'parent', line: 1, block: null },
        join: null,
      },
    });
    expect(validateObserverBinding(candidate).sources).toHaveLength(2);
    candidate.sources[1]!.parent_link!.call.source_id = 'child';
    expect(() => validateObserverBinding(candidate)).toThrow();
  });
});

describe('frozen observer requirement', () => {
  test('required scenario stays required without a candidate bundle', () => {
    expect(
      observerRequiredForScenario('brainstorming-todo-shared-intent'),
    ).toBe(true);
    const { experiment, identity } = attempt();
    expect(observerRequiredForAttempt(experiment, identity)).toBe(true);
  });
  test('rejects every conflicting identity field', () => {
    const { experiment, identity } = attempt();
    for (const field of Object.keys(identity)) {
      expect(() =>
        observerRequiredForAttempt(experiment, {
          ...identity,
          [field]: 'other',
        }),
      ).toThrow();
    }
  });
  test('rejects missing and ambiguous frozen selections', () => {
    const { experiment, identity } = attempt();
    experiment.planned_slots.push(experiment.planned_slots[0]!);
    expect(() => observerRequiredForAttempt(experiment, identity)).toThrow();
    experiment.planned_slots = [];
    expect(() => observerRequiredForAttempt(experiment, identity)).toThrow();
  });
  test('rejects a missing execution arm and unsupported required lineage', () => {
    const { experiment, identity } = attempt();
    experiment.execution_surface = [];
    expect(() => observerRequiredForAttempt(experiment, identity)).toThrow();
    const other = attempt(false);
    for (const slot of other.experiment.planned_slots)
      slot.scenario = 'brainstorming-todo-shared-intent';
    other.experiment.cells[0]!.scenario = 'brainstorming-todo-shared-intent';
    other.experiment.suite.comparisons[0]!.scenarios = [
      'brainstorming-todo-shared-intent',
    ];
    other.experiment.reserve_slots[0]!.scenario =
      'brainstorming-todo-shared-intent';
    expect(() =>
      observerRequiredForAttempt(other.experiment, other.identity),
    ).toThrow();
  });
  test('leaves non-observer reserve and rerun identities to campaign authentication', () => {
    const { experiment, identity } = attempt(false);
    expect(
      observerRequiredForAttempt(experiment, {
        ...identity,
        block_id: 'reserve',
        execution_attempt_id: 'sample-base:a2',
      }),
    ).toBe(false);
  });
});
