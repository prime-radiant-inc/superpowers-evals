import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runPhase } from '../src/checks/index.ts';
import { writePhase } from '../src/runner/phase.ts';

const IDENTITY = {
  scenario: 'demo',
  agent: 'claude',
  credential: 'none',
  os: 'linux',
};

test('writePhase writes {phase, updated_at, pid, identity}', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phase-'));
  writePhase(dir, 'agent', IDENTITY);
  const j = JSON.parse(readFileSync(join(dir, 'phase.json'), 'utf8'));
  expect(j.phase).toBe('agent');
  expect(typeof j.pid).toBe('number');
  expect(j.pid).toBe(process.pid);
  expect(typeof j.updated_at).toBe('string');
});

test('writePhase writes the run self-identity into phase.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phase-'));
  writePhase(dir, 'setup', {
    scenario: 'my-scn',
    agent: 'claude-haiku',
    credential: 'opus',
    os: 'windows',
  });
  const j = JSON.parse(readFileSync(join(dir, 'phase.json'), 'utf8'));
  expect(j.identity.scenario).toBe('my-scn');
  expect(j.identity.agent).toBe('claude-haiku');
  expect(j.identity.credential).toBe('opus');
  expect(j.identity.os).toBe('windows');
});

test('runPhase exposes QUORUM_SCENARIO_DIR to the baseline-manifest check verb', async () => {
  const scenarioDir = mkdtempSync(join(tmpdir(), 'scenario-phase-'));
  const workdir = mkdtempSync(join(tmpdir(), 'worktree-phase-'));
  try {
    const path = 'docs/superpowers/plans/plan.md';
    const fixture = join(scenarioDir, 'fixtures', path);
    const seeded = join(workdir, path);
    mkdirSync(join(fixture, '..'), { recursive: true });
    mkdirSync(join(seeded, '..'), { recursive: true });
    writeFileSync(fixture, 'PLAN\n');
    writeFileSync(seeded, 'PLAN\n');
    const digest = createHash('sha256').update('PLAN\n').digest('hex');
    writeFileSync(
      join(scenarioDir, 'baseline-manifest.json'),
      JSON.stringify({
        schema_version: 1,
        roles: { spec: path, plan: path },
        files: [{ path, mode: '100644', sha256: digest }],
      }),
    );
    const checksSh = join(scenarioDir, 'checks.sh');
    writeFileSync(checksSh, 'pre() { baseline-manifest; }\npost() { :; }\n');

    const result = await runPhase({
      checksSh,
      phase: 'pre',
      workdir,
      repoRoot: resolve(import.meta.dir, '..'),
      scenarioDir,
    });

    expect(result.exitCode).toBe(0);
    expect(result.records).toMatchObject([
      { check: 'baseline-manifest', passed: true, phase: 'pre' },
    ]);
  } finally {
    rmSync(scenarioDir, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});
