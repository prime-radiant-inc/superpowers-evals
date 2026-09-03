import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CommandResult,
  CommandRunner,
} from '../src/agents/command-runner.ts';
import {
  buildAttemptMounts,
  ContainerAttemptSpawner,
  containerNameForAttempt,
} from '../src/campaign/container-spawner.ts';
import type { CampaignChildSpec } from '../src/campaign/spawn.ts';
import { FakeClock } from '../src/scheduler/clock.ts';

const campaignId = 'c'.repeat(64);
const evalsSha = 'd'.repeat(40);
const imageDigest = `sha256:${'b'.repeat(64)}`;
const containerId = 'f'.repeat(64);

class FakeDocker implements CommandRunner {
  readonly calls: { command: string; args: readonly string[] }[] = [];
  readonly inspect: { value: unknown } = { value: null };
  createdId = containerId;
  startStatus = 0;
  rmStatus = 0;

  run(command: string, args: readonly string[]): CommandResult {
    this.calls.push({ command, args: [...args] });
    if (command !== 'docker') return { status: 0, stdout: '', stderr: '' };
    switch (args[0]) {
      case 'create':
        return { status: 0, stdout: `${this.createdId}\n`, stderr: '' };
      case 'inspect':
        return {
          status: 0,
          stdout: JSON.stringify([this.inspect.value]),
          stderr: '',
        };
      case 'start':
        return { status: this.startStatus, stdout: '', stderr: 'secret=never' };
      case 'rm':
        return {
          status: this.rmStatus,
          stdout: '',
          stderr: 'rm failed=secret',
        };
      default:
        return { status: 0, stdout: '', stderr: '' };
    }
  }
}

function fixture(): {
  readonly runner: FakeDocker;
  readonly spec: CampaignChildSpec;
  readonly expectedMounts: ReturnType<typeof buildAttemptMounts>;
} {
  const attemptDir = mkdtempSync(join(tmpdir(), 'container-spawner-'));
  const expectedMounts = buildAttemptMounts({
    evalsRoot: '/camp/evals',
    gauntletRoot: '/camp/gauntlet',
    binRoot: '/camp/bin',
    superpowersTree: '/camp/superpowers-snapshot',
    attemptDir,
    subjectEnvFile: join(attemptDir, '.stage/subject.env'),
    graderEnvFile: join(attemptDir, '.stage/grader.env'),
    passwdFile: join(attemptDir, '.stage/passwd'),
    groupFile: join(attemptDir, '.stage/group'),
  });
  const attempt = {
    attemptId: 'c1:s:arm_a:r1:a1',
    attemptDir,
    stdoutLog: join(attemptDir, 'stdout.log'),
    stderrLog: join(attemptDir, 'stderr.log'),
    homeDir: join(attemptDir, 'home'),
    entrypoint: '/camp/evals/container/attempt-entrypoint.sh',
    mounts: expectedMounts,
  } as const;
  return {
    runner: new FakeDocker(),
    expectedMounts,
    spec: {
      // The container path intentionally ignores this host command and uses
      // the fixed in-image entrypoint with these dispatcher arguments.
      command: 'bun',
      args: ['/camp/evals/src/cli/index.ts', 'run', 'scenarios/s'],
      cwd: '/camp/evals',
      env: {
        SECRET_SHOULD_NOT_BE_COPIED: 'sk-ant-secret',
        QUORUM_GRADER_API_KEY: 'grader-secret',
      },
      attempt,
    },
  };
}

function makeSpawner(runner: FakeDocker): ContainerAttemptSpawner {
  return new ContainerAttemptSpawner({
    runner,
    clock: new FakeClock(),
    stream: { write: () => {} },
    campaignId,
    campaignDir: '/camp',
    imageRef: 'superpowers-evals:local',
    imageDigest,
    evalsSha,
    bundleDir: '/camp/credential-bundle-secret-path',
    uid: 1000,
    gid: 1000,
  });
}

function inspected(
  attemptId: string,
  mounts: readonly { source: string; target: string; mode: 'ro' | 'rw' }[],
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    Id: containerId,
    Name: `/${containerNameForAttempt(campaignId, attemptId)}`,
    Image: imageDigest,
    Config: {
      Labels: {
        'quorum.campaign_id': campaignId,
        'quorum.attempt_id': attemptId,
        'quorum.evals_sha': evalsSha,
        'quorum.image_digest': imageDigest,
      },
    },
    Mounts: mounts.map((mount) => ({
      Type: 'bind',
      Source: mount.source,
      Destination: mount.target,
      RW: mount.mode === 'rw',
    })),
    ...over,
  };
}

test('creates with pinned digest and immutable identity, verifies, then starts', () => {
  const fx = fixture();
  fx.runner.inspect.value = inspected(
    fx.spec.attempt!.attemptId,
    fx.expectedMounts,
  );

  const child = makeSpawner(fx.runner).spawn(fx.spec);
  const dockerCalls = fx.runner.calls.filter(
    (call) => call.command === 'docker',
  );
  expect(dockerCalls.map((call) => call.args[0])).toEqual([
    'create',
    'inspect',
    'start',
  ]);
  const createArgs = [...dockerCalls[0]!.args];
  const name = containerNameForAttempt(campaignId, fx.spec.attempt!.attemptId);
  expect(createArgs[createArgs.indexOf('--name') + 1]).toBe(name);
  expect(createArgs).toContain(imageDigest);
  expect(createArgs).not.toContain('superpowers-evals:local');
  expect(createArgs).toContain(`quorum.campaign_id=${campaignId}`);
  expect(createArgs).toContain(
    `quorum.attempt_id=${fx.spec.attempt!.attemptId}`,
  );
  expect(createArgs).toContain(`quorum.evals_sha=${evalsSha}`);
  expect(createArgs).toContain(`quorum.image_digest=${imageDigest}`);
  expect(createArgs).toContain('QUORUM_COVERED_BY_LIVE_SPEND_LOCK=1');
  expect(createArgs).not.toContain('sk-ant-secret');
  expect(createArgs).not.toContain('grader-secret');
  expect(createArgs).not.toContain('/camp/credential-bundle-secret-path');
  expect(child.handle).toEqual({
    kind: 'container',
    containerName: name,
    containerId,
    imageDigest,
  });
});

test('rejects a non-canonical create id before trusting it', () => {
  const fx = fixture();
  fx.runner.createdId = 'ABC' as never;
  expect(() => makeSpawner(fx.runner).spawn(fx.spec)).toThrow(/container id/i);
  expect(fx.runner.calls.map((call) => call.args[0])).toEqual(['create']);
});

test('removes the exact container and never starts for every identity mismatch', () => {
  const mismatches: Record<string, unknown>[] = [
    { Id: '0'.repeat(64) },
    { Name: '/wrong-name' },
    { Image: `sha256:${'a'.repeat(64)}` },
    {
      Config: {
        Labels: {
          'quorum.campaign_id': 'wrong-campaign',
        },
      },
    },
    {
      Config: {
        Labels: {
          'quorum.attempt_id': 'other-attempt',
        },
      },
    },
    {
      Config: {
        Labels: {
          'quorum.evals_sha': 'wrong-sha',
        },
      },
    },
    {
      Config: {
        Labels: {
          'quorum.image_digest': `sha256:${'a'.repeat(64)}`,
        },
      },
    },
    {
      Config: {
        Labels: {
          'quorum.campaign_id': campaignId,
          'quorum.attempt_id': 'c1:s:arm_a:r1:a1',
          'quorum.evals_sha': evalsSha,
        },
      },
    },
  ];
  for (const mismatch of mismatches) {
    const fx = fixture();
    fx.runner.inspect.value = inspected(
      fx.spec.attempt!.attemptId,
      fx.expectedMounts,
      mismatch,
    );
    expect(() => makeSpawner(fx.runner).spawn(fx.spec)).toThrow(
      /identity|label|image|name/i,
    );
    expect(fx.runner.calls.map((call) => call.args[0])).toEqual([
      'create',
      'inspect',
      'rm',
    ]);
    expect(fx.runner.calls.at(-1)!.args).toEqual(['rm', containerId]);
  }
});

test('rejects the legacy Target/ReadOnly mount shape as malformed', () => {
  const fx = fixture();
  fx.runner.inspect.value = {
    ...inspected(fx.spec.attempt!.attemptId, fx.expectedMounts),
    Mounts: fx.expectedMounts.map((mount) => ({
      Type: 'bind',
      Source: mount.source,
      Target: mount.target,
      ReadOnly: mount.mode === 'ro',
    })),
  };
  expect(() => makeSpawner(fx.runner).spawn(fx.spec)).toThrow(/mount/i);
  expect(fx.runner.calls.at(-1)!.args).toEqual(['rm', containerId]);
});

test('removes the exact container and never starts for missing, extra, writable, or cross-attempt mounts', () => {
  const fxBase = fixture();
  const expected = fxBase.expectedMounts;
  const cases = [
    expected.slice(1),
    [
      ...expected,
      { source: '/etc/shadow', target: '/leak', mode: 'rw' as const },
    ],
    expected.map((mount, index) =>
      index === 0 ? { ...mount, mode: 'rw' as const } : mount,
    ),
    expected.map((mount, index) =>
      index === 0 ? { ...mount, source: '/camp/attempts/other/source' } : mount,
    ),
    expected.map((mount, index) =>
      index === 0 ? { ...mount, target: '/camp/attempts/other/target' } : mount,
    ),
  ];
  for (const observedMounts of cases) {
    const fx = fixture();
    fx.runner.inspect.value = inspected(
      fx.spec.attempt!.attemptId,
      observedMounts,
    );
    expect(() => makeSpawner(fx.runner).spawn(fx.spec)).toThrow(/mount/i);
    expect(fx.runner.calls.map((call) => call.args[0])).toEqual([
      'create',
      'inspect',
      'rm',
    ]);
    expect(fx.runner.calls.at(-1)!.args).toEqual(['rm', containerId]);
  }
});

test('removes a created container when start fails', () => {
  const fx = fixture();
  fx.runner.inspect.value = inspected(
    fx.spec.attempt!.attemptId,
    fx.expectedMounts,
  );
  fx.runner.startStatus = 1;
  expect(() => makeSpawner(fx.runner).spawn(fx.spec)).toThrow(/start/i);
  expect(fx.runner.calls.map((call) => call.args[0])).toEqual([
    'create',
    'inspect',
    'start',
    'rm',
  ]);
  expect(fx.runner.calls.at(-1)!.args).toEqual(['rm', containerId]);
});

test('reports both the original verification failure and failed exact-ID cleanup', () => {
  const fx = fixture();
  fx.runner.inspect.value = inspected(
    fx.spec.attempt!.attemptId,
    fx.expectedMounts,
    {
      Id: '0'.repeat(64),
    },
  );
  fx.runner.rmStatus = 1;
  expect(() => makeSpawner(fx.runner).spawn(fx.spec)).toThrow(
    /identity.*cleanup|cleanup.*identity/i,
  );
  expect(fx.runner.calls.at(-1)!.args).toEqual(['rm', containerId]);

  const startFx = fixture();
  startFx.runner.inspect.value = inspected(
    startFx.spec.attempt!.attemptId,
    startFx.expectedMounts,
  );
  startFx.runner.startStatus = 1;
  startFx.runner.rmStatus = 1;
  expect(() => makeSpawner(startFx.runner).spawn(startFx.spec)).toThrow(
    /start.*cleanup|cleanup.*start/i,
  );
  expect(startFx.runner.calls.at(-1)!.args).toEqual(['rm', containerId]);
});
