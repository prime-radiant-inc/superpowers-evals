import { describe, expect, test } from 'bun:test';
import { compose } from '../src/composer.ts';
import type { CheckManifest } from '../src/contracts/check-manifest.ts';

const gauntletPass = {
  status: 'pass' as const,
  summary: 's',
  reasoning: 'r',
  run_id: 'x',
};
const rec = (over = {}) => ({
  check: 'file-exists',
  args: ['a.txt'],
  negated: false,
  passed: true,
  detail: null,
  phase: 'post' as const,
  ...over,
});
const m = (entries: CheckManifest['entries']): CheckManifest => ({
  schema_version: 1,
  entries,
});

describe('composer manifest enforcement', () => {
  test('gauntlet pass + zero records + manifest expecting post-checks → indeterminate, never pass', () => {
    const v = compose({
      gauntlet: gauntletPass,
      checks: [],
      captureEmpty: false,
      error: null,
      expected: m([
        {
          phase: 'post',
          check: 'file-exists',
          args: ['a.txt'],
          negated: false,
          count: 1,
        },
      ]),
    });
    expect(v.final).toBe('indeterminate');
    expect(v.error?.stage).toBe('checks');
    expect(v.final_reason).toContain('manifest');
  });

  test('matching records compose exactly as before', () => {
    const v = compose({
      gauntlet: gauntletPass,
      checks: [rec()],
      captureEmpty: false,
      error: null,
      expected: m([
        {
          phase: 'post',
          check: 'file-exists',
          args: ['a.txt'],
          negated: false,
          count: 1,
        },
      ]),
    });
    expect(v.final).toBe('pass');
  });

  test('a failed-but-present record is a FAIL verdict, not a manifest error', () => {
    const v = compose({
      gauntlet: gauntletPass,
      checks: [rec({ passed: false })],
      captureEmpty: false,
      error: null,
      expected: m([
        {
          phase: 'post',
          check: 'file-exists',
          args: ['a.txt'],
          negated: false,
          count: 1,
        },
      ]),
    });
    expect(v.final).toBe('fail');
    expect(v.error).toBeNull();
  });

  test('unexpected extra record → indeterminate manifest error', () => {
    const v = compose({
      gauntlet: gauntletPass,
      checks: [rec(), rec({ check: 'git-repo', args: [] })],
      captureEmpty: false,
      error: null,
      expected: m([
        {
          phase: 'post',
          check: 'file-exists',
          args: ['a.txt'],
          negated: false,
          count: 1,
        },
      ]),
    });
    expect(v.final).toBe('indeterminate');
  });

  test('expected: null preserves legacy behavior (zero checks still pass)', () => {
    const v = compose({
      gauntlet: gauntletPass,
      checks: [],
      captureEmpty: false,
      error: null,
      expected: null,
    });
    expect(v.final).toBe('pass');
    expect(v.final_reason).toContain('no deterministic checks');
  });

  test('manifest with legitimately empty post entries + zero post records → pass (empty-post is legal until gating suites police it)', () => {
    const v = compose({
      gauntlet: gauntletPass,
      checks: [rec({ phase: 'pre' })],
      captureEmpty: false,
      error: null,
      expected: m([
        {
          phase: 'pre',
          check: 'file-exists',
          args: ['a.txt'],
          negated: false,
          count: 1,
        },
      ]),
    });
    expect(v.final).toBe('pass');
  });

  test('prior gates still win: gauntlet investigate short-circuits before manifest check', () => {
    const v = compose({
      gauntlet: { ...gauntletPass, status: 'investigate' },
      checks: [],
      captureEmpty: false,
      error: null,
      expected: m([
        {
          phase: 'post',
          check: 'file-exists',
          args: ['a.txt'],
          negated: false,
          count: 1,
        },
      ]),
    });
    expect(v.final_reason).toContain('did not complete');
  });
});
