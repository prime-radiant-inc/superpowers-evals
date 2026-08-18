import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { envSnapshot } from '../src/env.ts';
import {
  GAUNTLET_ENV_ALLOWLIST,
  gauntletEnvBase,
} from '../src/runner/gauntlet-env.ts';
import {
  invokeGauntlet,
  kimiLaunchSubstitutions,
  runScenario,
  runtimeCleanupDirs,
} from '../src/runner/index.ts';
import { mockGauntletDir } from './mock-gauntlet/shim.ts';

// --- pure projection --------------------------------------------------------

test('gauntletEnvBase drops the provider bundle and keeps the grader credential', () => {
  const hostile: Record<string, string> = {
    OPENAI_API_KEY: 'sk-host-openai',
    OPENAI_BASE_URL: 'http://evil.example',
    GEMINI_API_KEY: 'sk-host-gemini',
    KIMI_MODEL_API_KEY: 'sk-host-kimi',
    AWS_SECRET_ACCESS_KEY: 'host-aws',
    AWS_BEARER_TOKEN_BEDROCK: 'host-bedrock',
    GH_TOKEN: 'host-gh',
    ANTHROPIC_API_KEY: 'sk-grader',
    PATH: '/usr/bin:/bin',
    TMUX_TMPDIR: '/tmp/tmux',
  };
  const env = gauntletEnvBase(hostile);
  expect(env['OPENAI_API_KEY']).toBeUndefined();
  expect(env['GEMINI_API_KEY']).toBeUndefined();
  expect(env['KIMI_MODEL_API_KEY']).toBeUndefined();
  expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
  expect(env['AWS_BEARER_TOKEN_BEDROCK']).toBeUndefined();
  expect(env['GH_TOKEN']).toBeUndefined();
  expect(env['OPENAI_BASE_URL']).toBeUndefined();
  expect(env['ANTHROPIC_API_KEY']).toBe('sk-grader');
  expect(env['PATH']).toBe('/usr/bin:/bin');
  expect(env['TMUX_TMPDIR']).toBe('/tmp/tmux');
});

test('GAUNTLET_ENV_ALLOWLIST carries at most the grader credential names', () => {
  // The credential names are enumerated deliberately, never by pattern: exactly
  // the three names gauntlet's Anthropic auth resolution reads
  // (resolveAnthropicAuth: CLAUDE_CODE_OAUTH_TOKEN || ANTHROPIC_AUTH_TOKEN ||
  // ANTHROPIC_API_KEY). Any other secret-shaped name is a leak.
  const secretish = GAUNTLET_ENV_ALLOWLIST.filter((n) =>
    /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(n),
  );
  expect(secretish.sort()).toEqual(
    [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ].sort(),
  );
});

// --- runner wiring (real spawn seam) ----------------------------------------

const MOCK = resolve(import.meta.dir, 'mock-gauntlet');
const REAL_CODING_AGENTS = resolve(import.meta.dir, '..', 'coding-agents');

// Every grader credential name the projection may pass. The wiring tests
// REPLACE all of them with fake values for the duration, so the mock's
// finite-key env capture can never serialize a real host token.
const GRADER_CREDENTIAL_NAMES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const;

function makeScenario(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scn-genv-'));
  writeFileSync(
    join(dir, 'story.md'),
    '---\nquorum_max_time: 1m\n---\nDo the thing.\n',
  );
  writeFileSync(join(dir, 'setup.sh'), '#!/usr/bin/env bash\n:\n');
  chmodSync(join(dir, 'setup.sh'), 0o755);
  writeFileSync(join(dir, 'checks.sh'), 'pre() { :; }\npost() { :; }\n');
  return dir;
}

// Save the named process.env entries, apply `values`, and return a restore
// function for the finally block.
function swapEnv(values: Record<string, string | undefined>): () => void {
  const saved = Object.keys(values).map((k) => [k, process.env[k]] as const);
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  };
}

// Drive the REAL runScenario with the mock gauntlet on PATH and a hostile host
// env, then read back the env the spawned gauntlet child received (the mock's
// opt-in capture serializes ONLY the finite key set baked into the generated
// shim). This exercises the structured spawn seam — spawnGauntlet's env
// composition — not a rendered command line.
test('the spawned gauntlet child gets the projection, not the host env', async () => {
  const scenarioDir = makeScenario();
  const outRoot = mkdtempSync(join(tmpdir(), 'out-genv-'));
  const sproot = mkdtempSync(join(tmpdir(), 'sproot-'));
  const captureKeys = [
    ...GRADER_CREDENTIAL_NAMES,
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'KIMI_MODEL_API_KEY',
    'AWS_BEARER_TOKEN_BEDROCK',
    'QUORUM_AGENT_CWD',
    'QUORUM_AGENT_HOME',
    'MOCK_GAUNTLET_FIXTURE',
  ];
  const shimDir = mockGauntletDir('pass', { captureEnvKeys: captureKeys });
  const restore = swapEnv({
    PATH: `${shimDir}:${MOCK}:${process.env['PATH'] ?? ''}`,
    // ALL grader credential names replaced with fakes: the only secrets that
    // may cross into the child, and the capture must never see a real one.
    ANTHROPIC_API_KEY: 'sk-grader-e2e',
    ANTHROPIC_AUTH_TOKEN: 'fake-grader-oauth-sdk',
    CLAUDE_CODE_OAUTH_TOKEN: 'fake-grader-oauth-cc',
    // The coding agent's own provider credential (claude.yaml's opus_bedrock
    // default resolves it at provision time). It must reach the env FILE the
    // launcher sources — never the gauntlet child env.
    AWS_BEARER_TOKEN_BEDROCK: 'bedrock-key-test',
    SUPERPOWERS_ROOT: sproot,
    // Hostile provider bundle names a full-snapshot spread would leak.
    OPENAI_API_KEY: 'sk-host-openai',
    GEMINI_API_KEY: 'sk-host-gemini',
    KIMI_MODEL_API_KEY: 'sk-host-kimi',
  });
  let runDir: string | undefined;
  try {
    const { verdict } = await runScenario({
      scenarioDir,
      codingAgent: 'claude',
      codingAgentsDir: REAL_CODING_AGENTS,
      outRoot,
      onRunDir: (dir) => {
        runDir = dir;
      },
    });
    expect(verdict.final).toBe('pass');
    if (runDir === undefined) {
      throw new Error('onRunDir never fired');
    }
    const child = JSON.parse(
      readFileSync(join(runDir, 'mock-gauntlet-env.json'), 'utf8'),
    ) as Record<string, string | undefined>;
    // Gauntlet is a Bun executable. It must start inside the fresh run dir so
    // Bun cannot reload an operator checkout's .env after the runner projects
    // the child environment.
    expect(
      realpathSync(
        readFileSync(join(runDir, 'mock-gauntlet-cwd.txt'), 'utf8').trim(),
      ),
    ).toBe(realpathSync(runDir));
    // Hostile provider bundle: absent.
    expect(child['OPENAI_API_KEY']).toBeUndefined();
    expect(child['GEMINI_API_KEY']).toBeUndefined();
    expect(child['KIMI_MODEL_API_KEY']).toBeUndefined();
    // The coding agent's own provider credential: absent from the child env.
    expect(child['AWS_BEARER_TOKEN_BEDROCK']).toBeUndefined();
    // The grader credential names arrive — with exactly the fake values.
    expect(child['ANTHROPIC_API_KEY']).toBe('sk-grader-e2e');
    expect(child['ANTHROPIC_AUTH_TOKEN']).toBe('fake-grader-oauth-sdk');
    expect(child['CLAUDE_CODE_OAUTH_TOKEN']).toBe('fake-grader-oauth-cc');
    // The runner's quorum-owned overlays survive the projection.
    expect(child['QUORUM_AGENT_CWD']).toBeDefined();
    expect(child['QUORUM_AGENT_HOME']).toBeDefined();
    // The fixture selection rode in via the generated shim, not the host env.
    expect(child['MOCK_GAUNTLET_FIXTURE']).toBe('pass');
    // The capture is the finite key set only — never a full env dump.
    for (const key of Object.keys(child)) {
      expect(captureKeys).toContain(key);
    }
  } finally {
    restore();
    for (const dir of [shimDir, outRoot, scenarioDir, sproot]) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// Same wiring proof for copilot's stricter projection (F13 final fix,
// IMPORTANT 2): the REAL runScenario spawns the mock gauntlet for a copilot
// run; the child env must carry the three fake grader auth names + the base
// url, and never the OpenAI block or copilot's own GitHub token (env-file-
// only). All secrets are fakes — no real credential can reach the capture.
test('the copilot gauntlet child gets the grader contract, not the OpenAI block', async () => {
  const scenarioDir = makeScenario();
  const outRoot = mkdtempSync(join(tmpdir(), 'out-genv-'));
  const sproot = mkdtempSync(join(tmpdir(), 'sproot-'));
  // The copilot plugin files provisioning stages + verifies.
  for (const rel of [
    '.claude-plugin/plugin.json',
    'hooks/hooks.json',
    'hooks/run-hook.cmd',
    'hooks/session-start',
    'skills/using-superpowers/SKILL.md',
    'skills/brainstorming/SKILL.md',
  ]) {
    const path = join(sproot, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'x\n');
  }
  // A fake copilot binary so the provisioning PATH guard passes (it is never
  // launched: the mock gauntlet drops canned artifacts instead of driving it).
  const binDir = mkdtempSync(join(tmpdir(), 'bin-genv-'));
  const fakeCopilot = join(binDir, 'copilot');
  writeFileSync(fakeCopilot, '#!/bin/sh\nexit 0\n');
  chmodSync(fakeCopilot, 0o755);
  const captureKeys = [
    ...GRADER_CREDENTIAL_NAMES,
    'ANTHROPIC_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_ORG_ID',
    'COPILOT_GITHUB_TOKEN',
    'GH_TOKEN',
    'QUORUM_AGENT_CWD',
    'QUORUM_AGENT_HOME',
  ];
  const shimDir = mockGauntletDir('pass', { captureEnvKeys: captureKeys });
  const restore = swapEnv({
    PATH: `${shimDir}:${binDir}:${MOCK}:${process.env['PATH'] ?? ''}`,
    // ALL grader credential names replaced with fakes, plus a fake gateway
    // base url that must ride along with them.
    ANTHROPIC_API_KEY: 'sk-grader-e2e',
    ANTHROPIC_AUTH_TOKEN: 'fake-grader-oauth-sdk',
    CLAUDE_CODE_OAUTH_TOKEN: 'fake-grader-oauth-cc',
    ANTHROPIC_BASE_URL: 'https://gateway.example/v1',
    SUPERPOWERS_ROOT: sproot,
    // Copilot's own auth: a fake GitHub token that must stay env-file-only.
    COPILOT_GITHUB_TOKEN: 'ghp-fake-copilot-auth',
    GH_TOKEN: 'gho-fake-fallback',
    // The hostile unrelated provider block the old allowlist forwarded.
    OPENAI_API_KEY: 'sk-host-openai',
    OPENAI_BASE_URL: 'http://evil-openai.example',
    OPENAI_ORG_ID: 'evil-org',
  });
  let runDir: string | undefined;
  try {
    await runScenario({
      scenarioDir,
      codingAgent: 'copilot',
      codingAgentsDir: REAL_CODING_AGENTS,
      outRoot,
      onRunDir: (dir) => {
        runDir = dir;
      },
    });
    if (runDir === undefined) {
      throw new Error('onRunDir never fired');
    }
    const child = JSON.parse(
      readFileSync(join(runDir, 'mock-gauntlet-env.json'), 'utf8'),
    ) as Record<string, string | undefined>;
    // The full grader contract arrives — with exactly the fake values.
    expect(child['ANTHROPIC_API_KEY']).toBe('sk-grader-e2e');
    expect(child['ANTHROPIC_AUTH_TOKEN']).toBe('fake-grader-oauth-sdk');
    expect(child['CLAUDE_CODE_OAUTH_TOKEN']).toBe('fake-grader-oauth-cc');
    expect(child['ANTHROPIC_BASE_URL']).toBe('https://gateway.example/v1');
    // The unrelated OpenAI block and copilot's own secrets: absent.
    expect(child['OPENAI_API_KEY']).toBeUndefined();
    expect(child['OPENAI_BASE_URL']).toBeUndefined();
    expect(child['OPENAI_ORG_ID']).toBeUndefined();
    expect(child['COPILOT_GITHUB_TOKEN']).toBeUndefined();
    expect(child['GH_TOKEN']).toBeUndefined();
    // The quorum-owned overlays survive the projection.
    expect(child['QUORUM_AGENT_CWD']).toBeDefined();
    expect(child['QUORUM_AGENT_HOME']).toBeDefined();
  } finally {
    restore();
    for (const dir of [shimDir, binDir, outRoot, scenarioDir, sproot]) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// F13 corrective round (provenance defect): a whole runScenario whose
// provisioning fails before the Coding-Agent became runnable — here the
// missing nested Antigravity runtime token — must (a) still compose the
// expected setup-stage indeterminate verdict, (b) run ZERO agy invocations,
// including the post-failure `agy --version` provenance probe, and (c) keep
// the non-agent provenance (git rev, gauntlet version) running under
// run-local HOME/XDG routing — never the operator's home. Fakes only: no
// real agy, no auth, no network.
test('missing antigravity token: setup stays indeterminate, zero agy calls, version children run-local', async () => {
  const scenarioDir = makeScenario();
  const outRoot = mkdtempSync(join(tmpdir(), 'out-genv-'));
  const sproot = mkdtempSync(join(tmpdir(), 'sproot-'));
  // A fake agy that RECORDS every invocation (including --version) — the
  // regression's core assertion is that this log stays empty.
  const binDir = mkdtempSync(join(tmpdir(), 'bin-genv-'));
  const agyLog = join(binDir, 'agy-invocations.log');
  const fakeAgy = join(binDir, 'agy');
  writeFileSync(
    fakeAgy,
    `#!/bin/sh\necho "agy $@" >> '${agyLog}'\necho "agy FAKE 1.2.3"\n`,
  );
  chmodSync(fakeAgy, 0o755);
  // A fake gauntlet that dumps its env + prints a version: the gauntlet
  // --version probe still runs on a setup-failed run, and its child env
  // proves the run-local routing (and the operator sentinels' absence).
  const gauntletDump = join(binDir, 'gauntlet-version-env.txt');
  const fakeGauntlet = join(binDir, 'gauntlet');
  writeFileSync(
    fakeGauntlet,
    `#!/bin/sh\nenv > '${gauntletDump}'\necho "gauntlet FAKE 9.9.9"\n`,
  );
  chmodSync(fakeGauntlet, 0o755);
  // AGY_OAUTH_HOME with NO nested runtime token -> seedAgyRuntimeToken fails
  // -> ProvisionError BEFORE any agy subprocess.
  const emptyOauthHome = mkdtempSync(join(tmpdir(), 'agy-oauth-empty-'));
  const restore = swapEnv({
    PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
    AGY_OAUTH_HOME: emptyOauthHome,
    SUPERPOWERS_ROOT: sproot,
    // Operator home/config sentinels: must never reach a version child.
    HOME: '/operator-sentinel-home',
    XDG_CONFIG_HOME: '/operator-sentinel-xdg',
  });
  let runDir: string | undefined;
  try {
    const { verdict } = await runScenario({
      scenarioDir,
      codingAgent: 'antigravity',
      codingAgentsDir: REAL_CODING_AGENTS,
      outRoot,
      onRunDir: (dir) => {
        runDir = dir;
      },
    });
    if (runDir === undefined) {
      throw new Error('onRunDir never fired');
    }
    // (a) The final state remains the expected setup-stage indeterminate —
    // the missing-token fix from the prior wave is unchanged.
    expect(verdict.final).toBe('indeterminate');
    expect(verdict.error?.stage).toBe('setup');
    expect(verdict.final_reason).toContain('antigravity-oauth-token');
    // (b) ZERO agy invocations — provisioning never ran one, and the
    // post-failure provenance probe SKIPPED the agent version child.
    const agyCalls = existsSync(agyLog)
      ? readFileSync(agyLog, 'utf8')
          .split('\n')
          .filter((l) => l !== '')
      : [];
    expect(agyCalls).toEqual([]);
    // (c) Non-agent provenance preserved: the git rev probe still resolved,
    // the agent version is null (skipped), and the gauntlet version child
    // ran under run-local routing.
    expect(verdict.provenance?.harness_rev).toBeTruthy();
    expect(verdict.provenance?.agent_cli_version).toBe(null);
    expect(verdict.provenance?.gauntlet_version).toBe('gauntlet FAKE 9.9.9');
    const dumped: Record<string, string> = {};
    for (const line of readFileSync(gauntletDump, 'utf8').split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) dumped[line.slice(0, eq)] = line.slice(eq + 1);
    }
    expect(dumped['HOME']).toBe(join(runDir, 'home'));
    expect(dumped['XDG_CONFIG_HOME']).toBe(join(runDir, 'home', '.config'));
    expect(dumped['HOME']).not.toContain('operator-sentinel');
    expect(dumped['XDG_CONFIG_HOME']).not.toContain('operator-sentinel');
  } finally {
    restore();
    for (const dir of [binDir, outRoot, scenarioDir, sproot, emptyOauthHome]) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// The spawn seam must have NO adapter extraEnv channel into the child: a
// kimi-shaped provision map is consumed pre-spawn (runtime cleanup dirs +
// launcher substitutions) and, even when passed alongside the invoke args, its
// names never enter the spawned gauntlet child.
test('adapter provision env is consumed pre-spawn and cannot enter the gauntlet child', async () => {
  const provisionMap = {
    KIMI_ENV_FILE: '/tmp/kimi-secret-dir/kimi-runtime.env',
    KIMI_BINARY: '/opt/kimi/bin/kimi',
  };
  // The two real pre-spawn consumers: the env-file parent dir is reaped, and
  // both values become launcher SUBSTITUTIONS (baked into the launcher file).
  expect(runtimeCleanupDirs(provisionMap)).toEqual(['/tmp/kimi-secret-dir']);
  expect(kimiLaunchSubstitutions(provisionMap)).toEqual({
    $KIMI_ENV_FILE: '/tmp/kimi-secret-dir/kimi-runtime.env',
    $KIMI_BINARY: "'/opt/kimi/bin/kimi'",
  });

  const runDir = mkdtempSync(join(tmpdir(), 'run-genv-'));
  const home = mkdtempSync(join(tmpdir(), 'home-genv-'));
  const cwd = mkdtempSync(join(tmpdir(), 'cwd-genv-'));
  const captureKeys = [
    'KIMI_ENV_FILE',
    'KIMI_BINARY',
    'QUORUM_AGENT_CWD',
    'QUORUM_AGENT_HOME',
  ];
  const shimDir = mockGauntletDir('pass', { captureEnvKeys: captureKeys });
  const restore = swapEnv({
    PATH: `${shimDir}:${process.env['PATH'] ?? ''}`,
    // Even a hostile HOST export of an adapter env-file name is blocked by the
    // projection (not on the allowlist).
    KIMI_ENV_FILE: '/host/hostile-kimi.env',
  });
  try {
    // Excess properties (the old extraEnv channel) ride a variable, not an
    // object literal, so this compiles against the extraEnv-free interface —
    // and the child must still never see them.
    const args = {
      storyPath: join(runDir, 'story.md'),
      targetBinary: 'noop-target',
      runDir,
      launchCwd: cwd,
      runHomeDir: home,
      envBase: gauntletEnvBase(envSnapshot()),
      extraEnv: provisionMap,
    };
    const { gauntlet } = await invokeGauntlet(args);
    expect(gauntlet.status).toBe('pass');
    const child = JSON.parse(
      readFileSync(join(runDir, 'mock-gauntlet-env.json'), 'utf8'),
    ) as Record<string, string | undefined>;
    expect(child['KIMI_ENV_FILE']).toBeUndefined();
    expect(child['KIMI_BINARY']).toBeUndefined();
    // The quorum-owned overlays are applied AFTER the base, so nothing can
    // override them.
    expect(child['QUORUM_AGENT_CWD']).toBe(cwd);
    expect(child['QUORUM_AGENT_HOME']).toBe(home);
  } finally {
    restore();
    for (const dir of [shimDir, runDir, home, cwd]) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
