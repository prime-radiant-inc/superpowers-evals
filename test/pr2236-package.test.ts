import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import {
  buildRuntimePackage,
  type PackageReceipt,
} from '../scripts/experiments/pr2236-package.ts';

const REMOVED_REFERENCES = [
  'skills/diagnosing-superpowers/references/claude-code-sessions.md',
  'skills/diagnosing-superpowers/references/codex-sessions.md',
  'skills/diagnosing-superpowers/references/other-harnesses.md',
] as const;
const REMOVED_TEXT = '# Claude Code session store\nprivate removed recipe\n';

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (${result.status}): ${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function gitBytesSha256(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (${result.status}): ${String(result.stderr)}`,
    );
  }
  return createHash('sha256').update(result.stdout).digest('hex');
}

function write(root: string, path: string, body: string, executable = false) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, body);
  chmodSync(absolute, executable ? 0o755 : 0o644);
}

function commit(root: string, message: string): string {
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
}

function sourceFixture(): {
  root: string;
  controlSha: string;
  treatmentSha: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'pr2236-package-source-'));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'Package Test']);
  git(root, ['config', 'user.email', 'package-test@example.invalid']);
  write(root, '.claude-plugin/plugin.json', '{"name":"superpowers"}\n');
  write(root, '.codex-plugin/plugin.json', '{"name":"superpowers"}\n');
  write(root, '.cursor-plugin/plugin.json', '{"name":"superpowers"}\n');
  write(root, 'hooks/session-start', '#!/bin/sh\necho ready\n', true);
  write(
    root,
    '.opencode/plugins/superpowers.js',
    'export const plugin = {};\n',
  );
  write(
    root,
    '.pi/extensions/superpowers.ts',
    'export const extension = {};\n',
  );
  write(
    root,
    'skills/diagnosing-superpowers/SKILL.md',
    [
      '# Diagnose',
      ...REMOVED_REFERENCES.map((path) => `Read ${path}.`),
      'Read references/context-safety.md.',
      '',
    ].join('\n'),
  );
  write(
    root,
    'skills/diagnosing-superpowers/references/context-safety.md',
    '# Context safety\n',
  );
  for (const path of REMOVED_REFERENCES) write(root, path, REMOVED_TEXT);
  write(
    root,
    'skills/example/SKILL.md',
    '# Example\nRead references/runtime.md.\n',
  );
  write(root, 'skills/example/references/runtime.md', '# Runtime library\n');
  symlinkSync(
    'references/runtime.md',
    join(root, 'skills/example/runtime-link.md'),
  );
  write(
    root,
    'docs/superpowers/plans/development-plan.md',
    `Development copy follows.\n\n${REMOVED_TEXT}`,
  );
  write(root, 'tests/development-only.test.ts', 'throw new Error();\n');
  const controlSha = commit(root, 'control');

  for (const path of REMOVED_REFERENCES) rmSync(join(root, path));
  write(
    root,
    'skills/diagnosing-superpowers/SKILL.md',
    '# Diagnose\nRead references/session-discovery.md.\nRead references/context-safety.md.\n',
  );
  write(
    root,
    'skills/diagnosing-superpowers/references/session-discovery.md',
    '# Discover the session history\nUse observed records.\n',
  );
  const treatmentSha = commit(root, 'treatment');
  return { root, controlSha, treatmentSha };
}

function regularFiles(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) found.push(relative(root, absolute));
    }
  };
  visit(root);
  return found.sort();
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function expectReceiptMatchesPackage(
  outputDir: string,
  receipt: PackageReceipt,
) {
  const packageDir = join(outputDir, 'package');
  const paths = regularFiles(packageDir);
  expect(receipt.files.map((file) => file.path)).toEqual(paths);
  expect(receipt.files).toEqual(
    paths.map((path) => ({ path, sha256: sha256(join(packageDir, path)) })),
  );
  expect(
    JSON.parse(readFileSync(join(outputDir, 'receipt.json'), 'utf8')),
  ).toEqual(receipt);
}

test('builds clean root packages while preserving runtime bytes and references', () => {
  const fixture = sourceFixture();
  const outputRoot = mkdtempSync(join(tmpdir(), 'pr2236-packages-'));
  const controlDir = join(outputRoot, 'control');
  const treatmentDir = join(outputRoot, 'treatment');
  try {
    const control = buildRuntimePackage({
      sourceCheckout: fixture.root,
      sourceSha: fixture.controlSha,
      outputDir: controlDir,
      importCheckout: fixture.root,
      retainRef: 'refs/pr2236-session-discovery/control',
    });
    const treatment = buildRuntimePackage({
      sourceCheckout: fixture.root,
      sourceSha: fixture.treatmentSha,
      outputDir: treatmentDir,
      importCheckout: fixture.root,
      retainRef: 'refs/pr2236-session-discovery/treatment',
    });

    expect(control.source_sha).toBe(fixture.controlSha);
    expect(treatment.source_sha).toBe(fixture.treatmentSha);
    for (const [outputDir, receipt] of [
      [controlDir, control],
      [treatmentDir, treatment],
    ] as const) {
      expectReceiptMatchesPackage(outputDir, receipt);
      const packageDir = join(outputDir, 'package');
      expect(
        lstatSync(
          join(packageDir, 'skills/example/runtime-link.md'),
        ).isSymbolicLink(),
      ).toBe(true);
      expect(
        readlinkSync(join(packageDir, 'skills/example/runtime-link.md')),
      ).toBe('references/runtime.md');
      expect(
        readFileSync(join(packageDir, '.claude-plugin/plugin.json'), 'utf8'),
      ).toBe('{"name":"superpowers"}\n');
      expect(
        readFileSync(join(packageDir, '.codex-plugin/plugin.json'), 'utf8'),
      ).toBe('{"name":"superpowers"}\n');
      expect(
        readFileSync(join(packageDir, '.cursor-plugin/plugin.json'), 'utf8'),
      ).toBe('{"name":"superpowers"}\n');
      expect(
        readFileSync(join(packageDir, 'hooks/session-start'), 'utf8'),
      ).toBe('#!/bin/sh\necho ready\n');
      expect(
        lstatSync(join(packageDir, 'hooks/session-start')).mode & 0o111,
      ).not.toBe(0);
      expect(
        readFileSync(
          join(packageDir, '.opencode/plugins/superpowers.js'),
          'utf8',
        ),
      ).toContain('plugin');
      expect(
        readFileSync(join(packageDir, '.pi/extensions/superpowers.ts'), 'utf8'),
      ).toContain('extension');
      expect(
        readFileSync(
          join(packageDir, 'skills/example/references/runtime.md'),
          'utf8',
        ),
      ).toBe('# Runtime library\n');
      expect(() => lstatSync(join(packageDir, 'docs'))).toThrow();
      expect(() => lstatSync(join(packageDir, 'tests'))).toThrow();
      expect(() => lstatSync(join(packageDir, '.git'))).toThrow();
      expect(
        git(fixture.root, [
          'cat-file',
          '-e',
          `${receipt.runtime_sha}^{commit}`,
        ]),
      ).toBe('');
      expect(
        git(fixture.root, [
          'rev-list',
          '--parents',
          '-n',
          '1',
          receipt.runtime_sha,
        ]).split(' '),
      ).toHaveLength(1);
    }
    expect(
      git(fixture.root, ['rev-parse', 'refs/pr2236-session-discovery/control']),
    ).toBe(control.runtime_sha);
    expect(
      git(fixture.root, [
        'rev-parse',
        'refs/pr2236-session-discovery/treatment',
      ]),
    ).toBe(treatment.runtime_sha);

    const controlSkillPaths = git(fixture.root, [
      'ls-tree',
      '-r',
      '--name-only',
      fixture.controlSha,
      'skills/diagnosing-superpowers',
    ]).split('\n');
    for (const path of controlSkillPaths) {
      expect(sha256(join(controlDir, 'package', path))).toBe(
        gitBytesSha256(fixture.root, ['show', `${fixture.controlSha}:${path}`]),
      );
    }

    const treatmentFiles = regularFiles(join(treatmentDir, 'package'));
    for (const path of REMOVED_REFERENCES) {
      expect(treatmentFiles).not.toContain(path);
    }
    const treatmentText = treatmentFiles
      .map((path) => readFileSync(join(treatmentDir, 'package', path), 'utf8'))
      .join('\n');
    expect(treatmentText).not.toContain(REMOVED_TEXT.trim());
    expect(treatmentText).not.toContain('claude-code-sessions.md');
    expect(treatmentText).not.toContain('codex-sessions.md');
    expect(treatmentText).not.toContain('other-harnesses.md');
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('rejects an archived symlink that escapes the package root', () => {
  const root = mkdtempSync(join(tmpdir(), 'pr2236-package-symlink-'));
  const outputRoot = mkdtempSync(join(tmpdir(), 'pr2236-package-output-'));
  try {
    git(root, ['init', '-q']);
    git(root, ['config', 'user.name', 'Package Test']);
    git(root, ['config', 'user.email', 'package-test@example.invalid']);
    symlinkSync('../outside', join(root, 'escape'));
    const sourceSha = commit(root, 'escaping symlink');
    expect(() =>
      buildRuntimePackage({
        sourceCheckout: root,
        sourceSha,
        outputDir: join(outputRoot, 'bad'),
        importCheckout: root,
        retainRef: 'refs/pr2236-session-discovery/bad',
      }),
    ).toThrow('escaping symlink');
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
