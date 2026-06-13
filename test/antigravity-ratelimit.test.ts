import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { antigravityRateLimitReason } from '../src/agents/antigravity.ts';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'agy-config-'));
}

test('returns a reason when agy.log shows RESOURCE_EXHAUSTED', () => {
  const dir = tmpDir();
  writeFileSync(
    join(dir, 'agy.log'),
    'starting up\nstatus=RESOURCE_EXHAUSTED quota exceeded\n',
  );
  const reason = antigravityRateLimitReason(dir);
  expect(reason).not.toBeNull();
  expect(reason).toContain('Code Assist rate limit');
});

test('returns a reason on a word-boundaried 429', () => {
  const dir = tmpDir();
  writeFileSync(join(dir, 'agy.log'), 'HTTP 429 Too Many Requests\n');
  expect(antigravityRateLimitReason(dir)).not.toBeNull();
});

test('returns null when agy.log is clean', () => {
  const dir = tmpDir();
  writeFileSync(join(dir, 'agy.log'), 'all good, exit 0, response: OK\n');
  expect(antigravityRateLimitReason(dir)).toBeNull();
});

test('returns null when agy.log is absent', () => {
  expect(antigravityRateLimitReason(tmpDir())).toBeNull();
});

test('does not false-positive on an embedded 429 (e.g. a port or id)', () => {
  const dir = tmpDir();
  writeFileSync(join(dir, 'agy.log'), 'listening on port 14290; build 4291\n');
  expect(antigravityRateLimitReason(dir)).toBeNull();
});
