import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandRunner } from '../agents/command-runner.ts';

// How a run's superpowers rev was established. `recorded` came from the
// verdict; `recovered` and `tree_only` are derived from the tree the harness
// archived into the run's throwaway home; `inferred` is copied from a
// co-temporal sibling run and is never presented as recovered.
export const REV_RECOVERY_STATUSES = [
  'recorded',
  'recovered',
  'tree_only',
  'inferred',
  'unknown',
] as const;
export type RevRecoveryStatus = (typeof REV_RECOVERY_STATUSES)[number];

export interface RevRecovery {
  readonly status: RevRecoveryStatus;
  readonly superpowersSha: string | null;
  readonly superpowersTreeSha: string | null;
}

// Where each coding agent archives a full content copy of the superpowers tree
// inside a run's throwaway home. Agents absent from this list install by mount
// or symlink and archive nothing, so their rev is unrecoverable.
const ARCHIVED_SKILLS_DIRS = [
  'home/.codex/plugins/cache/debug/superpowers/local/skills',
] as const;

function gitOrThrow(
  gitRepo: string,
  args: readonly string[],
  runner: CommandRunner,
  env?: Record<string, string | undefined>,
): string {
  const result = runner.run('git', args, {
    cwd: gitRepo,
    ...(env === undefined ? {} : { env }),
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

// Hash an on-disk skills directory into `gitRepo`'s object store and return the
// resulting tree sha, without touching that repo's real index or worktree.
export function skillsTreeSha(
  skillsDir: string,
  gitRepo: string,
  runner: CommandRunner,
): string {
  const indexDir = mkdtempSync(join(tmpdir(), 'sp-index-'));
  const env = { GIT_INDEX_FILE: join(indexDir, 'index') };
  try {
    // --work-tree points git at the archived copy; `add -f` bypasses any
    // ignore rules that would otherwise skip files the copy legitimately has.
    gitOrThrow(
      gitRepo,
      ['--work-tree', skillsDir, 'add', '-f', '.'],
      runner,
      env,
    );
    return gitOrThrow(gitRepo, ['write-tree'], runner, env);
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
}

export interface SkillsTreeIndex {
  // skills-tree sha -> commits carrying it, newest commit date first
  readonly byTree: ReadonlyMap<
    string,
    ReadonlyArray<{ readonly sha: string; readonly committedAt: number }>
  >;
}

// One traversal of superpowers history, mapping every commit's `skills` subtree
// sha to that commit. Built once and shared across all runs in an export.
export function buildSkillsTreeIndex(
  gitRepo: string,
  runner: CommandRunner,
): SkillsTreeIndex {
  const log = gitOrThrow(gitRepo, ['log', '--all', '--format=%H %ct'], runner);
  const commits = log
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [sha, ct] = line.split(' ');
      return { sha: sha ?? '', committedAt: Number(ct ?? '0') * 1000 };
    })
    .filter((commit) => commit.sha !== '');

  // cat-file --batch-check resolves every <commit>:skills in a single process;
  // %(rest) echoes the commit sha back so the output can be zipped to input.
  const input = commits.map((c) => `${c.sha}:skills ${c.sha}\n`).join('');
  const result = runner.run(
    'git',
    ['cat-file', '--batch-check=%(objectname) %(rest)'],
    { cwd: gitRepo, input },
  );

  const byTree = new Map<string, Array<{ sha: string; committedAt: number }>>();
  const dateBySha = new Map(commits.map((c) => [c.sha, c.committedAt]));
  for (const line of result.stdout.split('\n')) {
    const [tree, sha] = line.trim().split(' ');
    // Commits without a skills/ dir resolve to "missing"; skip them.
    if (
      tree === undefined ||
      sha === undefined ||
      !/^[0-9a-f]{40}$/.test(tree)
    ) {
      continue;
    }
    const committedAt = dateBySha.get(sha);
    if (committedAt === undefined) {
      continue;
    }
    const bucket = byTree.get(tree);
    if (bucket === undefined) {
      byTree.set(tree, [{ sha, committedAt }]);
    } else {
      bucket.push({ sha, committedAt });
    }
  }
  for (const bucket of byTree.values()) {
    bucket.sort((a, b) => b.committedAt - a.committedAt);
  }
  return { byTree };
}

export interface RecoverArgs {
  readonly runDir: string;
  readonly recordedRev: string | null;
  readonly startedAt: string | undefined;
  readonly superpowersRepo: string;
  readonly index: SkillsTreeIndex;
  readonly runner: CommandRunner;
}

function archivedSkillsDir(runDir: string): string | null {
  for (const candidate of ARCHIVED_SKILLS_DIRS) {
    const path = join(runDir, candidate);
    if (existsSync(path)) {
      return path;
    }
  }
  return null;
}

// Several commits can share an identical skills tree — a docs-only commit
// stacked on a real one. The run was driven by the newest such commit that
// already existed when it started.
function pickCommit(
  candidates: ReadonlyArray<{
    readonly sha: string;
    readonly committedAt: number;
  }>,
  startedAt: string | undefined,
): string | null {
  if (candidates.length === 0) {
    return null;
  }
  const first = candidates[0];
  if (first === undefined) {
    return null;
  }
  if (candidates.length === 1 || startedAt === undefined) {
    return first.sha;
  }
  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) {
    return first.sha;
  }
  const preceding = candidates.find((c) => c.committedAt <= startedMs);
  // Candidates are newest-first, so falling back to the last entry picks the
  // oldest when every candidate somehow post-dates the run.
  return (preceding ?? candidates.at(-1) ?? first).sha;
}

export function recoverSuperpowersRev(args: RecoverArgs): RevRecovery {
  if (args.recordedRev !== null && args.recordedRev !== '') {
    return {
      status: 'recorded',
      superpowersSha: args.recordedRev,
      superpowersTreeSha: null,
    };
  }

  const skillsDir = archivedSkillsDir(args.runDir);
  if (skillsDir === null) {
    return {
      status: 'unknown',
      superpowersSha: null,
      superpowersTreeSha: null,
    };
  }

  let treeSha: string;
  try {
    treeSha = skillsTreeSha(skillsDir, args.superpowersRepo, args.runner);
  } catch {
    return {
      status: 'unknown',
      superpowersSha: null,
      superpowersTreeSha: null,
    };
  }

  const sha = pickCommit(args.index.byTree.get(treeSha) ?? [], args.startedAt);
  if (sha === null) {
    return {
      status: 'tree_only',
      superpowersSha: null,
      superpowersTreeSha: treeSha,
    };
  }
  return {
    status: 'recovered',
    superpowersSha: sha,
    superpowersTreeSha: treeSha,
  };
}
