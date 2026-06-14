// test/setup-helpers-shim.test.ts
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit } from '../src/setup-helpers/git.ts';
import { runSetup } from '../src/setup-step.ts';

describe('bin-ts shim via runSetup', () => {
  test('bare `setup-helpers` resolves to the TS impl', () => {
    const scenarioDir = mkdtempSync(join(tmpdir(), 'sh-scn-'));
    const workdir = mkdtempSync(join(tmpdir(), 'sh-work-'));
    try {
      writeFileSync(
        join(scenarioDir, 'setup.sh'),
        '#!/usr/bin/env bash\nset -euo pipefail\nsetup-helpers run create_cost_clean_repo\n',
      );
      chmodSync(join(scenarioDir, 'setup.sh'), 0o755);
      runSetup(scenarioDir, workdir, { QUORUM_REPO_ROOT: process.cwd() });
      expect(runGit(['log', '--format=%s'], workdir).trim()).toBe(
        'initial: README',
      );
    } finally {
      rmSync(scenarioDir, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test('shim propagates CLI exit codes (2 usage, 1 error)', () => {
    const shim = join(process.cwd(), 'bin-ts', 'setup-helpers');
    const workdir = mkdtempSync(join(tmpdir(), 'sh-ec-'));
    try {
      const env = {
        ...process.env,
        QUORUM_WORKDIR: workdir,
        QUORUM_REPO_ROOT: process.cwd(),
      };
      // Usage error: missing `run` subcommand -> exit 2.
      expect(spawnSync(shim, [], { env, encoding: 'utf8' }).status).toBe(2);
      // Unknown helper -> exit 1.
      expect(
        spawnSync(shim, ['run', 'nope'], { env, encoding: 'utf8' }).status,
      ).toBe(1);
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});
