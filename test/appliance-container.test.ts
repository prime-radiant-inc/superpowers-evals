import { expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from '../src/agents/command-runner.ts';
import {
  type ContainerLease,
  dockerExecEnvFileSupport,
  evalsContainerPath,
  type RecordedLifecycleOperation,
  reconcileScopedContainer,
  requireDockerExecEnvFile,
  runInLeasedContainer,
  runRecordedContainerLifecycle,
  scopedExecContainerArgs,
  scopedUpContainerArgs,
} from '../src/appliance/container.ts';
import {
  type EmptyStagedCredentialMaterial,
  type LiveActiveCredentialMaterial,
  type LiveStagedCredentialMaterial,
  type StagedCredentialMaterial,
  stageLiveCredentialMaterial,
  stageProbeCredentialMaterial,
} from '../src/appliance/credential-scope.ts';
import { ApplianceError } from '../src/appliance/errors.ts';
import type {
  LoadedApplianceConfig,
  LoadedApplianceStateConfig,
} from '../src/appliance/types.ts';
import {
  EMPTY_CREDENTIAL_SCOPE,
  type LiveCredentialScope,
} from '../src/credentials/scope.ts';

const CURRENT_ID =
  'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

class FakeRunner implements CommandRunner {
  calls: {
    command: string;
    args: readonly string[];
    options?: CommandOptions;
  }[] = [];

  inspectId: string | null = CURRENT_ID;
  inspectStatus = 0;
  execResult: CommandResult = { status: 0, stdout: '', stderr: '' };

  run(
    command: string,
    args: readonly string[],
    options?: CommandOptions,
  ): CommandResult {
    this.calls.push(
      options === undefined ? { command, args } : { command, args, options },
    );
    if (
      command === 'docker' &&
      args[0] === 'container' &&
      args[1] === 'inspect'
    ) {
      if (this.inspectStatus !== 0 || this.inspectId === null) {
        return { status: 1, stdout: '', stderr: 'no such container\n' };
      }
      return {
        status: 0,
        stdout: JSON.stringify([{ Id: this.inspectId, Image: 'img-1' }]),
        stderr: '',
      };
    }
    if (command === 'docker' && args[0] === 'exec') {
      return this.execResult;
    }
    return { status: 0, stdout: '', stderr: '' };
  }
}

// A structural state config literal — the recorded lifecycle primitive must
// compile and run against a value that carries NO bundle metadata at all.
function stateLoaded(): LoadedApplianceStateConfig {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'appliance-cont-')));
  return {
    configPath: join(root, 'appliance.json'),
    config: {
      root,
      evals: { path: join(root, 'evals'), remote: 'origin', ref: 'main' },
      superpowers: { path: join(root, 'superpowers'), remote: 'origin' },
      gauntlet: { path: join(root, 'gauntlet'), remote: 'origin', ref: 'main' },
      credential_bundle: {
        name: 'blessed',
        path: join(root, 'credentials/blessed'),
      },
      container: {
        name: 'quorum-appliance',
        results_root: join(root, 'evals/results'),
      },
    },
    paths: {
      jobs: join(root, 'state/jobs'),
      locks: join(root, 'state/locks'),
      provenance: join(root, 'state/provenance'),
    },
  };
}

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

test('current-ID probe issues exactly one inspect and one fixed docker exec', () => {
  const loaded = stateLoaded();
  const runner = new FakeRunner();
  runner.execResult = { status: 0, stdout: '', stderr: '' };

  const result = runRecordedContainerLifecycle(
    loaded,
    runner,
    { name: 'quorum-appliance', id: CURRENT_ID },
    'probe-process-group',
    456,
  );

  expect(result.status).toBe(0);
  expect(runner.calls).toEqual([
    { command: 'docker', args: ['container', 'inspect', 'quorum-appliance'] },
    {
      command: 'docker',
      args: ['exec', CURRENT_ID, 'bash', '-c', 'kill -0 -- -456'],
    },
  ]);
});

test('current-ID interrupt issues the fixed SIGINT exec against the immutable id', () => {
  const loaded = stateLoaded();
  const runner = new FakeRunner();

  runRecordedContainerLifecycle(
    loaded,
    runner,
    { name: 'quorum-appliance', id: CURRENT_ID },
    'interrupt-process-group',
    456,
  );

  expect(runner.calls[1]).toEqual({
    command: 'docker',
    args: ['exec', CURRENT_ID, 'bash', '-c', 'kill -INT -- -456'],
  });
  // No bundle, env-file, mount, or wrapper arguments anywhere near this seam.
  for (const call of runner.calls) {
    expect(call.command).toBe('docker');
    expect(call.args.join(' ')).not.toContain('--env-file');
    expect(call.args.join(' ')).not.toContain('--auth');
    expect(call.args.join(' ')).not.toContain('evals-container');
    expect(call.options).toBeUndefined();
  }
});

test('a replacement container id is refused after inspect with no exec', () => {
  const loaded = stateLoaded();
  const runner = new FakeRunner();
  runner.inspectId = 'replacement-id';

  const caught = captureError(() =>
    runRecordedContainerLifecycle(
      loaded,
      runner,
      { name: 'quorum-appliance', id: CURRENT_ID },
      'interrupt-process-group',
      456,
    ),
  );

  expect(caught).toBeInstanceOf(ApplianceError);
  expect(runner.calls).toHaveLength(1);
  expect(runner.calls[0]?.args).toEqual([
    'container',
    'inspect',
    'quorum-appliance',
  ]);
});

test('a missing or uninspectable configured container is refused with no exec', () => {
  const loaded = stateLoaded();
  const runner = new FakeRunner();
  runner.inspectStatus = 1;

  const caught = captureError(() =>
    runRecordedContainerLifecycle(
      loaded,
      runner,
      { name: 'quorum-appliance', id: CURRENT_ID },
      'probe-process-group',
      456,
    ),
  );

  expect(caught).toBeInstanceOf(ApplianceError);
  expect(runner.calls).toHaveLength(1);
});

test('invalid identity, pgid, or operation is refused before any runner call', () => {
  const loaded = stateLoaded();
  const invalid: {
    name: string;
    id: string;
    op: RecordedLifecycleOperation;
    pgid: number;
  }[] = [
    // Blank and whitespace-only recorded IDs.
    { name: 'quorum-appliance', id: '', op: 'probe-process-group', pgid: 456 },
    {
      name: 'quorum-appliance',
      id: '   ',
      op: 'interrupt-process-group',
      pgid: 456,
    },
    // Recorded/configured name mismatch.
    {
      name: 'other-container',
      id: CURRENT_ID,
      op: 'probe-process-group',
      pgid: 456,
    },
    // Unsafe process group ids.
    {
      name: 'quorum-appliance',
      id: CURRENT_ID,
      op: 'probe-process-group',
      pgid: 0,
    },
    {
      name: 'quorum-appliance',
      id: CURRENT_ID,
      op: 'probe-process-group',
      pgid: 1,
    },
    {
      name: 'quorum-appliance',
      id: CURRENT_ID,
      op: 'interrupt-process-group',
      pgid: -456,
    },
    {
      name: 'quorum-appliance',
      id: CURRENT_ID,
      op: 'probe-process-group',
      pgid: 456.5,
    },
    {
      name: 'quorum-appliance',
      id: CURRENT_ID,
      op: 'probe-process-group',
      pgid: Number.NaN,
    },
    {
      name: 'quorum-appliance',
      id: CURRENT_ID,
      op: 'interrupt-process-group',
      pgid: Number.POSITIVE_INFINITY,
    },
    // A cast unknown operation fails the runtime-exhaustive switch.
    {
      name: 'quorum-appliance',
      id: CURRENT_ID,
      op: 'kill-everything' as RecordedLifecycleOperation,
      pgid: 456,
    },
  ];

  for (const { name, id, op, pgid } of invalid) {
    const runner = new FakeRunner();
    const caught = captureError(() =>
      runRecordedContainerLifecycle(loaded, runner, { name, id }, op, pgid),
    );
    expect(caught).toBeInstanceOf(ApplianceError);
    expect((caught as ApplianceError).code).toBe('config_invalid');
    expect(runner.calls).toHaveLength(0);
  }
});

// --- scoped container primitives (F13 Task 3) -------------------------------

const SCOPED_ID =
  'c0ffee0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

interface ScopedFixture {
  readonly root: string;
  readonly loaded: LoadedApplianceConfig;
  readonly bundleDir: string;
  readonly scopedRoot: string;
  readonly stagingDir: string;
  readonly activeDir: string;
  readonly recoveryDir: string;
}

// Canonical (realpath) fixture root mirroring the credential-scope test
// fixture: every boundary walk is no-follow and macOS tmpdir traverses /var
// symlinks. Optional relative overrides build the hostile-topology variants.
function makeScopedFixture(
  overrides: { readonly evals?: string; readonly bundle?: string } = {},
): ScopedFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'appliance-scont-')));
  const evalsRel = overrides.evals ?? 'evals';
  const bundleRel = overrides.bundle ?? 'credentials/blessed';
  for (const dir of [
    `${evalsRel}/results`,
    'superpowers',
    'gauntlet',
    bundleRel,
    'state',
  ]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  const bundleDir = join(root, bundleRel);
  const loaded: LoadedApplianceConfig = {
    configPath: join(root, 'appliance.json'),
    config: {
      root,
      evals: { path: join(root, evalsRel), remote: 'origin', ref: 'main' },
      superpowers: { path: join(root, 'superpowers'), remote: 'origin' },
      gauntlet: { path: join(root, 'gauntlet'), remote: 'origin', ref: 'main' },
      credential_bundle: { name: 'blessed', path: bundleDir },
      container: {
        name: 'quorum-appliance',
        results_root: join(root, evalsRel, 'results'),
      },
    },
    bundle: {
      bundle_id: 'blessed-x',
      rotated_at: '2026-06-18T00:00:00Z',
      providers: [],
      note: '',
    },
    paths: {
      jobs: join(root, 'state/jobs'),
      locks: join(root, 'state/locks'),
      provenance: join(root, 'state/provenance'),
    },
  };
  const scopedRoot = join(root, 'state/credentials-scoped');
  return {
    root,
    loaded,
    bundleDir,
    scopedRoot,
    stagingDir: join(scopedRoot, 'staging'),
    activeDir: join(scopedRoot, 'active'),
    recoveryDir: join(scopedRoot, 'recovery'),
  };
}

const SCOPED_ENV_LINES: readonly string[] = [
  "ANTHROPIC_API_KEY='agent-anthropic-key'",
  "GEMINI_API_KEY='agent-gemini-key'",
  "COPILOT_GITHUB_TOKEN='agent-copilot-token'",
  "GH_TOKEN='agent-gh-token'",
  "OPENAI_API_KEY='agent-openai-key'",
  "QUORUM_GRADER_ANTHROPIC_API_KEY='grader-anthropic-key'",
  "QUORUM_GRADER_ANTHROPIC_BASE_URL='https://gateway.example/v1'",
  "HTTPS_PROXY='http://proxy.example:8080'",
];

function writeScopedTree(base: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const path = join(base, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
}

// The container-side destination the wrapper mounts each projected auth
// name at (kimi deliberately maps to /auth/kimi-code).
const AUTH_MOUNT_DEST: Readonly<Record<string, string>> = {
  codex: '/auth/codex',
  gemini: '/auth/gemini',
  kimi: '/auth/kimi-code',
  pi: '/auth/pi',
};

interface FakeInspectMount {
  readonly Type: 'bind';
  readonly Source: string;
  readonly Destination: string;
  readonly RW: boolean;
}

// The mount topology a correct scoped up produces: the active agent env file
// read-only at /run/evals/credentials.env plus each asserted auth directory
// read-only at its fixed destination.
function scopedInspectMounts(spec: {
  readonly envFile: string;
  readonly auth?: readonly { name: string; path: string }[];
  readonly extra?: readonly FakeInspectMount[];
}): FakeInspectMount[] {
  const mounts: FakeInspectMount[] = [
    {
      Type: 'bind',
      Source: spec.envFile,
      Destination: '/run/evals/credentials.env',
      RW: false,
    },
  ];
  for (const mount of spec.auth ?? []) {
    mounts.push({
      Type: 'bind',
      Source: mount.path,
      Destination: AUTH_MOUNT_DEST[mount.name] ?? `/auth/${mount.name}`,
      RW: false,
    });
  }
  mounts.push(...(spec.extra ?? []));
  return mounts;
}

function envOnlyMounts(fx: ScopedFixture): FakeInspectMount[] {
  return scopedInspectMounts({
    envFile: join(fx.activeDir, 'agent.env'),
  });
}

function geminiLiveMounts(fx: ScopedFixture): FakeInspectMount[] {
  return scopedInspectMounts({
    envFile: join(fx.activeDir, 'agent.env'),
    auth: [{ name: 'gemini', path: join(fx.activeDir, 'auth/gemini') }],
  });
}

function seedGeminiBundle(fx: ScopedFixture, salt = ''): void {
  writeScopedTree(fx.bundleDir, {
    'metadata.json': JSON.stringify({
      bundle_id: 'blessed-x',
      rotated_at: '2026-06-18T00:00:00Z',
      providers: [],
    }),
    'credentials.env': `${SCOPED_ENV_LINES.join('\n')}\n`,
    'gemini/oauth_creds.json': JSON.stringify({
      access_token: `gem-access${salt}`,
      refresh_token: `gem-refresh${salt}`,
    }),
    'gemini/google_accounts.json': JSON.stringify({
      accounts: [{ email: 'user@example.com' }],
    }),
  });
}

const GEMINI_OAUTH_SCOPE: LiveCredentialScope = {
  schemaVersion: 1,
  kind: 'live',
  agent: 'gemini',
  runtimeFamily: 'gemini',
  credential: 'gemini_cred',
  agentEnv: [],
  geminiAuthType: 'oauth-personal',
  oauth: { kind: 'gemini', mountName: 'gemini' },
};

// Same agent/credential/mount as GEMINI_OAUTH_SCOPE but the Antigravity
// projector: identical mount name, disjoint projected file set. Used to
// prove a same-mount cross-scope swap cannot pass the boundary.
const ANTIGRAVITY_SAME_MOUNT_SCOPE: LiveCredentialScope = {
  schemaVersion: 1,
  kind: 'live',
  agent: 'gemini',
  runtimeFamily: 'gemini',
  credential: 'gemini_cred',
  agentEnv: [],
  geminiAuthType: null,
  oauth: { kind: 'antigravity', mountName: 'gemini' },
};

const KIMI_OAUTH_SCOPE: LiveCredentialScope = {
  schemaVersion: 1,
  kind: 'live',
  agent: 'kimi',
  runtimeFamily: 'kimi',
  credential: 'kimi_cred',
  agentEnv: [],
  geminiAuthType: null,
  oauth: { kind: 'kimi', mountName: 'kimi' },
};

function piScope(provider: string): LiveCredentialScope {
  return {
    schemaVersion: 1,
    kind: 'live',
    agent: 'pi',
    runtimeFamily: 'pi',
    credential: 'pi_cred',
    agentEnv: [],
    geminiAuthType: null,
    oauth: { kind: 'pi', mountName: 'pi', provider },
  };
}

// Two api-key scopes that differ ONLY in agentEnv (same agent, credential,
// destinations): identical trees, so any signature difference is attributable
// to the agentEnv projection alone.
function agentEnvKeyScope(destination: string): LiveCredentialScope {
  return {
    schemaVersion: 1,
    kind: 'live',
    agent: 'probe-agent',
    runtimeFamily: 'probe-family',
    credential: 'probe_cred',
    agentEnv: [{ destinationName: destination, sourceNames: [destination] }],
    geminiAuthType: null,
    oauth: null,
  };
}

// A bundle carrying every OAuth delivery class so cross-scope and provider
// binding can be exercised on one fixture. Every value is a unique marker,
// distinct from every grader alias value in SCOPED_ENV_LINES.
function seedSharedAuthBundle(fx: ScopedFixture): void {
  writeScopedTree(fx.bundleDir, {
    'metadata.json': JSON.stringify({
      bundle_id: 'blessed-x',
      rotated_at: '2026-06-18T00:00:00Z',
      providers: [],
    }),
    'credentials.env': `${SCOPED_ENV_LINES.join('\n')}\n`,
    'gemini/oauth_creds.json': JSON.stringify({
      access_token: 'gem-access',
      refresh_token: 'gem-refresh',
    }),
    'gemini/google_accounts.json': JSON.stringify({
      accounts: [{ email: 'user@example.com' }],
    }),
    'gemini/antigravity-cli/antigravity-oauth-token': 'agy-marker-token\n',
    'kimi-code/config.toml': 'model = "kimi"\n',
    'kimi-code/credentials/kimi-code.json': JSON.stringify({
      token: 'kimi-creds-marker',
    }),
    'kimi-code/oauth/kimi-code': 'kimi-oauth-marker\n',
    'pi/agent/auth.json': JSON.stringify({
      'openai-codex': { token: 'pi-codex-marker' },
      anthropic: { token: 'pi-anthropic-marker' },
    }),
  });
}

// Full recursive fingerprint (paths, kinds, modes, bytes) used to prove the
// cleanup path never touched a slot.
function fingerprintTree(dir: string): string {
  const lines: string[] = [];
  const record = (path: string, rel: string): void => {
    const stats = lstatSync(path);
    const kind = stats.isSymbolicLink()
      ? 'link'
      : stats.isDirectory()
        ? 'dir'
        : 'file';
    const hash =
      kind === 'file' ? Bun.SHA256.hash(readFileSync(path), 'hex') : '';
    lines.push(`${rel}|${kind}|${(stats.mode & 0o777).toString(8)}|${hash}`);
    if (kind === 'dir') {
      for (const entry of readdirSync(path).sort()) {
        record(join(path, entry), `${rel}/${entry}`);
      }
    }
  };
  record(dir, '.');
  return lines.join('\n');
}

class ScopedFakeRunner implements CommandRunner {
  calls: { command: string; args: readonly string[] }[] = [];

  statusStdout = 'quorum-appliance: missing\n';
  statusStatus = 0;
  downStatus = 0;
  upStdout = `${SCOPED_ID}\n`;
  upStatus = 0;
  rmStatus = 0;
  execResult: CommandResult = { status: 0, stdout: '', stderr: '' };
  // The Docker `container inspect` Mounts payload for the captured id. Real
  // docker reports the created container's actual bind mounts here; leaving
  // this empty models a container whose credential mounts are all wrong.
  mounts: FakeInspectMount[] = [];
  inspect: (target: string) => CommandResult = (target) => ({
    status: 0,
    stdout: JSON.stringify([
      { Id: target, Image: 'img-1', Mounts: this.mounts },
    ]),
    stderr: '',
  });

  run(command: string, args: readonly string[]): CommandResult {
    this.calls.push({ command, args });
    if (command === 'docker') {
      if (args[0] === 'container' && args[1] === 'inspect') {
        return this.inspect(args[2] ?? '');
      }
      if (args[0] === 'rm') {
        return {
          status: this.rmStatus,
          stdout: '',
          stderr: this.rmStatus === 0 ? '' : 'rm failed\n',
        };
      }
      return { status: 1, stdout: '', stderr: 'unexpected docker call\n' };
    }
    const last = args[args.length - 1] ?? '';
    if (last === 'status') {
      return {
        status: this.statusStatus,
        stdout: this.statusStdout,
        stderr: '',
      };
    }
    if (last === 'down') {
      return {
        status: this.downStatus,
        stdout: '',
        stderr: this.downStatus === 0 ? '' : 'down failed\n',
      };
    }
    if (last === 'up') {
      return {
        status: this.upStatus,
        stdout: this.upStdout,
        stderr: this.upStatus === 0 ? '' : 'up failed\n',
      };
    }
    if (args.includes('exec')) {
      return this.execResult;
    }
    return { status: 1, stdout: '', stderr: 'unexpected wrapper call\n' };
  }
}

function emptyActiveMaterial(fx: ScopedFixture) {
  return {
    kind: 'empty' as const,
    credentialScope: EMPTY_CREDENTIAL_SCOPE,
    root: fx.activeDir,
    agentEnvFile: join(fx.activeDir, 'agent.env'),
    supervisorExecEnvFile: null,
    authMounts: [] as const,
  };
}

function liveActiveMaterial(fx: ScopedFixture): LiveActiveCredentialMaterial {
  return {
    kind: 'live',
    credentialScope: GEMINI_OAUTH_SCOPE,
    root: fx.activeDir,
    agentEnvFile: join(fx.activeDir, 'agent.env'),
    supervisorExecEnvFile: join(fx.activeDir, 'supervisor.exec.env'),
    authMounts: [{ name: 'gemini', path: join(fx.activeDir, 'auth/gemini') }],
  };
}

function emptyStagedLiteral(fx: ScopedFixture): EmptyStagedCredentialMaterial {
  return {
    kind: 'empty',
    credentialScope: EMPTY_CREDENTIAL_SCOPE,
    stageDir: fx.stagingDir,
    agentEnvFile: join(fx.stagingDir, 'agent.env'),
    supervisorExecEnvFile: null,
    authMounts: [],
  };
}

function liveStagedLiteral(fx: ScopedFixture): LiveStagedCredentialMaterial {
  return {
    kind: 'live',
    credentialScope: GEMINI_OAUTH_SCOPE,
    stageDir: fx.stagingDir,
    agentEnvFile: join(fx.stagingDir, 'agent.env'),
    supervisorExecEnvFile: join(fx.stagingDir, 'supervisor.exec.env'),
    authMounts: [{ name: 'gemini', path: join(fx.stagingDir, 'auth/gemini') }],
  };
}

function scopedLease(
  fx: ScopedFixture,
  overrides: Partial<ContainerLease> = {},
): ContainerLease {
  return {
    name: fx.loaded.config.container.name,
    id: SCOPED_ID,
    imageId: 'img-1',
    mountSignature: 'a'.repeat(64),
    credentialScope: EMPTY_CREDENTIAL_SCOPE,
    ...overrides,
  };
}

function expectedScopedUpArgs(
  fx: ScopedFixture,
  authArgs: readonly string[] = [],
): string[] {
  return [
    '--name',
    'quorum-appliance',
    '--superpowers-root',
    join(fx.root, 'superpowers'),
    '--env-file',
    join(fx.activeDir, 'agent.env'),
    '--no-default-auth',
    ...authArgs,
    'up',
  ];
}

function expectContainerError(
  caught: unknown,
  fragment: string,
): ApplianceError {
  expect(caught).toBeInstanceOf(ApplianceError);
  const err = caught as ApplianceError;
  expect(err.message).toContain(fragment);
  return err;
}

// --- scoped argument construction -------------------------------------------

test('scopedUpContainerArgs for asserted-empty material carries the empty env file, --no-default-auth, and zero auth mounts', () => {
  const fx = makeScopedFixture();
  const args = scopedUpContainerArgs(fx.loaded, emptyActiveMaterial(fx));
  expect(args).toEqual(expectedScopedUpArgs(fx));
});

test('scopedUpContainerArgs projects exactly the live auth mounts and never the supervisor path', () => {
  const fx = makeScopedFixture();
  // A structurally complete active generation, so the boundary can bind the
  // projected tree to the scope.
  writeScopedTree(fx.activeDir, {
    'agent.env': "ANTHROPIC_API_KEY='k'\n",
    'supervisor.exec.env': 'QUORUM_GRADER_SOURCE_MODE=appliance-scoped\n',
    'auth/gemini/oauth_creds.json': '{}',
    'auth/gemini/google_accounts.json': '{}',
  });
  const active = liveActiveMaterial(fx);
  const args = scopedUpContainerArgs(fx.loaded, active);
  expect(args).toEqual(
    expectedScopedUpArgs(fx, [
      '--auth',
      `gemini=${join(fx.activeDir, 'auth/gemini')}`,
    ]),
  );
  expect(args).not.toContain(active.supervisorExecEnvFile);
});

test('scopedUpContainerArgs rejects tampered active material', () => {
  const fx = makeScopedFixture();
  const live = liveActiveMaterial(fx);
  const tampered = [
    // Discriminant pairing: empty material cannot carry a live scope.
    { ...emptyActiveMaterial(fx), credentialScope: GEMINI_OAUTH_SCOPE },
    // Empty material cannot carry a supervisor file or mounts.
    {
      ...emptyActiveMaterial(fx),
      supervisorExecEnvFile: join(fx.activeDir, 'supervisor.exec.env'),
    },
    {
      ...emptyActiveMaterial(fx),
      authMounts: [{ name: 'gemini', path: join(fx.activeDir, 'auth/gemini') }],
    },
    // Live material must pair with a live scope and its own oauth mounts.
    { ...live, credentialScope: EMPTY_CREDENTIAL_SCOPE },
    { ...live, supervisorExecEnvFile: null },
    { ...live, authMounts: [] },
    {
      ...live,
      authMounts: [{ name: 'codex', path: join(fx.activeDir, 'auth/codex') }],
    },
    { ...live, authMounts: [...live.authMounts, ...live.authMounts] },
    // Projected paths must stay under the active credential root.
    { ...live, agentEnvFile: join(fx.root, 'outside.env') },
    { ...live, supervisorExecEnvFile: join(fx.root, 'outside.exec.env') },
    {
      ...live,
      authMounts: [{ name: 'gemini', path: join(fx.root, 'evil-auth') }],
    },
  ];
  for (const active of tampered) {
    const caught = captureError(() =>
      scopedUpContainerArgs(
        fx.loaded,
        active as Parameters<typeof scopedUpContainerArgs>[1],
      ),
    );
    expect(caught).toBeInstanceOf(ApplianceError);
    expect((caught as ApplianceError).code).toBe('config_invalid');
  }
});

test('scopedExecContainerArgs contains only name, expected immutable id, optional env file, exec, and the command', () => {
  const fx = makeScopedFixture();
  const lease = scopedLease(fx);
  expect(scopedExecContainerArgs(fx.loaded, lease, ['quorum', 'list'])).toEqual(
    [
      '--name',
      'quorum-appliance',
      '--expected-container-id',
      SCOPED_ID,
      'exec',
      'quorum',
      'list',
    ],
  );
  const supervisorFile = join(fx.activeDir, 'supervisor.exec.env');
  expect(
    scopedExecContainerArgs(fx.loaded, lease, ['quorum', 'run'], {
      execEnvFile: supervisorFile,
    }),
  ).toEqual([
    '--name',
    'quorum-appliance',
    '--expected-container-id',
    SCOPED_ID,
    '--exec-env-file',
    supervisorFile,
    'exec',
    'quorum',
    'run',
  ]);
});

test('scopedExecContainerArgs rejects invalid leases, commands, and env files', () => {
  const fx = makeScopedFixture();
  const invalid: {
    lease: ContainerLease;
    command: readonly string[];
    options?: { readonly execEnvFile?: string };
  }[] = [
    { lease: scopedLease(fx, { id: '' }), command: ['quorum'] },
    { lease: scopedLease(fx, { id: '   ' }), command: ['quorum'] },
    { lease: scopedLease(fx, { id: 'two words' }), command: ['quorum'] },
    {
      lease: scopedLease(fx, { name: 'other-container' }),
      command: ['quorum'],
    },
    { lease: scopedLease(fx), command: [] },
    {
      lease: scopedLease(fx),
      command: ['quorum'],
      options: { execEnvFile: 'relative/agent.env' },
    },
    {
      lease: scopedLease(fx),
      command: ['quorum'],
      options: { execEnvFile: '' },
    },
  ];
  for (const { lease, command, options } of invalid) {
    const caught = captureError(() =>
      scopedExecContainerArgs(fx.loaded, lease, command, options),
    );
    expect(caught).toBeInstanceOf(ApplianceError);
    expect((caught as ApplianceError).code).toBe('config_invalid');
  }
});

// --- reconcileScopedContainer -----------------------------------------------

test('reconcileScopedContainer activates an asserted-empty stage, captures the docker run id, and returns the scoped lease', () => {
  const fx = makeScopedFixture();
  const staged = stageProbeCredentialMaterial(fx.loaded);
  const runner = new ScopedFakeRunner();
  runner.mounts = envOnlyMounts(fx);

  const lease = reconcileScopedContainer(fx.loaded, runner, staged);

  expect(lease.name).toBe('quorum-appliance');
  expect(lease.id).toBe(SCOPED_ID);
  expect(lease.imageId).toBe('img-1');
  expect(lease.credentialScope).toEqual(EMPTY_CREDENTIAL_SCOPE);
  expect(lease.mountSignature).toMatch(/^[a-f0-9]{64}$/);

  const wrapper = evalsContainerPath(fx.loaded);
  expect(runner.calls).toEqual([
    { command: wrapper, args: ['--name', 'quorum-appliance', 'status'] },
    { command: wrapper, args: expectedScopedUpArgs(fx) },
    { command: 'docker', args: ['container', 'inspect', SCOPED_ID] },
  ]);

  // The asserted-empty generation is active: an empty env file, no
  // supervisor env, no auth directories, and the staging slot is consumed.
  expect(existsSync(fx.stagingDir)).toBe(false);
  expect(readFileSync(join(fx.activeDir, 'agent.env'), 'utf8')).toBe('');
  expect(existsSync(join(fx.activeDir, 'supervisor.exec.env'))).toBe(false);
  expect(existsSync(join(fx.activeDir, 'auth'))).toBe(false);
});

test('reconcileScopedContainer downs an existing container, activates the live stage, and mounts exactly the projected auth directory', () => {
  const fx = makeScopedFixture();
  seedGeminiBundle(fx);
  const staged = stageLiveCredentialMaterial(fx.loaded, GEMINI_OAUTH_SCOPE);
  const runner = new ScopedFakeRunner();
  runner.statusStdout = 'quorum-appliance: exists, running\n';
  runner.mounts = geminiLiveMounts(fx);

  const lease = reconcileScopedContainer(fx.loaded, runner, staged);

  expect(lease.credentialScope).toEqual(GEMINI_OAUTH_SCOPE);
  const wrapper = evalsContainerPath(fx.loaded);
  expect(runner.calls).toEqual([
    { command: wrapper, args: ['--name', 'quorum-appliance', 'status'] },
    { command: wrapper, args: ['--name', 'quorum-appliance', 'down'] },
    {
      command: wrapper,
      args: expectedScopedUpArgs(fx, [
        '--auth',
        `gemini=${join(fx.activeDir, 'auth/gemini')}`,
      ]),
    },
    { command: 'docker', args: ['container', 'inspect', SCOPED_ID] },
  ]);
  const upArgs = runner.calls[2]?.args ?? [];
  expect(upArgs).not.toContain(join(fx.activeDir, 'supervisor.exec.env'));

  expect(existsSync(fx.stagingDir)).toBe(false);
  expect(existsSync(join(fx.activeDir, 'auth/gemini/oauth_creds.json'))).toBe(
    true,
  );
  expect(
    existsSync(join(fx.activeDir, 'auth/gemini/google_accounts.json')),
  ).toBe(true);
  expect(existsSync(join(fx.activeDir, 'supervisor.exec.env'))).toBe(true);
});

test('scope/material mismatch and tamper fail before any wrapper or docker call and never discard the stage', () => {
  const fx = makeScopedFixture();
  seedGeminiBundle(fx);
  const emptyStaged = stageProbeCredentialMaterial(fx.loaded);
  const emptyTampers = [
    { ...emptyStaged, credentialScope: GEMINI_OAUTH_SCOPE },
    {
      ...emptyStaged,
      supervisorExecEnvFile: join(fx.stagingDir, 'supervisor.exec.env'),
    },
    {
      ...emptyStaged,
      authMounts: [
        { name: 'gemini', path: join(fx.stagingDir, 'auth/gemini') },
      ],
    },
  ];
  for (const staged of emptyTampers) {
    const runner = new ScopedFakeRunner();
    const caught = captureError(() =>
      reconcileScopedContainer(
        fx.loaded,
        runner,
        staged as unknown as StagedCredentialMaterial,
      ),
    );
    expect(caught).toBeInstanceOf(ApplianceError);
    expect((caught as ApplianceError).code).toBe('config_invalid');
    expect(runner.calls).toHaveLength(0);
    expect(existsSync(fx.stagingDir)).toBe(true);
  }

  const liveStaged = stageLiveCredentialMaterial(fx.loaded, GEMINI_OAUTH_SCOPE);
  const liveTampers = [
    { ...liveStaged, credentialScope: EMPTY_CREDENTIAL_SCOPE },
    { ...liveStaged, supervisorExecEnvFile: null },
    { ...liveStaged, authMounts: [] },
    {
      ...liveStaged,
      authMounts: [{ name: 'codex', path: join(fx.stagingDir, 'auth/codex') }],
    },
    {
      ...liveStaged,
      authMounts: [...liveStaged.authMounts, ...liveStaged.authMounts],
    },
    { ...liveStaged, agentEnvFile: join(fx.root, 'outside.env') },
    // A displaced stage dir with internally coherent paths must still be
    // refused before the container is touched.
    {
      ...liveStaged,
      stageDir: join(fx.root, 'state/evil-stage'),
      agentEnvFile: join(fx.root, 'state/evil-stage/agent.env'),
      supervisorExecEnvFile: join(
        fx.root,
        'state/evil-stage/supervisor.exec.env',
      ),
      authMounts: [
        { name: 'gemini', path: join(fx.root, 'state/evil-stage/auth/gemini') },
      ],
    },
  ];
  for (const staged of liveTampers) {
    const runner = new ScopedFakeRunner();
    const caught = captureError(() =>
      reconcileScopedContainer(
        fx.loaded,
        runner,
        staged as unknown as StagedCredentialMaterial,
      ),
    );
    expect(caught).toBeInstanceOf(ApplianceError);
    expect((caught as ApplianceError).code).toBe('config_invalid');
    expect(runner.calls).toHaveLength(0);
    expect(existsSync(fx.stagingDir)).toBe(true);
  }
});

test('hostile scoped-state topology fails with zero wrapper or docker calls', () => {
  // Final symlink: state/credentials-scoped aliased elsewhere.
  const finalLink = makeScopedFixture();
  mkdirSync(join(finalLink.root, 'evil-scoped'));
  symlinkSync(join(finalLink.root, 'evil-scoped'), finalLink.scopedRoot);
  // Intermediate symlink: state itself aliased elsewhere.
  const midLink = makeScopedFixture();
  rmSync(join(midLink.root, 'state'), { recursive: true, force: true });
  mkdirSync(join(midLink.root, 'elsewhere/credentials-scoped'), {
    recursive: true,
  });
  symlinkSync(join(midLink.root, 'elsewhere'), join(midLink.root, 'state'));
  // Scoped credential state beneath the evals code mount.
  const underEvals = makeScopedFixture({ evals: 'state' });

  for (const fx of [finalLink, midLink, underEvals]) {
    const runner = new ScopedFakeRunner();
    const caught = captureError(() =>
      reconcileScopedContainer(fx.loaded, runner, emptyStagedLiteral(fx)),
    );
    expect(caught).toBeInstanceOf(ApplianceError);
    expect((caught as ApplianceError).code).toBe('config_invalid');
    expect(runner.calls).toHaveLength(0);
  }
});

test('a credential bundle beneath the results mount fails with zero wrapper or docker calls', () => {
  const fx = makeScopedFixture({ bundle: 'evals/results/blessed' });
  // A structurally complete staged generation so validation reaches the
  // bundle boundary rather than failing on the projected tree shape.
  writeScopedTree(fx.stagingDir, {
    'agent.env': '',
    'supervisor.exec.env': 'ANTHROPIC_API_KEY=grader\n',
    'auth/gemini/oauth_creds.json': '{}',
    'auth/gemini/google_accounts.json': '{}',
  });
  const runner = new ScopedFakeRunner();

  const caught = captureError(() =>
    reconcileScopedContainer(fx.loaded, runner, liveStagedLiteral(fx)),
  );

  // The bundle sits beneath BOTH the evals repo and the results root
  // (results_root is inside evals); the boundary reports the first overlap
  // in its fixed target order, so accept either code/results target label.
  const err = expectContainerError(caught, 'credential bundle overlaps');
  expect(err.message).toMatch(/evals repo|results root/);
  expect((caught as ApplianceError).code).toBe('config_invalid');
  expect(runner.calls).toHaveLength(0);
});

test('a pre-activation down failure discards only the staging slot and preserves the typed error and active/recovery bytes', () => {
  const fx = makeScopedFixture();
  const staged = stageProbeCredentialMaterial(fx.loaded);
  writeScopedTree(fx.activeDir, { 'agent.env': 'PRIOR=1\n' });
  const activeBefore = fingerprintTree(fx.activeDir);
  const runner = new ScopedFakeRunner();
  runner.statusStdout = 'quorum-appliance: exists, running\n';
  runner.downStatus = 1;

  const caught = captureError(() =>
    reconcileScopedContainer(fx.loaded, runner, staged),
  );

  expect(caught).toBeInstanceOf(ApplianceError);
  expect((caught as ApplianceError).code).toBe('container_recreate_required');
  const wrapper = evalsContainerPath(fx.loaded);
  expect(runner.calls).toEqual([
    { command: wrapper, args: ['--name', 'quorum-appliance', 'status'] },
    { command: wrapper, args: ['--name', 'quorum-appliance', 'down'] },
  ]);
  expect(existsSync(fx.stagingDir)).toBe(false);
  expect(fingerprintTree(fx.activeDir)).toBe(activeBefore);
  expect(existsSync(fx.recoveryDir)).toBe(false);
});

test('a recovery refusal discards only the staging slot and preserves both generations byte-for-byte', () => {
  const fx = makeScopedFixture();
  const staged = stageProbeCredentialMaterial(fx.loaded);
  writeScopedTree(fx.activeDir, { 'agent.env': 'ACTIVE=1\n' });
  writeScopedTree(fx.recoveryDir, { 'agent.env': 'RECOVERY=1\n' });
  const activeBefore = fingerprintTree(fx.activeDir);
  const recoveryBefore = fingerprintTree(fx.recoveryDir);
  const runner = new ScopedFakeRunner();

  const caught = captureError(() =>
    reconcileScopedContainer(fx.loaded, runner, staged),
  );

  expectContainerError(caught, 'both active and recovery');
  expect(runner.calls).toEqual([
    {
      command: evalsContainerPath(fx.loaded),
      args: ['--name', 'quorum-appliance', 'status'],
    },
  ]);
  expect(existsSync(fx.stagingDir)).toBe(false);
  expect(fingerprintTree(fx.activeDir)).toBe(activeBefore);
  expect(fingerprintTree(fx.recoveryDir)).toBe(recoveryBefore);
});

test('a scoped up that returns no container id fails typed with no rollback target', () => {
  const fx = makeScopedFixture();
  const staged = stageProbeCredentialMaterial(fx.loaded);
  const runner = new ScopedFakeRunner();
  runner.upStdout = '';

  const caught = captureError(() =>
    reconcileScopedContainer(fx.loaded, runner, staged),
  );

  expectContainerError(caught, 'container id');
  expect((caught as ApplianceError).code).toBe('container_unhealthy');
  // status + up only: no inspect, no docker rm without a captured id.
  expect(runner.calls).toHaveLength(2);
  expect(runner.calls.some((call) => call.command === 'docker')).toBe(false);
});

test('malformed or replaced post-up inspection rolls back only the captured id, never the configured name', () => {
  const inspections: ((target: string) => CommandResult)[] = [
    () => ({ status: 1, stdout: '', stderr: 'no such container\n' }),
    () => ({ status: 0, stdout: 'not json', stderr: '' }),
    () => ({
      status: 0,
      stdout: JSON.stringify([{ Image: 'img-1' }]),
      stderr: '',
    }),
    () => ({
      status: 0,
      stdout: JSON.stringify([{ Id: 'different-id', Image: 'img-1' }]),
      stderr: '',
    }),
  ];
  for (const inspect of inspections) {
    const fx = makeScopedFixture();
    const staged = stageProbeCredentialMaterial(fx.loaded);
    const runner = new ScopedFakeRunner();
    runner.inspect = inspect;

    const caught = captureError(() =>
      reconcileScopedContainer(fx.loaded, runner, staged),
    );

    expect(caught).toBeInstanceOf(ApplianceError);
    const last = runner.calls[runner.calls.length - 1];
    expect(last).toEqual({ command: 'docker', args: ['rm', '-f', SCOPED_ID] });
    // The configured name is never targeted after up: no wrapper down.
    const wrapper = evalsContainerPath(fx.loaded);
    expect(
      runner.calls.some(
        (call) =>
          call.command === wrapper &&
          call.args[call.args.length - 1] === 'down',
      ),
    ).toBe(false);
  }
});

test('a rollback failure is appended to the original typed error without masking it', () => {
  const fx = makeScopedFixture();
  const staged = stageProbeCredentialMaterial(fx.loaded);
  const runner = new ScopedFakeRunner();
  runner.inspect = () => ({ status: 0, stdout: 'not json', stderr: '' });
  runner.rmStatus = 1;

  const caught = captureError(() =>
    reconcileScopedContainer(fx.loaded, runner, staged),
  );

  const err = expectContainerError(caught, SCOPED_ID);
  expect(err.message).toContain('rollback');
});

test('the mount signature describes scope and destinations, never secret values', () => {
  const fx = makeScopedFixture();
  seedGeminiBundle(fx, '-first');
  const runnerA = new ScopedFakeRunner();
  runnerA.mounts = geminiLiveMounts(fx);
  const leaseA = reconcileScopedContainer(
    fx.loaded,
    runnerA,
    stageLiveCredentialMaterial(fx.loaded, GEMINI_OAUTH_SCOPE),
  );

  // Same scope and destinations with rotated secret bytes: the signature
  // must not change, proving no secret value is hashed into it.
  seedGeminiBundle(fx, '-second');
  const runnerB = new ScopedFakeRunner();
  runnerB.statusStdout = 'quorum-appliance: exists, running\n';
  runnerB.mounts = geminiLiveMounts(fx);
  const leaseB = reconcileScopedContainer(
    fx.loaded,
    runnerB,
    stageLiveCredentialMaterial(fx.loaded, GEMINI_OAUTH_SCOPE),
  );
  expect(leaseB.mountSignature).toBe(leaseA.mountSignature);

  // A different asserted scope produces a different signature.
  const runnerC = new ScopedFakeRunner();
  runnerC.statusStdout = 'quorum-appliance: exists, running\n';
  runnerC.mounts = envOnlyMounts(fx);
  const leaseC = reconcileScopedContainer(
    fx.loaded,
    runnerC,
    stageProbeCredentialMaterial(fx.loaded),
  );
  expect(leaseC.mountSignature).not.toBe(leaseA.mountSignature);
});

test('the mount signature covers the complete asserted scope, field by field', () => {
  const fx = makeScopedFixture();
  seedSharedAuthBundle(fx);

  const signatureFor = (
    scope: LiveCredentialScope,
    auth: readonly { name: string; path: string }[] = [],
  ): string => {
    const runner = new ScopedFakeRunner();
    runner.statusStdout = 'quorum-appliance: exists, running\n';
    runner.mounts = scopedInspectMounts({
      envFile: join(fx.activeDir, 'agent.env'),
      auth,
    });
    return reconcileScopedContainer(
      fx.loaded,
      runner,
      stageLiveCredentialMaterial(fx.loaded, scope),
    ).mountSignature;
  };

  // agentEnv projections differ (identical trees otherwise).
  expect(signatureFor(agentEnvKeyScope('ANTHROPIC_API_KEY'))).not.toBe(
    signatureFor(agentEnvKeyScope('GEMINI_API_KEY')),
  );

  // geminiAuthType differs (same agentEnv, same destinations).
  const withMode: LiveCredentialScope = {
    ...agentEnvKeyScope('GEMINI_API_KEY'),
    geminiAuthType: 'gemini-api-key',
  };
  expect(signatureFor(withMode)).not.toBe(
    signatureFor(agentEnvKeyScope('GEMINI_API_KEY')),
  );

  // OAuth kind differs while the mount name is identical (gemini vs
  // antigravity both mount 'gemini').
  expect(
    signatureFor(GEMINI_OAUTH_SCOPE, [
      { name: 'gemini', path: join(fx.activeDir, 'auth/gemini') },
    ]),
  ).not.toBe(
    signatureFor(ANTIGRAVITY_SAME_MOUNT_SCOPE, [
      { name: 'gemini', path: join(fx.activeDir, 'auth/gemini') },
    ]),
  );

  // OAuth provider differs (identical pi destinations).
  expect(
    signatureFor(piScope('openai-codex'), [
      { name: 'pi', path: join(fx.activeDir, 'auth/pi') },
    ]),
  ).not.toBe(
    signatureFor(piScope('anthropic'), [
      { name: 'pi', path: join(fx.activeDir, 'auth/pi') },
    ]),
  );
});

test('captured-container mount topology is validated exactly and failures roll back only the captured id', () => {
  const cases: {
    readonly label: string;
    readonly fragment: string;
    readonly mounts: (fx: ScopedFixture) => FakeInspectMount[];
  }[] = [
    {
      label: 'missing credentials env mount',
      fragment: '/run/evals/credentials.env',
      mounts: (fx) =>
        geminiLiveMounts(fx).filter(
          (mount) => mount.Destination !== '/run/evals/credentials.env',
        ),
    },
    {
      label: 'credentials env mount is read-write',
      fragment: '/run/evals/credentials.env',
      mounts: (fx) =>
        geminiLiveMounts(fx).map((mount) =>
          mount.Destination === '/run/evals/credentials.env'
            ? { ...mount, RW: true }
            : mount,
        ),
    },
    {
      label: 'credentials env mount from the wrong source',
      fragment: '/run/evals/credentials.env',
      mounts: (fx) =>
        geminiLiveMounts(fx).map((mount) =>
          mount.Destination === '/run/evals/credentials.env'
            ? { ...mount, Source: join(fx.root, 'impostor.env') }
            : mount,
        ),
    },
    {
      label: 'missing asserted auth mount',
      fragment: '/auth/gemini',
      mounts: (fx) => envOnlyMounts(fx),
    },
    {
      label: 'auth mount is read-write',
      fragment: '/auth/gemini',
      mounts: (fx) =>
        geminiLiveMounts(fx).map((mount) =>
          mount.Destination === '/auth/gemini' ? { ...mount, RW: true } : mount,
        ),
    },
    {
      label: 'auth mount from the wrong source',
      fragment: '/auth/gemini',
      mounts: (fx) =>
        geminiLiveMounts(fx).map((mount) =>
          mount.Destination === '/auth/gemini'
            ? { ...mount, Source: join(fx.root, 'evil-auth') }
            : mount,
        ),
    },
    {
      label: 'unasserted extra auth mount',
      fragment: 'unasserted',
      mounts: (fx) =>
        scopedInspectMounts({
          envFile: join(fx.activeDir, 'agent.env'),
          auth: [{ name: 'gemini', path: join(fx.activeDir, 'auth/gemini') }],
          extra: [
            {
              Type: 'bind',
              Source: join(fx.root, 'hostile-codex'),
              Destination: '/auth/codex',
              RW: false,
            },
          ],
        }),
    },
    {
      label: 'supervisor exec env file mounted into the container',
      fragment: 'supervisor',
      mounts: (fx) =>
        scopedInspectMounts({
          envFile: join(fx.activeDir, 'agent.env'),
          auth: [{ name: 'gemini', path: join(fx.activeDir, 'auth/gemini') }],
          extra: [
            {
              Type: 'bind',
              Source: join(fx.activeDir, 'supervisor.exec.env'),
              Destination: '/evil/supervisor',
              RW: false,
            },
          ],
        }),
    },
  ];

  for (const { fragment, mounts } of cases) {
    const fx = makeScopedFixture();
    seedGeminiBundle(fx);
    const staged = stageLiveCredentialMaterial(fx.loaded, GEMINI_OAUTH_SCOPE);
    const runner = new ScopedFakeRunner();
    runner.mounts = mounts(fx);

    const caught = captureError(() =>
      reconcileScopedContainer(fx.loaded, runner, staged),
    );

    const err = expectContainerError(caught, fragment);
    expect(err.code).toBe('container_unhealthy');
    // Rollback targets exactly the captured id, never the configured name.
    expect(runner.calls[runner.calls.length - 1]).toEqual({
      command: 'docker',
      args: ['rm', '-f', SCOPED_ID],
    });
    const wrapper = evalsContainerPath(fx.loaded);
    expect(
      runner.calls.some(
        (call) =>
          call.command === wrapper &&
          call.args[call.args.length - 1] === 'down',
      ),
    ).toBe(false);
  }

  // An asserted-empty scope tolerates no auth mount at all.
  const fx = makeScopedFixture();
  const staged = stageProbeCredentialMaterial(fx.loaded);
  const runner = new ScopedFakeRunner();
  runner.mounts = scopedInspectMounts({
    envFile: join(fx.activeDir, 'agent.env'),
    extra: [
      {
        Type: 'bind',
        Source: join(fx.root, 'hostile-codex'),
        Destination: '/auth/codex',
        RW: false,
      },
    ],
  });
  const caught = captureError(() =>
    reconcileScopedContainer(fx.loaded, runner, staged),
  );
  expectContainerError(caught, 'unasserted');
  expect(runner.calls[runner.calls.length - 1]).toEqual({
    command: 'docker',
    args: ['rm', '-f', SCOPED_ID],
  });
});

test('material paths must be the exact fixed slot paths, not descendants', () => {
  const fx = makeScopedFixture();
  seedGeminiBundle(fx);

  // Direct active-material boundary.
  const live = liveActiveMaterial(fx);
  const activeAlternates = [
    { ...live, agentEnvFile: join(fx.activeDir, 'nested/agent.env') },
    {
      ...live,
      supervisorExecEnvFile: join(fx.activeDir, 'nested/supervisor.exec.env'),
    },
    {
      ...live,
      authMounts: [
        { name: 'gemini', path: join(fx.activeDir, 'auth/gemini/nested') },
      ],
    },
    {
      ...live,
      authMounts: [
        { name: 'gemini', path: join(fx.activeDir, 'auth/gemini-x') },
      ],
    },
  ];
  for (const active of activeAlternates) {
    const caught = captureError(() =>
      scopedUpContainerArgs(
        fx.loaded,
        active as Parameters<typeof scopedUpContainerArgs>[1],
      ),
    );
    expect(caught).toBeInstanceOf(ApplianceError);
    expect((caught as ApplianceError).code).toBe('config_invalid');
  }

  // Staged boundary: alternate paths fail before any runner call and never
  // discard the stage.
  const staged = stageLiveCredentialMaterial(fx.loaded, GEMINI_OAUTH_SCOPE);
  const stagedAlternates = [
    { ...staged, agentEnvFile: join(fx.stagingDir, 'nested/agent.env') },
    {
      ...staged,
      supervisorExecEnvFile: join(fx.stagingDir, 'nested/supervisor.exec.env'),
    },
    {
      ...staged,
      authMounts: [
        { name: 'gemini', path: join(fx.stagingDir, 'auth/gemini/nested') },
      ],
    },
    {
      ...staged,
      authMounts: [
        { name: 'gemini', path: join(fx.stagingDir, 'auth/gemini-x') },
      ],
    },
  ];
  for (const tampered of stagedAlternates) {
    const runner = new ScopedFakeRunner();
    const caught = captureError(() =>
      reconcileScopedContainer(
        fx.loaded,
        runner,
        tampered as unknown as StagedCredentialMaterial,
      ),
    );
    expect(caught).toBeInstanceOf(ApplianceError);
    expect((caught as ApplianceError).code).toBe('config_invalid');
    expect(runner.calls).toHaveLength(0);
    expect(existsSync(fx.stagingDir)).toBe(true);
  }
});

test('a same-mount cross-scope swap fails before down or activation', () => {
  // Staged for Antigravity, relabeled with the same-mount Gemini scope.
  const agy = makeScopedFixture();
  seedSharedAuthBundle(agy);
  const agyStaged = stageLiveCredentialMaterial(
    agy.loaded,
    ANTIGRAVITY_SAME_MOUNT_SCOPE,
  );
  const relabeledGemini = {
    ...agyStaged,
    credentialScope: GEMINI_OAUTH_SCOPE,
  };

  // Staged for Gemini, relabeled with the same-mount Antigravity scope.
  const gem = makeScopedFixture();
  seedSharedAuthBundle(gem);
  const gemStaged = stageLiveCredentialMaterial(gem.loaded, GEMINI_OAUTH_SCOPE);
  const relabeledAntigravity = {
    ...gemStaged,
    credentialScope: ANTIGRAVITY_SAME_MOUNT_SCOPE,
  };

  for (const [fx, staged] of [
    [agy, relabeledGemini],
    [gem, relabeledAntigravity],
  ] as const) {
    const runner = new ScopedFakeRunner();
    const caught = captureError(() =>
      reconcileScopedContainer(
        fx.loaded,
        runner,
        staged as unknown as StagedCredentialMaterial,
      ),
    );
    expect(caught).toBeInstanceOf(ApplianceError);
    expect((caught as ApplianceError).code).toBe('config_invalid');
    expect((caught as ApplianceError).message).toContain('projected auth');
    expect(runner.calls).toHaveLength(0);
    expect(existsSync(fx.stagingDir)).toBe(true);
  }
});

test('the staged auth tree must contain exactly the scope-required files', () => {
  // Extra rogue file inside the projected tree.
  const extra = makeScopedFixture();
  seedGeminiBundle(extra);
  const extraStaged = stageLiveCredentialMaterial(
    extra.loaded,
    GEMINI_OAUTH_SCOPE,
  );
  writeFileSync(join(extra.stagingDir, 'auth/gemini/rogue.json'), '{}');

  // Missing one of the required files.
  const missing = makeScopedFixture();
  seedGeminiBundle(missing);
  const missingStaged = stageLiveCredentialMaterial(
    missing.loaded,
    GEMINI_OAUTH_SCOPE,
  );
  rmSync(join(missing.stagingDir, 'auth/gemini/oauth_creds.json'));

  // An asserted-empty stage carrying an auth tree.
  const strayAuth = makeScopedFixture();
  const strayAuthStaged = stageProbeCredentialMaterial(strayAuth.loaded);
  mkdirSync(join(strayAuth.stagingDir, 'auth/codex'), { recursive: true });
  writeFileSync(join(strayAuth.stagingDir, 'auth/codex/auth.json'), '{}');

  // A live scope with no oauth projection carrying an auth tree.
  const noOauth = makeScopedFixture();
  seedGeminiBundle(noOauth);
  const noOauthStaged = stageLiveCredentialMaterial(
    noOauth.loaded,
    agentEnvKeyScope('ANTHROPIC_API_KEY'),
  );
  mkdirSync(join(noOauth.stagingDir, 'auth/gemini'), { recursive: true });
  writeFileSync(join(noOauth.stagingDir, 'auth/gemini/oauth_creds.json'), '{}');

  for (const [fx, staged] of [
    [extra, extraStaged],
    [missing, missingStaged],
    [strayAuth, strayAuthStaged],
    [noOauth, noOauthStaged],
  ] as const) {
    const runner = new ScopedFakeRunner();
    const caught = captureError(() =>
      reconcileScopedContainer(fx.loaded, runner, staged),
    );
    expect(caught).toBeInstanceOf(ApplianceError);
    expect((caught as ApplianceError).code).toBe('config_invalid');
    expect((caught as ApplianceError).message).toContain('projected auth');
    expect(runner.calls).toHaveLength(0);
  }
});

test('the optional kimi oauth file is accepted present or absent', () => {
  const withOptional = makeScopedFixture();
  seedSharedAuthBundle(withOptional);
  const runnerA = new ScopedFakeRunner();
  runnerA.mounts = scopedInspectMounts({
    envFile: join(withOptional.activeDir, 'agent.env'),
    auth: [{ name: 'kimi', path: join(withOptional.activeDir, 'auth/kimi') }],
  });
  const leaseA = reconcileScopedContainer(
    withOptional.loaded,
    runnerA,
    stageLiveCredentialMaterial(withOptional.loaded, KIMI_OAUTH_SCOPE),
  );
  expect(leaseA.credentialScope).toEqual(KIMI_OAUTH_SCOPE);

  const withoutOptional = makeScopedFixture();
  seedSharedAuthBundle(withoutOptional);
  rmSync(join(withoutOptional.bundleDir, 'kimi-code/oauth/kimi-code'), {
    force: true,
  });
  const runnerB = new ScopedFakeRunner();
  runnerB.mounts = scopedInspectMounts({
    envFile: join(withoutOptional.activeDir, 'agent.env'),
    auth: [
      { name: 'kimi', path: join(withoutOptional.activeDir, 'auth/kimi') },
    ],
  });
  const leaseB = reconcileScopedContainer(
    withoutOptional.loaded,
    runnerB,
    stageLiveCredentialMaterial(withoutOptional.loaded, KIMI_OAUTH_SCOPE),
  );
  expect(leaseB.credentialScope).toEqual(KIMI_OAUTH_SCOPE);
});

test('an incomplete or malformed scope is refused before any runner call', () => {
  const fx = makeScopedFixture();
  seedGeminiBundle(fx);
  const staged = stageLiveCredentialMaterial(fx.loaded, GEMINI_OAUTH_SCOPE);
  const broken = [
    { ...staged, credentialScope: { ...GEMINI_OAUTH_SCOPE, schemaVersion: 2 } },
    {
      ...staged,
      credentialScope: { ...GEMINI_OAUTH_SCOPE, agent: '' },
    },
    {
      ...staged,
      credentialScope: { ...GEMINI_OAUTH_SCOPE, credential: '' },
    },
    {
      ...staged,
      credentialScope: { ...GEMINI_OAUTH_SCOPE, runtimeFamily: '' },
    },
    {
      ...staged,
      credentialScope: {
        ...GEMINI_OAUTH_SCOPE,
        agentEnv: [{ destinationName: '', sourceNames: ['X'] }],
      } as unknown as LiveCredentialScope,
    },
    {
      ...staged,
      credentialScope: {
        ...GEMINI_OAUTH_SCOPE,
        geminiAuthType: 'hostile-mode',
      } as unknown as LiveCredentialScope,
    },
    {
      ...staged,
      credentialScope: {
        ...GEMINI_OAUTH_SCOPE,
        oauth: { kind: 'gemini', mountName: 'pi' },
      } as unknown as LiveCredentialScope,
    },
    {
      ...staged,
      credentialScope: {
        ...GEMINI_OAUTH_SCOPE,
        oauth: { kind: 'pi', mountName: 'pi' },
      } as unknown as LiveCredentialScope,
    },
    {
      ...staged,
      credentialScope: {
        ...EMPTY_CREDENTIAL_SCOPE,
        agent: 'not-null',
      } as unknown as typeof EMPTY_CREDENTIAL_SCOPE,
    },
  ];
  for (const tampered of broken) {
    const runner = new ScopedFakeRunner();
    const caught = captureError(() =>
      reconcileScopedContainer(
        fx.loaded,
        runner,
        tampered as unknown as StagedCredentialMaterial,
      ),
    );
    expect(caught).toBeInstanceOf(ApplianceError);
    expect((caught as ApplianceError).code).toBe('config_invalid');
    expect(runner.calls).toHaveLength(0);
    expect(existsSync(fx.stagingDir)).toBe(true);
  }
});

// --- runInLeasedContainer ----------------------------------------------------

test('runInLeasedContainer execs through the wrapper against the immutable lease id', () => {
  const fx = makeScopedFixture();
  const runner = new ScopedFakeRunner();
  runner.execResult = { status: 0, stdout: 'ok\n', stderr: '' };
  const lease = scopedLease(fx);

  const result = runInLeasedContainer(
    fx.loaded,
    runner,
    lease,
    ['quorum', 'list'],
    'container_unhealthy',
    'lease exec failed',
  );

  expect(result.stdout).toBe('ok\n');
  expect(runner.calls).toEqual([
    {
      command: evalsContainerPath(fx.loaded),
      args: scopedExecContainerArgs(fx.loaded, lease, ['quorum', 'list']),
    },
  ]);
});

test('runInLeasedContainer surfaces failures with the given typed code and refuses a mismatched lease', () => {
  const fx = makeScopedFixture();
  const runner = new ScopedFakeRunner();
  runner.execResult = { status: 1, stdout: '', stderr: 'boom\n' };

  const failed = captureError(() =>
    runInLeasedContainer(
      fx.loaded,
      runner,
      scopedLease(fx),
      ['quorum', 'list'],
      'quorum_check_failed',
      'lease exec failed',
    ),
  );
  expect(failed).toBeInstanceOf(ApplianceError);
  expect((failed as ApplianceError).code).toBe('quorum_check_failed');
  expect((failed as ApplianceError).message).toContain('lease exec failed');

  const mismatched = captureError(() =>
    runInLeasedContainer(
      fx.loaded,
      new ScopedFakeRunner(),
      scopedLease(fx, { name: 'other-container' }),
      ['quorum', 'list'],
      'container_unhealthy',
      'lease exec failed',
    ),
  );
  expect(mismatched).toBeInstanceOf(ApplianceError);
  expect((mismatched as ApplianceError).code).toBe('config_invalid');
});

// --- docker exec --env-file capability ---------------------------------------

class HelpRunner implements CommandRunner {
  calls: { command: string; args: readonly string[] }[] = [];
  result: CommandResult;

  constructor(result: CommandResult) {
    this.result = result;
  }

  run(command: string, args: readonly string[]): CommandResult {
    this.calls.push({ command, args });
    return this.result;
  }
}

test('requireDockerExecEnvFile probes docker exec --help and accepts --env-file support', () => {
  const runner = new HelpRunner({
    status: 0,
    stdout: 'Usage: docker exec\n  --env-file list\n',
    stderr: '',
  });
  requireDockerExecEnvFile(runner);
  expect(runner.calls).toEqual([
    { command: 'docker', args: ['exec', '--help'] },
  ]);
  expect(dockerExecEnvFileSupport(runner)).toBe(true);
});

test('requireDockerExecEnvFile fails typed when --env-file is unsupported or the probe fails', () => {
  const unsupported = new HelpRunner({
    status: 0,
    stdout: 'Usage: docker exec\n  --env list\n',
    stderr: '',
  });
  const missing = new HelpRunner({
    status: 1,
    stdout: '',
    stderr: 'docker: command not found\n',
  });
  for (const runner of [unsupported, missing]) {
    const caught = captureError(() => requireDockerExecEnvFile(runner));
    expect(caught).toBeInstanceOf(ApplianceError);
    expect((caught as ApplianceError).message).toContain('--env-file');
    expect(dockerExecEnvFileSupport(runner)).toBe(false);
  }
});
