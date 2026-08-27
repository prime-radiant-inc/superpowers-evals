// biome-ignore-all lint/correctness/noUnusedImports: registration skeleton — the pinned import block is consumed by units 5b/5c/5d (prepareRegistration/registerCampaign append to this file).
// Registration from the snapshot (kernel D3, R-REG-1..22; REV Blocker C):
// resolve refs -> choose/lock the final campaign-dir path -> materialize the
// evals+gauntlet snapshot at that final path -> read scenarios, agent YAMLs,
// and credentials.yaml FROM the snapshot's evals tree (never the mutable
// host checkout) -> grid expansion, rejection matrix, pricing, digest ->
// final-path init (journal + campaign_opened + sidecar + ballast) ->
// campaign.json staged + renamed LAST. Resume authority = campaign.json +
// the snapshot.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { CommandRunner } from '../agents/command-runner.ts';
import { superpowersCapability } from '../agents/index.ts';
import { resolveSuperpowersRef } from '../appliance/git.ts';
import {
  agentRuntimeFamily,
  loadAgentConfigForValidation,
} from '../contracts/agent-config.ts';
import { type Arm, ArmSchema } from '../contracts/campaign/arm.ts';
import {
  type Campaign,
  CampaignSchema,
  type ContentionThreshold,
  type HostFingerprint,
  ID_COMPONENT_RE,
} from '../contracts/campaign/campaign.ts';
import {
  campaignDigest,
  type PreDigestCampaign,
} from '../contracts/campaign/digest.ts';
import { poolKey } from '../contracts/campaign/pool.ts';
import { profileParamsSchema } from '../contracts/campaign/profile-params.ts';
import { scanCouplingDefault } from '../contracts/campaign/scenario-meta.ts';
import { type Suite, SuiteSchema } from '../contracts/campaign/suite.ts';
import {
  type Credential,
  parseCredentialsFile,
} from '../contracts/credential.ts';
import {
  type EstimatesArtifact,
  EstimatesArtifactSchema,
} from '../contracts/estimates.ts';
import type { Clock } from '../scheduler/clock.ts';
import {
  readCoupling,
  readQuorumTier,
  readRequiresSuperpowers,
} from '../story-meta.ts';
import { lookupEstimate } from './estimates.ts';
import {
  clockNowMs,
  type HostStatsProbe,
  probeFingerprint,
} from './host-stats.ts';
import type { SnapshotHandle } from './instrument-snapshot.ts';
import {
  createBallast,
  DEFAULT_BALLAST_BYTES,
  electWriter,
  initJournalDb,
  JournalError,
  stageAndPublishCampaignJson,
  verifyBallast,
} from './journal.ts';
import { acquireLease, type ProcessIdentityProbe } from './locks.ts';
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

// The pinned ID derivation table (REV-2 P-7). Injective by grammar — no
// hashing. `<cell-key> = <comparison_id>:<scenario-name>`.
export function comparisonId(ordinal: number): string {
  return `c${ordinal}`;
}
export function cellKeyOf(comparisonId: string, scenario: string): string {
  assertIdComponent(scenario, 'scenario name');
  return `${comparisonId}:${scenario}`;
}
export function primarySampleId(
  cellKey: string,
  arm: string,
  replicate: number,
): string {
  assertIdComponent(arm, 'arm name');
  return `${cellKey}:${arm}:r${replicate}`;
}
export function primaryBlockId(cellKey: string, replicate: number): string {
  return `${cellKey}:b${replicate}`;
}
export function reserveBlockId(cellKey: string, k: number): string {
  return `${cellKey}:x${k}`;
}
export function reserveSampleId(
  cellKey: string,
  arm: string,
  k: number,
): string {
  assertIdComponent(arm, 'arm name');
  return `${cellKey}:${arm}:x${k}`;
}
export function rerunInstanceId(
  lineageRootBlockId: string,
  seq: number,
): string {
  return `${lineageRootBlockId}:i${seq}`;
}
export function attemptIdOf(sampleId: string, seq: number): string {
  return `${sampleId}:a${seq}`;
}
