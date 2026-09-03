import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { z } from 'zod';
import {
  type CampaignIdentity,
  CampaignIdentitySchema,
} from '../contracts/campaign/campaign.ts';
import { RunnerError } from './errors.ts';

const MANIFEST_NAME = 'manifest.json';
const MANIFEST_STAGE_NAME = '.manifest.json.tmp';
const EXCLUDED_TOP_LEVEL_DIRS = new Set(['home']);

function isManifestPath(path: string): boolean {
  if (
    path.length === 0 ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path)
  ) {
    return false;
  }
  return path
    .split('/')
    .every((part) => part.length > 0 && part !== '.' && part !== '..');
}

const ManifestFileSchema = z
  .object({
    path: z.string().min(1).refine(isManifestPath, {
      message: 'manifest paths must be normalized relative paths',
    }),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const AttemptManifestSchema = z
  .object({
    schema_version: z.literal(1),
    run_id: z
      .string()
      .min(1)
      .refine(
        (value) =>
          !value.includes('/') &&
          !value.includes('\\') &&
          !value.includes('\0') &&
          value !== '.' &&
          value !== '..',
        { message: 'run_id must be a safe path component' },
      ),
    campaign: CampaignIdentitySchema,
    files: z.array(ManifestFileSchema),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const paths = new Set<string>();
    manifest.files.forEach((file, index) => {
      if (paths.has(file.path)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['files', index, 'path'],
          message: 'manifest file paths must be unique',
        });
      }
      paths.add(file.path);
    });
  });

export type AttemptManifest = z.infer<typeof AttemptManifestSchema>;

export function parseAttemptManifest(raw: string): AttemptManifest {
  return AttemptManifestSchema.parse(JSON.parse(raw));
}

function manifestError(message: string): RunnerError {
  return new RunnerError(`attempt manifest: ${message}`, 'capture');
}

function collectFiles(runDir: string): string[] {
  const found: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      const rawPath = relative(runDir, fullPath);
      const path = rawPath.split(sep).join('/');
      if (path === MANIFEST_NAME || path === MANIFEST_STAGE_NAME) continue;
      if (!isManifestPath(path)) {
        throw manifestError(`artifact path is not normalized: ${path}`);
      }
      if (entry.isSymbolicLink()) {
        throw manifestError(`symlinked artifact refused: ${path}`);
      }
      if (entry.isDirectory()) {
        if (directory === runDir && EXCLUDED_TOP_LEVEL_DIRS.has(entry.name)) {
          continue;
        }
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        throw manifestError(`non-regular artifact refused: ${path}`);
      }
      found.push(path);
    }
  };

  walk(runDir);
  return found.sort();
}

function digestFile(
  runDir: string,
  path: string,
): AttemptManifest['files'][number] {
  const fullPath = join(runDir, path);
  if (!lstatSync(fullPath).isFile()) {
    throw manifestError(`non-regular artifact refused: ${path}`);
  }
  const fd = openSync(fullPath, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const bytes = readFileSync(fullPath);
  return {
    path,
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function removeStaleStage(stagePath: string): void {
  try {
    unlinkSync(stagePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Write the attempt's complete, secret-free artifact inventory as its final
 * durable runner artifact. The host can publish only after validating this
 * private, atomically replaced manifest. */
export function writeAttemptManifest(
  runDir: string,
  campaign: CampaignIdentity,
): void {
  const stagePath = join(runDir, MANIFEST_STAGE_NAME);
  const finalPath = join(runDir, MANIFEST_NAME);
  let fd: number | null = null;
  try {
    removeStaleStage(stagePath);
    const parsedCampaign = CampaignIdentitySchema.parse(campaign);
    const runId = basename(runDir);
    if (runId.length === 0)
      throw manifestError('run directory has no basename');
    const files = collectFiles(runDir).map((path) => digestFile(runDir, path));
    const manifest: AttemptManifest = AttemptManifestSchema.parse({
      schema_version: 1,
      run_id: runId,
      campaign: parsedCampaign,
      files,
    });
    fd = openSync(stagePath, 'wx', 0o600);
    const body = `${JSON.stringify(manifest, null, 2)}\n`;
    // fsync follows chmod so both contents and private mode reach disk before
    // the stage is renamed into the final name.
    const bytes = Buffer.from(body, 'utf8');
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes.subarray(offset));
      if (written <= 0) throw manifestError('manifest stage made no progress');
      offset += written;
    }
    chmodSync(stagePath, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(stagePath, finalPath);
    chmodSync(finalPath, 0o600);
    const dirFd = openSync(runDir, 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (error: unknown) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the publication error.
      }
    }
    try {
      removeStaleStage(stagePath);
    } catch {
      // Preserve the publication error; a stale stage is not blessed output.
    }
    if (error instanceof RunnerError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw manifestError(reason);
  }
}
