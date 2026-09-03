import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SuperpowersSpec } from '../agents/superpowers.ts';

import {
  clockNowMs,
  DEFAULT_RESOURCE_FLOORS,
  hostStatsProbeForCli,
  preflightResourceFloors,
} from '../campaign/host-stats.ts';
import {
  acquireLiveSpendLock,
  COVERED_BY_LOCK_ENV,
  type LiveSpendLock,
  realProcessIdentityProbe,
} from '../campaign/locks.ts';
import {
  type CampaignIdentity,
  CampaignIdentitySchema,
} from '../contracts/campaign/campaign.ts';
import type { CredentialLabels } from '../contracts/credential.ts';
import { EXIT_CODE_BY_FINAL } from '../contracts/verdict.ts';
import { resolveCredentialNameForAgent } from '../credentials/resolve.ts';
import { getEnv } from '../env.ts';
import { RunnerError } from '../runner/errors.ts';
import {
  currentGauntletChild,
  runScenario,
  runWasStopped,
} from '../runner/index.ts';
import { writeAttemptManifest } from '../runner/manifest.ts';
import {
  type StoppedIdentity,
  writeStoppedVerdict,
} from '../runner/stopped.ts';
import { RealClock } from '../scheduler/clock.ts';
import { render } from './render.ts';
import { resolveScenarioDir, scenarioName } from './scenario.ts';

export interface RunCommandOptions {
  readonly codingAgent: string;
  readonly os: string;
  readonly codingAgentsDir: string;
  readonly outRoot: string;
  readonly scenariosRoot: string;
  readonly credential?: string;
  readonly credentialsFile?: string;
  readonly graderModel?: string;
  // Snapshot-local gauntlet wrapper: exposed on both the public `run` command
  // and the run-child parser (the campaign child enters through the
  // snapshot's public run; R-SPN-9 threading).
  readonly gauntletBin?: string;
  // R-SPN-4 identity intake: the --campaign-identity flag's raw JSON, parsed
  // at this boundary (a zod failure is the loud CLI error) before the run.
  readonly campaignIdentityJson?: string;
  // Explicit superpowers mode. `superpowersRoot` is an already-materialized
  // root (resolved here, never a ref); `noSuperpowers` runs stock. Both unset
  // = legacy ambient behavior.
  readonly superpowersRoot?: string;
  readonly noSuperpowers?: boolean;
}

/** Project commander's parsed options onto RunCommandOptions. The
 *  `--no-superpowers` flag parses as the NEGATED boolean `superpowers`
 *  (default true, false only when passed); the shared executor instead reads
 *  the mode off `noSuperpowers`, so the negation is folded here, once, for
 *  both CLI parsers. Commander likewise derives `campaignIdentity` from
 *  `--campaign-identity`; the executor reads `campaignIdentityJson`, so the
 *  flag is renamed here, at the same single fold. */
export function normalizeRunCommandOptions(
  opts: RunCommandOptions & {
    superpowers?: boolean;
    campaignIdentity?: string;
  },
): RunCommandOptions {
  const { superpowers: suppressed, campaignIdentity: json, ...rest } = opts;
  return {
    ...rest,
    ...(suppressed === false ? { noSuperpowers: true } : {}),
    ...(json !== undefined ? { campaignIdentityJson: json } : {}),
  };
}

export type RunCredentialsOrigin =
  | 'external-campaign'
  | 'canonical-snapshot'
  | undefined;

export interface RunStopState {
  stopExitCode: number | null;
}

export interface RunStopSignalSource {
  once(signal: NodeJS.Signals, handler: () => void): void;
  off(signal: NodeJS.Signals, handler: () => void): void;
}

const processStopSignalSource: RunStopSignalSource = {
  once: (signal, handler) => process.once(signal, handler),
  off: (signal, handler) => process.off(signal, handler),
};

/** Install the one idempotent stop path shared by interactive SIGINT and the
 * SIGTERM delivered by an attempt container's init during docker stop. */
export function installRunStopHandlers(
  state: RunStopState,
  killGauntletChild: (signal: NodeJS.Signals) => void,
  signalSource: RunStopSignalSource = processStopSignalSource,
): () => void {
  const onStop = (): void => {
    if (state.stopExitCode !== null) return;
    killGauntletChild('SIGINT');
    state.stopExitCode = 2;
  };
  signalSource.once('SIGINT', onStop);
  signalSource.once('SIGTERM', onStop);
  return () => {
    signalSource.off('SIGINT', onStop);
    signalSource.off('SIGTERM', onStop);
  };
}

function writeStoppedArtifacts(
  runDir: string,
  identity: StoppedIdentity,
): void {
  writeStoppedVerdict(runDir, identity);
  if (identity.campaign !== undefined) {
    writeAttemptManifest(runDir, identity.campaign);
  }
}

function runId(path: string): string {
  const last = path.split('/').at(-1);
  return last !== undefined && last !== '' ? last : path;
}

/** The machine-facing allocation line (parent Identity): emitted at run-dir
 *  allocation, before the first provider token, so a spawner can bind
 *  attempt -> run_id without waiting for exit. Legacy human output (the
 *  exit-time 'run-id:' line + rendered verdict) is unchanged. */
export function runAllocatedLine(runDir: string): string {
  return `run_allocated: ${runId(runDir)}\n`;
}

export interface RunCommandDependencies {
  readonly signalSource?: RunStopSignalSource;
}

// Shared by the public `quorum run` command and run-all's narrow internal child
// entrypoint. The caller fixes credential origin; no user input selects it.
// Returns the process exit code (never process.exit inside — C8: an exit
// here would bypass the live-spend lock's release `finally`); the CLI
// boundaries (src/cli/index.ts, src/cli/run-child.ts) perform the exit.
export async function executeRunCommand(
  scenario: string,
  opts: RunCommandOptions,
  credentialsOrigin: RunCredentialsOrigin,
  dependencies: RunCommandDependencies = {},
): Promise<number> {
  const scn = resolveScenarioDir(scenario, opts.scenariosRoot);
  if (scn === undefined) {
    process.stderr.write(
      `scenario not found: ${scenario} (looked at the path and under ${opts.scenariosRoot}/)\n`,
    );
    return 2;
  }
  const credentialName = resolveCredentialNameForAgent(
    resolve(opts.codingAgentsDir),
    opts.codingAgent,
    opts.credential,
  );
  // ONE seconds-based Clock for this boundary: the live-spend lock's
  // heartbeat and the R-LCK-2 floors preflight read the same source.
  const clock = new RealClock();
  const startedAt = new Date().toISOString();
  const scenarioId = scenarioName(scn);
  let runDirForStop: string | null = null;
  let labelsForStop: CredentialLabels | undefined;
  // R-LCK-2 surface (a): direct `quorum run` is a top-level spender. The
  // lock handle is captured here so the SIGINT stop path can release it —
  // its exit would otherwise bypass the release `finally` below and leave
  // the host-wide lock held until heartbeat staleness.
  let spendLock: LiveSpendLock | null = null;
  // The stop path RECORDS its exit code (a signal handler cannot unwind its
  // caller): the listener kills the gauntlet child so the awaited run
  // settles, and the resolved code — with the stopped verdict written and
  // the lock released below — reaches the CLI entrypoint, which exits.
  const stopState: RunStopState = { stopExitCode: null };
  let campaignIdentity: CampaignIdentity | undefined;
  const stoppedIdentity = () => ({
    scenario: scenarioId,
    codingAgent: opts.codingAgent,
    startedAt,
    ...(credentialName !== undefined ? { credential: credentialName } : {}),
    ...(labelsForStop !== undefined ? { labels: labelsForStop } : {}),
    ...(campaignIdentity !== undefined ? { campaign: campaignIdentity } : {}),
  });
  let uninstallStopHandlers: (() => void) | null = null;
  try {
    uninstallStopHandlers = installRunStopHandlers(
      stopState,
      (signal) => {
        currentGauntletChild()?.kill(signal);
      },
      dependencies.signalSource,
    );
    // Explicit superpowers mode from the CLI projection. Resolved paths only —
    // materialization/verification belongs to the spawning campaign.
    const superpowers: SuperpowersSpec | undefined =
      opts.superpowersRoot !== undefined
        ? { mode: 'root', root: resolve(opts.superpowersRoot) }
        : opts.noSuperpowers === true
          ? { mode: 'none' }
          : undefined;
    if (superpowers?.mode === 'root' && !existsSync(superpowers.root)) {
      throw new RunnerError(
        `--superpowers-root does not exist: ${superpowers.root}`,
        'setup',
      );
    }
    // R-SPN-4 (Decision D-8): parse the identity at the CLI boundary — a
    // malformed block fails loud here, before any run dir or provider token.
    campaignIdentity =
      opts.campaignIdentityJson === undefined
        ? undefined
        : CampaignIdentitySchema.parse(JSON.parse(opts.campaignIdentityJson));
    // Children never acquire (R-LCK-2 explicit channel): a process marked
    // covered — by the campaign spawner (src/campaign/spawn.ts) or run-all's
    // invokeChild — rides its holder's accounting and bypasses acquisition
    // entirely (C4: the marker means never acquire, not acquire-and-fail).
    // Only an uncovered process is a top-level spender.
    if (getEnv(COVERED_BY_LOCK_ENV) === undefined) {
      spendLock = acquireLiveSpendLock({
        clock,
        identity: realProcessIdentityProbe,
      });
    }
    // R-LCK-2 floors preflight — unconditional (no platform bypass): the
    // injectable probe resolves through the fixture seam; production gets the
    // real Linux probe whose non-Linux refusal IS the designated-host
    // discipline. It sits INSIDE the release envelope, immediately after
    // acquisition (acquire -> preflight -> run): a floor refusal must release
    // the lock, never strand it until heartbeat staleness.
    if (spendLock !== null) {
      preflightResourceFloors(
        hostStatsProbeForCli(resolve(opts.outRoot)).sample(clockNowMs(clock)),
        DEFAULT_RESOURCE_FLOORS,
      );
    }
    let runResult: Awaited<ReturnType<typeof runScenario>>;
    try {
      runResult = await runScenario({
        scenarioDir: resolve(scn),
        codingAgent: opts.codingAgent,
        os: opts.os,
        codingAgentsDir: resolve(opts.codingAgentsDir),
        outRoot: resolve(opts.outRoot),
        startedAt,
        credential: opts.credential,
        ...(opts.credentialsFile !== undefined
          ? {
              credentialsPath: resolve(opts.credentialsFile),
              ...(credentialsOrigin !== undefined ? { credentialsOrigin } : {}),
            }
          : {}),
        graderModel: opts.graderModel,
        ...(opts.gauntletBin !== undefined
          ? { gauntletBin: resolve(opts.gauntletBin) }
          : {}),
        ...(campaignIdentity !== undefined
          ? { campaign: campaignIdentity }
          : {}),
        ...(campaignIdentity !== undefined &&
        getEnv('QUORUM_ATTEMPT_DIR') !== undefined
          ? { campaignAttemptDir: getEnv('QUORUM_ATTEMPT_DIR') }
          : {}),
        ...(superpowers !== undefined ? { superpowers } : {}),
        onRunDir: (dir) => {
          runDirForStop = dir;
          process.stdout.write(runAllocatedLine(dir));
        },
        onCredentialLabels: (labels) => {
          labelsForStop = labels;
        },
        // The graceful-stop seam: the recorded stop is honored at every
        // runner phase boundary — a SIGINT before the gauntlet child exists
        // still stops the run (no child, no spend, stopped verdict).
        shouldStop: () => stopState.stopExitCode !== null,
      });
    } catch (err) {
      if (stopState.stopExitCode !== null && runWasStopped()) {
        // The run settled by REJECTING after the runner observed the stop:
        // the stop verdict and its code still win.
        if (runDirForStop !== null) {
          writeStoppedArtifacts(runDirForStop, stoppedIdentity());
        }
        return stopState.stopExitCode;
      }
      throw err;
    }
    const { runDir, verdict } = runResult;
    // The run's genuine outcome is authoritative: the stopped verdict is
    // written only when the run ACTUALLY stopped, per the runner's own
    // report (runWasStopped — a phase-boundary stop or a gauntlet child
    // that exited BY SIGINT), never a bare flag read. A stop recorded after
    // genuine completion is late; it is logged and the real verdict stands.
    if (stopState.stopExitCode !== null && runWasStopped()) {
      // The stop is terminal and LAST: the runner may have written its own
      // error verdict while settling — the stopped verdict overwrites it.
      if (runDirForStop !== null) {
        writeStoppedArtifacts(runDirForStop, stoppedIdentity());
      }
      return stopState.stopExitCode;
    }
    if (stopState.stopExitCode !== null) {
      process.stderr.write(
        "late stop signal after run completion — the run's verdict stands\n",
      );
    }
    process.stdout.write(`run-id: ${runId(runDir)}\n`);
    process.stdout.write(
      render(verdict, runDir, {
        color: process.stdout.isTTY ?? false,
        mode: 'full',
      }),
    );
    return EXIT_CODE_BY_FINAL[verdict.final];
  } finally {
    uninstallStopHandlers?.();
    spendLock?.release();
  }
}
