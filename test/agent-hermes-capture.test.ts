import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  exportHermesSessions,
  HERMES_CAPTURE_TIMEOUT_MS,
  HermesCaptureError,
  HermesTimeoutError,
  hermesEnv,
  hermesRunEnv,
  runHermesCommand,
  type SpawnFn,
  type SpawnResult,
  snapshotHermesSessions,
} from '../src/agents/hermes-capture.ts';

// Mirrors test/agent-opencode-capture.test.ts's structure, adapted for the
// real hermes CLI facts verified live in a container probe: `sessions list`
// is a plain table (no --format json), session ids are the LAST
// whitespace-separated token on a data row (shape \d{8}_\d{6}_[0-9a-f]+), and
// `sessions export --format jsonl --session-id <id> -` writes one JSON object
// to stdout per session (the trailing `-` selects stdout).

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'hermes-capture-test-'));
}

function rmrf(p: string): void {
  rmSync(p, { recursive: true, force: true });
}

function completed(stdout: string, stderr = '', exitCode = 0): SpawnResult {
  return { stdout, stderr, exitCode };
}

// A realistic `hermes sessions list` table: header + separator rows (whose
// last token never matches the session-id shape) plus data rows whose last
// column is the session id.
function fakeSessionListTable(ids: string[]): string {
  const lines = [
    'STARTED              TITLE                 MESSAGES  SESSION',
    '-------------------------------------------------------------',
    ...ids.map(
      (id) => `2026-07-23 21:26:58  untitled session      4         ${id}`,
    ),
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// hermesEnv — HOME + XDG isolation only (no config-dir override: HERMES_HOME
// defaults to $HOME/.hermes, matching the launcher's omission of HERMES_HOME).
// ---------------------------------------------------------------------------

test('hermesEnv isolates home and XDG dirs with no extra config-dir override', () => {
  const home = join(makeTmpDir(), 'home');
  try {
    expect(hermesEnv(home)).toEqual({
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_STATE_HOME: join(home, '.local', 'state'),
      XDG_CACHE_HOME: join(home, '.cache'),
      TMPDIR: join(home, '.tmp'),
    });
  } finally {
    rmrf(home);
  }
});

// ---------------------------------------------------------------------------
// hermesRunEnv — allowlist filter + defaults + XDG overlay
// ---------------------------------------------------------------------------

test('hermesRunEnv filters host env to the allowlist and overlays XDG isolation', () => {
  const home = join(makeTmpDir(), 'home');
  const orig = { ...process.env };
  process.env['SUPERPOWERS_ROOT'] = '/real/superpowers';
  process.env['HTTP_PROXY'] = 'http://leak';
  process.env['OPENROUTER_API_KEY'] = 'or-test';
  process.env['PATH'] = '/custom/bin';
  try {
    const env = hermesRunEnv(home);
    expect(env['OPENROUTER_API_KEY']).toBe('or-test');
    expect(env['PATH']).toBe('/custom/bin');
    expect(env['HOME']).toBe(home);
    expect('SUPERPOWERS_ROOT' in env).toBe(false);
    expect('HTTP_PROXY' in env).toBe(false);
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in orig)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(orig)) {
      if (v !== undefined) process.env[k] = v;
    }
  }
});

test('hermesRunEnv setdefaults PATH/TERM/LANG when absent', () => {
  const home = join(makeTmpDir(), 'home');
  const orig = { ...process.env };
  delete process.env['PATH'];
  delete process.env['TERM'];
  delete process.env['LANG'];
  try {
    const env = hermesRunEnv(home);
    expect(env['PATH']).toBe('/bin:/usr/bin');
    expect(env['TERM']).toBe('xterm-256color');
    expect(env['LANG']).toBe('C.UTF-8');
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in orig)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(orig)) {
      if (v !== undefined) process.env[k] = v;
    }
  }
});

// ---------------------------------------------------------------------------
// runHermesCommand — prefixes "hermes", uses launchCwd + allowlisted env
// ---------------------------------------------------------------------------

test('runHermesCommand prefixes hermes and passes allowlisted env + cwd', () => {
  const home = join(makeTmpDir(), 'home');
  const orig = { ...process.env };
  process.env['OPENROUTER_API_KEY'] = 'or-real';
  process.env['SUPERPOWERS_ROOT'] = '/leak';
  try {
    let seen:
      | { args: string[]; cwd: string; env: Record<string, string> }
      | undefined;
    const spawn: SpawnFn = (opts) => {
      seen = { args: opts.args, cwd: opts.cwd, env: opts.env };
      return completed('ok');
    };
    const result = runHermesCommand(['sessions', 'list'], {
      hermesHome: home,
      launchCwd: '/launch/here',
      spawn,
    });
    expect(result.stdout).toBe('ok');
    expect(seen?.args).toEqual(['hermes', 'sessions', 'list']);
    expect(seen?.cwd).toBe('/launch/here');
    expect(seen?.env['OPENROUTER_API_KEY']).toBe('or-real');
    expect('SUPERPOWERS_ROOT' in (seen?.env ?? {})).toBe(false);
    expect(seen?.env['HOME']).toBe(home);
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in orig)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(orig)) {
      if (v !== undefined) process.env[k] = v;
    }
  }
});

// ---------------------------------------------------------------------------
// snapshotHermesSessions — table parsing is defensive: header/separator rows
// are skipped because their last token never matches the session-id shape.
// ---------------------------------------------------------------------------

test('snapshotHermesSessions parses session ids from the table, skipping header/separator rows', () => {
  const tmp = makeTmpDir();
  try {
    const home = join(tmp, 'home');
    const launchCwd = join(tmp, 'project');
    mkdirSync(launchCwd, { recursive: true });
    const spawn: SpawnFn = (opts) => {
      expect(opts.args).toEqual(['hermes', 'sessions', 'list']);
      expect(opts.cwd).toBe(launchCwd);
      return completed(
        fakeSessionListTable([
          '20260723_212658_b572cd',
          '20260723_209999_aa11ff',
        ]),
      );
    };
    expect(snapshotHermesSessions({ home, launchCwd, spawn })).toEqual(
      new Set(['20260723_212658_b572cd', '20260723_209999_aa11ff']),
    );
  } finally {
    rmrf(tmp);
  }
});

test('snapshotHermesSessions ignores rows whose last token is not a session id', () => {
  const tmp = makeTmpDir();
  try {
    const home = join(tmp, 'home');
    const launchCwd = join(tmp, 'project');
    mkdirSync(launchCwd, { recursive: true });
    const spawn: SpawnFn = () =>
      completed(
        [
          'STARTED   TITLE    MESSAGES  SESSION',
          '(no sessions found)',
          '',
        ].join('\n'),
      );
    expect(snapshotHermesSessions({ home, launchCwd, spawn })).toEqual(
      new Set(),
    );
  } finally {
    rmrf(tmp);
  }
});

// ---------------------------------------------------------------------------
// exportHermesSessions — happy path, manifest, ordering, error handling
// ---------------------------------------------------------------------------

test('exportHermesSessions exports only new sessions and writes manifest', () => {
  const tmp = makeTmpDir();
  try {
    const home = join(tmp, 'home');
    const exportDir = join(home, '.hermes', 'sessions-export');
    const launchCwd = join(tmp, 'project');
    mkdirSync(launchCwd, { recursive: true });

    const calls: string[][] = [];
    const spawn: SpawnFn = (opts) => {
      calls.push(opts.args);
      expect(opts.cwd).toBe(launchCwd);
      expect(opts.env['HOME']).toBe(home);
      expect('SUPERPOWERS_ROOT' in opts.env).toBe(false);
      if (opts.args[1] === 'sessions' && opts.args[2] === 'list') {
        return completed(
          fakeSessionListTable([
            '20260723_100000_aaaaaa',
            '20260723_200000_bbbbbb',
          ]),
        );
      }
      if (
        opts.args[1] === 'sessions' &&
        opts.args[2] === 'export' &&
        opts.args.includes('20260723_200000_bbbbbb')
      ) {
        return completed(
          `${JSON.stringify({ id: '20260723_200000_bbbbbb', messages: [] })}\n`,
        );
      }
      throw new Error(`unexpected command: ${opts.args.join(' ')}`);
    };

    const exported = exportHermesSessions({
      hermesHome: home,
      exportDir,
      launchCwd,
      snapshot: new Set(['20260723_100000_aaaaaa']),
      spawn,
    });

    expect(exported).toEqual([join(exportDir, '20260723_200000_bbbbbb.json')]);
    const data = JSON.parse(readFileSync(exported[0] ?? '', 'utf8'));
    expect(data.id).toBe('20260723_200000_bbbbbb');

    const manifest = JSON.parse(
      readFileSync(
        join(exportDir, 'hermes-session-export-manifest.json'),
        'utf8',
      ),
    );
    expect(manifest.snapshot_ids).toEqual(['20260723_100000_aaaaaa']);
    expect(manifest.matched_ids).toEqual(['20260723_200000_bbbbbb']);
    expect(manifest.skipped_existing_ids).toEqual(['20260723_100000_aaaaaa']);

    expect(calls).toEqual([
      ['hermes', 'sessions', 'list'],
      [
        'hermes',
        'sessions',
        'export',
        '--format',
        'jsonl',
        '--session-id',
        '20260723_200000_bbbbbb',
        '-',
      ],
    ]);
  } finally {
    rmrf(tmp);
  }
});

test('exportHermesSessions exports multiple new sessions in id order', () => {
  const tmp = makeTmpDir();
  try {
    const home = join(tmp, 'home');
    const exportDir = join(home, '.hermes', 'sessions-export');
    const launchCwd = join(tmp, 'project');
    mkdirSync(launchCwd, { recursive: true });
    const exportOrder: string[] = [];
    const spawn: SpawnFn = (opts) => {
      if (opts.args[1] === 'sessions' && opts.args[2] === 'list') {
        return completed(
          fakeSessionListTable([
            '20260723_200000_bbbbbb',
            '20260723_100000_aaaaaa',
          ]),
        );
      }
      const id = opts.args[opts.args.length - 2] ?? '';
      exportOrder.push(id);
      return completed(`${JSON.stringify({ id, messages: [] })}\n`);
    };
    const exported = exportHermesSessions({
      hermesHome: home,
      exportDir,
      launchCwd,
      snapshot: new Set(),
      spawn,
    });
    expect(exportOrder).toEqual([
      '20260723_100000_aaaaaa',
      '20260723_200000_bbbbbb',
    ]);
    expect(exported).toEqual([
      join(exportDir, '20260723_100000_aaaaaa.json'),
      join(exportDir, '20260723_200000_bbbbbb.json'),
    ]);
  } finally {
    rmrf(tmp);
  }
});

test('exportHermesSessions returns empty when there are no new sessions', () => {
  const tmp = makeTmpDir();
  try {
    const home = join(tmp, 'home');
    const launchCwd = join(tmp, 'project');
    mkdirSync(launchCwd, { recursive: true });
    const spawn: SpawnFn = () =>
      completed(fakeSessionListTable(['20260723_100000_aaaaaa']));
    expect(
      exportHermesSessions({
        hermesHome: home,
        exportDir: join(home, '.hermes', 'sessions-export'),
        launchCwd,
        snapshot: new Set(['20260723_100000_aaaaaa']),
        spawn,
      }),
    ).toEqual([]);
  } finally {
    rmrf(tmp);
  }
});

test('exportHermesSessions raises HermesCaptureError on list failure', () => {
  const tmp = makeTmpDir();
  try {
    const spawn: SpawnFn = () => completed('', 'bad auth', 1);
    expect(() =>
      exportHermesSessions({
        hermesHome: join(tmp, 'home'),
        exportDir: join(tmp, 'exports'),
        launchCwd: tmp,
        snapshot: new Set(),
        spawn,
      }),
    ).toThrow(HermesCaptureError);
    expect(() =>
      exportHermesSessions({
        hermesHome: join(tmp, 'home'),
        exportDir: join(tmp, 'exports'),
        launchCwd: tmp,
        snapshot: new Set(),
        spawn,
      }),
    ).toThrow(/sessions list/);
  } finally {
    rmrf(tmp);
  }
});

test('exportHermesSessions raises on list timeout', () => {
  const tmp = makeTmpDir();
  try {
    const spawn: SpawnFn = () => {
      throw new Error('timeout: process timed out');
    };
    expect(() =>
      exportHermesSessions({
        hermesHome: join(tmp, 'home'),
        exportDir: join(tmp, 'exports'),
        launchCwd: tmp,
        snapshot: new Set(),
        spawn,
      }),
    ).toThrow(/sessions list timed out/);
  } finally {
    rmrf(tmp);
  }
});

test('exportHermesSessions converts a real HermesTimeoutError on list to a list-timeout', () => {
  const tmp = makeTmpDir();
  try {
    const spawn: SpawnFn = () => {
      throw new HermesTimeoutError('hermes sessions list kill');
    };
    expect(() =>
      exportHermesSessions({
        hermesHome: join(tmp, 'home'),
        exportDir: join(tmp, 'exports'),
        launchCwd: tmp,
        snapshot: new Set(),
        spawn,
      }),
    ).toThrow(/sessions list timed out/);
  } finally {
    rmrf(tmp);
  }
});

test('exportHermesSessions raises on export failure', () => {
  const tmp = makeTmpDir();
  try {
    const launchCwd = join(tmp, 'project');
    mkdirSync(launchCwd, { recursive: true });
    const spawn: SpawnFn = (opts) => {
      if (opts.args[1] === 'sessions' && opts.args[2] === 'list') {
        return completed(fakeSessionListTable(['20260723_100000_beef01']));
      }
      return completed('', 'export failed', 2);
    };
    expect(() =>
      exportHermesSessions({
        hermesHome: join(tmp, 'home'),
        exportDir: join(tmp, 'exports'),
        launchCwd,
        snapshot: new Set(),
        spawn,
      }),
    ).toThrow(/sessions export 20260723_100000_beef01/);
  } finally {
    rmrf(tmp);
  }
});

test('exportHermesSessions raises on export timeout', () => {
  const tmp = makeTmpDir();
  try {
    const launchCwd = join(tmp, 'project');
    mkdirSync(launchCwd, { recursive: true });
    const spawn: SpawnFn = (opts) => {
      if (opts.args[1] === 'sessions' && opts.args[2] === 'list') {
        return completed(fakeSessionListTable(['20260723_100000_beef01']));
      }
      throw new Error('timeout: export timed out');
    };
    expect(() =>
      exportHermesSessions({
        hermesHome: join(tmp, 'home'),
        exportDir: join(tmp, 'exports'),
        launchCwd,
        snapshot: new Set(),
        spawn,
      }),
    ).toThrow(/sessions export 20260723_100000_beef01 timed out/);
  } finally {
    rmrf(tmp);
  }
});

test('export invalid JSON error carries byte count and stdout/stderr evidence', () => {
  const tmp = makeTmpDir();
  try {
    const launchCwd = join(tmp, 'project');
    mkdirSync(launchCwd, { recursive: true });
    const spawn: SpawnFn = (opts) => {
      if (opts.args[1] === 'sessions' && opts.args[2] === 'list') {
        return completed(fakeSessionListTable(['20260723_100000_beef01']));
      }
      return completed('definitely not json', 'provider exploded\n', 0);
    };
    let caught: unknown;
    try {
      exportHermesSessions({
        hermesHome: join(tmp, 'home'),
        exportDir: join(tmp, 'exports'),
        launchCwd,
        snapshot: new Set(),
        spawn,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HermesCaptureError);
    const message = (caught as HermesCaptureError).message;
    expect(message).toContain('invalid JSON');
    expect(message).toContain('definitely not json');
    expect(message).toContain('provider exploded');
    expect(message).toContain('19 bytes');
  } finally {
    rmrf(tmp);
  }
});

test('exportHermesSessions raises when the exported id does not match the requested session', () => {
  const tmp = makeTmpDir();
  try {
    const launchCwd = join(tmp, 'project');
    mkdirSync(launchCwd, { recursive: true });
    const spawn: SpawnFn = (opts) => {
      if (opts.args[1] === 'sessions' && opts.args[2] === 'list') {
        return completed(fakeSessionListTable(['20260723_100000_beef01']));
      }
      return completed(
        `${JSON.stringify({ id: 'some_other_id', messages: [] })}\n`,
      );
    };
    expect(() =>
      exportHermesSessions({
        hermesHome: join(tmp, 'home'),
        exportDir: join(tmp, 'exports'),
        launchCwd,
        snapshot: new Set(),
        spawn,
      }),
    ).toThrow(/returned session id/);
  } finally {
    rmrf(tmp);
  }
});

// ---------------------------------------------------------------------------
// defaultSpawn / runHermesCommand stdout-survival + real-timeout integration
// (mirrors opencode-capture.ts's fake-binary integration tests).
// ---------------------------------------------------------------------------

const FAKE_HERMES = `#!/usr/bin/env node
const fs = require("node:fs");
function stdoutIsPipe() {
  try {
    const stat = fs.fstatSync(1);
    return (stat.mode & 0xF000) === 0x1000; // S_IFIFO
  } catch {
    return false;
  }
}
const args = process.argv.slice(2);
if (args[0] === "sessions" && args[1] === "list") {
  process.stdout.write("STARTED TITLE MESSAGES SESSION\\n20260723_000000_bad000\\n");
} else if (args[0] === "sessions" && args[1] === "export") {
  const id = args[args.indexOf("--session-id") + 1];
  const payload = Buffer.from(JSON.stringify({id, messages: [{filler: "x".repeat(200000)}]}) + "\\n");
  const toWrite = stdoutIsPipe() ? payload.slice(0, 65536) : payload;
  fs.writeSync(1, toWrite);
}
process.exit(0);
`;

test('runHermesCommand survives a bare process.exit() via regular-file stdout (integration)', () => {
  const tmp = makeTmpDir();
  try {
    const binDir = join(tmp, 'fake-bin');
    mkdirSync(binDir, { recursive: true });
    const fake = join(binDir, 'hermes');
    writeFileSync(fake, FAKE_HERMES, 'utf8');
    chmodSync(fake, 0o755);

    const home = join(tmp, 'home');
    const launchCwd = join(tmp, 'project');
    mkdirSync(launchCwd, { recursive: true });

    const orig = { ...process.env };
    process.env['PATH'] = `${binDir}:${process.env['PATH'] ?? '/usr/bin:/bin'}`;
    try {
      const exported = exportHermesSessions({
        hermesHome: home,
        exportDir: join(home, '.hermes', 'sessions-export'),
        launchCwd,
        snapshot: new Set(),
      });
      expect(existsSync(exported[0] ?? '')).toBe(true);
      const data = JSON.parse(readFileSync(exported[0] ?? '', 'utf8'));
      expect(data.id).toBe('20260723_000000_bad000');
      // Full payload survived: a pipe would have truncated at 64KiB.
      expect(data.messages[0].filler.length).toBe(200000);
    } finally {
      for (const k of Object.keys(process.env)) {
        if (!(k in orig)) delete process.env[k];
      }
      for (const [k, v] of Object.entries(orig)) {
        if (v !== undefined) process.env[k] = v;
      }
    }
  } finally {
    rmrf(tmp);
  }
});

test('runHermesCommand surfaces a real timeout instead of swallowing it (integration)', () => {
  const tmp = makeTmpDir();
  try {
    const binDir = join(tmp, 'fake-bin');
    mkdirSync(binDir, { recursive: true });
    const fake = join(binDir, 'hermes');
    writeFileSync(fake, '#!/bin/sh\nsleep 10\n', 'utf8');
    chmodSync(fake, 0o755);

    const home = join(tmp, 'home');
    const launchCwd = join(tmp, 'project');
    mkdirSync(launchCwd, { recursive: true });

    const orig = { ...process.env };
    process.env['PATH'] = `${binDir}:${process.env['PATH'] ?? '/usr/bin:/bin'}`;
    try {
      expect(() =>
        runHermesCommand(['sessions', 'list'], {
          hermesHome: home,
          launchCwd,
          timeoutMs: 300,
        }),
      ).toThrow(HermesTimeoutError);
    } finally {
      for (const k of Object.keys(process.env)) {
        if (!(k in orig)) delete process.env[k];
      }
      for (const [k, v] of Object.entries(orig)) {
        if (v !== undefined) process.env[k] = v;
      }
    }
  } finally {
    rmrf(tmp);
  }
});

test('HERMES_CAPTURE_TIMEOUT_MS is 90s (headroom for session list/export under concurrency)', () => {
  expect(HERMES_CAPTURE_TIMEOUT_MS).toBe(90_000);
});
