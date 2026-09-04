// Registration from the snapshot (kernel D3, R-REG-1..22; REV Blocker C;
// operator amendment 2026-08-27): resolve refs -> read the digest-computation
// intake read-only from the git OBJECT STORE at the resolved frozen SHA
// (git ls-tree + git show — immutable, never the mutable host checkout) ->
// grid expansion, rejection matrix, pricing, digest -> choose/lock the final
// campaign-dir path -> materialize the evals+gauntlet snapshot at that final
// path -> verifyIntakeMatch (byte-identity of every consumed file vs the
// object-store bytes) -> re-derive the AUTHORITATIVE intake + digest from the
// materialized tree -> final-path init (journal + campaign_opened + sidecar +
// ballast) -> campaign.json staged + renamed LAST. Dry-run and print-and-exit
// perform no writes at all. Resume authority = campaign.json + the snapshot.

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
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
  type Block,
  type Campaign,
  CampaignSchema,
  type Cell,
  type ContentionDeclaration,
  type ContentionThreshold,
  type ExecutionSurfaceArm,
  type HostFingerprint,
  ID_COMPONENT_RE,
  type PricingOverride,
  type Sample,
} from '../contracts/campaign/campaign.ts';
import {
  campaignDigest,
  jcsCanonicalize,
  type PreDigestCampaign,
  sha256Hex,
} from '../contracts/campaign/digest.ts';
import {
  type Experiment,
  ExperimentSchema,
} from '../contracts/campaign/experiment.ts';
import { experimentDigest } from '../contracts/campaign/experiment-digest.ts';
import { poolKey } from '../contracts/campaign/pool.ts';
import { profileParamsSchema } from '../contracts/campaign/profile-params.ts';
import { couplingDefaultFrom } from '../contracts/campaign/scenario-meta.ts';
import {
  type Suite as ExperimentSuite,
  SuiteSchema as ExperimentSuiteSchema,
  type BudgetedSuite as Suite,
  BudgetedSuiteSchema as SuiteSchema,
  TIER_SELECTOR_RE,
} from '../contracts/campaign/suite.ts';
import {
  type Credential,
  CredentialSchema,
  parseCredentialsFile,
} from '../contracts/credential.ts';
import type { EstimatesArtifact } from '../contracts/estimates.ts';
import { getEnv } from '../env.ts';
import type { Clock } from '../scheduler/clock.ts';
import {
  couplingFromStory,
  quorumTierFromStory,
  requiresSuperpowersFromStory,
} from '../story-meta.ts';
import { publishFrozenCampaign } from './campaign-document.ts';
import { type EstimateLookup, lookupEstimate } from './estimates.ts';
import {
  type CommittedTransition,
  ExecutionJournalWriter,
  initExecutionJournal,
} from './execution-journal.ts';
import {
  clockNowMs,
  type HostStatsProbe,
  PID_MAX_SLOTS,
  probeFingerprint,
} from './host-stats.ts';
import type { SnapshotHandle } from './instrument-snapshot.ts';
import {
  createBallast,
  DEFAULT_BALLAST_BYTES,
  electWriter,
  initJournalDb,
  type JournalFsOps,
  openJournalRead,
  stageAndPublishCampaignJson,
  verifyBallast,
} from './journal.ts';
import { acquireLease, type ProcessIdentityProbe } from './locks.ts';
import {
  assertFeasible,
  blockDemandVector,
  compileResourcePolicy,
} from './resource-policy.ts';
import { materializeCampaignSnapshot, repairDriftedTrees } from './snapshot.ts';

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

export const SURCHARGE_FORMULA_VERSION = 1;
export const SURCHARGE_RATE_MEDIUM = 0.1;
export const SURCHARGE_RATE_LOW = 0.25;
export const DEFAULT_GLOBAL_CAP = 8;
export const ESTIMATE_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

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

export interface BudgetedRegistrationInput {
  readonly suite: Suite;
  readonly arms: Readonly<Record<string, Arm>>;
  readonly credentials: Readonly<Record<string, Credential>>;
  readonly grader: { credential: string; model: string };
  readonly estimates: EstimatesArtifact;
  readonly capability: (family: string) => { ref: boolean; none: boolean };
  readonly agentOsSupport: (agent: string) => readonly string[] | undefined;
  readonly agentFamily: (agent: string) => string; // runtime_family ?? name
  readonly scenarios: readonly ScenarioIntake[];
  readonly globalCap: number;
  readonly campaignOs: string;
  /** Effective-environment reader for the R-REG-19 key-env preflight. */
  readonly env: (key: string) => string | undefined;
  /** Registration wall time (ms) for the R-REG-21 staleness check. */
  readonly nowMs: number;
  /** Operator-declared per-token escapes (C3, 2026-08-27 operator ruling):
   *  carried through to campaign.json's pricing_overrides by the
   *  orchestration layer (registerCampaign). */
  readonly pricingOverrides?: readonly PricingOverride[];
}

export interface BudgetedPreparedRegistration {
  readonly comparisons: Campaign['comparisons'];
  readonly cells: Cell[];
  readonly samples: Sample[];
  readonly blocks: Block[];
  readonly excluded_cells: { cell: string; reason: string }[];
  readonly warnings: string[];
  readonly budget: {
    usd_all_in: number;
    surcharge_applied: number;
    priced_coverage: number;
    surcharge_formula_version: number;
  };
}

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 } as const;

/** Per-arm pricing through the E1/E2 fallback chain plus the C3 override
 *  costing: an override-covered arm costs per_token_usd x the resolved
 *  tokens_total_median. When the token volume is absent the override cannot
 *  price — fail-closed, never cost_usd: 0, never silently admitted. */
interface ArmPricing {
  readonly lookup: EstimateLookup;
  /** Obol cost median, else the override cost; null when unpriceable. */
  readonly cost_usd: number | null;
  /** per_token_usd x tokens_total_median; null when no override applies or
   *  the volume did not resolve. */
  readonly override_cost: number | null;
}

function priceArm(
  estimates: EstimatesArtifact,
  overrides: readonly PricingOverride[],
  scenario: string,
  armDef: Arm,
  campaignOs: string,
): ArmPricing {
  const lookup = lookupEstimate(estimates, {
    scenario,
    agent: armDef.agent,
    credential: armDef.credential,
    os: campaignOs,
  });
  const override = overrides.find(
    (o) =>
      o.arm === armDef.name &&
      (o.scenario === undefined || o.scenario === scenario),
  );
  const override_cost =
    override !== undefined && lookup.tokens_total_median !== null
      ? override.per_token_usd * lookup.tokens_total_median
      : null;
  return {
    lookup,
    cost_usd: lookup.cost_total_usd ?? override_cost,
    override_cost,
  };
}

/** The pure registration core: grid expansion, the eligibility rejection
 *  matrix (all fail-closed, all loud-recorded), E7.0 reserve minting, E1/E2
 *  pricing, versioned surcharge. Canonical expansion order (determinism
 *  bundle): comparisons in suite order -> cells by scenario sort order ->
 *  arms in comparison order -> replicate ascending. Consumes the snapshot
 *  intake as INPUTS only — it never reads the mutable host checkout (C2). */
export function prepareBudgetedRegistration(
  input: BudgetedRegistrationInput,
): BudgetedPreparedRegistration {
  const { suite, arms, grader, estimates } = input;
  const gating = suite.kind === 'gating';
  const excluded_cells: { cell: string; reason: string }[] = [];
  const warnings: string[] = [];
  const comparisons: BudgetedPreparedRegistration['comparisons'] = [];
  const cells: Cell[] = [];
  const samples: Sample[] = [];
  const blocks: Block[] = [];
  const scenarioByName = new Map(input.scenarios.map((s) => [s.name, s]));
  const overrides = input.pricingOverrides ?? [];

  // Registration-level checks (not per-cell):
  checkProfileParams(suite);
  checkCellOverrideCorrelation(suite); // R-REG-18 (tripwire_expect half)
  checkGraderCredential(input); // R-REG-20 singular + R-REG-15 grader half
  checkKeyEnvPresence(input); // R-REG-19 (registration half)
  checkEstimateStaleness(input); // R-REG-21 — needs nowMs; see registerCampaign
  warnings.push(...graderAndPoolWarnings(input)); // R-REG-20 + R-REG-7
  if ((suite.reserve ?? 0) === 0) {
    warnings.push(
      `suite ${suite.name} registers zero reserve — contention invalidation will be shortfall-only (size reserve for correlated same-window draws)`,
    );
  }
  if (gating) {
    const attested = overrides.some((o) => o.applies_to_grader === true);
    if (!attested) {
      throw new RegistrationError(
        `grader-match restriction: the estimates artifact carries no grader identity, so the registered grader (${grader.credential}, ${grader.model}) must be attested by a pricing_overrides entry with applies_to_grader: true and a rationale (R-REG-3 grader pricing restriction)`,
      );
    }
  } else if (!overrides.some((o) => o.applies_to_grader === true)) {
    warnings.push(
      `grader ${grader.credential}/${grader.model} is unattested against the estimates artifact (exploratory: caveat, not refusal)`,
    );
  }

  suite.comparisons.forEach((comparison, index) => {
    const comparison_id = comparisonId(index + 1);
    const armNames =
      'arm' in comparison
        ? [comparison.arm]
        : [comparison.baseline, comparison.treatment];
    const scenarios = expandSelector(comparison.scenarios, input);
    comparisons.push(
      'arm' in comparison
        ? { comparison_id, arm: comparison.arm }
        : {
            comparison_id,
            baseline: comparison.baseline,
            treatment: comparison.treatment,
          },
    );
    for (const scenarioName of [...scenarios].sort()) {
      const cellKey = cellKeyOf(comparison_id, scenarioName);
      const scen = scenarioByName.get(scenarioName);
      if (scen === undefined) {
        excluded_cells.push({
          cell: cellKey,
          reason: `scenario ${scenarioName} not in the snapshot intake — add it to the scenario intake or fix the comparison's scenario selector`,
        });
        continue;
      }
      const rejection = rejectCell(input, scen, armNames);
      if (rejection !== null) {
        excluded_cells.push({ cell: cellKey, reason: rejection });
        continue;
      }
      const n = comparison.cells?.[scenarioName]?.n ?? comparison.n;
      const cellClass =
        comparison.cells?.[scenarioName]?.class ?? 'descriptive';
      // E1/E2 keying: scenario x agent x credential x os through the
      // lookupEstimate fallback chain.
      const estimatesByArm: Record<
        string,
        {
          duration_s: number;
          cost_usd: number;
          confidence: 'high' | 'medium' | 'low';
        }
      > = {};
      let allPriced = true;
      for (const armName of armNames) {
        const armDef = arms[armName];
        if (armDef === undefined) {
          throw new RegistrationError(
            `arm ${armName} named by a comparison is not in the intake`,
          );
        }
        const priced = priceArm(
          estimates,
          overrides,
          scenarioName,
          armDef,
          input.campaignOs,
        );
        if (priced.cost_usd === null) allPriced = false;
        estimatesByArm[armName] = {
          duration_s: priced.lookup.duration_s,
          cost_usd: priced.cost_usd ?? 0,
          // An override prices but does not manufacture confidence: the
          // fallback tier's own confidence stands (null at corpus tier
          // reads low), so the R-REG-3 surcharge is never suppressed.
          confidence: priced.lookup.confidence ?? 'low',
        };
      }
      if (gating && !allPriced) {
        excluded_cells.push({
          cell: cellKey,
          reason:
            'gating cell on obol-unpriced model without a priceable per-arm pricing override — a per_token_usd override without a resolvable tokens_total_median cannot price; rebuild estimates from runs carrying coding-agent-token-usage.json or drop the arm (R-REG-11)',
        });
        continue;
      }
      cells.push({
        scenario: scenarioName,
        comparison_id,
        arms: [...armNames],
        n,
        class: cellClass,
        coupling: scen.coupling,
        estimates_by_arm: estimatesByArm,
      });
      // Primary samples + blocks: replicate ascending; a block holds the
      // cell's replicate across the comparison's arms.
      for (let r = 1; r <= n; r++) {
        const blockSamples: string[] = [];
        for (const armName of armNames) {
          const sample_id = primarySampleId(cellKey, armName, r);
          samples.push({
            sample_id,
            cell: cellKey,
            arm: armName,
            replicate: r,
          });
          blockSamples.push(sample_id);
        }
        blocks.push({
          block_id: primaryBlockId(cellKey, r),
          comparison_id,
          sample_ids: blockSamples,
        });
      }
      // E7.0: reserve blocks are pre-registered, count-hard, priced — frozen
      // blocks with slot: 'reserve' and their own frozen samples.
      const reserve = suite.reserve ?? 0;
      for (let k = 1; k <= reserve; k++) {
        const reserveSamples: string[] = [];
        for (const armName of armNames) {
          const sample_id = reserveSampleId(cellKey, armName, k);
          samples.push({
            sample_id,
            cell: cellKey,
            arm: armName,
            replicate: k,
          });
          reserveSamples.push(sample_id);
        }
        blocks.push({
          block_id: reserveBlockId(cellKey, k),
          comparison_id,
          sample_ids: reserveSamples,
          slot: 'reserve',
        });
      }
    }
  });

  // Surcharge formula v1 (versioned): for each cell whose worst-arm
  // confidence < high, estimated cost x (medium ? 0.10 : 0.25), priced over
  // the cell's full frozen block count — primaries AND reserves (E7.0:
  // reserve blocks are pre-registered, count-hard, priced).
  const reservePerCell = suite.reserve ?? 0;
  let surcharge = 0;
  let pricedCells = 0;
  for (const cell of cells) {
    let worst: 'high' | 'medium' | 'low' = 'high';
    let cellCost = 0;
    let priced = true;
    for (const armName of cell.arms) {
      const est = cell.estimates_by_arm[armName];
      if (est === undefined) continue; // unpriced arm: covered by priced_coverage below
      if (CONFIDENCE_RANK[est.confidence] < CONFIDENCE_RANK[worst])
        worst = est.confidence;
      cellCost += est.cost_usd;
      if (est.cost_usd === 0 && est.confidence === 'low') priced = false;
    }
    if (priced) pricedCells += 1;
    if (worst !== 'high') {
      surcharge +=
        (cell.n + reservePerCell) *
        cellCost *
        (worst === 'medium' ? SURCHARGE_RATE_MEDIUM : SURCHARGE_RATE_LOW);
    }
  }

  return {
    comparisons,
    cells,
    samples,
    blocks,
    excluded_cells,
    warnings,
    budget: {
      usd_all_in: suite.budget_usd,
      surcharge_applied: surcharge,
      priced_coverage: cells.length === 0 ? 0 : pricedCells / cells.length,
      surcharge_formula_version: SURCHARGE_FORMULA_VERSION,
    },
  };
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
  if (
    scenario.requires_superpowers &&
    armNames.some((name) => input.arms[name]?.superpowers === 'none')
  ) {
    return 'scenario requires_superpowers conflicts with a superpowers: none arm';
  }
  for (const armName of armNames) {
    const arm = input.arms[armName];
    if (arm === undefined) return `arm ${armName} is absent from arms/`;
    const credential = input.credentials[arm.credential];
    if (credential === undefined) {
      return `credential ${arm.credential} for arm ${armName} is absent from credentials.yaml`;
    }
    const family = input.agentFamily(arm.agent);
    if (!credential.harnesses.includes(family)) {
      return `credential ${arm.credential} does not support harness ${family}`;
    }
    if (arm.os === 'windows')
      return `arm ${armName} targets unsupported windows`;
    const os = arm.os ?? input.campaignOs;
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
  const input = { ...rawInput, suite };
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

function expandSelector(
  selector: readonly string[] | string,
  input: BudgetedRegistrationInput,
): string[] {
  // typeof narrowing: Array.isArray cannot exclude a readonly array from
  // the union, typeof can.
  if (typeof selector === 'string') {
    const m = TIER_SELECTOR_RE.exec(selector);
    if (m === null) {
      throw new RegistrationError(
        `bad scenario selector ${JSON.stringify(selector)}`,
      );
    }
    const tier = m[1] as 'sentinel' | 'full' | 'adhoc';
    // The shipped run-all semantics: exact tier match (src/run-all/matrix.ts).
    return input.scenarios.filter((s) => s.tier === tier).map((s) => s.name);
  }
  return [...selector];
}

/** The eligibility rejection matrix (R-REG-9/10/12/13/14/15/16) applied per
 *  cell; returns the first reason or null. All fail-closed, loud-recorded. */
function rejectCell(
  input: BudgetedRegistrationInput,
  scen: ScenarioIntake,
  armNames: readonly string[],
): string | null {
  const { suite, arms, credentials, campaignOs } = input;
  // R-REG-16: requires_superpowers conflict drops the scenario for this
  // comparison (both arms), named in excluded_cells.
  if (
    scen.requires_superpowers &&
    armNames.some((a) => arms[a]?.superpowers === 'none')
  ) {
    return `scenario requires_superpowers conflicts with a superpowers: none arm (R-REG-16) — drop the none arm from this comparison or move the scenario to superpowers-capable arms`;
  }
  for (const armName of armNames) {
    const armDef = arms[armName];
    if (armDef === undefined)
      return `arm ${armName} not in arms/ intake (R-REG-2) — fix the comparison's arm names or add the arm to arms/`;
    const cred = credentials[armDef.credential];
    if (cred === undefined)
      return `arm ${armName} credential ${armDef.credential} not in credentials.yaml (R-REG-2) — add the credential or fix the arm's credential reference`;
    // R-REG-10: os: windows parses, then rejects.
    if (armDef.os === 'windows') {
      return `arm ${armName} targets os windows — a registration error (parent non-goal) (R-REG-10) — run the campaign on a linux or darwin host or drop the arm`;
    }
    // R-REG-14: arm os unsupported by the agent, credential, or scenario
    // directives.
    const armOs = armDef.os ?? campaignOs;
    const agentOs = input.agentOsSupport(armDef.agent);
    if (agentOs !== undefined && !agentOs.includes(armOs)) {
      return `arm ${armName} os ${armOs} unsupported by agent ${armDef.agent} (supports: ${agentOs.join(', ')}) (R-REG-14) — align the arm os with the agent's support or drop the arm`;
    }
    if (cred.os_support !== undefined && !cred.os_support.includes(armOs)) {
      return `arm ${armName} os ${armOs} unsupported by credential ${armDef.credential} (R-REG-14) — align the credential's os_support or drop the arm`;
    }
    if (scen.os !== undefined && !scen.os.includes(armOs)) {
      return `arm ${armName} os ${armOs} unsupported by scenario directive (${scen.os.join(', ')}) (R-REG-14) — align the scenario's os directive or drop the scenario from this comparison`;
    }
    // PAR §Suites: a scenario dropped by its `# coding-agents:` directive is
    // dropped within its comparison for both arms.
    if (
      scen.coding_agents !== undefined &&
      !scen.coding_agents.includes(armDef.agent)
    ) {
      return `arm ${armName} agent ${armDef.agent} outside the scenario's coding-agents directive (${scen.coding_agents.join(', ')}) — drop the scenario from this comparison or add the agent to the directive`;
    }
    // R-REG-9: none/ref arms on adapters without the capability.
    const cap = input.capability(input.agentFamily(armDef.agent));
    if (armDef.superpowers === 'none' ? !cap.none : !cap.ref) {
      return `arm ${armName} superpowers mode ${JSON.stringify(armDef.superpowers)} lacks adapter capability (default-deny registry) (R-REG-9) — drop the arm, switch it to a proven superpowers mode, or extend the adapter capability registry`;
    }
    // R-REG-15 rescinded (owner ruling 2026-09-01, D4a live validation):
    // the api-key-only gating rule was attestation formalism for D4b-era
    // release decisions; it blocked refusal-mechanics validation on
    // credentials (bedrock-bearer) the platform otherwise funds and serves.
    // Gating suites now gate on completed runs, not credential auth class.
  }
  // R-REG-13: minimum-feasible-launch feasibility — cap-1 pools facing
  // two-arm same-pool demand, spacing that cannot co-launch, and demand
  // exceeding the registered caps.
  if (armNames.length === 2) {
    const [a, b] = armNames as readonly [string, string];
    const armA = arms[a];
    const armB = arms[b];
    const credA = armA !== undefined ? credentials[armA.credential] : undefined;
    const credB = armB !== undefined ? credentials[armB.credential] : undefined;
    if (
      armA === undefined ||
      armB === undefined ||
      credA === undefined ||
      credB === undefined
    ) {
      return `comparison names an arm or credential missing from the intake (R-REG-2 fail-closed) — fix arms/ or credentials/ so every comparison arm resolves`;
    }
    const poolA = poolKey(credA, armA.credential);
    const poolB = poolKey(credB, armB.credential);
    if (poolA === poolB) {
      // Order-independent feasibility: every registry credential mapped to
      // this pool constrains it — the tightest cap and any positive spacing
      // bind the two-arm demand, whichever arm named them.
      const members = Object.entries(credentials)
        .filter(([name, cred]) => poolKey(cred, name) === poolA)
        .map(([, cred]) => cred);
      const poolCap = Math.min(
        ...members.map((cred) => cred.max_concurrency ?? 1),
      );
      const poolSpacing = Math.max(
        ...members.map((cred) => cred.launch_spacing_seconds ?? 0),
      );
      if (poolCap < 2) {
        return `comparison infeasible pre-spend: pool ${poolA} resolves to cap-${poolCap} across its ${members.length} credential declaration(s); two-arm same-pool demand cannot launch (R-REG-13) — raise every pool credential's max_concurrency to >= 2 or split the arms across pools`;
      }
      if (poolSpacing > 0) {
        return `comparison infeasible pre-spend: launch spacing ${poolSpacing}s declared on shared pool ${poolA}; the arms cannot co-launch (R-REG-13) — remove launch_spacing_seconds from the pool's credentials or split the arms across pools`;
      }
    }
    if (input.globalCap < 2) {
      return `comparison infeasible pre-spend: global_run_cap ${input.globalCap} < two-sample block demand (R-REG-13) — re-register with --global-cap >= 2`;
    }
  }
  // R-REG-12: usd-denominated profile parameters when any arm is unpriceable.
  const usdParams = Object.keys(suite.profile_params ?? {}).filter(
    (key) => key.endsWith('_usd') || key.startsWith('usd_'),
  );
  if (usdParams.length > 0) {
    const unpriceable = armNames.some((armName) => {
      const armDef = arms[armName];
      if (armDef === undefined) return true; // unknown arm: unpriceable, fail-closed
      return (
        priceArm(
          input.estimates,
          input.pricingOverrides ?? [],
          scen.name,
          armDef,
          campaignOs,
        ).cost_usd === null
      );
    });
    if (unpriceable) {
      return `usd-denominated profile parameters (${usdParams.join(', ')}) with an unpriceable arm (R-REG-12) — price the arm (a per-token override with a resolvable tokens_total_median, or refreshed estimates) or drop the usd-denominated parameters`;
    }
  }
  return null;
}

function checkProfileParams(suite: Suite): void {
  if (suite.profile === undefined) return;
  const schema = profileParamsSchema(suite.profile);
  if (schema === undefined) {
    throw new RegistrationError(`unknown profile ${suite.profile}`);
  }
  const result = schema.safeParse(suite.profile_params ?? {});
  if (!result.success) {
    throw new RegistrationError(
      `profile_params fail the ${suite.profile} registry schema: ${result.error.message}`,
    );
  }
  // R-REG-18: mde_by_scenario must cover every scenario carrying
  // confirmatory cells (checked after grid expansion would duplicate the
  // loop; the confirmatory set comes from the suite's cell overrides).
  if (suite.profile === 'release_gate_v1') {
    const params = result.data as { mde_by_scenario: Record<string, number> };
    const confirmatoryScenarios = new Set<string>();
    for (const comparison of suite.comparisons) {
      const cells = 'cells' in comparison ? comparison.cells : undefined;
      for (const [scenario, cell] of Object.entries(cells ?? {})) {
        if (cell.class === 'confirmatory') confirmatoryScenarios.add(scenario);
      }
    }
    for (const scenario of confirmatoryScenarios) {
      if (params.mde_by_scenario[scenario] === undefined) {
        throw new RegistrationError(
          `profile_params.mde_by_scenario missing confirmatory scenario ${scenario} (R-REG-18)`,
        );
      }
    }
  }
}

/** R-REG-18 (tripwire_expect half): the firing criterion correlates to
 *  tripwire cells — a gating tripwire cell without one has no firing
 *  semantics, and one declared on any other class is a miscorrelation. */
function checkCellOverrideCorrelation(suite: Suite): void {
  for (const comparison of suite.comparisons) {
    const cells = comparison.cells;
    if (cells === undefined) continue;
    for (const [scenario, cell] of Object.entries(cells)) {
      if (
        suite.kind === 'gating' &&
        cell.class === 'tripwire' &&
        cell.tripwire_expect === undefined
      ) {
        throw new RegistrationError(
          `comparison cell ${scenario} is class tripwire without tripwire_expect — the v1 firing criterion is required on gating tripwire cells (R-REG-18) — declare tripwire_expect: 'pass' | 'fail' or re-class the cell`,
        );
      }
      if (cell.class !== 'tripwire' && cell.tripwire_expect !== undefined) {
        throw new RegistrationError(
          `comparison cell ${scenario} (class ${cell.class}) declares tripwire_expect — the firing criterion correlates to tripwire cells only (R-REG-18) — drop tripwire_expect or re-class the cell tripwire`,
        );
      }
    }
  }
}

/** R-REG-20 grader singular: the registered grader credential must exist,
 *  mechanical, before any expansion. (The R-REG-15 api-key half was
 *  rescinded by owner ruling 2026-09-01 — see rejectCell.) */
function checkGraderCredential(input: BudgetedRegistrationInput): void {
  const cred = input.credentials[input.grader.credential];
  if (cred === undefined) {
    throw new RegistrationError(
      `grader credential ${input.grader.credential} not in credentials.yaml (R-REG-20 grader singular) — add the credential or re-register with a registered grader credential`,
    );
  }
}

function checkKeyEnvPresence(input: BudgetedRegistrationInput): void {
  // R-REG-19 (registration half): every arm credential and the grader
  // credential — api_key_env (or every key_pool entry) present in the
  // environment, else registration refuses.
  const missing: string[] = [];
  const checked = new Set<string>();
  const checkOne = (name: string, cred: Credential | undefined) => {
    if (cred === undefined || checked.has(name) || cred.auth !== 'api-key')
      return;
    checked.add(name);
    const envNames =
      cred.key_pool ??
      (cred.api_key_env !== undefined ? [cred.api_key_env] : []);
    if (envNames.length === 0) {
      missing.push(`${name}: api-key auth with no api_key_env/key_pool`);
      return;
    }
    for (const envName of envNames) {
      const value = input.env(envName);
      if (value === undefined || value === '') missing.push(envName);
    }
  };
  for (const armDef of Object.values(input.arms)) {
    checkOne(armDef.credential, input.credentials[armDef.credential]);
  }
  checkOne(input.grader.credential, input.credentials[input.grader.credential]);
  if (missing.length > 0) {
    throw new RegistrationError(
      `key env preflight failed — unset or missing: ${[...new Set(missing)].join(', ')} (R-REG-19; export the missing env vars and re-register — re-checked at every live-spend-lock acquisition)`,
    );
  }
}

function checkEstimateStaleness(input: BudgetedRegistrationInput): void {
  // R-REG-21: the mechanical staleness rule — the newest included run is
  // >30 days older than the build; artifact.generated_at IS the newest
  // included run's finished_at (data-derived), so compare it against
  // registration time. The process half (rebuild after every sealed gating
  // campaign) is not observable here and rides the refusal text.
  const generatedMs = Date.parse(input.estimates.generated_at);
  if (!Number.isFinite(generatedMs)) {
    throw new RegistrationError(
      `estimates artifact generated_at unparseable: ${input.estimates.generated_at}`,
    );
  }
  if (input.nowMs - generatedMs > ESTIMATE_STALE_AFTER_MS) {
    throw new RegistrationError(
      `estimates artifact is stale (generated ${input.estimates.generated_at}, >30 days before registration) — rebuild: quorum campaign acquire + quorum campaign estimates (R-REG-21; rebuild after every sealed gating campaign)`,
    );
  }
}

function graderAndPoolWarnings(input: BudgetedRegistrationInput): string[] {
  const warnings: string[] = [];
  const gating = input.suite.kind === 'gating';
  const graderCred = input.credentials[input.grader.credential];
  if (graderCred !== undefined) {
    const graderCap =
      graderCred.max_concurrency ??
      (graderCred.key_pool !== undefined ? graderCred.key_pool.length * 5 : 1);
    if (gating && graderCap < 15) {
      warnings.push(
        `grader pool cap ${graderCap} < 15 in a gating suite — every 8h-clearing Phase 0 configuration had cap >= 15 (R-REG-20 warning)`,
      );
    }
  }
  for (const [name, cred] of Object.entries(input.credentials)) {
    if (cred.key_pool !== undefined && cred.max_concurrency !== undefined) {
      if (cred.max_concurrency > cred.key_pool.length * 5) {
        warnings.push(
          `credential ${name}: key_pool max_concurrency ${cred.max_concurrency} exceeds key_pool.length x 5 (${cred.key_pool.length * 5}) — the single-key cap 5 Phase 0 modeled (R-REG-7 warning)`,
        );
      }
    }
  }
  return warnings;
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

export interface BudgetedRegisterArgs {
  readonly suitePath: string;
  readonly suiteRaw: string;
  readonly campaignsRoot: string;
  readonly estimates: EstimatesArtifact;
  readonly globalCap: number;
  readonly confirm: boolean;
  readonly dryRun: boolean;
  readonly evalsCheckout: string;
  readonly gauntletCheckout: string;
  readonly superpowersCheckout: string;
  readonly evalsRef: string;
  readonly gauntletRef: string;
  readonly runner: CommandRunner;
  readonly clock: Clock;
  readonly identity: ProcessIdentityProbe;
  readonly probe: HostStatsProbe;
  readonly env: (key: string) => string | undefined;
  readonly registeredBy: string;
  readonly nowMs: number;
  /** Operator-declared per-token escapes (C3 public intake, 2026-08-27
   *  operator ruling): passed into prepareRegistration's override costing
   *  and persisted into campaign.json's pricing_overrides. */
  readonly pricingOverrides?: readonly PricingOverride[];
  /** The publication-primitive fs seam (ballast + campaign.json staging);
   *  unset means the real filesystem. Lets a test observe the durable P-4
   *  order — committed campaign_opened BEFORE the marker rename. */
  readonly fsOps?: JournalFsOps;
}

export interface BudgetedRegisterResult {
  readonly campaign_id: string;
  readonly digest: string;
  /** '' until the dir exists (dry-run / print-and-exit). */
  readonly campaignDir: string;
  readonly published: boolean;
  readonly dryRun: boolean;
  readonly printed: string;
  readonly excluded_cells: { cell: string; reason: string }[];
  readonly warnings: string[];
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
interface ComputedRegistration {
  readonly prepared: BudgetedPreparedRegistration;
  readonly preDigest: PreDigestCampaign;
  readonly digest: string;
}

type CandidateClass =
  | { kind: 'absent' }
  | { kind: 'published'; digest: string }
  | { kind: 'incomplete'; openedDigest: string | null }
  | { kind: 'shell' }
  | { kind: 'ambiguous' };

/** Decision D-6 / Round-4 S-8 classification: published campaign.json
 *  supplies the candidate's full digest; an incomplete dir's first
 *  campaign_opened supplies it when readable; a digest-less dir is reusable
 *  only when nothing records spend; else ambiguous (prefix extends, loud
 *  orphan note). */
function classifyCandidate(candidate: string): CandidateClass {
  if (!existsSync(candidate)) return { kind: 'absent' };
  const campaignJson = join(candidate, 'campaign.json');
  if (existsSync(campaignJson)) {
    const doc = JSON.parse(readFileSync(campaignJson, 'utf8')) as {
      digest?: string;
    };
    if (typeof doc.digest !== 'string') return { kind: 'ambiguous' };
    return { kind: 'published', digest: doc.digest };
  }
  const journalDb = join(candidate, 'journal.db');
  let openedDigest: string | null = null;
  let eventCount = 0;
  if (existsSync(journalDb)) {
    const reader = openJournalRead(candidate);
    try {
      const events = reader.readEvents();
      eventCount = events.length;
      const opened = events[0];
      if (opened !== undefined && opened.type === 'campaign_opened') {
        openedDigest = opened.payload.digest;
      }
    } finally {
      reader.close();
    }
  }
  const spendArtifacts = ['cancel-request', '.storage-paused'].some((f) =>
    existsSync(join(candidate, f)),
  );
  if (openedDigest !== null) return { kind: 'incomplete', openedDigest };
  if (eventCount === 0 && !spendArtifacts) return { kind: 'shell' };
  return { kind: 'ambiguous' };
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

export function registerBudgetedCampaign(
  args: BudgetedRegisterArgs,
): BudgetedRegisterResult {
  const printed: string[] = [];
  const emit = (line: string): void => {
    printed.push(line);
  };

  // 1. Suite + grader intake (Design note 1): the grader block is extracted
  //    BEFORE the strict SuiteSchema parse.
  const raw = parseYaml(args.suiteRaw) as Record<string, unknown>;
  const graderRaw = raw['grader'] as
    | { credential?: string; model?: string }
    | undefined;
  if (
    graderRaw === undefined ||
    typeof graderRaw.credential !== 'string' ||
    typeof graderRaw.model !== 'string'
  ) {
    throw new RegistrationError(
      `${args.suitePath}: suite must declare grader: { credential, model } — the campaign grader is registered singular (R-REG-20)`,
    );
  }
  const graderDecl = {
    credential: graderRaw.credential,
    model: graderRaw.model,
  };
  const { grader: _stripped, ...suiteFields } = raw;
  const suite = SuiteSchema.parse(suiteFields);
  assertIdComponent(suite.name, 'suite name');

  // 2. Ref resolution to 40-hex SHAs (R-REG-8).
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

  // 3. Contention declarations (Decision D-3/D-4): the host fingerprint
  //    defines the designated host; thresholds derive from the same sample.
  const nowMs = clockNowMs(args.clock);
  const stats = args.probe.sample(nowMs);
  const fingerprint = probeFingerprint(args.probe, nowMs);
  const contention = buildContentionBlock({
    fingerprint,
    globalCap: args.globalCap,
    thresholds: defaultContentionThresholds({
      mem_bytes: stats.mem_total_bytes,
      swap_total_bytes: stats.swap_total_bytes,
      disk_total_bytes: stats.disk_total_bytes,
    }),
  });

  // 4. Digest-computation intake (operator amendment 2026-08-27, finding 1):
  //    grid + digest derive from the git OBJECT STORE at the resolved frozen
  //    SHA — read-only, and the first filesystem write only happens after
  //    the confirm gates below (finding 2: dry-run never writes).
  const compute = (intake: SnapshotIntake): ComputedRegistration => {
    const superpowers_by_arm: Record<string, string | null> = {};
    for (const armDef of Object.values(intake.arms)) {
      superpowers_by_arm[armDef.name] =
        armDef.superpowers === 'none'
          ? null
          : resolveSuperpowersRef(
              { path: args.superpowersCheckout, remote: 'origin' },
              armDef.superpowers,
              args.runner,
            );
    }
    const prepared = prepareBudgetedRegistration({
      suite,
      arms: intake.arms,
      credentials: intake.credentials,
      grader: graderDecl,
      estimates: args.estimates,
      capability: (family) => superpowersCapability(family),
      agentOsSupport: (agent) => intakeAgentConfig(intake, agent).os_support,
      agentFamily: (agent) =>
        agentRuntimeFamily(intakeAgentConfig(intake, agent)),
      scenarios: intake.scenarios,
      globalCap: args.globalCap,
      campaignOs: 'linux',
      env: args.env,
      nowMs: args.nowMs,
      ...(args.pricingOverrides !== undefined
        ? { pricingOverrides: args.pricingOverrides }
        : {}),
    });
    // Execution surface (scrubbed, secret-free — env-var NAMES only).
    const execution_surface = Object.values(intake.arms).map((armDef) => {
      const cred = intake.credentials[armDef.credential];
      return {
        name: armDef.name,
        agent: armDef.agent,
        credential: armDef.credential,
        auth: cred?.auth ?? 'api-key',
        api: cred?.api ?? 'openai-chat',
        ...(cred?.base_url !== undefined ? { base_url: cred.base_url } : {}),
        model: cred?.model ?? '',
        key_env_names:
          cred?.key_pool ??
          (cred?.api_key_env !== undefined ? [cred.api_key_env] : []),
      };
    });
    const preDigest: PreDigestCampaign = {
      schema_version: 1,
      campaign_id: 'pending',
      suite,
      refs: { superpowers_by_arm, evals: evalsSha, gauntlet: gauntletSha },
      grader: graderDecl,
      cells: prepared.cells,
      excluded_cells: prepared.excluded_cells,
      samples: prepared.samples,
      comparisons: prepared.comparisons,
      blocks: prepared.blocks,
      budget: prepared.budget,
      registered_at: new Date(args.nowMs).toISOString(),
      registered_by: args.registeredBy,
      contention,
      execution_surface,
      ...(args.pricingOverrides !== undefined
        ? { pricing_overrides: [...args.pricingOverrides] }
        : {}),
    };
    return { prepared, preDigest, digest: campaignDigest(preDigest) };
  };

  const intake = readSnapshotIntake(args.evalsCheckout, evalsSha, args.runner);
  const staging = compute(intake);
  const digest = staging.digest;
  const campaign_id = digest; // identity = digest

  // 5. Confirmation output (R-REG-22 + Decision D-1 max-block reading).
  emit(`campaign ${suite.name}`);
  emit(
    `grid: ${staging.prepared.cells.length} cells, ${staging.prepared.samples.length} samples, ${staging.prepared.blocks.length} blocks`,
  );
  emit(
    `budget: $${staging.prepared.budget.usd_all_in} all-in (surcharge $${staging.prepared.budget.surcharge_applied}, priced coverage ${staging.prepared.budget.priced_coverage})`,
  );
  for (const exclusion of staging.prepared.excluded_cells) {
    emit(`excluded ${exclusion.cell}: ${exclusion.reason}`);
  }
  for (const warning of staging.prepared.warnings) {
    emit(`warning: ${warning}`);
  }
  emit(
    'reserve is one shared per-cell pool for instrument, skew, exposure-audit, and contention replacements — size for correlated same-window draws',
  );
  if ((suite.reserve ?? 0) === 0) {
    emit('warning: contention invalidation will be shortfall-only');
  }
  emit(`digest: ${digest}`);
  emit(
    `global_run_cap = ${args.globalCap} per-sample slots; max contemporaneous two-arm blocks = ${Math.floor(args.globalCap / 2)}`,
  );

  const finishUnpublished = (): BudgetedRegisterResult => ({
    campaign_id,
    digest,
    campaignDir: '',
    published: false,
    dryRun: args.dryRun,
    printed: printed.join('\n'),
    excluded_cells: staging.prepared.excluded_cells,
    warnings: staging.prepared.warnings,
  });
  if (args.dryRun) return finishUnpublished();
  // Noninteractive: no tty prompt, ever — absent --confirm is the
  // print-and-exit path.
  if (!args.confirm) return finishUnpublished();

  // First filesystem write of the flow (finding 2): the campaigns root and
  // the registration lease, only once publication is confirmed.
  mkdirSync(args.campaignsRoot, { recursive: true });
  const lease = acquireLease({
    lockPath: join(args.campaignsRoot, 'registration.lock.d'),
    clock: args.clock,
    identity: args.identity,
    label: 'registration lease',
  });
  try {
    // 6. Candidate dir naming + collision extension (Decision D-6).
    let prefixLen = 8;
    let campaignDir = '';
    let reopenOnly = false;
    // Finding 4: extension is bounded by the digest itself — past the full
    // 64 hex chars the slice stops changing and an unbounded loop would
    // spin forever on a saturated prefix. A collision AT the full digest IS
    // the exhaustion: refuse naming the exhausted candidate dir and its
    // occupant's conflicting digest (campaign.json or journal
    // campaign_opened, via classifyCandidate — round-2 finding 2).
    const extendOrExhaust = (
      candidate: string,
      occupantDigest: string | null,
    ): void => {
      if (prefixLen >= digest.length) {
        const occupant =
          occupantDigest === null
            ? 'an ambiguous orphan with no readable digest'
            : `an occupant with digest ${occupantDigest}`;
        throw new RegistrationError(
          `digest-prefix collision exhausted at ${candidate}: the full-digest candidate is held by ${occupant}, conflicting with registering digest ${digest} — inspect the directories under ${args.campaignsRoot}, resolve or move the conflicting campaign, then re-register (fail-closed)`,
        );
      }
      prefixLen += 4;
    };
    for (;;) {
      const candidate = join(
        args.campaignsRoot,
        `${digest.slice(0, prefixLen)}-${suite.name}`,
      );
      const classification = classifyCandidate(candidate);
      if (classification.kind === 'absent' || classification.kind === 'shell') {
        campaignDir = candidate;
        break;
      }
      if (classification.kind === 'incomplete') {
        if (classification.openedDigest === digest) {
          campaignDir = candidate;
          break;
        }
        emit(
          `collision: ${candidate} holds a different campaign_opened digest — extending prefix`,
        );
        extendOrExhaust(candidate, classification.openedDigest);
        continue;
      }
      if (classification.kind === 'published') {
        if (classification.digest === digest) {
          campaignDir = candidate;
          reopenOnly = true; // R-REG-22: digest equality only, no republish
          break;
        }
        emit(
          `collision: ${candidate} is published with a different digest — extending prefix`,
        );
        extendOrExhaust(candidate, classification.digest);
        continue;
      }
      emit(
        `orphan: ${candidate} is ambiguous (no identity carrier, spend recorded) — left untouched, extending prefix`,
      );
      extendOrExhaust(candidate, null);
    }

    if (reopenOnly) {
      emit(
        `re-opening published campaign at ${campaignDir} (digest equality verified)`,
      );
      return {
        campaign_id,
        digest,
        campaignDir,
        published: false,
        dryRun: false,
        printed: printed.join('\n'),
        excluded_cells: staging.prepared.excluded_cells,
        warnings: staging.prepared.warnings,
      };
    }

    // 7. P-4 publication order: snapshot at the final path FIRST, then
    //    journal init -> ballast -> campaign.json staged + renamed LAST.
    //    (1) Materialize at the final path; incomplete-re-entry repair under
    //        the lease when the dest holds drifted/dirty debris (D-7 S-8).
    const snapshotArgs = {
      campaignDir,
      refs: staging.preDigest.refs,
      evalsCheckout: args.evalsCheckout,
      gauntletCheckout: args.gauntletCheckout,
      superpowersCheckout: args.superpowersCheckout,
      runner: args.runner,
    };
    let handle: SnapshotHandle;
    try {
      handle = materializeCampaignSnapshot(snapshotArgs);
    } catch (err) {
      emit(
        `repair: snapshot materialization failed (${(err as Error).message}) — removing drifted trees under lease and re-materializing (loud, D-7 S-8)`,
      );
      try {
        handle = repairDriftedTrees(snapshotArgs);
      } catch (repairErr) {
        throw new RegistrationError(
          `snapshot repair failed at ${campaignDir}: ${(repairErr as Error).message} — refusing registration (fail-closed)`,
        );
      }
    }
    // (2) Byte verification (amendment 2026-08-27): every consumed file
    //     must be byte-identical between the object-store intake and the
    //     final-path materialized tree. The materialized tree is the
    //     AUTHORITATIVE intake — its recomputed digest must equal the
    //     digest that named the directory (R-REG-5: what ships is what was
    //     digested; a mismatch is corruption, never ignored).
    verifyIntakeMatch(intake, handle.evalsRoot);
    const authoritative = compute(readIntakeFromEvalsTree(handle.evalsRoot));
    if (authoritative.digest !== digest) {
      throw new RegistrationError(
        `materialized snapshot at ${campaignDir} does not reproduce the registration digest (${authoritative.digest} != ${digest}) — refusing publication; inspect the snapshot trees, then re-run registration (fail-closed)`,
      );
    }
    probeChildContract(handle.evalsRoot, evalsSha, args);

    // (3) Journal init + campaign_opened (first event, committed before
    //     campaign.json exists; never re-journaled on re-entry) + sidecar.
    if (!existsSync(join(campaignDir, 'journal.db')))
      initJournalDb(campaignDir);
    const writer = electWriter({
      campaignDir,
      clock: args.clock,
      identity: args.identity,
    });
    try {
      const events = writer.readEvents();
      if (events.length === 0) {
        writer.appendEvent({
          type: 'campaign_opened',
          payload: { campaign_id, digest },
        });
      } else {
        const opened = events[0];
        if (
          opened === undefined ||
          opened.type !== 'campaign_opened' ||
          opened.payload.digest !== digest
        ) {
          throw new RegistrationError(
            `existing journal at ${campaignDir} carries a different campaign_opened digest — refusing (fail-closed); inspect journal.db and re-run registration against the matching suite/refs`,
          );
        }
      }
    } finally {
      writer.release();
    }
    const sidecar = join(campaignDir, 'contention-telemetry.jsonl');
    if (!existsSync(sidecar)) writeFileSync(sidecar, '', { flag: 'wx' });

    // (4) Ballast: verify-or-create. Idempotent re-entry VERIFIES the same
    //     properties or RECREATES the ballast before publishing (D-13) — a
    //     crash mid-createBallast leaves a short/unverifiable file, and a
    //     refusal here would brick the directory (createBallast opens
    //     O_EXCL). Publication has not happened yet, so recreation is
    //     legal; the never-recreate rule applies only MID-campaign.
    const ballastPath = join(campaignDir, '.ballast');
    if (!existsSync(ballastPath)) {
      createBallast(campaignDir, DEFAULT_BALLAST_BYTES, args.fsOps);
    } else if (!verifyBallast(campaignDir, DEFAULT_BALLAST_BYTES, args.fsOps)) {
      process.stderr.write(
        `existing .ballast at ${campaignDir} fails the non-sparse allocation check — recreating before publication (D-13 re-entry)\n`,
      );
      unlinkSync(ballastPath);
      createBallast(campaignDir, DEFAULT_BALLAST_BYTES, args.fsOps);
    }

    // (5) campaign.json staged + renamed LAST, directory fsync — built from
    //     the authoritative final-path intake. The publication is
    //     UNCONDITIONAL (finding 3): an unexpected existing campaign.json —
    //     one that appeared after classification — is the helper's
    //     already-published refusal, never a silent skip past the marker.
    //     Idempotent re-registration never reaches here (reopenOnly above).
    const finalDoc = { ...authoritative.preDigest, campaign_id, digest };
    CampaignSchema.parse(finalDoc); // the frozen document shape, validated
    stageAndPublishCampaignJson(
      campaignDir,
      finalDoc,
      DEFAULT_BALLAST_BYTES,
      args.fsOps,
    );
    emit(`published ${campaignDir}`);

    return {
      campaign_id,
      digest,
      campaignDir,
      published: true,
      dryRun: false,
      printed: printed.join('\n'),
      excluded_cells: authoritative.prepared.excluded_cells,
      warnings: authoritative.prepared.warnings,
    };
  } finally {
    lease.release();
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
  const graderRaw = record['grader'];
  const graderCredential =
    graderRaw !== null &&
    typeof graderRaw === 'object' &&
    !Array.isArray(graderRaw)
      ? (graderRaw as Record<string, unknown>)['credential']
      : undefined;
  const graderModel =
    graderRaw !== null &&
    typeof graderRaw === 'object' &&
    !Array.isArray(graderRaw)
      ? (graderRaw as Record<string, unknown>)['model']
      : undefined;
  if (typeof graderCredential !== 'string' || typeof graderModel !== 'string') {
    throw new RegistrationError(
      `${args.suitePath}: suite must declare grader: { credential, model }`,
    );
  }
  const grader = {
    credential: graderCredential,
    model: graderModel,
  };
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
