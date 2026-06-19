import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplianceProgram } from '../src/appliance/cli.ts';
import { ApplianceError } from '../src/appliance/errors.ts';

test('run-all keeps appliance flags before separator and passes quorum args verbatim', async () => {
  const calls: unknown[] = [];
  const stdout: string[] = [];
  const program = createApplianceProgram({
    stdout: (s) => stdout.push(s),
    stderr: () => undefined,
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
  const calls: unknown[] = [];
  const program = createApplianceProgram({
    stdout: () => undefined,
    stderr: () => undefined,
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
      scenario: 'writing-plans',
      agent: 'codex',
    },
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
  expect(wrapper).toContain('status --porcelain');
  expect(wrapper).toContain(
    'refs/remotes/${expected_remote}/${expected_ref}^{commit}',
  );
});
