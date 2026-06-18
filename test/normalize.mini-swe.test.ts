// Tests for src/normalize/mini-swe.ts
// Ported from Harbor's test fixtures: tests/unit/agents/installed/test_mini_swe_agent.py
// (V2_TOOL_CALLING_TRAJECTORY, V2_TOOL_CALLING_MULTI_TOOL, V2_WITH_EXIT_MESSAGE)

import { describe, expect, test } from 'bun:test';
import { ATIF_SCHEMA_VERSION } from '../src/atif/types.ts';
import { validateTrajectory } from '../src/atif/validate.ts';
import { normalizeMiniSwe } from '../src/normalize/mini-swe.ts';

// ---------------------------------------------------------------------------
// Fixtures: ported from Harbor test_mini_swe_agent.py
// ---------------------------------------------------------------------------

const V2_TOOL_CALLING_TRAJECTORY = JSON.stringify({
  trajectory_format: 'mini-swe-agent-1.1',
  info: {
    mini_version: '2.1.0',
    exit_status: 'completed',
    submission: 'diff --git a/baz.py b/baz.py\n',
    model_stats: { instance_cost: 0.25 },
    config: {
      model: { model_name: 'anthropic/claude-sonnet-4-5-20250929' },
      agent: { step_limit: 0, cost_limit: 5.0 },
    },
  },
  messages: [
    { role: 'system', content: 'You are a helpful assistant.', extra: {} },
    { role: 'user', content: 'Fix the import error in baz.py', extra: {} },
    {
      role: 'assistant',
      content: 'Let me look at the file to understand the import error.',
      tool_calls: [
        {
          id: 'call_abc123',
          type: 'function',
          function: {
            name: 'bash',
            arguments: '{"command": "cat baz.py"}',
          },
        },
      ],
      extra: {
        response: {
          usage: {
            prompt_tokens: 600,
            completion_tokens: 120,
            prompt_tokens_details: { cached_tokens: 100 },
            completion_tokens_details: { reasoning_tokens: 30 },
          },
        },
      },
    },
    {
      role: 'tool',
      content: 'import os\nimport sys\nfrom collections import OrderedDcit\n',
      tool_call_id: 'call_abc123',
      extra: {},
    },
    {
      role: 'assistant',
      content: 'I see a typo in the import: OrderedDcit should be OrderedDict.',
      tool_calls: [
        {
          id: 'call_def456',
          type: 'function',
          function: {
            name: 'bash',
            arguments:
              '{"command": "sed -i \'s/OrderedDcit/OrderedDict/\' baz.py"}',
          },
        },
      ],
      extra: {
        response: {
          usage: {
            prompt_tokens: 900,
            completion_tokens: 80,
            prompt_tokens_details: { cached_tokens: 300 },
            completion_tokens_details: { reasoning_tokens: 15 },
          },
        },
      },
    },
    {
      role: 'tool',
      content: '[File edited successfully]',
      tool_call_id: 'call_def456',
      extra: {},
    },
    {
      role: 'assistant',
      content: 'Let me verify the fix works.',
      tool_calls: [
        {
          id: 'call_ghi789',
          type: 'function',
          function: {
            name: 'bash',
            arguments: '{"command": "python -c \\"import baz\\""}',
          },
        },
      ],
      extra: {
        response: {
          usage: {
            prompt_tokens: 1100,
            completion_tokens: 50,
            prompt_tokens_details: { cached_tokens: 500 },
            completion_tokens_details: { reasoning_tokens: 5 },
          },
        },
      },
    },
    {
      role: 'tool',
      content: '',
      tool_call_id: 'call_ghi789',
      extra: {},
    },
  ],
});

const V2_TOOL_CALLING_MULTI_TOOL = JSON.stringify({
  trajectory_format: 'mini-swe-agent-1.1',
  info: {
    mini_version: '2.1.0',
    exit_status: 'completed',
    submission: '',
    model_stats: { instance_cost: 0.05 },
    config: {
      model: { model_name: 'openai/gpt-4o' },
      agent: {},
    },
  },
  messages: [
    { role: 'system', content: 'System prompt.', extra: {} },
    { role: 'user', content: 'Do something.', extra: {} },
    {
      role: 'assistant',
      content: "I'll run two commands.",
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'bash', arguments: '{"command": "ls"}' },
        },
        {
          id: 'call_2',
          type: 'function',
          function: { name: 'bash', arguments: '{"command": "pwd"}' },
        },
      ],
      extra: {
        response: {
          usage: {
            prompt_tokens: 200,
            completion_tokens: 40,
            prompt_tokens_details: { cached_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 0 },
          },
        },
      },
    },
    {
      role: 'tool',
      content: 'file1.py\nfile2.py',
      tool_call_id: 'call_1',
      extra: {},
    },
    {
      role: 'tool',
      content: '/testbed',
      tool_call_id: 'call_2',
      extra: {},
    },
  ],
});

const V2_WITH_EXIT_MESSAGE = JSON.stringify({
  trajectory_format: 'mini-swe-agent-1.1',
  info: {
    mini_version: '2.1.0',
    exit_status: 'Submitted',
    submission: '',
    model_stats: { instance_cost: 0.001 },
    config: {
      model: { model_name: 'openai/gpt-4o-mini' },
      agent: {},
    },
  },
  messages: [
    { role: 'system', content: 'System.', extra: {} },
    { role: 'user', content: 'Task.', extra: {} },
    {
      role: 'assistant',
      content: 'Done.',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'bash',
            arguments:
              '{"command": "echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"}',
          },
        },
      ],
      extra: {
        response: {
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            prompt_tokens_details: { cached_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 0 },
          },
        },
      },
    },
    {
      role: 'tool',
      content:
        '{"returncode": -1, "output": "", "exception_info": "action was not executed"}',
      tool_call_id: 'call_1',
      extra: {},
    },
    {
      role: 'exit',
      content: '',
      extra: { exit_status: 'Submitted', submission: '' },
    },
  ],
});

// ---------------------------------------------------------------------------
// Schema + agent metadata
// ---------------------------------------------------------------------------

describe('schema and metadata', () => {
  test('schema_version is ATIF_SCHEMA_VERSION', () => {
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_TRAJECTORY, '2.1.0');
    expect(traj.schema_version).toBe(ATIF_SCHEMA_VERSION);
  });

  test('agent.name is mini-swe-agent', () => {
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_TRAJECTORY, '2.1.0');
    expect(traj.agent.name).toBe('mini-swe-agent');
  });

  test('agent.version comes from info.mini_version', () => {
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_TRAJECTORY, 'fallback');
    expect(traj.agent.version).toBe('2.1.0');
  });

  test('agent.version falls back to passed version when mini_version absent', () => {
    const raw = JSON.stringify({
      messages: [{ role: 'system', content: 'x', extra: {} }],
    });
    const traj = normalizeMiniSwe(raw, 'v-fallback');
    expect(traj.agent.version).toBe('v-fallback');
  });

  test('agent.model_name from info.config.model.model_name', () => {
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_TRAJECTORY, '2.1.0');
    expect(traj.agent.model_name).toBe('anthropic/claude-sonnet-4-5-20250929');
  });

  test('agent.extra.original_format carries trajectory_format', () => {
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_TRAJECTORY, '2.1.0');
    expect(traj.agent.extra?.['original_format']).toBe('mini-swe-agent-1.1');
  });

  test('session_id is absent (not in log format)', () => {
    // mini-swe-agent logs do not carry a session_id in the log.
    // The capture layer sets it externally. Normalizer leaves it unset.
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_TRAJECTORY, '2.1.0');
    expect(traj.session_id).toBeUndefined();
  });

  test('validateTrajectory passes', () => {
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_TRAJECTORY, '2.1.0');
    const result = validateTrajectory(traj);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Step structure
// ---------------------------------------------------------------------------

describe('step structure', () => {
  test('step count: system + user + 3 assistant = 5 (tool messages become observations)', () => {
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_TRAJECTORY, '2.1.0');
    expect(traj.steps.length).toBe(5);
  });

  test('step sources are system, user, agent, agent, agent', () => {
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_TRAJECTORY, '2.1.0');
    const sources = traj.steps.map((s) => s.source);
    expect(sources).toEqual(['system', 'user', 'agent', 'agent', 'agent']);
  });

  test('step_ids are sequential from 1', () => {
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_TRAJECTORY, '2.1.0');
    traj.steps.forEach((step, i) => {
      expect(step.step_id).toBe(i + 1);
    });
  });

  test('system step message', () => {
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_TRAJECTORY, '2.1.0');
    expect(traj.steps[0]?.message).toBe('You are a helpful assistant.');
  });

  test('user step message', () => {
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_TRAJECTORY, '2.1.0');
    const userStep = traj.steps[1];
    const msg = userStep?.message;
    expect(
      typeof msg === 'string' && msg.includes('Fix the import error'),
    ).toBe(true);
  });

  test('exit message role is skipped', () => {
    const traj = normalizeMiniSwe(V2_WITH_EXIT_MESSAGE, '2.1.0');
    const sources = traj.steps.map((s) => s.source);
    expect(sources).not.toContain('exit');
    expect(traj.steps.length).toBe(3); // system + user + assistant
  });
});

// ---------------------------------------------------------------------------
// Content fidelity
// ---------------------------------------------------------------------------

describe('content fidelity', () => {
  test('reasoning_content is set when assistant has tool_calls (content becomes reasoning)', () => {
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_TRAJECTORY, '2.1.0');
    const step = traj.steps[2];
    expect(step?.reasoning_content).toBe(
      'Let me look at the file to understand the import error.',
    );
  });

  test('reasoning_content is undefined when content is empty', () => {
    const raw = JSON.stringify({
      info: {
        mini_version: '2.0.0',
        model_stats: { instance_cost: 0 },
        config: { model: { model_name: 'test/m' }, agent: {} },
      },
      messages: [
        { role: 'system', content: 'sys', extra: {} },
        { role: 'user', content: 'task', extra: {} },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_x',
              type: 'function',
              function: { name: 'bash', arguments: '{"command": "ls"}' },
            },
          ],
          extra: {},
        },
      ],
    });
    const traj = normalizeMiniSwe(raw, '2.0.0');
    expect(traj.steps[2]?.reasoning_content).toBeUndefined();
  });

  test('assistant without tool_calls: content goes to reasoning_content', () => {
    const raw = JSON.stringify({
      info: {
        mini_version: '2.0.0',
        model_stats: { instance_cost: 0 },
        config: { model: { model_name: 'test/m' }, agent: {} },
      },
      messages: [
        { role: 'system', content: 'sys', extra: {} },
        { role: 'user', content: 'task', extra: {} },
        { role: 'assistant', content: "I'm thinking about this...", extra: {} },
      ],
    });
    const traj = normalizeMiniSwe(raw, '2.0.0');
    const step = traj.steps[2];
    expect(step?.source).toBe('agent');
    expect(step?.tool_calls).toBeUndefined();
    // Harbor: content without tool_calls → reasoning_content
    expect(step?.reasoning_content).toBe("I'm thinking about this...");
  });

  test('observation attached to correct step', () => {
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_TRAJECTORY, '2.1.0');
    const step = traj.steps[2];
    expect(step?.observation).toBeDefined();
    const results = step?.observation?.results;
    expect(results).toBeDefined();
    const content = results?.[0]?.content;
    expect(typeof content === 'string' && content.includes('OrderedDcit')).toBe(
      true,
    );
  });

  test('empty tool result is preserved as empty string observation', () => {
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_TRAJECTORY, '2.1.0');
    const step = traj.steps[4];
    expect(step?.observation?.results[0]?.content).toBe('');
  });

  test('model_name on agent steps', () => {
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_TRAJECTORY, '2.1.0');
    const agentSteps = traj.steps.filter((s) => s.source === 'agent');
    for (const step of agentSteps) {
      expect(step.model_name).toBe('anthropic/claude-sonnet-4-5-20250929');
    }
  });
});

// ---------------------------------------------------------------------------
// Tool-name canonicalization
// ---------------------------------------------------------------------------

describe('tool-name canonicalization', () => {
  test('bash → Bash', () => {
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_TRAJECTORY, '2.1.0');
    const agentSteps = traj.steps.filter((s) => s.source === 'agent');
    const toolNames = agentSteps.flatMap((s) =>
      (s.tool_calls ?? []).map((tc) => tc.function_name),
    );
    expect(toolNames).toEqual(['Bash', 'Bash', 'Bash']);
  });

  test('unknown tool names pass through unchanged', () => {
    const raw = JSON.stringify({
      info: {
        mini_version: '2.0.0',
        model_stats: { instance_cost: 0 },
        config: { model: { model_name: 'test/m' }, agent: {} },
      },
      messages: [
        { role: 'system', content: 'sys', extra: {} },
        { role: 'user', content: 'task', extra: {} },
        {
          role: 'assistant',
          content: 'doing it',
          tool_calls: [
            {
              id: 'call_u',
              type: 'function',
              function: { name: 'some_custom_tool', arguments: '{}' },
            },
          ],
          extra: {},
        },
      ],
    });
    const traj = normalizeMiniSwe(raw, '2.0.0');
    expect(traj.steps[2]?.tool_calls?.[0]?.function_name).toBe(
      'some_custom_tool',
    );
  });

  test('tool_call_id is preserved', () => {
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_TRAJECTORY, '2.1.0');
    const step = traj.steps[2];
    expect(step?.tool_calls?.[0]?.tool_call_id).toBe('call_abc123');
  });

  test('tool arguments are parsed from JSON string', () => {
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_TRAJECTORY, '2.1.0');
    const step = traj.steps[2];
    expect(step?.tool_calls?.[0]?.arguments).toEqual({ command: 'cat baz.py' });
  });

  test('tool arguments as dict (already parsed object) are preserved', () => {
    const raw = JSON.stringify({
      info: {
        mini_version: '2.0.0',
        model_stats: { instance_cost: 0 },
        config: { model: { model_name: 'test/m' }, agent: {} },
      },
      messages: [
        { role: 'system', content: 'Sys.', extra: {} },
        { role: 'user', content: 'Task.', extra: {} },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_x',
              type: 'function',
              function: { name: 'bash', arguments: { command: 'echo hello' } },
            },
          ],
          extra: {},
        },
        { role: 'tool', content: 'hello', tool_call_id: 'call_x', extra: {} },
      ],
    });
    const traj = normalizeMiniSwe(raw, '2.0.0');
    expect(traj.steps[2]?.tool_calls?.[0]?.arguments).toEqual({
      command: 'echo hello',
    });
  });

  test('multiple tool calls in one step', () => {
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_MULTI_TOOL, '2.1.0');
    const step = traj.steps[2];
    expect(step?.tool_calls?.length).toBe(2);
    expect(step?.tool_calls?.[0]?.tool_call_id).toBe('call_1');
    expect(step?.tool_calls?.[1]?.tool_call_id).toBe('call_2');
  });

  test('multiple tool results attach as multiple observation results', () => {
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_MULTI_TOOL, '2.1.0');
    const step = traj.steps[2];
    const results = step?.observation?.results;
    expect(results?.length).toBe(2);
    const c0 = results?.[0]?.content;
    const c1 = results?.[1]?.content;
    expect(typeof c0 === 'string' && c0.includes('file1.py')).toBe(true);
    expect(typeof c1 === 'string' && c1.includes('/testbed')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Token metrics — DISJOINT buckets + SINGLE-SOURCE (per-step only)
// ---------------------------------------------------------------------------

describe('token metrics — disjoint buckets', () => {
  test('per-step prompt_tokens is UNCACHED (raw prompt_tokens minus cached_tokens)', () => {
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_TRAJECTORY, '2.1.0');
    // step[2] = first assistant: raw=600, cached=100 → uncached=500
    expect(traj.steps[2]?.metrics?.prompt_tokens).toBe(500);
  });

  test('per-step cached_tokens is the cache-read bucket', () => {
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_TRAJECTORY, '2.1.0');
    expect(traj.steps[2]?.metrics?.cached_tokens).toBe(100);
  });

  test('per-step completion_tokens', () => {
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_TRAJECTORY, '2.1.0');
    expect(traj.steps[2]?.metrics?.completion_tokens).toBe(120);
  });

  test('no metrics on system or user steps', () => {
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_TRAJECTORY, '2.1.0');
    expect(traj.steps[0]?.metrics).toBeUndefined(); // system
    expect(traj.steps[1]?.metrics).toBeUndefined(); // user
  });

  test('no metrics on step with zero usage', () => {
    const raw = JSON.stringify({
      info: {
        mini_version: '2.0.0',
        model_stats: { instance_cost: 0 },
        config: { model: { model_name: 'test/m' }, agent: {} },
      },
      messages: [
        { role: 'system', content: 'sys', extra: {} },
        { role: 'user', content: 'task', extra: {} },
        { role: 'assistant', content: 'done', extra: {} },
      ],
    });
    const traj = normalizeMiniSwe(raw, '2.0.0');
    expect(traj.steps[2]?.metrics).toBeUndefined();
  });

  test('disjoint-bucket conservation: sum of per-step (uncached_prompt + cached + completion) accounts for all tokens', () => {
    // Session totals from fixture:
    //   raw prompt: 600+900+1100=2600, cached: 100+300+500=900
    //   uncached prompt = 2600-900=1700
    //   completion: 120+80+50=250
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_TRAJECTORY, '2.1.0');
    let totalPrompt = 0;
    let totalCached = 0;
    let totalCompletion = 0;
    for (const step of traj.steps) {
      totalPrompt += step.metrics?.prompt_tokens ?? 0;
      totalCached += step.metrics?.cached_tokens ?? 0;
      totalCompletion += step.metrics?.completion_tokens ?? 0;
    }
    // uncached prompt (disjoint): 500+600+600 = 1700
    expect(totalPrompt).toBe(1700);
    // cached: 100+300+500 = 900
    expect(totalCached).toBe(900);
    // completion: 120+80+50 = 250
    expect(totalCompletion).toBe(250);
    // Disjoint-sum check: uncached+cached should equal raw prompt total
    expect(totalPrompt + totalCached).toBe(2600);
  });

  test('zero cached_tokens yields no cached_tokens field', () => {
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_MULTI_TOOL, '2.1.0');
    // step[2] = assistant: prompt=200, cached=0, completion=40
    expect(traj.steps[2]?.metrics?.prompt_tokens).toBe(200); // 200-0=200
    expect(traj.steps[2]?.metrics?.cached_tokens).toBeUndefined(); // 0 → omitted
    expect(traj.steps[2]?.metrics?.completion_tokens).toBe(40);
  });

  test('SINGLE-SOURCE: no final_metrics token totals when per-step metrics are emitted', () => {
    // Per-step usage is present → final_metrics must NOT carry token totals.
    // Avoids the double-count bug (obol skips final_metrics when per-step metrics exist).
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_TRAJECTORY, '2.1.0');
    expect(traj.final_metrics?.total_prompt_tokens).toBeUndefined();
    expect(traj.final_metrics?.total_completion_tokens).toBeUndefined();
  });

  test('cost_usd from info.model_stats.instance_cost is set on final_metrics', () => {
    // Session cost is a single value in info.model_stats.instance_cost → passthrough to final_metrics
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_TRAJECTORY, '2.1.0');
    expect(traj.final_metrics?.total_cost_usd).toBeCloseTo(0.25);
  });

  test('no cost_usd when instance_cost is 0', () => {
    const raw = JSON.stringify({
      info: {
        mini_version: '2.0.0',
        model_stats: { instance_cost: 0 },
        config: { model: { model_name: 'test/m' }, agent: {} },
      },
      messages: [
        { role: 'system', content: 'sys', extra: {} },
        { role: 'user', content: 'task', extra: {} },
        { role: 'assistant', content: 'done', extra: {} },
      ],
    });
    const traj = normalizeMiniSwe(raw, '2.0.0');
    expect(traj.final_metrics?.total_cost_usd).toBeUndefined();
  });

  test('exit message tokens excluded: only assistant step contributes usage', () => {
    // V2_WITH_EXIT_MESSAGE: only the one assistant step contributes usage
    const traj = normalizeMiniSwe(V2_WITH_EXIT_MESSAGE, '2.1.0');
    const agentStep = traj.steps.find((s) => s.source === 'agent');
    expect(agentStep?.metrics?.prompt_tokens).toBe(100); // 100-0=100
    expect(agentStep?.metrics?.completion_tokens).toBe(20);
    // cost is on final_metrics
    expect(traj.final_metrics?.total_cost_usd).toBeCloseTo(0.001);
  });

  test('missing info yields no cost_usd', () => {
    const raw = JSON.stringify({
      messages: [
        { role: 'system', content: 'sys', extra: {} },
        { role: 'user', content: 'task', extra: {} },
        { role: 'assistant', content: 'done', extra: {} },
      ],
    });
    const traj = normalizeMiniSwe(raw, 'unknown');
    expect(traj.final_metrics?.total_cost_usd).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Observation source_call_id linkage (ATIF invariant)
// ---------------------------------------------------------------------------

describe('observation source_call_id', () => {
  test('tool result source_call_id matches tool_call_id in same step', () => {
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_TRAJECTORY, '2.1.0');
    const step2 = traj.steps[2];
    expect(step2?.tool_calls?.[0]?.tool_call_id).toBe('call_abc123');
    expect(step2?.observation?.results[0]?.source_call_id).toBe('call_abc123');
  });

  test('validateTrajectory passes with source_call_id references', () => {
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_TRAJECTORY, '2.1.0');
    expect(validateTrajectory(traj).ok).toBe(true);
  });

  test('multi-tool: each tool result source_call_id matches its tool_call', () => {
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_MULTI_TOOL, '2.1.0');
    const step = traj.steps[2];
    const results = step?.observation?.results;
    expect(results?.[0]?.source_call_id).toBe('call_1');
    expect(results?.[1]?.source_call_id).toBe('call_2');
    expect(validateTrajectory(traj).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dedup: mini-swe-agent logs do NOT re-emit messages by id — flat list format.
// This test documents that assumption.
// ---------------------------------------------------------------------------

describe('no re-emission / no dedup needed', () => {
  test('each message index yields exactly one step contribution (no duplication)', () => {
    // mini-swe-agent uses a flat list of messages — no streaming re-emission by id.
    // Confirm step count matches expectations.
    const traj = normalizeMiniSwe(V2_TOOL_CALLING_TRAJECTORY, '2.1.0');
    // 8 messages → 5 steps (3 tool messages become observations on preceding agent steps)
    expect(traj.steps.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  test('missing info section yields fallback version and unknown model', () => {
    const raw = JSON.stringify({
      messages: [
        { role: 'system', content: 'sys', extra: {} },
        { role: 'user', content: 'task', extra: {} },
        { role: 'assistant', content: 'done', extra: {} },
      ],
    });
    const traj = normalizeMiniSwe(raw, 'v-fallback');
    expect(traj.agent.version).toBe('v-fallback');
    expect(traj.agent.model_name).toBe('unknown');
    expect(validateTrajectory(traj).ok).toBe(true);
  });

  test('list content in messages is joined with newlines', () => {
    const raw = JSON.stringify({
      info: {
        mini_version: '2.0.0',
        model_stats: { instance_cost: 0 },
        config: { model: { model_name: 'test/m' }, agent: {} },
      },
      messages: [
        { role: 'system', content: 'sys', extra: {} },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Part one.' },
            { type: 'text', text: 'Part two.' },
          ],
          extra: {},
        },
      ],
    });
    const traj = normalizeMiniSwe(raw, '2.0.0');
    expect(traj.steps[1]?.message).toBe('Part one.\nPart two.');
  });

  test('system-only messages produce one system step', () => {
    const raw = JSON.stringify({
      info: {
        mini_version: '2.0.0',
        model_stats: { instance_cost: 0 },
        config: { model: { model_name: 'test/m' }, agent: {} },
      },
      messages: [{ role: 'system', content: 'sys', extra: {} }],
    });
    const traj = normalizeMiniSwe(raw, '2.0.0');
    expect(traj.steps.length).toBe(1);
    expect(traj.steps[0]?.source).toBe('system');
    expect(validateTrajectory(traj).ok).toBe(true);
  });

  test('LitellmResponseModel shape (object==response) is parsed', () => {
    // LitellmResponseModel puts usage at top-level with input_tokens/output_tokens
    const raw = JSON.stringify({
      info: {
        mini_version: '2.0.0',
        model_stats: { instance_cost: 0.01 },
        config: { model: { model_name: 'openai/o1' }, agent: {} },
      },
      messages: [
        { role: 'system', content: 'sys', extra: {} },
        { role: 'user', content: 'task', extra: {} },
        {
          role: 'assistant',
          object: 'response',
          content: 'answer',
          usage: { input_tokens: 50, output_tokens: 10 },
          extra: {},
        },
      ],
    });
    const traj = normalizeMiniSwe(raw, '2.0.0');
    const agentStep = traj.steps[2];
    expect(agentStep?.metrics?.prompt_tokens).toBe(50);
    expect(agentStep?.metrics?.completion_tokens).toBe(10);
  });

  test('user message at index > 1 becomes observation on last agent step', () => {
    // Harbor: only i==1 user message creates a user step; later user messages
    // (role=="user" at index > 1) become observations on the preceding agent step.
    const raw = JSON.stringify({
      info: {
        mini_version: '2.0.0',
        model_stats: { instance_cost: 0 },
        config: { model: { model_name: 'test/m' }, agent: {} },
      },
      messages: [
        { role: 'system', content: 'sys', extra: {} },
        { role: 'user', content: 'initial task', extra: {} },
        {
          role: 'assistant',
          content: 'thinking',
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'bash', arguments: '{"command":"ls"}' },
            },
          ],
          extra: {},
        },
        { role: 'user', content: 'observation text', extra: {} },
      ],
    });
    const traj = normalizeMiniSwe(raw, '2.0.0');
    // system + user(initial) + agent = 3 steps; later user role becomes observation
    expect(traj.steps.length).toBe(3);
    const agentStep = traj.steps[2];
    expect(agentStep?.observation?.results.length).toBeGreaterThanOrEqual(1);
  });
});
