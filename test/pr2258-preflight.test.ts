import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  digestPr2258InstrumentFiles,
  loadPr2258ReceiptSet,
  PR2258_INSTRUMENT_FILES,
  type Pr2258DiagnosticGo,
  type Pr2258QualificationReceipts,
  Pr2258QualificationReceiptsSchema,
  validatePr2258Preflight,
} from '../scripts/pr2258-preflight.ts';
import { defaultCommandRunner } from '../src/agents/command-runner.ts';
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
const INSTRUMENT_SHA = '7'.repeat(64);
const EXPECTED_PAIRS = [
  ['codex_astra_pr2258_base', 'codex_astra_pr2258_head'],
  ['codex_sol_pr2258_base', 'codex_sol_pr2258_head'],
  ['claude_opus5_pr2258_base', 'claude_opus5_pr2258_head'],
] as const;

function parsedYaml(path: string): unknown {
  return parseYaml(readFileSync(join(ROOT, path), 'utf8'));
}

function completeDiagnosticGo(
  suite: Suite,
  receipts: Pr2258QualificationReceipts,
): Pr2258DiagnosticGo {
  return {
    review_receipt_authenticated: true,
    campaign_id: 'pr2258-parallel-diagnostic-qualified',
    input_digest: '8'.repeat(64),
    evals_sha: receipts.frozen_pins.evals_sha!,
    gauntlet_sha: receipts.frozen_pins.gauntlet_sha!,
    image_digest: receipts.frozen_pins.image_digest!,
    pricing_sha256: suite.pricing_snapshot!.sha256,
    instrument_sha256: INSTRUMENT_SHA,
    valid_pairs: 3,
    subject_exposures: 6,
    served_model_ids: {
      astra_subject: 'gpt-6-astra',
      sol_subject: 'gpt-5.6-sol',
      opus_subject: 'anthropic.claude-opus-5',
      sonnet_grader: 'anthropic.claude-sonnet-5',
    },
    delegate_model_ids: [],
    delegate_capture_complete: true,
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
    six_way_overlap_verified: true,
    maximum_start_skew_s: 60,
    grader_429_observed: false,
    independent_review: 'GO',
  };
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
      offline_accounting_probe_complete: true,
      primary_models_priced: [
        'gpt-6-astra',
        'gpt-5.6-sol',
        'anthropic.claude-opus-5',
        'anthropic.claude-sonnet-5',
      ],
      receipt_sha256: '4'.repeat(64),
    },
    capacity: {
      fake_provider_six_way_verified: true,
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
      fake_provider_six_way_overlap_verified: true,
      maximum_start_skew_s: 60,
      start_skew_margin_s: 0,
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
  includeDiagnosticGo = suiteName === 'measured',
  mutateDiagnosticGo?: (diagnosticGo: Pr2258DiagnosticGo) => void,
) {
  const { suite, grader } = loadSuite(suiteName);
  const arms = loadArms();
  const credentials = loadCredentials();
  const receipts = completeReceipts(suite, arms);
  mutate?.({ suite, arms, credentials, receipts });
  const diagnosticGo = includeDiagnosticGo
    ? completeDiagnosticGo(suite, receipts)
    : undefined;
  if (diagnosticGo) mutateDiagnosticGo?.(diagnosticGo);
  return validatePr2258Preflight({
    suite,
    grader,
    arms,
    credentials,
    globalCap: 6,
    qualification: receipts,
    instrumentSha256: INSTRUMENT_SHA,
    ...(diagnosticGo ? { diagnosticGo } : {}),
  });
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function git(root: string, args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function writeSourceFixture(root: string): string {
  const sourceRoot = join(root, 'source-fixture');
  const declarationPaths = [
    'credentials.yaml',
    'src/runner/index.ts',
    'suites/pr2258_parallel_diagnostic.yaml',
    'suites/pr2258_parallel_measured.yaml',
    'docs/experiments/2026-09-05-pr2258-parallel-pricing/current.json',
    ...EXPECTED_PAIRS.flatMap(([baseline, treatment]) => [
      `arms/${baseline}.yaml`,
      `arms/${treatment}.yaml`,
    ]),
  ];
  for (const path of [...declarationPaths, ...PR2258_INSTRUMENT_FILES]) {
    const destination = join(sourceRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    const source = join(ROOT, path);
    writeFileSync(
      destination,
      existsSync(source)
        ? readFileSync(source)
        : `export const pr2258TestFixture = ${JSON.stringify(path)};\n`,
    );
  }
  git(sourceRoot, ['init']);
  git(sourceRoot, ['add', '.']);
  git(sourceRoot, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'Source fixture',
  ]);
  return sourceRoot;
}

function writeReceiptSet(root: string): {
  manifestPath: string;
  capabilityPath: string;
  diagnosticPath: string;
  sourceRoot: string;
} {
  mkdirSync(root, { recursive: true });
  const sourceRoot = writeSourceFixture(root);
  const { suite } = loadSuite('measured');
  const arms = loadArms();
  const qualification = completeReceipts(suite, arms);
  const evalsSha = git(sourceRoot, ['rev-parse', 'HEAD']);
  qualification.frozen_pins.evals_sha = evalsSha;
  qualification.linux.evals_sha = evalsSha;
  qualification.installed.evals_sha = evalsSha;
  const evidenceReceipts = [
    'codex-chronology',
    'claude-chronology',
    'linux',
    'installed',
    'projection',
    'grader-separation',
    'pricing-probe',
    'capacity',
    'fake-exposure',
  ].map((name) => {
    const bytes = JSON.stringify({ schema_version: 1, kind: name });
    const path = `evidence/${name}.json`;
    mkdirSync(join(root, 'evidence'), { recursive: true });
    writeFileSync(join(root, path), bytes);
    return { path, sha256: sha256(bytes) };
  });
  const evidenceDigest = (name: string) =>
    evidenceReceipts.find(
      (receipt) => receipt.path === `evidence/${name}.json`,
    )!.sha256;
  qualification.chronology.codex.receipt_sha256 =
    evidenceDigest('codex-chronology');
  qualification.chronology.claude.receipt_sha256 =
    evidenceDigest('claude-chronology');
  qualification.linux.receipt_sha256 = evidenceDigest('linux');
  qualification.installed.receipt_sha256 = evidenceDigest('installed');
  qualification.projections.receipt_sha256 = evidenceDigest('projection');
  qualification.grader_bearer.receipt_sha256 =
    evidenceDigest('grader-separation');
  qualification.pricing.receipt_sha256 = evidenceDigest('pricing-probe');
  qualification.capacity.receipt_sha256 = evidenceDigest('capacity');
  qualification.exposure.receipt_sha256 = evidenceDigest('fake-exposure');
  const diagnosticGo = completeDiagnosticGo(suite, qualification);
  const instrumentFiles = PR2258_INSTRUMENT_FILES.map((path) => ({
    path,
    sha256: sha256(readFileSync(join(sourceRoot, path))),
  }));
  const instrumentSha256 = digestPr2258InstrumentFiles(instrumentFiles);
  diagnosticGo.instrument_sha256 = instrumentSha256;
  const binding = {
    evals_sha: qualification.frozen_pins.evals_sha,
    gauntlet_sha: qualification.frozen_pins.gauntlet_sha,
    image_digest: qualification.frozen_pins.image_digest,
    pricing_sha256: suite.pricing_snapshot!.sha256,
    instrument_sha256: instrumentSha256,
  };
  const capability = {
    schema_version: 1,
    kind: 'pr2258-capability-review',
    reviewed_by: 'qualification-reviewer',
    reviewed_at: '2026-09-05T12:00:00.000Z',
    binding,
    qualification,
  };
  const {
    review_receipt_authenticated: _reviewReceiptAuthenticated,
    ...diagnosticClaims
  } = diagnosticGo;
  const diagnostic = {
    schema_version: 1,
    kind: 'pr2258-diagnostic-go-review',
    reviewed_by: 'independent-diagnostic-reviewer',
    reviewed_at: '2026-09-05T13:00:00.000Z',
    binding,
    diagnostic_go: diagnosticClaims,
  };
  const capabilityBytes = JSON.stringify(capability);
  const diagnosticBytes = JSON.stringify(diagnostic);
  const capabilityPath = join(root, 'capability-review.json');
  const diagnosticPath = join(root, 'diagnostic-go-review.json');
  writeFileSync(capabilityPath, capabilityBytes);
  writeFileSync(diagnosticPath, diagnosticBytes);
  const manifest = {
    schema_version: 1,
    kind: 'pr2258-preflight-receipt-set',
    binding: {
      ...binding,
      instrument_files: instrumentFiles,
    },
    evidence_receipts: evidenceReceipts,
    capability_review: {
      path: 'capability-review.json',
      sha256: sha256(capabilityBytes),
    },
    diagnostic_go_review: {
      path: 'diagnostic-go-review.json',
      sha256: sha256(diagnosticBytes),
    },
  };
  const manifestPath = join(root, 'receipt-set.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { manifestPath, capabilityPath, diagnosticPath, sourceRoot };
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

test('capability receipts make the diagnostic experiment ready before provider observations', () => {
  const result = preflight('diagnostic');
  expect(result).toEqual({
    ready: true,
    blockers: [],
    evidence: expect.objectContaining({
      planned_slots: 6,
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

test('diagnostic capability requires finite fake-provider skew and exact margin', () => {
  const missingSkew = preflight('diagnostic', ({ receipts }) => {
    Reflect.set(receipts.exposure, 'maximum_start_skew_s', null);
  });
  expect(missingSkew.ready).toBe(false);
  expect(missingSkew.blockers).toContain(
    'fake-provider maximum start skew evidence is missing',
  );

  const wrongMargin = preflight('diagnostic', ({ receipts }) => {
    receipts.exposure.maximum_start_skew_s = 55;
    receipts.exposure.start_skew_margin_s = 0;
  });
  expect(wrongMargin.ready).toBe(false);
  expect(wrongMargin.blockers).toContain(
    'fake-provider start skew margin must be 5 seconds, got 0',
  );
});

test('measured experiment blocks without a diagnostic GO receipt', () => {
  const result = preflight('measured', undefined, false);

  expect(result.ready).toBe(false);
  expect(result.blockers).toContain(
    'measured campaign requires an authenticated diagnostic GO receipt',
  );
});

test('authenticated diagnostic GO makes the exact measured experiment ready', () => {
  const result = preflight('measured');

  expect(result.ready).toBe(true);
  expect(result.blockers).toEqual([]);
  expect(result.evidence.planned_slots).toBe(12);
});

test('measured experiment rejects a diagnostic NO-GO bound to wrong artifacts', () => {
  const result = preflight('measured', undefined, true, (diagnostic) => {
    diagnostic.evals_sha = '9'.repeat(40);
    diagnostic.instrument_sha256 = '0'.repeat(64);
    diagnostic.valid_pairs = 2;
    diagnostic.subject_exposures = 5;
    diagnostic.delegate_capture_complete = false;
    diagnostic.unpriced_models = ['observed.delegate'];
    diagnostic.six_way_overlap_verified = false;
    diagnostic.maximum_start_skew_s = 61;
    diagnostic.grader_429_observed = true;
    diagnostic.independent_review = 'NO-GO';
  });

  expect(result.ready).toBe(false);
  expect(result.blockers).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/diagnostic GO Evals pin differs/i),
      expect.stringMatching(/instrument bytes differ/i),
      expect.stringMatching(/requires 3 valid pairs/i),
      expect.stringMatching(/requires 6 subject exposures/i),
      expect.stringMatching(/unpriced models.*observed.delegate/i),
      expect.stringMatching(/delegate model capture is incomplete/i),
      expect.stringMatching(/diagnostic six-way overlap/i),
      expect.stringMatching(/diagnostic six-way start skew/i),
      expect.stringMatching(/grader 429/i),
      expect.stringMatching(/independent review is not GO/i),
    ]),
  );
});

test('measured experiment rejects role-swapped served model IDs', () => {
  const result = preflight('measured', undefined, true, (diagnostic) => {
    const astra = diagnostic.served_model_ids.astra_subject;
    diagnostic.served_model_ids.astra_subject =
      diagnostic.served_model_ids.sol_subject;
    diagnostic.served_model_ids.sol_subject = astra;
  });

  expect(result.ready).toBe(false);
  expect(result.blockers).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/Astra subject served.*gpt-6-astra/i),
      expect.stringMatching(/Sol subject served.*gpt-5.6-sol/i),
    ]),
  );
});

test('instrument inventory includes scoring, independent review and readout', () => {
  expect(PR2258_INSTRUMENT_FILES).toEqual(
    expect.arrayContaining([
      'src/experiments/observer/score.ts',
      'src/experiments/observer/independent-review.ts',
      'src/experiments/observer/readout.ts',
    ]),
  );
});

test('missing qualification evidence stays an explicit no-go', () => {
  const result = preflight('diagnostic', ({ receipts }) => {
    receipts.grader_bearer.values_verified_distinct = false;
    receipts.runtime.claude.supported = false;
    receipts.chronology.claude.complete = false;
    receipts.pricing.offline_accounting_probe_complete = false;
    receipts.linux.complete = false;
    receipts.installed.complete = false;
    receipts.projections.complete = false;
    receipts.capacity.fake_provider_six_way_verified = false;
    receipts.exposure.fake_provider_six_way_overlap_verified = false;
  });

  expect(result.ready).toBe(false);
  expect(result.blockers).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/grader bearer.*distinct/i),
      expect.stringMatching(/Claude runtime.*unsupported/i),
      expect.stringMatching(/Claude native chronology/i),
      expect.stringMatching(/pricing accounting probe.*incomplete/i),
      expect.stringMatching(/Linux qualification/i),
      expect.stringMatching(/installed qualification/i),
      expect.stringMatching(/projection rehearsal/i),
      expect.stringMatching(/six-way capacity/i),
      expect.stringMatching(/fake-provider six-way overlap/i),
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
    'pool pr2258_opus_subjects needs 2 concurrent slots but the compiled alias-aware cap is 1',
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

test('duplicate model-capacity receipts are rejected instead of using the last row', () => {
  const result = preflight('diagnostic', ({ receipts }) => {
    receipts.capacity.models.unshift({
      model: 'gpt-6-astra',
      max_concurrency: 0,
      verified: false,
    });
  });

  expect(result.ready).toBe(false);
  expect(result.blockers).toContain(
    'model gpt-6-astra has duplicate capacity receipts',
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

test('no-follow receipt-set loader accepts exact reviewed artifacts and source bytes', () => {
  const root = mkdtempSync(join(ROOT, '.pr2258-receipts-'));
  try {
    const paths = writeReceiptSet(root);
    const input = loadPr2258ReceiptSet(paths.sourceRoot, root, 'measured');

    expect(validatePr2258Preflight(input).ready).toBe(true);
    expect(input.diagnosticGo?.review_receipt_authenticated).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('receipt-set loader rejects altered and missing reviewed artifacts', () => {
  const alteredRoot = mkdtempSync(join(ROOT, '.pr2258-receipts-'));
  const missingRoot = mkdtempSync(join(ROOT, '.pr2258-receipts-'));
  try {
    const altered = writeReceiptSet(alteredRoot);
    writeFileSync(altered.capabilityPath, '{}');
    expect(() =>
      loadPr2258ReceiptSet(altered.sourceRoot, alteredRoot, 'diagnostic'),
    ).toThrow(/capability review digest/i);

    const missing = writeReceiptSet(missingRoot);
    unlinkSync(missing.diagnosticPath);
    expect(() =>
      loadPr2258ReceiptSet(missing.sourceRoot, missingRoot, 'measured'),
    ).toThrow(/diagnostic GO review/i);
  } finally {
    rmSync(alteredRoot, { recursive: true, force: true });
    rmSync(missingRoot, { recursive: true, force: true });
  }
});

test('receipt-set loader rejects a missing referenced qualification receipt', () => {
  const root = mkdtempSync(join(ROOT, '.pr2258-receipts-'));
  try {
    const paths = writeReceiptSet(root);
    const manifest = JSON.parse(
      readFileSync(paths.manifestPath, 'utf8'),
    ) as Record<string, unknown>;
    const receipts = manifest['evidence_receipts'] as Array<
      Record<string, unknown>
    >;
    unlinkSync(join(root, receipts[0]!['path'] as string));

    expect(() =>
      loadPr2258ReceiptSet(paths.sourceRoot, root, 'diagnostic'),
    ).toThrow(/qualification evidence receipt/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('receipt-set loader refuses a symlinked reviewed artifact', () => {
  const root = mkdtempSync(join(ROOT, '.pr2258-receipts-'));
  try {
    const paths = writeReceiptSet(root);
    const targetPath = join(root, 'capability-target.json');
    writeFileSync(targetPath, readFileSync(paths.capabilityPath));
    unlinkSync(paths.capabilityPath);
    symlinkSync('capability-target.json', paths.capabilityPath);

    expect(() =>
      loadPr2258ReceiptSet(paths.sourceRoot, root, 'diagnostic'),
    ).toThrow(/capability review/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('receipt-set loader hashes each exact observer instrument source file', () => {
  const root = mkdtempSync(join(ROOT, '.pr2258-receipts-'));
  try {
    const paths = writeReceiptSet(root);
    const manifest = JSON.parse(
      readFileSync(paths.manifestPath, 'utf8'),
    ) as Record<string, unknown>;
    const binding = manifest['binding'] as Record<string, unknown>;
    const files = binding['instrument_files'] as Array<Record<string, unknown>>;
    files[0]!['sha256'] = '0'.repeat(64);
    writeFileSync(paths.manifestPath, JSON.stringify(manifest));

    expect(() =>
      loadPr2258ReceiptSet(paths.sourceRoot, root, 'diagnostic'),
    ).toThrow(/observer instrument.*digest/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('receipt-set loader blocks when a required instrument source is absent', () => {
  const root = mkdtempSync(join(ROOT, '.pr2258-receipts-'));
  try {
    const paths = writeReceiptSet(root);
    unlinkSync(join(paths.sourceRoot, 'src/experiments/observer/readout.ts'));

    expect(() =>
      loadPr2258ReceiptSet(paths.sourceRoot, root, 'diagnostic'),
    ).toThrow(/source.*readout\.ts/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('receipt-set loader rejects a reviewed receipt bound to a different pin', () => {
  const root = mkdtempSync(join(ROOT, '.pr2258-receipts-'));
  try {
    const paths = writeReceiptSet(root);
    const capability = JSON.parse(
      readFileSync(paths.capabilityPath, 'utf8'),
    ) as Record<string, unknown>;
    const binding = capability['binding'] as Record<string, unknown>;
    binding['evals_sha'] = '9'.repeat(40);
    const bytes = JSON.stringify(capability);
    writeFileSync(paths.capabilityPath, bytes);
    const manifest = JSON.parse(
      readFileSync(paths.manifestPath, 'utf8'),
    ) as Record<string, unknown>;
    const capabilityRef = manifest['capability_review'] as Record<
      string,
      unknown
    >;
    capabilityRef['sha256'] = sha256(bytes);
    writeFileSync(paths.manifestPath, JSON.stringify(manifest));

    expect(() =>
      loadPr2258ReceiptSet(paths.sourceRoot, root, 'diagnostic'),
    ).toThrow(/capability review binding/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('receipt-set loader hashes current pricing bytes instead of trusting its manifest', () => {
  const root = mkdtempSync(join(ROOT, '.pr2258-receipts-'));
  try {
    const paths = writeReceiptSet(root);
    const manifest = JSON.parse(
      readFileSync(paths.manifestPath, 'utf8'),
    ) as Record<string, unknown>;
    const binding = manifest['binding'] as Record<string, unknown>;
    binding['pricing_sha256'] = '0'.repeat(64);
    const capability = JSON.parse(
      readFileSync(paths.capabilityPath, 'utf8'),
    ) as Record<string, unknown>;
    const capabilityBinding = capability['binding'] as Record<string, unknown>;
    capabilityBinding['pricing_sha256'] = '0'.repeat(64);
    const capabilityBytes = JSON.stringify(capability);
    writeFileSync(paths.capabilityPath, capabilityBytes);
    const capabilityRef = manifest['capability_review'] as Record<
      string,
      unknown
    >;
    capabilityRef['sha256'] = sha256(capabilityBytes);
    writeFileSync(paths.manifestPath, JSON.stringify(manifest));

    expect(() =>
      loadPr2258ReceiptSet(paths.sourceRoot, root, 'diagnostic'),
    ).toThrow(/source pricing snapshot digest/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([
  ['subjects', 2, false],
  ['subjects', 4, true],
  ['subject-grader', 6, false],
  ['subject-grader', 8, true],
] as const)('shared %s pool capacity %s checks aggregate demand', (kind, cap, ready) => {
  const result = preflight('diagnostic', ({ credentials }) => {
    const names =
      kind === 'subjects'
        ? ['openai_responses_6astra', 'openai_responses_56sol']
        : ['opus5_bedrock', 'sonnet5_bedrock_pr2258_grader'];
    for (const name of names) {
      credentials[name]!.quota_pool = 'shared-first-wave';
      credentials[name]!.max_concurrency = cap;
    }
  });
  if (kind === 'subjects') expect(result.ready).toBe(ready);
  else {
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain(
      'Opus subject credential must retain max_concurrency 4',
    );
    if (ready)
      expect(result.blockers).toEqual([
        'public grader credential must pin Sonnet 5 Mantle us-east-1, its dedicated bearer name and cap 6',
        'Opus subject credential must retain max_concurrency 4',
      ]);
  }
  if (!ready)
    expect(result.blockers).toContain(
      `pool shared-first-wave needs ${kind === 'subjects' ? 4 : 8} concurrent slots but the compiled alias-aware cap is ${cap}`,
    );
});

test('split rows cannot declare the same account capacity twice', () => {
  let parsed = true;
  const result = preflight('diagnostic', ({ receipts }) => {
    const first = receipts.capacity.accounts.shift()!;
    receipts.capacity.accounts.push(
      ...first.credentials.map((credential) => ({
        ...first,
        credentials: [credential],
        max_concurrency: 2,
      })),
    );
    parsed = Pr2258QualificationReceiptsSchema.safeParse(receipts).success;
  });
  expect(result.ready).toBe(false);
  expect(result.blockers).toContain(
    'account openai-subject-account has duplicate capacity receipts',
  );
  expect(parsed).toBe(false);
  expect(preflight('diagnostic').ready).toBe(true);
});

test.each([
  'wrong-head',
  'dirty-unlisted',
  'missing-git',
  'assume-unchanged',
] as const)('receipt-set source authority rejects %s', (change) => {
  const root = mkdtempSync(join(ROOT, '.pr2258-receipts-'));
  try {
    const paths = writeReceiptSet(root);
    if (change === 'missing-git')
      rmSync(join(paths.sourceRoot, '.git'), { recursive: true });
    else {
      if (change === 'assume-unchanged')
        git(paths.sourceRoot, [
          'update-index',
          '--assume-unchanged',
          'src/runner/index.ts',
        ]);
      writeFileSync(
        join(paths.sourceRoot, 'src/runner/index.ts'),
        'changed executed runner bytes',
      );
      if (change === 'wrong-head') {
        git(paths.sourceRoot, ['add', '.']);
        git(paths.sourceRoot, [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '-qm',
          'Different instrument',
        ]);
      }
    }
    expect(() =>
      loadPr2258ReceiptSet(paths.sourceRoot, root, 'diagnostic'),
    ).toThrow(/source/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('source mutation during receipt intake refuses qualification reuse', () => {
  const root = mkdtempSync(join(ROOT, '.pr2258-receipts-'));
  try {
    const paths = writeReceiptSet(root);
    let scans = 0;
    const runner = {
      run: ((command, args, options) => {
        if (args.includes('ls-tree') && ++scans === 2)
          writeFileSync(
            join(paths.sourceRoot, 'src/runner/index.ts'),
            'changed during intake',
          );
        return defaultCommandRunner.run(command, args, options);
      }) satisfies typeof defaultCommandRunner.run,
    };
    expect(() =>
      loadPr2258ReceiptSet(paths.sourceRoot, root, 'diagnostic', runner),
    ).toThrow(/source/i);
    expect(scans).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
