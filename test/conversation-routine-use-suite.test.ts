import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { checkArmSuiteFiles } from '../src/campaign/arm-suite-check.ts';
import { ArmSchema } from '../src/contracts/campaign/arm.ts';
import { GraderSchema } from '../src/contracts/campaign/experiment.ts';
import { SuiteSchema } from '../src/contracts/campaign/suite.ts';

const repoRoot = join(import.meta.dir, '..');
const suitePath = join(repoRoot, 'suites/conversation_routine_use.yaml');

test('routine-use stock arms differ from treatment only by name and superpowers', () => {
  for (const agent of ['claude', 'codex', 'pi']) {
    const treatment = ArmSchema.parse(
      parseYaml(
        readFileSync(join(repoRoot, `arms/conversation_${agent}.yaml`), 'utf8'),
      ),
    );
    const stock = ArmSchema.parse(
      parseYaml(
        readFileSync(
          join(repoRoot, `arms/conversation_${agent}_stock.yaml`),
          'utf8',
        ),
      ),
    );
    const {
      name: treatmentName,
      superpowers: treatmentSuperpowers,
      ...treatmentFields
    } = treatment;
    const {
      name: stockName,
      superpowers: stockSuperpowers,
      ...stockFields
    } = stock;

    expect(treatmentName).toBe(`conversation_${agent}`);
    expect(stockName).toBe(`conversation_${agent}_stock`);
    expect(treatmentSuperpowers).toBe(
      'b36e0829c6d0140e93cfef2ca599b1b07d4a7797',
    );
    expect(stockSuperpowers).toBe('none');
    expect(stockFields).toEqual(treatmentFields);
  }
});

test('routine-use suite declares the fixed 36-attempt paired matrix', () => {
  const raw = parseYaml(readFileSync(suitePath, 'utf8')) as Record<
    string,
    unknown
  >;
  const { grader, ...suiteFields } = raw;
  expect(GraderSchema.parse(grader)).toEqual({
    credential: 'sonnet5',
    model: 'claude-sonnet-5',
  });
  const suite = SuiteSchema.parse(suiteFields);

  expect(
    suite.comparisons.map((comparison) =>
      Array.isArray(comparison.scenarios)
        ? comparison.scenarios.length
        : comparison.scenarios,
    ),
  ).toEqual([4, 4, 1]);
  expect(suite.comparisons.map((comparison) => comparison.n)).toEqual([
    2, 2, 2,
  ]);
  const attempts = suite.comparisons.reduce((sum, comparison) => {
    if (!Array.isArray(comparison.scenarios) || !('baseline' in comparison)) {
      throw new Error('release requires explicit paired scenarios');
    }
    return sum + comparison.scenarios.length * comparison.n * 2;
  }, 0);
  expect(attempts).toBe(36);
  expect(suite.reserve).toBe(0);
  expect(suite.attempt_bounds).toEqual({
    max_attempts: 1,
    max_time_s: 2100,
  });

  expect(
    checkArmSuiteFiles({
      repoRoot,
      codingAgentsDir: join(repoRoot, 'coding-agents'),
      credentialsPath: join(repoRoot, 'credentials.yaml'),
    }),
  ).toEqual({ ok: true, errors: [], warnings: [] });
});
