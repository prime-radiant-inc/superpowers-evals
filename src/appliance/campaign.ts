import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
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
  publishReportSnapshot,
  readComparisonReadout,
  readComparisonReport,
} from '../campaign/report-publication.ts';
import { resolveCampaignResultsRoot } from '../campaign/results-root.ts';
import { sealReport } from '../campaign/seal.ts';
import { getEnv } from '../env.ts';
import { RealClock } from '../scheduler/clock.ts';
import { startCampaignOnce } from './campaign-run.ts';
import { ApplianceError } from './errors.ts';
import { currentCheckoutSha } from './git.ts';
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

const CAMPAIGN_SELECTOR_RE = /^[a-z0-9][a-z0-9._-]*$/;
type UnreadableCampaignCode =
  | 'unsafe_path'
  | 'invalid_campaign'
  | 'unavailable';

class ListedCampaignError extends Error {
  readonly code: UnreadableCampaignCode;

  constructor(code: UnreadableCampaignCode, message: string) {
    super(message);
    this.name = 'ListedCampaignError';
    this.code = code;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function listedCampaignNames(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => {
      if (entry.isSymbolicLink()) return true;
      if (!entry.isDirectory()) return false;
      try {
        return (
          lstatSync(join(root, entry.name, 'campaign.json'), {
            throwIfNoEntry: false,
          }) !== undefined
        );
      } catch {
        return true;
      }
    })
    .map((entry) => entry.name)
    .sort();
}

function listedCampaignDirectory(
  root: string,
  realRoot: string,
  selector: string,
): string {
  if (!CAMPAIGN_SELECTOR_RE.test(selector)) {
    throw new ListedCampaignError(
      'unsafe_path',
      'campaign selector must be a closed basename',
    );
  }
  const campaignDir = join(root, selector);
  try {
    if (!assertNoFollowDirChain(root, campaignDir, 'campaign'))
      throw new Error('campaign directory unavailable');
    const realCampaignDir = realpathSync(campaignDir);
    assertInsideRoot(realRoot, realCampaignDir);
    return realCampaignDir;
  } catch (error) {
    throw new ListedCampaignError('unsafe_path', errorMessage(error));
  }
}

function unreadableCampaign(selector: string, error: unknown) {
  const reason =
    error instanceof ListedCampaignError
      ? { code: error.code, message: error.message }
      : { code: 'unavailable' as const, message: errorMessage(error) };
  return { selector, state: 'unreadable' as const, reason };
}

/** Select a published basename or exact immutable identity, never a path escape. */
export function resolveCampaignDirectory(
  loaded: LoadedApplianceStateConfig,
  selector: string,
): string {
  if (!CAMPAIGN_SELECTOR_RE.test(selector))
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
  const lifecycleContext = (campaignDir: string) => ({
    loaded,
    campaignDir,
    jobId: `campaign-${randomUUID()}`,
    resultsRoot: resolveCampaignResultsRoot(
      loaded.config.container.results_root,
    ),
  });
  const context = (selector: string) =>
    lifecycleContext(resolveCampaignDirectory(loaded, selector));
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
        evalsRef: currentCheckoutSha(loaded.config.evals.path, 'evals', runner),
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
      const realRoot = realpathSync(root);
      return listedCampaignNames(root).map((selector) => {
        try {
          const campaignDir = listedCampaignDirectory(root, realRoot, selector);
          let experiment: ReturnType<typeof loadFrozenCampaign>;
          try {
            experiment = loadFrozenCampaign(campaignDir);
          } catch (error) {
            throw new ListedCampaignError(
              'invalid_campaign',
              errorMessage(error),
            );
          }
          const args = lifecycleContext(campaignDir);
          let status: ReturnType<typeof observeCampaignStatus>;
          try {
            status = observeCampaignStatus(args, deps.processes);
          } catch (error) {
            throw new ListedCampaignError('unavailable', errorMessage(error));
          }
          return {
            campaign_id: experiment.campaign_id,
            selector: basename(campaignDir),
            input_digest: experiment.input_digest,
            ...status,
          };
        } catch (error) {
          return unreadableCampaign(selector, error);
        }
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
      else publishReportSnapshot({ campaignDir: ctx.campaignDir, report });
      return report;
    },
  };
}
