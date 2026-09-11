import { expect, test } from 'bun:test';
import {
  materializeComparison,
  parsePairing,
  type ResolvedComparisonInput,
} from '../src/campaign/comparison-input.ts';
import type { Suite } from '../src/contracts/campaign/suite.ts';

const suite: Suite = {
  schema_version: 2,
  name: 'review',
  reserve: 0,
  max_exposure_skew: 60,
  attempt_bounds: { max_attempts: 1, max_time_s: 1800 },
  comparisons: [
    {
      baseline: 'baseline',
      treatment: 'candidate',
      scenarios: ['review'],
      n: 3,
    },
  ],
};
const input: ResolvedComparisonInput = {
  baseline: { label: 'release', sha: 'a'.repeat(40) },
  candidate: { label: 'dev', sha: 'b'.repeat(40) },
  pairs: [
    { agent: 'claude', credential: 'cred_a' },
    { agent: 'codex', credential: 'cred_b' },
  ],
};

test('expands each pairing while preserving scenario repetitions', () => {
  const result = materializeComparison(suite, input);
  expect(result.suite.comparisons).toEqual([
    {
      baseline: 'p1_baseline',
      treatment: 'p1_candidate',
      scenarios: ['review'],
      n: 3,
    },
    {
      baseline: 'p2_baseline',
      treatment: 'p2_candidate',
      scenarios: ['review'],
      n: 3,
    },
  ]);
  expect(result.arms['p2_candidate']).toMatchObject({
    agent: 'codex',
    credential: 'cred_b',
    superpowers: 'b'.repeat(40),
  });
  expect(suite.comparisons).toHaveLength(1);
});

test('parses optional effort without accepting incomplete or extra segments', () => {
  expect(parsePairing('codex:cred_b:high')).toEqual({
    agent: 'codex',
    credential: 'cred_b',
    effort: 'high',
  });
  expect(parsePairing('claude:cred_a')).toEqual({
    agent: 'claude',
    credential: 'cred_a',
  });
  for (const value of [
    '',
    'claude',
    ':cred_a',
    'claude:',
    'claude:cred_a:',
    'claude:cred_a:high:extra',
    'claude:cred_a:ultra',
  ]) {
    expect(() => parsePairing(value)).toThrow();
  }
});

test('rejects empty or duplicate pairings and incomplete resolved revisions', () => {
  expect(() => materializeComparison(suite, { ...input, pairs: [] })).toThrow();
  expect(() =>
    materializeComparison(suite, {
      ...input,
      pairs: [input.pairs[0]!, input.pairs[0]!],
    }),
  ).toThrow(/duplicate/i);
  expect(() =>
    materializeComparison(suite, {
      ...input,
      candidate: { label: 'dev', sha: '' },
    }),
  ).toThrow();
});

test('rejects explicit, mixed and single-arm template roles', () => {
  for (const comparisons of [
    [{ baseline: 'arm_a', treatment: 'arm_b', scenarios: ['review'], n: 3 }],
    [...suite.comparisons, { arm: 'baseline', scenarios: ['review'], n: 3 }],
    [{ arm: 'baseline', scenarios: ['review'], n: 3 }],
  ]) {
    expect(() =>
      materializeComparison({ ...suite, comparisons }, input),
    ).toThrow(/template roles/);
  }
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { superpowersCapability } from '../src/agents/index.ts';
import {
  buildContentionBlock,
  defaultContentionThresholds,
  intakeAgentConfig,
  prepareRegistration,
  readIntakeFromEvalsTree,
} from '../src/campaign/registration.ts';
import { agentRuntimeFamily } from '../src/contracts/agent-config.ts';
import { GraderSchema } from '../src/contracts/campaign/experiment.ts';
import { SuiteSchema } from '../src/contracts/campaign/suite.ts';
import { FAKE_PROBE } from './fixtures/core-comparison/registration.ts';

test.each([
  ['focused', 84, 2],
  ['release', 366, 3],
] as const)('real %s template compiles declared coverage through ordinary preparation', (name, slots, pairCount) => {
  const root = resolve(import.meta.dir, '..');
  const { grader, ...rawSuite } = parseYaml(
    readFileSync(`${root}/examples/campaigns/validation/${name}.yaml`, 'utf8'),
  );
  const resolved: ResolvedComparisonInput = {
    baseline: {
      label: 'v6.3.0',
      sha: 'b36e0829c6d0140e93cfef2ca599b1b07d4a7797',
    },
    candidate: {
      label: 'dev',
      sha: '3a8bdc11e1db42955350d6d6f063f7a8e89aef58',
    },
    pairs: [
      { agent: 'claude', credential: 'opus_bedrock' },
      { agent: 'codex', credential: 'openai_responses_56sol' },
      { agent: 'pi', credential: 'pi_gpt56_sol' },
    ].slice(0, pairCount),
  };
  const compiled = materializeComparison(SuiteSchema.parse(rawSuite), resolved);
  const intake = readIntakeFromEvalsTree(root);
  const stats = FAKE_PROBE.sample(0);
  const prepared = prepareRegistration({
    ...compiled,
    credentials: intake.credentials,
    grader: GraderSchema.parse(grader),
    refs: {
      evals: 'e'.repeat(40),
      gauntlet: 'f'.repeat(40),
      superpowers_by_arm: Object.fromEntries(
        Object.entries(compiled.arms).map(([name, arm]) => [
          name,
          arm.superpowers,
        ]),
      ),
    },
    scenarios: intake.scenarios,
    capability: superpowersCapability,
    agentOsSupport: (agent) => intakeAgentConfig(intake, agent).os_support,
    agentFamily: (agent) =>
      agentRuntimeFamily(intakeAgentConfig(intake, agent)),
    campaignOs: 'linux',
    globalCap: 8,
    contention: buildContentionBlock({
      fingerprint: probeFingerprint(FAKE_PROBE, 0),
      globalCap: 8,
      thresholds: defaultContentionThresholds({
        mem_bytes: stats.mem_total_bytes,
        swap_total_bytes: stats.swap_total_bytes,
        disk_total_bytes: stats.disk_total_bytes,
      }),
    }),
    registeredAt: '2026-09-10T00:00:00Z',
    registeredBy: 'test',
  });
  expect(prepared.planned_slots).toHaveLength(slots);
  expect(prepared.reserve_slots).toHaveLength(0);
  for (const cell of prepared.cells)
    expect(cell.n).toBe(cell.scenario === 'sdd-go-fractals-opus48' ? 5 : 3);
  expect(prepared.excluded_cells.map((cell) => cell.cell).sort()).toEqual(
    name === 'focused'
      ? []
      : [
          'c3:conversation-config-repair',
          'c3:conversation-debugging',
          'c3:conversation-design',
          'c3:conversation-review-feedback',
          'c3:tdd-holds-under-tests-later-pressure',
          'c3:user-pref-no-brainstorm',
          'c3:worktree-no-drift-to-main',
        ],
  );
  for (const cell of prepared.excluded_cells)
    expect(cell.reason).toContain('pi');
});

import { probeFingerprint } from '../src/campaign/host-stats.ts';
