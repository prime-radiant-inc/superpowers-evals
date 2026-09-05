// Authenticate frozen inputs and their registered execution-journal anchor.
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  type Experiment,
  ExperimentSchema,
} from '../contracts/campaign/experiment.ts';
import { experimentDigest } from '../contracts/campaign/experiment-digest.ts';
import {
  type CommittedTransition,
  readProjection,
} from './execution-journal.ts';
import type { CampaignProjection } from './execution-state.ts';

export class CampaignDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CampaignDocumentError';
  }
}

const AUDIT =
  'inspect the campaign directory by hand — the frozen document is the membership and finite-work authority and nothing may be inferred around it';

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
