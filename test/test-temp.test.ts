import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { envSnapshot } from '../src/env.ts';

const LAUNCHER = resolve(import.meta.dir, 'run.ts');

function fixture(name: string, body: string, setup = ''): string {
  const path = join(tmpdir(), `${name}.test.ts`);
  writeFileSync(
    path,
    `import { expect, test } from 'bun:test';
     import { spawnSync } from 'node:child_process';
     import { writeFileSync } from 'node:fs';
     import { tmpdir } from 'node:os';
     import { join } from 'node:path';
     test('scratch evidence', async () => {
       ${setup}
       const root = tmpdir();
       const inherited = spawnSync(process.execPath,
         ['-e', 'console.log(JSON.stringify(require("node:os").tmpdir()))'],
         { encoding: 'utf8' });
       const git = spawnSync('git', ['rev-parse', '--show-toplevel'],
         { cwd: root, encoding: 'utf8' });
       writeFileSync(join(root, 'evidence.txt'), 'child evidence');
       writeFileSync(process.env.RECEIPT, JSON.stringify({ root,
         env: [process.env.TMPDIR, process.env.TMP, process.env.TEMP],
         inherited: JSON.parse(inherited.stdout), gitStatus: git.status }));
       ${body}
     }, 60_000);`,
  );
  return path;
}

test.each([
  0, 1,
])('test exit %i preserves isolation and cleans only successful scratch', (exitCode) => {
  const receipt = join(tmpdir(), `child-${exitCode}.json`);
  const sibling = join(tmpdir(), `parent-${exitCode}.txt`);
  writeFileSync(sibling, 'parent evidence');
  const path = fixture(`temp-exit-${exitCode}`, `expect(${exitCode}).toBe(0);`);
  const child = spawnSync(process.execPath, [LAUNCHER, path], {
    env: { ...envSnapshot(), RECEIPT: receipt },
    encoding: 'utf8',
  });
  expect(child.status, child.stderr).toBe(exitCode);
  const { root, env, inherited, gitStatus } = JSON.parse(
    readFileSync(receipt, 'utf8'),
  ) as { root: string; env: string[]; inherited: string; gitStatus: number };
  try {
    expect(root).not.toBe(tmpdir());
    expect(relative(tmpdir(), root).startsWith(`..${sep}`)).toBe(true);
    expect(env).toEqual([root, root, root]);
    expect(inherited).toBe(root);
    expect(gitStatus).not.toBe(0);
    expect(readFileSync(sibling, 'utf8')).toBe('parent evidence');
    expect(existsSync(root)).toBe(exitCode !== 0);
    if (exitCode !== 0) {
      expect(readFileSync(join(root, 'evidence.txt'), 'utf8')).toBe(
        'child evidence',
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [signal, cleanExit, exitStatus] of [
  ['SIGTERM', false, 143],
  ['SIGTERM', true, 143],
  ['SIGINT', true, 130],
] as const) {
  test(`test cancellation ${signal} with clean child exit ${cleanExit} retains evidence`, async () => {
    const name = `temp-cancel-${signal}-${cleanExit}`;
    const receipt = join(tmpdir(), `${name}.json`);
    const path = fixture(
      name,
      'await new Promise(() => {});',
      cleanExit ? `process.once('${signal}', () => process.exit(0));` : '',
    );
    const child = Bun.spawn([process.execPath, LAUNCHER, path], {
      env: { ...envSnapshot(), RECEIPT: receipt },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const deadline = Date.now() + 3000;
    try {
      while (!existsSync(receipt) && Date.now() < deadline) await Bun.sleep(10);
      expect(existsSync(receipt)).toBe(true);
      child.kill(signal);
      expect(await child.exited).toBe(exitStatus);
      const { root } = JSON.parse(readFileSync(receipt, 'utf8')) as {
        root: string;
      };
      try {
        expect(readFileSync(join(root, 'evidence.txt'), 'utf8')).toBe(
          'child evidence',
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM');
      await child.exited;
      await output;
    }
  });
}
