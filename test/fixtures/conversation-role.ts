#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
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
  `${JSON.stringify({ role, input: readFileSync(input as string, 'utf8'), flags, arguments: Object.fromEntries(flags.flatMap((flag, index) => (flag.startsWith('--') ? [[flag.slice(2), flags[index + 1]]] : []))), env: { home: getEnv('QUORUM_AGENT_HOME'), cwd: getEnv('QUORUM_AGENT_CWD'), modelKey: getEnv('ANTHROPIC_API_KEY') === 'offline' ? 'offline' : undefined } })}\n`,
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
  if (mode === 'pi-usage-only') {
    writeFileSync(
      log,
      [
        { type: 'session', id: 'usage-only', cwd: get('--workspace') },
        {
          type: 'message',
          message: {
            role: 'assistant',
            provider: 'openai-codex',
            model: 'gpt-5.6-sol',
            usage: { input: 10, output: 5, cost: { total: 0.25 } },
            content: [],
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n'),
    );
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
  mode === 'assessed-fail' ||
  mode === 'unknown-usage-fail' ||
  mode === 'contradictory-all-pass-fail' ||
  mode === 'operational-exit'
    ? 'fail'
    : mode === 'assessed-investigate' ||
        mode === 'unknown-usage-investigate' ||
        mode === 'contradictory-all-pass-investigate' ||
        mode === 'contradictory-mixed-investigate' ||
        mode === 'assessment-timeout-report'
      ? 'investigate'
      : 'pass';
const criterionVerdicts =
  mode === 'contradictory-mixed-investigate'
    ? ['pass', 'pass', 'pass', 'fail']
    : [
        mode === 'inconsistent'
          ? 'fail'
          : mode === 'inconsistent-unclear' ||
              assessmentStatus === 'investigate'
            ? 'unclear'
            : assessmentStatus,
      ];
const result = {
  runId: basename(out),
  scenario: basename(out).split('_')[0],
  status: assessmentStatus,
  summary:
    mode === 'assessment-timeout-report' ? 'Assessment timed out' : 'Assessed',
  reasoning:
    mode === 'assessment-timeout-report'
      ? 'The assessor did not produce a valid report_result within 120000ms.'
      : 'Evidence checked',
  ...(mode === 'missing-criteria' || mode === 'assessment-timeout-report'
    ? {}
    : {
        criteria: criterionVerdicts.map((verdict, index) => ({
          criterion: index === 0 ? 'Fix pricing' : `Criterion ${index + 1}`,
          verdict:
            mode === 'contradictory-all-pass-fail' ||
            mode === 'contradictory-all-pass-investigate'
              ? 'pass'
              : verdict,
          evidence: 'output/src/pricing.js',
        })),
      }),
};
const resultOut =
  mode === 'missing-result' ? join(dirname(out), 'unallocated') : out;
mkdirSync(resultOut, { recursive: true });
writeFileSync(join(resultOut, 'result.json'), JSON.stringify(result));
const identity = { assessment_request_id: '001', assessment_attempt_id: '001' };
const zeroResponse = mode === 'conversion-error' || mode === 'zero-response';
const rows = [
  { type: 'llm_request', turn: 1, assessment_request_id: '001' },
  ...(!zeroResponse
    ? [{ type: 'llm_response', turn: 1, assessment_request_id: '001' }]
    : []),
  ...(mode === 'pending-logical-request'
    ? [{ type: 'llm_request', turn: 2, assessment_request_id: '002' }]
    : []),
  ...(mode === 'missing-run-end'
    ? []
    : [{ type: 'run_end', usage: { turns: zeroResponse ? 0 : 1 } }]),
];
writeFileSync(
  join(out, 'run.jsonl'),
  mode === 'empty-assessment-history'
    ? ''
    : `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
);
const usageRow = {
  type: 'obol.usage',
  v: '2026-06-08',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  ...identity,
  usage: {
    input_tokens: 12,
    output_tokens: 5,
    cache_creation_input_tokens: 3,
    cache_read_input_tokens: 7,
  },
};
const attemptRows = [
  {
    schema_version: 1,
    event: 'admission',
    ...identity,
    timestamp_ms: 100,
    outcome: 'admitted',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
  },
  {
    schema_version: 1,
    event: 'settlement',
    ...identity,
    timestamp_ms: 110,
    outcome: 'response',
    usage: 'recorded',
    accounting_failure: false,
    capture: 'disabled',
  },
];
if (mode !== 'zero-response' && mode !== 'empty-assessment-history') {
  writeFileSync(
    join(out, 'assessment-attempts.jsonl'),
    `${attemptRows.map((row) => JSON.stringify(row)).join('\n')}\n`,
  );
  let usageText = `${JSON.stringify(usageRow)}\n`;
  if (mode === 'duplicate-usage') usageText += usageText;
  if (mode === 'truncated-usage') usageText += '{"type":';
  if (mode === 'malformed-usage')
    usageText += `${JSON.stringify({
      ...usageRow,
      assessment_attempt_id: '002',
      usage: { input_tokens: -1, output_tokens: 500 },
    })}\n`;
  if (mode.startsWith('unknown-usage')) {
    writeFileSync(
      join(out, 'assessment-attempts.jsonl'),
      `${[
        attemptRows[0],
        {
          ...attemptRows[1],
          usage: 'not_returned',
          usage_unavailable: 'api_error',
        },
        ...attemptRows.map((row) => ({ ...row, assessment_attempt_id: '002' })),
      ]
        .map((row) => JSON.stringify(row))
        .join('\n')}\n`,
    );
    usageText = `${JSON.stringify({ ...usageRow, assessment_attempt_id: '002' })}\n`;
  }
  writeFileSync(
    join(out, 'usage.jsonl'),
    mode === 'missing-known-usage' ? '' : usageText,
  );
}
if (mode !== 'missing-marker') {
  const operational = mode === 'conversion-error';
  writeFileSync(
    join(out, 'assessment-completion.json'),
    JSON.stringify({
      schema_version: 1,
      run_id: basename(out),
      status: operational ? 'errored' : 'completed',
      reason: 'Fixture decision',
      terminal_at: new Date().toISOString(),
      accepted_report_sha256: operational
        ? null
        : createHash('sha256').update(JSON.stringify(result)).digest('hex'),
    }),
  );
}
process.exit(
  mode === 'operational-exit' || mode === 'conversion-error'
    ? 2
    : mode === 'assessment-error'
      ? 7
      : mode === 'exit-mismatch'
        ? 1
        : assessmentStatus === 'pass'
          ? 0
          : 1,
);
