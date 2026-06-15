// check-transcript CLI — runs trace checks over a captured transcript.
//
// Usage: bun run check-transcript.ts <verb> [args...]
//
// Exit codes:
//   0   — check passed
//   1   — check failed (an honest pass/fail verdict; `not` may invert it)
//   127 — usage error (no/unknown verb, bad args) OR a tool crash. This is in
//         `not`'s crash range (>=126) ON PURPOSE: a broken/typo'd check must
//         NOT be invertible. If it exited 2 or 1, `not check-transcript <typo>`
//         would treat it as an intentional failure and INVERT it to a silent
//         pass — green-lighting a check that never actually ran.
//
// The verb dispatch + arity/usage gates live in src/check/transcript-dispatch.ts
// (shared with the unified check-tool dispatcher's `not` path); this file owns
// only the record emission + exit-code mapping.

import { recordFail, recordPass } from '../check/record.ts';
import { loadCalls } from '../check/transcript.ts';
import { transcriptOutcome } from '../check/transcript-dispatch.ts';

const [, , verb, ...rest] = Bun.argv;
const cliArgs = rest;

// Non-invertible exit: usage errors and crashes must land in `not`'s crash
// range (>=126) so `not check-transcript ...` can't silently invert a broken
// check into a pass. Always emit a fail record too, so the direct (non-`not`)
// path and the composer see a failed check rather than a missing one.
const NONINVERTIBLE_EXIT = 127;

// The record's `check` is the verb name (the wrapper name `check-transcript`
// only appears via `not check-transcript ...`, recorded by the unified
// dispatcher's negate path). A missing verb has no name → record under the
// wrapper name.
const verbName = verb ?? 'check-transcript';

const { calls, empty } = loadCalls();
const outcome = transcriptOutcome(verb ?? '', cliArgs, calls, empty);

if (outcome.broken) {
  console.error(outcome.detail);
  recordFail(verbName, cliArgs, outcome.detail);
  process.exit(NONINVERTIBLE_EXIT);
}

if (outcome.passed) {
  recordPass(verbName, cliArgs, outcome.detail);
  process.exit(0);
} else {
  recordFail(verbName, cliArgs, outcome.detail);
  process.exit(1);
}
