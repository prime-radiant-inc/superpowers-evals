import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANTIGRAVITY_RATE_LIMIT_MARKER } from '../src/agents/antigravity.ts';
import {
  BatchHeaderSchema,
  ResultRecordSchema,
} from '../src/contracts/batch.ts';
import type { InvokeChildArgs, InvokeFn } from '../src/run-all/index.ts';
import { runBatch } from '../src/run-all/index.ts';

interface ScenarioSpec {
  readonly name: string;
  readonly directive?: string;
}

// Temp scenarios-root + coding-agents dir + an empty out-root.
function fixture(
  scenarios: readonly ScenarioSpec[],
  agents: readonly string[],
): {
  scenariosRoot: string;
  codingAgentsDir: string;
  outRoot: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'runall-'));
  const scenariosRoot = join(root, 'scenarios');
  const codingAgentsDir = join(root, 'coding-agents');
  const outRoot = join(root, 'results');
  mkdirSync(scenariosRoot, { recursive: true });
  mkdirSync(codingAgentsDir, { recursive: true });
  mkdirSync(outRoot, { recursive: true });

  for (const scn of scenarios) {
    const dir = join(scenariosRoot, scn.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'story.md'), 'body\n');
    const directiveLine =
      scn.directive !== undefined ? `# coding-agents: ${scn.directive}\n` : '';
    writeFileSync(
      join(dir, 'checks.sh'),
      `${directiveLine}pre() { :; }\npost() { :; }\n`,
    );
  }
  for (const agent of agents) {
    writeFileSync(join(codingAgentsDir, `${agent}.yaml`), `name: ${agent}\n`);
  }
  return { scenariosRoot, codingAgentsDir, outRoot };
}

// A captured-output sink for runBatch's `stream`.
class StringStream {
  text = '';
  write(s: string): void {
    this.text += s;
  }
}

interface VerdictPlan {
  readonly final?: 'pass' | 'fail' | 'indeterminate';
  readonly cost?: number | null;
  readonly rateLimited?: boolean;
}

// A fake invoke that, per (scenario, agent), allocates a deterministic run-id,
// writes a verdict.json under outRoot/<run_id>/ (so the status + cost reads
// work), and records the call. A plan keyed by "scenario/agent" controls the
// produced verdict; absent -> a plain pass with no economics.
function fakeInvoke(plans: Readonly<Record<string, VerdictPlan>>): {
  invoke: InvokeFn;
  calls: InvokeChildArgs[];
} {
  const calls: InvokeChildArgs[] = [];
  let n = 0;
  const invoke: InvokeFn = (args) => {
    calls.push(args);
    const key = `${args.scenarioDir.split('/').at(-1)}/${args.codingAgent}`;
    const plan = plans[key] ?? {};
    n += 1;
    const runId = `${args.codingAgent}-${n}`;
    const runDir = join(args.outRoot, runId);
    mkdirSync(runDir, { recursive: true });
    const verdict: Record<string, unknown> = {
      schema: 1,
      final: plan.final ?? 'pass',
      final_reason: 'fake',
      gauntlet: null,
      checks: [],
      error: plan.rateLimited
        ? {
            stage: 'gauntlet',
            message: `${ANTIGRAVITY_RATE_LIMIT_MARKER}: exhausted`,
          }
        : null,
      economics:
        plan.cost === undefined ? null : { total_est_cost_usd: plan.cost },
    };
    writeFileSync(join(runDir, 'verdict.json'), JSON.stringify(verdict));
    return Promise.resolve({ run_id: runId, exit_code: 0, error: null });
  };
  return { invoke, calls };
}

function readResults(
  batchDir: string,
): ReturnType<typeof ResultRecordSchema.parse>[] {
  return readFileSync(join(batchDir, 'results.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => ResultRecordSchema.parse(JSON.parse(line)));
}

test('runBatch writes header+footer, records, and tallies cost', async () => {
  const { scenariosRoot, codingAgentsDir, outRoot } = fixture(
    [{ name: 'alpha' }, { name: 'beta', directive: 'claude' }],
    ['claude', 'codex'],
  );
  // beta excludes codex via directive -> a directive skip.
  const { invoke, calls } = fakeInvoke({
    'alpha/claude': { final: 'pass', cost: 1.25 },
    'alpha/codex': { final: 'fail', cost: 0.5 },
    'beta/claude': { final: 'indeterminate', cost: 2.0 },
  });
  const stream = new StringStream();
  const batchDir = await runBatch({
    scenariosRoot,
    codingAgentsDir,
    outRoot,
    jobs: 1,
    invoke,
    stream,
  });

  // 4 cells total: 3 runnable + 1 directive skip (beta/codex).
  expect(calls).toHaveLength(3);

  const header = BatchHeaderSchema.parse(
    JSON.parse(readFileSync(join(batchDir, 'batch.json'), 'utf8')),
  );
  expect(header.coding_agents).toEqual(['claude', 'codex']);
  expect(header.finished_at).not.toBeNull();

  const results = readResults(batchDir);
  expect(results).toHaveLength(4);
  const skipRec = results.find(
    (r) => r.scenario === 'beta' && r.coding_agent === 'codex',
  );
  expect(skipRec?.skipped).toBe('directive');
  expect(skipRec?.run_id).toBeNull();
  const ran = results.filter((r) => r.skipped === undefined);
  expect(ran).toHaveLength(3);
  for (const r of ran) expect(r.run_id).not.toBeNull();

  // Summary cost tally: 1.25 + 0.5 + 2.0 = 3.75.
  expect(stream.text).toContain('cost $3.75');
  // Recorded finals (glyphs) appear in the plain output.
  expect(stream.text).toContain('alpha  claude  ✓');
  expect(stream.text).toContain('alpha  codex  ✗');
  expect(stream.text).toContain('beta  claude  ⊘');
  // Directive skip prints its reason label.
  expect(stream.text).toContain('(requires claude)');
  expect(stream.text).toContain('artifacts:');
});

test('unknown agentFilter throws', async () => {
  const { scenariosRoot, codingAgentsDir, outRoot } = fixture(
    [{ name: 'alpha' }],
    ['claude'],
  );
  const { invoke } = fakeInvoke({});
  await expect(
    runBatch({
      scenariosRoot,
      codingAgentsDir,
      outRoot,
      jobs: 1,
      agentFilter: ['ghost'],
      invoke,
    }),
  ).rejects.toThrow(/unknown coding-agent/);
});

test('rate-limit latch skips subsequent same-agent cells without invoking', async () => {
  const { scenariosRoot, codingAgentsDir, outRoot } = fixture(
    [{ name: 'a-first' }, { name: 'b-second' }],
    ['antigravity'],
  );
  // The first antigravity cell (a-first, sorted first) returns a rate-limited
  // verdict; the second (b-second) must be skipped:"rate-limited" uninvoked.
  const { invoke, calls } = fakeInvoke({
    'a-first/antigravity': { final: 'indeterminate', rateLimited: true },
  });
  const stream = new StringStream();
  const batchDir = await runBatch({
    scenariosRoot,
    codingAgentsDir,
    outRoot,
    jobs: 1,
    invoke,
    stream,
  });

  // Only the first cell invoked; the second latched out.
  expect(calls).toHaveLength(1);
  expect(calls[0]?.scenarioDir).toContain('a-first');

  const results = readResults(batchDir);
  const second = results.find((r) => r.scenario === 'b-second');
  expect(second?.skipped).toBe('rate-limited');
  expect(second?.run_id).toBeNull();
  expect(stream.text).toContain('(agy rate-limited)');
  // The summary surfaces the rate-limited count glyph.
  expect(stream.text).toContain('⏸');
});

test('cost cell shows — when a run has no economics', async () => {
  const { scenariosRoot, codingAgentsDir, outRoot } = fixture(
    [{ name: 'alpha' }],
    ['claude'],
  );
  const { invoke } = fakeInvoke({ 'alpha/claude': { final: 'pass' } });
  const stream = new StringStream();
  await runBatch({
    scenariosRoot,
    codingAgentsDir,
    outRoot,
    jobs: 1,
    invoke,
    stream,
  });
  expect(stream.text).toContain('alpha  claude  ✓');
  // No economics -> cost cell is an em dash, and no cost tally in the summary.
  expect(stream.text).toContain('—');
  expect(stream.text).not.toContain('cost $');
});
