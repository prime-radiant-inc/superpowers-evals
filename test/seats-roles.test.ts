import { expect, test } from 'bun:test';
import { classifyClaudeRole, classifyCodexRole } from '../src/seats/roles.ts';

// Role classification. Every label asserted here was enumerated from the
// recorded corpus: 617 distinct Claude meta.json descriptions and 141 distinct
// Codex agent_path values across the 212 sdd-* runs under results/.

test('Claude: "Implement Task N: …" and implementer-suffixed labels are implementers', () => {
  expect(classifyClaudeRole('Implement Task 1: Project Setup')).toBe(
    'implementer',
  );
  expect(classifyClaudeRole('Implement Task 3: Sierpinski algorithm')).toBe(
    'implementer',
  );
  expect(classifyClaudeRole('Task 2 implementer: Mandelbrot algorithm')).toBe(
    'implementer',
  );
  expect(classifyClaudeRole('Task 1: Go project setup implementer')).toBe(
    'implementer',
  );
  expect(classifyClaudeRole('Implement depth-aware Sierpinski')).toBe(
    'implementer',
  );
});

test('Claude: a fix/polish wave is implementer work even when it names a review', () => {
  // These seats apply findings; they do not adjudicate them.
  expect(classifyClaudeRole('Fix Task 2 review issues')).toBe('implementer');
  expect(classifyClaudeRole('Fix final review findings')).toBe('implementer');
  expect(classifyClaudeRole('Final-review fix wave')).toBe('implementer');
  expect(classifyClaudeRole('Final review fixes: all Important findings')).toBe(
    'implementer',
  );
  expect(classifyClaudeRole('Apply final-review fixes')).toBe('implementer');
  expect(classifyClaudeRole('Task 2 fix round 3')).toBe('implementer');
  expect(classifyClaudeRole('Task 4 minor fixes')).toBe('implementer');
  expect(classifyClaudeRole('Polish Task 6 tests')).toBe('implementer');
  expect(classifyClaudeRole('Cleanup minor review findings')).toBe(
    'implementer',
  );
  expect(classifyClaudeRole('Final cleanup: go mod tidy + comment')).toBe(
    'implementer',
  );
  expect(classifyClaudeRole('Harden storage saveTodos + tests')).toBe(
    'implementer',
  );
  expect(classifyClaudeRole('Build slugify helper (TDD)')).toBe('implementer');
});

test('Claude: per-task review labels are task reviewers', () => {
  expect(classifyClaudeRole('Review Task 1 (spec + quality)')).toBe(
    'task_reviewer',
  );
  expect(classifyClaudeRole('Code quality review Task 2')).toBe(
    'task_reviewer',
  );
  expect(classifyClaudeRole('Spec review Task 3')).toBe('task_reviewer');
  expect(classifyClaudeRole('Review spec compliance Task 4')).toBe(
    'task_reviewer',
  );
  expect(
    classifyClaudeRole('Task 5 reviewer: spec compliance + code quality'),
  ).toBe('task_reviewer');
  expect(classifyClaudeRole('Task 6 review: spec + quality')).toBe(
    'task_reviewer',
  );
  expect(classifyClaudeRole('Spec review CLI layer (Tasks 5-6)')).toBe(
    'task_reviewer',
  );
  expect(classifyClaudeRole('Quality review Task 7 README')).toBe(
    'task_reviewer',
  );
});

test('Claude: whole-branch review labels are final reviewers', () => {
  expect(classifyClaudeRole('Final whole-branch review')).toBe(
    'final_reviewer',
  );
  expect(classifyClaudeRole('Final whole-branch code review')).toBe(
    'final_reviewer',
  );
  expect(
    classifyClaudeRole('Final code review across entire implementation'),
  ).toBe('final_reviewer');
  expect(classifyClaudeRole('Final review of slugify branch')).toBe(
    'final_reviewer',
  );
  expect(classifyClaudeRole('Final full-implementation review')).toBe(
    'final_reviewer',
  );
});

test('Claude: re-reviews and scoped fix reviews are fix reviewers', () => {
  expect(classifyClaudeRole('Re-review Task 2 fix')).toBe('fix_reviewer');
  expect(
    classifyClaudeRole('Re-review Task 3 after fix (spec + quality)'),
  ).toBe('fix_reviewer');
  expect(classifyClaudeRole('Code quality re-review Task 4 after fixes')).toBe(
    'fix_reviewer',
  );
  expect(classifyClaudeRole('Scoped fix review')).toBe('fix_reviewer');
  expect(classifyClaudeRole('Task 3 scoped fix review')).toBe('fix_reviewer');
  expect(classifyClaudeRole('Task 3 fix round 2 review')).toBe('fix_reviewer');
  expect(classifyClaudeRole('Scoped re-review of fix wave')).toBe(
    'fix_reviewer',
  );
  expect(classifyClaudeRole('Final whole-branch re-review post-fix')).toBe(
    'fix_reviewer',
  );
  expect(classifyClaudeRole('Final review re-check after fixes')).toBe(
    'fix_reviewer',
  );
});

test('Claude: a label that names no role is other, never coerced', () => {
  // Real labels. "Review code changes" and "Code quality review CLI layer" name
  // a review with no task and no branch scope; "Task 9: end-to-end
  // verification" names neither building nor reviewing. Guessing would corrupt
  // the per-role rates this scorer exists to measure.
  expect(classifyClaudeRole('Review code changes')).toBe('other');
  expect(classifyClaudeRole('Review spec document')).toBe('other');
  expect(classifyClaudeRole('Code quality review CLI layer')).toBe('other');
  expect(classifyClaudeRole('Task 9: end-to-end verification')).toBe('other');
  expect(classifyClaudeRole('')).toBe('other');
});

test('Codex: agent_path role suffixes classify from the last path segment', () => {
  expect(classifyCodexRole('/root/task1_implementer')).toBe('implementer');
  expect(classifyCodexRole('/root/task1_impl')).toBe('implementer');
  expect(classifyCodexRole('/root/task3_implement')).toBe('implementer');
  expect(classifyCodexRole('/root/task_2_implementer')).toBe('implementer');
  expect(classifyCodexRole('/root/task1_reviewer')).toBe('task_reviewer');
  expect(classifyCodexRole('/root/task3_review')).toBe('task_reviewer');
  expect(classifyCodexRole('/root/review_task2')).toBe('task_reviewer');
  expect(classifyCodexRole('/root/task9_spec_review')).toBe('task_reviewer');
  expect(classifyCodexRole('/root/task5_quality_review')).toBe('task_reviewer');
  expect(classifyCodexRole('/root/final_review')).toBe('final_reviewer');
  expect(classifyCodexRole('/root/final_reviewer')).toBe('final_reviewer');
  expect(classifyCodexRole('/root/final_branch_reviewer')).toBe(
    'final_reviewer',
  );
  expect(classifyCodexRole('/root/final_code_review')).toBe('final_reviewer');
  expect(classifyCodexRole('/root/final_integration_review')).toBe(
    'final_reviewer',
  );
});

test('Codex: rereview and fix-then-review paths are fix reviewers', () => {
  expect(classifyCodexRole('/root/final_rereview')).toBe('fix_reviewer');
  expect(classifyCodexRole('/root/final_rereviewer')).toBe('fix_reviewer');
  expect(classifyCodexRole('/root/task1_rereviewer')).toBe('fix_reviewer');
  expect(classifyCodexRole('/root/task2_rereview2')).toBe('fix_reviewer');
  expect(classifyCodexRole('/root/final_branch_rereview')).toBe('fix_reviewer');
  expect(classifyCodexRole('/root/task8_spec_rereview')).toBe('fix_reviewer');
  expect(classifyCodexRole('/root/final_fix_reviewer')).toBe('fix_reviewer');
  expect(classifyCodexRole('/root/final_fix_review')).toBe('fix_reviewer');
  expect(classifyCodexRole('/root/task2_fix4_review')).toBe('fix_reviewer');
  expect(classifyCodexRole('/root/task2_fix_review_round2')).toBe(
    'fix_reviewer',
  );
  expect(classifyCodexRole('/root/cleanup_rereview')).toBe('fix_reviewer');
});

test('Codex: fix seats are implementers, and fix-AFTER-review is a fix seat', () => {
  // final_fix_reviewer reviews a fix; final_review_fixer applies one. The only
  // signal is which word comes first, so order decides.
  expect(classifyCodexRole('/root/final_fix')).toBe('implementer');
  expect(classifyCodexRole('/root/final_fixer')).toBe('implementer');
  expect(classifyCodexRole('/root/final_fix_wave')).toBe('implementer');
  expect(classifyCodexRole('/root/final_fix_implementer')).toBe('implementer');
  expect(classifyCodexRole('/root/task2_fix4')).toBe('implementer');
  expect(classifyCodexRole('/root/task2_fix_round2')).toBe('implementer');
  expect(classifyCodexRole('/root/final_review_fixer')).toBe('implementer');
  expect(classifyCodexRole('/root/final_review_fix')).toBe('implementer');
  expect(classifyCodexRole('/root/final_cleanup')).toBe('implementer');
});

test('Codex: a nested agent_path classifies by its own last segment', () => {
  // Real depth-2 paths: a reviewer spawned by an implementer.
  expect(classifyCodexRole('/root/task_9_implementer/task_9_reviewer')).toBe(
    'task_reviewer',
  );
  expect(classifyCodexRole('/root/task7_implementer/task7_review')).toBe(
    'task_reviewer',
  );
});

test('Codex: a feature-named seat and a missing agent_path are other', () => {
  // task4_titlecase / task1_slugify name what the seat worked on, not its role.
  // Codex CLI 0.144.3 recorded thread_spawn with agent_path: null entirely.
  expect(classifyCodexRole('/root/task4_titlecase')).toBe('other');
  expect(classifyCodexRole('/root/task1_slugify')).toBe('other');
  expect(classifyCodexRole('/root/task3_chunk')).toBe('other');
  expect(classifyCodexRole(null)).toBe('other');
  expect(classifyCodexRole('')).toBe('other');
});
