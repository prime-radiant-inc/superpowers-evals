// The frozen campaign document's runtime intake. Schema validity is not
// authenticity: CampaignSchema accepts a document whose digest does not
// match its content, whose campaign_id is unrelated to its digest, and whose
// samples name cells, arms, and refs that do not exist. Dispatch and
// recovery both derive real money from this document — estimates, pools,
// credentials, superpowers refs — so an unauthenticated read turns a
// corrupted or hand-edited file into zero-cost budget proposals and
// empty-string credential lookups.
//
// Every runtime consumer reads through this loader: recompute the digest,
// match it against the recorded identity, and close the document over
// itself. Any violation refuses loudly; nothing is substituted.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Campaign,
  CampaignSchema,
} from '../contracts/campaign/campaign.ts';
import { campaignDigest } from '../contracts/campaign/digest.ts';
import type { JournalEvent } from '../contracts/campaign/journal-events.ts';
import { openJournalRead } from './journal.ts';

export class CampaignDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CampaignDocumentError';
  }
}

const AUDIT =
  'inspect the campaign directory by hand — the frozen document is the membership and pricing authority and nothing may be inferred around it';

function refuse(source: string, detail: string): never {
  throw new CampaignDocumentError(
    `${source} is not an authentic frozen campaign document: ${detail} — refusing (fail-closed); ${AUDIT}`,
  );
}

/** The cell key the document's samples reference: `<comparison_id>:<scenario>`
 *  (the registration ID grammar). */
export function cellKeyOf(cell: { comparison_id: string; scenario: string }) {
  return `${cell.comparison_id}:${cell.scenario}`;
}

/** Authenticate an already-schema-valid document: identity, then closure. */
function authenticate(campaign: Campaign, source: string): Campaign {
  const recomputed = campaignDigest(campaign);
  if (recomputed !== campaign.digest) {
    refuse(
      source,
      `its recorded digest ${campaign.digest} is not the digest of its content (${recomputed}); the document was altered after registration`,
    );
  }
  if (campaign.campaign_id !== campaign.digest) {
    refuse(
      source,
      `campaign_id ${campaign.campaign_id} is not its digest ${campaign.digest} (identity IS the digest)`,
    );
  }

  const surfaceArms = new Set(campaign.execution_surface.map((a) => a.name));
  const refArms = new Set(Object.keys(campaign.refs.superpowers_by_arm));
  const requireArm = (arm: string, named: string): void => {
    if (!surfaceArms.has(arm)) {
      refuse(
        source,
        `${named} names arm ${arm}, absent from execution_surface`,
      );
    }
    if (!refArms.has(arm)) {
      refuse(
        source,
        `${named} names arm ${arm}, absent from refs.superpowers_by_arm`,
      );
    }
  };

  const cellByKey = new Map(campaign.cells.map((c) => [cellKeyOf(c), c]));
  for (const cell of campaign.cells) {
    for (const arm of cell.arms) {
      requireArm(arm, `cell ${cellKeyOf(cell)}`);
      if (cell.estimates_by_arm[arm] === undefined) {
        refuse(
          source,
          `cell ${cellKeyOf(cell)} carries no estimate for its arm ${arm}; a missing estimate is not a zero-cost one`,
        );
      }
    }
  }
  for (const sample of campaign.samples) {
    const cell = cellByKey.get(sample.cell);
    if (cell === undefined) {
      refuse(
        source,
        `sample ${sample.sample_id} belongs to cell ${sample.cell}, which is not a registered cell`,
      );
    }
    if (!cell.arms.includes(sample.arm)) {
      refuse(
        source,
        `sample ${sample.sample_id} carries arm ${sample.arm}, which is not one of cell ${sample.cell}'s arms`,
      );
    }
    requireArm(sample.arm, `sample ${sample.sample_id}`);
  }
  return campaign;
}

/** Parse + authenticate a frozen campaign document from parsed JSON. */
export function parseFrozenCampaign(raw: unknown, source: string): Campaign {
  const parsed = CampaignSchema.safeParse(raw);
  if (!parsed.success) {
    refuse(
      source,
      parsed.error.issues
        .map((i) => `${i.path.join('.')} ${i.message}`)
        .slice(0, 5)
        .join('; '),
    );
  }
  return authenticate(parsed.data, source);
}

/** The identity registration froze OUTSIDE the document: `campaign_opened`
 *  is the journal's first event and it is append-only, so it is the anchor a
 *  hand-edited campaign.json cannot restamp along with itself. Comparing the
 *  document's fields only against each other proves internal consistency,
 *  never that this is still the campaign that opened here. */
function assertAnchoredToJournal(
  campaign: Campaign,
  campaignDir: string,
): void {
  const source = `campaign.json at ${join(campaignDir, 'campaign.json')}`;
  let opened: JournalEvent | undefined;
  let reader: { readEvents(afterSeq?: number): JournalEvent[]; close(): void };
  try {
    reader = openJournalRead(campaignDir);
  } catch (err) {
    throw new CampaignDocumentError(
      `${source} cannot be anchored: its campaign journal is unreadable (${
        err instanceof Error ? err.message : String(err)
      }) — the frozen identity is only trustworthy against the campaign_opened event registration committed; ${AUDIT}`,
    );
  }
  try {
    opened = reader.readEvents(0)[0];
  } finally {
    reader.close();
  }
  if (opened === undefined || opened.type !== 'campaign_opened') {
    refuse(
      source,
      `its journal carries no campaign_opened event (found ${opened?.type ?? '<empty journal>'}), so the published identity has no external anchor`,
    );
  }
  if (opened.payload.digest !== campaign.digest) {
    refuse(
      source,
      `its digest ${campaign.digest} does not match the journal's campaign_opened digest ${opened.payload.digest}; the document was re-stamped after registration`,
    );
  }
  if (opened.payload.campaign_id !== campaign.campaign_id) {
    refuse(
      source,
      `its campaign_id ${campaign.campaign_id} does not match the journal's campaign_opened campaign_id ${opened.payload.campaign_id}`,
    );
  }
}

/** Read + authenticate `<campaignDir>/campaign.json`, then anchor its
 *  identity against the journal registration froze it in. */
export function loadFrozenCampaign(campaignDir: string): Campaign {
  const path = join(campaignDir, 'campaign.json');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new CampaignDocumentError(
      `campaign.json at ${path} could not be read as JSON (${
        err instanceof Error ? err.message : String(err)
      }) — refusing to derive campaign identity or membership from an unreadable document; ${AUDIT}`,
    );
  }
  const campaign = parseFrozenCampaign(raw, `campaign.json at ${path}`);
  assertAnchoredToJournal(campaign, campaignDir);
  return campaign;
}
