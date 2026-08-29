// The frozen document's runtime intake: schema validity is not authenticity.
// A document that parses can still carry a digest that does not match its
// content, an identity unrelated to that digest, or samples naming cells,
// arms, and refs that do not exist — and dispatch derives real money from
// every one of those fields.
import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CampaignDocumentError,
  loadFrozenCampaign,
  parseFrozenCampaign,
} from '../src/campaign/campaign-document.ts';
import { electWriter, initJournalDb } from '../src/campaign/journal.ts';
import type { ProcessIdentityProbe } from '../src/campaign/locks.ts';
import type { Campaign } from '../src/contracts/campaign/campaign.ts';
import { campaignDigest } from '../src/contracts/campaign/digest.ts';
import { FakeClock } from '../src/scheduler/clock.ts';

import { campaignDoc as authenticCampaignDoc } from './campaign-recovery-fixtures.ts';

const LOCAL_IDENTITY: ProcessIdentityProbe = {
  exists: () => 'alive',
  startTimeMs: () => 1,
};

/** The fixture document with `mutate` applied, re-stamped so only the
 *  property under test is broken (unless the test breaks the stamp itself). */
function doc(mutate: (c: Campaign) => void = () => {}): Campaign {
  const c = authenticCampaignDoc();
  mutate(c);
  return c;
}

/** Re-stamp identity = digest after a content edit. */
function stamped(mutate: (c: Campaign) => void): Campaign {
  const c = doc(mutate);
  const digest = campaignDigest(c);
  return { ...c, digest, campaign_id: digest };
}

test('an authentic document loads', () => {
  const c = authenticCampaignDoc();
  expect(parseFrozenCampaign(c, 'fixture').campaign_id).toBe(c.campaign_id);
});

test('a digest that is not the digest of the content refuses', () => {
  const tampered = { ...authenticCampaignDoc() };
  tampered.budget = { ...tampered.budget, usd_all_in: 999_999 };
  expect(() => parseFrozenCampaign(tampered, 'fixture')).toThrow(
    /recorded digest .* is not the digest of its content/,
  );
});

test('a campaign_id that is not the digest refuses (identity IS the digest)', () => {
  const c = { ...authenticCampaignDoc(), campaign_id: 'a'.repeat(64) };
  expect(() => parseFrozenCampaign(c, 'fixture')).toThrow(
    /campaign_id .* is not its digest/,
  );
});

test('a sample belonging to no registered cell refuses — never a zero-cost estimate', () => {
  const c = stamped((d) => {
    d.cells = [];
  });
  expect(() => parseFrozenCampaign(c, 'fixture')).toThrow(
    /belongs to cell .* which is not a registered cell/,
  );
});

test('an arm absent from the execution surface refuses — never an empty credential', () => {
  const c = stamped((d) => {
    d.execution_surface = d.execution_surface.slice(0, 1);
  });
  expect(() => parseFrozenCampaign(c, 'fixture')).toThrow(
    /absent from execution_surface/,
  );
});

test('an arm absent from refs.superpowers_by_arm refuses', () => {
  const c = stamped((d) => {
    d.refs = {
      ...d.refs,
      superpowers_by_arm: { arm_a: d.refs.superpowers_by_arm['arm_a'] ?? null },
    };
  });
  expect(() => parseFrozenCampaign(c, 'fixture')).toThrow(
    /absent from refs\.superpowers_by_arm/,
  );
});

test('a cell missing an estimate for one of its arms refuses', () => {
  const c = stamped((d) => {
    d.cells = d.cells.map((cell) => ({
      ...cell,
      estimates_by_arm: { arm_a: cell.estimates_by_arm['arm_a']! },
    }));
  });
  expect(() => parseFrozenCampaign(c, 'fixture')).toThrow(
    /carries no estimate for its arm/,
  );
});

test('loadFrozenCampaign refuses an unreadable or schema-invalid document', () => {
  const dir = mkdtempSync(join(tmpdir(), 'campdoc-'));
  expect(() => loadFrozenCampaign(dir)).toThrow(CampaignDocumentError);
  writeFileSync(join(dir, 'campaign.json'), '{"schema_version": 1}');
  expect(() => loadFrozenCampaign(dir)).toThrow(CampaignDocumentError);
});

// ---------------------------------------------------------------------------
// The external anchor: identity must match the journal, not just itself
// ---------------------------------------------------------------------------

/** A published campaign dir: journal opened against `doc`, campaign.json
 *  holding whatever `published` says (default: the same document). */
function publishedDir(doc: Campaign, published: Campaign = doc): string {
  const dir = mkdtempSync(join(tmpdir(), 'anchor-'));
  initJournalDb(dir);
  const w = electWriter({
    campaignDir: dir,
    clock: new FakeClock(0),
    identity: LOCAL_IDENTITY,
    campaign: doc,
  });
  w.appendEvent({
    type: 'campaign_opened',
    payload: { campaign_id: doc.campaign_id, digest: doc.digest },
  });
  w.release();
  writeFileSync(join(dir, 'campaign.json'), JSON.stringify(published));
  return dir;
}

test('a document that is internally consistent but re-stamped since publication refuses — identity is anchored to campaign_opened', () => {
  const original = authenticCampaignDoc();
  // A hand edit plus a fresh stamp: self-consistent, and a loader that only
  // compares fields WITHIN the file would accept it under the old directory.
  const edited = {
    ...original,
    budget: { ...original.budget, usd_all_in: 9_999 },
  };
  const restamped: Campaign = {
    ...edited,
    digest: campaignDigest(edited),
    campaign_id: campaignDigest(edited),
  };
  expect(campaignDigest(restamped)).toBe(restamped.digest); // internally sound
  const dir = publishedDir(original, restamped);
  expect(() => loadFrozenCampaign(dir)).toThrow(
    /campaign_opened .* digest|does not match the journal/,
  );
});

test('a campaign dir with no opened journal refuses — there is nothing to anchor against', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anchor-'));
  writeFileSync(
    join(dir, 'campaign.json'),
    JSON.stringify(authenticCampaignDoc()),
  );
  expect(() => loadFrozenCampaign(dir)).toThrow(CampaignDocumentError);
});

test('the published document loads when its identity matches campaign_opened', () => {
  const doc = authenticCampaignDoc();
  expect(loadFrozenCampaign(publishedDir(doc)).campaign_id).toBe(
    doc.campaign_id,
  );
});
