import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContainerStopper } from '../src/campaign/container-spawner.ts';
import type {
  GroupSignaler,
  SubjectHostProbe,
} from '../src/campaign/dispatcher.ts';
import type { ProcessIdentityProbe } from '../src/campaign/locks.ts';
import {
  type CampaignChildProbe,
  cancelCampaign,
  killJournaledPgids,
  type ResumeArgs,
  resumeCampaign,
  type UnverifiedContainerRecord,
} from '../src/campaign/recovery.ts';
import type { JournalEvent } from '../src/contracts/campaign/journal-events.ts';
import { FakeClock } from '../src/scheduler/clock.ts';
import {
  journaledTypes,
  lockDir,
  NO_LIVE_CHILD,
  publishedContainerCampaign,
} from './campaign-recovery-fixtures.ts';

const CAMPAIGN_ID = 'c'.repeat(64);
const ATTEMPT_ID = 'attempt-1';
const RUN_ID = 'run-1';
const CONTAINER_ID = 'a'.repeat(64);
const IMAGE_DIGEST = `sha256:${'b'.repeat(64)}`;

function containerEvent(): JournalEvent {
  return {
    seq: 1,
    ts_ms: 1,
    type: 'run_allocated',
    payload: {
      attempt_id: ATTEMPT_ID,
      run_id: RUN_ID,
      container_name: 'quorum-attempt-campaign-attempt',
      container_id: CONTAINER_ID,
      image_digest: IMAGE_DIGEST,
      key_grants: [],
    },
  } as JournalEvent;
}

function unverifiedRecord(): UnverifiedContainerRecord {
  return {
    attempt_id: ATTEMPT_ID,
    run_id: RUN_ID,
    container_name: 'quorum-attempt-campaign-attempt',
    container_id: CONTAINER_ID,
    image_digest: IMAGE_DIGEST,
  };
}

function noProcessRecoveryProbes(): {
  identity: ProcessIdentityProbe;
  child: CampaignChildProbe;
  signal: GroupSignaler;
  subjectHost: SubjectHostProbe;
} {
  return {
    identity: {
      exists: () => {
        throw new Error('process identity probe must not run for a container');
      },
      startTimeMs: () => {
        throw new Error(
          'process start-time probe must not run for a container',
        );
      },
    },
    child: {
      commandLine: () => {
        throw new Error('campaign-child probe must not run for a container');
      },
    },
    signal: () => {
      throw new Error('process-group probe must not run for a container');
    },
    subjectHost: {
      find: () => {
        throw new Error('subject-host probe must not run for a container');
      },
      kill: () => {
        throw new Error('subject-host kill must not run for a container');
      },
    },
  };
}

function recoveryArgs(
  extra: Partial<Parameters<typeof killJournaledPgids>[0]> = {},
): Parameters<typeof killJournaledPgids>[0] {
  return {
    events: [containerEvent()],
    campaignId: CAMPAIGN_ID,
    resultsRoot: '/results',
    stream: { write: () => {} },
    ...noProcessRecoveryProbes(),
    ...extra,
  };
}

test('recovery stops a journaled container handle through the injected stopper', async () => {
  const stopped: Array<[string, number]> = [];
  const containerStop: ContainerStopper = {
    stop: async (containerId, graceSeconds) => {
      stopped.push([containerId, graceSeconds]);
      return 'dead';
    },
  };

  const report = await killJournaledPgids(
    recoveryArgs({ containerStop, graceSeconds: 7 }),
  );

  expect(stopped).toEqual([[CONTAINER_ID, 7]]);
  expect(report.containersStopped).toEqual([CONTAINER_ID]);
  expect(report.containersSurvived).toEqual([]);
  expect(report.unverifiedContainers).toEqual([]);
});

test('recovery reports a surviving container loudly and never counts it stopped', async () => {
  const loud: string[] = [];
  const containerStop: ContainerStopper = {
    stop: async () => 'alive',
  };

  const report = await killJournaledPgids(
    recoveryArgs({ containerStop, stream: { write: (s) => loud.push(s) } }),
  );

  expect(report.containersStopped).toEqual([]);
  expect(report.containersSurvived).toEqual([CONTAINER_ID]);
  expect(report.unverifiedContainers).toEqual([unverifiedRecord()]);
  expect(loud.join('')).toMatch(/survived stop\+kill/);
  expect(loud.join('')).toMatch(/still spending/);
  expect(loud.join('')).toContain(`attempt ${ATTEMPT_ID}`);
  expect(loud.join('')).toContain(`run ${RUN_ID}`);
  expect(loud.join('')).toContain('quorum-attempt-campaign-attempt');
  expect(loud.join('')).toContain(CONTAINER_ID);
  expect(loud.join('')).toContain(IMAGE_DIGEST);
});

test('recovery without a stopper refuses to verify a container handle loudly', async () => {
  const loud: string[] = [];

  const report = await killJournaledPgids(
    recoveryArgs({ stream: { write: (s) => loud.push(s) } }),
  );

  expect(report.containersStopped).toEqual([]);
  expect(report.containersSurvived).toEqual([]);
  expect(report.unverifiedContainers).toEqual([unverifiedRecord()]);
  expect(loud.join('')).toMatch(/no container stopper injected/);
  expect(loud.join('')).toMatch(/recorded, not verified/);
  expect(loud.join('')).toContain(`attempt ${ATTEMPT_ID}`);
  expect(loud.join('')).toContain(`run ${RUN_ID}`);
  expect(loud.join('')).toContain('quorum-attempt-campaign-attempt');
  expect(loud.join('')).toContain(CONTAINER_ID);
  expect(loud.join('')).toContain(IMAGE_DIGEST);
});

test('recovery propagates a container stopper failure instead of classifying death', async () => {
  const containerStop: ContainerStopper = {
    stop: async () => {
      throw new Error('docker unavailable');
    },
  };

  await expect(
    killJournaledPgids(recoveryArgs({ containerStop })),
  ).rejects.toThrow('docker unavailable');
});

function resumeFixtureArgs(
  dir: string,
  containerStop: ContainerStopper,
  lockName: string,
): ResumeArgs {
  return {
    campaignDir: dir,
    credentials: {},
    evalsCheckout: dir,
    gauntletCheckout: dir,
    superpowersCheckout: dir,
    clock: new FakeClock(1),
    identity: NO_LIVE_CHILD,
    lockPath: lockDir(lockName),
    stream: { write: () => {} },
    containerStop,
  };
}

function aliveContainerStopper(ids: string[]): ContainerStopper {
  return {
    stop: async (containerId) => {
      ids.push(containerId);
      return 'alive';
    },
  };
}

test('resume forwards the container stopper and refuses before journal mutation when the container survives', async () => {
  const { dir } = publishedContainerCampaign();
  const before = journaledTypes(dir, 2);
  const stopped: string[] = [];

  await expect(
    resumeCampaign(
      resumeFixtureArgs(
        dir,
        aliveContainerStopper(stopped),
        'container-resume-forward.d',
      ),
    ),
  ).rejects.toThrow(/container.*could not be verified dead/i);

  expect(stopped).toEqual(['a'.repeat(64)]);
  expect(journaledTypes(dir, 2)).toEqual(before);
});

test('resume forwards the container stopper through cancel-request precedence', async () => {
  const { dir } = publishedContainerCampaign();
  writeFileSync(join(dir, 'cancel-request'), '1\noperator test\n');
  const before = journaledTypes(dir, 2);
  const stopped: string[] = [];

  await expect(
    resumeCampaign(
      resumeFixtureArgs(
        dir,
        aliveContainerStopper(stopped),
        'container-resume-cancel-forward.d',
      ),
    ),
  ).rejects.toThrow(/cancellation could not complete/i);

  expect(stopped).toEqual(['a'.repeat(64)]);
  expect(journaledTypes(dir, 2)).toEqual(before);
});

test('direct post-crash cancel forwards the container stopper and refuses terminal mutation when the container survives', async () => {
  const { dir } = publishedContainerCampaign();
  const before = journaledTypes(dir, 2);
  const stopped: string[] = [];

  const result = await cancelCampaign({
    campaignDir: dir,
    reason: 'operator test',
    clock: new FakeClock(1),
    identity: NO_LIVE_CHILD,
    lockPath: lockDir('container-cancel-forward.d'),
    stream: { write: () => {} },
    containerStop: aliveContainerStopper(stopped),
  });

  expect(result).toEqual({ cancelled: false, postCrash: true });
  expect(stopped).toEqual(['a'.repeat(64)]);
  expect(journaledTypes(dir, 2)).toEqual(before);
});
