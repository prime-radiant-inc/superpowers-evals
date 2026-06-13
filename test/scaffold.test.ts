import { expect, test } from 'bun:test';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkScenario,
  fixExecutableBits,
  newScenario,
  ScaffoldError,
} from '../src/scaffold.ts';

// A fresh scenarios-root directory; each test owns its own temp dir.
function scenariosRoot(): string {
  return mkdtempSync(join(tmpdir(), 'scaffold-'));
}

// Read a file's low 12 permission bits.
function permBits(path: string): number {
  return statSync(path).mode & 0o777;
}

// Strip the execute bits from a file (to drive the non-executable cases).
function clearExec(path: string): void {
  chmodSync(path, statSync(path).mode & ~0o111);
}

test('newScenario writes the three files with the right modes and content', () => {
  const root = scenariosRoot();
  const dir = newScenario(root, 'my-scenario');
  expect(dir).toBe(join(root, 'my-scenario'));

  const story = readFileSync(join(dir, 'story.md'), 'utf8');
  // {name} is interpolated into the id field.
  expect(story).toContain('id: my-scenario');
  expect(story).toContain('quorum_tier: full');
  expect(story).toContain('## Acceptance Criteria');

  const setup = readFileSync(join(dir, 'setup.sh'), 'utf8');
  expect(setup).toContain('#!/usr/bin/env bash');
  expect(setup).toContain('uv run setup-helpers run create_base_repo');
  // setup.sh chmod 0o755.
  expect(permBits(join(dir, 'setup.sh'))).toBe(0o755);

  const checks = readFileSync(join(dir, 'checks.sh'), 'utf8');
  expect(checks).toContain('pre() {');
  expect(checks).toContain('post() {');
  // checks.sh must NOT be executable.
  expect(statSync(join(dir, 'checks.sh')).mode & 0o111).toBe(0);

  rmSync(root, { recursive: true, force: true });
});

test('a fresh scenario round-trips through checkScenario with zero problems', () => {
  const root = scenariosRoot();
  const dir = newScenario(root, 'fresh');
  expect(checkScenario(dir)).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

test('newScenario throws ScaffoldError when the dir already exists', () => {
  const root = scenariosRoot();
  newScenario(root, 'dupe');
  expect(() => newScenario(root, 'dupe')).toThrow(ScaffoldError);
  rmSync(root, { recursive: true, force: true });
});

// Build a valid scenario, then let the caller mutate one file to drive a case.
function scenario(root: string, name: string): string {
  return newScenario(root, name);
}

test('checkScenario flags missing story.md', () => {
  const root = scenariosRoot();
  const dir = scenario(root, 's');
  rmSync(join(dir, 'story.md'));
  expect(checkScenario(dir)).toContain('story.md missing');
  rmSync(root, { recursive: true, force: true });
});

test('checkScenario flags frontmatter missing id and title', () => {
  const root = scenariosRoot();
  const dir = scenario(root, 's');
  writeFileSync(
    join(dir, 'story.md'),
    '---\nstatus: draft\n---\n\n## Acceptance Criteria\n- x\n',
  );
  const problems = checkScenario(dir);
  expect(problems).toContain("story.md frontmatter missing 'id'");
  expect(problems).toContain("story.md frontmatter missing 'title'");
  rmSync(root, { recursive: true, force: true });
});

test('checkScenario flags missing Acceptance Criteria section', () => {
  const root = scenariosRoot();
  const dir = scenario(root, 's');
  writeFileSync(
    join(dir, 'story.md'),
    '---\nid: s\ntitle: t\n---\n\nbody without the section\n',
  );
  expect(checkScenario(dir)).toContain(
    "story.md missing '## Acceptance Criteria' section",
  );
  rmSync(root, { recursive: true, force: true });
});

test('checkScenario flags an invalid quorum_tier', () => {
  const root = scenariosRoot();
  const dir = scenario(root, 's');
  writeFileSync(
    join(dir, 'story.md'),
    '---\nid: s\ntitle: t\nquorum_tier: bogus\n---\n\n## Acceptance Criteria\n- x\n',
  );
  expect(checkScenario(dir)).toContain(
    "story.md quorum_tier='bogus' is not valid (expected one of: sentinel, full, adhoc)",
  );
  rmSync(root, { recursive: true, force: true });
});

test('checkScenario flags a non-executable setup.sh', () => {
  const root = scenariosRoot();
  const dir = scenario(root, 's');
  clearExec(join(dir, 'setup.sh'));
  expect(checkScenario(dir)).toContain('setup.sh is not executable');
  rmSync(root, { recursive: true, force: true });
});

test('checkScenario flags an unknown setup-helpers name', () => {
  const root = scenariosRoot();
  const dir = scenario(root, 's');
  const setup = join(dir, 'setup.sh');
  writeFileSync(
    setup,
    '#!/usr/bin/env bash\nuv run setup-helpers run not_a_real_helper\n',
  );
  chmodSync(setup, 0o755);
  expect(checkScenario(dir)).toContain(
    "setup.sh references unknown helper 'not_a_real_helper'",
  );
  rmSync(root, { recursive: true, force: true });
});

test('checkScenario accepts multiple known helpers on one line', () => {
  const root = scenariosRoot();
  const dir = scenario(root, 's');
  const setup = join(dir, 'setup.sh');
  writeFileSync(
    setup,
    '#!/usr/bin/env bash\nuv run setup-helpers run create_base_repo add_worktree\n',
  );
  chmodSync(setup, 0o755);
  expect(checkScenario(dir)).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});

test('checkScenario flags a missing checks.sh', () => {
  const root = scenariosRoot();
  const dir = scenario(root, 's');
  rmSync(join(dir, 'checks.sh'));
  expect(checkScenario(dir)).toContain('checks.sh missing');
  rmSync(root, { recursive: true, force: true });
});

test('checkScenario flags a checks.sh bash syntax error (real bash -n)', () => {
  const root = scenariosRoot();
  const dir = scenario(root, 's');
  // An unterminated function body is a real bash -n parse error.
  writeFileSync(join(dir, 'checks.sh'), 'pre() {\n  git-repo\n');
  const problems = checkScenario(dir);
  expect(problems.some((p) => p.startsWith('checks.sh syntax error:'))).toBe(
    true,
  );
  rmSync(root, { recursive: true, force: true });
});

test('checkScenario flags missing pre() and post()', () => {
  const root = scenariosRoot();
  const dir = scenario(root, 's');
  // Valid bash, functions-only, but neither pre nor post is defined.
  writeFileSync(join(dir, 'checks.sh'), 'other() {\n  :\n}\n');
  const problems = checkScenario(dir);
  expect(problems).toContain('checks.sh missing pre() function');
  expect(problems).toContain('checks.sh missing post() function');
  rmSync(root, { recursive: true, force: true });
});

test('checkScenario flags a top-level statement (functions-only)', () => {
  const root = scenariosRoot();
  const dir = scenario(root, 's');
  writeFileSync(
    join(dir, 'checks.sh'),
    'echo hello\npre() {\n  :\n}\npost() {\n  :\n}\n',
  );
  const problems = checkScenario(dir);
  expect(problems).toContain(
    "checks.sh must be functions-only (top-level statement: 'echo hello')",
  );
  rmSync(root, { recursive: true, force: true });
});

test('checkScenario flags a backgrounded check (trailing &)', () => {
  const root = scenariosRoot();
  const dir = scenario(root, 's');
  writeFileSync(
    join(dir, 'checks.sh'),
    'pre() {\n  git-repo &\n}\npost() {\n  :\n}\n',
  );
  const problems = checkScenario(dir);
  expect(problems).toContain(
    'checks.sh:2: backgrounded check (`&`) is unsupported',
  );
  rmSync(root, { recursive: true, force: true });
});

test('checkScenario flags a $QUORUM_WORKDIR reference', () => {
  const root = scenariosRoot();
  const dir = scenario(root, 's');
  writeFileSync(
    join(dir, 'checks.sh'),
    'pre() {\n  file-exists "$QUORUM_WORKDIR/x"\n}\npost() {\n  :\n}\n',
  );
  const problems = checkScenario(dir);
  expect(problems).toContain(
    'checks.sh:2: $QUORUM_WORKDIR is not available; cwd is the workdir — use relative paths',
  );
  rmSync(root, { recursive: true, force: true });
});

test('fixExecutableBits flips a cleared setup.sh bit and returns ["setup.sh"]', () => {
  const root = scenariosRoot();
  const dir = scenario(root, 's');
  clearExec(join(dir, 'setup.sh'));
  expect(statSync(join(dir, 'setup.sh')).mode & 0o111).toBe(0);

  const fixed = fixExecutableBits(dir);
  expect(fixed).toEqual(['setup.sh']);
  expect(statSync(join(dir, 'setup.sh')).mode & 0o111).not.toBe(0);

  // Idempotent: a second pass fixes nothing.
  expect(fixExecutableBits(dir)).toEqual([]);
  rmSync(root, { recursive: true, force: true });
});
