import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  runAllChildEnvironment,
  validatePreparedAttemptAuthority,
} from '../src/campaign/child-authority.ts';
import {
  acquireLiveSpendLock,
  realProcessIdentityProbe,
} from '../src/campaign/locks.ts';
import {
  jcsCanonicalize,
  sha256Hex,
} from '../src/contracts/campaign/digest.ts';
import { envSnapshot } from '../src/env.ts';
import { RealClock } from '../src/scheduler/clock.ts';
import {
  blockActivation,
  twoArmExperiment,
} from './fixtures/core-comparison/factory.ts';

function authority() {
  const intent = blockActivation(twoArmExperiment()).attempts[0]!;
  intent.runtime_spec.public_env.QUORUM_ATTEMPT_AUTHORITY_FILE =
    '/run/quorum/attempt-authority.json';
  intent.runtime_spec.mounts.push({
    source: '/private/control/authority.json',
    target: '/run/quorum/attempt-authority.json',
    mode: 'ro',
  });
  intent.runtime_spec_digest = sha256Hex(jcsCanonicalize(intent.runtime_spec));
  return {
    schema_version: 1,
    campaign_id: intent.identity.campaign_id,
    input_digest: 'a'.repeat(64),
    start_id: 'start',
    intent,
  };
}
const mountInfo =
  '52 31 0:50 /authority.json /run/quorum/attempt-authority.json ro,relatime - ext4 /dev/root rw\n';
test('exact private authority binds CLI identity, runtime digest and read-only file mount', () => {
  const doc = authority();
  const read = {
    readDocument: () => JSON.stringify(doc),
    readMountInfo: () => mountInfo,
  };
  expect(
    validatePreparedAttemptAuthority(doc.intent.identity, read).start_id,
  ).toBe('start');
  expect(() =>
    validatePreparedAttemptAuthority(
      { ...doc.intent.identity, execution_attempt_id: 'forged' },
      read,
    ),
  ).toThrow();
  expect(() =>
    validatePreparedAttemptAuthority(doc.intent.identity, {
      ...read,
      readMountInfo: () => mountInfo.replace(' ro,relatime ', ' rw,relatime '),
    }),
  ).toThrow();
  doc.intent.runtime_spec.public_env.QUORUM_ATTEMPT_AUTHORITY_FILE =
    '/tmp/forged';
  doc.intent.runtime_spec_digest = sha256Hex(
    jcsCanonicalize(doc.intent.runtime_spec),
  );
  expect(() =>
    validatePreparedAttemptAuthority(doc.intent.identity, read),
  ).toThrow();
});

test('a parent lease authorizes only its direct child and expires when released', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'child-authority-'));
  const lockPath = join(root, 'live.lock.d');
  const lease = acquireLiveSpendLock({
    lockPath,
    clock: new RealClock(),
    identity: realProcessIdentityProbe,
  });
  try {
    const env = runAllChildEnvironment(lease);
    const module = resolve('src/campaign/child-authority.ts');
    const source = `import { authorizeCoveredChild } from ${JSON.stringify(module)}; authorizeCoveredChild();`;
    const options = {
      encoding: 'utf8' as const,
      env: { ...envSnapshot(), ...env, QUORUM_LIVE_SPEND_LOCK: lockPath },
      timeout: 10000,
    };
    expect(spawnSync(process.execPath, ['-e', source], options).status).toBe(0);
    lease.release();
    expect(
      spawnSync(process.execPath, ['-e', source], options).status,
    ).not.toBe(0);
  } finally {
    lease.release();
    rmSync(root, { recursive: true, force: true });
  }
});

const unsafeAuthorityLayouts: {
  name: string;
  modify: (doc: ReturnType<typeof authority>) => void;
}[] = [
  {
    name: 'authority source is inside writable attempt output',
    modify(doc) {
      doc.intent.runtime_spec.mounts[1]!.source =
        `${doc.intent.output_root}/authority.json`;
    },
  },
  {
    name: 'authority source equals writable attempt output',
    modify(doc) {
      doc.intent.runtime_spec.mounts[1]!.source = doc.intent.output_root;
    },
  },
  {
    name: 'a writable directory mount exposes the authority source through another target',
    modify(doc) {
      doc.intent.runtime_spec.mounts.push({
        source: '/private/control',
        target: '/work/control',
        mode: 'rw',
      });
    },
  },
  {
    name: 'a writable file mount aliases the exact authority source',
    modify(doc) {
      doc.intent.runtime_spec.mounts.push({
        source: '/private/control/authority.json',
        target: '/work/authority.json',
        mode: 'rw',
      });
    },
  },
  {
    name: 'the authority target equals writable attempt output',
    modify(doc) {
      doc.intent.output_root = '/run/quorum/attempt-authority.json';
    },
  },
  {
    name: 'multiple declared authority mounts make the source ambiguous',
    modify(doc) {
      doc.intent.runtime_spec.mounts.push({
        source: '/private/other/authority.json',
        target: '/run/quorum/attempt-authority.json',
        mode: 'ro',
      });
    },
  },
];
for (const { name, modify } of unsafeAuthorityLayouts) {
  test(`private authority refuses when ${name}`, () => {
    const doc = authority();
    modify(doc);
    doc.intent.runtime_spec_digest = sha256Hex(
      jcsCanonicalize(doc.intent.runtime_spec),
    );
    expect(() =>
      validatePreparedAttemptAuthority(doc.intent.identity, {
        readDocument: () => JSON.stringify(doc),
        readMountInfo: () => mountInfo,
      }),
    ).toThrow();
  });
}

test('a source with a shared string prefix outside writable path segments stays private', () => {
  const doc = authority();
  doc.intent.runtime_spec.mounts[1]!.source =
    `${doc.intent.output_root}-control/authority.json`;
  doc.intent.runtime_spec.mounts.push({
    source: `${doc.intent.output_root}-controls`,
    target: '/work/other',
    mode: 'rw',
  });
  doc.intent.runtime_spec_digest = sha256Hex(
    jcsCanonicalize(doc.intent.runtime_spec),
  );
  expect(
    validatePreparedAttemptAuthority(doc.intent.identity, {
      readDocument: () => JSON.stringify(doc),
      readMountInfo: () => mountInfo,
    }).start_id,
  ).toBe('start');
});
