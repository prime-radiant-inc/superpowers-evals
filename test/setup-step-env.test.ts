import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSetup, SETUP_ENV_ALLOWLIST } from '../src/setup-step.ts';

const HOSTILE = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'SOME_RANDOM_HOST_VAR',
];

function runHostileSetup(): Record<string, string> {
  const scenarioDir = mkdtempSync(join(tmpdir(), 'setup-scn-'));
  const workdir = mkdtempSync(join(tmpdir(), 'setup-wd-'));
  writeFileSync(
    join(scenarioDir, 'setup.sh'),
    '#!/usr/bin/env bash\nenv > "$QUORUM_WORKDIR/env-dump.txt"\n',
  );
  // runSetup execs setup.sh directly; without the executable bit its spawn
  // guard throws EACCES before any env assertion can run.
  chmodSync(join(scenarioDir, 'setup.sh'), 0o755);
  const saved: Record<string, string | undefined> = {};
  for (const name of HOSTILE) {
    saved[name] = process.env[name];
    process.env[name] = `hostile-${name}`;
  }
  try {
    runSetup(scenarioDir, workdir);
  } finally {
    for (const name of HOSTILE) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(workdir, 'env-dump.txt'), 'utf8').split(
    '\n',
  )) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

test('setup.sh never sees host credentials; quorum-owned and allowlisted vars survive', () => {
  const env = runHostileSetup();
  for (const name of HOSTILE) expect(env[name]).toBeUndefined();
  expect(env['QUORUM_WORKDIR']).toContain('setup-wd-');
  expect(env['QUORUM_SCENARIO_DIR']).toContain('setup-scn-');
  expect(env['QUORUM_REPO_ROOT']).toBeTruthy();
  expect(env['PATH']).toBeTruthy();
  // HOME is deliberately NOT projected: the Fix-1 drop sweep showed no active
  // setup path needs it (git auto-detects identity; runGit injects its own),
  // so an unevidenced re-add should fail here, loudly.
  expect(env['HOME']).toBeUndefined();
});

test('SETUP_ENV_ALLOWLIST contains no credential-shaped names', () => {
  for (const name of SETUP_ENV_ALLOWLIST) {
    expect(name).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i);
  }
});
