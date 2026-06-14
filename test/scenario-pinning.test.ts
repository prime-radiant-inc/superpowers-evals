import { expect, test } from 'bun:test';
import { existsSync, readdirSync, statSync } from 'node:fs';
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
  'antigravity-superpowers-bootstrap',
  'codex-native-hooks-bootstrap',
  'codex-subagent-wait-mapping',
  'codex-tool-mapping-comprehension',
  'copilot-superpowers-bootstrap',
  'gemini-superpowers-bootstrap',
  'kimi-superpowers-bootstrap',
  'opencode-superpowers-bootstrap',
  'pi-superpowers-bootstrap',
  'sdd-spec-context-consumed',
  'worktree-creation-under-pressure',
  'worktree-no-drift-to-main',
]);

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
