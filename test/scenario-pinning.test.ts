import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseCodingAgentsDirective } from '../src/checks/index.ts';
import { repoRoot } from '../src/paths.ts';

// Scenario unpin fence (oracle 08c3c6a, mirrors tests/quorum/test_scenario_pinning.py).
// A scenario is "pinned" iff its checks.sh carries a leading `# coding-agents:`
// directive (parseCodingAgentsDirective !== undefined). Pinning narrows a scenario
// to specific coding-agents, so the set of pinned scenarios is a deliberate harness
// decision — this frozen allowlist makes any silent (un)pin land RED instead of
// quietly changing matrix coverage. Verified against the live scenarios dir on disk.
const INTENTIONAL_PINNED_SCENARIOS = new Set<string>([
  'codex-windows-session-start-hook',
  'codex-subagent-wait-mapping',
  'codex-tool-mapping-comprehension',
  'sdd-spec-context-consumed',
  'worktree-creation-under-pressure',
  'worktree-no-drift-to-main',
  // Builder campaign fixture: intentionally limited to the Serf harness and
  // Linux, where its Go toolchain and SDD subagent workflow are validated.
  'serf-builder-fractals',
  // User-override evals: pinned to the agents whose ambient-instructions file is
  // verified (the inject-user-preference map) — pi/antigravity/opencode excluded
  // until probed.
  'user-pref-no-brainstorm',
  'user-pref-no-tdd',
  'user-pref-no-worktree',
  'user-pref-react-no-tdd-met',
  'user-pref-react-no-tdd-unmet',
  'user-pref-corp-no-brainstorm-met',
  'user-pref-corp-no-brainstorm-unmet',
  'user-pref-spec-location',
  'user-pref-sdd-no-strategy-prompt',
  'user-pref-no-visual-companion',
  'user-pref-no-visual-companion-control',
  // Campaign #1934/#1935 probes: pinned to claude,codex (the campaign's two
  // gate columns; other agents' fixture/runner behavior is unverified for these).
  'tdd-holds-under-tests-later-pressure',
  'verification-holds-under-just-confirm-pressure',
  'writing-good-tests-rejects-mock-existence-assertion',
  'writing-good-tests-no-coverage-over-correction',
  'writing-good-tests-rejects-test-only-teardown',
  'writing-good-tests-mock-at-right-level',
]);

test('Serf builder scenario pins its exact content-addressed source pair', () => {
  const scenarioDir = join(repoRoot(), 'scenarios', 'serf-builder-fractals');
  const manifestPath = join(scenarioDir, 'baseline-manifest.json');
  expect(existsSync(manifestPath)).toBe(true);
  if (!existsSync(manifestPath)) return;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;

  expect(manifest).toEqual({
    schema_version: 1,
    roles: {
      spec: 'docs/superpowers/specs/2026-07-01-fractals-cli-design.md',
      plan: 'docs/superpowers/plans/2026-07-01-fractals-cli.md',
    },
    files: [
      {
        path: 'docs/superpowers/plans/2026-07-01-fractals-cli.md',
        mode: '100644',
        sha256:
          '927f9ed4a0ef20c29c8232899c7ae13af01620a0931c18f2fa46f0f4ed2c5dd6',
      },
      {
        path: 'docs/superpowers/specs/2026-07-01-fractals-cli-design.md',
        mode: '100644',
        sha256:
          '7d7e963333e562103bace8c27281d69a0ada2511b269db180412e75796d0c5be',
      },
    ],
  });
});

test('harness pins are exactly the explicitly intentional scenarios', () => {
  const scenarioRoot = join(repoRoot(), 'scenarios');
  const pinned = new Set<string>();
  for (const entry of readdirSync(scenarioRoot)) {
    const scenarioDir = join(scenarioRoot, entry);
    if (!statSync(scenarioDir).isDirectory()) {
      continue;
    }
    const checksSh = join(scenarioDir, 'checks.sh');
    if (!existsSync(checksSh)) {
      continue;
    }
    if (parseCodingAgentsDirective(checksSh) !== undefined) {
      pinned.add(entry);
    }
  }
  expect(pinned).toEqual(INTENTIONAL_PINNED_SCENARIOS);
});
