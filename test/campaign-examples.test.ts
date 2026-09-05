import { expect, test } from 'bun:test';
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { defaultCommandRunner } from '../src/agents/command-runner.ts';
import { superpowersCapability } from '../src/agents/index.ts';
import {
  buildContentionBlock,
  intakeAgentConfig,
  prepareRegistration,
  readIntakeFromEvalsTree,
  registerCampaign,
} from '../src/campaign/registration.ts';
import { agentRuntimeFamily } from '../src/contracts/agent-config.ts';
import {
  experimentRegisterArgs,
  FAKE_PROBE,
} from './fixtures/core-comparison/registration.ts';

const root = join(import.meta.dir, '..');
function git(path: string, ...args: string[]) {
  const r = defaultCommandRunner.run('git', ['-C', path, ...args]);
  if (r.status !== 0) throw Error(r.stderr);
  return r.stdout.trim();
}
const fingerprint = {
  cpu_model: 'fixture',
  cpu_cores: 8,
  mem_bytes: 16 * 2 ** 30,
  disk_total_bytes: 100 * 2 ** 30,
};

test('all active finite suites compile against the real registry and supported adapter capabilities', () => {
  const intake = readIntakeFromEvalsTree(root);
  const sha = git(root, 'rev-parse', 'HEAD');
  for (const name of readdirSync(join(root, 'suites')).filter((n) =>
    n.endsWith('.yaml'),
  )) {
    const { grader, ...suite } = parse(
      readFileSync(join(root, 'suites', name), 'utf8'),
    );
    const result = prepareRegistration({
      suite,
      grader,
      arms: intake.arms,
      credentials: intake.credentials,
      scenarios: intake.scenarios,
      refs: {
        evals: sha,
        gauntlet: sha,
        superpowers_by_arm: Object.fromEntries(
          Object.values(intake.arms).map((a) => [
            a.name,
            a.superpowers === 'none' ? null : sha,
          ]),
        ),
      },
      globalCap: 8,
      contention: buildContentionBlock({
        fingerprint,
        globalCap: 8,
        thresholds: [{ metric: 'load', source: 'host', op: 'gt', value: 4 }],
      }),
      campaignOs: 'linux',
      capability: superpowersCapability,
      agentFamily: (a) => agentRuntimeFamily(intakeAgentConfig(intake, a)),
      agentOsSupport: (a) => intakeAgentConfig(intake, a).os_support,
      registeredAt: '2026-09-04T12:00:00.000Z',
      registeredBy: 'test',
    });
    expect(result.planned_slots.length).toBeGreaterThan(0);
    expect(result.suite.schema_version).toBe(2);
  }
});
for (const kind of ['pr-base', 'harnesses', 'skill-stock', 'models'])
  test(`${kind} example registers with actual local fixture refs and public credential prerequisites`, () => {
    const args = experimentRegisterArgs();
    const sp = args.superpowersCheckout;
    git(sp, 'init', '-q');
    git(sp, 'config', 'user.email', 'fixture@example.invalid');
    git(sp, 'config', 'user.name', 'fixture');
    writeFileSync(join(sp, 'README.md'), 'base\n');
    git(sp, 'add', '.');
    git(sp, 'commit', '-qm', 'base');
    const base = git(sp, 'rev-parse', 'HEAD');
    writeFileSync(join(sp, 'README.md'), 'treatment\n');
    git(sp, 'add', '.');
    git(sp, 'commit', '-qm', 'treatment');
    const treatment = git(sp, 'rev-parse', 'HEAD');
    rmSync(join(args.evalsCheckout, 'arms'), { recursive: true });
    mkdirSync(join(args.evalsCheckout, 'arms'));
    const folder = join(root, 'examples/campaigns', kind);
    for (const file of readdirSync(join(folder, 'arms'))) {
      const a = parse(readFileSync(join(folder, 'arms', file), 'utf8'));
      if (a.superpowers !== 'none')
        a.superpowers = a.superpowers.includes('BASE') ? base : treatment;
      writeFileSync(join(args.evalsCheckout, 'arms', file), stringify(a));
      cpSync(
        join(root, 'coding-agents', `${a.agent}.yaml`),
        join(args.evalsCheckout, 'coding-agents', `${a.agent}.yaml`),
      );
    }
    cpSync(
      join(root, 'credentials.yaml'),
      join(args.evalsCheckout, 'credentials.yaml'),
    );
    cpSync(
      join(root, 'scenarios/00-quorum-smoke-hello-world'),
      join(args.evalsCheckout, 'scenarios/00-quorum-smoke-hello-world'),
      { recursive: true },
    );
    git(args.evalsCheckout, 'add', '.');
    git(args.evalsCheckout, 'commit', '-qm', 'example inputs');
    const result = registerCampaign({
      ...args,
      evalsRef: git(args.evalsCheckout, 'rev-parse', 'HEAD'),
      suiteRaw: readFileSync(join(folder, 'suite.yaml'), 'utf8'),
      probe: FAKE_PROBE,
    });
    expect(result.experiment.planned_slots).toHaveLength(4);
    expect(result.experiment.execution_surface).toHaveLength(2);
    expect(result.experiment.grader.credential).toBe('sonnet5');
  }, 20000);
