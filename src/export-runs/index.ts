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
}

export interface ExportSummary {
  readonly exported: number;
  readonly skipped: number;
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

// Every run directory under results/<label>/<run-id>/ that has a verdict.
function discoverRunDirs(resultsDir: string): string[] {
  const runs: string[] = [];
  if (!existsSync(resultsDir)) {
    return runs;
  }
  for (const label of readdirSync(resultsDir, { withFileTypes: true })) {
    if (!label.isDirectory()) {
      continue;
    }
    const labelDir = join(resultsDir, label.name);
    for (const run of readdirSync(labelDir, { withFileTypes: true })) {
      if (!run.isDirectory()) {
        continue;
      }
      const runDir = join(labelDir, run.name);
      if (existsSync(join(runDir, 'verdict.json'))) {
        runs.push(runDir);
      }
    }
  }
  return runs.sort();
}

function copyTree(
  src: string,
  dest: string,
  record: (destPath: string) => void,
): void {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to, record);
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
      copyTree(from, join(destRun, name), record);
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

// Runs whose rev could not be recovered borrow the sha from the nearest
// co-temporal run in the same experiment directory, recorded in a field that
// never masquerades as a recovered sha.
function applyInference(entries: BundleEntry[]): BundleEntry[] {
  const known = entries.filter(
    (e) => e.superpowers_sha !== null && e.started_at !== null,
  );
  return entries.map((entry) => {
    if (entry.rev_recovery !== 'unknown' || entry.started_at === null) {
      return entry;
    }
    const label = basename(join(entry.source_path, '..'));
    const startedMs = Date.parse(entry.started_at);
    let best: { sha: string; delta: number } | null = null;
    for (const candidate of known) {
      if (basename(join(candidate.source_path, '..')) !== label) {
        continue;
      }
      const sha = candidate.superpowers_sha;
      const startedAt = candidate.started_at;
      if (sha === null || startedAt === null) {
        continue;
      }
      const delta = Math.abs(Date.parse(startedAt) - startedMs);
      if (best === null || delta < best.delta) {
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

  let done = 0;
  for (const runDir of runDirs) {
    done += 1;
    args.onProgress?.(done, runDirs.length);

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

    const runId = basename(runDir);
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
    byRecovery,
    bundleDir: args.outDir,
  };
}
