import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

// A primary repo plus a linked worktree cut from it (`git worktree add`),
// with the primary's `.git` directory renamed out of the way afterward. This
// reproduces exactly what the in-container view of a `cp-arm-*` worktree
// mount looks like: the worktree's `.git` file is a `gitdir:` pointer into
// the primary checkout's `.git/worktrees/<name>`, and that primary `.git` is
// not mounted into the container, so any git command run against the
// worktree fails.
function makeUnreachableLinkedWorktree(): {
  worktree: string;
  headSha: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'sp-worktree-'));
  const primary = join(root, 'primary');
  const worktree = join(root, 'linked-wt');
  spawnSync('git', ['init', '-q', primary]);
  spawnSync(
    'git',
    [
      '-C',
      primary,
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '--allow-empty',
      '-qm',
      'x',
    ],
    { cwd: primary },
  );
  const headSha = git(primary, 'rev-parse', 'HEAD');
  spawnSync('git', [
    '-C',
    primary,
    'worktree',
    'add',
    '-q',
    '-b',
    'wt-branch',
    worktree,
  ]);
  // Simulate the container's mount boundary: the primary checkout (and its
  // `.git`, which the worktree's gitdir pointer resolves into) is not part
  // of what gets bind-mounted -- only the worktree directory is.
  spawnSync('mv', [join(primary, '.git'), join(root, 'primary-git-hidden')]);
  return { worktree, headSha };
}

test('collectProvenance returns null superpowers_rev for a linked worktree whose primary .git is unreachable (RED: root cause of PRI-2494 item 22)', () => {
  const { worktree, headSha } = makeUnreachableLinkedWorktree();
  const prev = process.env['SUPERPOWERS_ROOT'];
  process.env['SUPERPOWERS_ROOT'] = worktree;
  try {
    // The in-container `git -C <worktree> rev-parse HEAD` genuinely fails
    // here (proven directly, not assumed) because the worktree's `.git`
    // file points at a now-unreachable primary `.git`.
    const directProbe = spawnSync('git', ['-C', worktree, 'rev-parse', 'HEAD']);
    expect(directProbe.status).not.toBe(0);
    expect(headSha).not.toBe('');

    const p = collectProvenance({ repoRoot: REPO, agentBinary: null });
    expect(p.superpowers_rev).toBe(null);
  } finally {
    if (prev === undefined) delete process.env['SUPERPOWERS_ROOT'];
    else process.env['SUPERPOWERS_ROOT'] = prev;
  }
});

test('collectProvenance uses the QUORUM_SUPERPOWERS_REV host override for a linked worktree (GREEN: the fix)', () => {
  const { worktree, headSha } = makeUnreachableLinkedWorktree();
  const prevRoot = process.env['SUPERPOWERS_ROOT'];
  const prevRev = process.env['QUORUM_SUPERPOWERS_REV'];
  process.env['SUPERPOWERS_ROOT'] = worktree;
  process.env['QUORUM_SUPERPOWERS_REV'] = headSha;
  try {
    const p = collectProvenance({ repoRoot: REPO, agentBinary: null });
    expect(p.superpowers_rev).toBe(headSha);
  } finally {
    if (prevRoot === undefined) delete process.env['SUPERPOWERS_ROOT'];
    else process.env['SUPERPOWERS_ROOT'] = prevRoot;
    if (prevRev === undefined) delete process.env['QUORUM_SUPERPOWERS_REV'];
    else process.env['QUORUM_SUPERPOWERS_REV'] = prevRev;
  }
});

test('collectProvenance prefers a live in-container rev-parse over a stale QUORUM_SUPERPOWERS_REV when both are unset/empty', () => {
  const sproot = makeRepo();
  const prevRoot = process.env['SUPERPOWERS_ROOT'];
  const prevRev = process.env['QUORUM_SUPERPOWERS_REV'];
  process.env['SUPERPOWERS_ROOT'] = sproot;
  process.env['QUORUM_SUPERPOWERS_REV'] = '';
  try {
    const p = collectProvenance({ repoRoot: REPO, agentBinary: null });
    expect(p.superpowers_rev).toBe(git(sproot, 'rev-parse', 'HEAD'));
  } finally {
    if (prevRoot === undefined) delete process.env['SUPERPOWERS_ROOT'];
    else process.env['SUPERPOWERS_ROOT'] = prevRoot;
    if (prevRev === undefined) delete process.env['QUORUM_SUPERPOWERS_REV'];
    else process.env['QUORUM_SUPERPOWERS_REV'] = prevRev;
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

// The battery that silently ran a stale PATH binary also reported os "linux"
// on a Darwin host; provenance now records where the run actually executed.
test('collectProvenance records the host platform', () => {
  const p = collectProvenance({ repoRoot: REPO, agentBinary: null });
  expect(p.host_platform).toBe(process.platform);
});

// F13: the version probes spawn third-party binaries (the agent CLI and
// gauntlet) — real children whose environment a same-named hostile export
// would otherwise ride into. Both must receive the probe projection, never the
// host provider bundle. Proven through real spawned children dumping their env.
test('version probe children never see the host provider bundle', () => {
  const bin = mkdtempSync(join(tmpdir(), 'bin-'));
  const agentDump = join(bin, 'agent-env-dump.txt');
  const gauntletDump = join(bin, 'gauntlet-env-dump.txt');
  const fakeAgent = join(bin, 'fake-agent');
  writeFileSync(
    fakeAgent,
    `#!/bin/sh\nenv > '${agentDump}'\necho "fake-agent 1.0.0"\n`,
  );
  const fakeGauntlet = join(bin, 'gauntlet');
  writeFileSync(
    fakeGauntlet,
    `#!/bin/sh\nenv > '${gauntletDump}'\necho "gauntlet 2.0.0"\n`,
  );
  spawnSync('chmod', ['+x', fakeAgent, fakeGauntlet]);

  const HOSTILE: Record<string, string> = {
    OPENAI_API_KEY: 'sk-host-openai',
    ANTHROPIC_API_KEY: 'sk-host-anthropic',
    OPENROUTER_API_KEY: 'sk-host-openrouter',
    GEMINI_API_KEY: 'sk-host-gemini',
    KIMI_MODEL_API_KEY: 'sk-host-kimi',
    AWS_SECRET_ACCESS_KEY: 'host-aws-secret',
    AWS_SESSION_TOKEN: 'host-aws-session',
    AWS_BEARER_TOKEN_BEDROCK: 'host-bedrock',
    SOME_RANDOM_HOST_VAR: 'leaked',
  };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(HOSTILE)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const prevPath = process.env['PATH'];
  process.env['PATH'] = `${bin}:${prevPath ?? ''}`;
  try {
    const p = collectProvenance({ repoRoot: REPO, agentBinary: 'fake-agent' });
    expect(p.agent_cli_version).toBe('fake-agent 1.0.0');
    expect(p.gauntlet_version).toBe('gauntlet 2.0.0');
    for (const dumpPath of [agentDump, gauntletDump]) {
      const dumped: Record<string, string> = {};
      for (const line of readFileSync(dumpPath, 'utf8').split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) dumped[line.slice(0, eq)] = line.slice(eq + 1);
      }
      for (const k of Object.keys(HOSTILE)) {
        expect({ dump: dumpPath, key: k, value: dumped[k] }).toEqual({
          dump: dumpPath,
          key: k,
          value: undefined,
        });
      }
      // The probe routing survives: PATH resolves the binary, HOME routes the
      // probed CLI's own config reads.
      expect(dumped['PATH']).toBeTruthy();
      expect(dumped['HOME']).toBe(process.env['HOME'] ?? '');
    }
  } finally {
    process.env['PATH'] = prevPath ?? '';
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
