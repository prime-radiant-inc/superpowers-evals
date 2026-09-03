import { expect, test } from 'bun:test';
import type { ContainerStopper } from '../src/campaign/container-spawner.ts';
import type {
  GroupSignaler,
  SubjectHostProbe,
} from '../src/campaign/dispatcher.ts';
import {
  killJournaledPgids,
  type UnverifiedContainerRecord,
} from '../src/campaign/recovery.ts';
import type { JournalEvent } from '../src/contracts/campaign/journal-events.ts';

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
  signal: GroupSignaler;
  subjectHost: SubjectHostProbe;
} {
  return {
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
