// Registration from the snapshot (kernel D3, R-REG-1..22; REV Blocker C):
// resolve refs -> choose/lock the final campaign-dir path -> materialize the
// evals+gauntlet snapshot at that final path -> read scenarios, agent YAMLs,
// and credentials.yaml FROM the snapshot's evals tree (never the mutable
// host checkout) -> grid expansion, rejection matrix, pricing, digest ->
// final-path init (journal + campaign_opened + sidecar + ballast) ->
// campaign.json staged + renamed LAST. Resume authority = campaign.json +
// the snapshot.

import type { Arm } from '../contracts/campaign/arm.ts';
import {
  type Block,
  type Campaign,
  type Cell,
  ID_COMPONENT_RE,
  type PricingOverride,
  type Sample,
} from '../contracts/campaign/campaign.ts';
import { poolKey } from '../contracts/campaign/pool.ts';
import { profileParamsSchema } from '../contracts/campaign/profile-params.ts';
import { type Suite, TIER_SELECTOR_RE } from '../contracts/campaign/suite.ts';
import type { Credential } from '../contracts/credential.ts';
import type { EstimatesArtifact } from '../contracts/estimates.ts';
import { type EstimateLookup, lookupEstimate } from './estimates.ts';

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
}

export interface RegistrationInput {
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

export interface PreparedRegistration {
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
export function prepareRegistration(
  input: RegistrationInput,
): PreparedRegistration {
  const { suite, arms, grader, estimates } = input;
  const gating = suite.kind === 'gating';
  const excluded_cells: { cell: string; reason: string }[] = [];
  const warnings: string[] = [];
  const comparisons: PreparedRegistration['comparisons'] = [];
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

function expandSelector(
  selector: readonly string[] | string,
  input: RegistrationInput,
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
  input: RegistrationInput,
  scen: ScenarioIntake,
  armNames: readonly string[],
): string | null {
  const { suite, arms, credentials, campaignOs } = input;
  const gating = suite.kind === 'gating';
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
    // R-REG-9: none/ref arms on adapters without the capability.
    const cap = input.capability(input.agentFamily(armDef.agent));
    if (armDef.superpowers === 'none' ? !cap.none : !cap.ref) {
      return `arm ${armName} superpowers mode ${JSON.stringify(armDef.superpowers)} lacks adapter capability (default-deny registry) (R-REG-9) — drop the arm, switch it to a proven superpowers mode, or extend the adapter capability registry`;
    }
    // R-REG-15: seat/subscription auth in gating suites — mechanical, no
    // operator override.
    if (gating && cred.auth !== 'api-key') {
      return `arm ${armName} credential ${armDef.credential} auth=${cred.auth} in a gating suite (R-REG-15, api-key required, no override) — switch the arm to an api-key credential`;
    }
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

/** R-REG-20 grader singular + R-REG-15 grader half: the registered grader
 *  credential must exist, and in a gating suite it must be api-key auth —
 *  mechanical, before any expansion. */
function checkGraderCredential(input: RegistrationInput): void {
  const cred = input.credentials[input.grader.credential];
  if (cred === undefined) {
    throw new RegistrationError(
      `grader credential ${input.grader.credential} not in credentials.yaml (R-REG-20 grader singular) — add the credential or re-register with a registered grader credential`,
    );
  }
  if (input.suite.kind === 'gating' && cred.auth !== 'api-key') {
    throw new RegistrationError(
      `grader credential ${input.grader.credential} auth=${cred.auth} in a gating suite — api-key required, no operator override (R-REG-15) — use an api-key grader credential`,
    );
  }
}

function checkKeyEnvPresence(input: RegistrationInput): void {
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

function checkEstimateStaleness(input: RegistrationInput): void {
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

function graderAndPoolWarnings(input: RegistrationInput): string[] {
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
  if (!gating && graderCred !== undefined && graderCred.auth !== 'api-key') {
    warnings.push(
      `grader credential ${input.grader.credential} auth=${graderCred.auth} — seat-auth grading cannot be enforced mechanically outside gating suites; prefer an api-key grader credential (R-REG-15 exploratory caveat)`,
    );
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
