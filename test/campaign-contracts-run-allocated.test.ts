import { expect, test } from 'bun:test';
import { runAllocatedLine } from '../src/cli/run-command.ts';
import { spawnCollectRunId } from '../src/run-all/index.ts';

const RUN_DIR = 'results/scn-claude-linux-20260824T120000Z-ab12';

test('the protocol line carries the run-id minted at allocation', () => {
  expect(runAllocatedLine(RUN_DIR)).toBe(
    'run_allocated: scn-claude-linux-20260824T120000Z-ab12\n',
  );
});

test("run-all's run-id collection tolerates the allocation line (hermetic printf child)", () => {
  // The parent-pinned protocol is additive: existing parsers scan for the
  // 'run-id: ' prefix and must be unaffected by the earlier machine line.
  // spawnCollectRunId args: {command, args, env, timeoutSeconds?, onPid?,
  // onStderr?} (src/run-all/index.ts); ChildResult is
  // {run_id, exit_code, error}.
  return spawnCollectRunId({
    command: 'printf',
    args: [
      'run_allocated: scn-claude-linux-20260824T120000Z-ab12\nrun-id: scn-claude-linux-20260824T120000Z-ab12\n',
    ],
    env: Bun.env,
  }).then((child) => {
    expect(child.run_id).toBe('scn-claude-linux-20260824T120000Z-ab12');
  });
});
