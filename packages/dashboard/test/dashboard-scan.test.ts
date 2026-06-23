import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cellKey } from '../src/contracts.ts';
import { pidAlive, readDashboardVerdict, scanResults } from '../src/scan.ts';

// Identity is read from each run's authoritative verdict.json / phase.json
// (scenario, coding_agent, credential, os) — never parsed out of the run-dir
// name. The dir name's only positional read is the started_at stamp tail.

// --- pidAlive ----------------------------------------------------------------

test('pidAlive returns true for the current process', () => {
  expect(pidAlive(process.pid)).toBe(true);
});

test('pidAlive returns false for a certainly-dead pid', () => {
  // 2^31-ish pid never exists; process.kill throws ESRCH.
  expect(pidAlive(2147483646)).toBe(false);
});

// --- readDashboardVerdict ----------------------------------------------------

test('readDashboardVerdict returns null when verdict.json is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-'));
  expect(readDashboardVerdict(dir)).toBeNull();
});

test('readDashboardVerdict parses a present verdict', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-'));
  writeFileSync(
    join(dir, 'verdict.json'),
    JSON.stringify({ final: 'pass', economics: { total_est_cost_usd: 2.5 } }),
  );
  const v = readDashboardVerdict(dir);
  expect(v?.final).toBe('pass');
  expect(v?.economics?.total_est_cost_usd).toBe(2.5);
});

test('readDashboardVerdict narrows credential + os identity fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-'));
  writeFileSync(
    join(dir, 'verdict.json'),
    JSON.stringify({
      final: 'pass',
      scenario: 's',
      coding_agent: 'claude',
      credential: 'opus',
      os: 'linux',
    }),
  );
  const v = readDashboardVerdict(dir);
  expect(v?.credential).toBe('opus');
  expect(v?.os).toBe('linux');
});

test('readDashboardVerdict returns null for unparseable JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-'));
  writeFileSync(join(dir, 'verdict.json'), '{ not json');
  expect(readDashboardVerdict(dir)).toBeNull();
});

// --- scanResults: helpers ----------------------------------------------------

// Build a run-dir name carrying the started_at stamp tail the scanner reads for
// display/sort. Identity is supplied by the verdict/phase contents, not the name.
function runId(
  scenario: string,
  agent: string,
  credential: string,
  os: string,
  stamp: string,
  nonce: string,
): string {
  return `${scenario}-${agent}-${credential}-${os}-${stamp}-${nonce}`;
}

function identity(over: Partial<Record<string, string>> = {}) {
  return {
    scenario: 's',
    coding_agent: 'claude',
    credential: 'none',
    os: 'linux',
    ...over,
  };
}

function writeRun(
  root: string,
  name: string,
  files: { verdict?: unknown; phase?: unknown },
): void {
  const d = join(root, name);
  mkdirSync(d, { recursive: true });
  if (files.verdict !== undefined) {
    writeFileSync(join(d, 'verdict.json'), JSON.stringify(files.verdict));
  }
  if (files.phase !== undefined) {
    writeFileSync(join(d, 'phase.json'), JSON.stringify(files.phase));
  }
}

// --- scanResults -------------------------------------------------------------

function scan(root: string) {
  return scanResults({ resultsDir: root, manifest: null });
}

test('scanResults returns an empty grid for a missing root', () => {
  const grid = scan(join(tmpdir(), 'does-not-exist-xyz'));
  expect(grid.cells.size).toBe(0);
});

test('scanResults buckets runs into cells and windows to 5 newest', () => {
  const root = mkdtempSync(join(tmpdir(), 'res-'));
  for (let i = 0; i < 7; i++) {
    writeRun(
      root,
      runId('s', 'claude', 'none', 'linux', `2026061${i}T000000Z`, `00${i}a`),
      {
        verdict: {
          final: 'pass',
          economics: { total_est_cost_usd: i },
          ...identity(),
        },
      },
    );
  }
  const grid = scan(root);
  const cell = grid.cells.get(cellKey('s', 'claude', 'none', 'linux'));
  expect(cell?.window.length).toBe(5);
  // Newest rightmost: the 7 stamps sort, window keeps the 5 newest (i=2..6),
  // newest is i=6 with cost 6.
  expect(cell?.window[4]?.cost_usd).toBe(6);
  expect(cell?.window[0]?.cost_usd).toBe(2);
});

test('scanResults skips batches and identity-less dirs', () => {
  const root = mkdtempSync(join(tmpdir(), 'res-'));
  mkdirSync(join(root, 'batches'), { recursive: true });
  // A dir whose verdict carries no identity is not placeable -> skipped.
  writeRun(
    root,
    runId('x', 'claude', 'none', 'linux', '20260612T000000Z', 'eeee'),
    {
      verdict: { final: 'pass' },
    },
  );
  writeRun(
    root,
    runId('s', 'claude', 'none', 'linux', '20260612T000000Z', 'aaaa'),
    {
      verdict: { final: 'pass', ...identity() },
    },
  );
  const grid = scan(root);
  expect(grid.cells.size).toBe(1);
  expect(grid.cells.has(cellKey('s', 'claude', 'none', 'linux'))).toBe(true);
});

test('scanResults reads final/cost/finished_at off the verdict', () => {
  const root = mkdtempSync(join(tmpdir(), 'res-'));
  const name = runId(
    's',
    'claude',
    'none',
    'linux',
    '20260612T000000Z',
    'aaaa',
  );
  writeRun(root, name, {
    verdict: {
      final: 'fail',
      economics: { total_est_cost_usd: 3.14 },
      finished_at: '2026-06-12T00:01:00Z',
      ...identity(),
    },
  });
  const cell = scan(root).cells.get(cellKey('s', 'claude', 'none', 'linux'));
  const rec = cell?.window[0];
  expect(rec?.final).toBe('fail');
  expect(rec?.cost_usd).toBe(3.14);
  expect(rec?.finished_at).toBe('2026-06-12T00:01:00Z');
  expect(rec?.run_id).toBe(name);
  expect(rec?.started_at).toBe('20260612T000000Z');
});

test('scanResults collapses an unknown final to "unknown"', () => {
  const root = mkdtempSync(join(tmpdir(), 'res-'));
  writeRun(
    root,
    runId('s', 'claude', 'none', 'linux', '20260612T000000Z', 'aaaa'),
    {
      verdict: { final: 'weird-value', ...identity() },
    },
  );
  const cell = scan(root).cells.get(cellKey('s', 'claude', 'none', 'linux'));
  expect(cell?.window[0]?.final).toBe('unknown');
  expect(cell?.window[0]?.cost_usd).toBeNull();
  expect(cell?.window[0]?.finished_at).toBeNull();
});

test('scanResults: a live-pid phase.json with identity and no verdict is the running run', () => {
  const root = mkdtempSync(join(tmpdir(), 'res-'));
  writeRun(
    root,
    runId('s', 'claude', 'none', 'linux', '20260612T000000Z', 'aaaa'),
    {
      phase: {
        phase: 'agent',
        updated_at: 'x',
        pid: process.pid,
        identity: {
          scenario: 's',
          agent: 'claude',
          credential: 'none',
          os: 'linux',
        },
      },
    },
  );
  const cell = scan(root).cells.get(cellKey('s', 'claude', 'none', 'linux'));
  expect(cell?.running?.phase).toBe('agent');
  expect(cell?.window.length).toBe(0);
});

test('scanResults: running phase is taken verbatim from phase.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'res-'));
  writeRun(
    root,
    runId('s', 'claude', 'none', 'linux', '20260612T000000Z', 'aaaa'),
    {
      phase: {
        phase: 'setup',
        updated_at: 'x',
        pid: process.pid,
        identity: {
          scenario: 's',
          agent: 'claude',
          credential: 'none',
          os: 'linux',
        },
      },
    },
  );
  const cell = scan(root).cells.get(cellKey('s', 'claude', 'none', 'linux'));
  expect(cell?.running?.phase).toBe('setup');
});

test('scanResults: an in-flight phase.json with no identity is skipped', () => {
  const root = mkdtempSync(join(tmpdir(), 'res-'));
  // Live pid, but no identity field -> not placeable -> the cell never appears.
  writeRun(
    root,
    runId('s', 'claude', 'none', 'linux', '20260612T000000Z', 'aaaa'),
    {
      phase: { phase: 'agent', updated_at: 'x', pid: process.pid },
    },
  );
  expect(scan(root).cells.size).toBe(0);
});

test('AUTHORITY RULE: verdict present means phase.json is ignored (not running)', () => {
  const root = mkdtempSync(join(tmpdir(), 'res-'));
  writeRun(
    root,
    runId('s', 'claude', 'none', 'linux', '20260612T000000Z', 'aaaa'),
    {
      verdict: {
        final: 'pass',
        economics: { total_est_cost_usd: 1 },
        ...identity(),
      },
      phase: {
        phase: 'agent',
        updated_at: 'x',
        pid: process.pid,
        identity: {
          scenario: 's',
          agent: 'claude',
          credential: 'none',
          os: 'linux',
        },
      },
    },
  );
  const cell = scan(root).cells.get(cellKey('s', 'claude', 'none', 'linux'));
  expect(cell?.running).toBeNull();
  expect(cell?.window.length).toBe(1);
  expect(cell?.window[0]?.final).toBe('pass');
});

test('ABANDONED EXCLUSION: dead-pid phase.json with no verdict omits the cell', () => {
  const root = mkdtempSync(join(tmpdir(), 'res-'));
  writeRun(
    root,
    runId('s', 'claude', 'none', 'linux', '20260612T000000Z', 'aaaa'),
    {
      phase: {
        phase: 'agent',
        updated_at: 'x',
        pid: 2147483646,
        identity: {
          scenario: 's',
          agent: 'claude',
          credential: 'none',
          os: 'linux',
        },
      },
    },
  );
  const grid = scan(root);
  expect(grid.cells.has(cellKey('s', 'claude', 'none', 'linux'))).toBe(false);
  expect(grid.cells.size).toBe(0);
});

test('ABANDONED EXCLUSION: phase.json without a pid omits the cell', () => {
  const root = mkdtempSync(join(tmpdir(), 'res-'));
  // pid missing -> schema rejects -> treated as no live phase -> abandoned.
  writeRun(
    root,
    runId('s', 'claude', 'none', 'linux', '20260612T000000Z', 'aaaa'),
    {
      phase: {
        phase: 'agent',
        updated_at: 'x',
        identity: {
          scenario: 's',
          agent: 'claude',
          credential: 'none',
          os: 'linux',
        },
      },
    },
  );
  expect(scan(root).cells.size).toBe(0);
});

test('scanResults: only the newest in-flight dir sets the cell running state', () => {
  const root = mkdtempSync(join(tmpdir(), 'res-'));
  // An older resolved run plus a newer live-pid running dir.
  writeRun(
    root,
    runId('s', 'claude', 'none', 'linux', '20260612T000000Z', 'aaaa'),
    {
      verdict: {
        final: 'pass',
        economics: { total_est_cost_usd: 1 },
        ...identity(),
      },
    },
  );
  writeRun(
    root,
    runId('s', 'claude', 'none', 'linux', '20260613T000000Z', 'bbbb'),
    {
      phase: {
        phase: 'checks',
        updated_at: 'x',
        pid: process.pid,
        identity: {
          scenario: 's',
          agent: 'claude',
          credential: 'none',
          os: 'linux',
        },
      },
    },
  );
  const cell = scan(root).cells.get(cellKey('s', 'claude', 'none', 'linux'));
  expect(cell?.running?.phase).toBe('checks');
  expect(cell?.running?.run_id).toBe(
    runId('s', 'claude', 'none', 'linux', '20260613T000000Z', 'bbbb'),
  );
  // The resolved run still shows in the window.
  expect(cell?.window.length).toBe(1);
  expect(cell?.window[0]?.final).toBe('pass');
});

test('scanResults: window ordering is (started_at, dir-name) ascending', () => {
  const root = mkdtempSync(join(tmpdir(), 'res-'));
  // Same timestamp, dir-name (nonce) tie-break.
  writeRun(
    root,
    runId('s', 'claude', 'none', 'linux', '20260612T000000Z', '00ff'),
    {
      verdict: {
        final: 'pass',
        economics: { total_est_cost_usd: 2 },
        ...identity(),
      },
    },
  );
  writeRun(
    root,
    runId('s', 'claude', 'none', 'linux', '20260612T000000Z', '00aa'),
    {
      verdict: {
        final: 'fail',
        economics: { total_est_cost_usd: 1 },
        ...identity(),
      },
    },
  );
  const cell = scan(root).cells.get(cellKey('s', 'claude', 'none', 'linux'));
  // 00aa < 00ff lexicographically, so 00aa is older (window[0]).
  expect(cell?.window[0]?.cost_usd).toBe(1);
  expect(cell?.window[1]?.cost_usd).toBe(2);
});

test('scanResults omits a cell whose only run is non-displayable', () => {
  const root = mkdtempSync(join(tmpdir(), 'res-'));
  // A dir with neither verdict nor a live phase: no record, no running.
  writeRun(
    root,
    runId('s', 'claude', 'none', 'linux', '20260612T000000Z', 'aaaa'),
    {},
  );
  expect(scanResults({ resultsDir: root, manifest: null }).cells.size).toBe(0);
});

// --- 4-part (scenario, agent, credential, os) identity -----------------------

test('cellKey is 4-part', () => {
  expect(cellKey('s1', 'claude', 'opus', 'windows')).toBe(
    's1\tclaude\topus\twindows',
  );
});

test('different-os runs of the same scenario/agent/credential are distinct cells', () => {
  const grid = scanResults({
    resultsDir: 'test/fixtures/scan/results',
    manifest: null,
  });
  expect(grid.cells.has(cellKey('s1', 'claude', 'none', 'linux'))).toBe(true);
  expect(grid.cells.has(cellKey('s1', 'claude', 'none', 'windows'))).toBe(true);
});

test('different-credential runs of the same scenario/agent/os are distinct cells', () => {
  const root = mkdtempSync(join(tmpdir(), 'res-cred-'));
  writeRun(
    root,
    runId('s', 'claude', 'opus', 'linux', '20260612T000000Z', 'aaaa'),
    {
      verdict: {
        final: 'pass',
        economics: { total_est_cost_usd: 1 },
        ...identity({ credential: 'opus' }),
      },
    },
  );
  writeRun(
    root,
    runId('s', 'claude', 'sonnet', 'linux', '20260612T000000Z', 'bbbb'),
    {
      verdict: {
        final: 'fail',
        economics: { total_est_cost_usd: 2 },
        ...identity({ credential: 'sonnet' }),
      },
    },
  );
  const grid = scan(root);
  // Same (scenario, agent, os), distinct credentials -> two cells.
  expect(grid.cells.size).toBe(2);
  const opusCell = grid.cells.get(cellKey('s', 'claude', 'opus', 'linux'));
  const sonnetCell = grid.cells.get(cellKey('s', 'claude', 'sonnet', 'linux'));
  expect(opusCell?.window[0]?.final).toBe('pass');
  expect(sonnetCell?.window[0]?.final).toBe('fail');
});
