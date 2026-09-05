import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..');
const DOCKERFILE = join(REPO, 'container', 'Dockerfile');

function dockerfileSource(): string {
  expect(existsSync(DOCKERFILE)).toBe(true);
  return readFileSync(DOCKERFILE, 'utf8');
}

test('container Dockerfile builds on the shared everyharness-container base', () => {
  const source = dockerfileSource();

  expect(source).toMatch(/^# syntax=docker\/dockerfile:/m);
  // The harness-CLI install layer (agent CLIs + base toolchains) lives in the
  // shared base image, pinned by digest per its version-pin policy. It must not
  // be duplicated here.
  expect(source).toMatch(
    /^FROM ghcr\.io\/prime-radiant-inc\/everyharness-container@sha256:[0-9a-f]{64}$/m,
  );
  expect(source).not.toContain('FROM ubuntu:');
});

test('container Dockerfile does not duplicate the base image harness layer', () => {
  const source = dockerfileSource();

  // These installs now belong to everyharness-container. Keeping them here
  // would reintroduce the duplicate-maintenance problem this base image solves.
  for (const baseOwned of [
    'deb.nodesource.com',
    'bun.sh/install',
    'astral.sh/uv/install.sh',
    'sh.rustup.rs',
    'mise.run',
    '@anthropic-ai/claude-code',
    '@openai/codex',
    '@google/gemini-cli',
    'cursor.com/install',
    'NousResearch/hermes-agent',
    'antigravity.google/cli/install.sh',
    'goose-${goose_arch}-unknown-linux-gnu.tar.gz',
  ]) {
    expect(source).not.toContain(baseOwned);
  }
});

test('container Dockerfile routes /usr/bin/timeout to GNU coreutils before checking it', () => {
  const source = dockerfileSource();

  // The base image defaults to uutils coreutils and ships GNU coreutils with a
  // `gnu` prefix; the campaign attempt deadline needs GNU timeout at the exact
  // entrypoint path the spawner pins, so the build must re-route it first.
  const divert = source.indexOf(
    'dpkg-divert --local --rename --divert /usr/bin/timeout.uutils /usr/bin/timeout',
  );
  const link = source.indexOf('ln -s gnutimeout /usr/bin/timeout');
  const check = source.indexOf(
    "/usr/bin/timeout --version | grep -F 'timeout (GNU coreutils)'",
  );
  expect(divert).toBeGreaterThan(-1);
  expect(link).toBeGreaterThan(divert);
  expect(check).toBeGreaterThan(link);
});

test('container Dockerfile keeps the serf build pinned by SERF_REF', () => {
  const source = dockerfileSource();

  expect(source).toContain(
    'ARG SERF_REF=0a459b633629cd034aa8a800c77bcd75a76496e8',
  );
  expect(source).toContain('prime-radiant-inc/serf');
  expect(source).toContain('git checkout "$SERF_REF"');
  expect(source).toContain(
    'git rev-parse HEAD > /usr/local/share/serf-source-rev',
  );
  expect(source).toContain('test -x /usr/local/bin/serf');
  expect(source).toContain('serf --version');
});

test('container Dockerfile exposes gauntlet, quorum shims and stable workspace entrypoint', () => {
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
