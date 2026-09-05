// Registration authenticates object-store inputs against the materialized snapshot,
// freezes finite work and resource policy, and publishes the document after its journal anchor.
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { CommandRunner } from '../agents/command-runner.ts';
import { superpowersCapability } from '../agents/index.ts';
import { resolveSuperpowersRef } from '../appliance/git.ts';
import {
  codingAgentsDirectiveFromChecks,
  osDirectiveFromChecks,
} from '../checks/index.ts';
import {
  type AgentConfig,
  agentRuntimeFamily,
  parseAgentConfigForValidation,
} from '../contracts/agent-config.ts';
import { type Arm, ArmSchema } from '../contracts/campaign/arm.ts';
import {
  type ContentionDeclaration,
  type ContentionThreshold,
  type ExecutionSurfaceArm,
  type HostFingerprint,
  ID_COMPONENT_RE,
} from '../contracts/campaign/campaign.ts';
import { jcsCanonicalize, sha256Hex } from '../contracts/campaign/digest.ts';
import {
  type Experiment,
  ExperimentSchema,
  GraderSchema,
} from '../contracts/campaign/experiment.ts';
import { experimentDigest } from '../contracts/campaign/experiment-digest.ts';
import { poolKey } from '../contracts/campaign/pool.ts';
import { couplingDefaultFrom } from '../contracts/campaign/scenario-meta.ts';
import {
  type Suite as ExperimentSuite,
  SuiteSchema as ExperimentSuiteSchema,
  TIER_SELECTOR_RE,
} from '../contracts/campaign/suite.ts';
import {
  type Credential,
  CredentialSchema,
  parseCredentialsFile,
} from '../contracts/credential.ts';
import { getEnv } from '../env.ts';
import type { Clock } from '../scheduler/clock.ts';
import {
  couplingFromStory,
  quorumTierFromStory,
  requiresSuperpowersFromStory,
} from '../story-meta.ts';
import { publishFrozenCampaign } from './campaign-document.ts';
import {
  type CommittedTransition,
  ExecutionJournalWriter,
  initExecutionJournal,
} from './execution-journal.ts';
import {
  type HostStatsProbe,
  PID_MAX_SLOTS,
  probeFingerprint,
} from './host-stats.ts';
import {
  createBallast,
  DEFAULT_BALLAST_BYTES,
  type JournalFsOps,
} from './journal.ts';
import { acquireLease, type ProcessIdentityProbe } from './locks.ts';
import {
  assertFeasible,
  blockDemandVector,
  compileResourcePolicy,
} from './resource-policy.ts';
import { materializeCampaignSnapshot } from './snapshot.ts';

export class RegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistrationError';
  }
}

/** D2's implementation merge — the minimum child-contract commit an evals
 *  ref must contain (Child-contract compatibility, REV fable I-12). */
export const MINIMUM_CHILD_CONTRACT_SHA =
  'f230698e5bb653371bee73d6e3212d6c2e241368';
export const DEFAULT_GLOBAL_CAP = 8;

/** Comparison ids this module mints: `c<N>`, N a 1-based ordinal. */
const COMPARISON_ID_RE = /^c[1-9][0-9]*$/;
/** Block-slot component of a lineage-root block id: primary `b<N>` or
 *  reserve `x<N>` (both are non-rerun blocks and therefore valid roots). */
const BLOCK_SLOT_RE = /^[bx][1-9][0-9]*$/;
/** Slot component of a sample id: primary `r<N>` or reserve `x<N>`. */
const SAMPLE_SLOT_RE = /^[rx][1-9][0-9]*$/;

/** Round-4 S-11: every external component interpolated into a generated id
 *  matches the pinned grammar; ':' is reserved as the generated delimiter.
 *  A duplicate at construction is a loud programming error. */
export function assertIdComponent(component: string, label: string): void {
  if (!ID_COMPONENT_RE.test(component)) {
    throw new RegistrationError(
      `${label} ${JSON.stringify(component)} is not a valid campaign id component (must match ${ID_COMPONENT_RE}; ':' is reserved as the generated delimiter)`,
    );
  }
}

/** Ordinals/sequences/replicates/reserve indices are 1-based positive
 *  integers. Rejects 0, negatives, non-integers, NaN, and the Infinities
 *  before they can break the lowercase id grammar. */
function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RegistrationError(
      `${label} ${JSON.stringify(value)} must be a 1-based positive integer`,
    );
  }
}

/** A prebuilt composite id handed to a constructor must already have the
 *  structural shape that constructor composes on top of: exactly
 *  `patterns.length` ':'-delimited components, each matching its pinned
 *  pattern. This is what keeps the derivation injective — a malformed or
 *  foreign id cannot be silently interpolated into a fresh namespace. */
function assertShapedId(
  id: string,
  label: string,
  patterns: readonly RegExp[],
): void {
  const parts = id.split(':');
  if (parts.length !== patterns.length) {
    throw new RegistrationError(
      `${label} ${JSON.stringify(id)} must have exactly ${patterns.length} ':'-delimited components`,
    );
  }
  for (const [index, pattern] of patterns.entries()) {
    const part = parts[index] as string;
    if (!pattern.test(part)) {
      throw new RegistrationError(
        `${label} ${JSON.stringify(id)} component ${index + 1} ${JSON.stringify(part)} does not match ${pattern}`,
      );
    }
  }
}

// The pinned ID derivation table (REV-2 P-7). Injective by grammar — no
// hashing. `<cell-key> = <comparison_id>:<scenario-name>`.
export function comparisonId(ordinal: number): string {
  assertPositiveInteger(ordinal, 'comparison ordinal');
  return `c${ordinal}`;
}
export function cellKeyOf(comparisonId: string, scenario: string): string {
  assertShapedId(comparisonId, 'comparison id', [COMPARISON_ID_RE]);
  assertIdComponent(scenario, 'scenario name');
  return `${comparisonId}:${scenario}`;
}
export function primarySampleId(
  cellKey: string,
  arm: string,
  replicate: number,
): string {
  assertShapedId(cellKey, 'cell key', [COMPARISON_ID_RE, ID_COMPONENT_RE]);
  assertIdComponent(arm, 'arm name');
  assertPositiveInteger(replicate, 'replicate');
  return `${cellKey}:${arm}:r${replicate}`;
}
export function primaryBlockId(cellKey: string, replicate: number): string {
  assertShapedId(cellKey, 'cell key', [COMPARISON_ID_RE, ID_COMPONENT_RE]);
  assertPositiveInteger(replicate, 'replicate');
  return `${cellKey}:b${replicate}`;
}
export function reserveBlockId(cellKey: string, k: number): string {
  assertShapedId(cellKey, 'cell key', [COMPARISON_ID_RE, ID_COMPONENT_RE]);
  assertPositiveInteger(k, 'reserve index');
  return `${cellKey}:x${k}`;
}
export function reserveSampleId(
  cellKey: string,
  arm: string,
  k: number,
): string {
  assertShapedId(cellKey, 'cell key', [COMPARISON_ID_RE, ID_COMPONENT_RE]);
  assertIdComponent(arm, 'arm name');
  assertPositiveInteger(k, 'reserve index');
  return `${cellKey}:${arm}:x${k}`;
}
export function rerunInstanceId(
  lineageRootBlockId: string,
  seq: number,
): string {
  assertShapedId(lineageRootBlockId, 'lineage-root block id', [
    COMPARISON_ID_RE,
    ID_COMPONENT_RE,
    BLOCK_SLOT_RE,
  ]);
  assertPositiveInteger(seq, 'rerun instance seq');
  return `${lineageRootBlockId}:i${seq}`;
}
export function attemptIdOf(sampleId: string, seq: number): string {
  assertShapedId(sampleId, 'sample id', [
    COMPARISON_ID_RE,
    ID_COMPONENT_RE,
    ID_COMPONENT_RE,
    SAMPLE_SLOT_RE,
  ]);
  assertPositiveInteger(seq, 'attempt seq');
  return `${sampleId}:a${seq}`;
}

export interface ScenarioIntake {
  readonly name: string;
  readonly tier: 'sentinel' | 'full' | 'adhoc';
  readonly requires_superpowers: boolean;
  readonly coupling:
    | 'pins-skill-names'
    | 'embeds-skill-fixtures'
    | 'arm-independent';
  /** Scenario `# os:` directive; undefined = run-anywhere. */
  readonly os: readonly string[] | undefined;
  /** Scenario `# coding-agents:` directive; undefined = any agent, [] (a
   *  matched-but-empty directive) = no agent — the run-all matrix reading. */
  readonly coding_agents: readonly string[] | undefined;
}

export interface RegistrationInput {
  readonly suite: ExperimentSuite;
  readonly arms: Readonly<Record<string, Arm>>;
  readonly credentials: Readonly<Record<string, Credential>>;
  readonly grader: Experiment['grader'];
  readonly refs: Experiment['refs'];
  readonly scenarios: readonly ScenarioIntake[];
  readonly capability: (family: string) => { ref: boolean; none: boolean };
  readonly agentOsSupport: (agent: string) => readonly string[] | undefined;
  readonly agentFamily: (agent: string) => string;
  readonly campaignOs: string;
  readonly globalCap: number;
  readonly contention: ContentionDeclaration;
  readonly registeredAt: string;
  readonly registeredBy: string;
  readonly estimates?: Experiment['estimates'];
}

export type PreparedRegistration = Omit<
  Experiment,
  'campaign_id' | 'input_digest' | 'registered_at' | 'registered_by'
>;

interface CredentialAuthorityProjection {
  readonly schema: 'quorum.credential-authority/v1';
  readonly pool_identity: 'campaign-pool-key/v1';
  readonly credentials: readonly (readonly [string, Credential])[];
}

function credentialAuthorityProjection(
  registry: Readonly<Record<string, Credential>>,
  activeCredentialNames: readonly string[],
): CredentialAuthorityProjection {
  const activePools = new Set(
    activeCredentialNames.map((name) => {
      const credential = registry[name];
      if (credential === undefined) {
        throw new RegistrationError(
          `active credential ${name} is absent from credentials.yaml`,
        );
      }
      return poolKey(credential, name);
    }),
  );
  const credentials = Object.entries(registry)
    .filter(([name, credential]) => activePools.has(poolKey(credential, name)))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([name, credential]) =>
        [name, CredentialSchema.parse(credential)] as const,
    );
  return {
    schema: 'quorum.credential-authority/v1',
    pool_identity: 'campaign-pool-key/v1',
    credentials,
  };
}

/** Digest only the strict public registry projection needed to prepare attempts. */
export function credentialAuthorityDigest(
  registry: Readonly<Record<string, Credential>>,
  activeCredentialNames: readonly string[],
): string {
  return sha256Hex(
    jcsCanonicalize(
      credentialAuthorityProjection(registry, activeCredentialNames),
    ),
  );
}

/** Refuse a changed public credential authority before a new attempt starts. */
export function assertCredentialAuthority(
  registry: Readonly<Record<string, Credential>>,
  experiment: Pick<
    Experiment,
    'execution_surface' | 'grader' | 'credential_authority_digest'
  >,
): void {
  const observed = credentialAuthorityDigest(
    registry,
    credentialNamesForExperiment(experiment),
  );
  if (observed !== experiment.credential_authority_digest) {
    throw new RegistrationError(
      `public credential authority changed (${observed} != ${experiment.credential_authority_digest}); refusing a new start`,
    );
  }
}

/** Credentials whose public aliases define the frozen campaign pool authority. */
export function credentialNamesForExperiment(
  experiment: Pick<Experiment, 'execution_surface' | 'grader'>,
): string[] {
  return [
    ...new Set([
      ...experiment.execution_surface.map((arm) => arm.credential),
      experiment.grader.credential,
    ]),
  ].sort();
}

function expandExperimentSelector(
  selector: readonly string[] | string,
  scenarios: readonly ScenarioIntake[],
): string[] {
  if (typeof selector !== 'string') return [...selector].sort();
  const match = TIER_SELECTOR_RE.exec(selector);
  if (match === null) {
    throw new RegistrationError(`bad scenario selector ${selector}`);
  }
  return scenarios
    .filter((scenario) => scenario.tier === match[1])
    .map((scenario) => scenario.name)
    .sort();
}

function experimentCellRejection(
  input: RegistrationInput,
  scenario: ScenarioIntake,
  armNames: readonly string[],
): string | null {
  const armTargets: { armName: string; arm: Arm; os: string }[] = [];
  for (const armName of armNames) {
    const arm = input.arms[armName];
    if (arm === undefined) return `arm ${armName} is absent from arms/`;
    const os = arm.os ?? input.campaignOs;
    if (os !== input.campaignOs) {
      return `arm ${armName} targets ${os}, but the campaign targets ${input.campaignOs}`;
    }
    armTargets.push({ armName, arm, os });
  }
  if (
    scenario.requires_superpowers &&
    armNames.some((name) => input.arms[name]?.superpowers === 'none')
  ) {
    return 'scenario requires_superpowers conflicts with a superpowers: none arm';
  }
  for (const { armName, arm, os } of armTargets) {
    const credential = input.credentials[arm.credential];
    if (credential === undefined) {
      return `credential ${arm.credential} for arm ${armName} is absent from credentials.yaml`;
    }
    const family = input.agentFamily(arm.agent);
    if (!credential.harnesses.includes(family)) {
      return `credential ${arm.credential} does not support harness ${family}`;
    }
    const agentOs = input.agentOsSupport(arm.agent);
    if (agentOs !== undefined && !agentOs.includes(os)) {
      return `arm ${armName} os ${os} is unsupported by agent ${arm.agent}`;
    }
    if (
      credential.os_support !== undefined &&
      !credential.os_support.includes(os)
    ) {
      return `arm ${armName} os ${os} is unsupported by credential ${arm.credential}`;
    }
    if (scenario.os !== undefined && !scenario.os.includes(os)) {
      return `arm ${armName} os ${os} is unsupported by scenario ${scenario.name}`;
    }
    if (
      scenario.coding_agents !== undefined &&
      !scenario.coding_agents.includes(arm.agent)
    ) {
      return `agent ${arm.agent} is outside scenario ${scenario.name}'s coding-agents directive`;
    }
    const capability = input.capability(family);
    if (arm.superpowers === 'none' ? !capability.none : !capability.ref) {
      return `arm ${armName} superpowers mode ${arm.superpowers} lacks adapter capability`;
    }
  }
  return null;
}

/** Compile one strict, finite, price-independent V2 experiment input. */
export function prepareRegistration(
  rawInput: RegistrationInput,
): PreparedRegistration {
  const suite = ExperimentSuiteSchema.parse(rawInput.suite);
  const grader = GraderSchema.parse(rawInput.grader);
  const input = { ...rawInput, suite, grader };
  if (input.campaignOs !== 'linux') {
    throw new RegistrationError(
      `campaign target ${input.campaignOs} is unsupported by the Linux-only campaign product`,
    );
  }
  if (input.globalCap !== input.contention.global_run_cap) {
    throw new RegistrationError(
      `global capacity ${input.globalCap} differs from contention declaration ${input.contention.global_run_cap}`,
    );
  }
  const graderCredential = input.credentials[input.grader.credential];
  if (graderCredential === undefined) {
    throw new RegistrationError(
      `grader credential ${input.grader.credential} is absent from credentials.yaml`,
    );
  }
  if (input.grader.model !== graderCredential.model) {
    throw new RegistrationError(
      `grader model ${input.grader.model} does not match credential ${input.grader.credential} model ${graderCredential.model}`,
    );
  }

  const scenarioByName = new Map(
    input.scenarios.map((item) => [item.name, item]),
  );
  const normalizedComparisons: ExperimentSuite['comparisons'] = [];
  const comparisons: Experiment['comparisons'] = [];
  const cells: Experiment['cells'] = [];
  const excludedCells: Experiment['excluded_cells'] = [];
  const plannedSlots: Experiment['planned_slots'] = [];
  const reserveSlots: Experiment['reserve_slots'] = [];
  const referencedArmNames = new Set<string>();

  suite.comparisons.forEach((comparison, comparisonIndex) => {
    const comparison_id = comparisonId(comparisonIndex + 1);
    const armNames =
      'arm' in comparison
        ? [comparison.arm]
        : [comparison.baseline, comparison.treatment];
    for (const name of armNames) referencedArmNames.add(name);
    const scenarios = expandExperimentSelector(
      comparison.scenarios,
      input.scenarios,
    );
    normalizedComparisons.push({ ...comparison, scenarios });
    comparisons.push(
      'arm' in comparison
        ? { comparison_id, arm: comparison.arm }
        : {
            comparison_id,
            baseline: comparison.baseline,
            treatment: comparison.treatment,
          },
    );
  });

  const referencedArms = [...referencedArmNames].sort().map((name) => {
    const arm = input.arms[name];
    if (arm === undefined) {
      throw new RegistrationError(`arm ${name} is absent from arms/`);
    }
    const resolvedRef = input.refs.superpowers_by_arm[name];
    if (arm.superpowers === 'none') {
      if (resolvedRef !== null) {
        throw new RegistrationError(
          `arm ${name} with superpowers: none requires an explicit null source ref`,
        );
      }
    } else if (typeof resolvedRef !== 'string') {
      throw new RegistrationError(
        `arm ${name} requires a resolved superpowers source ref`,
      );
    }
    return arm;
  });
  const activeCredentialNames = [
    ...new Set([
      ...referencedArms.map((arm) => arm.credential),
      input.grader.credential,
    ]),
  ].sort();
  const policy = compileResourcePolicy(
    input.credentials,
    activeCredentialNames,
  );
  const graderPool = poolKey(graderCredential, input.grader.credential);

  normalizedComparisons.forEach((comparison, comparisonIndex) => {
    const comparison_id = comparisonId(comparisonIndex + 1);
    const armNames =
      'arm' in comparison
        ? [comparison.arm]
        : [comparison.baseline, comparison.treatment];
    const scenarios = comparison.scenarios;
    if (!Array.isArray(scenarios)) {
      throw new RegistrationError('normalized selector was not expanded');
    }
    for (const scenarioName of scenarios) {
      const cellKey = cellKeyOf(comparison_id, scenarioName);
      const scenario = scenarioByName.get(scenarioName);
      if (scenario === undefined) {
        excludedCells.push({
          cell: cellKey,
          reason: `scenario ${scenarioName} is absent from the snapshot intake`,
        });
        continue;
      }
      const rejection = experimentCellRejection(input, scenario, armNames);
      if (rejection !== null) {
        excludedCells.push({ cell: cellKey, reason: rejection });
        continue;
      }
      const samplePoolById = new Map<string, string>();
      for (const armName of armNames) {
        const arm = input.arms[armName];
        if (arm === undefined) {
          throw new RegistrationError(`arm ${armName} is absent from arms/`);
        }
        const credential = input.credentials[arm.credential];
        if (credential === undefined) {
          throw new RegistrationError(
            `credential ${arm.credential} for arm ${armName} is absent from credentials.yaml`,
          );
        }
        samplePoolById.set(armName, poolKey(credential, arm.credential));
      }
      try {
        assertFeasible(
          blockDemandVector({
            block: { sample_ids: armNames },
            sampleArmCredentialPool: (sampleId) => {
              const pool = samplePoolById.get(sampleId);
              if (pool === undefined) {
                throw new RegistrationError(
                  `sample ${sampleId} has no compiled subject pool`,
                );
              }
              return pool;
            },
            graderPool,
          }),
          policy,
          input.globalCap,
        );
      } catch (error) {
        excludedCells.push({
          cell: cellKey,
          reason: `block is infeasible: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }

      const n = comparison.cells?.[scenarioName]?.n ?? comparison.n;
      cells.push({
        scenario: scenarioName,
        comparison_id,
        arms: [...armNames],
        n,
        coupling: scenario.coupling,
      });
      for (let replicate = 1; replicate <= n; replicate += 1) {
        const primary_block_id = primaryBlockId(cellKey, replicate);
        for (const arm of armNames) {
          plannedSlots.push({
            sample_id: primarySampleId(cellKey, arm, replicate),
            primary_block_id,
            comparison_id,
            scenario: scenarioName,
            arm,
            replicate,
          });
        }
      }
      for (let reserve = 1; reserve <= suite.reserve; reserve += 1) {
        reserveSlots.push({
          reserve_id: reserveBlockId(cellKey, reserve),
          comparison_id,
          scenario: scenarioName,
        });
      }
    }
  });
  if (cells.length === 0) {
    throw new RegistrationError(
      `experiment has no eligible cells: ${excludedCells.map((cell) => `${cell.cell}: ${cell.reason}`).join('; ')}`,
    );
  }

  const executionSurface: ExecutionSurfaceArm[] = referencedArms.map((arm) => {
    const credential = input.credentials[arm.credential];
    if (credential === undefined) {
      throw new RegistrationError(
        `credential ${arm.credential} for arm ${arm.name} is absent from credentials.yaml`,
      );
    }
    return {
      name: arm.name,
      agent: arm.agent,
      credential: arm.credential,
      auth: credential.auth,
      api: credential.api,
      ...(credential.base_url === undefined
        ? {}
        : { base_url: credential.base_url }),
      model: credential.model,
      key_env_names:
        credential.key_pool ??
        (credential.api_key_env === undefined ? [] : [credential.api_key_env]),
    };
  });
  const refs = {
    ...input.refs,
    superpowers_by_arm: Object.fromEntries(
      referencedArms.map((arm) => [
        arm.name,
        input.refs.superpowers_by_arm[arm.name],
      ]),
    ),
  };
  const prepared = {
    schema_version: 2 as const,
    suite: { ...suite, comparisons: normalizedComparisons },
    refs,
    grader: input.grader,
    cells,
    excluded_cells: excludedCells,
    comparisons,
    planned_slots: plannedSlots,
    reserve_slots: reserveSlots,
    execution_surface: executionSurface,
    credential_authority_digest: credentialAuthorityDigest(
      input.credentials,
      activeCredentialNames,
    ),
    pool_policy: [...policy.values()],
    contention: input.contention,
    runtime_limits: {
      max_time_s: suite.attempt_bounds.max_time_s,
      graceful_shutdown_s: 5 as const,
    },
    ...(input.estimates === undefined ? {} : { estimates: input.estimates }),
  };
  const validated = ExperimentSchema.parse({
    ...prepared,
    campaign_id: 'registration-validation',
    input_digest: '0'.repeat(64),
    registered_at: input.registeredAt,
    registered_by: input.registeredBy,
  });
  const {
    campaign_id: _campaignId,
    input_digest: _inputDigest,
    registered_at: _registeredAt,
    registered_by: _registeredBy,
    ...result
  } = validated;
  return result;
}

/** Decision D-4 defaults (drafted for gate challenge; the parent pins the
 *  obligation, not the numbers): absolute floor paired with the relative
 *  band; hysteresis lives solely in the frozen sustain_k. */
export function defaultContentionThresholds(args: {
  mem_bytes: number;
  swap_total_bytes: number;
  disk_total_bytes: number;
}): ContentionThreshold[] {
  const thresholds: ContentionThreshold[] = [
    { metric: 'load1_per_core', source: 'host', op: 'gt', value: 2.0 },
    {
      metric: 'mem_available_bytes',
      source: 'host',
      op: 'lt',
      value: Math.max(2 * 2 ** 30, 0.1 * args.mem_bytes),
      relative_of: 'mem_bytes',
    },
  ];
  // A swapless host (containerized campaign hosts report swap_total_bytes 0)
  // cannot experience swap contention, and 0.25 x 0 would refuse the
  // ContentionThreshold positive-value schema — omit the threshold; the
  // evaluator judges only declared thresholds.
  if (args.swap_total_bytes > 0) {
    thresholds.push({
      metric: 'swap_used_bytes',
      source: 'host',
      op: 'gt',
      value: 0.25 * args.swap_total_bytes,
      relative_of: 'swap_total_bytes',
    });
  }
  thresholds.push(
    {
      metric: 'disk_free_bytes',
      source: 'host',
      op: 'lt',
      value: Math.max(5 * 2 ** 30, 0.15 * args.disk_total_bytes),
      relative_of: 'disk_total_bytes',
    },
    {
      metric: 'process_count',
      source: 'host',
      op: 'gt',
      value: 0.8 * PID_MAX_SLOTS,
      relative_of: 'pid_table',
    },
  );
  return thresholds;
}

export function buildContentionBlock(args: {
  fingerprint: HostFingerprint;
  globalCap: number;
  thresholds: ContentionThreshold[];
  cadenceMs?: number;
  sustainK?: number;
  coverageN?: number;
  memTolerancePct?: number;
  diskTolerancePct?: number;
}): ContentionDeclaration {
  return {
    host_fingerprint: args.fingerprint,
    global_run_cap: args.globalCap,
    thresholds: args.thresholds,
    cadence_ms: args.cadenceMs ?? 10_000,
    sustain_k: args.sustainK ?? 3,
    coverage_n: args.coverageN ?? 4,
    mem_tolerance_pct: args.memTolerancePct ?? 10,
    disk_tolerance_pct: args.diskTolerancePct ?? 10,
  };
}

// ── registerCampaign orchestration + publication (task 5d) ────────────────

/** The D2 minimal-env invariant (PATH/HOME/TMPDIR only), read through
 *  src/env.ts — never a direct process.env read outside that boundary. */
function minimalGitEnv(): Readonly<Record<string, string | undefined>> {
  return {
    PATH: getEnv('PATH'),
    HOME: getEnv('HOME'),
    TMPDIR: getEnv('TMPDIR'),
  };
}

/** One scenario's intake from its consumed bytes — shared by the object-store
 *  and materialized-tree readers so the two can never disagree on a
 *  directive. `checks` is undefined for a story-only scenario dir (no
 *  directives, run-anywhere, any agent). */
function scenarioIntakeOf(
  name: string,
  story: string,
  checks: string | undefined,
  combined: string,
  hasSkillsFixtures: boolean,
): ScenarioIntake {
  return {
    name,
    tier: quorumTierFromStory(story),
    requires_superpowers: requiresSuperpowersFromStory(story) ?? false,
    coupling:
      couplingFromStory(story) ??
      couplingDefaultFrom(combined, hasSkillsFixtures),
    os: checks === undefined ? undefined : osDirectiveFromChecks(checks),
    coding_agents:
      checks === undefined
        ? undefined
        : codingAgentsDirectiveFromChecks(checks),
  };
}

/** Authoritative intake read from the MATERIALIZED final-path evals tree
 *  (Blocker C): arms/, credentials.yaml, scenarios/<name>/, coding-agents/
 *  via plain file reads, parsed by the same string-based readers the
 *  object-store intake uses. Records every consumed file's bytes so callers
 *  can cross-check provenance. */
export function readIntakeFromEvalsTree(evalsRoot: string): SnapshotIntake {
  const arms: Record<string, Arm> = {};
  const files: Record<string, string> = {};
  const armsDir = join(evalsRoot, 'arms');
  if (existsSync(armsDir)) {
    for (const entry of readdirSync(armsDir).sort()) {
      if (!entry.endsWith('.yaml')) continue;
      const rel = `arms/${entry}`;
      files[rel] = readFileSync(join(armsDir, entry), 'utf8');
      const arm = ArmSchema.parse(parseYaml(files[rel] as string));
      arms[arm.name] = arm;
    }
  }
  const credentialsPath = join(evalsRoot, 'credentials.yaml');
  if (!existsSync(credentialsPath)) {
    throw new RegistrationError(
      `no credentials.yaml at evals SHA — the snapshot intake cannot read credentials; fix the evals ref or add the registry, then re-register (fail-closed)`,
    );
  }
  files['credentials.yaml'] = readFileSync(credentialsPath, 'utf8');
  const credentials = parseCredentialsFile(
    parseYaml(files['credentials.yaml'] as string),
  );
  const scenarios: ScenarioIntake[] = [];
  const scenariosDir = join(evalsRoot, 'scenarios');
  if (existsSync(scenariosDir)) {
    for (const entry of readdirSync(scenariosDir).sort()) {
      const scenarioDir = join(scenariosDir, entry);
      const storyPath = join(scenarioDir, 'story.md');
      if (!existsSync(storyPath)) continue;
      files[`scenarios/${entry}/story.md`] = readFileSync(storyPath, 'utf8');
      const setupPath = join(scenarioDir, 'setup.sh');
      if (existsSync(setupPath)) {
        files[`scenarios/${entry}/setup.sh`] = readFileSync(setupPath, 'utf8');
      }
      const checksPath = join(scenarioDir, 'checks.sh');
      if (existsSync(checksPath)) {
        files[`scenarios/${entry}/checks.sh`] = readFileSync(
          checksPath,
          'utf8',
        );
      }
      const story = files[`scenarios/${entry}/story.md`] as string;
      const checks = files[`scenarios/${entry}/checks.sh`];
      const combined =
        story + (files[`scenarios/${entry}/setup.sh`] ?? '') + (checks ?? '');
      const skillsFixturesDir = join(scenarioDir, 'fixtures', 'skills');
      const hasSkillsFixtures =
        existsSync(skillsFixturesDir) &&
        statSync(skillsFixturesDir).isDirectory();
      scenarios.push(
        scenarioIntakeOf(entry, story, checks, combined, hasSkillsFixtures),
      );
    }
  }
  const agentsDir = join(evalsRoot, 'coding-agents');
  if (existsSync(agentsDir)) {
    for (const entry of readdirSync(agentsDir).sort()) {
      if (!entry.endsWith('.yaml')) continue;
      files[`coding-agents/${entry}`] = readFileSync(
        join(agentsDir, entry),
        'utf8',
      );
    }
  }
  return { arms, credentials, scenarios, files };
}

function gitOutText(runner: CommandRunner, args: readonly string[]): string {
  const res = runner.run('git', [...args], { env: minimalGitEnv() });
  if (res.status !== 0) {
    throw new RegistrationError(
      `git ${args.join(' ')} failed (${res.status}): ${res.stderr.trim()}`,
    );
  }
  return res.stdout;
}

/** Digest-computation intake (operator amendment 2026-08-27, finding 1):
 *  read-only from the git OBJECT STORE at the resolved frozen SHA —
 *  `git ls-tree` + `git show <sha>:<path>` through the CommandRunner seam.
 *  Object-store content is immutable, so these bytes can never observe the
 *  mutable host checkout (Blocker C's point). Fully in-memory (round-2
 *  finding 1): every parser consumes the strings directly, so dry-run and
 *  print-and-exit are write-free by construction — no scratch dir exists to
 *  leak. */
export function readSnapshotIntake(
  evalsCheckout: string,
  evalsSha: string,
  runner: CommandRunner,
): SnapshotIntake {
  const listing = gitOutText(runner, [
    '-C',
    evalsCheckout,
    'ls-tree',
    '-r',
    '--name-only',
    evalsSha,
  ]);
  const paths = listing.split('\n').filter((p) => p !== '');
  const files: Record<string, string> = {};
  const readAt = (rel: string): string => {
    const content = gitOutText(runner, [
      '-C',
      evalsCheckout,
      'show',
      `${evalsSha}:${rel}`,
    ]);
    files[rel] = content;
    return content;
  };
  const arms: Record<string, Arm> = {};
  for (const p of paths.filter((x) => /^arms\/[^/]+\.yaml$/.test(x))) {
    const arm = ArmSchema.parse(parseYaml(readAt(p)));
    arms[arm.name] = arm;
  }
  if (!paths.includes('credentials.yaml')) {
    throw new RegistrationError(
      `no credentials.yaml at evals SHA ${evalsSha} — the snapshot intake cannot read credentials; fix the evals ref or add the registry, then re-register (fail-closed)`,
    );
  }
  const credentials = parseCredentialsFile(
    parseYaml(readAt('credentials.yaml')),
  );
  const scenarios: ScenarioIntake[] = [];
  for (const p of paths.filter((x) =>
    /^scenarios\/[^/]+\/story\.md$/.test(x),
  )) {
    const name = p.split('/')[1] ?? '';
    if (name === '') continue; // unreachable by the path regex; keeps the type sound
    const story = readAt(p);
    const setup = `scenarios/${name}/setup.sh`;
    const checksPath = `scenarios/${name}/checks.sh`;
    const checks = paths.includes(checksPath) ? readAt(checksPath) : undefined;
    const combined =
      story + (paths.includes(setup) ? readAt(setup) : '') + (checks ?? '');
    const hasSkillsFixtures = paths.some((x) =>
      x.startsWith(`scenarios/${name}/fixtures/skills/`),
    );
    scenarios.push(
      scenarioIntakeOf(name, story, checks, combined, hasSkillsFixtures),
    );
  }
  for (const p of paths.filter((x) => /^coding-agents\/[^/]+\.yaml$/.test(x))) {
    readAt(p);
  }
  return { arms, credentials, scenarios, files };
}

/** Post-materialization guard (finding 1's byte-verification): the
 *  materialized evals tree must be byte-identical to the object-store
 *  intake for every file the grid consumed — a mismatch is corruption,
 *  never ignored (fail-closed, R-REG-5: what ships is what was digested). */
export function verifyIntakeMatch(
  intake: SnapshotIntake,
  evalsRoot: string,
): void {
  for (const [rel, content] of Object.entries(intake.files)) {
    if (readFileSync(join(evalsRoot, rel), 'utf8') !== content) {
      throw new RegistrationError(
        `materialized snapshot drifted from intake bytes at ${rel} — refusing publication (fail-closed); inspect ${join(evalsRoot, rel)} against the git object store at the registered SHA, then re-run registration`,
      );
    }
  }
}

export interface SnapshotIntake {
  readonly arms: Record<string, Arm>;
  readonly credentials: Record<string, Credential>;
  readonly scenarios: ScenarioIntake[];
  /** Relative path -> consumed bytes (object-store or tree), for the
   *  post-materialization byte verification. Agent configs parse from
   *  these bytes too (never a live directory read). */
  readonly files: Record<string, string>;
}

/** The intake's agent config by name, parsed from the consumed bytes. A
 *  missing YAML refuses naming the intake gap (fail-closed). */
export function intakeAgentConfig(
  intake: SnapshotIntake,
  agent: string,
): AgentConfig {
  const rel = `coding-agents/${agent}.yaml`;
  const source = intake.files[rel];
  if (source === undefined) {
    throw new RegistrationError(
      `agent '${agent}' has no ${rel} in the evals intake — add the agent config at the registered evals ref or fix the arm's agent reference (fail-closed)`,
    );
  }
  return parseAgentConfigForValidation(source, rel, agent);
}

/** Child-contract compatibility (REV fable I-12): the snapshot CLI probes
 *  clean and the evals SHA must contain D2's implementation merge — verified
 *  through the CommandRunner seam, rejected loudly naming the minimum. */
interface ChildContractProbeArgs {
  readonly runner: CommandRunner;
  readonly evalsCheckout: string;
}

function probeChildContract(
  evalsRoot: string,
  evalsSha: string,
  args: ChildContractProbeArgs,
): void {
  const minimalEnv = minimalGitEnv();
  const version = args.runner.run(
    'bun',
    [join(evalsRoot, 'src', 'cli', 'index.ts'), '--version'],
    { cwd: evalsRoot, env: minimalEnv },
  );
  if (version.status !== 0) {
    throw new RegistrationError(
      `child-contract probe failed: bun ${evalsRoot}/src/cli/index.ts --version exited ${version.status}: ${version.stderr.trim()} — the evals ref does not carry a runnable quorum CLI; use a ref at or beyond the child contract (REV fable I-12)`,
    );
  }
  const ancestor = args.runner.run(
    'git',
    [
      '-C',
      args.evalsCheckout,
      'merge-base',
      '--is-ancestor',
      MINIMUM_CHILD_CONTRACT_SHA,
      evalsSha,
    ],
    { env: minimalEnv },
  );
  if (ancestor.status !== 0) {
    throw new RegistrationError(
      `evals ref ${evalsSha} predates the minimum child-contract commit ${MINIMUM_CHILD_CONTRACT_SHA} (D2's implementation merge) — refusing registration; re-register with an evals ref containing ${MINIMUM_CHILD_CONTRACT_SHA} (REV fable I-12)`,
    );
  }
}

export interface RegisterArgs {
  readonly suitePath: string;
  readonly suiteRaw: string;
  readonly campaignsRoot: string;
  readonly globalCap: number;
  readonly evalsCheckout: string;
  readonly gauntletCheckout: string;
  readonly superpowersCheckout: string;
  readonly evalsRef: string;
  readonly gauntletRef: string;
  readonly runner: CommandRunner;
  readonly clock: Clock;
  readonly identity: ProcessIdentityProbe;
  readonly probe: HostStatsProbe;
  readonly registeredBy: string;
  readonly nowMs: number;
  readonly estimates?: Experiment['estimates'];
  readonly campaignId?: () => string;
  readonly fsOps?: JournalFsOps;
}

export interface RegisterResult {
  readonly experiment: Experiment;
  readonly campaignDir: string;
}

/**
 * Resolve, authenticate, compile, materialize and publish one independent V2
 * campaign. Repeating identical inputs creates a new campaign identity while
 * preserving the input digest.
 */
export function registerCampaign(args: RegisterArgs): RegisterResult {
  const raw = parseYaml(args.suiteRaw);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RegistrationError(`${args.suitePath}: suite must be an object`);
  }
  const record = raw as Record<string, unknown>;
  let grader: Experiment['grader'];
  try {
    grader = GraderSchema.parse(record['grader']);
  } catch (error) {
    throw new RegistrationError(
      `${args.suitePath}: invalid grader declaration: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const { grader: _grader, ...suiteFields } = record;
  const suite = ExperimentSuiteSchema.parse(suiteFields);

  const evalsSha = resolveSuperpowersRef(
    { path: args.evalsCheckout, remote: 'origin' },
    args.evalsRef,
    args.runner,
  );
  const gauntletSha = resolveSuperpowersRef(
    { path: args.gauntletCheckout, remote: 'origin' },
    args.gauntletRef,
    args.runner,
  );
  const now = new Date(args.nowMs).toISOString();
  const stats = args.probe.sample(args.nowMs);
  const contention = buildContentionBlock({
    fingerprint: probeFingerprint(args.probe, args.nowMs),
    globalCap: args.globalCap,
    thresholds: defaultContentionThresholds({
      mem_bytes: stats.mem_total_bytes,
      swap_total_bytes: stats.swap_total_bytes,
      disk_total_bytes: stats.disk_total_bytes,
    }),
  });
  const campaignId = (args.campaignId ?? randomUUID)();

  const compile = (intake: SnapshotIntake): Experiment => {
    const armNames = new Set<string>();
    for (const comparison of suite.comparisons) {
      if ('arm' in comparison) armNames.add(comparison.arm);
      else {
        armNames.add(comparison.baseline);
        armNames.add(comparison.treatment);
      }
    }
    const superpowers_by_arm: Record<string, string | null> = {};
    for (const name of [...armNames].sort()) {
      const arm = intake.arms[name];
      if (arm === undefined) {
        throw new RegistrationError(`arm ${name} is absent from arms/`);
      }
      superpowers_by_arm[name] =
        arm.superpowers === 'none'
          ? null
          : resolveSuperpowersRef(
              { path: args.superpowersCheckout, remote: 'origin' },
              arm.superpowers,
              args.runner,
            );
    }
    const prepared = prepareRegistration({
      suite,
      arms: intake.arms,
      credentials: intake.credentials,
      grader,
      refs: {
        superpowers_by_arm,
        evals: evalsSha,
        gauntlet: gauntletSha,
      },
      scenarios: intake.scenarios,
      capability: (family) => superpowersCapability(family),
      agentOsSupport: (agent) => intakeAgentConfig(intake, agent).os_support,
      agentFamily: (agent) =>
        agentRuntimeFamily(intakeAgentConfig(intake, agent)),
      campaignOs: 'linux',
      globalCap: args.globalCap,
      contention,
      registeredAt: now,
      registeredBy: args.registeredBy,
      ...(args.estimates === undefined ? {} : { estimates: args.estimates }),
    });
    const draft = {
      ...prepared,
      campaign_id: campaignId,
      input_digest: '0'.repeat(64),
      registered_at: now,
      registered_by: args.registeredBy,
    };
    return ExperimentSchema.parse({
      ...draft,
      input_digest: experimentDigest(draft),
    });
  };

  const intake = readSnapshotIntake(args.evalsCheckout, evalsSha, args.runner);
  const staged = compile(intake);
  mkdirSync(args.campaignsRoot, { recursive: true });
  const campaignsRoot = realpathSync(args.campaignsRoot);
  const lease = acquireLease({
    lockPath: join(campaignsRoot, 'registration.lock.d'),
    clock: args.clock,
    identity: args.identity,
    label: 'registration lease',
  });
  try {
    const campaignDir = join(campaignsRoot, `${campaignId}-${suite.name}`);
    if (existsSync(campaignDir)) {
      throw new RegistrationError(
        `campaign identity collision: ${campaignDir} already exists`,
      );
    }
    const handle = materializeCampaignSnapshot({
      campaignDir,
      refs: staged.refs,
      evalsCheckout: args.evalsCheckout,
      gauntletCheckout: args.gauntletCheckout,
      superpowersCheckout: args.superpowersCheckout,
      runner: args.runner,
    });
    verifyIntakeMatch(intake, handle.evalsRoot);
    const experiment = compile(readIntakeFromEvalsTree(handle.evalsRoot));
    if (experiment.input_digest !== staged.input_digest) {
      throw new RegistrationError(
        `materialized snapshot input digest ${experiment.input_digest} differs from object-store intake ${staged.input_digest}`,
      );
    }
    probeChildContract(handle.evalsRoot, evalsSha, args);
    createBallast(campaignDir, DEFAULT_BALLAST_BYTES, args.fsOps);
    initExecutionJournal({ campaignDir, experiment });
    const writer = ExecutionJournalWriter.elect({
      campaignDir,
      experiment,
      clock: args.clock,
      identity: args.identity,
    });
    let registered: CommittedTransition;
    try {
      registered = writer.commitTransition({
        transition_id: `registered:${campaignId}`,
        at: now,
        type: 'registered',
        payload: {
          campaign_id: campaignId,
          input_digest: experiment.input_digest,
        },
      });
    } finally {
      writer.release();
    }
    publishFrozenCampaign({ campaignDir, experiment, registered });
    return { experiment, campaignDir };
  } finally {
    lease.release();
  }
}
