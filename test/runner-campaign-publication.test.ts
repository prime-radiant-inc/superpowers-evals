import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { publishAttempt } from '../src/campaign/attempt-publish.ts';
import { readAttemptEvidence } from '../src/campaign/report-evidence.ts';
import { extractManifest, writeManifest } from '../src/check/manifest.ts';
import type { CampaignIdentity } from '../src/contracts/campaign/campaign.ts';
import { runScenario } from '../src/runner/index.ts';
import { parseAttemptManifest } from '../src/runner/manifest.ts';
import { mockGauntletDir } from './mock-gauntlet/shim.ts';

const REPO = resolve(import.meta.dir, '..');
const MOCK_GAUNTLET = resolve(import.meta.dir, 'mock-gauntlet');
const CODING_AGENTS = join(REPO, 'coding-agents');

const identity: CampaignIdentity = {
  campaign_id: 'c'.repeat(64),
  comparison_id: 'c1',
  block_id: 'c1:publication:b1',
  sample_id: 'c1:publication:arm_a:r1',
  execution_attempt_id: 'c1:publication:arm_a:r1:a1',
};

test('a checks-bearing campaign runner result publishes with authenticated check evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runner-publication-'));
  const scenarioName = 'campaign-publication';
  const scenarioDir = join(root, scenarioName);
  const campaignAttemptDir = join(root, 'attempt');
  const stagingRoot = join(campaignAttemptDir, 'staging');
  const subjectHome = join(campaignAttemptDir, 'home');
  const resultsRoot = join(root, 'results');
  const superpowersRoot = join(root, 'superpowers');
  const shimDir = mockGauntletDir('pass');
  mkdirSync(scenarioDir, { recursive: true });
  mkdirSync(resultsRoot);
  mkdirSync(superpowersRoot);
  writeFileSync(
    join(scenarioDir, 'story.md'),
    '---\nquorum_max_time: 1m\n---\nExercise campaign publication.\n',
  );
  writeFileSync(
    join(scenarioDir, 'setup.sh'),
    '#!/usr/bin/env bash\nprintf fixture > present.txt\n',
  );
  chmodSync(join(scenarioDir, 'setup.sh'), 0o755);
  writeFileSync(
    join(scenarioDir, 'checks.sh'),
    'pre() {\n  file-exists present.txt\n}\n' +
      'post() {\n  file-contains present.txt fixture\n}\n',
  );
  writeManifest(scenarioDir, extractManifest(join(scenarioDir, 'checks.sh')));

  const envKeys = [
    'PATH',
    'ANTHROPIC_API_KEY',
    'AWS_BEARER_TOKEN_BEDROCK',
    'SUPERPOWERS_ROOT',
  ] as const;
  const savedEnv = envKeys.map((key) => [key, Bun.env[key]] as const);
  Bun.env['PATH'] = `${shimDir}:${MOCK_GAUNTLET}:${Bun.env['PATH'] ?? ''}`;
  Bun.env['ANTHROPIC_API_KEY'] = 'sk-test';
  Bun.env['AWS_BEARER_TOKEN_BEDROCK'] = 'bedrock-key-test';
  Bun.env['SUPERPOWERS_ROOT'] = superpowersRoot;

  try {
    const runResult = await runScenario({
      scenarioDir,
      codingAgent: 'claude',
      codingAgentsDir: CODING_AGENTS,
      outRoot: stagingRoot,
      campaign: identity,
      campaignAttemptDir,
    });
    expect(runResult.verdict.final).toBe('pass');
    expect(existsSync(join(runResult.runDir, 'home'))).toBe(false);

    const manifestBody = readFileSync(
      join(runResult.runDir, 'manifest.json'),
      'utf8',
    );
    const manifest = parseAttemptManifest(manifestBody);
    const published = publishAttempt({
      attemptDir: campaignAttemptDir,
      resultsRoot,
      expectedAttemptId: identity.execution_attempt_id,
      expectedIdentity: identity,
      expectedRunId: manifest.run_id,
    });
    const artifacts = [
      ...manifest.files.map((file) => ({
        path: `${published.runId}/${file.path}`,
        sha256: file.sha256,
        bytes: file.size,
      })),
      {
        path: `${published.runId}/manifest.json`,
        sha256: createHash('sha256').update(manifestBody).digest('hex'),
        bytes: Buffer.byteLength(manifestBody),
      },
    ];

    rmSync(subjectHome, { recursive: true, force: true });
    rmSync(stagingRoot, { recursive: true, force: true });

    const publishedDir = join(resultsRoot, published.runId);
    expect(existsSync(publishedDir)).toBe(true);
    expect(
      JSON.parse(readFileSync(join(publishedDir, 'verdict.json'), 'utf8')),
    ).toMatchObject({ scenario: scenarioName });
    const evidence = readAttemptEvidence({
      resultsRoot,
      expectedIdentity: identity,
      artifacts,
    });
    expect(evidence.publication_valid).toBe(true);
    expect(evidence.checks).toEqual([
      expect.objectContaining({
        check: 'file-exists',
        phase: 'pre',
        passed: true,
      }),
      expect.objectContaining({
        check: 'file-contains',
        phase: 'post',
        passed: true,
      }),
    ]);
  } finally {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
