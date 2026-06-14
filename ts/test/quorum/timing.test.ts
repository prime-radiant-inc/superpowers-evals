import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isoToMs, sessionLogsDurationMs } from "../../src/quorum/timing.ts";

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "timing-test-"));
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.writeFileSync(filePath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// isoToMs
// ---------------------------------------------------------------------------

describe("isoToMs", () => {
  test("parses Z-suffixed ISO timestamp to epoch ms", () => {
    const ms = isoToMs("2026-06-09T00:00:00.000Z");
    expect(ms).not.toBeNull();
    // 2026-06-09T00:00:00Z as epoch ms
    const expected = new Date("2026-06-09T00:00:00.000Z").getTime();
    expect(ms).toBe(expected);
  });

  test("parses ISO timestamp with +00:00 offset", () => {
    const ms = isoToMs("2026-06-09T00:01:24.000+00:00");
    expect(ms).not.toBeNull();
    const expected = new Date("2026-06-09T00:01:24.000Z").getTime();
    expect(ms).toBe(expected);
  });

  test("returns null for unparseable string", () => {
    expect(isoToMs("not a timestamp")).toBeNull();
    expect(isoToMs("")).toBeNull();
    expect(isoToMs("garbage")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// sessionLogsDurationMs — ports of test_timing.py cases
// ---------------------------------------------------------------------------

test("iso timestamps span — 84 seconds", () => {
  const tmp = makeTmp();
  const f = path.join(tmp, "s.jsonl");
  writeJsonl(f, [
    { type: "user", timestamp: "2026-06-09T00:00:00.000Z" },
    { type: "assistant", timestamp: "2026-06-09T00:01:24.000Z" },
  ]);
  expect(sessionLogsDurationMs([f])).toBe(84_000);
});

test("numeric time span — epoch-ms time field (Kimi)", () => {
  const tmp = makeTmp();
  const f = path.join(tmp, "wire.jsonl");
  writeJsonl(f, [
    { type: "usage.record", time: 1_800_000_000_000 },
    { type: "usage.record", time: 1_800_000_042_000 },
  ]);
  expect(sessionLogsDurationMs([f])).toBe(42_000);
});

test("span crosses files — subagent logs in sibling files", () => {
  const tmp = makeTmp();
  const a = path.join(tmp, "a.jsonl");
  const b = path.join(tmp, "b.jsonl");
  writeJsonl(a, [{ timestamp: "2026-06-09T00:00:00Z" }]);
  writeJsonl(b, [{ timestamp: "2026-06-09T00:00:30Z" }]);
  expect(sessionLogsDurationMs([a, b])).toBe(30_000);
});

test("no timestamps returns null", () => {
  const tmp = makeTmp();
  const f = path.join(tmp, "s.jsonl");
  writeJsonl(f, [{ type: "user" }, { type: "assistant" }]);
  expect(sessionLogsDurationMs([f])).toBeNull();
});

test("garbage lines skipped, numeric timestamp field ignored", () => {
  const tmp = makeTmp();
  const f = path.join(tmp, "s.jsonl");
  // Mirrors Python test: non-JSON line, two valid ISO timestamps, one numeric timestamp (ignored)
  fs.writeFileSync(
    f,
    "not json\n" +
      '{"timestamp": "2026-06-09T00:00:00Z"}\n' +
      '{"timestamp": 42}\n' +
      '{"timestamp": "2026-06-09T00:00:10Z"}\n',
    "utf8",
  );
  expect(sessionLogsDurationMs([f])).toBe(10_000);
});

test("missing file ignored — returns null", () => {
  const tmp = makeTmp();
  expect(sessionLogsDurationMs([path.join(tmp, "nope.jsonl")])).toBeNull();
});
