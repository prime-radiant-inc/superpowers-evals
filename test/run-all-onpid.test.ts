import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { invokeChild } from '../src/run-all/index.ts';

// invokeChild must report the spawned child's OS pid through the optional onPid
// hook so the dashboard can SIGINT in-flight children (Task 11). We don't need a
// successful run: the pid is assigned synchronously after spawn, before the
// child does any work. Spawning the real CLI `run` against a nonexistent
// scenario dir exits fast (the run resolves with an error result) while still
// proving onPid fired with a numeric pid. Bounded by a short timeout so a
// regression can't hang the suite.
test('invokeChild reports the child pid via onPid', async () => {
  let pid: number | null = null;
  const outRoot = mkdtempSync(join(tmpdir(), 'onpid-'));
  const result = await invokeChild({
    scenarioDir: '/nonexistent-scenario-dir',
    codingAgent: 'nope',
    codingAgentsDir: '/nonexistent-coding-agents',
    outRoot,
    timeoutSeconds: 30,
    onPid: (p) => {
      pid = p;
    },
  });
  expect(typeof pid).toBe('number');
  expect(pid).toBeGreaterThan(0);
  // The child against a bogus scenario produces a non-success result; the run-id
  // line is never printed, so run_id is null. (We assert the hook fired, not the
  // run outcome.)
  expect(result.run_id).toBeNull();
});
