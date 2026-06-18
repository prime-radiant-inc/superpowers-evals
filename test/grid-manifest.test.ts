import { expect, test } from 'bun:test';
import { buildGridManifest } from '../src/run-all/matrix.ts';

test('grid manifest fans agents across os_support and carries skip reasons', () => {
  const m = buildGridManifest({
    scenariosRoot: 'test/fixtures/grid/scenarios',
    codingAgentsDir: 'test/fixtures/grid/coding-agents',
  });
  // claude supports [linux, windows]; codex supports [linux] only:
  const claudeWin = m.cells.find(
    (c) => c.agent === 'claude' && c.os === 'windows' && c.scenario === 's1',
  );
  const codexWin = m.cells.find(
    (c) => c.agent === 'codex' && c.os === 'windows',
  );
  expect(claudeWin).toBeDefined();
  expect(codexWin).toBeUndefined(); // codex has no windows sub-column
  // s2 has `# coding-agents: codex` → claude is directive-excluded there:
  const claudeS2 = m.cells.find(
    (c) => c.scenario === 's2' && c.agent === 'claude' && c.os === 'linux',
  );
  expect(claudeS2?.eligible).toBe(false);
  expect(claudeS2?.skipped_reason).toBe('directive');
  expect(m.scenarios).toContain('s1');
});
