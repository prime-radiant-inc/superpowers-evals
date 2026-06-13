import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildResult } from '../src/contracts/batch.ts';
import { startDashboard } from '../src/dashboard/index.ts';
import type { InvokeChildArgs } from '../src/run-all/index.ts';

// The e2e dashboard fixture: a results/ tree with one of each cell state, plus a
// scenarios/ + coding-agents/ tree so the grid renders the full cartesian
// product. The server is driven over a real (in-process) Bun.serve on port 0.
//
// Cells (scenario x agent), KNOWN_AGENTS = [claude, codex]:
//  - good   x claude  -> pass (verdict.json final=pass, cost 1.00)
//  - good   x codex   -> fail
//  - flaky  x claude  -> indeterminate
//  - flaky  x codex   -> a LIVE in-flight dir (phase.json pid = process.pid)
//  - drift  x claude  -> 3 runs, the latest >1.5x median of priors (▲)
//  - drift  x codex   -> an ABANDONED dir (phase.json with a dead pid, no verdict)

const KNOWN_AGENTS = ['claude', 'codex'] as const;
const SCENARIOS = ['drift', 'flaky', 'good'] as const; // sorted

interface Fixture {
  readonly root: string;
  readonly scenariosRoot: string;
  readonly codingAgentsDir: string;
  readonly resultsRoot: string;
}

// A dir name parts → dir path. Stamps are lexicographically ordered by index so
// "newest" is the highest stamp.
function runDir(
  resultsRoot: string,
  scenario: string,
  agent: string,
  idx: number,
  nonce: string,
): string {
  const stamp = `2026061${idx}T000000Z`;
  return join(resultsRoot, `${scenario}-${agent}-${stamp}-${nonce}`);
}

function writeVerdict(dir: string, final: string, cost: number | null): void {
  mkdirSync(dir, { recursive: true });
  const economics = cost !== null ? { total_est_cost_usd: cost } : null;
  writeFileSync(
    join(dir, 'verdict.json'),
    JSON.stringify({ final, economics, finished_at: '2026-06-12T00:00:00Z' }),
  );
}

function writePhaseOnly(dir: string, phase: string, pid: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'phase.json'),
    JSON.stringify({ phase, updated_at: '2026-06-12T00:00:00Z', pid }),
  );
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'dash-srv-'));
  const scenariosRoot = join(root, 'scenarios');
  const codingAgentsDir = join(root, 'coding-agents');
  const resultsRoot = join(root, 'results');

  for (const s of SCENARIOS) {
    const dir = join(scenariosRoot, s);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'story.md'), '# story\n');
    writeFileSync(join(dir, 'checks.sh'), 'pre() { :; }\npost() { :; }\n');
  }
  mkdirSync(codingAgentsDir, { recursive: true });
  for (const a of KNOWN_AGENTS) {
    writeFileSync(join(codingAgentsDir, `${a}.yaml`), 'max_concurrency: 4\n');
  }
  mkdirSync(resultsRoot, { recursive: true });

  // good x claude -> pass
  writeVerdict(runDir(resultsRoot, 'good', 'claude', 0, 'aaaa'), 'pass', 1.0);
  // good x codex -> fail
  writeVerdict(runDir(resultsRoot, 'good', 'codex', 0, 'bbbb'), 'fail', 2.0);
  // flaky x claude -> indeterminate
  writeVerdict(
    runDir(resultsRoot, 'flaky', 'claude', 0, 'cccc'),
    'indeterminate',
    1.5,
  );
  // flaky x codex -> live in-flight dir (this process's pid IS alive)
  writePhaseOnly(
    runDir(resultsRoot, 'flaky', 'codex', 0, 'dddd'),
    'agent',
    process.pid,
  );
  // drift x claude -> 3 runs, latest >1.5x median of priors ([1,1,3]) -> ▲
  writeVerdict(runDir(resultsRoot, 'drift', 'claude', 0, 'e001'), 'pass', 1.0);
  writeVerdict(runDir(resultsRoot, 'drift', 'claude', 1, 'e002'), 'pass', 1.0);
  writeVerdict(runDir(resultsRoot, 'drift', 'claude', 2, 'e003'), 'pass', 3.0);
  // drift x codex -> abandoned dir (dead pid, no verdict) -> excluded
  writePhaseOnly(
    runDir(resultsRoot, 'drift', 'codex', 0, 'ffff'),
    'agent',
    2_000_000_000, // out-of-range pid: never alive
  );

  return { root, scenariosRoot, codingAgentsDir, resultsRoot };
}

// Slice out a single cell's <td …id="<cellId>"…>…</td> from the rendered page
// so an assertion can't bleed across cell boundaries. Returns '' when not found.
function sliceCell(html: string, cellIdValue: string): string {
  const open = html.indexOf(`id="${cellIdValue}"`);
  if (open === -1) {
    return '';
  }
  const tdStart = html.lastIndexOf('<td', open);
  const tdEnd = html.indexOf('</td>', open);
  if (tdStart === -1 || tdEnd === -1) {
    return '';
  }
  return html.slice(tdStart, tdEnd + '</td>'.length);
}

let fixtures: Fixture[] = [];
let handles: { port: number; stop(): void }[] = [];

beforeEach(() => {
  fixtures = [];
  handles = [];
});

afterEach(() => {
  for (const h of handles) {
    h.stop();
  }
  for (const f of fixtures) {
    rmSync(f.root, { recursive: true, force: true });
  }
});

function start(
  fixtureOverride?: Partial<Parameters<typeof startDashboard>[0]>,
): { fixture: Fixture; port: number; base: string } {
  const fixture = makeFixture();
  fixtures.push(fixture);
  const handle = startDashboard({
    port: 0,
    resultsRoot: fixture.resultsRoot,
    scenariosRoot: fixture.scenariosRoot,
    codingAgentsDir: fixture.codingAgentsDir,
    jobs: 4,
    ...fixtureOverride,
  });
  handles.push(handle);
  return {
    fixture,
    port: handle.port,
    base: `http://localhost:${handle.port}`,
  };
}

test('GET / renders the grid with the tally header and every cell id', async () => {
  const { base } = start();
  const res = await fetch(`${base}/`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/html');
  const html = await res.text();

  // The tally header.
  expect(html).toContain('<b>quorum</b>');
  expect(html).toContain('scenarios ×');

  // Every (scenario, agent) cell id is present (cartesian product).
  for (const s of SCENARIOS) {
    for (const a of KNOWN_AGENTS) {
      expect(html).toContain(`id="cell-${s}-${a}"`);
    }
  }
});

test('GET / reflects pass/fail/indeterminate and the live in-flight cell', async () => {
  const { base } = start();
  const html = await fetch(`${base}/`).then((r) => r.text());

  // good x claude pass -> b-pass band, cost bottom.
  expect(sliceCell(html, 'cell-good-claude')).toContain('b-pass');
  // good x codex fail -> b-fail band.
  expect(sliceCell(html, 'cell-good-codex')).toContain('b-fail');
  // flaky x claude indeterminate -> b-indet band.
  expect(sliceCell(html, 'cell-flaky-claude')).toContain('b-indet');
  // flaky x codex live -> running class + the phase word.
  const liveTd = sliceCell(html, 'cell-flaky-codex');
  expect(liveTd).toContain('running');
  expect(liveTd).toContain('agent');
});

test('GET / shows the drift marker and omits the abandoned cell', async () => {
  const { base } = start();
  const html = await fetch(`${base}/`).then((r) => r.text());

  // drift x claude carries the ▲ marker.
  expect(sliceCell(html, 'cell-drift-claude')).toContain('▲');

  // drift x codex is abandoned (dead pid, no verdict) -> renders as empty (the
  // em-dash placeholder), NOT a running/done cell. Slice out just that cell's
  // <td>…</td> so the assertion can't bleed into a later cell's bands.
  const codexTd = sliceCell(html, 'cell-drift-codex');
  expect(codexTd).toContain('class="empty"');
  expect(codexTd).toContain('—');
  expect(codexTd).not.toContain('b-pass');
  expect(codexTd).not.toContain('running');
});

test('GET /static/styles.css serves text/css', async () => {
  const { base } = start();
  const res = await fetch(`${base}/static/styles.css`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/css');
  const body = await res.text();
  expect(body).toContain('.cb-slot');
});

test('GET /static/app.js serves text/javascript', async () => {
  const { base } = start();
  const res = await fetch(`${base}/static/app.js`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('javascript');
});

test('GET /static/fonts/*.woff2 serves font/woff2', async () => {
  const { base } = start();
  const res = await fetch(`${base}/static/fonts/Inter-Regular.woff2`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('woff2');
});

test('GET /static/* rejects path traversal outside the static dir', async () => {
  const { base } = start();
  const res = await fetch(`${base}/static/../server.ts`);
  // Bun's URL normalization collapses ../ before the request reaches us, so the
  // path is either 404 (no such static file) or rejected — never the .ts source.
  const body = await res.text();
  expect(res.status).toBe(404);
  expect(body).not.toContain('createDashboard');
});

test('GET /events responds with text/event-stream', async () => {
  const { base } = start();
  const res = await fetch(`${base}/events`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  expect(res.headers.get('cache-control')).toContain('no-cache');
  // Drop the stream so the test doesn't hang on an open SSE connection.
  await res.body?.cancel();
});

test('GET / on an unknown route is 404', async () => {
  const { base } = start();
  const res = await fetch(`${base}/nope`);
  expect(res.status).toBe(404);
});

// A gated invoke for the launch/409 path: the first launch's child blocks so the
// session stays active while we probe a second launch.
function gatedInvoke(): {
  invoke: (args: InvokeChildArgs) => Promise<ChildResult>;
  release: () => void;
} {
  let releaseGate: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    releaseGate = r;
  });
  const invoke = async (args: InvokeChildArgs): Promise<ChildResult> => {
    args.onPid?.(1_900_000);
    await gate;
    return { run_id: null, exit_code: 0, error: null };
  };
  return {
    invoke,
    release: () => {
      releaseGate?.();
    },
  };
}

test('POST /launch returns the run strip; a second launch while active is 409', async () => {
  const g = gatedInvoke();
  const { base } = start({ invoke: g.invoke });

  const body = new URLSearchParams({ kind: 'all' });
  const first = await fetch(`${base}/launch`, {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  expect(first.status).toBe(200);
  const stripHtml = await first.text();
  expect(stripHtml).toContain('runbar');
  expect(stripHtml).toContain('Running');

  // Second launch while the first is still active (gated) -> 409.
  const second = await fetch(`${base}/launch`, {
    method: 'POST',
    body: new URLSearchParams({ kind: 'all' }),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  expect(second.status).toBe(409);
  const busyHtml = await second.text();
  expect(busyHtml).toContain('runbar');

  // Release the gated child so the session drains before teardown.
  g.release();
  await new Promise((r) => setTimeout(r, 50));
});

test('POST /stop returns the Stopping runbar', async () => {
  const { base } = start();
  const res = await fetch(`${base}/stop`, { method: 'POST' });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('runbar');
  expect(html).toContain('Stopping');
});

test('an SSE cell frame is delivered after a scanner tick mutates a dir', async () => {
  const { fixture, base } = start();

  // Connect an SSE client. The scanner only ticks while a client is connected.
  const res = await fetch(`${base}/events`);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const reader = res.body?.getReader();
  if (reader === undefined) {
    throw new Error('expected an SSE body reader');
  }

  // Land a verdict.json into the previously-live (flaky x codex) dir so the next
  // scanner tick sees its signature change (running -> verdict-appeared) and
  // publishes a cell-flaky-codex frame.
  writeVerdict(
    runDir(fixture.resultsRoot, 'flaky', 'codex', 0, 'dddd'),
    'pass',
    0.5,
  );

  // Read frames until we see the cell event or time out. The scanner cadence is
  // ~1s; allow a few ticks.
  const decoder = new TextDecoder();
  let buf = '';
  const deadline = Date.now() + 6000;
  let sawCellFrame = false;
  while (Date.now() < deadline && !sawCellFrame) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: boolean; value: undefined }>((r) =>
        setTimeout(() => r({ done: false, value: undefined }), 1200),
      ),
    ]);
    if (chunk.value !== undefined) {
      buf += decoder.decode(chunk.value, { stream: true });
    }
    if (buf.includes('event: cell-flaky-codex')) {
      sawCellFrame = true;
    }
  }
  await reader.cancel();
  expect(sawCellFrame).toBe(true);
  // The frame's data line is single-line HTML carrying the cell id.
  expect(buf).toContain('cell-flaky-codex');
});
