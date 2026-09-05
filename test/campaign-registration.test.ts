import { expect, test } from 'bun:test';
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
  rerunInstanceId,
  reserveBlockId,
  reserveSampleId,
  type ScenarioIntake,
} from '../src/campaign/registration.ts';
import type { Arm } from '../src/contracts/campaign/arm.ts';
import { experimentDigest } from '../src/contracts/campaign/experiment-digest.ts';

import type { Credential } from '../src/contracts/credential.ts';

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
      attempt_bounds: { max_attempts: 2, max_time_s: 300 },
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
  // Rerun lineage: the successor of B:i1 is B:i2, never B:i1:i2 — the root is
  // the first non-rerun block; seq increments across the root.
  expect(rerunInstanceId('c1:sdd-escalates:b3', 1)).toBe(
    'c1:sdd-escalates:b3:i1',
  );
  expect(rerunInstanceId('c1:sdd-escalates:b3', 2)).toBe(
    'c1:sdd-escalates:b3:i2',
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
  expect(() => rerunInstanceId('c1:sdd-escalates:b3', 0)).toThrow(
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
  // lineage root: the first NON-rerun block — b<N> or x<N>, never :i<N>.
  expect(() => rerunInstanceId('c1:sdd-escalates:b3:i1', 1)).toThrow(
    RegistrationError,
  );
  expect(() => rerunInstanceId('c1:sdd-escalates:q3', 1)).toThrow(
    RegistrationError,
  );
  // sample id into an attempt: cell:arm:r<N> or cell:arm:x<N>.
  expect(() => attemptIdOf('c1:sdd-escalates:claude-sp', 2)).toThrow(
    RegistrationError,
  );
  expect(() => attemptIdOf('c1:sdd-escalates:claude-sp:q3', 2)).toThrow(
    RegistrationError,
  );
  // reserve lineage roots and reserve-sample attempts stay in-grammar.
  expect(rerunInstanceId('c1:sdd-escalates:x2', 1)).toBe(
    'c1:sdd-escalates:x2:i1',
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

// ── registerCampaign orchestration + publication (task 5d) ────────────────
// Real tmp git repos (house pattern), real bun installs, injected
// clock/identity/probe; the CommandRunner fake answers ONLY the merge-base
// child-contract check (the fixture cannot contain the real D2 merge SHA).
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
  defaultCommandRunner,
} from '../src/agents/command-runner.ts';
import { loadFrozenCampaign as loadExperiment } from '../src/campaign/campaign-document.ts';
import { readProjection } from '../src/campaign/execution-journal.ts';
import type { HostStats, HostStatsProbe } from '../src/campaign/host-stats.ts';
import type { ProcessIdentityProbe } from '../src/campaign/locks.ts';
import {
  type RegisterArgs as ExperimentRegisterArgs,
  registerCampaign as registerExperimentCampaign,
} from '../src/campaign/registration.ts';
import { FakeClock } from '../src/scheduler/clock.ts';

const LOCAL_IDENTITY: ProcessIdentityProbe = {
  exists: () => 'alive',
  startTimeMs: () => 1,
};
const FAKE_STATS: HostStats = {
  ts_ms: 0,
  load1: 0.1,
  pid_max: 1_000_000,
  mem_available_bytes: 8 * GiB,
  mem_total_bytes: 16 * GiB,
  swap_used_bytes: 0,
  swap_total_bytes: 4 * GiB,
  process_count: 200,
  disk_free_bytes: 50 * GiB,
  disk_total_bytes: 100 * GiB,
};
const FAKE_PROBE: HostStatsProbe = {
  sample: (nowMs) => ({ ...FAKE_STATS, ts_ms: nowMs }),
};

function git(dir: string, args: string[]): string {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (res.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

/** A real tmp evals checkout at one commit: arms/, credentials.yaml,
 *  coding-agents/claude.yaml, scenarios/scn-a, and a stub CLI entrypoint. */
function evalsRepo(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'evals-repo-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);
  writeFileSync(
    join(dir, 'credentials.yaml'),
    [
      'cred_a:',
      '  model: test-model',
      '  harnesses: [claude]',
      '  api: anthropic',
      '  auth: api-key',
      '  api_key_env: TEST_KEY',
      '  max_concurrency: 8',
      'cred_g:',
      '  model: test-model',
      '  harnesses: [claude]',
      '  api: anthropic',
      '  auth: api-key',
      '  api_key_env: TEST_GRADER',
      '  max_concurrency: 8',
      'cred_b:',
      '  model: test-model',
      '  harnesses: [claude]',
      '  api: anthropic',
      '  auth: api-key',
      '  api_key_env: TEST_KEY_B',
      '  max_concurrency: 8',
      '',
    ].join('\n'),
  );
  mkdirSync(join(dir, 'arms'), { recursive: true });
  writeFileSync(
    join(dir, 'arms', 'arm_a.yaml'),
    [
      'schema_version: 1',
      'name: arm_a',
      'agent: claude',
      'credential: cred_a',
      'superpowers: none',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'arms', 'arm_b.yaml'),
    [
      'schema_version: 1',
      'name: arm_b',
      'agent: claude',
      'credential: cred_b',
      'superpowers: none',
      '',
    ].join('\n'),
  );
  mkdirSync(join(dir, 'coding-agents'), { recursive: true });
  writeFileSync(
    join(dir, 'coding-agents', 'claude.yaml'),
    [
      'name: claude',
      'runtime_family: claude',
      'binary: claude',
      'model: claude-test',
      'home_config_subdir: .claude',
      'session_log_dir: .claude/projects',
      "session_log_glob: '**/*.jsonl'",
      'normalizer: claude',
      'default_credential: cred_a',
      '',
    ].join('\n'),
  );
  mkdirSync(join(dir, 'scenarios', 'scn-a'), { recursive: true });
  writeFileSync(
    join(dir, 'scenarios', 'scn-a', 'story.md'),
    '---\nquorum_tier: full\n---\nDo the thing.\n',
  );
  writeFileSync(
    join(dir, 'scenarios', 'scn-a', 'setup.sh'),
    '#!/usr/bin/env bash\n:\n',
  );
  writeFileSync(
    join(dir, 'scenarios', 'scn-a', 'checks.sh'),
    'pre() { :; }\npost() { :; }\n',
  );
  mkdirSync(join(dir, 'src', 'cli'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'cli', 'index.ts'),
    "if (process.argv.includes('--version')) console.log('quorum-test 0.0.0');\n",
  );
  commitWithLockfile(dir); // the snapshot's bun install --frozen-lockfile needs a committed lockfile
  return { dir, sha: git(dir, ['rev-parse', 'HEAD']) };
}

const EXPERIMENT_SUITE_RAW = [
  'schema_version: 2',
  'name: finite_comparison',
  'reserve: 1',
  'max_exposure_skew: 30',
  'attempt_bounds: { max_attempts: 2, max_time_s: 300 }',
  'grader: { credential: cred_g, model: test-model }',
  'comparisons:',
  '  - baseline: arm_a',
  '    treatment: arm_b',
  '    scenarios: [scn-a]',
  '    n: 1',
  '',
].join('\n');

function experimentRegisterArgs(
  overrides: Partial<ExperimentRegisterArgs> = {},
): ExperimentRegisterArgs {
  const evals = evalsRepo();
  const gauntlet = gauntletRepo();
  return {
    suitePath: 'suites/finite_comparison.yaml',
    suiteRaw: EXPERIMENT_SUITE_RAW,
    campaignsRoot: mkdtempSync(join(tmpdir(), 'experiment-campaigns-')),
    globalCap: 8,
    evalsCheckout: evals.dir,
    evalsRef: evals.sha,
    gauntletCheckout: gauntlet.dir,
    gauntletRef: gauntlet.sha,
    superpowersCheckout: mkdtempSync(join(tmpdir(), 'sp-')),
    runner: probeRunner(0),
    clock: new FakeClock(1),
    identity: LOCAL_IDENTITY,
    probe: FAKE_PROBE,
    registeredBy: 'test',
    nowMs: Date.parse('2026-09-04T12:00:00Z'),
    ...overrides,
  };
}

test('V2 registrations of identical inputs publish distinct IDs with equal input digests', () => {
  const args = experimentRegisterArgs();
  const first = registerExperimentCampaign(args);
  const second = registerExperimentCampaign(args);

  expect(first.experiment.campaign_id).not.toBe(second.experiment.campaign_id);
  expect(first.experiment.input_digest).toBe(second.experiment.input_digest);
  expect(first.campaignDir).not.toBe(second.campaignDir);
  expect(existsSync(join(first.campaignDir, '.ballast'))).toBe(true);
  expect(loadExperiment(first.campaignDir)).toEqual(first.experiment);
  const projection = readProjection(first.campaignDir);
  expect(projection.registered).toBe(true);
  expect(projection.experiment.campaign_id).toBe(first.experiment.campaign_id);
}, 60_000);

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

/** Give a fixture repo a dependency-less package.json + lockfile and commit
 *  everything — materializeEvalsSnapshot runs `bun install
 *  --frozen-lockfile` in every checked-out tree. */
function commitWithLockfile(dir: string): void {
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '0.0.0' }),
  );
  const installed = spawnSync('bun', ['install'], {
    cwd: dir,
    encoding: 'utf8',
  });
  if (installed.status !== 0)
    throw new Error(`fixture bun install failed: ${installed.stderr}`);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'fixture']);
}

function gauntletRepo(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gauntlet-repo-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);
  writeFileSync(join(dir, 'README.md'), 'gauntlet fixture\n');
  commitWithLockfile(dir);
  return { dir, sha: git(dir, ['rev-parse', 'HEAD']) };
}

/** Real runner everywhere EXCEPT the merge-base child-contract check, which
 *  the fixture repo cannot contain (the real D2 merge SHA). The fake answers
 *  that one call; everything else runs for real. */
function probeRunner(mergeBaseStatus: 0 | 1): CommandRunner {
  return {
    run(
      command: string,
      args: readonly string[],
      options?: CommandOptions,
    ): CommandResult {
      if (command === 'git' && args.includes('merge-base')) {
        return {
          status: mergeBaseStatus,
          stdout: '',
          stderr: mergeBaseStatus === 0 ? '' : 'not an ancestor\n',
        };
      }
      return defaultCommandRunner.run(command, args, options);
    },
  };
}

test('registration refuses a source below the minimum child contract', () => {
  expect(() =>
    registerExperimentCampaign(
      experimentRegisterArgs({ runner: probeRunner(1) }),
    ),
  ).toThrow(/child.contract|minimum/i);
});

export {
  EXPERIMENT_SUITE_RAW,
  experimentRegisterArgs,
  FAKE_PROBE,
  probeRunner,
};

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
