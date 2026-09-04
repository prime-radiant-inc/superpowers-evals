import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readPinnedNoFollowFile } from '../appliance/credential-scope.ts';
import {
  acquireLock,
  type LockHandle,
  reclaimStoppedRunLock,
} from '../appliance/locks.ts';
import type { LoadedApplianceStateConfig } from '../appliance/types.ts';
import { jcsCanonicalize, sha256Hex } from '../contracts/campaign/digest.ts';
import {
  type ArtifactRef,
  type AttemptRuntime,
  type BoundExecution,
  HostCampaignClaimSchema,
  type ProcessIdentity,
  ProcessIdentitySchema,
  type VerifiedStopped,
} from '../contracts/campaign/execution.ts';
import { RealClock } from '../scheduler/clock.ts';
import {
  type AttemptPublishFsOps,
  publishExecution,
} from './attempt-publish.ts';
import { loadFrozenCampaign } from './campaign-document.ts';
import {
  ExecutionJournalWriter,
  readCommittedTransitions,
  readProjection,
} from './execution-journal.ts';
import type { CampaignProjection } from './execution-state.ts';
import { createDurableMarker, fsyncDir, JOURNAL_LEASE_DIR } from './journal.ts';
import {
  acquireLiveSpendLock,
  defaultLiveSpendLockPath,
  type LiveSpendLock,
  readLiveSpendHolder,
  realProcessIdentityProbe,
} from './locks.ts';
import {
  clearHostClaim,
  currentProcessIdentity,
  persistStorageInterruption,
  publishCancelIntent,
  readCancelIntent,
  readHostClaim,
} from './ownership.ts';
import { resolveCampaignResultsRoot } from './results-root.ts';

export interface CampaignLifecycleArgs {
  loaded: LoadedApplianceStateConfig;
  jobId: string;
  campaignDir: string;
}
export interface CampaignProcessControl {
  observe(identity: ProcessIdentity): 'live' | 'dead' | 'unknown';
  stop(identity: ProcessIdentity): Promise<boolean>;
}
export const campaignProcesses: CampaignProcessControl = {
  observe(identity) {
    if (identity.boot_id !== currentProcessIdentity().boot_id) return 'dead';
    const alive = realProcessIdentityProbe.exists(identity.pid);
    if (alive === 'esrch') return 'dead';
    if (alive === 'unknown') return 'unknown';
    const birth = realProcessIdentityProbe.startTimeMs(identity.pid);
    return birth === null
      ? 'unknown'
      : String(birth) === identity.birth
        ? 'live'
        : 'dead';
  },
  async stop(identity) {
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      const observed = this.observe(identity);
      if (observed === 'dead') return true;
      if (observed !== 'live' || identity.pid === process.pid) return false;
      try {
        process.kill(identity.pid, signal);
      } catch {
        return this.observe(identity) === 'dead';
      }
      for (let i = 0; i < 20; i++) {
        await Bun.sleep(50);
        if (this.observe(identity) === 'dead') return true;
      }
    }
    return false;
  },
};
export function lifecycleLockPath(args: CampaignLifecycleArgs): string {
  if (!args.loaded.config.live_spend_lock)
    throw new Error('campaign helper requires configured live-spend lock');
  return defaultLiveSpendLockPath({
    requestedLockPath: args.loaded.config.live_spend_lock,
  });
}
const same = (a: unknown, b: unknown) =>
  jcsCanonicalize(a) === jcsCanonicalize(b);
const ReleasedLauncherSchema = z
  .object({ claim: HostCampaignClaimSchema, controller: ProcessIdentitySchema })
  .strict();
export function publishLauncherRelease(
  args: CampaignLifecycleArgs,
  claim: z.infer<typeof HostCampaignClaimSchema>,
  controller: ProcessIdentity,
): void {
  const { p, claim: durable, lockPath } = readLifecycle(args);
  if (
    !same(claim, durable) ||
    !same(claim.launcher, currentProcessIdentity()) ||
    !same(p.controller, controller) ||
    p.ended ||
    readCancelIntent(args.campaignDir)
  )
    throw new Error('launcher release authority mismatch');
  if (
    lstatSync(join(args.loaded.paths.locks, 'run.lock'), {
      throwIfNoEntry: false,
    }) ||
    lstatSync(join(args.campaignDir, JOURNAL_LEASE_DIR), {
      throwIfNoEntry: false,
    }) ||
    readLiveSpendHolder(lockPath)
  )
    throw new Error('launcher admission leases remain held');
  createDurableMarker(
    join(args.campaignDir, 'launcher-released.json'),
    `${jcsCanonicalize({ claim, controller })}\n`,
  );
}
function launcherReleased(
  args: CampaignLifecycleArgs,
  p: CampaignProjection,
): boolean {
  const path = join(args.campaignDir, 'launcher-released.json');
  if (!lstatSync(path, { throwIfNoEntry: false })) return false;
  const body = readPinnedNoFollowFile(
    args.campaignDir,
    ['launcher-released.json'],
    'launcher release',
    true,
  );
  if (body === null) throw new Error('missing launcher release');
  const receipt = ReleasedLauncherSchema.parse(JSON.parse(body));
  const { campaign_dir, ...start } = receipt.claim;
  if (
    campaign_dir !== args.campaignDir ||
    !same(start, p.start) ||
    !same(receipt.controller, p.controller)
  )
    throw new Error('launcher release identity mismatch');
  return true;
}
export interface CampaignStatus {
  state:
    | 'registered'
    | 'running'
    | 'stopping'
    | 'interrupted'
    | 'completed'
    | 'cancelled'
    | 'unresolved';
  next_action: 'run' | 'status' | 'cancel' | 'register' | 'report';
  progress?: { prepared: number; stopped: number };
}
function readLifecycle(args: CampaignLifecycleArgs) {
  const p = readProjection(args.campaignDir);
  const lockPath = lifecycleLockPath(args);
  let claim = readHostClaim({ lockPath });
  if (claim) {
    const { campaign_dir, ...start } = claim;
    if (campaign_dir !== args.campaignDir || !same(start, p.start)) {
      if (p.termination && claim.campaign_id !== p.experiment.campaign_id)
        claim = null;
      else throw new Error('foreign host claim');
    }
  }
  const intent = readCancelIntent(args.campaignDir);
  if (
    intent &&
    (!p.start ||
      intent.start_id !== p.start.start_id ||
      intent.campaign_id !== p.experiment.campaign_id ||
      intent.input_digest !== p.experiment.input_digest)
  )
    throw new Error('cancel intent identity mismatch');
  if (!claim && !p.termination && (p.controller || p.attempts.size))
    throw new Error('execution has no host claim');
  launcherReleased(args, p);
  return { p, claim, intent, lockPath };
}
/** Read-only projection; active measurements deliberately expose no behavioral verdict. */
export function observeCampaignStatus(
  args: CampaignLifecycleArgs,
  processes: Pick<CampaignProcessControl, 'observe'> = campaignProcesses,
): CampaignStatus {
  try {
    const { p, claim, intent, lockPath } = readLifecycle(args);
    if (p.ended)
      return {
        state: p.ended.outcome,
        next_action:
          !p.termination || claim
            ? 'cancel'
            : p.ended.outcome === 'interrupted'
              ? 'register'
              : 'report',
      };
    if (intent) return { state: 'stopping', next_action: 'cancel' };
    if (!p.start) return { state: 'registered', next_action: 'run' };
    const controllerState = p.controller
      ? processes.observe(p.controller)
      : null;
    if (controllerState === 'unknown')
      return { state: 'unresolved', next_action: 'cancel' };
    const holder = readLiveSpendHolder(lockPath);
    if (
      p.controller &&
      controllerState === 'live' &&
      claim &&
      (!holder ||
        [p.start.launcher, p.controller].some(
          (identity) =>
            holder.pid === identity.pid &&
            String(holder.birth_ts_ms) === identity.birth,
        ))
    )
      return {
        state: 'running',
        next_action: 'status',
        progress: {
          prepared: p.attempts.size,
          stopped: [...p.attempts.values()].filter((a) => a.stopped).length,
        },
      };
    return { state: 'interrupted', next_action: 'cancel' };
  } catch {
    return { state: 'unresolved', next_action: 'cancel' };
  }
}
function evidence(
  args: CampaignLifecycleArgs,
  name: string,
  value: unknown,
): ArtifactRef {
  const body = `${jcsCanonicalize(value)}\n`;
  const path = join(args.campaignDir, name);
  if (lstatSync(path, { throwIfNoEntry: false })) {
    if (
      readPinnedNoFollowFile(
        args.campaignDir,
        [name],
        'control evidence',
        true,
      ) !== body
    )
      throw new Error('control evidence differs from existing publication');
    fsyncDir(args.campaignDir);
  } else createDurableMarker(path, body);
  return {
    path: name,
    sha256: sha256Hex(body),
    bytes: Buffer.byteLength(body),
  };
}
function diskFull(error: unknown): boolean {
  for (
    let depth = 0;
    depth < 8 && typeof error === 'object' && error !== null;
    depth++
  ) {
    if ('code' in error && error.code === 'ENOSPC') return true;
    error = 'cause' in error ? error.cause : undefined;
  }
  return false;
}
export interface CancelCampaignDeps {
  publicationFs?: AttemptPublishFsOps;
  processes?: CampaignProcessControl;
  /** Reconstructed runtimes must preserve uncertainty for bound starts without receipts. */
  runtime: (
    startSettlement: (
      bound: BoundExecution,
    ) => 'never-issued' | 'settled' | 'uncertain',
  ) => AttemptRuntime;
}
export async function cancelCampaign(
  args: CampaignLifecycleArgs,
  deps: CancelCampaignDeps,
): Promise<{
  kind: 'terminated' | 'unresolved';
  status: CampaignStatus;
  reason?: string;
}> {
  const processes = deps.processes ?? campaignProcesses;
  let run: LockHandle | undefined,
    lease: LiveSpendLock | undefined,
    writer: ExecutionJournalWriter | undefined;
  try {
    let { p, claim, intent, lockPath } = readLifecycle(args);
    if (!p.start) throw new Error('campaign has no consumed start');
    if (p.termination && !claim)
      return {
        kind: 'terminated',
        status: observeCampaignStatus(args, processes),
      };
    if (!claim && (p.controller || p.attempts.size))
      throw new Error('started execution has lost its host claim');
    if (!intent) {
      const loss =
        processes.observe(p.controller ?? p.start.launcher) === 'dead';
      intent = {
        campaign_id: p.experiment.campaign_id,
        input_digest: p.experiment.input_digest,
        start_id: p.start.start_id,
        requested_at: new Date().toISOString(),
        controller_loss_established: loss,
        reason: 'operator cancellation',
      };
      publishCancelIntent(args.campaignDir, intent);
    }
    // The intent fences the pipe before any stop or attempt to become journal writer.
    const settleController = async (controller: ProcessIdentity | null) => {
      if (
        controller &&
        processes.observe(controller) !== 'dead' &&
        !(await processes.stop(controller))
      )
        throw new Error('controller death unresolved');
      if (controller && processes.observe(controller) !== 'dead')
        throw new Error('controller death unverified');
    };
    await settleController(p.controller);
    if (
      !launcherReleased(args, p) &&
      processes.observe(p.start.launcher) !== 'dead' &&
      !(await processes.stop(p.start.launcher))
    )
      throw new Error('launcher death unresolved');
    if (
      !launcherReleased(args, p) &&
      processes.observe(p.start.launcher) !== 'dead'
    )
      throw new Error('launcher death unverified');
    ({ p, claim, intent, lockPath } = readLifecycle(args));
    if (p.termination && !claim)
      return {
        kind: 'terminated',
        status: observeCampaignStatus(args, processes),
      };
    // The launcher can bind a child while stopping. Its settled role makes
    // this final binding stable; a closed gate alone is not proof of death.
    const verifiedController = p.controller;
    await settleController(verifiedController);
    ({ p, claim, intent, lockPath } = readLifecycle(args));
    if (p.termination && !claim)
      return {
        kind: 'terminated',
        status: observeCampaignStatus(args, processes),
      };
    if (!same(p.controller, verifiedController))
      throw new Error('controller binding changed after launcher settlement');
    if (!p.start || !intent)
      throw new Error('cancellation identity disappeared');
    reclaimStoppedRunLock(args.loaded, [
      p.start.launcher,
      ...(p.controller ? [p.controller] : []),
    ]);
    run = acquireLock({
      loaded: args.loaded,
      name: 'run.lock',
      jobId: args.jobId,
      command: 'campaign-run',
    });
    lease = acquireLiveSpendLock({
      lockPath,
      clock: new RealClock(),
      identity: realProcessIdentityProbe,
      ...(claim
        ? { authority: { kind: 'cancellation' as const, intent } }
        : {}),
    });
    writer = ExecutionJournalWriter.elect({
      campaignDir: args.campaignDir,
      experiment: loadFrozenCampaign(args.campaignDir),
      clock: new RealClock(),
      identity: realProcessIdentityProbe,
    });
    p = writer.readProjection();
    if (!same(p.controller, verifiedController))
      throw new Error('writer controller differs from verified death identity');
    const resultsRoot = resolveCampaignResultsRoot(
      args.loaded.config.container.results_root,
    );
    const persistFailure = (
      stopped: VerifiedStopped[],
      unresolved: string[],
    ) => {
      if (!p.start) return;
      persistStorageInterruption(args.campaignDir, {
        campaign_id: p.experiment.campaign_id,
        input_digest: p.experiment.input_digest,
        start_id: p.start.start_id,
        at: new Date().toISOString(),
        stopped,
        unresolved_attempt_ids: unresolved,
      });
    };
    const runtime = deps.runtime((bound) => {
      const a = p.attempts.get(bound.intent.identity.execution_attempt_id);
      if (!a || !same(a.intent, bound.intent))
        throw new Error('unknown frozen attempt');
      return a.bound_at === null
        ? 'never-issued'
        : a.started_at !== null
          ? 'settled'
          : 'uncertain';
    });
    if (!p.termination) {
      const stoppedInventory = new Map<string, VerifiedStopped>();
      const unresolved: string[] = [];
      let storageFailed = false;
      for (const a of p.attempts.values()) {
        const id = a.intent.identity.execution_attempt_id;
        if (a.stopped) {
          stoppedInventory.set(id, a.stopped);
          continue;
        }
        try {
          lease.heartbeat();
          const observed = await runtime.inspectOwned({ intent: a.intent });
          let stopped: VerifiedStopped;
          if (observed.kind === 'unresolved') throw new Error(observed.reason);
          if (
            observed.kind === 'absent' &&
            (a.bound_at === null || a.started_at !== null)
          ) {
            stopped = {
              execution_attempt_id: a.intent.identity.execution_attempt_id,
              container_id: a.container_id,
              proof: 'verified_absent',
              observed_at: new Date().toISOString(),
            };
          } else {
            if (
              observed.kind !== 'absent' &&
              (observed.runtime_spec_digest !== a.intent.runtime_spec_digest ||
                (a.container_id !== null &&
                  a.container_id !== observed.container_id))
            )
              throw new Error('runtime identity mismatch');
            const container_id =
              observed.kind === 'absent'
                ? a.container_id
                : observed.container_id;
            if (container_id === null)
              throw new Error('unknown runtime identity');
            const result = await runtime.stop(
              { intent: a.intent, container_id },
              5,
            );
            if (result.kind !== 'dead') throw new Error(result.reason);
            stopped = result.stopped;
          }
          stoppedInventory.set(id, stopped);
          if (storageFailed) continue;
          let artifacts: ArtifactRef[] = [];
          if (
            stopped.container_id !== null &&
            stopped.proof === 'inspected_stopped'
          ) {
            try {
              artifacts = publishExecution({
                bound: { intent: a.intent, container_id: stopped.container_id },
                stopped,
                resultsRoot,
                ...(deps.publicationFs ? { fsOps: deps.publicationFs } : {}),
              }).artifacts;
            } catch (error) {
              if (diskFull(error)) {
                storageFailed = true;
                continue;
              }
              /* Missing or invalid immutable evidence stays explicitly missing. */
            }
          }
          try {
            writer.commitTransition({
              type: 'accounting_observed',
              transition_id: randomUUID(),
              at: new Date().toISOString(),
              payload: {
                execution_attempt_id: a.intent.identity.execution_attempt_id,
                stopped,
                artifacts,
                evidence_missing: artifacts.length
                  ? null
                  : 'cancelled without published accounting',
              },
            });
          } catch {
            storageFailed = true;
          }
        } catch {
          unresolved.push(id);
        }
      }
      if (storageFailed) {
        if (!p.start) throw new Error('missing consumed start');
        persistStorageInterruption(args.campaignDir, {
          campaign_id: p.experiment.campaign_id,
          input_digest: p.experiment.input_digest,
          start_id: p.start.start_id,
          at: new Date().toISOString(),
          stopped: [...stoppedInventory.values()],
          unresolved_attempt_ids: unresolved,
        });
        throw new Error(
          'accounting publication failed; host ownership retained',
        );
      }
      if (unresolved.length)
        throw new Error(
          `runtime termination unresolved for ${unresolved.length} attempts`,
        );
      try {
        p = writer.readProjection();
        if (!p.ended) {
          const ordinary = !intent.controller_loss_established;
          const cancelRef = ordinary
            ? evidence(args, 'cancel-evidence.json', intent)
            : null;
          writer.commitTransition({
            type: 'ended',
            transition_id: randomUUID(),
            at: new Date().toISOString(),
            payload: {
              outcome: ordinary ? 'cancelled' : 'interrupted',
              reason: ordinary
                ? 'operator cancellation'
                : 'controller session lost',
              cancel_intent: cancelRef,
            },
          });
        }
        if (!p.start) throw new Error('missing start');
        const ref = evidence(
          args,
          `termination-processes-${randomUUID()}.json`,
          {
            start: p.start,
            controller: p.controller,
            launcher_role_released: launcherReleased(args, p),
            controller_dead: true,
            observed_at: new Date().toISOString(),
          },
        );
        writer.commitTransition({
          type: 'termination_verified',
          transition_id: randomUUID(),
          at: new Date().toISOString(),
          payload: {
            start_id: p.start.start_id,
            stopped: [...writer.readProjection().attempts.values()].map((a) => {
              if (!a.stopped) throw Error('unverified worker');
              return a.stopped;
            }),
            process_evidence: [ref],
          },
        });
      } catch (error) {
        persistFailure([...stoppedInventory.values()], unresolved);
        throw error;
      }
    }
    if (claim) {
      const t = readCommittedTransitions(args.campaignDir).find(
        (c) => c.transition.type === 'termination_verified',
      );
      if (t?.transition.type !== 'termination_verified')
        throw new Error('missing termination receipt');
      clearHostClaim(
        {
          campaign_id: claim.campaign_id,
          input_digest: claim.input_digest,
          start_id: claim.start_id,
          transition_id: t.transition.transition_id,
          transition_digest: t.transition_digest,
          stopped: t.transition.payload.stopped,
        },
        { lockPath },
      );
    }
    return {
      kind: 'terminated',
      status: observeCampaignStatus(args, processes),
    };
  } catch (error) {
    return {
      kind: 'unresolved',
      status: observeCampaignStatus(args, processes),
      reason:
        error instanceof Error ? error.message : 'cancellation unresolved',
    };
  } finally {
    writer?.release();
    lease?.release();
    run?.release();
  }
}

/** An ended current controller settles its own role while retaining all held fences. */
export function completeControllerTermination(
  args: CampaignLifecycleArgs & {
    runLock: LockHandle;
    liveSpend: LiveSpendLock;
    writer: ExecutionJournalWriter;
    assertNoUnsettledStarts(): void;
  },
): void {
  args.runLock.assertCurrentOwner();
  args.liveSpend.heartbeat();
  args.writer.assertCurrentOwner();
  args.assertNoUnsettledStarts();
  const p = args.writer.readProjection();
  const { claim, lockPath } = readLifecycle(args);
  const current = currentProcessIdentity();
  if (
    !claim ||
    !p.start ||
    !p.ended ||
    !same(p.controller, current) ||
    !launcherReleased(args, p)
  )
    throw new Error('current controller termination authority unresolved');
  if (!p.termination) {
    const stopped = [...p.attempts.values()].map((a) => {
      if (!a.stopped)
        throw new Error('unverified worker prevents controller termination');
      return a.stopped;
    });
    const ref = evidence(args, `termination-processes-${randomUUID()}.json`, {
      start: p.start,
      controller: p.controller,
      launcher_role_released: true,
      authorized_terminator: current,
      observed_at: new Date().toISOString(),
    });
    args.writer.commitTransition({
      type: 'termination_verified',
      transition_id: randomUUID(),
      at: new Date().toISOString(),
      payload: { start_id: p.start.start_id, stopped, process_evidence: [ref] },
    });
  }
  const committed = readCommittedTransitions(args.campaignDir).find(
    (t) => t.transition.type === 'termination_verified',
  );
  if (committed?.transition.type !== 'termination_verified')
    throw new Error('missing termination transition');
  clearHostClaim(
    {
      campaign_id: claim.campaign_id,
      input_digest: claim.input_digest,
      start_id: claim.start_id,
      transition_id: committed.transition.transition_id,
      transition_digest: committed.transition_digest,
      stopped: committed.transition.payload.stopped,
    },
    { lockPath },
  );
}
