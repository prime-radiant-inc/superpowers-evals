// biome-ignore-all lint/style/noProcessEnv: integration tests must control process environment

import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
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
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultCommandRunner } from '../../src/agents/command-runner.ts';
import { loadStateConfig } from '../../src/appliance/config.ts';
import {
  readCommittedTransitions,
  readProjection,
} from '../../src/campaign/execution-journal.ts';
import { MINIMUM_CHILD_CONTRACT_SHA } from '../../src/campaign/registration.ts';
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

type CampaignRuntime = ReturnType<
  typeof import('../../src/appliance/campaign.ts').campaignCommands
>;

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
  readonly configPath: string;
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
  const pinned = process.env['QUORUM_DOCKER_IMAGE_DIGEST'];
  if (!pinned || !IMAGE_DIGEST_RE.test(pinned) || value !== pinned)
    throw new Error(
      'QUORUM_DOCKER_IMAGE_DIGEST must be a pinned image ID matching superpowers-evals:local',
    );
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

function _withEnvironment<T>(
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
      'schema_version: 2',
      `name: ${SCENARIO}`,
      'reserve: 0',
      'max_exposure_skew: 60',
      'attempt_bounds: {max_attempts: 1, max_time_s: 120}',
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

async function loadCampaignRuntime(
  root: string,
  configPath: string,
): Promise<CampaignRuntime> {
  const module = (await import(
    pathToFileURL(join(root, 'src/appliance/campaign.ts')).href
  )) as typeof import('../../src/appliance/campaign.ts');
  return module.campaignCommands({
    loaded: loadStateConfig(configPath, { ensureState: true }),
    runner: defaultCommandRunner,
  });
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
    mkdirSync(join(checkout.root, 'results'), { recursive: true });
    const configPath = join(tempDir, 'appliance.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        root: tempDir,
        evals: { path: checkout.root, remote: 'origin', ref: checkout.commit },
        gauntlet: {
          path: resolve(gauntletRoot),
          remote: 'origin',
          ref: runProcess('git', [
            '-C',
            resolve(gauntletRoot),
            'rev-parse',
            'HEAD',
          ]).stdout.trim(),
        },
        superpowers: { path: resolve(superpowersRoot), remote: 'origin' },
        credential_bundle: { name: 'blessed', path: bundleDir },
        container: {
          name: 'unused',
          results_root: join(checkout.root, 'results'),
        },
        live_spend_lock: lockPath,
      }),
    );
    writeFileSync(
      join(bundleDir, 'metadata.json'),
      JSON.stringify({
        bundle_id: 'fixture',
        rotated_at: new Date().toISOString(),
        providers: ['fake'],
      }),
    );
    imageDigest(); // Required pinned input must match the local tag used by the production helper.
    const registered = runProcess(
      'bun',
      [
        '--no-env-file',
        join(checkout.root, 'src/appliance/cli.ts'),
        'campaign',
        'register',
        join(checkout.root, 'suites', `${SCENARIO}.yaml`),
        '--global-cap',
        '2',
        '--json',
      ],
      {
        cwd: checkout.root,
        env: { ...registerEnv, EVALS_APPLIANCE_CONFIG: configPath },
      },
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
    const runtime = await loadCampaignRuntime(checkout.root, configPath);
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
      configPath,
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
  const result = await fixture.runtime.run({
    campaignSelector: fixture.campaignId,
    json: true,
  });
  expect(result.kind).toBe('launched');
  await waitFor('completed V2 controller and namespace termination', () => {
    const p = readProjection(fixture.campaignDir);
    return p.ended !== null && p.termination !== null ? true : undefined;
  });
  const status = fixture.runtime.status({
    campaignSelector: fixture.campaignId,
    json: true,
  });
  expect(['completed', 'cancelled', 'interrupted']).toContain(status.state);
  fixture.runtime.report({ campaignSelector: fixture.campaignId, json: true });
  return status.state === 'completed' ? 0 : 1;
}

function journalEvents(
  campaignDir: string,
): readonly { type: string; payload: Record<string, unknown> }[] {
  return readCommittedTransitions(campaignDir).map((receipt) => ({
    type: receipt.transition.type,
    payload: receipt.transition.payload,
  }));
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
  for (const target of [
    '/run/quorum/attempt-authority.json',
    '/run/quorum/credentials.yaml',
  ]) {
    const mount = mounts.find((m) => m.Destination === target);
    expect(mount?.RW).toBe(false);
    expect(
      mount?.Source?.startsWith(join(fixture.campaignDir, 'control') + sep),
    ).toBe(true);
    expect(mount?.Source?.startsWith(attemptDir + sep)).toBe(false);
    if (target.endsWith('attempt-authority.json')) {
      const authority = JSON.parse(readFileSync(mount!.Source!, 'utf8'));
      expect(authority.campaign_id).toBe(fixture.campaignId);
      expect(authority.intent.identity.execution_attempt_id).toBe(attemptId);
    }
  }
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
  // Campaign commands own no generic job status; scan any invocation receipts
  // alongside the frozen document without scanning credentials.
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

function gauntletResultFiles(fixture: DockerFixture): string[] {
  const resultsRoot = join(fixture.checkout.root, 'results');
  const resultMarker = `${sep}gauntlet-agent${sep}results${sep}`;
  return filesUnder(resultsRoot).filter((path) => path.includes(resultMarker));
}

function diagnosticDestination(
  fixture: DockerFixture,
  diagnosticRoot: string,
  source: string,
): string {
  const attemptsRoot = join(fixture.campaignDir, 'attempts');
  if (source === attemptsRoot || source.startsWith(`${attemptsRoot}${sep}`)) {
    return join(diagnosticRoot, 'attempts', relative(attemptsRoot, source));
  }
  const resultsRoot = join(fixture.checkout.root, 'results');
  return join(diagnosticRoot, 'results', relative(resultsRoot, source));
}

function tailFile(path: string, maxCharacters = 4_000): string {
  const text = readFileSync(path, 'utf8');
  if (text === '') return '(empty)';
  if (text.length <= maxCharacters) return text;
  return `[...truncated to the last ${maxCharacters} characters...]\n${text.slice(-maxCharacters)}`;
}

function captureFailureDiagnostics(fixture: DockerFixture): string {
  try {
    const diagnosticRoot = join(fixture.tempDir, 'failure-diagnostics');
    const sources = [
      ...attemptLogFiles(fixture),
      ...gauntletResultFiles(fixture),
    ];
    const lines = ['failure diagnostics captured before teardown:'];
    if (sources.length === 0) {
      lines.push(
        'no retained attempt logs or gauntlet result files were found',
      );
      return lines.join('\n');
    }
    for (const source of sources) {
      const destination = diagnosticDestination(
        fixture,
        diagnosticRoot,
        source,
      );
      const label = relative(diagnosticRoot, destination);
      try {
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(source, destination);
        lines.push(`--- ${label} tail ---`, tailFile(destination));
      } catch (error) {
        lines.push(
          `--- ${label} capture failed: ${error instanceof Error ? error.message : String(error)} ---`,
        );
      }
    }
    return lines.join('\n');
  } catch (error) {
    return `failure diagnostics capture failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function captureRetainedContainers(fixture: DockerFixture): string | undefined {
  try {
    fixture.captureContainers(containerIdsForCampaign(fixture.campaignId));
    return undefined;
  } catch (error) {
    return `retained-container enumeration failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function enrichFailure(error: unknown, diagnostics: string): Error {
  const message = `${error instanceof Error ? error.message : String(error)}\n\n${diagnostics}`;
  if (error instanceof Error) {
    error.message = message;
    return error;
  }
  return new Error(message);
}

async function withFailureDiagnostics<T>(
  fixture: DockerFixture,
  action: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  let value!: T;
  let actionError: unknown;
  let actionFailed = false;
  try {
    value = await action();
  } catch (error) {
    actionFailed = true;
    actionError = error;
  }

  const diagnostics = actionFailed
    ? [captureRetainedContainers(fixture), captureFailureDiagnostics(fixture)]
        .filter((line): line is string => line !== undefined)
        .join('\n')
    : undefined;
  let cleanupError: unknown;
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
  }

  if (actionFailed) {
    const enriched = enrichFailure(actionError, diagnostics!);
    if (cleanupError !== undefined) {
      throw new AggregateError(
        [enriched, cleanupError],
        'campaign test and fixture cleanup failed',
      );
    }
    throw enriched;
  }
  if (cleanupError !== undefined) throw cleanupError;
  return value;
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
  const allocations = events.filter((event) => event.type === 'runtime_bound');
  expect(allocations.length).toBeGreaterThan(0);
  const attempts = readProjection(fixture.campaignDir).attempts;
  expect(
    allocations.every((event) => {
      const payload = event.payload;
      return (
        typeof payload['container_id'] === 'string' &&
        CONTAINER_ID_RE.test(payload['container_id']) &&
        attempts.get(String(payload['execution_attempt_id']))?.container_id ===
          payload['container_id'] &&
        attempts.get(String(payload['execution_attempt_id']))?.intent
          .runtime_spec_digest === payload['runtime_spec_digest']
      );
    }),
  ).toBe(true);
  expect(
    new Set(allocations.map((event) => String(event.payload['container_id']))),
  ).toEqual(new Set(containerIds));
  expect(events.some((event) => event.type === 'attempt_observed')).toBe(true);
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
  await withFailureDiagnostics(
    fixture,
    async () => {
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
    },
    fixture.cleanup,
  );
}, 180_000);

it('keeps daemonized subject children from holding a completed container', async () => {
  const fixture = await createFixture({ mode: 'daemonize', n: 1 });
  await withFailureDiagnostics(
    fixture,
    async () => {
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
    },
    fixture.cleanup,
  );
}, 180_000);

it('turns docker stop into a stopped verdict and publishes exit evidence', async () => {
  const fixture = await createFixture({ mode: 'hold', n: 1 });
  let run: Promise<number> | null = null;
  await withFailureDiagnostics(
    fixture,
    async () => {
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
    },
    async () => awaitRunAndCleanup(run, fixture.cleanup),
  );
}, 180_000);

it('retains mode-0600 logs after a SIGKILL without leaving a running agent', async () => {
  const fixture = await createFixture({ mode: 'hold', n: 1 });
  let run: Promise<number> | null = null;
  await withFailureDiagnostics(
    fixture,
    async () => {
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
    },
    async () => awaitRunAndCleanup(run, fixture.cleanup),
  );
}, 180_000);

it('gives parallel attempts the same tmux path and separate backing mounts', async () => {
  const fixture = await createFixture({ mode: 'hold', n: 2 });
  let run: Promise<number> | null = null;
  await withFailureDiagnostics(
    fixture,
    async () => {
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
      expect(
        attemptBackingSources.every((source) => source !== undefined),
      ).toBe(true);
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
    },
    async () => awaitRunAndCleanup(run, fixture.cleanup),
  );
}, 180_000);

import {
  CommandClientTimeoutError,
  type CommandRunner,
  SpawnCommandRunner,
} from '../../src/agents/command-runner.ts';
// Task 5 runtime gates. These require the actual Linux daemon and the exact
// built image, and are intentionally not evidence from the portable suite.
import {
  ContainerAttemptRuntime,
  containerNameForAttempt,
} from '../../src/campaign/container-spawner.ts';
import {
  jcsCanonicalize,
  sha256Hex,
} from '../../src/contracts/campaign/digest.ts';
import type {
  BoundExecution,
  PreparedExecution,
} from '../../src/contracts/campaign/execution.ts';
import {
  blockActivation,
  twoArmExperiment,
} from '../fixtures/core-comparison/factory.ts';

function deadlineFixture(body: string, maxTime = 1) {
  const image = process.env['QUORUM_DOCKER_IMAGE_DIGEST'];
  if (!image || !IMAGE_DIGEST_RE.test(image))
    throw new Error(
      'set QUORUM_DOCKER_IMAGE_DIGEST to the exact built Task 5 image ID',
    );
  const root = mkdtempSync(join(tmpdir(), 'quorum-deadline-'));
  chmodSync(root, 0o755);
  const output = join(root, 'output');
  mkdirSync(output);
  chmodSync(output, 0o777);
  const script = join(root, 'probe.sh');
  writeFileSync(script, `#!/usr/bin/env bash\nset -eu\n${body}\n`, {
    mode: 0o555,
  });
  const authority = join(root, 'authority.json');
  writeFileSync(authority, '{}\n', { mode: 0o444 });
  const intent = blockActivation(twoArmExperiment()).attempts[0]!;
  intent.identity.campaign_id = randomUUID();
  intent.output_root = output;
  intent.container_name = containerNameForAttempt(
    intent.identity.campaign_id,
    intent.identity.execution_attempt_id,
  );
  const spec = intent.runtime_spec;
  spec.image_digest = image;
  spec.command = script;
  spec.args = [];
  spec.entrypoint = ['/usr/bin/timeout'];
  spec.cwd = output;
  spec.user = {
    uid: process.getuid?.() || 1000,
    gid: process.getgid?.() || 1000,
  };
  spec.labels = {
    ...spec.labels,
    'quorum.campaign_id': intent.identity.campaign_id,
    'quorum.image_digest': image,
  };
  spec.mounts = [
    { source: output, target: output, mode: 'rw' },
    { source: script, target: script, mode: 'ro' },
    {
      source: authority,
      target: '/run/quorum/attempt-authority.json',
      mode: 'ro',
    },
  ];
  spec.public_env = {
    ...spec.public_env,
    HOME: join(output, 'home'),
    XDG_CONFIG_HOME: join(output, 'home/.config'),
    XDG_CACHE_HOME: join(output, 'home/.cache'),
    XDG_STATE_HOME: join(output, 'home/.local/state'),
    QUORUM_ATTEMPT_DIR: output,
    QUORUM_ATTEMPT_AUTHORITY_FILE: '/run/quorum/attempt-authority.json',
  };
  const credentials = join(root, 'credentials.yaml');
  writeFileSync(credentials, '{}\n', { mode: 0o444 });
  spec.credential_projection = {
    path: '/run/quorum/credentials.yaml',
    sha256: sha256Hex('{}\n'),
  };
  spec.mounts.push({
    source: credentials,
    target: spec.credential_projection.path,
    mode: 'ro',
  });
  spec.args.push('--credentials-file', spec.credential_projection.path);
  spec.max_time_s = maxTime;
  spec.tmpfs_bytes = 1024 * 1024;
  intent.runtime_spec_digest = sha256Hex(jcsCanonicalize(spec));
  const prepared: PreparedExecution = { intent };
  let bound: BoundExecution | undefined;
  let committed = false;
  const options = {
    runner: defaultCommandRunner,
    assertCreateAuthorized: () => {},
    assertStartAuthorized: () => {
      if (!committed) throw new Error('binding not committed');
    },
    startSettlement: () => 'uncertain' as const,
  };
  const runtime = new ContainerAttemptRuntime(options);
  return {
    root,
    output,
    prepared,
    runtime,
    options,
    async create() {
      bound = await runtime.create(prepared);
      return bound;
    },
    commit() {
      committed = true;
    },
    cleanup() {
      if (bound)
        defaultCommandRunner.run(
          'docker',
          ['rm', '--force', bound.container_id],
          { timeoutMs: 10000 },
        );
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function awaitFile(path: string, timeoutMs = 10000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${path}`);
    await Bun.sleep(20);
  }
}
async function namespaceDeadline(body: string, maxTime = 1) {
  const f = deadlineFixture(body, maxTime);
  try {
    const bound = await f.create();
    f.commit();
    const started = Date.now();
    const monitor = await f.runtime.start(bound);
    const stopped = await new Promise((resolve, reject) => {
      monitor.onStopped(resolve);
      monitor.onMonitorFailure((reason) => reject(new Error(reason)));
    });
    expect(stopped).toMatchObject({
      container_id: bound.container_id,
      proof: 'inspected_stopped',
    });
    const inspect = JSON.parse(
      defaultCommandRunner.run('docker', ['inspect', bound.container_id], {
        timeoutMs: 10000,
      }).stdout,
    )[0];
    expect(inspect.State.Pid).toBe(0);
    expect(inspect.State.Running).toBe(false);
    expect(Date.now() - started).toBeLessThan((maxTime + 10) * 1000);
    return {
      exitCode: inspect.State.ExitCode,
      probe: existsSync(join(f.output, 'probe'))
        ? readFileSync(join(f.output, 'probe'), 'utf8')
        : '',
    };
  } finally {
    f.cleanup();
  }
}

it('V2 Linux deadline normal exit preserves namespace-death proof', async () => {
  const result = await namespaceDeadline(
    'printf normal > "$QUORUM_ATTEMPT_DIR/probe"; exit 0',
  );
  expect(result).toEqual({ exitCode: 0, probe: 'normal' });
}, 20000);

it('V2 Linux deadline delivers TERM to a handling attempt', async () => {
  const result = await namespaceDeadline(
    'trap \'printf term > "$QUORUM_ATTEMPT_DIR/probe"; exit 0\' TERM\nwhile :; do sleep 0.1; done',
  );
  expect(result).toEqual({ exitCode: 124, probe: 'term' });
}, 20000);

it('V2 Linux deadline kills setsid TERM-ignoring descendants through PID namespace teardown', async () => {
  const f = deadlineFixture(
    'trap "" TERM\nsetsid bash -c \'trap "" TERM; while :; do sleep 0.1; done\' quorum-deadline-descendant &\nprintf ready > "$QUORUM_ATTEMPT_DIR/ready"\nwait',
    2,
  );
  try {
    const bound = await f.create();
    f.commit();
    const monitor = await f.runtime.start(bound);
    await awaitFile(join(f.output, 'ready'));
    const top = defaultCommandRunner.run(
      'docker',
      ['top', bound.container_id, '-eo', 'pid,args'],
      { timeoutMs: 10000 },
    );
    expect(top.status).toBe(0);
    const descendant = top.stdout
      .split('\n')
      .find((line) => line.includes('quorum-deadline-descendant'))
      ?.trim()
      .split(/\s+/)[0];
    expect(descendant).toMatch(/^\d+$/);
    expect(existsSync(`/proc/${descendant}`)).toBe(true);
    await new Promise((resolve, reject) => {
      monitor.onStopped(resolve);
      monitor.onMonitorFailure((reason) => reject(new Error(reason)));
    });
    expect(existsSync(`/proc/${descendant}`)).toBe(false);
  } finally {
    f.cleanup();
  }
}, 20000);

it('V2 Linux create-before-bind never starts a process and remains discoverable for cancellation', async () => {
  const f = deadlineFixture('touch "$QUORUM_ATTEMPT_DIR/launched"');
  try {
    const bound = await f.create();
    await expect(f.runtime.start(bound)).rejects.toThrow(
      'binding not committed',
    );
    expect(existsSync(join(f.output, 'launched'))).toBe(false);
    expect(
      await new ContainerAttemptRuntime(f.options).inspectOwned(f.prepared),
    ).toMatchObject({
      kind: 'matching-created',
      container_id: bound.container_id,
    });
  } finally {
    f.cleanup();
  }
}, 20000);

it('V2 Linux deadline survives a killed controller without a replacement', async () => {
  const f = deadlineFixture(
    'trap "" TERM\nprintf ready > "$QUORUM_ATTEMPT_DIR/ready"\nwhile :; do sleep 0.1; done',
    1,
  );
  const receipt = join(f.root, 'bound.json');
  const module = pathToFileURL(
    resolve('src/campaign/container-spawner.ts'),
  ).href;
  const runnerModule = pathToFileURL(
    resolve('src/agents/command-runner.ts'),
  ).href;
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    import {ContainerAttemptRuntime} from ${JSON.stringify(module)};
    import {defaultCommandRunner} from ${JSON.stringify(runnerModule)};
    import {writeFileSync} from 'node:fs';
    const runtime=new ContainerAttemptRuntime({runner:defaultCommandRunner,assertCreateAuthorized(){},assertStartAuthorized(){},startSettlement(){return 'uncertain';},dockerWait:()=>new Promise(()=>{})});
    const bound=await runtime.create(${JSON.stringify(f.prepared)});
    writeFileSync(${JSON.stringify(receipt)},JSON.stringify(bound));
    await runtime.start(bound);setInterval(()=>{},1000);
  `,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  let bound: BoundExecution | undefined;
  try {
    await awaitFile(receipt);
    bound = JSON.parse(readFileSync(receipt, 'utf8')) as BoundExecution;
    await awaitFile(join(f.output, 'ready'));
    child.kill('SIGKILL');
    await child.exited;
    await Bun.sleep(7500);
    expect(
      (await new ContainerAttemptRuntime(f.options).inspectOwned(f.prepared))
        .kind,
    ).toBe('matching-stopped');
    expect(
      (await new ContainerAttemptRuntime(f.options).stop(bound, 1)).kind,
    ).toBe('unresolved');
  } finally {
    child.kill('SIGKILL');
    await child.exited;
    if (bound)
      defaultCommandRunner.run(
        'docker',
        ['rm', '--force', bound.container_id],
        { timeoutMs: 10000 },
      );
    f.cleanup();
  }
}, 20000);

it('V2 Linux Docker client timeout forcibly ends a stalled client without claiming daemon state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quorum-client-timeout-'));
  const socket = join(root, 'docker.sock');
  const ready = join(root, 'ready');
  const server = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    import net from 'node:net';import {writeFileSync} from 'node:fs';
    net.createServer(socket=>socket.on('data',()=>{})).listen(${JSON.stringify(socket)},()=>writeFileSync(${JSON.stringify(ready)},''));
  `,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  try {
    await awaitFile(ready);
    expect(() =>
      new SpawnCommandRunner().run(
        'docker',
        ['--host', `unix://${socket}`, 'inspect', 'a'.repeat(64)],
        { timeoutMs: 100 },
      ),
    ).toThrow(CommandClientTimeoutError);
  } finally {
    server.kill('SIGKILL');
    await server.exited;
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

it('V2 Linux delayed daemon start after a stopped snapshot stays unresolved until an operation receipt', async () => {
  const f = deadlineFixture(
    'printf late > "$QUORUM_ATTEMPT_DIR/late"; sleep 10',
    10,
  );
  let bound: BoundExecution | undefined;
  let delayed: ReturnType<typeof Bun.spawn> | undefined;
  const receipt = join(f.root, 'start-receipt');
  const runner: CommandRunner = {
    run(command, args, options) {
      if (args[0] === 'start') {
        delayed = Bun.spawn(
          [
            process.execPath,
            '-e',
            `await Bun.sleep(500);const child=Bun.spawn(['docker','start',${JSON.stringify(args[1])}],{stdout:'ignore',stderr:'ignore'});if(await child.exited===0)await Bun.write(${JSON.stringify(receipt)},'docker_start_succeeded');`,
          ],
          { stdout: 'ignore', stderr: 'ignore' },
        );
        throw new CommandClientTimeoutError('docker', 1);
      }
      return defaultCommandRunner.run(command, args, options);
    },
  };
  const runtime = new ContainerAttemptRuntime({ ...f.options, runner });
  try {
    bound = await runtime.create(f.prepared);
    f.commit();
    await expect(runtime.start(bound)).rejects.toThrow(
      CommandClientTimeoutError,
    );
    expect((await runtime.stop(bound, 1)).kind).toBe('unresolved');
    await awaitFile(join(f.output, 'late'));
    await awaitFile(receipt);
    expect((await runtime.stop(bound, 1)).kind).toBe('unresolved');
    const cancellation = new ContainerAttemptRuntime({
      ...f.options,
      startSettlement: () =>
        readFileSync(receipt, 'utf8') === 'docker_start_succeeded'
          ? 'settled'
          : 'uncertain',
    });
    expect((await cancellation.stop(bound, 1)).kind).toBe('dead');
  } finally {
    if (delayed) await delayed.exited;
    if (bound)
      defaultCommandRunner.run(
        'docker',
        ['rm', '--force', bound.container_id],
        { timeoutMs: 10000 },
      );
    f.cleanup();
  }
}, 25000);
