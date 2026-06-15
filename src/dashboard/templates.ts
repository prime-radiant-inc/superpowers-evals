import { assertNever } from '../invariant.ts';
import type {
  CardView,
  CellView,
  HeaderTally,
  SlotKind,
  SlotView,
} from './contracts.ts';

// Typed template-literal HTML renderers. No templating dependency — pure string
// functions, no IO. Every class name and data-* attribute here must match what
// the static styles.css + app.js couple on, so those assets work unchanged.
//
// cellHtml is the single source of truth for first paint AND SSE swaps. Every
// interpolated scenario/agent/run_id/cost string is run through esc().

// HTML-escape the five metacharacters that can break an attribute or element
// body. Ampersand first so existing entities are not double-broken on the wrong
// side (we escape the `&` once, intentionally, rather than skip it).
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

// Escape the five HTML metacharacters. A single regex `.replace` over the
// metacharacter class (not a `.replaceAll` chain) so CodeQL's XSS sanitizer
// model recognizes it as a complete HTML escaper. The `?? ch` is unreachable
// (every matched char is a key) but satisfies noUncheckedIndexedAccess.
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

// Three-decimal fixed format, used for cost-bar heights and cell opacity.
function f3(n: number): string {
  return n.toFixed(3);
}

// The verdict-ribbon band class for a resolved slot kind. ghost/running are
// handled inline; the rest map to b-* band classes; unknown is the catch-all.
function bandClass(kind: SlotKind): string {
  switch (kind) {
    case 'ghost':
      return 'vs-slot ghost';
    case 'running':
      return 'vs-slot runslot';
    case 'fail':
      return 'vs-slot b-fail';
    case 'indeterminate':
      return 'vs-slot b-indet';
    case 'pass':
      return 'vs-slot b-pass';
    case 'unknown':
      return 'vs-slot b-unknown';
    default:
      return assertNever(kind);
  }
}

// The verdict-ribbon row (`.vs`): one band per slot, left-to-right (newest
// rightmost; ghost padding already on the left from cellView).
function ribbonHtml(slots: readonly SlotView[]): string {
  return slots
    .map((slot) => `<i class="${bandClass(slot.kind)}"></i>`)
    .join('');
}

// The cost-bar row (`.cb`): ghost/running slots use the 0.18 height floor via the
// `gh` class; resolved slots carry their normalized height in the inline `--h`
// custom property the CSS reads (height: calc(2px + var(--h) * 12px)).
function costBarHtml(slots: readonly SlotView[]): string {
  return slots
    .map((slot) => {
      if (slot.kind === 'ghost' || slot.kind === 'running') {
        return '<i class="cb-slot gh" style="--h:0.180"></i>';
      }
      return `<i class="cb-slot" style="--h:${f3(slot.height)}"></i>`;
    })
    .join('');
}

// The detail hover card (`.cell-card[data-card][hidden]`). Rendered inside the
// cell so SSE partial swaps carry it; app.js clones it to #card-host on hover.
// Rows are oldest..newest. Every interpolated string is escaped.
function cardHtml(card: CardView): string {
  const rows = card.rows
    .map(
      (row) =>
        `<div class="cell-card-row">` +
        `<span class="ccr-verdict v-${esc(row.verdict)}">${esc(row.verdict)}</span>` +
        `<span class="ccr-cost">${esc(row.cost)}</span>` +
        `<span class="ccr-time">${esc(row.timestamp)}</span>` +
        `<span class="ccr-id">${esc(row.run_id)}</span>` +
        `</div>`,
    )
    .join('');
  const drift =
    card.drift_line !== null
      ? `<div class="card-drift">${esc(card.drift_line)}</div>`
      : '';
  return (
    `<div class="cell-card" data-card hidden>` +
    `<div class="cell-card-age">${esc(card.age)}</div>` +
    `<div class="cell-card-rows">${rows}</div>` +
    drift +
    `</div>`
  );
}

// The cell <td>. The single source of truth for first paint and SSE swaps: the
// <td> carries id + sse-swap both equal to the cell id and hx-swap="outerHTML",
// so each cell listens for its own SSE event and a swap never bleeds into a
// neighbour. Empty cells short-circuit to the em-dash placeholder.
export function cellHtml(view: CellView): string {
  const id = esc(view.cell_id);
  const open = `<td class="c" id="${id}" sse-swap="${id}" hx-swap="outerHTML">`;

  if (view.state === 'empty') {
    // A "not applicable" cell (title set) can never run here (directive/draft):
    // dim it, show "n/a", and carry a hover tooltip explaining why — visually
    // distinct from a plain never-run cell, which shows the em-dash.
    if (view.title !== undefined) {
      return (
        `<td class="c c-na" id="${id}" sse-swap="${id}" hx-swap="outerHTML" title="${esc(view.title)}">` +
        `<div class="cell" style="opacity:${f3(view.opacity)}">` +
        `<span class="empty">n/a</span></div></td>`
      );
    }
    return `${open}<div class="cell"><span class="empty">—</span></div></td>`;
  }

  const stateClass =
    view.state === 'running'
      ? ' running'
      : view.state === 'queued'
        ? ' queued'
        : '';

  const drift = view.drift ? `<span class="drift">▲</span>` : '';
  const card = view.card !== null ? cardHtml(view.card) : '';

  return (
    `${open}` +
    `<div class="cell${stateClass}" style="opacity:${f3(view.opacity)}">` +
    `<div class="inner">` +
    `<div class="vs">${ribbonHtml(view.slots)}</div>` +
    `<div class="cb">${costBarHtml(view.slots)}</div>` +
    `<div class="dc">${drift}${esc(view.bottom)}</div>` +
    `</div>` +
    card +
    `</div>` +
    `</td>`
  );
}

// The header tally line (`.pghead` body):
//   quorum · N scenarios × M agents · P pass · F fail · I indeterminate · X not run
// Counts are integers, so no escaping is needed.
export function tallyHtml(tally: HeaderTally): string {
  const sep = `<span class="sep">·</span>`;
  return (
    `<b>quorum</b>${sep}` +
    `${tally.scenarios} scenarios × ${tally.agents} agents` +
    `${sep}<span class="kpass">${tally.passed} pass</span>` +
    `${sep}<span class="kfail">${tally.failed} fail</span>` +
    `${sep}<span class="kindet">${tally.indeterminate} indeterminate</span>` +
    `${sep}${tally.not_run} not run`
  );
}

// The run strip (`#runbar` body), swapped in by the `strip` SSE event:
// "Running N · M in flight · K done · $X spent · ■ Stop". The `.stop` element is
// what app.js's click handler keys off to POST /stop.
export interface RunStripArgs {
  readonly running: number;
  readonly inFlight: number;
  readonly done: number;
  readonly spent: number;
}

export function runStripHtml(a: RunStripArgs): string {
  return (
    `<div class="runbar"><span class="spin"></span>` +
    `<span><b>Running ${a.running}</b> · ${a.inFlight} in flight · ${a.done} done</span>` +
    `<span class="sub">$${a.spent.toFixed(2)} spent</span>` +
    `<span class="stop">■ Stop</span></div>`
  );
}

// Pre-formatted launch estimates: a fixed-2 dollar string or "" when unknown.
// Carried verbatim in the `data-estimate` attribute, which app.js re-parses with
// parseFloat (NaN ⇒ "~$—").
export interface GridEstimates {
  readonly row: Readonly<Record<string, string>>;
  readonly column: Readonly<Record<string, string>>;
}

// Per-column (agent) and per-row (scenario) RUNNABLE cell counts — what a
// column/row launch will actually run. Surfaced in `data-count` so app.js's
// confirm reads "Run N cells" (build spec) instead of the placeholder "Run ?".
export interface GridCounts {
  readonly row: Readonly<Record<string, number>>;
  readonly column: Readonly<Record<string, number>>;
}

export interface GridArgs {
  readonly scenarios: readonly string[];
  readonly agents: readonly string[];
  // Keyed by `${scenario}\t${agent}` (cellKey). Every (scenario, agent) pair
  // in the cartesian product must be present.
  readonly views: ReadonlyMap<string, CellView>;
  readonly tally: HeaderTally;
  readonly estimates: GridEstimates;
  readonly counts: GridCounts;
}

// The matrix table (`grid.html.j2`). Sticky-header table with the run-all corner
// button, per-agent column headers (data-launch="column"), per-scenario row
// labels (data-launch="row"), and inlined cell <td>s. data-count on the run-all
// button is the runnable total = pass+fail+indeterminate+not_run.
export function gridHtml(args: GridArgs): string {
  const { scenarios, agents, views, tally, estimates, counts } = args;

  const runnableCount =
    tally.passed + tally.failed + tally.indeterminate + tally.not_run;

  const headerCells = agents
    .map((agent) => {
      const est = esc(estimates.column[agent] ?? '');
      const count = counts.column[agent] ?? 0;
      return (
        `<th data-launch="column" data-agent="${esc(agent)}" data-count="${count}" data-estimate="${est}">` +
        `${esc(agent)}<span class="play">▶</span></th>`
      );
    })
    .join('');

  const bodyRows = scenarios
    .map((scenario) => {
      const est = esc(estimates.row[scenario] ?? '');
      const rowCount = counts.row[scenario] ?? 0;
      const cells = agents
        .map((agent) => {
          const view = views.get(`${scenario}\t${agent}`);
          // Every cartesian pair is expected; fall back to an empty cell rather
          // than throwing so a partial views map still renders a full grid.
          if (view === undefined) {
            return cellHtml({
              cell_id: `cell-${scenario}-${agent}`,
              scenario,
              agent,
              state: 'empty',
              slots: [],
              bottom: '—',
              drift: false,
              opacity: 1,
              card: null,
            });
          }
          return cellHtml(view);
        })
        .join('');
      return (
        `<tr>` +
        `<td class="rl" data-launch="row" data-scenario="${esc(scenario)}" data-count="${rowCount}" data-estimate="${est}">` +
        `<span class="play">▶</span>${esc(scenario)}</td>` +
        cells +
        `</tr>`
      );
    })
    .join('');

  return (
    `<table class="mx" id="grid">` +
    `<thead><tr class="agent-header">` +
    `<th class="corner">` +
    `<span class="allbtn" data-launch="all" data-count="${runnableCount}">▶ Run all</span>` +
    `</th>${headerCells}</tr></thead>` +
    `<tbody>${bodyRows}</tbody>` +
    `</table>`
  );
}

// The full page. References the vendored static assets and wires the SSE
// extension on <body> (hx-ext="sse" + sse-connect="/events"). The tally + grid
// bodies are already-rendered HTML inlined unescaped. #runbar is the strip swap
// target (sse-swap="strip").
export interface LayoutArgs {
  readonly tallyHtml: string;
  readonly gridHtml: string;
}

export function layoutHtml(args: LayoutArgs): string {
  return (
    `<!doctype html>\n` +
    `<html lang="en" data-theme="dark">\n` +
    `<head>\n` +
    `  <meta charset="utf-8">\n` +
    `  <meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `  <title>quorum dashboard</title>\n` +
    `  <link rel="stylesheet" href="/static/styles.css">\n` +
    `  <script src="/static/htmx.min.js" defer></script>\n` +
    `  <script src="/static/htmx-ext-sse.js" defer></script>\n` +
    `</head>\n` +
    `<body hx-ext="sse" sse-connect="/events">\n` +
    `  <div class="pghead" id="tally">${args.tallyHtml}</div>\n` +
    `  <div class="runbar-slot" id="runbar" sse-swap="strip" hx-swap="innerHTML"></div>\n` +
    `  <div class="mxwrap">${args.gridHtml}</div>\n` +
    `  <div id="confirm-host"></div>\n` +
    `  <div id="card-host"></div>\n` +
    `  <script src="/static/app.js" defer></script>\n` +
    `</body>\n` +
    `</html>\n`
  );
}
