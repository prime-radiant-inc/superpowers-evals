import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAgent, superpowersCapability } from '../src/agents/index.ts';
import type { AtifTrajectory } from '../src/atif/types.ts';
import { validateTrajectory } from '../src/atif/validate.ts';
import { captureTokenUsage, captureToolCalls } from '../src/capture/index.ts';
import {
  type AgentConfig,
  agentRuntimeFamily,
  loadAgentConfigForValidation,
} from '../src/contracts/agent-config.ts';
import { credentialScopeForSelection } from '../src/credentials/scope.ts';
import { buildContextSubstitutions, runScenario } from '../src/runner/index.ts';

const FAKE_SUBJECT_KEY = 'fake-subject-key-for-portable-test';
const FAKE_CONFIG_YAML = [
  'name: fake',
  'runtime_family: fake',
  'binary: fake-coding-agent',
  'session_log_dir: "${QUORUM_AGENT_HOME}/.claude/projects"',
  'session_log_glob: "**/*.jsonl"',
  'normalizer: claude',
  'home_config_subdir: .claude',
  'required_env: []',
  'default_credential: fake_subject',
  'os_support: [linux]',
  '',
].join('\n');

const FAKE_CONFIG: AgentConfig = {
  name: 'fake',
  runtime_family: 'fake',
  binary: 'fake-coding-agent',
  session_log_dir: '${QUORUM_AGENT_HOME}/.claude/projects',
  session_log_glob: '**/*.jsonl',
  normalizer: 'claude',
  home_config_subdir: '.claude',
  required_env: [],
  os_support: ['linux'],
};

function makeFakeRoot(
  withContext = true,
  subjectEnv = 'FAKE_SUBJECT_KEY',
): {
  readonly root: string;
  readonly agentsDir: string;
  readonly cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), 'quorum-fake-family-'));
  const agentsDir = join(root, 'coding-agents');
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, 'fake.yaml'), FAKE_CONFIG_YAML);

  if (withContext) {
    const contextDir = join(agentsDir, 'fake-context');
    mkdirSync(contextDir, { recursive: true });
    writeFileSync(
      join(contextDir, 'HOWTO.md'),
      'Submit $QUORUM_LAUNCH_AGENT.\n' +
        'Subject file: $QUORUM_SUBJECT_FILE\n' +
        'Quoted: $QUORUM_SUBJECT_FILE_SH\n',
    );
    const launcher = join(contextDir, 'launch-agent');
    writeFileSync(
      launcher,
      '#!/bin/sh\n' +
        '. "$QUORUM_SUBJECT_FILE"\n' +
        `printf '%s\\n' "$${subjectEnv}"\n`,
    );
    chmodSync(launcher, 0o755);
  }

  return {
    root,
    agentsDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeCredentials(
  root: string,
  auth = 'api-key',
  apiKeyEnv = 'FAKE_SUBJECT_KEY',
): string {
  const path = join(root, 'credentials.yaml');
  writeFileSync(
    path,
    [
      'fake_subject:',
      '  model: fake-subject-model',
      '  api: anthropic',
      `  auth: ${auth}`,
      `  api_key_env: ${apiKeyEnv}`,
      '  harnesses: [fake]',
      '  compat: {}',
      '',
    ].join('\n'),
  );
  return path;
}

function writeScenario(root: string): string {
  const scenarioDir = join(root, 'scenario');
  mkdirSync(scenarioDir, { recursive: true });
  writeFileSync(
    join(scenarioDir, 'story.md'),
    '---\nquorum_max_time: 1m\n---\nRun the fake subject.\n',
  );
  const setup = join(scenarioDir, 'setup.sh');
  writeFileSync(setup, '#!/bin/sh\n:\n');
  chmodSync(setup, 0o755);
  writeFileSync(
    join(scenarioDir, 'checks.sh'),
    'pre() { :; }\npost() { :; }\n',
  );
  return scenarioDir;
}

function writeGauntletStub(root: string): string {
  const path = join(root, 'gauntlet');
  writeFileSync(
    path,
    [
      '#!/bin/sh',
      'set -eu',
      'if [ "${1:-}" = "--version" ]; then',
      "  printf '%s\\n' 'fake-gauntlet 1.0'",
      '  exit 0',
      'fi',
      'mkdir -p gauntlet-agent/results/fake-run',
      "cat > gauntlet-agent/results/fake-run/result.json <<'EOF'",
      '{"status":"pass","summary":"fake grader pass","reasoning":"fake grader completed"}',
      'EOF',
      'mkdir -p "$QUORUM_AGENT_HOME/.claude/projects/fake"',
      'cat > "$QUORUM_AGENT_HOME/.claude/projects/fake/row.jsonl" <<\'EOF\'',
      '{"type":"assistant","timestamp":"2026-09-03T12:00:00.000Z","message":{"id":"fake-message-1","role":"assistant","model":"fake-subject-model","content":[{"type":"tool_use","id":"toolu_fake_1","name":"read","input":{"path":"HOWTO.md"}}],"usage":{"input_tokens":11,"output_tokens":7}}}',
      'EOF',
      '',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return path;
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

test('synthetic fake config parses and resolves its runtime family', () => {
  const fixture = makeFakeRoot();
  try {
    const config = loadAgentConfigForValidation(fixture.agentsDir, 'fake');
    expect(agentRuntimeFamily(config)).toBe('fake');
    expect(config.binary).toBe('fake-coding-agent');
  } finally {
    fixture.cleanup();
  }
});

test('fake family uses the declarative DefaultAgent and default-deny capabilities', () => {
  const fixture = makeFakeRoot();
  const homeRoot = mkdtempSync(join(tmpdir(), 'quorum-fake-home-'));
  try {
    const agent = resolveAgent(FAKE_CONFIG);
    expect(agent.config).toEqual(FAKE_CONFIG);
    expect(
      agent.provision(
        {
          configDir: join(homeRoot, '.claude'),
          workdir: join(homeRoot, 'workdir'),
          skeletonRoot: fixture.agentsDir,
        },
        undefined as never,
      ),
    ).toEqual({});
    expect(existsSync(join(homeRoot, '.claude'))).toBe(true);
    expect(superpowersCapability(FAKE_CONFIG)).toEqual({
      ref: false,
      none: true,
    });
  } finally {
    fixture.cleanup();
    rmSync(homeRoot, { recursive: true, force: true });
  }
});

test('fake api-key credentials project one stage-file env assignment', () => {
  const fixture = makeFakeRoot();
  try {
    const credentialsPath = writeCredentials(fixture.root);
    expect(
      credentialScopeForSelection(fixture.root, {
        agent: 'fake',
        credential: 'fake_subject',
      }),
    ).toEqual({
      schemaVersion: 1,
      kind: 'live',
      agent: 'fake',
      runtimeFamily: 'fake',
      credential: 'fake_subject',
      agentEnv: [
        {
          destinationName: 'FAKE_SUBJECT_KEY',
          sourceNames: ['FAKE_SUBJECT_KEY'],
        },
      ],
      geminiAuthType: null,
      oauth: null,
    });
    expect(readFileSync(credentialsPath, 'utf8')).toContain('fake_subject:');
  } finally {
    fixture.cleanup();
  }
});

test('fake non-api-key credentials fail closed', () => {
  const fixture = makeFakeRoot();
  try {
    writeCredentials(fixture.root, 'oauth');
    expect(() =>
      credentialScopeForSelection(fixture.root, {
        agent: 'fake',
        credential: 'fake_subject',
      }),
    ).toThrow(/no audited delivery channel for family 'fake' auth 'oauth'/);
  } finally {
    fixture.cleanup();
  }
});

test('fake runner requires its context directory', async () => {
  const fixture = makeFakeRoot(false);
  const scenarioDir = writeScenario(fixture.root);
  const credentialsPath = writeCredentials(fixture.root);
  const outRoot = join(fixture.root, 'results');
  const previousKey = process.env['FAKE_SUBJECT_KEY'];
  process.env['FAKE_SUBJECT_KEY'] = FAKE_SUBJECT_KEY;
  try {
    const result = await runScenario({
      scenarioDir,
      codingAgent: 'fake',
      codingAgentsDir: fixture.agentsDir,
      outRoot,
      credentialsPath,
    });
    expect(result.verdict.final).toBe('indeterminate');
    expect(result.verdict.error?.stage).toBe('setup');
    expect(result.verdict.error?.message).toContain(
      'required context directory missing',
    );
  } finally {
    restoreEnv('FAKE_SUBJECT_KEY', previousKey);
    fixture.cleanup();
  }
});

test('fake runner rejects a missing or empty selected subject env', async () => {
  const subjectEnv = 'ACME_SUBJECT_TOKEN';
  const previousKey = process.env[subjectEnv];
  const previousDefaultKey = process.env['FAKE_SUBJECT_KEY'];
  try {
    for (const value of [undefined, '']) {
      const fixture = makeFakeRoot(false, subjectEnv);
      const scenarioDir = writeScenario(fixture.root);
      const credentialsPath = writeCredentials(
        fixture.root,
        'api-key',
        subjectEnv,
      );
      const outRoot = join(fixture.root, 'results');
      if (value === undefined) {
        delete process.env[subjectEnv];
      } else {
        process.env[subjectEnv] = value;
      }
      delete process.env['FAKE_SUBJECT_KEY'];
      try {
        const result = await runScenario({
          scenarioDir,
          codingAgent: 'fake',
          codingAgentsDir: fixture.agentsDir,
          outRoot,
          credentialsPath,
        });
        expect(result.verdict.final).toBe('indeterminate');
        expect(result.verdict.error?.stage).toBe('setup');
        expect(result.verdict.error?.message).toMatch(
          new RegExp(`${subjectEnv}.*unset/empty`),
        );
      } finally {
        fixture.cleanup();
      }
    }
  } finally {
    restoreEnv(subjectEnv, previousKey);
    restoreEnv('FAKE_SUBJECT_KEY', previousDefaultKey);
  }
});

test('fake runner uses the selected api_key_env for subject provisioning', async () => {
  const subjectEnv = 'ACME_SUBJECT_TOKEN';
  const fixture = makeFakeRoot(true, subjectEnv);
  const scenarioDir = writeScenario(fixture.root);
  const credentialsPath = writeCredentials(fixture.root, 'api-key', subjectEnv);
  const gauntletBin = writeGauntletStub(fixture.root);
  const outRoot = join(fixture.root, 'results');
  const previousKey = process.env[subjectEnv];
  const previousDefaultKey = process.env['FAKE_SUBJECT_KEY'];
  delete process.env['FAKE_SUBJECT_KEY'];
  process.env[subjectEnv] = FAKE_SUBJECT_KEY;
  try {
    const result = await runScenario({
      scenarioDir,
      codingAgent: 'fake',
      codingAgentsDir: fixture.agentsDir,
      outRoot,
      credentialsPath,
      gauntletBin,
    });
    expect(result.verdict.final).toBe('pass');

    const subjectFile = join(result.runDir, 'home', '.fake-env');
    expect(readFileSync(subjectFile, 'utf8')).toBe(
      `${subjectEnv}='${FAKE_SUBJECT_KEY}'\n`,
    );
    const launcher = join(
      result.runDir,
      'gauntlet-agent',
      'context',
      'launch-agent',
    );
    const launched = spawnSync(launcher, {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
    });
    expect(launched.status).toBe(0);
    expect(launched.stdout).toBe(`${FAKE_SUBJECT_KEY}\n`);
  } finally {
    restoreEnv(subjectEnv, previousKey);
    restoreEnv('FAKE_SUBJECT_KEY', previousDefaultKey);
    fixture.cleanup();
  }
});

test('fake runner provisions a private subject file and substitutes both subject-file tokens', async () => {
  const fixture = makeFakeRoot();
  const scenarioDir = writeScenario(fixture.root);
  const credentialsPath = writeCredentials(fixture.root);
  const gauntletBin = writeGauntletStub(fixture.root);
  const outRoot = join(fixture.root, 'results');
  const previousKey = process.env['FAKE_SUBJECT_KEY'];
  process.env['FAKE_SUBJECT_KEY'] = FAKE_SUBJECT_KEY;
  try {
    const result = await runScenario({
      scenarioDir,
      codingAgent: 'fake',
      codingAgentsDir: fixture.agentsDir,
      outRoot,
      credentialsPath,
      gauntletBin,
    });
    expect(result.verdict.final).toBe('pass');

    const runHome = join(result.runDir, 'home');
    const subjectFile = join(runHome, '.fake-env');
    expect(readFileSync(subjectFile, 'utf8')).toBe(
      `FAKE_SUBJECT_KEY='${FAKE_SUBJECT_KEY}'\n`,
    );
    expect(statSync(subjectFile).mode & 0o777).toBe(0o600);

    const contextDir = join(result.runDir, 'gauntlet-agent', 'context');
    const howto = readFileSync(join(contextDir, 'HOWTO.md'), 'utf8');
    expect(howto).toContain(subjectFile);
    expect(howto).toContain(`'${subjectFile}'`);
    expect(howto).not.toContain('$QUORUM_SUBJECT_FILE');
    expect(howto).not.toContain('$QUORUM_SUBJECT_FILE_SH');

    const launcher = join(contextDir, 'launch-agent');
    const launched = spawnSync(launcher, {
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
    });
    expect(launched.status).toBe(0);
    expect(launched.stdout).toBe(`${FAKE_SUBJECT_KEY}\n`);

    const trajectory = JSON.parse(
      readFileSync(join(result.runDir, 'trajectory.json'), 'utf8'),
    ) as AtifTrajectory;
    expect(validateTrajectory(trajectory).ok).toBe(true);
    expect(
      JSON.parse(
        readFileSync(
          join(result.runDir, 'coding-agent-token-usage.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({
      total_input: 11,
      total_output: 7,
      total_tokens: 18,
      est_cost_usd: null,
    });
  } finally {
    restoreEnv('FAKE_SUBJECT_KEY', previousKey);
    fixture.cleanup();
  }
});

test('fake subject JSONL normalizes and prices through the ATIF capture path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quorum-fake-capture-'));
  try {
    const logDir = join(root, 'home', '.claude', 'projects', 'fake');
    const runDir = join(root, 'run');
    mkdirSync(logDir, { recursive: true });
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(logDir, 'row.jsonl'),
      `${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-09-03T12:00:00.000Z',
        message: {
          id: 'fake-capture-message',
          role: 'assistant',
          model: 'fake-unpriced-model',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_fake_capture',
              name: 'read',
              input: { path: 'HOWTO.md' },
            },
          ],
          usage: { input_tokens: 13, output_tokens: 5 },
        },
      })}\n`,
    );

    const args = {
      logDir: join(root, 'home', '.claude', 'projects'),
      logGlob: '**/*.jsonl',
      snapshot: new Set<string>(),
      normalizer: 'claude',
      runDir,
      launchCwd: join(root, 'workdir'),
    };
    const captured = captureToolCalls(args);
    expect(captured.rowCount).toBe(1);
    expect(
      validateTrajectory(
        JSON.parse(readFileSync(captured.path, 'utf8')) as AtifTrajectory,
      ).ok,
    ).toBe(true);

    const usagePath = await captureTokenUsage(args);
    expect(usagePath).toBe(join(runDir, 'coding-agent-token-usage.json'));
    expect(JSON.parse(readFileSync(usagePath!, 'utf8'))).toMatchObject({
      total_input: 13,
      total_output: 5,
      total_tokens: 18,
      est_cost_usd: null,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fake subject substitutions are absent for other families', () => {
  const substitutions = buildContextSubstitutions({
    launchCwd: '/tmp/workdir',
    launchAgentPath: '/tmp/run/context/launch-agent',
    runHomeDir: '/tmp/run/home',
    family: 'claude',
  });
  expect(substitutions['$QUORUM_SUBJECT_FILE']).toBeUndefined();
  expect(substitutions['$QUORUM_SUBJECT_FILE_SH']).toBeUndefined();
});
