/**
 * Regression tests for agyLogShowsRateLimit (ported from
 * tests/quorum/test_agy_rate_limit_matcher.py).
 *
 * A live agy sentinel sweep (2026-06-05) false-tripped: the bare "429" substring
 * matched a hex trace ID in the streaming agy.log (`Trace: 0xfa48dee42910dc8f` →
 * "...e4291..."), so the mid-run watcher killed a perfectly healthy agy run. The
 * matcher must require a *real* rate-limit signal, not any "429" anywhere.
 */

import { describe, expect, test } from "bun:test";
import { agyLogShowsRateLimit } from "../../src/quorum/agy-watch.ts";

// Verbatim line from the false-positive run
// (results/triggering-test-driven-development-antigravity-20260605T054333Z-d12c).
const HEX_TRACE_LINE =
  "I0604 22:43:45.882303 259 http_helpers.go:182] " +
  "URL: https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist " +
  "Trace: 0xfa48dee42910dc8f";

describe("agyLogShowsRateLimit", () => {
  test("ignores 429 inside a hex trace id", () => {
    expect(agyLogShowsRateLimit(HEX_TRACE_LINE)).toBe(false);
  });

  test("ignores 429 embedded in other numbers", () => {
    // ports, byte counts, etc. contain "429" without being a rate limit
    expect(agyLogShowsRateLimit("Language server listening on port 14290")).toBe(false);
    expect(agyLogShowsRateLimit("read 4296 bytes from stream")).toBe(false);
  });

  test("fires on real rate limit signals", () => {
    expect(agyLogShowsRateLimit("googleapi: Error 429: RESOURCE_EXHAUSTED")).toBe(true);
    expect(agyLogShowsRateLimit("HTTP status: 429 Too Many Requests")).toBe(true);
    expect(agyLogShowsRateLimit("rpc error RESOURCE_EXHAUSTED: quota")).toBe(true);
    expect(agyLogShowsRateLimit("backend returned RateLimitExceeded")).toBe(true);
  });

  test("clean log does not fire", () => {
    expect(agyLogShowsRateLimit("I0604 server.go:1292] Starting language server")).toBe(false);
    expect(agyLogShowsRateLimit("")).toBe(false);
  });
});
