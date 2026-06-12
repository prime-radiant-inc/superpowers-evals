import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ToolCall } from '../src/contracts/verdict.ts';
import { ToolCallSchema } from '../src/contracts/verdict.ts';
import { normalizeClaudeLogs } from '../src/normalizers/claude.ts';

// Replay-differential parity oracle. The fixture is a REAL recorded claude
// session mined from results/spec-targets-wrong-component-claude-sonnet-...,
// the single run with exactly one session .jsonl so the committed
// coding-agent-tool-calls.jsonl equals one file's normalization (the Python
// capture normalizes per-file and concatenates; a single-file run makes the
// whole file the unit of comparison). expected-tool-calls.jsonl is the
// Python normalizer's frozen output, verified to reproduce from session.jsonl
// via quorum.normalizers.normalize_claude_logs (EQUAL: True).
//
// If this diverges, the TS normalizer (src/normalizers/claude.ts) is wrong:
// fix the normalizer, do NOT edit this fixture.
const FIX = resolve(import.meta.dir, 'fixtures', 'claude');

function parseExpectedRows(raw: string): ToolCall[] {
  return raw
    .trim()
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      const parsed: unknown = JSON.parse(line);
      const result = ToolCallSchema.safeParse(parsed);
      if (!result.success) {
        throw new Error(
          `expected-tool-calls.jsonl row ${index} is not a valid ToolCall: ${result.error.message}`,
        );
      }
      return result.data;
    });
}

test('TS claude normalizer reproduces the Python tool-call rows for a real session', () => {
  const sessionPath = resolve(FIX, 'session.jsonl');
  const expectedPath = resolve(FIX, 'expected-tool-calls.jsonl');
  if (!existsSync(sessionPath) || !existsSync(expectedPath)) {
    throw new Error('fixture missing — run Task 15 Step 1 to mine/generate it');
  }

  const got = normalizeClaudeLogs(readFileSync(sessionPath, 'utf8'));
  const expected = parseExpectedRows(readFileSync(expectedPath, 'utf8'));

  // Sanity: this is a real, non-trivial session, not an empty oracle.
  expect(expected.length).toBeGreaterThan(0);
  expect(got).toEqual(expected);
});
