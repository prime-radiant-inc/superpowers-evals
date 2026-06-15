import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePrivateFileNoFollow } from '../src/agents/private-file.ts';

// B1-env-file-writes-no-nofollow: the shared private-file writer protects every
// secret env/credential write against a pre-placed symlink redirect.

test('writes the data at mode 0600 on a clean path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-'));
  const path = join(dir, '.secret-env');
  writePrivateFileNoFollow(path, 'ANTHROPIC_API_KEY=secret\n');
  expect(readFileSync(path, 'utf8')).toBe('ANTHROPIC_API_KEY=secret\n');
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test('truncates an existing regular file and re-applies 0600', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-'));
  const path = join(dir, '.secret-env');
  writeFileSync(path, 'OLD CONTENT THAT IS LONGER', { mode: 0o644 });
  writePrivateFileNoFollow(path, 'new\n');
  expect(readFileSync(path, 'utf8')).toBe('new\n');
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test('refuses to follow a symlink at the destination (no redirected secret)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-'));
  const victim = join(mkdtempSync(join(tmpdir(), 'victim-')), 'target');
  const path = join(dir, '.secret-env');
  symlinkSync(victim, path);
  expect(() => writePrivateFileNoFollow(path, 'SECRET\n')).toThrow();
  // The symlink target must NOT have been written through.
  expect(existsSync(victim)).toBe(false);
});

test('writes Buffer data as-is', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-'));
  const path = join(dir, '.secret-bin');
  writePrivateFileNoFollow(path, Buffer.from([1, 2, 3]));
  expect([...readFileSync(path)]).toEqual([1, 2, 3]);
});
