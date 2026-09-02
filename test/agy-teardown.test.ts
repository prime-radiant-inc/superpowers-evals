import { describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findRunTmuxServer,
  gauntletScratchDirForRun,
  killRunTmuxServer,
  killTmuxServer,
} from '../src/agents/agy-teardown.ts';
import type {
  CommandResult,
  CommandRunner,
} from '../src/agents/command-runner.ts';
import { makeTempHome } from './provision-helpers.ts';

// A CommandRunner that records every tmux invocation and answers list-panes for
// a named socket from a canned pane->stdout map. Mirrors the Python
// test_agy_teardown.py make_runner injection.
function makeRunner(panes: Record<string, string>): {
  runner: CommandRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: CommandRunner = {
    run(command: string, args: readonly string[]): CommandResult {
      calls.push([command, ...args]);
      let stdout = '';
      if (args.includes('list-panes')) {
        const name = args[1] ?? ''; // ['-L', <name>, 'list-panes', ...]
        stdout = panes[name] ?? '';
      }
      return { status: 0, stdout, stderr: '' };
    },
  };
  return { runner, calls };
}

describe('killRunTmuxServer', () => {
  test('kills the server whose pane started in the scratch dir', () => {
    const { home, cleanup } = makeTempHome();
    try {
      const scratch = join(home.workdir, 'gauntlet-agent', 'scratch');
      mkdirSync(scratch, { recursive: true });
      const { runner, calls } = makeRunner({
        'gauntlet-1-aaaaaa': '/some/other/scratch\n',
        'gauntlet-2-bbbbbb': `${scratch}\n`,
      });
      const killed = killRunTmuxServer(scratch, {
        runner,
        listSockets: () => ['gauntlet-1-aaaaaa', 'gauntlet-2-bbbbbb'],
      });
      expect(killed).toBe(true);
      expect(calls).toContainEqual([
        'tmux',
        '-L',
        'gauntlet-2-bbbbbb',
        'kill-server',
      ]);
      expect(calls).not.toContainEqual([
        'tmux',
        '-L',
        'gauntlet-1-aaaaaa',
        'kill-server',
      ]);
    } finally {
      cleanup();
    }
  });

  test('no gauntlet sockets returns false', () => {
    const { home, cleanup } = makeTempHome();
    try {
      const killed = killRunTmuxServer(home.workdir, {
        runner: { run: () => ({ status: 0, stdout: '', stderr: '' }) },
        listSockets: () => [],
      });
      expect(killed).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('does not false-match a sibling dir (resolved-path equality)', () => {
    const { home, cleanup } = makeTempHome();
    try {
      const scratch = join(home.workdir, 'gauntlet-agent', 'scratch');
      mkdirSync(scratch, { recursive: true });
      const sibling = join(home.workdir, 'gauntlet-agent', 'scratch-extra');
      mkdirSync(sibling, { recursive: true });
      const { runner, calls } = makeRunner({
        'gauntlet-1-aaaaaa': `${sibling}\n`,
      });
      const killed = killRunTmuxServer(scratch, {
        runner,
        listSockets: () => ['gauntlet-1-aaaaaa'],
      });
      expect(killed).toBe(false);
      expect(calls).not.toContainEqual([
        'tmux',
        '-L',
        'gauntlet-1-aaaaaa',
        'kill-server',
      ]);
    } finally {
      cleanup();
    }
  });

  test('matches a pane path by realpath across a symlinked scratch dir', () => {
    // The antigravity visible-workspace lives under tmpdir(); on macOS
    // /tmp -> /private/tmp, so tmux may report the realpath while quorum holds
    // the symlinked path (or vice versa). The kill must still fire. resolve()
    // is purely lexical and would miss this; realpath resolution must not.
    const base = mkdtempSync(join(realpathSync(tmpdir()), 'agy-teardown-'));
    try {
      const realScratch = join(base, 'real-scratch');
      mkdirSync(realScratch, { recursive: true });
      const linkScratch = join(base, 'link-scratch');
      symlinkSync(realScratch, linkScratch);

      // quorum holds the symlinked path; tmux reports the realpath.
      const { runner, calls } = makeRunner({
        'gauntlet-1-aaaaaa': `${realScratch}\n`,
      });
      const killed = killRunTmuxServer(linkScratch, {
        runner,
        listSockets: () => ['gauntlet-1-aaaaaa'],
      });
      expect(killed).toBe(true);
      expect(calls).toContainEqual([
        'tmux',
        '-L',
        'gauntlet-1-aaaaaa',
        'kill-server',
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('stops at the first match and never queries later sockets', () => {
    const { home, cleanup } = makeTempHome();
    try {
      const scratch = join(home.workdir, 'gauntlet-agent', 'scratch');
      mkdirSync(scratch, { recursive: true });
      const { runner, calls } = makeRunner({
        'gauntlet-1-aaaaaa': `${scratch}\n`,
        'gauntlet-2-bbbbbb': '/some/other/path\n',
      });
      const killed = killRunTmuxServer(scratch, {
        runner,
        listSockets: () => ['gauntlet-1-aaaaaa', 'gauntlet-2-bbbbbb'],
      });
      expect(killed).toBe(true);
      const listPanesTargets = calls
        .filter((c) => c.includes('list-panes'))
        .map((c) => c[2]);
      expect(listPanesTargets).not.toContain('gauntlet-2-bbbbbb');
    } finally {
      cleanup();
    }
  });
});

// The probe-only half of the kill: the campaign's verified subject-host kill
// needs to ask "which server hosts this run?" without signalling anything, so
// it can verify death by re-probing after the kill.
describe('findRunTmuxServer', () => {
  test('names the server whose pane started in the scratch dir without killing it', () => {
    const { home, cleanup } = makeTempHome();
    try {
      const scratch = join(home.workdir, 'gauntlet-agent', 'scratch');
      mkdirSync(scratch, { recursive: true });
      const { runner, calls } = makeRunner({
        'gauntlet-1-aaaaaa': '/some/other/scratch\n',
        'gauntlet-2-bbbbbb': `${scratch}\n`,
      });
      const found = findRunTmuxServer(scratch, {
        runner,
        listSockets: () => ['gauntlet-1-aaaaaa', 'gauntlet-2-bbbbbb'],
      });
      expect(found).toBe('gauntlet-2-bbbbbb');
      expect(calls.some((c) => c.includes('kill-server'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('returns null when no gauntlet server hosts the scratch dir', () => {
    const { home, cleanup } = makeTempHome();
    try {
      const scratch = join(home.workdir, 'gauntlet-agent', 'scratch');
      mkdirSync(scratch, { recursive: true });
      const { runner } = makeRunner({
        'gauntlet-1-aaaaaa': '/some/other/scratch\n',
      });
      expect(
        findRunTmuxServer(scratch, {
          runner,
          listSockets: () => ['gauntlet-1-aaaaaa'],
        }),
      ).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe('killTmuxServer', () => {
  test('dispatches kill-server against the named private server', () => {
    const { runner, calls } = makeRunner({});
    killTmuxServer('gauntlet-9-zzzzzz', { runner });
    expect(calls).toEqual([['tmux', '-L', 'gauntlet-9-zzzzzz', 'kill-server']]);
  });
});

// The run-dir -> scratch-dir locator: gauntlet mints its own run id under
// <runDir>/gauntlet-agent/results/<runId>/scratch; quorum is single-run-per-dir
// so the last such scratch dir is the run's.
describe('gauntletScratchDirForRun', () => {
  test('returns the run scratch dir', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'run-'));
    try {
      const scratch = join(runDir, 'gauntlet-agent', 'results', 'r1', 'scratch');
      mkdirSync(scratch, { recursive: true });
      expect(gauntletScratchDirForRun(runDir)).toBe(scratch);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  test('returns null when gauntlet never started (no results dir, no scratch)', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'run-'));
    try {
      expect(gauntletScratchDirForRun(runDir)).toBeNull();
      mkdirSync(join(runDir, 'gauntlet-agent', 'results'), { recursive: true });
      expect(gauntletScratchDirForRun(runDir)).toBeNull();
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });

  test('picks the last scratch dir when several exist', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'run-'));
    try {
      const a = join(runDir, 'gauntlet-agent', 'results', 'aaa', 'scratch');
      const z = join(runDir, 'gauntlet-agent', 'results', 'zzz', 'scratch');
      mkdirSync(a, { recursive: true });
      mkdirSync(z, { recursive: true });
      expect(gauntletScratchDirForRun(runDir)).toBe(z);
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});
