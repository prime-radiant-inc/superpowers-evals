import { expect, test } from 'bun:test';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseCredentialsFile } from '../src/contracts/credential.ts';
import {
  loadCredentialsFile,
  serializeCredentials,
  writeCredentialsSnapshot,
} from '../src/credentials/file.ts';

const fixturePath = join(
  import.meta.dir,
  'fixtures',
  'serf-campaign-credentials.yaml',
);

test('loadCredentialsFile reports missing and malformed credential paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'credential-file-'));
  const missingPath = join(root, 'missing.yaml');
  const malformedPath = join(root, 'malformed.yaml');
  writeFileSync(malformedPath, 'credentials: [not valid yaml', 'utf8');

  try {
    expect(() => loadCredentialsFile(missingPath)).toThrow(missingPath);
    expect(() => loadCredentialsFile(malformedPath)).toThrow(malformedPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadCredentialsFile falls back only for a missing optional default', () => {
  const root = mkdtempSync(join(tmpdir(), 'credential-file-'));
  const missingPath = join(root, 'missing-default.yaml');

  try {
    expect(loadCredentialsFile(missingPath, { allowMissing: true })).toEqual({
      path: resolve(missingPath),
      credentials: {},
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadCredentialsFile does not treat an unreadable optional default as missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'credential-file-'));
  const unreadablePath = join(root, 'unreadable-default.yaml');
  writeFileSync(
    unreadablePath,
    'sample:\n  model: test\n  harnesses: [pi]\n',
    'utf8',
  );
  chmodSync(unreadablePath, 0o000);

  try {
    expect(() =>
      loadCredentialsFile(unreadablePath, { allowMissing: true }),
    ).toThrow(/EACCES/);
  } finally {
    chmodSync(unreadablePath, 0o600);
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadCredentialsFile rejects reserved prototype credential names', () => {
  const root = mkdtempSync(join(tmpdir(), 'credential-file-'));
  const path = join(root, 'reserved-name.yaml');
  writeFileSync(path, '__proto__:\n  model: m\n  harnesses: [serf]\n', 'utf8');

  try {
    expect(() => loadCredentialsFile(path)).toThrow(/__proto__/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadCredentialsFile parses the labeled Serf campaign fixture', () => {
  const loaded = loadCredentialsFile(fixturePath);

  expect(loaded.path).toBe(resolve(fixturePath));
  expect(loaded.credentials['serf_example_a']?.labels?.provider).toBe(
    'example-provider',
  );
});

test('serializeCredentials sorts credential names and object keys', () => {
  const fixture =
    loadCredentialsFile(fixturePath).credentials['serf_example_a'];
  if (fixture === undefined) {
    throw new Error('Serf campaign fixture credential is missing');
  }
  const labels = fixture.labels;
  if (labels === undefined) {
    throw new Error('Serf campaign fixture labels are missing');
  }
  const serialized = serializeCredentials({
    zeta: fixture,
    alpha: {
      ...fixture,
      labels: { ...labels, model: 'example/model-b' },
      model: 'openrouter/@preset/example-b',
    },
  });

  expect(serialized).toBe(
    serializeCredentials({
      alpha: {
        ...fixture,
        labels: { ...labels, model: 'example/model-b' },
        model: 'openrouter/@preset/example-b',
      },
      zeta: fixture,
    }),
  );
  expect(serialized).toEndWith('\n');
  expect(serialized.indexOf('alpha:')).toBeLessThan(
    serialized.indexOf('zeta:'),
  );

  const alpha = serialized.slice(
    serialized.indexOf('alpha:'),
    serialized.indexOf('zeta:'),
  );
  expect(alpha.indexOf('api:')).toBeLessThan(alpha.indexOf('api_key_env:'));
  expect(alpha.indexOf('api_key_env:')).toBeLessThan(alpha.indexOf('auth:'));
  expect(alpha.indexOf('base_url:')).toBeLessThan(alpha.indexOf('harnesses:'));
  expect(alpha.indexOf('harnesses:')).toBeLessThan(alpha.indexOf('labels:'));
  expect(alpha.indexOf('catalog_as_of:')).toBeLessThan(
    alpha.indexOf('model: example/model-b'),
  );
});

test('writeCredentialsSnapshot writes a typed, secret-free credential snapshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'credential-snapshot-'));
  const destination = join(root, 'nested', 'credentials.yaml');
  const credentials = loadCredentialsFile(fixturePath).credentials;
  const previous = Bun.env['OPENROUTER_API_KEY'];
  const testSecret = crypto.randomUUID();
  Bun.env['OPENROUTER_API_KEY'] = testSecret;

  try {
    const snapshotPath = writeCredentialsSnapshot({
      credentials,
      destination,
    });
    const serialized = readFileSync(snapshotPath, 'utf8');

    expect(snapshotPath).toBe(resolve(destination));
    expect(statSync(snapshotPath).mode & 0o777).toBe(0o600);
    expect(parseCredentialsFile(parseYaml(serialized))).toEqual(credentials);
    expect(serialized).toContain('OPENROUTER_API_KEY');
    expect(serialized).not.toContain(testSecret);
  } finally {
    if (previous === undefined) {
      delete Bun.env['OPENROUTER_API_KEY'];
    } else {
      Bun.env['OPENROUTER_API_KEY'] = previous;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
