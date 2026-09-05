// Real controller, preparation, publication and termination; only the worker and clock are fake.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import type { CampaignControllerContext } from '../../../src/appliance/campaign-run.ts';
import { publishExecution } from '../../../src/campaign/attempt-publish.ts';
import { completeControllerTermination } from '../../../src/campaign/cancellation.ts';
import { prepareContainerExecution } from '../../../src/campaign/container-spawner.ts';
import {
  runCampaignDispatch,
  type SessionDependencies,
} from '../../../src/campaign/controller.ts';
import { sha256Hex } from '../../../src/contracts/campaign/digest.ts';
import type {
  BoundExecution,
  VerifiedStopped,
} from '../../../src/contracts/campaign/execution.ts';
import { loadCredentialsFile } from '../../../src/credentials/index.ts';
import { writeAttemptManifest } from '../../../src/runner/manifest.ts';
import { FakeClock } from '../../../src/scheduler/clock.ts';

async function execute(
  context: CampaignControllerContext,
  beforeFinish?: () => void,
) {
  const clock = new FakeClock(Date.now() / 1000);
  const { experiment, campaignDir } = context;
  const stopped = (b: BoundExecution): VerifiedStopped => ({
    execution_attempt_id: b.intent.identity.execution_attempt_id,
    container_id: b.container_id,
    proof: 'inspected_stopped',
    observed_at: new Date(clock.now() * 1000).toISOString(),
  });
  const deps: SessionDependencies = {
    hostCpu() {
      const cpu = cpus();
      return { cpu_model: cpu[0]!.model, cpu_cores: cpu.length };
    },
    clock,
    registry: () =>
      loadCredentialsFile(join(campaignDir, 'evals', 'credentials.yaml'))
        .credentials,
    verifySnapshot() {},
    prepare(args) {
      const arm = experiment.execution_surface.find(
        (a) => a.name === args.slot.arm,
      )!;
      const attemptId = `${args.slot.sample_id}:a${args.attemptNumber}`;
      return prepareContainerExecution({
        campaignDir,
        attemptId,
        agent: arm.agent,
        credentialName: arm.credential,
        evalsRoot: join(campaignDir, 'evals'),
        gauntletRoot: join(campaignDir, 'gauntlet'),
        binRoot: join(campaignDir, 'bin'),
        bundleDir: context.loaded.config.credential_bundle.path,
        uid: process.getuid!(),
        gid: process.getgid!(),
        grader: experiment.grader,
        identity: {
          campaign_id: experiment.campaign_id,
          comparison_id: args.slot.comparison_id,
          block_id: args.blockId,
          sample_id: args.slot.sample_id,
          execution_attempt_id: attemptId,
        },
        inputDigest: experiment.input_digest,
        startId: context.start.start_id,
        primaryBlockId: args.slot.primary_block_id,
        attemptNumber: args.attemptNumber,
        imageDigest: `sha256:${'a'.repeat(64)}`,
        evalsSha: experiment.refs.evals,
        maxTimeSeconds: experiment.runtime_limits.max_time_s,
        superpowersTree: null,
        scenarioDir: join(
          campaignDir,
          'evals',
          'scenarios',
          args.slot.scenario,
        ),
      });
    },
    runtime(authority) {
      return {
        async create(p) {
          authority.assertCreateAuthorized(p);
          return {
            ...p,
            container_id: sha256Hex(p.intent.identity.execution_attempt_id),
          };
        },
        async start(b) {
          authority.assertStartAuthorized(b);
          const run = join(
            b.intent.output_root,
            'staging',
            sha256Hex(b.intent.identity.execution_attempt_id),
          );
          mkdirSync(run);
          writeFileSync(
            join(run, 'verdict.json'),
            JSON.stringify({
              schema: 1,
              final: 'pass',
              final_reason: 'fixture worker result',
              gauntlet: null,
              checks: [],
              error: null,
              campaign: b.intent.identity,
              started_at: new Date(clock.now() * 1000).toISOString(),
              finished_at: new Date(clock.now() * 1000 + 1000).toISOString(),
              economics: {
                coding_agent: {
                  est_cost_usd: 1,
                  has_unpriced_model: false,
                  tokens: { total: 10 },
                },
                gauntlet: {
                  est_cost_usd: 0.1,
                  has_unpriced_model: false,
                  tokens: { total: 2 },
                },
              },
            }),
          );
          writeFileSync(
            join(run, 'trajectory.json'),
            JSON.stringify({
              steps: [
                {
                  timestamp: context.writer
                    .readProjection()
                    .attempts.get(b.intent.identity.execution_attempt_id)!
                    .prepared_at,
                },
              ],
            }),
          );
          writeAttemptManifest(run, b.intent.identity);
          return {
            startedAt: new Date(clock.now() * 1000).toISOString(),
            onStopped(fn) {
              fn(stopped(b));
            },
            onMonitorFailure() {},
          };
        },
        async inspectOwned(p) {
          const id = context.writer
            .readProjection()
            .attempts.get(p.intent.identity.execution_attempt_id)?.container_id;
          return id
            ? {
                kind: 'matching-stopped' as const,
                container_id: id,
                runtime_spec_digest: p.intent.runtime_spec_digest,
              }
            : { kind: 'absent' as const };
        },
        async stop(b) {
          return { kind: 'dead' as const, stopped: stopped(b) };
        },
        assertNoUnsettledStarts() {},
      };
    },
    publish: publishExecution,
    probe: {
      sample(now) {
        return {
          ts_ms: now,
          load1: 0,
          mem_available_bytes: 8 * 2 ** 30,
          mem_total_bytes: 16 * 2 ** 30,
          swap_used_bytes: 0,
          swap_total_bytes: 4 * 2 ** 30,
          process_count: 20,
          pid_max: 1000000,
          disk_free_bytes: 50 * 2 ** 30,
          disk_total_bytes: 100 * 2 ** 30,
        };
      },
    },
    cancelIntent: () => null,
    finish(runtime) {
      beforeFinish?.();
      completeControllerTermination({
        ...context,
        assertNoUnsettledStarts: () => runtime.assertNoUnsettledStarts(),
      });
    },
    storageFailure() {
      throw Error('unexpected storage failure');
    },
  };
  let done = false;
  const run = runCampaignDispatch(context, deps).finally(() => {
    done = true;
  });
  while (!done) {
    for (let i = 0; i < 50; i++) await Promise.resolve();
    const next = clock.earliestWaiter();
    if (next !== null) clock.setTo(next);
    await Bun.sleep(1);
  }
  await run;
}

export async function controller(context: CampaignControllerContext) {
  try {
    await execute(context);
  } catch (error) {
    writeFileSync(
      join(context.loaded.config.root, 'controller-error.txt'),
      String(error instanceof Error ? error.stack : error),
    );
    throw error;
  }
}

export async function controllerWithHeldTermination(
  context: CampaignControllerContext,
) {
  await execute(context, () => {
    const root = context.loaded.config.root;
    writeFileSync(join(root, 'termination-ready'), 'ready');
    const deadline = Date.now() + 15000;
    while (!existsSync(join(root, 'release-termination'))) {
      if (Date.now() > deadline)
        throw Error('fixture termination release timed out');
      Bun.sleepSync(10);
    }
  });
}
