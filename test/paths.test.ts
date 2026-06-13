import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { hexNonce, nowStampUtc, repoRoot } from '../src/paths.ts';

test('nowStampUtc formats as YYYYMMDDTHHMMSSZ', () => {
  const stamp = nowStampUtc(new Date('2026-06-12T01:53:01.000Z'));
  expect(stamp).toBe('20260612T015301Z');
});

test('hexNonce is 4 lowercase hex chars', () => {
  expect(hexNonce()).toMatch(/^[0-9a-f]{4}$/);
});

test('repoRoot points at the dir containing coding-agents/ and scenarios/', () => {
  const root = repoRoot();
  expect(existsSync(join(root, 'coding-agents'))).toBe(true);
  expect(existsSync(join(root, 'scenarios'))).toBe(true);
  // No trailing separator (a clean dir path), and it is NOT src/.
  expect(root.endsWith('/')).toBe(false);
  expect(root.endsWith('/src')).toBe(false);
});
