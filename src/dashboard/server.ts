import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnable, type SkippedReason } from '../contracts/batch.ts';
import type { InvokeFn } from '../run-all/index.ts';
import { buildMatrix } from '../run-all/matrix.ts';
import type { SchedulerEvent } from '../scheduler/index.ts';
import { type Cell, cellId, cellKey, type Grid } from './contracts.ts';
import { EventBus } from './event-bus.ts';
import {
  LaunchBusyError,
  type LaunchKind,
  Orchestrator,
} from './orchestrator.ts';
import { readDashboardVerdict, scanResults } from './scan.ts';
import {
  cellHtml,
  esc,
  gridHtml,
  layoutHtml,
  runStripHtml,
  tallyHtml,
} from './templates.ts';
import { cellView, diffGrids, headerTally, launchEstimate } from './view.ts';

// The Bun.serve fetch handler + scanner loop for the quorum dashboard. Native
// Bun.serve + a ReadableStream SSE body; no external web stack.
//
// Three layers, filesystem as the single source of truth:
//  - GET /            warm scan -> full grid (first paint).
//  - GET /events      one SSE stream per client; cell + strip partials.
//  - POST /launch     start a session (409 if one is active); returns the strip.
//  - POST /stop       SIGINT in-flight children + cancel queued cells.
//  - GET /static/*    the vendored CSS/JS/fonts.
//
// Reconciliation (the trickiest seam): TWO publishers feed ONE EventBus.
//  - The ORCHESTRATOR pushes on scheduler progress via onSchedulerEvent —
//    cell_started marks the cell running (neutral 'setup' phase) and bumps
//    in-flight; cell_finished re-derives the cell from a fresh scan and bumps
//    done + spent.
//  - The SCANNER pushes on filesystem diff every ~1s while a client is connected
//    — it picks up phase.json advances and verdict.json landings (including
//    terminal-launched runs the orchestrator never saw).
// Both publish the SAME idempotent full-state cell partial through the bus, so
// whichever fires first, the cell converges. The run strip reflects the
// dashboard's OWN session counts only (build spec); the grid reflects all runs.

// The session counters behind the run strip. The dashboard's OWN launch session
// only — a terminal run-all alongside it is grid activity the strip excludes.
interface Session {
  running: number;
  inFlight: number;
  done: number;
  spent: number;
}

export interface CreateDashboardArgs {
  readonly resultsRoot: string;
  readonly scenariosRoot: string;
  readonly codingAgentsDir: string;
  readonly jobs: number;
  readonly knownAgents: readonly string[];
  // Injectable child launcher (tests stub it; the orchestrator defaults to the
  // live invokeChild). Passed straight through to the Orchestrator.
  readonly invoke?: InvokeFn;
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

// Sorted scenario dir names with a story.md (the same set `quorum list` shows).
// The grid's row order.
function discoverScenarios(scenariosRoot: string): string[] {
  if (!existsSync(scenariosRoot)) {
    return [];
  }
  const out: string[] = [];
  for (const name of readdirSync(scenariosRoot)) {
    const dir = join(scenariosRoot, name);
    if (!statSync(dir).isDirectory()) {
      continue;
    }
    if (existsSync(join(dir, 'story.md'))) {
      out.push(name);
    }
  }
  out.sort();
  return out;
}

// Sorted *.yaml stems under coding_agents_dir. The grid's column order. The
// dashboard accepts knownAgents for the read-side longest-suffix parse
// separately; this is the DISPLAY column set.
function discoverAgents(codingAgentsDir: string): string[] {
  if (!existsSync(codingAgentsDir)) {
    return [];
  }
  const out: string[] = [];
  for (const name of readdirSync(codingAgentsDir)) {
    if (name.endsWith('.yaml')) {
      out.push(name.slice(0, -'.yaml'.length));
    }
  }
  out.sort();
  return out;
}

// Pre-format a launch estimate: a fixed-2 dollar string or "" when unknown.
// Carried verbatim in the data-estimate attribute; app.js reparses.
function fmtEst(value: number | undefined): string {
  return value !== undefined ? value.toFixed(2) : '';
}

// The hover "why" for a not-applicable cell (an empty cell that can never run
// here), by skip reason. directive is the common case (a scenario's
// `# coding-agents:` line excludes this agent).
function naTitle(reason: SkippedReason): string {
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

export function createDashboard(args: CreateDashboardArgs): Dashboard {
  const { resultsRoot, scenariosRoot, codingAgentsDir, jobs, knownAgents } =
    args;
  const bus = new EventBus();
  const session: Session = { running: 0, inFlight: 0, done: 0, spent: 0 };

  // The last scan snapshot the scanner diffs against; warmed on the first GET /.
  let lastGrid: Grid = scanResults(resultsRoot, knownAgents);

  // Publish the run strip reflecting the current session counts.
  const publishStrip = (): void => {
    bus.publish({
      event: 'strip',
      data: oneLine(
        runStripHtml({
          running: session.running,
          inFlight: session.inFlight,
          done: session.done,
          spent: session.spent,
        }),
      ),
    });
  };

  // Render + publish a cell partial for (scenario, agent) from a Cell.
  const publishCell = (cell: Cell, scenario: string, agent: string): void => {
    const view = cellView(cell, scenario, agent);
    bus.publish({
      event: cellId(scenario, agent),
      data: oneLine(cellHtml(view)),
    });
  };

  // The orchestrator's SSE sink. cell_started shows a neutral running cell +
  // bumps in-flight; cell_finished re-scans the cell to pick up the landed
  // verdict + bumps done/spent. cell_queued dims the cell.
  const onSchedulerEvent = (event: SchedulerEvent): void => {
    if (event.kind === 'cell_queued') {
      const { scenario, codingAgent: agent } = event.entry;
      const grid = scanResults(resultsRoot, knownAgents);
      const base =
        grid.cells.get(cellKey(scenario, agent)) ?? emptyCell(scenario, agent);
      publishCell({ ...base, queued: true }, scenario, agent);
      return;
    }
    if (event.kind === 'cell_started') {
      const { scenario, codingAgent: agent } = event.entry;
      // A just-started child is in setup (the runner writes phase.json "setup"
      // first); show that neutral phase. The accurate live phase + the run_id
      // flow from the scanner tick reading phase.json — the cell_started event
      // carries no run_id, so the running marker uses an empty placeholder.
      const cell: Cell = {
        scenario,
        agent,
        window: [],
        running: { run_id: '', phase: 'setup' },
        queued: false,
      };
      publishCell(cell, scenario, agent);
      session.inFlight += 1;
      publishStrip();
      return;
    }
    if (event.kind === 'cell_finished') {
      const { scenario, codingAgent: agent } = event.entry;
      const grid = scanResults(resultsRoot, knownAgents);
      const cell =
        grid.cells.get(cellKey(scenario, agent)) ?? emptyCell(scenario, agent);
      publishCell(cell, scenario, agent);
      session.done += 1;
      session.inFlight = Math.max(0, session.inFlight - 1);
      // Attribute "$ spent" to the EXACT run the dashboard launched (the
      // event's run_id), not the newest window slot. Reading the newest slot
      // would let a sibling terminal run-all that lands a later run for the same
      // cell corrupt the strip total in the post-finish rescan.
      const cost =
        event.run_id !== null
          ? (readDashboardVerdict(join(resultsRoot, event.run_id))?.economics
              ?.total_est_cost_usd ?? null)
          : null;
      if (cost !== null) {
        session.spent += cost;
      }
      publishStrip();
      return;
    }
    if (event.kind === 'batch_done') {
      // The session is over. Clear the run strip so #runbar doesn't linger with
      // a misleading "Running N · ■ Stop" that the user can click into a no-op
      // stop. The grid cells carry the results; a fresh launch re-seeds the
      // strip. The run strip describes the dashboard's own launch session, so it
      // should be empty between sessions.
      session.running = 0;
      session.inFlight = 0;
      session.done = 0;
      session.spent = 0;
      bus.publish({ event: 'strip', data: '' });
    }
  };

  const orchestrator = new Orchestrator({
    resultsRoot,
    scenariosRoot,
    codingAgentsDir,
    jobs,
    onEvent: onSchedulerEvent,
    ...(args.invoke !== undefined ? { invoke: args.invoke } : {}),
  });

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
      const next = scanResults(resultsRoot, knownAgents);
      for (const change of diffGrids(lastGrid, next)) {
        const cell = cellForId(next, change.cell_id);
        if (cell === null) {
          // A vanished cell — no new cell to render; a reload reconciles.
          continue;
        }
        publishCell(cell, cell.scenario, cell.agent);
      }
      // The scanner publishes ONLY cell partials. The run strip is driven by
      // launch + cell_started/cell_finished events alone — publishing it here
      // pushed the idle "Running 0 · 0 in flight · ■ Stop" strip into #runbar the
      // moment any client connected, showing a session that isn't running. Idle ⇒
      // #runbar stays empty (its first-paint state). The SSE stream stays warm
      // via its own keepalive (handleEvents), not a phantom strip.
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

  // Launch info for the grid: per-column/row RUNNABLE counts (the confirm's
  // "Run N cells") AND the set of cells that can NEVER run here (directive/
  // draft/tier skips), keyed by cellKey -> a human "why" string. buildMatrix
  // throws only on a bad filter (none here); guard so GET / never 500s.
  const launchInfo = (
    scenarios: readonly string[],
    agents: readonly string[],
  ): {
    counts: { row: Record<string, number>; column: Record<string, number> };
    skipped: Map<string, string>;
  } => {
    const row: Record<string, number> = {};
    const column: Record<string, number> = {};
    const skipped = new Map<string, string>();
    for (const s of scenarios) {
      row[s] = 0;
    }
    for (const a of agents) {
      column[a] = 0;
    }
    try {
      for (const e of buildMatrix({ scenariosRoot, codingAgentsDir })) {
        if (runnable(e)) {
          row[e.scenario] = (row[e.scenario] ?? 0) + 1;
          column[e.codingAgent] = (column[e.codingAgent] ?? 0) + 1;
        } else {
          skipped.set(
            cellKey(e.scenario, e.codingAgent),
            naTitle(e.skippedReason),
          );
        }
      }
    } catch {
      // Missing/unreadable dir — fall back to empty info so GET / still renders
      // the grid (counts show 0, no cell is marked n/a) rather than 500ing.
    }
    return { counts: { row, column }, skipped };
  };

  const renderRoot = (): Response => {
    const scenarios = discoverScenarios(scenariosRoot);
    const agents = discoverAgents(codingAgentsDir);
    const grid = scanResults(resultsRoot, knownAgents);
    lastGrid = grid;

    const { counts, skipped } = launchInfo(scenarios, agents);

    const views = new Map<string, ReturnType<typeof cellView>>();
    for (const scenario of scenarios) {
      for (const agent of agents) {
        const key = cellKey(scenario, agent);
        const cell = grid.cells.get(key) ?? emptyCell(scenario, agent);
        const view = cellView(cell, scenario, agent);
        // An empty cell that can never run here renders dimmed "n/a" + tooltip
        // (vs the plain never-run em-dash). A cell with history keeps it even
        // if it's no longer eligible.
        const naReason = skipped.get(key);
        views.set(
          key,
          view.state === 'empty' && naReason !== undefined
            ? { ...view, opacity: 0.3, title: naReason }
            : view,
        );
      }
    }
    const tally = headerTally(grid, scenarios, agents);
    const firstAgent = agents[0];
    const firstScenario = scenarios[0];
    const estimates = {
      row: Object.fromEntries(
        scenarios.map((s) => [
          s,
          fmtEst(
            firstAgent !== undefined
              ? launchEstimate(grid, s, firstAgent)
              : undefined,
          ),
        ]),
      ),
      column: Object.fromEntries(
        agents.map((a) => [
          a,
          fmtEst(
            firstScenario !== undefined
              ? launchEstimate(grid, firstScenario, a)
              : undefined,
          ),
        ]),
      ),
    };

    const page = layoutHtml({
      tallyHtml: tallyHtml(tally),
      gridHtml: gridHtml({
        scenarios,
        agents,
        views,
        tally,
        estimates,
        counts,
      }),
    });
    return new Response(page, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  };

  const handleLaunch = async (req: Request): Promise<Response> => {
    const form = await req.formData();
    const kindRaw = form.get('kind');
    const kind = parseKind(kindRaw);
    if (kind === null) {
      return new Response(
        '<div class="runbar">launch error: missing or invalid kind</div>',
        {
          status: 400,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        },
      );
    }
    const scenario = formString(form.get('scenario'));
    const agent = formString(form.get('agent'));
    try {
      orchestrator.launch({
        kind,
        ...(scenario !== undefined ? { scenario } : {}),
        ...(agent !== undefined ? { agent } : {}),
      });
    } catch (err: unknown) {
      if (err instanceof LaunchBusyError) {
        return new Response(
          '<div class="runbar">A launch session is already active.</div>',
          {
            status: 409,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          },
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      return new Response(
        `<div class="runbar">launch error: ${esc(message)}</div>`,
        {
          status: 400,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        },
      );
    }
    // Seed the strip from the runnable total so "Running N" is correct from
    // first paint (S4); reset the per-session counters.
    session.running = orchestrator.runnableTotal;
    session.inFlight = 0;
    session.done = 0;
    session.spent = 0;
    return new Response(
      runStripHtml({
        running: session.running,
        inFlight: 0,
        done: 0,
        spent: 0,
      }),
      { headers: { 'content-type': 'text/html; charset=utf-8' } },
    );
  };

  const handleStop = (): Response => {
    orchestrator.stop();
    return new Response('<div class="runbar">Stopping…</div>', {
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

  const fetchHandler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const { pathname } = url;
    if (req.method === 'GET' && pathname === '/') {
      return renderRoot();
    }
    if (req.method === 'GET' && pathname === '/events') {
      return handleEvents();
    }
    if (req.method === 'POST' && pathname === '/launch') {
      return handleLaunch(req);
    }
    if (req.method === 'POST' && pathname === '/stop') {
      return handleStop();
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

// An empty placeholder cell for a (scenario, agent) with no scan entry.
function emptyCell(scenario: string, agent: string): Cell {
  return { scenario, agent, window: [], running: null, queued: false };
}

// The cell in `grid` whose cell id equals `cellId`, or null. The scanner's diff
// returns ids; this maps an id back to a Cell to re-render.
function cellForId(grid: Grid, id: string): Cell | null {
  for (const cell of grid.cells.values()) {
    if (cellId(cell.scenario, cell.agent) === id) {
      return cell;
    }
  }
  return null;
}

// Parse the /launch kind form field into a LaunchKind, or null when invalid. The
// field value is a string | File | null (FormData); only a known kind string is
// accepted.
function parseKind(raw: string | File | null): LaunchKind | null {
  if (raw === 'row' || raw === 'column' || raw === 'all') {
    return raw;
  }
  return null;
}

// A form field as a non-empty string, or undefined (so optional fields are
// passed conditionally under exactOptionalPropertyTypes). A File value (no
// file uploads on these forms) is treated as absent.
function formString(raw: string | File | null): string | undefined {
  if (typeof raw === 'string' && raw.length > 0) {
    return raw;
  }
  return undefined;
}
