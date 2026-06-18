import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Cell, cellId, cellKey, type Grid } from './contracts.ts';
import { EventBus } from './event-bus.ts';
import type { GridManifest } from './manifest.ts';
import { scanResults } from './scan.ts';
import { cellHtml, gridHtml, layoutHtml, tallyHtml } from './templates.ts';
import { type CellIdentity, cellView, diffGrids, headerTally } from './view.ts';

// The Bun.serve fetch handler + scanner loop for the quorum dashboard. Native
// Bun.serve + a ReadableStream SSE body; no external web stack. Read-only: the
// filesystem is the single source of truth and the dashboard never launches runs.
//
// The dashboard imports NOTHING from the harness: its only inputs are the
// filesystem — results/ (via scanResults) and grid-manifest.json (the eligibility
// matrix, passed in as `manifest`). When the manifest is null it falls back to a
// results-only grid (only cells with observed runs).
//
// Three layers:
//  - GET /            warm scan -> full grid (first paint).
//  - GET /events      one SSE stream per client; cell partials.
//  - GET /static/*    the vendored CSS/JS/fonts.
//
// The SCANNER pushes on filesystem diff every ~1s while a client is connected —
// it picks up phase.json advances and verdict.json landings (the `running` cell
// state is scan-detected liveness: a run dir with phase.json + a live pid and no
// verdict yet). The cell partial is an idempotent full-state swap.

export interface CreateDashboardArgs {
  readonly resultsRoot: string;
  readonly knownAgents: readonly string[];
  // The scenario × agent × os eligibility matrix, or null (results-only board).
  readonly manifest: GridManifest | null;
}

export interface Dashboard {
  fetch(req: Request): Response | Promise<Response>;
  startScanner(): void;
  stopScanner(): void;
}

// The static asset dir, resolved relative to this module so it works regardless
// of cwd.
const STATIC_DIR = fileURLToPath(new URL('./static', import.meta.url));

// SSE data MUST be a single line: each `data:` field is one line, and a newline
// inside the HTML would split the frame. The cell/strip partials are already
// single-element HTML, but collapse any stray newline defensively.
function oneLine(html: string): string {
  return html.replaceAll('\n', '');
}

// content-type for a static asset by extension. woff2 is binary; everything else
// the dashboard serves is text. Unknown extensions fall back to octet-stream.
function contentTypeFor(path: string): string {
  if (path.endsWith('.css')) {
    return 'text/css; charset=utf-8';
  }
  if (path.endsWith('.js')) {
    return 'text/javascript; charset=utf-8';
  }
  if (path.endsWith('.woff2')) {
    return 'font/woff2';
  }
  if (path.endsWith('.txt')) {
    return 'text/plain; charset=utf-8';
  }
  if (path.endsWith('.html')) {
    return 'text/html; charset=utf-8';
  }
  return 'application/octet-stream';
}

// The hover "why" for a not-applicable cell (an empty cell that can never run
// here), by the manifest's skip reason. directive is the common case (a
// scenario's `# coding-agents:` line excludes this agent).
function naTitle(reason: 'directive' | 'draft' | 'tier' | null): string {
  switch (reason) {
    case 'directive':
      return "not eligible — this scenario's coding-agents directive excludes this agent";
    case 'draft':
      return 'draft scenario — not run by default';
    case 'tier':
      return 'filtered out by tier';
    default:
      return 'not run-eligible';
  }
}

// Distinct, sorted scenario names observed in the grid (the manifest-null
// fallback for the row axis).
function distinctScenarios(grid: Grid): string[] {
  const out = new Set<string>();
  for (const cell of grid.cells.values()) {
    out.add(cell.scenario);
  }
  return [...out].sort();
}

// Distinct, sorted agent names observed in the grid (the manifest-null fallback
// for the column axis).
function distinctAgents(grid: Grid): string[] {
  const out = new Set<string>();
  for (const cell of grid.cells.values()) {
    out.add(cell.agent);
  }
  return [...out].sort();
}

// The cell identities to render, in row-major (scenario, then agent) order. With
// a manifest, this is its declared cells (so ineligible/not-run cells render);
// without one, the observed grid cells.
function gridIdentities(
  grid: Grid,
  manifest: GridManifest | null,
): CellIdentity[] {
  if (manifest !== null) {
    return manifest.cells.map((c) => ({
      scenario: c.scenario,
      agent: c.agent,
      os: c.os,
    }));
  }
  return [...grid.cells.values()].map((c) => ({
    scenario: c.scenario,
    agent: c.agent,
    os: c.os,
  }));
}

export function createDashboard(args: CreateDashboardArgs): Dashboard {
  const { resultsRoot, knownAgents, manifest } = args;
  const bus = new EventBus();

  // Scan results/ overlaid with the manifest's eligibility matrix.
  const scan = (): Grid =>
    scanResults({ resultsDir: resultsRoot, knownAgents, manifest });

  // The last scan snapshot the scanner diffs against; warmed on the first GET /.
  let lastGrid: Grid = scan();

  // Render + publish a cell partial for (scenario, agent, os) from a Cell.
  const publishCell = (cell: Cell): void => {
    const view = cellView(cell, cell.scenario, cell.agent, cell.os);
    bus.publish({
      event: cellId(cell.scenario, cell.agent, cell.os),
      data: oneLine(cellHtml(view)),
    });
  };

  // --- scanner loop ----------------------------------------------------------

  let scannerTimer: ReturnType<typeof setTimeout> | null = null;
  let scannerStopped = false;

  const tick = (): void => {
    if (scannerStopped) {
      return;
    }
    // No clients: don't burn IO maintaining the SSE view, but keep rescheduling
    // so the loop resumes the instant a client connects.
    if (bus.subscriberCount > 0) {
      const next = scan();
      for (const change of diffGrids(lastGrid, next)) {
        const cell = cellForId(next, change.cell_id);
        if (cell === null) {
          // A vanished cell — no new cell to render; a reload reconciles.
          continue;
        }
        publishCell(cell);
      }
      lastGrid = next;
    }
    scannerTimer = setTimeout(tick, 1000);
  };

  const startScanner = (): void => {
    scannerStopped = false;
    if (scannerTimer === null) {
      scannerTimer = setTimeout(tick, 1000);
    }
  };

  const stopScanner = (): void => {
    scannerStopped = true;
    if (scannerTimer !== null) {
      clearTimeout(scannerTimer);
      scannerTimer = null;
    }
  };

  // --- routes ----------------------------------------------------------------

  // The cells that can NEVER run here (ineligible: directive/draft/tier), keyed
  // by 3-part cellKey -> a human "why" string. Drives the dimmed "n/a" tooltip.
  // Sourced from the manifest (the eligibility matrix); empty when manifest-null.
  const skipReasons = (): Map<string, string> => {
    const skipped = new Map<string, string>();
    if (manifest === null) {
      return skipped;
    }
    for (const c of manifest.cells) {
      if (!c.eligible) {
        skipped.set(
          cellKey(c.scenario, c.agent, c.os),
          naTitle(c.skipped_reason),
        );
      }
    }
    return skipped;
  };

  const renderRoot = (): Response => {
    const grid = scan();
    lastGrid = grid;

    const scenarios = manifest?.scenarios ?? distinctScenarios(grid);
    const agents = manifest?.agents ?? distinctAgents(grid);
    const identities = gridIdentities(grid, manifest);
    const skipped = skipReasons();

    const views = new Map<string, ReturnType<typeof cellView>>();
    for (const id of identities) {
      const key = cellKey(id.scenario, id.agent, id.os);
      const cell =
        grid.cells.get(key) ?? emptyCell(id.scenario, id.agent, id.os);
      const view = cellView(cell, id.scenario, id.agent, id.os);
      // An empty cell that can never run here renders dimmed "n/a" + tooltip
      // (vs the plain never-run em-dash). A cell with history keeps it even
      // if it's no longer eligible. gridHtml keys views by 2-part
      // `${scenario}\t${agent}` (Task 7 adds the OS column header), so the views
      // map is keyed that way here too.
      const naReason = skipped.get(key);
      views.set(
        `${id.scenario}\t${id.agent}`,
        view.state === 'empty' && naReason !== undefined
          ? { ...view, opacity: 0.3, title: naReason }
          : view,
      );
    }
    const tally = headerTally(
      grid,
      identities,
      scenarios.length,
      agents.length,
    );

    const page = layoutHtml({
      tallyHtml: tallyHtml(tally),
      gridHtml: gridHtml({
        scenarios,
        agents,
        views,
        tally,
      }),
    });
    return new Response(page, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  };

  const handleEvents = (): Response => {
    const queue = bus.subscribe();
    const encoder = new TextEncoder();
    let pump: ReturnType<typeof setInterval> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Flush the response headers immediately and warm the connection: a
        // stream that emits no bytes until its first real frame leaves a
        // browser/fetch waiting on an idle dashboard with no headers at all
        // (sse-starlette sends an analogous opening ping). Comment lines
        // (": ...") are ignored by EventSource.
        controller.enqueue(encoder.encode(': connected\n\n'));
        let idleTicks = 0;
        // Drain the client's queue on a short interval, writing one SSE frame
        // per buffered message. Frames are `event: <name>\ndata: <oneline>\n\n`.
        // When the queue is empty for a while, send a keepalive comment so the
        // connection (and any proxy in between) stays open on an idle board.
        pump = setInterval(() => {
          const messages = queue.drain();
          if (messages.length === 0) {
            idleTicks += 1;
            // ~5s (25 * 200ms) — comfortably under common idle timeouts so a
            // proxy or a non-idleTimeout-0 server never severs a quiet stream.
            if (idleTicks >= 25) {
              idleTicks = 0;
              controller.enqueue(encoder.encode(': keepalive\n\n'));
            }
            return;
          }
          idleTicks = 0;
          for (const msg of messages) {
            controller.enqueue(
              encoder.encode(`event: ${msg.event}\ndata: ${msg.data}\n\n`),
            );
          }
        }, 200);
      },
      cancel() {
        if (pump !== null) {
          clearInterval(pump);
          pump = null;
        }
        bus.unsubscribe(queue);
      },
    });
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  };

  const handleStatic = (pathname: string): Response => {
    // Strip "/static/" and reject any path that escapes the static dir.
    const rest = pathname.slice('/static/'.length);
    const target = join(STATIC_DIR, rest);
    const normalizedRoot = STATIC_DIR.endsWith('/')
      ? STATIC_DIR
      : `${STATIC_DIR}/`;
    if (target !== STATIC_DIR && !target.startsWith(normalizedRoot)) {
      return new Response('not found', { status: 404 });
    }
    // Bun.file is lazy — a missing/dir target would otherwise serve a 200 with an
    // empty body, so probe existence here and 404 an absent asset.
    if (!existsSync(target) || statSync(target).isDirectory()) {
      return new Response('not found', { status: 404 });
    }
    return new Response(Bun.file(target), {
      headers: { 'content-type': contentTypeFor(target) },
    });
  };

  const fetchHandler = (req: Request): Response => {
    const url = new URL(req.url);
    const { pathname } = url;
    if (req.method === 'GET' && pathname === '/') {
      return renderRoot();
    }
    if (req.method === 'GET' && pathname === '/events') {
      return handleEvents();
    }
    if (req.method === 'GET' && pathname.startsWith('/static/')) {
      return handleStatic(pathname);
    }
    return new Response('not found', { status: 404 });
  };

  return {
    fetch: fetchHandler,
    startScanner,
    stopScanner,
  };
}

// An empty placeholder cell for a (scenario, agent, os) with no scan entry.
function emptyCell(scenario: string, agent: string, os: string): Cell {
  return { scenario, agent, os, window: [], running: null };
}

// The cell in `grid` whose cell id equals `cellId`, or null. The scanner's diff
// returns ids; this maps an id back to a Cell to re-render.
function cellForId(grid: Grid, id: string): Cell | null {
  for (const cell of grid.cells.values()) {
    if (cellId(cell.scenario, cell.agent, cell.os) === id) {
      return cell;
    }
  }
  return null;
}
