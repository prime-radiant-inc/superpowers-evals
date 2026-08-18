import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { extractManifest, writeManifest } from '../src/check/manifest.ts';
import {
  allocateRunDir,
  buildGauntletArgv,
  contextDirName,
  runScenario,
} from '../src/runner/index.ts';
import { mockGauntletDir } from './mock-gauntlet/shim.ts';

test('allocateRunDir names <scenario>-<agent>-<credential>-<os>-<stamp>-<nonce> and creates it', () => {
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  const dir = allocateRunDir(
    out,
    '00-quorum-smoke-hello-world',
    'claude',
    'sonnet',
  );
  expect(basename(dir)).toMatch(
    /^00-quorum-smoke-hello-world-claude-sonnet-linux-\d{8}T\d{6}Z-[0-9a-f]{4}$/,
  );
  expect(existsSync(dir)).toBe(true);
});

test('allocateRunDir with os=windows id contains -claude-sonnet-windows-', () => {
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  const dir = allocateRunDir(out, 'sc', 'claude', 'sonnet', 'windows');
  expect(basename(dir)).toMatch(
    /^sc-claude-sonnet-windows-\d{8}T\d{6}Z-[0-9a-f]{4}$/,
  );
});

test('allocateRunDir is unique across calls (distinct nonces)', () => {
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  const a = allocateRunDir(out, 'scn', 'codex', 'none');
  const b = allocateRunDir(out, 'scn', 'codex', 'none');
  expect(a).not.toBe(b);
});

test('contextDirName: linux (default) returns the family context dir', () => {
  expect(contextDirName({ name: 'claude', runtime_family: 'claude' })).toBe(
    'claude',
  );
});

test('contextDirName(cfg, os): linux returns runtime_family', () => {
  expect(
    contextDirName({ name: 'claude', runtime_family: 'claude' }, 'linux'),
  ).toBe('claude');
});

test('contextDirName(cfg, os): windows returns runtime_family-windows', () => {
  expect(
    contextDirName({ name: 'claude', runtime_family: 'claude' }, 'windows'),
  ).toBe('claude-windows');
});

test('buildGauntletArgv is exact and order-stable with all optional flags', () => {
  const argv = buildGauntletArgv({
    storyPath: '/s/story.md',
    targetBinary: 'claude',
    runDir: '/r',
    maxTime: '10m',
    projectPrompt: '/r/p.md',
  });
  expect(argv).toEqual([
    'run',
    '/s/story.md',
    '--adapter',
    'tui',
    '--target',
    'claude',
    '--project-dir',
    '/r',
    '--state-dir',
    'gauntlet-agent',
    '--silent',
    '--model',
    'agent=claude-sonnet-5',
    '--max-time',
    '10m',
    '--project-prompt',
    '/r/p.md',
  ]);
});

test('buildGauntletArgv omits optional flags when absent', () => {
  const argv = buildGauntletArgv({
    storyPath: '/s/story.md',
    targetBinary: 'codex',
    runDir: '/r',
  });
  expect(argv).toEqual([
    'run',
    '/s/story.md',
    '--adapter',
    'tui',
    '--target',
    'codex',
    '--project-dir',
    '/r',
    '--state-dir',
    'gauntlet-agent',
    '--silent',
    '--model',
    'agent=claude-sonnet-5',
  ]);
});

test('buildGauntletArgv appends only --max-time when projectPrompt is absent', () => {
  const argv = buildGauntletArgv({
    storyPath: '/s/story.md',
    targetBinary: 'claude',
    runDir: '/r',
    maxTime: '5m',
  });
  expect(argv).toEqual([
    'run',
    '/s/story.md',
    '--adapter',
    'tui',
    '--target',
    'claude',
    '--project-dir',
    '/r',
    '--state-dir',
    'gauntlet-agent',
    '--silent',
    '--model',
    'agent=claude-sonnet-5',
    '--max-time',
    '5m',
  ]);
});

test('buildGauntletArgv honors an explicit graderModel override', () => {
  const argv = buildGauntletArgv({
    storyPath: '/s/story.md',
    targetBinary: 'claude',
    runDir: '/r',
    graderModel: 'claude-sonnet-4-6',
  });
  // The grader model is the only thing that changes; everything else is stable.
  expect(argv).toEqual([
    'run',
    '/s/story.md',
    '--adapter',
    'tui',
    '--target',
    'claude',
    '--project-dir',
    '/r',
    '--state-dir',
    'gauntlet-agent',
    '--silent',
    '--model',
    'agent=claude-sonnet-4-6',
  ]);
});

// --- expected-check manifest wiring ----------------------------------------
//
// The runner must load the scenario's committed checks-manifest.json and
// thread it into verdict composition, so a run whose emitted post-check
// records drift from the committed manifest composes indeterminate — never a
// pass with fewer checks. The harness mirrors test/runner-e2e.test.ts: the
// mock-gauntlet dir first on PATH drives the whole runScenario pipeline for
// $0, and its `pass` fixture yields a gauntlet pass plus a non-empty claude
// session capture, so the run reaches the final compose site.
const MOCK_GAUNTLET_DIR = resolve(import.meta.dir, 'mock-gauntlet');
const REAL_CODING_AGENTS = resolve(import.meta.dir, '..', 'coding-agents');

// A scenario whose committed manifest expects one more post check than
// checks.sh emits. The manifest is generated from the FULL two-check checks.sh
// via the real extractor/writer (the exact `quorum check` generation path),
// then checks.sh is rewritten without the second check — a check vanished
// after the manifest was frozen, the canonical drift this hardening targets.
function makeManifestScenario(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scn-manifest-'));
  writeFileSync(
    join(dir, 'story.md'),
    '---\nquorum_max_time: 1m\n---\nDo the thing.\n',
  );
  // setup.sh seeds the file the SURVIVING post check asserts, so the only
  // manifest/records discrepancy is the vanished entry.
  writeFileSync(
    join(dir, 'setup.sh'),
    '#!/usr/bin/env bash\nprintf x > present.txt\n',
  );
  chmodSync(join(dir, 'setup.sh'), 0o755);
  writeFileSync(
    join(dir, 'checks.sh'),
    'pre() {\n    :\n}\n\npost() {\n    file-exists present.txt\n    file-exists vanished.txt\n}\n',
  );
  writeManifest(dir, extractManifest(join(dir, 'checks.sh')));
  writeFileSync(
    join(dir, 'checks.sh'),
    'pre() {\n    :\n}\n\npost() {\n    file-exists present.txt\n}\n',
  );
  return dir;
}

// Drive runScenario with the mock-gauntlet shim first on PATH and the named
// fixture selected, restoring every mutated env var afterwards (even on
// throw). Uses the REAL coding-agents/ dir (same rationale as
// test/runner-e2e.test.ts): the claude run requires HOWTO + launcher +
// project-prompt + SUPERPOWERS_ROOT substitution, all present there.
async function runWithMockGauntlet(
  scenarioDir: string,
  fixture: string,
): Promise<Awaited<ReturnType<typeof runScenario>>> {
  const outRoot = mkdtempSync(join(tmpdir(), 'out-'));
  const keys = [
    'PATH',
    'ANTHROPIC_API_KEY',
    'AWS_BEARER_TOKEN_BEDROCK',
    'SUPERPOWERS_ROOT',
  ] as const;
  const saved = keys.map((k) => [k, process.env[k]] as const);
  process.env['PATH'] =
    `${mockGauntletDir(fixture)}:${MOCK_GAUNTLET_DIR}:${process.env['PATH'] ?? ''}`;
  process.env['ANTHROPIC_API_KEY'] = 'sk-test';
  process.env['AWS_BEARER_TOKEN_BEDROCK'] = 'bedrock-key-test';
  process.env['SUPERPOWERS_ROOT'] = mkdtempSync(join(tmpdir(), 'sproot-'));
  try {
    return await runScenario({
      scenarioDir,
      codingAgent: 'claude',
      codingAgentsDir: REAL_CODING_AGENTS,
      outRoot,
    });
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

test('runner loads the scenario manifest and passes it to compose', async () => {
  const { verdict } = await runWithMockGauntlet(makeManifestScenario(), 'pass');
  // A vanished post-check record must not let a gauntlet pass compose pass.
  expect(verdict.final).toBe('indeterminate');
  expect(verdict.error?.stage).toBe('checks');
  expect(verdict.final_reason).toContain('manifest');
  // The mismatch is the vanished entry itself, not an unrelated gate.
  expect(verdict.final_reason).toContain('vanished.txt');
});

// A committed-but-unparseable manifest is repository misconfiguration: it
// must triage as a setup-stage indeterminate — distinct from a runtime
// record mismatch, which the composer correctly keeps checks-stage.
function makeMalformedManifestScenario(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scn-manifest-bad-'));
  writeFileSync(
    join(dir, 'story.md'),
    '---\nquorum_max_time: 1m\n---\nDo the thing.\n',
  );
  writeFileSync(join(dir, 'setup.sh'), '#!/usr/bin/env bash\n:\n');
  chmodSync(join(dir, 'setup.sh'), 0o755);
  writeFileSync(
    join(dir, 'checks.sh'),
    'pre() {\n    :\n}\n\npost() {\n    :\n}\n',
  );
  writeFileSync(join(dir, 'checks-manifest.json'), '{ this is not json');
  return dir;
}

test('runner stages an unparseable checks-manifest.json as a setup error', async () => {
  const { verdict } = await runWithMockGauntlet(
    makeMalformedManifestScenario(),
    'pass',
  );
  // The load fails before gauntlet ever spawns; the verdict must carry the
  // setup stage and name the offending file for triage.
  expect(verdict.final).toBe('indeterminate');
  expect(verdict.error?.stage).toBe('setup');
  expect(verdict.final_reason).toContain('checks-manifest.json');
});
