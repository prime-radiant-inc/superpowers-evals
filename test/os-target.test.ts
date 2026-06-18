import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { loadOsTarget, OsTargetSchema } from '../src/contracts/os-target.ts';

const dir = join(import.meta.dir, '..', 'os-targets');
describe('os-target', () => {
  test('linux is built-in no-remote', () => {
    const t = loadOsTarget(dir, 'linux');
    expect(t.name).toBe('linux');
    expect(t.remote).toBeUndefined();
  });
  test('windows loads remote block', () => {
    const t = loadOsTarget(dir, 'windows');
    expect(t.remote?.port).toBe(2222);
    expect(t.remote?.win_run_root).toBe('C:\\eval-runs');
  });
  test('schema rejects bad shape', () => {
    expect(() => OsTargetSchema.parse({ name: 1 })).toThrow();
  });
});
