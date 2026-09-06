// Synthetic source contract fixture. This process never launches a Coding-Agent or provider.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  captureInput,
  observerBindingPath,
  runObserverCommand,
} from '../../../src/experiments/brainstorming-input-capture.ts';
import { validateObserverBinding } from '../../../src/experiments/observer/binding.ts';
import { createRawPrefix } from '../../../src/experiments/observer/raw.ts';

export function runObserverFixture(mode: string) {
  const argv = process.argv;
  if (argv.includes('--version')) {
    process.stdout.write('fixture-gauntlet 1\n');
    return;
  }
  const runDir = argv[argv.indexOf('--project-dir') + 1]!;
  const workdir = join(runDir, 'coding-agent-workdir');
  for (const path of [
    '.git/branches',
    '.git/refs/empty/nested',
    'node_modules/empty/nested',
  ])
    mkdirSync(join(workdir, path), { recursive: true });
  const binding = validateObserverBinding(
    JSON.parse(readFileSync(observerBindingPath(workdir), 'utf8')),
  );
  if (mode !== 'no-parent') {
    const rawPath = join(binding.roots[0]!.path, 'parent.jsonl');
    const message = (role: string, text: string) => ({
      type: 'response_item',
      payload: {
        type: 'message',
        role,
        content: [
          { type: role === 'user' ? 'input_text' : 'output_text', text },
        ],
      },
    });
    const call = (id: string) => ({
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: id,
        arguments: '{"cmd":"write-file"}',
      },
    });
    const result = (id: string) => ({
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: id,
        output: 'Process exited with code 0',
      },
    });
    const rows: unknown[] = [
      {
        type: 'session_meta',
        payload: {
          id: 'session',
          cwd: binding.launch_cwd,
          cli_version: '0.144.3',
          source: 'cli',
          originator: 'codex-tui',
          thread_source: 'user',
        },
      },
      message('user', 'Build a todo list.'),
      message('assistant', 'What is it for?'),
      message('user', 'Learn React state and events.'),
      message('assistant', 'One readable component for learning.'),
      message('user', 'I approve that design.'),
      call('spec'),
      result('spec'),
      message('assistant', 'Review spec.md.'),
    ];
    const save = () =>
      writeFileSync(
        rawPath,
        `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
      );
    writeFileSync(join(workdir, 'spec.md'), '# Spec\nLearn state and events.');
    save();
    const spec = captureInput(workdir).receipts.find(
      (r) => r.artifact_path === 'spec.md',
    )!;
    rows.push(
      message('user', 'I approve the spec.'),
      call('plan'),
      result('plan'),
      message('assistant', 'Review plan.md.'),
    );
    writeFileSync(join(workdir, 'plan.md'), '# Plan\nBuild one component.');
    save();
    const plan = captureInput(workdir).receipts.find(
      (r) => r.artifact_path === 'plan.md',
    )!;
    rows.push(
      message('user', 'I approve the plan; execute inline.'),
      call('implementation'),
      result('implementation'),
    );
    save();
    const selected = validateObserverBinding(
      JSON.parse(readFileSync(observerBindingPath(workdir), 'utf8')),
    );
    const source = selected.sources[0]!.source;
    const at = (line: number, block: number | null = null) => ({
      source_id: source.source_id,
      line,
      block,
    });
    const review = {
      schema_version: 2,
      reviewer: 'local contract fixture',
      stop_reason: 'endpoint',
      supporting_prefixes: [],
      source_prefixes: [createRawPrefix(source, readFileSync(rawPath))],
      events: [
        {
          kind: 'understanding',
          anchor: at(5, 0),
          aligned: true,
          note: 'Learning purpose governs scope.',
        },
        ...(mode === 'fail'
          ? []
          : [
              {
                kind: 'design_approval',
                anchor: at(6, 0),
                presented_anchor: at(5, 0),
                note: 'Approved design.',
              },
            ]),
        {
          kind: 'artifact_approval',
          stage: 'spec',
          anchor: at(10, 0),
          presented_anchor: at(9, 0),
          receipt: spec.observation_id,
          aligned: true,
          note: 'Approved spec.',
        },
        {
          kind: 'artifact_approval',
          stage: 'plan',
          anchor: at(14, 0),
          presented_anchor: at(13, 0),
          receipt: plan.observation_id,
          aligned: true,
          note: 'Approved plan.',
        },
        {
          kind: 'execution_choice',
          anchor: at(14, 0),
          method: 'inline',
          note: 'Explicit choice.',
        },
      ],
      actions: [
        {
          anchor: at(7),
          call_id: 'native:spec',
          effects: ['spec_write'],
          result_anchors: [at(8)],
          success: true,
          changed_artifacts: ['spec'],
          delegation: null,
          note: 'Spec saved.',
        },
        {
          anchor: at(11),
          call_id: 'native:plan',
          effects: ['plan_write'],
          result_anchors: [at(12)],
          success: true,
          changed_artifacts: ['plan'],
          delegation: null,
          note: 'Plan saved.',
        },
        {
          anchor: at(15),
          call_id: 'native:implementation',
          effects: ['implementation'],
          result_anchors: [at(16)],
          success: true,
          changed_artifacts: [],
          delegation: null,
          note: 'Component saved.',
        },
      ],
    };
    if (mode !== 'missing-review')
      runObserverCommand(
        'observer-write-review',
        Buffer.from(workdir).toString('base64'),
        Buffer.from(JSON.stringify(review)).toString('base64'),
      );
    if (mode === 'interrupted')
      mkdirSync(join(runDir, 'brainstorming-evidence', '.bundle-stage'));
    if (mode === 'error') mkdirSync(join(runDir, 'trajectory.json'));
  }
  const results = join(runDir, 'gauntlet-agent', 'results', 'fixture');
  mkdirSync(results, { recursive: true });
  writeFileSync(
    join(results, 'result.json'),
    JSON.stringify({
      schemaVersion: 5,
      runId: 'fixture',
      status: 'pass',
      summary: 'fixture',
      reasoning: 'contract fixture',
      duration_ms: 1,
      config: { model: 'fixture' },
    }),
  );
  writeFileSync(join(runDir, 'subject-finished'), 'done');
}
