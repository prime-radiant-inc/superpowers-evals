import {
  jcsCanonicalize,
  sha256Hex,
} from '../../../src/contracts/campaign/digest.ts';
import type {
  AttemptObservation,
  BlockActivation,
  CampaignTransition,
} from '../../../src/contracts/campaign/execution.ts';
import {
  type Experiment,
  ExperimentSchema,
} from '../../../src/contracts/campaign/experiment.ts';

export const fixtureTime = (second = 0) =>
  new Date(Date.UTC(2026, 8, 4, 0, 0, second)).toISOString();
export const evidenceRef = {
  path: 'audit.json',
  sha256: 'a'.repeat(64),
  bytes: 12,
};
export function twoArmExperiment(): Experiment {
  return ExperimentSchema.parse({
    schema_version: 2,
    campaign_id: 'campaign-one',
    input_digest: 'a'.repeat(64),
    suite: {
      schema_version: 2,
      name: 'comparison',
      comparisons: [
        {
          baseline: 'base',
          treatment: 'candidate',
          scenarios: ['scenario'],
          n: 1,
        },
      ],
      reserve: 1,
      max_exposure_skew: 2,
      attempt_bounds: { max_attempts: 2, max_time_s: 60 },
    },
    refs: {
      superpowers_by_arm: { base: 'b'.repeat(40), candidate: 'c'.repeat(40) },
      evals: 'd'.repeat(40),
      gauntlet: 'e'.repeat(40),
    },
    grader: { credential: 'grader', model: 'model' },
    cells: [
      {
        scenario: 'scenario',
        comparison_id: 'comparison',
        arms: ['base', 'candidate'],
        n: 1,
        coupling: 'arm-independent',
      },
    ],
    excluded_cells: [],
    comparisons: [
      { comparison_id: 'comparison', baseline: 'base', treatment: 'candidate' },
    ],
    planned_slots: ['base', 'candidate'].map((arm) => ({
      sample_id: `sample-${arm}`,
      primary_block_id: 'primary',
      comparison_id: 'comparison',
      scenario: 'scenario',
      arm,
      replicate: 1,
    })),
    reserve_slots: [
      {
        reserve_id: 'reserve',
        comparison_id: 'comparison',
        scenario: 'scenario',
      },
    ],
    execution_surface: ['base', 'candidate'].map((name) => ({
      name,
      agent: 'claude',
      credential: 'subject',
      auth: 'api-key',
      api: 'anthropic',
      model: 'model',
      key_env_names: ['ANTHROPIC_API_KEY'],
    })),
    credential_authority_digest: 'f'.repeat(64),
    pool_policy: [
      { pool_id: 'subject', max_concurrency: 2, launch_spacing_seconds: 0 },
    ],
    contention: {
      host_fingerprint: {
        cpu_model: 'fixture',
        cpu_cores: 4,
        mem_bytes: 4096,
        disk_total_bytes: 8192,
      },
      global_run_cap: 2,
      thresholds: [{ metric: 'load', source: 'host', op: 'gt', value: 3 }],
      cadence_ms: 100,
      sustain_k: 2,
      coverage_n: 2,
      mem_tolerance_pct: 10,
      disk_tolerance_pct: 10,
    },
    runtime_limits: { max_time_s: 60, graceful_shutdown_s: 5 },
    registered_at: fixtureTime(),
    registered_by: 'fixture',
  });
}
export function transition<T extends CampaignTransition['type']>(
  type: T,
  payload: Extract<CampaignTransition, { type: T }>['payload'],
  second = 0,
  id = `${type}-${second}`,
): Extract<CampaignTransition, { type: T }> {
  // The builder's discriminant and payload are correlated in its public signature.
  return {
    transition_id: id,
    at: fixtureTime(second),
    type,
    payload,
  } as Extract<CampaignTransition, { type: T }>;
}
export const startTransition = (experiment: Experiment, second = 1) =>
  transition(
    'started',
    {
      campaign_id: experiment.campaign_id,
      input_digest: experiment.input_digest,
      start_id: 'start',
      launcher: { pid: 101, birth: 'birth', boot_id: 'boot' },
      claimed_at: fixtureTime(second),
    },
    second,
  );
export function sessionTransitions(
  experiment: Experiment,
): CampaignTransition[] {
  return [
    transition('registered', {
      campaign_id: experiment.campaign_id,
      input_digest: experiment.input_digest,
    }),
    startTransition(experiment),
    transition(
      'controller_bound',
      {
        start_id: 'start',
        controller: { pid: 102, birth: 'controller', boot_id: 'boot' },
      },
      2,
    ),
  ];
}
export function blockActivation(
  experiment: Experiment,
  successor = false,
): BlockActivation {
  const blockId = successor ? 'successor' : 'primary';
  return {
    block_id: blockId,
    primary_block_id: 'primary',
    reserve_id: successor ? 'reserve' : null,
    predecessor_block_id: successor ? 'primary' : null,
    attempts: experiment.planned_slots.map((slot) => {
      const attemptId = `${slot.sample_id}-${successor ? 2 : 1}`;
      const root = `/campaign/attempts/${attemptId}`;
      const spec = {
        image_digest: `sha256:${'a'.repeat(64)}`,
        credential_projection: {
          path: '/run/quorum/credentials.yaml',
          sha256: 'd'.repeat(64),
        },
        command: 'bun',
        args: ['run', 'quorum'],
        cwd: root,
        user: { uid: 1000, gid: 1000 },
        mounts: [{ source: root, target: root, mode: 'rw' as const }],
        public_env: {
          HOME: `${root}/home`,
          TMPDIR: '/run/quorum/attempt' as const,
          TMUX_TMPDIR: '/run/quorum/attempt' as const,
          XDG_CONFIG_HOME: `${root}/home/.config`,
          XDG_CACHE_HOME: `${root}/home/.cache`,
          XDG_STATE_HOME: `${root}/home/.local/state`,
          QUORUM_COVERED_BY_LIVE_SPEND_LOCK: '1' as const,
          QUORUM_GRADER_SOURCE_MODE: 'appliance-scoped' as const,
          QUORUM_ATTEMPT_DIR: root,
          QUORUM_SUBJECT_FILE: '/run/quorum/subject.env' as const,
          QUORUM_GRADER_FILE: '/run/quorum/grader.env' as const,
          QUORUM_ATTEMPT_AUTHORITY_FILE: `${root}/authority.json`,
        },
        entrypoint: [],
        labels: {
          'quorum.campaign_id': experiment.campaign_id,
          'quorum.attempt_id': attemptId,
          'quorum.evals_sha': experiment.refs.evals,
          'quorum.image_digest': `sha256:${'a'.repeat(64)}`,
        },
        init: true as const,
        restart: 'no' as const,
        pid_namespace: 'private' as const,
        ipc_namespace: 'private' as const,
        privileged: false as const,
        no_new_privileges: true as const,
        tmpfs_bytes: 1024,
        max_time_s: experiment.runtime_limits.max_time_s,
        graceful_shutdown_s: 5 as const,
      };
      return {
        identity: {
          campaign_id: experiment.campaign_id,
          comparison_id: slot.comparison_id,
          block_id: blockId,
          sample_id: slot.sample_id,
          execution_attempt_id: attemptId,
        },
        primary_block_id: slot.primary_block_id,
        attempt_number: successor ? 2 : 1,
        output_root: root,
        container_name: attemptId,
        runtime_spec_digest: sha256Hex(jcsCanonicalize(spec)),
        runtime_spec: spec,
      };
    }),
  };
}
export function observation(
  block: BlockActivation,
  index: number,
  second: number,
  patch: Partial<AttemptObservation> = {},
): AttemptObservation {
  const id = block.attempts[index]!.identity.execution_attempt_id;
  return {
    execution_attempt_id: id,
    stopped: {
      execution_attempt_id: id,
      container_id: null,
      proof: 'never_created',
      observed_at: fixtureTime(second),
    },
    outcome: 'pass',
    failure_class: 'evidence',
    cause: null,
    artifacts: [evidenceRef],
    evidence_missing: null,
    validity: 'valid',
    ...patch,
  };
}
export function replacementFixture() {
  const experiment = twoArmExperiment();
  const primary = blockActivation(experiment);
  const successor = blockActivation(experiment, true);
  const transitions: CampaignTransition[] = [
    ...sessionTransitions(experiment),
    transition('block_activated', primary, 3),
    transition(
      'attempt_observed',
      { observation: observation(primary, 0, 4), excluded_block: null },
      4,
    ),
    transition(
      'attempt_observed',
      {
        observation: observation(primary, 1, 5, {
          outcome: 'indeterminate',
          failure_class: 'instrument',
          cause: 'grader_rate_limited',
        }),
        excluded_block: null,
      },
      5,
    ),
    transition(
      'block_replaced',
      { activation: successor, reason: 'grader_rate_limited' },
      6,
    ),
    transition(
      'attempt_observed',
      { observation: observation(successor, 0, 7), excluded_block: null },
      7,
    ),
    transition(
      'attempt_observed',
      {
        observation: observation(successor, 1, 8, { outcome: 'indeterminate' }),
        excluded_block: null,
      },
      8,
    ),
  ];
  return { experiment, primary, successor, transitions };
}
