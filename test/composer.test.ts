import { expect, test } from 'bun:test';
import { compose } from '../src/composer.ts';
import type { CheckRecord, GauntletLayer } from '../src/contracts/verdict.ts';

const G = (status: GauntletLayer['status']): GauntletLayer => ({
  status,
  summary: '',
  reasoning: '',
  run_id: 'r',
});
const post = (passed: boolean): CheckRecord => ({
  check: 'file-exists',
  args: [],
  negated: false,
  passed,
  detail: null,
  phase: 'post',
});

test('error -> indeterminate with stage in reason', () => {
  const v = compose({
    gauntlet: null,
    checks: [],
    captureEmpty: false,
    error: { stage: 'setup', message: 'boom' },
  });
  expect(v.final).toBe('indeterminate');
  expect(v.final_reason).toContain('quorum error (setup)');
});

test('failed pre-check -> indeterminate', () => {
  const pre: CheckRecord = {
    check: 'git-repo',
    args: [],
    negated: false,
    passed: false,
    detail: null,
    phase: 'pre',
  };
  expect(
    compose({
      gauntlet: G('pass'),
      checks: [pre],
      captureEmpty: false,
      error: null,
    }).final,
  ).toBe('indeterminate');
});

test('gauntlet investigate -> indeterminate', () => {
  expect(
    compose({
      gauntlet: G('investigate'),
      checks: [],
      captureEmpty: false,
      error: null,
    }).final,
  ).toBe('indeterminate');
});

test('gauntlet pass + no failed post -> pass', () => {
  expect(
    compose({
      gauntlet: G('pass'),
      checks: [post(true)],
      captureEmpty: false,
      error: null,
    }).final,
  ).toBe('pass');
});

test('gauntlet pass + failed post -> fail', () => {
  expect(
    compose({
      gauntlet: G('pass'),
      checks: [post(false)],
      captureEmpty: false,
      error: null,
    }).final,
  ).toBe('fail');
});

test('empty capture + trace check -> indeterminate', () => {
  const trace: CheckRecord = {
    check: 'tool-called',
    args: ['Bash'],
    negated: false,
    passed: true,
    detail: null,
    phase: 'post',
  };
  expect(
    compose({
      gauntlet: G('pass'),
      checks: [trace],
      captureEmpty: true,
      error: null,
    }).final,
  ).toBe('indeterminate');
});

// Every check-transcript verb that reads the transcript must be guarded: on an
// empty capture its pass/fail is meaningless, so the composer must force
// `indeterminate`. This is the dispatch table of src/cli/check-transcript.ts —
// if a verb is added there it must be added to TRACE_PRIMITIVES, and this test
// is the lock that catches the omission.
const CHECK_TRANSCRIPT_VERBS = [
  'tool-called',
  'tool-not-called',
  'tool-count',
  'tool-before',
  'tool-arg-match',
  'tool-match-before-tool-match',
  'skill-called',
  'skill-not-called',
  'skill-before-tool',
  'skill-before-implementation-tool',
  'implementation-tool-not-called',
  'investigated',
  'worktree-created',
];

for (const verb of CHECK_TRANSCRIPT_VERBS) {
  test(`empty capture + ${verb} -> indeterminate (trace-guard covers the verb)`, () => {
    const trace: CheckRecord = {
      check: verb,
      args: [],
      negated: false,
      passed: true,
      detail: null,
      phase: 'post',
    };
    expect(
      compose({
        gauntlet: G('pass'),
        checks: [trace],
        captureEmpty: true,
        error: null,
      }).final,
    ).toBe('indeterminate');
  });
}

// A negated transcript check (`not check-transcript <verb>`) is recorded by
// bin/not / bin/_record with `check: "check-transcript"` (the wrapped tool
// name), NOT the verb. On an empty capture its pass/fail is still meaningless,
// so the guard must catch it via the wrapper name.
test('empty capture + negated check-transcript -> indeterminate', () => {
  const trace: CheckRecord = {
    check: 'check-transcript',
    args: ['tool-arg-match', 'Bash', '--matches', 'x=y'],
    negated: true,
    passed: true,
    detail: null,
    phase: 'post',
  };
  expect(
    compose({
      gauntlet: G('pass'),
      checks: [trace],
      captureEmpty: true,
      error: null,
    }).final,
  ).toBe('indeterminate');
});

// A non-transcript check (git/fs state) is NOT a trace primitive: an empty
// capture says nothing about it, so it must NOT trigger the guard.
test('empty capture + non-trace check (file-exists) -> not guarded', () => {
  expect(
    compose({
      gauntlet: G('pass'),
      checks: [post(true)],
      captureEmpty: true,
      error: null,
    }).final,
  ).toBe('pass');
});
