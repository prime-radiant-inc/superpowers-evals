import { expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from '../src/agents/command-runner.ts';
import { SnapshotDriftError } from '../src/campaign/instrument-snapshot.ts';
import {
  driftAffectedBlockIds,
  materializeCampaignSnapshot,
  reconstructCampaignSnapshot,
  repairDriftedTrees,
  SnapshotIntegrationError,
} from '../src/campaign/snapshot.ts';

const EVALS = 'e'.repeat(40);
const GAUNTLET = '9'.repeat(40);
const SP_A = 'a'.repeat(40);
const SP_B = 'b'.repeat(40);

class RecordingRunner implements CommandRunner {
  readonly calls: {
    command: string;
    args: readonly string[];
    options?: CommandOptions;
  }[] = [];
  readonly heads = new Map<string, string>();
  readonly porcelain = new Map<string, string>();
  run(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): CommandResult {
    this.calls.push(
      options === undefined ? { command, args } : { command, args, options },
    );
    if (command === 'git' && args.includes('rev-parse')) {
      const dir = args[args.indexOf('-C') + 1] ?? '';
      return {
        status: 0,
        stdout: `${this.heads.get(dir) ?? EVALS}\n`,
        stderr: '',
      };
    }
    if (command === 'git' && args.includes('status')) {
      const dir = args[args.indexOf('-C') + 1] ?? '';
      return { status: 0, stdout: this.porcelain.get(dir) ?? '', stderr: '' };
    }
    // Worktree emulation: remove deletes the dest; add recreates it and
    // pins its HEAD to the requested sha — so a repair's remove -> re-add
    // sequence round-trips against the real ensureWorktreeAt validation.
    if (
      command === 'git' &&
      args.includes('worktree') &&
      args.includes('remove')
    ) {
      const dest = args[args.length - 1] ?? '';
      rmSync(dest, { recursive: true, force: true });
      this.heads.delete(dest);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (
      command === 'git' &&
      args.includes('worktree') &&
      args.includes('add')
    ) {
      const dest = args[args.indexOf('--detach') + 1] ?? '';
      const sha = args[args.length - 1] ?? '';
      mkdirSync(dest, { recursive: true });
      this.heads.set(dest, sha);
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  }
}

function refs(sp: Record<string, string | null>) {
  return { superpowers_by_arm: sp, evals: EVALS, gauntlet: GAUNTLET };
}

test('materializes the snapshot at the campaign dir itself + one worktree per DISTINCT arm SHA', () => {
  const runner = new RecordingRunner();
  const campaignDir = mkdtempSync(join(tmpdir(), 'camp-'));
  const handle = materializeCampaignSnapshot({
    campaignDir,
    refs: refs({ arm1: SP_A, arm2: SP_A, arm3: SP_B, arm4: null }),
    evalsCheckout: '/src/evals',
    gauntletCheckout: '/src/gauntlet',
    superpowersCheckout: '/src/sp',
    runner,
  });
  expect(handle.evalsRoot).toBe(join(campaignDir, 'evals')); // destDir = campaign dir (Decision D-6)
  expect(handle.superpowersWorktrees.map((w) => w.sha).sort()).toEqual([
    SP_A,
    SP_B,
  ]); // distinct only
  const adds = runner.calls.filter((c) => c.args.includes('add'));
  expect(adds.filter((c) => c.args.includes(SP_A))).toHaveLength(1);
  // 'none' arms materialize nothing.
  expect(runner.calls.some((c) => c.args.join(' ').includes('none'))).toBe(
    false,
  );
});

test('reconstruction cross-checks Campaign.refs and refuses a moved HEAD', () => {
  const runner = new RecordingRunner();
  const campaignDir = mkdtempSync(join(tmpdir(), 'camp-'));
  // A completed snapshot layout with MOVED heads (reconstruction re-reads HEADs).
  mkdirSync(join(campaignDir, 'evals'), { recursive: true });
  mkdirSync(join(campaignDir, 'gauntlet'), { recursive: true });
  mkdirSync(join(campaignDir, 'bin'), { recursive: true });
  const spRoot = join(campaignDir, `superpowers-${SP_A}`);
  mkdirSync(spRoot, { recursive: true });
  writeFileSync(join(campaignDir, '.quorum-snapshot-ok'), '');
  writeFileSync(
    join(campaignDir, 'bin', 'gauntlet'),
    `#!/bin/sh\nexec bun '${join(campaignDir, 'gauntlet')}/src/index.ts' "$@"\n`,
  );
  chmodSync(join(campaignDir, 'bin', 'gauntlet'), 0o755); // the completeness probe requires the exec bit
  // Heads match refs -> cross-check passes.
  runner.heads.set(join(campaignDir, 'evals'), EVALS);
  runner.heads.set(join(campaignDir, 'gauntlet'), GAUNTLET);
  runner.heads.set(spRoot, SP_A);
  const ok = reconstructCampaignSnapshot({
    campaignDir,
    refs: refs({ arm1: SP_A }),
    runner,
  });
  expect(ok.evalsSha).toBe(EVALS);
  // Evals HEAD moved -> loud refusal naming both SHAs (R-RCV-6).
  runner.heads.set(join(campaignDir, 'evals'), 'f'.repeat(40));
  expect(() =>
    reconstructCampaignSnapshot({
      campaignDir,
      refs: refs({ arm1: SP_A }),
      runner,
    }),
  ).toThrow(SnapshotIntegrationError);
  expect(() =>
    reconstructCampaignSnapshot({
      campaignDir,
      refs: refs({ arm1: SP_A }),
      runner,
    }),
  ).toThrow(/evals/);
});

test('reconstruction refuses an arm-SHA set mismatch (extra or missing worktree)', () => {
  const runner = new RecordingRunner();
  const campaignDir = mkdtempSync(join(tmpdir(), 'camp-'));
  mkdirSync(join(campaignDir, 'evals'), { recursive: true });
  mkdirSync(join(campaignDir, 'gauntlet'), { recursive: true });
  mkdirSync(join(campaignDir, 'bin'), { recursive: true });
  mkdirSync(join(campaignDir, `superpowers-${SP_A}`), { recursive: true });
  writeFileSync(join(campaignDir, '.quorum-snapshot-ok'), '');
  writeFileSync(
    join(campaignDir, 'bin', 'gauntlet'),
    `#!/bin/sh\nexec bun '${join(campaignDir, 'gauntlet')}/src/index.ts' "$@"\n`,
  );
  chmodSync(join(campaignDir, 'bin', 'gauntlet'), 0o755); // the completeness probe requires the exec bit
  runner.heads.set(join(campaignDir, 'evals'), EVALS);
  runner.heads.set(join(campaignDir, 'gauntlet'), GAUNTLET);
  runner.heads.set(join(campaignDir, `superpowers-${SP_A}`), SP_A);
  // Refs expect SP_B too -> mismatch.
  expect(() =>
    reconstructCampaignSnapshot({
      campaignDir,
      refs: refs({ arm1: SP_A, arm2: SP_B }),
      runner,
    }),
  ).toThrow(SnapshotIntegrationError);
});

test('drift affected-set: in-flight across the window + admitted-unspawned; clean pre-window terminals unaffected', () => {
  const affected = driftAffectedBlockIds({
    window: { lastCleanVerifyTsMs: 100, rematerializedTsMs: 500 },
    inFlight: [
      { block_id: 'live-through', admittedTsMs: 50, serviceEndTsMs: null },
      {
        block_id: 'started-in-window',
        admittedTsMs: 300,
        serviceEndTsMs: null,
      },
      { block_id: 'ended-in-window', admittedTsMs: 50, serviceEndTsMs: 200 },
      { block_id: 'clean-before-window', admittedTsMs: 10, serviceEndTsMs: 90 },
      { block_id: 'after-window', admittedTsMs: 600, serviceEndTsMs: null },
    ],
    admittedUnspawned: ['wave-block'],
  });
  expect(affected.sort()).toEqual(
    [
      'ended-in-window',
      'live-through',
      'started-in-window',
      'wave-block',
    ].sort(),
  );
});

test('repair: worktree remove --force + prune on the SOURCE checkout, then re-materialize (never rm -rf)', () => {
  const runner = new RecordingRunner();
  const campaignDir = mkdtempSync(join(tmpdir(), 'camp-'));
  // Drift the evals tree's HEAD so re-materialize must remove + recreate.
  mkdirSync(join(campaignDir, 'evals'), { recursive: true });
  mkdirSync(join(campaignDir, 'gauntlet'), { recursive: true });
  runner.heads.set(join(campaignDir, 'evals'), 'f'.repeat(40));
  runner.heads.set(join(campaignDir, 'gauntlet'), GAUNTLET);
  expect(() =>
    repairDriftedTrees({
      campaignDir,
      refs: refs({}),
      evalsCheckout: '/src/evals',
      gauntletCheckout: '/src/gauntlet',
      superpowersCheckout: '/src/sp',
      runner,
    }),
  ).not.toThrow(); // the runner's worktree emulation round-trips remove -> re-add at the right SHA
  const verbs = runner.calls.map((c) => `${c.command} ${c.args.join(' ')}`);
  expect(
    verbs.some(
      (v) => v.includes('worktree remove --force') && v.includes('/src/evals'),
    ),
  ).toBe(true);
  expect(verbs.some((v) => v.includes('worktree prune'))).toBe(true);
  expect(verbs.some((v) => v.includes('rm -rf'))).toBe(false);
});

// Defect-addendum C2 (partial) — this unit's repair contract: only
// identity-checked drifted trees are removed (never every tree), the
// completion marker is dropped before re-materialization so D2 rebuilds
// install + wrapper instead of skipping, and the rebuilt set is verified.

// A worktree remove deletes the dest, so its recorded porcelain goes with it.
class PorcelainAwareRunner extends RecordingRunner {
  override run(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): CommandResult {
    if (
      command === 'git' &&
      args.includes('worktree') &&
      args.includes('remove')
    ) {
      this.porcelain.delete(args[args.length - 1] ?? '');
    }
    return super.run(command, args, options);
  }
}

test('repair removes ONLY identity-checked drifted trees — clean siblings survive (C2)', () => {
  const runner = new PorcelainAwareRunner();
  const campaignDir = mkdtempSync(join(tmpdir(), 'camp-'));
  const spRoot = join(campaignDir, `superpowers-${SP_A}`);
  mkdirSync(join(campaignDir, 'evals'), { recursive: true });
  mkdirSync(join(campaignDir, 'gauntlet'), { recursive: true });
  mkdirSync(spRoot, { recursive: true });
  runner.heads.set(join(campaignDir, 'evals'), 'f'.repeat(40)); // moved HEAD: drift
  runner.heads.set(join(campaignDir, 'gauntlet'), GAUNTLET);
  runner.porcelain.set(join(campaignDir, 'gauntlet'), ' M story.md'); // dirty tree: drift
  runner.heads.set(spRoot, SP_A); // exact + clean: must survive
  expect(() =>
    repairDriftedTrees({
      campaignDir,
      refs: refs({ arm1: SP_A }),
      evalsCheckout: '/src/evals',
      gauntletCheckout: '/src/gauntlet',
      superpowersCheckout: '/src/sp',
      runner,
    }),
  ).not.toThrow();
  const removed = runner.calls
    .filter((c) => c.args.includes('remove'))
    .map((c) => c.args[c.args.length - 1]);
  expect(removed).toEqual([
    join(campaignDir, 'evals'),
    join(campaignDir, 'gauntlet'),
  ]);
});

test('repair drops the completion marker so re-materialization rebuilds install + wrapper (C2)', () => {
  const runner = new RecordingRunner();
  const campaignDir = mkdtempSync(join(tmpdir(), 'camp-'));
  mkdirSync(join(campaignDir, 'evals'), { recursive: true });
  mkdirSync(join(campaignDir, 'gauntlet'), { recursive: true });
  runner.heads.set(join(campaignDir, 'evals'), 'f'.repeat(40));
  runner.heads.set(join(campaignDir, 'gauntlet'), GAUNTLET);
  // A stale marker from the drifted era: without removal, D2's marker
  // fast-path would skip install/wrapper over the recreated trees.
  writeFileSync(join(campaignDir, '.quorum-snapshot-ok'), '');
  expect(() =>
    repairDriftedTrees({
      campaignDir,
      refs: refs({}),
      evalsCheckout: '/src/evals',
      gauntletCheckout: '/src/gauntlet',
      superpowersCheckout: '/src/sp',
      runner,
    }),
  ).not.toThrow(); // the post-repair verify also proves the marker was re-created
  expect(
    runner.calls.some((c) => c.command === 'bun' && c.args.includes('install')),
  ).toBe(true);
});

test('repair verifies the rebuilt tree set — a still-drifted recreate refuses loudly (C2)', () => {
  const runner = new RecordingRunner();
  const campaignDir = mkdtempSync(join(tmpdir(), 'camp-'));
  mkdirSync(join(campaignDir, 'evals'), { recursive: true });
  mkdirSync(join(campaignDir, 'gauntlet'), { recursive: true });
  runner.heads.set(join(campaignDir, 'evals'), EVALS);
  // The base runner's porcelain survives remove -> the recreated tree
  // re-materializes "successfully" yet can never verify clean.
  runner.porcelain.set(join(campaignDir, 'evals'), ' M story.md');

  expect(() =>
    repairDriftedTrees({
      campaignDir,
      refs: refs({}),
      evalsCheckout: '/src/evals',
      gauntletCheckout: '/src/gauntlet',
      superpowersCheckout: '/src/sp',
      runner,
    }),
  ).toThrow(SnapshotDriftError);
  expect(() =>
    repairDriftedTrees({
      campaignDir,
      refs: refs({}),
      evalsCheckout: '/src/evals',
      gauntletCheckout: '/src/gauntlet',
      superpowersCheckout: '/src/sp',
      runner,
    }),
  ).toThrow(/evals/);
});
