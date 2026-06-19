import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ApplianceActions,
  createApplianceProgram,
} from '../src/appliance/cli.ts';
import { ApplianceError } from '../src/appliance/errors.ts';
import type { LoadedApplianceConfig } from '../src/appliance/types.ts';

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

test('run-all keeps appliance flags before separator and passes quorum args verbatim', async () => {
  const evalsPath = mkdtempSync(join(tmpdir(), 'appliance-cli-evals-'));
  writeAgentYaml(evalsPath, 'codex', [
    'name: codex',
    'binary: codex',
    'home_config_subdir: ".codex"',
    'session_log_dir: "${QUORUM_AGENT_HOME}/.codex/sessions"',
    'session_log_glob: "**/rollout-*.jsonl"',
    'normalizer: codex',
    'required_env: []',
  ]);
  writeAgentYaml(evalsPath, 'kimi', [
    'name: kimi',
    'binary: kimi',
    'home_config_subdir: ".kimi-code"',
    'session_log_dir: "${QUORUM_AGENT_HOME}/.kimi-code/sessions"',
    'session_log_glob: "**/wire.jsonl"',
    'normalizer: kimi',
    'required_env: []',
  ]);
  const calls: unknown[] = [];
  const stdout: string[] = [];
  const program = createApplianceProgram({
    stdout: (s) => stdout.push(s),
    stderr: () => undefined,
    loadConfig: () => loadedForCli(evalsPath),
    actions: {
      doctor: async () => ({ ok: true }),
      prepare: async () => ({ ok: true }),
      run: async () => ({ ok: true }),
      runAll: async (args) => {
        calls.push(args);
        return { ok: true, job_id: 'job-1', status: 'preflighting' };
      },
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
    '--detach',
    '--superpowers-ref',
    'feature/x',
    '--',
    '--tier',
    'sentinel',
    '--coding-agents',
    'codex,kimi',
  ]);
  expect(calls).toEqual([
    {
      json: true,
      detach: true,
      superpowersRef: 'feature/x',
      quorumArgs: ['--tier', 'sentinel', '--coding-agents', 'codex,kimi'],
    },
  ]);
  expect(stdout.join('\n')).toContain('job-1');
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

test('run forwards scenario and coding agent with appliance options', async () => {
  const evalsPath = mkdtempSync(join(tmpdir(), 'appliance-cli-evals-'));
  writeScenario(evalsPath, 'writing-plans');
  writeAgentYaml(evalsPath, 'codex', [
    'name: codex',
    'binary: codex',
    'home_config_subdir: ".codex"',
    'session_log_dir: "${QUORUM_AGENT_HOME}/.codex/sessions"',
    'session_log_glob: "**/*.jsonl"',
    'normalizer: codex',
    'required_env: []',
  ]);
  const calls: unknown[] = [];
  const program = createApplianceProgram({
    stdout: () => undefined,
    stderr: () => undefined,
    loadConfig: () => loadedForCli(evalsPath),
    actions: {
      doctor: async () => ({ ok: true }),
      prepare: async () => ({ ok: true }),
      run: async (args) => {
        calls.push(args);
        return { ok: true };
      },
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
      json: true,
      detach: true,
      superpowersRef: 'feature/x',
      scenario: 'scenarios/writing-plans',
      agent: 'codex',
    },
  ]);
});

test('run accepts trusted bare and prefixed scenario paths', async () => {
  const evalsPath = mkdtempSync(join(tmpdir(), 'appliance-cli-evals-'));
  writeScenario(evalsPath, 'alpha');
  writeScenario(evalsPath, 'nested/bravo');
  writeAgentYaml(evalsPath, 'codex', [
    'name: codex',
    'binary: codex',
    'home_config_subdir: ".codex"',
    'session_log_dir: "${QUORUM_AGENT_HOME}/.codex/sessions"',
    'session_log_glob: "**/*.jsonl"',
    'normalizer: codex',
    'required_env: []',
  ]);
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
    },
    {
      json: true,
      detach: false,
      superpowersRef: 'main',
      scenario: 'scenarios/nested/bravo',
      agent: 'codex',
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
  const evalsPath = mkdtempSync(join(tmpdir(), 'appliance-cli-evals-'));
  writeScenario(evalsPath, 'writing-plans');
  writeAgentYaml(evalsPath, 'codex', [
    'name: codex',
    'binary: codex',
    'home_config_subdir: ".codex"',
    'session_log_dir: "${QUORUM_AGENT_HOME}/.codex/sessions"',
    'session_log_glob: "**/*.jsonl"',
    'normalizer: codex',
    'required_env:',
    '  - QUORUM_DEFINITELY_UNSET_VALIDATION',
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

test('run-all rejects antigravity and windows requests', async () => {
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

test('run-all rejects duplicate coding-agent and os forwarded flags', async () => {
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
  const evalsPath = mkdtempSync(join(tmpdir(), 'appliance-cli-evals-'));
  writeAgentYaml(evalsPath, 'codex', [
    'name: codex',
    'binary: codex',
    'home_config_subdir: ".codex"',
    'session_log_dir: "${QUORUM_AGENT_HOME}/.codex/sessions"',
    'session_log_glob: "**/*.jsonl"',
    'normalizer: codex',
    'required_env: []',
  ]);
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
  expect(wrapper).toContain(`${root}/config/appliance.json`);
  expect(wrapper).not.toContain('EVALS_APPLIANCE_CONFIG:-');
  expect(wrapper).toContain('config="$default_config"');
  expect(wrapper).toContain('EVALS_APPLIANCE_CONFIG="$default_config"');
  expect(wrapper).toContain(
    'git -C "$evals_path" fetch --prune --tags "$expected_remote" "$expected_ref"',
  );
  expect(wrapper).toContain('status --porcelain');
  expect(wrapper).toContain(
    'refs/remotes/${expected_remote}/${expected_ref}^{commit}',
  );
  expect(wrapper).toContain('exec env -i');
  expect(wrapper).toContain('PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}"');
  expect(wrapper).toContain('HOME="${HOME:-');
  const fetchIndex = wrapper.indexOf(
    'git -C "$evals_path" fetch --prune --tags "$expected_remote" "$expected_ref"',
  );
  const revParseIndex = wrapper.indexOf(
    'remote_sha="$(git -C "$evals_path" rev-parse --verify "$remote_ref")"',
  );
  expect(fetchIndex).toBeGreaterThanOrEqual(0);
  expect(revParseIndex).toBeGreaterThan(fetchIndex);
});
