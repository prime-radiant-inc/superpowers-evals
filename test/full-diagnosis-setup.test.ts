import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runGit } from '../src/setup-helpers/git.ts';
import { runSetup } from '../src/setup-step.ts';

const SCENARIO_SETUP = resolve(
  import.meta.dir,
  '..',
  'scenarios',
  'diagnosing-full-session',
  'setup.sh',
);

function sha256(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function makeSyntheticScenario(
  files: readonly {
    path: string;
    destination: 'session-store' | 'workdir';
    relativePath: string;
    body: string;
  }[],
): { scenarioDir: string; workdir: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'full-diagnosis-setup-'));
  const scenarioDir = join(root, 'scenario');
  const corpusDir = join(scenarioDir, 'history', 'claude');
  const workdir = join(root, 'workdir');
  const home = join(root, 'home');
  mkdirSync(corpusDir, { recursive: true });
  mkdirSync(workdir);
  mkdirSync(home);
  writeFileSync(join(scenarioDir, 'setup.sh'), readFileSync(SCENARIO_SETUP));
  chmodSync(join(scenarioDir, 'setup.sh'), 0o755);

  for (const file of files) {
    const source = join(corpusDir, file.path);
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, file.body);
  }
  writeFileSync(
    join(corpusDir, 'manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        harness: 'claude',
        files: files.map((file) => ({
          path: file.path,
          destination: file.destination,
          relativePath: file.relativePath,
          sha256: sha256(file.body),
        })),
      },
      null,
      2,
    )}\n`,
  );
  return { scenarioDir, workdir, home };
}

function executeScenarioSetup(fixture: {
  scenarioDir: string;
  workdir: string;
  home: string;
}): void {
  runSetup(fixture.scenarioDir, fixture.workdir, {
    QUORUM_CODING_AGENT: 'claude',
    QUORUM_CODING_AGENT_HOME: fixture.home,
    QUORUM_AGENT_CONFIG_DIR: join(fixture.home, '.claude'),
  });
}

test('full diagnosis setup succeeds when history installs only into the session store', () => {
  const fixture = makeSyntheticScenario([
    {
      path: 'native/session.jsonl',
      destination: 'session-store',
      relativePath: 'project/session.jsonl',
      body: '{"type":"session"}\n',
    },
  ]);

  expect(() => executeScenarioSetup(fixture)).not.toThrow();
  expect(
    existsSync(
      join(fixture.home, '.claude', 'projects', 'project', 'session.jsonl'),
    ),
  ).toBe(true);
  expect(runGit(['log', '--format=%s'], fixture.workdir).trim()).toBe(
    'initial: README',
  );
  expect(runGit(['status', '--short'], fixture.workdir)).toBe('');
});

test('full diagnosis setup commits workdir fixture content when the manifest supplies it', () => {
  const fixture = makeSyntheticScenario([
    {
      path: 'artifacts/context.md',
      destination: 'workdir',
      relativePath: 'evidence/context.md',
      body: 'synthetic evidence\n',
    },
  ]);

  executeScenarioSetup(fixture);

  expect(
    readFileSync(join(fixture.workdir, 'evidence', 'context.md'), 'utf8'),
  ).toBe('synthetic evidence\n');
  expect(
    runGit(['log', '--format=%s'], fixture.workdir).trim().split('\n'),
  ).toEqual(['fixture: add historical diagnosis artifacts', 'initial: README']);
  expect(runGit(['status', '--short'], fixture.workdir)).toBe('');
});
