import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { SpawnCommandRunner } from '../src/agents/command-runner.ts';
import { exportRuns } from '../src/export-runs/index.ts';
import type { BundleEntry } from '../src/export-runs/manifest.ts';
import { BundleManifestSchema } from '../src/export-runs/manifest.ts';

const runner = new SpawnCommandRunner();

function write(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
}

function verdict(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: 1,
    final: 'pass',
    final_reason: 'Gauntlet-Agent passed',
    gauntlet: {
      status: 'pass',
      summary: 's',
      reasoning: 'r',
      run_id: 'g-1',
    },
    checks: [],
    error: null,
    economics: null,
    scenario: 'demo-scenario',
    coding_agent: 'codex',
    started_at: '2026-07-30T20:15:15.000Z',
    finished_at: '2026-07-30T20:35:15.000Z',
    credential: 'codex_sub',
    os: 'linux',
    provenance: {
      superpowers_rev: null,
      superpowers_dirty: null,
      harness_rev: 'abc123harness',
      agent_cli_version: 'codex-cli 0.146.0',
      gauntlet_version: null,
    },
    ...overrides,
  });
}

// A results tree shaped like the real corpora: results/<label>/<run-id>/...
// with a throwaway home holding credentials the export must not carry.
function resultsTree(): { root: string; runId: string } {
  const root = mkdtempSync(join(tmpdir(), 'results-'));
  const runId = 'demo-codex-codex_sub-linux-20260730T201515Z-a325';
  // Label shape mirrors the real corpora: <campaign>-<arm>-rep<n>.
  const run = join(root, 'cx-eff-demo-rep1', runId);

  write(join(run, 'verdict.json'), verdict());
  write(join(run, 'trajectory.json'), '{"steps":[]}');
  write(join(run, 'coding-agent-token-usage.json'), '{"total":1}');
  write(join(run, 'phase.json'), '{"phase":"done"}');
  write(join(run, 'credentials.snapshot.yaml'), 'codex_sub:\n  api: openai\n');
  write(join(run, 'gauntlet-agent/results/g-1/run.jsonl'), '{"e":1}\n');
  write(join(run, 'coding-agent-workdir/src/main.go'), 'package main\n');
  // The agent's own git history is real output and must survive.
  write(join(run, 'coding-agent-workdir/.git/HEAD'), 'ref: refs/heads/main\n');
  // Vendored dependency bulk the agent's toolchain created. Reproducible, and
  // it drags in trust stores that trip the credential denylist.
  write(
    join(
      run,
      'coding-agent-workdir/.venv/lib/python3.12/site-packages/certifi/cacert.pem',
    ),
    '-----BEGIN CERTIFICATE-----\n',
  );
  write(
    join(run, 'coding-agent-workdir/.venv/lib/python3.12/site-packages/x.py'),
    'x = 1\n',
  );
  write(
    join(run, 'coding-agent-workdir/__pycache__/main.cpython-312.pyc'),
    'x',
  );
  write(join(run, 'coding-agent-workdir/node_modules/left-pad/index.js'), 'x');

  // Secrets and bulk that must be dropped.
  write(
    join(run, 'home/.codex/auth.json'),
    JSON.stringify({ tokens: { access_token: 'SECRET-ACCESS-TOKEN' } }),
  );
  write(join(run, 'home/.codex/config.toml'), 'model = "gpt"\n');
  write(join(run, 'home/.npm/_cacache/big.bin'), 'x'.repeat(1024));
  // Raw session logs must survive, lifted out of home/.
  write(join(run, 'home/.codex/sessions/2026/rollout.jsonl'), '{"m":"hi"}\n');
  // The archived tree the rev recovery reads.
  write(
    join(
      run,
      'home/.codex/plugins/cache/debug/superpowers/local/skills/brainstorming/SKILL.md',
    ),
    'first version\n',
  );

  return { root, runId };
}

function superpowersRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'sp-'));
  const git = (args: string[]): void => {
    const proc = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (proc.status !== 0) {
      throw new Error(proc.stderr);
    }
  };
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  mkdirSync(join(repo, 'skills/brainstorming'), { recursive: true });
  writeFileSync(join(repo, 'skills/brainstorming/SKILL.md'), 'first version\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'add brainstorming']);
  return repo;
}

function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else {
        out.push(relative(root, path));
      }
    }
  };
  visit(root);
  return out;
}

function runExport(): { bundle: string; runId: string } {
  const { root, runId } = resultsTree();
  const bundle = join(mkdtempSync(join(tmpdir(), 'bundle-')), 'out');
  exportRuns({
    resultsDir: root,
    outDir: bundle,
    superpowersRepo: superpowersRepo(),
    runner,
    sourceHost: 'test-host',
    now: '2026-08-09T00:00:00.000Z',
  });
  return { bundle, runId };
}

test('export drops every credential-bearing file', () => {
  const { bundle } = runExport();
  const files = walk(bundle);

  expect(files.some((f) => f.endsWith('auth.json'))).toBe(false);
  expect(files.some((f) => f.endsWith('credentials.snapshot.yaml'))).toBe(
    false,
  );
  expect(files.some((f) => f.endsWith('config.toml'))).toBe(false);
  // Nothing at all survives from home/ except the lifted sessions.
  expect(files.some((f) => f.includes('/home/'))).toBe(false);

  const dumped = files
    .map((f) => readFileSync(join(bundle, f), 'utf8'))
    .join('');
  expect(dumped).not.toContain('SECRET-ACCESS-TOKEN');
});

test('export keeps the analytical payload and lifts raw sessions', () => {
  const { bundle, runId } = runExport();
  const run = join(bundle, 'runs', runId);

  expect(existsSync(join(run, 'verdict.json'))).toBe(true);
  expect(existsSync(join(run, 'trajectory.json'))).toBe(true);
  expect(existsSync(join(run, 'coding-agent-token-usage.json'))).toBe(true);
  expect(existsSync(join(run, 'phase.json'))).toBe(true);
  expect(existsSync(join(run, 'gauntlet-agent/results/g-1/run.jsonl'))).toBe(
    true,
  );
  expect(existsSync(join(run, 'coding-agent-workdir/src/main.go'))).toBe(true);
  expect(existsSync(join(run, 'raw-sessions/2026/rollout.jsonl'))).toBe(true);
  // The npm cache is bulk, not payload.
  expect(existsSync(join(run, 'raw-sessions/_cacache'))).toBe(false);
  // The agent's commits are output worth keeping.
  expect(existsSync(join(run, 'coding-agent-workdir/.git/HEAD'))).toBe(true);
});

test('vendored dependency dirs are excluded from the workdir', () => {
  const { bundle, runId } = runExport();
  const workdir = join(bundle, 'runs', runId, 'coding-agent-workdir');

  expect(existsSync(join(workdir, '.venv'))).toBe(false);
  expect(existsSync(join(workdir, 'node_modules'))).toBe(false);
  expect(existsSync(join(workdir, '__pycache__'))).toBe(false);
  // Excluding them is what keeps a vendored CA trust store from tripping the
  // credential denylist and aborting a 600-run export.
  expect(walk(workdir).some((f) => f.endsWith('.pem'))).toBe(false);
  expect(existsSync(join(workdir, 'src/main.go'))).toBe(true);
});

test('the manifest records identity, recovery status, and checksums', () => {
  const { bundle, runId } = runExport();
  const manifest = BundleManifestSchema.parse(
    JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8')),
  );

  expect(manifest.source_host).toBe('test-host');
  expect(manifest.entries).toHaveLength(1);
  const entry = manifest.entries[0];
  if (entry === undefined) {
    throw new Error('missing entry');
  }
  expect(entry.run_id).toBe(runId);
  expect(entry.scenario).toBe('demo-scenario');
  expect(entry.coding_agent).toBe('codex');
  expect(entry.credential).toBe('codex_sub');
  expect(entry.final).toBe('pass');
  expect(entry.harness_rev).toBe('abc123harness');
  // The verdict had no rev; the archived tree supplies it exactly.
  expect(entry.rev_recovery).toBe('recovered');
  expect(entry.superpowers_sha).toMatch(/^[0-9a-f]{40}$/);

  // Every checksum must describe the file actually written.
  for (const [relPath, sha] of Object.entries(entry.files)) {
    const actual = Bun.SHA256.hash(
      readFileSync(join(bundle, 'runs', runId, relPath)),
      'hex',
    );
    expect(actual).toBe(sha);
  }
  expect(Object.keys(entry.files).length).toBeGreaterThan(0);
});

// A run with no archived tree (gemini/claude install superpowers by link)
// alongside a codex run from the same campaign whose sha is recoverable.
function corpusWithUnrecoverableRun(startedAt: string): string {
  const { root } = resultsTree();
  const run = join(root, 'cx-eff-cc-ceremony-arch-dev-rep1', 'gem-run');
  write(
    join(run, 'verdict.json'),
    verdict({ coding_agent: 'gemini', started_at: startedAt }),
  );
  write(join(run, 'trajectory.json'), '{"steps":[]}');
  return root;
}

function exportCorpus(root: string): BundleEntry[] {
  const bundle = join(mkdtempSync(join(tmpdir(), 'bundle-')), 'out');
  exportRuns({
    resultsDir: root,
    outDir: bundle,
    superpowersRepo: superpowersRepo(),
    runner,
    sourceHost: 'test-host',
    now: '2026-08-09T00:00:00.000Z',
  });
  return BundleManifestSchema.parse(
    JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8')),
  ).entries;
}

test('an unrecoverable run borrows a co-temporal sha from its campaign', () => {
  // The seeded codex run started 2026-07-30T20:15:15Z; three hours later is
  // well inside the window.
  const entries = exportCorpus(
    corpusWithUnrecoverableRun('2026-07-30T23:15:15.000Z'),
  );
  const gem = entries.find((e) => e.run_id === 'gem-run');

  expect(gem?.rev_recovery).toBe('inferred');
  expect(gem?.inferred_superpowers_sha).toMatch(/^[0-9a-f]{40}$/);
  // The borrowed sha must never occupy the field meaning "this run's sha".
  expect(gem?.superpowers_sha).toBeNull();
});

test('a run with no neighbour inside the window stays unknown', () => {
  const entries = exportCorpus(
    corpusWithUnrecoverableRun('2026-08-15T00:00:00.000Z'),
  );
  const gem = entries.find((e) => e.run_id === 'gem-run');

  expect(gem?.rev_recovery).toBe('unknown');
  expect(gem?.inferred_superpowers_sha).toBeNull();
});

test('a run whose verdict will not parse is skipped, not fatal', () => {
  const { root } = resultsTree();
  write(join(root, 'broken-rep1/run-x/verdict.json'), '{not json');
  const bundle = join(mkdtempSync(join(tmpdir(), 'bundle-')), 'out');

  const summary = exportRuns({
    resultsDir: root,
    outDir: bundle,
    superpowersRepo: superpowersRepo(),
    runner,
    sourceHost: 'test-host',
    now: '2026-08-09T00:00:00.000Z',
  });

  expect(summary.exported).toBe(1);
  expect(summary.skipped).toBe(1);
  const manifest = BundleManifestSchema.parse(
    JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8')),
  );
  expect(manifest.skipped).toHaveLength(1);
  expect(manifest.skipped[0]?.reason).toContain('verdict');
});

test('a run nested below the usual two levels is still found', () => {
  const { root } = resultsTree();
  // Quarantine dirs hold a whole label tree, putting the run one level deeper.
  const run = join(
    root,
    '.quarantine-quota-20260806',
    'cx-eff-demo-rep9',
    'quar-run',
  );
  write(join(run, 'verdict.json'), verdict());
  write(join(run, 'trajectory.json'), '{"steps":[]}');

  const entries = exportCorpus(root);

  expect(entries.map((e) => e.run_id).sort()).toEqual([
    'demo-codex-codex_sub-linux-20260730T201515Z-a325',
    'quar-run',
  ]);
});

test('a verdict inside a payload dir is not mistaken for a run', () => {
  const { root, runId } = resultsTree();
  // A scenario that exercises quorum itself leaves a verdict in the workdir.
  write(
    join(
      root,
      'cx-eff-demo-rep1',
      runId,
      'coding-agent-workdir/results/x/y/verdict.json',
    ),
    verdict(),
  );
  write(
    join(root, 'cx-eff-demo-rep1', runId, 'home/nested/verdict.json'),
    verdict(),
  );

  const entries = exportCorpus(root);

  expect(entries).toHaveLength(1);
  expect(entries[0]?.run_id).toBe(runId);
});

test('a colliding run id is skipped rather than overwriting the first', () => {
  const { root, runId } = resultsTree();
  const clash = join(
    root,
    '.quarantine-quota-20260806',
    'cx-eff-demo-rep1',
    runId,
  );
  write(join(clash, 'verdict.json'), verdict());

  const bundle = join(mkdtempSync(join(tmpdir(), 'bundle-')), 'out');
  const summary = exportRuns({
    resultsDir: root,
    outDir: bundle,
    superpowersRepo: superpowersRepo(),
    runner,
    sourceHost: 'test-host',
    now: '2026-08-09T00:00:00.000Z',
  });

  expect(summary.exported).toBe(1);
  expect(summary.skipped).toBe(1);
  const manifest = BundleManifestSchema.parse(
    JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8')),
  );
  // One copy wins by sort order; the skip names both paths so the collision is
  // diagnosable rather than silent.
  expect(manifest.skipped[0]?.reason).toContain('duplicate run id');
  expect(manifest.skipped[0]?.source_path).toBe(
    join(root, 'cx-eff-demo-rep1', runId),
  );
  expect(manifest.skipped[0]?.reason).toContain(clash);
  expect(manifest.entries[0]?.source_path).toBe(clash);
});

test('an already-exported run is left out of an incremental bundle', () => {
  const { root, runId } = resultsTree();
  const run = join(
    root,
    '.quarantine-quota-20260806',
    'cx-eff-demo-rep9',
    'new-run',
  );
  write(join(run, 'verdict.json'), verdict());

  const bundle = join(mkdtempSync(join(tmpdir(), 'bundle-')), 'out');
  const summary = exportRuns({
    resultsDir: root,
    outDir: bundle,
    superpowersRepo: superpowersRepo(),
    runner,
    sourceHost: 'test-host',
    now: '2026-08-09T00:00:00.000Z',
    excludeRunIds: new Set([runId]),
  });

  // Excluded is not skipped: nothing failed, it is simply already captured.
  expect(summary.exported).toBe(1);
  expect(summary.skipped).toBe(0);
  expect(summary.excluded).toBe(1);
  expect(existsSync(join(bundle, 'runs', runId))).toBe(false);
  expect(existsSync(join(bundle, 'runs', 'new-run', 'verdict.json'))).toBe(
    true,
  );
});

test('bundle files are written private', () => {
  const { bundle } = runExport();
  const mode = statSync(join(bundle, 'manifest.json')).mode & 0o777;
  expect(mode).toBe(0o600);
});
