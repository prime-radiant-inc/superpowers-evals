// test/setup-helpers-base.test.ts
import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from '../src/paths.ts';
import {
  createBaseRepo,
  initRepoFromFixtures,
  recordHead,
} from '../src/setup-helpers/base.ts';
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

describe('initRepoFromFixtures', () => {
  test('mirrors the fixtures tree into the workdir with one commit on main', () => {
    const scenario = tmp();
    const work = tmp();
    try {
      const fixtures = join(scenario, 'fixtures');
      mkdirSync(fixtures, { recursive: true });
      writeFileSync(join(fixtures, 'design.md'), 'DESIGN\n');
      writeFileSync(join(fixtures, 'plan.md'), 'PLAN\n');

      initRepoFromFixtures(work, fixtures);

      expect(existsSync(join(work, 'design.md'))).toBe(true);
      expect(existsSync(join(work, 'plan.md'))).toBe(true);
      expect(runGit(['log', '--format=%s'], work).trim()).toBe(
        'seed scenario fixtures',
      );
      expect(runGit(['rev-list', '--count', 'HEAD'], work).trim()).toBe('1');
      expect(runGit(['branch', '--show-current'], work).trim()).toBe('main');
    } finally {
      rmSync(scenario, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  test('copies nested subdirectories verbatim', () => {
    const scenario = tmp();
    const work = tmp();
    try {
      const fixtures = join(scenario, 'fixtures');
      mkdirSync(join(fixtures, 'docs', 'superpowers', 'plans'), {
        recursive: true,
      });
      writeFileSync(join(fixtures, 'package.json'), '{"name":"x"}\n');
      writeFileSync(
        join(fixtures, 'docs', 'superpowers', 'plans', 'p.md'),
        'PLAN\n',
      );

      initRepoFromFixtures(work, fixtures);

      expect(existsSync(join(work, 'package.json'))).toBe(true);
      expect(
        existsSync(join(work, 'docs', 'superpowers', 'plans', 'p.md')),
      ).toBe(true);
    } finally {
      rmSync(scenario, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  test('creates the workdir when it does not exist', () => {
    const scenario = tmp();
    const base = tmp();
    try {
      const fixtures = join(scenario, 'fixtures');
      mkdirSync(fixtures, { recursive: true });
      writeFileSync(join(fixtures, 'design.md'), 'D\n');
      const missing = join(base, 'nested', 'workdir');

      initRepoFromFixtures(missing, fixtures);

      expect(runGit(['rev-parse', 'HEAD'], missing).trim().length).toBe(40);
    } finally {
      rmSync(scenario, { recursive: true, force: true });
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('throws when the fixtures dir is missing', () => {
    const work = tmp();
    try {
      expect(() => initRepoFromFixtures(work, join(work, 'nope'))).toThrow(
        /fixtures dir not found/,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
