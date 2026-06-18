import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..');
const DOCKERFILE = join(REPO, 'container', 'Dockerfile');

function dockerfileSource(): string {
  expect(existsSync(DOCKERFILE)).toBe(true);
  return readFileSync(DOCKERFILE, 'utf8');
}

function expectInstallIntent(source: string, token: string): void {
  expect(source).toContain(token);
}

test('container Dockerfile uses the official Ubuntu 26.04 LTS base', () => {
  const source = dockerfileSource();

  expect(source).toMatch(/^# syntax=docker\/dockerfile:/m);
  expect(source).toMatch(/^FROM ubuntu:26\.04$/m);
  expect(source).not.toContain('mcr.microsoft.com/devcontainers');
  expect(source).not.toContain('ubuntu24.04');
});

test('container Dockerfile installs the core development toolchain families', () => {
  const source = dockerfileSource();

  for (const packageName of [
    'git',
    'gh',
    'curl',
    'jq',
    'ripgrep',
    'fd-find',
    'shellcheck',
    'build-essential',
    'python3-pip',
    'python3-venv',
    'ruby-full',
    'golang-go',
  ]) {
    expectInstallIntent(source, packageName);
  }

  for (const toolIntent of [
    'deb.nodesource.com',
    'bun.sh/install',
    'astral.sh/uv/install.sh',
    'sh.rustup.rs',
    'mise.run',
  ]) {
    expectInstallIntent(source, toolIntent);
  }
});

test('container Dockerfile installs headless agent CLIs without desktop IDE sprawl', () => {
  const source = dockerfileSource();

  for (const npmPackage of [
    '@anthropic-ai/claude-code',
    '@openai/codex',
    '@google/gemini-cli',
    'opencode-ai',
    '@github/copilot',
    '@factory/cli',
    '@qoder-ai/qodercli',
    '@qwen-code/qwen-code',
    '@moonshot-ai/kimi-code@0.15.0',
    '@kilocode/cli',
    'openclaw',
    '@sourcegraph/amp',
    '@augmentcode/auggie',
    '@continuedev/cli',
    'cline',
    '@mariozechner/pi-coding-agent',
  ]) {
    expectInstallIntent(source, npmPackage);
  }

  for (const externalInstall of [
    'cursor.com/install',
    'aider-chat',
    'AGY_OAUTH_HOME',
    'KIMI_OAUTH_HOME',
    'mini-swe-agent',
    'git+https://github.com/bytedance/trae-agent.git',
    'SWE-agent/SWE-agent',
    '/opt/sweagent-venv',
    'NousResearch/hermes-agent',
    'mimo.xiaomi.com/install',
    'acli.atlassian.com/gpg/public-key.asc',
    'acli.atlassian.com/linux/deb',
  ]) {
    expectInstallIntent(source, externalInstall);
  }

  for (const commandIntent of [
    '/usr/local/bin/kilo',
    '/usr/local/bin/droid',
    '/usr/local/bin/cn',
    '/usr/local/bin/kimi',
    '/usr/local/bin/cursor-agent',
    '/usr/local/bin/sweagent',
    '/usr/local/bin/hermes',
    '/usr/local/bin/mimo',
  ]) {
    expectInstallIntent(source, commandIntent);
  }

  expect(source).toContain(
    'curl -fsSL https://cursor.com/install | HOME=/opt/cursor-agent bash',
  );
  expect(source).toContain('test -x /opt/cursor-agent/.local/bin/agent');
  expect(source).not.toContain('find /opt/cursor-agent -type f -name agent');
  expect(source).not.toContain(
    'HOME=/opt/cursor-agent curl -fsSL https://cursor.com/install | bash',
  );
  expect(source).toContain('UV_TOOL_BIN_DIR=/usr/local/bin');
  expect(source).toContain('UV_PYTHON_INSTALL_DIR=/opt/uv-python');
  expect(source).toContain(
    'chmod -R a+rX "$UV_TOOL_DIR" "$UV_PYTHON_INSTALL_DIR"',
  );
  expect(source).toContain('mini-swe-agent --help');
  expect(source).toContain('trae-cli --version');
  expect(source).toContain('sweagent --help');
  expect(source).toContain('hermes version');
  expect(source).toContain('mimo --version');
  expect(source).toContain('acli --version');
  expect(source).not.toContain('[[');
  expect(source).not.toContain('uv tool install --tool-dir');
  expect(source).toContain('ARG TARGETARCH');
  expect(source).toContain('amd64) goose_arch=x86_64');
  expect(source).toContain('arm64) goose_arch=aarch64');
  expect(source).toContain('goose-${goose_arch}-unknown-linux-gnu.tar.gz');
  expect(source).not.toContain('goose_1.31.1_amd64.deb');

  for (const forbidden of [
    '.devcontainer/devcontainer.json',
    '/var/run/docker.sock',
    'xvfb',
    'vnc',
    'novnc',
    'cursor.deb',
    'kiro',
    'antigravity',
  ]) {
    expect(source.toLowerCase()).not.toContain(forbidden);
  }
});

test('container Dockerfile exposes quorum shims and stable workspace entrypoint', () => {
  const source = dockerfileSource();

  expect(source).toContain('COPY --from=gauntlet /package.json /opt/gauntlet/');
  expect(source).toContain('COPY --from=gauntlet /src /opt/gauntlet/src');
  expect(source).toContain('bun install --frozen-lockfile --ignore-scripts');
  expect(source).toContain('exec bun /opt/gauntlet/src/index.ts "$@"');
  expect(source).toContain('gauntlet config --json');
  expect(source).toContain('COPY container/bin/quorum /usr/local/bin/quorum');
  expect(source).toContain(
    'COPY container/bin/evals-tool-versions /usr/local/bin/evals-tool-versions',
  );
  expect(source).toContain(
    'chmod +x /usr/local/bin/quorum /usr/local/bin/evals-tool-versions',
  );
  expect(source).toMatch(/^WORKDIR \/workspace\/evals$/m);
  expect(source).toMatch(/^CMD \["sleep", "infinity"\]$/m);
});
