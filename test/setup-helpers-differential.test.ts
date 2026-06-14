// test/setup-helpers-differential.test.ts
//
// Transitional Python<->TS differential parity oracle for the duplication
// window (PRI-2220). For each hermetic dispatchable helper it builds the
// fixture twice -- once through the Python console script (uv run setup-helpers
// run <name>) and once through the TS runHelpers -- into separate temp dirs,
// then asserts the non-.git file trees are byte-identical and the git-log
// subject sequences match. SHAs are never compared (Python never pins commit
// dates). Skipped when uv / the Python package is unavailable. This file is
// throwaway: it is deleted in the purge PR once the Python side is removed.

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { repoRoot } from '../src/paths.ts';
import { runHelpers } from '../src/setup-helpers/cli.ts';

// The hermetic dispatchable helpers: each self-inits a fresh git repo (or, for
// create_base_repo, takes the deterministic init+3-commit branch because
// fixtures/template-repo has no .git) and touches no subprocess seam. The 5
// Tier-2 helpers (3 provisionVenv-bearing behavior fixtures, link_gemini_
// extension, install_codex_superpowers_plugin_hooks), the needsSuperpowersRoot
// symlink helper, and the layered/sibling helpers that require a pre-existing
// repo are all excluded -- none is byte-comparable from a standalone temp dir.
const HERMETIC: readonly string[] = [
  'create_cost_checkbox_page',
  'create_cost_clean_repo',
  'create_cost_large_files',
  'create_cost_trivial_plan',
  'create_writing_plans_skeleton',
  'create_code_review_planted_bugs',
  'create_spec_writing_blind_spot',
  'create_spec_targets_wrong_component',
  'create_spec_targets_wrong_component_with_checkpoint',
  'scaffold_sdd_go_fractals',
  'scaffold_sdd_go_fractals_crisp',
  'scaffold_sdd_go_fractals_critical_plan',
  'scaffold_sdd_go_fractals_stripped',
  'scaffold_sdd_go_fractals_coarse',
  'scaffold_sdd_go_fractals_elicited',
  'scaffold_sdd_go_fractals_control_plan',
  'scaffold_sdd_svelte_todo',
  'scaffold_sdd_svelte_todo_elicited',
  'scaffold_sdd_broken_plan',
  'scaffold_sdd_quality_defect_plan',
  'scaffold_sdd_spec_constraint_plan',
  'scaffold_sdd_yagni_plan',
  'create_base_repo',
];

// Recursive non-.git file map: relative path -> UTF-8 bytes. Walks the workdir
// excluding the .git directory entirely (SHAs and pack contents are not
// deterministic across two independent builds).
function fileTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const ent of readdirSync(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!ent.isFile()) {
      continue;
    }
    const abs = join(ent.parentPath, ent.name);
    const rel = relative(root, abs);
    if (rel === '.git' || rel.startsWith(`.git${'/'}`)) {
      continue;
    }
    out.set(rel, readFileSync(abs, 'utf8'));
  }
  return out;
}

// git log subjects, oldest-first. Compared instead of SHAs.
function subjects(dir: string): string {
  const proc = spawnSync('git', ['log', '--format=%s', '--reverse'], {
    cwd: dir,
    encoding: 'utf8',
  });
  return (proc.stdout ?? '').trim();
}

// Harden against uv's own error codes: uv-missing yields status null, while a
// uv-internal error also returns a nonzero status. Require the REAL Python
// console script to have run by matching its 'unknown helper' message on a
// bogus name -- only then is the differential meaningful. QUORUM_WORKDIR must
// be set or _run short-circuits on the missing-workdir check before it reaches
// the helper lookup that emits 'unknown helper'.
function pythonAvailable(): boolean {
  const probe = spawnSync(
    'uv',
    ['run', 'setup-helpers', 'run', '__nonexistent__'],
    {
      cwd: repoRoot(),
      encoding: 'utf8',
      env: { ...process.env, QUORUM_WORKDIR: tmpdir() },
    },
  );
  if (probe.status === null) {
    return false;
  }
  return probe.status !== 0 && (probe.stderr ?? '').includes('unknown helper');
}

// SUPERPOWERS_ROOT is irrelevant to every hermetic helper; pass it through when
// present (so the Python env is faithful) but never require it.
function superpowersRootOrUndefined(): string | undefined {
  const proc = spawnSync('printenv', ['SUPERPOWERS_ROOT'], {
    encoding: 'utf8',
  });
  const value = (proc.stdout ?? '').trim();
  return value === '' ? undefined : value;
}

const HAVE_PYTHON = pythonAvailable();

describe('differential parity (transitional)', () => {
  for (const name of HERMETIC) {
    test.skipIf(!HAVE_PYTHON)(`${name}: TS tree == Python tree`, async () => {
      const tsDir = mkdtempSync(join(tmpdir(), 'sh-diff-ts-'));
      const pyDir = mkdtempSync(join(tmpdir(), 'sh-diff-py-'));
      const spRoot = superpowersRootOrUndefined();
      try {
        await runHelpers([name], {
          workdir: tsDir,
          repoRoot: repoRoot(),
          superpowersRoot: spRoot,
        });

        const env: Record<string, string> = {
          QUORUM_WORKDIR: pyDir,
          QUORUM_REPO_ROOT: repoRoot(),
        };
        if (spRoot !== undefined) {
          env['SUPERPOWERS_ROOT'] = spRoot;
        }
        const py = spawnSync('uv', ['run', 'setup-helpers', 'run', name], {
          cwd: repoRoot(),
          encoding: 'utf8',
          env: { ...process.env, ...env },
        });
        expect(py.status, py.stderr ?? '').toBe(0);

        const tsTree = fileTree(tsDir);
        const pyTree = fileTree(pyDir);
        // Sorted relative-path lists must match (same set of files).
        expect([...tsTree.keys()].sort()).toEqual([...pyTree.keys()].sort());
        // Each file's bytes must match.
        for (const [rel, bytes] of tsTree) {
          expect(pyTree.get(rel), `byte mismatch in ${rel}`).toBe(bytes);
        }
        // Commit-message sequence must match (never the SHAs).
        expect(subjects(tsDir)).toBe(subjects(pyDir));
      } finally {
        rmSync(tsDir, { recursive: true, force: true });
        rmSync(pyDir, { recursive: true, force: true });
      }
    });
  }
});
