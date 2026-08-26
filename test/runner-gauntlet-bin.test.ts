import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mockGauntletDir } from './mock-gauntlet/shim.ts';

const RUN_CHILD = resolve(import.meta.dir, '..', 'src', 'cli', 'run-child.ts');
const REAL_CODING_AGENTS = resolve(import.meta.dir, '..', 'coding-agents');

test('gauntletBin wins over a decoy gauntlet earlier on PATH', () => {
  // Decoy: a gauntlet that, if executed, writes a marker and exits 127.
  const decoyDir = mkdtempSync(join(tmpdir(), 'decoy-'));
  const decoyMarker = join(decoyDir, 'decoy-ran');
  writeFileSync(
    join(decoyDir, 'gauntlet'),
    `#!/bin/sh\necho ran > "${decoyMarker}"\nexit 127\n`,
  );
  chmodSync(join(decoyDir, 'gauntlet'), 0o755);

  const scn = mkdtempSync(join(tmpdir(), 'scn-'));
  writeFileSync(
    join(scn, 'story.md'),
    '---\nquorum_max_time: 1m\n---\nDo the thing.',
  );
  writeFileSync(join(scn, 'setup.sh'), '#!/usr/bin/env bash\n:\n');
  chmodSync(join(scn, 'setup.sh'), 0o755);
  writeFileSync(join(scn, 'checks.sh'), 'pre() { :; }\npost() { :; }\n');

  const outRoot = mkdtempSync(join(tmpdir(), 'out-'));
  // The real mock-gauntlet shim is the sentinel binary we expect to run.
  const sentinelGauntlet = join(mockGauntletDir('pass'), 'gauntlet');
  const proc = spawnSync(
    'bun',
    [
      RUN_CHILD,
      scn,
      '--coding-agent',
      'claude',
      '--coding-agents-dir',
      REAL_CODING_AGENTS,
      '--out-root',
      outRoot,
      // claude.yaml's default_credential (opus_bedrock) lives in the canonical
      // registry — the same file the no-flag route snapshots (cli-run.test.ts);
      // run-child requires an explicit --credentials-file, so point it there.
      '--credentials-file',
      resolve(import.meta.dir, '..', 'credentials.yaml'),
      '--gauntlet-bin',
      sentinelGauntlet,
    ],
    {
      env: {
        ...process.env,
        PATH: `${decoyDir}:${process.env['PATH'] ?? ''}`,
        ANTHROPIC_API_KEY: 'sk-test',
        AWS_BEARER_TOKEN_BEDROCK: 'bedrock-key-test',
        SUPERPOWERS_ROOT: mkdtempSync(join(tmpdir(), 'sproot-')),
      },
      encoding: 'utf8',
    },
  );
  expect(existsSync(decoyMarker)).toBe(false);
  expect(proc.status).toBe(0);
  // The run produced a verdict (the sentinel mock gauntlet drove it): the
  // verdict's gauntlet layer carries the sentinel's minted run id
  // (mock-gauntlet.ts: mock_<fixture>_0000) and its pass verdict — the decoy
  // (exit 127, no result.json) would have synthesized investigate/null.
  const runs = readdirSync(outRoot).filter((d) => !d.startsWith('.'));
  expect(runs.length).toBe(1);
  const verdict = JSON.parse(
    readFileSync(join(outRoot, runs[0] ?? '', 'verdict.json'), 'utf8'),
  );
  expect(verdict.final).toBe('pass');
  expect(verdict.gauntlet.run_id).toBe('mock_pass_0000');
});
