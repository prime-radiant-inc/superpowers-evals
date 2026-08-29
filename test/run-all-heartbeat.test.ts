import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChildResult } from '../src/contracts/batch.ts';
import { setProcessEnv } from '../src/env.ts';

const HOST_STATS_FIXTURE = resolve(
  import.meta.dir,
  'fixtures',
  'host-stats.json',
);

import type { InvokeFn } from '../src/run-all/index.ts';
import { runBatch } from '../src/run-all/index.ts';

// runBatch now acquires the host-wide live-spend lock (R-LCK-2, task 9c):
// pin it to a per-file tmp path through the env seam — parallel test
// processes must never contend for the $HOME default, and tests never
// touch $HOME.
setProcessEnv(
  'QUORUM_LIVE_SPEND_LOCK',
  join(mkdtempSync(join(tmpdir(), 'qlock-')), 'live.lock.d'),
);
// The floors preflight runs on every runBatch acquisition (R-LCK-2): inject
// the passing host-stats fixture through the seam — never a skipped gate.
setProcessEnv('QUORUM_HOST_STATS_PROBE_FIXTURE', HOST_STATS_FIXTURE);

function fixture(names: readonly string[]): {
  scenariosRoot: string;
  codingAgentsDir: string;
  outRoot: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'runall-hb-'));
  const scenariosRoot = join(root, 'scenarios');
  const codingAgentsDir = join(root, 'coding-agents');
  const outRoot = join(root, 'results');
  mkdirSync(scenariosRoot, { recursive: true });
  mkdirSync(codingAgentsDir, { recursive: true });
  mkdirSync(outRoot, { recursive: true });
  for (const name of names) {
    const dir = join(scenariosRoot, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'story.md'), 'body\n');
    writeFileSync(join(dir, 'checks.sh'), 'pre() { :; }\npost() { :; }\n');
  }
  writeFileSync(join(codingAgentsDir, 'claude.yaml'), 'name: claude\n');
  return { scenariosRoot, codingAgentsDir, outRoot };
}

class StringStream {
  text = '';
  write(s: string): void {
    this.text += s;
  }
}

test('runBatch emits a heartbeat line via the injected timer and stops it at the end', async () => {
  const { scenariosRoot, codingAgentsDir, outRoot } = fixture(['a', 'b']);

  let tick!: () => void;
  let stoppedHeartbeat = 0;
  const startHeartbeat = (t: () => void): (() => void) => {
    tick = t;
    return () => {
      stoppedHeartbeat += 1;
    };
  };

  // jobs:1 -> 'a' is in flight (held open), 'b' is queued, when the tick fires.
  let started = 0;
  let release!: (r: ChildResult) => void;
  const invoke: InvokeFn = (args) =>
    new Promise<ChildResult>((resolve) => {
      started += 1;
      args.onPid?.(started);
      if (started === 1) {
        release = resolve;
      } else {
        resolve({ run_id: null, exit_code: 0, error: null });
      }
    });

  const stream = new StringStream();
  const run = runBatch({
    scenariosRoot,
    codingAgentsDir,
    outRoot,
    jobs: 1,
    invoke,
    startHeartbeat,
    heartbeatSeconds: 30,
    installSignals: () => () => {},
    stream,
  });

  while (started < 1) {
    await new Promise((r) => setTimeout(r, 1));
  }
  tick();
  expect(stream.text).toMatch(/running 1\/1 · done 0 · queued 1/);

  release({ run_id: null, exit_code: 0, error: null });
  await run;
  expect(stoppedHeartbeat).toBe(1);
});
