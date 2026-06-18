import { expect, test } from 'bun:test';
import { ATIF_SCHEMA_VERSION } from '../src/atif/types.ts';
import { validateTrajectory } from '../src/atif/validate.ts';
import { normalizeAcp } from '../src/normalize/acp.ts';

// ---------------------------------------------------------------------------
// Fixtures: ported from Harbor tests/unit/agents/installed/test_acp_agent.py
// (lines 303–473, test_populate_context_writes_trajectory_from_acp_events
//  and test_populate_context_segments_multiple_tool_cycles).
// Harbor schema_version translated: ATIF-v1.6 → ATIF-v1.7 (our convention).
// ---------------------------------------------------------------------------

/**
 * Fixture 1: Single tool cycle — mirrors
 * test_populate_context_writes_trajectory_from_acp_events.
 * Events: thought, message chunk × 2, request_permission, tool_call (pending),
 * tool_call_update (completed with output), final message chunk.
 */
const singleCycleEvents = `${[
  {
    event_type: 'session_update',
    payload: {
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Thinking' },
      },
    },
  },
  {
    event_type: 'session_update',
    payload: {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Creating' },
      },
    },
  },
  {
    event_type: 'session_update',
    payload: {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: ' hello.txt' },
      },
    },
  },
  {
    event_type: 'request_permission',
    payload: {
      tool_call: {
        toolCallId: 'call_123',
        tool: 'execute',
      },
      options: [],
      session_id: 'ses_test_123',
    },
  },
  {
    event_type: 'session_update',
    payload: {
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_123',
        title: 'apply_patch',
        kind: 'other',
        rawInput: {},
        status: 'pending',
      },
    },
  },
  {
    event_type: 'session_update',
    payload: {
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_123',
        title: 'Success. Updated the following files',
        kind: 'other',
        status: 'completed',
        rawInput: {
          patchText:
            '*** Begin Patch\n*** Add File: hello.txt\n+Hello, world!\n*** End Patch',
        },
        rawOutput: {
          output: 'Success. Updated the following files:\nA app/hello.txt',
        },
      },
    },
  },
  {
    event_type: 'session_update',
    payload: {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: ' Done.' },
      },
    },
  },
]
  .map((e) => JSON.stringify(e))
  .join('\n')}\n`;

/**
 * Fixture 2: Multiple tool cycles with usage_update events — mirrors
 * test_populate_context_segments_multiple_tool_cycles.
 * Events: message, usage_update (flushes step), tool_call + tool_call_update,
 * usage_update (flushes), tool_call + tool_call_update, usage_update (flushes),
 * final message, usage_update (flushes).
 */
const multiCycleEvents = `${[
  {
    event_type: 'session_update',
    payload: {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Plan' },
      },
    },
  },
  {
    event_type: 'session_update',
    payload: { update: { sessionUpdate: 'usage_update', used: 10 } },
  },
  {
    event_type: 'session_update',
    payload: {
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_1',
        title: 'write_file',
        kind: 'other',
        rawInput: { path: '/app/hello.txt' },
        status: 'pending',
      },
    },
  },
  {
    event_type: 'session_update',
    payload: {
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_1',
        title: 'write_file',
        kind: 'other',
        status: 'completed',
        rawOutput: { output: 'wrote hello.txt' },
      },
    },
  },
  {
    event_type: 'session_update',
    payload: { update: { sessionUpdate: 'usage_update', used: 11 } },
  },
  {
    event_type: 'session_update',
    payload: {
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_2',
        title: 'read_file',
        kind: 'other',
        rawInput: { path: '/app/hello.txt' },
        status: 'pending',
      },
    },
  },
  {
    event_type: 'session_update',
    payload: {
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_2',
        title: 'read_file',
        kind: 'other',
        status: 'completed',
        rawOutput: { output: 'Hello, world!' },
      },
    },
  },
  {
    event_type: 'session_update',
    payload: { update: { sessionUpdate: 'usage_update', used: 12 } },
  },
  {
    event_type: 'session_update',
    payload: {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Done' },
      },
    },
  },
  {
    event_type: 'session_update',
    payload: { update: { sessionUpdate: 'usage_update', used: 13 } },
  },
]
  .map((e) => JSON.stringify(e))
  .join('\n')}\n`;

/**
 * Fixture 3: usage_update events carrying inputTokens / outputTokens.
 * These are real-world ACP events where agents include per-step token counts
 * in usage_update payloads.
 */
const usageUpdateWithTokensEvents = `${[
  {
    event_type: 'session_update',
    payload: {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'First response' },
      },
    },
  },
  {
    event_type: 'session_update',
    payload: {
      update: {
        sessionUpdate: 'usage_update',
        inputTokens: 100,
        outputTokens: 25,
      },
    },
  },
  {
    event_type: 'session_update',
    payload: {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Second response' },
      },
    },
  },
  {
    event_type: 'session_update',
    payload: {
      update: {
        sessionUpdate: 'usage_update',
        inputTokens: 200,
        outputTokens: 40,
      },
    },
  },
]
  .map((e) => JSON.stringify(e))
  .join('\n')}\n`;

/**
 * Fixture 4: Tool name canonicalization — exercises ACP_TOOL_MAP and kind→title→"tool" logic.
 */
const toolNameEvents = `${[
  // kind is a known canonical key → maps directly
  {
    event_type: 'session_update',
    payload: {
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc_bash',
        kind: 'bash',
        title: 'Execute Shell Command',
        rawInput: { command: 'ls' },
        status: 'pending',
      },
    },
  },
  {
    event_type: 'session_update',
    payload: {
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc_bash',
        kind: 'bash',
        status: 'completed',
        rawOutput: { output: 'file.txt' },
      },
    },
  },
  // kind is "other" → falls back to title
  {
    event_type: 'session_update',
    payload: {
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc_read',
        kind: 'other',
        title: 'read_file',
        rawInput: { path: '/app/x.txt' },
        status: 'pending',
      },
    },
  },
  {
    event_type: 'session_update',
    payload: {
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc_read',
        kind: 'other',
        status: 'completed',
        rawOutput: { output: 'hello' },
      },
    },
  },
  // kind is "other", no title → falls back to "tool"
  {
    event_type: 'session_update',
    payload: {
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc_unknown',
        kind: 'other',
        rawInput: {},
        status: 'pending',
      },
    },
  },
  {
    event_type: 'session_update',
    payload: {
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc_unknown',
        kind: 'other',
        status: 'completed',
        rawOutput: { output: 'ok' },
      },
    },
  },
]
  .map((e) => JSON.stringify(e))
  .join('\n')}\n`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('schema_version is ATIF_SCHEMA_VERSION (v1.7)', () => {
  const traj = normalizeAcp(singleCycleEvents, '0.10.0');
  expect(traj.schema_version).toBe(ATIF_SCHEMA_VERSION);
  expect(traj.schema_version).toBe('ATIF-v1.7');
});

test('agent.name and agent.version are correct', () => {
  const traj = normalizeAcp(singleCycleEvents, '0.10.0');
  expect(traj.agent.name).toBe('acp');
  expect(traj.agent.version).toBe('0.10.0');
});

test('produces a valid ATIF trajectory (validateTrajectory ok, no errors)', () => {
  const traj = normalizeAcp(singleCycleEvents, '0.10.0');
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  expect(r.ok).toBe(true);
});

test('single cycle: step structure — agent step with thought+message+tool, second agent step with message', () => {
  const traj = normalizeAcp(singleCycleEvents, '0.10.0');
  // Without summary (no user instruction step), just 2 agent steps.
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  expect(agentSteps.length).toBe(2);

  const first = agentSteps[0]!;
  expect(first.reasoning_content).toBe('Thinking');
  expect(first.message).toBe('Creating hello.txt');
  expect(first.tool_calls).toBeDefined();
  expect(first.tool_calls!.length).toBe(1);
  expect(first.tool_calls![0]!.tool_call_id).toBe('call_123');

  const second = agentSteps[1]!;
  expect(second.message).toBe(' Done.');
  expect(second.tool_calls).toBeUndefined();
});

test('single cycle: observation attached to correct step with source_call_id', () => {
  const traj = normalizeAcp(singleCycleEvents, '0.10.0');
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  const toolStep = agentSteps[0]!;
  expect(toolStep.observation).toBeDefined();
  expect(toolStep.observation!.results.length).toBe(1);
  expect(toolStep.observation!.results[0]!.source_call_id).toBe('call_123');
  expect(toolStep.observation!.results[0]!.content).toBe(
    'Success. Updated the following files:\nA app/hello.txt',
  );
});

test('single cycle: tool_call arguments populated from rawInput in tool_call_update', () => {
  const traj = normalizeAcp(singleCycleEvents, '0.10.0');
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  const tc = agentSteps[0]!.tool_calls![0]!;
  expect(tc.arguments['patchText']).toBe(
    '*** Begin Patch\n*** Add File: hello.txt\n+Hello, world!\n*** End Patch',
  );
});

test('multiple cycles: correct step count and sources', () => {
  const traj = normalizeAcp(multiCycleEvents, '0.10.0');
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  // usage_update flushes steps: Plan→step1, write_file→step2, read_file→step3, Done→step4
  const sources = traj.steps.map((s) => s.source);
  expect(sources).toEqual(['agent', 'agent', 'agent', 'agent']);
});

test('multiple cycles: message content per step', () => {
  const traj = normalizeAcp(multiCycleEvents, '0.10.0');
  const steps = traj.steps;
  expect(steps[0]!.message).toBe('Plan');
  // title 'write_file' maps to canonical 'Write' via ACP_TOOL_MAP
  expect(steps[1]!.tool_calls![0]!.function_name).toBe('Write');
  // title 'read_file' maps to canonical 'Read' via ACP_TOOL_MAP
  expect(steps[2]!.tool_calls![0]!.function_name).toBe('Read');
  expect(steps[3]!.message).toBe('Done');
});

test('multiple cycles: observations on correct tool steps', () => {
  const traj = normalizeAcp(multiCycleEvents, '0.10.0');
  const steps = traj.steps;
  // Step 1 (Write — canonical for write_file title) has observation
  expect(steps[1]!.observation!.results[0]!.content).toBe('wrote hello.txt');
  expect(steps[1]!.observation!.results[0]!.source_call_id).toBe('call_1');
  // Step 2 (Read — canonical for read_file title) has observation
  expect(steps[2]!.observation!.results[0]!.content).toBe('Hello, world!');
  expect(steps[2]!.observation!.results[0]!.source_call_id).toBe('call_2');
});

test('step_ids are sequential from 1', () => {
  const traj = normalizeAcp(singleCycleEvents, '0.10.0');
  const ids = traj.steps.map((s) => s.step_id);
  expect(ids).toEqual(ids.map((_, i) => i + 1));
});

// ---------------------------------------------------------------------------
// Tool name canonicalization
// ---------------------------------------------------------------------------

test('tool name: kind → canonical name via ACP_TOOL_MAP', () => {
  const traj = normalizeAcp(toolNameEvents, '1.0.0');
  const names = traj.steps
    .filter((s) => s.source === 'agent' && s.tool_calls)
    .map((s) => s.tool_calls![0]!.function_name);
  // bash kind → Bash, read_file title (kind=other) → Read, no-title → "tool"
  expect(names).toEqual(['Bash', 'Read', 'tool']);
});

test('tool name: kind="other" falls back to title, then "tool"', () => {
  const traj = normalizeAcp(toolNameEvents, '1.0.0');
  const steps = traj.steps.filter((s) => s.source === 'agent' && s.tool_calls);
  // Second tool: kind=other, title=read_file → Read
  expect(steps[1]!.tool_calls![0]!.function_name).toBe('Read');
  // Third tool: kind=other, no title → "tool"
  expect(steps[2]!.tool_calls![0]!.function_name).toBe('tool');
});

// ---------------------------------------------------------------------------
// Token metrics — per-step when usage_update carries inputTokens/outputTokens
// ---------------------------------------------------------------------------

test('usage_update with inputTokens/outputTokens → per-step metrics, no final_metrics tokens', () => {
  const traj = normalizeAcp(usageUpdateWithTokensEvents, '1.0.0');
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);

  // Per-step metrics present
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  expect(agentSteps.length).toBe(2);
  expect(agentSteps[0]!.metrics?.prompt_tokens).toBe(100);
  expect(agentSteps[0]!.metrics?.completion_tokens).toBe(25);
  expect(agentSteps[1]!.metrics?.prompt_tokens).toBe(200);
  expect(agentSteps[1]!.metrics?.completion_tokens).toBe(40);

  // SINGLE-SOURCE: no final_metrics token totals when per-step metrics present
  expect(traj.final_metrics?.total_prompt_tokens).toBeUndefined();
  expect(traj.final_metrics?.total_completion_tokens).toBeUndefined();
});

test('disjoint-bucket conservation: sum of per-step metrics equals known session total', () => {
  const traj = normalizeAcp(usageUpdateWithTokensEvents, '1.0.0');
  let prompt = 0;
  let completion = 0;
  let cached = 0;
  let cacheWrite = 0;
  for (const s of traj.steps) {
    prompt += s.metrics?.prompt_tokens ?? 0;
    completion += s.metrics?.completion_tokens ?? 0;
    cached += s.metrics?.cached_tokens ?? 0;
    const cw = s.extra?.['cache_write'];
    if (typeof cw === 'number') cacheWrite += cw;
  }
  if (traj.final_metrics) {
    prompt += traj.final_metrics.total_prompt_tokens ?? 0;
    completion += traj.final_metrics.total_completion_tokens ?? 0;
    const fc = traj.final_metrics.extra?.['total_cached_tokens'];
    if (typeof fc === 'number') cached += fc;
  }
  // 100+200 prompt = 300, 25+40 completion = 65
  expect(prompt).toBe(300);
  expect(completion).toBe(65);
  expect(cached).toBe(0);
  expect(cacheWrite).toBe(0);
});

test('no metrics when usage_update events carry no token counts', () => {
  const traj = normalizeAcp(multiCycleEvents, '1.0.0');
  // usage_update events only have { used: N } — no inputTokens/outputTokens
  for (const s of traj.steps) {
    expect(s.metrics).toBeUndefined();
  }
  expect(traj.final_metrics?.total_prompt_tokens).toBeUndefined();
  expect(traj.final_metrics?.total_completion_tokens).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Content fidelity
// ---------------------------------------------------------------------------

test('reasoning_content populated from agent_thought_chunk events', () => {
  const traj = normalizeAcp(singleCycleEvents, '0.10.0');
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  expect(agentSteps[0]!.reasoning_content).toBe('Thinking');
});

test('message populated from agent_message_chunk events (concatenated)', () => {
  const traj = normalizeAcp(singleCycleEvents, '0.10.0');
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  expect(agentSteps[0]!.message).toBe('Creating hello.txt');
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

test('ignores unknown event_types (non-session_update, non-request_permission)', () => {
  const raw = [
    JSON.stringify({ event_type: 'unknown', payload: { data: 'ignored' } }),
    JSON.stringify({
      event_type: 'session_update',
      payload: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello' },
        },
      },
    }),
    JSON.stringify({
      event_type: 'session_update',
      payload: {
        update: { sessionUpdate: 'usage_update', used: 5 },
      },
    }),
  ].join('\n');
  const traj = normalizeAcp(raw, '1.0.0');
  expect(traj.steps.length).toBeGreaterThanOrEqual(1);
  expect(traj.steps[0]!.message).toBe('Hello');
});

test('handles bad/empty JSON lines without crashing', () => {
  const raw = [
    'not json at all',
    '',
    JSON.stringify({
      event_type: 'session_update',
      payload: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'OK' },
        },
      },
    }),
    JSON.stringify({
      event_type: 'session_update',
      payload: { update: { sessionUpdate: 'usage_update', used: 1 } },
    }),
  ].join('\n');
  const traj = normalizeAcp(raw, '1.0.0');
  const r = validateTrajectory(traj);
  expect(r.ok).toBe(true);
  expect(traj.steps[0]!.message).toBe('OK');
});

test('empty input produces a valid single-step trajectory', () => {
  const traj = normalizeAcp('', '1.0.0');
  const r = validateTrajectory(traj);
  expect(r.ok).toBe(true);
  expect(traj.steps.length).toBe(1);
});

test('request_permission before tool_call: permission request attached to step extra', () => {
  const traj = normalizeAcp(singleCycleEvents, '0.10.0');
  // The permission_request for call_123 should be captured in the step's extra
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  const toolStep = agentSteps[0]!;
  const permReqs = toolStep.extra?.['permission_requests'];
  expect(Array.isArray(permReqs)).toBe(true);
  expect((permReqs as unknown[]).length).toBe(1);
});

test('rawOutput with nested output key: extracted as observation content', () => {
  const raw = [
    JSON.stringify({
      event_type: 'session_update',
      payload: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Doing stuff' },
        },
      },
    }),
    JSON.stringify({
      event_type: 'session_update',
      payload: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc_1',
          kind: 'bash',
          rawInput: { command: 'ls' },
          status: 'pending',
        },
      },
    }),
    JSON.stringify({
      event_type: 'session_update',
      payload: {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc_1',
          kind: 'bash',
          status: 'completed',
          rawOutput: { output: 'file1.txt\nfile2.txt' },
        },
      },
    }),
    JSON.stringify({
      event_type: 'session_update',
      payload: { update: { sessionUpdate: 'usage_update', used: 5 } },
    }),
  ].join('\n');
  const traj = normalizeAcp(raw, '1.0.0');
  const r = validateTrajectory(traj);
  expect(r.errors).toEqual([]);
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  expect(agentSteps[0]!.observation!.results[0]!.content).toBe(
    'file1.txt\nfile2.txt',
  );
});

test('rawOutput with stdout/stderr keys: JSON-encoded as observation', () => {
  const raw = [
    JSON.stringify({
      event_type: 'session_update',
      payload: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Running' },
        },
      },
    }),
    JSON.stringify({
      event_type: 'session_update',
      payload: {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc_2',
          kind: 'bash',
          rawInput: { command: 'whoami' },
          status: 'pending',
        },
      },
    }),
    JSON.stringify({
      event_type: 'session_update',
      payload: {
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc_2',
          kind: 'bash',
          status: 'completed',
          rawOutput: { stdout: 'root\n', stderr: '', exit_code: 0 },
        },
      },
    }),
    JSON.stringify({
      event_type: 'session_update',
      payload: { update: { sessionUpdate: 'usage_update', used: 3 } },
    }),
  ].join('\n');
  const traj = normalizeAcp(raw, '1.0.0');
  const agentSteps = traj.steps.filter((s) => s.source === 'agent');
  const obs = agentSteps[0]!.observation!.results[0]!.content;
  // Should be JSON-encoded since it has stdout/stderr/exit_code
  expect(typeof obs).toBe('string');
  const parsed = JSON.parse(obs as string) as Record<string, unknown>;
  expect(parsed['stdout']).toBe('root\n');
});
