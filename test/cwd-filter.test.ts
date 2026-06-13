import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filterLogsByCwd } from '../src/capture/cwd-filter.ts';

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('codex filter keeps only rollouts whose session_meta cwd matches', () => {
  const dir = tmp('codex-');
  const target = tmp('target-');
  const match = join(dir, 'match.jsonl');
  writeFileSync(
    match,
    `${JSON.stringify({ type: 'session_meta', payload: { cwd: target } })}\n`,
  );
  const other = join(dir, 'other.jsonl');
  writeFileSync(
    other,
    `${JSON.stringify({ type: 'session_meta', payload: { cwd: tmp('elsewhere-') } })}\n`,
  );
  const noMeta = join(dir, 'no-meta.jsonl');
  writeFileSync(noMeta, `${JSON.stringify({ type: 'response_item' })}\n`);

  expect(filterLogsByCwd('codex', [match, other, noMeta], target)).toEqual([
    match,
  ]);
});

test('pi filter keeps only sessions whose header cwd matches', () => {
  const dir = tmp('pi-');
  const target = tmp('target-');
  const match = join(dir, 'match.jsonl');
  writeFileSync(match, `${JSON.stringify({ type: 'session', cwd: target })}\n`);
  const other = join(dir, 'other.jsonl');
  writeFileSync(
    other,
    `${JSON.stringify({ type: 'session', cwd: tmp('elsewhere-') })}\n`,
  );
  const malformed = join(dir, 'malformed.jsonl');
  writeFileSync(malformed, 'not json\n');

  expect(filterLogsByCwd('pi', [match, other, malformed], target)).toEqual([
    match,
  ]);
});

test('kimi filter uses session_index workDir attribution', () => {
  const home = tmp('kimi-home-');
  const target = tmp('kimi-target-');
  const matchDir = join(home, 'sessions', 'wd_target', 'session_match');
  const otherDir = join(home, 'sessions', 'wd_other', 'session_other');
  mkdirSync(matchDir, { recursive: true });
  mkdirSync(otherDir, { recursive: true });
  const match = join(matchDir, 'wire.jsonl');
  const other = join(otherDir, 'wire.jsonl');
  writeFileSync(match, '{}\n');
  writeFileSync(other, '{}\n');
  writeFileSync(
    join(home, 'session_index.jsonl'),
    `${JSON.stringify({ sessionDir: matchDir, workDir: target })}\n${JSON.stringify(
      { sessionDir: otherDir, workDir: tmp('elsewhere-') },
    )}\n`,
  );

  expect(filterLogsByCwd('kimi', [match, other], target)).toEqual([match]);
});

test('dialects without a filter pass through unchanged', () => {
  const paths = ['/a/x.jsonl', '/b/y.jsonl'];
  expect(filterLogsByCwd('claude', paths, '/anywhere')).toEqual(paths);
  expect(filterLogsByCwd('gemini', paths, '/anywhere')).toEqual(paths);
  expect(filterLogsByCwd('antigravity', paths, '/anywhere')).toEqual(paths);
});
