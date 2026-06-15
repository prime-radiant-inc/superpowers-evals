import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kimiLogsHaveSuperpowersSessionStart } from '../src/normalize/kimi.ts';

// B2-kimi-superpowers-session-start-check: the kimi wire log must show the
// Superpowers plugin_session_start injection fired (parity with Python
// kimi_logs_have_superpowers_session_start).

function writeLog(lines: object[]): string {
  const f = join(mkdtempSync(join(tmpdir(), 'kimi-')), 'wire.jsonl');
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n'));
  return f;
}

test('detects a direct plugin_session_start event for superpowers/using-superpowers', () => {
  const f = writeLog([
    { type: 'something' },
    {
      event: {
        type: 'plugin_session_start',
        plugin: 'superpowers',
        skill: 'using-superpowers',
      },
    },
  ]);
  expect(kimiLogsHaveSuperpowersSessionStart([f])).toBe(true);
});

test('detects the injection-origin variant via message text', () => {
  const f = writeLog([
    {
      origin: { kind: 'injection', variant: 'plugin_session_start' },
      message: {
        content:
          '<plugin_session_start plugin="Superpowers" skill="using-superpowers">',
      },
    },
  ]);
  expect(kimiLogsHaveSuperpowersSessionStart([f])).toBe(true);
});

test('returns false when no session-start signal is present', () => {
  const f = writeLog([
    { event: { type: 'tool.call', name: 'Read' } },
    { message: { content: 'just a normal message' } },
  ]);
  expect(kimiLogsHaveSuperpowersSessionStart([f])).toBe(false);
});

test('returns false for a plugin_session_start of a different plugin', () => {
  const f = writeLog([
    {
      event: {
        type: 'plugin_session_start',
        plugin: 'other-plugin',
        skill: 'x',
      },
    },
  ]);
  expect(kimiLogsHaveSuperpowersSessionStart([f])).toBe(false);
});

test('skips unreadable files and blank/non-JSON lines without throwing', () => {
  const f = writeLog([{ noise: 1 }]);
  expect(
    kimiLogsHaveSuperpowersSessionStart(['/does/not/exist.jsonl', f]),
  ).toBe(false);
});
