// src/campaign/acquire.ts

import type { Stats } from 'node:fs';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/** Per-run payload: durations, costs, identity, trajectory (skew scalar).
 *  Deliberately excludes homes (OAuth material), transcripts beyond the
 *  ATIF trajectory, and workdirs. */
export const PAYLOAD_RUN_FILES = [
  'verdict.json',
  'trajectory.json',
  'coding-agent-token-usage.json',
] as const;

export interface AcquireArgs {
  /** Flat results root on the source host (run dirs directly inside; a
   *  `batches/` subdirectory is consulted for batch metadata). */
  resultsRoot: string;
  /** Exact run-dir names to select. */
  runIds: readonly string[];
  outDir: string;
  sourceHost: string;
  /** ISO timestamp, injected (never Date.now) for reproducibility. */
  now: string;
  /** The exact command line, recorded in the selection manifest. */
  command: string;
}

export interface SelectionFileEntry {
  path: string;
  sha256: string;
  bytes: number;
}

export interface SelectionManifest {
  schema_version: 'quorum.corpus-selection/v1';
  source_host: string;
  pulled_at: string;
  command: string;
  runs: Array<{ run_id: string; files: SelectionFileEntry[]; notes: string[] }>;
  batches: Array<{ batch_id: string; files: SelectionFileEntry[] }>;
  missing_run_ids: string[];
}

/** A run id must be a single safe path component: no separators, no
 *  traversal, no NUL bytes, not empty. Anything else is rejected up front
 *  so it can never steer a copy outside the roots. */
function isValidRunId(id: string): boolean {
  return (
    id.length > 0 &&
    !id.includes('/') &&
    !id.includes('\\') &&
    !id.includes('..') &&
    !id.includes('\0')
  );
}

/** lstat — does NOT follow symlinks — so a symlink never passes the
 *  isDirectory()/isFile() checks below. Returns null when missing. */
function tryLstat(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function isRegularFile(path: string): boolean {
  const st = tryLstat(path);
  return st?.isFile() ?? false;
}

function isRegularDir(path: string): boolean {
  const st = tryLstat(path);
  return st?.isDirectory() ?? false;
}

/** A failed run: listed in missing_run_ids, with the reason in a per-run
 *  notes entry (empty files), and nothing copied for it. */
function failRun(
  manifest: SelectionManifest,
  runId: string,
  reason: string,
): void {
  manifest.missing_run_ids.push(runId);
  manifest.runs.push({ run_id: runId, files: [], notes: [reason] });
}

function sha256File(path: string): string {
  return Bun.SHA256.hash(readFileSync(path), 'hex');
}

/** Publish the manifest atomically: write a private temporary sibling,
 *  then rename over the final path, so interruption can never leave a
 *  truncated selection-manifest.json behind. */
function writeManifestAtomic(
  outDir: string,
  manifest: SelectionManifest,
): void {
  const finalPath = join(outDir, 'selection-manifest.json');
  const tmpPath = `${finalPath}.tmp`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(tmpPath, finalPath);
}

function copyRecorded(
  srcAbs: string,
  destAbs: string,
  relPath: string,
): SelectionFileEntry {
  mkdirSync(join(destAbs, '..'), { recursive: true });
  copyFileSync(srcAbs, destAbs);
  // Hash and size the COMPLETED destination so the manifest always
  // describes the copied bytes, never a concurrently-mutating source.
  return {
    path: relPath,
    sha256: sha256File(destAbs),
    bytes: statSync(destAbs).size,
  };
}

export async function acquireCorpus(
  args: AcquireArgs,
): Promise<SelectionManifest> {
  const manifest: SelectionManifest = {
    schema_version: 'quorum.corpus-selection/v1',
    source_host: args.sourceHost,
    pulled_at: args.now,
    command: args.command,
    runs: [],
    batches: [],
    missing_run_ids: [],
  };

  const wanted = new Set(args.runIds);

  for (const runId of [...wanted].sort()) {
    if (!isValidRunId(runId)) {
      failRun(manifest, runId, `invalid run id: ${JSON.stringify(runId)}`);
      continue;
    }
    const runDir = join(args.resultsRoot, runId);
    const runStat = tryLstat(runDir);
    if (runStat === null) {
      manifest.missing_run_ids.push(runId);
      continue;
    }
    if (!runStat.isDirectory()) {
      failRun(manifest, runId, 'run dir is a symlink or not a directory');
      continue;
    }

    // Gauntlet result cardinality is validated BEFORE anything is copied:
    // exactly one gauntlet-agent/results/<id> dir, reached only through
    // regular directories.
    const gResults = join(runDir, 'gauntlet-agent', 'results');
    if (
      !isRegularDir(join(runDir, 'gauntlet-agent')) ||
      !isRegularDir(gResults)
    ) {
      failRun(
        manifest,
        runId,
        'gauntlet-agent/results missing or not a regular directory',
      );
      continue;
    }
    const idEntries = readdirSync(gResults, { withFileTypes: true }).filter(
      (e) => e.isDirectory(),
    );
    if (idEntries.length !== 1) {
      failRun(
        manifest,
        runId,
        `gauntlet-agent/results holds ${idEntries.length} run dirs (expected 1)`,
      );
      continue;
    }
    const id = idEntries[0]?.name;
    if (id === undefined) {
      failRun(
        manifest,
        runId,
        'gauntlet-agent/results holds 0 run dirs (expected 1)',
      );
      continue;
    }
    const resultRel = join('gauntlet-agent', 'results', id, 'result.json');
    const resultJsonAbs = join(gResults, id, 'result.json');

    // Validate every payload source (lstat: symlinks and irregular files
    // fail the run) before copying anything for it.
    const notes: string[] = [];
    const sources: Array<{ srcAbs: string; rel: string }> = [];
    let failed = false;
    for (const rel of PAYLOAD_RUN_FILES) {
      const srcAbs = join(runDir, rel);
      const st = tryLstat(srcAbs);
      if (st === null) {
        notes.push(`missing payload file: ${rel}`);
        continue;
      }
      if (!st.isFile()) {
        failRun(
          manifest,
          runId,
          `payload file is a symlink or not a regular file: ${rel}`,
        );
        failed = true;
        break;
      }
      sources.push({ srcAbs, rel });
    }
    if (failed) continue;

    const resultStat = tryLstat(resultJsonAbs);
    if (resultStat === null) {
      notes.push(`missing payload file: ${resultRel}`);
    } else if (!resultStat.isFile()) {
      failRun(
        manifest,
        runId,
        `payload file is a symlink or not a regular file: ${resultRel}`,
      );
      continue;
    } else {
      sources.push({ srcAbs: resultJsonAbs, rel: resultRel });
    }

    const files: SelectionFileEntry[] = [];
    for (const { srcAbs, rel } of sources) {
      files.push(copyRecorded(srcAbs, join(args.outDir, runId, rel), rel));
    }
    manifest.runs.push({ run_id: runId, files, notes });
  }

  // Batch metadata: any batch whose results.jsonl carries a line whose
  // parsed run_id EQUALS a wanted id (substring matches never select;
  // unparseable lines are skipped).
  const batchesRoot = join(args.resultsRoot, 'batches');
  if (isRegularDir(batchesRoot)) {
    for (const batch of readdirSync(batchesRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()) {
      const resultsJsonl = join(batchesRoot, batch, 'results.jsonl');
      if (!isRegularFile(resultsJsonl)) continue;
      const text = readFileSync(resultsJsonl, 'utf8');
      const referenced = text.split('\n').some((line) => {
        try {
          const parsed = JSON.parse(line) as { run_id?: unknown };
          return typeof parsed.run_id === 'string' && wanted.has(parsed.run_id);
        } catch {
          return false;
        }
      });
      if (!referenced) continue;
      const files: SelectionFileEntry[] = [];
      const batchJsonAbs = join(batchesRoot, batch, 'batch.json');
      if (isRegularFile(batchJsonAbs)) {
        files.push(
          copyRecorded(
            batchJsonAbs,
            join(args.outDir, 'batches', batch, 'batch.json'),
            'batch.json',
          ),
        );
      }
      files.push(
        copyRecorded(
          resultsJsonl,
          join(args.outDir, 'batches', batch, 'results.jsonl'),
          'results.jsonl',
        ),
      );
      manifest.batches.push({ batch_id: batch, files });
    }
  }

  writeManifestAtomic(args.outDir, manifest);
  return manifest;
}
