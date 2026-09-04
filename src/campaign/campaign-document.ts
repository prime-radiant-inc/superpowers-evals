// Frozen campaign document authentication. Budget-bearing consumers use the
// explicit budgeted loader until cutover. V2 readers validate the strict
// Experiment, recompute its input digest, and anchor its identity to the
// registered execution-journal transition. Any violation refuses loudly.

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  type Campaign,
  CampaignSchema,
} from '../contracts/campaign/campaign.ts';
import { campaignDigest } from '../contracts/campaign/digest.ts';
import {
  type Experiment,
  ExperimentSchema,
} from '../contracts/campaign/experiment.ts';
import { experimentDigest } from '../contracts/campaign/experiment-digest.ts';
import type { JournalEvent } from '../contracts/campaign/journal-events.ts';
import {
  type CommittedTransition,
  readProjection,
} from './execution-journal.ts';
import type { CampaignProjection } from './execution-state.ts';
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
export function parseFrozenBudgetedCampaign(
  raw: unknown,
  source: string,
): Campaign {
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
export function loadFrozenBudgetedCampaign(campaignDir: string): Campaign {
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
  const campaign = parseFrozenBudgetedCampaign(raw, `campaign.json at ${path}`);
  assertAnchoredToJournal(campaign, campaignDir);
  return campaign;
}

/** Parse and authenticate a strict V2 experiment without consulting storage. */
export function parseFrozenCampaign(raw: unknown, source: string): Experiment {
  const parsed = ExperimentSchema.safeParse(raw);
  if (!parsed.success) {
    refuse(
      source,
      parsed.error.issues
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .slice(0, 5)
        .join('; '),
    );
  }
  const observed = experimentDigest(parsed.data);
  if (observed !== parsed.data.input_digest) {
    refuse(
      source,
      `input digest ${parsed.data.input_digest} does not authenticate the experiment (${observed})`,
    );
  }
  return parsed.data;
}

/** Load the sole V2 document and authenticate it against the V2 journal fold. */
export function loadFrozenCampaign(campaignDir: string): Experiment {
  const path = join(campaignDir, 'campaign.json');
  let projection: CampaignProjection;
  try {
    projection = readProjection(campaignDir);
  } catch (error) {
    throw new CampaignDocumentError(
      `campaign.json at ${path} cannot be anchored to its V2 execution journal (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!projection.registered) {
    refuse(
      sourceOf(path),
      'the execution journal has no registered transition',
    );
  }
  return parseFrozenCampaign(projection.experiment, sourceOf(path));
}

function sourceOf(path: string): string {
  return `campaign.json at ${path}`;
}

/** Publish campaign.json last from the exact durable registered receipt. */
export function publishFrozenCampaign(args: {
  campaignDir: string;
  experiment: Experiment;
  registered: CommittedTransition;
}): void {
  const experiment = parseFrozenCampaign(
    args.experiment,
    'registration output',
  );
  const registered = args.registered.transition;
  if (
    args.registered.sequence !== 1 ||
    registered.type !== 'registered' ||
    registered.payload.campaign_id !== experiment.campaign_id ||
    registered.payload.input_digest !== experiment.input_digest
  ) {
    throw new CampaignDocumentError(
      'campaign publication requires the first durable registered transition for this exact experiment',
    );
  }
  const target = join(args.campaignDir, 'campaign.json');
  if (existsSync(target)) {
    throw new CampaignDocumentError(
      `campaign.json already exists at ${target}`,
    );
  }
  const stage = join(args.campaignDir, `campaign.json.stage.${process.pid}`);
  const bytes = Buffer.from(`${JSON.stringify(experiment, null, 2)}\n`);
  let fd: number | undefined;
  try {
    fd = openSync(stage, 'wx', 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error('campaign document short write');
      offset += written;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(stage, target);
    const dirFd = openSync(args.campaignDir, 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(stage);
    } catch {
      /* The stage may already have been renamed or never created. */
    }
    throw new CampaignDocumentError(
      `campaign.json publication failed at ${target}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
