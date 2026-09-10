import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { defaultCommandRunner } from '../../../src/agents/command-runner.ts';
import {
  campaignCommands,
  resolveCampaignDirectory,
} from '../../../src/appliance/campaign.ts';
import {
  CAMPAIGN_IMAGE_REF,
  imageDigestOf,
} from '../../../src/appliance/campaign-image.ts';
import { observeCampaignStatus } from '../../../src/campaign/cancellation.ts';
import { readCommittedPrefix } from '../../../src/campaign/execution-journal.ts';
import { realProcessIdentityProbe } from '../../../src/campaign/locks.ts';
import { jcsCanonicalize } from '../../../src/contracts/campaign/digest.ts';
import { getEnv } from '../../../src/env.ts';
import { stopActiveRole } from '../../../src/runner/gauntlet-role.ts';
import {
  acquireQualificationLease,
  retainedRoleEnv,
} from '../../../src/runner/retained-role.ts';
import type { Clock } from '../../../src/scheduler/clock.ts';
import { RealClock } from '../../../src/scheduler/clock.ts';
import {
  type CampaignObservation,
  campaignDecision,
  type ReleaseEnvelope,
} from './envelope.ts';
import { type ObservationReceipt, observationChild } from './observe.ts';
import { hash, marker, prepareOperation, readPrivate } from './operation.ts';
import { prepareQualification, runQualificationSet } from './qualify.ts';

export type MonitorEffects = {
  clock: Clock;
  signal: AbortSignal;
  releaseQualificationLease(): void;
  launch(): Promise<void>;
  observe(signal: AbortSignal): Promise<CampaignObservation>;
  /** Own the cancellation child through settlement and verify termination; never bounded by the observation timer. */
  cancel(reason: string): Promise<CampaignObservation>;
  record(observation: CampaignObservation): void;
};
/** One finite campaign invocation, with an independent cutoff and one cancellation owner. */
export async function monitorCampaign(
  e: ReleaseEnvelope,
  campaignId: string,
  d: MonitorEffects,
): Promise<{ observation: CampaignObservation; reason: string | null }> {
  e = { ...e, campaigns: new Map(e.campaigns) };
  let cancellation: Promise<CampaignObservation> | null = null;
  let reason: string | null = null;
  let wakeCancel!: () => void;
  const cancelled = new Promise<void>((done) => {
    wakeCancel = done;
  });
  const cancel = (why: string) => {
    if (cancellation !== null) return;
    reason = why;
    cancellation = Promise.resolve().then(() => d.cancel(why));
    // Retain rejection until the owning monitor awaits settlement.
    void cancellation.catch(() => {});
    wakeCancel();
  };
  const abort = () => cancel('termination signal');
  const cutoff = d.clock.sleepUntilCancellable(
    (e.firstPaidAtMs + 21_540_000) / 1000,
  );
  void cutoff.expired.then((expired) => {
    if (expired) cancel('cutoff');
  });
  d.signal.addEventListener('abort', abort, { once: true });
  try {
    d.releaseQualificationLease();
    if (d.signal.aborted) throw new Error('cancelled before campaign launch');
    if (d.clock.now() * 1000 >= e.firstPaidAtMs + 21_540_000)
      throw new Error('cutoff before campaign launch');
    try {
      await d.launch();
    } catch {
      cancel('campaign launch unresolved');
    }
    while (cancellation === null) {
      const controller = new AbortController();
      const timeout = d.clock.sleepUntilCancellable(d.clock.now() + 10);
      try {
        const observed = await Promise.race([
          d.observe(controller.signal),
          cancelled.then(() => null),
          timeout.expired.then((expired) => {
            if (expired) cancel('observation timeout');
            return null;
          }),
        ]);
        if (observed !== null) {
          if (observed.campaignId !== campaignId)
            throw new Error('observation identity mismatch');
          d.record(observed);
          const decision = campaignDecision(e, d.clock.now() * 1000, observed);
          e = {
            ...e,
            campaigns: new Map(e.campaigns).set(
              campaignId,
              Math.max(e.campaigns.get(campaignId) ?? 0, observed.knownUsd),
            ),
          };
          if (observed.terminal && cancellation === null)
            return { observation: observed, reason: decision.reason };
          if (decision.action === 'cancel') cancel(decision.reason!);
        }
      } catch {
        cancel('observation failure');
      } finally {
        timeout.cancel();
        controller.abort();
      }
      if (cancellation !== null) break;
      const wait = d.clock.sleepUntilCancellable(d.clock.now() + 15);
      try {
        await Promise.race([wait.expired, cancelled]);
      } finally {
        wait.cancel();
      }
    }
    const observation = await cancellation!;
    if (observation.campaignId !== campaignId || !observation.terminal)
      throw new Error('campaign cancellation remains unresolved');
    d.record(observation);
    return {
      observation,
      reason:
        reason ?? campaignDecision(e, d.clock.now() * 1000, observation).reason,
    };
  } finally {
    cutoff.cancel();
    d.signal.removeEventListener('abort', abort);
  }
}

/** The exact ordinary helper child stays owned until exit, including a long cancellation. */
export async function campaignChild(
  helper: string,
  verb: 'run' | 'cancel',
  campaignId: string,
  out: string,
): Promise<void> {
  const log = openSync(join(out, `${verb}.log`), 'wx', 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const argv = ['campaign', verb, campaignId, '--json'];
      const child = spawn(helper, argv, {
        env: { PATH: getEnv('PATH') },
        stdio: ['ignore', log, log],
      });
      let failure: unknown;
      let identityKnown = false;
      child.once('error', (error) => {
        failure = error;
      });
      child.once('close', (code, signal) => {
        try {
          marker(join(out, `${verb}-settled.json`), { code, signal });
        } catch (error) {
          reject(error);
          return;
        }
        if (code === 0 && identityKnown && failure === undefined) resolve();
        else
          reject(failure ?? new Error(`ordinary campaign ${verb} unresolved`));
      });
      const birth =
        child.pid === undefined
          ? null
          : realProcessIdentityProbe.startTimeMs(child.pid);
      identityKnown = birth !== null;
      try {
        marker(join(out, `${verb}-launch.json`), {
          helper,
          argv,
          pid: child.pid ?? null,
          birth,
        });
      } catch (error) {
        failure = error;
      } // Do not release a living canceller on receipt failure.
    });
  } finally {
    closeSync(log);
  }
}
async function main(): Promise<void> {
  const [mode, flag, manifestPath, selectorFlag, selector, ...extra] =
    process.argv.slice(2);
  if (
    flag !== '--manifest' ||
    !manifestPath ||
    extra.length ||
    !(
      (mode === 'qualify' &&
        selectorFlag === '--role' &&
        (selector === 'assessment' || selector === 'driver')) ||
      (mode === 'campaign' && selectorFlag === '--campaign-id' && selector)
    )
  )
    throw new Error(
      'usage: run.ts qualify --manifest <path> --role assessment|driver | campaign --manifest <path> --campaign-id <id>',
    );
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
    stopActiveRole('SIGTERM');
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  let operation: ReturnType<typeof prepareOperation> | undefined;
  let spend: ReturnType<typeof acquireQualificationLease> | undefined;
  let settled: {
    complete: boolean;
    fault: string | null;
    semanticMatch?: boolean;
  } = { complete: false, fault: 'operator failed before settlement' };
  try {
    operation = prepareOperation(manifestPath, stop);
    const op = operation,
      m = op.m;
    if (m.mode !== (mode === 'qualify' ? selector : 'campaign'))
      throw new Error('manifest operation mode mismatch');
    if (
      imageDigestOf(defaultCommandRunner, CAMPAIGN_IMAGE_REF) !==
      'sha256:01fb1cd08f1e31c82fccedbaadead09e6ff97bca1f5d66f2f0904728ad536e8c'
    )
      throw new Error('qualified image changed');
    if (mode === 'qualify') {
      const execute = await prepareQualification(
        m,
        retainedRoleEnv(
          op.loaded.config.credential_bundle.path,
          op.pricing.directory,
        ),
        () => controller.signal.aborted,
      );
      spend = acquireQualificationLease(op.loaded, stop);
      op.verify();
      if (controller.signal.aborted)
        throw new Error('ownership lost before first admission');
      op.bootstrap();
      const original = op.envelope();
      const result = await runQualificationSet({
        role: selector as 'assessment' | 'driver',
        outputRoot: m.outputRoot,
        firstPaidAtMs: original.firstPaidAtMs,
        now: Date.now,
        stopped: () => controller.signal.aborted,
        execute,
        validate() {
          op.verify();
          spend!.heartbeat();
          op.lease.heartbeat();
          const envelope = op.envelope();
          if (
            envelope.qualificationKnownUsd +
              [...envelope.campaigns.values()].reduce((a, b) => a + b, 0) >=
            150
          )
            throw new Error('observed release cost reached');
        },
      });
      settled = result;
      if (!result.complete || !result.semanticMatch) process.exitCode = 1;
    } else {
      const campaignId = selector!;
      const campaignDir = resolveCampaignDirectory(op.loaded, campaignId);
      const prefix = readCommittedPrefix(campaignDir);
      const experiment = prefix.projection.experiment;
      const { grader: declaredGrader, ...declaredSuite } = parseYaml(
        readPrivate(
          join(m.qRoot, 'suites/conversation_routine_use.yaml'),
        ).toString('utf8'),
      );
      if (
        jcsCanonicalize(experiment.suite) !== jcsCanonicalize(declaredSuite) ||
        jcsCanonicalize(experiment.grader) !== jcsCanonicalize(declaredGrader)
      )
        throw new Error('campaign is not the frozen release suite');
      for (const [arm, sha] of Object.entries(
        experiment.refs.superpowers_by_arm,
      )) {
        if (
          sha !==
          (arm.endsWith('_stock')
            ? null
            : 'b36e0829c6d0140e93cfef2ca599b1b07d4a7797')
        )
          throw new Error('campaign Superpowers identity changed');
      }

      if (
        experiment.campaign_id !== campaignId ||
        prefix.projection.start !== null ||
        experiment.refs.evals !== m.qSha ||
        experiment.refs.gauntlet !== m.gSha ||
        experiment.grader.model !== 'anthropic.claude-sonnet-5' ||
        experiment.grader.credential !== 'sonnet5_bedrock' ||
        experiment.suite.name !== 'conversation_routine_use' ||
        experiment.planned_slots.length !== 36 ||
        experiment.reserve_slots.length !== 0 ||
        experiment.suite.reserve !== 0 ||
        experiment.suite.attempt_bounds.max_attempts !== 1 ||
        experiment.runtime_limits.max_time_s !== 900 ||
        experiment.contention.global_run_cap !== 4 ||
        experiment.cells.some((cell) => cell.n !== 2)
      )
        throw new Error('campaign differs from the fixed fresh allocation');
      const before = observeCampaignStatus({
        loaded: op.loaded,
        campaignDir,
        jobId: m.operationId,
      });
      if (before.state !== 'registered' || before.next_action !== 'run')
        throw new Error('campaign cannot start once');
      const envelope = op.envelope();
      if (
        envelope.qualificationKnownUsd +
          [...envelope.campaigns.values()].reduce((a, b) => a + b, 0) >=
        150
      )
        throw new Error('observed release cost reached');
      const observations = join(m.outputRoot, 'observations');
      mkdirSync(observations, { mode: 0o700 });
      let counter = 0,
        previous: { path: string; sha256: string } | undefined;
      const read = (signal: AbortSignal) =>
        observationChild(
          [
            join(import.meta.dir, 'observe.ts'),
            m.config.path,
            campaignId,
            ...(previous ? [previous.path, previous.sha256] : []),
          ],
          signal,
        );
      const record = (value: CampaignObservation) => {
        const path = join(
          observations,
          `${String(++counter).padStart(6, '0')}.json`,
        );
        marker(path, value);
        previous = { path, sha256: hash(`${JSON.stringify(value)}\n`) };
      };
      const helper = join(op.loaded.config.root, 'bin/evals-appliance');
      const result = await monitorCampaign(envelope, campaignId, {
        clock: new RealClock(),
        signal: controller.signal,
        releaseQualificationLease() {
          spend?.release();
          spend = undefined;
        },
        launch: () => campaignChild(helper, 'run', campaignId, m.outputRoot),
        observe: read,
        record,
        async cancel() {
          let cancelFailed = false;
          try {
            await campaignChild(helper, 'cancel', campaignId, m.outputRoot);
          } catch {
            cancelFailed = true;
          }
          // The original canceller has settled; existing cancellation is the only termination-only reconciliation primitive.
          if (cancelFailed)
            await campaignCommands({
              loaded: op.loaded,
              runner: defaultCommandRunner,
            }).cancel({ campaignSelector: campaignId, json: true });
          const timeout = new AbortController();
          const timer = setTimeout(() => timeout.abort(), 10_000);
          try {
            return await read(timeout.signal);
          } finally {
            clearTimeout(timer);
          }
        },
      });
      settled = {
        complete: result.observation.terminal && result.reason === null,
        fault: result.reason ?? result.observation.settledFault,
      };
      if (!settled.complete || settled.fault !== null) process.exitCode = 1;
    }
  } finally {
    try {
      spend?.release();
    } finally {
      if (operation) {
        try {
          marker(join(operation.m.outputRoot, 'settled.json'), settled);
        } finally {
          operation.lease.release();
        }
      }
    }
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}
if (import.meta.main)
  main().catch(() => {
    process.stderr.write(
      'finite routine operation failed; inspect private receipts\n',
    );
    process.exitCode = 1;
  });
