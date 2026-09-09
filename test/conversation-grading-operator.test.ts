import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  type CaseDependencies,
  runAssessmentCase,
  verifyAssessmentUsage,
} from '../docs/experiments/2026-09-08-conversation-grading/run.ts';
import {
  createRetainedAssessmentHeartbeatScheduler,
  retainedAssessmentEnv,
  runChild,
} from '../docs/experiments/2026-09-08-conversation-reliability/run.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const temporary = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'grade-')));
  roots.push(root);
  return root;
};
const digest = (path: string) =>
  createHash('sha256').update(readFileSync(path)).digest('hex');
const json = (path: string, value: unknown) =>
  writeFileSync(path, `${JSON.stringify(value)}\n`);
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const usage = {
  type: 'obol.usage',
  v: '2026-06-08',
  provider: 'anthropic',
  model: 'anthropic.claude-sonnet-5',
  usage: { input_tokens: 3, output_tokens: 2 },
};
const priced = (
  cost: number,
): NonNullable<Awaited<ReturnType<CaseDependencies['priceUsage']>>> => ({
  total_input: 3,
  total_output: 2,
  total_cache_create: 0,
  total_cache_read: 0,
  total_tokens: 5,
  model: 'anthropic.claude-sonnet-5',
  models: {},
  est_cost_usd: cost,
  unpriced_models: [],
  approximations: [],
  pricing_as_of: '2026-09-06',
});
function logs(out: string, turns = 1) {
  const events: unknown[] = [];
  for (let turn = 1; turn <= turns; turn++)
    events.push({ type: 'llm_request', turn }, { type: 'llm_response', turn });
  events.push({ type: 'run_end', usage: { turns } });
  writeFileSync(
    join(out, 'run.jsonl'),
    `${events.map((row) => JSON.stringify(row)).join('\n')}\n`,
  );
  writeFileSync(
    join(out, 'usage.jsonl'),
    `${Array.from({ length: turns }, () => JSON.stringify(usage)).join('\n')}\n`,
  );
}
test('one priced row cannot cover a two-turn assessment', () => {
  const out = temporary();
  json(join(out, 'result.json'), { usage: { turns: 2 } });
  logs(out, 2);
  writeFileSync(join(out, 'usage.jsonl'), `${JSON.stringify(usage)}\n`);
  expect(() => verifyAssessmentUsage(out)).toThrow();
  appendFileSync(join(out, 'usage.jsonl'), `${JSON.stringify(usage)}\n`);
  expect(verifyAssessmentUsage(out)).toBe(2);
});
for (const defect of [
  'extra usage',
  'missing response',
  'duplicate end',
  'truncated log',
  'wrong model',
  'negative cache',
  'wrong counts',
]) {
  test(`usage coverage refuses ${defect}`, () => {
    const out = temporary();
    json(join(out, 'result.json'), { usage: { turns: 1 } });
    logs(out);
    if (defect === 'extra usage')
      appendFileSync(join(out, 'usage.jsonl'), `${JSON.stringify(usage)}\n`);
    if (defect === 'missing response')
      appendFileSync(
        join(out, 'run.jsonl'),
        '{"type":"llm_request","turn":2}\n',
      );
    if (defect === 'duplicate end')
      appendFileSync(
        join(out, 'run.jsonl'),
        '{"type":"run_end","usage":{"turns":1}}\n',
      );
    if (defect === 'truncated log') appendFileSync(join(out, 'run.jsonl'), '{');
    if (defect === 'wrong model')
      json(join(out, 'usage.jsonl'), { ...usage, model: 'other' });
    if (defect === 'negative cache')
      json(join(out, 'usage.jsonl'), {
        ...usage,
        usage: { ...usage.usage, cache_read_input_tokens: -1 },
      });
    if (defect === 'wrong counts')
      json(join(out, 'result.json'), { usage: { turns: 2 } });
    expect(() => verifyAssessmentUsage(out)).toThrow();
  });
}
function git(root: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
function fixture() {
  const root = temporary();
  const q = join(root, 'q'),
    g = join(root, 'g'),
    experiment = join(root, 'experiment');
  for (const dir of [q, g, experiment]) mkdirSync(dir, { mode: 0o700 });
  const pricingPath = 'docs/experiments/2026-09-06-pr2258-pricing/current.json';
  mkdirSync(dirname(join(q, pricingPath)), { recursive: true });
  copyFileSync(join(import.meta.dir, '..', pricingPath), join(q, pricingPath));
  mkdirSync(join(g, 'src/format'), { recursive: true });
  mkdirSync(join(g, 'src/util'));
  writeFileSync(
    join(g, 'src/format/story-card.ts'),
    'export const parseStoryCard = JSON.parse;',
  );
  writeFileSync(
    join(g, 'src/util/id.ts'),
    'export const makeRunId = id => `${id}_20260908T220000Z_abcd`;',
  );
  writeFileSync(
    join(g, 'src/index.ts'),
    'process.stdout.write("started\\n"); setInterval(() => {}, 1000);',
  );
  for (const repo of [q, g]) {
    git(repo, 'init', '-q');
    git(repo, 'add', '.');
    git(
      repo,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qm',
      'fixture',
    );
  }
  const auth = join(root, 'gold.json');
  json(auth, { authenticated: 'independent judgments' });
  const ids = [
    'claude-design',
    'known-claude-design',
    'known-codex-review',
    'codex-design',
    'known-claude-review',
  ];
  const cases = ids.map((id, i) => {
    const dir = join(root, id);
    mkdirSync(dir);
    const rubric = join(dir, 'rubric.md'),
      index = join(dir, 'index.json');
    json(rubric, {
      id,
      acceptanceCriteria: ['The evidence demonstrates the criterion.'],
    });
    json(index, { files: ['evidence.txt'] });
    writeFileSync(join(dir, 'evidence.txt'), 'Retained conversation evidence.');
    return {
      ordinal: i + 1,
      id,
      rubric,
      evidence_root: dir,
      evidence_index: index,
      scenario_id: id,
      rubric_sha256: digest(rubric),
      evidence_index_sha256: digest(index),
      evidence_sha256: { 'evidence.txt': digest(join(dir, 'evidence.txt')) },
    };
  });
  const manifest = {
    q_root: q,
    g_root: g,
    q_sha: git(q, 'rev-parse', 'HEAD'),
    g_sha: git(g, 'rev-parse', 'HEAD'),
    experiment_dir: experiment,
    cutoff_at: '2026-09-08T23:00:00.000Z',
    model: 'anthropic.claude-sonnet-5',
    pricing: { path: pricingPath, sha256: digest(join(q, pricingPath)) },
    authentication_refs: [{ path: auth, sha256: digest(auth) }],
    cases,
  };
  const path = join(root, 'manifest.json');
  json(path, manifest);
  let now = Date.parse('2026-09-08T22:00:00.000Z'),
    calls = 0,
    released = 0,
    cost = 0.2;
  const deps: CaseDependencies = {
    now: () => now,
    signal: new AbortController().signal,
    acquireLease: () => ({
      heartbeat() {},
      release() {
        released++;
      },
    }),
    graderEnv: () => ({ PATH: '/usr/bin:/bin' }),
    async child(options) {
      calls++;
      expect(read(join(dirname(options.cwd), 'launch.json')).output_path).toBe(
        options.cwd,
      );
      const id = basename(options.cwd).split('_')[0]!;
      json(join(options.cwd, 'result.json'), {
        schemaVersion: 5,
        runId: basename(options.cwd),
        scenario: id,
        status: 'pass',
        summary: 'Supported.',
        reasoning: 'Evidence supports the criterion.',
        observations: [],
        criteria: [
          {
            criterion: 'The evidence demonstrates the criterion.',
            verdict: 'pass',
            evidence: 'evidence.txt: retained turn',
          },
        ],
        usage: { turns: 1 },
      });
      logs(options.cwd);
      return { code: 0, signal: null, timedOut: false, spawnError: false };
    },
    async priceUsage() {
      return priced(cost);
    },
  };
  const receipt = (ordinal: number, name: string) =>
    join(experiment, String(ordinal).padStart(2, '0'), `${name}.json`);
  const review = (ordinal: number, decision = 'match') =>
    json(receipt(ordinal, 'review'), {
      result_sha256: read(receipt(ordinal, 'settled')).result_sha256,
      decision,
      rationale: 'Independent judgment and the cited retained turn agree.',
    });
  return {
    path,
    manifest,
    deps,
    receipt,
    review,
    calls: () => calls,
    released: () => released,
    clock: (value: number) => {
      now = value;
    },
    price: (value: number) => {
      cost = value;
    },
  };
}
for (const defect of [
  'missing review',
  'unfinished launch',
  'changed result',
  'changed input',
  'duplicate',
  'skipped',
  'sixth',
  'spent allocation',
  '121 seconds',
  'gold stop',
]) {
  test(`admission refuses ${defect} without another child`, async () => {
    const f = fixture();
    await runAssessmentCase(f.path, 1, f.deps);
    f.review(1);
    let ordinal = 2;
    if (defect === 'missing review') rmSync(f.receipt(1, 'review'));
    if (defect === 'unfinished launch') rmSync(f.receipt(1, 'settled'));
    if (defect === 'changed result')
      appendFileSync(
        join(read(f.receipt(1, 'launch')).output_path, 'result.json'),
        ' ',
      );
    if (defect === 'changed input')
      appendFileSync(f.manifest.cases[0]!.rubric, ' ');
    if (defect === 'duplicate') ordinal = 1;
    if (defect === 'skipped') ordinal = 3;
    if (defect === 'sixth') ordinal = 6;
    if (defect === 'spent allocation') {
      f.price(4);
      const settled = read(f.receipt(1, 'settled'));
      settled.cost_usd = 4;
      settled.cumulative_cost_usd = 4;
      json(f.receipt(1, 'settled'), settled);
    }
    if (defect === '121 seconds')
      f.clock(Date.parse('2026-09-08T22:42:59.000Z'));
    if (defect === 'gold stop')
      json(join(f.manifest.experiment_dir, 'stopped.json'), {
        kind: 'gold',
        reason: 'Independent evidence contradicts gold.',
        manifest_sha256: digest(f.path),
        stopped_at: '2026-09-08T22:01:00.000Z',
        evidence_refs: f.manifest.authentication_refs,
      });
    await expect(runAssessmentCase(f.path, ordinal, f.deps)).rejects.toThrow();
    expect(f.calls()).toBe(1);
  });
}
test('semantic miss review permits exactly the next declared assessment', async () => {
  const f = fixture();
  await runAssessmentCase(f.path, 1, f.deps);
  f.review(1, 'semantic_miss');
  await runAssessmentCase(f.path, 2, f.deps);
  expect(f.calls()).toBe(2);
  expect(read(f.receipt(2, 'settled')).prior_semantic_miss).toBe(true);
  expect(f.released()).toBe(2);
});
test('a settled call can overshoot four dollars and its full subtotal is retained', async () => {
  const f = fixture();
  f.price(3.99);
  await runAssessmentCase(f.path, 1, f.deps);
  f.review(1);
  f.deps.priceUsage = async (path) =>
    priced(path.includes('/01/') ? 3.99 : 0.2);
  await runAssessmentCase(f.path, 2, f.deps);
  f.review(2);
  expect(read(f.receipt(2, 'settled')).cumulative_cost_usd).toBe(4.19);
  await expect(runAssessmentCase(f.path, 3, f.deps)).rejects.toThrow();
  expect(f.calls()).toBe(2);
});
test('lease loss cancels the existing real subprocess supervisor and retains logs', async () => {
  const f = fixture();
  let lost: () => void = () => {};
  f.deps.acquireLease = (callback) => {
    lost = callback;
    return { heartbeat() {}, release() {} };
  };
  f.deps.child = async (options) => {
    const timer = setTimeout(lost, 250);
    try {
      return await runChild(options);
    } finally {
      clearTimeout(timer);
    }
  };
  await expect(runAssessmentCase(f.path, 1, f.deps)).rejects.toThrow();
  const settled = read(f.receipt(1, 'settled'));
  expect(settled.outcome.signal).toBe('SIGTERM');
  expect(
    readFileSync(
      join(read(f.receipt(1, 'launch')).output_path, 'child.stdout.log'),
      'utf8',
    ),
  ).toBe('started\n');
  expect(read(join(f.manifest.experiment_dir, 'stopped.json')).kind).toBe(
    'operational',
  );
});

for (const defect of [
  'untracked source',
  'changed SHA',
  'changed authentication',
  'extra manifest field',
  'wrong case order',
  'symlink evidence',
  'exposed gold',
  'empty rubric',
]) {
  test(`initial admission refuses ${defect} before any child`, async () => {
    const f = fixture(),
      row = f.manifest.cases[0]!;
    if (defect === 'untracked source')
      writeFileSync(join(f.manifest.g_root, 'untracked.ts'), 'changed');
    if (defect === 'changed SHA') f.manifest.g_sha = 'a'.repeat(40);
    if (defect === 'changed authentication')
      appendFileSync(f.manifest.authentication_refs[0]!.path, ' ');
    if (defect === 'wrong case order') f.manifest.cases.reverse();
    if (defect === 'symlink evidence') {
      const evidence = join(row.evidence_root, 'evidence.txt');
      const saved = join(dirname(f.path), 'saved.txt');
      copyFileSync(evidence, saved);
      rmSync(evidence);
      symlinkSync(saved, evidence);
    }
    if (defect === 'exposed gold')
      f.manifest.authentication_refs.push({
        path: join(row.evidence_root, 'evidence.txt'),
        sha256: row.evidence_sha256['evidence.txt'],
      });
    if (defect === 'empty rubric') {
      json(row.rubric, { id: row.scenario_id, acceptanceCriteria: [] });
      row.rubric_sha256 = digest(row.rubric);
    }
    json(
      f.path,
      defect === 'extra manifest field'
        ? { ...f.manifest, command: 'other' }
        : f.manifest,
    );
    await expect(runAssessmentCase(f.path, 1, f.deps)).rejects.toThrow();
    expect(f.calls()).toBe(0);
  });
}
test('inputs changed during lease acquisition cannot launch', async () => {
  const f = fixture();
  f.deps.acquireLease = () => {
    appendFileSync(f.manifest.cases[0]!.rubric, ' ');
    return { heartbeat() {}, release() {} };
  };
  await expect(runAssessmentCase(f.path, 1, f.deps)).rejects.toThrow();
  expect(f.calls()).toBe(0);
});
for (const defect of [
  'wrong scenario',
  'wrong run',
  'wrong criterion',
  'wrong status',
  'wrong exit',
  'missing criterion',
  'unknown pricing',
]) {
  test(`settlement records an operational stop for ${defect}`, async () => {
    const f = fixture(),
      child = f.deps.child;
    f.deps.child = async (options) => {
      const outcome = await child(options);
      const path = join(options.cwd, 'result.json'),
        result = read(path);
      if (defect === 'wrong scenario') result.scenario = 'different';
      if (defect === 'wrong run') result.runId = 'different';
      if (defect === 'wrong criterion')
        result.criteria[0].criterion = 'Different';
      if (defect === 'wrong status') result.status = 'fail';
      if (defect === 'wrong exit') outcome.code = 1;
      if (defect === 'missing criterion') result.criteria = [];
      json(path, result);
      return outcome;
    };
    if (defect === 'unknown pricing')
      f.deps.priceUsage = async () => ({
        ...priced(0.2),
        unpriced_models: ['unknown'],
      });
    await expect(runAssessmentCase(f.path, 1, f.deps)).rejects.toThrow();
    expect(read(f.receipt(1, 'settled')).operational_error).not.toBeNull();
    expect(read(join(f.manifest.experiment_dir, 'stopped.json')).kind).toBe(
      'operational',
    );
    await expect(runAssessmentCase(f.path, 2, f.deps)).rejects.toThrow();
    expect(f.calls()).toBe(1);
  });
}
for (const [verdict, status] of [
  ['fail', 'fail'],
  ['unclear', 'investigate'],
]) {
  test(`complete ${verdict} assessment is a valid semantic review candidate`, async () => {
    const f = fixture(),
      child = f.deps.child;
    f.deps.child = async (options) => {
      const outcome = await child(options);
      const path = join(options.cwd, 'result.json'),
        result = read(path);
      result.criteria[0].verdict = verdict;
      result.status = status;
      json(path, result);
      return { ...outcome, code: 1 };
    };
    await runAssessmentCase(f.path, 1, f.deps);
    expect(read(f.receipt(1, 'settled')).operational_error).toBeNull();
  });
}
test('interrupted execution retains priced partial usage with incomplete coverage', async () => {
  const f = fixture();
  f.deps.child = async (options) => {
    logs(options.cwd);
    rmSync(join(options.cwd, 'run.jsonl'));
    return { code: null, signal: 'SIGTERM', timedOut: true, spawnError: false };
  };
  await expect(runAssessmentCase(f.path, 1, f.deps)).rejects.toThrow();
  const settled = read(f.receipt(1, 'settled'));
  expect(settled.coverage_complete).toBe(false);
  expect(settled.cost_usd).toBe(0.2);
  expect(settled.usage_sha256).not.toBeNull();
});
test('prior launch cannot precede the preceding settlement', async () => {
  const f = fixture();
  f.clock(Date.parse('2026-09-08T22:01:00.000Z'));
  await runAssessmentCase(f.path, 1, f.deps);
  f.review(1);
  f.clock(Date.parse('2026-09-08T22:02:00.000Z'));
  await runAssessmentCase(f.path, 2, f.deps);
  f.review(2);
  const first = read(f.receipt(1, 'settled'));
  first.finished_at = '2026-09-08T22:03:00.000Z';
  json(f.receipt(1, 'settled'), first);
  f.clock(Date.parse('2026-09-08T22:04:00.000Z'));
  await expect(runAssessmentCase(f.path, 3, f.deps)).rejects.toThrow();
  expect(f.calls()).toBe(2);
});
test('a clean source checkout cannot import a symlinked parser outside its root', async () => {
  const f = fixture(),
    parser = join(f.manifest.g_root, 'src/format/story-card.ts');
  const external = join(dirname(f.path), 'external-parser.ts');
  copyFileSync(parser, external);
  rmSync(parser);
  symlinkSync(external, parser);
  git(f.manifest.g_root, 'add', 'src/format/story-card.ts');
  git(
    f.manifest.g_root,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'symlink fixture',
  );
  f.manifest.g_sha = git(f.manifest.g_root, 'rev-parse', 'HEAD');
  json(f.path, f.manifest);
  await expect(runAssessmentCase(f.path, 1, f.deps)).rejects.toThrow();
  expect(f.calls()).toBe(0);
});

test('shared retained environment maps only the blessed bearer and supervisor network', () => {
  const bundle = temporary();
  writeFileSync(
    join(bundle, 'credentials.env'),
    'AWS_BEARER_TOKEN_BEDROCK=blessed-fixture-bearer\nANTHROPIC_API_KEY=unblessed-key\nANTHROPIC_AUTH_TOKEN=unblessed-token\nOPENAI_API_KEY=unrelated-key\nHTTPS_PROXY=http://fixture-proxy.invalid:8080\n',
    { mode: 0o600 },
  );
  const env = retainedAssessmentEnv(bundle, '/frozen/pricing');
  expect(env['ANTHROPIC_API_KEY']).toBe('blessed-fixture-bearer');
  expect(env['ANTHROPIC_BASE_URL']).toBe(
    'https://bedrock-mantle.us-east-1.api.aws/anthropic',
  );
  expect(env['HTTPS_PROXY']).toBe('http://fixture-proxy.invalid:8080');
  expect(env['OBOL_PRICING_DIR']).toBe('/frozen/pricing');
  for (const name of [
    'AWS_BEARER_TOKEN_BEDROCK',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'QUORUM_GRADER_SOURCE_MODE',
    'QUORUM_GRADER_ANTHROPIC_API_KEY',
  ])
    expect(env).not.toHaveProperty(name);
});
test('shared retained environment refuses missing bearer even with another provider credential', () => {
  const bundle = temporary();
  writeFileSync(
    join(bundle, 'credentials.env'),
    'ANTHROPIC_API_KEY=unblessed-key\n',
    { mode: 0o600 },
  );
  expect(() => retainedAssessmentEnv(bundle, '/frozen/pricing')).toThrow();
});
test('shared retained heartbeat scheduler reports loss and cancels future beats', async () => {
  let losses = 0,
    beats = 0;
  const scheduler = createRetainedAssessmentHeartbeatScheduler(() => {
    losses++;
  });
  const cancel = scheduler.every(2, () => {
    beats++;
    throw new Error('lease identity lost');
  });
  try {
    await Bun.sleep(20);
    expect(losses).toBeGreaterThan(0);
    expect(losses).toBe(beats);
  } finally {
    cancel();
  }
  const settled = beats;
  await Bun.sleep(20);
  expect(beats).toBe(settled);
});
test('one-case launch gives the shared environment private HOME and TMPDIR', async () => {
  const f = fixture(),
    bundle = temporary(),
    child = f.deps.child;
  writeFileSync(
    join(bundle, 'credentials.env'),
    'AWS_BEARER_TOKEN_BEDROCK=blessed-fixture-bearer\n',
    { mode: 0o600 },
  );
  f.deps.graderEnv = () => retainedAssessmentEnv(bundle, '/frozen/pricing');
  f.deps.child = async (options) => {
    expect(options.env['HOME']).toBe(join(options.cwd, 'home'));
    expect(options.env['TMPDIR']).toBe(join(options.cwd, 'tmp'));
    expect(options.env['ANTHROPIC_API_KEY']).toBe('blessed-fixture-bearer');
    expect(options.env).not.toHaveProperty('AWS_BEARER_TOKEN_BEDROCK');
    return child(options);
  };
  await runAssessmentCase(f.path, 1, f.deps);
});
