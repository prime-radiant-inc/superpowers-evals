import { expect, test } from 'bun:test';
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  createBallast,
  createDurableMarker,
  DEFAULT_BALLAST_BYTES,
  electWriter,
  initJournalDb,
  isStorageFullError,
  JOURNAL_DB_FILENAME,
  JournalError,
  type JournalFsOps,
  releaseBallast,
  stageAndPublishCampaignJson,
  verifyBallast,
} from '../src/campaign/journal.ts';
import type { ProcessIdentityProbe } from '../src/campaign/locks.ts';
import { FakeClock } from '../src/scheduler/clock.ts';

class LocalIdentity implements ProcessIdentityProbe {
  exists(): 'alive' {
    return 'alive';
  }
  startTimeMs(): number {
    return 1; // stable local birth — single-process tests
  }
}

/** The registration reality the publication gate requires: journal.db
 *  initialized AND a committed campaign_opened event (journaled before the
 *  campaign.json rename, with no frozen campaign document yet). */
function openJournal(dir: string): void {
  initJournalDb(dir);
  const w = electWriter({
    campaignDir: dir,
    clock: new FakeClock(1),
    identity: new LocalIdentity(),
  });
  w.appendEvent({
    type: 'campaign_opened',
    payload: { campaign_id: 'c1', digest: 'd'.repeat(64) },
  });
  w.release();
}

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

test('publication: gate refuses without journal + ballast readiness; valid path staged then renamed LAST', () => {
  const dir = tmpCampaign();
  try {
    const doc = { digest: 'd'.repeat(64) }; // the publisher takes unknown and serializes
    // Readiness gate (D-7/P-4/S-8 enforced by the primitive, not the caller):
    // no journal.db, no ballast -> refuse before touching the filesystem.
    expect(() => stageAndPublishCampaignJson(dir, doc)).toThrow(JournalError);
    expect(existsSync(join(dir, 'campaign.json'))).toBe(false);
    expect(
      readdirSync(dir).filter((n) => n.startsWith('campaign.json.stage.')),
    ).toEqual([]);
    // Ballast alone is not readiness: the journal must exist at the final path.
    createBallast(dir, DEFAULT_BALLAST_BYTES);
    expect(() => stageAndPublishCampaignJson(dir, doc)).toThrow(JournalError);
    expect(existsSync(join(dir, 'campaign.json'))).toBe(false);
    // An EMPTY journal.db is not an initialized journal (reviewer probe).
    writeFileSync(join(dir, JOURNAL_DB_FILENAME), '');
    expect(() => stageAndPublishCampaignJson(dir, doc)).toThrow(JournalError);
    expect(existsSync(join(dir, 'campaign.json'))).toBe(false);
    // A CORRUPT journal.db is not an initialized journal either.
    writeFileSync(join(dir, JOURNAL_DB_FILENAME), 'definitely not sqlite');
    expect(() => stageAndPublishCampaignJson(dir, doc)).toThrow(JournalError);
    expect(existsSync(join(dir, 'campaign.json'))).toBe(false);
    // Schema without the committed campaign_opened event is not readiness
    // (clear the corrupt journal first — initJournalDb refuses to touch it).
    rmSync(join(dir, JOURNAL_DB_FILENAME));
    initJournalDb(dir);
    expect(() => stageAndPublishCampaignJson(dir, doc)).toThrow(JournalError);
    expect(existsSync(join(dir, 'campaign.json'))).toBe(false);
    // Valid path: initialized journal (campaign_opened committed) + ballast.
    openJournal(dir);
    // A ballast of the wrong size is not the reserve the publisher expects.
    // Asserted only once every OTHER readiness precondition holds, so the
    // refusal can come from the ballast gate and nothing earlier.
    expect(() => stageAndPublishCampaignJson(dir, doc, 64 * 1024)).toThrow(
      JournalError,
    );
    expect(existsSync(join(dir, 'campaign.json'))).toBe(false);
    stageAndPublishCampaignJson(dir, doc);
    expect(existsSync(join(dir, 'campaign.json'))).toBe(true);
    expect(
      readdirSync(dir).filter((n) => n.startsWith('campaign.json.stage.')),
    ).toEqual([]);
    expect(
      JSON.parse(readFileSync(join(dir, 'campaign.json'), 'utf8')),
    ).toEqual(doc);
    // A second publication refuses (publication happens exactly once).
    expect(() => stageAndPublishCampaignJson(dir, doc)).toThrow(JournalError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('publication: non-JSON payload refuses with nothing staged (serialize before open)', () => {
  const dir = tmpCampaign();
  try {
    openJournal(dir);
    createBallast(dir, 64 * 1024);
    // JSON.stringify(undefined) -> undefined: previously staged "undefined\n".
    expect(() =>
      stageAndPublishCampaignJson(dir, undefined, 64 * 1024),
    ).toThrow(JournalError);
    // Circular reference: stringify throws — previously AFTER the stage open.
    const loop: Record<string, unknown> = { self: null };
    loop['self'] = loop;
    expect(() => stageAndPublishCampaignJson(dir, loop, 64 * 1024)).toThrow(
      JournalError,
    );
    // Neither refusal leaves stage debris or a published marker.
    expect(
      readdirSync(dir).filter((n) => n.startsWith('campaign.json.stage.')),
    ).toEqual([]);
    expect(existsSync(join(dir, 'campaign.json'))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('publication: a stale stage file from a crashed attempt refuses loudly, never overwrites', () => {
  const dir = tmpCampaign();
  try {
    openJournal(dir);
    createBallast(dir, 64 * 1024);
    const stale = join(dir, `campaign.json.stage.${process.pid}`);
    writeFileSync(stale, 'torn');
    expect(() =>
      stageAndPublishCampaignJson(dir, { ok: true }, 64 * 1024),
    ).toThrow(/stale|remove/i);
    expect(readFileSync(stale, 'utf8')).toBe('torn'); // untouched
    expect(existsSync(join(dir, 'campaign.json'))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the pinned P-4/S-8 order: journal init -> ballast -> campaign.json rename last', () => {
  const dir = tmpCampaign();
  try {
    openJournal(dir); // (1) journal initialized + campaign_opened committed;
    // (2) ballast created + fsynced BEFORE publication;
    createBallast(dir, DEFAULT_BALLAST_BYTES);
    // (3) campaign.json renamed LAST = readiness marker.
    stageAndPublishCampaignJson(dir, { schema_version: 1 });
    const order = readdirSync(dir);
    expect(order).toContain('journal.db');
    expect(order).toContain('.ballast');
    expect(order).toContain('campaign.json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fs-ops order: ballast fsync precedes publication; stage write -> fsync -> rename LAST -> dir fsync', () => {
  const dir = tmpCampaign();
  try {
    openJournal(dir);
    const { ops, calls } = recordedOps();
    createBallast(dir, 64 * 1024, ops);
    stageAndPublishCampaignJson(dir, { schema_version: 1 }, 64 * 1024, ops);
    const stage = `campaign.json.stage.${process.pid}`;
    const dirName = basename(dir);
    expect(calls).toEqual([
      'open-wx:.ballast',
      'write:.ballast',
      'fsync:.ballast', // durable BEFORE the allocation check
      'close:.ballast',
      'stat:.ballast', // non-sparse/size verification
      `open-r:${dirName}`, // dir fsync after ballast creation
      `fsync:${dirName}`,
      `close:${dirName}`,
      'exists:campaign.json', // publication gate: once-only
      'exists:journal.db', // publication gate: journal readiness
      'stat:.ballast', // publication gate: reserve integrity
      `open-wx:${stage}`,
      `write:${stage}`,
      `fsync:${stage}`,
      `close:${stage}`,
      `rename:${stage}->campaign.json`, // rename LAST
      `open-r:${dirName}`, // dir fsync after the publication rename
      `fsync:${dirName}`,
      `close:${dirName}`,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyBallast and publication refuse a zero-byte reserve outright', () => {
  const dir = tmpCampaign();
  try {
    createBallast(dir, 64 * 1024);
    // Zero is never a valid expected reserve — not even against a real ballast.
    expect(verifyBallast(dir, 0)).toBe(false);
    expect(verifyBallast(dir, -1)).toBe(false);
    // A zero-byte file is not a reserve, so verifying size 0 must refuse too.
    rmSync(join(dir, '.ballast'));
    writeFileSync(join(dir, '.ballast'), '');
    expect(verifyBallast(dir, 0)).toBe(false);
    // Publication against a zero reserve refuses before staging anything.
    openJournal(dir);
    rmSync(join(dir, '.ballast')); // clear the zero-byte stand-in first
    createBallast(dir, 64 * 1024);
    expect(() => stageAndPublishCampaignJson(dir, { ok: 1 }, 0)).toThrow(
      JournalError,
    );
    expect(existsSync(join(dir, 'campaign.json'))).toBe(false);
    expect(
      readdirSync(dir).filter((n) => n.startsWith('campaign.json.stage.')),
    ).toEqual([]);
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

test('fs-ops order: publication refused before readiness touches no write/rename ops', () => {
  const dir = tmpCampaign();
  try {
    mkdirSync(dir, { recursive: true }); // empty: no journal, no ballast
    const { ops, calls } = recordedOps();
    expect(() =>
      stageAndPublishCampaignJson(dir, { x: 1 }, 64 * 1024, ops),
    ).toThrow(JournalError);
    expect(calls).toEqual(['exists:campaign.json', 'exists:journal.db']);
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
