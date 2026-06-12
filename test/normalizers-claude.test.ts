import { expect, test } from 'bun:test';
import { ToolCallSchema } from '../src/contracts/verdict.ts';
import { normalizeClaudeLogs } from '../src/normalizers/claude.ts';
import { NORMALIZERS } from '../src/normalizers/index.ts';

test('flat tool_use: Bash is shell, Read is native', () => {
  const raw = [
    JSON.stringify({
      type: 'tool_use',
      name: 'Bash',
      input: { command: 'git status' },
    }),
    JSON.stringify({
      type: 'tool_use',
      name: 'Read',
      input: { file_path: '/x' },
    }),
    JSON.stringify({ type: 'text', text: 'ignored' }),
  ].join('\n');
  expect(normalizeClaudeLogs(raw)).toEqual([
    { tool: 'Bash', args: { command: 'git status' }, source: 'shell' },
    { tool: 'Read', args: { file_path: '/x' }, source: 'native' },
  ]);
});

test('nested assistant message: multiple tool_use blocks captured in order', () => {
  const raw = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/a' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
      ],
    },
  });
  expect(normalizeClaudeLogs(raw)).toEqual([
    { tool: 'Edit', args: { file_path: '/a' }, source: 'native' },
    { tool: 'Bash', args: { command: 'ls' }, source: 'shell' },
  ]);
});

test('blank lines and malformed JSON are skipped', () => {
  const raw = [
    '',
    '   ',
    'not json',
    JSON.stringify({ type: 'tool_use', name: 'Glob', input: {} }),
  ].join('\n');
  expect(normalizeClaudeLogs(raw)).toEqual([
    { tool: 'Glob', args: {}, source: 'native' },
  ]);
});

test('tool_use with missing input defaults args to {}', () => {
  const raw = JSON.stringify({ type: 'tool_use', name: 'Grep' });
  expect(normalizeClaudeLogs(raw)).toEqual([
    { tool: 'Grep', args: {}, source: 'native' },
  ]);
});

test('non-tool entries and unrecognized shapes yield no calls', () => {
  const raw = [
    JSON.stringify({ type: 'user', message: { content: 'hello' } }),
    JSON.stringify({ type: 'assistant', message: { content: [] } }),
    JSON.stringify({ foo: 'bar' }),
    JSON.stringify(42),
    JSON.stringify(null),
  ].join('\n');
  expect(normalizeClaudeLogs(raw)).toEqual([]);
});

test('every emitted call validates against the ToolCall contract', () => {
  const raw = JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'Write',
          input: { file_path: '/f', contents: 'x' },
        },
      ],
    },
  });
  for (const call of normalizeClaudeLogs(raw)) {
    expect(ToolCallSchema.parse(call)).toEqual(call);
  }
});

test('NORMALIZERS registry routes "claude" to normalizeClaudeLogs', () => {
  const fn = NORMALIZERS['claude'];
  expect(fn).toBe(normalizeClaudeLogs);
  const raw = JSON.stringify({
    type: 'tool_use',
    name: 'Bash',
    input: { command: 'ls' },
  });
  expect(fn?.(raw)).toEqual([
    { tool: 'Bash', args: { command: 'ls' }, source: 'shell' },
  ]);
});
