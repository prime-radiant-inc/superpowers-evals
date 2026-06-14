# Phase F — port the per-agent helpers to TS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Port the per-agent helper modules — `kimi`, `opencode_capture`, `agy_creds`, `agy_teardown`, `agy_watch` — from Python to TS/bun, parity-locked by their pytest cases.

**Architecture:** Strangler-fig, build-ahead under `ts/src/quorum/` — NOT wired into the live runner or deleted yet. These are mostly independent leaves (parallelizable), each invoked by the runner for a specific agent. **The gnarly one is `agy_watch`** (a `threading.Thread` daemon → a bun async watcher).

**Tech stack:** TS, bun. No new deps (subprocess via `Bun.spawn`; fs/path stdlib).

---

## Scope & model
Port → `ts/src/quorum/`, build-ahead, tests ported from `test_kimi.py` (554), `test_opencode_capture.py` (419), `test_agy_creds.py` (74), `test_agy_teardown.py` (101), `test_agy_watch.py` (57), `test_agy_rate_limit_matcher.py` (39). Do not modify/delete Python. Each module is an independent task (can run as parallel worktree implementers).

## Task 1: `agy_creds` (small)
`quorum/agy_creds.py` (61). API: `interface CredBackup`, `backupCredential(): CredBackup | null` (backs up `~/.gemini/oauth_creds.json` around mid-run kills; restore logic). Port `test_agy_creds.py`. `node:fs`. Commit.

## Task 2: `agy_teardown` (small)
`quorum/agy_teardown.py` (58). API: `killRunTmuxServer(scratchDir, opts?): boolean` + the socket/pane helpers (`_socket_dir`, `_list_gauntlet_sockets`, `_pane_path`). Shells to `tmux` via `Bun.spawn` (the Python takes an injectable `runner=subprocess.run`; in TS take an injectable spawn fn for testability, matching how `test_agy_teardown.py` injects). Port the tests. Commit.

## Task 3: `agy_watch` (THE gnarly one)
`quorum/agy_watch.py` (78) + the rate-limit matcher. API: `AgyRateLimitWatcher` — Python is a `threading.Thread` that tails `agy.log` and fires a teardown callback on a rate-limit signal. In TS, implement as a class with `start()`/`stop()` backed by a bun async loop (poll/`fs.watch` the log) — NOT a busy thread. The **rate-limit matcher** (the regex/predicate that decides "this log line = rate limited"; see `test_agy_rate_limit_matcher.py`) is a pure function — port it first and test it standalone (easy, deterministic). Then the watcher lifecycle (start → detect → fire teardown once → stop), ported from `test_agy_watch.py` (use injectable clock/teardown like the Python test). Be careful: fire-once semantics, clean stop, no leaked timer. Commit.

## Task 4: `opencode_capture`
`quorum/opencode_capture.py` (287). API: `OpenCodeCaptureError`, `opencodeEnv(home)`, `opencodeRunEnv(home)`, `runOpencodeCommand(...)` (shells to the `opencode` CLI via `Bun.spawn`, allowlisted env, 30s timeout), `snapshotOpencodeSessions({home, launchCwd})`, `exportOpencodeSessions(...)` + the session decision/list/export helpers. Port `test_opencode_capture.py` (mock/inject the opencode subprocess as the Python tests do). Commit.

## Task 5: `kimi` (largest)
`quorum/kimi.py` (440). API (mirror exactly): `KimiConfigError`, `resolveKimiBinary`, `kimiPreflightSentinelPayload`, `validateKimiPreflightSentinel`, `sanitizeKimiDiagnostic`, `effectiveKimiModelEnv`, `buildKimiSubprocessEnv`, `kimiStreamJsonReplyOk`, `kimiLogsHaveSuperpowersSessionStart`, `runKimiAuthPreflight` (shells to the kimi binary), the env constants (`ALLOWED_HOST_KIMI_MODEL_ENV`, `DEFAULT_KIMI_MODEL_ENV`, `KIMI_RUNTIME_FLAGS`, `_SENSITIVE_ENV_NAME_PARTS`), `_shell_assignment`. Lots of env/sentinel/diagnostic-sanitization logic + a subprocess auth preflight. **Note the secret-sanitization** (`sanitize_kimi_diagnostic` redacts KEY/TOKEN/SECRET/PASSWORD values ≥6 chars) — port the redaction faithfully (security-relevant). Port `test_kimi.py` (554 — cover all, incl. the sanitization + sentinel-validation cases). Commit.

## Final
- [ ] `cd ts && bun test` + `bun run typecheck` green; `uv run pytest tests/ -q` + `uv run ruff check` confirm Python untouched. Note phase complete (build-ahead).

## Self-Review
Each module a task; the threading→async port (`agy_watch`) flagged as the gnarly one with fire-once/clean-stop caveats; the kimi secret-sanitization flagged as security-relevant must-match. Subprocess-spawning modules (teardown/opencode/kimi) take injectable spawn fns for testability, matching the Python tests' injection. No placeholders — source + tests are the spec. ✓

## Execution Handoff
Saved here. Execute with superpowers:subagent-driven-development. Tasks 1–5 are independent (parallel worktrees OK); start the rate-limit matcher inside Task 3 first (pure, easy) before the watcher lifecycle.
