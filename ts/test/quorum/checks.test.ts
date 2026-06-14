import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  parseCodingAgentsDirective,
  runPhase,
} from "../../src/quorum/checks.ts";

// Absolute path to the repo's bin/ directory.
// This test file lives at ts/test/quorum/checks.test.ts
// The repo root is three levels up: ts/test/quorum → ts/test → ts → repo root.
const REPO = path.resolve(import.meta.dir, "../../..");
const QUORUM_BIN = path.join(REPO, "bin");

// ---- helpers ----

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "checks-test-"));
}

function rmrf(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

// ---- parseCodingAgentsDirective ----

describe("parseCodingAgentsDirective", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    rmrf(tmp);
  });

  test("returns list when directive is present", () => {
    const p = path.join(tmp, "checks.sh");
    fs.writeFileSync(p, "# coding-agents: codex, gemini\npre() { :; }\npost() { :; }\n");
    expect(parseCodingAgentsDirective(p)).toEqual(["codex", "gemini"]);
  });

  test("returns null when directive is absent", () => {
    const p = path.join(tmp, "checks.sh");
    fs.writeFileSync(p, "pre() { :; }\npost() { :; }\n");
    expect(parseCodingAgentsDirective(p)).toBeNull();
  });

  test("returns null when file does not exist", () => {
    const p = path.join(tmp, "nonexistent.sh");
    expect(parseCodingAgentsDirective(p)).toBeNull();
  });

  test("handles single agent", () => {
    const p = path.join(tmp, "checks.sh");
    fs.writeFileSync(p, "# coding-agents: claude\npre() { :; }\npost() { :; }\n");
    expect(parseCodingAgentsDirective(p)).toEqual(["claude"]);
  });

  test("strips whitespace from agent names", () => {
    const p = path.join(tmp, "checks.sh");
    fs.writeFileSync(p, "#  coding-agents:  codex ,  gemini  \npre() { :; }\n");
    expect(parseCodingAgentsDirective(p)).toEqual(["codex", "gemini"]);
  });

  test("only scans first 20 lines for directive", () => {
    const p = path.join(tmp, "checks.sh");
    const lines = Array(25).fill("# placeholder\n");
    lines[22] = "# coding-agents: codex\n";
    fs.writeFileSync(p, lines.join(""));
    // Directive at line 22 (0-indexed) is beyond the 20-line limit
    expect(parseCodingAgentsDirective(p)).toBeNull();
  });

  test("finds directive within 20-line limit", () => {
    const p = path.join(tmp, "checks.sh");
    const lines = Array(25).fill("# placeholder\n");
    lines[15] = "# coding-agents: codex\n";
    fs.writeFileSync(p, lines.join(""));
    expect(parseCodingAgentsDirective(p)).toEqual(["codex"]);
  });
});

// ---- runPhase ----

describe("runPhase", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    rmrf(tmp);
  });

  test("collects records from post phase", () => {
    const workdir = path.join(tmp, "wd");
    fs.mkdirSync(workdir);
    fs.writeFileSync(path.join(workdir, "x.md"), "hi");
    const checksSh = path.join(tmp, "checks.sh");
    fs.writeFileSync(
      checksSh,
      "pre() { git-repo 2>/dev/null || true; }\npost() { file-exists 'x.md'; file-exists 'missing.md'; }\n",
    );
    const { records, exitCode } = runPhase({
      checksSh,
      phase: "post",
      workdir,
      quorumBin: QUORUM_BIN,
    });
    expect(exitCode).toBe(0);
    expect(records).toHaveLength(2);
    expect(records[0]!.check).toBe("file-exists");
    expect(records[0]!.passed).toBe(true);
    expect(records[1]!.check).toBe("file-exists");
    expect(records[1]!.passed).toBe(false);
    expect(records.every((r) => r.phase === "post")).toBe(true);
  });

  test("nonzero exit signals crash for undefined function", () => {
    const workdir = path.join(tmp, "wd");
    fs.mkdirSync(workdir);
    const checksSh = path.join(tmp, "checks.sh");
    fs.writeFileSync(checksSh, "pre() { :; }\npost() { undefined_function_blam; }\n");
    const { exitCode } = runPhase({
      checksSh,
      phase: "post",
      workdir,
      quorumBin: QUORUM_BIN,
    });
    expect(exitCode).not.toBe(0);
  });

  test("crash after record still reports crash (exit 127)", () => {
    // Regression: a bash crash that fires AFTER a successful check tool emits
    // a record used to be masked by "exitCode = 0 if records". The fix: check
    // the bash-reserved exit-code range (126, 127, >=128) — those mean bash
    // itself crashed, not a tool's intentional fail-exit.
    const workdir = path.join(tmp, "wd");
    fs.mkdirSync(workdir);
    fs.writeFileSync(path.join(workdir, "x.md"), "hi");
    const checksSh = path.join(tmp, "checks.sh");
    fs.writeFileSync(
      checksSh,
      "pre() { :; }\npost() { file-exists 'x.md'; tools_called_typo; }\n",
    );
    const { records, exitCode } = runPhase({
      checksSh,
      phase: "post",
      workdir,
      quorumBin: QUORUM_BIN,
    });
    // file-exists record should still be captured
    expect(records.length).toBeGreaterThanOrEqual(1);
    // command-not-found crash should propagate as 127
    expect(exitCode).toBe(127);
  });

  test("tool failure does not look like crash (exit 0)", () => {
    // A normal tool failure (exit 1) is NOT a crash. file-exists on a missing
    // path exits 1, but the phase ran to completion. exitCode must stay 0.
    const workdir = path.join(tmp, "wd");
    fs.mkdirSync(workdir);
    const checksSh = path.join(tmp, "checks.sh");
    fs.writeFileSync(checksSh, "pre() { :; }\npost() { file-exists 'missing.md'; }\n");
    const { records, exitCode } = runPhase({
      checksSh,
      phase: "post",
      workdir,
      quorumBin: QUORUM_BIN,
    });
    expect(exitCode).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0]!.passed).toBe(false);
  });

  test("exports QUORUM_RUN_DIR so checks can access sibling paths", () => {
    const runDir = path.join(tmp, "run");
    fs.mkdirSync(runDir);
    const workdir = path.join(runDir, "wd");
    fs.mkdirSync(workdir);
    fs.writeFileSync(path.join(runDir, "sibling.txt"), "ok");
    const checksSh = path.join(tmp, "checks.sh");
    fs.writeFileSync(
      checksSh,
      'pre() { :; }\npost() { command-succeeds \'test -f "$QUORUM_RUN_DIR/sibling.txt"\'; }\n',
    );
    const { records, exitCode } = runPhase({
      checksSh,
      phase: "post",
      workdir,
      quorumBin: QUORUM_BIN,
      runDir,
    });
    expect(exitCode).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0]!.passed).toBe(true);
  });

  test("exports QUORUM_TRANSCRIPT_PATH env var", () => {
    const runDir = path.join(tmp, "run");
    fs.mkdirSync(runDir);
    const workdir = path.join(runDir, "wd");
    fs.mkdirSync(workdir);
    const transcript = path.join(runDir, "trajectory.json");
    const checksSh = path.join(tmp, "checks.sh");
    fs.writeFileSync(
      checksSh,
      "pre() { :; }\n" +
        "post() {\n" +
        `  command-succeeds "test \\"\\$QUORUM_TRANSCRIPT_PATH\\" = \\"${transcript}\\"";\n` +
        "}\n",
    );
    const { records, exitCode } = runPhase({
      checksSh,
      phase: "post",
      workdir,
      quorumBin: QUORUM_BIN,
      transcriptPath: transcript,
      runDir,
    });
    expect(exitCode).toBe(0);
    expect(records).toHaveLength(1);
    expect(records.every((r) => r.passed)).toBe(true);
  });

  test("sets QUORUM_TRANSCRIPT_PATH even when file is absent (fail-closed)", () => {
    // Fail-closed: QUORUM_TRANSCRIPT_PATH is set even though trajectory.json
    // does not exist (agent without ATIF support, or emission failed).
    const runDir = path.join(tmp, "run");
    fs.mkdirSync(runDir);
    const workdir = path.join(runDir, "wd");
    fs.mkdirSync(workdir);
    const transcript = path.join(runDir, "trajectory.json"); // never created
    const checksSh = path.join(tmp, "checks.sh");
    fs.writeFileSync(
      checksSh,
      "pre() { :; }\n" +
        "post() {\n" +
        `  command-succeeds "test \\"\\$QUORUM_TRANSCRIPT_PATH\\" = \\"${transcript}\\"";\n` +
        "}\n",
    );
    const { records, exitCode } = runPhase({
      checksSh,
      phase: "post",
      workdir,
      quorumBin: QUORUM_BIN,
      transcriptPath: transcript,
    });
    expect(exitCode).toBe(0);
    expect(fs.existsSync(transcript)).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0]!.passed).toBe(true);
  });

  test("omits QUORUM_RUN_DIR when runDir not provided", () => {
    // Without runDir, the env var must be unset — checks that need it should
    // fail gracefully rather than silently inherit a stale value.
    const workdir = path.join(tmp, "wd");
    fs.mkdirSync(workdir);
    const checksSh = path.join(tmp, "checks.sh");
    fs.writeFileSync(
      checksSh,
      'pre() { :; }\npost() { command-succeeds \'test -z "${QUORUM_RUN_DIR:-}"\'; }\n',
    );
    const { records, exitCode } = runPhase({
      checksSh,
      phase: "post",
      workdir,
      quorumBin: QUORUM_BIN,
    });
    expect(exitCode).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0]!.passed).toBe(true);
  });

  test("stamps phase field on all records", () => {
    const workdir = path.join(tmp, "wd");
    fs.mkdirSync(workdir);
    fs.writeFileSync(path.join(workdir, "a.md"), "a");
    const checksSh = path.join(tmp, "checks.sh");
    fs.writeFileSync(
      checksSh,
      "pre() { file-exists 'a.md'; }\npost() { :; }\n",
    );
    const { records, exitCode } = runPhase({
      checksSh,
      phase: "pre",
      workdir,
      quorumBin: QUORUM_BIN,
    });
    expect(exitCode).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0]!.phase).toBe("pre");
  });
});

// ---- check-transcript shim tests (bun is always present in bun test) ----

describe("check-transcript shim", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpDir();
  });
  afterEach(() => {
    rmrf(tmp);
  });

  test("shim runs and writes a record", () => {
    const traj = {
      schema_version: "ATIF-v1.7",
      agent: { name: "test", version: "1.0" },
      steps: [
        {
          step_id: 1,
          source: "agent",
          tool_calls: [
            {
              tool_call_id: "c1",
              function_name: "Write",
              arguments: { file_path: "x.md" },
            },
          ],
        },
      ],
    };
    const trajPath = path.join(tmp, "trajectory.json");
    fs.writeFileSync(trajPath, JSON.stringify(traj));
    const sink = path.join(tmp, "sink.jsonl");
    const workdir = path.join(tmp, "wd");
    fs.mkdirSync(workdir);

    const env = {
      ...process.env,
      PATH: `${QUORUM_BIN}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
      QUORUM_TRANSCRIPT_PATH: trajPath,
      QUORUM_RECORD_SINK: sink,
    };

    const result = Bun.spawnSync(
      ["check-transcript", "tool-called", "Write"],
      { cwd: workdir, env },
    );
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(sink)).toBe(true);
    const lines = fs.readFileSync(sink, "utf8").split("\n").filter((l) => l.trim());
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!);
    expect(rec["check"]).toBe("tool-called");
    expect(rec["passed"]).toBe(true);
  });

  test("typo'd verb under `not` does not silently pass", () => {
    // A typo'd verb under `not` must NOT invert into a pass. check-transcript
    // exits 127 (in bin/not's crash range) on a usage error, so `not` treats
    // it as a crash → records a fail and exits non-zero, surfacing the broken
    // check instead of green-lighting a check that never ran.
    const traj = {
      schema_version: "ATIF-v1.7",
      agent: { name: "test", version: "1.0" },
      steps: [
        {
          step_id: 1,
          source: "agent",
          tool_calls: [
            { tool_call_id: "c1", function_name: "Write", arguments: {} },
          ],
        },
      ],
    };
    const trajPath = path.join(tmp, "trajectory.json");
    fs.writeFileSync(trajPath, JSON.stringify(traj));
    const sink = path.join(tmp, "sink.jsonl");
    const workdir = path.join(tmp, "wd");
    fs.mkdirSync(workdir);
    const env = {
      ...process.env,
      PATH: `${QUORUM_BIN}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
      QUORUM_TRANSCRIPT_PATH: trajPath,
      QUORUM_RECORD_SINK: sink,
    };
    const result = Bun.spawnSync(
      ["not", "check-transcript", "totally-bogus-verb"],
      { cwd: workdir, env },
    );
    expect(result.exitCode).not.toBe(0);
    const lines = fs.existsSync(sink)
      ? fs.readFileSync(sink, "utf8").split("\n").filter((l) => l.trim())
      : [];
    expect(lines.length).toBeGreaterThan(0);
    const rec = JSON.parse(lines[lines.length - 1]!);
    expect(rec["passed"]).toBe(false);
  });
});
