import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConversationOutputCaptureError,
  snapshotConversationOutput,
} from '../src/capture/output.ts';

function tempRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'conversation-output-')));
}

test('snapshot retains authored output while excluding repository and dependency trees', () => {
  const root = tempRoot();
  const workdir = join(root, 'workdir');
  const output = join(root, 'output');
  for (const dir of [
    'src',
    'test',
    'docs',
    'scripts',
    '.git/objects',
    'node_modules/pkg',
    'nested/.venv/bin',
  ]) {
    mkdirSync(join(workdir, dir), { recursive: true });
  }
  writeFileSync(join(workdir, 'src/pricing.js'), 'source-v1\n');
  writeFileSync(join(workdir, 'test/pricing.test.js'), 'test\n');
  writeFileSync(join(workdir, 'docs/notes.md'), 'notes\n');
  writeFileSync(join(workdir, 'scripts/check.js'), 'helper\n');
  writeFileSync(join(workdir, '.git/HEAD'), 'ref\n');
  writeFileSync(join(workdir, 'node_modules/pkg/index.js'), 'dependency\n');
  writeFileSync(join(workdir, 'nested/.venv/bin/python'), 'dependency\n');

  expect(snapshotConversationOutput(workdir, output)).toEqual([
    'docs/notes.md',
    'scripts/check.js',
    'src/pricing.js',
    'test/pricing.test.js',
  ]);
  writeFileSync(join(workdir, 'src/pricing.js'), 'source-v2\n');
  expect(readFileSync(join(output, 'src/pricing.js'), 'utf8')).toBe(
    'source-v1\n',
  );
  rmSync(root, { recursive: true, force: true });
});

test('snapshot rejects a symlink that escapes the workspace', () => {
  const root = tempRoot();
  const workdir = join(root, 'workdir');
  mkdirSync(workdir);
  const outside = join(root, 'outside.txt');
  writeFileSync(outside, 'private\n');
  symlinkSync(outside, join(workdir, 'linked.txt'));
  expect(() =>
    snapshotConversationOutput(workdir, join(root, 'output')),
  ).toThrow(ConversationOutputCaptureError);
  rmSync(root, { recursive: true, force: true });
});

test('snapshot does not accept a symlinked workspace root', () => {
  const root = tempRoot();
  const actual = join(root, 'actual');
  mkdirSync(actual);
  writeFileSync(join(actual, 'private.txt'), 'private\n');
  const workdir = join(root, 'workdir');
  symlinkSync(actual, workdir);
  expect(() =>
    snapshotConversationOutput(workdir, join(root, 'output')),
  ).toThrow(ConversationOutputCaptureError);
  rmSync(root, { recursive: true, force: true });
});

test('snapshot cannot expose an excluded tree through an internal link', () => {
  const root = tempRoot();
  const workdir = join(root, 'workdir');
  mkdirSync(join(workdir, '.git'), { recursive: true });
  writeFileSync(join(workdir, '.git/config'), 'private\n');
  symlinkSync(join(workdir, '.git/config'), join(workdir, 'linked-config'));
  expect(() =>
    snapshotConversationOutput(workdir, join(root, 'output')),
  ).toThrow(ConversationOutputCaptureError);
  rmSync(root, { recursive: true, force: true });
});

test('snapshot rejects special files instead of trying to read them', () => {
  const root = tempRoot();
  const workdir = join(root, 'workdir');
  mkdirSync(workdir);
  const fifo = join(workdir, 'pipe');
  const made = spawnSync('mkfifo', [fifo]);
  expect(made.status).toBe(0);
  expect(() =>
    snapshotConversationOutput(workdir, join(root, 'output')),
  ).toThrow(ConversationOutputCaptureError);
  rmSync(root, { recursive: true, force: true });
});
