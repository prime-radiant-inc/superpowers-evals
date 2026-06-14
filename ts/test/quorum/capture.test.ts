/**
 * Tests for quorum/capture.ts — port of tests/quorum/test_capture.py.
 *
 * Capture locates a run's new session logs, normalizes EVERY one to ATIF
 * in-process (via the TS normalizer dispatch), merges their steps into a single
 * timestamp-ordered trajectory.json, retries on empty captures (PRI-2081), and
 * runs the per-backend cwd diagnostics.
 *
 * The Python suite's `@requires_bun` integration tests run against the real
 * normalizer dispatch; here the normalizers are already in-process, so every
 * test exercises the real merge + emit path.
 *
 * TestCaptureTokenUsage is intentionally omitted: capture_token_usage depends on
 * obol_capture + timing, which are out of scope for this build-ahead port.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  type CaptureResult,
  captureToolCalls,
  captureToolCallsWithRetry,
  detectKimiCwdMismatch,
  detectMisplacedPiSessions,
  detectUnusablePiSessions,
  newFilesSince,
  snapshotDir,
} from "../../src/quorum/capture.ts";

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "capture-test-"));
}

function mkdir(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function writeFile(p: string, content: string): string {
  mkdir(path.dirname(p));
  fs.writeFileSync(p, content, "utf8");
  return p;
}

/** Flatten function_name across all tool_calls in an emitted ATIF trajectory. */
function toolNames(trajectoryPath: string): string[] {
  const data = JSON.parse(fs.readFileSync(trajectoryPath, "utf8"));
  const names: string[] = [];
  for (const step of data.steps ?? []) {
    for (const call of step.tool_calls ?? []) {
      names.push(call.function_name);
    }
  }
  return names;
}

function claudeToolUseLine(calls: Array<{ id: string; name: string; input: unknown }>): string {
  return (
    JSON.stringify({
      type: "assistant",
      message: {
        content: calls.map((c) => ({
          type: "tool_use",
          id: c.id,
          name: c.name,
          input: c.input,
        })),
      },
    }) + "\n"
  );
}

function piToolCallLine(): string {
  return (
    JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "read", arguments: {} }],
      },
    }) + "\n"
  );
}

describe("snapshot and diff", () => {
  test("identifies only new files", () => {
    const tmp = makeTmp();
    const logDir = path.join(tmp, "logs");
    mkdir(logDir);
    writeFile(path.join(logDir, "old.jsonl"), "{}\n");
    const snap = snapshotDir(logDir, "*.jsonl");
    writeFile(path.join(logDir, "new.jsonl"), "{}\n");
    const newFiles = newFilesSince(logDir, "*.jsonl", snap);
    expect(newFiles.map((p) => path.basename(p))).toEqual(["new.jsonl"]);
  });

  test("recursive glob", () => {
    const tmp = makeTmp();
    const logDir = path.join(tmp, "logs");
    const sub = path.join(logDir, "project-a");
    mkdir(sub);
    const snap = snapshotDir(logDir, "**/session-*.jsonl");
    writeFile(path.join(sub, "session-001.jsonl"), "{}\n");
    const newFiles = newFilesSince(logDir, "**/session-*.jsonl", snap);
    expect(newFiles.length).toBe(1);
    expect(path.basename(newFiles[0]!)).toBe("session-001.jsonl");
  });

  test("codex target glob matches date-nested rollouts", () => {
    // codex nests rollouts under sessions/YYYY/MM/DD/, so the glob must recurse.
    const glob = "**/rollout-*.jsonl";
    const tmp = makeTmp();
    const sessions = path.join(tmp, "sessions");
    const nested = path.join(sessions, "2026", "05", "20");
    mkdir(nested);
    const snap = snapshotDir(sessions, glob);
    const rollout = path.join(nested, "rollout-2026-05-20T14-33-25-abc.jsonl");
    writeFile(rollout, "{}\n");
    const newFiles = newFilesSince(sessions, glob, snap);
    expect(newFiles.map((p) => path.basename(p))).toEqual([path.basename(rollout)]);
  });

  test("missing dir returns empty", () => {
    const tmp = makeTmp();
    const logDir = path.join(tmp, "missing");
    const snap = snapshotDir(logDir, "*.jsonl");
    expect(snap.size).toBe(0);
    expect(newFilesSince(logDir, "*.jsonl", snap)).toEqual([]);
  });
});

describe("captureToolCalls", () => {
  test("emits trajectory from session log", () => {
    const tmp = makeTmp();
    const logDir = path.join(tmp, "logs");
    mkdir(logDir);
    const snap = snapshotDir(logDir, "*.jsonl");
    const session = path.join(logDir, "session-abc.jsonl");
    writeFile(session, claudeToolUseLine([{ id: "t1", name: "Bash", input: { command: "ls" } }]));
    const runDir = mkdir(path.join(tmp, "run"));
    const result = captureToolCalls({
      logDir,
      logGlob: "*.jsonl",
      snapshot: snap,
      normalizer: "claude",
      runDir,
    });
    expect(result.path).toBe(path.join(runDir, "trajectory.json"));
    expect(fs.existsSync(result.path)).toBe(true);
    expect(result.rowCount).toBe(1);
    expect(toolNames(result.path)).toEqual(["Bash"]);
  });

  test("returns source logs and row count", () => {
    const tmp = makeTmp();
    const logDir = path.join(tmp, "logs");
    mkdir(logDir);
    const snap = snapshotDir(logDir, "*.jsonl");
    const first = path.join(logDir, "first.jsonl");
    writeFile(
      first,
      claudeToolUseLine([
        { id: "r1", name: "Read", input: { file_path: "a.py" } },
        { id: "e1", name: "Edit", input: { file_path: "a.py" } },
      ]),
    );
    const second = path.join(logDir, "second.jsonl");
    writeFile(second, '{"type":"text","text":"not a tool"}\n');
    const runDir = mkdir(path.join(tmp, "run"));

    const result = captureToolCalls({
      logDir,
      logGlob: "*.jsonl",
      snapshot: snap,
      normalizer: "claude",
      runDir,
    });

    expect(result.path).toBe(path.join(runDir, "trajectory.json"));
    // Both files located; the second carries no tool calls, so only the first's survive.
    expect(result.sourceLogs).toEqual([first, second]);
    expect(result.rowCount).toBe(2);
    expect(toolNames(result.path)).toEqual(["Read", "Edit"]);
  });

  test("merges tool calls from all source logs", () => {
    const tmp = makeTmp();
    const logDir = path.join(tmp, "logs");
    mkdir(logDir);
    const snap = snapshotDir(logDir, "*.jsonl");
    const first = path.join(logDir, "a-first.jsonl");
    writeFile(first, claudeToolUseLine([{ id: "s1", name: "Skill", input: { command: "writing-plans" } }]));
    const second = path.join(logDir, "b-second.jsonl");
    writeFile(second, claudeToolUseLine([{ id: "e1", name: "Edit", input: { file_path: "app.js" } }]));
    const runDir = mkdir(path.join(tmp, "run"));

    const result = captureToolCalls({
      logDir,
      logGlob: "*.jsonl",
      snapshot: snap,
      normalizer: "claude",
      runDir,
    });

    expect(result.sourceLogs).toEqual([first, second]);
    expect(toolNames(result.path).sort()).toEqual(["Edit", "Skill"]);
    expect(result.rowCount).toBe(2);
  });

  test("merge orders steps by timestamp across files", () => {
    // When a run produces two logs whose steps interleave by timestamp, the
    // merged trajectory must be timestamp-sorted, not file-concatenated. The
    // earlier-timestamped Skill (in the file sorting SECOND by name) must
    // precede the later-timestamped Edit (in the file sorting first).
    const tmp = makeTmp();
    const logDir = path.join(tmp, "gemini-home", ".gemini", "tmp");
    const subagent = path.join(logDir, "workdir", "chats", "abc", "subagent.jsonl");
    const main = path.join(logDir, "workdir", "chats", "session-20260612.jsonl");
    mkdir(path.dirname(subagent));
    mkdir(path.dirname(main));
    const snap = snapshotDir(logDir, "**/chats/**/*.jsonl");
    // subagent.jsonl sorts first by name but carries the LATER timestamp.
    writeFile(
      subagent,
      JSON.stringify({
        type: "gemini",
        timestamp: "2026-06-12T00:20:31.453Z",
        toolCalls: [{ id: "edit-1", name: "replace", args: { file_path: "app.js" } }],
      }) + "\n",
    );
    // session-*.jsonl sorts second by name but carries the EARLIER timestamp.
    writeFile(
      main,
      JSON.stringify({
        type: "gemini",
        timestamp: "2026-06-12T00:19:23.695Z",
        toolCalls: [{ id: "skill-1", name: "activate_skill", args: { name: "writing-plans" } }],
      }) + "\n",
    );
    const runDir = mkdir(path.join(tmp, "run"));

    const result = captureToolCalls({
      logDir,
      logGlob: "**/chats/**/*.jsonl",
      snapshot: snap,
      normalizer: "gemini",
      runDir,
    });

    expect(toolNames(result.path)).toEqual(["Skill", "Edit"]);
    expect(result.rowCount).toBe(2);
    const data = JSON.parse(fs.readFileSync(result.path, "utf8"));
    expect(data.steps.map((s: { step_id: number }) => s.step_id)).toEqual([1, 2]);
  });

  test("codex filter uses launch cwd", () => {
    const tmp = makeTmp();
    const logDir = path.join(tmp, "sessions");
    mkdir(logDir);
    const snap = snapshotDir(logDir, "*.jsonl");
    const launchCwd = mkdir(path.join(tmp, "launch-here"));
    const rollout = path.join(logDir, "rollout-1.jsonl");
    writeFile(
      rollout,
      JSON.stringify({ type: "session_meta", payload: { cwd: launchCwd } }) +
        "\n" +
        JSON.stringify({
          type: "response_item",
          payload: { type: "function_call", name: "spawn_agent", arguments: "{}" },
        }) +
        "\n",
    );

    const matched = captureToolCalls({
      logDir,
      logGlob: "*.jsonl",
      snapshot: snap,
      normalizer: "codex",
      runDir: mkdir(path.join(tmp, "run-match")),
      launchCwd,
    });
    // spawn_agent is aliased to the Claude-canonical Agent by the codex map.
    expect(toolNames(matched.path)).toEqual(["Agent"]);

    // A non-matching launch_cwd drops the rollout → empty capture, no file.
    const dropped = captureToolCalls({
      logDir,
      logGlob: "*.jsonl",
      snapshot: snap,
      normalizer: "codex",
      runDir: mkdir(path.join(tmp, "run-miss")),
      launchCwd: path.join(tmp, "elsewhere"),
    });
    expect(dropped.sourceLogs).toEqual([]);
    expect(dropped.rowCount).toBe(0);
    expect(fs.existsSync(dropped.path)).toBe(false);
  });

  test("kimi filter uses launch cwd", () => {
    const tmp = makeTmp();
    const logDir = path.join(tmp, "sessions");
    const matchDir = path.join(logDir, "wd_target", "session_match", "agents", "main");
    const otherDir = path.join(logDir, "wd_other", "session_other", "agents", "main");
    mkdir(matchDir);
    mkdir(otherDir);
    const snap = snapshotDir(logDir, "**/wire.jsonl");
    const launchCwd = mkdir(path.join(tmp, "launch-here"));
    const match = path.join(matchDir, "wire.jsonl");
    const other = path.join(otherDir, "wire.jsonl");
    writeFile(
      match,
      JSON.stringify({
        type: "context.append_loop_event",
        event: { type: "tool.call", name: "Read", args: { path: "README.md" } },
      }) + "\n",
    );
    writeFile(
      other,
      JSON.stringify({
        type: "context.append_loop_event",
        event: { type: "tool.call", name: "Bash", args: { command: "pwd" } },
      }) + "\n",
    );
    writeFile(
      path.join(tmp, "session_index.jsonl"),
      JSON.stringify({
        sessionId: "session_match",
        sessionDir: path.dirname(path.dirname(matchDir)),
        workDir: launchCwd,
      }) +
        "\n" +
        JSON.stringify({
          sessionId: "session_other",
          sessionDir: path.dirname(path.dirname(otherDir)),
          workDir: path.join(tmp, "elsewhere"),
        }) +
        "\n",
    );

    const matched = captureToolCalls({
      logDir,
      logGlob: "**/wire.jsonl",
      snapshot: snap,
      normalizer: "kimi",
      runDir: mkdir(path.join(tmp, "run-match")),
      launchCwd,
    });

    expect(toolNames(matched.path)).toEqual(["Read"]);
  });

  test("detectKimiCwdMismatch when new logs exist but none match", () => {
    const tmp = makeTmp();
    const logDir = path.join(tmp, "sessions");
    const sessionDir = path.join(logDir, "wd_other", "session_other");
    const wireDir = path.join(sessionDir, "agents", "main");
    mkdir(wireDir);
    const snap = snapshotDir(logDir, "**/wire.jsonl");
    const wire = path.join(wireDir, "wire.jsonl");
    writeFile(wire, "{}\n");
    writeFile(
      path.join(tmp, "session_index.jsonl"),
      JSON.stringify({ sessionDir, workDir: path.join(tmp, "wrong") }) + "\n",
    );

    expect(
      detectKimiCwdMismatch({
        logDir,
        logGlob: "**/wire.jsonl",
        snapshot: snap,
        launchCwd: path.join(tmp, "expected"),
      }),
    ).toEqual([wire]);
  });

  test("detectKimiCwdMismatch ignores unindexed logs", () => {
    const tmp = makeTmp();
    const logDir = path.join(tmp, "sessions");
    const sessionDir = path.join(logDir, "wd_other", "session_other");
    const wireDir = path.join(sessionDir, "agents", "main");
    mkdir(wireDir);
    const snap = snapshotDir(logDir, "**/wire.jsonl");
    writeFile(path.join(wireDir, "wire.jsonl"), "{}\n");

    expect(
      detectKimiCwdMismatch({
        logDir,
        logGlob: "**/wire.jsonl",
        snapshot: snap,
        launchCwd: path.join(tmp, "expected"),
      }),
    ).toEqual([]);
  });

  test("empty capture leaves no trajectory", () => {
    const tmp = makeTmp();
    const logDir = path.join(tmp, "logs");
    mkdir(logDir);
    const snap = snapshotDir(logDir, "*.jsonl");
    const runDir = mkdir(path.join(tmp, "run"));
    const result = captureToolCalls({
      logDir,
      logGlob: "*.jsonl",
      snapshot: snap,
      normalizer: "claude",
      runDir,
    });
    expect(result.sourceLogs).toEqual([]);
    expect(result.rowCount).toBe(0);
    expect(fs.existsSync(result.path)).toBe(false);
  });
});

describe("Pi session diagnostics", () => {
  test("detects misplaced pi sessions since snapshot", () => {
    const tmp = makeTmp();
    const logDir = mkdir(path.join(tmp, "sessions"));
    const launchCwd = mkdir(path.join(tmp, "coding-agent-workdir"));
    const wrongCwd = mkdir(path.join(tmp, "scratch"));
    const snap = snapshotDir(logDir, "*.jsonl");

    const session = path.join(logDir, "session.jsonl");
    writeFile(session, JSON.stringify({ type: "session", cwd: wrongCwd }) + "\n");

    expect(
      detectMisplacedPiSessions({
        logDir,
        logGlob: "*.jsonl",
        snapshot: snap,
        launchCwd,
      }),
    ).toEqual([session]);
  });

  test("detects unusable pi sessions since snapshot", () => {
    const tmp = makeTmp();
    const logDir = mkdir(path.join(tmp, "sessions"));
    const snap = snapshotDir(logDir, "*.jsonl");

    const malformed = path.join(logDir, "malformed.jsonl");
    writeFile(malformed, "{not json}\n");
    const missingCwd = path.join(logDir, "missing-cwd.jsonl");
    writeFile(missingCwd, JSON.stringify({ type: "session" }) + "\n");

    expect(
      detectUnusablePiSessions({
        logDir,
        logGlob: "*.jsonl",
        snapshot: snap,
      }),
    ).toEqual([malformed, missingCwd]);
  });
});

describe("captureToolCallsWithRetry", () => {
  test("no retry when first capture has rows", () => {
    const tmp = makeTmp();
    const logDir = mkdir(path.join(tmp, "logs"));
    const snap = snapshotDir(logDir, "*.jsonl");
    writeFile(path.join(logDir, "s.jsonl"), piToolCallLine());
    const runDir = mkdir(path.join(tmp, "run"));
    const sleeps: number[] = [];

    const result = captureToolCallsWithRetry({
      logDir,
      logGlob: "*.jsonl",
      snapshot: snap,
      normalizer: "pi",
      runDir,
      sleep: (s) => sleeps.push(s),
    });

    expect(result.rowCount).toBe(1);
    expect(result.attempts).toBe(1);
    expect(sleeps).toEqual([]);
  });

  test("retry loop reruns underlying capture until non-empty", () => {
    // Isolate the retry loop (PRI-2081) from emission: inject a capture impl
    // that returns an empty result first, then a non-empty one. The wrapper
    // must retry and return the non-empty result with attempts == 2.
    const tmp = makeTmp();
    const runDir = mkdir(path.join(tmp, "run"));
    const traj = path.join(runDir, "trajectory.json");
    const empty: CaptureResult = { path: traj, sourceLogs: [], rowCount: 0, attempts: 1 };
    const filled: CaptureResult = {
      path: traj,
      sourceLogs: [path.join(tmp, "s.jsonl")],
      rowCount: 3,
      attempts: 1,
    };
    const sleeps: number[] = [];
    const returns = [empty, filled];
    let callCount = 0;
    const captureImpl = (): CaptureResult => {
      callCount += 1;
      return returns.shift()!;
    };

    const result = captureToolCallsWithRetry({
      logDir: path.join(tmp, "logs"),
      logGlob: "*.jsonl",
      snapshot: new Set(),
      normalizer: "claude",
      runDir,
      attempts: 3,
      delayS: 2.0,
      sleep: (s) => sleeps.push(s),
      captureImpl,
    });

    expect(callCount).toBe(2);
    expect(result.rowCount).toBe(3);
    expect(result.sourceLogs).toEqual([path.join(tmp, "s.jsonl")]);
    expect(result.attempts).toBe(2);
    expect(sleeps).toEqual([2.0]);
  });

  test("retries pick up a late-appearing log", () => {
    const tmp = makeTmp();
    const logDir = mkdir(path.join(tmp, "logs"));
    const snap = snapshotDir(logDir, "*.jsonl");
    const runDir = mkdir(path.join(tmp, "run"));

    const sleepThenFlush = (): void => {
      writeFile(path.join(logDir, "late.jsonl"), piToolCallLine());
    };

    const result = captureToolCallsWithRetry({
      logDir,
      logGlob: "*.jsonl",
      snapshot: snap,
      normalizer: "pi",
      runDir,
      sleep: sleepThenFlush,
    });

    expect(result.rowCount).toBe(1);
    expect(result.sourceLogs.map((p) => path.basename(p))).toEqual(["late.jsonl"]);
    expect(result.attempts).toBe(2);
    expect(toolNames(result.path)).toEqual(["Read"]);
  });

  test("retries pick up a late-filling log", () => {
    // The file exists but yields zero tool calls (still mid-flush); content
    // arrives during the retry delay.
    const tmp = makeTmp();
    const logDir = mkdir(path.join(tmp, "logs"));
    const snap = snapshotDir(logDir, "*.jsonl");
    const runDir = mkdir(path.join(tmp, "run"));
    writeFile(path.join(logDir, "s.jsonl"), "");

    const sleepThenFill = (): void => {
      writeFile(path.join(logDir, "s.jsonl"), piToolCallLine());
    };

    const result = captureToolCallsWithRetry({
      logDir,
      logGlob: "*.jsonl",
      snapshot: snap,
      normalizer: "pi",
      runDir,
      sleep: sleepThenFill,
    });

    expect(result.rowCount).toBe(1);
    expect(result.attempts).toBe(2);
  });

  test("gives up after bounded attempts", () => {
    const tmp = makeTmp();
    const logDir = mkdir(path.join(tmp, "logs"));
    const snap = snapshotDir(logDir, "*.jsonl");
    const runDir = mkdir(path.join(tmp, "run"));
    const sleeps: number[] = [];

    const result = captureToolCallsWithRetry({
      logDir,
      logGlob: "*.jsonl",
      snapshot: snap,
      normalizer: "pi",
      runDir,
      attempts: 3,
      delayS: 2.0,
      sleep: (s) => sleeps.push(s),
    });

    expect(result.rowCount).toBe(0);
    expect(result.sourceLogs).toEqual([]);
    expect(result.attempts).toBe(3);
    expect(sleeps).toEqual([2.0, 2.0]);
    expect(fs.existsSync(result.path)).toBe(false);
  });
});
