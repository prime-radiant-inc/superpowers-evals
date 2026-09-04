import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStateConfig } from '../../../src/appliance/config.ts';
import {
  ExecutionJournalWriter,
  initExecutionJournal,
} from '../../../src/campaign/execution-journal.ts';
import {
  createBallast,
  DEFAULT_BALLAST_BYTES,
} from '../../../src/campaign/journal.ts';
import { realProcessIdentityProbe } from '../../../src/campaign/locks.ts';
import { experimentDigest } from '../../../src/contracts/campaign/experiment-digest.ts';
import { RealClock } from '../../../src/scheduler/clock.ts';
import { transition, twoArmExperiment } from './factory.ts';
export function lifecycleFixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'campaign-lifecycle-'));
  const campaignDir = join(root, 'campaign');
  mkdirSync(campaignDir);
  const configPath = join(root, 'appliance.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      root,
      evals: { path: process.cwd(), remote: 'origin', ref: 'main' },
      superpowers: { path: root, remote: 'origin' },
      gauntlet: { path: root, remote: 'origin', ref: 'main' },
      credential_bundle: { name: 'blessed', path: join(root, 'unused') },
      container: { name: 'unused', results_root: join(root, 'results') },
      live_spend_lock: join(root, 'live-spend.lock.d'),
    }),
  );
  const loaded = loadStateConfig(configPath, { ensureState: true });
  const experiment = twoArmExperiment();
  experiment.input_digest = experimentDigest(experiment);
  initExecutionJournal({ campaignDir, experiment });
  writeFileSync(join(campaignDir, 'campaign.json'), JSON.stringify(experiment));
  createBallast(campaignDir, DEFAULT_BALLAST_BYTES);
  const elect = () =>
    ExecutionJournalWriter.elect({
      campaignDir,
      experiment,
      clock: new RealClock(),
      identity: realProcessIdentityProbe,
    });
  const writer = elect();
  writer.commitTransition(
    transition('registered', {
      campaign_id: experiment.campaign_id,
      input_digest: experiment.input_digest,
    }),
  );
  writer.release();
  return { root, campaignDir, experiment, loaded, elect, jobId: 'invocation' };
}
