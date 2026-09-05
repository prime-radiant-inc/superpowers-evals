import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadFrozenCampaign } from '../campaign/campaign-document.ts';
import {
  type CampaignLifecycleArgs,
  type CampaignStatus,
  lifecycleLockPath,
  observeCampaignStatus,
  publishLauncherRelease,
} from '../campaign/cancellation.ts';
import {
  ExecutionJournalWriter,
  readProjection,
} from '../campaign/execution-journal.ts';
import { DEFAULT_BALLAST_BYTES, verifyBallast } from '../campaign/journal.ts';
import {
  acquireLiveSpendLock,
  type LiveSpendLock,
  realProcessIdentityProbe,
} from '../campaign/locks.ts';
import {
  assertHostClaimAuthority,
  currentProcessIdentity,
  publishHostClaim,
  readCancelIntent,
  readHostClaim,
} from '../campaign/ownership.ts';
import { resolveCampaignResultsRoot } from '../campaign/results-root.ts';
import { jcsCanonicalize } from '../contracts/campaign/digest.ts';
import type {
  ExecutionStart,
  HostCampaignClaim,
  ProcessIdentity,
} from '../contracts/campaign/execution.ts';
import type { Experiment } from '../contracts/campaign/experiment.ts';
import { RealClock } from '../scheduler/clock.ts';
import { loadStateConfig } from './config.ts';
import { acquireLock, type LockHandle } from './locks.ts';
import { detachedWorkerEnv } from './process.ts';

export { CAMPAIGN_IMAGE_REF, imageDigestOf } from './campaign-image.ts';

/** Internal build-time target. The public helper never accepts arbitrary module paths. */
export interface CampaignControllerTarget {
  module: string;
  exportName: string;
}
export interface CampaignControllerContext extends CampaignLifecycleArgs {
  experiment: Experiment;
  resultsRoot: string;
  start: ExecutionStart;
  claim: HostCampaignClaim;
  processIdentity: ProcessIdentity;
  runLock: LockHandle;
  liveSpend: LiveSpendLock;
  writer: ExecutionJournalWriter;
  assertAdmission(): void;
}
export type LaunchBoundary =
  | 'started'
  | 'claim_published'
  | 'controller_bound'
  | 'leases_released'
  | 'launcher_released'
  | 'gate_released';
export interface StartCampaignOnceDeps {
  target: CampaignControllerTarget;
  /** Persistence/pipe fault cuts, before the next effect. Not an authorization override. */
  onBoundary?: (boundary: LaunchBoundary) => void | Promise<void>;
}
function validateControllerTarget(target: CampaignControllerTarget): void {
  if (
    !isAbsolute(target.module) ||
    realpathSync(target.module) !== target.module ||
    !lstatSync(target.module).isFile() ||
    !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(target.exportName)
  )
    throw new Error('invalid local controller target');
}
function assertOpenStart(
  args: CampaignLifecycleArgs,
  writer: ExecutionJournalWriter,
  lease: LiveSpendLock,
): void {
  writer.assertCurrentOwner();
  lease.heartbeat();
  if (readCancelIntent(args.campaignDir))
    throw new Error('campaign cancellation requested');
  const p = writer.readProjection();
  if (!p.start || p.ended) throw new Error('campaign start is not open');
}
export async function startCampaignOnce(
  args: CampaignLifecycleArgs,
  deps: StartCampaignOnceDeps,
): Promise<{
  kind: 'launched' | 'already_running' | 'refused';
  status: CampaignStatus;
  reason?: string;
}> {
  let run: LockHandle | undefined,
    lease: LiveSpendLock | undefined,
    writer: ExecutionJournalWriter | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let released = false;
  try {
    validateControllerTarget(deps.target);
    const existing = observeCampaignStatus(args);
    if (existing.state === 'running')
      return { kind: 'already_running', status: existing };
    if (existing.state !== 'registered')
      return {
        kind: 'refused',
        status: existing,
        reason: 'start authorization unavailable',
      };
    const experiment = loadFrozenCampaign(args.campaignDir);
    const lockPath = lifecycleLockPath(args);
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
    });
    writer = ExecutionJournalWriter.elect({
      campaignDir: args.campaignDir,
      experiment,
      clock: new RealClock(),
      identity: realProcessIdentityProbe,
    });
    if (!verifyBallast(args.campaignDir, DEFAULT_BALLAST_BYTES))
      throw new Error('physically allocated emergency reserve required');
    const start: ExecutionStart = {
      campaign_id: experiment.campaign_id,
      input_digest: experiment.input_digest,
      start_id: randomUUID(),
      launcher: currentProcessIdentity(),
      claimed_at: new Date().toISOString(),
    };
    writer.commitTransition({
      type: 'started',
      transition_id: randomUUID(),
      at: start.claimed_at,
      payload: start,
    });
    await deps.onBoundary?.('started');
    const claim = { ...start, campaign_dir: args.campaignDir };
    publishHostClaim(claim, { lockPath });
    await deps.onBoundary?.('claim_published');
    const bootstrap = {
      configPath: args.loaded.configPath,
      jobId: args.jobId,
      campaignDir: args.campaignDir,
      startId: start.start_id,
      target: deps.target,
    };
    const gateModule = new URL('./process.ts', import.meta.url).href;
    const controllerModule = import.meta.url;
    const script = `const {waitForControllerGate}=await import(${JSON.stringify(gateModule)}); await waitForControllerGate(process.stdin,${JSON.stringify(start.start_id)}); const {runGatedCampaignController}=await import(${JSON.stringify(controllerModule)}); await runGatedCampaignController(${JSON.stringify(bootstrap)});`;
    child = spawn(process.execPath, ['--eval', script], {
      cwd: args.loaded.config.evals.path,
      detached: true,
      env: detachedWorkerEnv(args.loaded, args.jobId),
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    let pipeFailure: Error | undefined;
    child.on('error', (error) => {
      pipeFailure = error;
    });
    const gate = child.stdin;
    if (!gate) throw new Error('controller has no gate pipe');
    gate.on('error', (error) => {
      pipeFailure = error;
    });
    const pid = child.pid;
    if (!pid || pid <= 1) throw new Error('controller spawn has no safe PID');
    const birth = realProcessIdentityProbe.startTimeMs(pid);
    if (birth === null)
      throw new Error('controller birth cannot be established');
    const controller = {
      pid,
      birth: String(birth),
      boot_id: start.launcher.boot_id,
    };
    writer.commitTransition({
      type: 'controller_bound',
      transition_id: randomUUID(),
      at: new Date().toISOString(),
      payload: { start_id: start.start_id, controller },
    });
    await deps.onBoundary?.('controller_bound');
    run.assertCurrentOwner();
    assertOpenStart(args, writer, lease);
    if (pipeFailure) throw pipeFailure;
    writer.release();
    writer = undefined;
    lease.release();
    lease = undefined;
    run.release();
    run = undefined;
    await deps.onBoundary?.('leases_released');
    // This path can never bind, acquire admission leases, or spawn another child again.
    publishLauncherRelease(args, claim, controller);
    await deps.onBoundary?.('launcher_released');
    await new Promise<void>((resolve, reject) =>
      gate.end(`${start.start_id}\n`, (error?: Error | null) =>
        error ? reject(error) : resolve(),
      ),
    );
    if (pipeFailure) throw pipeFailure;
    released = true;
    child.unref();
    await deps.onBoundary?.('gate_released');
    return { kind: 'launched', status: observeCampaignStatus(args) };
  } catch (error) {
    return {
      kind: 'refused',
      status: observeCampaignStatus(args),
      reason:
        error instanceof Error ? error.message : 'campaign launch refused',
    };
  } finally {
    if (child && !released) {
      child.stdin?.destroy();
      child.unref();
    }
    writer?.release();
    lease?.release();
    run?.release();
  }
}
/** Called only by the pipe bootstrap. Authority is reacquired, never transferred. */
export async function runGatedCampaignController(input: {
  configPath: string;
  jobId: string;
  campaignDir: string;
  startId: string;
  target: CampaignControllerTarget;
}): Promise<void> {
  const loaded = loadStateConfig(input.configPath);
  const args = { loaded, jobId: input.jobId, campaignDir: input.campaignDir };
  const lockPath = lifecycleLockPath(args);
  const experiment = loadFrozenCampaign(args.campaignDir);
  const claim = readHostClaim({ lockPath });
  const me = currentProcessIdentity();
  const p = readProjection(args.campaignDir);
  if (
    !p.start ||
    !claim ||
    claim.start_id !== input.startId ||
    claim.campaign_dir !== args.campaignDir ||
    jcsCanonicalize(p.controller) !== jcsCanonicalize(me)
  )
    throw new Error('controller is not the bound child');
  let run: LockHandle | undefined,
    lease: LiveSpendLock | undefined,
    writer: ExecutionJournalWriter | undefined;
  try {
    run = acquireLock({
      loaded,
      name: 'run.lock',
      jobId: input.jobId,
      command: 'campaign-run',
    });
    const authority = { ...claim, kind: 'controller' as const, process: me };
    lease = acquireLiveSpendLock({
      lockPath,
      clock: new RealClock(),
      identity: realProcessIdentityProbe,
      authority,
    });
    writer = ExecutionJournalWriter.elect({
      campaignDir: args.campaignDir,
      experiment,
      clock: new RealClock(),
      identity: realProcessIdentityProbe,
    });
    const currentWriter = writer,
      currentLease = lease,
      currentRun = run;
    const assertAdmission = () => {
      currentRun.assertCurrentOwner();
      assertOpenStart(args, currentWriter, currentLease);
      assertHostClaimAuthority(lockPath, authority);
    };
    assertAdmission();
    validateControllerTarget(input.target);
    const module = await import(pathToFileURL(input.target.module).href);
    assertAdmission();
    const controller = module[input.target.exportName];
    if (typeof controller !== 'function')
      throw new Error('controller target is not a function');
    const context: CampaignControllerContext = {
      ...args,
      experiment,
      resultsRoot: resolveCampaignResultsRoot(
        loaded.config.container.results_root,
      ),
      start: p.start,
      claim,
      processIdentity: me,
      runLock: run,
      liveSpend: lease,
      writer,
      assertAdmission,
    };
    await controller(context);
    // An unsettled return loses this session permanently; it never elects a replacement.
  } finally {
    writer?.release();
    lease?.release();
    run?.release();
  }
}
