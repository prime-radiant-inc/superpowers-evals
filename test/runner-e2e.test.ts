import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runScenario } from '../src/runner/index.ts';

// The mock-gauntlet dir holds the executable `gauntlet` shim that execs
// mock-gauntlet.ts. Putting this dir first on PATH makes the runner's literal
// `gauntlet` spawn resolve to the stub, so the whole pipeline runs for $0.
const MOCK = resolve(import.meta.dir, 'mock-gauntlet');

// The REAL coding-agents/ dir (sibling of test/, one level up from import.meta.dir).
// The runner now requires claude-context/ + claude.project-prompt.md to exist
// for a claude run (populateContextDir required + project_prompt-existence
// check); both live in the real dir, so we point the e2e there rather than at a
// synthetic fixture missing them. The real claude.yaml's session_log_dir is the
// same ${CLAUDE_CONFIG_DIR}/projects the mock-gauntlet seeds.
const REAL_CODING_AGENTS = resolve(import.meta.dir, '..', 'coding-agents');

// A minimal scenario the runner can drive: a story carrying quorum_max_time, an
// executable no-op setup.sh, and a checks.sh whose pre/post phases assert
// nothing (no trace primitives), so the verdict is decided by the gauntlet
// fixture's status alone.
function makeScenario(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scn-'));
  writeFileSync(
    join(dir, 'story.md'),
    '---\nquorum_max_time: 1m\n---\nDo the thing.\n',
  );
  writeFileSync(join(dir, 'setup.sh'), '#!/usr/bin/env bash\n:\n');
  chmodSync(join(dir, 'setup.sh'), 0o755);
  writeFileSync(join(dir, 'checks.sh'), 'pre() { :; }\npost() { :; }\n');
  return dir;
}

// Drive runScenario with the mock-gauntlet on PATH and the named fixture
// selected, restoring every mutated env var afterwards (even on throw). Uses the
// REAL coding-agents/ dir so the claude run's required context (HOWTO + launcher
// + project-prompt + home-skeleton) is present. SUPERPOWERS_ROOT is set because
// the real claude.yaml lists it in required_env and the $SUPERPOWERS_ROOT
// substitution reads it.
async function runWithFixture(
  fixture: string,
): Promise<Awaited<ReturnType<typeof runScenario>>> {
  const scenarioDir = makeScenario();
  const outRoot = mkdtempSync(join(tmpdir(), 'out-'));

  // process.env is an index signature, so noPropertyAccessFromIndexSignature
  // requires bracket access throughout (the standard's tsconfig is ON).
  const prevPath = process.env['PATH'];
  const prevKey = process.env['ANTHROPIC_API_KEY'];
  const prevRoot = process.env['SUPERPOWERS_ROOT'];
  const prevFixture = process.env['MOCK_GAUNTLET_FIXTURE'];
  process.env['PATH'] = `${MOCK}:${prevPath ?? ''}`;
  process.env['ANTHROPIC_API_KEY'] = 'sk-test';
  process.env['SUPERPOWERS_ROOT'] = mkdtempSync(join(tmpdir(), 'sproot-'));
  process.env['MOCK_GAUNTLET_FIXTURE'] = fixture;
  try {
    return await runScenario({
      scenarioDir,
      codingAgent: 'claude',
      codingAgentsDir: REAL_CODING_AGENTS,
      outRoot,
    });
  } finally {
    if (prevPath === undefined) {
      delete process.env['PATH'];
    } else {
      process.env['PATH'] = prevPath;
    }
    if (prevKey === undefined) {
      delete process.env['ANTHROPIC_API_KEY'];
    } else {
      process.env['ANTHROPIC_API_KEY'] = prevKey;
    }
    if (prevRoot === undefined) {
      delete process.env['SUPERPOWERS_ROOT'];
    } else {
      process.env['SUPERPOWERS_ROOT'] = prevRoot;
    }
    if (prevFixture === undefined) {
      delete process.env['MOCK_GAUNTLET_FIXTURE'];
    } else {
      process.env['MOCK_GAUNTLET_FIXTURE'] = prevFixture;
    }
  }
}

test('mock-gauntlet drives a full pass run to a parity verdict', async () => {
  const { verdict } = await runWithFixture('pass');
  expect(verdict.schema).toBe(1);
  expect(verdict.final).toBe('pass');
  expect(verdict.gauntlet?.status).toBe('pass');
  // No error stage on the happy path, and the gauntlet layer is composed in.
  expect(verdict.error).toBe(null);
});

test('mock-gauntlet drives a fail fixture to a fail verdict', async () => {
  const { verdict } = await runWithFixture('fail-no-usage');
  expect(verdict.schema).toBe(1);
  expect(verdict.final).toBe('fail');
  expect(verdict.gauntlet?.status).toBe('fail');
  // economics is tolerated as partial/null when usage is absent (no assertion
  // on its contents — the e2e is a genuine obol round-trip, not a fixture).
  expect(verdict.error).toBe(null);
});
