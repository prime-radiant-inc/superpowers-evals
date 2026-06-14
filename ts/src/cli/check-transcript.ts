// check-transcript CLI — drop-in replacement for quorum's shell check tools.
//
// Usage: bun run check-transcript.ts <verb> [args...]
//
// Exit codes:
//   0   — check passed
//   1   — check failed (an honest pass/fail verdict; `not` may invert it)
//   127 — usage error (no/unknown verb, bad args) OR a tool crash. This is in
//         bin/not's crash range (>=126) ON PURPOSE: a broken/typo'd check must
//         NOT be invertible. If it exited 2 or 1, `not check-transcript <typo>`
//         would treat it as an intentional failure and INVERT it to a silent
//         pass — green-lighting a check that never actually ran.

import { loadCalls } from "../check/transcript.ts";
import { recordPass, recordFail } from "../check/record.ts";
import {
  verbToolCalled,
  verbToolNotCalled,
  verbToolCount,
  verbToolBefore,
  verbSkillCalled,
  verbSkillNotCalled,
  verbSkillBeforeTool,
  verbSkillBeforeImplementationTool,
  verbImplementationToolNotCalled,
  verbInvestigated,
  verbWorktreeCreated,
  verbToolMatchBeforeToolMatch,
  verbToolArgMatch,
} from "../check/verbs.ts";

const [, , verb, ...rest] = Bun.argv;
const cliArgs = rest;

// Non-invertible exit: usage errors and crashes must land in bin/not's crash
// range (>=126) so `not check-transcript ...` can't silently invert a broken
// check into a pass. Always emit a fail record too, so the direct (non-`not`)
// path and the composer see a failed check rather than a missing one.
const NONINVERTIBLE_EXIT = 127;
function brokenCheck(message: string, check: string): never {
  console.error(message);
  recordFail(check, cliArgs, message);
  process.exit(NONINVERTIBLE_EXIT);
}

if (!verb) {
  brokenCheck("usage: check-transcript <verb> [args...]", "check-transcript");
}

const { calls, empty } = loadCalls();

function dispatch(): void {
  try {
    dispatchInner();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    brokenCheck(`tool error: ${message}`, verb!);
  }
}

function dispatchInner(): void {
  switch (verb) {
    case "tool-called": {
      const r = verbToolCalled(calls, empty, cliArgs);
      r.passed
        ? recordPass(verb, cliArgs, r.detail)
        : recordFail(verb, cliArgs, r.detail);
      process.exit(r.passed ? 0 : 1);
    }
    case "tool-not-called": {
      const r = verbToolNotCalled(calls, empty, cliArgs);
      r.passed
        ? recordPass(verb, cliArgs, r.detail)
        : recordFail(verb, cliArgs, r.detail);
      process.exit(r.passed ? 0 : 1);
    }
    case "tool-count": {
      const r = verbToolCount(calls, empty, cliArgs);
      if (r === null) {
        brokenCheck(
          `Unknown operator: ${cliArgs[1] ?? ""} (expected: eq, gt, gte, lt, lte)`,
          verb,
        );
      }
      r.passed
        ? recordPass(verb, cliArgs, r.detail)
        : recordFail(verb, cliArgs, r.detail);
      process.exit(r.passed ? 0 : 1);
    }
    case "tool-before": {
      const r = verbToolBefore(calls, empty, cliArgs);
      r.passed
        ? recordPass(verb, cliArgs, r.detail)
        : recordFail(verb, cliArgs, r.detail);
      process.exit(r.passed ? 0 : 1);
    }
    case "skill-called": {
      const r = verbSkillCalled(calls, empty, cliArgs);
      r.passed
        ? recordPass(verb, cliArgs, r.detail)
        : recordFail(verb, cliArgs, r.detail);
      process.exit(r.passed ? 0 : 1);
    }
    case "skill-not-called": {
      const r = verbSkillNotCalled(calls, empty, cliArgs);
      r.passed
        ? recordPass(verb, cliArgs, r.detail)
        : recordFail(verb, cliArgs, r.detail);
      process.exit(r.passed ? 0 : 1);
    }
    case "skill-before-tool": {
      const r = verbSkillBeforeTool(calls, empty, cliArgs);
      r.passed
        ? recordPass(verb, cliArgs, r.detail)
        : recordFail(verb, cliArgs, r.detail);
      process.exit(r.passed ? 0 : 1);
    }
    case "skill-before-implementation-tool": {
      const r = verbSkillBeforeImplementationTool(calls, empty, cliArgs);
      r.passed
        ? recordPass(verb, cliArgs, r.detail)
        : recordFail(verb, cliArgs, r.detail);
      process.exit(r.passed ? 0 : 1);
    }
    case "implementation-tool-not-called": {
      const r = verbImplementationToolNotCalled(calls, empty, cliArgs);
      r.passed
        ? recordPass(verb, cliArgs, r.detail)
        : recordFail(verb, cliArgs, r.detail);
      process.exit(r.passed ? 0 : 1);
    }
    case "investigated": {
      const r = verbInvestigated(calls, empty, cliArgs);
      r.passed
        ? recordPass(verb, cliArgs, r.detail)
        : recordFail(verb, cliArgs, r.detail);
      process.exit(r.passed ? 0 : 1);
    }
    case "worktree-created": {
      const r = verbWorktreeCreated(calls, empty, cliArgs);
      r.passed
        ? recordPass(verb, cliArgs, r.detail)
        : recordFail(verb, cliArgs, r.detail);
      process.exit(r.passed ? 0 : 1);
    }
    case "tool-match-before-tool-match": {
      const r = verbToolMatchBeforeToolMatch(calls, empty, cliArgs);
      r.passed
        ? recordPass(verb, cliArgs, r.detail)
        : recordFail(verb, cliArgs, r.detail);
      process.exit(r.passed ? 0 : 1);
    }
    case "tool-arg-match": {
      const r = verbToolArgMatch(calls, empty, cliArgs);
      r.passed
        ? recordPass(verb, cliArgs, r.detail)
        : recordFail(verb, cliArgs, r.detail);
      process.exit(r.passed ? 0 : 1);
    }
    default:
      brokenCheck(`check-transcript: unknown verb '${verb}'`, verb ?? "check-transcript");
  }
}

dispatch();
