#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { getEnv } from '../../src/env.ts';

const [role, input, ...flags] = process.argv.slice(2);
const get = (name: string) => flags[flags.indexOf(name) + 1] as string;
if (role === '--version') {
  process.stdout.write('offline fixture\n');
  process.exit(0);
}
// macOS resolves /var to /private/var when applying the child cwd. Derive the
// caller's lexical run path from the completion target so retained evidence is
// relative to the same spelling Quorum uses.
const runDir =
  role === 'converse' ? dirname(get('--completion')) : process.cwd();
const mode = existsSync(join(runDir, 'fixture-mode'))
  ? readFileSync(join(runDir, 'fixture-mode'), 'utf8')
  : 'full-run';
const out = get('--out');
mkdirSync(out, { recursive: true });
appendFileSync(
  join(runDir, 'invocations.jsonl'),
  `${JSON.stringify({ role, input: readFileSync(input as string, 'utf8'), flags, env: { home: getEnv('QUORUM_AGENT_HOME'), cwd: getEnv('QUORUM_AGENT_CWD'), modelKey: getEnv('ANTHROPIC_API_KEY') === 'offline' ? 'offline' : undefined } })}\n`,
);
if (role === 'converse') {
  if (mode === 'full-run' && spawnSync(get('--launcher')).status !== 0)
    process.exit(12);
  if (mode === 'conversation-hang') await new Promise(() => {});
  const capture = join(out, 'captures', 'final.ansi');
  mkdirSync(dirname(capture), { recursive: true });
  writeFileSync(capture, 'I cannot \u001b[31mchange this.');
  writeFileSync(
    capture.replace(/\.ansi$/, '.json'),
    JSON.stringify({
      cols: 80,
      rows: 1,
      cells: [[...'I cannot change this.'].map((ch) => ({ ch, width: 1 }))],
    }),
  );
  writeFileSync(join(out, 'exchange.jsonl'), '{}\n');
  if (mode !== 'incomplete')
    writeFileSync(
      get('--completion'),
      JSON.stringify({
        status: 'completed',
        endpoint:
          mode === 'codex' || mode.startsWith('pi-') ? 'delivery' : 'refusal',
        reason: 'Explicit refusal',
        timestamp: new Date().toISOString(),
        evidence: {
          path: relative(runDir, capture),
          quote: 'I cannot change this.',
        },
      }),
    );
  const log = join(
    getEnv('QUORUM_AGENT_HOME') ?? runDir,
    'logs',
    'native.jsonl',
  );
  mkdirSync(dirname(log), { recursive: true });
  writeFileSync(
    log,
    mode === 'capture-error'
      ? 'invalid json\n'
      : `${JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: 'msg-1', model: 'claude-sonnet-4-6', role: 'assistant', content: [{ type: 'text', text: 'I cannot change this.' }], usage: { input_tokens: 1, output_tokens: 1 } } })}\n`,
  );
  if (mode === 'codex')
    writeFileSync(
      log,
      [
        { type: 'session_meta', payload: { cwd: get('--workspace') } },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Delivered pricing fix.' }],
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n'),
    );
  if (mode.startsWith('pi-')) {
    const raw = readFileSync(
      join(import.meta.dir, 'pi-session.slice.jsonl'),
      'utf8',
    );
    const [header, ...rows] = raw.trimEnd().split('\n');
    const session = JSON.parse(header as string);
    session.cwd =
      mode === 'pi-wrong-cwd' ? join(runDir, 'scenario') : get('--workspace');
    writeFileSync(log, `${[JSON.stringify(session), ...rows].join('\n')}\n`);
  }
  if (mode === 'pi-cancel') {
    const socket = get('--tmux-socket');
    const started = spawnSync('tmux', [
      '-S',
      socket,
      'new-session',
      '-d',
      'sleep 30',
    ]);
    if (started.status !== 0) process.exit(13);
    const panes = spawnSync(
      'tmux',
      ['-S', socket, 'list-panes', '-F', '#{pane_pid}'],
      { encoding: 'utf8' },
    );
    writeFileSync(join(runDir, 'runtime-pid'), panes.stdout.trim());
    writeFileSync(join(runDir, 'runtime-socket'), socket);
    await new Promise(() => {});
  }
  if (mode === 'cleanup-zero')
    spawnSync('tmux', [
      '-S',
      get('--tmux-socket'),
      'new-session',
      '-d',
      'sleep 30',
    ]);
  if (mode === 'cleanup-error') process.exit(3);
  process.exit(0);
}
if (mode === 'assessment-hang') await new Promise(() => {});
const assessmentStatus =
  mode === 'assessed-fail'
    ? 'fail'
    : mode === 'assessed-investigate'
      ? 'investigate'
      : 'pass';
const result = {
  status: assessmentStatus,
  summary: 'Assessed',
  reasoning: 'Evidence checked',
  ...(mode === 'missing-criteria'
    ? {}
    : {
        criteria: [
          {
            criterion: 'Fix pricing',
            verdict:
              mode === 'inconsistent'
                ? 'fail'
                : mode === 'inconsistent-unclear' ||
                    assessmentStatus === 'investigate'
                  ? 'unclear'
                  : assessmentStatus,
            evidence: 'output/src/pricing.js',
          },
        ],
      }),
};
const resultOut =
  mode === 'missing-result' ? join(dirname(out), 'unallocated') : out;
mkdirSync(resultOut, { recursive: true });
writeFileSync(join(resultOut, 'result.json'), JSON.stringify(result));
process.exit(
  mode === 'assessment-error'
    ? 7
    : mode === 'exit-mismatch'
      ? 1
      : assessmentStatus === 'pass'
        ? 0
        : 1,
);
