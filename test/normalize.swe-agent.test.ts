import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ATIF_SCHEMA_VERSION } from '../src/atif/types.ts';
import { validateTrajectory } from '../src/atif/validate.ts';
import { normalizeSweAgent } from '../src/normalize/swe-agent.ts';

// ---------------------------------------------------------------------------
// Inline fixture — representative swe-agent .traj JSON
// Layout: top-level { environment, trajectory: [...steps], info: {...} }
// Each step has: response (full LLM output), thought (parsed reasoning),
// action (command executed), observation (result), state, optional query.
// Info block: model_name, swe_agent_version, input_tokens, output_tokens,
//             total_cost (or cost), and optionally model.
// ---------------------------------------------------------------------------

const basicTraj = JSON.stringify({
  environment: 'swe_main',
  trajectory: [
    {
      response: 'I will look at the repository structure first.',
      thought: 'Need to understand the codebase layout.',
      action: 'find /testbed -maxdepth 2 -name "*.py" | head -20',
      observation: '/testbed/setup.py\n/testbed/src/app.py',
      state: 'open file: None',
      query: [
        { role: 'system', content: 'You are SWE-agent.' },
        { role: 'user', content: 'Fix the bug.' },
      ],
    },
    {
      response: 'Now I will fix the missing function.',
      thought: 'The add function is missing from app.py.',
      action: "echo 'def add(a, b): return a + b' >> /testbed/src/app.py",
      observation: '',
      state: 'open file: /testbed/src/app.py',
    },
  ],
  info: {
    model_name: 'claude-3-5-sonnet-20241022',
    swe_agent_version: '0.9.1',
    input_tokens: 4200,
    output_tokens: 310,
    total_cost: 0.015,
  },
});

// Traj with NO usage data — ensures we emit no metrics when usage is absent.
const noUsageTraj = JSON.stringify({
  environment: 'swe_main',
  trajectory: [
    {
      response: 'Some response.',
      thought: 'Some thought.',
      action: 'ls /testbed',
      observation: 'file1 file2',
      state: 'open file: None',
    },
  ],
  info: {
    model_name: 'gpt-4o',
    swe_agent_version: '1.0.0',
  },
});

// Traj with ZERO token counts — ensures we treat 0 as absent (no metrics).
const zeroUsageTraj = JSON.stringify({
  environment: 'swe_main',
  trajectory: [
    {
      response: 'Response.',
      thought: 'Thought.',
      action: 'pwd',
      observation: '/testbed',
      state: 'open file: None',
    },
  ],
  info: {
    model_name: 'gpt-4o',
    swe_agent_version: '1.0.0',
    input_tokens: 0,
    output_tokens: 0,
    total_cost: 0,
  },
});

// Traj with 'cost' key (alternate cost field) and 'model' key (alternate model field).
const altKeysTraj = JSON.stringify({
  environment: 'swe_other',
  trajectory: [
    {
      response: 'OK.',
      thought: 'Just checking.',
      action: 'echo hello',
      observation: 'hello',
      state: 'open file: None',
    },
  ],
  info: {
    model: 'gpt-4-turbo',
    swe_agent_version: '0.8.0',
    input_tokens: 1000,
    output_tokens: 50,
    cost: 0.005,
  },
});

// Traj where first step has a system query — the system step should be emitted.
const withSystemTraj = JSON.stringify({
  environment: 'swe_main',
  trajectory: [
    {
      response: 'Starting.',
      thought: 'Initial analysis.',
      action: 'ls',
      observation: 'file1',
      state: 'open file: None',
      query: [
        { role: 'system', content: 'You are SWE-agent, a coding agent.' },
      ],
    },
    {
      response: 'Done.',
      thought: 'All good.',
      action: 'exit',
      observation: '',
      state: 'done',
    },
  ],
  info: {
    model_name: 'claude-sonnet-4',
    swe_agent_version: '1.2.0',
    input_tokens: 2000,
    output_tokens: 100,
    total_cost: 0.0,
  },
});

// Empty trajectory — normalizer must not crash; must produce at least one step.
const emptyTraj = JSON.stringify({
  environment: 'swe_main',
  trajectory: [],
  info: {},
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('produces a valid ATIF v1.7 trajectory', () => {
  const traj = normalizeSweAgent(basicTraj, '0.9.1');
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
  expect(traj.schema_version).toBe(ATIF_SCHEMA_VERSION);
  expect(traj.agent.name).toBe('swe-agent');
  expect(traj.agent.version).toBe('0.9.1');
});

test('agent.version comes from the version argument, not the log', () => {
  const traj = normalizeSweAgent(basicTraj, 'injected-version');
  expect(traj.agent.version).toBe('injected-version');
});

test('agent.model_name is populated from info.model_name', () => {
  const traj = normalizeSweAgent(basicTraj, '0.9.1');
  expect(traj.agent.model_name).toBe('claude-3-5-sonnet-20241022');
});

test('agent.model_name falls back to info.model when info.model_name absent', () => {
  const traj = normalizeSweAgent(altKeysTraj, '0.8.0');
  expect(traj.agent.model_name).toBe('gpt-4-turbo');
});

test('agent.extra carries original_format and environment', () => {
  const traj = normalizeSweAgent(basicTraj, '0.9.1');
  expect(traj.agent.extra).toBeDefined();
  expect(traj.agent.extra!['original_format']).toBe('swe-agent-traj');
  expect(traj.agent.extra!['environment']).toBe('swe_main');
});

// ---------------------------------------------------------------------------
// Tool name canonicalization
// SWE-agent actions are shell commands executed in a bash environment.
// The synthetic swe_agent_action → Bash via SWE_AGENT_TOOL_MAP.
// ---------------------------------------------------------------------------

test('swe_agent_action steps are canonicalized to Bash tool calls', () => {
  const traj = normalizeSweAgent(basicTraj, '0.9.1');
  const agentSteps = traj.steps.filter(
    (s) => s.source === 'agent' && s.tool_calls,
  );
  expect(agentSteps.length).toBeGreaterThan(0);
  for (const step of agentSteps) {
    expect(step.tool_calls![0]!.function_name).toBe('Bash');
  }
});

test('tool_call arguments include raw_action from the action field', () => {
  const traj = normalizeSweAgent(basicTraj, '0.9.1');
  const agentSteps = traj.steps.filter(
    (s) => s.source === 'agent' && s.tool_calls,
  );
  expect(agentSteps[0]!.tool_calls![0]!.arguments['raw_action']).toBe(
    'find /testbed -maxdepth 2 -name "*.py" | head -20',
  );
  expect(agentSteps[1]!.tool_calls![0]!.arguments['raw_action']).toBe(
    "echo 'def add(a, b): return a + b' >> /testbed/src/app.py",
  );
});

// ---------------------------------------------------------------------------
// Content fidelity
// ---------------------------------------------------------------------------

test('step.message is populated from the response field', () => {
  const traj = normalizeSweAgent(basicTraj, '0.9.1');
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  expect(agentSteps[0]!.message).toBe(
    'I will look at the repository structure first.',
  );
  expect(agentSteps[1]!.message).toBe('Now I will fix the missing function.');
});

test('step.reasoning_content is populated from the thought field', () => {
  const traj = normalizeSweAgent(basicTraj, '0.9.1');
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  expect(agentSteps[0]!.reasoning_content).toBe(
    'Need to understand the codebase layout.',
  );
  expect(agentSteps[1]!.reasoning_content).toBe(
    'The add function is missing from app.py.',
  );
});

test('step.observation is populated from the observation field with source_call_id', () => {
  const traj = normalizeSweAgent(basicTraj, '0.9.1');
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  const step0 = agentSteps[0]!;
  expect(step0.observation).toBeDefined();
  expect(step0.observation!.results).toHaveLength(1);
  const result = step0.observation!.results[0]!;
  expect(result.content).toBe('/testbed/setup.py\n/testbed/src/app.py');
  // source_call_id must match the tool_call_id on the same step
  expect(result.source_call_id).toBe(step0.tool_calls![0]!.tool_call_id);
});

test('empty observation string produces no observation on the step', () => {
  const traj = normalizeSweAgent(basicTraj, '0.9.1');
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  // Step 1 has observation: "" → no observation emitted
  expect(agentSteps[1]!.observation).toBeUndefined();
});

test('no session_id is set (format lacks it)', () => {
  const traj = normalizeSweAgent(basicTraj, '0.9.1');
  expect(traj.session_id).toBeUndefined();
});

// ---------------------------------------------------------------------------
// System step from first query
// ---------------------------------------------------------------------------

test('system message from first query[].role=="system" becomes a system step', () => {
  const traj = normalizeSweAgent(withSystemTraj, '1.2.0');
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  const systemStep = traj.steps.find((s) => s.source === 'system');
  expect(systemStep).toBeDefined();
  expect(systemStep!.message).toBe('You are SWE-agent, a coding agent.');
  // system step must come first (step_id === 1)
  expect(systemStep!.step_id).toBe(1);
});

test('no system step when query is absent or has no system role', () => {
  // basicTraj has a query but only "system" in first step; noUsageTraj has no query
  const traj = normalizeSweAgent(noUsageTraj, '1.0.0');
  const systemSteps = traj.steps.filter((s) => s.source === 'system');
  expect(systemSteps).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Token usage: final_metrics ONLY (single source)
// SWE-agent logs only carry session-cumulative totals in info block.
// No per-step usage → final_metrics only. Never both.
// ---------------------------------------------------------------------------

test('usage goes to final_metrics only (no per-step metrics)', () => {
  const traj = normalizeSweAgent(basicTraj, '0.9.1');
  expect(traj.final_metrics).toBeDefined();
  for (const step of traj.steps) {
    expect(step.metrics).toBeUndefined();
  }
});

test('final_metrics carries total_prompt_tokens and total_completion_tokens from info', () => {
  const traj = normalizeSweAgent(basicTraj, '0.9.1');
  expect(traj.final_metrics!.total_prompt_tokens).toBe(4200);
  expect(traj.final_metrics!.total_completion_tokens).toBe(310);
});

test('total_cost from info.total_cost goes to final_metrics.total_cost_usd', () => {
  const traj = normalizeSweAgent(basicTraj, '0.9.1');
  expect(traj.final_metrics!.total_cost_usd).toBeCloseTo(0.015);
});

test('alternate cost key info.cost is used when total_cost is absent', () => {
  const traj = normalizeSweAgent(altKeysTraj, '0.8.0');
  expect(traj.final_metrics!.total_cost_usd).toBeCloseTo(0.005);
});

test('zero token counts produce no final_metrics (treated as absent)', () => {
  const traj = normalizeSweAgent(zeroUsageTraj, '1.0.0');
  // All zeros → treated as absent per Python: `info.get("input_tokens") or 0`
  // final_metrics may be absent or have no token fields
  if (traj.final_metrics) {
    expect(traj.final_metrics.total_prompt_tokens).toBeUndefined();
    expect(traj.final_metrics.total_completion_tokens).toBeUndefined();
    expect(traj.final_metrics.total_cost_usd).toBeUndefined();
  }
});

test('absent usage produces no final_metrics token fields', () => {
  const traj = normalizeSweAgent(noUsageTraj, '1.0.0');
  if (traj.final_metrics) {
    expect(traj.final_metrics.total_prompt_tokens).toBeUndefined();
    expect(traj.final_metrics.total_completion_tokens).toBeUndefined();
  }
});

// ---------------------------------------------------------------------------
// Disjoint-bucket conservation
// SWE-agent has no cache split → prompt + completion == session total.
// final_metrics only; per-step metrics are always absent.
// ---------------------------------------------------------------------------

test('disjoint-bucket conservation: final_metrics prompt + completion == known total', () => {
  const traj = normalizeSweAgent(basicTraj, '0.9.1');
  const fm = traj.final_metrics!;
  const total =
    (fm.total_prompt_tokens ?? 0) + (fm.total_completion_tokens ?? 0);
  // 4200 + 310 = 4510 — the full session token count
  expect(total).toBe(4510);
  // No per-step metrics may contribute to or duplicate the final total
  for (const step of traj.steps) {
    expect(step.metrics).toBeUndefined();
  }
});

// ---------------------------------------------------------------------------
// Step sequential step_id invariant
// ---------------------------------------------------------------------------

test('step_ids are sequential from 1', () => {
  const traj = normalizeSweAgent(basicTraj, '0.9.1');
  traj.steps.forEach((step, i) => {
    expect(step.step_id).toBe(i + 1);
  });
});

test('step_ids are sequential from 1 with system step', () => {
  const traj = normalizeSweAgent(withSystemTraj, '1.2.0');
  traj.steps.forEach((step, i) => {
    expect(step.step_id).toBe(i + 1);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('empty trajectory produces at least one step and validates', () => {
  const traj = normalizeSweAgent(emptyTraj, '0.0.0');
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  expect(traj.steps.length).toBeGreaterThanOrEqual(1);
});

test('invalid JSON input does not throw but produces a fallback trajectory', () => {
  expect(() => normalizeSweAgent('not json at all', '1.0.0')).not.toThrow();
  const traj = normalizeSweAgent('not json', '1.0.0');
  const r = validateTrajectory(traj);
  expect(r.ok).toBe(true);
});

// ---------------------------------------------------------------------------
// No dedup by id (format has no re-emitted rows — sequential .traj JSON array)
// ---------------------------------------------------------------------------

test('multiple trajectory steps each produce their own agent step (no dedup)', () => {
  const traj = normalizeSweAgent(basicTraj, '0.9.1');
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  // Two steps in basicTraj → two agent steps
  expect(agentSteps).toHaveLength(2);
});

// ---------------------------------------------------------------------------
// Committed fixture sanity test
// The .traj fixture at test/fixtures/harbor/swe-agent/run.traj is what Harbor's
// convert_swe_agent_to_atif() runs against (the oracle step). Verify it parses
// cleanly so the oracle has a valid input.
// ---------------------------------------------------------------------------

test('committed fixture file parses and produces a valid ATIF trajectory', () => {
  const fixturePath = join(
    import.meta.dir,
    'fixtures/harbor/swe-agent/run.traj',
  );
  const raw = readFileSync(fixturePath, 'utf8');
  const traj = normalizeSweAgent(raw, '0.9.1');
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  expect(traj.agent.name).toBe('swe-agent');
  expect(traj.final_metrics!.total_prompt_tokens).toBe(4200);
  expect(traj.final_metrics!.total_completion_tokens).toBe(310);
});
