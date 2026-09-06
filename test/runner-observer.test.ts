import { expect, spyOn, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import * as agents from '../src/agents/index.ts';
import { publishExecution } from '../src/campaign/attempt-publish.ts';
import { extractManifest, writeManifest } from '../src/check/manifest.ts';
import {
  jcsCanonicalize,
  sha256Hex,
} from '../src/contracts/campaign/digest.ts';
import {
  readObserverBundle,
  readObserverScore,
} from '../src/experiments/observer/bundle.ts';
import { runScenario } from '../src/runner/index.ts';
import { parseAttemptManifest } from '../src/runner/manifest.ts';
import {
  blockActivation,
  twoArmExperiment,
} from './fixtures/core-comparison/factory.ts';
import { lifecycleFixture } from './fixtures/core-comparison/lifecycle.ts';

test.each([
  'pass',
  'fail',
  'missing-review',
  'no-parent',
  'interrupted',
  'error',
  'stop',
])('runner freezes observer on %s exit before its manifest', async (mode) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'runner-observer-')));
  const original = spyOn(agents, 'resolveAgent').mockImplementation(
    (config) => ({
      config,
      provision(home) {
        mkdirSync(home.configDir, { recursive: true });
        return {};
      },
    }),
  );
  try {
    const scenario = join(root, 'brainstorming-todo-shared-intent');
    mkdirSync(scenario);
    writeFileSync(
      join(scenario, 'story.md'),
      'Run the local contract fixture.',
    );
    writeFileSync(
      join(scenario, 'setup.sh'),
      '#!/usr/bin/env bash\nprintf fixture > README.md\n',
    );
    chmodSync(join(scenario, 'setup.sh'), 0o755);
    writeFileSync(
      join(scenario, 'checks.sh'),
      'pre() {\n file-exists README.md\n}\npost() {\n brainstorming-review\n}\n',
    );
    writeManifest(scenario, extractManifest(join(scenario, 'checks.sh')));
    const config = join(root, 'agents');
    mkdirSync(join(config, 'codex-context'), { recursive: true });
    for (const file of ['HOWTO.md', 'project-prompt.md'])
      writeFileSync(join(config, 'codex-context', file), 'Local fixture.');
    writeFileSync(
      join(config, 'codex-context', 'launch-agent.sh'),
      '#!/usr/bin/env bash\nexit 0\n',
    );
    const binary = join(root, 'subject');
    writeFileSync(
      binary,
      '#!/usr/bin/env bash\nprintf "codex-cli 0.144.3\\n"\n',
    );
    chmodSync(binary, 0o755);
    writeFileSync(
      join(config, 'codex.yaml'),
      `name: codex\nbinary: ${binary}\nhome_config_subdir: .codex\nsession_log_dir: "\${QUORUM_AGENT_HOME}/.codex/sessions"\nsession_log_glob: "**/*.jsonl"\nnormalizer: codex\nrequired_env: []\n`,
    );
    const gauntlet = join(root, 'gauntlet');
    writeFileSync(
      gauntlet,
      `#!/usr/bin/env bun\nimport {runObserverFixture} from ${JSON.stringify(resolve(import.meta.dir, 'fixtures/observer/runner-gauntlet.ts'))};\nrunObserverFixture(${JSON.stringify(mode)});\n`,
    );
    chmodSync(gauntlet, 0o755);
    writeFileSync(join(root, 'missing-credentials.yaml'), '{}');
    const attempt = join(root, 'attempt');
    mkdirSync(join(attempt, 'staging'), { recursive: true });
    const experiment = twoArmExperiment();
    for (const arm of experiment.execution_surface) arm.agent = 'codex';
    const scenarioName = 'brainstorming-todo-shared-intent';
    experiment.suite.comparisons[0]!.scenarios = [scenarioName];
    experiment.cells[0]!.scenario = scenarioName;
    experiment.suite.reserve = 0;
    experiment.reserve_slots = [];
    experiment.suite.attempt_bounds.max_attempts = 1;
    for (const slot of experiment.planned_slots) slot.scenario = scenarioName;
    const intent = blockActivation(experiment).attempts[0]!;
    const oldRoot = intent.output_root;
    Object.assign(
      intent,
      JSON.parse(JSON.stringify(intent).replaceAll(oldRoot, attempt)),
    );
    intent.identity.execution_attempt_id = `${intent.identity.sample_id}:a1`;
    intent.runtime_spec_digest = sha256Hex(
      jcsCanonicalize(intent.runtime_spec),
    );
    let runDir = '';
    const result = await runScenario({
      scenarioDir: scenario,
      codingAgent: 'codex',
      codingAgentsDir: config,
      outRoot: join(attempt, 'staging'),
      campaignAttemptDir: attempt,
      gauntletBin: gauntlet,
      credentialsPath: join(root, 'missing-credentials.yaml'),
      superpowers: { mode: 'none' },
      campaign: intent.identity,
      onRunDir: (dir) => {
        runDir = dir;
      },
      shouldStop: () =>
        mode === 'stop' &&
        runDir !== '' &&
        existsSync(join(runDir, 'subject-finished')),
    });
    const manifest = parseAttemptManifest(
      readFileSync(join(result.runDir, 'manifest.json'), 'utf8'),
    );
    const bundleDir = join(result.runDir, 'brainstorming-evidence', 'bundle');
    if (mode === 'no-parent' || mode === 'interrupted') {
      expect(result.verdict.final).toBe('indeterminate');
      expect(result.verdict.error?.message).toContain('observer');
      expect(existsSync(bundleDir)).toBe(false);
    } else {
      expect(existsSync(bundleDir)).toBe(true);
      expect(readObserverBundle(bundleDir).binding.home).toBe(
        join(attempt, 'home'),
      );
      expect(
        manifest.files.some(
          (f) =>
            f.path === 'brainstorming-evidence/bundle/observer-bundle.json',
        ),
      ).toBe(true);
      if (mode === 'pass' || mode === 'fail') {
        expect(result.verdict.final).toBe(mode);
        const cli = resolve(
          import.meta.dir,
          '../src/cli/brainstorming-evidence.ts',
        );
        const score = spawnSync(process.execPath, [cli, 'score', bundleDir], {
          encoding: 'utf8',
        });
        expect(score.status).toBe(mode === 'pass' ? 0 : 1);
        const index = spawnSync(process.execPath, [cli, 'index', bundleDir], {
          encoding: 'utf8',
        });
        expect(index.status).toBe(0);
        expect(
          JSON.parse(index.stdout).sources[0].entries.length,
        ).toBeGreaterThan(0);
        const resultsRoot = join(root, 'results');
        mkdirSync(resultsRoot);
        const published = publishExecution({
          experiment,
          bound: { intent, container_id: 'a'.repeat(64) },
          stopped: {
            execution_attempt_id: intent.identity.execution_attempt_id,
            container_id: 'a'.repeat(64),
            proof: 'inspected_stopped',
            observed_at: new Date().toISOString(),
          },
          resultsRoot,
        });
        const copy = join(root, 'portable');
        cpSync(join(resultsRoot, published.runId), copy, { recursive: true });
        rmSync(join(attempt, 'home'), { recursive: true });
        rmSync(join(resultsRoot, published.runId), { recursive: true });
        const portableBundle = join(copy, 'brainstorming-evidence', 'bundle');
        const replay = spawnSync(
          process.execPath,
          [cli, 'score', portableBundle],
          { encoding: 'utf8' },
        );
        expect(replay.stdout).toBe(score.stdout);
        expect(replay.status).toBe(score.status);
        const replayIndex = spawnSync(
          process.execPath,
          [cli, 'index', portableBundle],
          { encoding: 'utf8' },
        );
        expect(replayIndex.stdout).toBe(index.stdout);
        const frozen = readObserverBundle(portableBundle);
        writeFileSync(join(portableBundle, frozen.receipts[0]!), '{}');
        expect(
          spawnSync(process.execPath, [cli, 'score', portableBundle]).status,
        ).toBe(127);
      }
      if (mode === 'error') expect(result.verdict.error).not.toBeNull();
      if (mode === 'stop')
        expect(result.verdict.final_reason).toContain('stop');
      if (mode !== 'missing-review' && mode !== 'pass' && mode !== 'fail')
        expect(readObserverScore(bundleDir).status).toBe('pass');
      if (mode === 'missing-review')
        expect(result.verdict.final).toBe('indeterminate');
    }
    expect(manifest.run_id).toBe(basename(result.runDir));
    expect(manifest.files.some((f) => f.path.startsWith('home/'))).toBe(false);
  } finally {
    original.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

test('observer readout CLI preserves active-campaign behavior hiding', () => {
  const f = lifecycleFixture();
  try {
    const results = join(f.root, 'results');
    mkdirSync(results);
    const result = spawnSync(
      process.execPath,
      [
        resolve(import.meta.dir, '../src/cli/brainstorming-evidence.ts'),
        'readout',
        '--campaign-dir',
        f.campaignDir,
        '--results-root',
        results,
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).behavior_available).toBe(false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
