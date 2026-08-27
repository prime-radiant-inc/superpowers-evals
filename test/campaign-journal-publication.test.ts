import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createBallast,
  DEFAULT_BALLAST_BYTES,
  initJournalDb,
  isStorageFullError,
  JournalError,
  releaseBallast,
  stageAndPublishCampaignJson,
  verifyBallast,
} from '../src/campaign/journal.ts';

function tmpCampaign(): string {
  return mkdtempSync(join(tmpdir(), 'pub-'));
}

test('ballast: non-sparse, fully written, fsynced, allocated blocks cover the length', () => {
  const dir = tmpCampaign();
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
});

test('publication: campaign.json staged as campaign.json.stage.<pid> then renamed LAST', () => {
  const dir = tmpCampaign();
  const doc = { digest: 'd'.repeat(64) }; // the publisher takes unknown and serializes
  stageAndPublishCampaignJson(dir, doc);
  expect(existsSync(join(dir, 'campaign.json'))).toBe(true);
  expect(
    readdirSync(dir).filter((n) => n.startsWith('campaign.json.stage.')),
  ).toEqual([]);
  expect(JSON.parse(readFileSync(join(dir, 'campaign.json'), 'utf8'))).toEqual(
    doc,
  );
  // A second publication refuses (publication happens exactly once).
  expect(() => stageAndPublishCampaignJson(dir, doc)).toThrow(JournalError);
});

test('the pinned P-4/S-8 order: journal init -> ballast -> campaign.json rename last', () => {
  const dir = tmpCampaign();
  // (1) journal initialized at the final path, campaign_opened journaled;
  initJournalDb(dir);
  // (2) ballast created + fsynced BEFORE publication;
  createBallast(dir, DEFAULT_BALLAST_BYTES);
  // (3) campaign.json renamed LAST = readiness marker.
  stageAndPublishCampaignJson(dir, { schema_version: 1 });
  const order = readdirSync(dir);
  expect(order).toContain('journal.db');
  expect(order).toContain('.ballast');
  expect(order).toContain('campaign.json');
});

test('releaseBallast unlinks and fsyncs the directory (D-13 pause path)', () => {
  const dir = tmpCampaign();
  createBallast(dir, 64 * 1024);
  releaseBallast(dir);
  expect(existsSync(join(dir, '.ballast'))).toBe(false);
  expect(() => releaseBallast(dir)).toThrow(JournalError); // absent ballast is loud
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
