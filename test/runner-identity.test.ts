import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FinalVerdictSchema } from '../src/contracts/verdict.ts';
import { runScenario } from '../src/runner/index.ts';

// The schema accepts the additive identity fields, all optional.
test('FinalVerdictSchema accepts identity fields', () => {
  const v = {
    schema: 1,
    final: 'pass',
    final_reason: 'ok',
    gauntlet: null,
    checks: [],
    error: null,
    economics: null,
    scenario: 'demo',
    coding_agent: 'claude',
    started_at: '2026-06-12T00:00:00.000Z',
    finished_at: '2026-06-12T00:01:00.000Z',
    credential: 'opus',
    os: 'linux',
  };
  const parsed = FinalVerdictSchema.parse(v);
  expect(parsed.scenario).toBe('demo');
  expect(parsed.credential).toBe('opus');
  expect(parsed.os).toBe('linux');
});

// A verdict with no identity fields still parses (old runs).
test('FinalVerdictSchema identity fields are optional', () => {
  const v = {
    schema: 1,
    final: 'pass',
    final_reason: 'ok',
    gauntlet: null,
    checks: [],
    error: null,
    economics: null,
  };
  expect(FinalVerdictSchema.parse(v).scenario).toBeUndefined();
});

test('runScenario persists labels from the selected credential snapshot', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runner-identity-'));
  const credentialsPath = join(root, 'credentials.yaml');
  const labels = {
    model: 'pi-test-model',
    provider: 'openrouter',
    quantization: 'fp16',
    preset_version_id: '00000000-0000-4000-8000-000000000003',
    catalog_as_of: '2026-07-10',
  };
  writeFileSync(
    credentialsPath,
    [
      'candidate:',
      '  model: pi-test-model',
      '  harnesses: [pi]',
      '  api: openai-chat',
      '  auth: api-key',
      '  labels:',
      `    model: ${labels.model}`,
      `    provider: ${labels.provider}`,
      `    quantization: ${labels.quantization}`,
      `    preset_version_id: ${labels.preset_version_id}`,
      `    catalog_as_of: ${labels.catalog_as_of}`,
      '',
    ].join('\n'),
  );

  const { runDir, verdict } = await runScenario({
    scenarioDir: join(root, 'missing-scenario'),
    codingAgent: 'pi',
    codingAgentsDir: resolve(import.meta.dir, '..', 'coding-agents'),
    outRoot: join(root, 'results'),
    credential: 'candidate',
    credentialsPath,
  });

  expect(verdict.labels).toEqual(labels);
  const persisted = FinalVerdictSchema.parse(
    JSON.parse(readFileSync(join(runDir, 'verdict.json'), 'utf8')),
  );
  expect(persisted.labels).toEqual(labels);
});
