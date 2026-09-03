import { expect, test } from 'bun:test';
import {
  RunAllocatedEvent,
  readRunAllocatedGrants,
} from '../src/contracts/campaign/journal-events.ts';

const containerId = 'a'.repeat(64);
const imageDigest = `sha256:${'b'.repeat(64)}`;

test('run_allocated container arm round-trips with container identity and grants', () => {
  const parsed = RunAllocatedEvent.parse({
    seq: 1,
    ts_ms: 5,
    type: 'run_allocated',
    payload: {
      attempt_id: 'c1:s:arm_a:r1:a1',
      run_id: 'run-1',
      container_id: containerId,
      image_digest: imageDigest,
      key_grants: [
        { role: 'subject', env: 'SUBJECT_KEY' },
        { role: 'grader', env: 'QUORUM_GRADER_API_KEY' },
      ],
    },
  });
  expect('pgid' in parsed.payload).toBe(false);
  expect(readRunAllocatedGrants(parsed.payload)).toEqual([
    { role: 'subject', env: 'SUBJECT_KEY' },
    { role: 'grader', env: 'QUORUM_GRADER_API_KEY' },
  ]);
});

test('run_allocated container arm rejects malformed identity in every field', () => {
  const base = {
    seq: 1,
    ts_ms: 5,
    type: 'run_allocated' as const,
  };
  // container_id must be a 64-hex docker id
  expect(() =>
    RunAllocatedEvent.parse({
      ...base,
      payload: {
        attempt_id: 'a',
        run_id: 'r',
        container_id: 'XYZ',
        image_digest: imageDigest,
        key_grants: [],
      },
    }),
  ).toThrow();
  // image_digest must be sha256-prefixed
  expect(() =>
    RunAllocatedEvent.parse({
      ...base,
      payload: {
        attempt_id: 'a',
        run_id: 'r',
        container_id: containerId,
        image_digest: 'latest',
        key_grants: [],
      },
    }),
  ).toThrow();
  // the container arm never carries pgid (strict objects discriminate the union)
  expect(() =>
    RunAllocatedEvent.parse({
      ...base,
      payload: {
        attempt_id: 'a',
        run_id: 'r',
        pgid: 42,
        container_id: containerId,
        image_digest: imageDigest,
        key_grants: [],
      },
    }),
  ).toThrow();
  // at most one grant per role
  expect(() =>
    RunAllocatedEvent.parse({
      ...base,
      payload: {
        attempt_id: 'a',
        run_id: 'r',
        container_id: containerId,
        image_digest: imageDigest,
        key_grants: [
          { role: 'subject', env: 'A' },
          { role: 'subject', env: 'B' },
        ],
      },
    }),
  ).toThrow();
});
