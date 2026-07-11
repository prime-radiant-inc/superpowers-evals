import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli', 'index.ts');
const CAMPAIGN_CREDENTIALS = resolve(
  import.meta.dir,
  'fixtures',
  'serf-campaign-credentials.yaml',
);

const MISSING_ROOT = '/tmp/quorum-list-check-no-root-xyz-987';

// Parity with Python's click.Path(exists=True, file_okay=False) on
// --scenarios-root for list and check: a typo'd root is a hard error, not a
// silent no-op (exit 0).

test('list errors on a nonexistent --scenarios-root (not a silent exit 0)', () => {
  const proc = spawnSync(
    'bun',
    [CLI, 'list', '--scenarios-root', MISSING_ROOT],
    { encoding: 'utf8' },
  );
  expect(proc.status).not.toBe(0);
});

test('check (no names) errors on a nonexistent --scenarios-root', () => {
  const proc = spawnSync(
    'bun',
    [CLI, 'check', '--scenarios-root', MISSING_ROOT],
    { encoding: 'utf8' },
  );
  expect(proc.status).not.toBe(0);
});

test('list still succeeds (exit 0) on an existing scenarios-root', () => {
  const root = mkdtempSync(join(tmpdir(), 'scn-'));
  const scn = join(root, 'alpha');
  mkdirSync(scn, { recursive: true });
  writeFileSync(join(scn, 'story.md'), '# story');
  const proc = spawnSync('bun', [CLI, 'list', '--scenarios-root', root], {
    encoding: 'utf8',
  });
  expect(proc.status).toBe(0);
  expect(proc.stdout).toContain('alpha');
});

test('check (no names) still succeeds (exit 0) on an empty existing scenarios-root', () => {
  const root = mkdtempSync(join(tmpdir(), 'scn-'));
  const proc = spawnSync('bun', [CLI, 'check', '--scenarios-root', root], {
    encoding: 'utf8',
  });
  expect(proc.status).toBe(0);
});

test('check accepts --credentials-file', () => {
  const root = mkdtempSync(join(tmpdir(), 'scn-'));
  const proc = spawnSync(
    'bun',
    [
      CLI,
      'check',
      '--scenarios-root',
      root,
      '--coding-agents-dir',
      root,
      '--credentials-file',
      CAMPAIGN_CREDENTIALS,
    ],
    { encoding: 'utf8' },
  );

  expect(proc.status).toBe(0);
  expect(proc.stderr).not.toContain('unknown option');
});

test('check accepts a narrow external campaign file without canonical defaults', () => {
  const root = mkdtempSync(join(tmpdir(), 'scn-'));
  const proc = spawnSync(
    'bun',
    [
      CLI,
      'check',
      '--scenarios-root',
      root,
      '--credentials-file',
      CAMPAIGN_CREDENTIALS,
    ],
    { encoding: 'utf8', cwd: resolve(import.meta.dir, '..') },
  );

  expect(proc.status).toBe(0);
  expect(proc.stdout).toContain('ok   credentials');
});

test('check rejects an unlabeled external OpenRouter campaign for the Serf runtime family', () => {
  const root = mkdtempSync(join(tmpdir(), 'scn-'));
  const credentials = join(root, 'campaign.yaml');
  writeFileSync(
    credentials,
    [
      'candidate:',
      '  model: openrouter/@preset/example-a',
      '  harnesses: [serf]',
      '  api: openai-chat',
      '  base_url: https://openrouter.ai/api/v1',
      '  api_key_env: OPENROUTER_API_KEY',
      '',
    ].join('\n'),
  );

  const proc = spawnSync(
    'bun',
    [
      CLI,
      'check',
      '--scenarios-root',
      root,
      '--coding-agents-dir',
      root,
      '--credentials-file',
      credentials,
    ],
    { encoding: 'utf8' },
  );

  expect(proc.status).toBe(1);
  expect(proc.stdout).toContain('FAIL credentials');
  expect(proc.stdout).toContain('route-attestation labels');
});

test.each([
  [
    'custom endpoint',
    'openrouter/@preset/example-a',
    'https://router.example.test/v1',
    'openai-chat',
    'api-key',
    'OPENROUTER_API_KEY',
  ],
  [
    'canonical endpoint with trailing slash',
    'openrouter/@preset/example-a',
    'https://openrouter.ai/api/v1/',
    'openai-chat',
    'api-key',
    'OPENROUTER_API_KEY',
  ],
  [
    'non-preset model profile',
    'example/model-a',
    'https://openrouter.ai/api/v1',
    'openai-chat',
    'api-key',
    'OPENROUTER_API_KEY',
  ],
  [
    'wrong API key environment',
    'openrouter/@preset/example-a',
    'https://openrouter.ai/api/v1',
    'openai-chat',
    'api-key',
    'EXAMPLE_PROVIDER_KEY',
  ],
  [
    'wrong wire API',
    'openrouter/@preset/example-a',
    'https://openrouter.ai/api/v1',
    'openai-responses',
    'api-key',
    'OPENROUTER_API_KEY',
  ],
  [
    'wrong auth mode',
    'openrouter/@preset/example-a',
    'https://openrouter.ai/api/v1',
    'openai-chat',
    'oauth',
    'OPENROUTER_API_KEY',
  ],
] as const)('check rejects external Serf campaign profile: %s', (_name, model, baseUrl, api, auth, keyEnv) => {
  const root = mkdtempSync(join(tmpdir(), 'scn-'));
  const credentials = join(root, 'campaign.yaml');
  writeFileSync(
    credentials,
    [
      'candidate:',
      `  model: ${model}`,
      '  harnesses: [serf]',
      `  api: ${api}`,
      `  base_url: ${baseUrl}`,
      `  auth: ${auth}`,
      `  api_key_env: ${keyEnv}`,
      '  labels:',
      '    model: example/model-a',
      '    provider: example-provider',
      '    quantization: fp8',
      '    preset_version_id: 00000000-0000-4000-8000-000000000001',
      '    catalog_as_of: 2026-07-10',
      '',
    ].join('\n'),
  );

  const proc = spawnSync(
    'bun',
    [
      CLI,
      'check',
      '--scenarios-root',
      root,
      '--coding-agents-dir',
      root,
      '--credentials-file',
      credentials,
    ],
    { encoding: 'utf8' },
  );

  expect(proc.status).toBe(1);
  expect(proc.stdout).toContain('Serf OpenRouter campaign v1 profile');
});

test('check rejects unknown fields in an explicit external credentials file', () => {
  const root = mkdtempSync(join(tmpdir(), 'scn-'));
  const credentials = join(root, 'campaign.yaml');
  writeFileSync(
    credentials,
    [
      'campaign:',
      '  model: example/model',
      '  harnesses: [serf]',
      '  unexpected: rejected',
      '',
    ].join('\n'),
  );

  const proc = spawnSync(
    'bun',
    [
      CLI,
      'check',
      '--scenarios-root',
      root,
      '--coding-agents-dir',
      root,
      '--credentials-file',
      credentials,
    ],
    { encoding: 'utf8' },
  );

  expect(proc.status).toBe(1);
  expect(proc.stdout).toContain('FAIL credentials');
  expect(proc.stdout).toContain('unexpected');
});

test('check rejects intrinsic errors in an explicit external credentials file', () => {
  const root = mkdtempSync(join(tmpdir(), 'scn-'));
  const credentials = join(root, 'campaign.yaml');
  writeFileSync(
    credentials,
    [
      'campaign:',
      '  model: example/model',
      '  harnesses: [serf]',
      '  api: mantle',
      '',
    ].join('\n'),
  );

  const proc = spawnSync(
    'bun',
    [
      CLI,
      'check',
      '--scenarios-root',
      root,
      '--coding-agents-dir',
      root,
      '--credentials-file',
      credentials,
    ],
    { encoding: 'utf8' },
  );

  expect(proc.status).toBe(1);
  expect(proc.stdout).toContain('FAIL credentials');
  expect(proc.stdout).toContain(
    "credential 'campaign' has api: mantle but no region",
  );
});

test('check without --credentials-file still enforces canonical agent defaults', () => {
  const root = mkdtempSync(join(tmpdir(), 'scn-'));
  const agentsDir = join(root, 'coding-agents');
  mkdirSync(agentsDir);
  writeFileSync(join(root, 'credentials.yaml'), '{}\n');
  writeFileSync(
    join(agentsDir, 'serf.yaml'),
    [
      'name: serf',
      'runtime_family: serf',
      'binary: serf',
      'home_config_subdir: .serf',
      'session_log_dir: /tmp/sessions',
      'session_log_glob: "*.json"',
      'normalizer: serf',
      'model: example/model',
      'default_credential: missing_default',
      'os_support: [linux]',
      '',
    ].join('\n'),
  );

  const proc = spawnSync(
    'bun',
    [CLI, 'check', '--scenarios-root', root, '--coding-agents-dir', agentsDir],
    { encoding: 'utf8', cwd: root },
  );

  expect(proc.status).toBe(1);
  expect(proc.stdout).toContain('FAIL credentials');
  expect(proc.stdout).toContain(
    "serf: default_credential 'missing_default' not found",
  );
});
