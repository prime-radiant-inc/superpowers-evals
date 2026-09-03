import { createHash } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseAttemptManifest } from '../runner/manifest.ts';

export class AttemptPublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttemptPublishError';
  }
}

export interface PublishAttemptArgs {
  readonly attemptDir: string;
  readonly resultsRoot: string;
  readonly expectedAttemptId: string;
}

function refusal(message: string): AttemptPublishError {
  return new AttemptPublishError(message);
}

function existingPath(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Verify a worker's private attempt output, then atomically publish its run.
 * The worker has already exited before this host-side operation starts; the
 * manifest is therefore the publication boundary for the verified artifacts. */
export function publishAttempt(args: PublishAttemptArgs): { runId: string } {
  if (args.expectedAttemptId.length === 0) {
    throw refusal('expected attempt id is required');
  }

  const staging = join(args.attemptDir, 'staging');
  let entries: string[];
  try {
    entries = readdirSync(staging);
  } catch {
    throw refusal(`attempt staging missing: ${staging}`);
  }
  if (entries.length !== 1) {
    throw refusal(
      `attempt staging must hold exactly one run directory, found [${entries.join(', ')}]`,
    );
  }

  const runId = entries[0];
  if (runId === undefined) {
    throw refusal('attempt staging has no run directory');
  }
  const runDir = join(staging, runId);
  let runStats: ReturnType<typeof lstatSync>;
  try {
    runStats = lstatSync(runDir);
  } catch {
    throw refusal(`staging entry is missing: ${runId}`);
  }
  if (runStats.isSymbolicLink() || !runStats.isDirectory()) {
    throw refusal(`staging entry is not a directory: ${runId}`);
  }

  const manifestPath = join(runDir, 'manifest.json');
  let manifestStats: ReturnType<typeof lstatSync>;
  try {
    manifestStats = lstatSync(manifestPath);
  } catch {
    throw refusal(`manifest missing for run ${runId}`);
  }
  if (manifestStats.isSymbolicLink() || !manifestStats.isFile()) {
    throw refusal(`manifest is non-regular or symlinked for run ${runId}`);
  }

  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch {
    throw refusal(`manifest missing for run ${runId}`);
  }

  let manifest: ReturnType<typeof parseAttemptManifest>;
  try {
    manifest = parseAttemptManifest(raw);
  } catch (error: unknown) {
    throw refusal(
      `manifest invalid for run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (manifest.run_id !== runId) {
    throw refusal(
      `manifest run-id mismatch: manifest ${manifest.run_id}, staging ${runId}`,
    );
  }
  if (manifest.campaign.execution_attempt_id !== args.expectedAttemptId) {
    throw refusal(
      `manifest attempt-id mismatch: manifest ${manifest.campaign.execution_attempt_id}, expected ${args.expectedAttemptId}`,
    );
  }

  for (const file of manifest.files) {
    const fullPath = join(runDir, file.path);
    let stats: ReturnType<typeof lstatSync> | undefined;
    try {
      stats = existingPath(fullPath);
    } catch (error: unknown) {
      throw refusal(
        `artifact status unavailable for ${file.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (stats === undefined || stats.isSymbolicLink() || !stats.isFile()) {
      throw refusal(
        `manifest lists a non-regular or missing artifact: ${file.path}`,
      );
    }

    let bytes: Buffer;
    try {
      bytes = readFileSync(fullPath);
    } catch (error: unknown) {
      throw refusal(
        `artifact read failed for ${file.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (bytes.length !== file.size) {
      throw refusal(
        `size mismatch for ${file.path}: manifest ${file.size}, disk ${bytes.length}`,
      );
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== file.sha256) {
      throw refusal(
        `digest mismatch for ${file.path}: manifest ${file.sha256}, disk ${digest}`,
      );
    }
  }

  const destination = join(args.resultsRoot, runId);
  try {
    if (existingPath(destination) !== undefined) {
      throw refusal(`results destination already exists: ${destination}`);
    }
  } catch (error: unknown) {
    if (error instanceof AttemptPublishError) throw error;
    throw refusal(
      `results destination status unavailable for ${runId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    renameSync(runDir, destination);
  } catch (error: unknown) {
    throw refusal(
      `publication rename failed for run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let resultsFd: number;
  try {
    resultsFd = openSync(args.resultsRoot, 'r');
    try {
      fsyncSync(resultsFd);
    } finally {
      closeSync(resultsFd);
    }
  } catch (error: unknown) {
    throw refusal(
      `publication directory sync failed for run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { runId };
}
