import { expect, test } from 'bun:test';
import {
  defaultCommandRunner,
  SpawnCommandRunner,
} from '../src/agents/command-runner.ts';
import { FakeCommandRunner } from './fake-command-runner.ts';

test('SpawnCommandRunner captures stdout and a zero status', () => {
  const result = new SpawnCommandRunner().run('printf', ['hello']);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('hello');
});

test('SpawnCommandRunner pipes stdin via input', () => {
  const result = new SpawnCommandRunner().run('cat', [], { input: 'piped' });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('piped');
});

test('SpawnCommandRunner reports a non-zero status', () => {
  const result = new SpawnCommandRunner().run('sh', ['-c', 'exit 3']);
  expect(result.status).toBe(3);
});

test('defaultCommandRunner is the real spawn runner', () => {
  expect(defaultCommandRunner).toBeInstanceOf(SpawnCommandRunner);
});

test('FakeCommandRunner records calls and returns the default OK', () => {
  const fake = new FakeCommandRunner();
  const result = fake.run('codex', ['login', '--with-api-key'], {
    input: 'sk-x',
  });
  expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
  expect(fake.calls).toEqual([
    {
      command: 'codex',
      args: ['login', '--with-api-key'],
      options: { input: 'sk-x' },
    },
  ]);
});

test('FakeCommandRunner uses a responder for canned results', () => {
  const fake = new FakeCommandRunner((command, args) =>
    command === 'gemini' && args[0] === 'extensions'
      ? { status: 0, stdout: 'superpowers', stderr: '' }
      : { status: 1, stdout: '', stderr: 'no' },
  );
  expect(fake.run('gemini', ['extensions', 'list']).stdout).toBe('superpowers');
  expect(fake.run('other', []).status).toBe(1);
});
