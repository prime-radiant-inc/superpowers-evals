import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const scenario = join(
  import.meta.dir,
  '..',
  'scenarios',
  'brainstorming-spec-handoff-source-identity',
);

function fixture(path: string): string {
  return readFileSync(join(scenario, 'fixtures', path), 'utf8');
}

test('source-identity scenario exists as an independent frozen challenge', () => {
  expect(existsSync(scenario)).toBe(true);
  expect(readFileSync(join(scenario, 'codex.config.toml'), 'utf8')).toContain(
    'model = "gpt-5.6-luna"',
  );
});

test('repository makes path, job, and content partial identities', () => {
  const cli = fixture('src/cli.js');
  const worker = fixture('src/worker.js');
  const fingerprint = fixture('src/source-fingerprint.js');
  const migration = fixture('migrations/001-create-import-tables.sql');

  expect(cli).toContain('locator: path');
  expect(worker).toContain('job.id');
  expect(worker).toContain('job.readSourceRevision()');
  expect(worker).toContain('job.stageSource(upload.contents)');
  expect(fingerprint).toContain("createHash('sha256')");
  expect(migration).toContain('source_locator TEXT NOT NULL');
  expect(migration).not.toContain('source_fingerprint');
});

test('repository exposes parser semantics that content-only identity misses', () => {
  const worker = fixture('src/worker.js');
  const source = fixture('src/file-source.js');

  expect(worker).toContain('job.resolveParser(job.parserProfile)');
  expect(worker).toContain('job.readSourceRevision()');
  expect(worker).toContain('sourceVersion: upload.version');
  expect(source).toContain('fingerprint()');
  expect(source).toContain('fingerprintContents(this.contents)');
  expect(source).not.toContain('parserProfile');
});

test('story preserves no-plan workflow without disclosing an identity design', () => {
  const story = readFileSync(join(scenario, 'story.md'), 'utf8');

  expect(story).toContain('stop before writing the implementation plan');
  expect(story).toContain(
    'The repository itself contains additional architectural evidence.',
  );
  expect(story).not.toContain('source descriptor');
  expect(story).not.toContain('logical locator');
  expect(story).not.toContain('content fingerprint');
});

test('scenario installs first and final artifact capture before the actor starts', () => {
  const setup = readFileSync(join(scenario, 'setup.sh'), 'utf8');

  expect(setup).toContain(
    'brainstorming-evidence.ts" install "$PWD" "$QUORUM_CODING_AGENT_HOME"',
  );
});
