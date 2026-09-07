import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { publishAttempt } from '../src/campaign/attempt-publish.ts';
import { readAttemptEvidence } from '../src/campaign/report-evidence.ts';
import { extractManifest, writeManifest } from '../src/check/manifest.ts';
import type { CampaignIdentity } from '../src/contracts/campaign/campaign.ts';
import { CHECK_SCRATCH_DIR } from '../src/contracts/campaign/execution.ts';
import { runScenario } from '../src/runner/index.ts';
import {
  parseAttemptManifest,
  writeAttemptManifest,
} from '../src/runner/manifest.ts';
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
  // realpath: the published-artifact readers refuse symlinked path components
  // by design, and macOS tmpdir() lives under /var -> /private/var.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'runner-publication-')));
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
    '#!/usr/bin/env bash\nprintf fixture > present.txt\nmkdir -p scratch-empty\nln -s present.txt link-to-present\n' +
      'mkdir -p node_modules/pkg && printf dep > node_modules/pkg/index.js && mkdir -p .venv/bin && printf py > .venv/bin/python\n',
  );
  chmodSync(join(scenarioDir, 'setup.sh'), 0o755);
  // The attempt scratch tmpfs is mounted noexec, so the check phase's sink must
  // land on the container's exec-capable /tmp instead (PRI-3097). Both phases
  // probe it: the runner threads the scratch root into pre() and post()
  // separately.
  const tmpdirProbe = `  command-succeeds 'case "$TMPDIR" in ${CHECK_SCRATCH_DIR}/sink-*/tmp) exit 0;; *) echo "TMPDIR=$TMPDIR" >&2; exit 1;; esac'\n`;
  writeFileSync(
    join(scenarioDir, 'checks.sh'),
    `pre() {\n  file-exists present.txt\n${tmpdirProbe}}\n` +
      `post() {\n  file-contains present.txt fixture\n${tmpdirProbe}}\n`,
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

  // An unrooted sink lands under os.tmpdir(), which is /tmp itself when TMPDIR
  // is unset — there the probe would pass without checkScratchRoot. Pin TMPDIR
  // to a fresh directory for the run: a default sink then lands at
  // <pinned>/sink-*/tmp, which the probe's ${CHECK_SCRATCH_DIR}/sink-*/tmp
  // pattern cannot match even when the pinned directory is itself under /tmp.
  const savedTmpdir = Bun.env['TMPDIR'];
  const pinnedTmpdir = realpathSync(mkdtempSync(join(tmpdir(), 'not-tmp-')));
  Bun.env['TMPDIR'] = pinnedTmpdir;

  try {
    const runResult = await runScenario({
      scenarioDir,
      codingAgent: 'claude',
      codingAgentsDir: CODING_AGENTS,
      outRoot: stagingRoot,
      campaign: identity,
      campaignAttemptDir,
      checkScratchRoot: CHECK_SCRATCH_DIR,
    });
    expect(runResult.verdict.final).toBe('pass');
    expect(existsSync(join(runResult.runDir, 'home'))).toBe(false);

    // New-mode artifacts travel through the ordinary worker manifest/publisher.
    const retained = {
      'conversation.json': {
        status: 'completed',
        endpoint: 'refusal',
        reason: 'Subject declined',
        timestamp: '2026-09-07T00:00:00Z',
        evidence: {
          path: 'conversation-agent/demo/captures/1.ansi',
          quote: 'Declined',
        },
      },
      'gauntlet-roles.json': {
        conversation: {
          out_dir: 'conversation-agent/demo',
          model: 'offline',
          started_at: '2026-09-07T00:00:00Z',
          finished_at: '2026-09-07T00:00:01Z',
          process_exit: { code: 0, signal: null },
          stop_cause: null,
        },
        assessment: {
          out_dir: 'gauntlet-agent/results/demo',
          model: 'offline',
          started_at: null,
          finished_at: null,
          process_exit: null,
          stop_cause: null,
        },
      },
      'conversation-agent/demo/exchange.jsonl': {
        kind: 'screen',
        path: 'captures/1.ansi',
      },
      'evidence/index.json': {
        files: ['conversation.json', 'output/pricing.js'],
      },
      'evidence/conversation.json': {
        status: 'completed',
        endpoint: 'refusal',
      },
      'evidence/output/pricing.js': { total: 0 },
    };
    for (const [path, body] of Object.entries(retained)) {
      mkdirSync(dirname(join(runResult.runDir, path)), { recursive: true });
      writeFileSync(join(runResult.runDir, path), JSON.stringify(body));
    }
    writeAttemptManifest(runResult.runDir, identity);
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
      existsSync(join(publishedDir, 'coding-agent-workdir', 'node_modules')),
    ).toBe(false);
    expect(
      existsSync(join(publishedDir, 'coding-agent-workdir', '.venv')),
    ).toBe(false);
    expect(
      manifest.files.some(
        (f) => f.path.includes('node_modules') || f.path.includes('.venv'),
      ),
    ).toBe(false);
    expect(
      JSON.parse(readFileSync(join(publishedDir, 'verdict.json'), 'utf8')),
    ).toMatchObject({ scenario: scenarioName });
    const evidence = readAttemptEvidence({
      resultsRoot,
      expectedIdentity: identity,
      artifacts,
    });
    expect(evidence.publication_valid).toBe(true);
    for (const [path, body] of Object.entries(retained)) {
      expect(manifest.files.some((file) => file.path === path)).toBe(true);
      expect(
        JSON.parse(readFileSync(join(publishedDir, path), 'utf8')),
      ).toEqual(body);
    }
    const link = join(publishedDir, 'coding-agent-workdir', 'link-to-present');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe('present.txt');
    expect(evidence.checks).toEqual([
      expect.objectContaining({
        check: 'file-exists',
        phase: 'pre',
        passed: true,
      }),
      expect.objectContaining({
        check: 'command-succeeds',
        phase: 'pre',
        passed: true,
      }),
      expect.objectContaining({
        check: 'file-contains',
        phase: 'post',
        passed: true,
      }),
      expect.objectContaining({
        check: 'command-succeeds',
        phase: 'post',
        passed: true,
      }),
    ]);
  } finally {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
    if (savedTmpdir === undefined) delete Bun.env['TMPDIR'];
    else Bun.env['TMPDIR'] = savedTmpdir;
    rmSync(pinnedTmpdir, { recursive: true, force: true });
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
