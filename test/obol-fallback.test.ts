import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sumCodingAgentTokens } from '../src/obol/fallback.ts';
import { estimateSessionLogs } from '../src/obol/index.ts';

// These fixtures mirror the real session-log shapes captured from live
// gemini-cli and opencode runs (2026-06-15). obol's gemini/opencode dialects
// return zero tokens on these versions, so quorum sums the per-message usage
// itself. Each model is left unpriced (est_cost_usd: null) — we count tokens,
// we do not price them.

function writeTmp(prefix: string, name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const f = join(dir, name);
  writeFileSync(f, body);
  return f;
}

// One gemini turn is recorded TWICE (same id, once without toolCalls and once
// with), so dedup by id is mandatory or every turn double-counts.
const GEMINI_LOG = [
  { sessionId: 's', startTime: '2026-06-15T02:07:00.000Z', kind: 'main' },
  {
    id: 'u1',
    timestamp: '2026-06-15T02:08:00.000Z',
    type: 'user',
    content: 'go',
  },
  {
    id: 'a1',
    timestamp: '2026-06-15T02:08:18.488Z',
    type: 'gemini',
    content: '',
    tokens: {
      input: 15813,
      output: 27,
      cached: 0,
      thoughts: 1005,
      tool: 0,
      total: 16845,
    },
    model: 'gemini-3.5-flash',
  },
  {
    id: 'a1',
    timestamp: '2026-06-15T02:08:18.500Z',
    type: 'gemini',
    content: '',
    tokens: {
      input: 15813,
      output: 27,
      cached: 0,
      thoughts: 1005,
      tool: 0,
      total: 16845,
    },
    model: 'gemini-3.5-flash',
    toolCalls: [
      {
        id: 'write_file__x',
        name: 'write_file',
        args: { file_path: 'hello.txt' },
      },
    ],
  },
  {
    id: 'a2',
    timestamp: '2026-06-15T02:08:25.000Z',
    type: 'gemini',
    content: 'done',
    tokens: {
      input: 16960,
      output: 14,
      cached: 0,
      thoughts: 150,
      tool: 0,
      total: 17124,
    },
    model: 'gemini-3.5-flash',
  },
];

const OPENCODE_LOG = {
  info: {
    id: 'ses_1',
    model: { id: 'gpt-5.5', providerID: 'openai', variant: 'default' },
    cost: 0.067986,
    tokens: {
      input: 10488,
      output: 105,
      reasoning: 106,
      cache: { read: 18432, write: 0 },
    },
  },
  messages: [
    {
      info: {
        role: 'user',
        model: { providerID: 'openai', modelID: 'gpt-5.5' },
      },
    },
    {
      info: {
        role: 'assistant',
        providerID: 'openai',
        modelID: 'gpt-5.5',
        cost: 0.05241,
        tokens: {
          total: 9667,
          input: 9504,
          output: 57,
          reasoning: 106,
          cache: { write: 0, read: 0 },
        },
      },
    },
    {
      info: {
        role: 'assistant',
        providerID: 'openai',
        modelID: 'gpt-5.5',
        cost: 0.007978,
        tokens: {
          total: 9715,
          input: 464,
          output: 35,
          reasoning: 0,
          cache: { write: 0, read: 9216 },
        },
      },
    },
    {
      info: {
        role: 'assistant',
        providerID: 'openai',
        modelID: 'gpt-5.5',
        cost: 0.007598,
        tokens: {
          total: 9749,
          input: 520,
          output: 13,
          reasoning: 0,
          cache: { write: 0, read: 9216 },
        },
      },
    },
  ],
};

test('sumCodingAgentTokens: gemini dedups by id and sums per-turn usage', () => {
  const f = writeTmp(
    'gem-',
    'chat.jsonl',
    `${GEMINI_LOG.map((r) => JSON.stringify(r)).join('\n')}\n`,
  );
  const u = sumCodingAgentTokens('gemini', [f]);
  expect(u).not.toBeNull();
  const usage = u as NonNullable<typeof u>;
  // input = 15813 + 16960; output (incl. reasoning/thoughts) = 27+1005 + 14+150
  expect(usage.total_input).toBe(15813 + 16960);
  expect(usage.total_output).toBe(27 + 1005 + 14 + 150);
  expect(usage.total_cache_read).toBe(0);
  expect(usage.total_cache_create).toBe(0);
  expect(usage.total_tokens).toBe(usage.total_input + usage.total_output);
  expect(usage.model).toBe('gemini-3.5-flash');
  expect(usage.models['gemini-3.5-flash']?.provider).toBe('google');
  // Unpriced: we count, we do not price.
  expect(usage.est_cost_usd).toBeNull();
  expect(usage.unpriced_models).toEqual(['gemini-3.5-flash']);
  expect(usage.models['gemini-3.5-flash']?.est_cost_usd).toBeNull();
});

test('sumCodingAgentTokens: opencode sums per-assistant-message usage', () => {
  const f = writeTmp('oc-', 'ses.json', JSON.stringify(OPENCODE_LOG));
  const u = sumCodingAgentTokens('opencode', [f]);
  expect(u).not.toBeNull();
  const usage = u as NonNullable<typeof u>;
  // Only assistant messages count; reasoning folds into output.
  expect(usage.total_input).toBe(9504 + 464 + 520);
  expect(usage.total_output).toBe(57 + 106 + 35 + 13);
  expect(usage.total_cache_read).toBe(0 + 9216 + 9216);
  expect(usage.total_cache_create).toBe(0);
  expect(usage.model).toBe('gpt-5.5');
  expect(usage.models['gpt-5.5']?.provider).toBe('openai');
  expect(usage.est_cost_usd).toBeNull();
  expect(usage.unpriced_models).toEqual(['gpt-5.5']);
});

test('sumCodingAgentTokens: returns null for a family without a fallback summer', () => {
  const f = writeTmp('cl-', 's.jsonl', '{}\n');
  expect(sumCodingAgentTokens('claude', [f])).toBeNull();
  expect(sumCodingAgentTokens('antigravity', [f])).toBeNull();
});

test('sumCodingAgentTokens: returns null when logs carry no token usage', () => {
  const f = writeTmp(
    'gem-empty-',
    'chat.jsonl',
    `${JSON.stringify({ kind: 'main' })}\n`,
  );
  expect(sumCodingAgentTokens('gemini', [f])).toBeNull();
});

test('estimateSessionLogs falls back to quorum token math when obol returns zero', async () => {
  // obol cannot parse this gemini-cli version; estimateSessionLogs must surface
  // the quorum-summed usage instead of null (which dropped coding_agent).
  const f = writeTmp(
    'gem-fb-',
    'chat.jsonl',
    `${GEMINI_LOG.map((r) => JSON.stringify(r)).join('\n')}\n`,
  );
  const usage = await estimateSessionLogs('gemini', [f]);
  expect(usage).not.toBeNull();
  const u = usage as NonNullable<typeof usage>;
  expect(u.total_tokens).toBe(15813 + 16960 + 27 + 1005 + 14 + 150);
  expect(u.est_cost_usd).toBeNull();
});
