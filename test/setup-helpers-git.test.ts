// test/setup-helpers-git.test.ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFixtureFile } from '../src/setup-helpers/fs.ts';
import { runGit } from '../src/setup-helpers/git.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'sh-git-'));
}

describe('runGit', () => {
  test('commits carry the Drill Test identity', () => {
    const dir = tmp();
    try {
      runGit(['init', '-b', 'main'], dir);
      writeFixtureFile(dir, 'a.txt', 'hello\n');
      runGit(['add', 'a.txt'], dir);
      runGit(['commit', '-m', 'first'], dir);
      const author = runGit(['log', '-1', '--format=%an <%ae>'], dir).trim();
      expect(author).toBe('Drill Test <drill@test.local>');
      expect(runGit(['log', '-1', '--format=%s'], dir).trim()).toBe('first');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('throws on nonzero git exit', () => {
    const dir = tmp();
    try {
      expect(() => runGit(['rev-parse', 'HEAD'], dir)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('writeFixtureFile creates parent dirs', async () => {
    const dir = tmp();
    try {
      writeFixtureFile(dir, 'docs/superpowers/plans/x.md', 'body\n');
      // AWAIT the assertion — a dangling `.resolves` is a floating promise that
      // settles after the test is marked passed (always-green) and trips
      // Biome's noFloatingPromises. Every `.resolves`/`.rejects` in this plan's
      // tests is awaited.
      expect(
        await Bun.file(join(dir, 'docs/superpowers/plans/x.md')).text(),
      ).toBe('body\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runGit extraEnv', () => {
  const DATES = {
    GIT_AUTHOR_DATE: '2026-07-10T12:00:00+0000',
    GIT_COMMITTER_DATE: '2026-07-10T12:00:00+0000',
  };

  test('extraEnv injects the commit author and committer dates', () => {
    const dir = tmp();
    try {
      runGit(['init', '-b', 'main'], dir);
      writeFixtureFile(dir, 'a.txt', 'same bytes\n');
      runGit(['add', '-A'], dir);
      runGit(['commit', '-m', 'initial'], dir, DATES);
      // The injected dates must reach the commit. Asserting the DATE (not
      // the commit hash) is what makes this a valid TDD red: two commits
      // made in the same wall-clock second collide on hash even WITHOUT
      // injection, so a hash-equality assertion is vacuously green. The
      // committed date is wall-clock pre-fix, the injected value post-fix.
      expect(
        runGit(['log', '-1', '--format=%cd', '--date=iso-strict'], dir).trim(),
      ).toBe('2026-07-10T12:00:00Z');
      expect(
        runGit(['log', '-1', '--format=%ad', '--date=iso-strict'], dir).trim(),
      ).toBe('2026-07-10T12:00:00Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
