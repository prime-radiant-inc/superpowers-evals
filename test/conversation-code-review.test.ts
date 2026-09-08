import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSetup } from '../src/setup-step.ts';

test('review preservation check accepts the fixture and rejects changed or missing source without executing it', () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'review-preservation-')),
  );
  const node = Bun.which('node');
  if (node === null) throw new Error('node is required for review check tests');
  const oracle = join(
    import.meta.dir,
    '../scenarios/conversation-code-review/oracle.cjs',
  );
  const check = () =>
    spawnSync(node, [oracle], { cwd: root, encoding: 'utf8' });
  try {
    runSetup(
      join(import.meta.dir, '../scenarios/code-review-catches-planted-bugs'),
      root,
    );
    const source = join(root, 'src/db.js');
    const fixture = readFileSync(source);
    expect(check().status).toBe(0);

    writeFileSync(
      source,
      "import { writeFileSync } from 'node:fs'; writeFileSync('executed', 'yes'); process.exit(0);",
    );
    expect(check().status).toBe(1);
    expect(existsSync(join(root, 'executed'))).toBe(false);

    rmSync(source);
    expect(check().status).toBe(1);
    writeFileSync(source, fixture);
    expect(check().status).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
