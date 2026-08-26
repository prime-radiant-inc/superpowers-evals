import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectProvenance } from '../src/runner/provenance.ts';

function tmpGitRepo(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'prov-'));
  const git = (a: string[]) =>
    spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  writeFileSync(join(dir, 'README.md'), 'x\n');
  git(['add', '.']);
  git(['commit', '-qm', 'init']);
  const sha = (git(['rev-parse', 'HEAD']).stdout ?? '').trim();
  return { dir, sha };
}

const base = {
  agentBinary: null,
  runHomeDir: mkdtempSync(join(tmpdir(), 'home-')),
};

// Set (or clear) one env name with a test-scoped pin.
function setEnv(name: string, value: string | undefined): void {
  // biome-ignore lint/style/noProcessEnv: test-scoped pin; withAmbient restores in finally
  if (value === undefined) delete process.env[name];
  else {
    // biome-ignore lint/style/noProcessEnv: test-scoped pin; withAmbient restores in finally
    process.env[name] = value;
  }
}

// Pin the ambient superpowers routing (SUPERPOWERS_ROOT plus the container
// REV override) around `body`, snapshotting and restoring the prior host
// values even on throw — the withAmbient pattern from the sibling
// superpowers suites.
function withAmbient(
  root: string | undefined,
  rev: string | undefined,
  body: () => void,
): void {
  // biome-ignore lint/style/noProcessEnv: snapshot the host value to restore in finally
  const prevRoot = process.env['SUPERPOWERS_ROOT'];
  // biome-ignore lint/style/noProcessEnv: snapshot the host value to restore in finally
  const prevRev = process.env['QUORUM_SUPERPOWERS_REV'];
  try {
    setEnv('SUPERPOWERS_ROOT', root);
    setEnv('QUORUM_SUPERPOWERS_REV', rev);
    body();
  } finally {
    setEnv('SUPERPOWERS_ROOT', prevRoot);
    setEnv('QUORUM_SUPERPOWERS_REV', prevRev);
  }
}

// A rev-shaped value that is never any real repository's HEAD; set as the
// REV override so a code path that wrongly consults it fails loudly.
const BOGUS_REV = 'deadbee0'.repeat(5);

test('root mode: provenance reads the threaded root, ignoring ambient and the REV override', () => {
  const { dir, sha } = tmpGitRepo();
  withAmbient('/ambient/elsewhere', BOGUS_REV, () => {
    const p = collectProvenance({
      ...base,
      repoRoot: dir,
      superpowers: { mode: 'root', root: dir },
    });
    expect(p.superpowers_rev).toBe(sha);
    expect(p.superpowers_dirty).toBe(false);
  });
});

test('none mode: rev and dirty are null even with ambient set', () => {
  withAmbient('/ambient/elsewhere', BOGUS_REV, () => {
    const p = collectProvenance({
      ...base,
      repoRoot: tmpGitRepo().dir,
      superpowers: { mode: 'none' },
    });
    expect(p.superpowers_rev).toBeNull();
    expect(p.superpowers_dirty).toBeNull();
  });
});

test('legacy: QUORUM_SUPERPOWERS_REV override still wins (unchanged)', () => {
  const { dir } = tmpGitRepo();
  withAmbient(dir, 'deadbeef'.repeat(5), () => {
    const p = collectProvenance({ ...base, repoRoot: dir });
    expect(p.superpowers_rev).toBe('deadbeef'.repeat(5));
  });
});
