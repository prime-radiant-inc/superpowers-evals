import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from '../src/paths.ts';
import { runSetup, SetupError } from '../src/setup-step.ts';

test('runSetup runs setup.sh in workdir with QUORUM_WORKDIR', () => {
  const scn = mkdtempSync(join(tmpdir(), 'scn-'));
  const wd = mkdtempSync(join(tmpdir(), 'wd-'));
  writeFileSync(
    join(scn, 'setup.sh'),
    '#!/usr/bin/env bash\necho "$QUORUM_WORKDIR" > marker.txt\n',
  );
  chmodSync(join(scn, 'setup.sh'), 0o755);
  runSetup(scn, wd);
  expect(readFileSync(join(wd, 'marker.txt'), 'utf8').trim()).toBe(wd);
});

test('non-zero setup.sh throws SetupError with output', () => {
  const scn = mkdtempSync(join(tmpdir(), 'scn-'));
  const wd = mkdtempSync(join(tmpdir(), 'wd-'));
  writeFileSync(
    join(scn, 'setup.sh'),
    '#!/usr/bin/env bash\necho boom >&2\nexit 3\n',
  );
  chmodSync(join(scn, 'setup.sh'), 0o755);
  expect(() => runSetup(scn, wd)).toThrow(SetupError);
});

test('SetupError carries stdout and stderr', () => {
  const scn = mkdtempSync(join(tmpdir(), 'scn-'));
  const wd = mkdtempSync(join(tmpdir(), 'wd-'));
  writeFileSync(
    join(scn, 'setup.sh'),
    '#!/usr/bin/env bash\necho out-line\necho err-line >&2\nexit 1\n',
  );
  chmodSync(join(scn, 'setup.sh'), 0o755);
  try {
    runSetup(scn, wd);
    throw new Error('expected runSetup to throw');
  } catch (err) {
    expect(err).toBeInstanceOf(SetupError);
    const message = (err as SetupError).message;
    expect(message).toContain('out-line');
    expect(message).toContain('err-line');
  }
});

test('envExtra is passed through to setup.sh', () => {
  const scn = mkdtempSync(join(tmpdir(), 'scn-'));
  const wd = mkdtempSync(join(tmpdir(), 'wd-'));
  writeFileSync(
    join(scn, 'setup.sh'),
    '#!/usr/bin/env bash\necho "$EXTRA_TOKEN" > token.txt\n',
  );
  chmodSync(join(scn, 'setup.sh'), 0o755);
  runSetup(scn, wd, { EXTRA_TOKEN: 'hello-extra' });
  expect(readFileSync(join(wd, 'token.txt'), 'utf8').trim()).toBe(
    'hello-extra',
  );
});

test('runSetup plumbs QUORUM_REPO_ROOT into setup.sh', () => {
  const scn = mkdtempSync(join(tmpdir(), 'scn-'));
  const wd = mkdtempSync(join(tmpdir(), 'wd-'));
  writeFileSync(
    join(scn, 'setup.sh'),
    '#!/usr/bin/env bash\necho "$QUORUM_REPO_ROOT" > repo-root.txt\n',
  );
  chmodSync(join(scn, 'setup.sh'), 0o755);
  // This is the exact env_extra the runner passes (quorum/runner.py parity).
  runSetup(scn, wd, { QUORUM_REPO_ROOT: repoRoot() });
  expect(readFileSync(join(wd, 'repo-root.txt'), 'utf8').trim()).toBe(
    repoRoot(),
  );
});
