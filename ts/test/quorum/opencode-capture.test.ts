/**
 * Tests for opencode-capture.ts
 *
 * Port of tests/quorum/test_opencode_capture.py — covers all cases.
 *
 * The Python tests inject at subprocess.run level via monkeypatch. Here we
 * use the injectable SpawnFn parameter to the public API functions, returning
 * SpawnResult objects from fake implementations.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  OpenCodeCaptureError,
  exportOpencodeSessions,
  opencodeEnv,
  opencodeRunEnv,
  runOpencodeCommand,
  snapshotOpencodeSessions,
  type SpawnFn,
  type SpawnResult,
} from "../../src/quorum/opencode-capture.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opencode-capture-test-"));
}

function rmrf(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

/**
 * Build a simple SpawnFn that returns a fixed result. Mirrors the Python
 * _completed() helper: stdout goes directly into the SpawnResult (no file
 * indirection needed since the TS injectable interface returns stdout as a string).
 */
function makeCompleted(stdout: string, stderr = "", exitCode = 0): SpawnResult {
  return { stdout, stderr, exitCode };
}

// ---------------------------------------------------------------------------
// opencodeEnv
// ---------------------------------------------------------------------------

test("opencodeEnv isolates home and XDG dirs", () => {
  const tmpDir = makeTmpDir();
  try {
    const home = path.join(tmpDir, "home");
    const env = opencodeEnv(home);
    expect(env).toEqual({
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_STATE_HOME: path.join(home, ".local", "state"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      TMPDIR: path.join(home, ".tmp"),
      OPENCODE_CONFIG_DIR: path.join(home, ".config", "opencode"),
    });
  } finally {
    rmrf(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// opencodeRunEnv
// ---------------------------------------------------------------------------

test("opencodeRunEnv scrubs harness paths and preserves provider env", () => {
  const tmpDir = makeTmpDir();
  try {
    const home = path.join(tmpDir, "home");
    // Simulate the env state — we can't monkeypatch process.env easily, but
    // we can verify the function reads from process.env and applies allowlist.
    // Save originals and mutate.
    const origEnv = { ...process.env };
    process.env["SUPERPOWERS_ROOT"] = "/real/superpowers";
    process.env["QUORUM_AGENT_CWD"] = "/real/workdir";
    process.env["OPENCODE_CONFIG_DIR"] = "/real/opencode";
    process.env["OPENAI_API_KEY"] = "sk-test";
    process.env["PATH"] = "/bin";

    try {
      const env = opencodeRunEnv(home);
      expect(env["OPENAI_API_KEY"]).toBe("sk-test");
      expect(env["PATH"]).toBe("/bin");
      expect(env["OPENCODE_CONFIG_DIR"]).toBe(path.join(home, ".config", "opencode"));
      expect("SUPERPOWERS_ROOT" in env).toBe(false);
      expect("QUORUM_AGENT_CWD" in env).toBe(false);
    } finally {
      // Restore
      for (const [k, v] of Object.entries(origEnv)) {
        process.env[k] = v;
      }
      if (!("SUPERPOWERS_ROOT" in origEnv)) delete process.env["SUPERPOWERS_ROOT"];
      if (!("QUORUM_AGENT_CWD" in origEnv)) delete process.env["QUORUM_AGENT_CWD"];
      if (!("OPENCODE_CONFIG_DIR" in origEnv)) delete process.env["OPENCODE_CONFIG_DIR"];
      if (!("OPENAI_API_KEY" in origEnv)) delete process.env["OPENAI_API_KEY"];
      if (!("PATH" in origEnv)) delete process.env["PATH"];
    }
  } finally {
    rmrf(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// snapshotOpencodeSessions
// ---------------------------------------------------------------------------

test("snapshotOpencodeSessions filters by launchCwd", () => {
  const tmpDir = makeTmpDir();
  try {
    const home = path.join(tmpDir, "home");
    const launchCwd = path.join(tmpDir, "project");
    fs.mkdirSync(launchCwd, { recursive: true });

    const spawn: SpawnFn = (opts) => {
      expect(opts.args).toEqual(["opencode", "session", "list", "--format", "json"]);
      expect(opts.cwd).toBe(launchCwd);
      return makeCompleted(
        JSON.stringify([
          { id: "ses_old", directory: launchCwd },
          { id: "ses_other", directory: path.join(tmpDir, "other") },
        ]),
      );
    };

    const result = snapshotOpencodeSessions({ home, launchCwd, spawn });
    expect(result).toEqual(new Set(["ses_old"]));
  } finally {
    rmrf(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// exportOpencodeSessions — main happy path
// ---------------------------------------------------------------------------

test("exportOpencodeSessions exports only new matching sessions and writes manifest", () => {
  const tmpDir = makeTmpDir();
  try {
    const home = path.join(tmpDir, "home");
    const exportDir = path.join(home, ".quorum", "session-exports");
    const launchReal = path.join(tmpDir, "real-project");
    fs.mkdirSync(launchReal, { recursive: true });
    const launchLink = path.join(tmpDir, "linked-project");
    fs.symlinkSync(launchReal, launchLink);

    const calls: string[][] = [];

    const spawn: SpawnFn = (opts) => {
      calls.push(opts.args);
      expect(opts.cwd).toBe(launchLink);
      expect(opts.env["HOME"]).toBe(home);
      expect("SUPERPOWERS_ROOT" in opts.env).toBe(false);

      if (
        opts.args[0] === "opencode" &&
        opts.args[1] === "session" &&
        opts.args[2] === "list"
      ) {
        return makeCompleted(
          JSON.stringify([
            {
              id: "ses_old",
              directory: fs.realpathSync(launchReal),
              created: 100,
            },
            {
              id: "ses_new",
              directory: fs.realpathSync(launchReal),
              created: 200,
            },
            { id: "ses_other", directory: path.join(tmpDir, "other") },
          ]),
        );
      }
      if (opts.args[0] === "opencode" && opts.args[1] === "export" && opts.args[2] === "ses_new") {
        return makeCompleted(
          JSON.stringify({
            info: { id: "ses_new", time: { created: 200 } },
            messages: [],
          }),
          "Exporting session: ses_new\n",
        );
      }
      throw new Error(`unexpected command: ${opts.args.join(" ")}`);
    };

    const exported = exportOpencodeSessions({
      opencodeHome: home,
      exportDir,
      launchCwd: launchLink,
      snapshot: new Set(["ses_old"]),
      spawn,
    });

    expect(exported).toEqual([path.join(exportDir, "0000000000000200-ses_new.json")]);
    const exportedData = JSON.parse(fs.readFileSync(exported[0]!, "utf8")) as {
      info: { id: string };
    };
    expect(exportedData.info.id).toBe("ses_new");

    const manifest = JSON.parse(
      fs.readFileSync(path.join(exportDir, "opencode-session-export-manifest.json"), "utf8"),
    ) as Record<string, unknown>;

    expect((manifest["raw_session_rows"] as Array<{ id: string }>)[0]!.id).toBe("ses_old");
    expect(manifest["snapshot_ids"]).toEqual(["ses_old"]);
    expect(manifest["matched_ids"]).toEqual(["ses_new"]);
    expect(manifest["skipped_existing_ids"]).toEqual(["ses_old"]);
    expect(manifest["skipped_nonmatching_ids"]).toEqual(["ses_other"]);

    const sessionDecisions = manifest["session_decisions"] as Array<Record<string, unknown>>;
    expect(sessionDecisions[0]!["matched"]).toBe(true);
    expect(sessionDecisions[2]!["matched"]).toBe(false);

    const exports = manifest["exports"] as Array<Record<string, unknown>>;
    expect(exports[0]!["stderr"]).toBe("Exporting session: ses_new\n");

    expect(calls).toEqual([
      ["opencode", "session", "list", "--format", "json"],
      ["opencode", "export", "ses_new"],
    ]);
  } finally {
    rmrf(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// exportOpencodeSessions — no matching session
// ---------------------------------------------------------------------------

test("exportOpencodeSessions returns empty array when no matching session", () => {
  const tmpDir = makeTmpDir();
  try {
    const home = path.join(tmpDir, "home");
    const launchCwd = path.join(tmpDir, "project");
    fs.mkdirSync(launchCwd, { recursive: true });

    const spawn: SpawnFn = (opts) => {
      expect(opts.args).toEqual(["opencode", "session", "list", "--format", "json"]);
      return makeCompleted(
        JSON.stringify([{ id: "ses_other", directory: path.join(tmpDir, "other") }]),
      );
    };

    const exported = exportOpencodeSessions({
      opencodeHome: home,
      exportDir: path.join(home, ".quorum", "session-exports"),
      launchCwd,
      snapshot: new Set(),
      spawn,
    });

    expect(exported).toEqual([]);
  } finally {
    rmrf(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// exportOpencodeSessions — orders by exported created when list lacks created
// ---------------------------------------------------------------------------

test("exportOpencodeSessions orders by exported created when list lacks created", () => {
  const tmpDir = makeTmpDir();
  try {
    const home = path.join(tmpDir, "home");
    const exportDir = path.join(home, ".quorum", "session-exports");
    const launchCwd = path.join(tmpDir, "project");
    fs.mkdirSync(launchCwd, { recursive: true });

    const spawn: SpawnFn = (opts) => {
      // args: ["opencode", "session", "list", ...] or ["opencode", "export", <id>]
      if (opts.args[1] === "session" && opts.args[2] === "list") {
        return makeCompleted(
          JSON.stringify([
            { id: "ses_late", directory: launchCwd },
            { id: "ses_early", directory: launchCwd },
          ]),
        );
      }
      const sessionId = opts.args[opts.args.length - 1]!;
      const created = sessionId === "ses_early" ? 10 : 20;
      return makeCompleted(
        JSON.stringify({ info: { id: sessionId, time: { created } }, messages: [] }),
      );
    };

    const exported = exportOpencodeSessions({
      opencodeHome: home,
      exportDir,
      launchCwd,
      snapshot: new Set(),
      spawn,
    });

    expect(exported).toEqual([
      path.join(exportDir, "0000000000000010-ses_early.json"),
      path.join(exportDir, "0000000000000020-ses_late.json"),
    ]);
  } finally {
    rmrf(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// exportOpencodeSessions — raises on list failure
// ---------------------------------------------------------------------------

test("exportOpencodeSessions raises on list failure", () => {
  const tmpDir = makeTmpDir();
  try {
    const spawn: SpawnFn = (_opts) => makeCompleted("", "bad auth", 1);

    expect(() =>
      exportOpencodeSessions({
        opencodeHome: path.join(tmpDir, "home"),
        exportDir: path.join(tmpDir, "exports"),
        launchCwd: tmpDir,
        snapshot: new Set(),
        spawn,
      }),
    ).toThrow(/session list/);
    expect(() =>
      exportOpencodeSessions({
        opencodeHome: path.join(tmpDir, "home"),
        exportDir: path.join(tmpDir, "exports"),
        launchCwd: tmpDir,
        snapshot: new Set(),
        spawn,
      }),
    ).toThrow(OpenCodeCaptureError);
  } finally {
    rmrf(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// exportOpencodeSessions — raises on list timeout
// ---------------------------------------------------------------------------

test("exportOpencodeSessions raises on list timeout", () => {
  const tmpDir = makeTmpDir();
  try {
    const spawn: SpawnFn = (_opts) => {
      throw new Error("timeout: process timed out");
    };

    expect(() =>
      exportOpencodeSessions({
        opencodeHome: path.join(tmpDir, "home"),
        exportDir: path.join(tmpDir, "exports"),
        launchCwd: tmpDir,
        snapshot: new Set(),
        spawn,
      }),
    ).toThrow(/session list timed out/);
  } finally {
    rmrf(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// exportOpencodeSessions — raises on export failure
// ---------------------------------------------------------------------------

test("exportOpencodeSessions raises on export failure", () => {
  const tmpDir = makeTmpDir();
  try {
    const launchCwd = path.join(tmpDir, "project");
    fs.mkdirSync(launchCwd, { recursive: true });

    const spawn: SpawnFn = (opts) => {
      if (opts.args[1] === "session" && opts.args[2] === "list") {
        return makeCompleted(
          JSON.stringify([{ id: "ses_match", directory: launchCwd, created: 10 }]),
        );
      }
      // export command returns failure
      return makeCompleted("", "export failed", 2);
    };

    expect(() =>
      exportOpencodeSessions({
        opencodeHome: path.join(tmpDir, "home"),
        exportDir: path.join(tmpDir, "exports"),
        launchCwd,
        snapshot: new Set(),
        spawn,
      }),
    ).toThrow(/export ses_match/);
  } finally {
    rmrf(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// exportOpencodeSessions — raises on export timeout
// ---------------------------------------------------------------------------

test("exportOpencodeSessions raises on export timeout", () => {
  const tmpDir = makeTmpDir();
  try {
    const launchCwd = path.join(tmpDir, "project");
    fs.mkdirSync(launchCwd, { recursive: true });

    const spawn: SpawnFn = (opts) => {
      if (opts.args[1] === "session" && opts.args[2] === "list") {
        return makeCompleted(
          JSON.stringify([{ id: "ses_match", directory: launchCwd, created: 10 }]),
        );
      }
      throw new Error("timeout: export timed out");
    };

    expect(() =>
      exportOpencodeSessions({
        opencodeHome: path.join(tmpDir, "home"),
        exportDir: path.join(tmpDir, "exports"),
        launchCwd,
        snapshot: new Set(),
        spawn,
      }),
    ).toThrow(/export ses_match timed out/);
  } finally {
    rmrf(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// exportOpencodeSessions — raises when multiple new sessions lack ordering
// ---------------------------------------------------------------------------

test("exportOpencodeSessions raises when multiple new sessions lack ordering", () => {
  const tmpDir = makeTmpDir();
  try {
    const launchCwd = path.join(tmpDir, "project");
    fs.mkdirSync(launchCwd, { recursive: true });

    const spawn: SpawnFn = (opts) => {
      if (opts.args[1] === "session" && opts.args[2] === "list") {
        return makeCompleted(
          JSON.stringify([
            { id: "ses_a", directory: launchCwd },
            { id: "ses_b", directory: launchCwd },
          ]),
        );
      }
      const sessionId = opts.args[opts.args.length - 1]!;
      return makeCompleted(JSON.stringify({ info: { id: sessionId }, messages: [] }));
    };

    expect(() =>
      exportOpencodeSessions({
        opencodeHome: path.join(tmpDir, "home"),
        exportDir: path.join(tmpDir, "exports"),
        launchCwd,
        snapshot: new Set(),
        spawn,
      }),
    ).toThrow(/cannot order/);
  } finally {
    rmrf(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// Integration tests using a real fake opencode binary
//
// The opencode CLI (bun-compiled) ends every command with a bare process.exit(),
// which discards stdout not yet drained. Through a pipe, exports >64KiB arrive
// truncated at the pipe-buffer boundary with exit 0; tiny replies can vanish.
// These tests run the real capture code against a fake `opencode` binary that
// honours that contract: full payload when stdout is a regular file, first
// 64KiB when stdout is a pipe.
// ---------------------------------------------------------------------------

const FAKE_OPENCODE_SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);

function stdoutIsPipe() {
  try {
    const stat = fs.fstatSync(1);
    // S_IFIFO = 0o010000 = 4096
    return (stat.mode & 0xF000) === 0x1000;
  } catch {
    return false;
  }
}

const scriptDir = path.dirname(path.resolve(process.argv[1]));

if (args[0] === "session" && args[1] === "list" && args[2] === "--format" && args[3] === "json") {
  process.stdout.write(JSON.stringify([{"id": "ses_big", "directory": process.cwd(), "created": 7}]));
} else if (args[0] === "export") {
  const garbageMode = fs.existsSync(path.join(scriptDir, "garbage-mode"));
  if (garbageMode) {
    process.stdout.write("definitely not json");
    process.stderr.write("provider exploded\\n");
    process.exit(0);
  }
  const sessionId = args[1];
  const payload = Buffer.from(JSON.stringify({
    "info": {"id": sessionId, "time": {"created": 7}},
    "messages": [{"filler": "x".repeat(200000)}]
  }));
  const isPipe = stdoutIsPipe();
  const toWrite = isPipe ? payload.slice(0, 65536) : payload;
  fs.writeSync(1, toWrite);
  process.stderr.write("Exporting session: " + sessionId + "\\n");
}
process.exit(0);
`;

function installFakeOpencode(tmpDir: string, opts?: { garbageMode?: boolean }): string {
  const binDir = path.join(tmpDir, "fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const fake = path.join(binDir, "opencode");
  fs.writeFileSync(fake, FAKE_OPENCODE_SCRIPT, "utf8");
  fs.chmodSync(fake, 0o755);
  if (opts?.garbageMode) {
    fs.writeFileSync(path.join(binDir, "garbage-mode"), "");
  }
  return binDir;
}

/**
 * Build a SpawnFn that prepends binDir to PATH but otherwise uses the real
 * defaultSpawn via Bun.spawnSync. We can't import defaultSpawn's internals
 * directly, so we replicate the temp-file approach inline.
 */
function makeRealSpawnWithBin(binDir: string): SpawnFn {
  return (opts) => {
    const env = { ...opts.env, PATH: `${binDir}:${opts.env["PATH"] ?? "/usr/bin:/bin"}` };
    const tmpFile = path.join(
      os.tmpdir(),
      `opencode-test-stdout-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
    );
    fs.writeFileSync(tmpFile, "");
    try {
      const stdoutFd = fs.openSync(tmpFile, "r+");
      try {
        const proc = Bun.spawnSync(opts.args, {
          cwd: opts.cwd,
          env,
          stdin: "ignore",
          stdout: stdoutFd,
          stderr: "pipe",
          timeout: opts.timeoutMs,
        });
        const stdout = fs.readFileSync(tmpFile, "utf8");
        const stderr =
          proc.stderr instanceof Uint8Array
            ? new TextDecoder().decode(proc.stderr)
            : typeof proc.stderr === "string"
              ? proc.stderr
              : "";
        return { stdout, stderr, exitCode: proc.exitCode ?? 0 };
      } finally {
        fs.closeSync(stdoutFd);
      }
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // ignore
      }
    }
  };
}

test("exportOpencodeSessions completes despite pipe truncation (integration)", () => {
  const tmpDir = makeTmpDir();
  try {
    const binDir = installFakeOpencode(tmpDir);
    const home = path.join(tmpDir, "home");
    const launchCwd = path.join(tmpDir, "project");
    fs.mkdirSync(launchCwd, { recursive: true });

    const spawn = makeRealSpawnWithBin(binDir);

    const exported = exportOpencodeSessions({
      opencodeHome: home,
      exportDir: path.join(home, ".quorum", "session-exports"),
      launchCwd,
      snapshot: new Set(),
      spawn,
    });

    const data = JSON.parse(fs.readFileSync(exported[0]!, "utf8")) as {
      info: { id: string };
      messages: Array<{ filler: string }>;
    };
    expect(data.info.id).toBe("ses_big");
    expect(data.messages[0]!.filler.length).toBe(200000);
  } finally {
    rmrf(tmpDir);
  }
});

test("export invalid JSON error carries stdout and stderr evidence (integration)", () => {
  const tmpDir = makeTmpDir();
  try {
    const binDir = installFakeOpencode(tmpDir, { garbageMode: true });
    const home = path.join(tmpDir, "home");
    const launchCwd = path.join(tmpDir, "project");
    fs.mkdirSync(launchCwd, { recursive: true });

    const spawn = makeRealSpawnWithBin(binDir);

    let caughtError: unknown;
    try {
      exportOpencodeSessions({
        opencodeHome: home,
        exportDir: path.join(home, ".quorum", "session-exports"),
        launchCwd,
        snapshot: new Set(),
        spawn,
      });
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBeInstanceOf(OpenCodeCaptureError);
    const message = (caughtError as OpenCodeCaptureError).message;
    expect(message).toContain("invalid JSON");
    expect(message).toContain("definitely not json");
    expect(message).toContain("provider exploded");
    expect(message).toContain("19 bytes");
  } finally {
    rmrf(tmpDir);
  }
});
