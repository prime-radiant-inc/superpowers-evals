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
// run-child requires an explicit --credentials-file; the repo's canonical
// registry is the file the no-flag public-run route snapshots (cli-run.test.ts)
// and carries claude's default_credential (opus_bedrock) — the campaign serf
// fixture does not, so a full pass run through run-child points here
// (same pattern as test/runner-gauntlet-bin.test.ts).
const REPO_CREDENTIALS = resolve(import.meta.dir, '..', 'credentials.yaml');

const IDENTITY = {
  campaign_id: 'c'.repeat(64),
  comparison_id: 'c1',
  block_id: 'c1:scn-a:b1',
  sample_id: 'c1:scn-a:arm_a:r1',
  execution_attempt_id: 'c1:scn-a:arm_a:r1:a1',
};

function scenario(): string {
  const scn = mkdtempSync(join(tmpdir(), 'scn-'));
  writeFileSync(
    join(scn, 'story.md'),
    '---\nquorum_max_time: 1m\n---\nDo the thing.',
  );
  writeFileSync(join(scn, 'setup.sh'), '#!/usr/bin/env bash\n:\n');
  chmodSync(join(scn, 'setup.sh'), 0o755);
  writeFileSync(join(scn, 'checks.sh'), 'pre() { :; }\npost() { :; }\n');
  return scn;
}

function runChild(extraArgs: string[], envExtra: Record<string, string> = {}) {
  const outRoot = mkdtempSync(join(tmpdir(), 'out-'));
  const proc = spawnSync(
    'bun',
    [
      RUN_CHILD,
      scenario(),
      '--coding-agent',
      'claude',
      '--coding-agents-dir',
      REAL_CODING_AGENTS,
      '--out-root',
      outRoot,
      '--credentials-file',
      REPO_CREDENTIALS,
      ...extraArgs,
    ],
    {
      env: {
        ...process.env,
        PATH: `${mockGauntletDir('pass')}:${process.env['PATH'] ?? ''}`,
        ANTHROPIC_API_KEY: 'sk-test',
        AWS_BEARER_TOKEN_BEDROCK: 'bedrock-key-test',
        SUPERPOWERS_ROOT: mkdtempSync(join(tmpdir(), 'sproot-')),
        ...envExtra,
      },
      encoding: 'utf8',
    },
  );
  const runs = readdirSync(outRoot).filter((d) => !d.startsWith('.'));
  return {
    status: proc.status,
    stderr: proc.stderr,
    outRoot,
    runDir: runs.length === 1 ? join(outRoot, runs[0]!) : null,
  };
}

test('campaign identity: persisted at run-dir allocation and stamped on the verdict', () => {
  const r = runChild(['--campaign-identity', JSON.stringify(IDENTITY)]);
  expect(r.status).toBe(0);
  expect(r.runDir).not.toBeNull();
  // Persisted at allocation — what makes R-RCV-3 quarantine possible.
  const persisted = JSON.parse(
    readFileSync(join(r.runDir!, 'campaign-identity.json'), 'utf8'),
  );
  expect(persisted).toEqual(IDENTITY);
  // Stamped on the verdict (every verdict path).
  const verdict = JSON.parse(
    readFileSync(join(r.runDir!, 'verdict.json'), 'utf8'),
  );
  expect(verdict.campaign).toEqual(IDENTITY);
});

test('legacy runs carry no campaign block (byte-identical intake absence)', () => {
  const r = runChild([]);
  expect(r.status).toBe(0);
  expect(existsSync(join(r.runDir!, 'campaign-identity.json'))).toBe(false);
  const verdict = JSON.parse(
    readFileSync(join(r.runDir!, 'verdict.json'), 'utf8'),
  );
  expect(verdict.campaign).toBeUndefined();
});

test('malformed campaign identity fails loud at the CLI boundary', () => {
  const r = runChild(['--campaign-identity', '{"campaign_id": "x"}']);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toMatch(/campaign-identity|comparison_id|invalid/i);
});

test('covered child marker: the child entry never attempts lock acquisition', () => {
  // C4 defect-addendum: campaign children enter covered by the holder's
  // live-spend lock (QUORUM_COVERED_BY_LIVE_SPEND_LOCK=1, set by the spawner
  // in src/campaign/spawn.ts). The marker means NEVER acquire — acquisition
  // under it refuses loudly (acquireLease in src/campaign/locks.ts) — so a
  // full pass through the shared child entry (executeRunCommand) proves no
  // exit path attempts acquisition, before and after task 9c wires the
  // top-level spender verbs.
  const r = runChild(['--campaign-identity', JSON.stringify(IDENTITY)], {
    QUORUM_COVERED_BY_LIVE_SPEND_LOCK: '1',
  });
  expect(r.status).toBe(0);
  const verdict = JSON.parse(
    readFileSync(join(r.runDir!, 'verdict.json'), 'utf8'),
  );
  expect(verdict.campaign).toEqual(IDENTITY);
});
