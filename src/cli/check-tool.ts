// check-tool CLI — the single typed dispatcher behind the bare check verbs.
//
// Usage: bun run check-tool.ts <verb> [args...]
//
// Each check verb is a bash function (defined by the sourced prelude,
// src/checks/prelude.sh) that execs this CLI with its own name as <verb>
// (e.g. file-exists → `check-tool.ts file-exists "$@"`). This generalizes the
// check-transcript precedent: all check LOGIC lives in src/check/ as pure verb
// functions; this file owns record emission + the 127 crash-band exit
// discipline.
//
// Exit codes (shared with check-transcript):
//   0   — check passed
//   1   — check failed (an honest pass/fail; `not` may invert it)
//   127 — broken check: usage error / unknown verb / missing required arg /
//         unknown operator/dimension / a thrown tool error. In `not`'s crash
//         range (>=126) ON PURPOSE so a broken/typo'd check can't vacuously
//         pass or be inverted into a silent pass.
//
// `not <inner> [args...]` is handled in-process (no subprocess, no jq): it runs
// the inner verb via the shared dispatch table and emits one negated record. It
// refuses to invert a missing inner tool or an inner crash — recording a FAIL
// under `not` and exiting 1 (NOT 127: a 127 would crash the whole phase via
// runPhase's heuristic; `not` deliberately uses exit 1).

import { negate, runVerb } from '../check/dispatch.ts';
import { defaultContext } from '../check/fs-verbs.ts';
import { recordFail, recordWith } from '../check/record.ts';

const [, , verb, ...args] = Bun.argv;

const NONINVERTIBLE_EXIT = 127;

function brokenExit(
  message: string,
  check: string,
  checkArgs: string[],
): never {
  console.error(message);
  recordFail(check, checkArgs, message);
  process.exit(NONINVERTIBLE_EXIT);
}

if (!verb) {
  brokenExit('usage: check-tool <verb> [args...]', 'check-tool', []);
}

const verbName: string = verb;
const ctx = defaultContext();

// `not` is its own verb: run the inner verb in-process, emit a single record.
if (verbName === 'not') {
  const r = negate(args, ctx);
  recordWith(r.check, r.args, r.passed, r.negated, r.detail);
  // refused (missing inner / inner crash) and normal failure both exit 1; only
  // a successful inversion exits 0. None of these is the 127 crash band.
  process.exit(r.passed ? 0 : 1);
}

let outcome: ReturnType<typeof runVerb>;
try {
  outcome = runVerb(verbName, args, ctx);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  brokenExit(`tool error: ${message}`, verbName, args);
}

if (outcome === null) {
  brokenExit(`check-tool: unknown verb '${verbName}'`, verbName, args);
}

if (outcome.broken) {
  brokenExit(outcome.detail, verbName, args);
}

if (outcome.passed) {
  recordWith(verbName, args, true, false, outcome.detail);
  process.exit(0);
} else {
  recordWith(verbName, args, false, false, outcome.detail);
  process.exit(1);
}
