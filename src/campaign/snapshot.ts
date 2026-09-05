import type { CommandRunner } from '../agents/command-runner.ts';
import type { Experiment } from '../contracts/campaign/experiment.ts';
import {
  materializeEvalsSnapshot,
  reconstructSnapshot,
  type SnapshotHandle,
  verifySnapshot,
} from './instrument-snapshot.ts';
import { materializeSuperpowersWorktree } from './provisioning.ts';

export class SnapshotIntegrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotIntegrationError';
  }
}

export interface MaterializeCampaignSnapshotArgs {
  readonly campaignDir: string;
  readonly refs: Experiment['refs'];
  readonly evalsCheckout: string;
  readonly gauntletCheckout: string;
  readonly superpowersCheckout: string;
  readonly runner: CommandRunner;
}

/** R-DSP-12: materialize the evals+gauntlet snapshot (destDir = the campaign
 *  dir) and one immutable worktree per DISTINCT arm superpowers SHA. */
export function materializeCampaignSnapshot(
  args: MaterializeCampaignSnapshotArgs,
): SnapshotHandle {
  const handle = materializeEvalsSnapshot({
    evalsCheckout: args.evalsCheckout,
    evalsSha: args.refs.evals,
    gauntletCheckout: args.gauntletCheckout,
    gauntletSha: args.refs.gauntlet,
    destDir: args.campaignDir,
    runner: args.runner,
  });
  const distinctShas = [
    ...new Set(
      Object.values(args.refs.superpowers_by_arm).filter(
        (sha): sha is string => sha !== null,
      ),
    ),
  ].sort();
  const worktrees = distinctShas.map((sha) => ({
    root: materializeSuperpowersWorktree({
      sourceCheckout: args.superpowersCheckout,
      sha,
      destParent: args.campaignDir,
      runner: args.runner,
    }),
    sha,
  }));
  return { ...handle, superpowersWorktrees: worktrees };
}

/** R-RCV-6: reconstruction reads expected SHAs from current worktree HEADs,
 *  so the controller cross-checks the handle against Campaign.refs and refuses
 *  loudly on ANY mismatch — evals SHA, gauntlet SHA, and the exact set of
 *  arm superpowers SHAs. */
export function reconstructCampaignSnapshot(args: {
  readonly campaignDir: string;
  readonly refs: Experiment['refs'];
  readonly runner: CommandRunner;
}): SnapshotHandle {
  const handle = reconstructSnapshot(args.campaignDir, args.runner);
  const mismatches: string[] = [];
  if (handle.evalsSha !== args.refs.evals) {
    mismatches.push(
      `evals: HEAD ${handle.evalsSha} != registered ${args.refs.evals}`,
    );
  }
  if (handle.gauntletSha !== args.refs.gauntlet) {
    mismatches.push(
      `gauntlet: HEAD ${handle.gauntletSha} != registered ${args.refs.gauntlet}`,
    );
  }
  const expectedArms = [
    ...new Set(
      Object.values(args.refs.superpowers_by_arm).filter(
        (sha): sha is string => sha !== null,
      ),
    ),
  ].sort();
  const observedArms = handle.superpowersWorktrees.map((w) => w.sha).sort();
  if (JSON.stringify(expectedArms) !== JSON.stringify(observedArms)) {
    mismatches.push(
      `superpowers worktree set: observed [${observedArms.join(', ')}] != registered [${expectedArms.join(', ')}]`,
    );
  }
  if (mismatches.length > 0) {
    throw new SnapshotIntegrationError(
      `snapshot reconstruction failed the Campaign.refs cross-check at ${args.campaignDir}: ${mismatches.join('; ')} — expected identity never derives from current HEAD alone; this controller session is interrupted`,
    );
  }
  return handle;
}

/** The D2 drift guard at the D2 cadence: per admission wave, at block
 *  terminal, pre-seal (task 8 call sites; D4 invokes pre-seal). */
export function verifyCampaignSnapshot(
  handle: SnapshotHandle,
  runner: CommandRunner,
): void {
  verifySnapshot(handle, runner);
}
