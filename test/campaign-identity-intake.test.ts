import { expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
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
// The static mock dir provides the `claude` binary shim (version probe /
// provisioning) while the generated hang shim provides `gauntlet`.
const MOCK = resolve(import.meta.dir, 'mock-gauntlet');

const IDENTITY = {
  campaign_id: 'c'.repeat(64),
  comparison_id: 'c1',
  block_id: 'c1:scn-a:b1',
  sample_id: 'c1:scn-a:arm_a:r1',
  execution_attempt_id: 'c1:scn-a:arm_a:r1:a1',
};

function scenario(setupFails = false): string {
  const scn = mkdtempSync(join(tmpdir(), 'scn-'));
  writeFileSync(
    join(scn, 'story.md'),
    '---\nquorum_max_time: 1m\n---\nDo the thing.',
  );
  // A failing setup drives the runner's post-allocation error path (RunnerError
  // stage 'setup' composed into an indeterminate verdict).
  writeFileSync(
    join(scn, 'setup.sh'),
    setupFails ? '#!/usr/bin/env bash\nexit 1\n' : '#!/usr/bin/env bash\n:\n',
  );
  chmodSync(join(scn, 'setup.sh'), 0o755);
  writeFileSync(join(scn, 'checks.sh'), 'pre() { :; }\npost() { :; }\n');
  return scn;
}

/** Every runChild test spawns a FULL `quorum run` in a child process (bun
 *  startup + module graph + a mock gauntlet). The 5s default is not a
 *  meaningful bound for that — it makes these tests flake on a loaded
 *  machine — so they carry the same explicit budget the SIGINT test below
 *  already declares. */
const CHILD_RUN_TIMEOUT_MS = 60_000;

function runChild(
  extraArgs: string[],
  envExtra: Record<string, string> = {},
  scn: string = scenario(),
  fixture = 'pass',
) {
  const outRoot = mkdtempSync(join(tmpdir(), 'out-'));
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
      '--credentials-file',
      REPO_CREDENTIALS,
      ...extraArgs,
    ],
    {
      env: {
        ...process.env,
        PATH: `${mockGauntletDir(fixture)}:${process.env['PATH'] ?? ''}`,
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

// Resolve, then sleep, then resolve again — a poll tick.
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Poll `predicate` until it returns a non-undefined value or the deadline
// passes (cli-run-sigint.test.ts's deterministic readiness gate).
async function pollFor<T>(
  predicate: () => T | undefined,
  deadlineMs: number,
  stepMs = 25,
): Promise<T | undefined> {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const v = predicate();
    if (v !== undefined) {
      return v;
    }
    if (Date.now() >= end) {
      return undefined;
    }
    await sleep(stepMs);
  }
}

// The single child dir of `outRoot` holding the mock's hang marker (the
// marker's dir IS the runDir — the mock's --project-dir).
function hangRunDir(outRoot: string): string | undefined {
  if (!existsSync(outRoot)) {
    return undefined;
  }
  for (const name of readdirSync(outRoot)) {
    const dir = join(outRoot, name);
    if (existsSync(join(dir, 'mock-gauntlet-hang.pid'))) {
      return dir;
    }
  }
  return undefined;
}

test(
  'campaign identity: persisted at run-dir allocation and stamped on the verdict',
  () => {
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
  },
  CHILD_RUN_TIMEOUT_MS,
);

test(
  'legacy runs carry no campaign block (byte-identical intake absence)',
  () => {
    const r = runChild([]);
    expect(r.status).toBe(0);
    expect(existsSync(join(r.runDir!, 'campaign-identity.json'))).toBe(false);
    const verdict = JSON.parse(
      readFileSync(join(r.runDir!, 'verdict.json'), 'utf8'),
    );
    expect(verdict.campaign).toBeUndefined();
  },
  CHILD_RUN_TIMEOUT_MS,
);

test(
  'malformed campaign identity fails loud at the CLI boundary',
  () => {
    const r = runChild(['--campaign-identity', '{"campaign_id": "x"}']);
    expect(r.status).not.toBe(0);
    // The SPECIFIC rejection: the zod issues dump names the first missing
    // required field (comparison_id) — not just any stderr noise.
    expect(r.stderr).toMatch(/ZodError/);
    expect(r.stderr).toMatch(/"comparison_id"/);
    // The boundary is BEFORE run-dir allocation: a malformed block must never
    // leave a run dir behind.
    expect(r.runDir).toBeNull();
    expect(readdirSync(r.outRoot).filter((d) => !d.startsWith('.'))).toEqual(
      [],
    );
  },
  CHILD_RUN_TIMEOUT_MS,
);

test(
  'setup-error path: identity persisted at allocation and stamped on a setup-error verdict',
  () => {
    // R-SPN-4: the stamp must land on EVERY exit path. A failing setup.sh
    // forces the OUTER error route — a thrown RunnerError caught by
    // runScenario and composed into an indeterminate verdict (stage 'setup').
    // The run-error route (error AFTER gauntlet started) is covered by the
    // post-gauntlet capture test below.
    const r = runChild(
      ['--campaign-identity', JSON.stringify(IDENTITY)],
      {},
      scenario(true),
    );
    expect(r.status).toBe(2); // exitCodeFor(indeterminate)
    expect(r.runDir).not.toBeNull();
    const verdict = JSON.parse(
      readFileSync(join(r.runDir!, 'verdict.json'), 'utf8'),
    );
    expect(verdict.final).toBe('indeterminate');
    expect(verdict.error?.stage).toBe('setup');
    // Both halves: persisted at allocation, stamped on the error verdict.
    expect(
      JSON.parse(
        readFileSync(join(r.runDir!, 'campaign-identity.json'), 'utf8'),
      ),
    ).toEqual(IDENTITY);
    expect(verdict.campaign).toEqual(IDENTITY);
  },
  CHILD_RUN_TIMEOUT_MS,
);

test(
  'run-error path: identity stamped on a post-gauntlet error verdict',
  () => {
    // The genuine run-error route (distinct from setup): Gauntlet STARTED and
    // COMPLETED (the pass-no-transcript fixture drops a passing result.json but
    // no canned claude session log), then the run errored in the capture
    // cascade — no Claude transcript appeared — composing an indeterminate
    // verdict with an error block (stage 'capture') via the runner's error
    // composition, not an early guard. The gauntlet layer's presence is what
    // proves this errored AFTER Gauntlet ran.
    const r = runChild(
      ['--campaign-identity', JSON.stringify(IDENTITY)],
      {},
      scenario(),
      'pass-no-transcript',
    );
    expect(r.status).toBe(2); // exitCodeFor(indeterminate)
    expect(r.runDir).not.toBeNull();
    const verdict = JSON.parse(
      readFileSync(join(r.runDir!, 'verdict.json'), 'utf8'),
    );
    // Gauntlet ran and passed; the run itself errored afterward.
    expect(verdict.gauntlet?.status).toBe('pass');
    expect(verdict.gauntlet?.run_id).toBe('mock_pass-no-transcript_0000');
    expect(verdict.final).toBe('indeterminate');
    expect(verdict.error?.stage).toBe('capture');
    // Both halves: persisted at allocation, stamped on the run-error verdict.
    expect(
      JSON.parse(
        readFileSync(join(r.runDir!, 'campaign-identity.json'), 'utf8'),
      ),
    ).toEqual(IDENTITY);
    expect(verdict.campaign).toEqual(IDENTITY);
  },
  CHILD_RUN_TIMEOUT_MS,
);

test('stopped path: SIGINT writes the stopped verdict stamped with the identity', async () => {
  // The stopped path is the CLI's SIGINT handler (writeStoppedVerdict), not
  // the runner's identified construction — it needs its own stamp proof.
  // Drives run-child under the mock gauntlet's `hang` fixture, parked in the
  // agent phase, then signals it (cli-run-sigint.test.ts's mechanics).
  const outRoot = mkdtempSync(join(tmpdir(), 'out-ident-sigint-'));
  const child = spawn(
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
      '--campaign-identity',
      JSON.stringify(IDENTITY),
    ],
    {
      env: {
        ...process.env,
        PATH: `${mockGauntletDir('hang')}:${MOCK}:${process.env['PATH'] ?? ''}`,
        ANTHROPIC_API_KEY: 'sk-test',
        AWS_BEARER_TOKEN_BEDROCK: 'bedrock-key-test',
        SUPERPOWERS_ROOT: mkdtempSync(join(tmpdir(), 'sproot-')),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  // The child must outlive this test body even if an assertion throws; reap it.
  const exited = new Promise<number | null>((resolveExit) => {
    child.on('exit', (code) => resolveExit(code));
  });
  try {
    // Race-free readiness: poll for the mock's hang marker (the runDir).
    const runDir = await pollFor(() => hangRunDir(outRoot), 30_000);
    expect(runDir).toBeDefined();
    if (runDir === undefined) {
      throw new Error('mock gauntlet never reached hang mode');
    }
    child.kill('SIGINT');
    const code = await exited;
    expect(code).toBe(2);
    const verdict = JSON.parse(
      readFileSync(join(runDir, 'verdict.json'), 'utf8'),
    );
    expect(verdict.final).toBe('indeterminate');
    expect(verdict.error?.stage).toBe('stopped');
    // Both halves: persisted at allocation, stamped on the stopped verdict.
    expect(
      JSON.parse(readFileSync(join(runDir, 'campaign-identity.json'), 'utf8')),
    ).toEqual(IDENTITY);
    expect(verdict.campaign).toEqual(IDENTITY);
  } finally {
    // Belt and suspenders: no leaked CLI child survives a failed assertion.
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    await exited;
  }
}, 60_000);

test(
  'covered child marker: the child entry never attempts lock acquisition',
  () => {
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
  },
  CHILD_RUN_TIMEOUT_MS,
);
