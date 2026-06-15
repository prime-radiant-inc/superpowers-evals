# ATIF graft + TS↔Python parity — status & remaining plan (RESUME DOC)

> Written 2026-06-14 to survive a context compaction. If you're resuming cold, read this top-to-bottom first. It captures branch state, what's merged, the in-flight Wave 2b, the remaining Wave 3, the review/finish steps, and the conventions every wave follows.

## TL;DR
Two stacked branches off `origin/main` (Matt's TS rewrite of the `quorum` eval harness, which still carries the Python original):
- **`atif-graft`** — the ATIF graft: purge Python, make ATIF v1.7 the canonical transcript (`trajectory.json`), replace the 13 `bin/` trace tools with one `check-transcript` CLI, + cleanup. Converged & green, its own PR. ~27 commits over main.
- **`ts-python-parity`** (branched off `atif-graft`) — closes the TS-vs-Python parity gaps from `~/2026-06-14-ts-python-parity-punchlist.md` (147 findings). **75 fixes merged so far** (Wave 1 + Wave 2a), gate green. **Wave 2b (the runner) is IN FLIGHT.**

Ground truth for "is X a real parity gap" = the **flat-JSONL Python frozen on `origin/main`** (`git show origin/main:quorum/<f>.py`), NOT the ATIF Python on other branches.

## Branches & worktrees
- `origin/main` — Matt's TS rewrite (`src/`) + the frozen Python (`quorum/`, `setup_helpers/`). The parity target.
- `atif-graft` @ `21f1a8a` — checked out at the MAIN session worktree `…/evals/.claude/worktrees/atif-graft`. Pushed. Its own PR (ATIF graft + purge + cleanup).
- `ts-python-parity` @ `c06a51d` (at write time) — checked out at the nested worktree `…/evals/.claude/worktrees/atif-graft/.claude/worktrees/parity`. Pushed. Do parity merges/commits HERE.
- `feat/atif-port` — the original ATIF port (under `ts/`); REFERENCE ONLY for heavy module ports (`git show feat/atif-port:ts/src/quorum/<x>.ts`). Untouched.
- Gates (run in the parity worktree): `bun run check` (biome+tsc+test) and `bun run quorum check`. Baseline at write time: **795 pass / 0 fail, 55 scenarios ok.**

## DONE
- **ATIF graft** (`atif-graft`): purge Python, ATIF capture (`trajectory.json` + multi-log carry-forward merge), `check-transcript <verb>` CLI (13 verbs), composer guard, converged via 2 review rounds (629 pass).
- **Wave 1** (28 fixes): leaf subsystems — normalizers, checks, cli, run-all, scaffold, setup-helpers.
- **Wave 2a** (47 fixes): all 8 agent provisioning modules (codex/gemini/copilot/claude/kimi/opencode/antigravity/pi) + capture/obol detectors + session `duration_ms` + economics. Heavy module ports (opencode-capture, agy-creds/teardown/watch, kimi sanitization, timing) cribbed from `feat/atif-port`. Exported building blocks for the runner (e.g. `writePrivateFileNoFollow`, `scanCopilotSecretLeaks`, opencode snapshot/export, agy modules, misplaced-session detectors).
- Fix commits: `git log --oneline origin/main..origin/ts-python-parity` (messages `fix(parity): <ID> …`).

## DONE — Wave 2b (the runner) + its review fixes
- **MERGED** `p2b-runner` → `ts-python-parity` at **`85be220`** (`--no-ff`), gate green (836 pass, 55 scenarios). It wired every Wave-2a building block + the A-core findings: REGION 1 early guards, REGION 2 gauntlet result tolerance, REGION 3 per-agent wiring (copilot env-allowlist/secret-scan/session-id; opencode snapshot/export; antigravity watcher/creds/launch-cwd/settings), REGION 4 post-capture cascade, REGION 5 economics crash-guard. `H-kimi-batch-preflight` intentionally NOT ported (parent-side batch preflight; out of scope, confirmed clean). `p2b-runner` remote branch deleted; stale local `p2-*` branches pruned.
- **Pre-merge adversarial review found 2 real gaps, both now fixed (TDD):**
  - **F1 (HIGH)** `24a8bb4` — copilot was missing from `STRICT_CAPTURE_NAMES`; an empty/zero-row copilot run was scored pass/fail instead of indeterminate. Added `copilot` to the strict floor (copilotCascadeVerdict still runs first, matching Python order). `test/runner-cascade.test.ts`.
  - **F2 / RX-6 (MEDIUM, secret leak)** `de0ad57` — kimi runtime-env mode-0600 secret temp dir was never reaped. Added `runtimeCleanupDirs` + `cleanupAgentRuntime` + a `runInner` try/finally (parity with Python `_cleanup_agent_runtime`; cleanup-failure → setup indeterminate). `test/runner-cleanup.test.ts`. **This closes RX-6.**
  - Known narrow residual (flagged, not fixed): a kimi provision that THROWS between writing the secret file and returning isn't covered by the runner finally (Python guards it with an internal try/except in `_seed_kimi_config`). Rare; untestable without heavy provision mocking. Optional follow-up.
- Gate after both fixes: **844 pass, 55 scenarios ok**, pushed `de0ad57`.

> NOTE on a hazard that was found & fixed: the Wave 2b worktree agent's `git reset --hard` had moved the **local** `atif-graft` branch forward to the parity commits (origin/atif-graft was untouched at `21f1a8a`). Left alone, a stray `git push` from the atif-graft worktree would have fast-forwarded the PR branch with parity commits. Local `atif-graft` was reset back to `origin/atif-graft`.

## WAVE 3 — the net-new LOW findings (from the colleague reconciliation, `~/2026-06-14-reconciled-missing-findings.md`)
**WAVE 3 DONE** — RX-1..6 all landed (`e323677` for RX-1..5 in `src/contracts/agent-config.ts`; RX-6 in the Wave 2b fixes). All are CodingAgentConfigError → setup indeterminate; `loadAgentConfig` is called only from the runner so `quorum check` is unaffected.
- **RX-1** ✅ `runtime_family` defaults to name, must be a known family (validate-only; returned shape unchanged since readers already default via `?? name`).
- **RX-2** ✅ claude family requires a model; any declared model must be non-blank.
- **RX-3** ✅ `name == file-stem`.
- **RX-4** ✅ `required_env` set at load time (present-but-empty counts as missing).
- **RX-5** ✅ `substituteEnv` now also does bare `$VAR` + `$$`→`$`; new `resolveSessionLogDir` substitutes then expands leading `~`; runner uses it.
- **RX-6** ✅ closed by F2 (`de0ad57`).
- Intentionally SKIPPED (sanctioned divergence): Python's "non-Claude variants not supported in v1" check — TS is multi-agent and the rule is redundant for every real config (runtime_family == name).
- Borderline (NOT done, skip unless asked): `run-dir-collision-tolerance` (`mkdir exist_ok=False` vs `recursive:true`) — real but no realistic exposure.

## LATER — review & finish
1. **Consolidated adversarial review** of the whole parity branch once Wave 2b + Wave 3 are in: `/par` (2 competing adversarial reviewers, disqualified for inflated findings) **and** `roborev review --branch --wait --base atif-graft` (diff vs `atif-graft` to isolate the parity delta; use `--base origin/main` for the full stack). Triage real findings, fix (TDD), re-verify. Converge (≤1 clean round).
2. **Finish / PRs** (confirm strategy with Jesse): `atif-graft` → `main` is its own PR (ATIF graft + purge + cleanup). `ts-python-parity` → either `main` or stacked on the `atif-graft` PR. Both target the right base; show Jesse the diffs before opening. Per repo `CLAUDE.md`: one problem per PR; disclose agent authorship.
3. **Parent submodule bump**: after a merge to `main` here, open the follow-up PR in the parent `superpowers` repo (target `dev`) bumping the `evals` submodule pointer.

## CONVENTIONS every wave follows
- **Cosmetic-skip policy** (do NOT fix): numeric rounding mode (banker's vs half-up), error-message wording, exit-code NUMBER (1 vs 2), key ordering, whitespace/padding/wrapping/truncation, non-ASCII escaping. Fix everything with behavioral/correctness/security/crash impact.
- **Sanctioned divergences** (intentional, NOT gaps — see punch list lines 30-37): the scheduler (`--jobs` default 1→8, `launch_spacing_seconds`), `bin/` check tools staying bash, JSON-formatting-only diffs, no `src/agents/claude.ts` (claude is the YAML default), the new `src/dashboard/` + `src/scheduler/`.
- **Parallel-fan-out pattern** (Wave 1/2a were `Workflow` runs; honor Jesse's "use a workflow, max parallelism, strict TDD"): one isolated-worktree agent per DISJOINT-file group; each `git fetch origin && git reset --hard origin/ts-python-parity && bun install`, TDD each finding (failing test first), `bun run check` + `bun run quorum check` green, `git push origin HEAD:p<wave>-<group> --force-with-lease`, return structured {branch,status,fixed,skipped,gate}. Then the controller merges the branches into `ts-python-parity` (disjoint files → clean), re-gates, pushes, deletes the merged `p*` branches, prunes the leftover `wf_*` worktrees.
- **The runner (`src/runner/index.ts`) is the serialization point** — never fan out parallel agents against it; do runner work in ONE agent (or sequentially). That's why Wave 2b is a single agent.
- **Re-derive normalizer (D-*) findings** against `src/normalize/*.ts` (our ATIF normalizers ≠ Matt's deleted flat `src/normalizers/`); several D-* are not-applicable or TS-is-safer — don't "fix" TS into matching a Python crash.
- After each wave: clean up `p*` branches (`git push origin --delete …`) and leftover workflow worktrees (`git worktree remove --force …/wf_*`; `git worktree prune`).

## KEY ARTIFACT LOCATIONS
- Our audit: `/Users/jesse/2026-06-14-ts-python-parity-punchlist.md` (147 findings; sections by subsystem with Python+TS refs + line ranges).
- Reconciled net-new: `/Users/jesse/2026-06-14-reconciled-missing-findings.md` (the 6 RX lows).
- Colleague audits (already reconciled — mostly dup/out-of-scope): `/Users/jesse/yesterday-session-findings.md`, `/Users/jesse/2026-06-14-ts-python-parity-punchlist (1).md`.
- ATIF graft spec/plan (on `atif-graft`/`ts-python-parity`): `docs/superpowers/specs/2026-06-14-atif-graft-onto-quorum-ts.md`, `docs/superpowers/plans/2026-06-14-atif-graft-and-cleanup.md`.
- Workflow scripts persisted under `…/workflows/scripts/ts-python-parity-wave1-*.js` and `…-wave2a-*.js` (editable + re-runnable via `Workflow({scriptPath})`).
- Standing constraints: don't push to `main`; pushes to our feature branches are authorized ("push whenever you commit"); live `quorum run` evals are trusted-maintainer only (never in public CI); `.env` for keys lives at `/Users/jesse/git/prime-radiant-inc/serf` (source inline, never echo into transcript).
