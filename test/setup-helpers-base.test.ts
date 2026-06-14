// test/setup-helpers-base.test.ts
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from '../src/paths.ts';
import { createBaseRepo, recordHead } from '../src/setup-helpers/base.ts';
import { runGit } from '../src/setup-helpers/git.ts';

const TEMPLATE = join(repoRoot(), 'fixtures', 'template-repo');
function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'sh-base-'));
}

describe('createBaseRepo', () => {
  test('builds the canonical 3-commit history on main', () => {
    const dir = tmp();
    try {
      createBaseRepo(dir, TEMPLATE);
      const log = runGit(['log', '--format=%s', '--reverse'], dir)
        .trim()
        .split('\n');
      expect(log).toEqual([
        'initial commit',
        'add utils module',
        'add entry point',
      ]);
      expect(runGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir).trim()).toBe(
        'main',
      );
      expect(existsSync(join(dir, 'src/index.js'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('recordHead writes quorum-recorded-head', async () => {
    const dir = tmp();
    try {
      createBaseRepo(dir, TEMPLATE);
      recordHead(dir);
      const head = runGit(['rev-parse', 'HEAD'], dir).trim();
      const recorded = runGit(['rev-parse', '--absolute-git-dir'], dir).trim();
      expect(
        await Bun.file(join(recorded, 'quorum-recorded-head')).text(),
      ).toBe(`${head}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
