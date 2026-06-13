import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildResult } from '../src/contracts/batch.ts';
import {
  LaunchBusyError,
  Orchestrator,
} from '../src/dashboard/orchestrator.ts';
import type { InvokeChildArgs } from '../src/run-all/index.ts';
import type { SchedulerEvent } from '../src/scheduler/index.ts';

// A scratch scenarios+agents+results fixture for the orchestrator. The
// orchestrator drives the REAL scheduler/matrix, so it needs a discoverable
// scenario (story.md) and an agent yaml; the invoke is stubbed so no child runs.
interface Fixture {
  readonly root: string;
  readonly scenariosRoot: string;
  readonly codingAgentsDir: string;
  readonly resultsRoot: string;
}

function makeFixture(
  scenarios: readonly string[],
  agents: readonly string[],
): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'orch-'));
  const scenariosRoot = join(root, 'scenarios');
  const codingAgentsDir = join(root, 'coding-agents');
  const resultsRoot = join(root, 'results');
  for (const s of scenarios) {
    const dir = join(scenariosRoot, s);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'story.md'), '# story\n');
    // buildMatrix reads checks.sh for the coding-agents directive; an empty file
    // means "no directive" (the cell is runnable for every agent).
    writeFileSync(join(dir, 'checks.sh'), 'pre() { :; }\npost() { :; }\n');
  }
  mkdirSync(codingAgentsDir, { recursive: true });
  for (const a of agents) {
    writeFileSync(join(codingAgentsDir, `${a}.yaml`), 'max_concurrency: 4\n');
  }
  mkdirSync(resultsRoot, { recursive: true });
  return { root, scenariosRoot, codingAgentsDir, resultsRoot };
}

let fixtures: Fixture[] = [];

beforeEach(() => {
  fixtures = [];
});

afterEach(() => {
  for (const f of fixtures) {
    rmSync(f.root, { recursive: true, force: true });
  }
});

function fixture(
  scenarios: readonly string[],
  agents: readonly string[],
): Fixture {
  const f = makeFixture(scenarios, agents);
  fixtures.push(f);
  return f;
}

// A gated invoke: the first launch's children block on a manually-released gate
// so the session stays "active" while we probe launch()/stop(). It records the
// onPid pids it was handed.
function gatedInvoke(): {
  invoke: (args: InvokeChildArgs) => Promise<ChildResult>;
  release: () => void;
  pids: number[];
  calls: number;
} {
  let releaseGate: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    releaseGate = r;
  });
  const pids: number[] = [];
  let calls = 0;
  const invoke = async (args: InvokeChildArgs): Promise<ChildResult> => {
    calls += 1;
    // Hand back a fake pid through onPid so stop() has something to SIGINT.
    const fakePid = 900000 + calls; // out-of-range pid: kill() throws ESRCH
    args.onPid?.(fakePid);
    pids.push(fakePid);
    await gate;
    return { run_id: null, exit_code: 0, error: null };
  };
  return {
    invoke,
    release: () => {
      releaseGate?.();
    },
    pids,
    calls,
  };
}

test('second launch while active throws LaunchBusyError', async () => {
  const f = fixture(['scn-a'], ['claude']);
  const g = gatedInvoke();
  const orch = new Orchestrator({
    resultsRoot: f.resultsRoot,
    scenariosRoot: f.scenariosRoot,
    codingAgentsDir: f.codingAgentsDir,
    jobs: 4,
    invoke: g.invoke,
  });
  orch.launch({ kind: 'all' });
  expect(orch.active).toBe(true);
  expect(() => orch.launch({ kind: 'all' })).toThrow(LaunchBusyError);
  // Let the gated child finish so the session drains and the batch footer lands.
  g.release();
  await orch.wait();
  expect(orch.active).toBe(false);
});

test('runnableTotal is set from the matrix before children run', async () => {
  const f = fixture(['scn-a', 'scn-b'], ['claude', 'codex']);
  const g = gatedInvoke();
  const orch = new Orchestrator({
    resultsRoot: f.resultsRoot,
    scenariosRoot: f.scenariosRoot,
    codingAgentsDir: f.codingAgentsDir,
    jobs: 8,
    invoke: g.invoke,
  });
  orch.launch({ kind: 'all' });
  // 2 scenarios x 2 agents, all runnable.
  expect(orch.runnableTotal).toBe(4);
  g.release();
  await orch.wait();
});

test('stop() requests scheduler stop and SIGINTs tracked pids', async () => {
  const f = fixture(['scn-a'], ['claude']);
  const g = gatedInvoke();
  const killed: number[] = [];
  const origKill: typeof process.kill = process.kill;
  // Spy on process.kill so stop()'s SIGINT is observed without a real signal.
  // The fake pids are out-of-range, so the real kill would throw ESRCH anyway.
  // The replacement matches process.kill's exact type so no cast is needed.
  const spyKill: typeof process.kill = (
    pid: number,
    signal?: string | number,
  ): true => {
    if (signal === 'SIGINT') {
      killed.push(pid);
      return true;
    }
    return origKill(pid, signal);
  };
  process.kill = spyKill;
  try {
    const orch = new Orchestrator({
      resultsRoot: f.resultsRoot,
      scenariosRoot: f.scenariosRoot,
      codingAgentsDir: f.codingAgentsDir,
      jobs: 4,
      invoke: g.invoke,
    });
    orch.launch({ kind: 'all' });
    // Give the scheduler a tick to dispatch the cell + register the pid.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));
    orch.stop();
    const firstPid = g.pids[0];
    if (firstPid === undefined) {
      throw new Error('expected the gated invoke to have recorded a pid');
    }
    expect(killed).toContain(firstPid);
    g.release();
    await orch.wait();
  } finally {
    process.kill = origKill;
  }
});

test('launch forwards scheduler events and appends results.jsonl', async () => {
  const f = fixture(['scn-a'], ['claude']);
  const events: SchedulerEvent[] = [];
  // A fast invoke that resolves immediately (no gate): the whole batch drains.
  const invoke = async (args: InvokeChildArgs): Promise<ChildResult> => {
    args.onPid?.(900111);
    return { run_id: null, exit_code: 0, error: null };
  };
  const orch = new Orchestrator({
    resultsRoot: f.resultsRoot,
    scenariosRoot: f.scenariosRoot,
    codingAgentsDir: f.codingAgentsDir,
    jobs: 4,
    invoke,
    onEvent: (ev) => {
      events.push(ev);
    },
  });
  orch.launch({ kind: 'all' });
  await orch.wait();
  // The orchestrator forwarded the scheduler's lifecycle events to onEvent.
  const kinds = events.map((e) => e.kind);
  expect(kinds).toContain('cell_queued');
  expect(kinds).toContain('cell_started');
  expect(kinds).toContain('cell_finished');
  expect(kinds).toContain('batch_done');
  // The batch dir + results.jsonl were written (parity with run-all).
  const batchesRoot = join(f.resultsRoot, 'batches');
  expect(existsSync(batchesRoot)).toBe(true);
});

test('kind=row applies a scenario filter; kind=column applies an agent filter', async () => {
  const f = fixture(['scn-a', 'scn-b'], ['claude', 'codex']);
  const makeOrch = (): Orchestrator =>
    new Orchestrator({
      resultsRoot: f.resultsRoot,
      scenariosRoot: f.scenariosRoot,
      codingAgentsDir: f.codingAgentsDir,
      jobs: 8,
      invoke: async (args: InvokeChildArgs): Promise<ChildResult> => {
        args.onPid?.(900222);
        return { run_id: null, exit_code: 0, error: null };
      },
    });

  const rowOrch = makeOrch();
  rowOrch.launch({ kind: 'row', scenario: 'scn-a' });
  // scn-a x {claude, codex} = 2 runnable.
  expect(rowOrch.runnableTotal).toBe(2);
  await rowOrch.wait();

  const colOrch = makeOrch();
  colOrch.launch({ kind: 'column', agent: 'claude' });
  // {scn-a, scn-b} x claude = 2 runnable.
  expect(colOrch.runnableTotal).toBe(2);
  await colOrch.wait();
});

test('the batch.json footer (finished_at) is written when the session drains', async () => {
  const f = fixture(['scn-a'], ['claude']);
  const orch = new Orchestrator({
    resultsRoot: f.resultsRoot,
    scenariosRoot: f.scenariosRoot,
    codingAgentsDir: f.codingAgentsDir,
    jobs: 4,
    invoke: async (): Promise<ChildResult> => ({
      run_id: null,
      exit_code: 0,
      error: null,
    }),
  });
  const batchId = orch.launch({ kind: 'all' });
  await orch.wait();
  const batchJsonPath = join(f.resultsRoot, 'batches', batchId, 'batch.json');
  const header = JSON.parse(readFileSync(batchJsonPath, 'utf8')) as {
    finished_at: string | null;
  };
  expect(header.finished_at).not.toBeNull();
});
