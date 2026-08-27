// Campaign-dir snapshot integration (kernel D3, R-DSP-11/12, R-RCV-6,
// Decision D-11): the D2 materializers called with campaign-dir
// destinations (destDir = the campaign dir itself — Decision D-6),
// reconstruction cross-checked against Campaign.refs (expected identity
// never derives from current HEAD alone), the drift-guard cadence sites,
// the revised affected-block mapping, and the authorized repair operation
// (remove + re-materialize under D2's contracts — never rm -rf).
import { lstatSync, rmSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import type { CommandRunner } from '../agents/command-runner.ts';
import type { Campaign } from '../contracts/campaign/campaign.ts';
import { getEnv } from '../env.ts';
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
  readonly refs: Campaign['refs'];
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
 *  so resume cross-checks the handle against Campaign.refs and refuses
 *  loudly on ANY mismatch — evals SHA, gauntlet SHA, and the exact set of
 *  arm superpowers SHAs. */
export function reconstructCampaignSnapshot(args: {
  readonly campaignDir: string;
  readonly refs: Campaign['refs'];
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
      `snapshot reconstruction failed the Campaign.refs cross-check at ${args.campaignDir}: ${mismatches.join('; ')} — expected identity never derives from current HEAD alone (refuse, fail-closed)`,
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

export interface DriftWindow {
  readonly lastCleanVerifyTsMs: number;
  readonly rematerializedTsMs: number;
}

export interface InFlightBlock {
  readonly block_id: string;
  readonly admittedTsMs: number;
  /** null = still running. */
  readonly serviceEndTsMs: number | null;
}

/** Decision D-11 revised mapping: affected = every block in flight at any
 *  point during [last clean verify, re-materialization complete], plus every
 *  block admitted-but-unspawned in the failing wave (wave verification runs
 *  before wave admission, so those simply never admit). Blocks whose own
 *  terminal verify was clean BEFORE the window opened are unaffected. */
export function driftAffectedBlockIds(args: {
  readonly window: DriftWindow;
  readonly inFlight: readonly InFlightBlock[];
  readonly admittedUnspawned: readonly string[];
}): string[] {
  const { window } = args;
  const affected = new Set<string>(args.admittedUnspawned);
  for (const block of args.inFlight) {
    if (
      block.serviceEndTsMs !== null &&
      block.serviceEndTsMs < window.lastCleanVerifyTsMs
    ) {
      continue; // clean terminal before the window: unaffected
    }
    const inFlightDuring =
      block.admittedTsMs <= window.rematerializedTsMs &&
      (block.serviceEndTsMs === null ||
        block.serviceEndTsMs >= window.lastCleanVerifyTsMs);
    if (inFlightDuring) affected.add(block.block_id);
  }
  return [...affected];
}

/** D2's completion marker (`MARKER` in instrument-snapshot.ts; the
 *  Decision D-6 layout pins the on-disk name). */
const SNAPSHOT_MARKER = '.quorum-snapshot-ok';

/** lstat — does NOT follow symlinks — so a planted symlink at an expected
 *  tree path is handled as drift, never traversed. Returns null when
 *  missing. (Idiom: provisioning.ts's tryLstat.) */
function tryLstat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** The authorized repair (Decision D-11 step 3, defect-addendum C2): each
 *  drifted tree removed through the CommandRunner seam — git worktree
 *  remove --force + prune on the SOURCE checkout (registrations live in the
 *  source's .git/worktrees) — and re-created by re-invoking the D2
 *  materializer at the same dest. Only identity-checked drifted direct
 *  children are removed (never every tree on a materialization error), the
 *  completion marker is dropped first so the materializer rebuilds
 *  install + wrapper instead of skipping, and the rebuilt wrapper/tree set
 *  is verified before the handle is returned. */
export function repairDriftedTrees(
  args: MaterializeCampaignSnapshotArgs,
): SnapshotHandle {
  // The D2 minimal-env invariant (PATH/HOME/TMPDIR only), read through
  // src/env.ts — never a direct process.env read outside that boundary.
  const minimalEnv = {
    PATH: getEnv('PATH'),
    HOME: getEnv('HOME'),
    TMPDIR: getEnv('TMPDIR'),
  };
  /** C2 identity check: is the direct child at `dest` drifted? Drift is
   *  exactly what D2 refuses to reuse — a non-directory/symlink at the
   *  expected path, an unreadable HEAD (not a git worktree), a HEAD != the
   *  registered SHA, or a dirty porcelain. null = absent or exact+clean:
   *  nothing to remove; a string = the drift, for the loud record. */
  const treeDrift = (dest: string, expectedSha: string): string | null => {
    const st = tryLstat(dest);
    if (st === null) return null; // absent: the materializer creates it
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return 'not a plain directory (symlink or non-directory)';
    }
    const head = args.runner.run('git', ['-C', dest, 'rev-parse', 'HEAD'], {
      env: minimalEnv,
    });
    if (head.status !== 0) {
      return `HEAD unreadable (git rev-parse exited ${head.status}: ${head.stderr.trim()})`;
    }
    const porcelain = args.runner.run(
      'git',
      ['-C', dest, 'status', '--porcelain'],
      {
        env: minimalEnv,
      },
    );
    if (porcelain.status !== 0) {
      return `porcelain unreadable (git status exited ${porcelain.status}: ${porcelain.stderr.trim()})`;
    }
    if (head.stdout.trim() !== expectedSha) {
      return `HEAD ${head.stdout.trim()} != registered ${expectedSha}`;
    }
    if (porcelain.stdout !== '') {
      return `dirty working tree: ${JSON.stringify(porcelain.stdout)}`;
    }
    return null; // exact + clean: keep it
  };
  const removeAndPrune = (
    checkout: string,
    dest: string,
    label: string,
    drift: string,
  ): void => {
    const remove = args.runner.run(
      'git',
      ['-C', checkout, 'worktree', 'remove', '--force', dest],
      { env: minimalEnv },
    );
    const prune = args.runner.run(
      'git',
      ['-C', checkout, 'worktree', 'prune'],
      {
        env: minimalEnv,
      },
    );
    if (remove.status !== 0 || prune.status !== 0) {
      throw new SnapshotIntegrationError(
        `drift repair failed for ${label} at ${dest}: remove ${remove.status} (${remove.stderr.trim()}), prune ${prune.status} (${prune.stderr.trim()}) — inspect ${dest} and the worktree registrations in ${checkout}/.git/worktrees, then re-run the repair (fail-closed)`,
      );
    }
    process.stderr.write(
      `campaign snapshot drift repair: removed + recreating ${label} at ${dest} (drift: ${drift})\n`,
    );
  };
  const targets = [
    {
      checkout: args.evalsCheckout,
      dest: join(args.campaignDir, 'evals'),
      label: 'evals',
      sha: args.refs.evals,
    },
    {
      checkout: args.gauntletCheckout,
      dest: join(args.campaignDir, 'gauntlet'),
      label: 'gauntlet',
      sha: args.refs.gauntlet,
    },
  ];
  for (const sha of new Set(
    Object.values(args.refs.superpowers_by_arm).filter(
      (s): s is string => s !== null,
    ),
  )) {
    targets.push({
      checkout: args.superpowersCheckout,
      dest: join(args.campaignDir, `superpowers-${sha}`),
      label: `superpowers(${sha.slice(0, 12)})`,
      sha,
    });
  }
  for (const t of targets) {
    const drift = treeDrift(t.dest, t.sha);
    if (drift !== null) {
      removeAndPrune(t.checkout, t.dest, t.label, drift);
    }
  }
  // C2: drop the completion marker BEFORE re-materializing — D2's marker
  // fast-path would otherwise skip install/wrapper reconstruction over the
  // newly recreated trees. rmSync unlinks exactly the named path (a planted
  // symlink goes as a link, never followed); a non-regular marker is
  // corruption and refuses loudly rather than being recursively deleted.
  const marker = join(args.campaignDir, SNAPSHOT_MARKER);
  const markerStat = tryLstat(marker);
  if (markerStat !== null) {
    if (!markerStat.isFile()) {
      throw new SnapshotIntegrationError(
        `snapshot marker is not a regular file (sabotage or corruption): ${marker} — inspect it, then re-run the repair (fail-closed)`,
      );
    }
    rmSync(marker, { force: true });
  }
  const handle = materializeCampaignSnapshot(args);
  // C2: prove the rebuilt wrapper/tree set with the same D2 drift guard the
  // cadence sites run — a repair whose recreate cannot verify clean never
  // hands the handle back.
  verifyCampaignSnapshot(handle, args.runner);
  return handle;
}
