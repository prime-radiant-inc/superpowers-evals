// Seat-role classification from the label the harness recorded.
//
// The patterns below were built by enumerating the labels that actually exist
// in results/: 617 distinct Claude `meta.json.description` values and 141
// distinct Codex `agent_path` values across the 212 sdd-* runs. Nothing here is
// guessed from what a label "probably" says, and nothing unmatched is coerced —
// an unrecognized label is `other` so it shows up in the rollup as
// unclassified rather than silently inflating a role's rate.

import type { SeatRole } from './types.ts';

// --- Claude: meta.json descriptions -----------------------------------------
//
// The controller writes these freehand, so the vocabulary is wide. Two signals
// carry it: the LEADING VERB (does this seat do work, or judge work?) and the
// SCOPE (one task, or the whole branch).

// A leading verb that means "this seat changes the tree". `Fix …`, `Polish …`,
// `Apply …` seats routinely name the review whose findings they are applying
// ("Fix final review findings"), so the leading verb must win over the word
// "review" appearing later.
const IMPLEMENTER_LEAD =
  /^\s*(implement|implementing|fix|fixes|apply|polish|harden|tidy|clean\s*up|cleanup|remove|add|improve|enhance|rework|build|tighten|style\s+fix|test\s+isolation|wire|split|migrate|refactor|update|write|document|silence|untrack|strengthen|simplify|guard|handle|convert|rename|restore|revert|drop|dedupe|delete)\b/i;

// `Final-review fix wave`, `Final review fixes: …`, `Final fix: …`,
// `Final cleanup: …`, `Final hygiene fixes`, `Final polish: …`.
const FINAL_FIX_LEAD =
  /^\s*final[-\s]*(review\s+)?(fix|fixes|cleanup|clean\s*up|hygiene|polish)\b/i;

const IMPLEMENTER_WORD = /\bimplementer\b/i;

const REVIEW_WORD = /\breview(er|ers|s|ed|ing)?\b/i;

// A re-review, or a review of a fix. `\bfix…\b` BEFORE `review` means the
// review is of the fix; the reverse order is a fix applying a review's
// findings and is caught earlier by IMPLEMENTER_LEAD.
const FIX_REVIEW_PATTERNS: readonly RegExp[] = [
  /\bre-?reviews?\b/i,
  /\bre-?reviewer\b/i,
  /\bscoped\b[\s\S]*\breview/i,
  /\bfix(es|ed)?\b[\s\S]*\breview/i,
  /\breview[\s\S]*\bafter\b[\s\S]*\bfix/i,
  /\bre-?check\b[\s\S]*\bfix/i,
  /\bpost-?fix\b/i,
];

// "Task 3", "Tasks 5-6", "for Task 4" — the per-task scope marker.
const TASK_SCOPE = /\btasks?\s*\d/i;

// A fix wave with no review word at all: "Task 2 fix round 3", "Task 4 minor
// fixes", "Task 3 fix: defer+os.Exit cleanup bug".
const BARE_FIX = /\bfix(es)?\b/i;

/**
 * The seat role a Claude subagent's `meta.json.description` names.
 *
 * Precedence, and why:
 *   1. fix/build verbs and `implementer` → implementer. A "Fix final review
 *      findings" seat is doing, not judging.
 *   2. re-review / fix-review wording → fix_reviewer.
 *   3. review + final scope → final_reviewer.
 *   4. review + task scope → task_reviewer.
 *   5. a fix with no review word → implementer.
 *   6. otherwise other.
 */
export function classifyClaudeRole(description: string): SeatRole {
  const label = description.trim();
  if (label.length === 0) {
    return 'other';
  }
  if (
    IMPLEMENTER_WORD.test(label) ||
    FINAL_FIX_LEAD.test(label) ||
    IMPLEMENTER_LEAD.test(label)
  ) {
    return 'implementer';
  }
  if (FIX_REVIEW_PATTERNS.some((pattern) => pattern.test(label))) {
    return 'fix_reviewer';
  }
  if (REVIEW_WORD.test(label)) {
    if (/\bfinal\b/i.test(label) && !TASK_SCOPE.test(label)) {
      return 'final_reviewer';
    }
    if (TASK_SCOPE.test(label)) {
      return 'task_reviewer';
    }
    // A review with neither a task nor a branch scope ("Review code changes",
    // "Code quality review CLI layer"). Genuinely ambiguous; left unclassified.
    return 'other';
  }
  if (BARE_FIX.test(label)) {
    return 'implementer';
  }
  return 'other';
}

// --- Codex: agent_path ------------------------------------------------------
//
// Codex seat labels are the controller-chosen thread names under /root, e.g.
// /root/task1_implementer, /root/final_fix_reviewer. They are far more regular
// than the Claude descriptions, but the same fix-vs-fix-review ordering trap
// exists: final_fix_reviewer reviews a fix, final_review_fixer applies one.

const CODEX_REREVIEW = /re_?-?review/;
const CODEX_REVIEW = /review/;
// "fix" or "cleanup" — a seat that changed the tree, or the subject of a review.
const CODEX_MUTATION = /fix|cleanup|clean_up/;
const CODEX_IMPL = /impl(ement(er|ing)?)?\b|_impl$/;
const CODEX_TASK = /task_?\d/;

/**
 * The seat role a Codex `agent_path` names.
 *
 * Classification reads the LAST path segment, so a depth-2 path such as
 * /root/task_9_implementer/task_9_reviewer is the reviewer it names, not its
 * parent. `null` (Codex CLI 0.144.3 recorded thread_spawn without an
 * agent_path at all) is `other`.
 */
export function classifyCodexRole(agentPath: string | null): SeatRole {
  if (agentPath === null) {
    return 'other';
  }
  const segments = agentPath.split('/').filter((s) => s.length > 0);
  const seat = (segments[segments.length - 1] ?? '').toLowerCase();
  if (seat.length === 0 || seat === 'root') {
    return 'other';
  }
  if (CODEX_REREVIEW.test(seat)) {
    return 'fix_reviewer';
  }
  const mutation = CODEX_MUTATION.exec(seat);
  const review = CODEX_REVIEW.exec(seat);
  if (mutation !== null && review !== null) {
    // fix-then-review is a review OF the fix; review-then-fix applies it.
    return mutation.index < review.index ? 'fix_reviewer' : 'implementer';
  }
  if (review !== null) {
    if (seat.includes('final')) {
      return 'final_reviewer';
    }
    if (CODEX_TASK.test(seat)) {
      return 'task_reviewer';
    }
    return 'other';
  }
  if (CODEX_IMPL.test(seat)) {
    return 'implementer';
  }
  if (mutation !== null) {
    return 'implementer';
  }
  // A seat named for the feature it built (task4_titlecase, task1_slugify)
  // names no role. Left unclassified rather than assumed to be an implementer.
  return 'other';
}
