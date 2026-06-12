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
