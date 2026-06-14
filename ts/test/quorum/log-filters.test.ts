import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  filterCodexLogsByCwd,
  filterKimiLogsByCwd,
  filterPiLogsByCwd,
  findMisplacedCodexRollouts,
  findMisplacedPiSessions,
  findUnusablePiSessions,
} from "../../src/quorum/log-filters.ts";

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "log-filters-test-"));
}

function writeJson(filePath: string, obj: unknown): string {
  fs.writeFileSync(filePath, JSON.stringify(obj) + "\n", "utf8");
  return filePath;
}

describe("filterCodexLogsByCwd", () => {
  test("keeps matching, drops non-matching, no-meta, and empty files", () => {
    const tmp = makeTmp();
    const target = "/private/tmp/drill-target";

    const matchPath = path.join(tmp, "match.jsonl");
    writeJson(matchPath, {
      type: "session_meta",
      payload: { id: "abc", cwd: target },
    });

    const otherPath = path.join(tmp, "other.jsonl");
    writeJson(otherPath, {
      type: "session_meta",
      payload: { id: "def", cwd: "/private/tmp/drill-other" },
    });

    const noMetaPath = path.join(tmp, "no-meta.jsonl");
    writeJson(noMetaPath, { type: "response_item", payload: {} });

    const emptyPath = path.join(tmp, "empty.jsonl");
    fs.writeFileSync(emptyPath, "", "utf8");

    const kept = filterCodexLogsByCwd(
      [matchPath, otherPath, noMetaPath, emptyPath],
      target,
    );
    expect(kept).toEqual([matchPath]);
  });

  test("resolves symlinked paths for comparison", () => {
    const tmp = makeTmp();
    const real = path.join(tmp, "real-workdir");
    fs.mkdirSync(real);
    const link = path.join(tmp, "linked-workdir");
    fs.symlinkSync(real, link);

    const rolloutPath = path.join(tmp, "rollout.jsonl");
    writeJson(rolloutPath, {
      type: "session_meta",
      payload: { id: "abc", cwd: fs.realpathSync(real) },
    });

    const kept = filterCodexLogsByCwd([rolloutPath], link);
    expect(kept).toEqual([rolloutPath]);
  });
});

describe("findMisplacedCodexRollouts", () => {
  test("flags rollouts inside run_dir but with wrong cwd", () => {
    const tmp = makeTmp();
    const runDir = path.join(tmp, "run");
    fs.mkdirSync(runDir);
    const workdir = path.join(runDir, "coding-agent-workdir");
    fs.mkdirSync(workdir);
    const scratch = path.join(runDir, "gauntlet-agent", "scratch");
    fs.mkdirSync(scratch, { recursive: true });

    const goodPath = path.join(tmp, "good.jsonl");
    writeJson(goodPath, {
      type: "session_meta",
      payload: { cwd: fs.realpathSync(workdir) },
    });

    const misplacedPath = path.join(tmp, "misplaced.jsonl");
    writeJson(misplacedPath, {
      type: "session_meta",
      payload: { cwd: fs.realpathSync(scratch) },
    });

    const unrelatedPath = path.join(tmp, "unrelated.jsonl");
    writeJson(unrelatedPath, {
      type: "session_meta",
      payload: { cwd: "/tmp/some-other-run" },
    });

    const misplaced = findMisplacedCodexRollouts(
      [goodPath, misplacedPath, unrelatedPath],
      { runDir, launchCwd: workdir },
    );
    expect(misplaced).toEqual([misplacedPath]);
  });

  test("resolves symlinked paths when checking run_dir membership", () => {
    const tmp = makeTmp();
    const real = path.join(tmp, "real-run");
    fs.mkdirSync(real);
    fs.mkdirSync(path.join(real, "coding-agent-workdir"));
    const scratch = path.join(real, "gauntlet-agent", "scratch");
    fs.mkdirSync(scratch, { recursive: true });
    const link = path.join(tmp, "linked-run");
    fs.symlinkSync(real, link);

    const rolloutPath = path.join(tmp, "rollout.jsonl");
    writeJson(rolloutPath, {
      type: "session_meta",
      payload: { cwd: fs.realpathSync(scratch) },
    });

    const misplaced = findMisplacedCodexRollouts([rolloutPath], {
      runDir: link,
      launchCwd: path.join(link, "coding-agent-workdir"),
    });
    expect(misplaced).toEqual([rolloutPath]);
  });
});

describe("filterPiLogsByCwd", () => {
  test("keeps matching session headers, drops non-matching and malformed", () => {
    const tmp = makeTmp();
    const target = "/tmp/drill-target";

    const matchPath = path.join(tmp, "match.jsonl");
    writeJson(matchPath, { type: "session", cwd: target });

    const otherPath = path.join(tmp, "other.jsonl");
    writeJson(otherPath, { type: "session", cwd: "/tmp/other" });

    const malformedPath = path.join(tmp, "malformed.jsonl");
    fs.writeFileSync(malformedPath, "not json\n", "utf8");

    const kept = filterPiLogsByCwd([matchPath, otherPath, malformedPath], target);
    expect(kept).toEqual([matchPath]);
  });

  test("resolves symlinked paths for comparison", () => {
    const tmp = makeTmp();
    const real = path.join(tmp, "real-workdir");
    fs.mkdirSync(real);
    const link = path.join(tmp, "linked-workdir");
    fs.symlinkSync(real, link);

    const sessionPath = path.join(tmp, "session.jsonl");
    writeJson(sessionPath, { type: "session", cwd: fs.realpathSync(real) });

    const kept = filterPiLogsByCwd([sessionPath], link);
    expect(kept).toEqual([sessionPath]);
  });
});

describe("findMisplacedPiSessions", () => {
  test("reports sessions whose cwd does not match launch_cwd", () => {
    const tmp = makeTmp();
    const launchCwd = path.join(tmp, "run", "coding-agent-workdir");
    const wrongCwd = path.join(tmp, "scratch");
    fs.mkdirSync(launchCwd, { recursive: true });
    fs.mkdirSync(wrongCwd);

    const sessionPath = path.join(tmp, "session.jsonl");
    writeJson(sessionPath, { type: "session", cwd: wrongCwd });

    const misplaced = findMisplacedPiSessions([sessionPath], { launchCwd });
    expect(misplaced).toEqual([sessionPath]);
  });
});

describe("findUnusablePiSessions", () => {
  test("reports malformed, missing cwd, and non-session first rows", () => {
    const tmp = makeTmp();

    const malformedPath = path.join(tmp, "malformed.jsonl");
    fs.writeFileSync(malformedPath, "{not json}\n", "utf8");

    const missingCwdPath = path.join(tmp, "missing-cwd.jsonl");
    writeJson(missingCwdPath, { type: "session" });

    const textFirstPath = path.join(tmp, "text-first.jsonl");
    writeJson(textFirstPath, { type: "message" });

    const unusable = findUnusablePiSessions([
      malformedPath,
      missingCwdPath,
      textFirstPath,
    ]);
    expect(unusable).toEqual([malformedPath, missingCwdPath, textFirstPath]);
  });
});

describe("filterKimiLogsByCwd", () => {
  test("uses session_index.jsonl to match workDir against target", () => {
    const tmp = makeTmp();
    const target = "/tmp/kimi-target";

    const matchDir = path.join(tmp, "sessions", "wd_target", "session_match");
    const otherDir = path.join(tmp, "sessions", "wd_other", "session_other");
    fs.mkdirSync(matchDir, { recursive: true });
    fs.mkdirSync(otherDir, { recursive: true });

    const matchPath = path.join(matchDir, "wire.jsonl");
    const otherPath = path.join(otherDir, "wire.jsonl");
    fs.writeFileSync(matchPath, "{}\n", "utf8");
    fs.writeFileSync(otherPath, "{}\n", "utf8");

    const indexPath = path.join(tmp, "session_index.jsonl");
    fs.writeFileSync(
      indexPath,
      JSON.stringify({
        sessionId: "session_match",
        sessionDir: matchDir,
        workDir: target,
      }) +
        "\n" +
        JSON.stringify({
          sessionId: "session_other",
          sessionDir: otherDir,
          workDir: "/tmp/elsewhere",
        }) +
        "\n",
      "utf8",
    );

    const kept = filterKimiLogsByCwd([matchPath, otherPath], target);
    expect(kept).toEqual([matchPath]);
  });
});
