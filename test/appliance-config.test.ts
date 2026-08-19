import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadCredentialConfig,
  loadStateConfig,
} from '../src/appliance/config.ts';
import { ApplianceError } from '../src/appliance/errors.ts';

interface ConfigFixture {
  readonly root: string;
  readonly configPath: string;
  readonly bundleDir: string;
}

function fixture(opts: { metadata?: string | null } = {}): ConfigFixture {
  // Canonical (realpath) fixture root: the boundary validates every absolute
  // path component no-follow, and macOS tmpdir paths traverse /var symlinks.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'appliance-cfg-')));
  for (const dir of [
    'superpowers-evals/results',
    'superpowers',
    'gauntlet',
    'credentials/blessed',
  ]) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  const bundleDir = join(root, 'credentials/blessed');
  const metadata =
    opts.metadata === undefined
      ? JSON.stringify({
          bundle_id: 'blessed-a',
          rotated_at: '2026-06-18T00:00:00Z',
          providers: ['anthropic'],
        })
      : opts.metadata;
  if (metadata !== null) {
    writeFileSync(join(bundleDir, 'metadata.json'), metadata);
  }
  const configPath = join(root, 'appliance.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      root,
      evals: {
        path: join(root, 'superpowers-evals'),
        remote: 'origin',
        ref: 'main',
      },
      superpowers: { path: join(root, 'superpowers'), remote: 'origin' },
      gauntlet: { path: join(root, 'gauntlet'), remote: 'origin', ref: 'main' },
      credential_bundle: { name: 'blessed', path: bundleDir },
      container: {
        name: 'quorum-appliance',
        results_root: join(root, 'superpowers-evals/results'),
      },
    }),
  );
  return { root, configPath, bundleDir };
}

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

// --- structural loader ------------------------------------------------------

test('loadStateConfig loads structural config without touching the bundle', () => {
  // No metadata.json at all, and the payload is unreadable: the structural
  // loader must not care about either.
  const fx = fixture({ metadata: null });
  writeFileSync(join(fx.bundleDir, 'credentials.env'), 'SECRET=1\n');
  chmodSync(join(fx.bundleDir, 'credentials.env'), 0o000);
  try {
    const loaded = loadStateConfig(fx.configPath);
    expect(loaded.config.root).toBe(fx.root);
    expect(loaded.paths.jobs).toBe(join(fx.root, 'state/jobs'));
    expect(loaded.paths.locks).toBe(join(fx.root, 'state/locks'));
    expect(loaded.paths.provenance).toBe(join(fx.root, 'state/provenance'));
    // The structural type has no bundle field at all.
    expect('bundle' in loaded).toBe(false);
  } finally {
    chmodSync(join(fx.bundleDir, 'credentials.env'), 0o600);
  }
});

test('loadStateConfig tolerates a missing bundle directory entirely', () => {
  const fx = fixture({ metadata: null });
  rmSync(fx.bundleDir, { recursive: true, force: true });
  const loaded = loadStateConfig(fx.configPath);
  expect(loaded.config.credential_bundle.path).toBe(fx.bundleDir);
});

test('loadStateConfig ensureState creates private state dirs; read-only does not', () => {
  const fx = fixture({ metadata: null });
  const readOnly = loadStateConfig(fx.configPath);
  expect(readOnly.paths.jobs).toBe(join(fx.root, 'state/jobs'));
  expect(existsSync(join(fx.root, 'state'))).toBe(false);

  loadStateConfig(fx.configPath, { ensureState: true });
  expect(statSync(join(fx.root, 'state')).mode & 0o777).toBe(0o700);
  expect(statSync(join(fx.root, 'state/jobs')).mode & 0o777).toBe(0o700);
  expect(statSync(join(fx.root, 'state/locks')).mode & 0o777).toBe(0o700);
  expect(statSync(join(fx.root, 'state/provenance')).mode & 0o777).toBe(0o700);
});

test('loadStateConfig fails typed on a missing root', () => {
  const fx = fixture({ metadata: null });
  rmSync(fx.root, { recursive: true, force: true });
  const caught = captureError(() => loadStateConfig(fx.configPath));
  expect(caught).toBeInstanceOf(ApplianceError);
  expect((caught as ApplianceError).code).toBe('config_invalid');
});

// --- credential-aware loader ------------------------------------------------

test('loadCredentialConfig loads bundle metadata on the happy path', () => {
  const fx = fixture();
  const loaded = loadCredentialConfig(fx.configPath);
  expect(loaded.bundle.bundle_id).toBe('blessed-a');
  expect(loaded.config.root).toBe(fx.root);
});

test('loadCredentialConfig never opens credentials.env or oauth payloads', () => {
  // A dangling symlink where the payload lives: if the loader touched it,
  // this would throw; the metadata read is the only bundle access.
  const fx = fixture();
  symlinkSync(join(fx.root, 'nowhere'), join(fx.bundleDir, 'credentials.env'));
  const loaded = loadCredentialConfig(fx.configPath);
  expect(loaded.bundle.bundle_id).toBe('blessed-a');
});

test('loadCredentialConfig fails typed on a final-symlink bundle dir before payload access', () => {
  const fx = fixture();
  const realBundle = join(fx.root, 'real-bundle');
  mkdirSync(realBundle, { recursive: true });
  writeFileSync(
    join(realBundle, 'metadata.json'),
    JSON.stringify({ bundle_id: 'x', rotated_at: 'x', providers: [] }),
  );
  rmSync(fx.bundleDir, { recursive: true, force: true });
  symlinkSync(realBundle, fx.bundleDir);
  const caught = captureError(() => loadCredentialConfig(fx.configPath));
  expect(caught).toBeInstanceOf(ApplianceError);
  expect((caught as ApplianceError).code).toBe('config_invalid');
});

test('loadCredentialConfig fails typed on an intermediate-symlink bundle path', () => {
  const fx = fixture();
  mkdirSync(join(fx.root, 'aside/blessed'), { recursive: true });
  writeFileSync(
    join(fx.root, 'aside/blessed/metadata.json'),
    JSON.stringify({ bundle_id: 'x', rotated_at: 'x', providers: [] }),
  );
  rmSync(join(fx.root, 'credentials'), { recursive: true, force: true });
  symlinkSync(join(fx.root, 'aside'), join(fx.root, 'credentials'));
  const caught = captureError(() => loadCredentialConfig(fx.configPath));
  expect(caught).toBeInstanceOf(ApplianceError);
});

test('loadCredentialConfig refuses a symlinked metadata.json before reading it', () => {
  const fx = fixture({ metadata: null });
  writeFileSync(
    join(fx.root, 'outside-metadata.json'),
    JSON.stringify({ bundle_id: 'evil', rotated_at: 'x', providers: [] }),
  );
  symlinkSync(
    join(fx.root, 'outside-metadata.json'),
    join(fx.bundleDir, 'metadata.json'),
  );
  const caught = captureError(() => loadCredentialConfig(fx.configPath));
  expect(caught).toBeInstanceOf(ApplianceError);
  expect((caught as ApplianceError).message).toContain('metadata');
});

test('loadCredentialConfig fails typed on missing or unreadable metadata', () => {
  const missing = fixture({ metadata: null });
  expect(
    captureError(() => loadCredentialConfig(missing.configPath)),
  ).toBeInstanceOf(ApplianceError);

  const unreadable = fixture();
  chmodSync(join(unreadable.bundleDir, 'metadata.json'), 0o000);
  try {
    expect(
      captureError(() => loadCredentialConfig(unreadable.configPath)),
    ).toBeInstanceOf(ApplianceError);
  } finally {
    chmodSync(join(unreadable.bundleDir, 'metadata.json'), 0o600);
  }
});

test('loadCredentialConfig still requires the code repos to exist', () => {
  const fx = fixture();
  rmSync(join(fx.root, 'gauntlet'), { recursive: true, force: true });
  expect(
    captureError(() => loadCredentialConfig(fx.configPath)),
  ).toBeInstanceOf(ApplianceError);
  // The structural loader does not: read/recovery operations only need the
  // appliance/state namespace.
  const structural = loadStateConfig(fx.configPath);
  expect(structural.config.root).toBe(fx.root);
});
