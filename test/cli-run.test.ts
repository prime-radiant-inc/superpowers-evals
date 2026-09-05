import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mockGauntletDir } from './mock-gauntlet/shim.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli', 'index.ts');
const MOCK = resolve(import.meta.dir, 'mock-gauntlet');
// Direct `quorum run` is a top-level live-spend spender (R-LCK-2): pin the
// lock to a per-file tmp path so parallel test processes never contend for
// the $HOME default and tests never touch $HOME.
const SPEND_LOCK = join(mkdtempSync(join(tmpdir(), 'qlock-')), 'live.lock.d');
// The CLI spender verbs run the floors preflight unconditionally through the
// injectable probe (R-LCK-2): portable tests inject a passing host-stats
// fixture through the seam instead of skipping the gate.
const HOST_STATS_FIXTURE = resolve(
  import.meta.dir,
  'fixtures',
  'host-stats.json',
);
const CAMPAIGN_CREDENTIALS = resolve(
  import.meta.dir,
  'fixtures',
  'serf-campaign-credentials.yaml',
);
// The REAL coding-agents/ dir: the runner now requires claude-context/ +
// claude.project-prompt.md for a claude run, and both live here (a synthetic
// fixture would lack them). Its session_log_dir is the same
// ${CLAUDE_CONFIG_DIR}/projects the mock-gauntlet seeds.
const REAL_CODING_AGENTS = resolve(import.meta.dir, '..', 'coding-agents');

function scenario(): string {
  const scn = mkdtempSync(join(tmpdir(), 'scn-'));
  writeFileSync(
    join(scn, 'story.md'),
    '---\nquorum_max_time: 1m\n---\nDo the thing.',
  );
  writeFileSync(join(scn, 'setup.sh'), '#!/usr/bin/env bash\n:\n');
  chmodSync(join(scn, 'setup.sh'), 0o755);
  writeFileSync(join(scn, 'checks.sh'), 'pre() { :; }\npost() { :; }\n');
  return scn;
}

function runCli(
  fixture: string,
  extraArgs: string[] = [],
): { status: number | null; stdout: string; diagnostic: string } {
  const outRoot = mkdtempSync(join(tmpdir(), 'out-'));
  const started = Date.now();
  const proc = spawnSync(
    'bun',
    [
      CLI,
      'run',
      scenario(),
      '--coding-agent',
      'claude',
      '--coding-agents-dir',
      REAL_CODING_AGENTS,
      '--out-root',
      outRoot,
      ...extraArgs,
    ],
    {
      env: {
        ...process.env,
        QUORUM_LIVE_SPEND_LOCK: SPEND_LOCK,
        QUORUM_HOST_STATS_PROBE_FIXTURE: HOST_STATS_FIXTURE,

        // The fixture selection rides in the generated gauntlet shim (the
        // runner's gauntlet-env projection strips a host-exported
        // MOCK_GAUNTLET_FIXTURE); MOCK still provides the `claude` shim.
        PATH: `${mockGauntletDir(fixture)}:${MOCK}:${process.env['PATH'] ?? ''}`,
        ANTHROPIC_API_KEY: 'sk-test',
        // claude.yaml's default_credential is opus_bedrock (Mantle), whose
        // provision resolves this bearer; the mock-gauntlet never makes a real
        // Mantle call, so a fake value suffices.
        AWS_BEARER_TOKEN_BEDROCK: 'bedrock-key-test',
        // The real claude.yaml lists SUPERPOWERS_ROOT in required_env and the
        // $SUPERPOWERS_ROOT context substitution reads it.
        SUPERPOWERS_ROOT: mkdtempSync(join(tmpdir(), 'sproot-')),
      },
      encoding: 'utf8',
    },
  );
  const phases = readdirSync(outRoot).flatMap((name) => {
    try {
      return [
        JSON.parse(readFileSync(join(outRoot, name, 'phase.json'), 'utf8')),
      ];
    } catch {
      return [];
    }
  });
  const diagnostic = JSON.stringify({
    status: proc.status,
    signal: proc.signal,
    elapsed_ms: Date.now() - started,
    outRoot,
    phases,
    stderr: proc.stderr,
  });
  return { status: proc.status, stdout: proc.stdout, diagnostic };
}

test('quorum run exits 1 on a fail verdict and prints run-id', () => {
  const { status, stdout, diagnostic } = runCli('fail-no-usage');
  expect(stdout, diagnostic).toContain('run-id:');
  expect(status).toBe(1);
});

test('quorum run exits 0 on a pass verdict', () => {
  const { status, stdout } = runCli('pass');
  expect(stdout).toContain('run-id:');
  expect(status).toBe(0);
});

test('quorum run embeds linux in run-id by default (no --os flag)', () => {
  const { status, stdout } = runCli('pass');
  expect(stdout).toContain('run-id:');
  // The run-id format is <scenario>-<agent>-<os>-<stamp>-<nonce>; the OS
  // segment must be 'linux' when --os is not supplied.
  const runIdLine = stdout.split('\n').find((l) => l.startsWith('run-id:'));
  expect(runIdLine).toMatch(/-linux-/);
  expect(status).toBe(0);
});

test('quorum run embeds linux in run-id when --os linux is explicit', () => {
  const { status, stdout } = runCli('pass', ['--os', 'linux']);
  expect(stdout).toContain('run-id:');
  const runIdLine = stdout.split('\n').find((l) => l.startsWith('run-id:'));
  expect(runIdLine).toMatch(/-linux-/);
  expect(status).toBe(0);
});

test('quorum run accepts an explicit --credentials-file path', () => {
  // A missing scenario makes the action fail before any paid invocation. The
  // assertion distinguishes a parsed credentials-file option from Commander
  // rejecting it as an unknown option.
  const proc = spawnSync(
    'bun',
    [
      CLI,
      'run',
      'missing-scenario',
      '--coding-agent',
      'claude',
      '--credentials-file',
      CAMPAIGN_CREDENTIALS,
    ],
    { encoding: 'utf8' },
  );

  expect(proc.status).toBe(2);
  expect(proc.stderr).toContain('scenario not found');
  expect(proc.stderr).not.toContain('unknown option');
});

test('direct run cannot classify an arbitrary external credentials file as a snapshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'direct-campaign-'));
  const outRoot = join(root, 'results');
  const credentials = join(root, 'campaign.yaml');
  mkdirSync(outRoot);
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
      'run',
      scenario(),
      '--coding-agent',
      'serf-alias',
      '--coding-agents-dir',
      join(root, 'coding-agents'),
      '--out-root',
      outRoot,
      '--credential',
      'candidate',
      '--credentials-file',
      credentials,
      '--credentials-snapshot',
    ],
    { encoding: 'utf8' },
  );

  expect(proc.status).not.toBe(0);
  expect(proc.stderr).toContain('unknown option');
  expect(readdirSync(outRoot)).toEqual([]);
});

test('direct run validates an arbitrary external credentials file before allocation', () => {
  const root = mkdtempSync(join(tmpdir(), 'direct-campaign-'));
  const outRoot = join(root, 'results');
  const credentials = join(root, 'campaign.yaml');
  mkdirSync(outRoot);
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
      'run',
      scenario(),
      '--coding-agent',
      'serf-alias',
      '--coding-agents-dir',
      join(root, 'coding-agents'),
      '--out-root',
      outRoot,
      '--credential',
      'candidate',
      '--credentials-file',
      credentials,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        QUORUM_LIVE_SPEND_LOCK: SPEND_LOCK,
        QUORUM_HOST_STATS_PROBE_FIXTURE: HOST_STATS_FIXTURE,

        QUORUM_INTERNAL_CREDENTIALS_SNAPSHOT_PATH: credentials,
      },
    },
  );

  expect(proc.status).toBe(1);
  expect(proc.stderr).toContain('route-attestation labels');
  expect(readdirSync(outRoot)).toEqual([]);
});

test('quorum run emits run_allocated before the exit run-id line', () => {
  const { status, stdout } = runCli('pass');
  expect(status).toBe(0);
  const lines = stdout.split('\n');
  const allocatedIndex = lines.findIndex((l) =>
    l.startsWith('run_allocated: '),
  );
  const runIdIndex = lines.findIndex((l) => l.startsWith('run-id:'));
  expect(allocatedIndex).toBeGreaterThanOrEqual(0);
  expect(runIdIndex).toBeGreaterThan(allocatedIndex);
  expect(lines[allocatedIndex]).toBe(
    `run_allocated: ${lines[runIdIndex]?.slice('run-id: '.length)}`,
  );
});
