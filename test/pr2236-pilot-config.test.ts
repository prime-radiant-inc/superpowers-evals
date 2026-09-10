import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { type Arm, ArmSchema } from '../src/contracts/campaign/arm.ts';
import { GraderSchema } from '../src/contracts/campaign/experiment.ts';
import { SuiteSchema } from '../src/contracts/campaign/suite.ts';

const ROOT = join(import.meta.dir, '..');
const SCENARIO = 'diagnosing-session-discovery';
const CONTROL_REF = 'd7bc5b0197d3f5358d8af03d4474ec3c826465be';
const TREATMENT_REF = '1a51aa0ac628f75354fd3e1a52b572b603953c77';

const EXPECTED_PAIRS = [
  {
    agent: 'claude',
    credential: 'opus_bedrock',
    effort: 'high',
  },
  {
    agent: 'codex',
    credential: 'openai_responses_56sol',
    effort: 'high',
  },
  {
    agent: 'pi',
    credential: 'pi_gpt56_sol',
    effort: undefined,
  },
] as const;

function loadYaml(path: string): unknown {
  return parseYaml(readFileSync(join(ROOT, path), 'utf8'));
}

function loadArm(name: string): Arm {
  return ArmSchema.parse(loadYaml(`arms/${name}.yaml`));
}

test('PR 2236 pilot expands to exactly one before/after run per harness', () => {
  const suitePath = join(ROOT, 'suites/pr2236_session_discovery.yaml');
  expect(existsSync(suitePath)).toBe(true);

  const raw = loadYaml('suites/pr2236_session_discovery.yaml') as Record<
    string,
    unknown
  >;
  expect(GraderSchema.parse(raw['grader'])).toEqual({
    credential: 'sonnet5',
    model: 'claude-sonnet-5',
  });
  const { grader: _grader, ...suiteFields } = raw;
  const suite = SuiteSchema.parse(suiteFields);

  expect(suite.comparisons).toHaveLength(3);
  expect(suite.reserve).toBe(0);
  expect(suite.attempt_bounds).toEqual({
    max_attempts: 1,
    max_time_s: 600,
  });

  let plannedEvaluations = 0;
  const includedScenarios = new Set<string>();
  for (const [index, expected] of EXPECTED_PAIRS.entries()) {
    const comparison = suite.comparisons[index];
    expect(comparison).toEqual({
      baseline: `pr2236_${expected.agent}_before`,
      treatment: `pr2236_${expected.agent}_after`,
      scenarios: [SCENARIO],
      n: 1,
    });
    if (comparison === undefined || !('baseline' in comparison)) continue;

    const before = loadArm(comparison.baseline);
    const after = loadArm(comparison.treatment);
    expect(before.name).toBe(comparison.baseline);
    expect(after.name).toBe(comparison.treatment);
    expect(before.agent).toBe(expected.agent);
    expect(after.agent).toBe(expected.agent);
    expect(before.credential).toBe(expected.credential);
    expect(after.credential).toBe(expected.credential);
    expect(before.effort).toBe(expected.effort);
    expect(after.effort).toBe(expected.effort);
    expect(before.superpowers).toBe(CONTROL_REF);
    expect(after.superpowers).toBe(TREATMENT_REF);
    expect(before.superpowers).not.toBe(after.superpowers);

    for (const scenario of comparison.scenarios) {
      includedScenarios.add(scenario);
    }
    plannedEvaluations += comparison.scenarios.length * comparison.n * 2;
  }

  expect(plannedEvaluations).toBe(6);
  expect([...includedScenarios]).toEqual([SCENARIO]);
});
