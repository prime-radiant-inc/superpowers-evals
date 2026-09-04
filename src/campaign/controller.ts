import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultCommandRunner } from '../agents/command-runner.ts';
import {
  CAMPAIGN_IMAGE_REF,
  imageDigestOf,
} from '../appliance/campaign-image.ts';
import type { CampaignControllerContext } from '../appliance/campaign-run.ts';
import { readPinnedNoFollowFile } from '../appliance/credential-scope.ts';
import { jcsCanonicalize, sha256Hex } from '../contracts/campaign/digest.ts';
import type {
  ArtifactRef,
  AttemptIntent,
  AttemptRuntime,
  BlockActivation,
  BoundExecution,
  CampaignTransition,
  PreparedExecution,
  ReplacementCause,
  ValidityCause,
  VerifiedStopped,
} from '../contracts/campaign/execution.ts';
import { ReplacementCauseSchema } from '../contracts/campaign/execution.ts';
import type { PlannedSlot } from '../contracts/campaign/experiment.ts';
import { poolKey } from '../contracts/campaign/pool.ts';
import type { Credential } from '../contracts/credential.ts';
import { FinalVerdictSchema } from '../contracts/verdict.ts';
import { loadCredentialsFile } from '../credentials/index.ts';
import { type Clock, RealClock } from '../scheduler/clock.ts';
import { blockPrioritySeconds, compareAdmissionOrder } from './admission.ts';
import {
  AttemptPublicationStorageError,
  publishExecution,
  readPublishedArtifact,
} from './attempt-publish.ts';
import { completeControllerTermination } from './cancellation.ts';
import { classifyFailure } from './classifier.ts';
import {
  ContainerAttemptRuntime,
  prepareContainerExecution,
} from './container-spawner.ts';
import {
  type BlockInterval,
  ContentionSampler,
  evaluateContention,
  parseSidecar,
} from './contention.ts';
import type { CampaignProjection } from './execution-state.ts';
import { type HostStatsProbe, hostStatsProbeForCli } from './host-stats.ts';
import type { SnapshotHandle } from './instrument-snapshot.ts';
import { createDurableMarker } from './journal.ts';
import { resolveKeyForSpawn } from './key-select.ts';
import {
  persistStorageInterruption,
  publishCancelIntent,
  readCancelIntent,
} from './ownership.ts';
import { assertCredentialAuthority } from './registration.ts';
import { assertFeasible, blockDemandVector } from './resource-policy.ts';
import {
  gauntletEventStreamTextsFromText,
  gauntletResultText,
  senseEvidence,
  sensorAttributionRank,
  trajectoryExposureFromText,
} from './sensors.ts';
import { GLOBAL_POOL } from './simulate.ts';
import {
  reconstructCampaignSnapshot,
  verifyCampaignSnapshot,
} from './snapshot.ts';
export type SessionContext = Pick<
  CampaignControllerContext,
  'campaignDir' | 'experiment' | 'writer' | 'resultsRoot' | 'assertAdmission'
>;
type Runtime = AttemptRuntime & {
  assertNoUnsettledStarts(): void;
};
export interface RuntimeAuthority {
  assertCreateAuthorized(prepared: PreparedExecution): void;
  assertStartAuthorized(bound: BoundExecution): void;
}
export interface SessionDependencies {
  signal?: AbortSignal;
  clock: Clock;
  registry(): Readonly<Record<string, Credential>>;
  verifySnapshot(): void;
  prepare(args: {
    slot: PlannedSlot;
    blockId: string;
    attemptNumber: number;
    subjectKeyEnv?: string;
    graderKeyEnv?: string;
  }): PreparedExecution;
  runtime(authority: RuntimeAuthority): Runtime;
  publish: typeof publishExecution;
  probe: HostStatsProbe;
  cancelIntent(): {
    ref: ArtifactRef;
    controllerLoss: boolean;
  } | null;
  finish(runtime: Runtime): void;
  storageFailure(stopped: VerifiedStopped[], unresolved: string[]): void;
}
export interface SessionResult {
  outcome: 'completed' | 'cancelled' | 'interrupted';
  reason: string;
}
function productionDependencies(
  context: CampaignControllerContext,
): SessionDependencies {
  const runner = defaultCommandRunner;
  let snapshot: SnapshotHandle | undefined;
  let imageDigest: string | undefined;
  const frozenSnapshot = () => {
    context.assertAdmission();
    snapshot ??= reconstructCampaignSnapshot({
      campaignDir: context.campaignDir,
      refs: context.experiment.refs,
      runner,
    });
    context.assertAdmission();
    return snapshot;
  };
  const registry = () =>
    loadCredentialsFile(
      join(context.loaded.config.evals.path, 'credentials.yaml'),
    ).credentials;
  return {
    clock: new RealClock(),
    registry,
    verifySnapshot: () => verifyCampaignSnapshot(frozenSnapshot(), runner),
    prepare(args) {
      const snapshot = frozenSnapshot();
      imageDigest ??= imageDigestOf(runner, CAMPAIGN_IMAGE_REF);
      context.assertAdmission();
      const arm = required(
        context.experiment.execution_surface.find(
          (a) => a.name === args.slot.arm,
        ),
      );
      const sha = context.experiment.refs.superpowers_by_arm[args.slot.arm];
      const tree =
        sha === null
          ? null
          : snapshot.superpowersWorktrees.find((t) => t.sha === sha)?.root;
      if (tree === undefined) throw Error('frozen superpowers tree missing');
      const attemptId = `${args.slot.sample_id}:a${args.attemptNumber}`;
      const uid = userInfo().uid;
      const gid = userInfo().gid;
      return prepareContainerExecution({
        campaignDir: context.campaignDir,
        attemptId,
        agent: arm.agent,
        credentialName: arm.credential,
        evalsRoot: snapshot.evalsRoot,
        bundleDir: context.loaded.config.credential_bundle.path,
        uid,
        gid,
        grader: context.experiment.grader,
        ...(args.subjectKeyEnv ? { subjectKeyEnv: args.subjectKeyEnv } : {}),
        ...(args.graderKeyEnv ? { graderKeyEnv: args.graderKeyEnv } : {}),
        identity: {
          campaign_id: context.experiment.campaign_id,
          comparison_id: args.slot.comparison_id,
          block_id: args.blockId,
          sample_id: args.slot.sample_id,
          execution_attempt_id: attemptId,
        },
        inputDigest: context.experiment.input_digest,
        startId: context.start.start_id,
        primaryBlockId: args.slot.primary_block_id,
        attemptNumber: args.attemptNumber,
        imageDigest,
        evalsSha: context.experiment.refs.evals,
        maxTimeSeconds: context.experiment.runtime_limits.max_time_s,
        gauntletRoot: snapshot.gauntletRoot,
        binRoot: dirname(snapshot.gauntletBin),
        superpowersTree: tree,
        scenarioDir: join(snapshot.evalsRoot, 'scenarios', args.slot.scenario),
      });
    },
    runtime(authority) {
      return new ContainerAttemptRuntime({
        runner,
        ...authority,
        startSettlement(bound) {
          const a = context.writer
            .readProjection()
            .attempts.get(bound.intent.identity.execution_attempt_id);
          return a?.started_at
            ? 'settled'
            : a?.container_id
              ? 'uncertain'
              : 'never-issued';
        },
      });
    },
    publish: publishExecution,
    probe: hostStatsProbeForCli(context.campaignDir),
    cancelIntent() {
      const intent = readCancelIntent(context.campaignDir);
      if (!intent) return null;
      if (
        intent.start_id !== context.start.start_id ||
        intent.campaign_id !== context.experiment.campaign_id ||
        intent.input_digest !== context.experiment.input_digest
      )
        throw Error('foreign cancellation authority');
      const body = required(
        readPinnedNoFollowFile(
          context.campaignDir,
          ['cancel-intent.json'],
          'cancel intent',
          true,
        ),
      );
      return {
        ref: {
          path: 'cancel-intent.json',
          bytes: Buffer.byteLength(body),
          sha256: sha256Hex(body),
        },
        controllerLoss: intent.controller_loss_established,
      };
    },
    finish: (runtime) =>
      completeControllerTermination({
        ...context,
        assertNoUnsettledStarts: () => runtime.assertNoUnsettledStarts(),
      }),
    storageFailure: (stopped, unresolved) => {
      persistStorageInterruption(context.campaignDir, {
        campaign_id: context.experiment.campaign_id,
        input_digest: context.experiment.input_digest,
        start_id: context.start.start_id,
        at: new Date().toISOString(),
        stopped,
        unresolved_attempt_ids: unresolved,
      });
    },
  };
}
/** One held controller session. Every durable decision reads the writer's fold;
 * callback delivery only queues facts and never mutates execution state. */
export async function runCampaignDispatch(
  context: CampaignControllerContext,
): Promise<SessionResult>;
export async function runCampaignDispatch(
  context: SessionContext,
  deps: SessionDependencies,
): Promise<SessionResult>;
export async function runCampaignDispatch(
  context: SessionContext,
  supplied?: SessionDependencies,
): Promise<SessionResult> {
  const deps =
    supplied ?? productionDependencies(context as CampaignControllerContext);
  const { experiment, writer } = context;
  const { clock } = deps;
  const now = () => new Date(clock.now() * 1000).toISOString();
  const projection = () => writer.readProjection();
  let halted: string | null = null;
  let storageFailed = false;
  let breach = false;
  let cancelled: ReturnType<SessionDependencies['cancelIntent']> = null;
  let wake: (() => void) | undefined;
  const events: (
    | {
        stopped: VerifiedStopped;
      }
    | {
        failed: string;
        attemptId: string;
      }
  )[] = [];
  const signal = () => wake?.();
  const keyGrants = new Map<string, { credential: string; env: string }[]>();
  const latches = new Map<string, number>();
  const policy = new Map(experiment.pool_policy.map((p) => [p.pool_id, p]));
  let registry: Readonly<Record<string, Credential>> = {};
  const slots = new Map(experiment.planned_slots.map((s) => [s.sample_id, s]));
  const credentialFor = (slot: PlannedSlot) =>
    required(experiment.execution_surface.find((a) => a.name === slot.arm))
      .credential;
  const subjectPool = (id: string) => {
    const name = credentialFor(required(slots.get(id)));
    return poolKey(required(registry[name]), name);
  };
  let graderPool: string;
  const demand = (ids: string[]) =>
    blockDemandVector({
      block: { sample_ids: ids },
      sampleArmCredentialPool: subjectPool,
      graderPool,
    });
  const commit = (
    type: CampaignTransition['type'],
    payload: CampaignTransition['payload'],
  ) => {
    try {
      writer.commitTransition({
        type,
        payload,
        at: now(),
        transition_id: randomUUID(),
      } as CampaignTransition);
    } catch (error) {
      storageFailed = true;
      halted = 'journal publication failed';
      throw error;
    }
  };
  const guard = () => {
    if (halted) throw Error(halted);
    cancelled = deps.cancelIntent();
    if (cancelled || deps.signal?.aborted) throw Error('operator cancellation');
    context.assertAdmission();
    writer.assertCurrentOwner();
    assertCredentialAuthority(deps.registry(), experiment);
  };
  const assertIntent = (prepared: PreparedExecution) => {
    guard();
    const a = projection().attempts.get(
      prepared.intent.identity.execution_attempt_id,
    );
    if (
      !a ||
      a.stopped ||
      jcsCanonicalize(a.intent) !== jcsCanonicalize(prepared.intent)
    )
      throw Error('exact committed intent required');
    return a;
  };
  const runtime = deps.runtime({
    assertCreateAuthorized(prepared) {
      const a = assertIntent(prepared);
      if (a.container_id) throw Error('attempt already bound');
    },
    assertStartAuthorized(bound) {
      const a = assertIntent(bound);
      if (a.container_id !== bound.container_id || a.started_at)
        throw Error('exact unstarted committed binding required');
    },
  });
  const controlEvidence = (
    blockId: string,
    verdict: string,
    details: unknown,
  ): ArtifactRef => {
    const body = `${jcsCanonicalize({ campaign_id: experiment.campaign_id, input_digest: experiment.input_digest, start_id: required(projection().start).start_id, block_id: blockId, at: now(), verdict, details })}\n`;
    const path = `validity-${randomUUID()}.json`;
    try {
      createDurableMarker(join(context.campaignDir, path), body);
    } catch (error) {
      storageFailed = true;
      throw error;
    }
    return { path, bytes: Buffer.byteLength(body), sha256: sha256Hex(body) };
  };
  const stoppedInventory = new Map<string, VerifiedStopped>();
  const publish = (intent: AttemptIntent, stopped: VerifiedStopped) => {
    if (stopped.container_id === null)
      return {
        artifacts: [] as ArtifactRef[],
        missing: 'no published execution',
      };
    try {
      return {
        artifacts: deps.publish({
          bound: { intent, container_id: stopped.container_id },
          stopped,
          resultsRoot: context.resultsRoot,
        }).artifacts,
        missing: null,
      };
    } catch (error) {
      if (isStorageFailure(error)) {
        storageFailed = true;
        throw error;
      }
      return {
        artifacts: [] as ArtifactRef[],
        missing: 'invalid or missing published evidence',
      };
    }
  };
  const observe = (
    stopped: VerifiedStopped,
    accountingOnly: boolean,
    unknownCause = false,
  ) => {
    const id = stopped.execution_attempt_id;
    const a = required(projection().attempts.get(id));
    stoppedInventory.set(id, stopped);
    if (accountingOnly ? a.accounting : a.observation) return;
    const evidence = publish(a.intent, stopped);
    if (accountingOnly) {
      commit('accounting_observed', {
        execution_attempt_id: id,
        stopped,
        artifacts: evidence.artifacts,
        evidence_missing: evidence.missing,
      });
      return;
    }
    guard();
    let outcome: 'pass' | 'fail' | 'indeterminate' = 'indeterminate';
    let stage: Parameters<typeof classifyFailure>[0]['stage'];
    let missing = evidence.missing;
    let strongest: ReturnType<typeof senseEvidence> = null;
    try {
      const ref = evidence.artifacts.find((r) =>
        r.path.endsWith('/verdict.json'),
      );
      if (!ref) throw Error('verdict absent');
      const verdict = FinalVerdictSchema.parse(
        JSON.parse(readPublishedArtifact(context.resultsRoot, ref)),
      );
      if (
        jcsCanonicalize(verdict.campaign) !== jcsCanonicalize(a.intent.identity)
      )
        throw Error('verdict identity mismatch');
      outcome = verdict.final;
      stage = verdict.error?.stage;
    } catch (error) {
      if (isStorageFailure(error)) {
        storageFailed = true;
        throw error;
      }
      outcome = 'indeterminate';
      stage = undefined;
      missing = 'invalid or missing authenticated verdict';
    }
    for (const ref of evidence.artifacts) {
      try {
        const role = ref.path.includes('/gauntlet-agent/')
          ? ('grader' as const)
          : ('subject' as const);
        const texts =
          ref.path.endsWith('/run.jsonl') && role === 'grader'
            ? gauntletEventStreamTextsFromText(
                readPublishedArtifact(context.resultsRoot, ref),
              )
            : ref.path.endsWith('/result.json') && role === 'grader'
              ? [
                  {
                    source: 'gauntlet_result' as const,
                    text: gauntletResultText(
                      readPublishedArtifact(context.resultsRoot, ref),
                    ),
                  },
                ]
              : [];
        const name =
          role === 'grader'
            ? experiment.grader.credential
            : credentialFor(required(slots.get(a.intent.identity.sample_id)));
        const cred = required(registry[name]);
        for (const text of texts) {
          const found = senseEvidence({
            ...text,
            role,
            credential: {
              api: cred.api,
              ...(cred.base_url ? { base_url: cred.base_url } : {}),
            },
          });
          if (
            found &&
            (!strongest ||
              sensorAttributionRank(found) < sensorAttributionRank(strongest))
          )
            strongest = found;
        }
      } catch (error) {
        if (isStorageFailure(error)) {
          storageFailed = true;
          throw error;
        }
        outcome = 'indeterminate';
        missing = 'invalid authenticated sensor evidence';
      }
    }
    if (unknownCause) {
      outcome = 'indeterminate';
      stage = undefined;
      strongest = null;
    }
    const classification = classifyFailure({
      outcome,
      ...(stage ? { stage } : {}),
      exitClass: 'clean',
      role: strongest?.role ?? 'subject',
      sensorEvidence: strongest?.evidence ?? 'none',
    });
    if (strongest?.evidence === '429-match') {
      const pool =
        strongest.role === 'grader'
          ? graderPool
          : subjectPool(a.intent.identity.sample_id);
      latches.set(
        pool,
        Math.max(
          latches.get(pool) ?? 0,
          clock.now() + strongest.cooldownMs / 1000,
        ),
      );
    }
    commit('attempt_observed', {
      observation: {
        execution_attempt_id: id,
        stopped,
        outcome,
        failure_class:
          classification.class === 'shortfall'
            ? 'evidence'
            : classification.class,
        cause: classification.cause ?? null,
        artifacts: evidence.artifacts,
        evidence_missing: missing,
        validity: 'valid',
      },
      excluded_block: null,
    });
    if (
      classification.cause === 'grader_billing_exhausted' ||
      classification.cause === 'grader_misconfigured'
    )
      halted = classification.cause;
  };
  const stopAttempt = async (
    id: string,
    accountingOnly: boolean,
    unknownCause = false,
  ) => {
    const a = required(projection().attempts.get(id));
    if (a.stopped) return;
    const owned = await runtime.inspectOwned({ intent: a.intent });
    let stopped: VerifiedStopped;
    if (owned.kind === 'absent') {
      runtime.assertNoUnsettledStarts();
      stopped = {
        execution_attempt_id: id,
        container_id: a.container_id,
        proof: a.container_id ? 'verified_absent' : 'never_created',
        observed_at: now(),
      };
    } else {
      const containerId =
        owned.kind === 'unresolved' ? a.container_id : owned.container_id;
      if (!containerId) throw Error('runtime ownership unresolved');
      const result = await runtime.stop(
        { intent: a.intent, container_id: containerId },
        5,
      );
      if (result.kind !== 'dead') throw Error('runtime death unresolved');
      stopped = result.stopped;
    }
    observe(stopped, accountingOnly, unknownCause);
  };
  const replacementCause = (
    p: CampaignProjection,
    blockId: string,
  ): ReplacementCause | null => {
    const b = required(p.blocks.get(blockId));
    const excluded = ReplacementCauseSchema.safeParse(b.excluded);
    if (excluded.success) return excluded.data;
    for (const intent of b.activation.attempts) {
      const obs = p.attempts.get(
        intent.identity.execution_attempt_id,
      )?.observation;
      const cause = ReplacementCauseSchema.safeParse(obs?.cause);
      if (obs?.failure_class === 'instrument' && cause.success)
        return cause.data;
    }
    return null;
  };
  const audit = () => {
    guard();
    deps.verifySnapshot();
    guard();
    const p = projection();
    const sidecar = parseSidecar(context.campaignDir);
    const intervals: BlockInterval[] = [...p.blocks.values()].map((b) => {
      const attempts = b.activation.attempts.map((a) =>
        required(p.attempts.get(a.identity.execution_attempt_id)),
      );
      return {
        block_id: b.activation.block_id,
        startTsMs: Math.min(...attempts.map((a) => Date.parse(a.prepared_at))),
        endTsMs: attempts.every((a) => a.stopped)
          ? Math.max(
              ...attempts.map((a) =>
                Date.parse(required(a.stopped).observed_at),
              ),
            )
          : null,
      };
    });
    const results = evaluateContention({
      ...sidecar,
      thresholds: experiment.contention.thresholds,
      sustainK: experiment.contention.sustain_k,
      cadenceMs: experiment.contention.cadence_ms,
      coverageN: experiment.contention.coverage_n,
      cpuCores: experiment.contention.host_fingerprint.cpu_cores,
      campaignOpenedTsMs: Date.parse(required(p.start).claimed_at),
      lastTerminalTsMs: clock.now() * 1000,
      blocks: intervals,
    });
    for (const b of p.blocks.values()) {
      const id = b.activation.block_id;
      const attempts = b.activation.attempts.map((a) =>
        required(p.attempts.get(a.identity.execution_attempt_id)),
      );
      if (b.invalidation || !attempts.every((a) => a.observation)) continue;
      let cause: ValidityCause | null =
        results.get(id) === 'invalid'
          ? 'contention'
          : results.get(id) !== 'clean'
            ? 'missing_telemetry'
            : null;
      const exposures = attempts.map((a) => {
        const ref = required(a.observation).artifacts.find((r) =>
          r.path.endsWith('/trajectory.json'),
        );
        try {
          return ref
            ? trajectoryExposureFromText(
                readPublishedArtifact(context.resultsRoot, ref),
              )
            : null;
        } catch (error) {
          if (isStorageFailure(error)) {
            storageFailed = true;
            throw error;
          }
          return null;
        }
      });
      if (
        !cause &&
        exposures.some(
          (timestamp, index) =>
            timestamp === null ||
            timestamp < Date.parse(required(attempts[index]).prepared_at) ||
            timestamp >
              Date.parse(
                required(required(attempts[index]).stopped).observed_at,
              ),
        )
      )
        cause = 'exposure';
      if (
        !cause &&
        Math.max(...(exposures as number[])) -
          Math.min(...(exposures as number[])) >
          experiment.suite.max_exposure_skew * 1000
      )
        cause = 'skew';
      if (cause) {
        const ref = controlEvidence(id, cause, {
          exposures,
          contention: results.get(id),
          intervals,
          telemetry: sidecar,
        });
        commit('block_invalidated', {
          block_id: id,
          reason: cause,
          evidence_refs: [ref],
        });
      } else if (
        !b.excluded &&
        !b.validity_receipt &&
        sidecar.lines.some(
          (line) =>
            !('missing' in line) &&
            line.ts_ms >=
              Math.max(
                ...attempts.map((a) =>
                  Date.parse(required(a.stopped).observed_at),
                ),
              ),
        )
      ) {
        const ref = controlEvidence(id, 'valid', {
          exposures,
          contention: 'clean',
          intervals,
          telemetry: sidecar,
        });
        commit('block_validated', { block_id: id, evidence_refs: [ref] });
      }
    }
  };
  const sampler = new ContentionSampler({
    campaignDir: context.campaignDir,
    probe: deps.probe,
    clock,
    thresholds: experiment.contention.thresholds,
    sustainK: experiment.contention.sustain_k,
    cadenceMs: experiment.contention.cadence_ms,
    cpuCores: experiment.contention.host_fingerprint.cpu_cores,
    onBreachEntry() {
      breach = true;
      signal();
    },
    onBreachExit() {
      breach = false;
      signal();
    },
    onSampleError(error, source) {
      if (source === 'storage' || isStorageFailure(error)) {
        storageFailed = true;
        halted = 'telemetry storage failed';
      }
      signal();
    },
  });
  let samplerLoop: Promise<void> | undefined;
  const sleep = async (seconds: number) => {
    const timer = clock.sleepUntilCancellable(seconds);
    try {
      await Promise.race([
        timer.expired,
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
      ]);
    } finally {
      timer.cancel();
      wake = undefined;
    }
  };
  const nextStart = (pool: string) => {
    let last = 0;
    for (const a of projection().attempts.values())
      if (
        a.started_at &&
        (subjectPool(a.intent.identity.sample_id) === pool ||
          graderPool === pool)
      )
        last = Math.max(last, Date.parse(a.started_at) / 1000);
    return Math.max(
      latches.get(pool) ?? 0,
      last + (policy.get(pool)?.launch_spacing_seconds ?? 0),
    );
  };
  const drainEvents = async () => {
    while (events.length) {
      const event = required(events.shift());
      if ('failed' in event) {
        await stopAttempt(event.attemptId, false, true);
        halted = 'runtime monitor failure';
        break;
      }
      observe(event.stopped, false);
      if (halted) break;
      const a = required(
        projection().attempts.get(event.stopped.execution_attempt_id),
      );
      if (replacementCause(projection(), a.intent.identity.block_id)) {
        for (const sibling of required(
          projection().blocks.get(a.intent.identity.block_id),
        ).activation.attempts)
          await stopAttempt(sibling.identity.execution_attempt_id, false);
      }
    }
    guard();
  };
  const onSignal = () => {
    if (!supplied && !projection().ended) {
      try {
        if (!readCancelIntent(context.campaignDir))
          publishCancelIntent(context.campaignDir, {
            campaign_id: experiment.campaign_id,
            input_digest: experiment.input_digest,
            start_id: required(projection().start).start_id,
            requested_at: now(),
            controller_loss_established: false,
            reason: 'controller cancellation signal',
          });
      } catch {
        halted = 'cancellation intent publication failed';
        storageFailed = true;
      }
    }
    signal();
  };
  deps.signal?.addEventListener('abort', onSignal);
  if (!supplied) {
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
  }
  try {
    registry = deps.registry();
    graderPool = poolKey(
      required(registry[experiment.grader.credential]),
      experiment.grader.credential,
    );
    guard();
    if (projection().attempts.size)
      throw Error('controller session cannot reconstruct admission');
    for (const primary of new Set(
      experiment.planned_slots.map((s) => s.primary_block_id),
    ))
      assertFeasible(
        demand(
          experiment.planned_slots
            .filter((s) => s.primary_block_id === primary)
            .map((s) => s.sample_id),
        ),
        policy,
        experiment.contention.global_run_cap,
      );
    samplerLoop = sampler.start();
    for (;;) {
      guard();
      await drainEvents();
      guard();
      audit();
      guard();
      const p = projection();
      const primaryIds = [
        ...new Set(experiment.planned_slots.map((s) => s.primary_block_id)),
      ];
      const candidates: {
        primary: string;
        predecessor: string | null;
        reserve: string | null;
        reason: ReplacementCause | null;
      }[] = [];
      for (const primary of primaryIds) {
        const selected = p.selected_blocks.get(primary);
        if (!selected) {
          candidates.push({
            primary,
            predecessor: null,
            reserve: null,
            reason: null,
          });
          continue;
        }
        if (p.exhausted_blocks.has(primary)) continue;
        const b = required(p.blocks.get(selected));
        if (
          !b.activation.attempts.every(
            (a) =>
              required(p.attempts.get(a.identity.execution_attempt_id)).stopped,
          )
        )
          continue;
        const reason = replacementCause(p, selected);
        if (!reason) continue;
        const slot = required(
          experiment.planned_slots.find((s) => s.primary_block_id === primary),
        );
        const reserve = experiment.reserve_slots.find(
          (r) =>
            r.comparison_id === slot.comparison_id &&
            r.scenario === slot.scenario &&
            !p.consumed_reserves.has(r.reserve_id),
        );
        if (
          !reserve ||
          b.activation.attempts.some(
            (a) =>
              a.attempt_number >= experiment.suite.attempt_bounds.max_attempts,
          )
        )
          commit('block_exhausted', { primary_block_id: primary, reason });
        else
          candidates.push({
            primary,
            predecessor: selected,
            reserve: reserve.reserve_id,
            reason,
          });
      }
      const current = projection();
      if (
        primaryIds.every((id) => {
          const b = current.blocks.get(current.selected_blocks.get(id) ?? '');
          return (
            current.exhausted_blocks.has(id) ||
            (b?.validity_receipt &&
              !b.excluded &&
              !replacementCause(current, b.activation.block_id))
          );
        })
      ) {
        audit();
        guard();
        const final = projection();
        if (
          [...final.selected_blocks.values()].some(
            (id) =>
              required(final.blocks.get(id)).excluded &&
              !final.exhausted_blocks.has(
                required(final.blocks.get(id)).activation.primary_block_id,
              ),
          )
        )
          continue;
        commit('ended', {
          outcome: 'completed',
          reason: 'planned comparison resolved',
          cancel_intent: null,
        });
        // A final audit can still select a reserve. End admission durably
        // before closing its required telemetry producer.
        await sampler.stop();
        await samplerLoop;
        deps.finish(runtime);
        return { outcome: 'completed', reason: 'planned comparison resolved' };
      }
      const usage = demand(
        [...current.attempts.values()]
          .filter((a) => !a.stopped)
          .map((a) => a.intent.identity.sample_id),
      );
      candidates.sort((a, b) => {
        const priority = (primary: string) =>
          blockPrioritySeconds({
            block: {
              sample_ids: experiment.planned_slots
                .filter((s) => s.primary_block_id === primary)
                .map((s) => s.sample_id),
            },
            sampleEstimateSeconds: (id) => {
              const s = required(slots.get(id));
              return experiment.estimates?.[s.scenario]?.[s.arm]?.duration_s;
            },
            attemptDeadlineSeconds: experiment.runtime_limits.max_time_s,
          });
        return (
          priority(b.primary) - priority(a.primary) ||
          compareAdmissionOrder(
            { block_id: a.reserve ?? a.primary },
            { block_id: b.reserve ?? b.primary },
          )
        );
      });
      const candidate = breach
        ? undefined
        : candidates.find((c) =>
            [
              ...demand(
                experiment.planned_slots
                  .filter((s) => s.primary_block_id === c.primary)
                  .map((s) => s.sample_id),
              ),
            ].every(
              ([pool, amount]) =>
                (usage.get(pool) ?? 0) + amount <=
                  (pool === GLOBAL_POOL
                    ? experiment.contention.global_run_cap
                    : required(policy.get(pool)).max_concurrency) &&
                nextStart(pool) <= clock.now(),
            ),
          );
      if (!candidate) {
        await sleep(clock.now() + experiment.contention.cadence_ms / 1000);
        continue;
      }
      deps.verifySnapshot();
      guard();
      const activation: BlockActivation = {
        block_id: candidate.reserve ?? candidate.primary,
        primary_block_id: candidate.primary,
        reserve_id: candidate.reserve,
        predecessor_block_id: candidate.predecessor,
        attempts: [],
      };
      const keyLoads = new Map<string, Record<string, number>>();
      const loadsFor = (credential: string) => {
        let loads = keyLoads.get(credential);
        if (!loads) {
          loads = {};
          keyLoads.set(credential, loads);
        }
        return loads;
      };
      for (const [id, grants] of keyGrants)
        if (!projection().attempts.get(id)?.stopped)
          for (const { credential, env } of grants) {
            const loads = loadsFor(credential);
            loads[env] = (loads[env] ?? 0) + 1;
          }
      for (const slot of experiment.planned_slots.filter(
        (s) => s.primary_block_id === candidate.primary,
      )) {
        const previous = candidate.predecessor
          ? required(
              projection().blocks.get(candidate.predecessor),
            ).activation.attempts.find(
              (a) => a.identity.sample_id === slot.sample_id,
            )
          : undefined;
        const grant = (name: string) => {
          const selection = resolveKeyForSpawn({
            cred: required(registry[name]),
            credentialName: name,
            inFlight: loadsFor(name),
          });
          if (selection.kind === 'wait')
            throw Error('aggregate admission exceeded per-key capacity');
          if (selection.kind === 'native') return undefined;
          const env = selection.grant.envName;
          const loads = loadsFor(name);
          loads[env] = (loads[env] ?? 0) + 1;
          return env;
        };
        const subjectKeyEnv = grant(credentialFor(slot));
        const graderKeyEnv = grant(experiment.grader.credential);
        guard();
        const prepared = deps.prepare({
          slot,
          blockId: activation.block_id,
          attemptNumber: (previous?.attempt_number ?? 0) + 1,
          ...(subjectKeyEnv ? { subjectKeyEnv } : {}),
          ...(graderKeyEnv ? { graderKeyEnv } : {}),
        });
        guard();
        activation.attempts.push(prepared.intent);
        keyGrants.set(prepared.intent.identity.execution_attempt_id, [
          ...(subjectKeyEnv
            ? [{ credential: credentialFor(slot), env: subjectKeyEnv }]
            : []),
          ...(graderKeyEnv
            ? [{ credential: experiment.grader.credential, env: graderKeyEnv }]
            : []),
        ]);
      }
      commit(
        candidate.reason ? 'block_replaced' : 'block_activated',
        candidate.reason
          ? { activation, reason: candidate.reason }
          : activation,
      );
      for (const intent of activation.attempts) {
        await drainEvents();
        if (
          projection().attempts.get(intent.identity.execution_attempt_id)
            ?.stopped
        )
          continue;
        guard();
        const bound = await runtime.create({ intent });
        guard();
        commit('runtime_bound', {
          execution_attempt_id: intent.identity.execution_attempt_id,
          container_id: bound.container_id,
          runtime_spec_digest: intent.runtime_spec_digest,
        });
        while (
          Math.max(
            nextStart(subjectPool(intent.identity.sample_id)),
            nextStart(graderPool),
          ) > clock.now()
        ) {
          await sleep(
            Math.max(
              nextStart(subjectPool(intent.identity.sample_id)),
              nextStart(graderPool),
            ),
          );
          await drainEvents();
          if (
            projection().attempts.get(intent.identity.execution_attempt_id)
              ?.stopped
          )
            break;
          guard();
        }
        if (
          projection().attempts.get(intent.identity.execution_attempt_id)
            ?.stopped
        )
          continue;
        guard();
        const monitor = await runtime.start(bound);
        writer.assertCurrentOwner();
        const receiptAttempt = projection().attempts.get(
          intent.identity.execution_attempt_id,
        );
        if (
          !receiptAttempt ||
          receiptAttempt.container_id !== bound.container_id ||
          jcsCanonicalize(receiptAttempt.intent) !==
            jcsCanonicalize(bound.intent)
        )
          throw Error('successful start receipt binding differs');
        commit('runtime_started', {
          execution_attempt_id: intent.identity.execution_attempt_id,
          observed_at: monitor.startedAt,
          receipt: 'docker_start_succeeded',
        });
        guard();
        monitor.onStopped((stopped) => {
          events.push({ stopped });
          signal();
        });
        monitor.onMonitorFailure((failed) => {
          events.push({
            failed,
            attemptId: intent.identity.execution_attempt_id,
          });
          signal();
        });
      }
    }
  } catch (error) {
    halted ??=
      error instanceof Error ? error.message : 'controller interrupted';
    storageFailed ||= isStorageFailure(error);
    await sampler.stop();
    await samplerLoop;
    const unresolved: string[] = [];
    for (const a of projection().attempts.values()) {
      const id = a.intent.identity.execution_attempt_id;
      if (a.stopped) {
        stoppedInventory.set(id, a.stopped);
        continue;
      }
      try {
        await stopAttempt(id, true);
      } catch {
        unresolved.push(id);
      }
    }
    if (storageFailed)
      deps.storageFailure(
        [...stoppedInventory.values()],
        [...projection().attempts.keys()].filter(
          (id) => !stoppedInventory.has(id),
        ),
      );
    try {
      writer.assertCurrentOwner();
      cancelled ??= deps.cancelIntent();
      const outcome =
        cancelled && !cancelled.controllerLoss ? 'cancelled' : 'interrupted';
      const reason = outcome === 'cancelled' ? 'operator cancellation' : halted;
      if (!projection().ended)
        commit('ended', {
          outcome,
          reason,
          cancel_intent:
            outcome === 'cancelled' ? required(cancelled).ref : null,
        });
      if (!storageFailed && !unresolved.length) deps.finish(runtime);
    } catch (failure) {
      if (isStorageFailure(failure) || storageFailed)
        deps.storageFailure(
          [...stoppedInventory.values()],
          [...projection().attempts.keys()].filter(
            (id) => !stoppedInventory.has(id),
          ),
        );
    }
    const ended = projection().ended;
    return {
      outcome: ended?.outcome ?? 'interrupted',
      reason: ended?.reason ?? halted,
    };
  } finally {
    deps.signal?.removeEventListener('abort', onSignal);
    if (!supplied) {
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
    }
    await sampler.stop();
    await samplerLoop;
  }
}
function isStorageFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error instanceof AttemptPublicationStorageError ||
    /ENOSPC|SQLITE_FULL|SQLITE_IOERR|EIO/.test(error.message) ||
    ('cause' in error && isStorageFailure(error.cause))
  );
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw Error('frozen campaign inventory missing');
  return value;
}
