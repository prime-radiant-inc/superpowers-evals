import { afterEach, expect, test } from 'bun:test';
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
import { snapshotDir } from '../src/capture/index.ts';
import { getEnv } from '../src/env.ts';
import { runPreparedConversation } from '../src/runner/conversation.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function setup(mode = 'refusal') {
  const runDir = mkdtempSync(join(tmpdir(), 'convo-'));
  dirs.push(runDir);
  for (const dir of ['scenario', 'work', 'home', 'logs'])
    mkdirSync(join(runDir, dir));
  const scenarioDir = join(runDir, 'scenario');
  const workdir = join(runDir, 'work');
  writeFileSync(join(runDir, 'fixture-mode'), mode);
  writeFileSync(
    join(scenarioDir, 'story.md'),
    '---\nid: demo\nquorum_mode: conversation\nquorum_max_time: 10m\n---\nPlease fix pricing.\n\n## Acceptance Criteria\n- Fix pricing\n',
  );
  writeFileSync(join(scenarioDir, 'oracle.cjs'), 'process.exit(1)');
  writeFileSync(
    join(scenarioDir, 'checks.sh'),
    'pre() { :; }\npost() { command-succeeds "node \\"$QUORUM_SCENARIO_DIR/oracle.cjs\\""; }\n'.replaceAll(
      '\\"',
      '"',
    ),
  );
  writeFileSync(join(workdir, 'pricing.js'), 'unchanged');
  const gauntletBin = join(runDir, 'gauntlet');
  writeFileSync(
    gauntletBin,
    `#!/bin/sh\nexec '${process.execPath}' '${resolve(import.meta.dir, 'fixtures/conversation-role.ts')}' "$@"\n`,
  );
  chmodSync(gauntletBin, 0o755);
  return {
    runDir,
    scenarioDir,
    storyPath: join(scenarioDir, 'story.md'),
    launcherPath: gauntletBin,
    workdir,
    launchCwd: workdir,
    runHomeDir: join(runDir, 'home'),
    configDir: join(runDir, 'home'),
    codingAgent: 'claude',
    normalizer: 'claude' as const,
    logDir: join(runDir, 'home', 'logs'),
    logGlob: '*.jsonl',
    snapshot: snapshotDir(join(runDir, 'home', 'logs'), '*.jsonl'),
    checksSh: join(scenarioDir, 'checks.sh'),
    checksRepoRoot: resolve(import.meta.dir, '..'),
    preRecords: [],
    expectedChecks: null,
    gauntletBin,
    graderModel: 'offline',
    maxTime: '1s',
    envBase: {
      PATH: getEnv('PATH'),
      HOME: runDir,
      ANTHROPIC_API_KEY: 'offline',
    },
    shouldStop: () => false,
    identity: {
      scenario: 'demo',
      agent: 'claude',
      credential: 'test',
      os: 'linux',
    },
  };
}
test('completed refusal retains evidence and failing oracle still reaches isolated assessment', async () => {
  const args = setup();
  const v = await runPreparedConversation(args);
  expect(v.final).toBe('fail');
  expect(v.conversation?.status).toBe('completed');
  expect(v.checks.some((c) => c.phase === 'post' && !c.passed)).toBe(true);
  const calls = readFileSync(join(args.runDir, 'invocations.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  expect(calls.map((c) => c.role)).toEqual(['converse', 'assess']);
  expect(calls[0].input).not.toContain('Acceptance Criteria');
  expect(calls[1].input).not.toContain('Please fix pricing');
  expect(calls[0].env.home).toBe(args.runHomeDir);
  expect(calls[1].env.home).toBeUndefined();
  expect(calls.map((c) => c.env.modelKey)).toEqual(['offline', 'offline']);
  const files = JSON.parse(
    readFileSync(join(args.runDir, 'evidence/index.json'), 'utf8'),
  ).files;
  expect(files).toContain('checks.json');
  expect(files).toContain('native/native.jsonl');
  expect(files).toContain('output/pricing.js');
  expect(files).toContain('visible/captures/final.ansi');
  expect(files).toContain('trajectory.json');
  expect(
    files.every((p: string) => existsSync(join(args.runDir, 'evidence', p))),
  ).toBe(true);
  expect(v.gauntlet?.process_exit).toEqual({ code: 0, signal: null });
});
for (const mode of [
  'cleanup-error',
  'cleanup-zero',
  'capture-error',
  'assessment-error',
  'missing-criteria',
  'inconsistent',
  'inconsistent-unclear',
])
  test(`${mode} preserves completion and cannot pass`, async () => {
    const args = setup(mode);
    const v = await runPreparedConversation(args);
    expect(v.final).toBe('indeterminate');
    expect(v.economics?.['gauntlet']).toBeTruthy();
    expect(v.conversation?.status).toBe('completed');
    if (mode === 'cleanup-zero')
      expect(
        existsSync(join(args.runDir, 'evidence/native/native.jsonl')),
      ).toBe(true);
    if (mode === 'assessment-error')
      expect(v.gauntlet?.process_exit?.code).toBe(7);
    if (mode === 'cleanup-error' || mode === 'capture-error')
      expect(
        readFileSync(join(args.runDir, 'invocations.jsonl'), 'utf8')
          .trim()
          .split('\n'),
      ).toHaveLength(1);
  });
test('missing endpoint does not start assessment', async () => {
  const args = setup('incomplete');
  const v = await runPreparedConversation(args);
  expect(v.final).toBe('indeterminate');
  expect(v.conversation?.status).toBe('errored');
  expect(
    readFileSync(join(args.runDir, 'invocations.jsonl'), 'utf8')
      .trim()
      .split('\n'),
  ).toHaveLength(1);
});
test('cancellation before launch allocates both roles without executing either', async () => {
  const args = setup();
  const v = await runPreparedConversation({ ...args, shouldStop: () => true });
  expect(v.error?.stage).toBe('stopped');
  expect(v.economics?.['gauntlet']).toMatchObject({
    roles: {
      conversation: { status: 'not_run' },
      assessment: { status: 'not_run' },
    },
  });
  expect(existsSync(join(args.runDir, 'invocations.jsonl'))).toBe(false);
  expect(
    JSON.parse(readFileSync(join(args.runDir, 'gauntlet-roles.json'), 'utf8'))
      .assessment.started_at,
  ).toBeNull();
});

for (const mode of ['conversation-hang', 'assessment-hang'])
  test(`cancellation during ${mode} stops the worker and preserves any completion`, async () => {
    const args = setup(mode);
    const v = await runPreparedConversation({
      ...args,
      shouldStop: () => {
        const path = join(args.runDir, 'invocations.jsonl');
        return (
          existsSync(path) &&
          readFileSync(path, 'utf8').includes(
            mode === 'assessment-hang'
              ? '"role":"assess"'
              : '"role":"converse"',
          )
        );
      },
    });
    expect(v.error?.stage).toBe('stopped');
    expect(v.conversation?.status).toBe(
      mode === 'assessment-hang' ? 'completed' : 'stopped',
    );
  });
test('a crashed checker preserves completion and records but starts no assessment', async () => {
  const args = setup();
  writeFileSync(
    args.checksSh,
    'pre() { :; }\npost() { file-exists missing; exit 137; }\n',
  );
  const v = await runPreparedConversation(args);
  expect(v.error?.stage).toBe('checks');
  expect(v.conversation?.status).toBe('completed');
  expect(v.checks).toHaveLength(1);
  expect(
    readFileSync(join(args.runDir, 'invocations.jsonl'), 'utf8')
      .trim()
      .split('\n'),
  ).toHaveLength(1);
});
test('cancellation after oracle starts no assessment', async () => {
  const args = setup();
  const marker = join(args.runDir, 'oracle-done');
  writeFileSync(
    join(args.scenarioDir, 'oracle.cjs'),
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'done'); process.exit(1);`,
  );
  const v = await runPreparedConversation({
    ...args,
    shouldStop: () => existsSync(marker),
  });
  expect(v.error?.stage).toBe('stopped');
  expect(v.conversation?.status).toBe('completed');
  expect(v.checks).toHaveLength(1);
  expect(
    readFileSync(join(args.runDir, 'invocations.jsonl'), 'utf8')
      .trim()
      .split('\n'),
  ).toHaveLength(1);
});

test('runner rejects an unsupported family even when it uses the Pi normalizer', async () => {
  const args = setup();
  const agents = join(args.runDir, 'agents');
  mkdirSync(agents);
  writeFileSync(
    join(agents, 'fake.yaml'),
    'name: fake\nruntime_family: fake\nbinary: /usr/bin/true\nnormalizer: pi\nhome_config_subdir: .pi/agent\nsession_log_dir: "${QUORUM_AGENT_HOME}/logs"\nsession_log_glob: "*.jsonl"\nrequired_env: []\nos_support: [linux]\n',
  );
  const credentialsPath = join(args.runDir, 'credentials.yaml');
  writeFileSync(credentialsPath, '{}\n');
  const { runScenario } = await import('../src/runner/index.ts');
  const result = await runScenario({
    scenarioDir: args.scenarioDir,
    codingAgent: 'fake',
    codingAgentsDir: agents,
    credentialsPath,
    outRoot: join(args.runDir, 'out'),
    gauntletBin: '/usr/bin/true',
    superpowers: { mode: 'none' },
  });
  expect(result.verdict.error?.stage).toBe('setup');
  expect(result.verdict.final_reason).toContain(
    'conversation mode supports only Linux',
  );
  expect(existsSync(join(result.runDir, 'coding-agent-workdir'))).toBe(false);
});

test('full runner uses prepared launcher/home and returns the persisted completed verdict', async () => {
  const args = setup();
  const agents = join(args.runDir, 'agents');
  const context = join(agents, 'claude-context');
  mkdirSync(context, { recursive: true });
  writeFileSync(
    join(agents, 'claude.yaml'),
    'name: claude\ndefault_credential: test_subject\nruntime_family: claude\nbinary: /usr/bin/true\nnormalizer: claude\nhome_config_subdir: .claude\nsession_log_dir: "${QUORUM_AGENT_HOME}/logs"\nsession_log_glob: "*.jsonl"\nrequired_env: []\nos_support: [linux]\n',
  );
  writeFileSync(join(context, 'HOWTO.md'), 'Launch $QUORUM_LAUNCH_AGENT.\n');
  writeFileSync(
    join(context, 'launch-agent'),
    '#!/bin/sh\ncd "$QUORUM_AGENT_CWD"\nprintf "%s" "$QUORUM_AGENT_HOME" > launch-home.txt\n',
  );
  chmodSync(join(context, 'launch-agent'), 0o755);
  writeFileSync(join(args.scenarioDir, 'setup.sh'), '#!/bin/sh\n:\n');
  chmodSync(join(args.scenarioDir, 'setup.sh'), 0o755);
  const credentialsPath = join(args.runDir, 'credentials.yaml');
  writeFileSync(
    credentialsPath,
    'test_subject:\n  model: offline\n  api: anthropic\n  auth: subscription\n  harnesses: [claude]\n',
  );
  const { runScenario, runWasStopped } = await import('../src/runner/index.ts');
  const result = await runScenario({
    scenarioDir: args.scenarioDir,
    codingAgent: 'claude',
    codingAgentsDir: agents,
    credentialsPath,
    outRoot: join(args.runDir, 'out'),
    gauntletBin: args.gauntletBin,
    superpowers: { mode: 'none' },
  });
  expect(result.verdict.error).toBeNull();
  expect(result.verdict.final).toBe('fail');
  expect(result.verdict.conversation?.status).toBe('completed');
  expect(
    readFileSync(
      join(result.runDir, 'evidence/output/launch-home.txt'),
      'utf8',
    ),
  ).toBe(join(result.runDir, 'home'));
  expect(
    JSON.parse(readFileSync(join(result.runDir, 'verdict.json'), 'utf8'))
      .conversation,
  ).toEqual(result.verdict.conversation);
  expect(runWasStopped()).toBe(false);
});

test('full runner admits Pi through its provisioned launcher without an effort argument', async () => {
  const args = setup('full-run');
  writeFileSync(join(args.scenarioDir, 'setup.sh'), '#!/bin/sh\n:\n');
  chmodSync(join(args.scenarioDir, 'setup.sh'), 0o755);
  const credentialsPath = join(args.runDir, 'credentials.yaml');
  writeFileSync(
    credentialsPath,
    'test_subject:\n  model: gpt-5.6-sol\n  api: openai-responses\n  base_url: https://api.openai.com/v1\n  api_key_env: QUORUM_PI_TEST_KEY\n  auth: api-key\n  harnesses: [pi]\n',
  );

  const shimDir = join(args.runDir, 'shims');
  const globalModules = join(args.runDir, 'global-modules');
  const sessionFixture = join(args.runDir, 'pi-session.jsonl');
  mkdirSync(join(globalModules, 'pi-subagents'), { recursive: true });
  mkdirSync(shimDir);
  writeFileSync(
    join(shimDir, 'npm'),
    `#!/bin/sh\nprintf '%s\\n' '${globalModules}'\n`,
  );
  writeFileSync(
    join(shimDir, 'pi'),
    `#!/bin/sh
set -eu
if [ "${'${1-}'}" = "--version" ]; then
  printf '%s\\n' 'pi 0.0-test'
  exit 0
fi
printf '%s\\n' "$@" > pi-launch-argv.txt
printf '%s\\n' "${'${PI_PROVIDER-}'}/${'${PI_MODEL-}'}" > pi-launch-model.txt
mkdir -p "$HOME/.pi/agent/sessions/native"
cp '${sessionFixture}' "$HOME/.pi/agent/sessions/native/session.jsonl"
`,
  );
  chmodSync(join(shimDir, 'npm'), 0o755);
  chmodSync(join(shimDir, 'pi'), 0o755);

  const savedPath = Bun.env['PATH'];
  const savedKey = Bun.env['QUORUM_PI_TEST_KEY'];
  Bun.env['PATH'] = `${shimDir}:${savedPath ?? ''}`;
  Bun.env['QUORUM_PI_TEST_KEY'] = 'offline-pi-key';
  try {
    const { runScenario } = await import('../src/runner/index.ts');
    const result = await runScenario({
      scenarioDir: args.scenarioDir,
      codingAgent: 'pi',
      codingAgentsDir: resolve(import.meta.dir, '../coding-agents'),
      credential: 'test_subject',
      credentialsPath,
      outRoot: join(args.runDir, 'out'),
      gauntletBin: args.gauntletBin,
      superpowers: { mode: 'none' },
      onRunDir(runDir) {
        const raw = readFileSync(
          join(import.meta.dir, 'fixtures/pi-session.slice.jsonl'),
          'utf8',
        );
        const [header, ...rows] = raw.trimEnd().split('\n');
        const session = JSON.parse(header as string);
        session.cwd = join(runDir, 'coding-agent-workdir');
        writeFileSync(
          sessionFixture,
          `${[JSON.stringify(session), ...rows].join('\n')}\n`,
        );
      },
    });
    expect(result.verdict.error).toBeNull();
    expect(result.verdict.conversation?.status).toBe('completed');
    expect(
      existsSync(join(result.runDir, 'evidence/native/native/session.jsonl')),
    ).toBe(true);
    expect(
      readFileSync(
        join(result.runDir, 'evidence/output/pi-launch-model.txt'),
        'utf8',
      ).trim(),
    ).toBe('quorum/gpt-5.6-sol');
    const launcherArgs = readFileSync(
      join(result.runDir, 'evidence/output/pi-launch-argv.txt'),
      'utf8',
    )
      .trim()
      .split('\n');
    expect(launcherArgs).toContain('--provider');
    expect(launcherArgs).toContain('--model');
    expect(launcherArgs).not.toContain('--effort');
    expect(launcherArgs).not.toContain('--session-dir');
  } finally {
    if (savedPath === undefined) delete Bun.env['PATH'];
    else Bun.env['PATH'] = savedPath;
    if (savedKey === undefined) delete Bun.env['QUORUM_PI_TEST_KEY'];
    else Bun.env['QUORUM_PI_TEST_KEY'] = savedKey;
  }
}, 10_000);
test('conversation Windows rejection runs no setup or role', async () => {
  const args = setup();
  const agents = join(args.runDir, 'agents');
  mkdirSync(agents);
  writeFileSync(
    join(agents, 'claude.yaml'),
    'name: claude\ndefault_credential: test_subject\nbinary: /usr/bin/true\nnormalizer: claude\nhome_config_subdir: .claude\nsession_log_dir: "${QUORUM_AGENT_HOME}/logs"\nsession_log_glob: "*.jsonl"\nrequired_env: []\nos_support: [linux, windows]\n',
  );
  const credentialsPath = join(args.runDir, 'credentials.yaml');
  writeFileSync(
    credentialsPath,
    'test_subject:\n  model: offline\n  api: anthropic\n  auth: subscription\n  harnesses: [claude]\n',
  );
  const { runScenario } = await import('../src/runner/index.ts');
  const result = await runScenario({
    scenarioDir: args.scenarioDir,
    codingAgent: 'claude',
    codingAgentsDir: agents,
    credentialsPath,
    outRoot: join(args.runDir, 'out'),
    gauntletBin: '/usr/bin/true',
    os: 'windows',
  });
  expect(result.verdict.error?.stage).toBe('setup');
  expect(result.verdict.final_reason).toContain(
    'conversation mode supports only Linux',
  );
  expect(existsSync(join(result.runDir, 'coding-agent-workdir'))).toBe(false);
});

test('a check manifest mismatch stops before assessment', async () => {
  const args = setup();
  const v = await runPreparedConversation({
    ...args,
    expectedChecks: { schema_version: 1, entries: [] },
  });
  expect(v.error?.stage).toBe('checks');
  expect(
    readFileSync(join(args.runDir, 'invocations.jsonl'), 'utf8')
      .trim()
      .split('\n'),
  ).toHaveLength(1);
});

test('Codex delivery uses native cwd-bound message evidence', async () => {
  const args = setup('codex');
  const v = await runPreparedConversation({
    ...args,
    codingAgent: 'codex',
    normalizer: 'codex',
  });
  expect(v.final).toBe('fail');
  expect(v.conversation?.endpoint).toBe('delivery');
  expect(existsSync(join(args.runDir, 'evidence/trajectory.json'))).toBe(true);
});

test('Pi delivery retains the real native session only at the launch cwd', async () => {
  const args = setup('pi-correct');
  const verdict = await runPreparedConversation({
    ...args,
    codingAgent: 'pi',
    normalizer: 'pi',
    maxTime: '3s',
  });
  expect(verdict.final).toBe('fail');
  expect(verdict.conversation).toMatchObject({
    status: 'completed',
    endpoint: 'delivery',
  });
  const files: string[] = JSON.parse(
    readFileSync(join(args.runDir, 'evidence/index.json'), 'utf8'),
  ).files;
  expect(files).toContain('native/native.jsonl');
  expect(files).toContain('trajectory.json');
  const trajectory = JSON.parse(
    readFileSync(join(args.runDir, 'evidence/trajectory.json'), 'utf8'),
  );
  expect(trajectory.agent.name).toBe('pi');
  expect(
    trajectory.steps.some(
      (step: { tool_calls?: unknown[] }) => step.tool_calls?.length,
    ),
  ).toBe(true);
});

test('Pi delivery rejects a native session from the wrong cwd before assessment', async () => {
  const args = setup('pi-wrong-cwd');
  const verdict = await runPreparedConversation({
    ...args,
    codingAgent: 'pi',
    normalizer: 'pi',
    maxTime: '3s',
  });
  expect(verdict.error?.stage).toBe('capture');
  expect(verdict.final_reason).toContain(
    'native conversation capture unavailable',
  );
  const files: string[] = JSON.parse(
    readFileSync(join(args.runDir, 'evidence/index.json'), 'utf8'),
  ).files;
  expect(files.some((path) => path.startsWith('native/'))).toBe(false);
  expect(files).not.toContain('trajectory.json');
  expect(
    readFileSync(join(args.runDir, 'invocations.jsonl'), 'utf8')
      .trim()
      .split('\n'),
  ).toHaveLength(1);
});

test('Pi cancellation retains native evidence and confirms private runtime cleanup', async () => {
  const args = setup('pi-cancel');
  const marker = join(args.runDir, 'runtime-pid');
  const verdict = await runPreparedConversation({
    ...args,
    codingAgent: 'pi',
    normalizer: 'pi',
    shouldStop: () => existsSync(marker),
  });
  expect(verdict.error?.stage).toBe('stopped');
  expect(verdict.conversation?.status).toBe('completed');
  expect(existsSync(join(args.runDir, 'evidence/native/native.jsonl'))).toBe(
    true,
  );
  expect(existsSync(join(args.runDir, 'evidence/trajectory.json'))).toBe(true);
  const roles = JSON.parse(
    readFileSync(join(args.runDir, 'gauntlet-roles.json'), 'utf8'),
  );
  expect(roles.conversation.stop_cause).toBe('cancelled');
  expect(roles.conversation.process_exit.signal).toBe('SIGTERM');
  const socket = readFileSync(join(args.runDir, 'runtime-socket'), 'utf8');
  expect(existsSync(socket)).toBe(false);
  const pid = Number(readFileSync(marker, 'utf8'));
  expect(() => process.kill(-pid, 0)).toThrow();
});

test('assessment reads only its allocated result file', async () => {
  const args = setup('missing-result');
  const v = await runPreparedConversation(args);
  expect(v.final).toBe('indeterminate');
  expect(v.gauntlet?.status).toBe('investigate');
  const roles = JSON.parse(
    readFileSync(join(args.runDir, 'gauntlet-roles.json'), 'utf8'),
  );
  expect(v.gauntlet?.run_id).toBe(roles.assessment.out_dir.split('/').at(-1));
  expect(v.gauntlet?.process_exit).toEqual({ code: 0, signal: null });
});

for (const [mode, final, exit] of [
  ['assessed-fail', 'fail', 1],
  ['assessed-investigate', 'indeterminate', 1],
  ['exit-mismatch', 'indeterminate', 1],
] as const)
  test(`${mode} preserves the assessor's semantic exit and independent completion`, async () => {
    const args = setup(mode);
    const verdict = await runPreparedConversation(args);
    expect(verdict.final).toBe(final);
    expect(verdict.conversation?.status).toBe('completed');
    expect(verdict.gauntlet?.process_exit?.code).toBe(exit);
    expect(verdict.error).toEqual(
      mode === 'exit-mismatch'
        ? expect.objectContaining({ stage: 'gauntlet' })
        : null,
    );
  });

test('outer runner exception retains persisted started-role accounting', async () => {
  const args = setup();
  const { runScenario } = await import('../src/runner/index.ts');
  const result = await runScenario({
    scenarioDir: args.scenarioDir,
    codingAgent: 'claude',
    codingAgentsDir: resolve(import.meta.dir, '../coding-agents'),
    outRoot: join(args.runDir, 'outer-error'),
    onRunDir(runDir) {
      const record = {
        out_dir: 'conversation-agent/observed',
        model: 'claude-sonnet-4-6',
        started_at: '2026-09-07T00:00:00Z',
        finished_at: null,
        process_exit: null,
        stop_cause: null,
      };
      writeFileSync(
        join(runDir, 'gauntlet-roles.json'),
        JSON.stringify({
          conversation: record,
          assessment: {
            ...record,
            out_dir: 'gauntlet-agent/results/allocated',
            started_at: null,
          },
        }),
      );
    },
    onCredentialLabels() {
      throw new Error('escaped finalization error');
    },
  });
  expect(result.verdict.error?.message).toBe('escaped finalization error');
  expect(result.verdict.economics?.['partial']).toBe(true);
  expect(result.verdict.economics?.['gauntlet']).toMatchObject({
    roles: {
      conversation: { status: 'started', usage: null },
      assessment: { status: 'not_run' },
    },
  });
});

for (const mode of [
  'normal',
  'cancel',
  'error',
  'fallback-write',
  'fallback-rename',
] as const)
  test(`completion persistence survives later storage faults: ${mode}`, async () => {
    const args = setup(mode.startsWith('fallback') ? 'incomplete' : 'refusal');
    const inputPath = join(args.runDir, 'args.json');
    writeFileSync(inputPath, JSON.stringify(args));
    const invalidRecord = '{"prior":"invalid record"}';
    if (mode.startsWith('fallback'))
      writeFileSync(join(args.runDir, 'conversation.json'), invalidRecord);
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, 'fixtures/conversation-write-failure.ts'),
        inputPath,
        mode,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe('');
    expect(exit).toBe(0);
    const result = JSON.parse(stdout);
    if (mode.startsWith('fallback')) {
      expect(result.faultCount).toBeGreaterThan(0);
      expect(result.durableBytes).toBe(invalidRecord);
      expect(
        result.rootFiles.filter((file: string) => file.endsWith('.tmp')),
      ).toEqual([]);
    } else {
      expect(result.escaped).toBeNull();
      expect(JSON.parse(result.durableBytes).status).toBe('completed');
      expect(result.durableBytes).toBe(result.observedCompletion);
      expect(result.verdict.conversation.status).toBe('completed');
      expect(result.verdict.error?.stage ?? null).toBe(
        mode === 'cancel' ? 'stopped' : mode === 'error' ? 'capture' : null,
      );
      if (mode === 'error') expect(result.faultCount).toBeGreaterThan(0);
    }
  });
