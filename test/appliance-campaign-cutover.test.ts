import { expect, test } from 'bun:test';
import { createApplianceProgram } from '../src/appliance/cli.ts';
import {
  canonicalReportBytes,
  digestReportBytes,
} from '../src/campaign/report-publication.ts';

test('the supported helper exposes the complete finite campaign journey', () => {
  const program = createApplianceProgram();
  const campaign = program.commands.find(
    (command) => command.name() === 'campaign',
  );
  expect(campaign?.commands.map((command) => command.name()).sort()).toEqual([
    'cancel',
    'costs',
    'list',
    'register',
    'report',
    'run',
    'status',
  ]);
});

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkArmSuiteFiles } from '../src/campaign/arm-suite-check.ts';

test('active configuration validation rejects historical budgeted suites', () => {
  const root = mkdtempSync(join(tmpdir(), 'retired-suite-'));
  mkdirSync(join(root, 'suites'));
  writeFileSync(
    join(root, 'suites', 'old.yaml'),
    'schema_version: 1\nname: old\nkind: exploratory\nbudget_usd: 1\ngrader: {credential: grader, model: fixture}\ncomparisons: [{arm: old, scenarios: [fixture], n: 1}]\n',
  );
  const result = checkArmSuiteFiles({
    repoRoot: root,
    codingAgentsDir: join(root, 'coding-agents'),
    credentialsPath: join(root, 'credentials.yaml'),
  });
  expect(
    result.errors.some((error) => error.includes('unsupported suite version')),
  ).toBe(true);
});

import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { campaignCommands } from '../src/appliance/campaign.ts';
import { startCampaignOnce } from '../src/appliance/campaign-run.ts';
import { createApplianceActions } from '../src/appliance/cli.ts';
import { loadStateConfig } from '../src/appliance/config.ts';
import { createJob, updateJob } from '../src/appliance/jobs.ts';
import { cancelJob, dispatchDetachedWorker } from '../src/appliance/process.ts';
import { readProjection } from '../src/campaign/execution-journal.ts';
import { EMPTY_CREDENTIAL_SCOPE } from '../src/credentials/scope.ts';
import {
  experimentRegisterArgs,
  FAKE_PROBE,
} from './fixtures/core-comparison/registration.ts';

function helperFixture(exportName = 'controller') {
  const r = experimentRegisterArgs();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'campaign-operator-')));
  const bundle = join(root, 'bundle');
  mkdirSync(bundle);
  mkdirSync(join(root, 'measurements'));
  writeFileSync(
    join(bundle, 'credentials.env'),
    "TEST_KEY='fixture-a'\nTEST_KEY_B='fixture-b'\nTEST_GRADER='fixture-grader'\n",
  );
  const configPath = join(root, 'appliance.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      root,
      evals: {
        path: realpathSync(r.evalsCheckout),
        remote: 'origin',
        ref: r.evalsRef,
      },
      gauntlet: {
        path: realpathSync(r.gauntletCheckout),
        remote: 'origin',
        ref: r.gauntletRef,
      },
      superpowers: {
        path: realpathSync(r.superpowersCheckout),
        remote: 'origin',
      },
      credential_bundle: { name: 'blessed', path: bundle },
      container: { name: 'unused', results_root: join(root, 'measurements') },
      live_spend_lock: join(root, 'live-spend.lock.d'),
    }),
  );
  const loaded = loadStateConfig(configPath, { ensureState: true });
  const target = {
    module: realpathSync(
      join(import.meta.dir, 'fixtures/core-comparison/operator-controller.ts'),
    ),
    exportName,
  };
  let launches = 0;
  const commands = campaignCommands({
    loaded,
    runner: r.runner,
    probe: FAKE_PROBE,
    launch: (args, production) => {
      expect(production.target.module).toBe(
        realpathSync(join(import.meta.dir, '../src/campaign/controller.ts')),
      );
      expect(production.target.exportName).toBe('runCampaignDispatch');
      launches++;
      return startCampaignOnce(args, { target });
    },
  });
  const suite = join(root, 'suite.yaml');
  writeFileSync(suite, r.suiteRaw.replace('reserve: 1', 'reserve: 0'));
  return { root, r, loaded, commands, suite, launches: () => launches };
}
async function waitUntil(fn: () => boolean) {
  const end = Date.now() + 15000;
  while (!fn()) {
    if (Date.now() > end) throw Error('operator controller timed out');
    await Bun.sleep(20);
  }
}

test('production command journey registers a fresh identity, gates one real controller, reads and seals its result', async () => {
  const f = helperFixture();
  const registration = f.commands.register({ suite: f.suite, json: true });
  const id = registration.experiment.campaign_id;
  const args = { campaignSelector: id, json: true };
  expect(registration.campaignDir.endsWith(id)).toBe(false);
  expect(f.commands.list()).toHaveLength(1);
  expect(f.commands.status(args).state).toBe('registered');
  expect(() => f.commands.report(args)).toThrow();
  expect((await f.commands.run(args)).kind).toBe('launched');
  await waitUntil(
    () =>
      f.commands.status(args).state === 'completed' &&
      f.commands.status(args).next_action === 'report',
  );
  expect(f.commands.status(args).state).toBe('completed');
  expect(f.commands.costs(args).subject_cost_usd.known_subtotal).toBe(2);
  const report = f.commands.report(args);
  expect(report.report.complete).toBe(true);
  expect(report.report.comparisons).toHaveLength(1);
  expect(existsSync(join(registration.campaignDir, 'report-seal.json'))).toBe(
    true,
  );
  expect((await f.commands.run(args)).kind).toBe('refused');
  expect(readProjection(registration.campaignDir).attempts.size).toBe(2);
  rmSync(f.root, { recursive: true, force: true });
}, 20000);

test('controller loss permits termination-only cancel, incomplete report and a fresh identity; job receipts have no authority', async () => {
  const f = helperFixture();
  const registered = f.commands.register({ suite: f.suite, json: true });
  const args = {
    campaignSelector: registered.experiment.campaign_id,
    json: true,
  };
  const marker = join(f.root, 'ready');
  const module = join(f.root, 'hold.ts');
  writeFileSync(
    module,
    `export async function controller(context) {context.assertAdmission(); await Bun.write(${JSON.stringify(marker)},'ready'); await Bun.sleep(60000);}`,
  );
  const commands = campaignCommands({
    loaded: f.loaded,
    runner: f.r.runner,
    probe: FAKE_PROBE,
    launch: (ctx) =>
      startCampaignOnce(ctx, { target: { module, exportName: 'controller' } }),
  });
  expect((await commands.run(args)).kind).toBe('launched');
  await waitUntil(() => existsSync(marker));
  expect(commands.status(args).state).toBe('running');
  expect(() => commands.report(args)).toThrow();
  expect(commands.costs(args).subject_cost_usd.attempts).toBe(0);
  const p = readProjection(registered.campaignDir);
  const loaded = {
    ...f.loaded,
    bundle: {
      bundle_id: 'fixture',
      rotated_at: new Date().toISOString(),
      providers: [],
    },
  };
  const receipt = createJob(loaded, {
    kind: 'campaign-run',
    superpowersRef: registered.experiment.refs.evals,
    argv: ['evals-appliance', 'campaign', 'run', args.campaignSelector],
    requester: { agent: null, thread: null, task: null },
    credentialSelection: null,
    credentialScope: EMPTY_CREDENTIAL_SCOPE,
    credentialScopeSourceEvalsSha: null,
    campaign: {
      campaign_id: args.campaignSelector,
      campaign_dir: registered.campaignDir,
      evals_sha: registered.experiment.refs.evals,
      helper_sha: registered.experiment.refs.evals,
      image_ref: 'superpowers-evals:local',
      image_digest: `sha256:${'a'.repeat(64)}`,
    },
  });
  updateJob(loaded, receipt.job_id, (current) => ({
    ...current,
    status: 'done',
    result: { exit_code: 0, summary: 'completed' },
  }));
  const actions = createApplianceActions({
    loadStateConfig: () => loaded,
    loadCredentialConfig: () => loaded,
    commandRunner: f.r.runner,
    spawnDetachedWorker: () => {
      throw Error('must not launch generic worker');
    },
    runWorker: async () => {
      throw Error('must not dispatch');
    },
  });
  for (const action of [
    actions.status,
    actions.show,
    actions.costs,
    actions.cancel,
  ])
    await expect(action({ id: receipt.job_id, json: true })).rejects.toThrow(
      /invocation receipt/,
    );
  await expect(
    actions.show({ id: receipt.job_id, json: true }),
  ).rejects.toThrow(
    'evals-appliance campaign report with the campaign identity',
  );
  await expect(cancelJob(loaded, receipt.job_id, f.r.runner)).rejects.toThrow(
    /campaign invocation/,
  );
  await expect(dispatchDetachedWorker(loaded, receipt.job_id)).rejects.toThrow(
    /campaign invocation/,
  );
  expect(commands.status(args).state).toBe('running');
  expect(readProjection(registered.campaignDir).termination).toBeNull();
  process.kill(p.controller!.pid, 'SIGKILL');
  await waitUntil(() => commands.status(args).state === 'interrupted');
  const early = commands.report(args);
  const snapshotDir = join(
    registered.campaignDir,
    'report-snapshots',
    `${early.anchor.last_sequence}-${digestReportBytes(canonicalReportBytes(early))}`,
  );
  const earlyBytes = readFileSync(join(snapshotDir, 'report.json'));
  expect(commands.report(args)).toEqual(early);
  expect(existsSync(join(registered.campaignDir, 'report.json'))).toBe(false);
  expect((await commands.run(args)).kind).toBe('refused');
  expect(await commands.cancel(args)).toMatchObject({
    kind: 'unresolved',
    reason: expect.stringContaining('live-spend lock is held'),
  });
  // Advance only the dead process's lease heartbeat; journal and claim remain real.
  for (const lock of [
    f.loaded.config.live_spend_lock!,
    join(registered.campaignDir, 'journal.lease.d'),
  ]) {
    const owner = readdirSync(lock).find((name) => name.startsWith('owner-'))!;
    const token = readFileSync(join(lock, owner), 'utf8').trim().split('\n');
    expect(Number(token[0])).toBe(p.controller!.pid);
    token[2] = String(Date.now() - 151000);
    writeFileSync(join(lock, owner), `${token.join('\n')}\n`);
  }
  expect(await commands.cancel(args)).toMatchObject({ kind: 'terminated' });
  const report = commands.report(args);
  expect(report.report.complete).toBe(false);
  expect(report.report.status).toBe('interrupted');
  expect(report.anchor.last_sequence).toBeGreaterThan(
    early.anchor.last_sequence,
  );
  expect(readFileSync(join(snapshotDir, 'report.json'))).toEqual(earlyBytes);
  expect(commands.report(args)).toEqual(report);
  expect(existsSync(join(registered.campaignDir, 'report-seal.json'))).toBe(
    false,
  );
  const fresh = commands.register({ suite: f.suite, json: true });
  expect(fresh.experiment.campaign_id).not.toBe(
    registered.experiment.campaign_id,
  );
  expect(fresh.experiment.input_digest).toBe(
    registered.experiment.input_digest,
  );
  rmSync(f.root, { recursive: true, force: true });
}, 20000);

test('a different model comparison requires configuration only', async () => {
  const f = helperFixture();
  const registry = join(f.r.evalsCheckout, 'credentials.yaml');
  writeFileSync(
    registry,
    readFileSync(registry, 'utf8').replace(
      'cred_b:\n  model: test-model',
      'cred_b:\n  model: fixture-model-b',
    ),
  );
  expect(
    f.r.runner.run('git', [
      '-C',
      f.r.evalsCheckout,
      'commit',
      '-am',
      'fixture model comparison',
    ]).status,
  ).toBe(0);
  const ref = f.r.runner
    .run('git', ['-C', f.r.evalsCheckout, 'rev-parse', 'HEAD'])
    .stdout.trim();
  Object.assign(f.loaded.config.evals, { ref });
  writeFileSync(f.loaded.configPath, JSON.stringify(f.loaded.config));
  const registration = f.commands.register({ suite: f.suite, json: true });
  expect(
    registration.experiment.execution_surface.map((arm) => arm.model),
  ).toEqual(['test-model', 'fixture-model-b']);
  expect(registration.experiment.planned_slots).toHaveLength(2);
  const args = {
    campaignSelector: registration.experiment.campaign_id,
    json: true,
  };
  expect((await f.commands.run(args)).kind).toBe('launched');
  await waitUntil(() => f.commands.status(args).next_action === 'report');
  expect(f.commands.report(args).report.comparisons).toHaveLength(1);
  rmSync(f.root, { recursive: true, force: true });
}, 20000);

test('an ended readout preserves its snapshot before final termination and seal', async () => {
  const f = helperFixture('controllerWithHeldTermination');
  const registration = f.commands.register({ suite: f.suite, json: true });
  const args = {
    campaignSelector: registration.experiment.campaign_id,
    json: true,
  };
  expect((await f.commands.run(args)).kind).toBe('launched');
  await waitUntil(() => existsSync(join(f.root, 'termination-ready')));
  try {
    const early = f.commands.report(args);
    expect(early.report.status).toBe('completed');
    expect(early.report.termination_verified).toBe(false);
    const snapshot = join(
      registration.campaignDir,
      'report-snapshots',
      `${early.anchor.last_sequence}-${digestReportBytes(canonicalReportBytes(early))}`,
      'report.json',
    );
    const bytes = readFileSync(snapshot);
    expect(existsSync(join(registration.campaignDir, 'report.json'))).toBe(
      false,
    );
    expect(f.commands.report(args)).toEqual(early);
    writeFileSync(join(f.root, 'release-termination'), 'release');
    await waitUntil(
      () => readProjection(registration.campaignDir).termination !== null,
    );
    const final = f.commands.report(args);
    expect(final.anchor.last_sequence).toBeGreaterThan(
      early.anchor.last_sequence,
    );
    expect(final.report.termination_verified).toBe(true);
    expect(readFileSync(snapshot)).toEqual(bytes);
    expect(
      readFileSync(join(registration.campaignDir, 'report.json')).equals(
        canonicalReportBytes(final),
      ),
    ).toBe(true);
    expect(existsSync(join(registration.campaignDir, 'report-seal.json'))).toBe(
      true,
    );
    expect(f.commands.report(args)).toEqual(final);
  } finally {
    writeFileSync(join(f.root, 'release-termination'), 'release');
  }
}, 20000);
