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
  expect(source).toContain('export CODEX_AUTH_HOME=/auth/codex');
  expect(source).toContain('export GEMINI_OAUTH_HOME=/auth/gemini');
  expect(source).toContain('export AGY_OAUTH_HOME=/auth/gemini');
  expect(source).toContain('export KIMI_OAUTH_HOME=/auth/kimi-code');
  expect(source).toContain('export KIMI_BINARY=/usr/local/bin/kimi');
  expect(source).toContain('export PI_OAUTH_HOME=/auth/pi');
  expect(source).toContain('exec bun run src/cli/index.ts "$@"');
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
