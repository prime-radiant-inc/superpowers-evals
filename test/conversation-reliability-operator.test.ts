import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  createOutputRoot,
  executeStage,
  gitHead,
  loadExecutionInput,
  runChild,
  type StageDependencies,
  validatePriorSummary,
} from '../docs/experiments/2026-09-08-conversation-reliability/run.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const qSha = 'a'.repeat(40);
const sources = {
  candidate: {
    root: '/srv/quorum/pilots/conversation-assessment/gauntlet-reliability',
    sha: 'b'.repeat(40),
  },
};
const start = Date.parse('2026-09-08T12:00:00Z');
const cutoffAt = '2026-09-08T16:00:00.000Z';
function temp(): string {
  const root = mkdtempSync(
    join(tmpdir(), 'conversation-reliability-operator-'),
  );
  roots.push(root);
  return root;
}
function json(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

// The injected Gauntlet parser represents the already checked source checkout.
// Planning must use its returned card ID, rather than a fixed review run prefix.
const parseRubric = (text: string) => ({ id: text.trim() });
function fixture(stage: 'known' | 'controls' = 'known') {
  const root = temp();
  const inputDir = join(root, 'input');
  mkdirSync(inputDir);
  const cases: {
    id: string;
    rubric: string;
    evidence_root: string;
    evidence_index: string;
    gauntlet_root: string;
    gauntlet_sha: string;
  }[] = [];
  for (let i = 0; i < 6; i++) {
    const name = `case-${i}`;
    const evidence = join(inputDir, name);
    mkdirSync(evidence);
    json(join(evidence, 'index.json'), { files: ['delivery.txt'] });
    writeFileSync(join(evidence, 'delivery.txt'), `retained delivery ${i}`);
    writeFileSync(
      join(inputDir, `${name}.md`),
      i % 2 ? 'conversation-design' : 'conversation-pricing',
    );
    for (let repeat = 1; repeat <= 2; repeat++) {
      cases.push({
        id: `${name}-candidate-${repeat}`,
        rubric: `${name}.md`,
        evidence_root: name,
        evidence_index: `${name}/index.json`,
        gauntlet_root: sources.candidate.root,
        gauntlet_sha: sources.candidate.sha,
      });
    }
  }
  json(join(inputDir, 'expected.json'), { frozen: 'expectations' });
  const envelope = {
    stage,
    q_sha: qSha,
    cutoff_at: cutoffAt,
    expectations: {
      path: 'expected.json',
      sha256: digest(join(inputDir, 'expected.json')),
    },
    sources,
    cases,
  };
  json(join(inputDir, 'cases.json'), envelope);
  return { root, inputDir, envelope };
}
function fakeDependencies(
  overrides: Partial<StageDependencies> = {},
): StageDependencies {
  return {
    now: () => start,
    signal: new AbortController().signal,
    acquireLease: () => ({ heartbeat() {}, release() {} }),
    verifyInputs() {},
    async execute(_entry, out) {
      json(join(out, 'result.json'), { status: 'pass' });
      json(join(out, 'usage.jsonl'), { cost: 0.25 });
      return { code: 0, signal: null, timedOut: false, spawnError: false };
    },
    async priceUsage(path) {
      try {
        return (JSON.parse(readFileSync(path, 'utf8')) as { cost: number })
          .cost;
      } catch {
        return null;
      }
    },
    ...overrides,
  };
}
async function runKnown(overrides: Partial<StageDependencies> = {}) {
  const f = fixture();
  const input = loadExecutionInput(f.inputDir, parseRubric);
  const output = createOutputRoot(input, join(f.root, 'output'));
  const deps = fakeDependencies(overrides);
  const summary = await executeStage(input, output, deps);
  return { ...f, input, output, deps, summary };
}

test('plans twelve candidate-only rows using each parsed rubric ID and freezes full evidence bytes', () => {
  const f = fixture();
  const input = loadExecutionInput(f.inputDir, parseRubric);
  expect(input.cases).toHaveLength(12);
  expect(input.cases[0]?.scenario_id).toBe('conversation-pricing');
  expect(input.cases[2]?.scenario_id).toBe('conversation-design');
  const before = input.inputs_sha256;
  writeFileSync(join(f.inputDir, 'case-0/delivery.txt'), 'changed evidence');
  expect(loadExecutionInput(f.inputDir, parseRubric).inputs_sha256).not.toBe(
    before,
  );
});

test('freezes the finite cutoff as part of the input identity', () => {
  const f = fixture();
  const before = loadExecutionInput(f.inputDir, parseRubric).inputs_sha256;
  f.envelope.cutoff_at = '2026-09-08T15:30:00.000Z';
  json(join(f.inputDir, 'cases.json'), f.envelope);
  const changed = loadExecutionInput(f.inputDir, parseRubric);
  expect(changed.inputs_sha256).not.toBe(before);
  expect(changed.cutoff_at).toBe('2026-09-08T15:30:00.000Z');
});

test('refuses changed criterion expectations outside the evidence indexes', () => {
  const f = fixture();
  loadExecutionInput(f.inputDir, parseRubric);
  json(join(f.inputDir, 'expected.json'), { frozen: 'changed' });
  expect(() => loadExecutionInput(f.inputDir, parseRubric)).toThrow(
    'expectation digest mismatch',
  );
});

test('refuses a frozen cutoff beyond the four-hour live window', async () => {
  const f = fixture();
  f.envelope.cutoff_at = '2026-09-08T16:00:00.001Z';
  json(join(f.inputDir, 'cases.json'), f.envelope);
  const input = loadExecutionInput(f.inputDir, parseRubric);
  const output = createOutputRoot(input, join(f.root, 'output'));
  await expect(executeStage(input, output, fakeDependencies())).rejects.toThrow(
    'four-hour live window',
  );
});

test('rejects duplicate IDs, wrong counts, foreign roots and mismatched source SHAs', () => {
  for (const mutation of [
    'duplicate',
    'count',
    'root',
    'sha',
    'commands',
  ] as const) {
    const f = fixture();
    if (mutation === 'duplicate')
      f.envelope.cases[1]!.id = f.envelope.cases[0]!.id;
    if (mutation === 'count') f.envelope.cases.pop();
    if (mutation === 'root')
      f.envelope.cases[0]!.gauntlet_root = '/tmp/arbitrary';
    if (mutation === 'sha') f.envelope.cases[0]!.gauntlet_sha = 'f'.repeat(40);
    json(
      join(f.inputDir, 'cases.json'),
      mutation === 'commands'
        ? { ...f.envelope, args: ['--eval', 'bad'] }
        : f.envelope,
    );
    expect(() => loadExecutionInput(f.inputDir, parseRubric)).toThrow();
  }
});

test('rejects output reuse and overlap with inputs or retained evidence', () => {
  const f = fixture();
  const input = loadExecutionInput(f.inputDir, parseRubric);
  const out = createOutputRoot(input, join(f.root, 'output'));
  expect(() => createOutputRoot(input, out)).toThrow();
  expect(() => createOutputRoot(input, join(f.inputDir, 'out'))).toThrow();
});

test('tracked dirty sources are refused by the real git boundary', () => {
  const root = temp();
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(result.stderr);
  };
  git(['init', '--quiet']);
  writeFileSync(join(root, 'tracked'), 'source');
  git(['add', 'tracked']);
  git([
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-qm',
    'fixture',
  ]);
  expect(gitHead(root)).toHaveLength(40);
  writeFileSync(join(root, 'tracked'), 'changed');
  expect(() => gitHead(root)).toThrow('tracked source changes');
});

test('records a complete finite stage including valid fails and scenario-derived output IDs', async () => {
  const run = await runKnown({
    async execute(entry, out) {
      expect(basename(out).split('_')[0]).toBe(entry.scenario_id);
      expect(
        readFileSync(join(entry.evidence_root, 'delivery.txt'), 'utf8'),
      ).toStartWith('retained delivery');
      json(join(out, 'result.json'), { status: 'fail' });
      json(join(out, 'usage.jsonl'), { cost: 0.25 });
      return { code: 1, signal: null, timedOut: false, spawnError: false };
    },
  });
  expect(run.summary.status).toBe('completed');
  expect(run.summary.cases).toHaveLength(12);
  expect(
    run.summary.cases.every((row) => row.process_status === 'graded'),
  ).toBe(true);
  expect(run.summary.cumulative_cost_usd).toBe(3);
  expect(run.summary.cost_complete).toBe(true);
});

test('exit zero without a matching grade stops and missing usage stays unknown', async () => {
  const run = await runKnown({
    async execute() {
      return { code: 0, signal: null, timedOut: false, spawnError: false };
    },
  });
  expect(run.summary.status).toBe('stopped');
  expect(run.summary.stop_reason).toBe('instrument_failure');
  expect(run.summary.cases).toHaveLength(1);
  expect(run.summary.cases[0]?.cost_usd).toBeNull();
  expect(run.summary.cost_complete).toBe(false);
});

test('missing or unpriced usage stops future calls even with a valid grade', async () => {
  const run = await runKnown({ priceUsage: async () => null });
  expect(run.summary.stop_reason).toBe('missing_or_unpriced_usage');
  expect(run.summary.cases).toHaveLength(1);
  expect(run.summary.status).toBe('stopped');
});

test('stops before a further call once observed spend reaches the allocation', async () => {
  const run = await runKnown({ priceUsage: async () => 4 });
  expect(run.summary.status).toBe('stopped');
  expect(run.summary.stop_reason).toBe('cost_threshold_reached');
  expect(run.summary.cases).toHaveLength(2);
  expect(run.summary.cumulative_cost_usd).toBe(8);
});

test('the frozen envelope cutoff refuses calls that cannot fit their deadline and cleanup', async () => {
  const run = await runKnown({ now: () => Date.parse('2026-09-08T15:58:00Z') });
  expect(run.summary.stop_reason).toBe('insufficient_time');
  expect(run.summary.cases).toHaveLength(0);
});

test('cancellation terminates the current row, records it, releases the lease and stops', async () => {
  const controller = new AbortController();
  let released = false;
  const run = await runKnown({
    signal: controller.signal,
    acquireLease: () => ({
      heartbeat() {},
      release() {
        released = true;
      },
    }),
    async execute(_entry, out, signal) {
      controller.abort('cancelled:SIGINT');
      expect(signal.aborted).toBe(true);
      json(join(out, 'usage.jsonl'), { cost: 0.2 });
      return {
        code: null,
        signal: 'SIGINT',
        timedOut: false,
        spawnError: false,
      };
    },
  });
  expect(run.summary.stop_reason).toBe('cancelled:SIGINT');
  expect(run.summary.cases).toHaveLength(1);
  expect(run.summary.cumulative_cost_usd).toBe(0.2);
  expect(released).toBe(true);
});

test('lease loss stops future calls without losing the just-finished usage', async () => {
  let beats = 0;
  const run = await runKnown({
    acquireLease: () => ({
      heartbeat() {
        if (++beats === 2) throw new Error('lost');
      },
      release() {},
    }),
  });
  expect(run.summary.stop_reason).toBe('lease_lost');
  expect(run.summary.cases).toHaveLength(1);
  expect(run.summary.cases[0]?.cost_usd).toBe(0.25);
});

async function controlsFrom(known: Awaited<ReturnType<typeof runKnown>>) {
  const f = fixture('controls');
  const path = join(known.output, 'summary.json');
  json(join(f.inputDir, 'cases.json'), {
    ...f.envelope,
    prior_summary: { path, sha256: digest(path) },
  });
  const input = loadExecutionInput(f.inputDir, parseRubric);
  const prior = await validatePriorSummary(
    input,
    known.deps.priceUsage,
    parseRubric,
    start + 30_000,
  );
  return { ...f, input, prior };
}

test('controls reprice all known rows and retain cumulative spend and the original window', async () => {
  const known = await runKnown();
  const controls = await controlsFrom(known);
  expect(controls.prior?.cumulative_cost_usd).toBe(3);
  const output = createOutputRoot(
    controls.input,
    join(controls.root, 'output'),
  );
  const summary = await executeStage(
    controls.input,
    output,
    fakeDependencies({ priceUsage: async () => 5 }),
    controls.prior,
  );
  expect(summary.execution_started_at).toBe('2026-09-08T12:00:00.000Z');
  expect(summary.deadline_at).toBe('2026-09-08T13:30:00.000Z');
  expect(summary.cases).toHaveLength(1);
  expect(summary.cumulative_cost_usd).toBe(8);
  expect(summary.stop_reason).toBe('cost_threshold_reached');
});

test('controls cannot reset the 90-minute assessment window', async () => {
  const known = await runKnown();
  const controls = await controlsFrom(known);
  const output = createOutputRoot(
    controls.input,
    join(controls.root, 'output'),
  );
  const summary = await executeStage(
    controls.input,
    output,
    fakeDependencies({ now: () => start + 89 * 60_000 }),
    controls.prior,
  );
  expect(summary.cases).toHaveLength(0);
  expect(summary.stop_reason).toBe('insufficient_time');
});

test('controls reject stopped, incomplete, changed, or inconsistently priced known receipts', async () => {
  for (const mutation of [
    'stopped',
    'missing',
    'duplicate',
    'cost',
    'usage',
    'source',
    'expectation',
  ] as const) {
    const known = await runKnown();
    if (mutation === 'stopped') known.summary.status = 'stopped';
    if (mutation === 'missing') known.summary.cases.pop();
    if (mutation === 'duplicate')
      known.summary.cases[1] = known.summary.cases[0]!;
    if (mutation === 'cost') known.summary.cumulative_cost_usd = 0;
    if (mutation === 'source') known.summary.q_sha = 'b'.repeat(40);
    if (mutation === 'expectation')
      known.summary.expectations.sha256 = 'c'.repeat(64);
    if (mutation === 'usage')
      rmSync(join(known.summary.cases[0]!.output_path, 'usage.jsonl'));
    json(join(known.output, 'summary.json'), known.summary);
    await expect(controlsFrom(known)).rejects.toThrow();
  }
});

test('the external child deadline terminates a real local sleeping process', async () => {
  const result = await runChild({
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: temp(),
    env: {},
    signal: new AbortController().signal,
    timeoutMs: 30,
  });
  expect(result.timedOut).toBe(true);
  expect(result.signal).not.toBeNull();
});

test('an already cancelled child is never spawned', async () => {
  const controller = new AbortController();
  controller.abort('cancelled:SIGTERM');
  const root = temp();
  const result = await runChild({
    args: ['-e', 'throw new Error("must not execute")'],
    cwd: root,
    env: {},
    signal: controller.signal,
    timeoutMs: 1000,
  });
  expect(result.code).toBeNull();
  expect(result.signal).toBe('SIGTERM');
  expect(result.spawnError).toBe(false);
});

test('source validation time cannot consume the reserved execution and cleanup window', async () => {
  let now = Date.parse('2026-09-08T15:57:00Z');
  const run = await runKnown({
    now: () => now,
    verifyInputs() {
      now = Date.parse('2026-09-08T15:58:00Z');
    },
  });
  expect(run.summary.cases).toHaveLength(0);
  expect(run.summary.stop_reason).toBe('insufficient_time');
});

test('output cannot be written into a retained run next to its evidence directory', () => {
  const f = fixture();
  const external = join(f.root, 'retained');
  mkdirSync(external);
  const evidence = join(external, 'evidence');
  mkdirSync(evidence);
  json(join(evidence, 'index.json'), { files: ['delivery.txt'] });
  writeFileSync(join(evidence, 'delivery.txt'), 'external retained delivery');
  for (const row of f.envelope.cases.slice(0, 2)) {
    row.evidence_root = evidence;
    row.evidence_index = join(evidence, 'index.json');
  }
  json(join(f.inputDir, 'cases.json'), f.envelope);
  const input = loadExecutionInput(f.inputDir, parseRubric);
  expect(() => createOutputRoot(input, join(external, 'output'))).toThrow();
});

test('lease loss during a call aborts the active boundary and preserves its usage', async () => {
  let loseLease = () => {};
  const run = await runKnown({
    acquireLease(lost) {
      loseLease = lost;
      return { heartbeat() {}, release() {} };
    },
    async execute(_entry, out, signal) {
      loseLease();
      expect(signal.aborted).toBe(true);
      json(join(out, 'usage.jsonl'), { cost: 0.5 });
      return {
        code: null,
        signal: 'SIGTERM',
        timedOut: false,
        spawnError: false,
      };
    },
  });
  expect(run.summary.cases).toHaveLength(1);
  expect(run.summary.stop_reason).toBe('lease_lost');
  expect(run.summary.cases[0]?.cost_usd).toBe(0.5);
});

test('an initial summary write failure removes the cancellation listener', async () => {
  const f = fixture();
  const input = loadExecutionInput(f.inputDir, parseRubric);
  const controller = new AbortController();
  await expect(
    executeStage(
      input,
      join(f.root, 'missing-output'),
      fakeDependencies({ signal: controller.signal }),
    ),
  ).rejects.toThrow();
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
});

test('a release failure remains visible alongside the original stopping cause', async () => {
  const run = await runKnown({
    acquireLease: () => ({
      heartbeat() {},
      release() {
        throw new Error('cannot release');
      },
    }),
    priceUsage: async () => null,
  });
  expect(run.summary.status).toBe('stopped');
  expect(run.summary.stop_reason).toBe(
    'missing_or_unpriced_usage;lease_release_failure',
  );
});

test('SIGINT reaches a ready child and an ignored cancellation is killed before continuing', async () => {
  const root = temp();
  const controller = new AbortController();
  const pending = runChild({
    args: [
      '-e',
      'const fs = require("node:fs"); for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => fs.writeFileSync("received", signal)); fs.writeFileSync("ready", "ready"); setInterval(() => {}, 1000)',
    ],
    cwd: root,
    env: {},
    signal: controller.signal,
    timeoutMs: 25_000,
  });
  const deadline = Date.now() + 20_000;
  while (!existsSync(join(root, 'ready')) && Date.now() < deadline)
    await new Promise((done) => setTimeout(done, 10));
  controller.abort('cancelled:SIGINT');
  const result = await pending;
  expect(result.timedOut).toBe(false);
  expect(readFileSync(join(root, 'ready'), 'utf8')).toBe('ready');
  expect(readFileSync(join(root, 'received'), 'utf8')).toBe('SIGINT');
  expect(result.signal).toBe('SIGKILL');
}, 30_000);

for (const phase of ['input', 'execute'] as const) {
  test(`a thrown ${phase} failure retains its private cause and stops later calls`, async () => {
    const cause = `${phase} failure: fixture-private-token`;
    let calls = 0;
    const run = await runKnown(
      phase === 'input'
        ? {
            verifyInputs() {
              throw new Error(cause);
            },
          }
        : {
            async execute(_entry, out) {
              calls++;
              json(join(out, 'usage.jsonl'), { cost: 0.3 });
              throw new Error(cause);
            },
          },
    );
    expect(run.summary.status).toBe('stopped');
    expect(run.summary.stop_reason).toBe('instrument_failure');
    expect(calls).toBe(phase === 'input' ? 0 : 1);
    expect(run.summary.cases).toHaveLength(phase === 'input' ? 0 : 1);
    expect(run.summary.cumulative_cost_usd).toBe(phase === 'input' ? 0 : 0.3);
    const diagnostics = join(run.output, 'diagnostics.jsonl');
    expect(existsSync(diagnostics)).toBe(true);
    expect(readFileSync(diagnostics, 'utf8')).toContain(cause);
    expect(statSync(diagnostics).mode & 0o777).toBe(0o600);
    expect(statSync(run.output).mode & 0o777).toBe(0o700);
    expect(
      readFileSync(join(run.output, 'summary.json'), 'utf8'),
    ).not.toContain(cause);
  });
}

test('a real CLI failure before result publication retains private stdout and stderr', async () => {
  const run = await runKnown({
    async execute(_entry, out, signal) {
      const cli = join(out, 'failing-cli.ts');
      writeFileSync(
        cli,
        'process.stdout.write("startup fixture-private-token\\n"); throw new Error("CLI startup failed fixture-private-token");',
      );
      return await runChild({ args: [cli], cwd: out, env: {}, signal });
    },
  });
  expect(run.summary.stop_reason).toBe('instrument_failure');
  expect(run.summary.cases).toHaveLength(1);
  expect(run.summary.cost_complete).toBe(false);
  const out = run.summary.cases[0]!.output_path;
  expect(existsSync(join(out, 'result.json'))).toBe(false);
  for (const stream of ['stdout', 'stderr']) {
    const log = join(out, `child.${stream}.log`);
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, 'utf8')).toContain('fixture-private-token');
    expect(statSync(log).mode & 0o777).toBe(0o600);
  }
  expect(readFileSync(join(out, 'child.stderr.log'), 'utf8')).toContain(
    'CLI startup failed',
  );
  expect(readFileSync(join(run.output, 'summary.json'), 'utf8')).not.toContain(
    'fixture-private-token',
  );
});
