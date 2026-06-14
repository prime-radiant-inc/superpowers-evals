// test/setup-helpers-cost.test.ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCostCheckboxPage,
  createCostCleanRepo,
  createCostLargeFiles,
  createCostTrivialPlan,
} from '../src/setup-helpers/cost-fixtures.ts';
import { runGit } from '../src/setup-helpers/git.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'sh-cost-'));
}

describe('cost fixtures', () => {
  test('checkbox page has an empty <main> and one commit', () => {
    const dir = tmp();
    try {
      createCostCheckboxPage({ workdir: dir } as never);
      expect(runGit(['show', 'HEAD:index.html'], dir)).toContain(
        '<main></main>',
      );
      expect(runGit(['log', '--format=%s'], dir).trim()).toBe(
        'initial: empty tasks page',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('clean repo is a single README commit', () => {
    const dir = tmp();
    try {
      createCostCleanRepo({ workdir: dir } as never);
      expect(runGit(['log', '--format=%s'], dir).trim()).toBe(
        'initial: README',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('large files: 5 modules, 80 entities, exact byte shape', () => {
    const dir = tmp();
    try {
      createCostLargeFiles({ workdir: dir } as never);
      const users = runGit(['show', 'HEAD:src/users.js'], dir);
      // LASTING byte-shape oracle (survives the purge): entity #1's full
      // get+save block must match _render_module byte-for-byte, including the
      // // comment lines, `record` naming, the multi-line throw with LITERAL
      // ${id}, and the save-block `return users.get(id);`. A substring check
      // would pass against a drifted generator — assert the whole block.
      const block1 =
        'export function getUser1(id) {\n' +
        '  // Lookup helper #1 for User records.\n' +
        '  const record = users.get(id);\n' +
        '  if (!record) {\n' +
        '    throw new Error(`User 1 not found: ${id}`);\n' +
        '  }\n' +
        '  return record;\n' +
        '}\n' +
        '\n' +
        'export function saveUser1(id, data) {\n' +
        '  // Persist helper #1 for User records.\n' +
        '  users.set(id, { ...data, version: 1 });\n' +
        '  return users.get(id);\n' +
        '}\n';
      expect(users).toContain(block1);
      // Header + last entity present.
      expect(users.startsWith('// users.js\n')).toBe(true);
      expect(users).toContain('export function getUser80(id) {');
      expect(users).toContain('export function saveUser80(id, data) {');
      expect(runGit(['log', '--format=%s'], dir).trim()).toBe(
        'initial: synthetic CRUD modules',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('trivial plan: app stub + dated plan file', () => {
    const dir = tmp();
    try {
      createCostTrivialPlan({ workdir: dir } as never);
      expect(runGit(['show', 'HEAD:src/app.js'], dir)).toContain(
        'function main()',
      );
      expect(
        runGit(
          ['show', 'HEAD:docs/superpowers/plans/2026-05-06-trivial.md'],
          dir,
        ),
      ).toContain('Task 1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Python parity (L-helper-missing-workdir-mkdir): every create-from-scratch
  // helper calls workdir.mkdir(parents=True, exist_ok=True) as its first action,
  // so it is self-sufficient when $QUORUM_WORKDIR does not yet exist.
  test('each cost helper creates the workdir when it does not exist', () => {
    const base = tmp();
    try {
      const cases: Array<[string, (ctx: never) => void]> = [
        ['checkbox', createCostCheckboxPage],
        ['clean', createCostCleanRepo],
        ['large', createCostLargeFiles],
        ['trivial', createCostTrivialPlan],
      ];
      for (const [name, helper] of cases) {
        const missing = join(base, name, 'nested', 'workdir');
        helper({ workdir: missing } as never);
        expect(runGit(['rev-parse', 'HEAD'], missing).trim().length).toBe(40);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
