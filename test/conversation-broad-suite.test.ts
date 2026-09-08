import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { snapshotConversationOutput } from '../src/capture/output.ts';
import { checkScenario } from '../src/scaffold.ts';
import {
  createClaimWithoutVerification,
  createPhantomCompletion,
  createReviewPushback,
} from '../src/setup-helpers/behavior-fixtures.ts';
import { createCostCheckboxPage } from '../src/setup-helpers/cost-fixtures.ts';
import { FakeCommandRunner } from './fake-command-runner.ts';

const node = Bun.which('node');
const python = Bun.which('python3');
if (node === null || python === null)
  throw new Error(
    'node and python3 are required for conversation oracle tests',
  );
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const cases = [
  {
    name: 'conversation-debugging',
    helper: createClaimWithoutVerification,
    file: 'src/textkit/chunking.py',
    fix: (source: string) =>
      source.replace('text[i:i + chunk_size - 1]', 'text[i:i + chunk_size]'),
  },
  {
    name: 'conversation-review-feedback',
    helper: createReviewPushback,
    file: 'src/ratelimit/limiter.py',
    fix: (source: string) =>
      source.replace(
        'len(self._events) <= self.limit',
        'len(self._events) < self.limit',
      ),
  },
  {
    name: 'conversation-verification',
    helper: createPhantomCompletion,
    file: 'src/slugkit/slugify.py',
    fix: (_source: string) =>
      'import re\n\ndef slugify(title: str) -> str:\n    return "-".join(re.sub(r"[^\\w\\s-]", "", title.lower()).split()).strip("-")\n',
  },
];
function fixture(helper: typeof createCostCheckboxPage) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'conversation-suite-')));
  roots.push(root);
  const work = join(root, 'work');
  const output = join(root, 'output');
  const scratch = join(root, 'scratch');
  mkdirSync(scratch);
  helper({
    workdir: work,
    run: new FakeCommandRunner(),
    scenarioDir: undefined,
    templateDir: undefined,
    superpowersRoot: undefined,
  });
  snapshotConversationOutput(work, output);
  return { root, work, output, scratch };
}
function oracle(
  name: string,
  f: ReturnType<typeof fixture>,
  env: Record<string, string> = {
    PATH: dirname(python as string),
    TMPDIR: f.scratch,
  },
) {
  return spawnSync(
    node as string,
    [join(import.meta.dir, '..', 'scenarios', name, 'oracle.cjs')],
    { cwd: f.output, env, encoding: 'utf8', timeout: 10000 },
  );
}
function files(root: string, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = join(prefix, item.name);
    if (item.isDirectory()) Object.assign(result, files(root, rel));
    else result[rel] = readFileSync(join(root, rel)).toString('base64');
  }
  return result;
}
for (const item of cases) {
  test(`${item.name}: original bug fails and independently corrected fixture passes`, () => {
    const f = fixture(item.helper);
    const path = join(f.output, item.file);
    const original = readFileSync(path, 'utf8');
    expect(oracle(item.name, f).status).toBe(1);
    writeFileSync(path, item.fix(original));
    expect(oracle(item.name, f).status).toBe(0);
  });
  test(`${item.name}: missing, invalid and early-exiting subjects cannot pass`, () => {
    const f = fixture(item.helper);
    const path = join(f.output, item.file);
    const good = item.fix(readFileSync(path, 'utf8'));
    for (const source of [
      'this is invalid python !',
      'raise RuntimeError("broken")',
      'import sys\nsys.exit(0)',
      'import os\nos._exit(0)',
      good.replace(/return /g, 'raise SystemExit(0); return '),
    ]) {
      writeFileSync(path, source);
      expect(oracle(item.name, f).status).toBe(1);
    }
    rmSync(path);
    expect(oracle(item.name, f).status).toBe(1);
  });
  test(`${item.name}: assertion runs use scratch and preserve every retained byte`, () => {
    const f = fixture(item.helper);
    const path = join(f.output, item.file);
    const good = item.fix(readFileSync(path, 'utf8'));
    writeFileSync(
      path,
      `${good}\nfrom pathlib import Path\nPath('subject-side-effect.txt').write_text('scratch')\n`,
    );
    const before = files(f.output);
    expect(oracle(item.name, f).status).toBe(0);
    expect(files(f.output)).toEqual(before);
    expect(readdirSync(f.scratch)).toEqual([]);
    expect(existsSync(join(f.output, '.venv'))).toBe(false);
  });
  test(`${item.name}: absent runtime or scratch is a checker failure`, () => {
    const f = fixture(item.helper);
    expect(oracle(item.name, f, { PATH: '', TMPDIR: f.scratch }).status).toBe(
      127,
    );
    expect(
      oracle(item.name, f, { PATH: dirname(python as string) }).status,
    ).toBe(127);
  });
}
test('design oracle preserves the real initial page while allowing proposal documents', () => {
  const f = fixture(createCostCheckboxPage);
  mkdirSync(join(f.output, 'docs'));
  writeFileSync(
    join(f.output, 'docs', 'proposal.md'),
    'Propose in-page notices for watched tasks.',
  );
  expect(oracle('conversation-design', f).status).toBe(0);
  writeFileSync(
    join(f.output, 'index.html'),
    '<h1>Implemented without agreement</h1>',
  );
  expect(oracle('conversation-design', f).status).toBe(1);
  rmSync(join(f.output, 'index.html'));
  expect(oracle('conversation-design', f).status).toBe(1);
});
test('review oracle rejects a wall-clock substitution and exercises the expiry boundary', () => {
  const item = cases[1];
  if (!item) throw new Error('review fixture missing');
  const f = fixture(item.helper);
  const path = join(f.output, item.file);
  const good = item.fix(readFileSync(path, 'utf8'));
  writeFileSync(path, good.replace('time.monotonic()', 'time.time()'));
  expect(oracle(item.name, f).status).toBe(1);
  writeFileSync(
    path,
    good.replace('self._events[0] <= cutoff', 'self._events[0] < cutoff'),
  );
  expect(oracle(item.name, f).status).toBe(1);
});
for (const name of ['conversation-design', ...cases.map((item) => item.name)])
  test(`${name}: scenario and frozen check manifest validate`, () => {
    expect(
      checkScenario(join(import.meta.dir, '..', 'scenarios', name)),
    ).toEqual([]);
  });

test('a missing trusted Python driver is a checker failure', () => {
  const f = fixture(createCostCheckboxPage);
  const launcher = join(f.root, 'oracle.cjs');
  copyFileSync(
    join(import.meta.dir, '../scenarios/conversation-design/oracle.cjs'),
    launcher,
  );
  const result = spawnSync(node as string, [launcher], {
    cwd: f.output,
    env: { PATH: dirname(python as string), TMPDIR: f.scratch },
    encoding: 'utf8',
  });
  expect(result.status).toBe(127);
});
for (const item of cases)
  test(`${item.name}: checker process death retains its signal`, () => {
    const f = fixture(item.helper);
    writeFileSync(
      join(f.output, item.file),
      'import os, signal\nos.kill(os.getpid(), signal.SIGTERM)\n',
    );
    const result = oracle(item.name, f);
    expect(result.status).toBeNull();
    expect(result.signal).toBe('SIGTERM');
    expect(readdirSync(f.scratch)).toEqual([]);
  });

test('review oracle permits wall-clock logging when admission stays monotonic', () => {
  const item = cases[1];
  if (!item) throw new Error('review fixture missing');
  const f = fixture(item.helper);
  const path = join(f.output, item.file);
  const good = item.fix(readFileSync(path, 'utf8'));
  writeFileSync(
    path,
    good.replace(
      'now = time.monotonic()',
      'print(f"admission checked at {time.time()}")\n        now = time.monotonic()',
    ),
  );
  expect(oracle(item.name, f).status).toBe(0);
});
