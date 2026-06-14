// test/setup-helpers-provision-venv.test.ts
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
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

  // Python parity (L-provision-venv-python-fallback): Python's no-uv branch uses
  // sys.executable — a specific, present interpreter resolved to an absolute
  // path — not a bare PATH name that may be a different interpreter or absent.
  // With no explicit override the TS fallback must resolve the same way: an
  // absolute path to an interpreter that actually exists, never the bare string.
  test('no-uv fallback resolves an absolute, present interpreter (not bare python3)', () => {
    const run = new FakeRunner();
    provisionVenv('/work', run, { uvAvailable: false });
    const resolved = run.calls[0]?.command ?? '';
    expect(resolved).not.toBe('python3');
    expect(isAbsolute(resolved)).toBe(true);
    expect(existsSync(resolved)).toBe(true);
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
