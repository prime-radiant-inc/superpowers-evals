import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ATIF_NORMALIZERS } from '../src/capture/index.ts';
import type { SourceIndex } from '../src/capture/source-index.ts';
import { collectDiagnosisArtifacts } from '../src/experiments/diagnosis/artifacts.ts';
import type {
  CollectDiagnosisArgs,
  DiagnosisArtifacts,
  FixtureFile,
} from '../src/experiments/diagnosis/contracts.ts';
import { installDiagnosisFixture } from '../src/experiments/diagnosis/fixtures.ts';
import { pruneDependencyTrees } from '../src/runner/prune.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function digest(body: string | Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

function claudeHistory(id: string, inputTokens = 10): string {
  return [
    JSON.stringify({
      type: 'user',
      sessionId: id,
      message: { role: 'user', content: 'inspect the incident' },
    }),
    JSON.stringify({
      type: 'assistant',
      sessionId: id,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'historical answer' }],
        usage: { input_tokens: inputTokens, output_tokens: 5 },
      },
    }),
  ].join('\n');
}

function makeFixture(): CollectDiagnosisArgs {
  const root = mkdtempSync(join(tmpdir(), 'diagnosis-artifacts-'));
  roots.push(root);
  const corpusDir = join(root, 'corpus');
  const home = join(root, 'home');
  const runDir = join(root, 'run');
  const workdir = join(runDir, 'coding-agent-workdir');
  mkdirSync(corpusDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(workdir, { recursive: true });

  const declarations = [
    {
      path: 'native/history.jsonl',
      destination: 'session-store',
      relativePath: 'project/history.jsonl',
      body: claudeHistory('historical-root'),
    },
    {
      path: 'native/relationships.json',
      destination: 'session-store',
      relativePath: 'metadata/relationships.json',
      body: '{"root":"historical-root"}\n',
    },
    {
      path: 'artifacts/implementation.md',
      destination: 'workdir',
      relativePath: 'plans/implementation.md',
      body: '# Reviewed historical plan\n',
    },
  ] as const;
  const files: FixtureFile[] = declarations.map((file) => {
    const source = join(corpusDir, file.path);
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, file.body);
    return {
      path: file.path,
      destination: file.destination,
      relativePath: file.relativePath,
      sha256: digest(file.body),
    };
  });
  const manifest = {
    schemaVersion: 1 as const,
    harness: 'claude' as const,
    files,
  };
  writeFileSync(
    join(corpusDir, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const args = { manifest, corpusDir, home, workdir, runDir };
  installDiagnosisFixture(args);
  return args;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function installedHistory(args: CollectDiagnosisArgs): string {
  return join(args.home, '.claude', 'projects', 'project', 'history.jsonl');
}

test('retains exact historical, case, report, manifest, and workdir evidence with absolute origins', () => {
  const args = makeFixture();
  const diagnosisDir = join(
    args.home,
    '.superpowers',
    'diagnosing-superpowers',
    'case-001',
  );
  mkdirSync(join(diagnosisDir, 'analysts'), { recursive: true });
  writeFileSync(join(diagnosisDir, 'case.md'), '# Partial case\n');
  writeFileSync(join(diagnosisDir, 'report.md'), '# Final report\n');
  writeFileSync(join(diagnosisDir, 'analysts', 'timeline.md'), 'evidence\n');
  writeFileSync(join(args.workdir, 'local-report.md'), '# Workspace report\n');
  const liveUsage = '{"total_tokens":15,"est_cost_usd":0.01}\n';
  const liveSourceIndex =
    '{"schemaVersion":1,"sources":[{"id":"source-000001"}],"mergedSteps":[]}\n';
  writeFileSync(join(args.runDir, 'coding-agent-token-usage.json'), liveUsage);
  writeFileSync(join(args.runDir, 'atif-sources.json'), liveSourceIndex);

  const result = collectDiagnosisArtifacts(args);

  expect(result.errors).toEqual([]);
  expect(result.preservation.map((row) => row.status)).toEqual([
    'unchanged',
    'unchanged',
    'unchanged',
  ]);
  const byRetained = new Map(
    result.files.map((file) => [file.retainedPath, file]),
  );
  expect(byRetained.get('diagnosis-artifacts/case-001/case.md')).toEqual({
    originalPath: join(diagnosisDir, 'case.md'),
    retainedPath: 'diagnosis-artifacts/case-001/case.md',
    sha256: digest('# Partial case\n'),
    bytes: 15,
  });
  expect(byRetained.get('diagnosis-artifacts/case-001/report.md')).toEqual({
    originalPath: join(diagnosisDir, 'report.md'),
    retainedPath: 'diagnosis-artifacts/case-001/report.md',
    sha256: digest('# Final report\n'),
    bytes: 15,
  });
  expect(byRetained.get('coding-agent-workdir/local-report.md')).toEqual({
    originalPath: join(args.workdir, 'local-report.md'),
    retainedPath: 'coding-agent-workdir/local-report.md',
    sha256: digest('# Workspace report\n'),
    bytes: 19,
  });
  expect(
    readFileSync(
      join(args.runDir, 'diagnosis-artifacts', 'case-001', 'case.md'),
    ),
  ).toEqual(Buffer.from('# Partial case\n'));
  expect(
    readFileSync(
      join(
        args.runDir,
        'diagnosis-history',
        'native',
        'session-store',
        'project',
        'history.jsonl',
      ),
    ),
  ).toEqual(readFileSync(installedHistory(args)));
  expect(
    readFileSync(join(args.runDir, 'diagnosis-history', 'manifest.json')),
  ).toEqual(readFileSync(join(args.corpusDir, 'manifest.json')));

  const sourceIndex = readJson<SourceIndex>(
    join(args.runDir, 'diagnosis-history', 'atif-sources.json'),
  );
  expect(sourceIndex.mergedSteps).toEqual([]);
  expect(sourceIndex.sources).toEqual([
    {
      id: 'history-000001',
      nativePath: installedHistory(args),
      sha256: digest(claudeHistory('historical-root')),
      trajectoryPath: 'diagnosis-history/atif-sources/000001.json',
      error: null,
    },
  ]);
  const trajectoryPath = join(
    args.runDir,
    'diagnosis-history',
    'atif-sources',
    '000001.json',
  );
  const trajectoryBytes = readFileSync(trajectoryPath);
  expect(byRetained.get('diagnosis-history/atif-sources/000001.json')).toEqual({
    originalPath: trajectoryPath,
    retainedPath: 'diagnosis-history/atif-sources/000001.json',
    sha256: digest(trajectoryBytes),
    bytes: trajectoryBytes.byteLength,
  });
  expect(
    readJson<{ agent: { version: string }; session_id: string }>(
      trajectoryPath,
    ),
  ).toMatchObject({
    agent: { version: 'unknown' },
    session_id: 'historical-root',
  });
  expect(
    readFileSync(join(args.runDir, 'coding-agent-token-usage.json'), 'utf8'),
  ).toBe(liveUsage);
  expect(readFileSync(join(args.runDir, 'atif-sources.json'), 'utf8')).toBe(
    liveSourceIndex,
  );
  expect(
    existsSync(join(args.runDir, 'diagnosis-history', 'trajectory.json')),
  ).toBe(false);
  expect(
    readJson<DiagnosisArtifacts>(join(args.runDir, 'diagnosis-artifacts.json')),
  ).toEqual(result);
});

test('retains a changed history and a partial case while recording changed and missing evidence', () => {
  const args = makeFixture();
  const changed = claudeHistory('historical-root', 77);
  writeFileSync(installedHistory(args), changed);
  const relationship = join(
    args.home,
    '.claude',
    'projects',
    'metadata',
    'relationships.json',
  );
  rmSync(relationship);
  const diagnosisDir = join(
    args.home,
    '.superpowers',
    'diagnosing-superpowers',
    'partial-case',
  );
  mkdirSync(diagnosisDir, { recursive: true });
  writeFileSync(join(diagnosisDir, 'case.md'), 'unfinished case\n');

  const result = collectDiagnosisArtifacts(args);

  expect(result.preservation.map((row) => row.status)).toEqual([
    'changed',
    'missing',
    'unchanged',
  ]);
  expect(result.errors).toEqual([
    expect.stringContaining('changed'),
    expect.stringContaining('missing'),
  ]);
  expect(
    readFileSync(
      join(
        args.runDir,
        'diagnosis-history',
        'native',
        'session-store',
        'project',
        'history.jsonl',
      ),
      'utf8',
    ),
  ).toBe(changed);
  expect(
    readFileSync(
      join(args.runDir, 'diagnosis-artifacts', 'partial-case', 'case.md'),
      'utf8',
    ),
  ).toBe('unfinished case\n');
  expect(result.files.some((file) => file.originalPath === relationship)).toBe(
    false,
  );
});

test('does not follow a diagnosis symlink to an auth file', () => {
  const args = makeFixture();
  const authPath = join(args.home, '.claude', 'auth.json');
  mkdirSync(dirname(authPath), { recursive: true });
  writeFileSync(authPath, 'DO-NOT-RETAIN-AUTH');
  const diagnosisDir = join(
    args.home,
    '.superpowers',
    'diagnosing-superpowers',
    'case-with-link',
  );
  mkdirSync(diagnosisDir, { recursive: true });
  writeFileSync(join(diagnosisDir, 'case.md'), 'safe evidence\n');
  symlinkSync(authPath, join(diagnosisDir, 'auth-evidence.json'));

  const result = collectDiagnosisArtifacts(args);

  expect(result.errors).toEqual([expect.stringContaining('symbolic link')]);
  expect(result.files.some((file) => file.originalPath === authPath)).toBe(
    false,
  );
  expect(
    existsSync(
      join(
        args.runDir,
        'diagnosis-artifacts',
        'case-with-link',
        'auth-evidence.json',
      ),
    ),
  ).toBe(false);
  expect(
    readFileSync(join(args.runDir, 'diagnosis-artifacts.json'), 'utf8'),
  ).not.toContain('DO-NOT-RETAIN-AUTH');
});

test('anchors diagnosis traversal at home when the .superpowers parent is a symlink', () => {
  const args = makeFixture();
  const outside = join(dirname(args.home), 'outside-superpowers');
  const escapedDiagnosis = join(outside, 'diagnosing-superpowers');
  mkdirSync(escapedDiagnosis, { recursive: true });
  writeFileSync(join(escapedDiagnosis, 'auth.json'), 'OUTSIDE-AUTH-BYTES');
  symlinkSync(outside, join(args.home, '.superpowers'));
  writeFileSync(join(args.workdir, 'local-report.md'), 'safe report\n');

  const result = collectDiagnosisArtifacts(args);

  expect(result.errors).toEqual([expect.stringContaining('symbolic link')]);
  expect(
    existsSync(join(args.runDir, 'diagnosis-artifacts', 'auth.json')),
  ).toBe(false);
  expect(
    readFileSync(join(args.runDir, 'diagnosis-artifacts.json'), 'utf8'),
  ).not.toContain('OUTSIDE-AUTH-BYTES');
  expect(
    result.files.some(
      (file) => file.retainedPath === 'coding-agent-workdir/local-report.md',
    ),
  ).toBe(true);
  expect(
    existsSync(
      join(
        args.runDir,
        'diagnosis-history',
        'native',
        'session-store',
        'project',
        'history.jsonl',
      ),
    ),
  ).toBe(true);
});

test('workdir inventory excludes dependency trees at every depth like campaign pruning', () => {
  const args = makeFixture();
  mkdirSync(join(args.workdir, 'packages', 'app', 'node_modules'), {
    recursive: true,
  });
  mkdirSync(join(args.workdir, 'packages', 'app', '.venv', 'bin'), {
    recursive: true,
  });
  writeFileSync(
    join(args.workdir, 'packages', 'app', 'node_modules', 'dep.js'),
    'dependency\n',
  );
  writeFileSync(
    join(args.workdir, 'packages', 'app', '.venv', 'bin', 'python'),
    'venv\n',
  );
  writeFileSync(
    join(args.workdir, 'packages', 'app', 'evidence.md'),
    'retained evidence\n',
  );

  const result = collectDiagnosisArtifacts(args);
  pruneDependencyTrees(args.workdir);

  const workdirFiles = result.files.filter((file) =>
    file.retainedPath.startsWith('coding-agent-workdir/'),
  );
  expect(
    workdirFiles
      .map((file) => file.retainedPath)
      .some(
        (path) => path.includes('/node_modules/') || path.includes('/.venv/'),
      ),
  ).toBe(false);
  expect(
    workdirFiles.every((file) =>
      existsSync(join(args.runDir, file.retainedPath)),
    ),
  ).toBe(true);
  expect(
    workdirFiles.some(
      (file) =>
        file.retainedPath === 'coding-agent-workdir/packages/app/evidence.md',
    ),
  ).toBe(true);
});

test('a repeat collection replaces collector-owned output instead of mixing attempts', () => {
  const args = makeFixture();
  const diagnosisRoot = join(
    args.home,
    '.superpowers',
    'diagnosing-superpowers',
  );
  mkdirSync(join(diagnosisRoot, 'first'), { recursive: true });
  writeFileSync(join(diagnosisRoot, 'first', 'report.md'), 'first attempt\n');
  collectDiagnosisArtifacts(args);
  rmSync(join(diagnosisRoot, 'first'), { recursive: true });
  mkdirSync(join(diagnosisRoot, 'second'), { recursive: true });
  writeFileSync(join(diagnosisRoot, 'second', 'case.md'), 'second attempt\n');

  const second = collectDiagnosisArtifacts(args);

  expect(
    existsSync(join(args.runDir, 'diagnosis-artifacts', 'first', 'report.md')),
  ).toBe(false);
  expect(
    readFileSync(
      join(args.runDir, 'diagnosis-artifacts', 'second', 'case.md'),
      'utf8',
    ),
  ).toBe('second attempt\n');
  expect(
    second.files.some((file) => file.retainedPath.includes('/first/')),
  ).toBe(false);
});

test('keeps native bytes and indexes a historical normalization error', () => {
  const args = makeFixture();
  writeFileSync(installedHistory(args), 'not valid claude jsonl\n');

  const normalizeClaude = ATIF_NORMALIZERS['claude'];
  ATIF_NORMALIZERS['claude'] = () => {
    throw new Error('synthetic historical normalization failure');
  };
  let result: DiagnosisArtifacts;
  try {
    result = collectDiagnosisArtifacts(args);
  } finally {
    if (normalizeClaude === undefined) delete ATIF_NORMALIZERS['claude'];
    else ATIF_NORMALIZERS['claude'] = normalizeClaude;
  }
  const sourceIndex = readJson<SourceIndex>(
    join(args.runDir, 'diagnosis-history', 'atif-sources.json'),
  );

  expect(sourceIndex.sources).toMatchObject([
    {
      id: 'history-000001',
      sha256: digest('not valid claude jsonl\n'),
      trajectoryPath: null,
      error: expect.any(String),
    },
  ]);
  expect(result.errors).toContain(
    `historical normalization failed for ${installedHistory(args)}: synthetic historical normalization failure`,
  );
  expect(
    readFileSync(
      join(
        args.runDir,
        'diagnosis-history',
        'native',
        'session-store',
        'project',
        'history.jsonl',
      ),
      'utf8',
    ),
  ).toBe('not valid claude jsonl\n');
});
