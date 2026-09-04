import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { z } from 'zod';
import { readPinnedNoFollowFile } from '../appliance/credential-scope.ts';
import {
  type CampaignIdentity,
  CampaignIdentitySchema,
} from '../contracts/campaign/campaign.ts';
import { jcsCanonicalize, sha256Hex } from '../contracts/campaign/digest.ts';
import { AttemptIntentSchema } from '../contracts/campaign/execution.ts';
import {
  ExperimentIdentitySchema,
  IdSchema,
} from '../contracts/campaign/experiment.ts';
import { getEnv } from '../env.ts';
import {
  COVERED_BY_LOCK_ENV,
  defaultLiveSpendLockPath,
  type LiveSpendLock,
  parseLockToken,
  readLiveSpendHolder,
  realProcessIdentityProbe,
} from './locks.ts';
import { readHostClaim } from './ownership.ts';

export const ATTEMPT_AUTHORITY_PATH = '/run/quorum/attempt-authority.json';
export const RUN_ALL_PARENT_OWNER_ENV = 'QUORUM_RUN_ALL_PARENT_OWNER_FILE';
export const PreparedAttemptAuthoritySchema = ExperimentIdentitySchema.extend({
  schema_version: z.literal(1),
  start_id: IdSchema,
  intent: AttemptIntentSchema,
}).strict();
export type PreparedAttemptAuthority = z.infer<
  typeof PreparedAttemptAuthoritySchema
>;
export interface AttemptAuthorityReadOps {
  readDocument(): string;
  readMountInfo(): string;
}
const realReadOps: AttemptAuthorityReadOps = {
  readDocument() {
    const body = readPinnedNoFollowFile(
      dirname(ATTEMPT_AUTHORITY_PATH),
      [basename(ATTEMPT_AUTHORITY_PATH)],
      'private attempt authority',
      true,
    );
    if (body === null) throw new Error('private attempt authority missing');
    return body;
  },
  readMountInfo() {
    if (process.platform !== 'linux')
      throw new Error(
        'private attempt authority requires a Linux read-only file mount',
      );
    return readFileSync('/proc/self/mountinfo', 'utf8');
  },
};
function containsPath(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}
export function validatePreparedAttemptAuthority(
  identity: CampaignIdentity,
  io: AttemptAuthorityReadOps = realReadOps,
): PreparedAttemptAuthority {
  const expected = CampaignIdentitySchema.parse(identity);
  const mounts = io
    .readMountInfo()
    .trim()
    .split('\n')
    .map((line) => line.split(' '));
  const matching = mounts.filter(
    (fields) => fields[4] === ATTEMPT_AUTHORITY_PATH,
  );
  if (matching.length !== 1 || !matching[0]?.[5]?.split(',').includes('ro'))
    throw new Error(
      'private attempt authority must be an exact read-only file mount',
    );
  const doc = PreparedAttemptAuthoritySchema.parse(
    JSON.parse(io.readDocument()),
  );
  const intent = doc.intent;
  const spec = intent.runtime_spec;
  const authorityMounts = spec.mounts.filter(
    (mount) => mount.target === ATTEMPT_AUTHORITY_PATH,
  );
  const authorityMount = authorityMounts[0];
  if (
    authorityMounts.length !== 1 ||
    authorityMount?.mode !== 'ro' ||
    containsPath(intent.output_root, ATTEMPT_AUTHORITY_PATH) ||
    containsPath(intent.output_root, authorityMount.source) ||
    spec.mounts.some(
      (mount) =>
        mount.mode === 'rw' &&
        containsPath(mount.source, authorityMount.source),
    )
  )
    throw new Error(
      'private attempt authority source must be unambiguous and outside writable output or source aliases',
    );
  if (
    doc.campaign_id !== expected.campaign_id ||
    jcsCanonicalize(intent.identity) !== jcsCanonicalize(expected) ||
    sha256Hex(jcsCanonicalize(spec)) !== intent.runtime_spec_digest ||
    spec.public_env.QUORUM_ATTEMPT_AUTHORITY_FILE !== ATTEMPT_AUTHORITY_PATH
  )
    throw new Error(
      'private attempt authority identity or runtime specification mismatch',
    );
  return doc;
}
/** The lease token remains at its original inode. Children receive its name, never a copied token. */
export function runAllChildEnvironment(
  lease: LiveSpendLock,
): Record<string, string> {
  lease.heartbeat();
  return {
    [COVERED_BY_LOCK_ENV]: '1',
    [RUN_ALL_PARENT_OWNER_ENV]: lease.ownerFile,
    QUORUM_LIVE_SPEND_LOCK: lease.lockPath,
  };
}
export function authorizeCoveredChild(identity?: CampaignIdentity): void {
  if (getEnv(COVERED_BY_LOCK_ENV) !== '1')
    throw new Error('covered execution requires an explicit child role');
  const authorityPath = getEnv('QUORUM_ATTEMPT_AUTHORITY_FILE');
  const parentOwner = getEnv(RUN_ALL_PARENT_OWNER_ENV);
  if (authorityPath !== undefined) {
    if (
      parentOwner !== undefined ||
      authorityPath !== ATTEMPT_AUTHORITY_PATH ||
      identity === undefined
    )
      throw new Error('private attempt authority path or child role mismatch');
    validatePreparedAttemptAuthority(identity);
    return;
  }
  if (identity !== undefined || parentOwner === undefined)
    throw new Error('covered child marker alone is not execution authority');
  const lockPath = defaultLiveSpendLockPath();
  if (
    dirname(parentOwner) !== lockPath ||
    !/^owner-[0-9a-f-]+$/.test(basename(parentOwner))
  )
    throw new Error(
      'run-all child parent marker is outside the canonical lease',
    );
  const body = readPinnedNoFollowFile(
    lockPath,
    [basename(parentOwner)],
    'run-all parent lease',
    true,
  );
  const token = body === null ? null : parseLockToken(body);
  const holder = readLiveSpendHolder(lockPath);
  if (
    !token ||
    !holder ||
    token.pid !== process.ppid ||
    holder.pid !== token.pid ||
    holder.birth_ts_ms !== token.birth_ts_ms ||
    realProcessIdentityProbe.exists(token.pid) !== 'alive' ||
    realProcessIdentityProbe.startTimeMs(token.pid) !== token.birth_ts_ms ||
    readHostClaim({ lockPath }) !== null
  )
    throw new Error('run-all child has no matching live direct parent lease');
}
