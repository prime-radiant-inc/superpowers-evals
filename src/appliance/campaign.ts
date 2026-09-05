import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandRunner } from '../agents/command-runner.ts';
import { loadFrozenCampaign } from '../campaign/campaign-document.ts';
import {
  type CampaignProcessControl,
  cancelCampaign,
  observeCampaignStatus,
} from '../campaign/cancellation.ts';
import { ContainerAttemptRuntime } from '../campaign/container-spawner.ts';
import {
  type HostStatsProbe,
  hostStatsProbeForCli,
} from '../campaign/host-stats.ts';
import { realProcessIdentityProbe } from '../campaign/locks.ts';
import {
  DEFAULT_GLOBAL_CAP,
  registerCampaign,
} from '../campaign/registration.ts';
import {
  publishReport,
  readComparisonReadout,
  readComparisonReport,
} from '../campaign/report-publication.ts';
import { resolveCampaignResultsRoot } from '../campaign/results-root.ts';
import { sealReport } from '../campaign/seal.ts';
import { getEnv } from '../env.ts';
import { RealClock } from '../scheduler/clock.ts';
import { startCampaignOnce } from './campaign-run.ts';
import { ApplianceError } from './errors.ts';
import { assertInsideRoot, assertNoFollowDirChain } from './safe-fs.ts';
import type { LoadedApplianceStateConfig } from './types.ts';

export interface CampaignCommandArgs {
  campaignSelector: string;
  json: boolean;
}
export interface CampaignRegisterArgs {
  suite: string;
  globalCap?: number;
  json: boolean;
}
export interface CampaignCommandDeps {
  loaded: LoadedApplianceStateConfig;
  runner: CommandRunner;
  probe?: HostStatsProbe;
  processes?: CampaignProcessControl;
  /** Internal external-effect seam; never read from configuration or argv. */
  launch?: typeof startCampaignOnce;
}

/** Select a published basename or exact immutable identity, never a path escape. */
export function resolveCampaignDirectory(
  loaded: LoadedApplianceStateConfig,
  selector: string,
): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(selector))
    throw new ApplianceError(
      'config_invalid',
      'campaign',
      'campaign selector must be a closed basename or exact identity',
    );
  const root = join(loaded.config.evals.path, 'campaigns');
  if (!existsSync(root)) throw new Error(`campaign not found: ${selector}`);
  if (!assertNoFollowDirChain(loaded.config.evals.path, root, 'campaigns'))
    throw new Error('campaign root unavailable');
  const candidates = readdirSync(root).filter(
    (name) => name === selector || name.startsWith(`${selector}-`),
  );
  const matches: string[] = [];
  for (const name of candidates) {
    const path = join(root, name);
    if (!assertNoFollowDirChain(root, path, 'campaign'))
      throw new Error('campaign directory unavailable');
    assertInsideRoot(realpathSync(root), realpathSync(path));
    const experiment = loadFrozenCampaign(path);
    if (name === selector || experiment.campaign_id === selector)
      matches.push(realpathSync(path));
  }
  if (matches.length !== 1)
    throw new Error(`campaign not found or ambiguous: ${selector}`);
  return matches[0] as string;
}

export function campaignCommands(deps: CampaignCommandDeps) {
  const { loaded, runner } = deps;
  const root = join(loaded.config.evals.path, 'campaigns');
  const context = (selector: string) => ({
    loaded,
    campaignDir: resolveCampaignDirectory(loaded, selector),
    jobId: `campaign-${randomUUID()}`,
    resultsRoot: resolveCampaignResultsRoot(
      loaded.config.container.results_root,
    ),
  });
  return {
    register(args: CampaignRegisterArgs) {
      const globalCap = args.globalCap ?? DEFAULT_GLOBAL_CAP;
      if (!Number.isSafeInteger(globalCap) || globalCap <= 0)
        throw new Error('global cap must be a positive integer');
      return registerCampaign({
        suitePath: args.suite,
        suiteRaw: readFileSync(args.suite, 'utf8'),
        campaignsRoot: root,
        globalCap,
        evalsCheckout: loaded.config.evals.path,
        gauntletCheckout: loaded.config.gauntlet.path,
        superpowersCheckout: loaded.config.superpowers.path,
        evalsRef: loaded.config.evals.ref,
        gauntletRef: loaded.config.gauntlet.ref,
        runner,
        clock: new RealClock(),
        identity: realProcessIdentityProbe,
        probe: deps.probe ?? hostStatsProbeForCli(loaded.config.evals.path),
        registeredBy: getEnv('USER') ?? 'operator',
        nowMs: Date.now(),
      });
    },
    list() {
      if (!existsSync(root)) return [];
      if (!assertNoFollowDirChain(loaded.config.evals.path, root, 'campaigns'))
        throw new Error('campaign root unavailable');
      return readdirSync(root)
        .sort()
        .filter((name) => existsSync(join(root, name, 'campaign.json')))
        .map((name) => {
          const args = context(name);
          const experiment = loadFrozenCampaign(args.campaignDir);
          return {
            campaign_id: experiment.campaign_id,
            selector: basename(args.campaignDir),
            input_digest: experiment.input_digest,
            ...observeCampaignStatus(args, deps.processes),
          };
        });
    },
    status(args: CampaignCommandArgs) {
      return observeCampaignStatus(
        context(args.campaignSelector),
        deps.processes,
      );
    },
    run(args: CampaignCommandArgs) {
      return (deps.launch ?? startCampaignOnce)(
        context(args.campaignSelector),
        {
          target: {
            module: fileURLToPath(
              new URL('../campaign/controller.ts', import.meta.url),
            ),
            exportName: 'runCampaignDispatch',
          },
        },
      );
    },
    cancel(args: CampaignCommandArgs) {
      return cancelCampaign(context(args.campaignSelector), {
        ...(deps.processes ? { processes: deps.processes } : {}),
        runtime: (startSettlement) =>
          new ContainerAttemptRuntime({
            runner,
            startSettlement,
            assertCreateAuthorized() {
              throw new Error('cancellation cannot create attempts');
            },
            assertStartAuthorized() {
              throw new Error('cancellation cannot start attempts');
            },
          }),
      });
    },
    costs(args: CampaignCommandArgs) {
      return readComparisonReadout(
        context(args.campaignSelector),
        deps.processes,
      ).report.accounting;
    },
    report(args: CampaignCommandArgs) {
      const ctx = context(args.campaignSelector);
      const report = readComparisonReport(ctx, deps.processes);
      if (
        report.report.status === 'completed' &&
        report.report.complete &&
        report.report.termination_verified
      )
        sealReport({ campaignDir: ctx.campaignDir, report });
      else publishReport({ campaignDir: ctx.campaignDir, report });
      return report;
    },
  };
}
