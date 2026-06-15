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
  expect(source).toContain('export PI_OAUTH_HOME=/auth/pi');
  expect(source).toContain('exec bun run src/cli/index.ts "$@"');
});

test('evals-tool-versions reports available tools without failing on missing optional agents', () => {
  const root = mkdtempSync(join(tmpdir(), 'evals-tool-versions-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);

  try {
    writeFakeTool(bin, 'bun', 'bun 1.3.13');
    writeFakeTool(bin, 'claude', 'claude 2.0.0');

    const proc = spawnSync('/bin/bash', [TOOL_VERSIONS], {
      env: { PATH: bin },
      encoding: 'utf8',
    });

    expect(proc.status).toBe(0);
    expect(proc.stderr).toBe('');
    expect(proc.stdout).toContain('bun: bun 1.3.13');
    expect(proc.stdout).toContain('claude: claude 2.0.0');
    expect(proc.stdout).toContain('codex: missing');
    expect(proc.stdout).toContain('kimi: missing');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('evals-tool-versions reports the real exit status for failing version checks', () => {
  const root = mkdtempSync(join(tmpdir(), 'evals-tool-versions-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);

  try {
    writeFailingVersionTool(bin, 'claude', 'claude version probe failed', 42);

    const proc = spawnSync('/bin/bash', [TOOL_VERSIONS], {
      env: { PATH: bin },
      encoding: 'utf8',
    });

    expect(proc.status).toBe(0);
    expect(proc.stderr).toBe('');
    expect(proc.stdout).toContain(
      'claude: present (version check failed with exit 42): claude version probe failed',
    );
    expect(proc.stdout).not.toContain(
      'claude: present (version check failed with exit 0)',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
