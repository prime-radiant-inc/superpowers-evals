import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { CommandRunner } from '../agents/command-runner.ts';
import { FinalVerdictSchema } from '../contracts/verdict.ts';
import type { BundleEntry, BundleSkip } from './manifest.ts';
import { BundleManifestSchema, denylistHit } from './manifest.ts';
import type { RevRecovery, SkillsTreeIndex } from './rev-recovery.ts';
import { buildSkillsTreeIndex, recoverSuperpowersRev } from './rev-recovery.ts';

// Run-root artifacts carried verbatim. Everything not named here is dropped,
// so a new secret-bearing file added by some future harness cannot leak by
// default.
const PAYLOAD_FILES = [
  'verdict.json',
  'trajectory.json',
  'coding-agent-token-usage.json',
  'phase.json',
] as const;

const PAYLOAD_DIRS = ['gauntlet-agent', 'coding-agent-workdir'] as const;

// Dependency trees the agent's toolchain materialized rather than authored.
// They are reproducible bulk, and they vendor trust stores (certifi's
// cacert.pem) that are not credentials but look exactly like one. The agent's
// own .git is deliberately absent from this list: its commits are real output.
const VENDOR_DIRS = new Set([
  '.venv',
  'venv',
  'node_modules',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
]);

// Raw coding-agent session logs, lifted out of the throwaway home into
// raw-sessions/ so the rest of home/ can be dropped wholesale.
const SESSION_DIRS = [
  'home/.codex/sessions',
  'home/.claude/sessions',
  'home/.gemini/sessions',
  'home/.kimi/sessions',
] as const;

export interface ExportArgs {
  readonly resultsDir: string;
  readonly outDir: string;
  readonly superpowersRepo: string;
  readonly runner: CommandRunner;
  readonly sourceHost: string;
  readonly now: string;
  readonly onProgress?: (done: number, total: number) => void;
  // Runs a previous bundle already captured. Re-exporting one is worse than
  // useless: thinning deletes the home the rev recovery reads, so a second pass
  // over an already-exported run yields a strictly weaker provenance record.
  readonly excludeRunIds?: ReadonlySet<string>;
}

export interface ExportSummary {
  readonly exported: number;
  readonly skipped: number;
  readonly excluded: number;
  readonly byRecovery: Record<string, number>;
  readonly bundleDir: string;
}

function writePrivate(path: string, body: string | Buffer): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body, { mode: 0o600 });
}

function sha256(path: string): string {
  return Bun.SHA256.hash(readFileSync(path), 'hex');
}

// A run's own payload can contain a nested results tree — a scenario that
// exercises quorum itself leaves verdicts under coding-agent-workdir/. Finding
// a verdict marks a run and stops the descent, and these names are never
// searched at all.
const NON_RUN_DIRS = new Set([...PAYLOAD_DIRS, 'home', 'raw-sessions', '.git']);

// Depth is bounded so a stray symlink or a deep fixture tree cannot turn a
// scan into a full-disk walk.
const MAX_DISCOVERY_DEPTH = 6;

// Every run directory at any depth. The canonical layout is
// results/<label>/<run-id>/, but quarantine sweeps move a whole label tree
// under a holding directory, putting its runs one level deeper.
//
// A run is a directory holding a verdict.json or a home/ — the latter marks a
// run that crashed before it could reach a verdict, which callers thinning
// disk still need to see. Either marker ends the descent.
export function findRunDirs(resultsDir: string): string[] {
  const runs: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (
      existsSync(join(dir, 'verdict.json')) ||
      existsSync(join(dir, 'home'))
    ) {
      runs.push(dir);
      return;
    }
    if (depth >= MAX_DISCOVERY_DEPTH) {
      return;
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !NON_RUN_DIRS.has(entry.name)) {
        visit(join(dir, entry.name), depth + 1);
      }
    }
  };
  if (existsSync(resultsDir)) {
    visit(resultsDir, 0);
  }
  return runs.sort();
}

function discoverRunDirs(resultsDir: string): string[] {
  return findRunDirs(resultsDir).filter((dir) =>
    existsSync(join(dir, 'verdict.json')),
  );
}

function copyTree(
  src: string,
  dest: string,
  record: (destPath: string) => void,
  skipVendor = false,
): void {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      if (skipVendor && VENDOR_DIRS.has(entry.name)) {
        continue;
      }
      copyTree(from, to, record, skipVendor);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    mkdirSync(dest, { recursive: true });
    copyFileSync(from, to);
    record(to);
  }
}

// Copy the allowlisted payload out of a run dir. Returns bundle-relative path
// -> sha-256 for everything written.
function copyPayload(runDir: string, destRun: string): Record<string, string> {
  const files: Record<string, string> = {};
  const record = (destPath: string): void => {
    const rel = relative(destRun, destPath);
    files[rel] = sha256(destPath);
  };

  mkdirSync(destRun, { recursive: true });
  for (const name of PAYLOAD_FILES) {
    const from = join(runDir, name);
    if (existsSync(from) && statSync(from).isFile()) {
      const to = join(destRun, name);
      copyFileSync(from, to);
      record(to);
    }
  }
  for (const name of PAYLOAD_DIRS) {
    const from = join(runDir, name);
    if (existsSync(from) && statSync(from).isDirectory()) {
      copyTree(
        from,
        join(destRun, name),
        record,
        name === 'coding-agent-workdir',
      );
    }
  }
  for (const name of SESSION_DIRS) {
    const from = join(runDir, name);
    if (existsSync(from) && statSync(from).isDirectory()) {
      copyTree(from, join(destRun, 'raw-sessions'), record);
    }
  }
  return files;
}

// A campaign groups the experiment directories run against one superpowers
// build — `cx-eff-cc-ceremony-arch-dev-rep1` and `cx-eff-cx-sdd-small-fix-rep3`
// are both `cx-eff`. Arms are agent-specific, so a gemini-only arm has no
// sibling to learn from; the campaign does.
function campaignOf(sourcePath: string): string {
  const label = basename(join(sourcePath, '..'));
  const parts = label.split('-');
  return parts.slice(0, 2).join('-');
}

// Beyond this, "co-temporal" stops meaning anything: superpowers moves several
// times a day during a campaign. A run with no closer neighbour stays unknown
// rather than borrowing a sha that is probably wrong.
const INFERENCE_WINDOW_MS = 24 * 60 * 60 * 1000;

// Runs whose rev could not be recovered borrow the sha from the nearest
// co-temporal run in the same campaign, recorded in a field that never
// masquerades as a recovered sha.
function applyInference(entries: BundleEntry[]): BundleEntry[] {
  const known = entries.filter(
    (e) => e.superpowers_sha !== null && e.started_at !== null,
  );
  return entries.map((entry) => {
    if (entry.rev_recovery !== 'unknown' || entry.started_at === null) {
      return entry;
    }
    const campaign = campaignOf(entry.source_path);
    const startedMs = Date.parse(entry.started_at);
    let best: { sha: string; delta: number } | null = null;
    for (const candidate of known) {
      if (campaignOf(candidate.source_path) !== campaign) {
        continue;
      }
      const sha = candidate.superpowers_sha;
      const startedAt = candidate.started_at;
      if (sha === null || startedAt === null) {
        continue;
      }
      const delta = Math.abs(Date.parse(startedAt) - startedMs);
      if (
        delta <= INFERENCE_WINDOW_MS &&
        (best === null || delta < best.delta)
      ) {
        best = { sha, delta };
      }
    }
    if (best === null) {
      return entry;
    }
    return {
      ...entry,
      rev_recovery: 'inferred' as const,
      inferred_superpowers_sha: best.sha,
    };
  });
}

export function exportRuns(args: ExportArgs): ExportSummary {
  const runDirs = discoverRunDirs(args.resultsDir);
  mkdirSync(args.outDir, { recursive: true });

  let index: SkillsTreeIndex = { byTree: new Map() };
  if (existsSync(join(args.superpowersRepo, '.git'))) {
    index = buildSkillsTreeIndex(args.superpowersRepo, args.runner);
  }

  let entries: BundleEntry[] = [];
  const skipped: BundleSkip[] = [];
  const claimedRunIds = new Map<string, string>();
  let excluded = 0;

  let done = 0;
  for (const runDir of runDirs) {
    done += 1;
    args.onProgress?.(done, runDirs.length);

    const runId = basename(runDir);
    if (args.excludeRunIds?.has(runId) === true) {
      excluded += 1;
      continue;
    }
    // Bundle layout is keyed on the run id alone, so a collision would merge
    // two runs' payloads into one directory and corrupt both.
    const claimed = claimedRunIds.get(runId);
    if (claimed !== undefined) {
      skipped.push({
        source_path: runDir,
        reason: `duplicate run id, already exported from ${claimed}`,
      });
      continue;
    }
    claimedRunIds.set(runId, runDir);

    let parsed: ReturnType<typeof FinalVerdictSchema.parse>;
    try {
      parsed = FinalVerdictSchema.parse(
        JSON.parse(readFileSync(join(runDir, 'verdict.json'), 'utf8')),
      );
    } catch (error) {
      skipped.push({
        source_path: runDir,
        reason: `unreadable verdict: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
      });
      continue;
    }

    let recovery: RevRecovery;
    try {
      recovery = recoverSuperpowersRev({
        runDir,
        recordedRev: parsed.provenance?.superpowers_rev ?? null,
        startedAt: parsed.started_at,
        superpowersRepo: args.superpowersRepo,
        index,
        runner: args.runner,
      });
    } catch {
      recovery = {
        status: 'unknown',
        superpowersSha: null,
        superpowersTreeSha: null,
      };
    }

    const destRun = join(args.outDir, 'runs', runId);
    let files: Record<string, string>;
    try {
      files = copyPayload(runDir, destRun);
    } catch (error) {
      skipped.push({
        source_path: runDir,
        reason: `payload copy failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    const leaked = Object.keys(files).find((rel) => denylistHit(rel) !== null);
    if (leaked !== undefined) {
      // Unreachable via the allowlist; a hard stop rather than a skip, because
      // it means the allowlist itself is wrong and every other run is suspect.
      throw new Error(
        `export allowlist leaked a credential-shaped file: ${runId}/${leaked}`,
      );
    }

    entries.push({
      run_id: runId,
      source_path: runDir,
      scenario: parsed.scenario ?? null,
      coding_agent: parsed.coding_agent ?? null,
      credential: parsed.credential ?? null,
      os: parsed.os ?? null,
      started_at: parsed.started_at ?? null,
      finished_at: parsed.finished_at ?? null,
      final: parsed.final,
      harness_rev: parsed.provenance?.harness_rev ?? null,
      rev_recovery: recovery.status,
      superpowers_sha: recovery.superpowersSha,
      superpowers_tree_sha: recovery.superpowersTreeSha,
      inferred_superpowers_sha: null,
      files,
    });
  }

  entries = applyInference(entries);

  const manifest = BundleManifestSchema.parse({
    schema_version: 1,
    created_at: args.now,
    source_host: args.sourceHost,
    source_results_dir: args.resultsDir,
    entries,
    skipped,
  });
  writePrivate(
    join(args.outDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  const byRecovery: Record<string, number> = {};
  for (const entry of entries) {
    byRecovery[entry.rev_recovery] = (byRecovery[entry.rev_recovery] ?? 0) + 1;
  }

  return {
    exported: entries.length,
    skipped: skipped.length,
    excluded,
    byRecovery,
    bundleDir: args.outDir,
  };
}
