import { expect, test } from 'bun:test';
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
