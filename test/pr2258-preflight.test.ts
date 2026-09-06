import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  type Pr2258QualificationReceipts,
  validatePr2258Preflight,
} from '../scripts/pr2258-preflight.ts';
import { compareAdmissionOrder } from '../src/campaign/admission.ts';
import { compileResourcePolicy } from '../src/campaign/resource-policy.ts';
import { type Arm, ArmSchema } from '../src/contracts/campaign/arm.ts';
import {
  type Grader,
  GraderSchema,
} from '../src/contracts/campaign/experiment.ts';
import { type Suite, SuiteSchema } from '../src/contracts/campaign/suite.ts';
import {
  type Credential,
  parseCredentialsFile,
} from '../src/contracts/credential.ts';
import { repoRoot } from '../src/paths.ts';

const ROOT = repoRoot();
const BASE = 'fd02874aa5c55ba3c2bca431253b48e0e4c8be5a';
const HEAD = '069edf3ffc2ffdce80a84d3344a4064acec7e10c';
const SCENARIO = 'brainstorming-todo-shared-intent';
const EXPECTED_PAIRS = [
  ['codex_astra_pr2258_base', 'codex_astra_pr2258_head'],
  ['codex_sol_pr2258_base', 'codex_sol_pr2258_head'],
  ['claude_opus5_pr2258_base', 'claude_opus5_pr2258_head'],
] as const;

function parsedYaml(path: string): unknown {
  return parseYaml(readFileSync(join(ROOT, path), 'utf8'));
}

function loadSuite(name: 'diagnostic' | 'measured'): {
  suite: Suite;
  grader: Grader;
} {
  const raw = parsedYaml(`suites/pr2258_parallel_${name}.yaml`) as Record<
    string,
    unknown
  >;
  const grader = GraderSchema.parse(raw['grader']);
  const { grader: _grader, ...suiteFields } = raw;
  return { suite: SuiteSchema.parse(suiteFields), grader };
}

function loadArms(): Record<string, Arm> {
  return Object.fromEntries(
    EXPECTED_PAIRS.flatMap(([baseline, treatment]) => [
      baseline,
      treatment,
    ]).map((name) => [name, ArmSchema.parse(parsedYaml(`arms/${name}.yaml`))]),
  );
}

function loadCredentials(): Record<string, Credential> {
  return parseCredentialsFile(parsedYaml('credentials.yaml'));
}

function completeReceipts(
  suite: Suite,
  arms: Readonly<Record<string, Arm>>,
): Pr2258QualificationReceipts {
  const armNames = Object.keys(arms).sort();
  return {
    frozen_pins: {
      evals_sha: 'a'.repeat(40),
      gauntlet_sha: 'b'.repeat(40),
      image_digest: `sha256:${'c'.repeat(64)}`,
    },
    runtime: {
      codex: {
        supported: true,
        installed_build: 'codex-qualified-build',
        qualified_build: 'codex-qualified-build',
        requested_effort: 'xhigh',
        settings_verified: true,
      },
      claude: {
        supported: true,
        installed_build: 'claude-qualified-build',
        qualified_build: 'claude-qualified-build',
        requested_effort: 'default-recorded',
        settings_verified: true,
      },
    },
    timing: {
      subject_instruction_cutoff_s: 1500,
      subject_cutoff_mechanically_enforced: false,
      gauntlet_allowance_s: 1800,
    },
    chronology: {
      codex: { complete: true, receipt_sha256: 'd'.repeat(64) },
      claude: { complete: true, receipt_sha256: 'e'.repeat(64) },
    },
    linux: {
      complete: true,
      receipt_sha256: 'f'.repeat(64),
      evals_sha: 'a'.repeat(40),
      gauntlet_sha: 'b'.repeat(40),
      image_digest: `sha256:${'c'.repeat(64)}`,
    },
    installed: {
      complete: true,
      receipt_sha256: '1'.repeat(64),
      evals_sha: 'a'.repeat(40),
      gauntlet_sha: 'b'.repeat(40),
      image_digest: `sha256:${'c'.repeat(64)}`,
    },
    projections: {
      complete: true,
      cleaned: true,
      arm_names: armNames,
      grader_credential: 'sonnet5_bedrock_pr2258_grader',
      receipt_sha256: '2'.repeat(64),
    },
    grader_bearer: {
      values_verified_distinct: true,
      receipt_sha256: '3'.repeat(64),
    },
    pricing: {
      installed_sha256: suite.pricing_snapshot?.sha256 ?? null,
      complete: true,
      observed_models: [
        'gpt-6-astra',
        'gpt-5.6-sol',
        'anthropic.claude-opus-5',
        'anthropic.claude-sonnet-5',
      ],
      priced_models: [
        'gpt-6-astra',
        'gpt-5.6-sol',
        'anthropic.claude-opus-5',
        'anthropic.claude-sonnet-5',
      ],
      unpriced_models: [],
      service_tiers_verified: true,
      cache_buckets_verified: true,
      separately_billed_tools: 'none-observed',
      receipt_sha256: '4'.repeat(64),
    },
    capacity: {
      simultaneous_mix_verified: true,
      accounts: [
        {
          account: 'openai-subject-account',
          credentials: ['openai_responses_6astra', 'openai_responses_56sol'],
          max_concurrency: 4,
          verified: true,
        },
        {
          account: 'opus-subject-account',
          credentials: ['opus5_bedrock'],
          max_concurrency: 2,
          verified: true,
        },
        {
          account: 'grader-account',
          credentials: ['sonnet5_bedrock_pr2258_grader'],
          max_concurrency: 6,
          verified: true,
        },
      ],
      models: [
        { model: 'gpt-6-astra', max_concurrency: 2, verified: true },
        { model: 'gpt-5.6-sol', max_concurrency: 2, verified: true },
        {
          model: 'anthropic.claude-opus-5',
          max_concurrency: 2,
          verified: true,
        },
        {
          model: 'anthropic.claude-sonnet-5',
          max_concurrency: 6,
          verified: true,
        },
      ],
      receipt_sha256: '5'.repeat(64),
    },
    exposure: {
      six_way_overlap_verified: true,
      maximum_start_skew_s: 60,
      receipt_sha256: '6'.repeat(64),
    },
  };
}

function preflight(
  suiteName: 'diagnostic' | 'measured',
  mutate?: (args: {
    suite: Suite;
    arms: Record<string, Arm>;
    credentials: Record<string, Credential>;
    receipts: Pr2258QualificationReceipts;
  }) => void,
) {
  const { suite, grader } = loadSuite(suiteName);
  const arms = loadArms();
  const credentials = loadCredentials();
  const receipts = completeReceipts(suite, arms);
  mutate?.({ suite, arms, credentials, receipts });
  return validatePr2258Preflight({
    suite,
    grader,
    arms,
    credentials,
    globalCap: 6,
    qualification: receipts,
  });
}

test.each([
  ['diagnostic', 1, 6],
  ['measured', 2, 12],
] as const)('%s declaration freezes three matched comparisons and its finite work', (name, repetitions, slots) => {
  const { suite, grader } = loadSuite(name);
  const arms = loadArms();
  const armNames = suite.comparisons.flatMap((comparison) =>
    'arm' in comparison
      ? [comparison.arm]
      : [comparison.baseline, comparison.treatment],
  );

  expect(grader).toEqual({
    credential: 'sonnet5_bedrock_pr2258_grader',
    model: 'anthropic.claude-sonnet-5',
  });
  expect(suite.comparisons).toHaveLength(3);
  expect(new Set(armNames).size).toBe(6);
  expect(
    suite.comparisons.map((comparison) => {
      if ('arm' in comparison) throw new Error('expected matched comparison');
      return [comparison.baseline, comparison.treatment];
    }),
  ).toEqual(EXPECTED_PAIRS.map((pair) => [...pair]));
  expect(
    suite.comparisons.every(
      (comparison) =>
        comparison.n === repetitions &&
        Array.isArray(comparison.scenarios) &&
        comparison.scenarios.length === 1 &&
        comparison.scenarios[0] === SCENARIO,
    ),
  ).toBe(true);
  expect(armNames.length * repetitions).toBe(slots);
  expect(suite.reserve).toBe(0);
  expect(suite.attempt_bounds).toEqual({
    max_attempts: 1,
    max_time_s: 2400,
  });
  expect(suite.max_exposure_skew).toBe(60);
  expect(suite.pricing_snapshot?.path).toBe(
    'docs/experiments/2026-09-05-pr2258-parallel-pricing/current.json',
  );

  for (const [baseline, treatment] of EXPECTED_PAIRS) {
    expect(arms[baseline]?.superpowers).toBe(BASE);
    expect(arms[treatment]?.superpowers).toBe(HEAD);
  }
});

test('pricing snapshot digest is real and shared by both declarations', () => {
  const diagnostic = loadSuite('diagnostic').suite.pricing_snapshot;
  const measured = loadSuite('measured').suite.pricing_snapshot;
  expect(diagnostic).toEqual(measured);
  expect(diagnostic).toBeDefined();
  const bytes = readFileSync(join(ROOT, diagnostic!.path));
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    diagnostic!.sha256,
  );
});

test('parsed public policy supports the exact six-subject and six-grader wave', () => {
  const credentials = loadCredentials();
  const names = [
    'openai_responses_6astra',
    'openai_responses_56sol',
    'opus5_bedrock',
    'sonnet5_bedrock_pr2258_grader',
  ];
  const policy = compileResourcePolicy(credentials, names);
  const byModel = Object.fromEntries(
    names.map((name) => {
      const credential = credentials[name]!;
      const pool = [...policy.values()].find(
        (candidate) =>
          candidate.pool_id ===
          (credential.quota_pool ??
            `${credential.base_url ?? name}|${credential.api}|${credential.model}`),
      );
      return [credential.model, pool];
    }),
  );

  expect(byModel['gpt-6-astra']?.max_concurrency).toBeGreaterThanOrEqual(2);
  expect(byModel['gpt-5.6-sol']?.max_concurrency).toBeGreaterThanOrEqual(2);
  expect(
    byModel['anthropic.claude-opus-5']?.max_concurrency,
  ).toBeGreaterThanOrEqual(2);
  expect(byModel['anthropic.claude-sonnet-5']?.max_concurrency).toBe(6);
});

test('complete receipts make the exact finite experiment ready', () => {
  const result = preflight('measured');
  expect(result).toEqual({
    ready: true,
    blockers: [],
    evidence: expect.objectContaining({
      planned_slots: 12,
      global_cap: 6,
      concurrent_subjects: 6,
      concurrent_graders: 6,
      subject_demand_by_model: {
        'anthropic.claude-opus-5': 2,
        'gpt-5.6-sol': 2,
        'gpt-6-astra': 2,
      },
      grader_demand_by_model: { 'anthropic.claude-sonnet-5': 6 },
    }),
  });
});

test('missing qualification evidence stays an explicit no-go', () => {
  const result = preflight('diagnostic', ({ receipts }) => {
    receipts.grader_bearer.values_verified_distinct = false;
    receipts.runtime.claude.supported = false;
    receipts.chronology.claude.complete = false;
    receipts.pricing.complete = false;
    receipts.linux.complete = false;
    receipts.installed.complete = false;
    receipts.projections.complete = false;
    receipts.capacity.simultaneous_mix_verified = false;
    receipts.exposure.six_way_overlap_verified = false;
  });

  expect(result.ready).toBe(false);
  expect(result.blockers).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/grader bearer.*distinct/i),
      expect.stringMatching(/Claude runtime.*unsupported/i),
      expect.stringMatching(/Claude native chronology/i),
      expect.stringMatching(/pricing coverage.*incomplete/i),
      expect.stringMatching(/Linux qualification/i),
      expect.stringMatching(/installed qualification/i),
      expect.stringMatching(/projection rehearsal/i),
      expect.stringMatching(/six-way capacity/i),
      expect.stringMatching(/six-way overlap/i),
    ]),
  );
});

test('runtime timing keeps the instructed subject cutoff distinct from the enforced allowance', () => {
  const result = preflight('diagnostic', ({ receipts }) => {
    receipts.timing.subject_cutoff_mechanically_enforced = true;
    receipts.timing.gauntlet_allowance_s = 1799;
  });

  expect(result.blockers).toEqual(
    expect.arrayContaining([
      'the 25-minute subject cutoff must remain recorded as instructed, not mechanically enforced',
      'the enforced Gauntlet allowance must be 1800 seconds, got 1799',
    ]),
  );
});

test('unused aliases lower the actual compiled pool and block readiness', () => {
  const result = preflight('diagnostic', ({ credentials }) => {
    credentials['opus5_bedrock']!.quota_pool = 'pr2258_opus_subjects';
    credentials['unused_tight_alias'] = {
      ...credentials['opus5_bedrock']!,
      max_concurrency: 1,
    };
  });

  expect(result.ready).toBe(false);
  expect(result.blockers).toContain(
    'subject pool pr2258_opus_subjects needs 2 concurrent slots but the compiled alias-aware cap is 1',
  );
});

test('account and per-model capacity evidence are independent blockers', () => {
  const account = preflight('diagnostic', ({ receipts }) => {
    receipts.capacity.accounts[0]!.max_concurrency = 3;
  });
  expect(account.blockers).toContain(
    'account openai-subject-account needs 4 concurrent calls but verified capacity is 3',
  );

  const model = preflight('diagnostic', ({ receipts }) => {
    receipts.capacity.models[3]!.max_concurrency = 5;
  });
  expect(model.blockers).toContain(
    'model anthropic.claude-sonnet-5 needs 6 concurrent calls but verified capacity is 5',
  );
});

test('different pins, unclean projections and incompatible spacing block readiness', () => {
  const result = preflight('diagnostic', ({ credentials, receipts }) => {
    receipts.installed.evals_sha = '9'.repeat(40);
    receipts.projections.cleaned = false;
    credentials['sonnet5_bedrock_pr2258_grader']!.launch_spacing_seconds = 31;
  });

  expect(result.blockers).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/installed Evals pin differs/i),
      expect.stringMatching(/projection rehearsal stages.*cleaned/i),
      expect.stringMatching(
        /grader pool.*spacing requires 62 seconds.*60-second/i,
      ),
    ]),
  );
});

test('equal-priority suite blocks visit all comparisons before repetition two', () => {
  const { suite } = loadSuite('measured');
  const blocks = suite.comparisons.flatMap((_comparison, comparisonIndex) =>
    [1, 2].map((replicate) => ({
      block_id: `c${comparisonIndex + 1}:${SCENARIO}:b${replicate}`,
    })),
  );

  expect(blocks.sort(compareAdmissionOrder).slice(0, 3)).toEqual([
    { block_id: `c1:${SCENARIO}:b1` },
    { block_id: `c2:${SCENARIO}:b1` },
    { block_id: `c3:${SCENARIO}:b1` },
  ]);
});
