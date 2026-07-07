import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { collectProvenance } from '../src/runner/provenance.ts';

const REPO = resolve(import.meta.dir, '..');

function git(cwd: string, ...args: string[]): string {
  const p = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return (p.stdout ?? '').trim();
}

// A tiny throwaway git repo standing in for $SUPERPOWERS_ROOT.
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sp-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync(
    'git',
    [
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '--allow-empty',
      '-qm',
      'x',
    ],
    { cwd: dir },
  );
  return dir;
}

test('collectProvenance reads superpowers rev + dirty flag from SUPERPOWERS_ROOT', () => {
  const sproot = makeRepo();
  const prev = process.env['SUPERPOWERS_ROOT'];
  process.env['SUPERPOWERS_ROOT'] = sproot;
  try {
    const p = collectProvenance({ repoRoot: REPO, agentBinary: null });
    expect(p.superpowers_rev).toBe(git(sproot, 'rev-parse', 'HEAD'));
    expect(p.superpowers_dirty).toBe(false);
    writeFileSync(join(sproot, 'dirt.txt'), 'x');
    expect(
      collectProvenance({ repoRoot: REPO, agentBinary: null })
        .superpowers_dirty,
    ).toBe(true);
  } finally {
    if (prev === undefined) delete process.env['SUPERPOWERS_ROOT'];
    else process.env['SUPERPOWERS_ROOT'] = prev;
  }
});

test('collectProvenance reads the harness rev from repoRoot', () => {
  const p = collectProvenance({ repoRoot: REPO, agentBinary: null });
  expect(p.harness_rev).toBe(git(REPO, 'rev-parse', 'HEAD'));
});

test('collectProvenance probes the agent CLI version via --version', () => {
  // A fake agent binary on a scoped PATH.
  const bin = mkdtempSync(join(tmpdir(), 'bin-'));
  const fake = join(bin, 'fake-agent');
  writeFileSync(fake, '#!/bin/sh\necho "fake-agent 9.9.9"\n');
  spawnSync('chmod', ['+x', fake]);
  const prevPath = process.env['PATH'];
  process.env['PATH'] = `${bin}:${prevPath ?? ''}`;
  try {
    const p = collectProvenance({ repoRoot: REPO, agentBinary: 'fake-agent' });
    expect(p.agent_cli_version).toBe('fake-agent 9.9.9');
  } finally {
    process.env['PATH'] = prevPath ?? '';
  }
});

test('collectProvenance never throws: every probe failure is a null field', () => {
  const prev = process.env['SUPERPOWERS_ROOT'];
  process.env['SUPERPOWERS_ROOT'] = '/nonexistent/definitely-not-a-repo';
  try {
    const p = collectProvenance({
      repoRoot: mkdtempSync(join(tmpdir(), 'notrepo-')),
      agentBinary: 'definitely-not-a-binary-xyz',
    });
    expect(p.superpowers_rev).toBe(null);
    expect(p.superpowers_dirty).toBe(null);
    expect(p.harness_rev).toBe(null);
    expect(p.agent_cli_version).toBe(null);
  } finally {
    if (prev === undefined) delete process.env['SUPERPOWERS_ROOT'];
    else process.env['SUPERPOWERS_ROOT'] = prev;
  }
});
