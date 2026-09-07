import { expect, test } from 'bun:test';
import { render } from '../src/cli/render.ts';
import type { FinalVerdict } from '../src/contracts/verdict.ts';

// Parity with show.py:_format_economics_pane, whose only gate is `if not econ`.
// An off-type field (e.g. a string total_est_cost_usd) must still render a
// (degraded) Economics pane via the _fmt_* helpers — NOT drop the whole pane.

function verdictWith(economics: Record<string, unknown>): FinalVerdict {
  return {
    schema: 1,
    final: 'pass',
    final_reason: 'because',
    gauntlet: null,
    checks: [],
    error: null,
    economics,
  } as FinalVerdict;
}

test('an off-type total_est_cost_usd still renders the Economics pane (degraded)', () => {
  const verdict = verdictWith({
    gauntlet: { duration_ms: 1000, est_cost_usd: 1.5 },
    coding_agent: { duration_ms: 2000, est_cost_usd: 2.5 },
    total_est_cost_usd: 'lots',
  });
  const out = render(verdict, '/run/x', { color: false, mode: 'full' });
  // The pane header must be present (the pane is NOT dropped).
  expect(out).toContain('Economics');
  // The degraded total renders as n/a (a string cost is not a number).
  const totalLine = out.split('\n').find((l) => l.includes('total'));
  expect(totalLine).toBeDefined();
  expect(totalLine).toContain('n/a');
});

test('a well-typed economics block still renders the total cost', () => {
  const verdict = verdictWith({
    gauntlet: { duration_ms: 1000, est_cost_usd: 1.5 },
    coding_agent: { duration_ms: 2000, est_cost_usd: 2.5 },
    total_est_cost_usd: 4,
  });
  const out = render(verdict, '/run/x', { color: false, mode: 'full' });
  expect(out).toContain('Economics');
  const totalLine = out.split('\n').find((l) => l.includes('total'));
  expect(totalLine).toContain('$4.00');
});

test('an off-type est_cost_usd in a block degrades that cost cell, pane still renders', () => {
  const verdict = verdictWith({
    gauntlet: { duration_ms: 1000, est_cost_usd: 'nope' },
    coding_agent: { duration_ms: 2000, est_cost_usd: 2.5 },
    total_est_cost_usd: 2.5,
  });
  const out = render(verdict, '/run/x', { color: false, mode: 'full' });
  expect(out).toContain('Economics');
  // The Economics Gauntlet ROW (indented "  Gauntlet ...") degrades its cost to
  // n/a; the Coding row keeps its cost. (The "Gauntlet-Agent" pane header is a
  // different, separator line.)
  const gauntletRow = out.split('\n').find((l) => l.startsWith('  Gauntlet'));
  expect(gauntletRow).toBeDefined();
  expect(gauntletRow).toContain('n/a');
});

test('role cost rows distinguish missing started usage from assessment not run', () => {
  const base = {
    gauntlet: {
      est_cost_usd: 0.1,
      roles: {
        conversation: {
          status: 'started',
          duration_ms: 1000,
          usage: { total_tokens: 1000, est_cost_usd: 0.1 },
        },
        assessment: { status: 'not_run', duration_ms: null, usage: null },
      },
    },
    partial: true,
    total_est_cost_usd: null,
  };
  let out = render(verdictWith(base), '/run/x', { color: false, mode: 'full' });
  expect(
    out.split('\n').find((line) => line.trimStart().startsWith('Conversation')),
  ).toContain('$0.10');
  expect(
    out.split('\n').find((line) => line.trimStart().startsWith('Assessment')),
  ).toContain('not run');
  base.gauntlet.roles.assessment.status = 'started';
  out = render(verdictWith(base), '/run/x', { color: false, mode: 'full' });
  expect(
    out.split('\n').find((line) => line.trimStart().startsWith('Assessment')),
  ).toContain('usage missing');
});
