import type {
  CardView,
  CellStatus,
  CellView,
  HeaderTally,
  SlotKind,
  SlotView,
} from './contracts.ts';
import { assertNever } from './invariant.ts';

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
// Each row shows: verdict | agent cost | duration | tokens | timestamp | run_id.
// The card footer shows the run-total cost (gauntlet + agent), labeled.
function cardHtml(card: CardView): string {
  const rows = card.rows
    .map(
      (row) =>
        `<div class="cell-card-row">` +
        `<span class="ccr-verdict v-${esc(row.verdict)}">${esc(row.verdict)}</span>` +
        `<span class="ccr-cost">${esc(row.cost)}</span>` +
        `<span class="ccr-dur">${esc(row.time)}</span>` +
        `<span class="ccr-tok">${esc(row.tokens)}</span>` +
        `<span class="ccr-time">${esc(row.timestamp)}</span>` +
        `<span class="ccr-id">${esc(row.run_id)}</span>` +
        `</div>`,
    )
    .join('');
  const drift =
    card.drift_line !== null
      ? `<div class="card-drift">${esc(card.drift_line)}</div>`
      : '';
  const runTotal =
    `<div class="card-run-total">` +
    `<span class="crt-label">run total</span>` +
    `<span class="crt-value">${esc(card.run_total)}</span>` +
    `</div>`;
  return (
    `<div class="cell-card" data-card hidden>` +
    `<div class="cell-card-age">${esc(card.age)}</div>` +
    `<div class="cell-card-rows">${rows}</div>` +
    drift +
    runTotal +
    `</div>`
  );
}

// The status glyph and CSS class for a cell outcome status. Each status gets
// a distinct shape glyph so the triad is not color-only.
function statusGlyph(status: CellStatus): { glyph: string; cls: string } {
  switch (status) {
    case 'pass':
      return { glyph: '✓', cls: 'status-pass' };
    case 'failed':
      return { glyph: '✗', cls: 'status-failed' };
    case 'incomplete':
      return { glyph: '~', cls: 'status-incomplete' };
    case 'not_run':
      return { glyph: '·', cls: 'status-not_run' };
    case 'ineligible':
      return { glyph: '·', cls: 'status-ineligible' };
  }
}

// The cell <td>. The single source of truth for first paint and SSE swaps: the
// <td> carries id + sse-swap both equal to the cell id and hx-swap="outerHTML",
// so each cell listens for its own SSE event and a swap never bleeds into a
// neighbour. Empty cells short-circuit to the em-dash placeholder.
export function cellHtml(view: CellView): string {
  const id = esc(view.cell_id);
  const open = `<td class="c" id="${id}" sse-swap="${id}" hx-swap="outerHTML">`;

  if (view.state === 'empty') {
    const sg = statusGlyph(view.status);
    // Ineligible cell: title set by server (naTitle), opacity dimmed, status
    // class carries the ineligible glyph. This is the ONE ineligible rendering
    // path — the title/opacity overlay from server.ts handles the tooltip/dim;
    // the status span here handles the glyph.
    if (view.title !== undefined) {
      return (
        `<td class="c c-na" id="${id}" sse-swap="${id}" hx-swap="outerHTML" title="${esc(view.title)}">` +
        `<div class="cell" style="opacity:${f3(view.opacity)}">` +
        `<span class="${sg.cls}">${sg.glyph}</span></div></td>`
      );
    }
    // not_run: plain middle-dot, no tooltip, default opacity.
    return (
      `${open}` +
      `<div class="cell"><span class="${sg.cls}">${sg.glyph}</span></div>` +
      `</td>`
    );
  }

  const stateClass = view.state === 'running' ? ' running' : '';

  const drift = view.drift ? `<span class="drift">▲</span>` : '';
  const card = view.card !== null ? cardHtml(view.card) : '';

  // Status glyph: shown for done cells. For running cells, the shimmer
  // communicates in-progress state — skip the outcome glyph.
  const sg = statusGlyph(view.status);
  // For incomplete cells, surface the error stage (if any) as a tooltip on
  // the status glyph so it's visible on hover without consuming bottom space.
  const stageTitle =
    view.status === 'incomplete' && view.error_stage !== null
      ? ` title="${esc(view.error_stage)}"`
      : '';
  const statusSpan =
    view.state !== 'running'
      ? `<span class="${sg.cls}"${stageTitle}>${sg.glyph}</span>`
      : '';

  // For done cells: two-line face (time headline + agent cost).
  // For running cells: phase word. Bottom is '—' for done cells (not rendered).
  let faceHtml: string;
  if (view.state === 'done') {
    faceHtml =
      `<div class="dc">` +
      `${drift}${statusSpan}` +
      `<span class="face-time">${esc(view.face_time)}</span>` +
      `<span class="face-cost">${esc(view.face_cost)}</span>` +
      `</div>`;
  } else {
    faceHtml = `<div class="dc">${drift}${statusSpan}${esc(view.bottom)}</div>`;
  }

  return (
    `${open}` +
    `<div class="cell${stateClass}" style="opacity:${f3(view.opacity)}">` +
    `<div class="inner">` +
    `<div class="vs">${ribbonHtml(view.slots)}</div>` +
    `<div class="cb">${costBarHtml(view.slots)}</div>` +
    faceHtml +
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

export interface GridArgs {
  readonly scenarios: readonly string[];
  readonly agents: readonly string[];
  // Keyed by `${scenario}\t${agent}` (cellKey). Every (scenario, agent) pair
  // in the cartesian product must be present.
  readonly views: ReadonlyMap<string, CellView>;
  readonly tally: HeaderTally;
}

// The matrix table. Sticky-header table with per-agent column headers,
// per-scenario row labels, and inlined cell <td>s. Read-only: no launch
// affordances.
export function gridHtml(args: GridArgs): string {
  const { scenarios, agents, views } = args;

  const headerCells = agents
    .map((agent) => `<th data-agent="${esc(agent)}">${esc(agent)}</th>`)
    .join('');

  const bodyRows = scenarios
    .map((scenario) => {
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
              // The server populates every (scenario, agent) pair, so this
              // fallback is defensive only; os is unknown here (Task 7 adds the
              // OS column header to this table).
              os: '',
              state: 'empty',
              status: 'not_run',
              error_stage: null,
              slots: [],
              bottom: '—',
              face_time: '—',
              face_cost: '—',
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
        `<td class="rl" data-scenario="${esc(scenario)}">${esc(scenario)}</td>` +
        cells +
        `</tr>`
      );
    })
    .join('');

  return (
    `<table class="mx" id="grid">` +
    `<thead><tr class="agent-header">` +
    `<th class="corner"></th>${headerCells}</tr></thead>` +
    `<tbody>${bodyRows}</tbody>` +
    `</table>`
  );
}

// The full page. References the vendored static assets and wires the SSE
// extension on <body> (hx-ext="sse" + sse-connect="/events"). The tally + grid
// bodies are already-rendered HTML inlined unescaped.
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
    `  <div class="mxwrap">${args.gridHtml}</div>\n` +
    `  <div id="card-host"></div>\n` +
    `  <script src="/static/app.js" defer></script>\n` +
    `</body>\n` +
    `</html>\n`
  );
}
