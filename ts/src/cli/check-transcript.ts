// check-transcript CLI — drop-in replacement for quorum's shell check tools.
//
// Usage: bun run check-transcript.ts <verb> [args...]
//
// Exit codes:
//   0 — check passed
//   1 — check failed
//   2 — usage error (unknown verb or bad args)
//
// DEFERRED verb: tool-arg-match
//   Takes an arbitrary jq expression that requires a separate TS expression
//   contract decision. Keep using the shell tool for this verb.

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
} from "../check/verbs.ts";

const [, , verb, ...rest] = Bun.argv;

if (!verb) {
  console.error("usage: check-transcript <verb> [args...]");
  process.exit(2);
}

// tool-arg-match is intentionally deferred — needs a separate TS expression
// contract decision before a jq-expression-free interface can be defined.
if (verb === "tool-arg-match") {
  console.error(
    "verb not yet supported in check-transcript (uses jq expressions); keep using the shell tool",
  );
  process.exit(2);
}

const { calls, empty } = loadCalls();
const cliArgs = rest;

function dispatch(): void {
  try {
    dispatchInner();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordFail(verb!, cliArgs, `tool error: ${message}`);
    process.exit(1);
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
        console.error(
          `Unknown operator: ${cliArgs[1] ?? ""} (expected: eq, gt, gte, lt, lte)`,
        );
        process.exit(2);
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
    default:
      console.error(`check-transcript: unknown verb '${verb}'`);
      console.error("usage: check-transcript <verb> [args...]");
      process.exit(2);
  }
}

dispatch();
