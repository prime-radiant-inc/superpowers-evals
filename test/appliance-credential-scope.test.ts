import { expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  activateScopedCredentialMaterial,
  assertCredentialBundleBoundary,
  assertScopedCredentialStateBoundary,
  discardStagedCredentialMaterial,
  recoverScopedCredentialActivation,
  retireScopedCredentialMaterial,
  stageLiveCredentialMaterial,
  stageProbeCredentialMaterial,
} from '../src/appliance/credential-scope.ts';
import { ApplianceError } from '../src/appliance/errors.ts';
import type { LoadedApplianceConfig } from '../src/appliance/types.ts';
import type { LiveCredentialScope } from '../src/credentials/scope.ts';

// The witnessed flat two-provider pi auth shape (test/agent-pi.test.ts): a
// top-level provider-keyed record, nothing nested above the entries.
const SOURCE_PI_AUTH = {
  'openai-codex': {
    type: 'oauth',
    access: 'pi-access-a',
    refresh: 'pi-refresh-a',
    expires: 9999999999999,
    accountId: 'acct-1',
  },
  anthropic: {
    type: 'api',
    key: 'pi-anthropic-key',
  },
} as const;

interface Fixture {
  readonly root: string;
  readonly loaded: LoadedApplianceConfig;
  readonly bundleDir: string;
  readonly scopedRoot: string;
  readonly stagingDir: string;
  readonly activeDir: string;
  readonly recoveryDir: string;
}

function makeFixture(): Fixture {
  // Canonical (realpath) fixture root: the boundary validates every absolute
  // path component no-follow, and macOS tmpdir paths traverse /var symlinks.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'appliance-scope-')));
  for (const dir of [
    'evals/results',
    'superpowers',
    'gauntlet',
    'credentials/blessed',
    'state',
  ]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  const bundleDir = join(root, 'credentials/blessed');
  const loaded: LoadedApplianceConfig = {
    configPath: join(root, 'appliance.json'),
    config: {
      root,
      evals: { path: join(root, 'evals'), remote: 'origin', ref: 'main' },
      superpowers: { path: join(root, 'superpowers'), remote: 'origin' },
      gauntlet: { path: join(root, 'gauntlet'), remote: 'origin', ref: 'main' },
      credential_bundle: { name: 'blessed', path: bundleDir },
      container: {
        name: 'quorum-appliance',
        results_root: join(root, 'evals/results'),
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

const DEFAULT_ENV_LINES: readonly string[] = [
  "ANTHROPIC_API_KEY='agent-anthropic-key'",
  "GEMINI_API_KEY='agent-gemini-key'",
  "COPILOT_GITHUB_TOKEN='agent-copilot-token'",
  "GH_TOKEN='agent-gh-token'",
  "OPENAI_API_KEY='agent-openai-key'",
  "AWS_SECRET_ACCESS_KEY='hostile-aws-secret'",
  "AWS_BEARER_TOKEN_BEDROCK='hostile-bedrock'",
  "QUORUM_GRADER_ANTHROPIC_API_KEY='grader-anthropic-key'",
  "QUORUM_GRADER_ANTHROPIC_BASE_URL='https://gateway.example/v1'",
  "HTTPS_PROXY='http://proxy.example:8080'",
  "NODE_EXTRA_CA_CERTS='/etc/ssl/extra.pem'",
  "GH_HOST='github.example'",
  "COPILOT_MODEL='gpt-x'",
];

function writeTree(base: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const path = join(base, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
  }
}

function seedBundle(
  fx: Fixture,
  opts: { envLines?: readonly string[]; files?: Record<string, string> } = {},
): void {
  writeTree(fx.bundleDir, {
    'metadata.json': JSON.stringify({
      bundle_id: 'blessed-x',
      rotated_at: '2026-06-18T00:00:00Z',
      providers: [],
    }),
    'credentials.env': `${(opts.envLines ?? DEFAULT_ENV_LINES).join('\n')}\n`,
    'codex/auth.json': JSON.stringify({
      OPENAI_API_KEY: 'codex-api-key',
      tokens: { access_token: 'codex-access', refresh_token: 'codex-refresh' },
    }),
    'gemini/oauth_creds.json': JSON.stringify({
      access_token: 'gem-access',
      refresh_token: 'gem-refresh',
    }),
    'gemini/google_accounts.json': JSON.stringify({
      accounts: [{ email: 'user@example.com' }],
    }),
    'gemini/antigravity-cli/antigravity-oauth-token': 'agy-raw-token\n',
    'kimi-code/config.toml': 'model = "k3"\napi_base = "https://k.example"\n',
    'kimi-code/credentials/kimi-code.json': JSON.stringify({
      access_token: 'kimi-access',
      refresh_token: 'kimi-refresh',
    }),
    'kimi-code/oauth/kimi-code': 'kimi-oauth-token\n',
    'pi/agent/auth.json': JSON.stringify(SOURCE_PI_AUTH),
    'pi/agent/settings.json': JSON.stringify({
      defaultProvider: 'openai-codex',
      defaultModel: 'gpt-5.5',
    }),
    ...(opts.files ?? {}),
  });
}

function liveScope(
  overrides: Partial<LiveCredentialScope> & Pick<LiveCredentialScope, 'agent'>,
): LiveCredentialScope {
  return {
    schemaVersion: 1,
    kind: 'live',
    runtimeFamily: overrides.agent,
    credential: `${overrides.agent}_cred`,
    agentEnv: [],
    geminiAuthType: null,
    oauth: null,
    ...overrides,
  };
}

const CLAUDE_SCOPE = liveScope({
  agent: 'claude',
  agentEnv: [
    {
      destinationName: 'ANTHROPIC_API_KEY',
      sourceNames: ['ANTHROPIC_API_KEY'],
    },
  ],
});

const GEMINI_OAUTH_SCOPE = liveScope({
  agent: 'gemini',
  geminiAuthType: 'oauth-personal',
  oauth: { kind: 'gemini', mountName: 'gemini' },
});

const GEMINI_API_SCOPE = liveScope({
  agent: 'gemini',
  geminiAuthType: 'gemini-api-key',
  agentEnv: [
    { destinationName: 'GEMINI_API_KEY', sourceNames: ['GEMINI_API_KEY'] },
  ],
});

const ANTIGRAVITY_SCOPE = liveScope({
  agent: 'antigravity',
  oauth: { kind: 'antigravity', mountName: 'gemini' },
});

const CODEX_SCOPE = liveScope({
  agent: 'codex',
  oauth: { kind: 'codex', mountName: 'codex' },
});

const KIMI_SCOPE = liveScope({
  agent: 'kimi',
  oauth: { kind: 'kimi', mountName: 'kimi' },
});

const PI_SCOPE = liveScope({
  agent: 'pi',
  oauth: { kind: 'pi', mountName: 'pi', provider: 'openai-codex' },
});

const COPILOT_SCOPE = liveScope({
  agent: 'copilot',
  agentEnv: [
    {
      destinationName: 'COPILOT_GITHUB_TOKEN',
      sourceNames: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
    },
  ],
});

// Sorted relative paths of every regular file under `dir`; a non-regular
// entry (symlink/fifo/device) is reported with a marker so no test can
// accidentally vouch for one.
function readProjectedTree(dir: string): string[] {
  const out: string[] = [];
  const visit = (current: string, rel: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(path, entryRel);
      } else if (entry.isFile()) {
        out.push(entryRel);
      } else {
        out.push(`${entryRel}#non-regular`);
      }
    }
  };
  visit(dir, '');
  return out.sort();
}

// Full recursive fingerprint (paths, kinds, modes, bytes) used to prove
// byte-for-byte and metadata-for-metadata restoration.
function snapshotTree(dir: string): string {
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

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectScopeError(caught: unknown, fragment: string): ApplianceError {
  expect(caught).toBeInstanceOf(ApplianceError);
  const err = caught as ApplianceError;
  expect(err.code).toBe('config_invalid');
  expect(err.message).toContain(fragment);
  return err;
}

// --- probe staging ----------------------------------------------------------

test('probe staging writes an empty agent.env and never inspects the bundle', () => {
  const fx = makeFixture();
  // The blessed bundle is hostile garbage: unreadable env payload, garbage
  // metadata. Probe staging must not care — it never opens either.
  writeTree(fx.bundleDir, {
    'metadata.json': 'not json at all',
    'credentials.env': "ANTHROPIC_API_KEY='never-read'",
  });
  chmodSync(join(fx.bundleDir, 'credentials.env'), 0o000);
  try {
    const staged = stageProbeCredentialMaterial(fx.loaded);
    expect(staged.kind).toBe('empty');
    expect(staged.credentialScope.kind).toBe('empty');
    expect(staged.stageDir).toBe(fx.stagingDir);
    expect(staged.agentEnvFile).toBe(join(fx.stagingDir, 'agent.env'));
    expect(staged.supervisorExecEnvFile).toBe(null);
    expect(staged.authMounts).toEqual([]);
    expect(readFileSync(staged.agentEnvFile, 'utf8')).toBe('');
    expect(statSync(fx.stagingDir).mode & 0o777).toBe(0o700);
    expect(statSync(staged.agentEnvFile).mode & 0o777).toBe(0o600);
  } finally {
    chmodSync(join(fx.bundleDir, 'credentials.env'), 0o600);
  }
});

test('probe staging succeeds when the bundle payload is a dangling symlink', () => {
  const fx = makeFixture();
  writeTree(fx.bundleDir, { 'metadata.json': '{}' });
  symlinkSync(join(fx.root, 'nowhere'), join(fx.bundleDir, 'credentials.env'));
  const staged = stageProbeCredentialMaterial(fx.loaded);
  expect(staged.kind).toBe('empty');
  expect(existsSync(staged.agentEnvFile)).toBe(true);
});

test('probe staging fails closed when the staging slot is a symlink', () => {
  const fx = makeFixture();
  const elsewhere = join(fx.root, 'elsewhere');
  mkdirSync(elsewhere, { recursive: true });
  mkdirSync(fx.scopedRoot, { recursive: true });
  symlinkSync(elsewhere, fx.stagingDir);
  const caught = captureError(() => stageProbeCredentialMaterial(fx.loaded));
  expect(caught).toBeInstanceOf(ApplianceError);
  expect((caught as ApplianceError).code).toBe('config_invalid');
  // The link target was never written into.
  expect(readdirSync(elsewhere)).toEqual([]);
});

// --- boundary asserts -------------------------------------------------------

test('scoped state boundary rejects every ancestor/descendant overlap', () => {
  const overlapping: ((fx: Fixture) => string)[] = [
    // results_root inside the scoped state namespace.
    (fx) => join(fx.scopedRoot, 'results'),
    // results_root as an ancestor of the scoped namespace.
    (fx) => join(fx.root, 'state'),
    // exact collision.
    (fx) => fx.scopedRoot,
  ];
  for (const resultsRootFor of overlapping) {
    const fx = makeFixture();
    const resultsRoot = resultsRootFor(fx);
    const loaded: LoadedApplianceConfig = {
      ...fx.loaded,
      config: {
        ...fx.loaded.config,
        container: { ...fx.loaded.config.container, results_root: resultsRoot },
      },
    };
    const caught = captureError(() =>
      assertScopedCredentialStateBoundary(loaded),
    );
    expect(caught).toBeInstanceOf(ApplianceError);
    expect((caught as ApplianceError).code).toBe('config_invalid');
  }
  // Repo overlaps: evals / superpowers / gauntlet each containing the scoped
  // namespace (ancestor) fail the same way.
  const repoOverlaps: ((fx: Fixture) => LoadedApplianceConfig['config'])[] = [
    (fx) => ({
      ...fx.loaded.config,
      evals: { ...fx.loaded.config.evals, path: join(fx.root, 'state') },
    }),
    (fx) => ({
      ...fx.loaded.config,
      superpowers: {
        ...fx.loaded.config.superpowers,
        path: join(fx.root, 'state'),
      },
    }),
    (fx) => ({
      ...fx.loaded.config,
      gauntlet: { ...fx.loaded.config.gauntlet, path: join(fx.root, 'state') },
    }),
  ];
  for (const configFor of repoOverlaps) {
    const fx = makeFixture();
    const loaded: LoadedApplianceConfig = {
      ...fx.loaded,
      config: configFor(fx),
    };
    const caught = captureError(() =>
      assertScopedCredentialStateBoundary(loaded),
    );
    expect(caught).toBeInstanceOf(ApplianceError);
  }
});

test('scoped state boundary rejects final and intermediate symlinks', () => {
  // Final: the staging slot is a link.
  const fx1 = makeFixture();
  mkdirSync(join(fx1.root, 'aside'), { recursive: true });
  mkdirSync(fx1.scopedRoot, { recursive: true });
  symlinkSync(join(fx1.root, 'aside'), fx1.activeDir);
  expect(
    captureError(() => assertScopedCredentialStateBoundary(fx1.loaded)),
  ).toBeInstanceOf(ApplianceError);

  // Intermediate: state/credentials-scoped itself is a link.
  const fx2 = makeFixture();
  mkdirSync(join(fx2.root, 'aside/deep'), { recursive: true });
  symlinkSync(join(fx2.root, 'aside'), fx2.scopedRoot);
  expect(
    captureError(() => assertScopedCredentialStateBoundary(fx2.loaded)),
  ).toBeInstanceOf(ApplianceError);
});

test('scoped state boundary rejects unknown entries in the fixed namespace', () => {
  const fx = makeFixture();
  mkdirSync(join(fx.scopedRoot, 'stray-generation'), { recursive: true });
  const caught = captureError(() =>
    assertScopedCredentialStateBoundary(fx.loaded),
  );
  expect(caught).toBeInstanceOf(ApplianceError);
  expect((caught as ApplianceError).message).toContain('stray-generation');
});

test('bundle boundary requires a real no-follow bundle dir and rejects overlaps', () => {
  // Missing bundle dir.
  const fxMissing = makeFixture();
  rmSync(fxMissing.bundleDir, { recursive: true, force: true });
  expect(
    captureError(() => assertCredentialBundleBoundary(fxMissing.loaded.config)),
  ).toBeInstanceOf(ApplianceError);

  // Final symlink.
  const fxFinal = makeFixture();
  rmSync(fxFinal.bundleDir, { recursive: true, force: true });
  mkdirSync(join(fxFinal.root, 'real-bundle'), { recursive: true });
  symlinkSync(join(fxFinal.root, 'real-bundle'), fxFinal.bundleDir);
  expect(
    captureError(() => assertCredentialBundleBoundary(fxFinal.loaded.config)),
  ).toBeInstanceOf(ApplianceError);

  // Intermediate symlink (credentials -> elsewhere).
  const fxMid = makeFixture();
  rmSync(join(fxMid.root, 'credentials'), { recursive: true, force: true });
  mkdirSync(join(fxMid.root, 'aside/blessed'), { recursive: true });
  symlinkSync(join(fxMid.root, 'aside'), join(fxMid.root, 'credentials'));
  expect(
    captureError(() => assertCredentialBundleBoundary(fxMid.loaded.config)),
  ).toBeInstanceOf(ApplianceError);

  // Bundle inside results (descendant) and results inside bundle (ancestor).
  const fxIn = makeFixture();
  const inResults = join(fxIn.loaded.config.container.results_root, 'bundle');
  mkdirSync(inResults, { recursive: true });
  expect(
    captureError(() =>
      assertCredentialBundleBoundary({
        ...fxIn.loaded.config,
        credential_bundle: { name: 'blessed', path: inResults },
      }),
    ),
  ).toBeInstanceOf(ApplianceError);
  const fxOut = makeFixture();
  expect(
    captureError(() =>
      assertCredentialBundleBoundary({
        ...fxOut.loaded.config,
        container: {
          ...fxOut.loaded.config.container,
          results_root: join(fxOut.bundleDir, 'results'),
        },
      }),
    ),
  ).toBeInstanceOf(ApplianceError);
});

// --- live staging: exact projections ---------------------------------------

test('gemini oauth staging projects exactly the two oauth JSON files', () => {
  const fx = makeFixture();
  seedBundle(fx);
  const gemini = stageLiveCredentialMaterial(fx.loaded, GEMINI_OAUTH_SCOPE);
  expect(gemini.kind).toBe('live');
  expect(gemini.authMounts.map((m) => m.name)).toEqual(['gemini']);
  expect(readProjectedTree(gemini.authMounts[0]?.path ?? '')).toEqual([
    'google_accounts.json',
    'oauth_creds.json',
  ]);
  // The agent env carries the scope-derived mode, nothing else.
  expect(readFileSync(gemini.agentEnvFile, 'utf8')).toBe(
    "GEMINI_AUTH_TYPE='oauth-personal'\n",
  );
  // 0700 dirs / 0600 files throughout the staged material.
  expect(statSync(gemini.stageDir).mode & 0o777).toBe(0o700);
  expect(statSync(gemini.authMounts[0]?.path ?? '').mode & 0o777).toBe(0o700);
  expect(
    statSync(join(gemini.authMounts[0]?.path ?? '', 'oauth_creds.json')).mode &
      0o777,
  ).toBe(0o600);
});

test('antigravity staging projects only the antigravity token under the gemini mount', () => {
  const fx = makeFixture();
  seedBundle(fx);
  const antigravity = stageLiveCredentialMaterial(fx.loaded, ANTIGRAVITY_SCOPE);
  expect(antigravity.authMounts.map((m) => m.name)).toEqual(['gemini']);
  expect(readProjectedTree(antigravity.authMounts[0]?.path ?? '')).toEqual([
    'antigravity-cli/antigravity-oauth-token',
  ]);
});

test('codex staging projects exactly auth.json under the codex mount', () => {
  const fx = makeFixture();
  seedBundle(fx);
  const codex = stageLiveCredentialMaterial(fx.loaded, CODEX_SCOPE);
  expect(codex.authMounts.map((m) => m.name)).toEqual(['codex']);
  expect(readProjectedTree(codex.authMounts[0]?.path ?? '')).toEqual([
    'auth.json',
  ]);
});

test('kimi staging projects config, credentials, and the optional oauth token', () => {
  const fx = makeFixture();
  seedBundle(fx);
  const kimi = stageLiveCredentialMaterial(fx.loaded, KIMI_SCOPE);
  expect(kimi.authMounts.map((m) => m.name)).toEqual(['kimi']);
  expect(readProjectedTree(kimi.authMounts[0]?.path ?? '')).toEqual([
    'config.toml',
    'credentials/kimi-code.json',
    'oauth/kimi-code',
  ]);
});

test('kimi staging tolerates a missing optional oauth token but requires the rest', () => {
  const fx = makeFixture();
  seedBundle(fx);
  rmSync(join(fx.bundleDir, 'kimi-code/oauth'), { recursive: true });
  const kimi = stageLiveCredentialMaterial(fx.loaded, KIMI_SCOPE);
  expect(readProjectedTree(kimi.authMounts[0]?.path ?? '')).toEqual([
    'config.toml',
    'credentials/kimi-code.json',
  ]);

  const fx2 = makeFixture();
  seedBundle(fx2);
  rmSync(join(fx2.bundleDir, 'kimi-code/config.toml'));
  const caught = captureError(() =>
    stageLiveCredentialMaterial(fx2.loaded, KIMI_SCOPE),
  );
  expect(caught).toBeInstanceOf(ApplianceError);
});

test('pi staging retains exactly the selected top-level provider entry', () => {
  const fx = makeFixture();
  seedBundle(fx);
  const pi = stageLiveCredentialMaterial(fx.loaded, PI_SCOPE);
  expect(pi.authMounts.map((m) => m.name)).toEqual(['pi']);
  expect(readProjectedTree(pi.authMounts[0]?.path ?? '')).toEqual([
    'agent/auth.json',
  ]);
  const piAuthPath = join(pi.authMounts[0]?.path ?? '', 'agent/auth.json');
  expect(JSON.parse(readFileSync(piAuthPath, 'utf8'))).toEqual({
    'openai-codex': SOURCE_PI_AUTH['openai-codex'],
  });
});

test('pi staging fails typed on malformed auth JSON, a missing provider, and prototype names', () => {
  const malformed = makeFixture();
  seedBundle(malformed, { files: { 'pi/agent/auth.json': '{ not json' } });
  expect(
    captureError(() => stageLiveCredentialMaterial(malformed.loaded, PI_SCOPE)),
  ).toBeInstanceOf(ApplianceError);

  const missing = makeFixture();
  seedBundle(missing);
  expect(
    captureError(() =>
      stageLiveCredentialMaterial(missing.loaded, {
        ...PI_SCOPE,
        oauth: { kind: 'pi', mountName: 'pi', provider: 'nonexistent' },
      }),
    ),
  ).toBeInstanceOf(ApplianceError);

  // Inherited Object.prototype names are not own-property entries.
  const proto = makeFixture();
  seedBundle(proto);
  expect(
    captureError(() =>
      stageLiveCredentialMaterial(proto.loaded, {
        ...PI_SCOPE,
        oauth: { kind: 'pi', mountName: 'pi', provider: 'constructor' },
      }),
    ),
  ).toBeInstanceOf(ApplianceError);
});

// --- live staging: agent env behavior ---------------------------------------

test('agent env selects the first nonempty source and drops hostile names', () => {
  const fx = makeFixture();
  seedBundle(fx);
  const claude = stageLiveCredentialMaterial(fx.loaded, CLAUDE_SCOPE);
  const body = readFileSync(claude.agentEnvFile, 'utf8');
  expect(body).toBe("ANTHROPIC_API_KEY='agent-anthropic-key'\n");
  for (const hostile of [
    'AWS_SECRET_ACCESS_KEY',
    'AWS_BEARER_TOKEN_BEDROCK',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'QUORUM_GRADER_',
  ]) {
    expect(body).not.toContain(hostile);
  }
});

test('copilot agent env resolves ordered sources into one destination', () => {
  const fx = makeFixture();
  seedBundle(fx, {
    envLines: [
      "GH_TOKEN='fallback-gh-token'",
      "QUORUM_GRADER_ANTHROPIC_API_KEY='grader-anthropic-key'",
    ],
  });
  const copilot = stageLiveCredentialMaterial(fx.loaded, COPILOT_SCOPE);
  expect(readFileSync(copilot.agentEnvFile, 'utf8')).toBe(
    "COPILOT_GITHUB_TOKEN='fallback-gh-token'\n",
  );
});

test('agent env fails closed when every ordered source is missing or empty', () => {
  const fx = makeFixture();
  seedBundle(fx, {
    envLines: [
      "COPILOT_GITHUB_TOKEN=''",
      "QUORUM_GRADER_ANTHROPIC_API_KEY='grader-anthropic-key'",
    ],
  });
  const caught = captureError(() =>
    stageLiveCredentialMaterial(fx.loaded, COPILOT_SCOPE),
  );
  expectScopeError(caught, 'COPILOT_GITHUB_TOKEN');
});

test('a nonempty contradictory bundle GEMINI_AUTH_TYPE is config_invalid', () => {
  const fx = makeFixture();
  seedBundle(fx, {
    envLines: [
      "GEMINI_API_KEY='agent-gemini-key'",
      "GEMINI_AUTH_TYPE='oauth-personal'",
      "QUORUM_GRADER_ANTHROPIC_API_KEY='grader-anthropic-key'",
    ],
  });
  const caught = captureError(() =>
    stageLiveCredentialMaterial(fx.loaded, GEMINI_API_SCOPE),
  );
  expectScopeError(caught, 'GEMINI_AUTH_TYPE');

  // Matching or empty bundle values are fine.
  const fxOk = makeFixture();
  seedBundle(fxOk, {
    envLines: [
      "GEMINI_API_KEY='agent-gemini-key'",
      "GEMINI_AUTH_TYPE='gemini-api-key'",
      "QUORUM_GRADER_ANTHROPIC_API_KEY='grader-anthropic-key'",
    ],
  });
  const staged = stageLiveCredentialMaterial(fxOk.loaded, GEMINI_API_SCOPE);
  expect(readFileSync(staged.agentEnvFile, 'utf8')).toContain(
    "GEMINI_AUTH_TYPE='gemini-api-key'",
  );
});

// --- live staging: supervisor behavior --------------------------------------

test('supervisor env carries the mode marker and grader aliases, never canonical names', () => {
  const fx = makeFixture();
  seedBundle(fx);
  const claude = stageLiveCredentialMaterial(fx.loaded, CLAUDE_SCOPE);
  const body = readFileSync(claude.supervisorExecEnvFile, 'utf8');
  const lines = body.split('\n').filter((line) => line !== '');
  expect(lines).toContain('QUORUM_GRADER_SOURCE_MODE=appliance-scoped');
  expect(lines).toContain(
    'QUORUM_GRADER_ANTHROPIC_API_KEY=grader-anthropic-key',
  );
  expect(lines).toContain(
    'QUORUM_GRADER_ANTHROPIC_BASE_URL=https://gateway.example/v1',
  );
  // Network/TLS names ride along when defined in the trusted bundle env.
  expect(lines).toContain('HTTPS_PROXY=http://proxy.example:8080');
  expect(lines).toContain('NODE_EXTRA_CA_CERTS=/etc/ssl/extra.pem');
  // Canonical grader names never appear in the host file, and copilot
  // routing stays out of a non-copilot scope.
  for (const line of lines) {
    expect(line.startsWith('ANTHROPIC_API_KEY=')).toBe(false);
    expect(line.startsWith('CLAUDE_CODE_OAUTH_TOKEN=')).toBe(false);
    expect(line.startsWith('ANTHROPIC_AUTH_TOKEN=')).toBe(false);
    expect(line.startsWith('GH_HOST=')).toBe(false);
    expect(line.startsWith('COPILOT_MODEL=')).toBe(false);
    expect(line.startsWith('AWS_')).toBe(false);
  }
  // The agent env never carries grader aliases.
  expect(readFileSync(claude.agentEnvFile, 'utf8')).not.toContain(
    'QUORUM_GRADER_',
  );
});

test('supervisor env includes copilot routing names only for a copilot scope', () => {
  const fx = makeFixture();
  seedBundle(fx);
  const copilot = stageLiveCredentialMaterial(fx.loaded, COPILOT_SCOPE);
  const lines = readFileSync(copilot.supervisorExecEnvFile, 'utf8')
    .split('\n')
    .filter((line) => line !== '');
  expect(lines).toContain('GH_HOST=github.example');
  expect(lines).toContain('COPILOT_MODEL=gpt-x');
});

test('at least one nonempty grader auth source is required; base URL alone is not auth', () => {
  const fx = makeFixture();
  seedBundle(fx, {
    envLines: [
      "ANTHROPIC_API_KEY='agent-anthropic-key'",
      "QUORUM_GRADER_ANTHROPIC_BASE_URL='https://gateway.example/v1'",
    ],
  });
  const caught = captureError(() =>
    stageLiveCredentialMaterial(fx.loaded, CLAUDE_SCOPE),
  );
  expectScopeError(caught, 'grader');
});

test('CR or LF in a supervisor env value fails closed', () => {
  for (const hostile of [
    "QUORUM_GRADER_ANTHROPIC_API_KEY=$'grader\\nINJECTED=1'",
    "HTTPS_PROXY=$'http://proxy.example\\r'",
  ]) {
    const fx = makeFixture();
    seedBundle(fx, {
      envLines: [
        "ANTHROPIC_API_KEY='agent-anthropic-key'",
        "QUORUM_GRADER_ANTHROPIC_API_KEY='grader-anthropic-key'",
        hostile,
      ],
    });
    const caught = captureError(() =>
      stageLiveCredentialMaterial(fx.loaded, CLAUDE_SCOPE),
    );
    expect(caught).toBeInstanceOf(ApplianceError);
  }
});

// --- live staging: all-pairs secret distinctness ----------------------------

test('an agent env value equal to a differently named grader auth value fails closed', () => {
  const fx = makeFixture();
  seedBundle(fx, {
    envLines: [
      "ANTHROPIC_API_KEY='shared-secret-value'",
      "QUORUM_GRADER_ANTHROPIC_AUTH_TOKEN='shared-secret-value'",
    ],
  });
  const caught = captureError(() =>
    stageLiveCredentialMaterial(fx.loaded, CLAUDE_SCOPE),
  );
  expect(caught).toBeInstanceOf(ApplianceError);
  // The secret value itself never appears in the error.
  expect((caught as ApplianceError).message).not.toContain(
    'shared-secret-value',
  );
});

test('base URLs are excluded from the secret-equality comparison', () => {
  const fx = makeFixture();
  seedBundle(fx, {
    envLines: [
      "ANTHROPIC_API_KEY='https://gateway.example/v1'",
      "QUORUM_GRADER_ANTHROPIC_API_KEY='grader-anthropic-key'",
      "QUORUM_GRADER_ANTHROPIC_BASE_URL='https://gateway.example/v1'",
    ],
  });
  const staged = stageLiveCredentialMaterial(fx.loaded, CLAUDE_SCOPE);
  expect(existsSync(staged.agentEnvFile)).toBe(true);
});

test('a nested codex JSON token equal to any grader auth alias fails closed', () => {
  const fx = makeFixture();
  seedBundle(fx, {
    files: {
      'codex/auth.json': JSON.stringify({
        tokens: { access_token: 'grader-anthropic-key' },
      }),
    },
  });
  const caught = captureError(() =>
    stageLiveCredentialMaterial(fx.loaded, CODEX_SCOPE),
  );
  expect(caught).toBeInstanceOf(ApplianceError);
  expect((caught as ApplianceError).message).not.toContain(
    'grader-anthropic-key',
  );
});

test('gemini, kimi, antigravity, and pi delivery classes all enforce distinctness', () => {
  const cases: {
    scope: LiveCredentialScope;
    files: Record<string, string>;
  }[] = [
    {
      scope: GEMINI_OAUTH_SCOPE,
      files: {
        'gemini/oauth_creds.json': JSON.stringify({
          access_token: 'grader-anthropic-key',
        }),
      },
    },
    {
      scope: KIMI_SCOPE,
      files: {
        'kimi-code/credentials/kimi-code.json': JSON.stringify({
          access_token: 'grader-anthropic-key',
        }),
      },
    },
    {
      scope: KIMI_SCOPE,
      files: { 'kimi-code/oauth/kimi-code': 'grader-anthropic-key\n' },
    },
    {
      scope: ANTIGRAVITY_SCOPE,
      files: {
        'gemini/antigravity-cli/antigravity-oauth-token':
          'grader-anthropic-key\n',
      },
    },
    {
      scope: PI_SCOPE,
      files: {
        'pi/agent/auth.json': JSON.stringify({
          'openai-codex': { type: 'oauth', access: 'grader-anthropic-key' },
        }),
      },
    },
  ];
  for (const { scope, files } of cases) {
    const fx = makeFixture();
    seedBundle(fx, { files });
    const caught = captureError(() =>
      stageLiveCredentialMaterial(fx.loaded, scope),
    );
    expect(caught).toBeInstanceOf(ApplianceError);
  }
  // A NON-selected pi provider entry is not part of the agent material and
  // must not trip the comparison.
  const fxOther = makeFixture();
  seedBundle(fxOther, {
    files: {
      'pi/agent/auth.json': JSON.stringify({
        'openai-codex': SOURCE_PI_AUTH['openai-codex'],
        anthropic: { type: 'api', key: 'grader-anthropic-key' },
      }),
    },
  });
  const staged = stageLiveCredentialMaterial(fxOther.loaded, PI_SCOPE);
  expect(staged.kind).toBe('live');
});

// --- live staging: hostile inputs and cleanup -------------------------------

test('symlink and FIFO oauth sources are rejected without creating a stage', () => {
  const fxLink = makeFixture();
  seedBundle(fxLink);
  rmSync(join(fxLink.bundleDir, 'codex/auth.json'));
  symlinkSync(
    join(fxLink.root, 'evals/results'),
    join(fxLink.bundleDir, 'codex/auth.json'),
  );
  expect(
    captureError(() => stageLiveCredentialMaterial(fxLink.loaded, CODEX_SCOPE)),
  ).toBeInstanceOf(ApplianceError);
  expect(existsSync(fxLink.stagingDir)).toBe(false);

  const fxFifo = makeFixture();
  seedBundle(fxFifo);
  rmSync(join(fxFifo.bundleDir, 'codex/auth.json'));
  const fifo = spawnSync('mkfifo', [join(fxFifo.bundleDir, 'codex/auth.json')]);
  expect(fifo.status).toBe(0);
  expect(
    captureError(() => stageLiveCredentialMaterial(fxFifo.loaded, CODEX_SCOPE)),
  ).toBeInstanceOf(ApplianceError);
  expect(existsSync(fxFifo.stagingDir)).toBe(false);

  // Intermediate symlink traversal inside the bundle (codex -> elsewhere).
  const fxDir = makeFixture();
  seedBundle(fxDir);
  rmSync(join(fxDir.bundleDir, 'codex'), { recursive: true });
  mkdirSync(join(fxDir.root, 'aside'), { recursive: true });
  writeFileSync(join(fxDir.root, 'aside/auth.json'), '{}');
  symlinkSync(join(fxDir.root, 'aside'), join(fxDir.bundleDir, 'codex'));
  expect(
    captureError(() => stageLiveCredentialMaterial(fxDir.loaded, CODEX_SCOPE)),
  ).toBeInstanceOf(ApplianceError);
  expect(existsSync(fxDir.stagingDir)).toBe(false);
});

test('a bundle fault is typed before shell evaluation or file creation', () => {
  // The whole bundle dir is a symlink: refused by the bundle boundary before
  // credentials.env could be evaluated or any staging file created.
  const fx = makeFixture();
  rmSync(fx.bundleDir, { recursive: true, force: true });
  const realBundle = join(fx.root, 'real-bundle');
  mkdirSync(realBundle, { recursive: true });
  writeFileSync(join(realBundle, 'credentials.env'), "ANTHROPIC_API_KEY='x'\n");
  symlinkSync(realBundle, fx.bundleDir);
  const caught = captureError(() =>
    stageLiveCredentialMaterial(fx.loaded, CLAUDE_SCOPE),
  );
  expect(caught).toBeInstanceOf(ApplianceError);
  expect(existsSync(fx.stagingDir)).toBe(false);

  // A missing credentials.env is a typed fault, not a bash error.
  const fx2 = makeFixture();
  seedBundle(fx2);
  rmSync(join(fx2.bundleDir, 'credentials.env'));
  const caught2 = captureError(() =>
    stageLiveCredentialMaterial(fx2.loaded, CLAUDE_SCOPE),
  );
  expect(caught2).toBeInstanceOf(ApplianceError);
  expect(existsSync(fx2.stagingDir)).toBe(false);
});

test('a partial stage is cleaned up on failure and cleared on the next invocation', () => {
  const fx = makeFixture();
  seedBundle(fx, { files: { 'pi/agent/auth.json': '{ not json' } });
  expect(
    captureError(() => stageLiveCredentialMaterial(fx.loaded, PI_SCOPE)),
  ).toBeInstanceOf(ApplianceError);
  // Best-effort cleanup removed the fixed staging slot.
  expect(existsSync(fx.stagingDir)).toBe(false);

  // Simulate an interrupted stage (crash left junk): the next invocation
  // clears only the staging slot and restages; active/recovery are never
  // touched by staging.
  mkdirSync(fx.stagingDir, { recursive: true });
  writeFileSync(join(fx.stagingDir, 'leftover.env'), 'stale');
  mkdirSync(fx.activeDir, { recursive: true });
  writeFileSync(join(fx.activeDir, 'agent.env'), 'ACTIVE=1\n');
  const activeBefore = snapshotTree(fx.activeDir);
  seedBundle(fx); // repair the bundle
  const staged = stageLiveCredentialMaterial(fx.loaded, CLAUDE_SCOPE);
  expect(existsSync(join(fx.stagingDir, 'leftover.env'))).toBe(false);
  expect(existsSync(staged.agentEnvFile)).toBe(true);
  expect(snapshotTree(fx.activeDir)).toBe(activeBefore);
  expect(existsSync(fx.recoveryDir)).toBe(false);
});

test('discardStagedCredentialMaterial removes only the staging slot', () => {
  const fx = makeFixture();
  seedBundle(fx);
  stageLiveCredentialMaterial(fx.loaded, CLAUDE_SCOPE);
  mkdirSync(fx.activeDir, { recursive: true });
  writeFileSync(join(fx.activeDir, 'agent.env'), 'ACTIVE=1\n');
  const activeBefore = snapshotTree(fx.activeDir);
  discardStagedCredentialMaterial(fx.loaded);
  expect(existsSync(fx.stagingDir)).toBe(false);
  expect(snapshotTree(fx.activeDir)).toBe(activeBefore);
});

// --- activation, recovery, retirement ---------------------------------------

test('activation swaps the stage into the fixed active slot', () => {
  const fx = makeFixture();
  seedBundle(fx);
  const staged = stageLiveCredentialMaterial(fx.loaded, CLAUDE_SCOPE);
  const active = activateScopedCredentialMaterial(fx.loaded, staged);
  expect(active.kind).toBe('live');
  expect(active.root).toBe(fx.activeDir);
  expect(active.agentEnvFile).toBe(join(fx.activeDir, 'agent.env'));
  expect(active.supervisorExecEnvFile).toBe(
    join(fx.activeDir, 'supervisor.exec.env'),
  );
  expect(readFileSync(active.agentEnvFile, 'utf8')).toBe(
    "ANTHROPIC_API_KEY='agent-anthropic-key'\n",
  );
  expect(existsSync(fx.stagingDir)).toBe(false);
  expect(existsSync(fx.recoveryDir)).toBe(false);
  expect(readdirSync(fx.scopedRoot)).toEqual(['active']);
});

test('re-activation after rotation replaces the generation without accumulating', () => {
  const fx = makeFixture();
  seedBundle(fx);
  activateScopedCredentialMaterial(
    fx.loaded,
    stageLiveCredentialMaterial(fx.loaded, CLAUDE_SCOPE),
  );
  // Rotate the bundle, restage, reactivate.
  seedBundle(fx, {
    envLines: [
      "ANTHROPIC_API_KEY='agent-anthropic-key-v2'",
      "QUORUM_GRADER_ANTHROPIC_API_KEY='grader-anthropic-key-v2'",
    ],
  });
  const active = activateScopedCredentialMaterial(
    fx.loaded,
    stageLiveCredentialMaterial(fx.loaded, CLAUDE_SCOPE),
  );
  expect(readFileSync(active.agentEnvFile, 'utf8')).toBe(
    "ANTHROPIC_API_KEY='agent-anthropic-key-v2'\n",
  );
  expect(readdirSync(fx.scopedRoot)).toEqual(['active']);
});

test('activation fails closed while an unresolved recovery slot exists', () => {
  const fx = makeFixture();
  seedBundle(fx);
  const staged = stageLiveCredentialMaterial(fx.loaded, CLAUDE_SCOPE);
  mkdirSync(fx.recoveryDir, { recursive: true });
  writeFileSync(join(fx.recoveryDir, 'agent.env'), 'OLD=1\n');
  const recoveryBefore = snapshotTree(fx.recoveryDir);
  expect(
    captureError(() => activateScopedCredentialMaterial(fx.loaded, staged)),
  ).toBeInstanceOf(ApplianceError);
  expect(snapshotTree(fx.recoveryDir)).toBe(recoveryBefore);
});

test('a first-rename failure leaves the current active generation untouched', () => {
  const fx = makeFixture();
  seedBundle(fx);
  activateScopedCredentialMaterial(
    fx.loaded,
    stageLiveCredentialMaterial(fx.loaded, CLAUDE_SCOPE),
  );
  const staged = stageLiveCredentialMaterial(fx.loaded, CLAUDE_SCOPE);
  const activeBefore = snapshotTree(fx.activeDir);
  const spy = spyOn(fs, 'renameSync').mockImplementation(() => {
    const err = new Error('EACCES: forced') as NodeJS.ErrnoException;
    err.code = 'EACCES';
    throw err;
  });
  let caught: unknown;
  try {
    caught = captureError(() =>
      activateScopedCredentialMaterial(fx.loaded, staged),
    );
  } finally {
    spy.mockRestore();
  }
  expect(caught).toBeInstanceOf(ApplianceError);
  expect(snapshotTree(fx.activeDir)).toBe(activeBefore);
  expect(existsSync(fx.recoveryDir)).toBe(false);
});

test('a second-rename failure restores the prior active tree byte-for-byte', () => {
  const fx = makeFixture();
  seedBundle(fx);
  activateScopedCredentialMaterial(
    fx.loaded,
    stageLiveCredentialMaterial(fx.loaded, CODEX_SCOPE),
  );
  const staged = stageLiveCredentialMaterial(fx.loaded, CODEX_SCOPE);
  const activeBefore = snapshotTree(fx.activeDir);
  // Pass the first rename (active -> recovery) through; fail the second
  // (staging -> active).
  const realRename = fs.renameSync;
  const spy = spyOn(fs, 'renameSync').mockImplementation(((
    source: fs.PathLike,
    dest: fs.PathLike,
  ) => {
    if (String(source) === fx.stagingDir) {
      const err = new Error('EACCES: forced') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    }
    realRename(source, dest);
  }) as typeof fs.renameSync);
  let caught: unknown;
  try {
    caught = captureError(() =>
      activateScopedCredentialMaterial(fx.loaded, staged),
    );
  } finally {
    spy.mockRestore();
  }
  expect(caught).toBeInstanceOf(ApplianceError);
  // Byte-for-byte and metadata-for-metadata restoration of the old active.
  expect(snapshotTree(fx.activeDir)).toBe(activeBefore);
  expect(existsSync(fx.recoveryDir)).toBe(false);
  // The stage is preserved for a retry.
  expect(existsSync(join(fx.stagingDir, 'agent.env'))).toBe(true);
});

test('an interrupted swap recovers deterministically; two generations fail closed', () => {
  // recovery present, active absent: the old generation is restored.
  const fx = makeFixture();
  mkdirSync(fx.recoveryDir, { recursive: true });
  writeFileSync(join(fx.recoveryDir, 'agent.env'), 'OLD=1\n');
  recoverScopedCredentialActivation(fx.loaded);
  expect(existsSync(fx.recoveryDir)).toBe(false);
  expect(readFileSync(join(fx.activeDir, 'agent.env'), 'utf8')).toBe('OLD=1\n');

  // Nothing interrupted: a no-op.
  recoverScopedCredentialActivation(fx.loaded);
  expect(readFileSync(join(fx.activeDir, 'agent.env'), 'utf8')).toBe('OLD=1\n');

  // recovery AND active both complete: ambiguous, never guessed.
  const fx2 = makeFixture();
  mkdirSync(fx2.recoveryDir, { recursive: true });
  writeFileSync(join(fx2.recoveryDir, 'agent.env'), 'OLD=1\n');
  mkdirSync(fx2.activeDir, { recursive: true });
  writeFileSync(join(fx2.activeDir, 'agent.env'), 'NEW=1\n');
  expect(
    captureError(() => recoverScopedCredentialActivation(fx2.loaded)),
  ).toBeInstanceOf(ApplianceError);
  expect(readFileSync(join(fx2.activeDir, 'agent.env'), 'utf8')).toBe(
    'NEW=1\n',
  );
  expect(readFileSync(join(fx2.recoveryDir, 'agent.env'), 'utf8')).toBe(
    'OLD=1\n',
  );
});

test('retireScopedCredentialMaterial removes every fixed slot and nothing else', () => {
  const fx = makeFixture();
  seedBundle(fx);
  activateScopedCredentialMaterial(
    fx.loaded,
    stageLiveCredentialMaterial(fx.loaded, CLAUDE_SCOPE),
  );
  stageLiveCredentialMaterial(fx.loaded, CLAUDE_SCOPE);
  retireScopedCredentialMaterial(fx.loaded);
  expect(existsSync(fx.stagingDir)).toBe(false);
  expect(existsSync(fx.activeDir)).toBe(false);
  expect(existsSync(fx.recoveryDir)).toBe(false);
  // The bundle itself is untouched.
  expect(existsSync(join(fx.bundleDir, 'credentials.env'))).toBe(true);
});
