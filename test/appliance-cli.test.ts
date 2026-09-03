import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CommandResult,
  CommandRunner,
} from '../src/agents/command-runner.ts';
import {
  type ApplianceActions,
  createApplianceActions,
  createApplianceProgram,
} from '../src/appliance/cli.ts';
import {
  loadCredentialConfig,
  loadStateConfig,
} from '../src/appliance/config.ts';
import { buildLiveCredentialRequest } from '../src/appliance/credential-request.ts';
import { ApplianceError } from '../src/appliance/errors.ts';
import type { LoadedApplianceConfig } from '../src/appliance/types.ts';
import { envSnapshot } from '../src/env.ts';

function noopActions(
  overrides: Partial<ApplianceActions> = {},
): ApplianceActions {
  return {
    doctor: async () => ({ ok: true }),
    prepare: async () => ({ ok: true }),
    run: async () => ({ ok: true }),
    runAll: async () => ({ ok: true }),
    status: async () => ({ ok: true }),
    cancel: async () => ({ ok: true }),
    show: async () => ({ ok: true }),
    costs: async () => ({ ok: true }),
    import: async () => ({ ok: true }),
    prune: async () => ({ ok: true }),
    campaignRun: async () => ({ ok: true }),
    ...overrides,
  };
}

function loadedForCli(evalsPath: string): LoadedApplianceConfig {
  const root = mkdtempSync(join(tmpdir(), 'appliance-cli-config-'));
  return {
    configPath: join(root, 'appliance.json'),
    config: {
      root,
      evals: { path: evalsPath, remote: 'origin', ref: 'main' },
      superpowers: { path: join(root, 'superpowers'), remote: 'origin' },
      gauntlet: { path: join(root, 'gauntlet'), remote: 'origin', ref: 'main' },
      credential_bundle: {
        name: 'blessed',
        path: join(root, 'credentials/blessed'),
      },
      container: {
        name: 'quorum-appliance',
        results_root: join(evalsPath, 'results'),
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
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function writeAgentYaml(
  evalsPath: string,
  name: string,
  lines: readonly string[],
): void {
  const dir = join(evalsPath, 'coding-agents');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), `${lines.join('\n')}\n`);
}

function writeScenario(evalsPath: string, relativePath: string): void {
  const dir = join(evalsPath, 'scenarios', relativePath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'story.md'), 'id: fixture\n');
  writeFileSync(join(dir, 'setup.sh'), '#!/usr/bin/env bash\n');
  writeFileSync(join(dir, 'checks.sh'), 'pre() { :; }\npost() { :; }\n');
}

// The trusted checkout's own agent + credential corpus. codex_sub is the
// agent default (subscription auth -> an OAuth mount, no env); openai_responses
// is the explicit override (api-key -> one env passthrough). Two shapes, so a
// resolved scope cannot be confused with a defaulted one.
const CODEX_AGENT_LINES: readonly string[] = [
  'name: codex',
  'binary: codex',
  'home_config_subdir: ".codex"',
  'session_log_dir: "${QUORUM_AGENT_HOME}/.codex/sessions"',
  'session_log_glob: "**/rollout-*.jsonl"',
  'normalizer: codex',
  'required_env: []',
  'default_credential: codex_sub',
];

const CODEX_SUB_SCOPE = {
  schemaVersion: 1,
  kind: 'live',
  agent: 'codex',
  runtimeFamily: 'codex',
  credential: 'codex_sub',
  agentEnv: [],
  geminiAuthType: null,
  oauth: { kind: 'codex', mountName: 'codex' },
};

const OPENAI_RESPONSES_SCOPE = {
  schemaVersion: 1,
  kind: 'live',
  agent: 'codex',
  runtimeFamily: 'codex',
  credential: 'openai_responses',
  agentEnv: [
    { destinationName: 'OPENAI_API_KEY', sourceNames: ['OPENAI_API_KEY'] },
  ],
  geminiAuthType: null,
  oauth: null,
};

function writeCredentialsYaml(evalsPath: string): void {
  writeFileSync(
    join(evalsPath, 'credentials.yaml'),
    [
      'codex_sub:',
      '  model: gpt-5.5',
      '  api: openai-responses',
      '  auth: subscription',
      '  harnesses: [codex]',
      'openai_responses:',
      '  model: gpt-5.5',
      '  api: openai-responses',
      '  api_key_env: OPENAI_API_KEY',
      '  harnesses: [codex]',
      'kimi_default:',
      '  model: kimi-k2',
      '  api_key_env: KIMI_MODEL_API_KEY',
      '  harnesses: [kimi]',
      '',
    ].join('\n'),
  );
}

// Real git, not a faked rev-parse: the evals SHA a credential request pins is
// the actual HEAD of the configured checkout, and Task 5 compares against it.
function commitCheckout(evalsPath: string): string {
  const git = (...args: readonly string[]): string => {
    const proc = spawnSync('git', ['-C', evalsPath, ...args], {
      encoding: 'utf8',
    });
    if (proc.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${proc.stderr}`);
    }
    return proc.stdout.trim();
  };
  const init = spawnSync('git', ['init', '-q', '-b', 'main', evalsPath], {
    encoding: 'utf8',
  });
  if (init.status !== 0) {
    throw new Error(`git init failed: ${init.stderr}`);
  }
  git('add', '-A');
  git(
    '-c',
    'user.email=fixture@example.com',
    '-c',
    'user.name=Fixture',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'fixture checkout',
  );
  return git('rev-parse', 'HEAD');
}

interface TrustedCheckout {
  readonly evalsPath: string;
  readonly headSha: string;
}

// A structurally complete trusted evals checkout: agent corpus, credential
// registry, scenarios, and a real commit whose HEAD the request pins.
function trustedCheckout(scenarios: readonly string[] = []): TrustedCheckout {
  const evalsPath = realpathSync(
    mkdtempSync(join(tmpdir(), 'appliance-cli-evals-')),
  );
  writeAgentYaml(evalsPath, 'codex', CODEX_AGENT_LINES);
  writeCredentialsYaml(evalsPath);
  for (const scenario of scenarios) {
    writeScenario(evalsPath, scenario);
  }
  return { evalsPath, headSha: commitCheckout(evalsPath) };
}

test('run-all keeps appliance flags before separator and passes quorum args verbatim', async () => {
  const checkout = trustedCheckout();
  const calls: unknown[] = [];
  const stdout: string[] = [];
  const program = createApplianceProgram({
    stdout: (s) => stdout.push(s),
    stderr: () => undefined,
    loadConfig: () => loadedForCli(checkout.evalsPath),
    actions: noopActions({
      runAll: async (args, request) => {
        calls.push({ args, request });
        return { ok: true, job_id: 'job-1', status: 'preflighting' };
      },
    }),
  });
  await program.parseAsync([
    'node',
    'evals-appliance',
    'run-all',
    '--json',
    '--detach',
    '--superpowers-ref',
    'feature/x',
    '--',
    '--tier',
    'sentinel',
    '--coding-agents',
    'codex',
  ]);
  expect(calls).toEqual([
    {
      args: {
        json: true,
        detach: true,
        superpowersRef: 'feature/x',
        // The forwarded bytes survive byte-for-byte; the request is derived
        // from them, never a rewrite of them.
        quorumArgs: ['--tier', 'sentinel', '--coding-agents', 'codex'],
      },
      request: {
        selection: { agent: 'codex', credential: null },
        scope: CODEX_SUB_SCOPE,
        sourceEvalsSha: checkout.headSha,
      },
    },
  ]);
  expect(stdout.join('\n')).toContain('job-1');
});

test('run-all forwards one explicit credential and resolves it into the request', async () => {
  const checkout = trustedCheckout();
  const calls: unknown[] = [];
  const program = createApplianceProgram({
    stdout: () => undefined,
    stderr: () => undefined,
    loadConfig: () => loadedForCli(checkout.evalsPath),
    actions: noopActions({
      runAll: async (args, request) => {
        calls.push({ args, request });
        return { ok: true };
      },
    }),
  });

  await program.parseAsync([
    'node',
    'evals-appliance',
    'run-all',
    '--json',
    '--superpowers-ref',
    'main',
    '--',
    '--coding-agents',
    'codex',
    '--credentials',
    'openai_responses',
  ]);

  expect(calls).toEqual([
    {
      args: {
        json: true,
        detach: false,
        superpowersRef: 'main',
        quorumArgs: [
          '--coding-agents',
          'codex',
          '--credentials',
          'openai_responses',
        ],
      },
      request: {
        selection: { agent: 'codex', credential: 'openai_responses' },
        scope: OPENAI_RESPONSES_SCOPE,
        sourceEvalsSha: checkout.headSha,
      },
    },
  ]);
});

test('status accepts --json before the id', async () => {
  const ids: string[] = [];
  const program = createApplianceProgram({
    stdout: () => undefined,
    stderr: () => undefined,
    actions: {
      doctor: async () => ({ ok: true }),
      prepare: async () => ({ ok: true }),
      run: async () => ({ ok: true }),
      runAll: async () => ({ ok: true }),
      status: async ({ id }) => {
        ids.push(id);
        return { ok: true };
      },
      cancel: async () => ({ ok: true }),
      show: async () => ({ ok: true }),
      costs: async () => ({ ok: true }),
    },
  });
  await program.parseAsync([
    'node',
    'evals-appliance',
    'status',
    '--json',
    'job-1',
  ]);
  expect(ids).toEqual(['job-1']);
});

test('import forwards the bundle dir with no force flag', async () => {
  const calls: unknown[] = [];
  const program = createApplianceProgram({
    stdout: () => undefined,
    stderr: () => undefined,
    actions: noopActions({
      import: async (args) => {
        calls.push(args);
        return { ok: true };
      },
    }),
  });

  await program.parseAsync([
    'node',
    'evals-appliance',
    'import',
    '--json',
    '/srv/bundles/lane-b',
  ]);

  expect(calls).toEqual([{ json: true, bundleDir: '/srv/bundles/lane-b' }]);
});

test('import renders ok:false and exit 1 for all-failed and mixed results', async () => {
  const failure = {
    run_id: 'r-bad',
    code: 'import_conflict',
    message: 'destination exists with different content',
  };
  const cases: {
    result: {
      imported: number;
      skipped: number;
      healed: number;
      failed: number;
      failures: (typeof failure)[];
      run_ids: string[];
    };
    ok: boolean;
    exits: number[];
  }[] = [
    {
      result: {
        imported: 1,
        skipped: 0,
        healed: 0,
        failed: 0,
        failures: [],
        run_ids: ['r-good'],
      },
      ok: true,
      exits: [],
    },
    {
      result: {
        imported: 0,
        skipped: 0,
        healed: 0,
        failed: 2,
        failures: [failure, { ...failure, run_id: 'r-worse' }],
        run_ids: [],
      },
      ok: false,
      exits: [1],
    },
    {
      result: {
        imported: 1,
        skipped: 0,
        healed: 0,
        failed: 1,
        failures: [failure],
        run_ids: ['r-good'],
      },
      ok: false,
      exits: [1],
    },
  ];
  for (const { result, ok, exits } of cases) {
    const stdout: string[] = [];
    const seenExits: number[] = [];
    const program = createApplianceProgram({
      stdout: (s) => stdout.push(s),
      stderr: () => undefined,
      setExitCode: (code) => seenExits.push(code),
      actions: noopActions({ import: async () => result }),
    });
    await program.parseAsync([
      'node',
      'evals-appliance',
      'import',
      '--json',
      '/srv/bundles/lane-b',
    ]);
    const payload = JSON.parse(stdout.join('')) as {
      ok: boolean;
      imported: number;
      failed: number;
      failures: unknown[];
      run_ids: unknown[];
    };
    expect(payload.ok).toBe(ok);
    // The full result payload survives either way.
    expect(payload.imported).toBe(result.imported);
    expect(payload.failed).toBe(result.failed);
    expect(payload.failures).toEqual(result.failures);
    expect(payload.run_ids).toEqual(result.run_ids);
    expect(seenExits).toEqual(exits);
  }
});

test('the removed --force option is rejected loudly by the actual CLI', () => {
  // Real subprocess: commander's option parsing rejects --force before any
  // config is loaded or any action runs — the loud failure we want.
  const proc = spawnSync(
    'bun',
    ['src/appliance/cli.ts', 'import', '--force', '/tmp/no-such-bundle'],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  expect(proc.status).not.toBe(0);
  expect(`${proc.stderr}${proc.stdout}`).toContain("unknown option '--force'");
});

test('prune defaults to a dry-run with a 7-day floor and forwards --apply', async () => {
  // Fresh program per parse: commander keeps option state across parseAsync
  // calls, which would leak --apply from one invocation into the next.
  const calls: unknown[] = [];
  const parsePrune = async (extra: readonly string[]): Promise<void> => {
    const program = createApplianceProgram({
      stdout: () => undefined,
      stderr: () => undefined,
      actions: noopActions({
        prune: async (args) => {
          calls.push(args);
          return { ok: true };
        },
      }),
    });
    await program.parseAsync(['node', 'evals-appliance', 'prune', ...extra]);
  };

  await parsePrune([]);
  await parsePrune(['--apply']);
  await parsePrune(['--apply', '--older-than-days', '14']);

  expect(calls).toEqual([
    { json: false, apply: false, olderThanDays: 7 },
    { json: false, apply: true, olderThanDays: 7 },
    { json: false, apply: true, olderThanDays: 14 },
  ]);
});

test('prune rejects unsafe --older-than-days values before the action runs', async () => {
  const calls: unknown[] = [];
  for (const extra of [
    ['--older-than-days', '0'],
    ['--older-than-days=-1'],
    ['--older-than-days', '1.5'],
    ['--older-than-days', '7days'],
    ['--older-than-days', 'abc'],
  ]) {
    const stdout: string[] = [];
    const exits: number[] = [];
    const program = createApplianceProgram({
      stdout: (s) => stdout.push(s),
      stderr: () => undefined,
      setExitCode: (code) => exits.push(code),
      actions: noopActions({
        prune: async (args) => {
          calls.push(args);
          return { ok: true };
        },
      }),
    });
    await program.parseAsync([
      'node',
      'evals-appliance',
      'prune',
      '--json',
      '--apply',
      ...extra,
    ]);
    const payload = JSON.parse(stdout.join('')) as {
      ok: boolean;
      error: { code: string };
    };
    expect(payload.ok).toBe(false);
    expect(payload.error.code).toBe('config_invalid');
    expect(exits).toEqual([1]);
  }
  expect(calls).toEqual([]);
});

test('campaign run routes its closed selector and json option to the action', async () => {
  const calls: unknown[] = [];
  const stdout: string[] = [];
  const program = createApplianceProgram({
    stdout: (text) => stdout.push(text),
    stderr: () => undefined,
    actions: noopActions({
      campaignRun: async (args) => {
        calls.push(args);
        return { job_id: 'job-1' };
      },
    }),
  });

  await program.parseAsync([
    'node',
    'evals-appliance',
    'campaign',
    'run',
    'prefix-suite',
    '--json',
  ]);

  expect(calls).toEqual([{ campaignSelector: 'prefix-suite', json: true }]);
  expect(JSON.parse(stdout.join(''))).toEqual({ ok: true, job_id: 'job-1' });
});

test('default dry-run prune creates and chmods no state dirs', () => {
  // Real subprocess against the DEFAULT actions: a dry-run report must not
  // materialize or re-chmod state/{jobs,locks,provenance}.
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'appliance-cli-dryrun-')),
  );
  for (const sub of [
    'evals/results',
    'superpowers',
    'gauntlet',
    'credentials/blessed',
  ]) {
    mkdirSync(join(root, sub), { recursive: true });
  }
  writeFileSync(
    join(root, 'credentials/blessed/metadata.json'),
    JSON.stringify({
      bundle_id: 'blessed-x',
      rotated_at: '2026-06-18T00:00:00Z',
      providers: [],
    }),
  );
  const configPath = join(root, 'appliance.json');
  writeFileSync(
    configPath,
    JSON.stringify({
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
    }),
  );
  // Pre-existing state/jobs with a non-0o700 mode: dry-run must leave it be.
  mkdirSync(join(root, 'state/jobs'), { recursive: true });
  chmodSync(join(root, 'state'), 0o755);
  chmodSync(join(root, 'state/jobs'), 0o755);

  const proc = spawnSync('bun', ['src/appliance/cli.ts', 'prune', '--json'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...envSnapshot(), EVALS_APPLIANCE_CONFIG: configPath },
  });
  expect(proc.status).toBe(0);
  const payload = JSON.parse(proc.stdout) as { ok: boolean; dry_run: boolean };
  expect(payload.ok).toBe(true);
  expect(payload.dry_run).toBe(true);
  expect(existsSync(join(root, 'state/locks'))).toBe(false);
  expect(existsSync(join(root, 'state/provenance'))).toBe(false);
  expect(statSync(join(root, 'state')).mode & 0o777).toBe(0o755);
  expect(statSync(join(root, 'state/jobs')).mode & 0o777).toBe(0o755);
});

test('prune apply renders ok:false and exit 1 when any candidate move failed', async () => {
  const cases: {
    result: {
      dry_run: boolean;
      quarantined: { name: string; to: string }[];
      failures: { name: string; message: string }[];
    };
    ok: boolean;
    exits: number[];
  }[] = [
    {
      result: {
        dry_run: false,
        quarantined: [{ name: 'a', to: '/q/a' }],
        failures: [],
      },
      ok: true,
      exits: [],
    },
    {
      result: {
        dry_run: false,
        quarantined: [{ name: 'a', to: '/q/a' }],
        failures: [{ name: 'b', message: 'EXDEV' }],
      },
      ok: false,
      exits: [1],
    },
    {
      result: {
        dry_run: false,
        quarantined: [],
        failures: [{ name: 'b', message: 'EXDEV' }],
      },
      ok: false,
      exits: [1],
    },
  ];
  for (const { result, ok, exits } of cases) {
    const stdout: string[] = [];
    const seenExits: number[] = [];
    const program = createApplianceProgram({
      stdout: (s) => stdout.push(s),
      stderr: () => undefined,
      setExitCode: (code) => seenExits.push(code),
      actions: noopActions({ prune: async () => result }),
    });
    await program.parseAsync([
      'node',
      'evals-appliance',
      'prune',
      '--json',
      '--apply',
    ]);
    const payload = JSON.parse(stdout.join('')) as {
      ok: boolean;
      quarantined: unknown[];
      failures: unknown[];
    };
    expect(payload.ok).toBe(ok);
    // The full partial result survives either way.
    expect(payload.quarantined).toEqual(result.quarantined);
    expect(payload.failures).toEqual(result.failures);
    expect(seenExits).toEqual(exits);
  }
});

test('run forwards scenario and coding agent with appliance options', async () => {
  const checkout = trustedCheckout(['writing-plans']);
  const calls: unknown[] = [];
  const program = createApplianceProgram({
    stdout: () => undefined,
    stderr: () => undefined,
    loadConfig: () => loadedForCli(checkout.evalsPath),
    actions: noopActions({
      run: async (args, request) => {
        calls.push({ args, request });
        return { ok: true };
      },
    }),
  });

  await program.parseAsync([
    'node',
    'evals-appliance',
    'run',
    '--json',
    '--detach',
    '--superpowers-ref',
    'feature/x',
    '--scenario',
    'writing-plans',
    '--coding-agent',
    'codex',
  ]);

  expect(calls).toEqual([
    {
      args: {
        json: true,
        detach: true,
        superpowersRef: 'feature/x',
        scenario: 'scenarios/writing-plans',
        agent: 'codex',
        // Omitted --credential normalizes to null and resolves the agent
        // default inside the request.
        credential: null,
      },
      request: {
        selection: { agent: 'codex', credential: null },
        scope: CODEX_SUB_SCOPE,
        sourceEvalsSha: checkout.headSha,
      },
    },
  ]);
});

test('run forwards one explicit credential and resolves it into the request', async () => {
  const checkout = trustedCheckout(['writing-plans']);
  const calls: unknown[] = [];
  const program = createApplianceProgram({
    stdout: () => undefined,
    stderr: () => undefined,
    loadConfig: () => loadedForCli(checkout.evalsPath),
    actions: noopActions({
      run: async (args, request) => {
        calls.push({ args, request });
        return { ok: true };
      },
    }),
  });

  await program.parseAsync([
    'node',
    'evals-appliance',
    'run',
    '--json',
    '--superpowers-ref',
    'main',
    '--scenario',
    'writing-plans',
    '--coding-agent',
    'codex',
    '--credential',
    'openai_responses',
  ]);

  expect(calls).toEqual([
    {
      args: {
        json: true,
        detach: false,
        superpowersRef: 'main',
        scenario: 'scenarios/writing-plans',
        agent: 'codex',
        credential: 'openai_responses',
      },
      request: {
        selection: { agent: 'codex', credential: 'openai_responses' },
        scope: OPENAI_RESPONSES_SCOPE,
        sourceEvalsSha: checkout.headSha,
      },
    },
  ]);
});

test('run accepts trusted bare and prefixed scenario paths', async () => {
  const checkout = trustedCheckout(['alpha', 'nested/bravo']);
  const evalsPath = checkout.evalsPath;
  const calls: unknown[] = [];
  const program = createApplianceProgram({
    stdout: () => undefined,
    stderr: () => undefined,
    loadConfig: () => loadedForCli(evalsPath),
    actions: noopActions({
      run: async (args) => {
        calls.push(args);
        return { ok: true };
      },
    }),
  });

  await program.parseAsync([
    'node',
    'evals-appliance',
    'run',
    '--json',
    '--superpowers-ref',
    'main',
    '--scenario',
    'alpha',
    '--coding-agent',
    'codex',
  ]);
  await program.parseAsync([
    'node',
    'evals-appliance',
    'run',
    '--json',
    '--superpowers-ref',
    'main',
    '--scenario',
    'scenarios/nested/bravo',
    '--coding-agent',
    'codex',
  ]);

  expect(calls).toEqual([
    {
      json: true,
      detach: false,
      superpowersRef: 'main',
      scenario: 'scenarios/alpha',
      agent: 'codex',
      credential: null,
    },
    {
      json: true,
      detach: false,
      superpowersRef: 'main',
      scenario: 'scenarios/nested/bravo',
      agent: 'codex',
      credential: null,
    },
  ]);
});

test('run rejects absolute and traversing scenario paths before job submission', async () => {
  const evalsPath = mkdtempSync(join(tmpdir(), 'appliance-cli-evals-'));
  writeScenario(evalsPath, 'alpha');
  writeAgentYaml(evalsPath, 'codex', [
    'name: codex',
    'binary: codex',
    'home_config_subdir: ".codex"',
    'session_log_dir: "${QUORUM_AGENT_HOME}/.codex/sessions"',
    'session_log_glob: "**/*.jsonl"',
    'normalizer: codex',
    'required_env: []',
  ]);
  const stdout: string[] = [];
  const calls: unknown[] = [];
  const program = createApplianceProgram({
    stdout: (s) => stdout.push(s),
    stderr: () => undefined,
    setExitCode: () => undefined,
    loadConfig: () => loadedForCli(evalsPath),
    actions: noopActions({
      run: async (args) => {
        calls.push(args);
        return { ok: true };
      },
    }),
  });

  await program.parseAsync([
    'node',
    'evals-appliance',
    'run',
    '--json',
    '--superpowers-ref',
    'main',
    '--scenario',
    '/tmp/alpha',
    '--coding-agent',
    'codex',
  ]);
  await program.parseAsync([
    'node',
    'evals-appliance',
    'run',
    '--json',
    '--superpowers-ref',
    'main',
    '--scenario',
    '../escape',
    '--coding-agent',
    'codex',
  ]);
  await program.parseAsync([
    'node',
    'evals-appliance',
    'run',
    '--json',
    '--superpowers-ref',
    'main',
    '--scenario',
    'scenarios/alpha/../alpha',
    '--coding-agent',
    'codex',
  ]);
  await program.parseAsync([
    'node',
    'evals-appliance',
    'run',
    '--json',
    '--superpowers-ref',
    'main',
    '--scenario',
    'scenarios/',
    '--coding-agent',
    'codex',
  ]);

  expect(calls).toEqual([]);
  const errors = stdout.map((entry) => JSON.parse(entry).error.code);
  expect(errors).toEqual([
    'config_invalid',
    'config_invalid',
    'config_invalid',
    'config_invalid',
  ]);
});

test('json failures use appliance error shape', async () => {
  const stdout: string[] = [];
  let exitCode = 0;
  const program = createApplianceProgram({
    stdout: (s) => stdout.push(s),
    stderr: () => undefined,
    setExitCode: (code) => {
      exitCode = code;
    },
    actions: {
      doctor: async () => {
        throw new ApplianceError('lock_busy', 'doctor', 'run.lock is busy');
      },
      prepare: async () => ({ ok: true }),
      run: async () => ({ ok: true }),
      runAll: async () => ({ ok: true }),
      status: async () => ({ ok: true }),
      cancel: async () => ({ ok: true }),
      show: async () => ({ ok: true }),
      costs: async () => ({ ok: true }),
    },
  });

  await program.parseAsync(['node', 'evals-appliance', 'doctor', '--json']);

  expect(exitCode).toBe(1);
  expect(JSON.parse(stdout.join(''))).toEqual({
    ok: false,
    error: {
      code: 'lock_busy',
      step: 'doctor',
      message: 'run.lock is busy',
    },
  });
});

test('run rejects antigravity on the Phase 1 appliance', async () => {
  const evalsPath = mkdtempSync(join(tmpdir(), 'appliance-cli-evals-'));
  writeScenario(evalsPath, 'writing-plans');
  const stdout: string[] = [];
  let exitCode = 0;
  const program = createApplianceProgram({
    stdout: (s) => stdout.push(s),
    stderr: () => undefined,
    setExitCode: (code) => {
      exitCode = code;
    },
    loadConfig: () => loadedForCli(evalsPath),
    actions: {
      doctor: async () => ({ ok: true }),
      prepare: async () => ({ ok: true }),
      run: async () => ({ ok: true }),
      runAll: async () => ({ ok: true }),
      status: async () => ({ ok: true }),
      cancel: async () => ({ ok: true }),
      show: async () => ({ ok: true }),
      costs: async () => ({ ok: true }),
    },
  });

  await program.parseAsync([
    'node',
    'evals-appliance',
    'run',
    '--json',
    '--superpowers-ref',
    'main',
    '--scenario',
    'writing-plans',
    '--coding-agent',
    'antigravity',
  ]);

  expect(exitCode).toBe(1);
  expect(JSON.parse(stdout.join('')).error.code).toBe('unsupported_os');
});

test('run validates the trusted coding-agent config for single-scenario runs', async () => {
  const evalsPath = realpathSync(
    mkdtempSync(join(tmpdir(), 'appliance-cli-evals-')),
  );
  writeScenario(evalsPath, 'writing-plans');
  // required_env is deliberately unsatisfiable: loadAgentConfigForValidation
  // checks config shape, not the host environment.
  writeAgentYaml(evalsPath, 'codex', [
    'name: codex',
    'binary: codex',
    'home_config_subdir: ".codex"',
    'session_log_dir: "${QUORUM_AGENT_HOME}/.codex/sessions"',
    'session_log_glob: "**/*.jsonl"',
    'normalizer: codex',
    'required_env:',
    '  - QUORUM_DEFINITELY_UNSET_VALIDATION',
    'default_credential: codex_sub',
  ]);
  writeAgentYaml(evalsPath, 'stealth', [
    'name: stealth',
    'runtime_family: antigravity',
    'binary: agy',
    'home_config_subdir: "."',
    'session_log_dir: "${QUORUM_AGENT_HOME}/.gemini/antigravity-cli/brain"',
    'session_log_glob: "**/transcript.jsonl"',
    'normalizer: antigravity',
    'required_env: []',
  ]);
  writeCredentialsYaml(evalsPath);
  commitCheckout(evalsPath);
  const stdout: string[] = [];
  const calls: unknown[] = [];
  const program = createApplianceProgram({
    stdout: (s) => stdout.push(s),
    stderr: () => undefined,
    setExitCode: () => undefined,
    loadConfig: () => loadedForCli(evalsPath),
    actions: noopActions({
      run: async (args) => {
        calls.push(args);
        return { ok: true };
      },
    }),
  });

  await program.parseAsync([
    'node',
    'evals-appliance',
    'run',
    '--json',
    '--superpowers-ref',
    'main',
    '--scenario',
    'writing-plans',
    '--coding-agent',
    'stealth',
  ]);
  await program.parseAsync([
    'node',
    'evals-appliance',
    'run',
    '--json',
    '--superpowers-ref',
    'main',
    '--scenario',
    'writing-plans',
    '--coding-agent',
    'codex',
  ]);

  expect(JSON.parse(stdout[0] ?? '').error.code).toBe('unsupported_os');
  expect(calls).toEqual([
    {
      json: true,
      detach: false,
      superpowersRef: 'main',
      scenario: 'scenarios/writing-plans',
      agent: 'codex',
      credential: null,
    },
  ]);
});

test('run-all requires explicit supported coding agents', async () => {
  const stdout: string[] = [];
  let exitCode = 0;
  const program = createApplianceProgram({
    stdout: (s) => stdout.push(s),
    stderr: () => undefined,
    setExitCode: (code) => {
      exitCode = code;
    },
    actions: {
      doctor: async () => ({ ok: true }),
      prepare: async () => ({ ok: true }),
      run: async () => ({ ok: true }),
      runAll: async () => ({ ok: true }),
      status: async () => ({ ok: true }),
      cancel: async () => ({ ok: true }),
      show: async () => ({ ok: true }),
      costs: async () => ({ ok: true }),
    },
  });

  await program.parseAsync([
    'node',
    'evals-appliance',
    'run-all',
    '--json',
    '--superpowers-ref',
    'main',
    '--',
    '--tier',
    'sentinel',
  ]);

  expect(exitCode).toBe(1);
  expect(JSON.parse(stdout.join('')).error.code).toBe('unsupported_os');
});

test('run-all rejects empty coding agent lists', async () => {
  const stdout: string[] = [];
  const program = createApplianceProgram({
    stdout: (s) => stdout.push(s),
    stderr: () => undefined,
    setExitCode: () => undefined,
    actions: {
      doctor: async () => ({ ok: true }),
      prepare: async () => ({ ok: true }),
      run: async () => ({ ok: true }),
      runAll: async () => ({ ok: true }),
      status: async () => ({ ok: true }),
      cancel: async () => ({ ok: true }),
      show: async () => ({ ok: true }),
      costs: async () => ({ ok: true }),
    },
  });

  await program.parseAsync([
    'node',
    'evals-appliance',
    'run-all',
    '--json',
    '--superpowers-ref',
    'main',
    '--',
    '--coding-agents=',
  ]);
  await program.parseAsync([
    'node',
    'evals-appliance',
    'run-all',
    '--json',
    '--superpowers-ref',
    'main',
    '--',
    '--coding-agents',
    '--tier',
    'sentinel',
  ]);

  const errors = stdout.map((entry) => JSON.parse(entry).error.code);
  expect(errors).toEqual(['unsupported_os', 'unsupported_os']);
});

test('run-all rejects antigravity and unsupported target-OS options', async () => {
  const stdout: string[] = [];
  const program = createApplianceProgram({
    stdout: (s) => stdout.push(s),
    stderr: () => undefined,
    setExitCode: () => undefined,
    actions: {
      doctor: async () => ({ ok: true }),
      prepare: async () => ({ ok: true }),
      run: async () => ({ ok: true }),
      runAll: async () => ({ ok: true }),
      status: async () => ({ ok: true }),
      cancel: async () => ({ ok: true }),
      show: async () => ({ ok: true }),
      costs: async () => ({ ok: true }),
    },
  });

  await program.parseAsync([
    'node',
    'evals-appliance',
    'run-all',
    '--json',
    '--superpowers-ref',
    'main',
    '--',
    '--coding-agents',
    'codex,antigravity',
  ]);
  await program.parseAsync([
    'node',
    'evals-appliance',
    'run-all',
    '--json',
    '--superpowers-ref',
    'main',
    '--',
    '--coding-agents',
    'codex',
    '--os',
    'windows',
  ]);

  const errors = stdout.map((entry) => JSON.parse(entry).error.code);
  expect(errors).toEqual(['unsupported_os', 'unsupported_os']);
});

test('run-all rejects duplicate coding-agent and unsupported target-OS flags', async () => {
  const stdout: string[] = [];
  const calls: unknown[] = [];
  const program = createApplianceProgram({
    stdout: (s) => stdout.push(s),
    stderr: () => undefined,
    setExitCode: () => undefined,
    actions: noopActions({
      runAll: async (args) => {
        calls.push(args);
        return { ok: true };
      },
    }),
  });

  await program.parseAsync([
    'node',
    'evals-appliance',
    'run-all',
    '--json',
    '--superpowers-ref',
    'main',
    '--',
    '--coding-agents',
    'codex',
    '--coding-agents=codex',
  ]);
  await program.parseAsync([
    'node',
    'evals-appliance',
    'run-all',
    '--json',
    '--superpowers-ref',
    'main',
    '--',
    '--coding-agents',
    'codex',
    '--os=linux',
    '--os',
    'linux',
  ]);

  expect(calls).toEqual([]);
  const errors = stdout.map((entry) => JSON.parse(entry).error.code);
  expect(errors).toEqual(['unsupported_os', 'unsupported_os']);
});

test('run-all rejects forwarded root and result override flags', async () => {
  const stdout: string[] = [];
  const calls: unknown[] = [];
  const program = createApplianceProgram({
    stdout: (s) => stdout.push(s),
    stderr: () => undefined,
    setExitCode: () => undefined,
    actions: noopActions({
      runAll: async (args) => {
        calls.push(args);
        return { ok: true };
      },
    }),
  });

  await program.parseAsync([
    'node',
    'evals-appliance',
    'run-all',
    '--json',
    '--superpowers-ref',
    'main',
    '--',
    '--coding-agents',
    'codex',
    '--scenarios-root=/tmp/scenarios',
  ]);
  await program.parseAsync([
    'node',
    'evals-appliance',
    'run-all',
    '--json',
    '--superpowers-ref',
    'main',
    '--',
    '--coding-agents',
    'codex',
    '--coding-agents-dir',
    '/tmp/agents',
  ]);
  await program.parseAsync([
    'node',
    'evals-appliance',
    'run-all',
    '--json',
    '--superpowers-ref',
    'main',
    '--',
    '--coding-agents',
    'codex',
    '--out-root=/tmp/results',
  ]);

  expect(calls).toEqual([]);
  const errors = stdout.map((entry) => JSON.parse(entry).error.code);
  expect(errors).toEqual([
    'unsupported_os',
    'unsupported_os',
    'unsupported_os',
  ]);
});

test('run-all validates requested agents against trusted checkout configs', async () => {
  const evalsPath = realpathSync(
    mkdtempSync(join(tmpdir(), 'appliance-cli-evals-')),
  );
  writeAgentYaml(evalsPath, 'codex', CODEX_AGENT_LINES);
  writeAgentYaml(evalsPath, 'broken', ['name: broken']);
  writeAgentYaml(evalsPath, 'stealth', [
    'name: stealth',
    'runtime_family: antigravity',
    'binary: agy',
    'home_config_subdir: "."',
    'session_log_dir: "${QUORUM_AGENT_HOME}/.gemini/antigravity-cli/brain"',
    'session_log_glob: "**/transcript.jsonl"',
    'normalizer: antigravity',
    'required_env: []',
  ]);
  writeCredentialsYaml(evalsPath);
  commitCheckout(evalsPath);
  const stdout: string[] = [];
  const calls: unknown[] = [];
  const program = createApplianceProgram({
    stdout: (s) => stdout.push(s),
    stderr: () => undefined,
    setExitCode: () => undefined,
    loadConfig: () => loadedForCli(evalsPath),
    actions: noopActions({
      runAll: async (args) => {
        calls.push(args);
        return { ok: true };
      },
    }),
  });

  await program.parseAsync([
    'node',
    'evals-appliance',
    'run-all',
    '--json',
    '--superpowers-ref',
    'main',
    '--',
    '--coding-agents',
    'missing',
  ]);
  await program.parseAsync([
    'node',
    'evals-appliance',
    'run-all',
    '--json',
    '--superpowers-ref',
    'main',
    '--',
    '--coding-agents',
    'broken',
  ]);
  await program.parseAsync([
    'node',
    'evals-appliance',
    'run-all',
    '--json',
    '--superpowers-ref',
    'main',
    '--',
    '--coding-agents',
    'stealth',
  ]);
  await program.parseAsync([
    'node',
    'evals-appliance',
    'run-all',
    '--json',
    '--superpowers-ref',
    'main',
    '--',
    '--coding-agents',
    'codex',
  ]);

  expect(calls).toHaveLength(1);
  const errors = stdout
    .slice(0, 3)
    .map((entry) => JSON.parse(entry).error.code);
  expect(errors).toEqual([
    'unsupported_os',
    'unsupported_os',
    'unsupported_os',
  ]);
});

test('install wrapper embeds the requested root and strict checkout checks', () => {
  const root = mkdtempSync(join(tmpdir(), 'appliance-install-'));
  const proc = spawnSync('bash', ['scripts/install-evals-appliance', root], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  expect(proc.status).toBe(0);

  const wrapper = readFileSync(join(root, 'bin/evals-appliance'), 'utf8');
  const syntax = spawnSync('bash', ['-n', join(root, 'bin/evals-appliance')], {
    encoding: 'utf8',
  });
  expect(syntax.status).toBe(0);
  expect(wrapper).toContain(`${root}/config/appliance.json`);
  expect(wrapper).not.toContain('EVALS_APPLIANCE_CONFIG:-');
  expect(wrapper).toContain('sanitized_path=/usr/local/bin:/usr/bin:/bin');
  expect(wrapper).toContain('sanitized_home=');
  expect(wrapper).toContain(
    'exec /usr/bin/env -i PATH="$sanitized_path" HOME="$sanitized_home" EVALS_APPLIANCE_CONFIG="$default_config" /bin/bash -s -- "$@"',
  );
  expect(wrapper).toStartWith('#!/bin/bash -p');
  expect(wrapper).toContain(
    'builtin exec /usr/bin/env -i PATH="$sanitized_path" HOME="$sanitized_home" EVALS_APPLIANCE_CONFIG="$default_config" /bin/bash -s -- "$@"',
  );
  expect(wrapper).toContain("<<'EVALS_APPLIANCE_SANITIZED_SCRIPT'");
  expect(wrapper).toContain('config="$EVALS_APPLIANCE_CONFIG"');
  expect(wrapper).not.toContain('EVALS_APPLIANCE_SANITIZED=1');
  expect(wrapper).not.toContain('bash "$0"');
  expect(wrapper).not.toContain('--sanitized');
  expect(wrapper).not.toContain('shift');
  expect(wrapper).not.toContain('fetch --prune');
  expect(wrapper).not.toContain(
    'refs/remotes/${expected_remote}/${expected_ref}',
  );
  expect(wrapper).not.toContain('remote_sha=');
  expect(wrapper).toContain('status --porcelain');
  expect(wrapper).toContain('rev-parse --abbrev-ref HEAD');
  expect(wrapper).toContain('exec bun run src/appliance/cli.ts "$@"');
  expect(wrapper).not.toContain('PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}"');
  expect(wrapper).not.toContain('HOME="${HOME:-');

  const hostileEnv = join(root, 'hostile-bash-env');
  const marker = join(root, 'hostile-marker');
  writeFileSync(
    hostileEnv,
    [
      `printf sourced > ${shellQuote(marker)}`,
      "exec() { printf 'intercepted exec\\n' >&2; exit 42; }",
      '',
    ].join('\n'),
  );
  const hostile = spawnSync(join(root, 'bin/evals-appliance'), ['status'], {
    encoding: 'utf8',
    env: { ...Bun.env, BASH_ENV: hostileEnv },
  });
  expect(hostile.status).not.toBe(42);
  expect(hostile.stderr).not.toContain('intercepted exec');
  expect(existsSync(marker)).toBe(false);
});

// --- the real production actions after the cutover (F13 Task 5) -------------
// The production prepare/run/run-all writers are driven end to end through
// createApplianceActions, whose finite dependencies are the two config
// loaders, the command runner, the detached worker spawner, and runWorker.
// Tests supply fakes at exactly that seam: no guard, no module mock.

interface RealConfigFixture {
  readonly root: string;
  readonly configPath: string;
  readonly evalsPath: string;
  readonly bundleDir: string;
  readonly headSha: string;
}

// A structurally valid on-disk appliance config whose credential bundle is
// BROKEN (no metadata.json): production actions that consult the bundle fail
// on it, so any refusal these tests observe happened before bundle access.
function writeRealConfig(): RealConfigFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'appliance-cli-real-')));
  for (const sub of [
    'evals/results',
    'superpowers',
    'gauntlet',
    'credentials/blessed',
  ]) {
    mkdirSync(join(root, sub), { recursive: true });
  }
  const configPath = join(root, 'appliance.json');
  writeFileSync(
    configPath,
    JSON.stringify({
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
    }),
  );
  // A real checkout: the program action resolves the credential request from
  // this corpus and pins this HEAD BEFORE the cutover guard runs, so the
  // fixture has to be able to answer both.
  const evalsPath = join(root, 'evals');
  writeCredentialsYaml(evalsPath);
  const headSha = commitCheckout(evalsPath);
  return {
    root,
    configPath,
    evalsPath,
    bundleDir: join(root, 'credentials/blessed'),
    headSha,
  };
}

interface CliJson {
  readonly ok: boolean;
  readonly error?: {
    readonly code: string;
    readonly step: string;
    readonly message: string;
  };
}

function runCli(fx: RealConfigFixture, args: readonly string[]) {
  const proc = spawnSync('bun', ['src/appliance/cli.ts', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...envSnapshot(), EVALS_APPLIANCE_CONFIG: fx.configPath },
  });
  return proc;
}

// Valid bundle metadata, so the credential-aware loader succeeds.
function seedBundleMetadata(fx: RealConfigFixture): void {
  writeFileSync(
    join(fx.bundleDir, 'metadata.json'),
    JSON.stringify({
      bundle_id: 'blessed-a',
      rotated_at: '2026-06-18T00:00:00Z',
      providers: ['openai'],
    }),
  );
}

// Records every subprocess the production actions make, and snapshots the job
// namespace the first time one of them is a container action.
class ActionRunner implements CommandRunner {
  calls: { command: string; args: readonly string[] }[] = [];
  jobsAtFirstContainerCall: string[] | null = null;
  jobsDir: string;

  constructor(jobsDir: string) {
    this.jobsDir = jobsDir;
  }

  containerCalls(): { command: string; args: readonly string[] }[] {
    return this.calls.filter(
      (call) =>
        call.command === 'docker' ||
        call.command.endsWith('scripts/evals-container'),
    );
  }

  run(command: string, args: readonly string[]): CommandResult {
    const isContainerCall =
      command === 'docker' || command.endsWith('scripts/evals-container');
    if (isContainerCall && this.jobsAtFirstContainerCall === null) {
      this.jobsAtFirstContainerCall = existsSync(this.jobsDir)
        ? readdirSync(this.jobsDir)
        : [];
    }
    this.calls.push({ command, args });
    if (command === 'git' && args.includes('status')) {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (
      command === 'git' &&
      args.includes('rev-parse') &&
      args.some((arg) => arg.startsWith('refs/tags/'))
    ) {
      // Only the branch ref resolves, so the superpowers ref is unambiguous.
      return { status: 1, stdout: '', stderr: 'missing tag\n' };
    }
    if (command === 'git' && args.includes('rev-parse')) {
      return { status: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
    }
    if (command === 'docker' && args[0] === 'exec' && args[1] === '--help') {
      return {
        status: 0,
        stdout: 'Usage: docker exec\n  --env-file list\n',
        stderr: '',
      };
    }
    if (command.endsWith('scripts/evals-container')) {
      // Stop the real preflight at the image build: these tests are about
      // what production WROTE before the first container action, not about a
      // full simulated container lifecycle.
      return { status: 1, stdout: '', stderr: 'fixture: no docker\n' };
    }
    return { status: 0, stdout: '', stderr: '' };
  }
}

interface ActionHarness {
  readonly fx: RealConfigFixture;
  readonly runner: ActionRunner;
  readonly actions: ApplianceActions;
  readonly workerCalls: string[];
  readonly detachCalls: string[];
  readonly jobsDir: string;
}

function actionHarness(fx: RealConfigFixture): ActionHarness {
  const jobsDir = join(fx.root, 'state/jobs');
  const runner = new ActionRunner(jobsDir);
  const workerCalls: string[] = [];
  const detachCalls: string[] = [];
  const actions = createApplianceActions({
    loadStateConfig: (options) => loadStateConfig(fx.configPath, options),
    loadCredentialConfig: (options) =>
      loadCredentialConfig(fx.configPath, options),
    commandRunner: runner,
    spawnDetachedWorker: (_loaded, jobId) => {
      detachCalls.push(jobId);
      return { host_pid: 4242, host_pgid: 4242 };
    },
    runWorker: async (_loaded, jobId) => {
      workerCalls.push(jobId);
    },
  });
  return { fx, runner, actions, workerCalls, detachCalls, jobsDir };
}

function liveRequestFor(
  fx: RealConfigFixture,
  selection: { agent: string; credential: string | null },
) {
  return buildLiveCredentialRequest(fx.evalsPath, selection, fx.headSha);
}

function persistedJob(harness: ActionHarness, jobId: string) {
  return JSON.parse(
    readFileSync(join(harness.jobsDir, jobId, 'job.json'), 'utf8'),
  ) as Record<string, unknown>;
}

test('production run persists the credential triple before the worker or Docker', async () => {
  const fx = writeRealConfig();
  seedBundleMetadata(fx);
  writeScenario(fx.evalsPath, 'writing-plans');
  writeAgentYaml(fx.evalsPath, 'codex', CODEX_AGENT_LINES);
  const harness = actionHarness(fx);

  await harness.actions.run(
    {
      json: true,
      superpowersRef: 'main',
      detach: false,
      scenario: 'writing-plans',
      agent: 'codex',
      credential: null,
    },
    liveRequestFor(fx, { agent: 'codex', credential: null }),
  );

  expect(harness.workerCalls).toHaveLength(1);
  const jobId = harness.workerCalls[0] ?? '';
  const record = persistedJob(harness, jobId);
  expect(record['kind']).toBe('run');
  expect(record['credential_selection']).toEqual({
    agent: 'codex',
    credential: null,
  });
  expect(record['credential_scope']).toEqual(CODEX_SUB_SCOPE);
  expect(record['credential_scope_source_evals_sha']).toBe(fx.headSha);
  expect(record['command']).toEqual({
    argv: [
      'quorum',
      'run',
      'scenarios/writing-plans',
      '--coding-agent',
      'codex',
    ],
    sanitized: true,
  });
  // The writer ran before anything touched a container.
  expect(harness.runner.containerCalls()).toEqual([]);
  expect(harness.detachCalls).toEqual([]);
});

test('production run-all persists the explicit credential and detaches its worker', async () => {
  const fx = writeRealConfig();
  seedBundleMetadata(fx);
  writeAgentYaml(fx.evalsPath, 'codex', CODEX_AGENT_LINES);
  const harness = actionHarness(fx);

  await harness.actions.runAll(
    {
      json: true,
      superpowersRef: 'main',
      detach: true,
      quorumArgs: [
        '--coding-agents',
        'codex',
        '--credentials',
        'openai_responses',
      ],
    },
    liveRequestFor(fx, { agent: 'codex', credential: 'openai_responses' }),
  );

  expect(harness.detachCalls).toHaveLength(1);
  expect(harness.workerCalls).toEqual([]);
  const record = persistedJob(harness, harness.detachCalls[0] ?? '');
  expect(record['kind']).toBe('run-all');
  expect(record['credential_selection']).toEqual({
    agent: 'codex',
    credential: 'openai_responses',
  });
  expect(record['credential_scope']).toEqual(OPENAI_RESPONSES_SCOPE);
  expect(record['credential_scope_source_evals_sha']).toBe(fx.headSha);
  expect(harness.runner.containerCalls()).toEqual([]);
});

test('production prepare writes its asserted-empty job before the first container action', async () => {
  const fx = writeRealConfig();
  seedBundleMetadata(fx);
  const harness = actionHarness(fx);

  await expect(
    harness.actions.prepare({ json: true, superpowersRef: 'main' }),
  ).rejects.toBeInstanceOf(ApplianceError);

  const snapshot = harness.runner.jobsAtFirstContainerCall ?? [];
  expect(snapshot).toHaveLength(1);
  const record = persistedJob(harness, snapshot[0] ?? '');
  expect(record['kind']).toBe('prepare');
  expect(record['credential_selection']).toBe(null);
  expect(record['credential_scope']).toEqual({
    schemaVersion: 1,
    kind: 'empty',
    agent: null,
    runtimeFamily: null,
    credential: null,
    agentEnv: [],
    geminiAuthType: null,
    oauth: null,
  });
  expect(record['credential_scope_source_evals_sha']).toBe(null);
});

test('bundle metadata faults fail prepare and run before job creation or Docker', async () => {
  const cases: readonly {
    readonly what: string;
    readonly break: (fx: RealConfigFixture) => void;
  }[] = [
    { what: 'missing metadata', break: () => {} },
    {
      what: 'unreadable metadata',
      break: (fx) => {
        seedBundleMetadata(fx);
        chmodSync(join(fx.bundleDir, 'metadata.json'), 0o000);
      },
    },
    {
      what: 'final-symlink metadata',
      break: (fx) => {
        const real = join(fx.root, 'elsewhere-metadata.json');
        writeFileSync(
          real,
          JSON.stringify({
            bundle_id: 'blessed-a',
            rotated_at: '2026-06-18T00:00:00Z',
            providers: [],
          }),
        );
        symlinkSync(real, join(fx.bundleDir, 'metadata.json'));
      },
    },
    {
      what: 'intermediate-symlink bundle path',
      break: (fx) => {
        seedBundleMetadata(fx);
        const link = join(fx.root, 'credentials-link');
        symlinkSync(join(fx.root, 'credentials'), link);
        const config = JSON.parse(readFileSync(fx.configPath, 'utf8'));
        config.credential_bundle.path = join(link, 'blessed');
        writeFileSync(fx.configPath, JSON.stringify(config));
      },
    },
  ];

  for (const entry of cases) {
    const fx = writeRealConfig();
    writeScenario(fx.evalsPath, 'writing-plans');
    writeAgentYaml(fx.evalsPath, 'codex', CODEX_AGENT_LINES);
    entry.break(fx);
    const harness = actionHarness(fx);

    await expect(
      harness.actions.prepare({ json: true, superpowersRef: 'main' }),
    ).rejects.toMatchObject({ code: 'config_invalid' });
    await expect(
      harness.actions.run(
        {
          json: true,
          superpowersRef: 'main',
          detach: false,
          scenario: 'writing-plans',
          agent: 'codex',
          credential: null,
        },
        liveRequestFor(fx, { agent: 'codex', credential: null }),
      ),
    ).rejects.toMatchObject({ code: 'config_invalid' });

    // No job record, no container action, no worker.
    expect(
      existsSync(harness.jobsDir) ? readdirSync(harness.jobsDir) : [],
    ).toEqual([]);
    expect(harness.runner.containerCalls()).toEqual([]);
    expect(harness.workerCalls).toEqual([]);

    // Status and identity-verified cancellation stay on the structural loader.
    await expect(
      harness.actions.status({ json: true, id: 'job-none' }),
    ).rejects.toMatchObject({ code: 'job_not_found' });
    await expect(
      harness.actions.cancel({ json: true, id: 'job-none' }),
    ).rejects.toMatchObject({ code: 'job_not_found' });
  }
});

test('argument faults fail before job creation for run and run-all', () => {
  const fx = writeRealConfig();
  seedBundleMetadata(fx);
  writeAgentYaml(fx.evalsPath, 'codex', CODEX_AGENT_LINES);

  const badScenario = runCli(fx, [
    'run',
    '--superpowers-ref',
    'main',
    '--scenario',
    'no-such-scenario',
    '--coding-agent',
    'codex',
    '--json',
  ]);
  expect(badScenario.status).toBe(1);
  expect((JSON.parse(badScenario.stdout) as CliJson).error?.message).toContain(
    'trusted scenario not found',
  );

  const badArgs = runCli(fx, [
    'run-all',
    '--superpowers-ref',
    'main',
    '--json',
  ]);
  expect(badArgs.status).toBe(1);
  expect((JSON.parse(badArgs.stdout) as CliJson).error?.message).toContain(
    'requires explicit --coding-agents',
  );

  expect(existsSync(join(fx.root, 'state/jobs'))).toBe(false);
});

test('structural status and cancel stay available while the bundle is broken', () => {
  const fx = writeRealConfig();
  // The bundle has no metadata.json at all; a credential-aware load would
  // fail. Structural read/recovery operations answer anyway.
  const status = runCli(fx, ['status', 'job-none', '--json']);
  expect(status.status).toBe(1);
  const statusPayload = JSON.parse(status.stdout) as CliJson;
  expect(statusPayload.error?.code).toBe('job_not_found');

  const cancel = runCli(fx, ['cancel', 'job-none', '--json']);
  expect(cancel.status).toBe(1);
  const cancelPayload = JSON.parse(cancel.stdout) as CliJson;
  expect(cancelPayload.error?.code).toBe('job_not_found');
});

test('doctor requires the credential-aware loader and fails typed on a broken bundle', () => {
  const fx = writeRealConfig();
  const proc = runCli(fx, ['doctor', '--json']);
  expect(proc.status).toBe(1);
  const payload = JSON.parse(proc.stdout) as CliJson;
  expect(payload.error?.code).toBe('config_invalid');
  expect(payload.error?.step).toBe('config');
  expect(payload.error?.message).toContain('metadata');
});

// --- one normalized (agent, credential) selection per job (F13) -------------
// The appliance isolation unit is exactly one agent plus one credential. A
// selection that could widen into a second cell — a second agent, a second
// credential, a foreign registry, an ambiguous value — is rejected before any
// job exists, so no job record can assert a scope broader than it will use.

// Commander retains option state across parses on one program instance, so
// every selection case below builds its own program.
test('run rejects every ambiguous --credential shape before the action runs', async () => {
  const checkout = trustedCheckout(['alpha']);
  const cases: readonly (readonly string[])[] = [
    ['--credential='], // blank
    ['--credential', '   '], // whitespace only
    ['--credential=,'], // comma only
    ['--credential', 'a,b'], // two credentials
    ['--credential', '--json'], // option-looking value
    ['--credential', 'openai_responses', '--credential', 'codex_sub'], // duplicate
  ];

  for (const extra of cases) {
    const calls: unknown[] = [];
    const stdout: string[] = [];
    const program = createApplianceProgram({
      stdout: (s) => stdout.push(s),
      stderr: () => undefined,
      setExitCode: () => undefined,
      loadConfig: () => loadedForCli(checkout.evalsPath),
      actions: noopActions({
        run: async (args) => {
          calls.push(args);
          return { ok: true };
        },
      }),
    });
    await program.parseAsync([
      'node',
      'evals-appliance',
      'run',
      '--json',
      '--superpowers-ref',
      'main',
      '--scenario',
      'alpha',
      '--coding-agent',
      'codex',
      ...extra,
    ]);

    const payload = JSON.parse(stdout.join('')) as CliJson;
    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe('unsupported_os');
    expect(payload.error?.step).toBe('arguments');
    expect(calls).toEqual([]);
  }
});

test('run-all rejects every ambiguous selection shape before the action runs', async () => {
  const checkout = trustedCheckout();
  const cases: readonly (readonly string[])[] = [
    ['--coding-agents', 'codex,kimi'], // two agents
    ['--coding-agents', 'codex', '--credentials', 'a,b'], // two credentials
    ['--coding-agents', 'codex', '--credentials='], // blank
    ['--coding-agents', 'codex', '--credentials=,'], // comma only
    ['--coding-agents', 'codex', '--credentials'], // bare, no value
    ['--coding-agents', 'codex', '--credentials', '--tier', 'sentinel'], // option-looking
    ['--coding-agents', 'codex', '--credentials', 'a', '--credentials', 'b'], // duplicate
    ['--coding-agents', 'codex', '--credential', 'codex_sub'], // singular flag
    ['--coding-agents', 'codex', '--credentials-file', '/tmp/creds.yaml'], // foreign registry
    ['--', '--coding-agents', 'codex', '--credentials', 'codex_sub'], // downstream end-of-options hides the asserted selection
    ['--tier', '--coding-agents', 'codex', '--credentials', 'codex_sub'], // downstream consumes the selection flag as another option's value
  ];

  for (const quorumArgs of cases) {
    const calls: unknown[] = [];
    const stdout: string[] = [];
    const program = createApplianceProgram({
      stdout: (s) => stdout.push(s),
      stderr: () => undefined,
      setExitCode: () => undefined,
      loadConfig: () => loadedForCli(checkout.evalsPath),
      actions: noopActions({
        runAll: async (args) => {
          calls.push(args);
          return { ok: true };
        },
      }),
    });
    await program.parseAsync([
      'node',
      'evals-appliance',
      'run-all',
      '--json',
      '--superpowers-ref',
      'main',
      '--',
      ...quorumArgs,
    ]);

    const payload = JSON.parse(stdout.join('')) as CliJson;
    expect(payload.ok).toBe(false);
    expect(payload.error?.code).toBe('unsupported_os');
    expect(payload.error?.step).toBe('arguments');
    expect(calls).toEqual([]);
  }
});

test('the cross-command and custom-registry selection flags are unknown to run', () => {
  // Real subprocesses: commander rejects an unknown option before any action,
  // config load, or job creation.
  for (const flag of ['--credentials', '--credentials-file']) {
    const proc = spawnSync(
      'bun',
      [
        'src/appliance/cli.ts',
        'run',
        '--superpowers-ref',
        'main',
        '--scenario',
        'alpha',
        '--coding-agent',
        'codex',
        flag,
        'whatever',
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(proc.status).not.toBe(0);
    expect(`${proc.stderr}${proc.stdout}`).toContain(
      `unknown option '${flag}'`,
    );
  }
});

test('a bare --credential with no value is rejected by the real CLI', () => {
  const proc = spawnSync(
    'bun',
    [
      'src/appliance/cli.ts',
      'run',
      '--superpowers-ref',
      'main',
      '--scenario',
      'alpha',
      '--coding-agent',
      'codex',
      '--credential',
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  expect(proc.status).not.toBe(0);
  expect(`${proc.stderr}${proc.stdout}`).toContain('--credential');
});

test('the credential request is built before the credential-aware loader runs', () => {
  // Ordering proof: an unresolvable credential fails with the credential-scope
  // error, which can only happen if the program action builds the request
  // before anything consults the bundle. Both refusals precede any state
  // directory.
  const fx = writeRealConfig();
  writeScenario(fx.evalsPath, 'writing-plans');
  writeAgentYaml(fx.evalsPath, 'codex', CODEX_AGENT_LINES);

  const unknownCredential = runCli(fx, [
    'run',
    '--superpowers-ref',
    'main',
    '--scenario',
    'writing-plans',
    '--coding-agent',
    'codex',
    '--credential',
    'no_such_credential',
    '--json',
  ]);
  expect(unknownCredential.status).toBe(1);
  const scopePayload = JSON.parse(unknownCredential.stdout) as CliJson;
  expect(scopePayload.error?.step).toBe('credential-scope');
  expect(scopePayload.error?.message).toContain('no_such_credential');
  expect(existsSync(join(fx.root, 'state'))).toBe(false);

  // A resolvable credential gets past request construction and then lands on
  // this fixture's broken bundle — still before job creation, state mutation,
  // or any bundle PAYLOAD access.
  const resolvable = runCli(fx, [
    'run',
    '--superpowers-ref',
    'main',
    '--scenario',
    'writing-plans',
    '--coding-agent',
    'codex',
    '--credential',
    'openai_responses',
    '--json',
  ]);
  expect(resolvable.status).toBe(1);
  const bundlePayload = JSON.parse(resolvable.stdout) as CliJson;
  expect(bundlePayload.error?.step).toBe('config');
  expect(bundlePayload.error?.code).toBe('config_invalid');
  // The credential-aware loader ensures the appliance-owned state namespace
  // before it validates the bundle, so an empty state/ may exist. What must
  // NOT exist is a job: nothing was recorded as submitted.
  const jobsDir = join(fx.root, 'state/jobs');
  expect(existsSync(jobsDir) ? readdirSync(jobsDir) : []).toEqual([]);

  // CLI output names no credential material location.
  expect(resolvable.stdout).not.toContain('credentials-scoped');
  expect(resolvable.stdout).not.toContain(fx.bundleDir);
});
