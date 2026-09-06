import { expect, test } from 'bun:test';
import {
  EFFORT_LEVELS,
  EffortLevelSchema,
  effortRefusal,
} from '../src/contracts/effort.ts';

test('every effort level parses and unknown levels reject', () => {
  for (const level of EFFORT_LEVELS) {
    expect(EffortLevelSchema.parse(level)).toBe(level);
  }
  expect(() => EffortLevelSchema.parse('ultra')).toThrow();
});

test('codex accepts minimal through xhigh and refuses max', () => {
  expect(effortRefusal('codex', 'minimal')).toBeNull();
  expect(effortRefusal('codex', 'xhigh')).toBeNull();
  expect(effortRefusal('codex', 'max')).toBe(
    'harness codex does not accept effort max (accepts minimal, low, medium, high, xhigh)',
  );
});

test('claude accepts low through max and refuses minimal', () => {
  expect(effortRefusal('claude', 'low')).toBeNull();
  expect(effortRefusal('claude', 'xhigh')).toBeNull();
  expect(effortRefusal('claude', 'max')).toBeNull();
  expect(effortRefusal('claude', 'minimal')).toBe(
    'harness claude does not accept effort minimal (accepts low, medium, high, xhigh, max)',
  );
});

test('a family without an effort control refuses every level', () => {
  expect(effortRefusal('pi', 'high')).toBe('harness pi has no effort control');
});
