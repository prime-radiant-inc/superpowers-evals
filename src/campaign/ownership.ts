import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { readPinnedNoFollowFile } from '../appliance/credential-scope.ts';
import { jcsCanonicalize, sha256Hex } from '../contracts/campaign/digest.ts';
import {
  type HostCampaignClaim,
  HostCampaignClaimSchema,
  type ProcessIdentity,
  VerifiedStoppedSchema,
} from '../contracts/campaign/execution.ts';
import {
  ExperimentIdentitySchema,
  IdSchema,
  Sha256Schema,
  TimestampSchema,
} from '../contracts/campaign/experiment.ts';
import {
  readCommittedTransitions,
  readProjection,
} from './execution-journal.ts';
import {
  createDurableMarker,
  DEFAULT_BALLAST_BYTES,
  fsyncDir,
  type JournalFsOps,
  releaseBallast,
  verifyBallast,
} from './journal.ts';
import {
  defaultLiveSpendLockPath,
  readLiveSpendHolder,
  realProcessIdentityProbe,
} from './locks.ts';

export interface OwnershipPaths {
  lockPath?: string;
}
export const CancelIntentSchema = ExperimentIdentitySchema.extend({
  start_id: IdSchema,
  requested_at: TimestampSchema,
  controller_loss_established: z.boolean(),
  reason: IdSchema,
}).strict();
export type CancelIntent = z.infer<typeof CancelIntentSchema>;
const TerminationReceiptSchema = ExperimentIdentitySchema.extend({
  start_id: IdSchema,
  transition_id: IdSchema,
  transition_digest: Sha256Schema,
  stopped: z.array(VerifiedStoppedSchema),
}).strict();
export type TerminationReceipt = z.infer<typeof TerminationReceiptSchema>;
export type LiveSpendAuthority =
  | (HostCampaignClaim & { kind: 'controller'; process: ProcessIdentity })
  | { kind: 'cancellation'; intent: CancelIntent };
function same(left: unknown, right: unknown): boolean {
  return jcsCanonicalize(left) === jcsCanonicalize(right);
}
function identityMatches(
  left: { campaign_id: string; input_digest: string; start_id: string },
  right: { campaign_id: string; input_digest: string; start_id: string },
): boolean {
  return (
    left.campaign_id === right.campaign_id &&
    left.input_digest === right.input_digest &&
    left.start_id === right.start_id
  );
}
export function currentProcessIdentity(): ProcessIdentity {
  const birth = realProcessIdentityProbe.startTimeMs(process.pid);
  if (birth === null) throw new Error('cannot establish current process birth');
  let boot: string;
  if (process.platform === 'linux')
    boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  else if (process.platform === 'darwin') {
    const result = spawnSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (result.status !== 0) throw new Error('cannot establish boot identity');
    boot = result.stdout.trim();
  } else throw new Error('unsupported process boot identity platform');
  if (!boot) throw new Error('empty boot identity');
  return { pid: process.pid, birth: String(birth), boot_id: boot };
}
function pathFor(options: OwnershipPaths): string {
  return `${defaultLiveSpendLockPath(options.lockPath ? { requestedLockPath: options.lockPath } : {})}.claim.json`;
}
function optionalDocument(path: string): string | null {
  if (!lstatSync(path, { throwIfNoEntry: false })) return null;
  return readPinnedNoFollowFile(
    dirname(path),
    [basename(path)],
    'host ownership',
    true,
  );
}
function requireHostLease(options: OwnershipPaths): void {
  const holder = readLiveSpendHolder(
    defaultLiveSpendLockPath(
      options.lockPath ? { requestedLockPath: options.lockPath } : {},
    ),
  );
  if (
    !holder ||
    holder.pid !== process.pid ||
    holder.birth_ts_ms !== realProcessIdentityProbe.startTimeMs(process.pid)
  )
    throw new Error('host claim mutation requires current host lease');
}
export function readHostClaim(
  options: OwnershipPaths = {},
): HostCampaignClaim | null {
  const body = optionalDocument(pathFor(options));
  return body === null ? null : HostCampaignClaimSchema.parse(JSON.parse(body));
}
export function publishHostClaim(
  input: HostCampaignClaim,
  options: OwnershipPaths = {},
): void {
  const claim = HostCampaignClaimSchema.parse(input);
  requireHostLease(options);
  const projection = readProjection(claim.campaign_dir);
  const { campaign_dir: _dir, ...start } = claim;
  if (
    !same(projection.start, start) ||
    !same(claim.launcher, currentProcessIdentity()) ||
    projection.ended
  )
    throw new Error(
      'host claim does not match committed live start and launcher',
    );
  if (!verifyBallast(claim.campaign_dir, DEFAULT_BALLAST_BYTES))
    throw new Error(
      'host claim requires physically allocated emergency reserve',
    );
  createDurableMarker(pathFor(options), `${jcsCanonicalize(claim)}\n`);
}
export function assertHostClaimAuthority(
  lockPath: string,
  authority?: LiveSpendAuthority,
): void {
  const claim = readHostClaim({ lockPath });
  if (!claim) {
    if (authority)
      throw new Error('host authority has no matching durable claim');
    return;
  }
  if (!authority)
    throw new Error(
      `unresolved host claim for ${claim.campaign_id}; cancel before admitting another spender`,
    );
  const projection = readProjection(claim.campaign_dir);
  const { campaign_dir: _dir, ...start } = claim;
  if (!same(projection.start, start))
    throw new Error('host claim start differs from journal');
  if (authority.kind === 'controller') {
    const { kind: _kind, process: caller, ...bound } = authority;
    if (
      !same(bound, claim) ||
      !same(caller, currentProcessIdentity()) ||
      !same(projection.controller, caller) ||
      projection.ended ||
      optionalDocument(join(claim.campaign_dir, 'cancel-intent.json')) !== null
    )
      throw new Error(
        'controller authority does not match live persisted controller',
      );
  } else {
    const intent = CancelIntentSchema.parse(authority.intent);
    const durable = readCancelIntent(claim.campaign_dir);
    if (!identityMatches(intent, claim) || !same(intent, durable))
      throw new Error(
        'cancellation authority differs from durable cancel intent',
      );
  }
}
export function publishCancelIntent(
  campaignDir: string,
  input: CancelIntent,
  fsOps?: JournalFsOps,
): void {
  const intent = CancelIntentSchema.parse(input);
  const projection = readProjection(campaignDir);
  if (!projection.start || !identityMatches(intent, projection.start))
    throw new Error('cancel intent does not match committed start');
  const path = join(campaignDir, 'cancel-intent.json');
  const existing = optionalDocument(path);
  if (existing !== null) {
    if (!same(JSON.parse(existing), intent))
      throw new Error('cancel intent already exists with different bytes');
    fsyncDir(campaignDir, fsOps);
    return;
  }
  createDurableMarker(path, `${jcsCanonicalize(intent)}\n`, fsOps);
}
export function readCancelIntent(campaignDir: string): CancelIntent | null {
  const body = optionalDocument(join(campaignDir, 'cancel-intent.json'));
  return body === null ? null : CancelIntentSchema.parse(JSON.parse(body));
}
export function clearHostClaim(
  input: TerminationReceipt,
  options: OwnershipPaths = {},
): void {
  const receipt = TerminationReceiptSchema.parse(input);
  requireHostLease(options);
  const claim = readHostClaim(options);
  if (!claim || !identityMatches(receipt, claim))
    throw new Error('termination receipt does not match durable host claim');
  const committed = readCommittedTransitions(claim.campaign_dir).find(
    (entry) => entry.transition.transition_id === receipt.transition_id,
  );
  if (
    !committed ||
    committed.transition_digest !== receipt.transition_digest ||
    committed.transition.type !== 'termination_verified' ||
    !same(committed.transition.payload.stopped, receipt.stopped)
  )
    throw new Error(
      'termination receipt is not the durable journal transition',
    );
  const projection = readProjection(claim.campaign_dir);
  if (
    !projection.termination ||
    projection.termination.start_id !== claim.start_id ||
    !same(projection.termination, committed.transition.payload)
  )
    throw new Error(
      'termination receipt does not close the complete campaign inventory',
    );
  for (const ref of projection.termination.process_evidence) {
    const body = readPinnedNoFollowFile(
      claim.campaign_dir,
      ref.path.split('/'),
      'termination process evidence',
      true,
    );
    if (body === null) throw new Error('termination evidence missing');
    if (Buffer.byteLength(body) !== ref.bytes || sha256Hex(body) !== ref.sha256)
      throw new Error(
        'termination process evidence bytes differ from committed reference',
      );
  }
  // All mutators hold the same host lease; reclamation never touches this file.
  unlinkSync(pathFor(options));
  fsyncDir(dirname(pathFor(options)));
}

export const StorageInterruptionSchema = ExperimentIdentitySchema.extend({
  start_id: IdSchema,
  at: TimestampSchema,
  stopped: z.array(VerifiedStoppedSchema),
  unresolved_attempt_ids: z.array(IdSchema),
}).strict();
export type StorageInterruption = z.infer<typeof StorageInterruptionSchema>;
/** Called only after stop attempts. Evidence records uncertainty; it never releases ownership. */
export function persistStorageInterruption(
  campaignDir: string,
  input: StorageInterruption,
  fsOps?: JournalFsOps,
): { kind: 'durable'; path: string } | { kind: 'unresolved'; reason: string } {
  try {
    const evidence = StorageInterruptionSchema.parse(input);
    const projection = readProjection(campaignDir);
    if (!projection.start || !identityMatches(evidence, projection.start))
      throw new Error('storage interruption start mismatch');
    const inventory = [
      ...evidence.stopped.map((item) => item.execution_attempt_id),
      ...evidence.unresolved_attempt_ids,
    ];
    if (
      new Set(inventory).size !== inventory.length ||
      inventory.length !== projection.attempts.size ||
      inventory.some((id) => !projection.attempts.has(id))
    )
      throw new Error(
        'storage interruption requires complete stopped or unresolved inventory',
      );
    const path = join(campaignDir, 'storage-interruption.json');
    const existing = optionalDocument(path);
    if (existing !== null) {
      if (!same(JSON.parse(existing), evidence))
        throw new Error('different emergency evidence already published');
      fsyncDir(campaignDir, fsOps);
      return { kind: 'durable', path };
    }
    releaseBallast(campaignDir, fsOps);
    createDurableMarker(path, `${jcsCanonicalize(evidence)}\n`, fsOps);
    return { kind: 'durable', path };
  } catch (error) {
    return {
      kind: 'unresolved',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
