import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { envSnapshot } from '../src/env.ts';
import { spawnCollectRunId } from '../src/run-all/index.ts';

// H-child-stderr-not-drained: Python's invoke_child uses
// subprocess.run(capture_output=True), which drains BOTH stdout and stderr into
// in-memory buffers, so a child writing a lot of stderr never blocks on its
// write(). The prior TS spawn attached a data listener ONLY to child.stdout and
// left child.stderr piped-but-unread. This test pins the parity behavior: the
// spawn core must actively CONSUME the child's stderr while still capturing the
// run-id from stdout.
//
// The child floods ~512KB to stderr before printing its run-id on stdout. The
// onStderr hook must observe those bytes flowing (proving stderr is drained,
// not ignored), and the run-id must still be parsed. Bounded by a short test
// timeout so a regression that stops draining can't hang the suite.
test('spawnCollectRunId drains child stderr while capturing the run-id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stderr-drain-'));
  const script = join(dir, 'flood.ts');
  const floodBytes = 8 * 64 * 1024; // 512KB, 8x the ~64KB OS pipe buffer
  writeFileSync(
    script,
    [
      `const blob = 'x'.repeat(${floodBytes});`,
      'process.stderr.write(blob);',
      "process.stdout.write('run-id: flood-ok\\n');",
    ].join('\n'),
  );

  let stderrBytes = 0;
  const result = await spawnCollectRunId({
    command: process.execPath,
    args: [script],
    env: { ...envSnapshot() },
    timeoutSeconds: 15,
    onStderr: (n) => {
      stderrBytes += n;
    },
  });

  expect(result.error).toBeNull();
  expect(result.run_id).toBe('flood-ok');
  // The full flood must have been consumed off the stderr pipe.
  expect(stderrBytes).toBe(floodBytes);
}, 20_000);
