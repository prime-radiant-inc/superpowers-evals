import { expect, test } from 'bun:test';
import { render } from '../src/cli/render.ts';
import type { FinalVerdict } from '../src/contracts/verdict.ts';

test('completed refusal and actual assessment failures expose their independent evidence', () => {
  const verdict: FinalVerdict = {
    schema: 1,
    final: 'fail',
    final_reason: 'pricing unchanged',
    error: null,
    economics: null,
    conversation: {
      status: 'completed',
      endpoint: 'refusal',
      reason: 'Subject declined',
      timestamp: '2026-09-07T00:00:00Z',
      evidence: {
        path: 'conversation-agent/demo/captures/1.ansi',
        quote: 'I cannot do this',
      },
    },
    gauntlet: {
      status: 'fail',
      summary: 'bad pricing',
      reasoning: 'Oracle found unchanged output',
      run_id: 'demo',
      criteria: [
        {
          criterion: 'Correct pricing',
          verdict: 'fail',
          evidence: 'output/pricing.js: still returns 0',
        },
      ],
    },
    checks: [
      {
        phase: 'post',
        check: 'command-succeeds',
        args: ['oracle'],
        negated: false,
        passed: false,
        detail: 'incorrect total',
      },
    ],
  };
  const out = render(verdict, '/run/demo', { color: false, mode: 'full' });
  for (const text of [
    'Conversation',
    'completed',
    'refusal',
    'Subject declined',
    'conversation-agent/demo/captures/1.ansi',
    'I cannot do this',
    'Assessment',
    'Correct pricing',
    'fail',
    'output/pricing.js: still returns 0',
    'Deterministic checks',
    'incorrect total',
  ])
    expect(out).toContain(text);
  expect(out.indexOf('Conversation')).toBeLessThan(out.indexOf('Assessment'));
});
test('incomplete interaction exposes its stop reason and absent assessment', () => {
  const out = render(
    {
      schema: 1,
      final: 'indeterminate',
      final_reason: 'timeout',
      gauntlet: null,
      checks: [],
      error: null,
      economics: null,
      conversation: {
        status: 'timed_out',
        endpoint: null,
        reason: 'role deadline exceeded',
        timestamp: '2026-09-07T00:00:00Z',
        evidence: null,
      },
    },
    '/run/demo',
    { color: false, mode: 'full' },
  );
  expect(out).toContain('timed_out');
  expect(out).toContain('role deadline exceeded');
  expect(out).toContain('Assessment');
});
