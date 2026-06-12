import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ToolCall } from '../src/contracts/verdict.ts';
import { ToolCallSchema } from '../src/contracts/verdict.ts';
import { normalizeCodexLogs } from '../src/normalizers/codex.ts';

// Replay-differential parity oracle for the codex dialect. No real codex run
// exists under results/ (the only recorded run there is antigravity), so this
// fixture is SYNTHETIC: a hand-built session.jsonl that exercises every codex
// shape — function_call (exec_command, apply_patch, spawn_agent->Agent,
// wait_agent/close_agent verbatim, non-JSON arguments fallback),
// custom_tool_call (apply_patch raw-string input), and an item-keyed
// local_shell_call (array command joined on space).
//
// expected-tool-calls.jsonl is NOT hand-written: it is the frozen output of
// the REAL Python normalizer (quorum.normalizers.normalize_codex_logs) run
// over this same session.jsonl. So while the session is synthetic, the parity
// assertion is genuine — the TS normalizer must reproduce the Python rows.
//
// If this diverges, the TS normalizer (src/normalizers/codex.ts) is wrong:
// fix the normalizer, do NOT edit this fixture.
const FIX = resolve(import.meta.dir, 'fixtures', 'codex');

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

test('TS codex normalizer reproduces the Python tool-call rows for the dialect fixture', () => {
  const sessionPath = resolve(FIX, 'session.jsonl');
  const expectedPath = resolve(FIX, 'expected-tool-calls.jsonl');
  if (!existsSync(sessionPath) || !existsSync(expectedPath)) {
    throw new Error(
      'codex fixture missing — regenerate session.jsonl + expected-tool-calls.jsonl',
    );
  }

  const got = normalizeCodexLogs(readFileSync(sessionPath, 'utf8'));
  const expected = parseExpectedRows(readFileSync(expectedPath, 'utf8'));

  // Sanity: a non-trivial fixture, not an empty oracle.
  expect(expected.length).toBeGreaterThan(0);
  expect(got).toEqual(expected);
});
