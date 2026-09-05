import { expect, test } from 'bun:test';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  createBallast,
  createDurableMarker,
  isStorageFullError,
  JournalError,
  type JournalFsOps,
  releaseBallast,
  verifyBallast,
} from '../src/campaign/journal.ts';

function tmpCampaign(): string {
  return mkdtempSync(join(tmpdir(), 'pub-'));
}

/** Real-fs ops that record the durable operation ORDER (the seam carries the
 *  fiction; every call still hits the real filesystem). */

test('createDurableMarker: the final name only ever appears complete — staged, fsynced, then LINKED (atomic and exclusive)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'marker-'));
  const { ops, calls } = recordedOps();
  createDurableMarker(join(dir, '.storage-paused'), 'why\n', ops);
  // The EEXIST guard's existence probe is not part of the durable order.
  const durable = calls.filter((c) => !c.startsWith('exists:'));
  const staged = durable[0]!.replace('open-wx:', '');
  expect(staged).toMatch(/^\.storage-paused\.stage\./);
  expect(durable).toEqual([
    `open-wx:${staged}`,
    `write:${staged}`,
    `fsync:${staged}`,
    `close:${staged}`,
    `link:${staged}->.storage-paused`,
    `open-r:${basename(dir)}`,
    `fsync:${basename(dir)}`,
    `close:${basename(dir)}`,
    `unlink:${staged}`,
  ]);
  expect(readFileSync(join(dir, '.storage-paused'), 'utf8')).toBe('why\n');
  // No stage debris survives a successful create.
  expect(readdirSync(dir)).toEqual(['.storage-paused']);
});

test('createDurableMarker: process death mid-create leaves only a STAGE name, which never blesses anything', () => {
  const dir = mkdtempSync(join(tmpdir(), 'marker-'));
  const marker = join(dir, 'cancel-request');
  const { ops } = recordedOps();
  // Death after the staged bytes are fsynced but before the rename: the
  // final name must not exist, and the stage debris must not be mistaken
  // for it.
  expect(() =>
    createDurableMarker(marker, 'why\n', {
      ...ops,
      link: () => {
        throw new Error('process died before the link');
      },
    }),
  ).toThrow();
  expect(existsSync(marker)).toBe(false);
  // A later create still succeeds and is the one that counts.
  createDurableMarker(marker, 'real\n');
  expect(readFileSync(marker, 'utf8')).toBe('real\n');
});

test('createDurableMarker: a short write is never fsynced as success', () => {
  const dir = mkdtempSync(join(tmpdir(), 'marker-'));
  const marker = join(dir, '.storage-paused');
  const { ops } = recordedOps();
  let fsynced = 0;
  let accepted = 0;
  expect(() =>
    createDurableMarker(marker, 'a much longer body than lands\n', {
      ...ops,
      write: (fd, data) => {
        // The volume takes one byte, then stops accepting: forward progress
        // ends and the remaining bytes never land.
        if (accepted > 0) return 0;
        const buf = typeof data === 'string' ? Buffer.from(data) : data;
        accepted = ops.write(fd, buf.subarray(0, 1));
        return accepted;
      },
      fsync: (fd) => {
        fsynced += 1;
        ops.fsync(fd);
      },
    }),
  ).toThrow(/short write|no forward progress/);
  expect(fsynced).toBe(0); // a torn record is never made durable
  expect(existsSync(marker)).toBe(false);
});

test('createDurableMarker: cleanup failure still refuses, and still leaves no final name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'marker-'));
  const marker = join(dir, '.storage-paused');
  const { ops } = recordedOps();
  expect(() =>
    createDurableMarker(marker, 'why\n', {
      ...ops,
      fsync: () => {
        throw new Error('fsync failed');
      },
      unlink: () => {
        throw new Error('cannot remove the temp either');
      },
    }),
  ).toThrow(/cannot remove the temp either/);
  // Whatever debris remains, it is NOT the final name.
  expect(existsSync(marker)).toBe(false);
});

test('createDurableMarker: a creation that fails mid-way leaves NO final name — the next attempt is not handed a blessed residue', () => {
  const dir = mkdtempSync(join(tmpdir(), 'marker-'));
  const marker = join(dir, '.storage-paused');
  const failAt = (stage: 'write' | 'fsync'): JournalFsOps => {
    const { ops } = recordedOps();
    return {
      ...ops,
      write: (fd, data) => {
        if (stage === 'write') throw new Error('volume went read-only');
        return ops.write(fd, data);
      },
      fsync: (fd) => {
        if (stage === 'fsync') throw new Error('fsync failed');
        ops.fsync(fd);
      },
    };
  };
  // A marker is the ONLY durable record of its decision, and every caller's
  // EEXIST arm blesses whatever it finds at the final path. A half-written
  // one must therefore never appear there.
  // Only the stages BEFORE the link: once the link lands the record exists
  // and is complete, which is the success arm (covered separately).
  for (const stage of ['write', 'fsync'] as const) {
    expect(() => createDurableMarker(marker, 'why\n', failAt(stage))).toThrow();
    expect(existsSync(marker)).toBe(false);
  }
  // …and a clean creation afterwards still works.
  createDurableMarker(marker, 'why\n');
  expect(readFileSync(marker, 'utf8')).toBe('why\n');
});

test("createDurableMarker: two concurrent creators — exactly one wins, the loser gets EEXIST, and the winner's bytes survive", () => {
  const dir = mkdtempSync(join(tmpdir(), 'marker-'));
  const marker = join(dir, 'cancel-request');
  const { ops } = recordedOps();
  let raced = false;
  let loser: unknown = null;
  // B runs to completion inside A's window, right where A is about to
  // publish the final name. Only an atomic, EEXIST-respecting create keeps
  // A from replacing B's operator reason (POSIX rename would overwrite it).
  try {
    createDurableMarker(marker, 'A reason\n', {
      ...ops,
      link: (from, to) => {
        if (!raced) {
          raced = true;
          createDurableMarker(marker, 'B reason\n');
        }
        ops.link(from, to);
      },
    });
  } catch (err) {
    loser = err;
  }
  expect(raced).toBe(true);
  expect((loser as { code?: string } | null)?.code).toBe('EEXIST');
  // B got there first, so B's reason is what the operator reads back.
  expect(readFileSync(marker, 'utf8')).toBe('B reason\n');
  expect(readdirSync(dir).filter((n) => !n.includes('.stage.'))).toEqual([
    'cancel-request',
  ]);
});

test('createDurableMarker: a short write splitting a multi-byte character never corrupts the content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'marker-'));
  const marker = join(dir, 'cancel-request');
  const { ops } = recordedOps();
  // An operator reason with non-ASCII in it. A retry loop that counts UTF-8
  // bytes but slices JS code units re-sends the wrong tail and lands the
  // expected byte COUNT with corrupted content.
  const body = '1730000000000\nannulé — coût dépassé ✂\n';
  let first = true;
  createDurableMarker(marker, body, {
    ...ops,
    write: (fd, data) => {
      if (!first) return ops.write(fd, data);
      first = false;
      // The volume takes 5 bytes — landing mid-character.
      const buf = typeof data === 'string' ? Buffer.from(data) : data;
      return ops.write(fd, buf.subarray(0, 5));
    },
  });
  expect(readFileSync(marker, 'utf8')).toBe(body);
});

test('createDurableMarker: death after the final link is SUCCESS — the marker is complete and stays blessed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'marker-'));
  const marker = join(dir, '.storage-paused');
  const { ops } = recordedOps();
  // The link landed, so the record exists and is complete; only its
  // directory entry is unconfirmed. Cleanup must never take it away.
  expect(() =>
    createDurableMarker(marker, 'why\n', {
      ...ops,
      openRead: (p) => {
        if (p === dir) throw new Error('died before the directory fsync');
        return ops.openRead(p);
      },
    }),
  ).toThrow();
  expect(existsSync(marker)).toBe(true);
  expect(readFileSync(marker, 'utf8')).toBe('why\n');
  // …and the caller's EEXIST arm still blesses it.
  expect(() => createDurableMarker(marker, 'other\n')).toThrow(
    expect.objectContaining({ code: 'EEXIST' }),
  );
});

test('createDurableMarker: death mid-link leaves no final name and only inert temp debris', () => {
  const dir = mkdtempSync(join(tmpdir(), 'marker-'));
  const marker = join(dir, '.storage-paused');
  const { ops } = recordedOps();
  expect(() =>
    createDurableMarker(marker, 'why\n', {
      ...ops,
      link: () => {
        throw new Error('died during the link');
      },
    }),
  ).toThrow();
  expect(existsSync(marker)).toBe(false);
  // Whatever debris remains is a stage name, which no caller reads.
  expect(readdirSync(dir).every((n) => n.includes('.stage.'))).toBe(true);
  createDurableMarker(marker, 'real\n');
  expect(readFileSync(marker, 'utf8')).toBe('real\n');
});

test('createDurableMarker: a temp-removal failure never touches the final name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'marker-'));
  const marker = join(dir, 'cancel-request');
  const { ops } = recordedOps();
  createDurableMarker(marker, 'kept\n', {
    ...ops,
    unlink: () => {
      throw new Error('cannot remove the temp');
    },
  });
  // The publication succeeded; the temp is inert debris, not a failure.
  expect(readFileSync(marker, 'utf8')).toBe('kept\n');
});

test('createDurableMarker: an existing marker refuses (O_EXCL) — callers own the EEXIST arm', () => {
  const dir = mkdtempSync(join(tmpdir(), 'marker-'));
  createDurableMarker(join(dir, 'cancel-request'), 'first\n');
  expect(() =>
    createDurableMarker(join(dir, 'cancel-request'), 'second\n'),
  ).toThrow();
  expect(readFileSync(join(dir, 'cancel-request'), 'utf8')).toBe('first\n');
});

function recordedOps(): { ops: JournalFsOps; calls: string[] } {
  const calls: string[] = [];
  const fdNames = new Map<number, string>();
  const name = (fd: number) => fdNames.get(fd) ?? String(fd);
  const ops: JournalFsOps = {
    openExclusive: (path) => {
      calls.push(`open-wx:${basename(path)}`);
      const fd = openSync(path, 'wx');
      fdNames.set(fd, basename(path));
      return fd;
    },
    openRead: (path) => {
      calls.push(`open-r:${basename(path)}`);
      const fd = openSync(path, 'r');
      fdNames.set(fd, basename(path));
      return fd;
    },
    close: (fd) => {
      calls.push(`close:${name(fd)}`);
      closeSync(fd);
    },
    write: (fd, data) => {
      calls.push(`write:${name(fd)}`);
      return typeof data === 'string'
        ? writeSync(fd, data)
        : writeSync(fd, data);
    },
    fsync: (fd) => {
      calls.push(`fsync:${name(fd)}`);
      fsyncSync(fd);
    },
    rename: (from, to) => {
      calls.push(`rename:${basename(from)}->${basename(to)}`);
      renameSync(from, to);
    },
    link: (from, to) => {
      calls.push(`link:${basename(from)}->${basename(to)}`);
      linkSync(from, to);
    },
    unlink: (path) => {
      calls.push(`unlink:${basename(path)}`);
      unlinkSync(path);
    },
    stat: (path) => {
      calls.push(`stat:${basename(path)}`);
      return statSync(path);
    },
    exists: (path) => {
      calls.push(`exists:${basename(path)}`);
      return existsSync(path);
    },
  };
  return { ops, calls };
}

test('ballast: non-sparse, fully written, fsynced, allocated blocks cover the length', () => {
  const dir = tmpCampaign();
  try {
    createBallast(dir, 64 * 1024);
    const path = join(dir, '.ballast');
    const st = statSync(path);
    expect(st.size).toBe(64 * 1024);
    // Non-sparse: allocated 512-byte blocks cover the length.
    expect(st.blocks * 512).toBeGreaterThanOrEqual(64 * 1024);
    // Content is non-zero buffers (never truncate-only).
    const body = readFileSync(path);
    expect(body.some((b) => b !== 0)).toBe(true);
    expect(verifyBallast(dir, 64 * 1024)).toBe(true);
    expect(verifyBallast(dir, 128 * 1024)).toBe(false); // wrong size refuses
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ballast: non-positive or non-integer size refuses without creating a file', () => {
  const dir = tmpCampaign();
  try {
    for (const bad of [0, -1, 4096.5]) {
      expect(() => createBallast(dir, bad)).toThrow(JournalError);
    }
    // A reserve of zero/fractional bytes reserves nothing — nothing is created.
    expect(existsSync(join(dir, '.ballast'))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fs-ops order: releaseBallast unlinks then fsyncs the directory (D-13 pause path)', () => {
  const dir = tmpCampaign();
  try {
    createBallast(dir, 64 * 1024);
    const { ops, calls } = recordedOps();
    releaseBallast(dir, ops);
    const dirName = basename(dir);
    expect(calls).toEqual([
      'exists:.ballast',
      'unlink:.ballast',
      `open-r:${dirName}`,
      `fsync:${dirName}`, // the freed name is durable before evidence lands
      `close:${dirName}`,
    ]);
    expect(existsSync(join(dir, '.ballast'))).toBe(false);
    expect(() => releaseBallast(dir)).toThrow(JournalError); // absent ballast is loud
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isStorageFullError: SQLITE_FULL and ENOSPC shapes match; anything else does not (D-13 detection)', () => {
  expect(
    isStorageFullError(
      Object.assign(new Error('commit failed'), { code: 'SQLITE_FULL' }),
    ),
  ).toBe(true);
  expect(
    isStorageFullError(
      Object.assign(new Error('write failed'), { code: 'ENOSPC' }),
    ),
  ).toBe(true);
  expect(isStorageFullError(new Error('database or disk is full'))).toBe(true); // bun:sqlite message shape
  expect(
    isStorageFullError(
      Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' }),
    ),
  ).toBe(false);
  expect(isStorageFullError(new Error('locked'))).toBe(false);
  expect(isStorageFullError(null)).toBe(false);
  expect(isStorageFullError('ENOSPC')).toBe(false); // a bare string is not an error shape
});
