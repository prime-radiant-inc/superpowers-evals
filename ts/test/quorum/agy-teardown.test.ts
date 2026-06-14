import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { killRunTmuxServer, type TmuxRunResult } from "../../src/quorum/agy-teardown.ts";

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agy-teardown-test-"));
}

/**
 * Return a { runner, calls } pair. runner() records every command it receives
 * and, when the command is a list-panes call, returns the canned stdout for that
 * socket name. Mirrors test_agy_teardown.py's make_runner.
 */
function makeRunner(panes: Record<string, string>): {
  runner: (cmd: string[]) => TmuxRunResult;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner = (cmd: string[]): TmuxRunResult => {
    calls.push(cmd);
    let stdout = "";
    if (cmd.includes("list-panes")) {
      const name = cmd[2] ?? "";
      stdout = panes[name] ?? "";
    }
    return { returncode: 0, stdout, stderr: "" };
  };
  return { runner, calls };
}

describe("killRunTmuxServer", () => {
  test("kills the server under the scratch dir", () => {
    const tmp = makeTmp();
    const scratch = path.join(tmp, "run123", "gauntlet-agent", "scratch");
    fs.mkdirSync(scratch, { recursive: true });
    const { runner, calls } = makeRunner({
      "gauntlet-1-aaaaaa": "/some/other/scratch\n",
      "gauntlet-2-bbbbbb": `${scratch}\n`,
    });
    const killed = killRunTmuxServer(scratch, {
      runner,
      listSockets: () => ["gauntlet-1-aaaaaa", "gauntlet-2-bbbbbb"],
    });
    expect(killed).toBe(true);
    expect(calls).toContainEqual(["tmux", "-L", "gauntlet-2-bbbbbb", "kill-server"]);
    expect(calls).not.toContainEqual(["tmux", "-L", "gauntlet-1-aaaaaa", "kill-server"]);
  });

  test("no match returns false", () => {
    const tmp = makeTmp();
    const killed = killRunTmuxServer(tmp, {
      runner: () => ({ returncode: 0, stdout: "", stderr: "" }),
      listSockets: () => [],
    });
    expect(killed).toBe(false);
  });

  test("does not false-match sibling dir", () => {
    const tmp = makeTmp();
    const scratch = path.join(tmp, "run123", "gauntlet-agent", "scratch");
    fs.mkdirSync(scratch, { recursive: true });
    const sibling = path.join(tmp, "run123", "gauntlet-agent", "scratch-extra");
    fs.mkdirSync(sibling, { recursive: true });

    const { runner, calls } = makeRunner({ "gauntlet-1-aaaaaa": `${sibling}\n` });
    const killed = killRunTmuxServer(scratch, {
      runner,
      listSockets: () => ["gauntlet-1-aaaaaa"],
    });
    expect(killed).toBe(false);
    expect(calls).not.toContainEqual(["tmux", "-L", "gauntlet-1-aaaaaa", "kill-server"]);
  });

  test("non-matching pane returns false", () => {
    const tmp = makeTmp();
    const { runner } = makeRunner({ "gauntlet-1-aaaaaa": "/unrelated/path\n" });
    const killed = killRunTmuxServer(tmp, {
      runner,
      listSockets: () => ["gauntlet-1-aaaaaa"],
    });
    expect(killed).toBe(false);
  });

  test("stops at first match", () => {
    const tmp = makeTmp();
    const scratch = path.join(tmp, "run456", "gauntlet-agent", "scratch");
    fs.mkdirSync(scratch, { recursive: true });

    const { runner, calls } = makeRunner({
      "gauntlet-1-aaaaaa": `${scratch}\n`,
      "gauntlet-2-bbbbbb": "/some/other/path\n",
    });
    const killed = killRunTmuxServer(scratch, {
      runner,
      listSockets: () => ["gauntlet-1-aaaaaa", "gauntlet-2-bbbbbb"],
    });
    expect(killed).toBe(true);
    // The second server's list-panes must NOT have been called.
    const listPanesTargets = calls.filter((c) => c.includes("list-panes")).map((c) => c[2]);
    expect(listPanesTargets).not.toContain("gauntlet-2-bbbbbb");
  });
});
