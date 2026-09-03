import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { extractManifest, writeManifest } from '../src/check/manifest.ts';
import {
  allocateRunDir,
  buildGauntletArgv,
  contextDirName,
  runScenario,
} from '../src/runner/index.ts';
import { mockGauntletDir } from './mock-gauntlet/shim.ts';

test('allocateRunDir names <scenario>-<agent>-<credential>-<os>-<stamp>-<nonce> and creates it', () => {
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  const dir = allocateRunDir(
    out,
    '00-quorum-smoke-hello-world',
    'claude',
    'sonnet',
  );
  expect(basename(dir)).toMatch(
    /^00-quorum-smoke-hello-world-claude-sonnet-linux-\d{8}T\d{6}Z-[0-9a-f]{4}$/,
  );
  expect(existsSync(dir)).toBe(true);
});

test('allocateRunDir with os=windows id contains -claude-sonnet-windows-', () => {
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  const dir = allocateRunDir(out, 'sc', 'claude', 'sonnet', 'windows');
  expect(basename(dir)).toMatch(
    /^sc-claude-sonnet-windows-\d{8}T\d{6}Z-[0-9a-f]{4}$/,
  );
});

test('allocateRunDir is unique across calls (distinct nonces)', () => {
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  const a = allocateRunDir(out, 'scn', 'codex', 'none');
  const b = allocateRunDir(out, 'scn', 'codex', 'none');
  expect(a).not.toBe(b);
});

test('contextDirName: linux (default) returns the family context dir', () => {
  expect(contextDirName({ name: 'claude', runtime_family: 'claude' })).toBe(
    'claude',
  );
});

test('contextDirName(cfg, os): linux returns runtime_family', () => {
  expect(
    contextDirName({ name: 'claude', runtime_family: 'claude' }, 'linux'),
  ).toBe('claude');
});

test('contextDirName(cfg, os): windows returns runtime_family-windows', () => {
  expect(
    contextDirName({ name: 'claude', runtime_family: 'claude' }, 'windows'),
  ).toBe('claude-windows');
});

test('buildGauntletArgv is exact and order-stable with all optional flags', () => {
  const argv = buildGauntletArgv({
    storyPath: '/s/story.md',
    targetBinary: 'claude',
    runDir: '/r',
    maxTime: '10m',
    projectPrompt: '/r/p.md',
  });
  expect(argv).toEqual([
    'run',
    '/s/story.md',
    '--adapter',
    'tui',
    '--target',
    'claude',
    '--project-dir',
    '/r',
    '--state-dir',
    'gauntlet-agent',
    '--silent',
    '--model',
    'agent=claude-sonnet-5',
    '--max-time',
    '10m',
    '--project-prompt',
    '/r/p.md',
  ]);
});

test('buildGauntletArgv omits optional flags when absent', () => {
  const argv = buildGauntletArgv({
    storyPath: '/s/story.md',
    targetBinary: 'codex',
    runDir: '/r',
  });
  expect(argv).toEqual([
    'run',
    '/s/story.md',
    '--adapter',
    'tui',
    '--target',
    'codex',
    '--project-dir',
    '/r',
    '--state-dir',
    'gauntlet-agent',
    '--silent',
    '--model',
    'agent=claude-sonnet-5',
  ]);
});

test('buildGauntletArgv appends only --max-time when projectPrompt is absent', () => {
  const argv = buildGauntletArgv({
    storyPath: '/s/story.md',
    targetBinary: 'claude',
    runDir: '/r',
    maxTime: '5m',
  });
  expect(argv).toEqual([
    'run',
    '/s/story.md',
    '--adapter',
    'tui',
    '--target',
    'claude',
    '--project-dir',
    '/r',
    '--state-dir',
    'gauntlet-agent',
    '--silent',
    '--model',
    'agent=claude-sonnet-5',
    '--max-time',
    '5m',
  ]);
});

test('buildGauntletArgv honors an explicit graderModel override', () => {
  const argv = buildGauntletArgv({
    storyPath: '/s/story.md',
    targetBinary: 'claude',
    runDir: '/r',
    graderModel: 'claude-sonnet-4-6',
  });
  // The grader model is the only thing that changes; everything else is stable.
  expect(argv).toEqual([
    'run',
    '/s/story.md',
    '--adapter',
    'tui',
    '--target',
    'claude',
    '--project-dir',
    '/r',
    '--state-dir',
    'gauntlet-agent',
    '--silent',
    '--model',
    'agent=claude-sonnet-4-6',
  ]);
});

// --- expected-check manifest wiring ----------------------------------------
//
// The runner must load the scenario's committed checks-manifest.json and
// thread it into verdict composition, so a run whose emitted post-check
// records drift from the committed manifest composes indeterminate — never a
// pass with fewer checks. The harness mirrors test/runner-e2e.test.ts: the
// mock-gauntlet dir first on PATH drives the whole runScenario pipeline for
// $0, and its `pass` fixture yields a gauntlet pass plus a non-empty claude
// session capture, so the run reaches the final compose site.
const MOCK_GAUNTLET_DIR = resolve(import.meta.dir, 'mock-gauntlet');
const REAL_CODING_AGENTS = resolve(import.meta.dir, '..', 'coding-agents');

// A scenario whose committed manifest expects one more post check than
// checks.sh emits. The manifest is generated from the FULL two-check checks.sh
// via the real extractor/writer (the exact `quorum check` generation path),
// then checks.sh is rewritten without the second check — a check vanished
// after the manifest was frozen, the canonical drift this hardening targets.
function makeManifestScenario(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scn-manifest-'));
  writeFileSync(
    join(dir, 'story.md'),
    '---\nquorum_max_time: 1m\n---\nDo the thing.\n',
  );
  // setup.sh seeds the file the SURVIVING post check asserts, so the only
  // manifest/records discrepancy is the vanished entry.
  writeFileSync(
    join(dir, 'setup.sh'),
    '#!/usr/bin/env bash\nprintf x > present.txt\n',
  );
  chmodSync(join(dir, 'setup.sh'), 0o755);
  writeFileSync(
    join(dir, 'checks.sh'),
    'pre() {\n    :\n}\n\npost() {\n    file-exists present.txt\n    file-exists vanished.txt\n}\n',
  );
  writeManifest(dir, extractManifest(join(dir, 'checks.sh')));
  writeFileSync(
    join(dir, 'checks.sh'),
    'pre() {\n    :\n}\n\npost() {\n    file-exists present.txt\n}\n',
  );
  return dir;
}

// Drive runScenario with the mock-gauntlet shim first on PATH and the named
// fixture selected, restoring every mutated env var afterwards (even on
// throw). Uses the REAL coding-agents/ dir (same rationale as
// test/runner-e2e.test.ts): the claude run requires HOWTO + launcher +
// project-prompt + SUPERPOWERS_ROOT substitution, all present there.
async function runWithMockGauntlet(
  scenarioDir: string,
  fixture: string,
  gauntletBin?: string,
): Promise<Awaited<ReturnType<typeof runScenario>>> {
  const outRoot = mkdtempSync(join(tmpdir(), 'out-'));
  const keys = [
    'PATH',
    'ANTHROPIC_API_KEY',
    'AWS_BEARER_TOKEN_BEDROCK',
    'SUPERPOWERS_ROOT',
  ] as const;
  const saved = keys.map((k) => [k, process.env[k]] as const);
  process.env['PATH'] =
    `${mockGauntletDir(fixture)}:${MOCK_GAUNTLET_DIR}:${process.env['PATH'] ?? ''}`;
  process.env['ANTHROPIC_API_KEY'] = 'sk-test';
  process.env['AWS_BEARER_TOKEN_BEDROCK'] = 'bedrock-key-test';
  process.env['SUPERPOWERS_ROOT'] = mkdtempSync(join(tmpdir(), 'sproot-'));
  try {
    return await runScenario({
      scenarioDir,
      codingAgent: 'claude',
      codingAgentsDir: REAL_CODING_AGENTS,
      outRoot,
      gauntletBin,
    });
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

test('runner enables a scenario-installed input guard at the grader boundary', async () => {
  const scenario = makeManifestScenario();
  writeFileSync(
    join(scenario, 'setup.sh'),
    `#!/usr/bin/env bash
set -euo pipefail
printf x > present.txt
capture_run_dir="$(dirname "$QUORUM_WORKDIR")"
mkdir -p "$capture_run_dir/gauntlet-agent"
cat > "$capture_run_dir/gauntlet-agent/tui-input-guard" <<'GUARD'
#!/bin/sh
touch "$(dirname "$0")/input-captured"
GUARD
chmod 700 "$capture_run_dir/gauntlet-agent/tui-input-guard"
`,
  );
  const fake = join(mkdtempSync(join(tmpdir(), 'guard-grader-')), 'gauntlet');
  writeFileSync(
    fake,
    `#!/usr/bin/env bash
export MOCK_GAUNTLET_FIXTURE=pass
exec bun '${join(MOCK_GAUNTLET_DIR, 'input-guard.ts')}' "$@"
`,
    { mode: 0o755 },
  );
  const { runDir } = await runWithMockGauntlet(scenario, 'pass', fake);
  expect(existsSync(join(runDir, 'gauntlet-agent', 'input-captured'))).toBe(
    true,
  );
}, 30_000);

test('campaign attempt execution routes agent and provenance home outside staging', async () => {
  const fx = makeFakeBinFixture();
  const scenarioDir = mkdtempSync(join(tmpdir(), 'scn-attempt-home-'));
  writeFileSync(
    join(scenarioDir, 'story.md'),
    '---\nquorum_max_time: 1m\n---\nDo the thing.\n',
  );
  writeFileSync(join(scenarioDir, 'setup.sh'), '#!/usr/bin/env bash\n:\n');
  chmodSync(join(scenarioDir, 'setup.sh'), 0o755);
  writeFileSync(
    join(scenarioDir, 'checks.sh'),
    'pre() { :; }\npost() { :; }\n',
  );
  const attemptDir = mkdtempSync(join(tmpdir(), 'attempt-home-'));
  const outRoot = join(attemptDir, 'staging');
  const shimDir = mockGauntletDir('pass');
  const saved = ['PATH', 'SUPERPOWERS_ROOT', 'AWS_BEARER_TOKEN_BEDROCK'].map(
    (k) => [k, process.env[k]] as const,
  );
  process.env['PATH'] =
    `${shimDir}:${MOCK_GAUNTLET_DIR}:${process.env['PATH'] ?? ''}`;
  process.env['SUPERPOWERS_ROOT'] = mkdtempSync(join(tmpdir(), 'sproot-'));
  process.env['AWS_BEARER_TOKEN_BEDROCK'] = 'bedrock-key-test';
  try {
    const { runDir, verdict } = await runScenario({
      scenarioDir,
      codingAgent: 'claude',
      codingAgentsDir: fx.agentsDir,
      outRoot,
      campaign: {
        campaign_id: 'c'.repeat(64),
        comparison_id: 'c1',
        block_id: 'c1:scn-a:b1',
        sample_id: 'c1:scn-a:arm_a:r1',
        execution_attempt_id: 'c1:scn-a:arm_a:r1:a1',
      },
      campaignAttemptDir: attemptDir,
    });
    expect(verdict.final).toBe('pass');
    const calls = parseInvocationLog(fx.logPath).filter((call) =>
      call.header.startsWith('FAKECLAUDE'),
    );
    expect(calls).toHaveLength(2);
    const provenanceCall = calls.at(-1);
    if (provenanceCall === undefined) {
      throw new Error('provenance probe invocation missing from log');
    }
    expect(provenanceCall.env['HOME']).toBe(join(attemptDir, 'home'));
    expect(provenanceCall.env['XDG_CONFIG_HOME']).toBe(
      join(attemptDir, 'home', '.config'),
    );
    // The gauntlet session output proves the launch path used the attempt
    // home; checks may create a staging-local HOME, but never this log.
    expect(
      existsSync(
        join(
          attemptDir,
          'home',
          '.claude',
          'projects',
          'mock',
          'mock_pass_0000.jsonl',
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(runDir, '.claude', 'projects', 'mock', 'mock_pass_0000.jsonl'),
      ),
    ).toBe(false);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fx.cleanup();
  }
}, 60_000);

test('runner loads the scenario manifest and passes it to compose', async () => {
  const { verdict } = await runWithMockGauntlet(makeManifestScenario(), 'pass');
  // A vanished post-check record must not let a gauntlet pass compose pass.
  expect(verdict.final).toBe('indeterminate');
  expect(verdict.error?.stage).toBe('checks');
  expect(verdict.final_reason).toContain('manifest');
  // The mismatch is the vanished entry itself, not an unrelated gate.
  expect(verdict.final_reason).toContain('vanished.txt');
});

// A committed-but-unparseable manifest is repository misconfiguration: it
// must triage as a setup-stage indeterminate — distinct from a runtime
// record mismatch, which the composer correctly keeps checks-stage.
function makeMalformedManifestScenario(): string {
  const dir = mkdtempSync(join(tmpdir(), 'scn-manifest-bad-'));
  writeFileSync(
    join(dir, 'story.md'),
    '---\nquorum_max_time: 1m\n---\nDo the thing.\n',
  );
  writeFileSync(join(dir, 'setup.sh'), '#!/usr/bin/env bash\n:\n');
  chmodSync(join(dir, 'setup.sh'), 0o755);
  writeFileSync(
    join(dir, 'checks.sh'),
    'pre() {\n    :\n}\n\npost() {\n    :\n}\n',
  );
  writeFileSync(join(dir, 'checks-manifest.json'), '{ this is not json');
  return dir;
}

test('runner stages an unparseable checks-manifest.json as a setup error', async () => {
  const { verdict } = await runWithMockGauntlet(
    makeMalformedManifestScenario(),
    'pass',
  );
  // The load fails before gauntlet ever spawns; the verdict must carry the
  // setup stage and name the offending file for triage.
  expect(verdict.final).toBe('indeterminate');
  expect(verdict.error?.stage).toBe('setup');
  expect(verdict.final_reason).toContain('checks-manifest.json');
});

// ---------------------------------------------------------------------------
// F13 micro corrective round 2: the post-run provenance stamp must NEVER
// reload the agent config. loadAgentConfig is side-effectful — its
// pin_cli_version enforcement spawns `<binary> --version` with the AMBIENT
// env — so the old provenance-time reload re-invoked the agent binary after
// a setup failure (where the probe result was then discarded anyway:
// agent_cli_version composed null) while handing that child the operator's
// HOME and provider/AWS bundle. The binary must come from the config the run
// itself already loaded, and no post-failure agent invocation may occur
// through pin enforcement or collectProvenance.
// ---------------------------------------------------------------------------

import { cpSync, readFileSync, rmSync } from 'node:fs';

// A copy of the real coding-agents dir with claude.yaml pointed at a fake
// absolute-path binary + `pin_cli_version: FAKEPIN` — the supported config
// contract under test, exercised via a throwaway copy so no committed YAML
// changes. The ABSOLUTE path matters: the pin probe spawns the binary with
// NO env option, and Bun's no-env spawnSync resolves bare names through the
// STARTUP PATH (ignoring in-test PATH mutations), so only an absolute path
// reliably routes the pin probe to the fake — which is exactly the seam the
// defect lives on.
function makePinnedAgentsDir(fakeClaudePath: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'agents-pin-'));
  cpSync(REAL_CODING_AGENTS, dir, { recursive: true });
  const yamlPath = join(dir, 'claude.yaml');
  const raw = readFileSync(yamlPath, 'utf8');
  writeFileSync(
    yamlPath,
    `${raw.replace(/^binary: claude$/m, `binary: ${fakeClaudePath}`).trimEnd()}
pin_cli_version: FAKEPIN
`,
  );
  return dir;
}

// Fake `claude` + `gauntlet` binaries that log every invocation (args + full
// child env) to one shared log, so tests can (a) count invocations, (b) read
// each child's env, and (c) place a setup-failure marker in call order. All
// "versions" are fakes; no real CLI, auth, or network is touched.
interface FakeBinFixture {
  binDir: string;
  agentsDir: string;
  logPath: string;
  cleanup: () => void;
}

// Single-quote a value for embedding in the generated /bin/sh script.
function shSingleQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function makeFakeBinFixture(): FakeBinFixture {
  const binDir = mkdtempSync(join(tmpdir(), 'bin-pin-'));
  const logPath = join(binDir, 'invocations.log');
  // F13 micro corrective round 3: the recorder is FINITE and NON-SECRET — it
  // never serializes the environment. Per invocation it writes: the header
  // line (call ordering / marker semantics), then, for the two routing
  // names, the VALUE only when it is a known-safe test path (under the OS
  // tmpdir — where every run-local home lives — or the routing sentinel
  // constants; anything else, e.g. the operator's real HOME, degrades to a
  // presence boolean), then presence booleans for the secret-shaped names —
  // never values. There is no fallback or full-dump path: the pre-run pin
  // child legitimately inherits real process-start credentials, and this log
  // must stay safe to leave on disk across a crash. Both fakes (agent and
  // gauntlet) are generated from this one recorder.
  const recordEnvLines = (tag: string) => {
    const routingCases = ROUTING_VALUE_NAMES.map(
      (name) =>
        `for name in ${name}; do
` +
        '  eval "value=\\${$name-}"\n' +
        `  case "$value" in
` +
        `    ${shSingleQuote(SAFE_VALUE_ROOT)}*|${KNOWN_SAFE_VALUES_LIST.map(
          (v) => shSingleQuote(v),
        ).join('|')})
` +
        `      echo "  ${tag}-ENV $name=$value" >> '${logPath}' ;;
` +
        `    *)
` +
        `      if [ -n "$value" ]; then
` +
        `        echo "  ${tag}-ENV PRESENT:$name=true" >> '${logPath}'
` +
        `      else
` +
        `        echo "  ${tag}-ENV PRESENT:$name=false" >> '${logPath}'
` +
        `      fi ;;
` +
        `  esac
` +
        `done
`,
    ).join('');
    const presenceCases = SECRET_SHAPED_NAMES.map(
      (name) =>
        `for name in ${name}; do
` +
        '  eval "value=\\${$name-}"\n' +
        `  if [ -n "$value" ]; then
` +
        `    echo "  ${tag}-ENV PRESENT:$name=true" >> '${logPath}'
` +
        `  else
` +
        `    echo "  ${tag}-ENV PRESENT:$name=false" >> '${logPath}'
` +
        `  fi
` +
        `done
`,
    ).join('');
    return routingCases + presenceCases;
  };
  const mk = (name: string, versionLine: string) => {
    const p = join(binDir, name);
    writeFileSync(
      p,
      `#!/bin/sh\n` +
        `echo "${name.toUpperCase()}-INVOCATION $*" >> '${logPath}'\n` +
        recordEnvLines(name.toUpperCase()) +
        `echo "${versionLine}"\n`,
    );
    chmodSync(p, 0o755);
    return p;
  };
  const fakeClaude = mk('fakeclaude', 'claude FAKEPIN 9.9.9');
  mk('gauntlet', 'gauntlet FAKE-G 2.0');
  const agentsDir = makePinnedAgentsDir(fakeClaude);
  return {
    binDir,
    agentsDir,
    logPath,
    cleanup: () => {
      rmSync(binDir, { recursive: true, force: true });
      rmSync(agentsDir, { recursive: true, force: true });
    },
  };
}

// Parse the shared invocation log into sections: each starts at an
// *-INVOCATION line and carries the subsequent *-ENV lines — routing VALUE
// lines (`NAME=<safe path>`, recorded only for safe test paths) and
// `PRESENT:NAME=true|false` presence booleans (the only representation
// secret-shaped names ever get).
function parseInvocationLog(logPath: string): {
  header: string;
  env: Record<string, string>;
  present: Record<string, boolean>;
}[] {
  if (!existsSync(logPath)) return [];
  const sections: {
    header: string;
    env: Record<string, string>;
    present: Record<string, boolean>;
  }[] = [];
  for (const line of readFileSync(logPath, 'utf8').split('\n')) {
    const inv = line.match(/^([A-Z]+)-INVOCATION (.*)$/);
    if (inv !== null) {
      sections.push({ header: `${inv[1]} ${inv[2]}`, env: {}, present: {} });
      continue;
    }
    const valueLine = line.match(
      /^ {2}[A-Z]+-ENV (HOME|XDG_CONFIG_HOME)=(.*)$/,
    );
    const current = sections.at(-1);
    if (
      valueLine?.[1] !== undefined &&
      valueLine[2] !== undefined &&
      current !== undefined
    ) {
      current.env[valueLine[1]] = valueLine[2];
      continue;
    }
    const presentLine = line.match(
      /^ {2}[A-Z]+-ENV PRESENT:([A-Z0-9_]+)=(true|false)$/,
    );
    if (
      presentLine?.[1] !== undefined &&
      presentLine[2] !== undefined &&
      current !== undefined
    ) {
      current.present[presentLine[1]] = presentLine[2] === 'true';
    }
  }
  return sections;
}

// The hostile operator bundle seeded for the regression: HOME/XDG routing
// sentinels plus provider/AWS secrets. All values are fakes.
const OPERATOR_SENTINELS: Record<string, string> = {
  HOME: '/operator-sentinel-home',
  XDG_CONFIG_HOME: '/operator-sentinel-xdg',
  ANTHROPIC_API_KEY: 'sk-host-anthropic',
  AWS_SECRET_ACCESS_KEY: 'host-aws-secret',
};

// F13 micro corrective round 3: the fake binaries' shared invocation log is a
// disk artifact that can outlive a crashed/interrupted test, and the
// legitimate pre-run pin child may inherit REAL process-start credentials —
// so the harness must never serialize a full environment or any secret value.
// The only env lines allowed are (a) HOME/XDG_CONFIG_HOME VALUES when they
// are known-safe test paths (under the OS tmpdir, or the routing sentinel
// constants), and (b) presence booleans for secret-shaped names — never
// values. Every other line must be an invocation header or the setup-failure
// marker; anything else is a full-dump (or value-leak) regression.
const SAFE_VALUE_ROOT = `${tmpdir()}/`;
const KNOWN_SAFE_VALUES: ReadonlySet<string> = new Set([
  '/operator-sentinel-home',
  '/operator-sentinel-xdg',
]);
const KNOWN_SAFE_VALUES_LIST = [...KNOWN_SAFE_VALUES];
const SECRET_SHAPED_NAMES = [
  'ANTHROPIC_API_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_BEARER_TOKEN_BEDROCK',
] as const;
const ROUTING_VALUE_NAMES = ['HOME', 'XDG_CONFIG_HOME'] as const;
// Every fake secret value the tests seed (hostile in-process env or a
// hostile-startup subprocess run): none may appear anywhere in the log.
const SEEDED_SECRET_VALUES = [
  'sk-host-anthropic',
  'host-aws-secret',
  'bedrock-key-test',
] as const;

function assertInvocationLogHygiene(log: string): void {
  const lines = log.split('\n');
  for (const line of lines) {
    if (
      line === '' ||
      line === 'SETUP-FAILED-MARKER' ||
      /^[A-Z]+-INVOCATION /.test(line)
    ) {
      continue;
    }
    // A value line is allowed ONLY for the two routing names, and its value
    // must be a known-safe test path.
    const valueLine = line.match(
      /^ {2}[A-Z]+-ENV (HOME|XDG_CONFIG_HOME)=(.*)$/,
    );
    if (valueLine !== null) {
      const value = valueLine[2] ?? '';
      expect({
        line,
        safe: value.startsWith(SAFE_VALUE_ROOT) || KNOWN_SAFE_VALUES.has(value),
      }).toEqual({ line, safe: true });
      continue;
    }
    // Secret-shaped (and non-safe routing) names appear ONLY as presence
    // booleans.
    const presentLine = line.match(
      /^ {2}[A-Z]+-ENV PRESENT:(HOME|XDG_CONFIG_HOME|[A-Z0-9_]+)=(true|false)$/,
    );
    if (presentLine !== null) {
      continue;
    }
    // Anything else — a PATH=/PWD= line from a full dump, an unknown var, a
    // secret value — fails loudly with the offending line.
    expect({ line, allowed: false }).toEqual({ line, allowed: true });
  }
  // No seeded fake secret value may appear anywhere in the log, pre- or
  // post-marker (presence booleans carry no value by construction).
  for (const secret of SEEDED_SECRET_VALUES) {
    expect({ secret, present: log.includes(secret) }).toEqual({
      secret,
      present: false,
    });
  }
}

// A scenario whose setup.sh FAILS, appending a marker to the shared
// invocation log first so "post-failure" is a concrete position in call order.
function makeSetupFailScenario(logPath: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'scn-setupfail-'));
  writeFileSync(
    join(dir, 'story.md'),
    '---\nquorum_max_time: 1m\n---\nDo the thing.\n',
  );
  writeFileSync(
    join(dir, 'setup.sh'),
    `#!/usr/bin/env bash\necho "SETUP-FAILED-MARKER" >> '${logPath}'\nexit 1\n`,
  );
  chmodSync(join(dir, 'setup.sh'), 0o755);
  writeFileSync(`${dir}/checks.sh`, 'pre() { :; }\npost() { :; }\n');
  return dir;
}

// The pinned-config whole-run regression (F13 micro corrective round 2,
// binding fix 4): after the setup-failure marker there are ZERO agent
// invocations — not through pin enforcement (the provenance-time config
// reload) and not through collectProvenance — and no post-failure child of
// any kind receives the operator HOME/provider/AWS bundle. Non-agent
// provenance (git rev, gauntlet version) is preserved under run-local
// routing, and the final agent_cli_version is null.
test('pinned agent setup failure: zero agent invocations post-failure, no operator bundle in any post-failure child', async () => {
  const fx = makeFakeBinFixture();
  const scenarioDir = makeSetupFailScenario(fx.logPath);
  const outRoot = mkdtempSync(join(tmpdir(), 'out-pin-'));
  const sproot = mkdtempSync(join(tmpdir(), 'sproot-'));
  // The mock-gauntlet shim dir is not needed: setup fails before gauntlet.
  const keys = [
    'PATH',
    'SUPERPOWERS_ROOT',
    'AWS_BEARER_TOKEN_BEDROCK',
    ...Object.keys(OPERATOR_SENTINELS),
  ] as const;
  const saved = keys.map((k) => [k, process.env[k]] as const);
  process.env['PATH'] = `${fx.binDir}:${process.env['PATH'] ?? ''}`;
  process.env['SUPERPOWERS_ROOT'] = sproot;
  process.env['AWS_BEARER_TOKEN_BEDROCK'] = 'bedrock-key-test';
  for (const [k, v] of Object.entries(OPERATOR_SENTINELS)) {
    process.env[k] = v;
  }
  let runDir: string | undefined;
  try {
    const { verdict } = await runScenario({
      scenarioDir,
      codingAgent: 'claude',
      codingAgentsDir: fx.agentsDir,
      outRoot,
      onRunDir: (dir) => {
        runDir = dir;
      },
    });
    if (runDir === undefined) {
      throw new Error('onRunDir never fired');
    }
    expect(verdict.final).toBe('indeterminate');
    expect(verdict.error?.stage).toBe('setup');
    const log = readFileSync(fx.logPath, 'utf8');
    expect(log).toContain('SETUP-FAILED-MARKER');
    const sections = parseInvocationLog(fx.logPath);
    // Precise order check: walk the raw log; after the marker line, no
    // FAKECLAUDE-INVOCATION line may appear (neither pin enforcement from a
    // provenance-time config reload nor the collectProvenance probe).
    const lines = log.split('\n');
    const markerLine = lines.indexOf('SETUP-FAILED-MARKER');
    expect(markerLine).toBeGreaterThanOrEqual(0);
    const claudePostMarker = lines
      .slice(markerLine + 1)
      .filter((l) => l.startsWith('FAKECLAUDE-INVOCATION'));
    expect(claudePostMarker).toEqual([]);
    // No post-marker ENV line (from any child) carries the operator bundle.
    for (const line of lines.slice(markerLine + 1)) {
      if (!line.startsWith('  ')) continue;
      for (const v of Object.values(OPERATOR_SENTINELS)) {
        expect({ line, leaks: line.includes(v) }).toEqual({
          line,
          leaks: false,
        });
      }
    }
    // Final agent_cli_version: null (skipped), while the non-agent
    // provenance is preserved — and the gauntlet --version child ran under
    // run-local routing (run home, not the operator sentinel).
    expect(verdict.provenance?.agent_cli_version).toBe(null);
    expect(verdict.provenance?.harness_rev).toBeTruthy();
    expect(verdict.provenance?.gauntlet_version).toBe('gauntlet FAKE-G 2.0');
    // The log itself is hygienic: no full-environment serialization, no
    // secret values, value lines only for safe test paths.
    assertInvocationLogHygiene(log);
    const gauntletChildren = sections.filter((s) =>
      s.header.startsWith('GAUNTLET'),
    );
    expect(gauntletChildren.length).toBeGreaterThan(0);
    for (const child of gauntletChildren) {
      expect(child.env['HOME']).toBe(join(runDir, 'home'));
      expect(child.env['XDG_CONFIG_HOME']).toBe(
        join(runDir, 'home', '.config'),
      );
      // Secret-shaped names never carry a value; on this run-local child
      // they are not even PRESENT.
      expect(child.env['ANTHROPIC_API_KEY']).toBeUndefined();
      expect(child.env['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
      expect(child.present['ANTHROPIC_API_KEY']).toBe(false);
      expect(child.present['AWS_SECRET_ACCESS_KEY']).toBe(false);
    }
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    fx.cleanup();
    rmSync(scenarioDir, { recursive: true, force: true });
    rmSync(outRoot, { recursive: true, force: true });
    rmSync(sproot, { recursive: true, force: true });
  }
});

// Binding fix 5 (success leg): a pinned-config SUCCESS run still records the
// agent version — exactly one pre-run pin-validation probe (the existing
// config contract) plus exactly one provenance probe, i.e. NO third call from
// a provenance-time config reload — and the provenance probe's child runs
// run-local with no operator bundle.
test('pinned agent success: agent version recorded with exactly pin + provenance probes (no config reload probe)', async () => {
  const fx = makeFakeBinFixture();
  const scenarioDir = mkdtempSync(join(tmpdir(), 'scn-pinok-'));
  writeFileSync(
    join(scenarioDir, 'story.md'),
    '---\nquorum_max_time: 1m\n---\nDo the thing.\n',
  );
  writeFileSync(join(scenarioDir, 'setup.sh'), '#!/usr/bin/env bash\n:\n');
  chmodSync(join(scenarioDir, 'setup.sh'), 0o755);
  writeFileSync(
    join(scenarioDir, 'checks.sh'),
    'pre() { :; }\npost() { :; }\n',
  );
  const outRoot = mkdtempSync(join(tmpdir(), 'out-pin-'));
  const sproot = mkdtempSync(join(tmpdir(), 'sproot-'));
  const shimDir = mockGauntletDir('pass');
  const keys = [
    'PATH',
    'SUPERPOWERS_ROOT',
    'AWS_BEARER_TOKEN_BEDROCK',
    'ANTHROPIC_API_KEY',
    'HOME',
    'XDG_CONFIG_HOME',
    'AWS_SECRET_ACCESS_KEY',
  ] as const;
  const saved = keys.map((k) => [k, process.env[k]] as const);
  process.env['PATH'] = `${shimDir}:${fx.binDir}:${process.env['PATH'] ?? ''}`;
  process.env['SUPERPOWERS_ROOT'] = sproot;
  process.env['AWS_BEARER_TOKEN_BEDROCK'] = 'bedrock-key-test';
  process.env['ANTHROPIC_API_KEY'] = 'sk-host-anthropic';
  process.env['HOME'] = '/operator-sentinel-home';
  process.env['XDG_CONFIG_HOME'] = '/operator-sentinel-xdg';
  process.env['AWS_SECRET_ACCESS_KEY'] = 'host-aws-secret';
  let runDir: string | undefined;
  try {
    const { verdict } = await runScenario({
      scenarioDir,
      codingAgent: 'claude',
      codingAgentsDir: fx.agentsDir,
      outRoot,
      onRunDir: (dir) => {
        runDir = dir;
      },
    });
    if (runDir === undefined) {
      throw new Error('onRunDir never fired');
    }
    expect(verdict.final).toBe('pass');
    expect(verdict.provenance?.agent_cli_version).toBe('claude FAKEPIN 9.9.9');
    // (gauntlet_version is not asserted here: the mock-gauntlet shim on PATH
    // legitimately shadows the fake gauntlet for the run itself.)
    // Exactly ONE pin-validation probe (pre-run, the existing config
    // contract) plus ONE provenance probe. A provenance-time config reload
    // would surface as a third CLAUDE-INVOCATION.
    const claudeCalls = parseInvocationLog(fx.logPath).filter((s) =>
      s.header.startsWith('FAKECLAUDE'),
    );
    expect(claudeCalls.map((c) => c.header)).toEqual([
      'FAKECLAUDE --version',
      'FAKECLAUDE --version',
    ]);
    // The provenance probe (the last call) runs run-local with no operator
    // bundle; the pre-run pin call is the existing contract and is not
    // asserted here.
    const provenanceCall = claudeCalls.at(-1);
    if (provenanceCall === undefined) {
      throw new Error('provenance probe invocation missing from log');
    }
    expect(provenanceCall.env['HOME']).toBe(join(runDir, 'home'));
    expect(provenanceCall.env['XDG_CONFIG_HOME']).toBe(
      join(runDir, 'home', '.config'),
    );
    expect(provenanceCall.env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(provenanceCall.env['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(provenanceCall.present['ANTHROPIC_API_KEY']).toBe(false);
    expect(provenanceCall.present['AWS_SECRET_ACCESS_KEY']).toBe(false);
    assertInvocationLogHygiene(readFileSync(fx.logPath, 'utf8'));
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    fx.cleanup();
    for (const dir of [shimDir, scenarioDir, outRoot, sproot]) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// Binding fix 5 (later-stage leg): a checks-stage failure (not setup) keeps
// the agent version probe — the agent WAS runnable — and still without any
// extra config-reload probe.
test('pinned agent checks-stage failure: agent version still recorded, no extra probe', async () => {
  const fx = makeFakeBinFixture();
  const scenarioDir = makeManifestScenario();
  const outRoot = mkdtempSync(join(tmpdir(), 'out-pin-'));
  const sproot = mkdtempSync(join(tmpdir(), 'sproot-'));
  const shimDir = mockGauntletDir('pass');
  const keys = [
    'PATH',
    'SUPERPOWERS_ROOT',
    'AWS_BEARER_TOKEN_BEDROCK',
  ] as const;
  const saved = keys.map((k) => [k, process.env[k]] as const);
  process.env['PATH'] = `${shimDir}:${fx.binDir}:${process.env['PATH'] ?? ''}`;
  process.env['SUPERPOWERS_ROOT'] = sproot;
  process.env['AWS_BEARER_TOKEN_BEDROCK'] = 'bedrock-key-test';
  try {
    const { verdict } = await runScenario({
      scenarioDir,
      codingAgent: 'claude',
      codingAgentsDir: fx.agentsDir,
      outRoot,
    });
    // The manifest-drift scenario composes a checks-stage error verdict.
    expect(verdict.error?.stage).toBe('checks');
    // The agent was runnable, so its version probe still records normally.
    expect(verdict.provenance?.agent_cli_version).toBe('claude FAKEPIN 9.9.9');
    const claudeCalls = parseInvocationLog(fx.logPath).filter((s) =>
      s.header.startsWith('FAKECLAUDE'),
    );
    expect(claudeCalls.length).toBe(2);
    assertInvocationLogHygiene(readFileSync(fx.logPath, 'utf8'));
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    fx.cleanup();
    for (const dir of [shimDir, scenarioDir, outRoot, sproot]) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
