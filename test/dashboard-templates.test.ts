import { expect, test } from 'bun:test';
import type {
  AgentColumns,
  CellView,
  HeaderTally,
  SlotView,
} from '../src/dashboard/contracts.ts';
import { cellKey } from '../src/dashboard/contracts.ts';
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
    bottom: '—',
    face_time: '2m5s',
    face_cost: '$1.25',
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
    face_time: '—',
    face_cost: '—',
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
    face_time: '—',
    face_cost: '—',
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
    face_time: '—',
    face_cost: '—',
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
      face_time: '—',
      face_cost: '—',
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
            time: '2m5s',
            tokens: '12.3k',
            timestamp: '2026-06-12 00:00',
            run_id: '20260612T000000Z-1a2b',
          },
          {
            verdict: 'fail',
            cost: '$0.90',
            time: '1m30s',
            tokens: '—',
            timestamp: '2026-06-12 01:00',
            run_id: '20260612T010000Z-3c4d',
          },
        ],
        drift_line: 'last run cost 1.6× the prior median',
        run_total: '$2.00',
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
  // new: time, tokens, and run-total appear in the card
  expect(html).toContain('class="ccr-dur">2m5s<');
  expect(html).toContain('class="ccr-tok">12.3k<');
  expect(html).toContain('class="card-run-total"');
  expect(html).toContain('run total');
  expect(html).toContain('$2.00');
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
            time: '—',
            tokens: '—',
            timestamp: 't',
            run_id: '<script>',
          },
        ],
        drift_line: 'a & b',
        run_total: '$—',
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
    bottom: '—',
    face_time: '—',
    face_cost: '$0.50',
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
    columns: 12,
    passed: 301,
    failed: 9,
    indeterminate: 4,
    not_run: 226,
    ineligible: 0,
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

test('tallyHtml reports the OS sub-column count and a distinct ineligible segment', () => {
  const tally: HeaderTally = {
    scenarios: 4,
    agents: 3,
    columns: 7,
    passed: 5,
    failed: 1,
    indeterminate: 0,
    not_run: 2,
    ineligible: 3,
  };
  const html = tallyHtml(tally);
  // The sub-column count is reported (OS sub-columns, not just agents).
  expect(html).toContain('7 cells');
  // not_run and ineligible are distinct segments with different counts.
  expect(html).toContain('2 not run');
  expect(html).toContain('class="kineligible">3 ineligible<');
  // not_run is not inflated by ineligible.
  expect(html).not.toContain('5 not run');
});

// --- gridHtml ------------------------------------------------------------------

// --- gridHtml test helpers -----------------------------------------------------

function tally(over: Partial<HeaderTally> = {}): HeaderTally {
  return {
    scenarios: 0,
    agents: 0,
    columns: 0,
    passed: 0,
    failed: 0,
    indeterminate: 0,
    not_run: 0,
    ineligible: 0,
    ...over,
  };
}

// Build a 3-part views map (cellKey) for the cartesian product of scenarios ×
// agentColumns(agent, os).
function viewsFor(
  scenarios: readonly string[],
  agentColumns: readonly AgentColumns[],
): Map<string, CellView> {
  const views = new Map<string, CellView>();
  for (const s of scenarios) {
    for (const ac of agentColumns) {
      for (const os of ac.oses) {
        views.set(
          cellKey(s, ac.agent, os),
          doneView({
            cell_id: `cell-${s}-${ac.agent}-${os}`,
            scenario: s,
            agent: ac.agent,
            os,
          }),
        );
      }
    }
  }
  return views;
}

test('gridHtml renders the matrix table, headers, and row labels', () => {
  const scenarios = ['scn-a', 'scn-b'];
  const agentColumns: AgentColumns[] = [
    { agent: 'claude', oses: ['linux'] },
    { agent: 'codex', oses: ['linux'] },
  ];
  const views = viewsFor(scenarios, agentColumns);
  const html = gridHtml({
    scenarios,
    agentColumns,
    views,
    collapseOsRow: true,
    tally: tally({
      scenarios: 2,
      agents: 2,
      columns: 2,
      passed: 3,
      failed: 1,
    }),
  });
  expect(html).toContain('<table class="mx" id="grid">');
  // read-only: no launch affordances.
  expect(html).not.toContain('data-launch');
  expect(html).not.toContain('class="play"');
  // agent-group headers carry data-agent; OS sub-columns carry data-agent + data-os.
  expect(html).toContain('data-agent="claude"');
  expect(html).toContain('data-agent="codex"');
  expect(html).toContain('data-scenario="scn-a"');
  expect(html).toContain('data-scenario="scn-b"');
  // cells are inlined (3-part cell ids present).
  expect(html).toContain('id="cell-scn-a-claude-linux"');
  expect(html).toContain('id="cell-scn-b-codex-linux"');
});

test('gridHtml escapes scenario and agent names in data attributes and labels', () => {
  const scenarios = ['s&x'];
  const agentColumns: AgentColumns[] = [{ agent: 'a"b', oses: ['linux'] }];
  const views = viewsFor(scenarios, agentColumns);
  const html = gridHtml({
    scenarios,
    agentColumns,
    views,
    collapseOsRow: true,
    tally: tally({ scenarios: 1, agents: 1, columns: 1, passed: 1 }),
  });
  expect(html).toContain('data-agent="a&quot;b"');
  expect(html).toContain('data-scenario="s&amp;x"');
  expect(html).not.toContain('data-agent="a"b"'); // no raw quote breaking the attr
});

test('gridHtml renders one OS sub-column per agent OS with data-os', () => {
  const scenarios = ['scn-a'];
  const agentColumns: AgentColumns[] = [
    { agent: 'claude', oses: ['linux', 'windows'] },
  ];
  const views = viewsFor(scenarios, agentColumns);
  const html = gridHtml({
    scenarios,
    agentColumns,
    views,
    collapseOsRow: false,
    tally: tally({ scenarios: 1, agents: 1, columns: 2 }),
  });
  // The agent header spans both OS sub-columns.
  expect(html).toContain('class="agent-col" data-agent="claude" colspan="2"');
  // Two OS sub-column headers, each with data-agent + data-os.
  expect(html).toContain('class="os-col" data-agent="claude" data-os="linux"');
  expect(html).toContain(
    'class="os-col" data-agent="claude" data-os="windows"',
  );
  // The OS-header row is NOT collapsed when multiple OSes are displayed.
  expect(html).toContain('class="os-header"');
  expect(html).not.toContain('class="os-header collapsed"');
  // Both per-OS cells render.
  expect(html).toContain('id="cell-scn-a-claude-linux"');
  expect(html).toContain('id="cell-scn-a-claude-windows"');
});

test('gridHtml keeps the OS-header row in the DOM (collapsed) for an all-linux grid', () => {
  const scenarios = ['scn-a'];
  const agentColumns: AgentColumns[] = [
    { agent: 'claude', oses: ['linux'] },
    { agent: 'codex', oses: ['linux'] },
  ];
  const views = viewsFor(scenarios, agentColumns);
  const html = gridHtml({
    scenarios,
    agentColumns,
    views,
    collapseOsRow: true,
    tally: tally({ scenarios: 1, agents: 2, columns: 2 }),
  });
  // The OS-header row is present in the DOM, marked collapsed (not removed).
  expect(html).toContain('class="os-header collapsed"');
  // The OS sub-column th is still rendered (DOM-stable column indices).
  expect(html).toContain('class="os-col" data-agent="claude" data-os="linux"');
});

test('gridHtml renders the empty-state message when there are no scenarios or agents', () => {
  const noScenarios = gridHtml({
    scenarios: [],
    agentColumns: [{ agent: 'claude', oses: ['linux'] }],
    views: new Map(),
    collapseOsRow: true,
    tally: tally({ agents: 1, columns: 1 }),
  });
  expect(noScenarios).toContain('class="empty-state"');
  expect(noScenarios).not.toContain('<table class="mx"');

  const noAgents = gridHtml({
    scenarios: ['scn-a'],
    agentColumns: [],
    views: new Map(),
    collapseOsRow: true,
    tally: tally({ scenarios: 1 }),
  });
  expect(noAgents).toContain('class="empty-state"');
  expect(noAgents).not.toContain('<table class="mx"');
});

test('cellHtml carries data-agent and data-os on the cell <td>', () => {
  const html = cellHtml(
    doneView({
      cell_id: 'cell-s-claude-windows',
      scenario: 's',
      agent: 'claude',
      os: 'windows',
    }),
  );
  expect(html).toContain('data-agent="claude"');
  expect(html).toContain('data-os="windows"');
});

test('cellHtml carries data-agent and data-os on an ineligible (c-na) cell', () => {
  const html = cellHtml({
    cell_id: 'cell-s-claude-linux',
    scenario: 's',
    agent: 'claude',
    os: 'linux',
    state: 'empty',
    status: 'ineligible',
    error_stage: null,
    slots: [],
    bottom: '—',
    face_time: '—',
    face_cost: '—',
    drift: false,
    opacity: 0.3,
    card: null,
    title: 'not eligible — directive',
  });
  expect(html).toContain('c-na');
  expect(html).toContain('data-agent="claude"');
  expect(html).toContain('data-os="linux"');
});

// --- layoutHtml ----------------------------------------------------------------

test('layoutHtml wires htmx + the SSE extension and references the static assets', () => {
  const html = layoutHtml({
    tallyHtml: '<b>quorum</b>',
    gridHtml: '<table></table>',
    mode: 'full',
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

test('layoutHtml renders the mode banner only in results-only mode', () => {
  const resultsOnly = layoutHtml({
    tallyHtml: '<b>quorum</b>',
    gridHtml: '<table></table>',
    mode: 'results-only',
  });
  expect(resultsOnly).toContain('class="mode-banner"');
  expect(resultsOnly).toContain('grid-manifest.json not found');

  const full = layoutHtml({
    tallyHtml: '<b>quorum</b>',
    gridHtml: '<table></table>',
    mode: 'full',
  });
  expect(full).not.toContain('mode-banner');
});
