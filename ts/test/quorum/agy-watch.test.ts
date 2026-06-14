/**
 * Watcher lifecycle tests (ported from tests/quorum/test_agy_watch.py).
 *
 * Verifies the start -> detect -> fire-teardown-once -> stop lifecycle, that a
 * clean log never trips, that stop() before start() is safe, and that the
 * watcher tolerates an initially-absent log that is created later.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgyRateLimitWatcher } from "../../src/quorum/agy-watch.ts";

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agy-watch-test-"));
}

async function runUntil(pred: () => boolean, timeout = 2000): Promise<boolean> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("AgyRateLimitWatcher", () => {
  test("detects RESOURCE_EXHAUSTED and tears down", async () => {
    const tmp = makeTmp();
    const log = path.join(tmp, "agy.log");
    fs.writeFileSync(log, "starting\n", "utf8");
    const killed: string[] = [];
    const w = new AgyRateLimitWatcher(log, tmp, {
      teardown: (sd) => {
        killed.push(sd);
        return true;
      },
      pollIntervalMs: 20,
    });
    w.start();
    fs.appendFileSync(log, "googleapi: Error 429: RESOURCE_EXHAUSTED\n", "utf8");
    expect(await runUntil(() => w.tripped)).toBe(true);
    expect(killed).toEqual([tmp]);
    expect(w.matchedText).toContain("RESOURCE_EXHAUSTED");
    await w.stop();
  });

  test("clean log does not trip", async () => {
    const tmp = makeTmp();
    const log = path.join(tmp, "agy.log");
    fs.writeFileSync(log, "all good\nmore output\n", "utf8");
    const w = new AgyRateLimitWatcher(log, tmp, { teardown: () => true, pollIntervalMs: 20 });
    w.start();
    await sleep(200);
    expect(w.tripped).toBe(false);
    await w.stop();
  });

  test("stop before start does not raise", async () => {
    const tmp = makeTmp();
    const w = new AgyRateLimitWatcher(path.join(tmp, "agy.log"), tmp, { teardown: () => true });
    await w.stop(); // never started — must not raise
    expect(w.tripped).toBe(false);
  });

  test("tolerates absent then created log", async () => {
    const tmp = makeTmp();
    const log = path.join(tmp, "agy.log"); // does not exist yet
    const w = new AgyRateLimitWatcher(log, tmp, { teardown: () => true, pollIntervalMs: 20 });
    w.start();
    await sleep(100);
    fs.writeFileSync(log, "429 RESOURCE_EXHAUSTED\n", "utf8");
    expect(await runUntil(() => w.tripped)).toBe(true);
    await w.stop();
  });

  test("fires teardown exactly once", async () => {
    const tmp = makeTmp();
    const log = path.join(tmp, "agy.log");
    fs.writeFileSync(log, "starting\n", "utf8");
    let calls = 0;
    const w = new AgyRateLimitWatcher(log, tmp, {
      teardown: () => {
        calls++;
        return true;
      },
      pollIntervalMs: 20,
    });
    w.start();
    fs.appendFileSync(log, "RESOURCE_EXHAUSTED\n", "utf8");
    expect(await runUntil(() => w.tripped)).toBe(true);
    // Append more rate-limit signal; the watcher has already returned and must
    // not fire teardown again.
    fs.appendFileSync(log, "RESOURCE_EXHAUSTED again\n", "utf8");
    await sleep(150);
    expect(calls).toBe(1);
    await w.stop();
  });

  test("stop is clean and idempotent (no leaked loop)", async () => {
    const tmp = makeTmp();
    const log = path.join(tmp, "agy.log");
    fs.writeFileSync(log, "all good\n", "utf8");
    const w = new AgyRateLimitWatcher(log, tmp, { teardown: () => true, pollIntervalMs: 20 });
    w.start();
    await sleep(50);
    await w.stop();
    expect(w.running).toBe(false);
    await w.stop(); // second stop is a no-op, must not raise
    expect(w.running).toBe(false);
  });
});
