# Phase C — port cost/timing (obol) to TS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Port the cost/timing modules (`timing`, `obol_capture`, `economics`) from Python to TS/bun, parity-locked by their pytest cases.

**Architecture:** Strangler-fig, build-ahead under `ts/src/quorum/` — NOT wired into the live Python harness or deleted yet (the runner still uses the Python versions until the spine flips, Phase G). Phase B leaves must be merged first (no hard dep, but same workspace).

**Tech stack:** TypeScript, bun. New dep: **`@primeradianthq/obol`** (the bun/TS obol binding — prudence uses it; Jesse confirmed it should work). `timing`/`economics` need no new deps.

---

## Scope & model

Port `quorum/timing.py` (50), `quorum/obol_capture.py` (175), `quorum/economics.py` (163) → `ts/src/quorum/`. Build-ahead, tests ported from `tests/quorum/test_timing.py` (61), `test_obol_capture.py` (312), `test_obol_smoke.py` (39), `test_economics.py` (258). Do not modify/delete Python.

**The crux — RESOLVED (validated GREEN 2026-06-14):** `@primeradianthq/obol@0.4.1`
is a drop-in for the Python `obol`: all 8 dialects, **byte-for-byte parity** on
real + synthetic data. Two notes baked into the tasks below: (a) `estimatePath`
is **async** (`await`), so the estimate functions return `Promise`; (b) version
skew (py 0.4.0 vs bun 0.4.1, behaviorally identical) — recommend pinning the
Python dep to `>=0.4.1` at the end so they can't drift. Original gating note:

**(verify the bun obol API)** `obol_capture.py` calls `obol.estimate_path(path, dialect=<str>) -> obol.CostEstimate` and catches `obol.ObolError`. Confirm `@primeradianthq/obol` exposes equivalents (likely `estimatePath`/`CostEstimate`/`ObolError` — read its types) and that `CostEstimate` carries the fields `_merge_estimates` reads (the per-bucket subtotals: input/cache_create/cache_read/output, and cost). If the bun API diverges materially, STOP and report — economics may need to stay Python (a permanent hybrid seam) rather than a forced port.

## Dependency

`cd ts && bun add @primeradianthq/obol`. It pulls a native binding (koffi); confirm it builds/installs in this environment and a trivial `estimatePath` round-trips on a real fixture before proceeding.

## File structure
- Create: `ts/src/quorum/timing.ts`, `ts/src/quorum/obol-capture.ts`, `ts/src/quorum/economics.ts`
- Create: `ts/test/quorum/timing.test.ts`, `obol-capture.test.ts`, `obol-smoke.test.ts`, `economics.test.ts`
- Modify: `ts/package.json` (add obol)

---

## Task 1: obol-bun smoke + dep (gating)

- [ ] `cd ts && bun add @primeradianthq/obol`; write `ts/test/quorum/obol-smoke.test.ts` porting `tests/quorum/test_obol_smoke.py` — call the bun `estimatePath` on the same fixture(s) and assert a `CostEstimate` with the expected buckets/cost. Run it.
- [ ] If the bun API can't reproduce the smoke test, STOP and report the divergence (don't force the rest of the phase).
- [ ] Commit `chore(ts): add @primeradianthq/obol + smoke test (phase C)`.

## Task 2: Port `timing` (no obol)

**Source:** `quorum/timing.py`. **Tests:** `test_timing.py`.
- `isoToMs(ts: string): number | null` (from `_iso_to_ms`)
- `sessionLogsDurationMs(files: string[]): number | null` (from `session_logs_duration_ms`) — read each file, find min/max ISO timestamps, return span in ms. Read the Python for which lines/fields it scans.
- [ ] Port `test_timing.py` cases (RED) → implement → green → typecheck.
- [ ] Commit `feat(ts): port timing to TS (phase C)`.

## Task 3: Port `obol_capture` (the obol bridge)

**Source:** `quorum/obol_capture.py`. **Tests:** `test_obol_capture.py` (312 — cover all).
- `DIALECTS` (the normalizer→obol-dialect map, 7 entries; antigravity absent by design).
- `estimateSessionLogs(backendFamily: string, sessionLogFiles: string[]): Record<string,unknown> | null` (from `estimate_session_logs`): map family→dialect; for each file `estimatePath(path, dialect)` (catch `ObolError` → return null for the whole run, matching Python); merge via the port of `_merge_estimates`; for kimi add `tool_result_total_bytes` (port `_kimi_tool_result_total_bytes`).
- `estimateUsageSidecar(path: string): Record<string,unknown> | null` (from `estimate_usage_sidecar`; dialect `"obol"`).
- private `mergeEstimates(estimates: CostEstimate[])` → the frozen dict shape (`_BUCKET_KEYS` = total_input/total_cache_create/total_cache_read/total_output + cost). **Preserve the output dict shape EXACTLY** — it freezes into run artifacts; the Python tests assert on it.
- Best-effort contract: only `ObolError` is caught (→ null); other errors propagate. No silent $0.
- [ ] Port `test_obol_capture.py` (RED) → implement → green → typecheck. If a real obol fixture is needed, reuse the Python test fixtures.
- [ ] Commit `feat(ts): port obol_capture to TS (phase C)`.

## Task 4: Port `economics`

**Source:** `quorum/economics.py`. **Tests:** `test_economics.py` (258).
- `buildRunEconomics(runDir: string): Record<string,unknown> | null` (from `build_run_economics`) + the private helpers (`_gauntlet_results_dir`, `_read_json`, `_obol_provenance`, `_tokens_shell`, `_gauntlet_block`, `_coding_block`). Reads run artifacts (result.json, usage sidecars, the obol-capture output) and assembles the economics dict the verdict carries. Depends on the `obol-capture` + `timing` ports.
- **Preserve the economics dict shape EXACTLY** (it's in `verdict.json`; `show`'s economics pane + tests depend on it).
- [ ] Port `test_economics.py` (RED) → implement → green → typecheck.
- [ ] Commit `feat(ts): port economics to TS (phase C)`.

## Final
- [ ] `cd ts && bun test` + `bun run typecheck` green.
- [ ] `uv run pytest tests/ -q` + `uv run ruff check` — Python untouched, unchanged.
- [ ] Note phase complete in the status doc (build-ahead; Python retained).

## Self-Review
Spec coverage: timing/obol_capture/economics each have a port+tests task; obol dep is gated first. ✓ No placeholders: each task cites the source module + test file + the API. ✓ Shared shapes (the obol merge dict, the economics dict) flagged as must-match-exactly (run-artifact contracts). ✓ The obol-bun parity risk is gated up front with a STOP. ✓

## Execution Handoff
Saved to `docs/superpowers/plans/2026-06-14-phase-c-cost-timing-ts-port.md`. Execute with superpowers:subagent-driven-development. Task 1 (obol smoke) gates the phase; Tasks 2–4 then proceed (4 depends on 2+3's modules).
