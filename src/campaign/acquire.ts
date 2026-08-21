// src/campaign/acquire.ts
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
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

function sha256File(path: string): string {
  return Bun.SHA256.hash(readFileSync(path), 'hex');
}

function writePrivate(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body, { mode: 0o600 });
}

function copyRecorded(
  srcAbs: string,
  destAbs: string,
  relPath: string,
): SelectionFileEntry {
  mkdirSync(join(destAbs, '..'), { recursive: true });
  copyFileSync(srcAbs, destAbs);
  return {
    path: relPath,
    sha256: sha256File(srcAbs),
    bytes: statSync(srcAbs).size,
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
    const runDir = join(args.resultsRoot, runId);
    if (!existsSync(runDir) || !statSync(runDir).isDirectory()) {
      manifest.missing_run_ids.push(runId);
      continue;
    }
    const files: SelectionFileEntry[] = [];
    const notes: string[] = [];
    for (const rel of PAYLOAD_RUN_FILES) {
      const srcAbs = join(runDir, rel);
      if (!existsSync(srcAbs)) {
        notes.push(`missing payload file: ${rel}`);
        continue;
      }
      files.push(copyRecorded(srcAbs, join(args.outDir, runId, rel), rel));
    }
    // gauntlet-agent/results/<id>/result.json — exactly one id expected.
    const gResults = join(runDir, 'gauntlet-agent', 'results');
    if (existsSync(gResults)) {
      const ids = readdirSync(gResults, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
      if (ids.length !== 1) {
        notes.push(
          `gauntlet-agent/results holds ${ids.length} run dirs (expected 1)`,
        );
      }
      for (const id of ids) {
        const rel = join('gauntlet-agent', 'results', id, 'result.json');
        const srcAbs = join(gResults, id, 'result.json');
        if (existsSync(srcAbs)) {
          files.push(copyRecorded(srcAbs, join(args.outDir, runId, rel), rel));
        }
      }
    } else {
      notes.push('no gauntlet-agent/results dir');
    }
    manifest.runs.push({ run_id: runId, files, notes });
  }

  // Batch metadata: any batch whose results.jsonl references a wanted run.
  const batchesRoot = join(args.resultsRoot, 'batches');
  if (existsSync(batchesRoot)) {
    for (const batch of readdirSync(batchesRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()) {
      const resultsJsonl = join(batchesRoot, batch, 'results.jsonl');
      if (!existsSync(resultsJsonl)) continue;
      const text = readFileSync(resultsJsonl, 'utf8');
      if (![...wanted].some((id) => text.includes(id))) continue;
      const files: SelectionFileEntry[] = [];
      for (const rel of ['batch.json', 'results.jsonl']) {
        const srcAbs = join(batchesRoot, batch, rel);
        if (existsSync(srcAbs)) {
          files.push(
            copyRecorded(srcAbs, join(args.outDir, 'batches', batch, rel), rel),
          );
        }
      }
      manifest.batches.push({ batch_id: batch, files });
    }
  }

  writePrivate(
    join(args.outDir, 'selection-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}
