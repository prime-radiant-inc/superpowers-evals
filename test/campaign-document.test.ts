// The frozen document's runtime intake: schema validity is not authenticity.
// A document that parses can still carry a digest that does not match its
// content, an identity unrelated to that digest, or samples naming cells,
// arms, and refs that do not exist — and dispatch derives real money from
// every one of those fields.
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadFrozenCampaign as loadExperiment,
  parseFrozenCampaign as parseExperiment,
} from '../src/campaign/campaign-document.ts';
import {
  ExecutionJournalWriter,
  initExecutionJournal,
} from '../src/campaign/execution-journal.ts';
import type { ProcessIdentityProbe } from '../src/campaign/locks.ts';
import { experimentDigest } from '../src/contracts/campaign/experiment-digest.ts';
import { FakeClock } from '../src/scheduler/clock.ts';
import {
  fixtureTime,
  transition,
  twoArmExperiment,
} from './fixtures/core-comparison/factory.ts';

function authenticExperiment() {
  const draft = twoArmExperiment();
  return {
    ...draft,
    input_digest: experimentDigest(draft),
  };
}

test('a V2 experiment authenticates its input digest', () => {
  const experiment = authenticExperiment();
  expect(parseExperiment(experiment, 'fixture').input_digest).toBe(
    experiment.input_digest,
  );
  expect(() =>
    parseExperiment(
      { ...experiment, credential_authority_digest: '1'.repeat(64) },
      'fixture',
    ),
  ).toThrow(/input digest/);
});

test('a V2 experiment loads only when its registered transition anchors the identity', () => {
  const experiment = authenticExperiment();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'experiment-')));
  initExecutionJournal({ campaignDir: dir, experiment });
  const writer = ExecutionJournalWriter.elect({
    campaignDir: dir,
    experiment,
    clock: new FakeClock(0),
    identity: LOCAL_IDENTITY,
  });
  writer.commitTransition(
    transition('registered', {
      campaign_id: experiment.campaign_id,
      input_digest: experiment.input_digest,
    }),
  );
  writer.release();
  writeFileSync(join(dir, 'campaign.json'), JSON.stringify(experiment));

  expect(loadExperiment(dir).campaign_id).toBe(experiment.campaign_id);

  const foreign = {
    ...experiment,
    campaign_id: 'different-campaign',
    registered_at: fixtureTime(1),
  };
  writeFileSync(join(dir, 'campaign.json'), JSON.stringify(foreign));
  expect(() => loadExperiment(dir)).toThrow(/journal|identity|registered/i);
});

const LOCAL_IDENTITY: ProcessIdentityProbe = {
  exists: () => 'alive',
  startTimeMs: () => 1,
};
