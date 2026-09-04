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
import { readPinnedNoFollowFile } from '../appliance/credential-scope.ts';
import type { CampaignIdentity } from '../contracts/campaign/campaign.ts';
import { jcsCanonicalize } from '../contracts/campaign/digest.ts';
import {
  type ArtifactRef,
  type BoundExecution,
  type VerifiedStopped,
  VerifiedStoppedSchema,
} from '../contracts/campaign/execution.ts';
import { parseAttemptManifest } from '../runner/manifest.ts';

export class AttemptPublishError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'AttemptPublishError';
  }
}

export interface PublishAttemptArgs {
  readonly attemptDir: string;
  readonly resultsRoot: string;
  readonly expectedAttemptId: string;
  readonly expectedIdentity?: CampaignIdentity;
  /** Journaled allocation, when observed; checked before the rename. */
  readonly expectedRunId?: string | undefined;
  /** Test seam for the post-rename durability cut; production uses fs. */
  readonly fsOps?: AttemptPublishFsOps | undefined;
}

export interface AttemptPublishFsOps {
  readonly renameSync: (oldPath: string, newPath: string) => void;
  readonly openSync: (path: string, flags: string) => number;
  readonly fsyncSync: (fd: number) => void;
  readonly closeSync: (fd: number) => void;
}

function refusal(message: string, cause?: unknown): AttemptPublishError {
  return new AttemptPublishError(message, cause);
}

function existingPath(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function verifyInventory(runDir: string, listedPaths: readonly string[]): void {
  const listedFiles = new Set(listedPaths);
  const listedDirectories = new Set<string>();
  for (const listedPath of listedPaths) {
    const components = listedPath.split('/');
    components.pop();
    let directory = '';
    for (const component of components) {
      directory =
        directory.length === 0 ? component : `${directory}/${component}`;
      listedDirectories.add(directory);
    }
  }

  const walk = (directory: string, prefix: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch (error: unknown) {
      throw refusal(
        `artifact inventory read failed for ${prefix || '.'}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const entry of entries) {
      const relativePath = prefix.length === 0 ? entry : `${prefix}/${entry}`;
      const fullPath = join(directory, entry);
      let stats: ReturnType<typeof lstatSync> | undefined;
      try {
        stats = existingPath(fullPath);
      } catch (error: unknown) {
        throw refusal(
          `artifact inventory status unavailable for ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (stats === undefined) {
        throw refusal(`artifact inventory entry disappeared: ${relativePath}`);
      }
      if (relativePath === 'manifest.json') {
        if (stats.isSymbolicLink() || !stats.isFile()) {
          throw refusal(`manifest is non-regular or symlinked for run`);
        }
        continue;
      }
      if (listedFiles.has(relativePath)) {
        if (stats.isSymbolicLink() || !stats.isFile()) {
          throw refusal(
            `manifest lists a non-regular or missing artifact: ${relativePath}`,
          );
        }
        continue;
      }
      if (listedDirectories.has(relativePath)) {
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
          throw refusal(
            `artifact directory is non-regular or symlinked: ${relativePath}`,
          );
        }
        walk(fullPath, relativePath);
        continue;
      }
      throw refusal(`unlisted artifact refused: ${relativePath}`);
    }
  };

  walk(runDir, '');
}

/** Verify a worker's private attempt output, then atomically publish its run.
 * The worker has already exited before this host-side operation starts; the
 * manifest is therefore the publication boundary for the verified artifacts. */
export function publishAttempt(args: PublishAttemptArgs): { runId: string } {
  const fsOps: AttemptPublishFsOps = args.fsOps ?? {
    renameSync,
    openSync,
    fsyncSync,
    closeSync,
  };
  if (args.expectedAttemptId.length === 0) {
    throw refusal('expected attempt id is required');
  }

  const staging = join(args.attemptDir, 'staging');
  let stagingStats: ReturnType<typeof lstatSync>;
  try {
    stagingStats = lstatSync(staging);
  } catch {
    throw refusal(`attempt staging missing: ${staging}`);
  }
  if (stagingStats.isSymbolicLink() || !stagingStats.isDirectory()) {
    throw refusal(`attempt staging is non-regular or symlinked: ${staging}`);
  }

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
  if (args.expectedRunId !== undefined && runId !== args.expectedRunId) {
    throw refusal(
      `staging run-id ${runId} disagrees with the journaled allocation ${args.expectedRunId}`,
    );
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

  if (
    args.expectedIdentity !== undefined &&
    jcsCanonicalize(manifest.campaign) !==
      jcsCanonicalize(args.expectedIdentity)
  ) {
    throw refusal('manifest campaign identity mismatch');
  }

  for (const file of manifest.files) {
    const components = file.path.split('/');
    let fullPath = runDir;
    let stats: ReturnType<typeof lstatSync> | undefined;
    for (const [index, component] of components.entries()) {
      fullPath = join(fullPath, component);
      try {
        stats = existingPath(fullPath);
      } catch (error: unknown) {
        throw refusal(
          `artifact status unavailable for ${file.path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (stats === undefined) {
        throw refusal(
          `manifest lists a non-regular or missing artifact: ${file.path}`,
        );
      }
      if (index < components.length - 1) {
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
          throw refusal(
            `artifact directory is non-regular or symlinked: ${components.slice(0, index + 1).join('/')}`,
          );
        }
      } else if (stats.isSymbolicLink() || !stats.isFile()) {
        throw refusal(
          `manifest lists a non-regular or missing artifact: ${file.path}`,
        );
      }
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

  verifyInventory(
    runDir,
    manifest.files.map((file) => file.path),
  );

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
    fsOps.renameSync(runDir, destination);
  } catch (error: unknown) {
    throw refusal(
      `publication rename failed for run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }

  let resultsFd: number;
  try {
    resultsFd = fsOps.openSync(args.resultsRoot, 'r');
    try {
      fsOps.fsyncSync(resultsFd);
    } finally {
      fsOps.closeSync(resultsFd);
    }
  } catch (error: unknown) {
    throw refusal(
      `publication directory sync failed for run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }

  return { runId };
}

/** V2 publication consumes runtime-produced death proof and authenticates every
 * campaign identity field before returning immutable results-root-relative refs. */
export function publishExecution(args: {
  bound: BoundExecution;
  stopped: VerifiedStopped;
  resultsRoot: string;
  expectedRunId?: string;
  fsOps?: AttemptPublishFsOps;
}): { runId: string; artifacts: ArtifactRef[] } {
  const stopped = VerifiedStoppedSchema.parse(args.stopped);
  const intent = args.bound.intent;
  if (
    stopped.container_id !== args.bound.container_id ||
    stopped.execution_attempt_id !== intent.identity.execution_attempt_id ||
    stopped.proof !== 'inspected_stopped'
  )
    throw refusal('publication requires exact inspected namespace death');
  const staging = join(intent.output_root, 'staging');
  const entries = readdirSync(staging);
  if (entries.length !== 1 || entries[0] === undefined)
    throw refusal('publication requires one runner-minted run');
  const runId = entries[0];
  const body = readPinnedNoFollowFile(
    staging,
    [runId, 'manifest.json'],
    'attempt manifest',
    true,
  );
  if (body === null) throw refusal('attempt manifest missing');
  const manifest = parseAttemptManifest(body);
  if (
    manifest.run_id !== runId ||
    jcsCanonicalize(manifest.campaign) !== jcsCanonicalize(intent.identity)
  )
    throw refusal('manifest campaign identity mismatch');
  const published = publishAttempt({
    attemptDir: intent.output_root,
    resultsRoot: args.resultsRoot,
    expectedAttemptId: intent.identity.execution_attempt_id,
    expectedIdentity: intent.identity,
    expectedRunId: args.expectedRunId,
    fsOps: args.fsOps,
  });
  return {
    ...published,
    artifacts: [
      ...manifest.files.map((file) => ({
        path: `${runId}/${file.path}`,
        sha256: file.sha256,
        bytes: file.size,
      })),
      {
        path: `${runId}/manifest.json`,
        sha256: createHash('sha256').update(body).digest('hex'),
        bytes: Buffer.byteLength(body),
      },
    ],
  };
}

/** Read only publisher-returned references beneath the configured results root.
 * Revalidate bytes at each consumer boundary; a pathname alone is not evidence. */
export function readPublishedArtifact(
  resultsRoot: string,
  ref: ArtifactRef,
): string {
  const body = readPinnedNoFollowFile(
    resultsRoot,
    ref.path.split('/'),
    'published campaign artifact',
    true,
  );
  if (
    body === null ||
    Buffer.byteLength(body) !== ref.bytes ||
    createHash('sha256').update(body).digest('hex') !== ref.sha256
  )
    throw new AttemptPublishError(
      'published artifact differs from authenticated reference',
    );
  return body;
}
