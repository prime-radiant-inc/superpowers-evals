// test/campaign-cli-verbs.test.ts — the promised C1 bodies for the
// `quorum campaign register | run | cancel` verb wiring, plus the C12 pins:
// (a) `campaign run` has NO options in v1 (the spec's CLI option/default
//     table row "— (none in v1)"), so the three draft flags must be rejected;
// (b) checkout discovery is NON-CLI: evals = the running checkout,
//     gauntlet = $GAUNTLET_ROOT, superpowers = $SUPERPOWERS_ROOT — the
//     environment seams the repo already owns, fail-closed when unset.
// Every test subprocess-launches the real CLI entrypoint (src/cli/index.ts):
// the commander wiring itself is the unit under test, so in-process calls to
// the verb functions would prove nothing. Hermetic — tmp git fixtures, no
// network, no credentials, no live evals.
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { openJournalRead } from '../src/campaign/journal.ts';
import {
  campaignCancel,
  campaignRegister,
  campaignRun,
} from '../src/cli/campaign.ts';
import { envSnapshot } from '../src/env.ts';
import { publishedCampaign } from './campaign-recovery-fixtures.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli', 'index.ts');
// Per-file live-spend lock path: the cancel verb reads the holder from
// $QUORUM_LIVE_SPEND_LOCK (unset here means "no holder" -> post-crash path),
// and nothing in this file touches the $HOME default.
const SPEND_LOCK = join(mkdtempSync(join(tmpdir(), 'qlock-')), 'live.lock.d');

function git(dir: string, args: string[]): string {
  const res = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (res.status !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

/** A real tmp gauntlet checkout at one commit — $GAUNTLET_ROOT must point at
 * a git repo for register's ref resolution (R-REG-8). */
function gauntletRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gauntlet-repo-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);
  writeFileSync(join(dir, 'README.md'), 'gauntlet fixture\n');
  // The snapshot's bun install --frozen-lockfile runs inside EVERY
  // checked-out tree, so the fixture needs a committed lockfile.
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'gauntlet-fixture', version: '0.0.0' }),
  );
  const install = spawnSync('bun', ['install'], {
    cwd: dir,
    encoding: 'utf8',
  });
  if (install.status !== 0)
    throw new Error(`gauntlet fixture bun install failed: ${install.stderr}`);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'fixture']);
  return dir;
}

const GAUNTLET_ROOT = gauntletRepo();
const SUPERPOWERS_ROOT = mkdtempSync(join(tmpdir(), 'sproot-'));

/** The estimates artifact (the task-5d fixture shape, inside staleness). */
function writeEstimates(dir: string): string {
  const path = join(dir, 'estimates-v1.json');
  writeFileSync(
    path,
    JSON.stringify({
      schema_version: 'quorum.estimates/v1',
      generated_at: new Date(Date.now() - 7 * 86_400_000).toISOString(),
      corpus: {
        sources: ['s'],
        run_count: 10,
        duplicates_excluded: 0,
        digest: 'd',
      },
      entries: [
        {
          scenario: 'scn-a',
          agent: 'claude',
          credential: 'cred_a',
          os: 'linux',
          duration_s_median: 600,
          duration_n: 9,
          cost_subject_usd_median: 1,
          cost_grader_usd_median: 0.5,
          cost_total_usd_median: 1.5,
          priced_n: 9,
          spread_s: { p25: 500, p75: 700 },
          confidence: 'high',
        },
      ],
      fallbacks: {
        scenario_agent: [],
        scenario: [],
        corpus_median: { duration_s: 600, cost_total_usd: 1.5 },
      },
    }),
  );
  return path;
}

/** The suite document (task-5d shape): grader block + one comparison. */
function writeSuite(dir: string): string {
  const path = join(dir, 'testsuite.yaml');
  writeFileSync(
    path,
    [
      'schema_version: 1',
      'name: testsuite',
      'kind: exploratory',
      'budget_usd: 100',
      'grader: { credential: cred_a, model: grader-model }',
      'comparisons:',
      '  - baseline: arm_a',
      '    treatment: arm_b',
      '    scenarios: [scn-a]',
      '    n: 1',
      '',
    ].join('\n'),
  );
  return path;
}

type EnvOverrides = Record<string, string | undefined>;
function cliEnv(overrides: EnvOverrides = {}): Record<string, string> {
  const env: Record<string, string | undefined> = { ...envSnapshot() };
  env['QUORUM_LIVE_SPEND_LOCK'] = SPEND_LOCK;
  env['GAUNTLET_ROOT'] = GAUNTLET_ROOT;
  env['SUPERPOWERS_ROOT'] = SUPERPOWERS_ROOT;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env as Record<string, string>;
}

function runCli(
  args: string[],
  opts: { cwd?: string; env?: EnvOverrides } = {},
): { status: number; stdout: string; stderr: string } {
  const p = spawnSync('bun', [CLI, ...args], {
    encoding: 'utf8',
    cwd: opts.cwd,
    env: cliEnv(opts.env),
  });
  return { status: p.status ?? 1, stdout: p.stdout, stderr: p.stderr };
}

// ── register ───────────────────────────────────────────────────────────────

test('campaign register resolves gauntlet from $GAUNTLET_ROOT, refusing loudly when unset (C12b)', () => {
  const work = mkdtempSync(join(tmpdir(), 'reg-'));
  const res = runCli(
    [
      'campaign',
      'register',
      writeSuite(work),
      '--estimates',
      writeEstimates(work),
    ],
    { env: { GAUNTLET_ROOT: undefined } },
  );
  expect(res.status).toBe(1);
  expect(res.stderr).toContain('GAUNTLET_ROOT');
}, 30_000);

test('campaign register resolves superpowers from $SUPERPOWERS_ROOT, refusing loudly when unset (C12b)', () => {
  const work = mkdtempSync(join(tmpdir(), 'reg-'));
  const res = runCli(
    [
      'campaign',
      'register',
      writeSuite(work),
      '--estimates',
      writeEstimates(work),
    ],
    { env: { SUPERPOWERS_ROOT: undefined } },
  );
  expect(res.status).toBe(1);
  expect(res.stderr).toContain('SUPERPOWERS_ROOT');
}, 30_000);

test("campaign register's --estimates default is estimates/v1.json (pinned table)", () => {
  // cwd holds the suite but NOT estimates/v1.json: the default path itself
  // must be the thing that refuses, naming the path.
  const work = mkdtempSync(join(tmpdir(), 'reg-'));
  const suite = writeSuite(work);
  const res = runCli(['campaign', 'register', suite], { cwd: work });
  expect(res.status).toBe(1);
  expect(res.stderr).toContain('estimates/v1.json');
}, 30_000);

test('campaign register with valid seams refuses fail-closed past intake (deep wiring)', () => {
  // Suite + estimates + both checkout env vars present. The verb threads
  // the REAL production surfaces from here: ref resolution over the
  // $GAUNTLET_ROOT fixture and the running evals checkout, then —
  // platform-dependent, both loud, both wiring proofs:
  //   darwin: the real host-stats probe refuses the non-appliance host;
  //   linux:  intake reads the running checkout at HEAD, where the fixture
  //           suite's arms do not exist (R-REG-2 fail-closed).
  const work = mkdtempSync(join(tmpdir(), 'reg-'));
  const res = runCli([
    'campaign',
    'register',
    writeSuite(work),
    '--estimates',
    writeEstimates(work),
  ]);
  expect(res.status).toBe(1);
  if (process.platform === 'linux') {
    expect(res.stderr).toContain('not in arms/ intake');
  } else {
    expect(res.stderr).toContain('requires the Linux appliance');
  }
}, 60_000);

// ── run ────────────────────────────────────────────────────────────────────

test('campaign run rejects the three C12-forbidden options (pinned: none in v1)', () => {
  for (const flag of [
    '--evals-checkout',
    '--gauntlet-checkout',
    '--superpowers-checkout',
  ]) {
    const res = runCli([
      'campaign',
      'run',
      '/tmp/does-not-matter',
      flag,
      '/tmp/x',
    ]);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`unknown option '${flag}'`);
  }
}, 30_000);

test('campaign run refuses a nonexistent campaign directory loudly', () => {
  const res = runCli(['campaign', 'run', '/tmp/quorum-no-such-campaign-xyz']);
  expect(res.status).toBe(1);
  expect(res.stderr).toContain('campaign');
}, 30_000);

// ── cancel + the R-RCV-7 refuse-to-resume precedence ───────────────────────

/** A published campaign dir plus the snapshot-tree credentials the run verb
 * parses before resume (grader_cred is the fixture document's grader). */
function campaignFixture(): string {
  const fx = publishedCampaign({ inFlight: false });
  mkdirSync(join(fx.dir, 'evals'), { recursive: true });
  writeFileSync(
    join(fx.dir, 'evals', 'credentials.yaml'),
    [
      'grader_cred:',
      '  model: grader-model',
      '  harnesses: [claude]',
      '  api: anthropic',
      '  auth: api-key',
      '  api_key_env: KEY_G',
      '',
    ].join('\n'),
  );
  return fx.dir;
}

function journalTypes(dir: string): { types: string[]; last: unknown } {
  const reader = openJournalRead(dir);
  try {
    const events = reader.readEvents();
    return { types: events.map((e) => e.type), last: events.at(-1)?.payload };
  } finally {
    reader.close();
  }
}

test('campaign cancel journals campaign_cancelled LAST with --reason; a later campaign run refuses to resume, citing the cancel-request (R-RCV-7)', () => {
  const dir = campaignFixture();
  const cancel = runCli([
    'campaign',
    'cancel',
    dir,
    '--reason',
    'operator halt',
  ]);
  expect(cancel.status).toBe(0);
  expect(cancel.stdout).toContain('campaign cancelled');
  // Marker first, campaign_cancelled LAST (Decision D-12), reason carried.
  expect(existsSync(join(dir, 'cancel-request'))).toBe(true);
  const markerLine2 = readFileSync(join(dir, 'cancel-request'), 'utf8').split(
    '\n',
  )[1];
  expect(markerLine2).toBe('operator halt');
  const { types, last } = journalTypes(dir);
  expect(types).toEqual(['campaign_opened', 'campaign_cancelled']);
  expect(last).toEqual({ reason: 'operator halt' });

  // The resume verb checks cancel-request FIRST: it completes the
  // cancellation instead of resuming (idempotent — already terminal).
  const run = runCli(['campaign', 'run', dir]);
  expect(run.status).toBe(0);
  expect(run.stdout).toContain(
    'cancel-request present — completing cancellation instead of resuming',
  );
  expect(run.stdout).toContain('campaign run finished: cancelled');
}, 60_000);

test('campaign run completes an already-requested cancellation even when every other prerequisite is missing (R-RCV-7 FIRST)', () => {
  // The pin: cancel-request is checked before ANYTHING else. A missing
  // $GAUNTLET_ROOT or a damaged snapshot-credentials file must never block
  // completing a cancellation the operator already requested.
  const dir = campaignFixture();
  writeFileSync(join(dir, 'cancel-request'), `${Date.now()}\noperator halt\n`);
  // Damage the credentials file too — still must not matter.
  writeFileSync(join(dir, 'evals', 'credentials.yaml'), '{ not: yaml');
  const res = runCli(['campaign', 'run', dir], {
    env: { GAUNTLET_ROOT: undefined, SUPERPOWERS_ROOT: undefined },
  });
  expect(res.status).toBe(0);
  expect(res.stdout).toContain(
    'cancel-request present — completing cancellation instead of resuming',
  );
  expect(res.stdout).toContain('campaign run finished: cancelled');
  const { types } = journalTypes(dir);
  expect(types).toEqual(['campaign_opened', 'campaign_cancelled']);
}, 60_000);

// ── register success paths (C1; every earlier register test ended in exit 1)
// ────────────────────────────────────────────────────────────────────────────

const WORKTREE = resolve(import.meta.dir, '..');
const CHILD_CONTRACT_SHA = 'f230698e5bb653371bee73d6e3212d6c2e241368';
const HOST_STATS_FIXTURE = resolve(
  import.meta.dir,
  'fixtures',
  'host-stats.json',
);

/** A real clone of THIS worktree's committed state: the register verb runs
 * from the clone, so repoRoot() — the evals checkout the verb freezes and
 * intakes — is the clone (the real checkout stays untouched). The clone
 * additionally carries the campaign inputs the fixture suite references
 * (arms/, scenarios/scn-a, fixture credentials). */
function evalsCheckout(): string {
  const holder = mkdtempSync(join(tmpdir(), 'evals-cli-'));
  const dir = join(holder, 'repo');
  const clone = spawnSync(
    'git',
    ['-c', 'advice.detachedHead=false', 'clone', '-q', WORKTREE, dir],
    { encoding: 'utf8' },
  );
  if (clone.status !== 0) throw new Error(clone.stderr);
  symlinkSync(join(WORKTREE, 'node_modules'), join(dir, 'node_modules'));
  const gitOpts = ['-c', 'user.email=t@t', '-c', 'user.name=t'];
  const g = (args: string[]): string => {
    const r = spawnSync('git', ['-C', dir, ...gitOpts, ...args], {
      encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  writeFileSync(
    join(dir, 'credentials.yaml'),
    [
      'cred_a:',
      '  model: test-model',
      '  harnesses: [claude]',
      '  api: anthropic',
      '  auth: api-key',
      '  api_key_env: TEST_KEY_A',
      'cred_b:',
      '  model: test-model',
      '  harnesses: [claude]',
      '  api: anthropic',
      '  auth: api-key',
      '  api_key_env: TEST_KEY_B',
      '',
    ].join('\n'),
  );
  mkdirSync(join(dir, 'arms'), { recursive: true });
  writeFileSync(
    join(dir, 'arms', 'arm_a.yaml'),
    [
      'schema_version: 1',
      'name: arm_a',
      'agent: claude',
      'credential: cred_a',
      'superpowers: none',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'arms', 'arm_b.yaml'),
    [
      'schema_version: 1',
      'name: arm_b',
      'agent: claude',
      'credential: cred_b',
      'superpowers: none',
      '',
    ].join('\n'),
  );
  mkdirSync(join(dir, 'scenarios', 'scn-a'), { recursive: true });
  writeFileSync(
    join(dir, 'scenarios', 'scn-a', 'story.md'),
    '---\nquorum_tier: full\n---\nDo the thing.\n',
  );
  writeFileSync(
    join(dir, 'scenarios', 'scn-a', 'setup.sh'),
    '#!/usr/bin/env bash\n:\n',
  );
  writeFileSync(
    join(dir, 'scenarios', 'scn-a', 'checks.sh'),
    'pre() { :; }\npost() { :; }\n',
  );
  g(['add', '-A']);
  g(['commit', '-qm', 'campaign CLI fixtures']);
  return dir;
}

const EVALS_CHECKOUT = evalsCheckout();

/** The child-contract seam: a `git` PATH shim answering exactly the pinned
 * merge-base --is-ancestor question (the commit exists in no reachable
 * store) and delegating everything else to the real git. */
const GIT_SHIM_DIR = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'git-shim-'));
  writeFileSync(
    join(dir, 'git'),
    `#!/bin/sh
# Test seam (registration child-contract probe): answer the one
# merge-base --is-ancestor question for D2's pinned implementation merge,
# which exists in no reachable object store; delegate all else to real git.
if [ "$1" = "-C" ] && [ "$3" = "merge-base" ] && [ "$4" = "--is-ancestor" ] \
   && [ "$5" = "${CHILD_CONTRACT_SHA}" ]; then
  exit 0
fi
exec /usr/bin/git "$@"
`,
    { mode: 0o755 },
  );
  return dir;
})();

/** Register invocations run from the clone (cwd inside it so the relative
 * --estimates default and campaigns/ root land there) with the passing
 * host-stats fixture injected through the seam. */
function registerCli(
  args: string[],
  opts: { env?: EnvOverrides } = {},
): { status: number; stdout: string; stderr: string } {
  const p = spawnSync(
    'bun',
    [join(EVALS_CHECKOUT, 'src', 'cli', 'index.ts'), ...args],
    {
      encoding: 'utf8',
      cwd: EVALS_CHECKOUT,
      env: {
        ...cliEnv({
          GAUNTLET_ROOT,
          SUPERPOWERS_ROOT,
          QUORUM_HOST_STATS_PROBE_FIXTURE: HOST_STATS_FIXTURE,
          TEST_KEY_A: 'fixture-key-a',
          TEST_KEY_B: 'fixture-key-b',
        }),
        ...opts.env,
      },
    },
  );
  return { status: p.status ?? 1, stdout: p.stdout, stderr: p.stderr };
}

function fixtureSuite(): string {
  return writeSuite(EVALS_CHECKOUT);
}

function fixtureEstimates(): string {
  return writeEstimates(EVALS_CHECKOUT);
}

test('register without --confirm prints grid + digest + cap and exits 0, never writing (print-and-exit)', () => {
  const res = registerCli([
    'campaign',
    'register',
    fixtureSuite(),
    '--estimates',
    fixtureEstimates(),
  ]);
  expect(res.stderr).toBe('');
  expect(res.status).toBe(0);
  expect(res.stdout).toMatch(/digest: [0-9a-f]{64}/);
  expect(res.stdout).toContain('grid: 1 cells');
  expect(res.stdout).toContain('global_run_cap = 8 per-sample slots');
  expect(existsSync(join(EVALS_CHECKOUT, 'campaigns'))).toBe(false);
}, 120_000);

test('register --dry-run computes the same grid + digest and never publishes', () => {
  const res = registerCli([
    'campaign',
    'register',
    fixtureSuite(),
    '--estimates',
    fixtureEstimates(),
    '--dry-run',
  ]);
  expect(res.status).toBe(0);
  expect(res.stdout).toMatch(/digest: [0-9a-f]{64}/);
  expect(existsSync(join(EVALS_CHECKOUT, 'campaigns'))).toBe(false);
}, 120_000);

test('register --global-cap forwards the flag into the frozen cap reading', () => {
  const res = registerCli([
    'campaign',
    'register',
    fixtureSuite(),
    '--estimates',
    fixtureEstimates(),
    '--global-cap',
    '4',
  ]);
  expect(res.status).toBe(0);
  expect(res.stdout).toContain('global_run_cap = 4 per-sample slots');
  expect(res.stdout).toContain('max contemporaneous two-arm blocks = 2');
}, 120_000);

test('register --confirm publishes: campaign.json + journal + snapshot, digest printed, exit 0', () => {
  // The child-contract probe's prerequisites come through the seams: D2's
  // pinned implementation-merge commit exists in no reachable object store
  // (cat-file misses locally AND on origin), so the fixture PATH carries a
  // git shim that answers exactly that merge-base --is-ancestor question
  // and delegates everything else to the real git — the same PATH-shim
  // mechanism the mock-gauntlet harness uses. Everything else is real:
  // worktree materialization, bun installs, publication order.
  const res = registerCli(
    [
      'campaign',
      'register',
      fixtureSuite(),
      '--estimates',
      fixtureEstimates(),
      '--confirm',
    ],
    { env: { PATH: `${GIT_SHIM_DIR}:${envSnapshot()['PATH'] ?? ''}` } },
  );
  expect(res.stderr).toBe('');
  expect(res.status).toBe(0);
  const digest = /[0-9a-f]{64}/.exec(
    /digest: ([0-9a-f]{64})/.exec(res.stdout)?.[1] ?? '',
  )?.[0];
  expect(digest).toBeDefined();
  const campaigns = join(EVALS_CHECKOUT, 'campaigns');
  const dir = readdirSync(campaigns)
    .filter((d) => d.endsWith('-testsuite'))
    .map((d) => join(campaigns, d))[0];
  expect(dir).toBeDefined();
  expect(basename(dir!)).toBe(`${digest!.slice(0, 8)}-testsuite`);
  for (const f of [
    'campaign.json',
    'journal.db',
    '.quorum-snapshot-ok',
    'evals/credentials.yaml',
    'gauntlet/README.md',
  ]) {
    expect(existsSync(join(dir!, f))).toBe(true);
  }
  const doc: { digest?: string; contention?: { global_run_cap?: number } } =
    JSON.parse(readFileSync(join(dir!, 'campaign.json'), 'utf8')) as {
      digest?: string;
      contention?: { global_run_cap?: number };
    };
  expect(doc.digest).toBe(digest);
  expect(doc.contention?.global_run_cap).toBe(8);
}, 300_000);

test('the D3 verbs resolve exit codes in-process (only the Commander action exits)', async () => {
  // C8 boundary: a fail-closed verb error must RETURN a code, never
  // process.exit inside the helper — an in-process caller (this test) would
  // otherwise die with it.
  expect(await campaignRun('/tmp/quorum-no-such-campaign-xyz')).toBe(1);
  expect(await campaignCancel('/tmp/quorum-no-such-campaign-xyz', {})).toBe(1);
  expect(
    campaignRegister('/tmp/no-such-suite.yaml', {
      estimates: '/tmp/no-such-estimates.json',
      globalCap: '8',
    }),
  ).toBe(1);
}, 30_000);
