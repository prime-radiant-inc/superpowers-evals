# Phase G — port the runner (the spine flip) to TS Implementation Plan

> Strategy spec. The executable, function-by-function detail must be authored AFTER Phases B–F merge (the TS leaf APIs it consumes must be final). This is the **gated big-bang spine flip** — it rewrites the orchestrator in TS, flips the live `quorum` entry point, and deletes the Python runner. Do NOT auto-execute.

**Goal:** Port `quorum/runner.py` (2528 LOC) — per-run orchestration — to TS/bun, then flip the live entry point so the TS runner drives real runs, and delete the Python runner.

**Prerequisite:** Phases B–F merged (the TS runner consumes them IN-PROCESS): `coding-agent-config`, `capture` (capture+retry+merge), `checks` (runPhase/bash), `composer` (compose/toDict→verdict.json), `obol_capture`/`economics`/`timing`, and the agent helpers (`kimi`/`opencode_capture`/`agy_*`).

## What the TS runner does (port the orchestration)
1. **Setup:** allocate run dir; per-agent seed/auth/config — port the `_seed_*` ceremony (codex/gemini/copilot/kimi/antigravity/opencode): write config dirs (`CLAUDE_CONFIG_DIR`/`CODEX_HOME`/etc.), seed trust/api-key approval, install the superpowers plugin, run each agent's auth preflight (shells to the agent CLI).
2. **Launch ceremony:** generate the per-agent launcher (the `launch-agent` template substitution) incl. the **env-scrub / `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE`** (B1) handling; the `QUORUM_AGENT_CWD` bridge.
3. **Drive:** `Bun.spawn` the gauntlet CLI (the QA driver) with the bridged env; capture its result (`run.jsonl`, `result.{json,md}`).
4. **Capture:** TS `captureToolCallsWithRetry` → `trajectory.json` (in-process normalizers).
5. **Checks:** TS `runPhase` for `pre`/`post` (spawns bash for `checks.sh`); the `# coding-agents:` directive gating.
6. **Compose + economics:** TS `compose(...)` + `buildRunEconomics(...)` → `FinalVerdict.toDict()` → `verdict.json`.
7. **Diagnostics:** the strict-capture stage attribution (the `indeterminate(stage=...)` logic) + the per-backend diagnostic cascade (codex misplaced rollouts, pi sessions, kimi unmatched logs, copilot multi-log guard); the `agy` rate-limit watcher + teardown.

## The gnarly bits (where ~all the operational complexity lives)
- Per-agent auth/seed ceremony (6 agents, each bespoke — codex auth, gemini OAuth + extension link, copilot gh-auth, kimi preflight sentinel, antigravity preflight + agy creds/teardown/watch, opencode provider preflight).
- The gauntlet subprocess + env bridge + the `QUORUM_AGENT_CWD`/launch-cwd sentinel.
- Stage attribution (`RunError.stage`) + the per-backend "empty capture → which diagnostic" cascade.
- The `agy` daemon (rate-limit watcher → teardown) lifecycle.

## The flip (gated, irreversible-ish)
- Add a parity harness: run a sample of real scenarios via the TS runner AND the Python runner, diff the resulting `verdict.json` (final + reason + checks + economics). MUST be green before flipping.
- Flip: `cli.py`'s `run`/`run-all` → call the TS runner (or do it as part of Phase H's full-CLI flip). Delete `quorum/runner.py` + its Python deps once the TS runner is the live path.
- **Requires Jesse's review before flipping** (deletes the spine, flips live CLI/CI). The whole B1/capture/launch operational surface lives here — treat like the check-layer cutover: parity-gated, then big-bang, then /par + roborev.

## Note
Given the value taper (the analysis layer B–D is the high-value part; the runner is orchestration that already works as Python-calling-bun), reconfirm with Jesse that porting the spine is worth it before authoring the executable plan — the hybrid (Python spine, TS leaves) is a defensible resting state.
