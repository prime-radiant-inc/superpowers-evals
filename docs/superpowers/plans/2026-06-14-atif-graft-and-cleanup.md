# ATIF graft + cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make ATIF v1.7 the canonical on-disk transcript on the `atif-graft` branch and replace the 13 transcript-reading `bin/` shell tools with the single TS `check-transcript <verb>` CLI — then apply the audit's small cleanup trim.

**Architecture:** Strangler-fig graft. The ATIF analysis layer already exists, fully tested, on branch `feat/atif-port` under `ts/src/{atif,normalize,detect,check,cli/check-transcript.ts}`. We copy it into this branch's `src/` (names don't clash: ours are `normalize/`/`check/` singular vs Matt's `normalizers/`/`checks/` plural), prove equivalence with a transitional differential test, then flip capture + scenarios over and delete the old flat pipeline.

**Tech Stack:** TypeScript, Bun, biome, zod (existing), `@primeradianthq/obol` (existing). No new deps.

**Design doc:** `docs/superpowers/specs/2026-06-14-atif-graft-onto-quorum-ts.md`. Read it for the seam analysis and the "lucky compatibilities" (identical `{check,args,negated,passed,detail}` record shape; same flat `{tool,args}` projection; composer's `TRACE_PRIMITIVES` guard already keyed on verb names).

---

## Source of truth for copied code

The ATIF layer is already written and parity-locked on `feat/atif-port`. **Do not rewrite it** — copy each file verbatim, then reconcile to biome style (`bun run lint:fix`) and `tsc`. Read each source file with `git show feat/atif-port:<path>`.

| Source (`feat/atif-port`) | Destination (`atif-graft`) |
|---|---|
| `ts/src/atif/{types,project,validate}.ts` | `src/atif/` |
| `ts/src/normalize/{claude,codex,gemini,copilot,opencode,pi,kimi,antigravity}.ts` | `src/normalize/` |
| `ts/src/detect/{skill,implementation}.ts` | `src/detect/` |
| `ts/src/check/{record,transcript,verbs,regex}.ts` | `src/check/` |
| `ts/src/cli/check-transcript.ts` | `src/cli/check-transcript.ts` |
| `ts/src/quorum/capture.ts` (the ATIF merge: `_merge_trajectories`, step-id renumber) | port into `src/capture/index.ts` |
| `ts/test/atif/*`, `ts/test/normalize.*`, `ts/test/check*`, `ts/test/detect*` | `test/` |

Names are clash-free: ours `src/normalize/` (singular) + `src/check/` (singular) + `src/atif/` + `src/detect/` coexist with Matt's `src/normalizers/` (plural) + `src/checks/` (the bash bridge — KEPT). Cross-imports inside the copied files (`check/transcript.ts` → `../atif/project.ts`, etc.) are preserved because the sibling layout under `src/` matches `feat/atif-port`'s `ts/src/`.

## File structure (net effect after the graft)

- **Add:** `src/atif/`, `src/normalize/`, `src/detect/`, `src/check/`, `src/cli/check-transcript.ts`, `bin/check-transcript` (bun shim).
- **Rewire:** `src/capture/index.ts` (emit `trajectory.json` ATIF, not flat JSONL); `src/checks/index.ts` + `src/runner/index.ts` (set `QUORUM_TRANSCRIPT_PATH`, drop `QUORUM_TOOL_CALLS_PATH`).
- **Delete (rollout):** `src/normalizers/` (plural, flat `ToolCall[]`); the 13 transcript `bin/` tools (`tool-called`, `tool-not-called`, `tool-count`, `tool-before`, `skill-called`, `skill-not-called`, `skill-before-tool`, `skill-before-implementation-tool`, `implementation-tool-not-called`, `investigated`, `worktree-created`, `tool-match-before-tool-match`, `tool-arg-match`). **Keep** the ~18 non-transcript `bin/` tools (`git-repo`, `file-exists`, `not`, `_record`, the `*-plugin-installed`, `requires-tool`, …) and `src/checks/` (the bash bridge — unchanged).
- **Flip:** every `scenarios/*/checks.sh` transcript check → `check-transcript <verb>` (reuse `feat/atif-port`'s already-flipped files).

---

## Phase 1 — MVP: claude slice + transitional parity fence

Proves the whole contract (capture format → env → CLI → record shape → composer) on one agent before the repetitive rollout. NO live agent; uses a frozen replay fixture.

### Task 1: copy the ATIF core + claude normalizer + check layer (no wiring)

**Files:** create `src/atif/{types,project,validate}.ts`, `src/normalize/claude.ts`, `src/detect/{skill,implementation}.ts`, `src/check/{record,transcript,verbs,regex}.ts`, `src/cli/check-transcript.ts` (copied from the `feat/atif-port` paths in the table above).

- [ ] **Step 1:** for each destination file, `git show feat/atif-port:<source>` and write it verbatim to the destination. `src/normalize/claude.ts` only needs `src/atif/*`; `src/check/*` imports `src/atif/project.ts` + `src/detect/*`. (codex/gemini/etc. normalizers come in Phase 2 — claude alone for the MVP.)
- [ ] **Step 2:** `bun run lint:fix` then `bun run typecheck`. Expected: biome clean, tsc clean. Fix any single/double-quote or import-extension diffs biome flags.
- [ ] **Step 3:** `bun test` — full suite still green (449), the new files have no tests yet (added in Task 3).
- [ ] **Step 4:** commit `feat(atif): add ATIF core + claude normalizer + check-transcript (no wiring)`.

### Task 2: the `bin/check-transcript` shim

**Files:** create `bin/check-transcript`.

- [ ] **Step 1:** write the shim (mirrors `bin-ts/setup-helpers`):
```bash
#!/usr/bin/env bash
# Resolve check-transcript to the TS CLI. Repo root is one dir up from bin/.
here="$(cd "$(dirname "$0")/.." && pwd)"
exec bun run "$here/src/cli/check-transcript.ts" "$@"
```
- [ ] **Step 2:** `chmod +x bin/check-transcript`.
- [ ] **Step 3:** smoke it: `QUORUM_TRANSCRIPT_PATH=/nonexistent QUORUM_RECORD_SINK=/tmp/s bin/check-transcript tool-not-called Foo; cat /tmp/s` — expect a record with `passed:false` (empty-transcript guard fails negative assertions). Confirm the record JSON shape is `{check,args,negated,passed,detail}`.
- [ ] **Step 4:** commit `feat(atif): bin/check-transcript shim`.

### Task 3: transitional differential check-record test (claude) — THE parity fence

**Files:** create `test/atif-graft-differential.test.ts` (throwaway: deleted after rollout once `src/normalizers/` is gone).

- [ ] **Step 1: write the failing test.** Use a frozen claude session-log replay input (from `test/fixtures/claude/`). For each verb in `['tool-called','tool-not-called','tool-count','tool-before','skill-called','skill-not-called','tool-arg-match']` with representative args drawn from the fixture's actual tools:
  - **OLD path:** `normalizeClaudeLogs` (from `src/normalizers/claude.ts`) → write the flat `coding-agent-tool-calls.jsonl`; run the corresponding `bin/<verb>` with `QUORUM_TOOL_CALLS_PATH` + `QUORUM_RECORD_SINK` (via `spawnSync('bash', ['-c', ...])`); read the sink record.
  - **NEW path:** ATIF claude normalize (from `src/normalize/claude.ts`) → write `trajectory.json`; run `bin/check-transcript <verb>` with `QUORUM_TRANSCRIPT_PATH` + `QUORUM_RECORD_SINK`; read the sink record.
  - assert `old.passed === new.passed` for each verb.
- [ ] **Step 2:** run it — expect RED first if a verb diverges (investigate), else GREEN.
- [ ] **Step 3:** make it green (the layers are already parity-locked; divergence here means a wiring bug — fix the wiring, not the assertion).
- [ ] **Step 4:** commit `test(atif): transitional claude differential parity fence`.

**Exit criteria for Phase 1:** identical `passed` across both paths for the claude fixture on all listed verbs. That validates the seam end-to-end.

---

## Phase 2 — rollout (repeat the proven pattern)

### Task 4: copy the remaining 7 ATIF normalizers
- [ ] Copy `src/normalize/{codex,gemini,copilot,opencode,pi,kimi,antigravity}.ts` from `feat/atif-port` (table above). `bun run lint:fix` + `bun run typecheck` + `bun test` green. Commit `feat(atif): remaining 7 ATIF normalizers`.

### Task 5: extend the differential fence to all 8 agents
- [ ] Parameterize `test/atif-graft-differential.test.ts` over every agent that has a frozen fixture (`test/fixtures/<agent>/`), old-normalizer vs ATIF-normalizer, same verb set. All green. Commit `test(atif): differential fence over all dialects`.

### Task 6: rewire capture to emit ATIF `trajectory.json`
**Files:** `src/capture/index.ts`.
- [ ] Replace the per-log `JSON.stringify(rec)` flat-line serialization with: normalize each new log to an ATIF `Trajectory`, **merge** all logs into one (port `_merge_trajectories` from `feat/atif-port:ts/src/quorum/capture.ts` — timestamp-ordered, stable fallback `(untimestamped, ts, fileIndex, inFileIndex)`, `step_id` renumbered from 1), and write `run_dir/trajectory.json`. `rowCount` = `flattenToolCalls(traj).length` (preserves the PRI-2081 empty-capture retry). The gemini timestamp-ordering special-case is subsumed by the ATIF merge.
- [ ] Update `CaptureResult.path` to the `trajectory.json` path. Update `captureToolCalls`/`captureToolCallsWithRetry` tests (`test/...capture...`) to the ATIF artifact. `bun test` green. Commit `feat(atif): capture emits ATIF trajectory.json`.

### Task 7: runner/checks env → `QUORUM_TRANSCRIPT_PATH`
**Files:** `src/checks/index.ts` (lines ~24, 57-58), `src/runner/index.ts:538`.
- [ ] In `RunPhaseArgs` rename `toolCallsPath` → `transcriptPath`; set `QUORUM_TRANSCRIPT_PATH` (not `QUORUM_TOOL_CALLS_PATH`) in the child env. In the runner, pass `transcriptPath: capture.path` (now `trajectory.json`). Update `test/runner-*`/`checks` tests. `bun test` green. Commit `feat(atif): checks read QUORUM_TRANSCRIPT_PATH`.

### Task 8: flip scenario `checks.sh` transcript checks
- [ ] For each `scenarios/*/checks.sh` with a transcript check, prefix it with `check-transcript ` (e.g. `tool-called Agent` → `check-transcript tool-called Agent`). Reuse `feat/atif-port`'s already-flipped files: `git show feat/atif-port:scenarios/<name>/checks.sh`. Leave non-transcript lines (`git-repo`, `file-exists`, `not …`) unchanged. `bun run quorum check` → 55 ok (the `setup-helpers run`/parser is unaffected). Commit `feat(atif): scenarios use check-transcript`.

### Task 9: delete the old flat pipeline
- [ ] `git rm -r src/normalizers` and `git rm bin/{tool-called,tool-not-called,tool-count,tool-before,skill-called,skill-not-called,skill-before-tool,skill-before-implementation-tool,implementation-tool-not-called,investigated,worktree-created,tool-match-before-tool-match,tool-arg-match}`. Delete `test/atif-graft-differential.test.ts` (its job is done — `src/normalizers/` is gone) and any `test/replay-*` that imported the old normalizers (the ATIF normalizers have their own tests from Task 12). Grep for dangling imports of `normalizers/`. `bun run check` + `bun run quorum check` green. Commit `chore(atif): remove flat ToolCall pipeline + 13 bin trace tools`.

### Task 10: composer guard
**Files:** `src/composer.ts`.
- [ ] Confirm `TRACE_PRIMITIVES` lists every `check-transcript` verb name (the record's `check` field is the verb). Add any missing. Optional hardening: make `bin/not` record the inner verb so a `not check-transcript <verb>` can't dodge the guard (today every transcript negative uses a dedicated verb, so not currently reachable — document if not fixed). `bun test` green. Commit `fix(atif): composer trace-guard covers all verbs`.

---

## Phase 3 — port the ATIF unit tests

### Task 11: bring the analysis-layer tests
- [ ] Copy the atif/check/normalize/detect tests from `feat/atif-port:ts/test/` into `test/`, adjust import paths to `src/`. These are the real parity locks for the copied code. `bun test` green (count rises well above 449). Commit `test(atif): port analysis-layer unit tests`.

---

## Phase 4 — cleanup (the audit's trim; independent of the graft)

Each is a small, isolated deletion verified by `bun run check`.

### Task 12: `env.ts` no-op zod schema
- [ ] `src/env.ts` `EnvSchema` is all `z.string().optional()` (can never fail). Replace with a plain typed object read; drop the zod import if now unused. Commit `refactor: drop no-op env zod schema`.

### Task 13: dead exports / unreferenced symbols
- [ ] Run `bunx knip` (or grep). Remove: `src/setup-helpers/worktree.ts` `addWorktree`/`detachHead` if truly never dispatched (confirm they're not in `KNOWN_HELPER_NAMES` validation paths first), `src/env.ts` `superpowersRoot` if no caller, `agyLogShowsRateLimit` (unused export + its lone test). Drop stray `export` keywords on in-file-only symbols flagged by knip. `bun run check` green. Commit `chore: remove dead exports (knip)`.

### Task 14: single-consumer contracts (optional, low priority)
- [ ] If `src/contracts/gauntlet.ts` and the `economics` contract each have exactly one consumer, inline them into that consumer. Skip if it hurts wire-shape locality. Commit `refactor: inline single-consumer contracts`.

---

## Final
- [ ] `bun run check` (biome + tsc + bun test) green; `bun run quorum check` → 55 ok.
- [ ] Dispatch a final code reviewer over the whole branch.
- [ ] Use superpowers:finishing-a-development-branch.

## Self-Review

**Spec coverage:** transcript→ATIF (Tasks 1,4,6), bin/→check-transcript (Tasks 1,2,8,9), runner env (Task 7), composer guard (Task 10), tests (3,5,11), cleanup (12-14). All spec §3 items mapped. ✓
**Placeholder scan:** copied code is referenced by exact `git show feat/atif-port:<path>` (concrete, not vague — the code exists and is named); no "TBD"/"handle edge cases". ✓
**Type consistency:** `transcriptPath`/`QUORUM_TRANSCRIPT_PATH` used consistently (Task 7); record shape `{check,args,negated,passed,detail}` matches Matt's `SinkRecordSchema` (spec §1.3). ✓
**Naming clash check:** `normalize/`+`check/`+`atif/`+`detect/` (ours) vs `normalizers/`+`checks/` (Matt's) — distinct; verified against the real `src/` tree. ✓

## Execution Handoff
Saved to `docs/superpowers/plans/2026-06-14-atif-graft-and-cleanup.md`. Execute with superpowers:subagent-driven-development. Phase 1 (claude MVP + parity fence) gates the rollout; Phases 2-3 repeat the proven pattern; Phase 4 is independent cleanup.
