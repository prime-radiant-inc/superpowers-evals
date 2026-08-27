// Registration from the snapshot (kernel D3, R-REG-1..22; REV Blocker C):
// resolve refs -> choose/lock the final campaign-dir path -> materialize the
// evals+gauntlet snapshot at that final path -> read scenarios, agent YAMLs,
// and credentials.yaml FROM the snapshot's evals tree (never the mutable
// host checkout) -> grid expansion, rejection matrix, pricing, digest ->
// final-path init (journal + campaign_opened + sidecar + ballast) ->
// campaign.json staged + renamed LAST. Resume authority = campaign.json +
// the snapshot.
import { ID_COMPONENT_RE } from '../contracts/campaign/campaign.ts';

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
