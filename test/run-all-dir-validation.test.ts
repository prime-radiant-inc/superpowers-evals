import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMatrix } from '../src/run-all/matrix.ts';

// H-runall-dir-existence-not-validated: Python types --scenarios-root and
// --coding-agents-dir as click.Path(exists=True, file_okay=False), giving a
// clean, actionable error when a root is missing or is a file. The TS path let
// a missing/non-dir root surface only later as a raw ENOENT thrown deep inside
// readdirSync. buildMatrix must validate both roots upfront with a clear message
// that names the offending path, not leak a raw ENOENT/ENOTDIR.

function withRoots(): { scenariosRoot: string; codingAgentsDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'dirval-'));
  const scenariosRoot = join(root, 'scenarios');
  const codingAgentsDir = join(root, 'coding-agents');
  mkdirSync(scenariosRoot, { recursive: true });
  mkdirSync(codingAgentsDir, { recursive: true });
  writeFileSync(join(codingAgentsDir, 'claude.yaml'), 'name: claude\n');
  return { scenariosRoot, codingAgentsDir };
}

test('buildMatrix rejects a missing scenarios-root with a clear message', () => {
  const { codingAgentsDir } = withRoots();
  const missing = join(mkdtempSync(join(tmpdir(), 'dirval-')), 'nope');
  expect(() =>
    buildMatrix({ scenariosRoot: missing, codingAgentsDir }),
  ).toThrow(new RegExp(`--scenarios-root.*${missing}`));
});

test('buildMatrix rejects a missing coding-agents-dir with a clear message', () => {
  const { scenariosRoot } = withRoots();
  const missing = join(mkdtempSync(join(tmpdir(), 'dirval-')), 'nope');
  expect(() =>
    buildMatrix({ scenariosRoot, codingAgentsDir: missing }),
  ).toThrow(new RegExp(`--coding-agents-dir.*${missing}`));
});

test('buildMatrix rejects a scenarios-root that is a file (not a directory)', () => {
  const { codingAgentsDir } = withRoots();
  const dir = mkdtempSync(join(tmpdir(), 'dirval-'));
  const file = join(dir, 'a-file');
  writeFileSync(file, 'i am a file\n');
  expect(() => buildMatrix({ scenariosRoot: file, codingAgentsDir })).toThrow(
    /--scenarios-root.*not a directory/,
  );
});
