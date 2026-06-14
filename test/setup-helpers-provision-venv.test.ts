// test/setup-helpers-provision-venv.test.ts
import { describe, expect, test } from 'bun:test';
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from '../src/agents/command-runner.ts';
import { provisionVenv } from '../src/setup-helpers/base.ts';

class FakeRunner implements CommandRunner {
  calls: Array<{ command: string; args: readonly string[] }> = [];
  run(
    command: string,
    args: readonly string[],
    _o?: CommandOptions,
  ): CommandResult {
    this.calls.push({ command, args });
    return { status: 0, stdout: '', stderr: '' };
  }
}

describe('provisionVenv', () => {
  test('uses uv when uvAvailable is true', () => {
    const run = new FakeRunner();
    provisionVenv('/work', run, { uvAvailable: true });
    expect(run.calls[0]?.command).toBe('uv');
    expect(run.calls[0]?.args.slice(0, 2)).toEqual(['venv', '--python']);
    expect(run.calls[1]?.args).toContain('pytest');
    expect(run.calls[1]?.args).toContain('-e');
  });

  test('falls back to python -m venv when uv is absent', () => {
    const run = new FakeRunner();
    provisionVenv('/work', run, { uvAvailable: false, python: 'python3' });
    expect(run.calls[0]?.command).toBe('python3');
    expect(run.calls[0]?.args.slice(0, 2)).toEqual(['-m', 'venv']);
  });

  test('throws when a provisioning command fails', () => {
    class Failing implements CommandRunner {
      run(): CommandResult {
        return { status: 1, stdout: '', stderr: 'boom' };
      }
    }
    expect(() =>
      provisionVenv('/work', new Failing(), { uvAvailable: true }),
    ).toThrow();
  });
});
