#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { compileResourcePolicy } from '../src/campaign/resource-policy.ts';
import { ArmSchema, type Arm } from '../src/contracts/campaign/arm.ts';
import {
  GraderSchema,
  type Grader,
  type PoolPolicy,
} from '../src/contracts/campaign/experiment.ts';
import { poolKey } from '../src/contracts/campaign/pool.ts';
import { SuiteSchema, type Suite } from '../src/contracts/campaign/suite.ts';
import {
  parseCredentialsFile,
  type Credential,
} from '../src/contracts/credential.ts';
import { repoRoot } from '../src/paths.ts';

const SHA256_RE = /^[a-f0-9]{64}$/;
const GIT_SHA_RE = /^[a-f0-9]{40}$/;
const IMAGE_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const EXPECTED_PAIRS = [
  ['codex_astra_pr2258_base', 'codex_astra_pr2258_head'],
  ['codex_sol_pr2258_base', 'codex_sol_pr2258_head'],
  ['claude_opus5_pr2258_base', 'claude_opus5_pr2258_head'],
] as const;
const EXPECTED_REFS = {
  base: 'fd02874aa5c55ba3c2bca431253b48e0e4c8be5a',
  head: '069edf3ffc2ffdce80a84d3344a4064acec7e10c',
} as const;
const EXPECTED_SCENARIO = 'brainstorming-todo-shared-intent';
const EXPECTED_GRADER = 'sonnet5_bedrock_pr2258_grader';
const EXPECTED_GRADER_MODEL = 'anthropic.claude-sonnet-5';

const RuntimeReceiptSchema = z
  .object({
    supported: z.boolean(),
    installed_build: z.string().min(1).nullable(),
    qualified_build: z.string().min(1).nullable(),
    requested_effort: z.string().min(1).nullable(),
    settings_verified: z.boolean(),
  })
  .strict();
const EvidenceReceiptSchema = z
  .object({
    complete: z.boolean(),
    receipt_sha256: z.string().nullable(),
  })
  .strict();
const BoundaryReceiptSchema = EvidenceReceiptSchema.extend({
  evals_sha: z.string().nullable(),
  gauntlet_sha: z.string().nullable(),
  image_digest: z.string().nullable(),
}).strict();

export const Pr2258QualificationReceiptsSchema = z
  .object({
    frozen_pins: z
      .object({
        evals_sha: z.string().nullable(),
        gauntlet_sha: z.string().nullable(),
        image_digest: z.string().nullable(),
      })
      .strict(),
    runtime: z
      .object({ codex: RuntimeReceiptSchema, claude: RuntimeReceiptSchema })
      .strict(),
    timing: z
      .object({
        subject_instruction_cutoff_s: z.number().int().positive(),
        subject_cutoff_mechanically_enforced: z.boolean(),
        gauntlet_allowance_s: z.number().int().positive(),
      })
      .strict(),
    chronology: z
      .object({
        codex: EvidenceReceiptSchema,
        claude: EvidenceReceiptSchema,
      })
      .strict(),
    linux: BoundaryReceiptSchema,
    installed: BoundaryReceiptSchema,
    projections: z
      .object({
        complete: z.boolean(),
        cleaned: z.boolean(),
        arm_names: z.array(z.string()),
        grader_credential: z.string().nullable(),
        receipt_sha256: z.string().nullable(),
      })
      .strict(),
    grader_bearer: z
      .object({
        values_verified_distinct: z.boolean(),
        receipt_sha256: z.string().nullable(),
      })
      .strict(),
    pricing: z
      .object({
        installed_sha256: z.string().nullable(),
        complete: z.boolean(),
        observed_models: z.array(z.string()),
        priced_models: z.array(z.string()),
        unpriced_models: z.array(z.string()),
        service_tiers_verified: z.boolean(),
        cache_buckets_verified: z.boolean(),
        separately_billed_tools: z.enum([
          'none-observed',
          'priced',
          'unverified',
        ]),
        receipt_sha256: z.string().nullable(),
      })
      .strict(),
    capacity: z
      .object({
        simultaneous_mix_verified: z.boolean(),
        accounts: z.array(
          z
            .object({
              account: z.string().min(1),
              credentials: z.array(z.string().min(1)).min(1),
              max_concurrency: z.number().int().nonnegative(),
              verified: z.boolean(),
            })
            .strict(),
        ),
        models: z.array(
          z
            .object({
              model: z.string().min(1),
              max_concurrency: z.number().int().nonnegative(),
              verified: z.boolean(),
            })
            .strict(),
        ),
        receipt_sha256: z.string().nullable(),
      })
      .strict(),
    exposure: z
      .object({
        six_way_overlap_verified: z.boolean(),
        maximum_start_skew_s: z.number().nonnegative().nullable(),
        receipt_sha256: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

export type Pr2258QualificationReceipts = z.infer<
  typeof Pr2258QualificationReceiptsSchema
>;

export interface Pr2258PreflightInput {
  suite: Suite;
  grader: Grader;
  arms: Readonly<Record<string, Arm>>;
  credentials: Readonly<Record<string, Credential>>;
  globalCap: number;
  qualification: Pr2258QualificationReceipts;
}

export interface Pr2258PreflightResult {
  ready: boolean;
  blockers: string[];
  evidence: {
    planned_slots: number;
    global_cap: number;
    concurrent_subjects: number;
    concurrent_graders: number;
    subject_demand_by_model: Record<string, number>;
    grader_demand_by_model: Record<string, number>;
    resource_policy: PoolPolicy[];
    pricing_snapshot: Suite['pricing_snapshot'];
  };
}

function addCount(record: Record<string, number>, key: string, count: number) {
  record[key] = (record[key] ?? 0) + count;
}

function hasReceiptDigest(value: string | null): boolean {
  return value !== null && SHA256_RE.test(value);
}

function expectedArmNames(): string[] {
  return EXPECTED_PAIRS.flatMap(([baseline, treatment]) => [
    baseline,
    treatment,
  ]).sort();
}

function exactStringSet(actual: readonly string[], expected: readonly string[]) {
  return (
    actual.length === expected.length &&
    [...actual].sort().every((value, index) => value === [...expected].sort()[index])
  );
}

export function validatePr2258Preflight(
  input: Pr2258PreflightInput,
): Pr2258PreflightResult {
  const blockers: string[] = [];
  const { suite, grader, arms, credentials, qualification } = input;
  const expectedRepetitions =
    suite.name === 'pr2258_parallel_diagnostic'
      ? 1
      : suite.name === 'pr2258_parallel_measured'
        ? 2
        : null;
  if (expectedRepetitions === null)
    blockers.push(`unsupported PR 2258 suite name ${suite.name}`);
  if (input.globalCap !== 6)
    blockers.push(`global capacity must be 6, got ${input.globalCap}`);
  if (suite.comparisons.length !== 3)
    blockers.push(`suite must declare exactly 3 comparisons, got ${suite.comparisons.length}`);
  if (suite.reserve !== 0) blockers.push(`suite reserve must be 0, got ${suite.reserve}`);
  if (suite.max_exposure_skew !== 60)
    blockers.push(`suite exposure skew must be 60 seconds, got ${suite.max_exposure_skew}`);
  if (suite.attempt_bounds.max_attempts !== 1)
    blockers.push(`suite max_attempts must be 1, got ${suite.attempt_bounds.max_attempts}`);
  if (suite.attempt_bounds.max_time_s !== 2400)
    blockers.push(`suite max_time_s must be 2400, got ${suite.attempt_bounds.max_time_s}`);

  EXPECTED_PAIRS.forEach(([baseline, treatment], index) => {
    const comparison = suite.comparisons[index];
    if (
      comparison === undefined ||
      'arm' in comparison ||
      comparison.baseline !== baseline ||
      comparison.treatment !== treatment
    ) {
      blockers.push(`comparison ${index + 1} must be ${baseline} versus ${treatment}`);
      return;
    }
    if (
      !Array.isArray(comparison.scenarios) ||
      comparison.scenarios.length !== 1 ||
      comparison.scenarios[0] !== EXPECTED_SCENARIO
    )
      blockers.push(`comparison ${index + 1} must use only ${EXPECTED_SCENARIO}`);
    if (expectedRepetitions !== null && comparison.n !== expectedRepetitions)
      blockers.push(`comparison ${index + 1} must use n=${expectedRepetitions}`);
  });

  const expectedArms = expectedArmNames();
  for (const [baseline, treatment] of EXPECTED_PAIRS) {
    const baseArm = arms[baseline];
    const headArm = arms[treatment];
    if (baseArm?.superpowers !== EXPECTED_REFS.base)
      blockers.push(`arm ${baseline} must pin base ${EXPECTED_REFS.base}`);
    if (headArm?.superpowers !== EXPECTED_REFS.head)
      blockers.push(`arm ${treatment} must pin head ${EXPECTED_REFS.head}`);
  }
  const expectedArmConfiguration: Record<
    string,
    { agent: string; credential: string }
  > = {
    codex_astra_pr2258_base: { agent: 'codex', credential: 'openai_responses_6astra' },
    codex_astra_pr2258_head: { agent: 'codex', credential: 'openai_responses_6astra' },
    codex_sol_pr2258_base: { agent: 'codex', credential: 'openai_responses_56sol' },
    codex_sol_pr2258_head: { agent: 'codex', credential: 'openai_responses_56sol' },
    claude_opus5_pr2258_base: { agent: 'claude', credential: 'opus5_bedrock' },
    claude_opus5_pr2258_head: { agent: 'claude', credential: 'opus5_bedrock' },
  };
  for (const [name, expected] of Object.entries(expectedArmConfiguration)) {
    const arm = arms[name];
    if (arm === undefined) {
      blockers.push(`arm ${name} is missing`);
      continue;
    }
    if (arm.agent !== expected.agent || arm.credential !== expected.credential || arm.os !== 'linux')
      blockers.push(`arm ${name} must use ${expected.agent}/${expected.credential} on linux`);
  }

  if (grader.credential !== EXPECTED_GRADER || grader.model !== EXPECTED_GRADER_MODEL)
    blockers.push(`grader must be ${EXPECTED_GRADER} on ${EXPECTED_GRADER_MODEL}`);
  const graderCredential = credentials[EXPECTED_GRADER];
  if (
    graderCredential === undefined ||
    graderCredential.model !== EXPECTED_GRADER_MODEL ||
    graderCredential.api !== 'mantle' ||
    graderCredential.auth !== 'bedrock-bearer' ||
    graderCredential.api_key_env !== 'QUORUM_PR2258_GRADER_BEARER' ||
    graderCredential.region !== 'us-east-1' ||
    graderCredential.max_concurrency !== 6
  )
    blockers.push('public grader credential must pin Sonnet 5 Mantle us-east-1, its dedicated bearer name and cap 6');
  const opusCredential = credentials['opus5_bedrock'];
  if (opusCredential?.max_concurrency !== 4)
    blockers.push('Opus subject credential must retain max_concurrency 4');
  if (
    graderCredential?.api_key_env === undefined ||
    graderCredential.api_key_env === opusCredential?.api_key_env
  )
    blockers.push('public grader bearer environment name must differ from the Opus subject bearer name');
  if (!qualification.grader_bearer.values_verified_distinct)
    blockers.push('grader bearer values are not verified distinct from the Opus subject bearer');
  if (!hasReceiptDigest(qualification.grader_bearer.receipt_sha256))
    blockers.push('grader bearer separation receipt is missing');

  const runtimeChecks = [
    ['Codex', qualification.runtime.codex, 'xhigh'],
    ['Claude', qualification.runtime.claude, null],
  ] as const;
  for (const [label, receipt, requiredEffort] of runtimeChecks) {
    if (!receipt.supported) blockers.push(`${label} runtime is unsupported`);
    if (
      receipt.installed_build === null ||
      receipt.qualified_build === null ||
      receipt.installed_build !== receipt.qualified_build
    )
      blockers.push(`${label} installed build does not match its qualified build`);
    if (!receipt.settings_verified)
      blockers.push(`${label} runtime settings are not verified`);
    if (
      receipt.requested_effort === null ||
      (requiredEffort !== null && receipt.requested_effort !== requiredEffort)
    )
      blockers.push(
        requiredEffort === null
          ? `${label} requested effort or recorded default is missing`
          : `${label} requested effort must be ${requiredEffort}`,
      );
  }
  if (qualification.timing.subject_instruction_cutoff_s !== 1500)
    blockers.push(
      `the instructed subject cutoff must be 1500 seconds, got ${qualification.timing.subject_instruction_cutoff_s}`,
    );
  if (qualification.timing.subject_cutoff_mechanically_enforced)
    blockers.push(
      'the 25-minute subject cutoff must remain recorded as instructed, not mechanically enforced',
    );
  if (qualification.timing.gauntlet_allowance_s !== 1800)
    blockers.push(
      `the enforced Gauntlet allowance must be 1800 seconds, got ${qualification.timing.gauntlet_allowance_s}`,
    );

  for (const [label, receipt] of [
    ['Codex', qualification.chronology.codex],
    ['Claude', qualification.chronology.claude],
  ] as const) {
    if (!receipt.complete || !hasReceiptDigest(receipt.receipt_sha256))
      blockers.push(`${label} native chronology coverage is incomplete`);
  }

  const pins = qualification.frozen_pins;
  if (!pins.evals_sha || !GIT_SHA_RE.test(pins.evals_sha))
    blockers.push('frozen Evals pin is missing');
  if (!pins.gauntlet_sha || !GIT_SHA_RE.test(pins.gauntlet_sha))
    blockers.push('frozen Gauntlet pin is missing');
  if (!pins.image_digest || !IMAGE_DIGEST_RE.test(pins.image_digest))
    blockers.push('frozen image digest is missing');
  for (const [label, receipt] of [
    ['Linux', qualification.linux],
    ['installed', qualification.installed],
  ] as const) {
    if (!receipt.complete || !hasReceiptDigest(receipt.receipt_sha256))
      blockers.push(`${label} qualification receipt is incomplete`);
    if (receipt.evals_sha !== pins.evals_sha)
      blockers.push(`${label} Evals pin differs from the frozen preflight pin`);
    if (receipt.gauntlet_sha !== pins.gauntlet_sha)
      blockers.push(`${label} Gauntlet pin differs from the frozen preflight pin`);
    if (receipt.image_digest !== pins.image_digest)
      blockers.push(`${label} image digest differs from the frozen preflight pin`);
  }

  const projections = qualification.projections;
  if (!projections.complete || !hasReceiptDigest(projections.receipt_sha256))
    blockers.push('actual credential projection rehearsal is incomplete');
  if (!projections.cleaned)
    blockers.push('credential projection rehearsal stages were not verified cleaned');
  if (!exactStringSet(projections.arm_names, expectedArms))
    blockers.push('credential projection rehearsal does not cover all six arms exactly');
  if (projections.grader_credential !== EXPECTED_GRADER)
    blockers.push('credential projection rehearsal does not cover the selected grader');

  const pricing = qualification.pricing;
  if (
    suite.pricing_snapshot === undefined ||
    !suite.pricing_snapshot.path.endsWith('/current.json')
  )
    blockers.push('suite pricing snapshot must name a canonical current.json');
  if (pricing.installed_sha256 !== suite.pricing_snapshot?.sha256)
    blockers.push('installed worker pricing digest differs from the suite snapshot');
  if (!pricing.complete) blockers.push('pricing coverage is incomplete');
  const primaryModels = [
    'gpt-6-astra',
    'gpt-5.6-sol',
    'anthropic.claude-opus-5',
    EXPECTED_GRADER_MODEL,
  ];
  for (const model of primaryModels)
    if (!pricing.priced_models.includes(model))
      blockers.push(`pricing does not cover primary model ${model}`);
  for (const model of pricing.observed_models)
    if (!pricing.priced_models.includes(model))
      blockers.push(`observed model ${model} is not priced for its endpoint`);
  if (pricing.unpriced_models.length > 0)
    blockers.push(`pricing has unpriced models: ${[...pricing.unpriced_models].sort().join(', ')}`);
  if (!pricing.service_tiers_verified)
    blockers.push('pricing service tiers are not verified in the worker');
  if (!pricing.cache_buckets_verified)
    blockers.push('pricing cache buckets are not verified in the worker');
  if (pricing.separately_billed_tools === 'unverified')
    blockers.push('separately billed tool usage is not verified or priced');
  if (!hasReceiptDigest(pricing.receipt_sha256))
    blockers.push('worker pricing qualification receipt is missing');

  const subjectDemandByCredential: Record<string, number> = {
    openai_responses_6astra: 2,
    openai_responses_56sol: 2,
    opus5_bedrock: 2,
  };
  const demandByCredential: Record<string, number> = {
    ...subjectDemandByCredential,
    [EXPECTED_GRADER]: 6,
  };
  const subjectDemandByModel: Record<string, number> = {};
  for (const [credentialName, count] of Object.entries(subjectDemandByCredential)) {
    const credential = credentials[credentialName];
    if (credential === undefined) {
      blockers.push(`subject credential ${credentialName} is missing`);
      continue;
    }
    addCount(subjectDemandByModel, credential.model, count);
  }
  const graderDemandByModel = { [EXPECTED_GRADER_MODEL]: 6 };
  const activeCredentialNames = Object.keys(demandByCredential);
  let policy: ReadonlyMap<string, PoolPolicy> = new Map();
  try {
    policy = compileResourcePolicy(credentials, activeCredentialNames);
    for (const [credentialName, needed] of Object.entries(demandByCredential)) {
      const credential = credentials[credentialName];
      if (credential === undefined) continue;
      const id = poolKey(credential, credentialName);
      const available = policy.get(id)?.max_concurrency;
      const role = credentialName === EXPECTED_GRADER ? 'grader' : 'subject';
      if (available === undefined)
        blockers.push(`${role} pool ${id} is absent from compiled resource policy`);
      else if (available < needed)
        blockers.push(`${role} pool ${id} needs ${needed} concurrent slots but the compiled alias-aware cap is ${available}`);
    }
  } catch (error) {
    blockers.push(`resource policy could not compile: ${error instanceof Error ? error.message : 'unknown error'}`);
  }

  const assignedAccounts = new Map<string, string>();
  for (const account of qualification.capacity.accounts) {
    let needed = 0;
    for (const credential of account.credentials) {
      if (assignedAccounts.has(credential))
        blockers.push(`credential ${credential} appears in more than one account capacity receipt`);
      assignedAccounts.set(credential, account.account);
      needed += demandByCredential[credential] ?? 0;
    }
    if (!account.verified)
      blockers.push(`account ${account.account} capacity is unverified`);
    else if (account.max_concurrency < needed)
      blockers.push(`account ${account.account} needs ${needed} concurrent calls but verified capacity is ${account.max_concurrency}`);
  }
  for (const credential of activeCredentialNames)
    if (!assignedAccounts.has(credential))
      blockers.push(`credential ${credential} has no aggregate account capacity receipt`);

  const modelDemand: Record<string, number> = { ...subjectDemandByModel };
  addCount(modelDemand, EXPECTED_GRADER_MODEL, 6);
  const modelReceipts = new Map(
    qualification.capacity.models.map((receipt) => [receipt.model, receipt]),
  );
  for (const [model, needed] of Object.entries(modelDemand)) {
    const receipt = modelReceipts.get(model);
    if (receipt === undefined || !receipt.verified)
      blockers.push(`model ${model} has no verified capacity receipt`);
    else if (receipt.max_concurrency < needed)
      blockers.push(`model ${model} needs ${needed} concurrent calls but verified capacity is ${receipt.max_concurrency}`);
  }
  if (!qualification.capacity.simultaneous_mix_verified)
    blockers.push('six-way capacity is not verified for the simultaneous subject/grader mix');
  if (!hasReceiptDigest(qualification.capacity.receipt_sha256))
    blockers.push('six-way capacity receipt is missing');

  const firstWaveBlocksByPool = new Map<string, Set<string>>();
  const addBlock = (poolId: string, blockId: string) => {
    const blocks = firstWaveBlocksByPool.get(poolId) ?? new Set<string>();
    blocks.add(blockId);
    firstWaveBlocksByPool.set(poolId, blocks);
  };
  suite.comparisons.forEach((comparison, comparisonIndex) => {
    if (!Array.isArray(comparison.scenarios)) return;
    const armNames =
      'arm' in comparison
        ? [comparison.arm]
        : [comparison.baseline, comparison.treatment];
    for (const scenario of comparison.scenarios) {
      const blockId = `c${comparisonIndex + 1}:${scenario}:b1`;
      for (const armName of armNames) {
        const arm = arms[armName];
        const credential = arm && credentials[arm.credential];
        if (arm && credential)
          addBlock(poolKey(credential, arm.credential), blockId);
      }
      if (graderCredential)
        addBlock(poolKey(graderCredential, EXPECTED_GRADER), blockId);
    }
  });
  const graderPool =
    graderCredential && poolKey(graderCredential, EXPECTED_GRADER);
  for (const [poolId, blocks] of firstWaveBlocksByPool) {
    const compiled = policy.get(poolId);
    const spacing = compiled?.launch_spacing_seconds ?? 0;
    const span = spacing * Math.max(0, blocks.size - 1);
    if (span > suite.max_exposure_skew) {
      const role = poolId === graderPool ? 'grader' : 'subject';
      blockers.push(`${role} pool ${compiled?.pool_id ?? poolId} spacing requires ${span} seconds, beyond the 60-second exposure bound`);
    }
  }
  if (!qualification.exposure.six_way_overlap_verified)
    blockers.push('six-way overlap is not verified');
  if (
    qualification.exposure.maximum_start_skew_s === null ||
    qualification.exposure.maximum_start_skew_s > suite.max_exposure_skew
  )
    blockers.push('observed six-way start skew does not satisfy the 60-second exposure bound');
  if (!hasReceiptDigest(qualification.exposure.receipt_sha256))
    blockers.push('six-way exposure receipt is missing');

  const plannedSlots = suite.comparisons.reduce((sum, comparison) => {
    const armsPerComparison = 'arm' in comparison ? 1 : 2;
    const scenarios = Array.isArray(comparison.scenarios) ? comparison.scenarios.length : 0;
    return sum + armsPerComparison * comparison.n * scenarios;
  }, 0);
  const evidence: Pr2258PreflightResult['evidence'] = {
    planned_slots: plannedSlots,
    global_cap: input.globalCap,
    concurrent_subjects: 6,
    concurrent_graders: 6,
    subject_demand_by_model: Object.fromEntries(
      Object.entries(subjectDemandByModel).sort(([a], [b]) => a.localeCompare(b)),
    ),
    grader_demand_by_model: graderDemandByModel,
    resource_policy: [...policy.values()],
    pricing_snapshot: suite.pricing_snapshot,
  };
  return { ready: blockers.length === 0, blockers, evidence };
}

function loadInput(
  root: string,
  suiteKind: 'diagnostic' | 'measured',
  qualification: Pr2258QualificationReceipts,
): Pr2258PreflightInput {
  const suitePath = join(root, `suites/pr2258_parallel_${suiteKind}.yaml`);
  const raw = parseYaml(readFileSync(suitePath, 'utf8')) as Record<string, unknown>;
  const grader = GraderSchema.parse(raw['grader']);
  const { grader: _grader, ...suiteFields } = raw;
  const suite = SuiteSchema.parse(suiteFields);
  const arms: Record<string, Arm> = {};
  for (const [baseline, treatment] of EXPECTED_PAIRS) {
    for (const name of [baseline, treatment])
      arms[name] = ArmSchema.parse(
        parseYaml(readFileSync(join(root, 'arms', `${name}.yaml`), 'utf8')),
      );
  }
  const credentials = parseCredentialsFile(
    parseYaml(readFileSync(join(root, 'credentials.yaml'), 'utf8')),
  );
  return { suite, grader, arms, credentials, globalCap: 6, qualification };
}

export function main(args: string[]): number {
  const [suiteKind, receiptPath] = args;
  if (
    (suiteKind !== 'diagnostic' && suiteKind !== 'measured') ||
    receiptPath === undefined
  ) {
    console.error('usage: bun scripts/pr2258-preflight.ts <diagnostic|measured> <qualification-receipt.json>');
    return 2;
  }
  let qualification: Pr2258QualificationReceipts;
  try {
    const parsed = JSON.parse(readFileSync(receiptPath, 'utf8'));
    qualification = Pr2258QualificationReceiptsSchema.parse(parsed);
  } catch {
    console.error(JSON.stringify({ ready: false, blockers: ['qualification receipt is missing or invalid'] }));
    return 2;
  }
  try {
    const result = validatePr2258Preflight(
      loadInput(repoRoot(), suiteKind, qualification),
    );
    console.log(JSON.stringify(result, null, 2));
    return result.ready ? 0 : 1;
  } catch {
    console.error(JSON.stringify({ ready: false, blockers: ['public preflight declarations are invalid'] }));
    return 2;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
