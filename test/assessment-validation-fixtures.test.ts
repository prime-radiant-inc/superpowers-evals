import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { GraderSchema } from '../src/contracts/campaign/experiment.ts';
import { SuiteSchema } from '../src/contracts/campaign/suite.ts';
import { projectConversationStory } from '../src/runner/conversation-input.ts';
import { createCodeReviewPlantedBugs } from '../src/setup-helpers/behavior-fixtures.ts';

const fixtures = 'test/fixtures/assessment-validation';
const workloads = 'examples/campaigns/validation';
const sha256 = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

test('constructed source is byte-identical to the actual planted fixture', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-planted-'));
  try {
    createCodeReviewPlantedBugs({
      workdir: root,
      templateDir: undefined,
      superpowersRoot: undefined,
      scenarioDir: undefined,
      run: {
        run() {
          throw new Error('unexpected external dependency');
        },
      },
    });
    expect(
      execFileSync('git', ['show', 'HEAD~1:src/db.js'], { cwd: root }),
    ).toEqual(
      readFileSync(
        join(fixtures, 'constructed/supported-complete/db.before.js'),
      ),
    );
    expect(readFileSync(join(root, 'src/db.js'))).toEqual(
      readFileSync(join(fixtures, 'constructed/supported-complete/db.js')),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lookup success does not imply authentication or a storage format', async () => {
  const root = mkdtempSync(join(tmpdir(), 'review-counterexample-'));
  try {
    copyFileSync(
      join(fixtures, 'constructed/supported-complete/db.js'),
      join(root, 'db.js'),
    );
    writeFileSync(
      join(root, 'database-driver.js'),
      'export class Database { query() { return {id: 1, password_hash: "stored-digest"}; } }',
    );
    const { login, findUserByEmail } = await import(
      pathToFileURL(join(root, 'db.js')).href
    );
    expect(await findUserByEmail("' OR 1=1 --")).toMatchObject({ id: 1 });
    expect(await login("' OR 1=1 --", 'wrong-password')).toBeNull();
    expect(await login('alice', 'correct-password')).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('constructed evidence bytes and full rubrics match the frozen manifest', () => {
  const manifest = json(join(fixtures, 'manifest.json')) as {
    cases: Array<{
      id: string;
      partition: string;
      location: string;
      rubric_sha256: string;
      evidence_sha256: string;
      expected: Array<{
        criterion: number;
        verdict: string;
        required_reason: string;
      }>;
    }>;
  };
  expect(manifest.cases).toHaveLength(8);
  const rubric = projectConversationStory(
    readFileSync('scenarios/conversation-code-review/story.md', 'utf8'),
  ).rubric;
  for (const entry of manifest.cases) {
    expect(entry.expected.map((row) => row.criterion)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(entry.expected.every((row) => row.required_reason.length > 0)).toBe(
      true,
    );
    expect(entry.rubric_sha256).toBe(sha256(rubric));
    if (entry.partition !== 'held-out') {
      expect(entry.location).toBe(entry.id);
      continue;
    }
    const root = join(fixtures, entry.location);
    const index = json(join(root, 'index.json')) as { files: string[] };
    // The complete before/current source boundary excludes labels and the injected driver.
    expect(index.files.toSorted()).toEqual([
      'db.before.js',
      'db.js',
      'review.md',
    ]);
    const inventory = Object.fromEntries(
      ['index.json', ...index.files]
        .sort()
        .map((file) => [file, sha256(readFileSync(join(root, file)))]),
    );
    expect(sha256(JSON.stringify(inventory))).toBe(entry.evidence_sha256);
    expect(sha256(readFileSync(join(root, 'rubric.md')))).toBe(
      entry.rubric_sha256,
    );
    expect(sha256(readFileSync(join(root, 'db.js')))).toBe(
      '89d327d35e468272115f40b2f0b995a5b279ce61d5436701d7ca768913dcc6f0',
    );
    const words = readFileSync(join(root, 'review.md'), 'utf8')
      .trim()
      .split(/\s+/).length;
    expect(words).toBeGreaterThanOrEqual(600);
    expect(words).toBeLessThanOrEqual(1000);
  }
});

test('qualification denominators separate grounding from omitted findings', () => {
  const manifest = json(join(fixtures, 'manifest.json'));
  expect(manifest.assessments_per_case).toBe(3);
  expect(manifest.cases.length * manifest.assessments_per_case).toBe(24);
  expect(
    manifest.cases.reduce(
      (n: number, c: { expected: unknown[] }) => n + c.expected.length * 3,
      0,
    ),
  ).toBe(144);
  for (const verdict of ['pass', 'fail']) {
    expect(
      manifest.cases.filter(
        (c: { expected: Array<{ verdict: string }> }) =>
          c.expected[5]?.verdict === verdict,
      ).length * 3,
    ).toBe(12);
  }
  expect(
    manifest.cases
      .find((c: { id: string }) => c.id === 'missing-credential')
      .expected.map((row: { verdict: string }) => row.verdict),
  ).toEqual(['pass', 'pass', 'fail', 'pass', 'fail', 'pass']);
});

test('workload declarations preserve samples, exclusions and existing suite fields', () => {
  const requirements = json(join(workloads, 'requirements.json'));
  for (const [name, scenarioCount, samples, bound] of [
    ['focused', 7, 84, 5400],
    ['release', 22, 366, 10800],
  ] as const) {
    const { grader, ...raw } = parse(
      readFileSync(join(workloads, `${name}.yaml`), 'utf8'),
    );
    expect(GraderSchema.parse(grader)).toEqual({
      credential: 'sonnet5',
      model: 'claude-sonnet-5',
    });
    const suite = SuiteSchema.parse(raw);
    expect(suite.reserve).toBe(0);
    expect(suite.attempt_bounds).toEqual({
      max_attempts: 1,
      max_time_s: bound,
    });
    const comparison = suite.comparisons[0]!;
    expect(comparison).toMatchObject({
      baseline: 'baseline',
      treatment: 'candidate',
      n: 3,
    });
    const scenarios = comparison.scenarios as string[];
    expect(scenarios).toHaveLength(scenarioCount);
    let actual = 0;
    for (const scenario of scenarios) {
      const repetitions = comparison.cells?.[scenario]?.n ?? comparison.n;
      const harnesses =
        name === 'release' &&
        requirements.scenarios[scenario].pi_release_eligible
          ? 3
          : 2;
      actual += repetitions * harnesses * 2;
    }
    expect(actual).toBe(samples);
    expect(sha256(readFileSync(suite.pricing_snapshot!.path))).toBe(
      suite.pricing_snapshot!.sha256,
    );
  }
});

test('criterion obligations bind current story, rubric and check manifest bytes', () => {
  const requirements = json(join(workloads, 'requirements.json'));
  for (const [name, raw] of Object.entries(requirements.scenarios)) {
    const scenario = raw as {
      mode: string;
      story_sha256: string;
      rubric_sha256: string;
      criteria: Array<{
        id: string;
        ordinal: number;
        text: string;
        required_artifact_classes: string[];
      }>;
      oracle_authority: { manifest: string; check_manifest_sha256: string };
    };
    const story = readFileSync(`scenarios/${name}/story.md`, 'utf8');
    expect(sha256(story)).toBe(scenario.story_sha256);
    expect(
      sha256(
        scenario.mode === 'conversation'
          ? projectConversationStory(story).rubric
          : story,
      ),
    ).toBe(scenario.rubric_sha256);
    expect(sha256(readFileSync(scenario.oracle_authority.manifest))).toBe(
      scenario.oracle_authority.check_manifest_sha256,
    );
    for (const [index, criterion] of scenario.criteria.entries()) {
      expect(criterion.ordinal).toBe(index + 1);
      expect(criterion.id).toBe(`${name}:${index + 1}`);
      expect(criterion.text.length).toBeGreaterThan(0);
      expect(criterion.required_artifact_classes.length).toBeGreaterThan(0);
    }
  }
});

test('check references preserve exact manifest entries and limited oracle authority', () => {
  const requirements = json(join(workloads, 'requirements.json'));
  for (const raw of Object.values(requirements.scenarios)) {
    const scenario = raw as {
      checks: Array<{
        ordinal: number;
        authority: { kind: string; sources: string[] };
        phase: string;
        check: string;
        args: string[] | null;
        negated: boolean;
        count: number;
      }>;
      criteria: Array<{
        check_refs: Array<{ ordinal: number; scope: string }>;
      }>;
      oracle_authority: { manifest: string };
    };
    const manifest = json(scenario.oracle_authority.manifest);
    expect(scenario.checks).toHaveLength(manifest.entries.length);
    for (const [index, entry] of scenario.checks.entries()) {
      const { ordinal, authority, ...identity } = entry;
      expect(ordinal).toBe(index);
      expect(identity).toEqual(manifest.entries[index]);
      expect(authority.kind.length).toBeGreaterThan(0);
      for (const source of authority.sources)
        expect(readFileSync(source).length).toBeGreaterThan(0);
    }
    for (const criterion of scenario.criteria) {
      expect(Array.isArray(criterion.check_refs)).toBe(true);
      for (const reference of criterion.check_refs) {
        expect(scenario.checks[reference.ordinal]?.ordinal).toBe(
          reference.ordinal,
        );
        expect(reference.scope.length).toBeGreaterThan(0);
      }
    }
  }
  const repair = requirements.scenarios['conversation-config-repair'];
  expect(
    repair.criteria[1].check_refs.map(
      (ref: { ordinal: number }) => ref.ordinal,
    ),
  ).toEqual([3]);
  expect(repair.checks[3].authority).toEqual({
    kind: 'independent_behavior',
    sources: ['scenarios/conversation-config-repair/oracle.py'],
  });
  expect(repair.criteria[1].required_artifact_classes).toEqual([
    'output',
    'check_dispositions',
  ]);
});

test('source-only grounding remains judgeable without process capture', () => {
  const requirements = json(join(workloads, 'requirements.json'));
  const review = requirements.scenarios['conversation-code-review'];
  const grounding = review.criteria[5];
  const available = new Set(['visible_delivery', 'output']);
  expect(
    grounding.required_artifact_classes.every((kind: string) =>
      available.has(kind),
    ),
  ).toBe(true);
  expect(grounding.required_artifact_classes).toEqual([
    'visible_delivery',
    'output',
  ]);
  expect(grounding.check_refs).toEqual([]);
  expect(
    review.criteria.every(
      (criterion: { check_refs: unknown[] }) =>
        criterion.check_refs.length === 0,
    ),
  ).toBe(true);
  const process =
    requirements.scenarios['triggering-test-driven-development'].criteria[0];
  expect(process.required_artifact_classes).toContain('normalized_trace');
  expect(
    process.required_artifact_classes.every((kind: string) =>
      available.has(kind),
    ),
  ).toBe(false);
});
