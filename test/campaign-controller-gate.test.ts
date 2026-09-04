import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
for (const mode of ['release', 'eof', 'invalid', 'timeout'] as const) {
  test(`private controller pipe ${mode}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'controller-gate-'));
    roots.push(root);
    const marker = join(root, 'admitted');
    const module = new URL('../src/appliance/process.ts', import.meta.url).href;
    const child = spawn(
      process.execPath,
      [
        '--eval',
        `
      const { waitForControllerGate } = await import(${JSON.stringify(module)});
      try { await waitForControllerGate(process.stdin, 'start', 100); }
      catch { process.exit(3); }
      await Bun.write(${JSON.stringify(marker)}, 'admitted');
    `,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const exited = new Promise<number | null>((resolve) =>
      child.on('exit', resolve),
    );
    if (mode === 'release') child.stdin.end('start\n');
    if (mode === 'invalid') child.stdin.end('wrong\n');
    if (mode === 'eof') child.stdin.end();
    const code = await exited;
    expect(existsSync(marker)).toBe(mode === 'release');
    expect(code).toBe(mode === 'release' ? 0 : 3);
  });
}
