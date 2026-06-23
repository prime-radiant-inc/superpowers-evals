import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BatchHeaderSchema,
  type ChildResult,
  ResultRecordSchema,
} from '../src/contracts/batch.ts';
import type { KillFn } from '../src/run-all/child-stop.ts';
import type { InvokeFn } from '../src/run-all/index.ts';
import { runAllStopSignalsForEnv, runBatch } from '../src/run-all/index.ts';

// A scenarios-root + coding-agents dir + empty out-root, one agent.
function fixture(names: readonly string[]): {
  scenariosRoot: string;
  codingAgentsDir: string;
  outRoot: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'runall-stop-'));
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

test('detached run-all mode ignores SIGHUP but keeps explicit stop signals', () => {
  expect(runAllStopSignalsForEnv({})).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP']);
  expect(
    runAllStopSignalsForEnv({ QUORUM_RUN_ALL_SIGNAL_MODE: 'detached' }),
  ).toEqual(['SIGINT', 'SIGTERM']);
});

function readResults(
  batchDir: string,
): ReturnType<typeof ResultRecordSchema.parse>[] {
  return readFileSync(join(batchDir, 'results.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => ResultRecordSchema.parse(JSON.parse(line)));
}

test('a signal mid-drive stops the queue, SIGINTs in-flight children, and still writes the footer', async () => {
  const { scenariosRoot, codingAgentsDir, outRoot } = fixture(['a', 'b', 'c']);

  // jobs:1 -> 'a' is in flight; 'b' and 'c' are queued, when the signal fires.
  // The in-flight child resolves only when "killed" (SIGINT), writing a stopped
  // verdict like the real runner's SIGINT handler would.
  let nextPid = 9000;
  let started = 0;
  const resolvers = new Map<number, () => void>();
  const invoke: InvokeFn = (args) =>
    new Promise<ChildResult>((resolve) => {
      started += 1;
      const pid = nextPid++;
      args.onPid?.(pid);
      const runId = `${args.codingAgent}-${pid}`;
      resolvers.set(pid, () => {
        const runDir = join(outRoot, runId);
        mkdirSync(runDir, { recursive: true });
        writeFileSync(
          join(runDir, 'verdict.json'),
          JSON.stringify({
            schema: 1,
            final: 'indeterminate',
            final_reason: 'run stopped before completion',
            gauntlet: null,
            checks: [],
            error: { stage: 'stopped', message: 'run interrupted by SIGINT' },
            economics: null,
          }),
        );
        resolve({ run_id: runId, exit_code: -1, error: null });
      });
    });
  const kill: KillFn = (pid) => resolvers.get(pid)?.();

  let fire!: () => void;
  let uninstalled = 0;
  const installSignals = (handler: () => void): (() => void) => {
    fire = handler;
    return () => {
      uninstalled += 1;
    };
  };

  const stream = new StringStream();
  const run = runBatch({
    scenariosRoot,
    codingAgentsDir,
    outRoot,
    jobs: 1,
    invoke,
    kill,
    installSignals,
    stream,
  });

  while (started < 1) {
    await new Promise((r) => setTimeout(r, 1));
  }
  fire();

  const batchDir = await run;

  const header = BatchHeaderSchema.parse(
    JSON.parse(readFileSync(join(batchDir, 'batch.json'), 'utf8')),
  );
  expect(header.finished_at).not.toBeNull();
  expect(uninstalled).toBe(1);

  const results = readResults(batchDir);
  // 'a' was in flight -> recorded as a finished cell (its stopped verdict).
  expect(results.find((r) => r.scenario === 'a')?.run_id).not.toBeNull();
  // 'b' and 'c' were queued -> eager-skipped 'stopped'.
  for (const name of ['b', 'c']) {
    expect(results.find((r) => r.scenario === name)?.skipped).toBe('stopped');
  }
  expect(stream.text).toContain('(stopped)');
});

test('a second signal triggers the hard-exit fallback', async () => {
  const { scenariosRoot, codingAgentsDir, outRoot } = fixture(['a']);

  let started = 0;
  let release!: (r: ChildResult) => void;
  const invoke: InvokeFn = (args) =>
    new Promise<ChildResult>((resolve) => {
      started += 1;
      args.onPid?.(1);
      release = resolve;
    });

  let fire!: () => void;
  const installSignals = (handler: () => void): (() => void) => {
    fire = handler;
    return () => {};
  };
  let hardExited = 0;
  const hardExit = (): void => {
    hardExited += 1;
  };

  const run = runBatch({
    scenariosRoot,
    codingAgentsDir,
    outRoot,
    jobs: 1,
    invoke,
    installSignals,
    hardExit,
    kill: () => {}, // no-op: 'a' stays in flight after the first signal
    stream: new StringStream(),
  });

  while (started < 1) {
    await new Promise((r) => setTimeout(r, 1));
  }
  fire();
  expect(hardExited).toBe(0);
  fire();
  expect(hardExited).toBe(1);

  // Let the batch settle so there is no dangling drive.
  release({ run_id: null, exit_code: -1, error: 'stopped' });
  await run;
});
