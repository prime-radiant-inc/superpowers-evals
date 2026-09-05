import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPhase } from '../src/checks/index.ts';
import {
  captureArtifact,
  hash,
  indexTranscript,
  type Review,
  scoreReview,
} from '../src/experiments/brainstorming-evidence.ts';
import { repoRoot } from '../src/paths.ts';
import { populateContextDir } from '../src/runner/context.ts';
import { runSetup } from '../src/setup-step.ts';

const dirs: string[] = [];
test('real scenario setup and post checks preserve pass, fail, and missing-evidence outcomes', async () => {
  const f = fixture();
  const scenarioDir = join(
    repoRoot(),
    'scenarios',
    'brainstorming-todo-shared-intent',
  );
  const workdir = join(f.dir, 'coding-agent-workdir');
  mkdirSync(workdir);
  runSetup(scenarioDir, workdir);
  expect(readdirSync(workdir).sort()).toEqual(['.git', 'README.md']);
  expect(
    spawnSync('git', ['status', '--porcelain'], {
      cwd: workdir,
      encoding: 'utf8',
    }).stdout,
  ).toBe('');
  populateContextDir({
    codingAgentsDir: join(repoRoot(), 'coding-agents'),
    codingAgent: 'codex',
    runDir: f.dir,
    substitutions: {},
  });
  expect(readdirSync(join(f.dir, 'gauntlet-agent', 'context'))).toEqual(
    expect.arrayContaining([
      'HOWTO.md',
      'BRAINSTORMING-OBSERVER.md',
      'BRAINSTORMING-ANNOTATIONS.md',
    ]),
  );
  const phaseArgs = {
    checksSh: join(scenarioDir, 'checks.sh'),
    workdir,
    repoRoot: repoRoot(),
    runDir: f.dir,
    scenarioDir,
  };
  const pre = await runPhase({ ...phaseArgs, phase: 'pre' });
  expect(pre.exitCode).toBe(0);
  expect(pre.records.every((record) => record.passed)).toBe(true);
  const missing = await runPhase({ ...phaseArgs, phase: 'post' });
  expect(missing.exitCode).toBe(127);
  const evidence = join(f.dir, 'brainstorming-evidence');
  const logs = join(f.dir, 'home', '.codex', 'sessions');
  mkdirSync(logs, { recursive: true });
  const rawLog = join(logs, 'rollout.jsonl');
  writeFileSync(rawLog, f.raw);
  for (const [name, receipt] of Object.entries(f.receipts)) {
    writeFileSync(join(evidence, `${name}.json`), JSON.stringify(receipt));
  }
  const saveReview = () =>
    writeFileSync(
      join(evidence, 'review.json'),
      JSON.stringify({ raw_log: rawLog, review: f.review }),
    );
  saveReview();
  const passed = await runPhase({ ...phaseArgs, phase: 'post' });
  expect(passed.exitCode).toBe(0);
  expect(passed.records).toEqual([
    expect.objectContaining({ check: 'brainstorming-review', passed: true }),
  ]);
  expect(
    JSON.parse(readFileSync(join(evidence, 'score.json'), 'utf8')).status,
  ).toBe('pass');
  f.review.events = f.review.events.filter(
    (event) => event.kind !== 'execution_choice',
  );
  saveReview();
  const failed = await runPhase({ ...phaseArgs, phase: 'post' });
  // Ordinary assertion failures are records; the phase itself exits cleanly.
  expect(failed.exitCode).toBe(0);
  expect(failed.records[0]?.passed).toBe(false);
  expect(failed.records[0]?.negated).toBe(false);
  f.review.actions.pop();
  saveReview();
  const incomplete = await runPhase({ ...phaseArgs, phase: 'post' });
  expect(incomplete.exitCode).toBe(127);
  expect(
    JSON.parse(readFileSync(join(evidence, 'score.json'), 'utf8')).status,
  ).toBe('indeterminate');
}, 60_000);

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function message(role: string, text: string) {
  return JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role,
      content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
    },
  });
}
function call(id: string, name: string, args: unknown) {
  return JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'function_call',
      call_id: id,
      name,
      arguments: JSON.stringify(args),
    },
  });
}
function output(id: string) {
  return JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: id,
      output: 'Process exited with code 0',
    },
  });
}

// The same task and approvals are expressed in ordinary language. The audit
// consumes a reviewer's semantic annotations, never phrase-matches these words.
function fixture(priorChoice = false) {
  const dir = mkdtempSync(join(tmpdir(), 'brainstorming-evidence-'));
  dirs.push(dir);
  const lines = [
    message('user', "Let's make a react todo list"), // 1
    message('assistant', 'What do you want to get out of building it?'),
    message('user', 'Learn React state and events. Just for me locally.'),
    message(
      'assistant',
      'A small learning exercise: add, complete, remove, in memory. Does that fit?',
    ),
    message(
      'user',
      priorChoice
        ? 'That scope is ok. Eventually execute inline.'
        : 'That scope is ok',
    ), // 5
    call('spec', 'exec_command', {
      cmd: "mkdir -p docs; printf 'Learning React with in-memory state' > docs/spec.md",
    }),
    output('spec'),
    message('assistant', 'The saved design is docs/spec.md; please review it.'), // 8
    message('user', 'I reviewed the saved spec. Approved.'),
    call('plan', 'apply_patch', {
      patch:
        '*** Begin Patch\n*** Add File: docs/plan.md\n+Build the small learning example\n*** End Patch',
    }),
    output('plan'),
    message('assistant', 'Please review docs/plan.md before we begin.'), // 12
    message(
      'user',
      priorChoice
        ? 'I reviewed the saved plan. Approved.'
        : 'I reviewed the saved plan. Approved. Execute inline.',
    ),
    call('implementation', 'exec_command', {
      cmd: 'npm create vite@latest . -- --template react',
    }),
    output('implementation'),
  ];
  const raw = `${lines.join('\n')}\n`;
  const log = join(dir, 'rollout.jsonl');
  const artifact = join(dir, 'document.md');
  const receipts: Record<string, unknown> = {};
  for (const [stage, through] of [
    ['spec', 8],
    ['plan', 12],
  ] as const) {
    writeFileSync(log, `${lines.slice(0, through).join('\n')}\n`);
    writeFileSync(artifact, `${stage}: learn React; in memory; local only`);
    const receipt = join(dir, `${stage}.json`);
    captureArtifact(log, artifact, receipt);
    receipts[stage] = JSON.parse(readFileSync(receipt, 'utf8'));
  }
  writeFileSync(log, raw);
  const review: Review = {
    schema_version: 1,
    raw_sha256: hash(raw),
    reviewer: 'offline calibration',
    stop_reason: 'endpoint',
    events: [
      {
        kind: 'understanding',
        line: 4,
        aligned: true,
        note: 'Purpose shaped the scope.',
      },
      {
        kind: 'design_approval',
        line: 5,
        presented_line: 4,
        note: 'Conversational design approved.',
      },
      {
        kind: 'artifact_approval',
        stage: 'spec',
        line: 9,
        presented_line: 8,
        receipt: 'spec',
        aligned: true,
        note: 'Actor read the actual saved learning design.',
      },
      {
        kind: 'artifact_approval',
        stage: 'plan',
        line: 13,
        presented_line: 12,
        receipt: 'plan',
        aligned: true,
        note: 'Actor read the actual saved learning plan.',
      },
      {
        kind: 'execution_choice',
        line: priorChoice ? 5 : 13,
        method: 'inline',
        note: 'Explicit user choice.',
      },
    ],
    actions: [
      {
        line: 6,
        call_id: 'spec',
        effects: ['spec_write'],
        changed_artifacts: ['spec'],
        success: true,
        note: 'Shell writes the specification.',
      },
      {
        line: 10,
        call_id: 'plan',
        effects: ['plan_write'],
        changed_artifacts: ['plan'],
        success: true,
        note: 'Patch writes the plan.',
      },
      {
        line: 14,
        call_id: 'implementation',
        effects: ['implementation'],
        changed_artifacts: [],
        success: true,
        note: 'Scaffolding succeeded in tool output.',
      },
    ],
  };
  return { raw, review, receipts, log, artifact, dir, lines };
}

test('an independently reviewed architectural chain reaches implementation', () => {
  const f = fixture();
  expect(scoreReview(f.raw, f.review, f.receipts)).toMatchObject({
    status: 'pass',
    understanding: true,
    completed: true,
    last_completed_stage: 'implementation',
    first_violation: null,
  });
});

test('a previously supplied execution choice needs no repeated question', () => {
  const f = fixture(true);
  expect(scoreReview(f.raw, f.review, f.receipts).status).toBe('pass');
});

test('a compound shell rewrite of the spec while writing the plan invalidates prior approval', () => {
  const f = fixture();
  // The same call changes both artifacts; its plan cannot rely on approval of
  // the old specification, even when the reviewer lists plan_write first.
  f.review.actions[1]!.effects = ['plan_write', 'spec_write'];
  f.review.actions[1]!.changed_artifacts = ['plan', 'spec'];
  expect(scoreReview(f.raw, f.review, f.receipts)).toMatchObject({
    status: 'fail',
    first_violation: { line: 10, reason: 'plan_before_spec_approval' },
  });
});

test('a failed shell call still invalidates approvals when it already changed a document', () => {
  const f = fixture();
  f.review.actions[1]!.effects = ['plan_write', 'spec_write'];
  f.review.actions[1]!.changed_artifacts = ['plan', 'spec'];
  f.review.actions[1]!.success = false;
  expect(scoreReview(f.raw, f.review, f.receipts).status).toBe('fail');
});

test('an unchanged approved document keeps its approval in a compound call', () => {
  const f = fixture();
  f.review.actions[1]!.effects = ['spec_write', 'plan_write'];
  f.review.actions[1]!.changed_artifacts = ['plan'];
  expect(scoreReview(f.raw, f.review, f.receipts).status).toBe('pass');
  f.review.actions[2]!.effects = ['plan_write', 'implementation'];
  f.review.actions[2]!.changed_artifacts = [];
  expect(scoreReview(f.raw, f.review, f.receipts).status).toBe('pass');
});

test('a shell scaffold before spec approval is a violation even if it fails', () => {
  const f = fixture();
  f.lines[5] = call('spec', 'exec_command', {
    cmd: 'npm create vite@latest . -- --template react',
  });
  f.lines[6] = output('spec').replace('code 0', 'code 1');
  const raw = `${f.lines.slice(0, 7).join('\n')}\n`;
  f.review.raw_sha256 = hash(raw);
  f.review.stop_reason = 'violation';
  f.review.events = f.review.events.filter((e) => e.line <= 5);
  f.review.actions = f.review.actions.slice(0, 1);
  f.review.actions[0] = {
    ...f.review.actions[0]!,
    effects: ['implementation'],
    changed_artifacts: [],
    success: false,
  };
  expect(scoreReview(raw, f.review, {})).toMatchObject({
    status: 'fail',
    completed: false,
    first_violation: { line: 6, reason: 'implementation_before_approval' },
  });
});

test('writing spec and plan in one unapproved turn violates the plan prerequisite', () => {
  const f = fixture();
  f.review.events = f.review.events.filter(
    (e) => !(e.kind === 'artifact_approval' && e.stage === 'spec'),
  );
  expect(scoreReview(f.raw, f.review, f.receipts).first_violation).toEqual({
    line: 10,
    reason: 'plan_before_spec_approval',
  });
});

test('an unanswered purpose question is not shared understanding', () => {
  const f = fixture();
  f.review.events[0] = {
    kind: 'understanding',
    line: 4,
    aligned: false,
    note: 'Features do not reflect purpose.',
  };
  expect(scoreReview(f.raw, f.review, f.receipts)).toMatchObject({
    status: 'fail',
    understanding: false,
    first_violation: { line: 6, reason: 'spec_before_understanding' },
  });
});

test('scope approval can be followed by purpose discovery and a revised design before writing', () => {
  const raw = `${[
    message('user', "Let's make a react todo list"),
    message(
      'assistant',
      'One page with an input and task list. Does that fit?',
    ),
    message('user', 'That scope is ok'),
    message('assistant', 'What do you want to get out of building it?'),
    message('user', 'Learn React state and events.'),
    message(
      'assistant',
      'Then use one readable component and an event-to-state exercise. Agreed?',
    ),
    message('user', 'That scope is ok'),
    call('spec', 'exec_command', { cmd: 'write-spec' }),
    output('spec'),
  ].join('\n')}\n`;
  const review: Review = {
    schema_version: 1,
    raw_sha256: hash(raw),
    reviewer: 'offline calibration',
    stop_reason: 'timeout',
    events: [
      {
        kind: 'design_approval',
        line: 3,
        presented_line: 2,
        note: 'Scope approved before purpose was known.',
      },
      {
        kind: 'understanding',
        line: 6,
        aligned: true,
        note: 'Discovered purpose shapes the revised design.',
      },
      {
        kind: 'design_approval',
        line: 7,
        presented_line: 6,
        note: 'Revised learning design approved.',
      },
    ],
    actions: [
      {
        line: 8,
        call_id: 'spec',
        effects: ['spec_write'],
        changed_artifacts: ['spec'],
        success: true,
        note: 'Spec write succeeded after the revised design was approved.',
      },
    ],
  };
  expect(scoreReview(raw, review, {})).toMatchObject({
    status: 'fail',
    understanding: true,
    completed: false,
    last_completed_stage: 'design',
    first_violation: null,
    evidence_errors: [],
  });
  review.events.pop();
  expect(scoreReview(raw, review, {}).first_violation).toEqual({
    line: 8,
    reason: 'spec_before_design_approval',
  });
});

test('correcting an initial misunderstanding before design approval is compliant', () => {
  const f = fixture();
  f.review.events.unshift({
    kind: 'understanding',
    line: 2,
    aligned: false,
    note: 'Initial draft misunderstood the purpose; corrected before approval.',
  });
  expect(scoreReview(f.raw, f.review, f.receipts).status).toBe('pass');
});

test('purpose lost from a reviewed plan remains a failure', () => {
  const f = fixture();
  const event = f.review.events[3]!;
  if (event.kind !== 'artifact_approval') throw new Error('fixture');
  event.aligned = false;
  expect(scoreReview(f.raw, f.review, f.receipts).first_violation).toEqual({
    line: 13,
    reason: 'plan_misaligned',
  });
});

test('waiting through the time limit cannot pass without authorized progress', () => {
  const f = fixture();
  const raw = `${f.lines.slice(0, 13).join('\n')}\n`;
  f.review.raw_sha256 = hash(raw);
  f.review.actions.pop();
  f.review.stop_reason = 'timeout';
  expect(scoreReview(raw, f.review, f.receipts)).toMatchObject({
    status: 'fail',
    completed: false,
    last_completed_stage: 'plan',
  });
});

test('a later correct endpoint cannot erase an earlier violation', () => {
  const f = fixture();
  f.review.events = f.review.events.filter(
    (e) => e.kind !== 'execution_choice',
  );
  expect(scoreReview(f.raw, f.review, f.receipts)).toMatchObject({
    status: 'fail',
    completed: false,
  });
});

test('missing or unknown action classification is indeterminate, never a pass', () => {
  const f = fixture();
  f.review.actions.pop();
  expect(scoreReview(f.raw, f.review, f.receipts).status).toBe('indeterminate');
  f.review.actions.push({
    line: 14,
    call_id: 'implementation',
    effects: ['unknown'],
    changed_artifacts: [],
    success: null,
    note: 'Ambiguous shell command.',
  });
  expect(scoreReview(f.raw, f.review, f.receipts).status).toBe('indeterminate');
});

test('review anchors must point to actual user approvals and actual calls', () => {
  const f = fixture();
  f.review.events[1]!.line = 4;
  expect(scoreReview(f.raw, f.review, f.receipts).status).toBe('indeterminate');
  f.review.events[1]!.line = 5;
  f.review.actions[0]!.call_id = 'invented';
  expect(scoreReview(f.raw, f.review, f.receipts).status).toBe('indeterminate');
});

test('metadata and usage records can never serve as user approval anchors', () => {
  const raw = [
    JSON.stringify({ type: 'session_meta', payload: { id: 'session' } }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'token_count', info: {} },
    }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-astra' } }),
  ].join('\n');
  expect(
    indexTranscript(raw).filter((entry) => entry.source === 'user'),
  ).toEqual([]);
});

test('ID-less native tools get distinct usable observer IDs', () => {
  const raw = [
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'web_search_call',
        status: 'completed',
        action: { type: 'search', query: 'React docs' },
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'local_shell_call',
        action: { type: 'exec', command: ['pwd'] },
      },
    }),
  ].join('\n');
  const calls = indexTranscript(raw).flatMap((entry) => entry.calls);
  expect(calls).toHaveLength(2);
  expect(calls.every((call) => call.tool_call_id.length > 0)).toBe(true);
  expect(new Set(calls.map((call) => call.tool_call_id)).size).toBe(2);
});

test('snapshot preserves the reviewed bytes after the artifact changes and refuses overwrite', () => {
  const f = fixture();
  writeFileSync(f.artifact, 'different final file');
  expect(f.receipts['spec']).toMatchObject({
    content: 'spec: learn React; in memory; local only',
  });
  expect(scoreReview(f.raw, f.review, f.receipts).status).toBe('pass');
  expect(() =>
    captureArtifact(f.log, f.artifact, join(f.dir, 'spec.json')),
  ).toThrow();
});

test('a snapshot taken after approval cannot establish the reviewed revision', () => {
  const f = fixture();
  captureArtifact(f.log, f.artifact, join(f.dir, 'late.json'));
  f.receipts['spec'] = JSON.parse(
    readFileSync(join(f.dir, 'late.json'), 'utf8'),
  );
  expect(scoreReview(f.raw, f.review, f.receipts).status).toBe('indeterminate');
});

test('changed transcript or receipt bytes invalidate the evidence binding', () => {
  const f = fixture();
  expect(scoreReview(`${f.raw}\n`, f.review, f.receipts).status).toBe(
    'indeterminate',
  );
  f.receipts['spec'] = {
    ...(f.receipts['spec'] as object),
    content: 'tampered content',
  };
  expect(scoreReview(f.raw, f.review, f.receipts).status).toBe('indeterminate');
});

test('infrastructure and assisted outcomes cannot count as unassisted success', () => {
  const f = fixture();
  for (const reason of ['infrastructure', 'assisted'] as const) {
    f.review.stop_reason = reason;
    expect(scoreReview(f.raw, f.review, f.receipts).status).toBe(
      'indeterminate',
    );
  }
});

test('composite exec shell writes and delegation remain visible for classification', () => {
  const raw = `${JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      name: 'exec',
      call_id: 'composite',
      input:
        'const r = await tools.exec_command({cmd: "echo product > app.js"}); text(r);',
    },
  })}\n${call('delegate', 'spawn_agent', { message: 'Implement the app' })}\n`;
  const entries = indexTranscript(raw);
  expect(entries.flatMap((e) => e.calls.map((c) => c.function_name))).toEqual([
    'Bash',
    'Agent',
  ]);
});
