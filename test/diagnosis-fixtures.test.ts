import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { envSnapshot } from '../src/env.ts';
import {
  type DiagnosisHarness,
  type DiagnosisKey,
  DiagnosisKeySchema,
  type FixtureArgs,
  type FixtureManifest,
  FixtureManifestSchema,
} from '../src/experiments/diagnosis/contracts.ts';
import {
  installDiagnosisFixture,
  verifyDiagnosisFixture,
} from '../src/experiments/diagnosis/fixtures.ts';

const CLI = resolve(
  import.meta.dir,
  '..',
  'src',
  'cli',
  'diagnosis-fixtures.ts',
);

const STORE_ROOTS: Record<DiagnosisHarness, string> = {
  claude: '.claude/projects',
  codex: '.codex/sessions',
  pi: '.pi/agent/sessions',
};

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function sha256(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function makeFixture(harness: DiagnosisHarness = 'pi'): FixtureArgs {
  const root = mkdtempSync(join(tmpdir(), 'diagnosis-unit-'));
  roots.push(root);
  const corpusDir = join(root, 'corpus');
  mkdirSync(corpusDir);

  const declarations = [
    ['native/history-a.jsonl', 'archive/history-a.jsonl', 'session-store'],
    ['native/history-b.jsonl', 'archive/history-b.jsonl', 'session-store'],
    ['native/history-c.jsonl', 'archive/history-c.jsonl', 'session-store'],
    ['native/history-d.jsonl', 'archive/history-d.jsonl', 'session-store'],
    [
      'native/relationships.json',
      'metadata/relationships.json',
      'session-store',
    ],
    ['artifacts/implementation.md', 'plans/implementation.md', 'workdir'],
  ] as const;

  const files = declarations.map(([path, relativePath, destination], index) => {
    const body = path.endsWith('.jsonl')
      ? `${JSON.stringify({ synthetic_unit_fixture: true, record: index })}\n`
      : `synthetic neutral artifact ${index}\n`;
    const source = join(corpusDir, path);
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, body);
    return { path, destination, relativePath, sha256: sha256(body) };
  });

  return {
    manifest: { schemaVersion: 1, harness, files },
    corpusDir,
    home: join(root, 'home'),
    workdir: join(root, 'workdir'),
  };
}

function installedPath(args: FixtureArgs, index: number): string {
  const file = args.manifest.files[index]!;
  const root =
    file.destination === 'session-store'
      ? join(args.home, STORE_ROOTS[args.manifest.harness])
      : args.workdir;
  return join(root, file.relativePath);
}

function cloneManifest(manifest: FixtureManifest): FixtureManifest {
  return structuredClone(manifest);
}

function listFiles(root: string, prefix = ''): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(root, prefix), {
    withFileTypes: true,
  })) {
    const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...listFiles(root, relativePath));
    } else {
      files.push(relativePath);
    }
  }
  return files.sort();
}

test.each([
  'claude',
  'codex',
  'pi',
] as const)('%s installs four histories, a relationship sidecar, and a plan byte-for-byte', (harness) => {
  const args = makeFixture(harness);

  installDiagnosisFixture(args);

  const rows = verifyDiagnosisFixture(args);
  expect(rows).toHaveLength(6);
  expect(rows.every((row) => row.status === 'unchanged')).toBe(true);
  for (const [index, file] of args.manifest.files.entries()) {
    expect(readFileSync(installedPath(args, index))).toEqual(
      readFileSync(join(args.corpusDir, file.path)),
    );
  }
  expect(listFiles(join(args.home, STORE_ROOTS[harness]))).toEqual([
    'archive/history-a.jsonl',
    'archive/history-b.jsonl',
    'archive/history-c.jsonl',
    'archive/history-d.jsonl',
    'metadata/relationships.json',
  ]);
  expect(listFiles(args.workdir)).toEqual(['plans/implementation.md']);
});

test('verifier reports changed and missing installed bytes without changing them', () => {
  const args = makeFixture();
  installDiagnosisFixture(args);
  writeFileSync(installedPath(args, 0), 'changed\n');
  rmSync(installedPath(args, 1));

  const rows = verifyDiagnosisFixture(args);

  expect(rows[0]).toEqual({
    source: args.manifest.files[0]!.path,
    installedPath: installedPath(args, 0),
    expectedSha256: args.manifest.files[0]!.sha256,
    actualSha256: sha256('changed\n'),
    status: 'changed',
  });
  expect(rows[1]).toEqual({
    source: args.manifest.files[1]!.path,
    installedPath: installedPath(args, 1),
    expectedSha256: args.manifest.files[1]!.sha256,
    actualSha256: null,
    status: 'missing',
  });
});

test.each([
  ['source traversal', 'path', '../outside.jsonl'],
  ['absolute destination', 'relativePath', '/tmp/outside.jsonl'],
  ['unnormalized source', 'path', 'native/../root.jsonl'],
  ['unnormalized destination', 'relativePath', 'context//root.jsonl'],
] as const)('installer rejects %s paths', (_label, field, value) => {
  const args = makeFixture();
  const manifest = cloneManifest(args.manifest);
  manifest.files[0]![field] = value;

  expect(() => installDiagnosisFixture({ ...args, manifest })).toThrow();
  expect(() => readFileSync(installedPath(args, 1))).toThrow();
});

test('installer rejects duplicate destinations before copying', () => {
  const args = makeFixture();
  const manifest = cloneManifest(args.manifest);
  manifest.files[1]!.destination = manifest.files[0]!.destination;
  manifest.files[1]!.relativePath = manifest.files[0]!.relativePath;

  expect(() => installDiagnosisFixture({ ...args, manifest })).toThrow(
    /duplicate destination/,
  );
  expect(() => readFileSync(installedPath(args, 2))).toThrow();
});

test.each([
  ['within one destination root', false],
  ['across resolved destination roots', true],
] as const)('installer rejects ancestor conflicts %s before copying', (_label, acrossRoots) => {
  const args = makeFixture('codex');
  const manifest = cloneManifest(args.manifest);
  const storeRoot = join(args.home, STORE_ROOTS.codex);
  args.workdir = acrossRoots ? storeRoot : args.workdir;
  manifest.files[0]!.destination = 'workdir';
  manifest.files[0]!.relativePath = 'foo';
  manifest.files[1]!.destination = acrossRoots ? 'session-store' : 'workdir';
  manifest.files[1]!.relativePath = 'foo/bar';

  expect(() => installDiagnosisFixture({ ...args, manifest })).toThrow(
    /destination conflict/,
  );
  expect(existsSync(join(args.workdir, 'foo'))).toBe(false);
  expect(existsSync(join(args.workdir, 'foo', 'bar'))).toBe(false);
});

test('installer rejects a symbolic-link source before copying', () => {
  const args = makeFixture();
  const file = args.manifest.files[0]!;
  const source = join(args.corpusDir, file.path);
  const outside = join(dirname(args.corpusDir), 'outside.jsonl');
  writeFileSync(outside, readFileSync(source));
  rmSync(source);
  symlinkSync(outside, source);

  expect(() => installDiagnosisFixture(args)).toThrow(/symbolic link/);
  expect(() => readFileSync(installedPath(args, 1))).toThrow();
});

test('installer rejects a symbolic-link destination before copying', () => {
  const args = makeFixture('claude');
  const store = join(args.home, STORE_ROOTS.claude);
  const outside = join(dirname(args.home), 'outside-store');
  mkdirSync(join(args.home, '.claude'), { recursive: true });
  mkdirSync(outside);
  symlinkSync(outside, store);

  expect(() => installDiagnosisFixture(args)).toThrow(/symbolic link/);
  expect(readdirSync(outside)).toEqual([]);
});

test('installer rejects a symbolic-link harness directory before copying', () => {
  const args = makeFixture('claude');
  const outside = join(dirname(args.home), 'outside-config');
  mkdirSync(args.home, { recursive: true });
  mkdirSync(outside);
  symlinkSync(outside, join(args.home, '.claude'));

  expect(() => installDiagnosisFixture(args)).toThrow(/symbolic link/);
  expect(readdirSync(outside)).toEqual([]);
});

test('installer validates every source hash before copying any file', () => {
  const args = makeFixture('codex');
  args.manifest.files[5]!.sha256 = '0'.repeat(64);

  expect(() => installDiagnosisFixture(args)).toThrow(/hash mismatch/);
  expect(() => readFileSync(installedPath(args, 0))).toThrow();
});

test('installer refuses every overwrite before copying any file', () => {
  const args = makeFixture();
  const occupied = installedPath(args, 5);
  mkdirSync(dirname(occupied), { recursive: true });
  writeFileSync(occupied, 'keep me\n');

  expect(() => installDiagnosisFixture(args)).toThrow(/already exists/);
  expect(readFileSync(occupied, 'utf8')).toBe('keep me\n');
  expect(() => readFileSync(installedPath(args, 0))).toThrow();
});

test('runtime manifest validation rejects unsupported harnesses and unknown fields', () => {
  const args = makeFixture();
  const unsupported = { ...args.manifest, harness: 'gemini' };
  const unknown = { ...args.manifest, answerKey: 'must remain private' };

  expect(() =>
    installDiagnosisFixture({
      ...args,
      manifest: unsupported as unknown as FixtureManifest,
    }),
  ).toThrow();
  expect(() => FixtureManifestSchema.parse(unknown)).toThrow();
});

test('diagnosis key validation enforces strict objects and evidence primitives', () => {
  const base: DiagnosisKey = {
    schemaVersion: 1,
    harness: 'codex',
    manifestSha256: 'a'.repeat(64),
    sessions: [
      {
        id: 'session-root',
        role: 'root',
        source: 'native/root.jsonl',
        parentId: null,
        evidence: [{ source: 'native/root.jsonl', line: 1 }],
      },
    ],
    humanTurns: [
      {
        id: 'turn-1',
        text: 'synthetic request',
        timestamp: null,
        evidence: [{ source: 'native/root.jsonl', line: 2 }],
      },
    ],
    requiredFindings: [
      {
        id: 'finding-1',
        dimension: 'skill-timeline',
        statement: 'Synthetic expected finding.',
        evidence: [{ source: 'native/root.jsonl', line: 3 }],
      },
    ],
    negativeControls: [],
    quantities: [
      {
        id: 'quantity-1',
        value: null,
        unit: 'tokens',
        scope: 'turn-1',
        evidence: [{ source: 'native/root.jsonl', line: 4 }],
      },
    ],
    capabilities: {
      usage: {
        available: false,
        evidence: [{ source: 'native/root.jsonl', line: 4 }],
      },
    },
  };

  expect(DiagnosisKeySchema.parse(base)).toEqual(base);
  expect(() =>
    DiagnosisKeySchema.parse({
      ...base,
      sessions: [{ ...base.sessions[0], id: '' }],
    }),
  ).toThrow();
  expect(() =>
    DiagnosisKeySchema.parse({
      ...base,
      quantities: [{ ...base.quantities[0], value: Number.POSITIVE_INFINITY }],
    }),
  ).toThrow();
  expect(() =>
    DiagnosisKeySchema.parse({
      ...base,
      humanTurns: [
        {
          ...base.humanTurns[0],
          evidence: [{ source: 'native/root.jsonl', line: 0 }],
        },
      ],
    }),
  ).toThrow();
  expect(() =>
    DiagnosisKeySchema.parse({ ...base, privateNote: true }),
  ).toThrow();
});

test.each([
  'claude',
  'codex',
  'pi',
] as const)('%s CLI installs from the setup home and verifies from the config directory', (harness) => {
  const args = makeFixture(harness);
  const manifestPath = join(dirname(args.corpusDir), 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(args.manifest));
  const common = {
    ...envSnapshot(),
    HOME: join(dirname(args.home), 'operator-home-must-not-be-used'),
    QUORUM_WORKDIR: args.workdir,
  };

  const install = spawnSync(
    'bun',
    [CLI, 'install', manifestPath, args.corpusDir],
    {
      env: { ...common, QUORUM_CODING_AGENT_HOME: args.home },
      encoding: 'utf8',
    },
  );
  expect({ status: install.status, stderr: install.stderr }).toEqual({
    status: 0,
    stderr: '',
  });

  const configDir = join(
    args.home,
    ...(harness === 'pi' ? ['.pi', 'agent'] : [`.${harness}`]),
  );
  const verify = spawnSync(
    'bun',
    [CLI, 'verify', manifestPath, args.corpusDir],
    {
      env: { ...common, QUORUM_AGENT_CONFIG_DIR: configDir },
      encoding: 'utf8',
    },
  );
  expect({ status: verify.status, stderr: verify.stderr }).toEqual({
    status: 0,
    stderr: '',
  });

  writeFileSync(installedPath(args, 0), 'changed\n');
  expect(
    spawnSync('bun', [CLI, 'verify', manifestPath, args.corpusDir], {
      env: { ...common, QUORUM_AGENT_CONFIG_DIR: configDir },
    }).status,
  ).toBe(1);
});

test('CLI returns 127 for malformed reference data and a mismatched config directory', () => {
  const args = makeFixture('codex');
  const manifestPath = join(dirname(args.corpusDir), 'manifest.json');
  writeFileSync(manifestPath, '{not json');
  const common = {
    ...envSnapshot(),
    QUORUM_WORKDIR: args.workdir,
    QUORUM_AGENT_CONFIG_DIR: join(args.home, '.claude'),
  };

  expect(
    spawnSync('bun', [CLI, 'verify', manifestPath, args.corpusDir], {
      env: common,
    }).status,
  ).toBe(127);

  writeFileSync(manifestPath, JSON.stringify(args.manifest));
  expect(
    spawnSync('bun', [CLI, 'verify', manifestPath, args.corpusDir], {
      env: common,
    }).status,
  ).toBe(127);
});
