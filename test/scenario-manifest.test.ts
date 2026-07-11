import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVerb } from '../src/check/dispatch.ts';
import type { CheckContext } from '../src/check/fs-verbs.ts';
import {
  parseBaselineManifest,
  validateBaselineManifest,
  verifyBaselineTree,
} from '../src/scenario-manifest.ts';

interface FixtureFile {
  readonly path: string;
  readonly content: string;
  readonly mode?: '100644' | '100755';
}

const SPEC = 'docs/superpowers/specs/2026-07-01-fractals-cli-design.md';
const PLAN = 'docs/superpowers/plans/2026-07-01-fractals-cli.md';

function tempDir(prefix = 'scenario-manifest-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function writeFixture(scenarioDir: string, file: FixtureFile): void {
  const path = join(scenarioDir, 'fixtures', file.path);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, file.content);
  chmodSync(path, file.mode === '100755' ? 0o755 : 0o644);
}

function writeManifest(
  scenarioDir: string,
  files: readonly FixtureFile[],
): void {
  writeFileSync(
    join(scenarioDir, 'baseline-manifest.json'),
    `${JSON.stringify(
      {
        schema_version: 1,
        roles: { spec: SPEC, plan: PLAN },
        files: files.map((file) => ({
          path: file.path,
          mode: file.mode ?? '100644',
          sha256: sha256(file.content),
        })),
      },
      null,
      2,
    )}\n`,
  );
}

function validScenario(): { scenarioDir: string; files: FixtureFile[] } {
  const scenarioDir = tempDir();
  const files = [
    { path: PLAN, content: 'PLAN\n' },
    { path: SPEC, content: 'SPEC\n' },
  ];
  for (const file of files) writeFixture(scenarioDir, file);
  writeManifest(scenarioDir, files);
  return { scenarioDir, files };
}

function rewriteManifest(scenarioDir: string, value: unknown): void {
  writeFileSync(
    join(scenarioDir, 'baseline-manifest.json'),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function manifestJson(scenarioDir: string): {
  schema_version: number;
  roles: { spec: string; plan: string };
  files: Array<{ path: string; mode: string; sha256: string }>;
} {
  return JSON.parse(
    readFileSync(join(scenarioDir, 'baseline-manifest.json'), 'utf8'),
  ) as never;
}

test('validates a content-addressed baseline fixture tree', () => {
  const { scenarioDir } = validScenario();
  try {
    expect(validateBaselineManifest(scenarioDir)).toEqual([]);
  } finally {
    rmSync(scenarioDir, { recursive: true, force: true });
  }
});

test('reports every declared fixture that is missing', () => {
  const { scenarioDir } = validScenario();
  try {
    rmSync(join(scenarioDir, 'fixtures', SPEC));
    expect(validateBaselineManifest(scenarioDir)).toContain(
      `missing file: ${SPEC}`,
    );
  } finally {
    rmSync(scenarioDir, { recursive: true, force: true });
  }
});

test('reports fixture files not declared by the manifest', () => {
  const { scenarioDir } = validScenario();
  try {
    writeFixture(scenarioDir, {
      path: 'src/extra.ts',
      content: 'export {};\n',
    });
    expect(validateBaselineManifest(scenarioDir)).toContain(
      'extra file: src/extra.ts',
    );
  } finally {
    rmSync(scenarioDir, { recursive: true, force: true });
  }
});

test('reports content and mode drift from the declared baseline', () => {
  const { scenarioDir } = validScenario();
  try {
    writeFileSync(join(scenarioDir, 'fixtures', PLAN), 'CHANGED\n');
    chmodSync(join(scenarioDir, 'fixtures', SPEC), 0o755);
    const problems = validateBaselineManifest(scenarioDir);
    expect(problems).toContain(`sha256 mismatch: ${PLAN}`);
    expect(problems).toContain(
      `mode mismatch: ${SPEC} (expected 100644, got 100755)`,
    );
  } finally {
    rmSync(scenarioDir, { recursive: true, force: true });
  }
});

test('rejects unsafe, duplicate, and unsorted manifest file paths', () => {
  const { scenarioDir } = validScenario();
  try {
    const manifest = manifestJson(scenarioDir);
    const plan = manifest.files[0];
    const spec = manifest.files[1];
    if (plan === undefined || spec === undefined) {
      throw new Error('valid manifest fixture is missing entries');
    }
    manifest.files = [
      spec,
      plan,
      { ...plan, path: '../escape.md' },
      { ...plan },
    ];
    rewriteManifest(scenarioDir, manifest);
    const problems = validateBaselineManifest(scenarioDir);
    expect(problems).toContain('invalid path: ../escape.md');
    expect(problems).toContain(`duplicate path: ${PLAN}`);
    expect(problems).toContain('manifest files must be sorted by path');
  } finally {
    rmSync(scenarioDir, { recursive: true, force: true });
  }
});

test('rejects role paths that are not manifest files', () => {
  const { scenarioDir } = validScenario();
  try {
    const manifest = manifestJson(scenarioDir);
    manifest.roles.plan = 'docs/superpowers/plans/missing.md';
    rewriteManifest(scenarioDir, manifest);
    expect(validateBaselineManifest(scenarioDir)).toContain(
      'role plan is not declared in files: docs/superpowers/plans/missing.md',
    );
  } finally {
    rmSync(scenarioDir, { recursive: true, force: true });
  }
});

test('rejects unsafe node types and unsupported declared modes', () => {
  const { scenarioDir } = validScenario();
  try {
    const manifest = manifestJson(scenarioDir);
    const plan = join(scenarioDir, 'fixtures', PLAN);
    const spec = join(scenarioDir, 'fixtures', SPEC);
    rmSync(spec);
    symlinkSync(plan, spec);
    rmSync(plan);
    mkdirSync(plan);
    const first = manifest.files[0];
    if (first === undefined)
      throw new Error('valid manifest fixture is missing');
    first.mode = '100600';
    rewriteManifest(scenarioDir, manifest);

    const problems = validateBaselineManifest(scenarioDir);
    expect(problems).toContain(`invalid mode: ${PLAN} (100600)`);
    expect(problems).toContain(`not a regular file: ${PLAN}`);
    expect(problems).toContain(`symlink: ${SPEC}`);
  } finally {
    rmSync(scenarioDir, { recursive: true, force: true });
  }
});

test('runtime verification ignores only the worktree .git directory', () => {
  const { scenarioDir, files } = validScenario();
  const workdir = tempDir('baseline-worktree-');
  try {
    for (const file of files) {
      const path = join(workdir, file.path);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, file.content);
      chmodSync(path, 0o644);
    }
    mkdirSync(join(workdir, '.git', 'objects'), { recursive: true });
    writeFileSync(join(workdir, '.git', 'objects', 'placeholder'), 'git\n');
    const manifest = parseBaselineManifest(
      join(scenarioDir, 'baseline-manifest.json'),
    );
    expect(
      verifyBaselineTree({ manifest, rootDir: workdir, ignoreGitDir: true }),
    ).toEqual([]);

    writeFileSync(join(workdir, 'unexpected.txt'), 'nope\n');
    expect(
      verifyBaselineTree({ manifest, rootDir: workdir, ignoreGitDir: true }),
    ).toContain('extra file: unexpected.txt');
  } finally {
    rmSync(scenarioDir, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});

test('baseline-manifest check verb verifies the seeded worktree from QUORUM_SCENARIO_DIR', () => {
  const { scenarioDir, files } = validScenario();
  const workdir = tempDir('baseline-check-');
  try {
    for (const file of files) {
      const path = join(workdir, file.path);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, file.content);
      chmodSync(path, 0o644);
    }
    const ctx: CheckContext = {
      cwd: workdir,
      env: (key) => (key === 'QUORUM_SCENARIO_DIR' ? scenarioDir : undefined),
    };
    expect(runVerb('baseline-manifest', [], ctx)).toEqual({
      passed: true,
      detail: '',
    });
  } finally {
    rmSync(scenarioDir, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
});
