import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureInput,
  installInputCapture,
  publishInputCapture,
  readInputObservation,
} from '../src/experiments/brainstorming-input-capture.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fixture(campaign = false) {
  const attempt = mkdtempSync(join(tmpdir(), 'input-capture-'));
  dirs.push(attempt);
  const dir = campaign ? join(attempt, 'staging', 'run') : attempt;
  const workdir = join(dir, 'coding-agent-workdir');
  const home = join(campaign ? attempt : dir, 'home');
  const logs = join(home, '.codex', 'sessions');
  mkdirSync(workdir, { recursive: true });
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(workdir, 'README.md'), 'Empty app fixture');
  const evidence = join(dir, 'brainstorming-evidence');
  mkdirSync(evidence);
  installInputCapture(workdir, home);
  const log = join(logs, 'main.jsonl');
  const spec = join(workdir, 'spec.md');
  const raw = `${JSON.stringify({ type: 'session_meta', payload: { id: 'parent', cwd: workdir, source: 'cli' } })}\n${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Please review spec.md.' }] } })}\n`;
  return { dir, workdir, logs, evidence, log, spec, raw };
}

test.each([
  false,
  true,
])('installed guard follows the selected subject home and fails closed after log loss (campaign=%s)', (campaign) => {
  const f = fixture(campaign);
  const guard = join(f.dir, 'gauntlet-agent', 'tui-input-guard');
  const invoke = () =>
    spawnSync(guard, [], {
      input: '{"name":"type","args":{"text":"yes"}}\n',
      encoding: 'utf8',
    });
  expect(invoke().status).toBe(0);
  writeFileSync(f.log, f.raw);
  writeFileSync(f.spec, 'Learning React');
  expect(invoke().status).toBe(0);
  rmSync(f.log);
  expect(invoke().status).not.toBe(0);
});

test('missing-log startup blocks non-Markdown product work', () => {
  const f = fixture();
  writeFileSync(
    join(f.workdir, 'package.json'),
    '{"scripts":{"start":"vite"}}',
  );
  expect(() => captureInput(f.workdir)).toThrow('main Codex');
  expect(readdirSync(f.evidence)).toEqual([]);
});

test('captures actual bytes with a fresh transcript boundary for each revision and observation', () => {
  const f = fixture();
  writeFileSync(f.log, f.raw);
  writeFileSync(f.spec, 'Learning React');
  const first = captureInput(f.workdir);
  appendFileSync(f.log, '{}\n');
  const second = captureInput(f.workdir);
  writeFileSync(f.spec, 'Learning React state and events');
  const third = captureInput(f.workdir);
  const receipts = [first, second, third].map((result) => {
    const receipt = result.receipts.find((r) => r.artifact_path === f.spec)!;
    return JSON.parse(
      readFileSync(join(f.evidence, `${receipt.name}.json`), 'utf8'),
    );
  });
  expect(receipts.map((r) => r.content)).toEqual([
    'Learning React',
    'Learning React',
    'Learning React state and events',
  ]);
  expect(receipts.map((r) => r.after_line)).toEqual([2, 3, 3]);
});

test('same-cwd review subagents do not replace the main rollout; two main sessions fail closed', () => {
  const f = fixture();
  writeFileSync(f.log, f.raw);
  writeFileSync(f.spec, 'Learning React');
  writeFileSync(
    join(f.logs, 'child.jsonl'),
    `${JSON.stringify({ type: 'session_meta', payload: { cwd: f.workdir, source: { subagent: { thread_spawn: { parent_thread_id: 'parent' } } } } })}\n`,
  );
  expect(captureInput(f.workdir).raw_log).toBe(f.log);
  writeFileSync(join(f.logs, 'second.jsonl'), f.raw);
  expect(() => captureInput(f.workdir)).toThrow('main Codex');
});

test('incomplete JSONL and changed artifacts without a log cannot produce receipts', () => {
  const f = fixture();
  writeFileSync(f.spec, 'Learning React');
  expect(() => captureInput(f.workdir)).toThrow();
  writeFileSync(f.log, `${f.raw}{`);
  expect(() => captureInput(f.workdir)).toThrow('JSONL');
  expect(readdirSync(f.evidence)).toEqual([]);
});

test('document symlinks fail closed instead of silently omitting the presented file', () => {
  const f = fixture();
  writeFileSync(f.log, f.raw);
  const outside = join(f.dir, 'outside.md');
  writeFileSync(outside, 'private');
  symlinkSync(outside, f.spec);
  expect(() => captureInput(f.workdir)).toThrow('symlink');
});

test('non-regular files fail promptly instead of blocking the capture reader', () => {
  const f = fixture();
  writeFileSync(f.log, f.raw);
  writeFileSync(f.spec, 'Learning React');
  // Reading this FIFO would hang until a writer connects.
  const fifo = join(f.workdir, 'pending.md');
  expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
  expect(() => captureInput(f.workdir)).toThrow('regular file');
  expect(readdirSync(f.evidence)).toEqual([]);
});

for (const change of ['rewrite', 'append', 'add', 'delete'] as const) {
  test(`a ${change} between observations publishes no receipts`, () => {
    const f = fixture();
    writeFileSync(f.log, f.raw);
    writeFileSync(f.spec, 'Learning React');
    const before = readInputObservation(f.workdir);
    if (change === 'rewrite') writeFileSync(f.spec, 'Different purpose');
    if (change === 'append') appendFileSync(f.log, '{}\n');
    if (change === 'add') writeFileSync(join(f.workdir, 'plan.md'), 'New plan');
    if (change === 'delete') rmSync(f.spec);
    const after = readInputObservation(f.workdir);
    expect(() => publishInputCapture(f.workdir, before, after)).toThrow(
      'changed during observation',
    );
    expect(readdirSync(f.evidence)).toEqual([]);
  });
}
