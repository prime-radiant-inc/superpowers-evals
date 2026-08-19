import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..');
const QUORUM_SHIM = join(REPO, 'container', 'bin', 'quorum');
const TOOL_VERSIONS = join(REPO, 'container', 'bin', 'evals-tool-versions');

function bashCheck(script: string): ReturnType<typeof spawnSync> {
  return spawnSync('bash', ['-n', script], { encoding: 'utf8' });
}

function writeFakeTool(dir: string, name: string, output: string): void {
  const tool = join(dir, name);
  writeFileSync(
    tool,
    ['#!/bin/sh', `printf '%s\\n' '${output.replace(/'/g, "'\\''")}'`, ''].join(
      '\n',
    ),
  );
  chmodSync(tool, 0o755);
}

function writeFailingVersionTool(
  dir: string,
  name: string,
  output: string,
  status: number,
): void {
  const tool = join(dir, name);
  writeFileSync(
    tool,
    [
      '#!/bin/sh',
      'if [ "${1:-}" = "--version" ]; then',
      `  printf '%s\\n' '${output.replace(/'/g, "'\\''")}'`,
      `  exit ${status}`,
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(tool, 0o755);
}

test('container/bin/quorum is valid bash', () => {
  const proc = bashCheck(QUORUM_SHIM);
  expect(proc.status).toBe(0);
});

test('container/bin/evals-tool-versions is valid bash', () => {
  const proc = bashCheck(TOOL_VERSIONS);
  expect(proc.status).toBe(0);
});

test('container/bin/quorum preserves the in-container launch contract', () => {
  const source = readFileSync(QUORUM_SHIM, 'utf8');

  expect(source).toContain('cd /workspace/evals');
  expect(source).toContain('/run/evals/credentials.env');
  expect(source).toContain('export SUPERPOWERS_ROOT=/workspace/superpowers');
  // Auth-home selection is behavior-tested below through the sourceable
  // helper; the launch flow must invoke it against the projected auth root
  // AFTER the credentials env is sourced, so an env-file-injected OAuth home
  // is also cleared.
  expect(source).toContain('quorum_select_auth_env /auth');
  expect(source.indexOf('quorum_select_auth_env /auth')).toBeGreaterThan(
    source.indexOf('/run/evals/credentials.env'),
  );
  expect(source).toContain('export KIMI_BINARY=/usr/local/bin/kimi');
  expect(source).toContain('exec bun run src/cli/index.ts "$@"');
});

// Run the shim's auth-home selection for real: source the shim (the launch
// flow is guarded behind an executed-only check), call the helper against a
// temp auth root, and print the resulting environment.
function selectAuthEnv(
  authRoot: string,
  hostileEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const proc = spawnSync(
    'bash',
    [
      '-c',
      'source "$1" && quorum_select_auth_env "$2" && env',
      'bash',
      QUORUM_SHIM,
      authRoot,
    ],
    { encoding: 'utf8', env: { ...hostileEnv, PATH: Bun.env['PATH'] ?? '' } },
  );
  expect(proc.status).toBe(0);
  const out: Record<string, string> = {};
  for (const line of String(proc.stdout).split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) {
      out[line.slice(0, eq)] = line.slice(eq + 1);
    }
  }
  return out;
}

const HOSTILE_OAUTH_ENV: NodeJS.ProcessEnv = {
  CODEX_AUTH_HOME: '/evil/codex',
  GEMINI_OAUTH_HOME: '/evil/gemini',
  AGY_OAUTH_HOME: '/evil/agy',
  KIMI_OAUTH_HOME: '/evil/kimi',
  PI_OAUTH_HOME: '/evil/pi',
};

test('sourcing container/bin/quorum defines the auth selector without running the launch flow', () => {
  // The launch flow cd's into /workspace/evals and execs the CLI — neither
  // exists on the host, so exit 0 proves the guard kept it from running.
  const proc = spawnSync(
    'bash',
    [
      '-c',
      'source "$1" && declare -F quorum_select_auth_env',
      'bash',
      QUORUM_SHIM,
    ],
    { encoding: 'utf8' },
  );
  expect(proc.status).toBe(0);
  expect(proc.stdout).toContain('quorum_select_auth_env');
});

test('absent projected mounts remove hostile inherited OAuth homes', () => {
  const root = mkdtempSync(join(tmpdir(), 'quorum-auth-env-'));
  try {
    const authRoot = join(root, 'auth');
    mkdirSync(authRoot);

    const env = selectAuthEnv(authRoot, HOSTILE_OAUTH_ENV);

    expect(env['CODEX_AUTH_HOME']).toBeUndefined();
    expect(env['GEMINI_OAUTH_HOME']).toBeUndefined();
    expect(env['AGY_OAUTH_HOME']).toBeUndefined();
    expect(env['KIMI_OAUTH_HOME']).toBeUndefined();
    expect(env['PI_OAUTH_HOME']).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('present projected mounts win over hostile injected OAuth homes and absent ones stay unset', () => {
  const root = mkdtempSync(join(tmpdir(), 'quorum-auth-env-'));
  try {
    const authRoot = join(root, 'auth');
    mkdirSync(join(authRoot, 'gemini'), { recursive: true });
    mkdirSync(join(authRoot, 'pi'), { recursive: true });

    const env = selectAuthEnv(authRoot, HOSTILE_OAUTH_ENV);

    expect(env['GEMINI_OAUTH_HOME']).toBe(join(authRoot, 'gemini'));
    expect(env['AGY_OAUTH_HOME']).toBe(join(authRoot, 'gemini'));
    expect(env['PI_OAUTH_HOME']).toBe(join(authRoot, 'pi'));
    expect(env['CODEX_AUTH_HOME']).toBeUndefined();
    expect(env['KIMI_OAUTH_HOME']).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every projected mount exports its OAuth home for the projected path', () => {
  const root = mkdtempSync(join(tmpdir(), 'quorum-auth-env-'));
  try {
    const authRoot = join(root, 'auth');
    for (const dir of ['codex', 'gemini', 'kimi-code', 'pi']) {
      mkdirSync(join(authRoot, dir), { recursive: true });
    }

    const env = selectAuthEnv(authRoot, {});

    expect(env['CODEX_AUTH_HOME']).toBe(join(authRoot, 'codex'));
    expect(env['GEMINI_OAUTH_HOME']).toBe(join(authRoot, 'gemini'));
    expect(env['AGY_OAUTH_HOME']).toBe(join(authRoot, 'gemini'));
    expect(env['KIMI_OAUTH_HOME']).toBe(join(authRoot, 'kimi-code'));
    expect(env['PI_OAUTH_HOME']).toBe(join(authRoot, 'pi'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('container/bin/quorum tightens umask for live run artifacts', () => {
  const source = readFileSync(QUORUM_SHIM, 'utf8');
  const umaskIndex = source.indexOf('umask 077');
  const execIndex = source.indexOf('exec bun run src/cli/index.ts "$@"');

  expect(umaskIndex).toBeGreaterThanOrEqual(0);
  expect(execIndex).toBeGreaterThan(umaskIndex);
});

test('evals-tool-versions delegates the base inventory to harness-versions and reports evals tools', () => {
  const root = mkdtempSync(join(tmpdir(), 'evals-tool-versions-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);

  try {
    // The base image ships harness-versions; the shared harness/toolchain
    // inventory is its responsibility, not this script's.
    writeFakeTool(bin, 'harness-versions', 'claude: claude 2.0.0');
    writeFakeTool(bin, 'quorum', 'quorum 1.0.0');

    const proc = spawnSync('/bin/bash', [TOOL_VERSIONS], {
      env: { PATH: bin },
      encoding: 'utf8',
    });

    expect(proc.status).toBe(0);
    expect(proc.stderr).toBe('');
    // Delegated base inventory passes straight through.
    expect(proc.stdout).toContain('claude: claude 2.0.0');
    // Evals-specific tools are reported by this script.
    expect(proc.stdout).toContain('quorum: quorum 1.0.0');
    expect(proc.stdout).toContain('serf: missing');
    expect(proc.stdout).toContain('gauntlet: missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('evals-tool-versions reports the real exit status for failing evals-tool version checks', () => {
  const root = mkdtempSync(join(tmpdir(), 'evals-tool-versions-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);

  try {
    writeFakeTool(bin, 'harness-versions', 'claude: claude 2.0.0');
    writeFailingVersionTool(bin, 'serf', 'serf version probe failed', 42);

    const proc = spawnSync('/bin/bash', [TOOL_VERSIONS], {
      env: { PATH: bin },
      encoding: 'utf8',
    });

    expect(proc.status).toBe(0);
    expect(proc.stderr).toBe('');
    expect(proc.stdout).toContain(
      'serf: present (version check failed with exit 42): serf version probe failed',
    );
    expect(proc.stdout).not.toContain(
      'serf: present (version check failed with exit 0)',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('evals-tool-versions probes gauntlet via config since it has no --version flag', () => {
  const root = mkdtempSync(join(tmpdir(), 'evals-tool-versions-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);

  try {
    writeFakeTool(bin, 'harness-versions', 'claude: claude 2.0.0');
    // A working gauntlet: `config --json` exits 0.
    writeFakeTool(bin, 'gauntlet', '{}');

    const proc = spawnSync('/bin/bash', [TOOL_VERSIONS], {
      env: { PATH: bin },
      encoding: 'utf8',
    });

    expect(proc.status).toBe(0);
    expect(proc.stderr).toBe('');
    // Reported as present without dumping gauntlet's usage text.
    expect(proc.stdout).toContain('gauntlet: present');
    expect(proc.stdout).not.toContain(
      'gauntlet: present (config check failed)',
    );
    expect(proc.stdout).not.toContain('Unknown command');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('evals-tool-versions flags gauntlet when its config probe fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'evals-tool-versions-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);

  try {
    writeFakeTool(bin, 'harness-versions', 'claude: claude 2.0.0');
    // A broken gauntlet: present on PATH but `config --json` exits nonzero.
    const gauntlet = join(bin, 'gauntlet');
    writeFileSync(gauntlet, ['#!/bin/sh', 'exit 1', ''].join('\n'));
    chmodSync(gauntlet, 0o755);

    const proc = spawnSync('/bin/bash', [TOOL_VERSIONS], {
      env: { PATH: bin },
      encoding: 'utf8',
    });

    expect(proc.status).toBe(0);
    expect(proc.stderr).toBe('');
    expect(proc.stdout).toContain('gauntlet: present (config check failed)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('evals-tool-versions reports a clear diagnostic when the base image harness-versions is absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'evals-tool-versions-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);

  try {
    // No harness-versions on PATH — the eval image is expected to inherit it
    // from the base image, so its absence is a meaningful diagnostic.
    const proc = spawnSync('/bin/bash', [TOOL_VERSIONS], {
      env: { PATH: bin },
      encoding: 'utf8',
    });

    expect(proc.status).toBe(0);
    expect(proc.stderr).toBe('');
    expect(proc.stdout).toContain(
      'harness-versions: missing (base image not detected)',
    );
    // Evals-specific tools are still reported.
    expect(proc.stdout).toContain('quorum: missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
