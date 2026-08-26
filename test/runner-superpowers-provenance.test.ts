import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunnerError } from '../src/runner/errors.ts';
import { runScenario } from '../src/runner/index.ts';
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
// REV and DIRTY overrides) around `body`, snapshotting and restoring the
// prior host values even on throw — these tests share one process, so a pin
// left behind would leak into every later test's ambient read.
async function withAmbient(
  root: string | undefined,
  rev: string | undefined,
  dirty: string | undefined,
  body: () => void | Promise<void>,
): Promise<void> {
  // biome-ignore lint/style/noProcessEnv: snapshot the host value to restore in finally
  const prevRoot = process.env['SUPERPOWERS_ROOT'];
  // biome-ignore lint/style/noProcessEnv: snapshot the host value to restore in finally
  const prevRev = process.env['QUORUM_SUPERPOWERS_REV'];
  // biome-ignore lint/style/noProcessEnv: snapshot the host value to restore in finally
  const prevDirty = process.env['QUORUM_SUPERPOWERS_DIRTY'];
  try {
    setEnv('SUPERPOWERS_ROOT', root);
    setEnv('QUORUM_SUPERPOWERS_REV', rev);
    setEnv('QUORUM_SUPERPOWERS_DIRTY', dirty);
    await body();
  } finally {
    setEnv('SUPERPOWERS_ROOT', prevRoot);
    setEnv('QUORUM_SUPERPOWERS_REV', prevRev);
    setEnv('QUORUM_SUPERPOWERS_DIRTY', prevDirty);
  }
}

// A rev-shaped value that is never any real repository's HEAD; set as the
// REV override so a code path that wrongly consults it fails loudly. The
// DIRTY override is pinned to the lying 'true' the same way: the explicit
// modes probe clean fixture repos, so a path consulting hostDirty() flips
// the assertion.
const BOGUS_REV = 'deadbee0'.repeat(5);

test('root mode: provenance reads the threaded root, ignoring ambient and the REV/DIRTY overrides', async () => {
  const { dir, sha } = tmpGitRepo();
  await withAmbient('/ambient/elsewhere', BOGUS_REV, 'true', () => {
    const p = collectProvenance({
      ...base,
      repoRoot: dir,
      superpowers: { mode: 'root', root: dir },
    });
    expect(p.superpowers_rev).toBe(sha);
    expect(p.superpowers_dirty).toBe(false);
  });
});

test('none mode: rev and dirty are null even with ambient set', async () => {
  await withAmbient('/ambient/elsewhere', BOGUS_REV, 'true', () => {
    const p = collectProvenance({
      ...base,
      repoRoot: tmpGitRepo().dir,
      superpowers: { mode: 'none' },
    });
    expect(p.superpowers_rev).toBeNull();
    expect(p.superpowers_dirty).toBeNull();
  });
});

test('legacy: QUORUM_SUPERPOWERS_REV override still wins (unchanged)', async () => {
  const { dir } = tmpGitRepo();
  await withAmbient(dir, 'deadbeef'.repeat(5), undefined, () => {
    const p = collectProvenance({ ...base, repoRoot: dir });
    expect(p.superpowers_rev).toBe('deadbeef'.repeat(5));
  });
});

// The two loud-at-start rejections live at the very top of runScenario: a
// rejected combination must fail before ANY side effect — no run dir is
// allocated, onRunDir never fires. The coding-agents dir is deliberately an
// empty temp dir: whenever a rejection is missed, the run still dies fast at
// the unknown-coding-agent guard without spawning a provisioning subprocess,
// keeping the miss path hermetic.
function expectLoudAtStart(
  args: Omit<Parameters<typeof runScenario>[0], 'outRoot' | 'onRunDir'>,
  message: string,
): Promise<void> {
  const outRoot = mkdtempSync(join(tmpdir(), 'out-'));
  let allocated: string | null = null;
  const capture = async (): Promise<void> => {
    let caught: unknown;
    try {
      await runScenario({
        ...args,
        outRoot,
        onRunDir: (dir) => {
          allocated = dir;
        },
      });
    } catch (e: unknown) {
      caught = e;
    }
    // Full-message equality on the captured error — toThrow(string) is
    // substring-matching and cannot prove the verbatim contract.
    expect(caught).toBeInstanceOf(RunnerError);
    const err = caught as RunnerError;
    expect(err.message).toBe(message);
    expect(err.stage).toBe('setup');
    // Rejection precedes allocation: no run dir exists and the allocation
    // callback never fired.
    expect(allocated).toBeNull();
    expect(readdirSync(outRoot)).toEqual([]);
  };
  return capture();
}

test('runScenario rejects QUORUM_SUPERPOWERS_REV under an explicit mode, before allocating a run dir', async () => {
  await withAmbient(undefined, BOGUS_REV, undefined, () =>
    expectLoudAtStart(
      {
        scenarioDir: mkdtempSync(join(tmpdir(), 'scn-')),
        codingAgent: 'claude',
        codingAgentsDir: mkdtempSync(join(tmpdir(), 'agents-')),
        superpowers: { mode: 'none' },
      },
      'QUORUM_SUPERPOWERS_REV is set while an explicit superpowers mode is active — it would stamp a rev the run never used',
    ),
  );
});

test('runScenario rejects an explicit mode under a non-linux os, before allocating a run dir', async () => {
  await withAmbient(undefined, undefined, undefined, () =>
    expectLoudAtStart(
      {
        scenarioDir: mkdtempSync(join(tmpdir(), 'scn-')),
        codingAgent: 'claude',
        codingAgentsDir: mkdtempSync(join(tmpdir(), 'agents-')),
        os: 'windows',
        superpowers: { mode: 'root', root: mkdtempSync(join(tmpdir(), 'sp-')) },
      },
      'explicit superpowers modes are not supported with --os windows (mixed-state rejection)',
    ),
  );
});

test('gauntletBinary: the version probe runs the supplied wrapper, never the PATH gauntlet', () => {
  const bin = mkdtempSync(join(tmpdir(), 'bin-'));
  const wrapperMarker = join(bin, 'wrapper-ran');
  const pathMarker = join(bin, 'path-gauntlet-ran');
  const wrapper = join(bin, 'gauntlet-snapshot');
  writeFileSync(
    wrapper,
    `#!/bin/sh\necho ran > '${wrapperMarker}'\necho "gauntlet-snapshot 7.7.7"\n`,
  );
  // A distinct fake on PATH: if the probe ever resolved the bare 'gauntlet'
  // name instead of the supplied wrapper, this one's version line and marker
  // would show up.
  writeFileSync(
    join(bin, 'gauntlet'),
    `#!/bin/sh\necho ran > '${pathMarker}'\necho "gauntlet-on-PATH 0.0.1"\n`,
  );
  spawnSync('chmod', ['+x', wrapper, join(bin, 'gauntlet')]);
  // biome-ignore lint/style/noProcessEnv: pin PATH so the bare name resolves to the fake; restored in finally
  const prevPath = process.env['PATH'];
  // biome-ignore lint/style/noProcessEnv: pin PATH so the bare name resolves to the fake; restored in finally
  process.env['PATH'] = `${bin}:${prevPath ?? ''}`;
  try {
    const p = collectProvenance({
      ...base,
      repoRoot: tmpGitRepo().dir,
      gauntletBinary: wrapper,
    });
    expect(p.gauntlet_version).toBe('gauntlet-snapshot 7.7.7');
    expect(existsSync(wrapperMarker)).toBe(true);
    expect(existsSync(pathMarker)).toBe(false);
  } finally {
    if (prevPath === undefined) {
      // biome-ignore lint/style/noProcessEnv: restore the snapshotted host value
      delete process.env['PATH'];
    } else {
      // biome-ignore lint/style/noProcessEnv: restore the snapshotted host value
      process.env['PATH'] = prevPath;
    }
  }
});
