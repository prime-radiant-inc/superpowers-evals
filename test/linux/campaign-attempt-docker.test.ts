// biome-ignore-all lint/style/noProcessEnv: integration tests must control process environment

import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultCommandRunner } from '../../src/agents/command-runner.ts';
import type { ContainerAttemptSpawnerArgs } from '../../src/campaign/container-spawner.ts';
import { openJournalRead } from '../../src/campaign/journal.ts';
import { MINIMUM_CHILD_CONTRACT_SHA } from '../../src/campaign/registration.ts';
import type { CampaignRunOptions } from '../../src/cli/campaign.ts';
import { RealClock } from '../../src/scheduler/clock.ts';
import {
  type FakeProvider,
  startFakeProvider,
} from './fixtures/fake-provider.ts';

const enabled =
  process.platform === 'linux' &&
  process.env['QUORUM_DOCKER_INTEGRATION'] === '1';
const it = enabled ? test : test.skip;

const SCENARIO = 'campaign_docker_fake';
const IMAGE_REF = 'superpowers-evals:local';
const SUBJECT_ENV = 'FAKE_SUBJECT_KEY';
const GRADER_ENV = 'QUORUM_GRADER_ANTHROPIC_API_KEY';
const GRADER_BASE_URL_ENV = 'QUORUM_GRADER_ANTHROPIC_BASE_URL';
const CONTAINER_ID_RE = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

type FixtureMode = 'complete' | 'daemonize' | 'hold';

interface ProcessResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface DockerMount {
  readonly Type?: string;
  readonly Source?: string;
  readonly Destination?: string;
  readonly RW?: boolean;
}

interface DockerContainer {
  readonly Id?: string;
  readonly Name?: string;
  readonly Config?: {
    readonly Env?: readonly string[];
    readonly Image?: string;
    readonly Init?: boolean;
    readonly Labels?: Readonly<Record<string, string>> | null;
  };
  readonly HostConfig?: {
    readonly Init?: boolean;
  };
  readonly Mounts?: readonly DockerMount[];
  readonly State?: {
    readonly Running?: boolean;
    readonly ExitCode?: number;
    readonly OOMKilled?: boolean;
    readonly Pid?: number;
  };
}

interface SyntheticCheckout {
  readonly root: string;
  readonly commit: string;
  readonly cleanup: () => void;
}

interface CampaignRuntime {
  readonly campaignRun: typeof import('../../src/cli/campaign.ts').campaignRun;
  readonly ContainerAttemptSpawner: new (
    args: ContainerAttemptSpawnerArgs,
  ) => NonNullable<CampaignRunOptions['spawner']>;
}

interface DockerFixture {
  readonly tempDir: string;
  readonly checkout: SyntheticCheckout;
  readonly campaignDir: string;
  readonly bundleDir: string;
  readonly providerRecord: string;
  readonly provider: FakeProvider;
  readonly subjectValue: string;
  readonly graderValue: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly runtime: CampaignRuntime;
  readonly spawner: NonNullable<CampaignRunOptions['spawner']>;
  readonly campaignId: string;
  readonly cleanup: () => Promise<void>;
  readonly captureContainers: (ids: readonly string[]) => void;
}

interface FixtureOptions {
  readonly mode: FixtureMode;
  readonly n: number;
}

function runProcess(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
  } = {},
): ProcessResult {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
    maxBuffer: Number.POSITIVE_INFINITY,
    timeout: 120_000,
  });
  if (result.error !== undefined) {
    throw new Error(`${command} failed to spawn`);
  }
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function runDocker(args: readonly string[]): ProcessResult {
  const result = runProcess('docker', args);
  if (result.status !== 0) {
    throw new Error(`docker ${args[0] ?? '<command>'} failed`);
  }
  return result;
}

function bridgeGateway(): string {
  const raw = runDocker(['network', 'inspect', 'bridge']).stdout;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('docker bridge inspection was not JSON');
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error('docker bridge inspection had an unexpected shape');
  }
  const network = parsed[0];
  if (network === null || typeof network !== 'object') {
    throw new Error('docker bridge inspection had no network object');
  }
  const ipam = (network as { IPAM?: unknown }).IPAM;
  if (ipam === null || typeof ipam !== 'object') {
    throw new Error('docker bridge inspection had no IPAM object');
  }
  const configs = (ipam as { Config?: unknown }).Config;
  if (!Array.isArray(configs)) {
    throw new Error('docker bridge inspection had no IPAM config');
  }
  const gateway = configs
    .map((entry) => {
      if (entry === null || typeof entry !== 'object') return undefined;
      const value = (entry as { Gateway?: unknown }).Gateway;
      return typeof value === 'string' && value !== '' ? value : undefined;
    })
    .find((value): value is string => value !== undefined);
  if (gateway === undefined) {
    throw new Error('docker bridge has no runtime gateway');
  }
  return gateway;
}

function imageDigest(): string {
  const value = runDocker([
    'image',
    'inspect',
    IMAGE_REF,
    '--format',
    '{{.Id}}',
  ]).stdout.trim();
  if (!IMAGE_DIGEST_RE.test(value)) {
    throw new Error('campaign image did not report a canonical digest');
  }
  return value;
}

function dockerInspect(containerId: string): DockerContainer {
  if (!CONTAINER_ID_RE.test(containerId)) {
    throw new Error('test received a non-canonical container id');
  }
  const raw = runDocker(['inspect', containerId]).stdout;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('docker inspect was not JSON');
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error('docker inspect returned an unexpected shape');
  }
  const container = parsed[0];
  if (container === null || typeof container !== 'object') {
    throw new Error('docker inspect returned no container object');
  }
  return container as DockerContainer;
}

function containerIdsForCampaign(campaignId: string): string[] {
  const output = runDocker([
    'ps',
    '--all',
    '--no-trunc',
    '--quiet',
    '--filter',
    `label=quorum.campaign_id=${campaignId}`,
  ]).stdout;
  const ids = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (!ids.every((id) => CONTAINER_ID_RE.test(id))) {
    throw new Error('docker returned a non-canonical campaign container id');
  }
  return ids;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

async function waitFor<T>(
  description: string,
  predicate: () => T | undefined,
  timeoutMs = 90_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = predicate();
      if (value !== undefined) return value;
    } catch {
      // Docker state is expected to be transient while a container is created.
    }
    await delay(250);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function runningContainers(
  campaignId: string,
  count: number,
): Promise<string[]> {
  return await waitFor(`${count} running campaign containers`, () => {
    const ids = containerIdsForCampaign(campaignId);
    const running = ids.filter(
      (id) => dockerInspect(id).State?.Running === true,
    );
    return running.length >= count ? running.slice(0, count) : undefined;
  });
}

function stopContainers(ids: readonly string[]): void {
  for (const id of ids) {
    if (!CONTAINER_ID_RE.test(id)) {
      throw new Error('refusing to stop a non-canonical captured id');
    }
    const result = runProcess('docker', ['stop', '--time', '1', id]);
    if (
      result.status !== 0 &&
      !result.stderr.includes(`No such container: ${id}`)
    ) {
      throw new Error('docker stop failed for a captured container');
    }
  }
}

function killContainer(id: string): void {
  if (!CONTAINER_ID_RE.test(id)) {
    throw new Error('refusing to kill a non-canonical captured id');
  }
  const result = runProcess('docker', ['kill', '--signal', 'KILL', id]);
  if (
    result.status !== 0 &&
    !result.stderr.includes(`No such container: ${id}`)
  ) {
    throw new Error('docker kill failed for a captured container');
  }
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  const stats = lstatSync(root);
  if (stats.isSymbolicLink()) return [];
  if (stats.isFile()) return [root];
  if (!stats.isDirectory()) return [];
  return readdirSync(root).flatMap((entry) => filesUnder(join(root, entry)));
}

function publishedRunDirs(root: string): string[] {
  const resultsRoot = join(root, 'results');
  if (!existsSync(resultsRoot)) return [];
  return readdirSync(resultsRoot)
    .map((entry) => join(resultsRoot, entry))
    .filter((path) => existsSync(join(path, 'verdict.json')));
}

function attemptDirs(campaignDir: string): string[] {
  const attemptsRoot = join(campaignDir, 'attempts');
  if (!existsSync(attemptsRoot)) return [];
  return readdirSync(attemptsRoot)
    .map((entry) => join(attemptsRoot, entry))
    .filter((path) => lstatSync(path).isDirectory());
}

function assertNoSecretBytes(
  paths: readonly (string | Buffer)[],
  values: readonly string[],
): void {
  for (const path of paths) {
    const bytes = typeof path === 'string' ? readFileSync(path) : path;
    for (const value of values) {
      expect(bytes.includes(Buffer.from(value, 'utf8'))).toBe(false);
    }
  }
}

function withEnvironment<T>(
  overrides: Readonly<Record<string, string>>,
  action: () => T | Promise<T>,
): T | Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(overrides)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    const result = action();
    if (!(result instanceof Promise)) {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      return result;
    }
    return result.finally(() => {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
  } catch (error) {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    throw error;
  }
}

function writeFakeScenario(
  root: string,
  mode: FixtureMode,
  n: number,
  graderBaseUrl: string,
): void {
  for (const directory of [
    'arms',
    'coding-agents',
    'scenarios',
    'suites',
    'estimates',
  ]) {
    rmSync(join(root, directory), { recursive: true, force: true });
  }
  mkdirSync(join(root, 'arms'), { recursive: true });
  mkdirSync(join(root, 'coding-agents', 'fake-context'), {
    recursive: true,
  });
  mkdirSync(join(root, 'scenarios', SCENARIO), { recursive: true });
  mkdirSync(join(root, 'suites'), { recursive: true });
  mkdirSync(join(root, 'estimates'), { recursive: true });

  writeFileSync(
    join(root, 'coding-agents', 'fake.yaml'),
    [
      'name: fake',
      'runtime_family: fake',
      'binary: fake-coding-agent',
      'session_log_dir: "${QUORUM_AGENT_HOME}/.claude/projects"',
      'session_log_glob: "**/*.jsonl"',
      'normalizer: claude',
      'home_config_subdir: ".claude"',
      'required_env: []',
      'os_support: ["linux"]',
      '',
    ].join('\n'),
    { mode: 0o644 },
  );
  writeFileSync(
    join(root, 'coding-agents', 'fake-context', 'launch-agent'),
    [
      '#!/bin/sh',
      'exec env -i HOME="$HOME" PATH="$PATH" TERM="$TERM" \\',
      '  sh -c \'set -a; . "$QUORUM_SUBJECT_FILE"; set +a; exec "$QUORUM_AGENT_CWD/fake-coding-agent" "$@"\' -- "$@"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  writeFileSync(
    join(root, 'coding-agents', 'fake-context', 'HOWTO.md'),
    [
      '# Fake subject launch',
      '',
      'Run the subject with this exact command:',
      '',
      '"$QUORUM_LAUNCH_AGENT"',
      '',
      'FAKE-SUBJECT-LAUNCHER: $QUORUM_LAUNCH_AGENT',
      '',
    ].join('\n'),
    { mode: 0o644 },
  );

  const scenarioDir = join(root, 'scenarios', SCENARIO);
  writeFileSync(
    join(scenarioDir, 'story.md'),
    [
      '---',
      `id: ${SCENARIO}`,
      'title: fake subject container protocol smoke',
      'status: ready',
      'quorum_tier: full',
      'quorum_max_time: 2m',
      'tags: campaign,docker,fake',
      '---',
      '',
      'The grader drives the fake subject through the generated launcher.',
      '',
      '## Acceptance Criteria',
      '',
    ].join('\n'),
    { mode: 0o644 },
  );
  writeFileSync(
    join(scenarioDir, 'setup.sh'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cp "$QUORUM_REPO_ROOT/test/linux/fixtures/fake-coding-agent" "$QUORUM_WORKDIR/fake-coding-agent"',
      'chmod 0755 "$QUORUM_WORKDIR/fake-coding-agent"',
      'if [[ -f "$QUORUM_SCENARIO_DIR/fake-agent.conf" ]]; then',
      '  cp "$QUORUM_SCENARIO_DIR/fake-agent.conf" "$QUORUM_WORKDIR/fake-agent.conf"',
      'fi',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  writeFileSync(
    join(scenarioDir, 'checks.sh'),
    [
      'pre() {',
      '  file-exists fake-coding-agent',
      '}',
      '',
      'post() {',
      '  file-exists subject-ran.txt',
      '}',
      '',
    ].join('\n'),
    { mode: 0o644 },
  );
  if (mode !== 'complete') {
    const settings = [
      ...(mode === 'daemonize' ? ['FAKE_AGENT_DAEMONIZE=1'] : []),
      ...(mode === 'hold' ? ['FAKE_AGENT_HOLD=1'] : []),
      '',
    ];
    writeFileSync(join(scenarioDir, 'fake-agent.conf'), settings.join('\n'), {
      mode: 0o644,
    });
  }

  writeFileSync(
    join(root, 'credentials.yaml'),
    [
      'fake_subject:',
      '  model: fake-subject-model',
      '  harnesses: [fake]',
      '  api: anthropic',
      '  auth: api-key',
      `  api_key_env: ${SUBJECT_ENV}`,
      '  max_concurrency: 2',
      '  os_support: [linux]',
      'fake_grader:',
      '  model: claude-fake-grader-0',
      '  harnesses: [claude]',
      '  api: anthropic',
      '  auth: api-key',
      `  api_key_env: ${GRADER_ENV}`,
      `  base_url: '${graderBaseUrl}'`,
      '  max_concurrency: 2',
      '  os_support: [linux]',
      '',
    ].join('\n'),
    { mode: 0o644 },
  );
  writeFileSync(
    join(root, 'arms', 'fake.yaml'),
    [
      'schema_version: 1',
      'name: fake_subject',
      'agent: fake',
      'credential: fake_subject',
      'superpowers: none',
      'os: linux',
      '',
    ].join('\n'),
    { mode: 0o644 },
  );
  writeFileSync(
    join(root, 'suites', `${SCENARIO}.yaml`),
    [
      'schema_version: 1',
      `name: ${SCENARIO}`,
      'kind: exploratory',
      'budget_usd: 10',
      'grader: { credential: fake_grader, model: claude-fake-grader-0 }',
      'comparisons:',
      '  - arm: fake_subject',
      `    scenarios: [${SCENARIO}]`,
      `    n: ${n}`,
      '',
    ].join('\n'),
    { mode: 0o644 },
  );
  writeFileSync(
    join(root, 'estimates', 'v1.json'),
    `${JSON.stringify(
      {
        schema_version: 'quorum.estimates/v1',
        generated_at: new Date().toISOString(),
        corpus: {
          sources: ['task-1c-fake-fixture'],
          run_count: 1,
          duplicates_excluded: 0,
          digest: 'task-1c-fake-fixture',
        },
        entries: [
          {
            scenario: SCENARIO,
            agent: 'fake',
            credential: 'fake_subject',
            os: 'linux',
            duration_s_median: 10,
            duration_n: 1,
            cost_subject_usd_median: 0,
            cost_grader_usd_median: 0.01,
            cost_total_usd_median: 0.01,
            priced_n: 1,
            spread_s: { p25: 10, p75: 10 },
            confidence: 'low',
          },
        ],
        fallbacks: {
          scenario_agent: [],
          scenario: [],
          corpus_median: { duration_s: 10, cost_total_usd: 0.01 },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o644 },
  );
}

function writeGitShim(tempDir: string, minimumCommit: string): string {
  const shimDir = join(tempDir, 'git-shim');
  mkdirSync(shimDir, { recursive: true });
  const shim = join(shimDir, 'git');
  writeFileSync(
    shim,
    [
      '#!/bin/sh',
      `if [ "$1" = "-C" ] && [ "$3" = "merge-base" ] && [ "$4" = "--is-ancestor" ] && [ "$5" = "${minimumCommit}" ]; then`,
      '  exit 0',
      'fi',
      'exec /usr/bin/git "$@"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  chmodSync(shim, 0o755);
  return shimDir;
}

async function loadCampaignRuntime(root: string): Promise<CampaignRuntime> {
  const query = `?task1c=${randomUUID()}`;
  const campaignUrl = `${pathToFileURL(join(root, 'src', 'cli', 'campaign.ts')).href}${query}`;
  const spawnerUrl = `${pathToFileURL(join(root, 'src', 'campaign', 'container-spawner.ts')).href}${query}`;
  const campaign = (await import(
    campaignUrl
  )) as typeof import('../../src/cli/campaign.ts');
  const spawner = (await import(spawnerUrl)) as Pick<
    typeof import('../../src/campaign/container-spawner.ts'),
    'ContainerAttemptSpawner'
  >;
  return {
    campaignRun: campaign.campaignRun,
    ContainerAttemptSpawner: spawner.ContainerAttemptSpawner,
  };
}

async function attemptCleanup(
  errors: unknown[],
  action: () => void | Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    errors.push(error);
  }
}

async function cleanupFixtureResources(args: {
  readonly captured: ReadonlySet<string>;
  readonly provider: FakeProvider;
  readonly checkout: SyntheticCheckout;
  readonly tempDir: string;
}): Promise<void> {
  const errors: unknown[] = [];
  for (const id of args.captured) {
    await attemptCleanup(errors, () => {
      const result = runProcess('docker', ['rm', '-f', id]);
      if (
        result.status !== 0 &&
        !result.stderr.includes(`No such container: ${id}`)
      ) {
        throw new Error(`exact captured-container cleanup failed for ${id}`);
      }
    });
  }
  await attemptCleanup(errors, () => args.provider.stop());
  await attemptCleanup(errors, () => args.checkout.cleanup());
  await attemptCleanup(errors, () => {
    rmSync(args.tempDir, { recursive: true, force: true });
  });
  if (errors.length > 0) {
    throw new AggregateError(errors, 'fixture cleanup failed');
  }
}

async function awaitRunAndCleanup(
  run: Promise<number> | null,
  cleanup: () => Promise<void>,
): Promise<void> {
  const errors: unknown[] = [];
  await attemptCleanup(errors, async () => {
    if (run !== null) await run;
  });
  await attemptCleanup(errors, cleanup);
  if (errors.length > 0) {
    throw new AggregateError(errors, 'campaign run or fixture cleanup failed');
  }
}

async function createFixture(options: FixtureOptions): Promise<DockerFixture> {
  const tempDir = mkdtempSync(join(tmpdir(), 'quorum-task1c-'));
  let checkout: SyntheticCheckout | null = null;
  let provider: FakeProvider | null = null;
  try {
    const gateway = bridgeGateway();
    const subjectValue = `fake-subject-${randomUUID().replaceAll('-', '')}`;
    const graderValue = `fake-grader-${randomUUID().replaceAll('-', '')}`;
    const providerRecord = join(tempDir, 'provider.ndjson');
    provider = startFakeProvider({
      bind: '0.0.0.0',
      port: 0,
      recordPath: providerRecord,
    });
    const graderBaseUrl = `http://${gateway}:${provider.url.port}`;
    const bundleDir = join(tempDir, 'bundle');
    mkdirSync(bundleDir, { mode: 0o700 });
    writeFileSync(
      join(bundleDir, 'credentials.env'),
      [
        `${SUBJECT_ENV}='${subjectValue}'`,
        `${GRADER_ENV}='${graderValue}'`,
        `${GRADER_BASE_URL_ENV}='${graderBaseUrl}'`,
        '',
      ].join('\n'),
      { mode: 0o600 },
    );

    const { createSyntheticCheckout } = await import(
      './fixtures/synthetic-checkout.ts'
    );
    checkout = createSyntheticCheckout({
      scenarioName: SCENARIO,
      configure: (root: string) =>
        writeFakeScenario(root, options.mode, options.n, graderBaseUrl),
    });

    const gauntletRoot = process.env['GAUNTLET_ROOT'];
    if (gauntletRoot === undefined || gauntletRoot === '') {
      throw new Error('GAUNTLET_ROOT is required for the Linux integration');
    }
    const superpowersRoot =
      process.env['SUPERPOWERS_ROOT'] ?? join(tempDir, 'superpowers');
    mkdirSync(superpowersRoot, { recursive: true });
    const lockPath = join(tempDir, 'live-spend.lock.d');
    const environment = {
      GAUNTLET_ROOT: resolve(gauntletRoot),
      SUPERPOWERS_ROOT: resolve(superpowersRoot),
      [SUBJECT_ENV]: subjectValue,
      [GRADER_ENV]: graderValue,
      QUORUM_LIVE_SPEND_LOCK: lockPath,
    };
    const gitShimDir = writeGitShim(tempDir, MINIMUM_CHILD_CONTRACT_SHA);
    const registerEnv = {
      ...process.env,
      ...environment,
      PATH: `${gitShimDir}${delimiter}${process.env['PATH'] ?? ''}`,
    };
    const registered = runProcess(
      'bun',
      [
        '--no-env-file',
        join(checkout.root, 'src', 'cli', 'index.ts'),
        'campaign',
        'register',
        join(checkout.root, 'suites', `${SCENARIO}.yaml`),
        '--estimates',
        join(checkout.root, 'estimates', 'v1.json'),
        '--global-cap',
        '2',
        '--confirm',
      ],
      { cwd: checkout.root, env: registerEnv },
    );
    if (registered.status !== 0) {
      const gitLookup = runProcess('sh', ['-c', 'command -v git'], {
        cwd: checkout.root,
        env: registerEnv,
      });
      const gitShimMode = statSync(join(gitShimDir, 'git')).mode & 0o777;
      throw new Error(
        [
          `synthetic campaign registration failed (status ${registered.status})`,
          `stdout:\n${registered.stdout.trim()}`,
          `stderr:\n${registered.stderr.trim()}`,
          `git lookup: ${gitLookup.stdout.trim()} (status ${gitLookup.status}); shim mode ${gitShimMode.toString(8)}`,
        ].join('\n'),
      );
    }
    const campaignRoot = join(checkout.root, 'campaigns');
    const campaignEntries = readdirSync(campaignRoot).filter(
      (entry) => entry !== 'registration.lock.d',
    );
    if (campaignEntries.length !== 1) {
      throw new Error('synthetic registration did not produce one campaign');
    }
    const campaignDir = join(campaignRoot, campaignEntries[0]!);
    const campaign = JSON.parse(
      readFileSync(join(campaignDir, 'campaign.json'), 'utf8'),
    ) as { campaign_id: string };
    const runtime = await loadCampaignRuntime(checkout.root);
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;
    const spawner = new runtime.ContainerAttemptSpawner({
      runner: defaultCommandRunner,
      clock: new RealClock(),
      stream: { write: () => {} },
      campaignId: campaign.campaign_id,
      campaignDir,
      imageRef: IMAGE_REF,
      imageDigest: imageDigest(),
      evalsSha: checkout.commit,
      bundleDir,
      uid,
      gid,
    });
    if (provider === null || checkout === null) {
      throw new Error('synthetic fixture setup did not complete');
    }
    const activeProvider = provider;
    const activeCheckout = checkout;
    const captured = new Set<string>();
    let cleanupPromise: Promise<void> | null = null;
    return {
      tempDir,
      checkout: activeCheckout,
      campaignDir,
      bundleDir,
      providerRecord,
      provider: activeProvider,
      subjectValue,
      graderValue,
      environment,
      runtime,
      spawner,
      campaignId: campaign.campaign_id,
      captureContainers: (ids) => {
        for (const id of ids) {
          if (!CONTAINER_ID_RE.test(id)) {
            throw new Error('captured a non-canonical container id');
          }
          captured.add(id);
        }
      },
      cleanup: async () => {
        if (cleanupPromise === null) {
          cleanupPromise = cleanupFixtureResources({
            captured,
            provider: activeProvider,
            checkout: activeCheckout,
            tempDir,
          });
        }
        await cleanupPromise;
      },
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    await attemptCleanup(cleanupErrors, async () => {
      if (provider !== null) await provider.stop();
    });
    await attemptCleanup(cleanupErrors, () => checkout?.cleanup());
    await attemptCleanup(cleanupErrors, () => {
      rmSync(tempDir, { recursive: true, force: true });
    });
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'synthetic fixture setup and cleanup failed',
      );
    }
    throw error;
  }
}

async function runCampaign(fixture: DockerFixture): Promise<number> {
  return await withEnvironment(fixture.environment, () =>
    fixture.runtime.campaignRun(fixture.campaignDir, {
      spawner: fixture.spawner,
    }),
  );
}

function journalEvents(campaignDir: string): readonly {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}[] {
  const reader = openJournalRead(campaignDir);
  try {
    return reader.readEvents() as readonly {
      readonly type: string;
      readonly payload: Record<string, unknown>;
    }[];
  } finally {
    reader.close();
  }
}

function assertContainerMountAudit(
  fixture: DockerFixture,
  container: DockerContainer,
): void {
  const mounts = container.Mounts ?? [];
  const sources = mounts
    .map((mount) => mount.Source)
    .filter((source): source is string => source !== undefined);
  const labels = container.Config?.Labels;
  const attemptId = labels?.['quorum.attempt_id'];
  if (typeof attemptId !== 'string' || attemptId === '') {
    throw new Error('container inspect had no attempt identity label');
  }
  expect(labels?.['quorum.campaign_id']).toBe(fixture.campaignId);
  const attemptsRoot = join(fixture.campaignDir, 'attempts');
  const attemptDir = join(attemptsRoot, attemptId);
  const allowedAttemptSources = new Set([
    attemptDir,
    join(attemptDir, '.stage', 'subject.env'),
    join(attemptDir, '.stage', 'grader.env'),
    join(attemptDir, '.stage', 'passwd'),
    join(attemptDir, '.stage', 'group'),
  ]);
  const attemptSources = sources.filter(
    (source) =>
      source === attemptsRoot || source.startsWith(`${attemptsRoot}${sep}`),
  );
  expect(
    attemptSources.every((source) => allowedAttemptSources.has(source)),
  ).toBe(true);
  expect(sources.includes(fixture.bundleDir)).toBe(false);
  expect(sources.includes(join(fixture.campaignDir, 'journal.db'))).toBe(false);
  expect(sources.includes(fixture.campaignDir)).toBe(false);
  expect(sources.includes(join(fixture.campaignDir, 'attempts'))).toBe(false);
  expect(
    mounts.some(
      (mount) =>
        mount.Source === '/var/run/docker.sock' ||
        mount.Destination === '/var/run/docker.sock',
    ),
  ).toBe(false);
  expect(
    mounts.some((mount) => mount.Destination === '/run/quorum/attempt'),
  ).toBe(true);
  const configEnv = container.Config?.Env ?? [];
  expect(configEnv.some((entry) => entry.includes(fixture.subjectValue))).toBe(
    false,
  );
  expect(configEnv.some((entry) => entry.includes(fixture.graderValue))).toBe(
    false,
  );
}

function subjectEvidenceFiles(fixture: DockerFixture): string[] {
  return attemptDirs(fixture.campaignDir).flatMap((attemptDir) =>
    filesUnder(join(attemptDir, 'subject-evidence')).filter((path) =>
      path.endsWith('env.txt'),
    ),
  );
}

function assertSubjectIsolation(fixture: DockerFixture): void {
  const evidence = subjectEvidenceFiles(fixture);
  expect(evidence.length).toBeGreaterThan(0);
  for (const path of evidence) {
    const text = readFileSync(path, 'utf8');
    expect(text.includes(`${SUBJECT_ENV}=${fixture.subjectValue}`)).toBe(true);
    expect(text.includes(fixture.graderValue)).toBe(false);
    expect(text.includes('QUORUM_GRADER_')).toBe(false);
  }
}

function assertAttemptLogsPrivate(fixture: DockerFixture): void {
  const attempts = attemptDirs(fixture.campaignDir);
  expect(attempts.length).toBeGreaterThan(0);
  for (const attempt of attempts) {
    for (const name of ['stdout.log', 'stderr.log', 'exit.json']) {
      const path = join(attempt, name);
      expect(existsSync(path)).toBe(true);
      expect(modeOf(path)).toBe(0o600);
    }
  }
}

interface ProviderRecord {
  readonly headers: Record<string, string | null>;
  readonly conversation_fingerprint: string;
  readonly turn: number;
}

function providerRecords(fixture: DockerFixture): ProviderRecord[] {
  const raw = readFileSync(fixture.providerRecord, 'utf8').trim();
  expect(raw).not.toBe('');
  return raw.split(/\r?\n/).map((line) => JSON.parse(line) as ProviderRecord);
}

function assertProviderRecords(
  fixture: DockerFixture,
  expectedConversations: number,
): void {
  const records = providerRecords(fixture);
  expect(records.length).toBe(expectedConversations * 4);
  const turnsByConversation = new Map<string, number[]>();
  for (const record of records) {
    const turns =
      turnsByConversation.get(record.conversation_fingerprint) ?? [];
    turns.push(record.turn);
    turnsByConversation.set(record.conversation_fingerprint, turns);
    expect(record.headers['x_api_key']).toBe(fixture.graderValue);
    const graderHeaders = Object.entries(record.headers)
      .filter(([, value]) => value?.includes(fixture.graderValue) === true)
      .map(([name]) => name);
    expect(graderHeaders).toEqual(['x_api_key']);
    expect(
      Object.values(record.headers).every(
        (value) => value?.includes(fixture.subjectValue) !== true,
      ),
    ).toBe(true);
  }
  const sequences = [...turnsByConversation.values()].sort((left, right) =>
    left.join(',').localeCompare(right.join(',')),
  );
  expect(turnsByConversation.size).toBe(expectedConversations);
  expect(sequences).toEqual(
    Array.from({ length: expectedConversations }, () => [1, 2, 3, 4]),
  );
}

function jobRecordFiles(fixture: DockerFixture): string[] {
  // Direct campaignRun bypasses the appliance invocation wrapper, so this
  // fixture normally has no state/jobs record. Keep that target explicit for
  // any job record created by the wrapper path without scanning credentials.
  return [
    join(fixture.campaignDir, 'campaign.json'),
    ...filesUnder(join(fixture.tempDir, 'state', 'jobs')),
  ];
}

function attemptLogFiles(fixture: DockerFixture): string[] {
  return attemptDirs(fixture.campaignDir).flatMap((attemptDir) =>
    ['stdout.log', 'stderr.log']
      .map((name) => join(attemptDir, name))
      .filter((path) => existsSync(path)),
  );
}

function assertNoCredentialValuesInControlArtifacts(
  fixture: DockerFixture,
  inspected: readonly DockerContainer[],
): void {
  // Do not scan the whole campaign tree: subject-evidence/env.txt is a
  // deliberately credential-bearing witness for assertSubjectIsolation.
  const dockerInspection = inspected.map((container) =>
    Buffer.from(JSON.stringify(container)),
  );
  const journal = [
    Buffer.from(JSON.stringify(journalEvents(fixture.campaignDir))),
    join(fixture.campaignDir, 'journal.db'),
  ];
  const jobRecords = jobRecordFiles(fixture);
  const logs = attemptLogFiles(fixture);
  assertNoSecretBytes(
    [...dockerInspection, ...journal, ...jobRecords, ...logs],
    [fixture.subjectValue, fixture.graderValue],
  );
}

function assertFullJournal(
  fixture: DockerFixture,
  containerIds: readonly string[],
): void {
  const events = journalEvents(fixture.campaignDir);
  const allocations = events.filter((event) => event.type === 'run_allocated');
  expect(allocations.length).toBeGreaterThan(0);
  expect(
    allocations.every((event) => {
      const payload = event.payload;
      return (
        typeof payload['container_id'] === 'string' &&
        CONTAINER_ID_RE.test(payload['container_id']) &&
        typeof payload['image_digest'] === 'string' &&
        IMAGE_DIGEST_RE.test(payload['image_digest'])
      );
    }),
  ).toBe(true);
  expect(
    new Set(allocations.map((event) => String(event.payload['container_id']))),
  ).toEqual(new Set(containerIds));
  expect(
    events.some(
      (event) =>
        event.type === 'run_completed' || event.type === 'instrument_failure',
    ),
  ).toBe(true);
}

async function waitForRunAllocation(campaignDir: string): Promise<void> {
  await waitFor('run allocation', () => {
    const allocated = attemptDirs(campaignDir).some((attemptDir) => {
      const stdoutLog = join(attemptDir, 'stdout.log');
      return (
        existsSync(stdoutLog) &&
        readFileSync(stdoutLog, 'utf8').includes('run_allocated: ')
      );
    });
    return allocated ? true : undefined;
  });
}

function mountNamespaceIdentity(pid: number | undefined): string {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
    throw new Error('running container had no host PID');
  }
  const namespace = statSync(`/proc/${pid}/ns/mnt`);
  return `${namespace.dev}:${namespace.ino}`;
}

it('publishes complete fake container attempts with scoped credentials', async () => {
  const fixture = await createFixture({ mode: 'complete', n: 2 });
  try {
    const status = await runCampaign(fixture);
    expect(status).toBe(0);

    const ids = containerIdsForCampaign(fixture.campaignId);
    fixture.captureContainers(ids);
    expect(ids.length).toBe(2);
    const inspected = ids.map((id) => dockerInspect(id));
    for (const container of inspected) {
      expect(container.HostConfig?.Init ?? container.Config?.Init).toBe(true);
      expect(container.State?.Running).toBe(false);
      expect(container.State?.ExitCode).toBe(0);
      assertContainerMountAudit(fixture, container);
    }
    assertAttemptLogsPrivate(fixture);
    assertSubjectIsolation(fixture);
    assertProviderRecords(fixture, 2);
    assertNoCredentialValuesInControlArtifacts(fixture, inspected);

    const published = publishedRunDirs(fixture.checkout.root);
    expect(published.length).toBe(2);
    expect(
      published.every(
        (runDir) =>
          existsSync(join(runDir, 'verdict.json')) &&
          existsSync(join(runDir, 'manifest.json')),
      ),
    ).toBe(true);
    assertFullJournal(fixture, ids);
  } finally {
    await fixture.cleanup();
  }
});

it('keeps daemonized subject children from holding a completed container', async () => {
  const fixture = await createFixture({ mode: 'daemonize', n: 1 });
  try {
    const status = await runCampaign(fixture);
    expect(status).toBe(0);
    const ids = containerIdsForCampaign(fixture.campaignId);
    fixture.captureContainers(ids);
    expect(ids.length).toBe(1);
    const container = dockerInspect(ids[0]!);
    expect(container.State?.Running).toBe(false);
    expect(container.State?.ExitCode).toBe(0);
    const daemonMarkers = filesUnder(fixture.campaignDir).filter((path) =>
      path.endsWith('subject-evidence/daemon.pid'),
    );
    expect(daemonMarkers.length).toBe(1);
    expect(readFileSync(daemonMarkers[0]!, 'utf8').trim()).not.toBe('');
    expect(
      container.Config?.Env?.some((entry) => entry.includes('DAEMONIZE')),
    ).toBe(false);
    expect(containerIdsForCampaign(fixture.campaignId)).toEqual(ids);
  } finally {
    await fixture.cleanup();
  }
});

it('turns docker stop into a stopped verdict and publishes exit evidence', async () => {
  const fixture = await createFixture({ mode: 'hold', n: 1 });
  let run: Promise<number> | null = null;
  try {
    run = runCampaign(fixture);
    const ids = await runningContainers(fixture.campaignId, 1);
    fixture.captureContainers(ids);
    await waitForRunAllocation(fixture.campaignDir);
    stopContainers(ids);
    expect(await run).toBe(0);
    for (const id of ids) {
      expect(dockerInspect(id).State?.Running).toBe(false);
    }
    const verdicts = publishedRunDirs(fixture.checkout.root).map(
      (runDir) =>
        JSON.parse(readFileSync(join(runDir, 'verdict.json'), 'utf8')) as {
          final?: string;
          error?: { stage?: string } | null;
        },
    );
    expect(
      verdicts.some(
        (verdict) =>
          verdict.final === 'indeterminate' &&
          verdict.error?.stage === 'stopped',
      ),
    ).toBe(true);
    assertAttemptLogsPrivate(fixture);
  } finally {
    await awaitRunAndCleanup(run, fixture.cleanup);
  }
});

it('retains mode-0600 logs after a SIGKILL without leaving a running agent', async () => {
  const fixture = await createFixture({ mode: 'hold', n: 1 });
  let run: Promise<number> | null = null;
  try {
    run = runCampaign(fixture);
    const ids = await runningContainers(fixture.campaignId, 1);
    fixture.captureContainers(ids);
    killContainer(ids[0]!);
    expect(await run).toBe(0);
    expect(dockerInspect(ids[0]!).State?.Running).toBe(false);
    assertAttemptLogsPrivate(fixture);
    assertNoCredentialValuesInControlArtifacts(fixture, [
      dockerInspect(ids[0]!),
    ]);
  } finally {
    await awaitRunAndCleanup(run, fixture.cleanup);
  }
});

it('gives parallel attempts the same tmux path and separate backing mounts', async () => {
  const fixture = await createFixture({ mode: 'hold', n: 2 });
  let run: Promise<number> | null = null;
  try {
    run = runCampaign(fixture);
    const ids = await runningContainers(fixture.campaignId, 2);
    fixture.captureContainers(ids);
    const inspected = ids.map((id) => dockerInspect(id));
    const tmuxTmpdirs = inspected.map(
      (container) =>
        (container.Config?.Env ?? []).find((entry) =>
          entry.startsWith('TMUX_TMPDIR='),
        ) ?? '',
    );
    expect(tmuxTmpdirs).toEqual([
      'TMUX_TMPDIR=/run/quorum/attempt',
      'TMUX_TMPDIR=/run/quorum/attempt',
    ]);
    const attemptBackingSources = inspected.map((container) => {
      const mount = (container.Mounts ?? []).find(
        (candidate) =>
          typeof candidate.Destination === 'string' &&
          candidate.Destination.startsWith(
            `${join(fixture.campaignDir, 'attempts')}${sep}`,
          ),
      );
      return mount?.Source;
    });
    expect(attemptBackingSources.every((source) => source !== undefined)).toBe(
      true,
    );
    expect(new Set(attemptBackingSources).size).toBe(2);
    expect(
      new Set(
        inspected.map((container) =>
          mountNamespaceIdentity(container.State?.Pid),
        ),
      ).size,
    ).toBe(2);
    expect(
      inspected.every((container) =>
        (container.Mounts ?? []).some(
          (mount) => mount.Destination === '/run/quorum/attempt',
        ),
      ),
    ).toBe(true);
    stopContainers(ids);
    expect(await run).toBe(0);
  } finally {
    await awaitRunAndCleanup(run, fixture.cleanup);
  }
});
