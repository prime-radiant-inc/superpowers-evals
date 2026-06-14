# Phase E — port capture (session-log location + ATIF merge + retry) to TS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Port `quorum/capture.py` (495 LOC) — the per-run capture step (locate new session logs → emit a merged ATIF `trajectory.json` → empty-capture retry → per-backend diagnostics) — from Python to TS/bun, parity-locked by `tests/quorum/test_capture.py` (773 LOC).

**Architecture:** Strangler-fig, build-ahead under `ts/src/quorum/` — NOT wired into the live runner or deleted yet (the Python runner uses it until the spine flips, Phase G). **Depends on already-ported TS:** `log-filters` (Phase B, merged) and the TS normalizers + `flattenToolCalls`/`validateTrajectory` (the cutover). Key simplification: the Python `capture.py` shells out to `bun` to emit ATIF; **the TS `capture.ts` calls the normalizers + merge IN-PROCESS** (no subprocess) — same outputs, faster.

**Tech stack:** TS, bun. No new deps.

---

## Scope & model
Port `quorum/capture.py` → `ts/src/quorum/capture.ts`, build-ahead, tests ported from `test_capture.py`. Do not modify/delete Python.

## Public API to port (preserve semantics + output shapes exactly)
- `interface CaptureResult { ... }` — mirror the dataclass (path/trajectory path, source_logs, row_count, attempts).
- `interface KimiUnmatchedLogsDiagnostic { ... }`
- `snapshotDir(logDir, glob): Set<string>` (from `snapshot_dir`)
- `newFilesSince(logDir, glob, snapshot): string[]` (from `new_files_since`)
- `captureToolCalls(opts): CaptureResult` (from `capture_tool_calls`) — locate new source logs (via `_new_session_logs` + the Phase-B `log-filters` cwd filters), normalize EACH to ATIF in-process, **merge** via the port of `_merge_trajectories`, write `run_dir/trajectory.json`, set `row_count` = merged tool-call count; fail-closed (no logs / zero tool_calls → row_count 0, unlink stale trajectory).
- `captureToolCallsWithRetry(opts): CaptureResult` (from `capture_tool_calls_with_retry`) — **the PRI-2081 retry loop: `while result.row_count === 0 && used < attempts`**. Port the loop shape EXACTLY (it's the load-bearing flaky-race guard).
- `detectMisplacedCodexRollouts(...)`, `detectMisplacedPiSessions(...)`, `detectUnusablePiSessions(...)`, `diagnoseKimiUnmatchedLogs(...)` + the kimi-index helpers (`_kimi_home_for_log`, `_read_kimi_session_index`, `_indexed_wrong_cwd_kimi_logs`).
- private merge helpers: `_merge_trajectories` (**timestamp-ordered, stable fallback to (file_index, in_file_index), step_id renumbered — this is the multi-log fix; match it exactly**), `_steps_tool_call_count`, `_step_timestamp`, `_trajectory_tool_call_count`, `_new_session_logs`.

## Gnarly bits (read the Python carefully)
1. **The merge** (`_merge_trajectories`) — the timestamp ordering + stable fallback + step_id renumber. The Python tests (`test_merges_tool_calls_from_all_source_logs`, `test_merge_orders_steps_by_timestamp_across_files`) pin it; the TS must reproduce identical merged step order + ids.
2. **The retry** — same loop semantics; unit-test with a mock capture returning row_count 0 then >0.
3. **In-process ATIF** — instead of `emit_atif_trajectory` shelling to bun, import the TS normalizer dispatch (the `normalize.ts` per-agent functions) + `flattenToolCalls` directly. Confirm the merged output still passes `validateTrajectory`.
4. **Source-log location + cwd filters** — reuse `ts/src/quorum/log-filters.ts` (codex/pi/kimi cwd filtering) faithfully.

## Tasks (subagent-driven)
- [ ] **Task 1:** Port the pure helpers + merge: `snapshotDir`, `newFilesSince`, `_new_session_logs`, `_merge_trajectories` + `_step*`/`_trajectory_tool_call_count`. Port their `test_capture.py` cases (incl. the merge-ordering + multi-file cases) RED→green. Commit.
- [ ] **Task 2:** Port `captureToolCalls` (in-process ATIF emit + merge + fail-closed) and `captureToolCallsWithRetry` (the retry). Port the capture + retry tests RED→green (incl. the retry mock test). Commit.
- [ ] **Task 3:** Port the diagnostics (`detect_*`, kimi unmatched-logs) + their tests. Commit.
- [ ] **Final:** `cd ts && bun test` + `bun run typecheck` green; `uv run pytest tests/ -q` + `uv run ruff check` confirm Python untouched. Note phase complete (build-ahead).

## Self-Review
Covers every public function + the 3 gnarly bits (merge, retry, in-process ATIF). Output shapes (`CaptureResult`, the trajectory) flagged must-match. Depends on merged Phase-B `log-filters` + the TS normalizers. No placeholders — `capture.py` + `test_capture.py` are the spec. ✓

## Execution Handoff
Saved here. Execute with superpowers:subagent-driven-development; Task 1 (merge/helpers) precedes Task 2 (capture/retry). This is the heaviest leaf (773-LOC test file) — expect the most careful review on the merge + retry.
