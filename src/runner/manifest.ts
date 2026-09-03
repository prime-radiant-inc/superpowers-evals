import { createHash } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, join, sep } from 'node:path';
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

const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const READ_FILE_FLAGS = fsConstants.O_RDONLY | NOFOLLOW;
const READ_DIRECTORY_FLAGS =
  fsConstants.O_RDONLY | NOFOLLOW | (fsConstants.O_DIRECTORY ?? 0);

function isSameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
}

interface PinnedDirectory {
  readonly fd: number;
  readonly viaPath: string;
}

function pinnedPath(fd: number, stat: Stats): string {
  return process.platform === 'darwin'
    ? `/.vol/${stat.dev}/${stat.ino}`
    : `/proc/self/fd/${fd}`;
}

function openDirectory(path: string): PinnedDirectory {
  const fd = openSync(path, READ_DIRECTORY_FLAGS);
  try {
    const stat = fstatSync(fd);
    if (!stat.isDirectory()) {
      throw manifestError(`non-directory artifact path refused: ${path}`);
    }
    return { fd, viaPath: pinnedPath(fd, stat) };
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // Preserve the original validation error.
    }
    throw error;
  }
}

function collectFiles(runDir: string): {
  files: AttemptManifest['files'];
  rootPath: string;
} {
  const found: AttemptManifest['files'] = [];
  const rootPath = realpathSync(runDir);

  const walk = (
    directory: PinnedDirectory,
    displayPath: string,
    isRoot: boolean,
  ): void => {
    for (const entry of readdirSync(directory.viaPath, {
      withFileTypes: true,
    })) {
      const path = join(displayPath, entry.name).split(sep).join('/');
      if (path === MANIFEST_NAME || path === MANIFEST_STAGE_NAME) continue;
      if (!isManifestPath(path)) {
        throw manifestError(`artifact path is not normalized: ${path}`);
      }
      if (entry.isSymbolicLink()) {
        throw manifestError(`symlinked artifact refused: ${path}`);
      }
      if (entry.isDirectory()) {
        if (isRoot && EXCLUDED_TOP_LEVEL_DIRS.has(entry.name)) {
          continue;
        }
        const child = openDirectory(`${directory.viaPath}/${entry.name}`);
        try {
          walk(child, path, false);
          if (
            !isSameFile(
              fstatSync(child.fd),
              lstatSync(`${directory.viaPath}/${entry.name}`),
            )
          ) {
            throw manifestError(
              `artifact directory changed while it was being read: ${path}`,
            );
          }
        } finally {
          closeSync(child.fd);
        }
        continue;
      }
      if (!entry.isFile()) {
        throw manifestError(`non-regular artifact refused: ${path}`);
      }
      found.push(digestFile(directory, path));
    }
    // Every nested directory's entries are durable before the root manifest
    // can bless the inventory.
    fsyncSync(directory.fd);
  };

  const rootDirectory = openDirectory(rootPath);
  try {
    walk(rootDirectory, '', true);
  } finally {
    closeSync(rootDirectory.fd);
  }
  return {
    files: found.sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    ),
    rootPath,
  };
}

function digestFile(
  parent: PinnedDirectory,
  path: string,
): AttemptManifest['files'][number] {
  const name = path.split('/').at(-1);
  if (name === undefined) {
    throw manifestError(`artifact path is not normalized: ${path}`);
  }
  const fullPath = `${parent.viaPath}/${name}`;
  const initialPathStat = lstatSync(fullPath);
  if (!initialPathStat.isFile()) {
    throw manifestError(`non-regular artifact refused: ${path}`);
  }
  const fd = openSync(fullPath, READ_FILE_FLAGS);
  try {
    const initialFdStat = fstatSync(fd);
    if (
      !initialFdStat.isFile() ||
      !isSameFile(initialPathStat, initialFdStat)
    ) {
      throw manifestError(`artifact changed while it was being read: ${path}`);
    }
    fsyncSync(fd);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      if (bytesRead < 0) {
        throw manifestError(`artifact read failed: ${path}`);
      }
      hash.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
    const finalFdStat = fstatSync(fd);
    const finalPathStat = lstatSync(fullPath);
    if (
      !finalFdStat.isFile() ||
      !isSameFile(initialFdStat, finalFdStat) ||
      !isSameFile(initialFdStat, finalPathStat) ||
      size !== finalFdStat.size
    ) {
      throw manifestError(`artifact changed while it was being read: ${path}`);
    }
    fsyncSync(fd);
    return { path, size, sha256: hash.digest('hex') };
  } finally {
    closeSync(fd);
  }
}

function removeIfPresent(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function syncDirectory(path: string): void {
  const directory = openDirectory(path);
  try {
    fsyncSync(directory.fd);
  } finally {
    closeSync(directory.fd);
  }
}

function cleanupPath(path: string, runDir: string, errors: string[]): void {
  try {
    if (removeIfPresent(path)) syncDirectory(runDir);
  } catch (error: unknown) {
    errors.push(
      `${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
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
    // A new invocation invalidates any old blessing before validation starts.
    if (removeIfPresent(finalPath)) syncDirectory(runDir);
    if (removeIfPresent(stagePath)) syncDirectory(runDir);
    const parsedCampaign = CampaignIdentitySchema.parse(campaign);
    const runId = basename(runDir);
    if (runId.length === 0)
      throw manifestError('run directory has no basename');
    const collected = collectFiles(runDir);
    const files = collected.files;
    const manifest: AttemptManifest = AttemptManifestSchema.parse({
      schema_version: 1,
      run_id: runId,
      campaign: parsedCampaign,
      files,
    });
    fd = openSync(
      stagePath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        NOFOLLOW,
      0o600,
    );
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
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(stagePath, finalPath);
    syncDirectory(collected.rootPath);
  } catch (error: unknown) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the publication error.
      }
    }
    const cleanupErrors: string[] = [];
    cleanupPath(stagePath, runDir, cleanupErrors);
    // Retry invalidating the final even when the initial preflight unlink
    // failed; a stale blessing must never survive a refused invocation.
    cleanupPath(finalPath, runDir, cleanupErrors);
    if (error instanceof RunnerError && cleanupErrors.length === 0) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    const cleanupDetail =
      cleanupErrors.length > 0
        ? `; manifest cleanup failed: ${cleanupErrors.join('; ')}`
        : '';
    throw manifestError(`${reason}${cleanupDetail}`);
  }
}
