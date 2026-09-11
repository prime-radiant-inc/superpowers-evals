import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareRecords, readManifest } from '../src/check/manifest.ts';
import { runPhase } from '../src/checks/index.ts';
import { repoRoot } from '../src/paths.ts';

const scenarioDir = join(
  repoRoot(),
  'scenarios',
  'writing-plans-no-spec-conversational',
);
const checksSh = join(scenarioDir, 'checks.sh');
const planPath = 'docs/superpowers/plans/plan.md';
const specPath = 'docs/superpowers/specs/design.md';

test('no-spec post checks accept equivalent headers and preserve filesystem authority', async () => {
  const cases = [
    {
      name: 'equivalent header',
      plan: '**Spec:** no separate specification; requirements are: add a version flag.\n',
      expected: [true, true],
    },
    {
      name: 'canonical header',
      plan: '**Spec:** none — requirements: add a version flag.\n',
      expected: [true, true],
    },
    {
      name: 'missing plan',
      plan: null,
      expected: [false, true],
    },
    {
      name: 'fabricated spec',
      plan: '**Spec:** none — requirements: add a version flag.\n',
      spec: '# Design\n',
      expected: [true, false],
    },
  ];

  for (const scenario of cases) {
    const workdir = mkdtempSync(join(tmpdir(), 'writing-plans-no-spec-'));
    try {
      if (scenario.plan !== null && scenario.plan !== undefined) {
        const plan = join(workdir, planPath);
        mkdirSync(join(plan, '..'), { recursive: true });
        writeFileSync(plan, `# Implementation plan\n\n${scenario.plan}`);
      }
      if ('spec' in scenario && scenario.spec !== undefined) {
        const spec = join(workdir, specPath);
        mkdirSync(join(spec, '..'), { recursive: true });
        writeFileSync(spec, scenario.spec);
      }

      const result = await runPhase({
        checksSh,
        phase: 'post',
        workdir,
        repoRoot: repoRoot(),
        scenarioDir,
      });

      expect(result.exitCode, scenario.name).toBe(0);
      expect(
        result.records.map((record) => record.check),
        scenario.name,
      ).toEqual(['file-exists', 'file-exists']);
      expect(
        result.records.map((record) => record.passed),
        scenario.name,
      ).toEqual(scenario.expected);
      const manifest = readManifest(scenarioDir);
      expect(manifest).not.toBeNull();
      expect(
        compareRecords(
          {
            ...manifest!,
            entries: manifest!.entries.filter(
              (entry) => entry.phase === 'post',
            ),
          },
          result.records,
        ),
        scenario.name,
      ).toEqual({ missing: [], unexpected: [] });
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  }
}, 60_000);
