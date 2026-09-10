import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { type Arm, ArmSchema } from '../src/contracts/campaign/arm.ts';
import { GraderSchema } from '../src/contracts/campaign/experiment.ts';
import { SuiteSchema } from '../src/contracts/campaign/suite.ts';
import { parseCredentialsFile } from '../src/contracts/credential.ts';

const ROOT = join(import.meta.dir, '..');
const SCENARIO = 'diagnosing-full-session';
const CONTROL_REF = 'd7bc5b0197d3f5358d8af03d4474ec3c826465be';
const TREATMENT_REF = '6ac8f0c0c9e256a619736388fd5c0b85c35c39a1';

const EXPECTED_PAIRS = [
  {
    agent: 'claude',
    credential: 'opus_bedrock',
    model: 'anthropic.claude-opus-4-8',
    effort: 'high',
  },
  {
    agent: 'codex',
    credential: 'openai_responses_56sol',
    model: 'gpt-5.6-sol',
    effort: 'high',
  },
  {
    agent: 'pi',
    credential: 'pi_gpt56_sol',
    model: 'gpt-5.6-sol',
    effort: undefined,
  },
] as const;

function loadYaml(path: string): unknown {
  return parseYaml(readFileSync(join(ROOT, path), 'utf8'));
}

function loadArm(name: string): Arm {
  return ArmSchema.parse(loadYaml(`arms/${name}.yaml`));
}

test('full diagnosis declares one bounded before/after run for each harness', () => {
  const raw = loadYaml('suites/pr2236_full_diagnosis.yaml') as Record<
    string,
    unknown
  >;
  expect(GraderSchema.parse(raw['grader'])).toEqual({
    credential: 'sonnet5',
    model: 'claude-sonnet-5',
  });
  const { grader: _grader, ...suiteFields } = raw;
  const suite = SuiteSchema.parse(suiteFields);
  const credentials = parseCredentialsFile(loadYaml('credentials.yaml'));

  expect(suite).toMatchObject({
    schema_version: 2,
    name: 'pr2236_full_diagnosis',
    reserve: 0,
    max_exposure_skew: 60,
    attempt_bounds: { max_attempts: 1, max_time_s: 1200 },
  });
  expect(suite.comparisons).toHaveLength(3);

  let plannedAttempts = 0;
  for (const [index, expected] of EXPECTED_PAIRS.entries()) {
    const comparison = suite.comparisons[index];
    expect(comparison).toEqual({
      baseline: `pr2236_full_${expected.agent}_before`,
      treatment: `pr2236_full_${expected.agent}_after`,
      scenarios: [SCENARIO],
      n: 1,
    });
    if (comparison === undefined || !('baseline' in comparison)) continue;

    const before = loadArm(comparison.baseline);
    const after = loadArm(comparison.treatment);
    for (const arm of [before, after]) {
      expect(arm.agent).toBe(expected.agent);
      expect(arm.os).toBe('linux');
      expect(arm.credential).toBe(expected.credential);
      expect(arm.effort).toBe(expected.effort);
    }
    expect(credentials[expected.credential]?.model).toBe(expected.model);
    expect(before.name).toBe(comparison.baseline);
    expect(after.name).toBe(comparison.treatment);
    expect(before.superpowers).toBe(CONTROL_REF);
    expect(after.superpowers).toBe(TREATMENT_REF);
    plannedAttempts += comparison.scenarios.length * comparison.n * 2;
  }
  expect(plannedAttempts).toBe(6);
});

test('full diagnosis keeps the public story at fifteen minutes and excludes private history', () => {
  const scenarioDir = join(ROOT, 'scenarios', SCENARIO);
  const story = readFileSync(join(scenarioDir, 'story.md'), 'utf8');
  expect(story).toContain('\nquorum_max_time: 15m\n');
  expect(existsSync(join(scenarioDir, 'history'))).toBe(false);
});
