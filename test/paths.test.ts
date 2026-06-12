import { expect, test } from 'bun:test';
import { hexNonce, nowStampUtc } from '../src/paths.ts';

test('nowStampUtc formats as YYYYMMDDTHHMMSSZ', () => {
  const stamp = nowStampUtc(new Date('2026-06-12T01:53:01.000Z'));
  expect(stamp).toBe('20260612T015301Z');
});

test('hexNonce is 4 lowercase hex chars', () => {
  expect(hexNonce()).toMatch(/^[0-9a-f]{4}$/);
});
