import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  assertCredentialAuthority,
  assertIdComponent,
  attemptIdOf,
  cellKeyOf,
  comparisonId,
  credentialAuthorityDigest,
  type RegistrationInput as ExperimentRegistrationInput,
  prepareRegistration as prepareExperimentRegistration,
  primaryBlockId,
  primarySampleId,
  RegistrationError,
  reserveBlockId,
  reserveSampleId,
  type ScenarioIntake,
} from '../src/campaign/registration.ts';
import type { Arm } from '../src/contracts/campaign/arm.ts';
import { ExperimentSchema } from '../src/contracts/campaign/experiment.ts';
import { experimentDigest } from '../src/contracts/campaign/experiment-digest.ts';
import type { Credential } from '../src/contracts/credential.ts';
import {
  EXPERIMENT_SUITE_RAW,
  experimentRegisterArgs,
  probeRunner,
} from './fixtures/core-comparison/registration.ts';
import {
  subprocessTraceDir,
  traceError,
  writeSubprocessTrace,
} from './fixtures/subprocess-trace.ts';

function experimentInput(
  overrides: Partial<ExperimentRegistrationInput> = {},
): ExperimentRegistrationInput {
  return {
    suite: {
      schema_version: 2,
      name: 'finite_comparison',
      comparisons: [
        {
          baseline: 'arm_a',
          treatment: 'arm_b',
          scenarios: ['scn-a'],
          n: 1,
        },
      ],
      reserve: 1,
      max_exposure_skew: 30,
      attempt_bounds: { max_attempts: 2, max_time_s: 5400 },
    },
    arms: {
      arm_a: arm('arm_a'),
      arm_b: arm('arm_b', { credential: 'cred_b' }),
    },
    credentials: {
      cred_a: credential({
        max_concurrency: 8,
        api_key_env: 'DEFINITELY_UNSET_SECRET_A',
      }),
      cred_b: credential({
        max_concurrency: 8,
        api_key_env: 'DEFINITELY_UNSET_SECRET_B',
      }),
    },
    grader: { credential: 'cred_a', model: 'test-model' },
    refs: {
      superpowers_by_arm: { arm_a: null, arm_b: null },
      evals: 'a'.repeat(40),
      gauntlet: 'b'.repeat(40),
    },
    scenarios: [scenario('scn-a')],
    capability: () => ({ ref: true, none: true }),
    agentOsSupport: () => ['linux'],
    agentFamily: () => 'claude',
    agentMaxTime: () => undefined,
    campaignOs: 'linux',
    globalCap: 8,
    contention: {
      host_fingerprint: {
        cpu_model: 'fixture',
        cpu_cores: 8,
        mem_bytes: 16 * 2 ** 30,
        disk_total_bytes: 100 * 2 ** 30,
      },
      global_run_cap: 8,
      thresholds: [{ metric: 'load', source: 'host', op: 'gt', value: 4 }],
      cadence_ms: 1000,
      sustain_k: 2,
      coverage_n: 2,
      mem_tolerance_pct: 10,
      disk_tolerance_pct: 10,
    },
    registeredAt: '2026-09-04T12:00:00.000Z',
    registeredBy: 'test',
    ...overrides,
  };
}

test('V2 preparation is price independent and reserve does not expand planned samples', () => {
  const prepared = prepareExperimentRegistration(experimentInput());

  expect(prepared.planned_slots.map((slot) => slot.sample_id)).toEqual([
    'c1:scn-a:arm_a:r1',
    'c1:scn-a:arm_b:r1',
  ]);
  expect(prepared.reserve_slots).toEqual([
    { reserve_id: 'c1:scn-a:x1', comparison_id: 'c1', scenario: 'scn-a' },
  ]);
  expect(prepared.estimates).toBeUndefined();
});

test('V2 configuration validation does not require secret values', () => {
  expect(() => prepareExperimentRegistration(experimentInput())).not.toThrow();
});

test('V2 grader must name the model owned by its selected credential', () => {
  expect(() =>
    prepareExperimentRegistration(
      experimentInput({
        grader: { credential: 'cred_a', model: 'test-model' },
      }),
    ),
  ).not.toThrow();
  expect(() =>
    prepareExperimentRegistration(
      experimentInput({
        grader: { credential: 'cred_a', model: 'different-model' },
      }),
    ),
  ).toThrow(/grader model different-model.*credential cred_a.*test-model/);
});

test('V2 Linux preparation excludes an explicit Darwin arm before compatibility checks', () => {
  const base = experimentInput();
  const prepared = prepareExperimentRegistration(
    experimentInput({
      suite: {
        ...base.suite,
        comparisons: [
          { arm: 'arm_a', scenarios: ['darwin-only'], n: 1 },
          { arm: 'arm_b', scenarios: ['linux-valid'], n: 1 },
        ],
      },
      arms: {
        arm_a: arm('arm_a', { os: 'darwin' }),
        arm_b: arm('arm_b', { credential: 'cred_b' }),
      },
      grader: { credential: 'cred_a', model: 'test-model' },
      scenarios: [
        scenario('darwin-only', { os: ['darwin'] }),
        scenario('linux-valid', { os: ['linux'] }),
      ],
      agentOsSupport: () => ['linux', 'darwin'],
    }),
  );

  expect(prepared.cells.map((cell) => cell.scenario)).toEqual(['linux-valid']);
  expect(prepared.excluded_cells).toEqual([
    {
      cell: 'c1:darwin-only',
      reason: expect.stringMatching(/arm arm_a.*darwin.*campaign.*linux/),
    },
  ]);
});

// An eligible control keeps the denominator observable when either paired arm
// is incompatible: exclusion must remove the whole cell, including reserves.
test.each([
  [
    'stock adapter',
    {
      capability: (family: string) => ({ ref: true, none: family !== 'codex' }),
    },
    /arm arm_b.*adapter capability/,
  ],
  [
    'ref adapter',
    {
      arms: {
        arm_a: arm('arm_a'),
        arm_b: arm('arm_b', {
          agent: 'codex',
          credential: 'cred_b',
          superpowers: 'pinned-ref',
        }),
      },
      refs: {
        evals: 'a'.repeat(40),
        gauntlet: 'b'.repeat(40),
        superpowers_by_arm: { arm_a: null, arm_b: 'c'.repeat(40) },
      },
      capability: (family: string) => ({ ref: family !== 'codex', none: true }),
    },
    /arm arm_b.*adapter capability/,
  ],
  [
    'credential OS',
    {
      credentials: {
        cred_a: credential(),
        cred_b: credential({ harnesses: ['codex'], os_support: ['darwin'] }),
      },
    },
    /arm arm_b.*unsupported by credential cred_b/,
  ],
  [
    'agent OS',
    {
      agentOsSupport: (agent: string) =>
        agent === 'codex' ? ['darwin'] : ['linux'],
    },
    /arm arm_b.*unsupported by agent codex/,
  ],
  [
    'credential harness',
    { credentials: { cred_a: credential(), cred_b: credential() } },
    /cred_b.*does not support harness codex/,
  ],
  [
    'scenario OS',
    {
      scenarios: [scenario('paired', { os: ['darwin'] }), scenario('control')],
    },
    /unsupported by scenario paired/,
  ],
  [
    'restrictive directive',
    {
      scenarios: [
        scenario('paired', { coding_agents: ['claude'] }),
        scenario('control'),
      ],
    },
    /agent codex.*coding-agents directive/,
  ],
  [
    'empty directive',
    {
      scenarios: [
        scenario('paired', { coding_agents: [] }),
        scenario('control'),
      ],
    },
    /agent claude.*coding-agents directive/,
  ],
  [
    'accepted directives',
    {
      scenarios: [
        scenario('paired', {
          os: ['linux'],
          coding_agents: ['claude', 'codex'],
        }),
        scenario('control'),
      ],
    },
    null,
  ],
] as const)('V2 paired eligibility: %s', (_name, overrides, reason) => {
  const base = experimentInput();
  const prepared = prepareExperimentRegistration(
    experimentInput({
      suite: {
        ...base.suite,
        comparisons: [
          {
            baseline: 'arm_a',
            treatment: 'arm_b',
            scenarios: ['paired'],
            n: 1,
          },
          { arm: 'arm_a', scenarios: ['control'], n: 1 },
        ],
      },
      arms: {
        arm_a: arm('arm_a'),
        arm_b: arm('arm_b', { agent: 'codex', credential: 'cred_b' }),
      },
      credentials: {
        cred_a: credential(),
        cred_b: credential({ harnesses: ['codex'] }),
      },
      agentFamily: (agent) => agent,
      scenarios: [scenario('paired'), scenario('control')],
      ...overrides,
    }),
  );
  expect(prepared.excluded_cells).toEqual(
    reason === null
      ? []
      : [{ cell: 'c1:paired', reason: expect.stringMatching(reason) }],
  );
  expect(
    prepared.cells.map((cell) => `${cell.comparison_id}:${cell.scenario}`),
  ).toEqual(reason === null ? ['c1:paired', 'c2:control'] : ['c2:control']);
  expect(prepared.planned_slots.map((slot) => slot.sample_id)).toEqual([
    ...(reason === null ? ['c1:paired:arm_a:r1', 'c1:paired:arm_b:r1'] : []),
    'c2:control:arm_a:r1',
  ]);
  expect(prepared.reserve_slots.map((slot) => slot.reserve_id)).toEqual(
    reason === null ? ['c1:paired:x1', 'c2:control:x1'] : ['c2:control:x1'],
  );
});

test('V2 preparation refuses a non-Linux campaign target', () => {
  expect(() =>
    prepareExperimentRegistration(
      experimentInput({
        campaignOs: 'darwin',
        grader: { credential: 'cred_a', model: 'test-model' },
        agentOsSupport: () => ['darwin'],
      }),
    ),
  ).toThrow(/campaign target darwin.*Linux-only/);
});

test('V2 credential authority is order-independent and rejects public mutation', () => {
  const input = experimentInput({
    credentials: {
      cred_a: credential({ quota_pool: 'shared', max_concurrency: 8 }),
      cred_b: credential({ max_concurrency: 8 }),
      shared_alias: credential({ quota_pool: 'shared', max_concurrency: 6 }),
    },
  });
  const prepared = prepareExperimentRegistration(input);
  const experiment = {
    ...prepared,
    campaign_id: 'campaign',
    input_digest: '0'.repeat(64),
    registered_at: input.registeredAt,
    registered_by: input.registeredBy,
  };
  const reversed = Object.fromEntries(
    Object.entries(input.credentials).reverse(),
  );

  expect(credentialAuthorityDigest(reversed, ['cred_b', 'cred_a'])).toBe(
    prepared.credential_authority_digest,
  );
  expect(() => assertCredentialAuthority(reversed, experiment)).not.toThrow();
  expect(() =>
    assertCredentialAuthority(
      {
        ...input.credentials,
        shared_alias: credential({ quota_pool: 'shared', max_concurrency: 5 }),
      },
      experiment,
    ),
  ).toThrow(/public credential authority changed/);
});

test('V2 preparation requires an authenticated source ref for each ref arm', () => {
  const base = experimentInput();
  const input = experimentInput({
    arms: {
      ...base.arms,
      arm_a: arm('arm_a', { superpowers: 'release-ref' }),
    },
    refs: {
      ...base.refs,
      superpowers_by_arm: { arm_b: null },
    },
  });

  expect(() => prepareExperimentRegistration(input)).toThrow(
    /arm arm_a.*resolved superpowers source ref/,
  );
});

test('V2 preparation freezes supplied scheduling estimates in its input digest', () => {
  const without = prepareExperimentRegistration(experimentInput());
  const withEstimate = prepareExperimentRegistration(
    experimentInput({
      estimates: {
        'scn-a': {
          arm_a: { duration_s: 20, cost_usd: 0, confidence: 'low' },
        },
      },
    }),
  );
  const stamp = (prepared: typeof without) => ({
    ...prepared,
    campaign_id: 'campaign',
    input_digest: '0'.repeat(64),
    registered_at: '2026-09-04T12:00:00.000Z',
    registered_by: 'test',
  });

  expect(experimentDigest(stamp(withEstimate))).not.toBe(
    experimentDigest(stamp(without)),
  );
});

test('the pinned ID derivation table', () => {
  const cmp = comparisonId(1);
  expect(cmp).toBe('c1');
  const cell = cellKeyOf(cmp, 'sdd-escalates');
  expect(cell).toBe('c1:sdd-escalates');
  expect(primarySampleId(cell, 'claude-sp', 3)).toBe(
    'c1:sdd-escalates:claude-sp:r3',
  );
  expect(primaryBlockId(cell, 3)).toBe('c1:sdd-escalates:b3');
  expect(reserveBlockId(cell, 2)).toBe('c1:sdd-escalates:x2');
  expect(reserveSampleId(cell, 'claude-sp', 2)).toBe(
    'c1:sdd-escalates:claude-sp:x2',
  );
  expect(attemptIdOf('c1:sdd-escalates:claude-sp:r3', 2)).toBe(
    'c1:sdd-escalates:claude-sp:r3:a2',
  );
});

test('ID components outside the pinned grammar reject; ":" never passes', () => {
  expect(() => assertIdComponent('ok-name.x_1', 'scenario name')).not.toThrow();
  expect(() => assertIdComponent('has:colon', 'scenario name')).toThrow(
    RegistrationError,
  );
  expect(() => assertIdComponent('Upper', 'arm name')).toThrow(
    RegistrationError,
  );
  expect(() => assertIdComponent('-lead', 'scenario name')).toThrow(
    RegistrationError,
  );
  expect(() => assertIdComponent('', 'suite name')).toThrow(RegistrationError);
  expect(() => cellKeyOf('c1', 'bad:scenario')).toThrow(RegistrationError);
});

test('numeric parameters outside the 1-based positive-integer domain reject', () => {
  expect(() => comparisonId(0)).toThrow(RegistrationError);
  expect(() => comparisonId(-1)).toThrow(RegistrationError);
  expect(() => comparisonId(1.5)).toThrow(RegistrationError);
  expect(() => comparisonId(Number.NaN)).toThrow(RegistrationError);
  expect(() => comparisonId(Number.POSITIVE_INFINITY)).toThrow(
    RegistrationError,
  );
  expect(() => primaryBlockId('c1:sdd-escalates', -1)).toThrow(
    RegistrationError,
  );
  expect(() => reserveBlockId('c1:sdd-escalates', 0)).toThrow(
    RegistrationError,
  );
  expect(() =>
    primarySampleId('c1:sdd-escalates', 'claude-sp', Number.NaN),
  ).toThrow(RegistrationError);
  expect(() => reserveSampleId('c1:sdd-escalates', 'claude-sp', 1.5)).toThrow(
    RegistrationError,
  );
  expect(() => attemptIdOf('c1:sdd-escalates:claude-sp:r3', -2)).toThrow(
    RegistrationError,
  );
});

test('prebuilt id inputs are shape-validated before interpolation', () => {
  // comparison id into a cell key: must be c<N>, N 1-based, single component.
  expect(() => cellKeyOf('1', 'sdd-escalates')).toThrow(RegistrationError);
  expect(() => cellKeyOf('c0', 'sdd-escalates')).toThrow(RegistrationError);
  expect(() => cellKeyOf('c1:extra', 'sdd-escalates')).toThrow(
    RegistrationError,
  );
  // cell key into block/sample constructors: exactly c<N>:<scenario>.
  expect(() => primaryBlockId('c1', 3)).toThrow(RegistrationError);
  expect(() =>
    primarySampleId('c1:sdd-escalates:extra', 'claude-sp', 3),
  ).toThrow(RegistrationError);
  expect(() => reserveSampleId('c1:', 'claude-sp', 2)).toThrow(
    RegistrationError,
  );
  // sample id into an attempt: cell:arm:r<N> or cell:arm:x<N>.
  expect(() => attemptIdOf('c1:sdd-escalates:claude-sp', 2)).toThrow(
    RegistrationError,
  );
  expect(() => attemptIdOf('c1:sdd-escalates:claude-sp:q3', 2)).toThrow(
    RegistrationError,
  );
  expect(attemptIdOf('c1:sdd-escalates:claude-sp:x2', 1)).toBe(
    'c1:sdd-escalates:claude-sp:x2:a1',
  );
});

const _CAPABLE = () => ({ ref: true, none: true });

// Fixture builders. Some call sites cast their override literal `as never`:
// exactOptionalPropertyTypes rejects an explicit `undefined` override (the
// deletion idiom, e.g. `api_key_env: undefined` to strip a default), and the
// cast admits exactly that — the builders' outputs are still exercised
// against the real zod schemas by the tests themselves.
function credential(overrides: Partial<Credential> = {}): Credential {
  return {
    model: 'test-model',
    harnesses: ['claude'],
    api: 'anthropic',
    auth: 'api-key',
    api_key_env: 'TEST_KEY',
    compat: {},
    max_concurrency: 15,
    ...overrides,
  } as Credential;
}

function arm(name: string, overrides: Partial<Arm> = {}): Arm {
  return {
    schema_version: 1,
    name,
    agent: 'claude',
    credential: 'cred_a',
    superpowers: 'none',
    ...overrides,
  } as Arm;
}

function scenario(
  name: string,
  overrides: Partial<ScenarioIntake> = {},
): ScenarioIntake {
  return {
    name,
    story: 'QA story',
    tier: 'full',
    requires_superpowers: false,
    coupling: 'arm-independent',
    os: undefined,
    coding_agents: undefined,
    ...overrides,
  };
}

import {
  buildContentionBlock,
  defaultContentionThresholds,
} from '../src/campaign/registration.ts';

const GiB = 2 ** 30;

test('the five pinned D-4 threshold defaults derive from the fingerprint', () => {
  const thresholds = defaultContentionThresholds({
    mem_bytes: 16 * GiB,
    swap_total_bytes: 4 * GiB,
    disk_total_bytes: 100 * GiB,
  });
  expect(thresholds).toEqual([
    { metric: 'load1_per_core', source: 'host', op: 'gt', value: 2.0 },
    {
      metric: 'mem_available_bytes',
      source: 'host',
      op: 'lt',
      value: Math.max(2 * GiB, 0.1 * 16 * GiB),
      relative_of: 'mem_bytes',
    },
    {
      metric: 'swap_used_bytes',
      source: 'host',
      op: 'gt',
      value: 0.25 * 4 * GiB,
      relative_of: 'swap_total_bytes',
    },
    {
      metric: 'disk_free_bytes',
      source: 'host',
      op: 'lt',
      value: Math.max(5 * GiB, 0.15 * 100 * GiB),
      relative_of: 'disk_total_bytes',
    },
    {
      metric: 'process_count',
      source: 'host',
      op: 'gt',
      value: 800_000,
      relative_of: 'pid_table',
    },
  ]);
});

test('a swapless host omits the swap threshold (0 would refuse the positive-value schema)', () => {
  // First-contact evidence: containerized campaign hosts report
  // swap_total_bytes 0; a 0.25 x 0 threshold value violates the
  // ContentionThreshold positive-value schema, and a swapless host cannot
  // experience swap contention — the evaluator judges only declared
  // thresholds, so omission is the honest declaration.
  const thresholds = defaultContentionThresholds({
    mem_bytes: 16 * GiB,
    swap_total_bytes: 0,
    disk_total_bytes: 100 * GiB,
  });
  expect(thresholds.map((t) => t.metric)).toEqual([
    'load1_per_core',
    'mem_available_bytes',
    'disk_free_bytes',
    'process_count',
  ]);
});

test('buildContentionBlock freezes G, thresholds, sampler parameters, tolerances (digest members)', () => {
  const block = buildContentionBlock({
    fingerprint: {
      cpu_model: 'Apple M1',
      cpu_cores: 8,
      mem_bytes: 16 * GiB,
      disk_total_bytes: 100 * GiB,
    },
    globalCap: 24,
    thresholds: defaultContentionThresholds({
      mem_bytes: 16 * GiB,
      swap_total_bytes: 4 * GiB,
      disk_total_bytes: 100 * GiB,
    }),
  });
  expect(block).toEqual({
    host_fingerprint: {
      cpu_model: 'Apple M1',
      cpu_cores: 8,
      mem_bytes: 16 * GiB,
      disk_total_bytes: 100 * GiB,
    },
    global_run_cap: 24,
    thresholds: block.thresholds,
    cadence_ms: 10_000,
    sustain_k: 3,
    coverage_n: 4,
    mem_tolerance_pct: 10,
    disk_tolerance_pct: 10,
  });
});

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { CommandRunner } from '../src/agents/command-runner.ts';
import { loadFrozenCampaign as loadExperiment } from '../src/campaign/campaign-document.ts';
import { readProjection } from '../src/campaign/execution-journal.ts';
import { registerCampaign as registerExperimentCampaign } from '../src/campaign/registration.ts';
import { sha256Hex } from '../src/contracts/campaign/digest.ts';

test('V2 registrations of identical inputs publish distinct IDs with equal input digests', () => {
  const args = experimentRegisterArgs();
  const first = registerExperimentCampaign(args);
  const second = registerExperimentCampaign(args);

  expect(first.experiment.comparison_request).toBeUndefined();
  expect(first.experiment.campaign_id).not.toBe(second.experiment.campaign_id);
  expect(first.experiment.input_digest).toBe(second.experiment.input_digest);
  expect(first.campaignDir).not.toBe(second.campaignDir);
  expect(existsSync(join(first.campaignDir, '.ballast'))).toBe(true);
  expect(loadExperiment(first.campaignDir)).toEqual(first.experiment);
  const projection = readProjection(first.campaignDir);
  expect(projection.registered).toBe(true);
  expect(projection.experiment.campaign_id).toBe(first.experiment.campaign_id);
}, 60_000);

test('registration verifies selected pricing after materialization and before journal publication', () => {
  const campaignId = 'pricing-registration';
  const args = experimentRegisterArgs({ campaignId: () => campaignId });
  const pricing = '{"as_of":"fixture","namespaces":{}}\n';
  mkdirSync(join(args.evalsCheckout, 'pricing'));
  writeFileSync(join(args.evalsCheckout, 'pricing', 'current.json'), pricing);
  const commit = spawnSync(
    'git',
    ['-C', args.evalsCheckout, 'add', 'pricing/current.json'],
    { encoding: 'utf8' },
  );
  expect(commit.status).toBe(0);
  const committed = spawnSync(
    'git',
    ['-C', args.evalsCheckout, 'commit', '-qm', 'pricing fixture'],
    { encoding: 'utf8' },
  );
  expect(committed.status).toBe(0);
  const rev = spawnSync(
    'git',
    ['-C', args.evalsCheckout, 'rev-parse', 'HEAD'],
    {
      encoding: 'utf8',
    },
  );
  expect(rev.status).toBe(0);
  const suiteRaw = EXPERIMENT_SUITE_RAW.replace(
    'grader:',
    `pricing_snapshot: { path: pricing/current.json, sha256: '${'0'.repeat(64)}' }\ngrader:`,
  );
  expect(sha256Hex(pricing)).not.toBe('0'.repeat(64));

  expect(() =>
    registerExperimentCampaign({
      ...args,
      evalsRef: rev.stdout.trim(),
      suiteRaw,
    }),
  ).toThrow(/pricing snapshot.*digest/i);
  const campaignDir = join(
    args.campaignsRoot,
    `${campaignId}-finite_comparison`,
  );
  expect(existsSync(join(campaignDir, 'journal.db'))).toBe(false);
  expect(existsSync(join(campaignDir, 'campaign.json'))).toBe(false);
});

test('V2 raw registration rejects unsupported grader fields', () => {
  const args = experimentRegisterArgs({
    suiteRaw: EXPERIMENT_SUITE_RAW.replace(
      'grader: { credential: cred_g, model: test-model }',
      'grader: { credential: cred_g, model: test-model, alias: unsupported }',
    ),
  });

  let message = '';
  try {
    registerExperimentCampaign(args);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain('invalid grader declaration');
  expect(message).toContain('alias');
});

test('registration refuses a source below the minimum child contract', () => {
  expect(() =>
    registerExperimentCampaign(
      experimentRegisterArgs({ runner: probeRunner(1) }),
    ),
  ).toThrow(/child.contract|minimum/i);
});

test('registration refuses materialized source bytes that differ from authenticated intake', () => {
  const args = experimentRegisterArgs();
  const delegate = args.runner;
  const runner: CommandRunner = {
    run(command, argv, options) {
      const result = delegate.run(command, argv, options);
      if (
        command === 'bun' &&
        argv.includes('install') &&
        options?.cwd?.startsWith(realpathSync(args.campaignsRoot)) &&
        options.cwd.endsWith('/evals')
      ) {
        writeFileSync(join(options.cwd, 'credentials.yaml'), 'tampered: {}\n');
      }
      return result;
    },
  };
  expect(() => registerExperimentCampaign({ ...args, runner })).toThrow(
    /drifted from intake bytes/,
  );
});

test('registration never overwrites an unexpected published document', () => {
  const args = experimentRegisterArgs();
  const delegate = args.runner;
  let interloper = '';
  const runner: CommandRunner = {
    run(command, argv, options) {
      const result = delegate.run(command, argv, options);
      if (
        command === 'bun' &&
        argv.includes('--version') &&
        options?.cwd?.startsWith(realpathSync(args.campaignsRoot)) &&
        options.cwd.endsWith('/evals')
      ) {
        interloper = join(options.cwd, '..', 'campaign.json');
        writeFileSync(interloper, 'interloper');
      }
      return result;
    },
  };
  expect(() => registerExperimentCampaign({ ...args, runner })).toThrow(
    /campaign.json already exists/,
  );
  expect(readFileSync(interloper, 'utf8')).toBe('interloper');
});

test.each([
  '# coding-agents: codex',
  '# coding-agents: ,',
  '# os: windows',
])('V2 freezes real checks.sh intake: %s', (directive) => {
  const traceDir = subprocessTraceDir('registration-intake');
  const real = probeRunner(0);
  let nextCallId = 0;
  const runner: CommandRunner = {
    run(command, argv, options) {
      const call_id = ++nextCallId;
      const started = performance.now();
      const operation = argv.find((part) =>
        [
          'init',
          'add',
          'commit',
          'rev-parse',
          'worktree',
          'show',
          'ls-tree',
          'merge-base',
          'install',
          '--version',
          'status',
          'diff',
        ].includes(part),
      );
      writeSubprocessTrace(traceDir, {
        event: 'start',
        call_id,
        command,
        operation,
        cwd: options?.cwd,
      });
      try {
        const result = real.run(command, argv, options);
        writeSubprocessTrace(traceDir, {
          event: 'end',
          call_id,
          elapsed_ms: performance.now() - started,
          status: result.status,
          ...(result.status === 0
            ? {}
            : { stderr: result.stderr.slice(0, 1024) }),
        });
        return result;
      } catch (error) {
        writeSubprocessTrace(traceDir, {
          event: 'throw',
          call_id,
          elapsed_ms: performance.now() - started,
          error: traceError(error),
        });
        throw error;
      }
    },
  };
  const args = experimentRegisterArgs({ runner });
  const source = join(args.evalsCheckout, 'scenarios', 'scn-a');
  cpSync(source, join(args.evalsCheckout, 'scenarios', 'control'), {
    recursive: true,
  });
  const checks = join(source, 'checks.sh');
  writeFileSync(checks, `${directive}\npre() { :; }\npost() { :; }\n`);
  const git = (argv: string[]) => {
    const result = args.runner.run('git', argv, { cwd: args.evalsCheckout });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git(['add', 'scenarios']);
  git(['commit', '-qm', 'freeze restrictive scenario directive']);
  const frozenRef = git(['rev-parse', 'HEAD']);
  // The mutable checkout now permits Claude. Registration must still read the
  // restrictive directive from the selected immutable object-store revision.
  writeFileSync(
    checks,
    '# coding-agents: claude\npre() { :; }\npost() { :; }\n',
  );
  git(['add', 'scenarios']);
  git(['commit', '-qm', 'allow Claude in later source']);
  const result = registerExperimentCampaign({
    ...args,
    evalsRef: frozenRef,
    suiteRaw: `${EXPERIMENT_SUITE_RAW}  - arm: arm_a\n    scenarios: [control]\n    n: 1\n`,
  });
  expect(result.experiment.refs.evals).toBe(frozenRef);
  expect(result.experiment.excluded_cells).toEqual([
    {
      cell: 'c1:scn-a',
      reason: expect.stringMatching(
        directive.startsWith('# os:')
          ? /unsupported by scenario/
          : /coding-agents directive/,
      ),
    },
  ]);
  expect(
    result.experiment.cells.map(
      (cell) => `${cell.comparison_id}:${cell.scenario}`,
    ),
  ).toEqual(['c2:control']);
  expect(result.experiment.planned_slots.map((slot) => slot.sample_id)).toEqual(
    ['c2:control:arm_a:r1'],
  );
  expect(
    result.experiment.reserve_slots.map((slot) => slot.reserve_id),
  ).toEqual(['c2:control:x1']);
});

test.each([
  ['matching reordered', ['KEY_B', 'KEY_A'], false, false],
  ['equal overlapping allowance', ['KEY_B', 'KEY_C'], false, false],
  ['conflicting overlap', ['KEY_A', 'KEY_B', 'KEY_C', 'KEY_D'], false, true],
  ['singular overlap', null, false, true],
  ['bearer overlap', null, true, true],
] as const)('registration pool key allowances: %s', (_label, keyPool, bearer, rejects) => {
  const base = experimentInput();
  const first = credential({
    quota_pool: 'shared',
    max_concurrency: 4,
    key_pool: ['KEY_A', 'KEY_B'],
  });
  delete first.api_key_env;
  const second = credential({
    quota_pool: 'shared',
    max_concurrency: 4,
    ...(keyPool ? { key_pool: [...keyPool] } : { api_key_env: 'KEY_B' }),
    ...(bearer
      ? {
          auth: 'bedrock-bearer' as const,
          api: 'mantle' as const,
          region: 'us-east-1',
        }
      : {}),
  });
  if (keyPool) delete second.api_key_env;
  const run = () =>
    prepareExperimentRegistration(
      experimentInput({
        ...base,
        credentials: {
          ...base.credentials,
          cred_a: first,
          shared_alias: second,
        },
      }),
    );
  if (rejects)
    expect(run).toThrow(/conflicting per-key allowance.*shared.*KEY_[AB]/);
  else expect(run).not.toThrow();
});

test('V2 registration freezes an arm effort into the execution surface', () => {
  const plain = prepareExperimentRegistration(experimentInput());
  expect(
    plain.execution_surface.find((entry) => entry.name === 'arm_a'),
  ).not.toHaveProperty('effort');

  const withEffort = prepareExperimentRegistration(
    experimentInput({
      arms: {
        arm_a: arm('arm_a', { effort: 'xhigh' }),
        arm_b: arm('arm_b', { credential: 'cred_b' }),
      },
    }),
  );
  const surface = new Map(
    withEffort.execution_surface.map((entry) => [entry.name, entry]),
  );
  expect(surface.get('arm_a')?.effort).toBe('xhigh');
  expect(surface.get('arm_b')).not.toHaveProperty('effort');
});

test('V2 registration refuses an effort the arm agent family cannot honor', () => {
  expect(() =>
    prepareExperimentRegistration(
      experimentInput({
        arms: {
          arm_a: arm('arm_a', { effort: 'minimal' }),
          arm_b: arm('arm_b', { credential: 'cred_b' }),
        },
      }),
    ),
  ).toThrow(
    /arm arm_a effort minimal refused: harness claude does not accept effort minimal/,
  );
  expect(() =>
    prepareExperimentRegistration(
      experimentInput({
        agentFamily: () => 'pi',
        credentials: {
          cred_a: credential({
            harnesses: ['pi'],
            max_concurrency: 8,
            api_key_env: 'DEFINITELY_UNSET_SECRET_A',
          }),
          cred_b: credential({
            harnesses: ['pi'],
            max_concurrency: 8,
            api_key_env: 'DEFINITELY_UNSET_SECRET_B',
          }),
        },
        arms: {
          arm_a: arm('arm_a', { effort: 'high' }),
          arm_b: arm('arm_b', { credential: 'cred_b' }),
        },
      }),
    ),
  ).toThrow(/arm arm_a effort high refused: harness pi has no effort control/);
});

import { comparisonRegisterArgs } from './fixtures/core-comparison/registration.ts';

function fixtureGit(path: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', path, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

test('runtime registration freezes refs once across intake passes and authenticates the template', () => {
  const args = comparisonRegisterArgs();
  const initial = fixtureGit(
    args.superpowersCheckout,
    'rev-parse',
    'refs/remotes/origin/dev',
  );
  const baseline = fixtureGit(args.superpowersCheckout, 'rev-parse', 'release');
  let moved = false;
  const runner: CommandRunner = {
    run(command, argv, options) {
      if (!moved && command === 'git' && argv.includes('worktree')) {
        fixtureGit(
          args.superpowersCheckout,
          'update-ref',
          'refs/remotes/origin/dev',
          baseline,
        );
        moved = true;
      }
      return args.runner.run(command, argv, options);
    },
  };
  const result = registerExperimentCampaign({ ...args, runner });
  expect(moved).toBe(true);
  expect(
    fixtureGit(
      args.superpowersCheckout,
      'rev-parse',
      'refs/remotes/origin/dev',
    ),
  ).toBe(baseline);
  expect(result.experiment.refs.superpowers_by_arm).toEqual({
    p1_baseline: baseline,
    p1_candidate: initial,
  });
  expect(result.experiment.comparison_request).toEqual({
    baseline: { label: 'release', sha: baseline },
    candidate: { label: 'dev', sha: initial },
    pairs: [{ agent: 'claude', credential: 'cred_a' }],
    suite_path: 'suites/comparison.yaml',
    suite_sha256: sha256Hex(args.suiteRaw),
  });
  expect(
    existsSync(join(result.campaignDir, 'evals/arms/p1_baseline.yaml')),
  ).toBe(false);
  expect(loadExperiment(result.campaignDir)).toEqual(result.experiment);
});

test('runtime registration refuses dirty, untracked, outside and snapshot-substituted templates', () => {
  const args = comparisonRegisterArgs();
  expect(() =>
    registerExperimentCampaign({
      ...args,
      suiteRaw: `${args.suiteRaw}# changed\n`,
    }),
  ).toThrow(/suite.*bytes|template/i);
  writeFileSync(args.suitePath, `${args.suiteRaw}# dirty\n`);
  expect(() => registerExperimentCampaign(args)).toThrow(
    /suite.*bytes|template/i,
  );
  writeFileSync(args.suitePath, args.suiteRaw);
  const untracked = join(args.evalsCheckout, 'suites/untracked.yaml');
  writeFileSync(untracked, args.suiteRaw);
  expect(() =>
    registerExperimentCampaign({ ...args, suitePath: untracked }),
  ).toThrow();
  const outside = join(args.campaignsRoot, 'outside.yaml');
  writeFileSync(outside, args.suiteRaw);
  expect(() =>
    registerExperimentCampaign({ ...args, suitePath: outside }),
  ).toThrow(/outside/);
  const runner: CommandRunner = {
    run(command, argv, options) {
      const result = args.runner.run(command, argv, options);
      if (
        command === 'bun' &&
        argv.includes('install') &&
        options?.cwd?.endsWith('/evals')
      ) {
        writeFileSync(
          join(options.cwd, 'suites/comparison.yaml'),
          `${args.suiteRaw}# corrupt\n`,
        );
      }
      return result;
    },
  };
  expect(() => registerExperimentCampaign({ ...args, runner })).toThrow(
    /drifted|snapshot/,
  );
});

test('runtime identity includes labels, refs, ordered pairings, effort and exact template bytes', () => {
  const args = comparisonRegisterArgs();
  const original = registerExperimentCampaign(args).experiment;
  for (const comparisonInput of [
    { ...args.comparisonInput!, baselineLabel: 'different label' },
    { ...args.comparisonInput!, candidate: 'release' },
    {
      ...args.comparisonInput!,
      pairs: [{ agent: 'claude', credential: 'cred_b' }],
    },
    {
      ...args.comparisonInput!,
      pairs: [
        { agent: 'claude', credential: 'cred_a', effort: 'high' as const },
      ],
    },
  ]) {
    expect(
      registerExperimentCampaign({ ...args, comparisonInput }).experiment
        .input_digest,
    ).not.toBe(original.input_digest);
  }
  const pairs = [
    { agent: 'claude', credential: 'cred_a' },
    { agent: 'claude', credential: 'cred_b' },
  ];
  const ordered = registerExperimentCampaign({
    ...args,
    comparisonInput: { ...args.comparisonInput!, pairs },
  }).experiment;
  const reversed = registerExperimentCampaign({
    ...args,
    comparisonInput: { ...args.comparisonInput!, pairs: [...pairs].reverse() },
  }).experiment;
  expect(ordered.input_digest).not.toBe(reversed.input_digest);
  const changed = {
    ...original,
    comparison_request: {
      ...original.comparison_request!,
      suite_sha256: sha256Hex(`${args.suiteRaw}# comment\n`),
    },
  };
  expect(experimentDigest(changed)).not.toBe(original.input_digest);
  const suiteRaw = `${args.suiteRaw}# authenticated comment\n`;
  writeFileSync(args.suitePath, suiteRaw);
  fixtureGit(args.evalsCheckout, 'add', 'suites/comparison.yaml');
  fixtureGit(args.evalsCheckout, 'commit', '-qm', 'revise template bytes');
  const revised = registerExperimentCampaign({
    ...args,
    suiteRaw,
    evalsRef: fixtureGit(args.evalsCheckout, 'rev-parse', 'HEAD'),
  }).experiment;
  expect(revised.comparison_request?.suite_sha256).toBe(sha256Hex(suiteRaw));
  expect(revised.input_digest).not.toBe(original.input_digest);
  writeFileSync(args.suitePath, args.suiteRaw);

  expect(() =>
    registerExperimentCampaign({
      ...args,
      comparisonInput: {
        ...args.comparisonInput!,
        pairs: [{ agent: 'claude', credential: 'unknown' }],
      },
    }),
  ).toThrow(/credential unknown/);
}, 60000);

test('role budgets resolve each arm from story then agent defaults', () => {
  const input = experimentInput({
    arms: { arm_a: arm('arm_a'), arm_b: arm('arm_b', { agent: 'pi' }) },
    agentMaxTime: (agent) => (agent === 'pi' ? '20m' : '10m'),
  });
  expect(prepareExperimentRegistration(input).role_budgets['c1:scn-a']).toEqual(
    {
      arm_a: {
        subject_ms: 600000,
        assessment_ms: null,
        assessment_report_grace_ms: null,
        overhead_ms: 900000,
      },
      arm_b: {
        subject_ms: 1200000,
        assessment_ms: null,
        assessment_report_grace_ms: null,
        overhead_ms: 900000,
      },
    },
  );
  const withStory = {
    ...input,
    scenarios: [
      scenario('scn-a', {
        story:
          '---\nquorum_max_time: 30m\nquorum_mode: conversation\nquorum_assessment_max_time: 10m\nquorum_assessment_report_grace: 60s\n---\n',
      }),
    ],
  };
  const budget =
    prepareExperimentRegistration(withStory).role_budgets['c1:scn-a'];
  for (const name of ['arm_a', 'arm_b'])
    expect(budget?.[name]).toEqual({
      subject_ms: 1800000,
      assessment_ms: 600000,
      assessment_report_grace_ms: 60000,
      overhead_ms: 900000,
    });
});
test('outer attempt bounds accommodate every arm including QA final-report headroom', () => {
  const base = experimentInput();
  const input = {
    ...base,
    suite: {
      ...base.suite,
      attempt_bounds: { max_attempts: 2, max_time_s: 1500 },
    },
  };
  expect(
    prepareExperimentRegistration(input).role_budgets['c1:scn-a']?.['arm_a']
      ?.subject_ms,
  ).toBe(600000);
  expect(() =>
    prepareExperimentRegistration({ ...input, agentMaxTime: () => '601s' }),
  ).toThrow(
    /attempt bound cannot accommodate scn-a's role budgets and overhead/,
  );
  expect(() =>
    prepareExperimentRegistration({
      ...input,
      scenarios: [
        scenario('scn-a', {
          story:
            '---\nquorum_mode: conversation\nquorum_assessment_max_time: 5m\nquorum_assessment_report_grace: 60s\n---\n',
        }),
      ],
    }),
  ).toThrow(/attempt bound cannot accommodate/);
});

test('registration freezes role budgets from committed story and agent bytes despite checkout edits', () => {
  const args = experimentRegisterArgs();
  const git = (argv: string[]) => {
    const result = args.runner.run('git', ['-C', args.evalsCheckout, ...argv]);
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const storyPath = join(args.evalsCheckout, 'scenarios/scn-a/story.md');
  const agentPath = join(args.evalsCheckout, 'coding-agents/claude.yaml');
  const agent = readFileSync(agentPath, 'utf8');
  writeFileSync(
    storyPath,
    '---\nquorum_mode: conversation\nquorum_assessment_max_time: 5m\nquorum_assessment_report_grace: 60s\n---\nStory.\n\n## Acceptance Criteria\n\n- Deliver the requested result.\n',
  );
  writeFileSync(agentPath, `${agent}max_time: 20m\n`);
  git(['add', 'scenarios/scn-a/story.md', 'coding-agents/claude.yaml']);
  git(['commit', '-qm', 'freeze role allowances']);
  const evalsRef = git(['rev-parse', 'HEAD']);
  writeFileSync(
    storyPath,
    '---\nquorum_max_time: 1s\n---\nMutable checkout.\n',
  );
  writeFileSync(agentPath, `${agent}max_time: 1s\n`);
  const result = registerExperimentCampaign({ ...args, evalsRef });
  expect(result.experiment.role_budgets?.['c1:scn-a']?.['arm_a']).toEqual({
    subject_ms: 1200000,
    assessment_ms: 300000,
    assessment_report_grace_ms: 60000,
    overhead_ms: 900000,
  });
  expect(result.experiment.input_digest).toBe(
    experimentDigest(result.experiment),
  );
}, 30000);

test('present frozen role budgets require exact cell and arm inventory and valid bounds', () => {
  const prepared = prepareExperimentRegistration(experimentInput());
  const experiment = {
    ...prepared,
    campaign_id: 'test',
    input_digest: '0'.repeat(64),
    registered_at: '2026-09-10T00:00:00Z',
    registered_by: 'test',
  };
  const budgets = prepared.role_budgets;
  expect(ExperimentSchema.safeParse(experiment).success).toBe(true);
  for (const role_budgets of [
    {},
    { ...budgets, extra: budgets['c1:scn-a'] },
    { 'c1:scn-a': { arm_a: budgets['c1:scn-a']?.['arm_a'] } },
    {
      'c1:scn-a': {
        ...budgets['c1:scn-a'],
        arm_a: { ...budgets['c1:scn-a']?.['arm_a'], subject_ms: 5400000 },
      },
    },
  ])
    expect(
      ExperimentSchema.safeParse({ ...experiment, role_budgets }).success,
    ).toBe(false);
  const { role_budgets: _budgets, ...retained } = experiment;
  expect(ExperimentSchema.parse(retained).role_budgets).toBeUndefined();
});

test('registration authenticates requirements and qualification source bytes in both intake passes', () => {
  const args = experimentRegisterArgs();
  mkdirSync(join(args.evalsCheckout, 'dep'));
  writeFileSync(
    join(args.evalsCheckout, 'dep/package.json'),
    JSON.stringify({ name: 'fixture-dep', version: '0.0.0' }),
  );
  writeFileSync(
    join(args.evalsCheckout, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      version: '0.0.0',
      workspaces: ['dep'],
      dependencies: { 'fixture-dep': 'workspace:*' },
    }),
  );
  const installed = args.runner.run('bun', ['install'], {
    cwd: args.evalsCheckout,
  });
  if (installed.status !== 0) throw new Error(installed.stderr);
  const story = readFileSync(
    join(args.evalsCheckout, 'scenarios/scn-a/story.md'),
    'utf8',
  );
  const manifest = readFileSync(
    join(args.evalsCheckout, 'scenarios/scn-a/checks-manifest.json'),
    'utf8',
  );
  const rubric = sha256Hex(story);
  const requirements = JSON.stringify({
    schema_version: 1,
    scenarios: {
      'scn-a': {
        mode: 'qa',
        story_sha256: rubric,
        rubric_sha256: rubric,
        criteria: [],
        checks: [],
        oracle_authority: { check_manifest_sha256: sha256Hex(manifest) },
      },
    },
  });
  const cases = JSON.stringify({
    schema_version: 1,
    assessments_per_case: 1,
    cases: [
      {
        id: 'case',
        rubric_sha256: rubric,
        expected: [
          {
            criterion: 1,
            verdict: 'pass',
            required_reason: 'fixture expected behavior',
          },
        ],
      },
    ],
  });
  const qualification = JSON.stringify({
    schema_version: 1,
    gauntlet_sha: 'a'.repeat(40),
    grader: {
      credential: 'fixture',
      model: 'fixture',
      configuration_sha256: 'a'.repeat(64),
    },
    evidence_semantics_sha256: 'b'.repeat(64),
    scopes: [
      {
        scenario: 'scn-a',
        rubric_sha256: rubric,
        criterion_ids: ['scn-a:1'],
        assessment_ms: 300000,
        report_grace_ms: 60000,
        case_manifest: { path: 'cases.json', sha256: sha256Hex(cases) },
        private_receipt_sha256: 'c'.repeat(64),
        observations: [],
      },
    ],
  });
  for (const [path, bytes] of Object.entries({
    'requirements.json': requirements,
    'cases.json': cases,
    'qualification.json': qualification,
  }))
    writeFileSync(join(args.evalsCheckout, path), bytes);
  const git = (argv: string[]) => {
    const result = args.runner.run('git', ['-C', args.evalsCheckout, ...argv]);
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git([
    'add',
    'requirements.json',
    'cases.json',
    'qualification.json',
    'package.json',
    'bun.lock',
    'dep/package.json',
  ]);
  git(['commit', '-qm', 'freeze public measurement declarations']);
  const evalsRef = git(['rev-parse', 'HEAD']);
  const suiteRaw = `${args.suiteRaw}\nmeasurement_requirements:\n  path: requirements.json\n  sha256: ${sha256Hex(requirements)}\nassessment_qualification:\n  path: qualification.json\n  sha256: ${sha256Hex(qualification)}\n`;
  const frozen = registerExperimentCampaign({
    ...args,
    evalsRef,
    suiteRaw,
  }).experiment;
  expect(frozen.measurement_requirements?.['scn-a']?.rubric_sha256).toBe(
    rubric,
  );
  expect(frozen.assessment_qualification?.scopes[0]?.status).toBe('unverified');
  for (const path of ['requirements.json', 'cases.json', 'src/cli/index.ts']) {
    const runner: CommandRunner = {
      run(command, argv, options) {
        const result = args.runner.run(command, argv, options);
        if (
          command === 'bun' &&
          argv.includes('install') &&
          options?.cwd?.startsWith(realpathSync(args.campaignsRoot)) &&
          options.cwd.endsWith('/evals')
        )
          writeFileSync(join(options.cwd, path), 'tampered');
        return result;
      },
    };
    expect(() =>
      registerExperimentCampaign({ ...args, evalsRef, suiteRaw, runner }),
    ).toThrow(/drifted from intake bytes/);
  }
}, 60000);
