import { expect, test } from 'bun:test';
import {
  classifyClaudeRole,
  classifyCodexRole,
  classifyCodexSeat,
} from '../src/seats/roles.ts';

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

// --- Codex: the dispatch-prompt fallback ------------------------------------
//
// Every prompt asserted below is the verbatim opening line of a real dispatched
// thread in the appliance corpus: 543 spawned threads across 60 sdd-* runs whose
// CLI (0.140.0 and 0.144.4) recorded agent_path: null. Counts in the comments
// are thread counts for that signature.

test('Codex: agent_path wins over the dispatch prompt and reports itself as the source', () => {
  // The prompt is deliberately a reviewer's; the path must still decide, and
  // the source must say so, because agent_path is the signal we trust.
  expect(
    classifyCodexSeat({
      agentPath: '/root/task1_implementer',
      agentRole: 'default',
      dispatchPrompt: "You are reviewing one task's implementation: Task 1.",
    }),
  ).toEqual({ role: 'implementer', source: 'agent_path' });
  // A path that names no role stays other on the path's evidence — the
  // fallback fires only when agent_path is absent.
  expect(
    classifyCodexSeat({
      agentPath: '/root/task4_titlecase',
      agentRole: 'worker',
      dispatchPrompt: 'You are implementing Task 4: Title Case.',
    }),
  ).toEqual({ role: 'other', source: 'agent_path' });
});

test('Codex: a task-scoped review dispatch is a task reviewer', () => {
  // 55 threads carry the template opening verbatim; 113 more name the task.
  expect(
    classifyCodexSeat({
      agentPath: null,
      agentRole: 'default',
      dispatchPrompt:
        "You are reviewing one task's implementation: first whether it matches its requirements, then whether it is well-built. This is a task-scoped gate, not a merge review — a broad whole-branch review happens separately after all tasks are complete.",
    }),
  ).toEqual({ role: 'task_reviewer', source: 'dispatch_prompt' });
  expect(
    classifyCodexSeat({
      agentPath: null,
      agentRole: 'default',
      dispatchPrompt:
        "You are reviewing one task's implementation: Task 2 Admin Report. This is a task-scoped gate, not a merge review.",
    }),
  ).toEqual({ role: 'task_reviewer', source: 'dispatch_prompt' });
  expect(
    classifyCodexSeat({
      agentPath: null,
      agentRole: 'default',
      dispatchPrompt:
        'You are reviewing Task 6: FilterBar Component. This is a task-scoped gate.',
    }),
  ).toEqual({ role: 'task_reviewer', source: 'dispatch_prompt' });
});

test('Codex: a re-review dispatch is a fix reviewer whatever its scope', () => {
  expect(
    classifyCodexSeat({
      agentPath: null,
      agentRole: 'default',
      dispatchPrompt:
        'You are re-reviewing Task 3 after fixes. This is a task-scoped gate, not a merge review.',
    }),
  ).toEqual({ role: 'fix_reviewer', source: 'dispatch_prompt' });
  expect(
    classifyCodexSeat({
      agentPath: null,
      agentRole: 'default',
      dispatchPrompt:
        'You are re-reviewing the final-review fix wave. A previous review produced findings; an implementer has attempted to fix them. Your job is to verdict each finding and inspect the fix diff — nothing else.',
    }),
  ).toEqual({ role: 'fix_reviewer', source: 'dispatch_prompt' });
  // A whole-branch re-review is still a fix reviewer, matching the
  // agent_path rule that /root/final_rereview is a fix reviewer.
  expect(
    classifyCodexSeat({
      agentPath: null,
      agentRole: 'default',
      dispatchPrompt:
        'You are a Senior Code Reviewer re-reviewing completed work after a final-review fix.',
    }),
  ).toEqual({ role: 'fix_reviewer', source: 'dispatch_prompt' });
  expect(
    classifyCodexSeat({
      agentPath: null,
      agentRole: 'default',
      dispatchPrompt:
        'You are performing the final re-review after a cleanup fix.',
    }),
  ).toEqual({ role: 'fix_reviewer', source: 'dispatch_prompt' });
});

test('Codex: a whole-branch review dispatch is a final reviewer', () => {
  // The requesting-code-review template's opening: 62 threads.
  expect(
    classifyCodexSeat({
      agentPath: null,
      agentRole: 'default',
      dispatchPrompt:
        'You are a Senior Code Reviewer with expertise in software architecture, design patterns, and best practices. Your job is to review completed work against its plan and identify issues before integration.',
    }),
  ).toEqual({ role: 'final_reviewer', source: 'dispatch_prompt' });
  expect(
    classifyCodexSeat({
      agentPath: null,
      agentRole: 'default',
      dispatchPrompt:
        'You are the final whole-branch code reviewer for the completed Priority Formatting implementation. This is read-only: do not mutate the working tree, index, HEAD, or branch state.',
    }),
  ).toEqual({ role: 'final_reviewer', source: 'dispatch_prompt' });
  // Names fixes and cleanup in its trailing prose, and is still the review.
  expect(
    classifyCodexSeat({
      agentPath: null,
      agentRole: 'default',
      dispatchPrompt:
        'You are doing the final whole-branch review for the report formatter branch after all fixes and cleanup.',
    }),
  ).toEqual({ role: 'final_reviewer', source: 'dispatch_prompt' });
});

test('Codex: an implement or fix dispatch is an implementer', () => {
  expect(
    classifyCodexSeat({
      agentPath: null,
      agentRole: 'worker',
      dispatchPrompt: 'You are implementing Task 1: User Report.',
    }),
  ).toEqual({ role: 'implementer', source: 'dispatch_prompt' });
  expect(
    classifyCodexSeat({
      agentPath: null,
      agentRole: 'worker',
      dispatchPrompt: 'You are fixing Task 2 review findings.',
    }),
  ).toEqual({ role: 'implementer', source: 'dispatch_prompt' });
  // An imperative dispatch with no "You are" preamble.
  expect(
    classifyCodexSeat({
      agentPath: null,
      agentRole: 'worker',
      dispatchPrompt:
        'Fix Task 1 review findings in the feature worktree at /workspace/evals/results/sdd-svelte-todo/coding-agent-workdir/.worktrees/svelte-todo-sdd.',
    }),
  ).toEqual({ role: 'implementer', source: 'dispatch_prompt' });
  expect(
    classifyCodexSeat({
      agentPath: null,
      agentRole: 'worker',
      dispatchPrompt:
        'You are the single final-review fix subagent for this branch.',
    }),
  ).toEqual({ role: 'implementer', source: 'dispatch_prompt' });
  expect(
    classifyCodexSeat({
      agentPath: null,
      agentRole: 'worker',
      dispatchPrompt:
        'You are a fix implementer addressing the final review findings for the completed report formatter work.',
    }),
  ).toEqual({ role: 'implementer', source: 'dispatch_prompt' });
});

test('Codex: a fix wave named for the review it follows is still an implementer', () => {
  // The same fix-vs-fix-review trap the agent_path rules handle: the leading
  // verb decides. These four seats all applied patches.
  expect(
    classifyCodexSeat({
      agentPath: null,
      agentRole: 'worker',
      dispatchPrompt: 'You are fixing Task 3 after re-review.',
    }),
  ).toEqual({ role: 'implementer', source: 'dispatch_prompt' });
  expect(
    classifyCodexSeat({
      agentPath: null,
      agentRole: 'worker',
      dispatchPrompt:
        'You are handling the one final review fix wave for the metrics formatter project.',
    }),
  ).toEqual({ role: 'implementer', source: 'dispatch_prompt' });
  expect(
    classifyCodexSeat({
      agentPath: null,
      agentRole: 'worker',
      dispatchPrompt:
        'You are handling the single final-review cleanup pass for the Go Fractals CLI branch.',
    }),
  ).toEqual({ role: 'implementer', source: 'dispatch_prompt' });
  expect(
    classifyCodexSeat({
      agentPath: null,
      agentRole: 'worker',
      dispatchPrompt:
        'You are doing the single final-review fix wave for the report formatter branch.',
    }),
  ).toEqual({ role: 'implementer', source: 'dispatch_prompt' });
});

test('Codex: agent_role alone yields a coarse role, never a reviewer subtype', () => {
  // The last resort, for a thread whose log holds no dispatch prompt. On the
  // 543-thread corpus agent_role=default was a reviewer 265/265 times and
  // agent_role=worker an implementer 243/278 — enough to name the side of the
  // split, never enough to name WHICH reviewer. `reviewer` says exactly that.
  expect(
    classifyCodexSeat({
      agentPath: null,
      agentRole: 'default',
      dispatchPrompt: null,
    }),
  ).toEqual({ role: 'reviewer', source: 'agent_role' });
  expect(
    classifyCodexSeat({
      agentPath: null,
      agentRole: 'worker',
      dispatchPrompt: null,
    }),
  ).toEqual({ role: 'implementer', source: 'agent_role' });
});

test('Codex: a seat with no signal at all stays other, unclassified', () => {
  expect(
    classifyCodexSeat({
      agentPath: null,
      agentRole: null,
      dispatchPrompt: null,
    }),
  ).toEqual({ role: 'other', source: 'unclassified' });
  // A dispatch prompt that names no job, and no agent_role to fall back on.
  expect(
    classifyCodexSeat({
      agentPath: null,
      agentRole: null,
      dispatchPrompt: 'Continue where the previous thread left off.',
    }),
  ).toEqual({ role: 'other', source: 'unclassified' });
  expect(
    classifyCodexSeat({ agentPath: null, agentRole: null, dispatchPrompt: '' }),
  ).toEqual({ role: 'other', source: 'unclassified' });
});
