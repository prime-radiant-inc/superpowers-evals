import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  executeRunCommand,
  installRunStopHandlers,
  type RunStopState,
} from '../src/cli/run-command.ts';
import { AttemptManifestSchema } from '../src/runner/manifest.ts';
import { mockGauntletDir } from './mock-gauntlet/shim.ts';

const RUN_CHILD = resolve(import.meta.dir, '..', 'src', 'cli', 'run-child.ts');
const REAL_CODING_AGENTS = resolve(import.meta.dir, '..', 'coding-agents');
const REPO_CREDENTIALS = resolve(import.meta.dir, '..', 'credentials.yaml');
const MOCK = resolve(import.meta.dir, 'mock-gauntlet');
const HOST_STATS_FIXTURE = resolve(
  import.meta.dir,
  'fixtures',
  'host-stats.json',
);
const SPEND_LOCK = join(mkdtempSync(join(tmpdir(), 'qlock-')), 'live.lock.d');

const IDENTITY = {
  campaign_id: 'c'.repeat(64),
  comparison_id: 'c1',
  block_id: 'c1:scn-a:b1',
  sample_id: 'c1:scn-a:arm_a:r1',
  execution_attempt_id: 'c1:scn-a:arm_a:r1:a1',
};

class FakeSignalSource {
  private readonly handlers = new Map<NodeJS.Signals, () => void>();

  once(signal: NodeJS.Signals, handler: () => void): void {
    this.handlers.set(signal, handler);
  }

  off(signal: NodeJS.Signals, handler: () => void): void {
    if (this.handlers.get(signal) === handler) this.handlers.delete(signal);
  }

  emit(signal: NodeJS.Signals): void {
    const handler = this.handlers.get(signal);
    this.handlers.delete(signal);
    handler?.();
  }

  listenerCount(): number {
    return this.handlers.size;
  }
}

function scenario(): string {
  const scn = mkdtempSync(join(tmpdir(), 'scn-sigterm-'));
  writeFileSync(
    join(scn, 'story.md'),
    '---\nquorum_max_time: 1m\n---\nDo the thing.',
  );
  writeFileSync(join(scn, 'setup.sh'), '#!/usr/bin/env bash\n:\n');
  chmodSync(join(scn, 'setup.sh'), 0o755);
  writeFileSync(join(scn, 'checks.sh'), 'pre() { :; }\npost() { :; }\n');
  return scn;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function pollFor(
  predicate: () => string | undefined,
  deadlineMs: number,
): Promise<string | undefined> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    const result = predicate();
    if (result !== undefined) return result;
    await sleep(25);
  }
  return predicate();
}

function hangRunDir(outRoot: string): string | undefined {
  if (!existsSync(outRoot)) return undefined;
  for (const name of readdirSync(outRoot)) {
    const dir = join(outRoot, name);
    if (existsSync(join(dir, 'mock-gauntlet-hang.pid'))) return dir;
  }
  return undefined;
}

async function runStopped(campaign: boolean): Promise<string> {
  const outRoot = mkdtempSync(join(tmpdir(), 'out-sigterm-'));
  const child = spawn(
    'bun',
    [
      RUN_CHILD,
      scenario(),
      '--coding-agent',
      'claude',
      '--coding-agents-dir',
      REAL_CODING_AGENTS,
      '--out-root',
      outRoot,
      '--credentials-file',
      REPO_CREDENTIALS,
      ...(campaign ? ['--campaign-identity', JSON.stringify(IDENTITY)] : []),
    ],
    {
      env: {
        ...Bun.env,
        QUORUM_LIVE_SPEND_LOCK: SPEND_LOCK,
        QUORUM_HOST_STATS_PROBE_FIXTURE: HOST_STATS_FIXTURE,
        PATH: `${mockGauntletDir('hang')}:${MOCK}:${Bun.env['PATH'] ?? ''}`,
        ANTHROPIC_API_KEY: 'sk-test',
        AWS_BEARER_TOKEN_BEDROCK: 'bedrock-key-test',
        SUPERPOWERS_ROOT: mkdtempSync(join(tmpdir(), 'sproot-')),
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    },
  );
  const exited = new Promise<number | null>((resolveExit) => {
    child.on('exit', (code) => resolveExit(code));
  });
  try {
    const runDir = await pollFor(() => hangRunDir(outRoot), 30_000);
    expect(runDir).toBeDefined();
    if (runDir === undefined) throw new Error('mock gauntlet never hung');
    child.kill('SIGTERM');
    expect(await exited).toBe(2);
    return runDir;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    await exited;
  }
}

test('SIGTERM and SIGINT share one idempotent stop path', () => {
  const state: RunStopState = { stopExitCode: null };
  const killed: NodeJS.Signals[] = [];
  const source = new FakeSignalSource();
  const uninstall = installRunStopHandlers(
    state,
    (signal) => {
      killed.push(signal);
    },
    source,
  );

  try {
    source.emit('SIGTERM');
    source.emit('SIGINT');
    source.emit('SIGTERM');

    expect(state.stopExitCode).toBe(2);
    expect(killed).toEqual(['SIGINT']);
  } finally {
    uninstall();
  }
});

test('run stop listeners are removed when setup validation throws', async () => {
  const source = new FakeSignalSource();
  const missingRoot = join(
    mkdtempSync(join(tmpdir(), 'missing-root-')),
    'none',
  );
  const sigintListeners = process.listenerCount('SIGINT');
  const sigtermListeners = process.listenerCount('SIGTERM');
  await expect(
    executeRunCommand(
      scenario(),
      {
        codingAgent: 'claude',
        os: 'linux',
        codingAgentsDir: REAL_CODING_AGENTS,
        outRoot: mkdtempSync(join(tmpdir(), 'out-stop-cleanup-')),
        scenariosRoot: 'scenarios',
        superpowersRoot: missingRoot,
      },
      undefined,
      { signalSource: source },
    ),
  ).rejects.toThrow(`--superpowers-root does not exist: ${missingRoot}`);
  expect(source.listenerCount()).toBe(0);
  expect(process.listenerCount('SIGINT')).toBe(sigintListeners);
  expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
});

test('campaign SIGTERM stop rewrites the manifest after overwriting the verdict', async () => {
  const runDir = await runStopped(true);
  const verdictBytes = readFileSync(join(runDir, 'verdict.json'));
  const manifest = AttemptManifestSchema.parse(
    JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8')),
  );
  const verdictEntry = manifest.files.find(
    (file) => file.path === 'verdict.json',
  );
  expect(verdictEntry).toBeDefined();
  expect(verdictEntry?.size).toBe(verdictBytes.length);
  expect(verdictEntry?.sha256).toBe(Bun.SHA256.hash(verdictBytes, 'hex'));
}, 60_000);

test('ordinary SIGTERM stop does not create a campaign manifest', async () => {
  const runDir = await runStopped(false);
  expect(existsSync(join(runDir, 'manifest.json'))).toBe(false);
}, 60_000);
