#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { lstatSync, readlinkSync, realpathSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { blockDemandVector, compileResourcePolicy } from '../src/campaign/resource-policy.ts';
import { GLOBAL_POOL } from '../src/campaign/simulate.ts';
import { defaultCommandRunner, type CommandRunner } from '../src/agents/command-runner.ts';
import { getEnv } from '../src/env.ts';
import { closePin, pinAbsoluteDir, readPinnedNoFollowBytes } from '../src/appliance/credential-scope.ts';
import { ArmSchema, type Arm } from '../src/contracts/campaign/arm.ts';
import {
  GraderSchema,
  type Grader,
  type PoolPolicy,
} from '../src/contracts/campaign/experiment.ts';
import { poolKey } from '../src/contracts/campaign/pool.ts';
import { jcsCanonicalize } from '../src/contracts/campaign/digest.ts';
import { RelativeArtifactPathSchema } from '../src/contracts/campaign/execution.ts';
import { SuiteSchema, type Suite } from '../src/contracts/campaign/suite.ts';
import {
  parseCredentialsFile,
  type Credential,
} from '../src/contracts/credential.ts';
import { repoRoot } from '../src/paths.ts';
import { sharesMantleCredentialSource } from '../src/credentials/scope.ts';

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
const EXPECTED_GRADER = 'sonnet5_bedrock';
const EXPECTED_GRADER_MODEL = 'anthropic.claude-sonnet-5';

export const PR2258_INSTRUMENT_FILES = [
  'src/experiments/observer/binding.ts',
  'src/experiments/observer/bundle.ts',
  'src/experiments/observer/claude.ts',
  'src/experiments/observer/codex.ts',
  'src/experiments/observer/contracts.ts',
  'src/experiments/observer/final-state.ts',
  'src/experiments/observer/independent-review.ts',
  'src/experiments/observer/raw.ts',
  'src/experiments/observer/readout.ts',
  'src/experiments/observer/review.ts',
  'src/experiments/observer/score.ts',
] as const;

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
        shared_source_verified: z.boolean(),
        receipt_sha256: z.string().nullable(),
      })
      .strict(),
    pricing: z
      .object({
        installed_sha256: z.string().nullable(),
        offline_accounting_probe_complete: z.boolean(),
        primary_models_priced: z.array(z.string()),
        receipt_sha256: z.string().nullable(),
      })
      .strict(),
    capacity: z
      .object({
        fake_provider_six_way_verified: z.boolean(),
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
        fake_provider_six_way_overlap_verified: z.boolean(),
        maximum_start_skew_s: z.number().nonnegative().nullable(),
        start_skew_margin_s: z.number().nonnegative().nullable(),
        receipt_sha256: z.string().nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const accounts = new Set<string>();
    value.capacity.accounts.forEach((receipt, index) => {
      if (accounts.has(receipt.account))
        context.addIssue({ code: 'custom', message: `duplicate account capacity receipt for ${receipt.account}`, path: ['capacity', 'accounts', index, 'account'] });
      accounts.add(receipt.account);
    });
    const seen = new Set<string>();
    value.capacity.models.forEach((receipt, index) => {
      if (seen.has(receipt.model))
        context.addIssue({
          code: 'custom',
          message: `duplicate model capacity receipt for ${receipt.model}`,
          path: ['capacity', 'models', index, 'model'],
        });
      seen.add(receipt.model);
    });
  });

export type Pr2258QualificationReceipts = z.infer<
  typeof Pr2258QualificationReceiptsSchema
>;

export const Pr2258DiagnosticGoSchema = z
  .object({
    review_receipt_authenticated: z.literal(true),
    campaign_id: z.string().min(1),
    input_digest: z.string().regex(SHA256_RE),
    evals_sha: z.string().regex(GIT_SHA_RE),
    gauntlet_sha: z.string().regex(GIT_SHA_RE),
    image_digest: z.string().regex(IMAGE_DIGEST_RE),
    pricing_sha256: z.string().regex(SHA256_RE),
    instrument_sha256: z.string().regex(SHA256_RE),
    valid_pairs: z.number().int().nonnegative(),
    subject_exposures: z.number().int().nonnegative(),
    served_model_ids: z
      .object({
        astra_subject: z.string().min(1),
        sol_subject: z.string().min(1),
        opus_subject: z.string().min(1),
        sonnet_grader: z.string().min(1),
      })
      .strict(),
    delegate_model_ids: z.array(z.string().min(1)),
    delegate_capture_complete: z.boolean(),
    priced_models: z.array(z.string().min(1)),
    unpriced_models: z.array(z.string().min(1)),
    service_tiers_verified: z.boolean(),
    cache_buckets_verified: z.boolean(),
    separately_billed_tools: z.enum([
      'none-observed',
      'priced',
      'unverified',
    ]),
    six_way_overlap_verified: z.boolean(),
    maximum_start_skew_s: z.number().nonnegative().nullable(),
    grader_429_observed: z.boolean(),
    independent_review: z.enum(['GO', 'NO-GO']),
  })
  .strict();

export type Pr2258DiagnosticGo = z.infer<typeof Pr2258DiagnosticGoSchema>;

const ReceiptSetBindingSchema = z
  .object({
    evals_sha: z.string().regex(GIT_SHA_RE),
    gauntlet_sha: z.string().regex(GIT_SHA_RE),
    image_digest: z.string().regex(IMAGE_DIGEST_RE),
    pricing_sha256: z.string().regex(SHA256_RE),
    instrument_sha256: z.string().regex(SHA256_RE),
  })
  .strict();
const ReceiptReferenceSchema = z
  .object({
    path: RelativeArtifactPathSchema,
    sha256: z.string().regex(SHA256_RE),
  })
  .strict();
const InstrumentFileSchema = z
  .object({
    path: RelativeArtifactPathSchema,
    sha256: z.string().regex(SHA256_RE),
  })
  .strict();
const ReceiptSetManifestSchema = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal('pr2258-preflight-receipt-set'),
    binding: ReceiptSetBindingSchema.extend({
      instrument_files: z.array(InstrumentFileSchema),
    }).strict(),
    evidence_receipts: z.array(ReceiptReferenceSchema),
    capability_review: ReceiptReferenceSchema,
    diagnostic_go_review: ReceiptReferenceSchema.optional(),
  })
  .strict();
const CapabilityReviewSchema = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal('pr2258-capability-review'),
    reviewed_by: z.string().min(1),
    reviewed_at: z.string().datetime({ offset: true }),
    binding: ReceiptSetBindingSchema,
    qualification: Pr2258QualificationReceiptsSchema,
  })
  .strict();
const DiagnosticGoReviewSchema = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal('pr2258-diagnostic-go-review'),
    reviewed_by: z.string().min(1),
    reviewed_at: z.string().datetime({ offset: true }),
    binding: ReceiptSetBindingSchema,
    diagnostic_go: Pr2258DiagnosticGoSchema.omit({
      review_receipt_authenticated: true,
    }),
  })
  .strict();

type InstrumentFile = z.infer<typeof InstrumentFileSchema>;

function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function digestPr2258InstrumentFiles(
  files: readonly InstrumentFile[],
): string {
  const canonical = [...files].sort((a, b) => a.path.localeCompare(b.path));
  return createHash('sha256')
    .update(jcsCanonicalize(canonical))
    .digest('hex');
}

export interface Pr2258PreflightInput {
  suite: Suite;
  grader: Grader;
  arms: Readonly<Record<string, Arm>>;
  credentials: Readonly<Record<string, Credential>>;
  globalCap: number;
  qualification: Pr2258QualificationReceipts;
  instrumentSha256?: string;
  diagnosticGo?: Pr2258DiagnosticGo;
}

export interface Pr2258PreflightResult {
  ready: boolean;
  blockers: string[];
  qualification_gaps: string[];
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
  const qualificationGaps: string[] = [];
  const { suite, grader, arms, credentials, qualification } = input;
  const expectedRepetitions =
    suite.name === 'pr2258_parallel_diagnostic'
      ? 1
      : suite.name === 'pr2258_parallel_measured'
        ? 2
        : null;
  const measured = suite.name === 'pr2258_parallel_measured';
  // Diagnostics collect missing native and concurrency evidence; measurements require it.
  const qualificationChecks = measured ? blockers : qualificationGaps;
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
    graderCredential.api_key_env !== 'AWS_BEARER_TOKEN_BEDROCK' ||
    graderCredential.region !== 'us-east-1' ||
    graderCredential.max_concurrency !== 6
  )
    blockers.push('public grader credential must pin Sonnet 5 Mantle us-east-1, the existing bearer source and cap 6');
  const opusCredential = credentials['opus5_bedrock'];
  if (opusCredential?.max_concurrency !== 4)
    blockers.push('Opus subject credential must retain max_concurrency 4');
  if (!sharesMantleCredentialSource(opusCredential, graderCredential))
    blockers.push('grader and Opus subject must explicitly select the same regional Mantle source');
  if (!qualification.grader_bearer.shared_source_verified)
    blockers.push('grader bearer shared source is not verified in the installed projection');
  if (!hasReceiptDigest(qualification.grader_bearer.receipt_sha256))
    blockers.push('grader bearer shared source receipt is missing');

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
      qualificationChecks.push(`${label} native chronology coverage is incomplete`);
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
  if (!pricing.offline_accounting_probe_complete)
    blockers.push('offline pricing accounting probe is incomplete');
  const primaryModels = [
    'gpt-6-astra',
    'gpt-5.6-sol',
    'anthropic.claude-opus-5',
    EXPECTED_GRADER_MODEL,
  ];
  for (const model of primaryModels)
    if (!pricing.primary_models_priced.includes(model))
      blockers.push(`pricing does not cover primary model ${model}`);
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
    const sampleCredentials = Object.entries(subjectDemandByCredential).flatMap(([name, count]) => Array<string>(count).fill(name));
    const credentialPool = (name: string) => {
      const credential = credentials[name];
      if (!credential) throw new Error(`active credential ${name} is missing`);
      return poolKey(credential, name);
    };
    const graderPool = credentialPool(EXPECTED_GRADER);
    const demand = blockDemandVector({
      block: { sample_ids: sampleCredentials },
      sampleArmCredentialPool: credentialPool,
      graderPool,
    });
    for (const [id, needed] of demand) {
      if (id === GLOBAL_POOL) continue;
      const available = policy.get(id)?.max_concurrency;
      if (available === undefined)
        blockers.push(`pool ${id} is absent from compiled resource policy`);
      else if (available < needed)
        blockers.push(`pool ${id} needs ${needed} concurrent slots but the compiled alias-aware cap is ${available}`);
    }
  } catch (error) {
    blockers.push(`resource policy could not compile: ${error instanceof Error ? error.message : 'unknown error'}`);
  }

  const assignedAccounts = new Map<string, string>();
  const accountIds = new Set<string>();
  for (const account of qualification.capacity.accounts) {
    if (accountIds.has(account.account))
      blockers.push(`account ${account.account} has duplicate capacity receipts`);
    accountIds.add(account.account);
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

  if (assignedAccounts.get('opus5_bedrock') !== assignedAccounts.get(EXPECTED_GRADER))
    blockers.push('shared Mantle source must use one aggregate subject/grader account receipt');

  const modelDemand: Record<string, number> = { ...subjectDemandByModel };
  addCount(modelDemand, EXPECTED_GRADER_MODEL, 6);
  const modelReceipts = new Map<
    string,
    Pr2258QualificationReceipts['capacity']['models'][number]
  >();
  for (const receipt of qualification.capacity.models) {
    if (modelReceipts.has(receipt.model))
      blockers.push(`model ${receipt.model} has duplicate capacity receipts`);
    else modelReceipts.set(receipt.model, receipt);
  }
  for (const [model, needed] of Object.entries(modelDemand)) {
    const receipt = modelReceipts.get(model);
    if (receipt === undefined || !receipt.verified)
      blockers.push(`model ${model} has no verified capacity receipt`);
    else if (receipt.max_concurrency < needed)
      blockers.push(`model ${model} needs ${needed} concurrent calls but verified capacity is ${receipt.max_concurrency}`);
  }
  if (!qualification.capacity.fake_provider_six_way_verified)
    qualificationChecks.push('fake-provider six-way capacity is not verified for the simultaneous subject/grader mix');
  if (!hasReceiptDigest(qualification.capacity.receipt_sha256))
    qualificationChecks.push('six-way capacity receipt is missing');

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
  if (!qualification.exposure.fake_provider_six_way_overlap_verified)
    qualificationChecks.push('fake-provider six-way overlap is not verified');
  const fakeProviderSkew = qualification.exposure.maximum_start_skew_s;
  if (typeof fakeProviderSkew !== 'number' || !Number.isFinite(fakeProviderSkew))
    qualificationChecks.push('fake-provider maximum start skew evidence is missing');
  else {
    if (fakeProviderSkew > suite.max_exposure_skew)
      blockers.push('fake-provider six-way start skew does not satisfy the 60-second exposure bound');
    const expectedMargin = Math.max(0, suite.max_exposure_skew - fakeProviderSkew);
    const observedMargin = qualification.exposure.start_skew_margin_s;
    if (observedMargin !== expectedMargin)
      (observedMargin === null ? qualificationChecks : blockers).push(
        `fake-provider start skew margin must be ${expectedMargin} seconds, got ${observedMargin}`,
      );
  }
  if (!hasReceiptDigest(qualification.exposure.receipt_sha256))
    qualificationChecks.push('six-way exposure receipt is missing');

  if (measured) {
    const diagnostic = input.diagnosticGo;
    if (diagnostic === undefined) {
      blockers.push(
        'measured campaign requires an authenticated diagnostic GO receipt',
      );
    } else {
      if (diagnostic.review_receipt_authenticated !== true)
        blockers.push('diagnostic GO review receipt is not authenticated');
      if (diagnostic.evals_sha !== pins.evals_sha)
        blockers.push('diagnostic GO Evals pin differs from the frozen preflight pin');
      if (diagnostic.gauntlet_sha !== pins.gauntlet_sha)
        blockers.push('diagnostic GO Gauntlet pin differs from the frozen preflight pin');
      if (diagnostic.image_digest !== pins.image_digest)
        blockers.push('diagnostic GO image digest differs from the frozen preflight pin');
      if (diagnostic.pricing_sha256 !== suite.pricing_snapshot?.sha256)
        blockers.push('diagnostic GO pricing bytes differ from the measured suite');
      if (
        input.instrumentSha256 === undefined ||
        diagnostic.instrument_sha256 !== input.instrumentSha256
      )
        blockers.push('diagnostic GO instrument bytes differ from measured preflight');
      if (diagnostic.valid_pairs !== 3)
        blockers.push(`diagnostic GO requires 3 valid pairs, got ${diagnostic.valid_pairs}`);
      if (diagnostic.subject_exposures !== 6)
        blockers.push(
          `diagnostic GO requires 6 subject exposures, got ${diagnostic.subject_exposures}`,
        );
      const observedModels = [
        ...Object.values(diagnostic.served_model_ids),
        ...diagnostic.delegate_model_ids,
      ];
      const expectedServedModels = [
        ['Astra subject', diagnostic.served_model_ids.astra_subject, 'gpt-6-astra'],
        ['Sol subject', diagnostic.served_model_ids.sol_subject, 'gpt-5.6-sol'],
        ['Opus subject', diagnostic.served_model_ids.opus_subject, 'anthropic.claude-opus-5'],
        ['Sonnet grader', diagnostic.served_model_ids.sonnet_grader, EXPECTED_GRADER_MODEL],
      ] as const;
      for (const [role, actual, expected] of expectedServedModels)
        if (actual !== expected)
          blockers.push(`${role} served ${actual}; expected exact approved model ${expected}`);
      for (const model of observedModels)
        if (!diagnostic.priced_models.includes(model))
          blockers.push(`diagnostic observed model ${model} is not priced for its endpoint`);
      if (!diagnostic.delegate_capture_complete)
        blockers.push('diagnostic delegate model capture is incomplete');
      if (diagnostic.unpriced_models.length > 0)
        blockers.push(
          `diagnostic has unpriced models: ${[...diagnostic.unpriced_models].sort().join(', ')}`,
        );
      if (!diagnostic.service_tiers_verified)
        blockers.push('diagnostic pricing service tiers are not verified');
      if (!diagnostic.cache_buckets_verified)
        blockers.push('diagnostic pricing cache buckets are not verified');
      if (diagnostic.separately_billed_tools === 'unverified')
        blockers.push('diagnostic separately billed tool usage is not verified or priced');
      if (!diagnostic.six_way_overlap_verified)
        blockers.push('diagnostic six-way overlap is not verified');
      if (
        diagnostic.maximum_start_skew_s === null ||
        diagnostic.maximum_start_skew_s > suite.max_exposure_skew
      )
        blockers.push('diagnostic six-way start skew does not satisfy the 60-second bound');
      if (diagnostic.grader_429_observed)
        blockers.push('diagnostic observed a grader 429');
      if (diagnostic.independent_review !== 'GO')
        blockers.push('diagnostic independent review is not GO');
    }
  }

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
  return { ready: blockers.length === 0, blockers, qualification_gaps: qualificationGaps, evidence };
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

function readReviewedJson<T>(
  qualificationRoot: string,
  reference: z.infer<typeof ReceiptReferenceSchema>,
  label: string,
  schema: z.ZodType<T>,
): T {
  const bytes = readPinnedNoFollowBytes(
    qualificationRoot,
    reference.path.split('/'),
    label,
    true,
  );
  if (bytes === null) throw new Error(`${label} is missing`);
  if (sha256Bytes(bytes) !== reference.sha256)
    throw new Error(`${label} digest does not match the receipt-set manifest`);
  try {
    return schema.parse(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw new Error(`${label} is not a valid reviewed receipt`);
  }
}

function sameReceiptBinding(
  left: z.infer<typeof ReceiptSetBindingSchema>,
  right: z.infer<typeof ReceiptSetBindingSchema>,
): boolean {
  return jcsCanonicalize(left) === jcsCanonicalize(right);
}

/** Authenticate tracked execution bytes, including files hidden by index flags.
 * Git identity alone cannot qualify a dirty or differently rooted instrument. */
function verifyQualificationSource(sourceRoot: string, expectedSha: string, runner: CommandRunner): void {
  const git = (args: string[]) => {
    const result = runner.run('git', ['-C', sourceRoot, ...args], {
      env: { PATH: getEnv('PATH'), HOME: getEnv('HOME'), TMPDIR: getEnv('TMPDIR'), GIT_OPTIONAL_LOCKS: '0' },
    });
    if (result.status !== 0) throw new Error('Qualification source Git authority is unavailable');
    return result.stdout;
  };
  if (realpathSync(git(['rev-parse', '--show-toplevel']).trim()) !== resolve(sourceRoot))
    throw new Error('Qualification source must be the exact Git checkout root');
  const assertHead = () => {
    if (git(['rev-parse', '--verify', 'HEAD']).trim() !== expectedSha)
      throw new Error('Qualification source HEAD differs from reviewed evals_sha');
  };
  assertHead();
  const listing = git(['ls-tree', '-rz', '--full-tree', expectedSha]);
  if (!listing) throw new Error('Qualification source tree is empty');
  for (const record of listing.split('\0').filter(Boolean)) {
    const match = /^(100644|100755|120000) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error('Qualification source contains an unsupported Git entry');
    const mode = match[1];
    const digest = match[2];
    const path = match[3];
    if (!path) throw new Error('Qualification source entry has no path');
    const pin = pinAbsoluteDir(dirname(join(sourceRoot, path)), 'qualification source');
    try {
      const pinnedPath = join(pin.viaPath, basename(path));
      const stat = lstatSync(pinnedPath);
      let bytes: Buffer;
      if (mode === '120000') {
        if (!stat.isSymbolicLink()) throw new Error(`Qualification source type differs: ${path}`);
        bytes = Buffer.from(readlinkSync(pinnedPath));
      } else {
        if (!stat.isFile() || Boolean(stat.mode & 0o111) !== (mode === '100755'))
          throw new Error(`Qualification source type or mode differs: ${path}`);
        const raw = readPinnedNoFollowBytes(sourceRoot, path.split('/'), `qualification source ${path}`, true);
        if (!raw) throw new Error(`Qualification source is missing: ${path}`);
        bytes = raw;
      }
      if (createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== digest)
        throw new Error(`Qualification source tracked bytes differ: ${path}`);
    } catch (error) {
      throw new Error(`Qualification source verification failed for ${path}`, { cause: error });
    } finally { closePin(pin); }
  }
  if (git(['status', '--porcelain', '--untracked-files=all']) !== '')
    throw new Error('Qualification source working tree is dirty');
  assertHead();
}

export function loadPr2258ReceiptSet(
  sourceRoot: string,
  qualificationRoot: string,
  suiteKind: 'diagnostic' | 'measured',
  runner: CommandRunner = defaultCommandRunner,
): Pr2258PreflightInput {
  // The approved private root supplies reviewer authority. No-follow reads and
  // hashes bind the exact reviewed bytes; they do not prove the claims' truth.
  const manifestBytes = readPinnedNoFollowBytes(
    qualificationRoot,
    ['receipt-set.json'],
    'PR 2258 receipt-set manifest',
    true,
  );
  if (manifestBytes === null) throw new Error('PR 2258 receipt-set manifest is missing');
  let manifest: z.infer<typeof ReceiptSetManifestSchema>;
  try {
    manifest = ReceiptSetManifestSchema.parse(
      JSON.parse(manifestBytes.toString('utf8')),
    );
  } catch {
    throw new Error('PR 2258 receipt-set manifest is invalid');
  }

  verifyQualificationSource(sourceRoot, manifest.binding.evals_sha, runner);

  const capability = readReviewedJson(
    qualificationRoot,
    manifest.capability_review,
    'capability review',
    CapabilityReviewSchema,
  );
  const binding = {
    evals_sha: manifest.binding.evals_sha,
    gauntlet_sha: manifest.binding.gauntlet_sha,
    image_digest: manifest.binding.image_digest,
    pricing_sha256: manifest.binding.pricing_sha256,
    instrument_sha256: manifest.binding.instrument_sha256,
  };
  if (!sameReceiptBinding(capability.binding, binding))
    throw new Error('capability review binding differs from the receipt-set manifest');
  if (
    capability.qualification.frozen_pins.evals_sha !== binding.evals_sha ||
    capability.qualification.frozen_pins.gauntlet_sha !== binding.gauntlet_sha ||
    capability.qualification.frozen_pins.image_digest !== binding.image_digest
  )
    throw new Error('capability review claims differ from its exact source/image binding');

  const evidencePaths = new Set<string>();
  const evidenceDigests = new Set<string>();
  for (const reference of manifest.evidence_receipts) {
    if (evidencePaths.has(reference.path))
      throw new Error(`evidence receipt path is duplicated: ${reference.path}`);
    evidencePaths.add(reference.path);
    const bytes = readPinnedNoFollowBytes(
      qualificationRoot,
      reference.path.split('/'),
      `qualification evidence receipt ${reference.path}`,
      true,
    );
    if (bytes === null || sha256Bytes(bytes) !== reference.sha256)
      throw new Error(`qualification evidence receipt ${reference.path} digest differs from the manifest`);
    evidenceDigests.add(reference.sha256);
  }
  const qualificationDigests = [
    capability.qualification.chronology.codex.receipt_sha256,
    capability.qualification.chronology.claude.receipt_sha256,
    capability.qualification.linux.receipt_sha256,
    capability.qualification.installed.receipt_sha256,
    capability.qualification.projections.receipt_sha256,
    capability.qualification.grader_bearer.receipt_sha256,
    capability.qualification.pricing.receipt_sha256,
    capability.qualification.capacity.receipt_sha256,
    capability.qualification.exposure.receipt_sha256,
  ].filter((digest): digest is string => digest !== null);
  for (const digest of qualificationDigests)
    if (!evidenceDigests.has(digest))
      throw new Error(`qualification claim references an unbound evidence receipt ${digest}`);

  const input = loadInput(sourceRoot, suiteKind, capability.qualification);
  const pricingPath = input.suite.pricing_snapshot?.path;
  if (pricingPath === undefined)
    throw new Error('source suite has no pricing snapshot');
  const pricingBytes = readPinnedNoFollowBytes(
    sourceRoot,
    pricingPath.split('/'),
    'source pricing snapshot',
    true,
  );
  if (
    pricingBytes === null ||
    sha256Bytes(pricingBytes) !== input.suite.pricing_snapshot?.sha256 ||
    sha256Bytes(pricingBytes) !== binding.pricing_sha256
  )
    throw new Error('source pricing snapshot digest differs from the reviewed binding');

  const expectedInstrumentPaths = [...PR2258_INSTRUMENT_FILES].sort();
  const declaredInstrumentPaths = manifest.binding.instrument_files
    .map((file) => file.path)
    .sort();
  if (!exactStringSet(declaredInstrumentPaths, expectedInstrumentPaths))
    throw new Error('instrument file manifest does not name the exact observer source set');
  const actualInstrumentFiles = manifest.binding.instrument_files.map((file) => {
    const bytes = readPinnedNoFollowBytes(
      sourceRoot,
      file.path.split('/'),
      `observer instrument ${file.path}`,
      true,
    );
    if (bytes === null || sha256Bytes(bytes) !== file.sha256)
      throw new Error(`observer instrument ${file.path} digest differs from the reviewed manifest`);
    return file;
  });
  if (digestPr2258InstrumentFiles(actualInstrumentFiles) !== binding.instrument_sha256)
    throw new Error('observer instrument aggregate digest differs from the reviewed binding');

  let diagnosticGo: Pr2258DiagnosticGo | undefined;
  if (suiteKind === 'measured') {
    if (manifest.diagnostic_go_review === undefined)
      throw new Error('diagnostic GO review is missing from the measured receipt set');
    const review = readReviewedJson(
      qualificationRoot,
      manifest.diagnostic_go_review,
      'diagnostic GO review',
      DiagnosticGoReviewSchema,
    );
    if (!sameReceiptBinding(review.binding, binding))
      throw new Error('diagnostic GO review binding differs from the receipt-set manifest');
    if (
      review.diagnostic_go.evals_sha !== binding.evals_sha ||
      review.diagnostic_go.gauntlet_sha !== binding.gauntlet_sha ||
      review.diagnostic_go.image_digest !== binding.image_digest ||
      review.diagnostic_go.pricing_sha256 !== binding.pricing_sha256 ||
      review.diagnostic_go.instrument_sha256 !== binding.instrument_sha256
    )
      throw new Error('diagnostic GO claims differ from its exact artifact binding');
    diagnosticGo = {
      ...review.diagnostic_go,
      review_receipt_authenticated: true,
    };
  }

  verifyQualificationSource(sourceRoot, binding.evals_sha, runner);
  return {
    ...input,
    instrumentSha256: binding.instrument_sha256,
    ...(diagnosticGo ? { diagnosticGo } : {}),
  };
}

export function main(args: string[]): number {
  const [suiteKind, qualificationRoot] = args;
  if (
    (suiteKind !== 'diagnostic' && suiteKind !== 'measured') ||
    qualificationRoot === undefined
  ) {
    console.error('usage: bun scripts/pr2258-preflight.ts <diagnostic|measured> <approved-qualification-root>');
    return 2;
  }
  try {
    const result = validatePr2258Preflight(
      loadPr2258ReceiptSet(repoRoot(), qualificationRoot, suiteKind),
    );
    console.log(JSON.stringify(result, null, 2));
    return result.ready ? 0 : 1;
  } catch {
    console.error(JSON.stringify({ ready: false, blockers: ['reviewed qualification receipt set or public declarations are invalid'] }));
    return 2;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
