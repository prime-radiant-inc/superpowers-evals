import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { flattenToolCalls } from '../src/atif/project.ts';
import { validateTrajectory } from '../src/atif/validate.ts';
import { normalizeSerf } from '../src/normalize/serf.ts';

const REAL_FIXTURE = join(
  import.meta.dir,
  'fixtures',
  'serf-real-trajectory.json',
);

// A real serf `--export-atif` trajectory (claude-sonnet-4-6 on "Let's make a
// react todo list") is the ground truth: it must round-trip through quorum's
// validator and surface the brainstorming skill activation.
test('normalizeSerf accepts a real serf ATIF export and validates as v1.7', () => {
  const raw = readFileSync(REAL_FIXTURE, 'utf8');
  const traj = normalizeSerf(raw, 'unknown');

  expect(traj.schema_version).toBe('ATIF-v1.7');
  expect(traj.agent.name).toBe('serf');
  expect(validateTrajectory(traj).ok).toBe(true);
});

test('normalizeSerf canonicalizes use_skill -> Skill with a qualified skill arg', () => {
  const raw = readFileSync(REAL_FIXTURE, 'utf8');
  const calls = flattenToolCalls(normalizeSerf(raw, 'unknown'));

  const skillCalls = calls.filter((c) => c.tool === 'Skill');
  expect(skillCalls.length).toBeGreaterThan(0);
  expect(skillCalls.map((c) => c.args['skill'])).toContain(
    'superpowers:brainstorming',
  );
  // No raw native name leaks past the normalizer.
  expect(calls.some((c) => c.tool === 'use_skill')).toBe(false);
});

// Synthetic trajectory exercising the tool mappings the brainstorming run did
// not (delegate, bash, read_file). serf already emits canonical arg keys
// (file_path, command), so only names + the Agent prompt key are rewritten.
const syntheticSerf = {
  schema_version: 'ATIF-v1.7',
  session_id: 'sess-synthetic',
  agent: { name: 'serf', version: 'v0.9.0', model_name: 'claude-sonnet-4-6' },
  steps: [
    {
      step_id: 1,
      source: 'user',
      message: 'do work',
      extra: {},
    },
    {
      step_id: 2,
      source: 'agent',
      message: 'working',
      tool_calls: [
        {
          tool_call_id: 'c1',
          function_name: 'delegate',
          arguments: { task: 'review the code', agent_type: 'subagent' },
        },
        {
          tool_call_id: 'c2',
          function_name: 'bash',
          arguments: { command: 'ls' },
        },
        {
          tool_call_id: 'c3',
          function_name: 'read_file',
          arguments: { file_path: '/tmp/x.txt' },
        },
      ],
      extra: {},
    },
  ],
  extra: {},
};

test('normalizeSerf maps delegate -> Agent (task -> prompt), bash -> Bash, read_file -> Read', () => {
  const traj = normalizeSerf(JSON.stringify(syntheticSerf), 'unknown');
  expect(validateTrajectory(traj).ok).toBe(true);

  const calls = flattenToolCalls(traj);
  const agent = calls.find((c) => c.tool === 'Agent');
  expect(agent).toBeDefined();
  expect(agent?.args['prompt']).toBe('review the code');
  // task is renamed, not duplicated.
  expect(agent?.args['task']).toBeUndefined();

  expect(calls.find((c) => c.tool === 'Bash')?.args['command']).toBe('ls');
  expect(calls.find((c) => c.tool === 'Read')?.args['file_path']).toBe(
    '/tmp/x.txt',
  );
});

test('normalizeSerf lifts serf cache-creation tokens to the obol-priced extra.cache_write key', () => {
  // serf records cache-creation under metrics.extra.cache_write_tokens; obol
  // prices it only from step.extra.cache_write (the key claude's normalizer
  // uses). Without the lift, serf cost is undercounted.
  const raw = readFileSync(REAL_FIXTURE, 'utf8');
  const traj = normalizeSerf(raw, 'unknown');

  let liftedTotal = 0;
  let liftedSteps = 0;
  for (const step of traj.steps) {
    const cw = step.extra?.['cache_write'];
    if (typeof cw === 'number' && cw > 0) {
      liftedTotal += cw;
      liftedSteps += 1;
    }
  }
  // The real fixture carries 7 steps summing to 22201 cache-write tokens.
  expect(liftedSteps).toBe(7);
  expect(liftedTotal).toBe(22201);
});

test('normalizeSerf synthetic step lifts cache_write_tokens onto step.extra.cache_write', () => {
  const traj = normalizeSerf(
    JSON.stringify({
      schema_version: 'ATIF-v1.7',
      agent: { name: 'serf', version: 'v0.9.0' },
      steps: [
        {
          step_id: 1,
          source: 'agent',
          message: 'x',
          metrics: {
            prompt_tokens: 10,
            completion_tokens: 5,
            cached_tokens: 100,
            extra: { cache_write_tokens: 42 },
          },
          extra: { serf_kind: 'keep-me' },
        },
      ],
    }),
    'unknown',
  );
  expect(traj.steps[0]?.extra?.['cache_write']).toBe(42);
  // existing step.extra is preserved.
  expect(traj.steps[0]?.extra?.['serf_kind']).toBe('keep-me');
});

test('normalizeSerf fails closed on non-JSON and non-conformant input', () => {
  expect(() => normalizeSerf('not json{', 'unknown')).toThrow();
  expect(() => normalizeSerf('[]', 'unknown')).toThrow();
  expect(() => normalizeSerf('{"agent":{}}', 'unknown')).toThrow();
});
