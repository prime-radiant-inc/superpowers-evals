import { createHash } from 'node:crypto';
import {
  closeSync,
  type Dirent,
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

export interface AttemptManifestFsOps {
  closeSync(fd: number): void;
  fchmodSync(fd: number, mode: number): void;
  fstatSync(fd: number): Stats;
  fsyncSync(fd: number): void;
  lstatSync(path: string): Stats;
  openSync(path: string, flags: number, mode?: number): number;
  readSync(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): number;
  readdirSync(path: string): Dirent[];
  realpathSync(path: string): string;
  renameSync(oldPath: string, newPath: string): void;
  unlinkSync(path: string): void;
  writeSync(fd: number, buffer: Uint8Array): number;
}

export const ATTEMPT_MANIFEST_FS: AttemptManifestFsOps = {
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync: (path) => readdirSync(path, { withFileTypes: true }),
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync: (fd, buffer) => writeSync(fd, buffer),
};

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

function openDirectory(
  path: string,
  ops: AttemptManifestFsOps,
): PinnedDirectory {
  const fd = ops.openSync(path, READ_DIRECTORY_FLAGS);
  try {
    const stat = ops.fstatSync(fd);
    if (!stat.isDirectory()) {
      throw manifestError(`non-directory artifact path refused: ${path}`);
    }
    return { fd, viaPath: pinnedPath(fd, stat) };
  } catch (error) {
    try {
      ops.closeSync(fd);
    } catch {
      // Preserve the original validation error.
    }
    throw error;
  }
}

function collectFiles(
  runDir: string,
  ops: AttemptManifestFsOps,
): { files: AttemptManifest['files']; rootPath: string } {
  const found: AttemptManifest['files'] = [];
  const rootPath = ops.realpathSync(runDir);

  const walk = (
    directory: PinnedDirectory,
    displayPath: string,
    isRoot: boolean,
  ): void => {
    for (const entry of ops.readdirSync(directory.viaPath)) {
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
        const child = openDirectory(`${directory.viaPath}/${entry.name}`, ops);
        try {
          walk(child, path, false);
          if (
            !isSameFile(
              ops.fstatSync(child.fd),
              ops.lstatSync(`${directory.viaPath}/${entry.name}`),
            )
          ) {
            throw manifestError(
              `artifact directory changed while it was being read: ${path}`,
            );
          }
        } finally {
          ops.closeSync(child.fd);
        }
        continue;
      }
      if (!entry.isFile()) {
        throw manifestError(`non-regular artifact refused: ${path}`);
      }
      found.push(digestFile(directory, path, ops));
    }
    // Every nested directory's entries are durable before the root manifest
    // can bless the inventory.
    ops.fsyncSync(directory.fd);
  };

  const rootDirectory = openDirectory(rootPath, ops);
  try {
    walk(rootDirectory, '', true);
  } finally {
    ops.closeSync(rootDirectory.fd);
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
  ops: AttemptManifestFsOps,
): AttemptManifest['files'][number] {
  const name = path.split('/').at(-1);
  if (name === undefined) {
    throw manifestError(`artifact path is not normalized: ${path}`);
  }
  const fullPath = `${parent.viaPath}/${name}`;
  const initialPathStat = ops.lstatSync(fullPath);
  if (!initialPathStat.isFile()) {
    throw manifestError(`non-regular artifact refused: ${path}`);
  }
  const fd = ops.openSync(fullPath, READ_FILE_FLAGS);
  try {
    const initialFdStat = ops.fstatSync(fd);
    if (
      !initialFdStat.isFile() ||
      !isSameFile(initialPathStat, initialFdStat)
    ) {
      throw manifestError(`artifact changed while it was being read: ${path}`);
    }
    ops.fsyncSync(fd);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let size = 0;
    while (true) {
      const bytesRead = ops.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      if (bytesRead < 0) {
        throw manifestError(`artifact read failed: ${path}`);
      }
      hash.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
    const finalFdStat = ops.fstatSync(fd);
    const finalPathStat = ops.lstatSync(fullPath);
    if (
      !finalFdStat.isFile() ||
      !isSameFile(initialFdStat, finalFdStat) ||
      !isSameFile(initialFdStat, finalPathStat) ||
      size !== finalFdStat.size
    ) {
      throw manifestError(`artifact changed while it was being read: ${path}`);
    }
    ops.fsyncSync(fd);
    return { path, size, sha256: hash.digest('hex') };
  } finally {
    ops.closeSync(fd);
  }
}

function removeIfPresent(path: string, ops: AttemptManifestFsOps): boolean {
  try {
    ops.unlinkSync(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function syncDirectory(path: string, ops: AttemptManifestFsOps): void {
  const directory = openDirectory(path, ops);
  try {
    ops.fsyncSync(directory.fd);
  } finally {
    ops.closeSync(directory.fd);
  }
}

function cleanupPath(
  path: string,
  runDir: string,
  ops: AttemptManifestFsOps,
  errors: string[],
): void {
  try {
    if (removeIfPresent(path, ops)) syncDirectory(runDir, ops);
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
  ops: AttemptManifestFsOps = ATTEMPT_MANIFEST_FS,
): void {
  const stagePath = join(runDir, MANIFEST_STAGE_NAME);
  const finalPath = join(runDir, MANIFEST_NAME);
  let fd: number | null = null;
  let renameAttempted = false;
  try {
    // A new invocation invalidates any old blessing before validation starts.
    if (removeIfPresent(finalPath, ops)) syncDirectory(runDir, ops);
    if (removeIfPresent(stagePath, ops)) syncDirectory(runDir, ops);
    const parsedCampaign = CampaignIdentitySchema.parse(campaign);
    const runId = basename(runDir);
    if (runId.length === 0)
      throw manifestError('run directory has no basename');
    const collected = collectFiles(runDir, ops);
    const files = collected.files;
    const manifest: AttemptManifest = AttemptManifestSchema.parse({
      schema_version: 1,
      run_id: runId,
      campaign: parsedCampaign,
      files,
    });
    fd = ops.openSync(
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
      const written = ops.writeSync(fd, bytes.subarray(offset));
      if (written <= 0) throw manifestError('manifest stage made no progress');
      offset += written;
    }
    ops.fchmodSync(fd, 0o600);
    ops.fsyncSync(fd);
    ops.closeSync(fd);
    fd = null;
    renameAttempted = true;
    ops.renameSync(stagePath, finalPath);
    syncDirectory(collected.rootPath, ops);
  } catch (error: unknown) {
    if (fd !== null) {
      try {
        ops.closeSync(fd);
      } catch {
        // Preserve the publication error.
      }
    }
    const cleanupErrors: string[] = [];
    cleanupPath(stagePath, runDir, ops, cleanupErrors);
    if (renameAttempted) {
      cleanupPath(finalPath, runDir, ops, cleanupErrors);
    }
    if (error instanceof RunnerError && cleanupErrors.length === 0) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    const cleanupDetail =
      cleanupErrors.length > 0
        ? `; manifest cleanup failed: ${cleanupErrors.join('; ')}`
        : '';
    throw manifestError(`${reason}${cleanupDetail}`);
  }
}
