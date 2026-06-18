import { expect, test } from 'bun:test';
import type {
  CellView,
  HeaderTally,
  SlotView,
} from '../src/dashboard/contracts.ts';
import {
  cellHtml,
  esc,
  gridHtml,
  layoutHtml,
  tallyHtml,
} from '../src/dashboard/templates.ts';

// Typed template-literal renderers (Task 8). These tests pin the parity-critical
// htmx wiring + class/data-attr contract the copied CSS/JS depend on — not exact
// whitespace. Reference: .worktrees/dashboard-ref/quorum/dashboard/templates/*.j2
// + app.py (_tally_html / _run_strip_html).

// --- small helpers to build views without IO ----------------------------------

function ghostSlots(): SlotView[] {
  return Array.from({ length: 5 }, () => ({ kind: 'ghost', height: 0.18 }));
}

function doneView(over: Partial<CellView> = {}): CellView {
  return {
    cell_id: 'cell-s-claude',
    scenario: 's',
    agent: 'claude',
    os: 'linux',
    state: 'done',
    status: 'pass',
    error_stage: null,
    slots: [
      { kind: 'ghost', height: 0.18 },
      { kind: 'ghost', height: 0.18 },
      { kind: 'pass', height: 0.25 },
      { kind: 'fail', height: 0.5 },
      { kind: 'pass', height: 1 },
    ],
    bottom: '$1.25',
    drift: false,
    opacity: 0.84,
    card: null,
    ...over,
  };
}

// --- esc -----------------------------------------------------------------------

test('esc escapes HTML metacharacters', () => {
  expect(esc('a&b<c>"d"')).toBe('a&amp;b&lt;c&gt;&quot;d&quot;');
});

test('esc escapes the single quote (complete sanitizer; CodeQL XSS guard)', () => {
  expect(esc("it's <a href='x'>")).toBe('it&#39;s &lt;a href=&#39;x&#39;&gt;');
});

test('esc escapes ampersand first (no double-encoding)', () => {
  expect(esc('&lt;')).toBe('&amp;lt;');
});

test('esc leaves ordinary text untouched', () => {
  expect(esc('sdd-elicited claude-haiku')).toBe('sdd-elicited claude-haiku');
});

// --- cellHtml: the single source of truth (first paint + SSE swap) -------------

test('cellHtml emits id + sse-swap = cell-<scenario>-<agent> and hx-swap outerHTML', () => {
  const html = cellHtml(doneView());
  expect(html).toContain('id="cell-s-claude"');
  expect(html).toContain('sse-swap="cell-s-claude"');
  expect(html).toContain('hx-swap="outerHTML"');
  expect(html).toContain('class="c"');
});

test('cellHtml escapes the cell id (scenario/agent are interpolated)', () => {
  const html = cellHtml(
    doneView({ cell_id: 'cell-a&b-x"y', scenario: 'a&b', agent: 'x"y' }),
  );
  // The id/sse-swap attribute values must be escaped to stay well-formed HTML.
  expect(html).toContain('id="cell-a&amp;b-x&quot;y"');
  expect(html).toContain('sse-swap="cell-a&amp;b-x&quot;y"');
  expect(html).not.toContain('x"y"'); // no raw quote leaking out of the attr
});

// --- cell-state smoke matrix ---------------------------------------------------

test('empty cell renders the not_run glyph (middle dot) and no inner ribbon', () => {
  const html = cellHtml({
    cell_id: 'cell-s-claude',
    scenario: 's',
    agent: 'claude',
    os: 'linux',
    state: 'empty',
    status: 'not_run',
    error_stage: null,
    slots: ghostSlots(),
    bottom: '—',
    drift: false,
    opacity: 1,
    card: null,
  });
  expect(html).toContain('id="cell-s-claude"');
  expect(html).toContain('class="status-not_run"');
  expect(html).not.toContain('class="inner"');
  expect(html).not.toContain('class="vs"');
});

test('ineligible cell (title set) renders dimmed ineligible glyph + tooltip', () => {
  const html = cellHtml({
    cell_id: 'cell-s-claude',
    scenario: 's',
    agent: 'claude',
    os: 'linux',
    state: 'empty',
    status: 'ineligible',
    error_stage: null,
    slots: ghostSlots(),
    bottom: '—',
    drift: false,
    opacity: 0.3,
    card: null,
    title: 'not eligible — directive',
  });
  expect(html).toContain('c-na');
  expect(html).toContain('title="not eligible — directive"');
  expect(html).toContain('class="status-ineligible"');
  expect(html).toContain('opacity:0.300');
});

test('done cell carries solid bands, a cost-bar with --h, and the cost bottom', () => {
  const html = cellHtml(doneView());
  expect(html).toContain('class="vs-slot b-pass"');
  expect(html).toContain('class="vs-slot b-fail"'); // fail hatch band
  expect(html).toContain('class="vs-slot ghost"'); // left padding
  // cost-bar slots: ghosts use the 0.18 floor, real slots carry their height.
  expect(html).toContain('class="cb-slot gh" style="--h:0.180"');
  expect(html).toContain('class="cb-slot" style="--h:1.000"');
  expect(html).toContain('$1.25');
  expect(html).not.toContain('class="drift"'); // no drift marker
});

test('done cell with drift shows the ▲ marker before the cost', () => {
  const html = cellHtml(doneView({ drift: true }));
  expect(html).toContain('<span class="drift">▲</span>');
  // drift sits to the left of the dollar amount.
  expect(html.indexOf('▲')).toBeLessThan(html.indexOf('$1.25'));
});

test('opacity is rendered to 3 decimals on the cell wrapper', () => {
  const html = cellHtml(doneView({ opacity: 0.84 }));
  expect(html).toContain('style="opacity:0.840"');
});

test('running cell carries the running class, a shimmer runslot, and the phase bottom', () => {
  const html = cellHtml({
    cell_id: 'cell-s-claude',
    scenario: 's',
    agent: 'claude',
    os: 'linux',
    state: 'running',
    status: 'not_run',
    error_stage: null,
    slots: [
      { kind: 'ghost', height: 0.18 },
      { kind: 'ghost', height: 0.18 },
      { kind: 'pass', height: 0.5 },
      { kind: 'pass', height: 1 },
      { kind: 'running', height: 0.18 },
    ],
    bottom: 'agent',
    drift: false,
    opacity: 1,
    card: null,
  });
  expect(html).toContain('class="cell running"');
  expect(html).toContain('class="vs-slot runslot"'); // shimmer band
  // the running slot in the cost-bar also uses the gh/0.18 floor.
  expect(html).toContain('class="cb-slot gh" style="--h:0.180"');
  expect(html).toContain('agent'); // phase word, not a cost
  expect(html).not.toContain('$'); // no cost while in flight
});

test('running cell renders the queued-phase word verbatim for each phase', () => {
  for (const phase of ['setup', 'agent', 'checks']) {
    const html = cellHtml({
      cell_id: 'cell-s-claude',
      scenario: 's',
      agent: 'claude',
      os: 'linux',
      state: 'running',
      status: 'not_run',
      error_stage: null,
      slots: ghostSlots(),
      bottom: phase,
      drift: false,
      opacity: 1,
      card: null,
    });
    expect(html).toContain(`>${phase}`);
  }
});

test('a padded <5-window cell left-pads ghosts (newest rightmost)', () => {
  // Two real runs, three ghost pads on the left.
  const html = cellHtml(
    doneView({
      slots: [
        { kind: 'ghost', height: 0.18 },
        { kind: 'ghost', height: 0.18 },
        { kind: 'ghost', height: 0.18 },
        { kind: 'pass', height: 0.4 },
        { kind: 'pass', height: 1 },
      ],
    }),
  );
  const ghostCount = html.split('class="vs-slot ghost"').length - 1;
  expect(ghostCount).toBe(3);
  const passCount = html.split('class="vs-slot b-pass"').length - 1;
  expect(passCount).toBe(2);
});

test('indeterminate and unknown bands map to b-indet / b-unknown', () => {
  const html = cellHtml(
    doneView({
      slots: [
        { kind: 'ghost', height: 0.18 },
        { kind: 'ghost', height: 0.18 },
        { kind: 'ghost', height: 0.18 },
        { kind: 'indeterminate', height: 0.5 },
        { kind: 'unknown', height: 1 },
      ],
    }),
  );
  expect(html).toContain('class="vs-slot b-indet"');
  expect(html).toContain('class="vs-slot b-unknown"');
});

// --- detail hover card ---------------------------------------------------------

test('cellHtml renders the detail card markup when card is present', () => {
  const html = cellHtml(
    doneView({
      card: {
        age: '3h',
        rows: [
          {
            verdict: 'pass',
            cost: '$1.25',
            timestamp: '2026-06-12 00:00',
            run_id: '20260612T000000Z-1a2b',
          },
          {
            verdict: 'fail',
            cost: '$0.90',
            timestamp: '2026-06-12 01:00',
            run_id: '20260612T010000Z-3c4d',
          },
        ],
        drift_line: 'last run cost 1.6× the prior median',
      },
    }),
  );
  expect(html).toContain('class="cell-card" data-card hidden');
  expect(html).toContain('class="cell-card-age">3h<');
  expect(html).toContain('class="ccr-verdict v-pass">pass<');
  expect(html).toContain('class="ccr-verdict v-fail">fail<');
  expect(html).toContain('20260612T000000Z-1a2b');
  expect(html).toContain(
    'class="card-drift">last run cost 1.6× the prior median<',
  );
});

test('cellHtml omits the card block when card is null', () => {
  const html = cellHtml(doneView({ card: null }));
  expect(html).not.toContain('data-card');
  expect(html).not.toContain('cell-card');
});

test('cellHtml escapes card row run_id and drift_line', () => {
  const html = cellHtml(
    doneView({
      card: {
        age: '3h',
        rows: [
          {
            verdict: 'pass',
            cost: '$1.25',
            timestamp: 't',
            run_id: '<script>',
          },
        ],
        drift_line: 'a & b',
      },
    }),
  );
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).toContain('a &amp; b');
});

test('incomplete cell with error_stage shows stage as tooltip on status glyph', () => {
  const html = cellHtml({
    cell_id: 'cell-s-claude-linux',
    scenario: 's',
    agent: 'claude',
    os: 'linux',
    state: 'done',
    status: 'incomplete',
    error_stage: 'checks',
    slots: [
      { kind: 'ghost', height: 0.18 },
      { kind: 'ghost', height: 0.18 },
      { kind: 'ghost', height: 0.18 },
      { kind: 'ghost', height: 0.18 },
      { kind: 'unknown', height: 0.5 },
    ],
    bottom: '$0.50',
    drift: false,
    opacity: 1,
    card: null,
  });
  expect(html).toContain('title="checks"');
  expect(html).toContain('class="status-incomplete"');
});

// --- tallyHtml -----------------------------------------------------------------

test('tallyHtml renders the quorum header tally line', () => {
  const tally: HeaderTally = {
    scenarios: 54,
    agents: 10,
    passed: 301,
    failed: 9,
    indeterminate: 4,
    not_run: 226,
  };
  const html = tallyHtml(tally);
  expect(html).toContain('<b>quorum</b>');
  expect(html).toContain('54 scenarios × 10 agents');
  expect(html).toContain('class="kpass">301 pass<');
  expect(html).toContain('class="kfail">9 fail<');
  expect(html).toContain('class="kindet">4 indeterminate<');
  expect(html).toContain('226 not run');
  expect(html).toContain('class="sep">·<');
});

// --- gridHtml ------------------------------------------------------------------

test('gridHtml renders the matrix table, headers, and row labels', () => {
  const scenarios = ['scn-a', 'scn-b'];
  const agents = ['claude', 'codex'];
  const views = new Map<string, CellView>();
  for (const s of scenarios) {
    for (const a of agents) {
      views.set(
        `${s}\t${a}`,
        doneView({ cell_id: `cell-${s}-${a}`, scenario: s, agent: a }),
      );
    }
  }
  const tally: HeaderTally = {
    scenarios: 2,
    agents: 2,
    passed: 3,
    failed: 1,
    indeterminate: 0,
    not_run: 0,
  };
  const html = gridHtml({
    scenarios,
    agents,
    views,
    tally,
  });
  expect(html).toContain('<table class="mx" id="grid">');
  // read-only: no launch affordances.
  expect(html).not.toContain('data-launch');
  expect(html).not.toContain('class="play"');
  // column headers carry data-agent; row labels carry data-scenario.
  expect(html).toContain('<th data-agent="claude">claude</th>');
  expect(html).toContain('<th data-agent="codex">codex</th>');
  expect(html).toContain('data-scenario="scn-a"');
  expect(html).toContain('data-scenario="scn-b"');
  // cells are inlined (cell ids present).
  expect(html).toContain('id="cell-scn-a-claude"');
  expect(html).toContain('id="cell-scn-b-codex"');
});

test('gridHtml escapes scenario and agent names in data attributes and labels', () => {
  const scenarios = ['s&x'];
  const agents = ['a"b'];
  const views = new Map<string, CellView>();
  views.set(
    's&x\ta"b',
    doneView({ cell_id: 'cell-s&x-a"b', scenario: 's&x', agent: 'a"b' }),
  );
  const html = gridHtml({
    scenarios,
    agents,
    views,
    tally: {
      scenarios: 1,
      agents: 1,
      passed: 1,
      failed: 0,
      indeterminate: 0,
      not_run: 0,
    },
  });
  expect(html).toContain('data-agent="a&quot;b"');
  expect(html).toContain('data-scenario="s&amp;x"');
  expect(html).not.toContain('data-agent="a"b"'); // no raw quote breaking the attr
});

// --- layoutHtml ----------------------------------------------------------------

test('layoutHtml wires htmx + the SSE extension and references the static assets', () => {
  const html = layoutHtml({
    tallyHtml: '<b>quorum</b>',
    gridHtml: '<table></table>',
  });
  expect(html).toContain('<!doctype html>');
  expect(html).toContain('data-theme="dark"');
  expect(html).toContain('href="/static/styles.css"');
  expect(html).toContain('src="/static/htmx.min.js"');
  expect(html).toContain('src="/static/htmx-ext-sse.js"');
  expect(html).toContain('src="/static/app.js"');
  // SSE wiring on the body.
  expect(html).toContain('hx-ext="sse"');
  expect(html).toContain('sse-connect="/events"');
  // tally + grid + the detail card host (read-only: no runbar/confirm host).
  expect(html).toContain('id="tally"');
  expect(html).toContain('id="card-host"');
  expect(html).not.toContain('id="runbar"');
  expect(html).not.toContain('id="confirm-host"');
  // the slotted bodies are inlined unescaped (already-rendered HTML).
  expect(html).toContain('<b>quorum</b>');
  expect(html).toContain('<table></table>');
});
