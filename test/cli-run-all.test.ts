import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildChildRunArgs } from '../src/run-all/index.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli', 'index.ts');
const CAMPAIGN_CREDENTIALS = resolve(
  import.meta.dir,
  'fixtures',
  'serf-campaign-credentials.yaml',
);

// CLI-boundary validation for `run-all`. These pin the fail-fast behavior that
// stops a bad invocation before any agent is launched — they never drive a real
// gauntlet run.

test('run-all rejects a non-integer --jobs value (e.g. 3.5)', () => {
  // Python validates --jobs with click.IntRange(min=1); a fractional token like
  // "3.5" is a usage error. TS must not silently truncate it to 3.
  const root = mkdtempSync(join(tmpdir(), 'scn-'));
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  const proc = spawnSync(
    'bun',
    [
      CLI,
      'run-all',
      '--jobs',
      '3.5',
      '--scenarios-root',
      root,
      '--coding-agents-dir',
      root,
      '--out-root',
      out,
    ],
    { encoding: 'utf8' },
  );
  expect(proc.status).not.toBe(0);
  expect(proc.stderr).toContain('--jobs');
});

test('run-all rejects a trailing-garbage --jobs value (e.g. 8x)', () => {
  const root = mkdtempSync(join(tmpdir(), 'scn-'));
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  const proc = spawnSync(
    'bun',
    [
      CLI,
      'run-all',
      '--jobs',
      '8x',
      '--scenarios-root',
      root,
      '--coding-agents-dir',
      root,
      '--out-root',
      out,
    ],
    { encoding: 'utf8' },
  );
  expect(proc.status).not.toBe(0);
  expect(proc.stderr).toContain('--jobs');
});

test('run-all rejects the removed output-mode option', () => {
  const root = mkdtempSync(join(tmpdir(), 'scn-'));
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  const removedOutputModeOption = `--no-${['cur', 'sor'].join('')}`;
  const proc = spawnSync(
    'bun',
    [
      CLI,
      'run-all',
      removedOutputModeOption,
      '--scenarios-root',
      root,
      '--coding-agents-dir',
      root,
      '--out-root',
      out,
    ],
    { encoding: 'utf8' },
  );
  expect(proc.status).not.toBe(0);
  expect(proc.stderr).toContain(`unknown option '${removedOutputModeOption}'`);
});

test('run-all rejects a non-integer --heartbeat-seconds value (e.g. 1.5)', () => {
  // Asserts the validation message specifically, so an unimplemented flag
  // (commander's "unknown option") fails this test rather than passing it.
  const root = mkdtempSync(join(tmpdir(), 'scn-'));
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  const proc = spawnSync(
    'bun',
    [
      CLI,
      'run-all',
      '--heartbeat-seconds',
      '1.5',
      '--scenarios-root',
      root,
      '--coding-agents-dir',
      root,
      '--out-root',
      out,
    ],
    { encoding: 'utf8' },
  );
  expect(proc.status).not.toBe(0);
  expect(proc.stderr).toContain('--heartbeat-seconds must be an integer');
});

test('run-all accepts --heartbeat-seconds 0 (heartbeat disabled)', () => {
  // Empty roots -> 0 runnable cells -> the batch completes and exits 0, proving
  // the flag parses and 0 is a valid (disabling) value.
  const root = mkdtempSync(join(tmpdir(), 'scn-'));
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  const proc = spawnSync(
    'bun',
    [
      CLI,
      'run-all',
      '--heartbeat-seconds',
      '0',
      '--scenarios-root',
      root,
      '--coding-agents-dir',
      root,
      '--out-root',
      out,
    ],
    { encoding: 'utf8' },
  );
  expect(proc.status).toBe(0);
});

test('run-all errors when --scenarios-root does not exist', () => {
  // Python declares run-all's --scenarios-root as click.Path(exists=True),
  // failing fast at the CLI boundary on a missing root.
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  const proc = spawnSync(
    'bun',
    [
      CLI,
      'run-all',
      '--scenarios-root',
      '/tmp/quorum-does-not-exist-xyz-123',
      '--coding-agents-dir',
      out,
      '--out-root',
      out,
    ],
    { encoding: 'utf8' },
  );
  expect(proc.status).not.toBe(0);
  expect(proc.stderr).toContain('--scenarios-root does not exist');
});

test('run-all errors when --coding-agents-dir does not exist', () => {
  const root = mkdtempSync(join(tmpdir(), 'scn-'));
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  const proc = spawnSync(
    'bun',
    [
      CLI,
      'run-all',
      '--scenarios-root',
      root,
      '--coding-agents-dir',
      '/tmp/quorum-does-not-exist-agents-xyz-123',
      '--out-root',
      out,
    ],
    { encoding: 'utf8' },
  );
  expect(proc.status).not.toBe(0);
  expect(proc.stderr).toContain('--coding-agents-dir does not exist');
});

test('run-all accepts --credentials-file while --credentials remains a CSV filter', () => {
  const root = mkdtempSync(join(tmpdir(), 'scn-'));
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  const proc = spawnSync(
    'bun',
    [
      CLI,
      'run-all',
      '--credentials-file',
      CAMPAIGN_CREDENTIALS,
      '--credentials',
      'serf_example_a',
      '--scenarios-root',
      root,
      '--coding-agents-dir',
      root,
      '--out-root',
      out,
      '--heartbeat-seconds',
      '0',
    ],
    { encoding: 'utf8' },
  );

  expect(proc.status).toBe(0);
  expect(proc.stderr).not.toContain('unknown option');
});

test('buildChildRunArgs forwards the immutable credentials snapshot path', () => {
  const snapshotPath = '/tmp/batch/credentials.snapshot.yaml';
  const args = buildChildRunArgs({
    scenarioDir: '/tmp/scenarios/alpha',
    codingAgent: 'serf',
    codingAgentsDir: '/tmp/coding-agents',
    outRoot: '/tmp/results',
    credentialsPath: snapshotPath,
  });

  expect(args).toContain('--credentials-file');
  expect(args[args.indexOf('--credentials-file') + 1]).toBe(snapshotPath);
  expect(args[0]).toEndWith('/src/cli/run-child.ts');
  expect(args[1]).toBe('/tmp/scenarios/alpha');
  expect(args).not.toContain('run');
  expect(args).not.toContain('--credentials-snapshot');
});

test('internal run-all child consumes an unlabeled canonical snapshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'internal-run-child-'));
  const scenario = join(root, 'scenario');
  const outRoot = join(root, 'results');
  const credentials = join(root, 'credentials.snapshot.yaml');
  mkdirSync(scenario);
  mkdirSync(outRoot);
  writeFileSync(join(scenario, 'story.md'), 'Internal child test.\n');
  writeFileSync(join(scenario, 'checks.sh'), 'pre() { :; }\npost() { :; }\n');
  writeFileSync(
    credentials,
    [
      'canonical:',
      '  model: example/default-model',
      '  harnesses: [serf]',
      '  api: anthropic',
      '  api_key_env: EXAMPLE_PROVIDER_KEY',
      '',
    ].join('\n'),
  );
  const internalEntry = resolve(
    import.meta.dir,
    '..',
    'src',
    'cli',
    'run-child.ts',
  );

  const proc = spawnSync(
    'bun',
    [
      internalEntry,
      scenario,
      '--coding-agent',
      'missing-serf-alias',
      '--coding-agents-dir',
      join(root, 'coding-agents'),
      '--out-root',
      outRoot,
      '--credential',
      'canonical',
      '--credentials-file',
      credentials,
    ],
    { encoding: 'utf8' },
  );

  expect(proc.status).toBe(2);
  expect(proc.stdout).toContain('run-id:');
  expect(readdirSync(outRoot)).toHaveLength(1);
});
