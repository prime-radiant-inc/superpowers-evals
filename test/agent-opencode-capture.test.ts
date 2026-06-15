import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  exportOpencodeSessions,
  OPENCODE_CAPTURE_TIMEOUT_MS,
  OpenCodeCaptureError,
  OpenCodeTimeoutError,
  opencodeEnv,
  opencodeRunEnv,
  runOpencodeCommand,
  type SpawnFn,
  type SpawnResult,
  snapshotOpencodeSessions,
  spawnOutcome,
} from '../src/agents/opencode-capture.ts';

// Port of tests/quorum/test_opencode_capture.py — the Python injects at the
// subprocess.run level; here we inject the SpawnFn seam.

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'opencode-capture-test-'));
}

function rmrf(p: string): void {
  rmSync(p, { recursive: true, force: true });
}

function completed(stdout: string, stderr = '', exitCode = 0): SpawnResult {
  return { stdout, stderr, exitCode };
}

// ---------------------------------------------------------------------------
// spawnOutcome — the pure exit/signal -> outcome decision
// (M1-opencode-timeout-swallowed-as-success): Bun.spawnSync does NOT throw on
// timeout; it kills the child and returns { exitCode: null, signalCode: 'SIGTERM' }.
// The old `proc.exitCode ?? 0` coerced that into a success. spawnOutcome must map
// a killed/null-exit result to a timeout, never to success.
// ---------------------------------------------------------------------------

test('spawnOutcome maps a clean exit 0 to success', () => {
  expect(spawnOutcome({ exitCode: 0, signalCode: null })).toBe('success');
});

test('spawnOutcome maps a non-zero exit to failure', () => {
  expect(spawnOutcome({ exitCode: 1, signalCode: null })).toBe('failure');
});

// Bun.spawnSync reports signalCode === undefined (an omitted optional, NOT null)
// on a clean exit; that must still count as success, not a kill/timeout.
test('spawnOutcome maps a clean exit 0 with absent signalCode to success', () => {
  expect(spawnOutcome({ exitCode: 0 })).toBe('success');
});

test('spawnOutcome maps a null exit (killed on timeout) to timeout', () => {
  expect(spawnOutcome({ exitCode: null, signalCode: 'SIGTERM' })).toBe(
    'timeout',
  );
});

test('spawnOutcome maps a signalled kill (non-null signal) to timeout', () => {
  // A signal with a null exit is the kill case; the timeout that fired SIGTERM.
  expect(spawnOutcome({ exitCode: null, signalCode: 'SIGKILL' })).toBe(
    'timeout',
  );
});

// ---------------------------------------------------------------------------
// opencodeEnv
// ---------------------------------------------------------------------------

test('opencodeEnv isolates home and XDG dirs', () => {
  const home = join(makeTmpDir(), 'home');
  try {
    expect(opencodeEnv(home)).toEqual({
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_STATE_HOME: join(home, '.local', 'state'),
      XDG_CACHE_HOME: join(home, '.cache'),
      TMPDIR: join(home, '.tmp'),
      OPENCODE_CONFIG_DIR: join(home, '.config', 'opencode'),
    });
  } finally {
    rmrf(home);
  }
});

// ---------------------------------------------------------------------------
// opencodeRunEnv — the allowlist filter (B2-opencode-preflight-env-not-allowlisted)
// ---------------------------------------------------------------------------

test('opencodeRunEnv filters host env to the allowlist and overlays XDG isolation', () => {
  const home = join(makeTmpDir(), 'home');
  const orig = { ...process.env };
  // A provider key (allowlisted) survives; harness/leak vars (not allowlisted)
  // are scrubbed; an ambient OPENCODE_CONFIG_DIR is overridden by the XDG overlay.
  process.env['SUPERPOWERS_ROOT'] = '/real/superpowers';
  process.env['OPENCODE_CONFIG_DIR'] = '/ambient/opencode';
  process.env['HTTP_PROXY'] = 'http://leak';
  process.env['OPENAI_API_KEY'] = 'sk-test';
  process.env['PATH'] = '/custom/bin';
  try {
    const env = opencodeRunEnv(home);
    expect(env['OPENAI_API_KEY']).toBe('sk-test');
    expect(env['PATH']).toBe('/custom/bin');
    expect(env['OPENCODE_CONFIG_DIR']).toBe(join(home, '.config', 'opencode'));
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

test('opencodeRunEnv setdefaults PATH/TERM/LANG when absent', () => {
  const home = join(makeTmpDir(), 'home');
  const orig = { ...process.env };
  delete process.env['PATH'];
  delete process.env['TERM'];
  delete process.env['LANG'];
  try {
    const env = opencodeRunEnv(home);
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
// runOpencodeCommand — prefixes "opencode", uses launchCwd + allowlisted env
// ---------------------------------------------------------------------------

test('runOpencodeCommand prefixes opencode and passes allowlisted env + cwd', () => {
  const home = join(makeTmpDir(), 'home');
  const orig = { ...process.env };
  process.env['ANTHROPIC_API_KEY'] = 'sk-anthropic';
  process.env['SUPERPOWERS_ROOT'] = '/leak';
  try {
    let seen:
      | { args: string[]; cwd: string; env: Record<string, string> }
      | undefined;
    const spawn: SpawnFn = (opts) => {
      seen = { args: opts.args, cwd: opts.cwd, env: opts.env };
      return completed('ok');
    };
    const result = runOpencodeCommand(['session', 'list'], {
      opencodeHome: home,
      launchCwd: '/launch/here',
      spawn,
    });
    expect(result.stdout).toBe('ok');
    expect(seen?.args).toEqual(['opencode', 'session', 'list']);
    expect(seen?.cwd).toBe('/launch/here');
    expect(seen?.env['ANTHROPIC_API_KEY']).toBe('sk-anthropic');
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
// snapshotOpencodeSessions
// ---------------------------------------------------------------------------

test('snapshotOpencodeSessions returns ids whose directory matches launchCwd', () => {
  const tmp = makeTmpDir();
  try {
    const home = join(tmp, 'home');
    const launchCwd = join(tmp, 'project');
    mkdirSync(launchCwd, { recursive: true });
    const spawn: SpawnFn = (opts) => {
      expect(opts.args).toEqual([
        'opencode',
        'session',
        'list',
        '--format',
        'json',
      ]);
      expect(opts.cwd).toBe(launchCwd);
      return completed(
        JSON.stringify([
          { id: 'ses_old', directory: launchCwd },
          { id: 'ses_other', directory: join(tmp, 'other') },
        ]),
      );
    };
    expect(snapshotOpencodeSessions({ home, launchCwd, spawn })).toEqual(
      new Set(['ses_old']),
    );
  } finally {
    rmrf(tmp);
  }
});

// ---------------------------------------------------------------------------
// exportOpencodeSessions — happy path, realpath matching, manifest
// ---------------------------------------------------------------------------

test('exportOpencodeSessions exports only new matching sessions and writes manifest', () => {
  const tmp = makeTmpDir();
  try {
    const home = join(tmp, 'home');
    const exportDir = join(home, '.quorum', 'session-exports');
    const launchReal = join(tmp, 'real-project');
    mkdirSync(launchReal, { recursive: true });
    const launchLink = join(tmp, 'linked-project');
    symlinkSync(launchReal, launchLink);

    const calls: string[][] = [];
    const spawn: SpawnFn = (opts) => {
      calls.push(opts.args);
      expect(opts.cwd).toBe(launchLink);
      expect(opts.env['HOME']).toBe(home);
      expect('SUPERPOWERS_ROOT' in opts.env).toBe(false);
      if (opts.args[1] === 'session' && opts.args[2] === 'list') {
        return completed(
          JSON.stringify([
            {
              id: 'ses_old',
              directory: realpathSync(launchReal),
              created: 100,
            },
            {
              id: 'ses_new',
              directory: realpathSync(launchReal),
              created: 200,
            },
            { id: 'ses_other', directory: join(tmp, 'other') },
          ]),
        );
      }
      if (opts.args[1] === 'export' && opts.args[2] === 'ses_new') {
        return completed(
          JSON.stringify({
            info: { id: 'ses_new', time: { created: 200 } },
            messages: [],
          }),
          'Exporting session: ses_new\n',
        );
      }
      throw new Error(`unexpected command: ${opts.args.join(' ')}`);
    };

    const exported = exportOpencodeSessions({
      opencodeHome: home,
      exportDir,
      launchCwd: launchLink,
      snapshot: new Set(['ses_old']),
      spawn,
    });

    expect(exported).toEqual([
      join(exportDir, '0000000000000200-ses_new.json'),
    ]);
    const data = JSON.parse(readFileSync(exported[0] ?? '', 'utf8'));
    expect(data.info.id).toBe('ses_new');

    const manifest = JSON.parse(
      readFileSync(
        join(exportDir, 'opencode-session-export-manifest.json'),
        'utf8',
      ),
    );
    expect(manifest.snapshot_ids).toEqual(['ses_old']);
    expect(manifest.matched_ids).toEqual(['ses_new']);
    expect(manifest.skipped_existing_ids).toEqual(['ses_old']);
    expect(manifest.skipped_nonmatching_ids).toEqual(['ses_other']);
    expect(manifest.session_decisions[0].matched).toBe(true);
    expect(manifest.session_decisions[2].matched).toBe(false);
    expect(manifest.exports[0].stderr).toBe('Exporting session: ses_new\n');

    expect(calls).toEqual([
      ['opencode', 'session', 'list', '--format', 'json'],
      ['opencode', 'export', 'ses_new'],
    ]);
  } finally {
    rmrf(tmp);
  }
});

test('exportOpencodeSessions returns empty when nothing matches launchCwd', () => {
  const tmp = makeTmpDir();
  try {
    const home = join(tmp, 'home');
    const launchCwd = join(tmp, 'project');
    mkdirSync(launchCwd, { recursive: true });
    const spawn: SpawnFn = () =>
      completed(
        JSON.stringify([{ id: 'ses_other', directory: join(tmp, 'other') }]),
      );
    expect(
      exportOpencodeSessions({
        opencodeHome: home,
        exportDir: join(home, '.quorum', 'session-exports'),
        launchCwd,
        snapshot: new Set(),
        spawn,
      }),
    ).toEqual([]);
  } finally {
    rmrf(tmp);
  }
});

test('exportOpencodeSessions orders by exported created when list lacks created', () => {
  const tmp = makeTmpDir();
  try {
    const home = join(tmp, 'home');
    const exportDir = join(home, '.quorum', 'session-exports');
    const launchCwd = join(tmp, 'project');
    mkdirSync(launchCwd, { recursive: true });
    const spawn: SpawnFn = (opts) => {
      if (opts.args[1] === 'session' && opts.args[2] === 'list') {
        return completed(
          JSON.stringify([
            { id: 'ses_late', directory: launchCwd },
            { id: 'ses_early', directory: launchCwd },
          ]),
        );
      }
      const sessionId = opts.args[opts.args.length - 1] ?? '';
      const created = sessionId === 'ses_early' ? 10 : 20;
      return completed(
        JSON.stringify({
          info: { id: sessionId, time: { created } },
          messages: [],
        }),
      );
    };
    expect(
      exportOpencodeSessions({
        opencodeHome: home,
        exportDir,
        launchCwd,
        snapshot: new Set(),
        spawn,
      }),
    ).toEqual([
      join(exportDir, '0000000000000010-ses_early.json'),
      join(exportDir, '0000000000000020-ses_late.json'),
    ]);
  } finally {
    rmrf(tmp);
  }
});

test('exportOpencodeSessions raises OpenCodeCaptureError on list failure', () => {
  const tmp = makeTmpDir();
  try {
    const spawn: SpawnFn = () => completed('', 'bad auth', 1);
    expect(() =>
      exportOpencodeSessions({
        opencodeHome: join(tmp, 'home'),
        exportDir: join(tmp, 'exports'),
        launchCwd: tmp,
        snapshot: new Set(),
        spawn,
      }),
    ).toThrow(OpenCodeCaptureError);
    expect(() =>
      exportOpencodeSessions({
        opencodeHome: join(tmp, 'home'),
        exportDir: join(tmp, 'exports'),
        launchCwd: tmp,
        snapshot: new Set(),
        spawn,
      }),
    ).toThrow(/session list/);
  } finally {
    rmrf(tmp);
  }
});

test('exportOpencodeSessions raises on list timeout', () => {
  const tmp = makeTmpDir();
  try {
    const spawn: SpawnFn = () => {
      throw new Error('timeout: process timed out');
    };
    expect(() =>
      exportOpencodeSessions({
        opencodeHome: join(tmp, 'home'),
        exportDir: join(tmp, 'exports'),
        launchCwd: tmp,
        snapshot: new Set(),
        spawn,
      }),
    ).toThrow(/session list timed out/);
  } finally {
    rmrf(tmp);
  }
});

test('exportOpencodeSessions converts a real OpenCodeTimeoutError on list to a list-timeout', () => {
  const tmp = makeTmpDir();
  try {
    // defaultSpawn throws OpenCodeTimeoutError when Bun.spawnSync kills the child;
    // listSessions must recognize that exact type and re-raise as a list timeout.
    const spawn: SpawnFn = () => {
      throw new OpenCodeTimeoutError(
        'opencode session list --format json kill',
      );
    };
    expect(() =>
      exportOpencodeSessions({
        opencodeHome: join(tmp, 'home'),
        exportDir: join(tmp, 'exports'),
        launchCwd: tmp,
        snapshot: new Set(),
        spawn,
      }),
    ).toThrow(/session list timed out/);
  } finally {
    rmrf(tmp);
  }
});

test('exportOpencodeSessions raises on export failure', () => {
  const tmp = makeTmpDir();
  try {
    const launchCwd = join(tmp, 'project');
    mkdirSync(launchCwd, { recursive: true });
    const spawn: SpawnFn = (opts) => {
      if (opts.args[1] === 'session' && opts.args[2] === 'list') {
        return completed(
          JSON.stringify([
            { id: 'ses_match', directory: launchCwd, created: 10 },
          ]),
        );
      }
      return completed('', 'export failed', 2);
    };
    expect(() =>
      exportOpencodeSessions({
        opencodeHome: join(tmp, 'home'),
        exportDir: join(tmp, 'exports'),
        launchCwd,
        snapshot: new Set(),
        spawn,
      }),
    ).toThrow(/export ses_match/);
  } finally {
    rmrf(tmp);
  }
});

test('exportOpencodeSessions raises on export timeout', () => {
  const tmp = makeTmpDir();
  try {
    const launchCwd = join(tmp, 'project');
    mkdirSync(launchCwd, { recursive: true });
    const spawn: SpawnFn = (opts) => {
      if (opts.args[1] === 'session' && opts.args[2] === 'list') {
        return completed(
          JSON.stringify([
            { id: 'ses_match', directory: launchCwd, created: 10 },
          ]),
        );
      }
      throw new Error('timeout: export timed out');
    };
    expect(() =>
      exportOpencodeSessions({
        opencodeHome: join(tmp, 'home'),
        exportDir: join(tmp, 'exports'),
        launchCwd,
        snapshot: new Set(),
        spawn,
      }),
    ).toThrow(/export ses_match timed out/);
  } finally {
    rmrf(tmp);
  }
});

test('exportOpencodeSessions raises when multiple new sessions lack ordering', () => {
  const tmp = makeTmpDir();
  try {
    const launchCwd = join(tmp, 'project');
    mkdirSync(launchCwd, { recursive: true });
    const spawn: SpawnFn = (opts) => {
      if (opts.args[1] === 'session' && opts.args[2] === 'list') {
        return completed(
          JSON.stringify([
            { id: 'ses_a', directory: launchCwd },
            { id: 'ses_b', directory: launchCwd },
          ]),
        );
      }
      const sessionId = opts.args[opts.args.length - 1] ?? '';
      return completed(
        JSON.stringify({ info: { id: sessionId }, messages: [] }),
      );
    };
    expect(() =>
      exportOpencodeSessions({
        opencodeHome: join(tmp, 'home'),
        exportDir: join(tmp, 'exports'),
        launchCwd,
        snapshot: new Set(),
        spawn,
      }),
    ).toThrow(/cannot order/);
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
      if (opts.args[1] === 'session' && opts.args[2] === 'list') {
        return completed(
          JSON.stringify([
            { id: 'ses_match', directory: launchCwd, created: 10 },
          ]),
        );
      }
      return completed('definitely not json', 'provider exploded\n', 0);
    };
    let caught: unknown;
    try {
      exportOpencodeSessions({
        opencodeHome: join(tmp, 'home'),
        exportDir: join(tmp, 'exports'),
        launchCwd,
        snapshot: new Set(),
        spawn,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OpenCodeCaptureError);
    const message = (caught as OpenCodeCaptureError).message;
    expect(message).toContain('invalid JSON');
    expect(message).toContain('definitely not json');
    expect(message).toContain('provider exploded');
    expect(message).toContain('19 bytes');
  } finally {
    rmrf(tmp);
  }
});

// ---------------------------------------------------------------------------
// defaultSpawn / runOpencodeCommand stdout-survival trick
// (B2-opencode-run-command-file-stdout): a regular-file stdout drains the full
// payload even when the binary ends with a bare process.exit() that would
// truncate a pipe at the 64KiB boundary.
// ---------------------------------------------------------------------------

const FAKE_OPENCODE = `#!/usr/bin/env node
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
if (args[0] === "session" && args[1] === "list") {
  process.stdout.write(JSON.stringify([{id:"ses_big",directory:process.cwd(),created:7}]));
} else if (args[0] === "export") {
  const payload = Buffer.from(JSON.stringify({
    info: {id: args[1], time: {created: 7}},
    messages: [{filler: "x".repeat(200000)}]
  }));
  const toWrite = stdoutIsPipe() ? payload.slice(0, 65536) : payload;
  fs.writeSync(1, toWrite);
  process.stderr.write("Exporting session: " + args[1] + "\\n");
}
process.exit(0);
`;

test('runOpencodeCommand survives a bare process.exit() via regular-file stdout (integration)', () => {
  const tmp = makeTmpDir();
  try {
    const binDir = join(tmp, 'fake-bin');
    mkdirSync(binDir, { recursive: true });
    const fake = join(binDir, 'opencode');
    writeFileSync(fake, FAKE_OPENCODE, 'utf8');
    chmodSync(fake, 0o755);

    const home = join(tmp, 'home');
    const launchCwd = join(tmp, 'project');
    mkdirSync(launchCwd, { recursive: true });

    const orig = { ...process.env };
    process.env['PATH'] = `${binDir}:${process.env['PATH'] ?? '/usr/bin:/bin'}`;
    try {
      const exported = exportOpencodeSessions({
        opencodeHome: home,
        exportDir: join(home, '.quorum', 'session-exports'),
        launchCwd,
        snapshot: new Set(),
      });
      expect(existsSync(exported[0] ?? '')).toBe(true);
      const data = JSON.parse(readFileSync(exported[0] ?? '', 'utf8'));
      expect(data.info.id).toBe('ses_big');
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

// M1-opencode-timeout-swallowed-as-success (integration): the real defaultSpawn
// must NOT coerce a killed-on-timeout child into a phantom exit 0 with empty
// stdout (which would be parsed as zero sessions). A child that outlives its
// timeout must surface as a list-timeout error, not a silent empty success.
test('runOpencodeCommand surfaces a real timeout instead of swallowing it (integration)', () => {
  const tmp = makeTmpDir();
  try {
    const binDir = join(tmp, 'fake-bin');
    mkdirSync(binDir, { recursive: true });
    const fake = join(binDir, 'opencode');
    // Sleeps well past the injected timeout, so Bun.spawnSync kills it.
    writeFileSync(fake, '#!/bin/sh\nsleep 10\n', 'utf8');
    chmodSync(fake, 0o755);

    const home = join(tmp, 'home');
    const launchCwd = join(tmp, 'project');
    mkdirSync(launchCwd, { recursive: true });

    const orig = { ...process.env };
    process.env['PATH'] = `${binDir}:${process.env['PATH'] ?? '/usr/bin:/bin'}`;
    try {
      // A short timeout forces the kill; runOpencodeCommand must throw, not return
      // a phantom { exitCode: 0, stdout: '' }.
      expect(() =>
        runOpencodeCommand(['session', 'list', '--format', 'json'], {
          opencodeHome: home,
          launchCwd,
          timeoutMs: 300,
        }),
      ).toThrow(OpenCodeTimeoutError);
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

test('OPENCODE_CAPTURE_TIMEOUT_MS is 30s', () => {
  expect(OPENCODE_CAPTURE_TIMEOUT_MS).toBe(30_000);
});
