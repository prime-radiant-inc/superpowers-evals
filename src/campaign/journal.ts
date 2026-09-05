// Durable filesystem primitives shared by the execution journal and publication.
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
export const JOURNAL_DB_FILENAME = 'journal.db';
export const JOURNAL_LEASE_DIR = 'journal.lease.d';
export const DEFAULT_BALLAST_BYTES = 8 * 1024 * 1024;
export class JournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalError';
  }
}
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
export interface JournalFsOps {
  /** O_EXCL create: refuses if the path already exists. */
  openExclusive(path: string): number;
  /** Read-only open (file or directory). */
  openRead(path: string): number;
  close(fd: number): void;
  /** Bytes actually written — a short write must never be fsynced as
   *  success, so every caller loops until the whole buffer has landed. */
  write(fd: number, data: string | Buffer): number;
  fsync(fd: number): void;
  rename(from: string, to: string): void;
  /** Hard-link `from` onto `to`. Atomic AND EEXIST-respecting: unlike
   *  rename it refuses when `to` exists, so it publishes a fully-written
   *  file under a name that is exclusively created. */
  link(from: string, to: string): void;
  unlink(path: string): void;
  stat(path: string): { size: number; blocks: number };
  exists(path: string): boolean;
}

export const journalFsOps: JournalFsOps = {
  openExclusive: (path) => openSync(path, 'wx'),
  openRead: (path) => openSync(path, 'r'),
  close: closeSync,
  write: (fd, data) =>
    typeof data === 'string' ? writeSync(fd, data) : writeSync(fd, data),
  fsync: fsyncSync,
  rename: renameSync,
  link: linkSync,
  unlink: unlinkSync,
  stat: (path) => statSync(path),
  exists: existsSync,
};

/** Write every byte before anyone fsyncs: a partial write fsynced as success
 *  is a torn record presented as durable. Zero forward progress refuses
 *  rather than spinning (contention.ts's sidecar writer, same discipline).
 *
 *  The retry slices BYTES, not JS code units: a short write that lands
 *  mid-character would otherwise resume from the wrong offset and reach the
 *  expected byte count with corrupted content. */
function writeFull(
  fsOps: JournalFsOps,
  fd: number,
  data: string,
  path: string,
): void {
  const bytes = Buffer.from(data, 'utf8');
  let written = 0;
  while (written < bytes.length) {
    const n = fsOps.write(fd, bytes.subarray(written));
    if (!Number.isFinite(n) || n <= 0) {
      throw new JournalError(
        `short write on ${path} (${written} of ${bytes.length} bytes, no forward progress) — refusing to fsync a torn record`,
      );
    }
    written += n;
  }
}

/** Best-effort failure-path cleanup whose own failure is REPORTED, never
 * swallowed (no silent drops): null on success, the underlying error
 * message on failure so the refusal can carry it. */
function cleanupUnlink(fsOps: JournalFsOps, path: string): string | null {
  try {
    fsOps.unlink(path);
    return null;
  } catch (err) {
    return errorMessage(err);
  }
}

/** Decision D-13 ballast: physically allocated, operator-visible, created +
 *  fsynced BEFORE campaign.json publication. Non-sparse: open exclusively,
 *  write non-zero buffers through the entire length (never truncate-only),
 *  fsync the file, verify allocated blocks cover the length, then fsync the
 *  campaign directory. Failure or an unverifiable allocation refuses
 *  publication. */
export function createBallast(
  campaignDir: string,
  sizeBytes: number,
  fsOps: JournalFsOps = journalFsOps,
): void {
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    throw new JournalError(
      `ballast size must be a positive integer of bytes, got ${sizeBytes} — a zero/fractional reserve reserves nothing (Decision D-13 requires physically allocated bytes)`,
    );
  }
  const path = join(campaignDir, '.ballast');
  let fd: number;
  try {
    fd = fsOps.openExclusive(path); // O_EXCL: never overwrite an existing ballast
  } catch (err) {
    throw new JournalError(
      `ballast already exists or cannot be created at ${path}: ${errorMessage(err)} — verify the existing reserve (verifyBallast) instead of recreating, or clear the path and retry registration`,
    );
  }
  try {
    try {
      const chunk = Buffer.alloc(64 * 1024, 0xba); // non-zero
      let written = 0;
      while (written < sizeBytes) {
        const want = Math.min(chunk.length, sizeBytes - written);
        // A short write must never be fsynced as a full reserve.
        const n = fsOps.write(fd, chunk.subarray(0, want));
        if (!Number.isFinite(n) || n <= 0) {
          throw new JournalError(
            `short write on ${path} (${written} of ${sizeBytes} bytes, no forward progress) — refusing to fsync a partial reserve`,
          );
        }
        written += n;
      }
      fsOps.fsync(fd); // durable BEFORE the allocation check
    } finally {
      fsOps.close(fd);
    }
  } catch (err) {
    const cleanup = cleanupUnlink(fsOps, path);
    throw new JournalError(
      `ballast write/fsync failed at ${path}: ${errorMessage(err)}` +
        (cleanup
          ? `; removing the failed ballast also failed (${cleanup}) — delete ${path} by hand`
          : '') +
        ` — free space on the campaign volume, then retry registration (fail-closed: no ballast, no publication)`,
    );
  }
  if (!verifyBallast(campaignDir, sizeBytes, fsOps)) {
    const cleanup = cleanupUnlink(fsOps, path);
    throw new JournalError(
      `ballast allocation unverifiable at ${path} (sparse or short filesystem?) — refusing publication (fail-closed)` +
        (cleanup
          ? `; removing the invalid ballast also failed (${cleanup}) — delete ${path} by hand`
          : '') +
        `; free space on the campaign volume or use a qualified non-sparse filesystem, then retry registration`,
    );
  }
  try {
    fsyncDir(campaignDir, fsOps);
  } catch (err) {
    throw new JournalError(
      `ballast created and verified at ${path} but the directory fsync failed: ${errorMessage(err)} — fsync the campaign directory by hand, verify (verifyBallast), then publish`,
    );
  }
}

/** Zero (or anything non-positive / non-integral) is never a valid reserve
 *  size: a zero-byte file verifies nothing even though `size === 0` would
 *  trivially match, so the request itself refuses. */
export function verifyBallast(
  campaignDir: string,
  sizeBytes: number,
  fsOps: JournalFsOps = journalFsOps,
): boolean {
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) return false;
  try {
    const st = fsOps.stat(join(campaignDir, '.ballast'));
    return st.size === sizeBytes && st.blocks * 512 >= sizeBytes;
  } catch {
    return false;
  }
}

/** D-13 pause step 3: release the ballast (unlink, fsync dir) so the freed
 *  blocks land the pause evidence. Absence is loud (the reserve was already
 *  spent; callers preserve their own storage-interruption evidence). */
export function releaseBallast(
  campaignDir: string,
  fsOps: JournalFsOps = journalFsOps,
): void {
  const path = join(campaignDir, '.ballast');
  if (!fsOps.exists(path)) {
    throw new JournalError(
      `no ballast to release at ${path} — the reserve was already spent; cannot release the same emergency reserve twice`,
    );
  }
  try {
    fsOps.unlink(path);
  } catch (err) {
    throw new JournalError(
      `cannot release the ballast at ${path}: ${errorMessage(err)} — clear the path (or remount the volume writable), then retry the pause; the pause evidence must land in the freed blocks`,
    );
  }
  try {
    fsyncDir(campaignDir, fsOps);
  } catch (err) {
    throw new JournalError(
      `ballast unlinked at ${path} but the directory fsync failed: ${errorMessage(err)} — fsync the campaign directory before writing pause evidence (D-13 step 3 is not durable yet)`,
    );
  }
}

/** Create a crash-consistency marker durably. The D-13 storage-paused marker
 *  and the D-12 cancel-request marker are each the ONLY durable record of a
 *  decision at the moment they are written, and every caller blesses
 *  whatever it finds at the final path — so the final NAME must be created
 *  atomically, exclusively, and only ever complete.
 *
 *  Stage into a unique name in the same directory (O_EXCL), write every byte
 *  (a short write is never fsynced as success), fsync the file, then publish
 *  with `link(2)`: it is atomic, it REFUSES with EEXIST when the final name
 *  already exists, and the bytes it publishes are already durable. Rename
 *  would be atomic but not exclusive — two concurrent cancels would let the
 *  second silently replace the first operator's reason. Finally fsync the
 *  directory and drop the temp.
 *
 *  Once the link lands the operation has SUCCEEDED: the record exists and is
 *  complete, so no failure path may ever unlink the final name. A failure
 *  BEFORE the link leaves no final name and at most an inert temp, which no
 *  caller reads.
 *
 *  EEXIST semantics are unchanged for callers: presence-is-the-record stays
 *  their arm to take, and what they bless is now always complete. */
export function createDurableMarker(
  path: string,
  body: string,
  fsOps: JournalFsOps = journalFsOps,
): void {
  const stage = `${path}.stage.${process.pid}.${randomBytes(4).toString('hex')}`;
  const fd = fsOps.openExclusive(stage);
  let published = false;
  try {
    try {
      writeFull(fsOps, fd, body, stage);
      fsOps.fsync(fd);
    } finally {
      fsOps.close(fd);
    }
    // The exclusive, atomic publication. EEXIST rides out to the caller
    // untouched — an existing marker is another writer's completed record.
    fsOps.link(stage, path);
    published = true;
    // The new directory entry is only durable once the directory is.
    fsyncDir(dirname(path), fsOps);
  } catch (err) {
    // The final name is NEVER removed here: either it was never created, or
    // the link succeeded and it is a complete record — someone's, possibly
    // another writer's.
    const tempFailure = fsOps.exists(stage)
      ? cleanupUnlink(fsOps, stage)
      : null;
    if (published) {
      throw new JournalError(
        `durable marker ${path} was published but its directory entry could not be fsynced (${errorMessage(err)}) — the marker itself is complete and has been left in place; re-run the operation to confirm it (the EEXIST arm will bless it)` +
          (tempFailure === null
            ? ''
            : `; removing the temp ${stage} also failed (${tempFailure})`),
      );
    }
    throw err instanceof Error && (err as { code?: string }).code === 'EEXIST'
      ? err // the caller's presence-is-the-record arm owns this
      : new JournalError(
          `durable marker ${path} could not be written (${errorMessage(err)}) — the final name was never created, so nothing reads a partial marker back as a durable record` +
            (tempFailure === null
              ? ''
              : `; removing the temp ${stage} also failed (${tempFailure}) — delete it by hand`),
        );
  }
  // Best effort: a leftover temp is inert debris, never a failure.
  cleanupUnlink(fsOps, stage);
}

/** D-13 step-1 detection predicate: a storage-full failure from either
 *  store — SQLITE_FULL from a bun:sqlite commit, or ENOSPC from an fs write
 *  (the sampler's sidecar append plausibly hits the full volume first).
 *  Matched by error `code` first, message shape as the fallback (bun:sqlite
 *  surfaces "database or disk is full"). Production callers: the
 *  dispatcher's appendCritical and its sampler onSampleError hook (task 8),
 *  both entering performStoragePause. */
export function isStorageFullError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = 'code' in err ? err.code : undefined;
  if (code === 'SQLITE_FULL' || code === 'ENOSPC') return true;
  const message = 'message' in err ? err.message : undefined;
  return (
    typeof message === 'string' &&
    /SQLITE_FULL|database or disk is full|ENOSPC/.test(message)
  );
}

export function fsyncDir(
  dir: string,
  fsOps: JournalFsOps = journalFsOps,
): void {
  const fd = fsOps.openRead(dir);
  try {
    fsOps.fsync(fd);
  } finally {
    fsOps.close(fd);
  }
}
