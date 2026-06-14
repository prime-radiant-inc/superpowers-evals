# Phase D — port verdict composition + check execution to TS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Port `checks` (sources `checks.sh`, runs `pre()`/`post()`, collects records) and `composer` (composes the final verdict) from Python to TS/bun, parity-locked by their pytest cases.

**Architecture:** Strangler-fig, build-ahead under `ts/src/quorum/` — NOT wired into the live runner or deleted yet (the Python runner still uses them until the spine flips, Phase G). `checks.sh`/scenario files stay shell; the port spawns bash to run them.

**Tech stack:** TypeScript, bun. No new deps (bash via `Bun.spawn`; JSON parsing).

---

## Scope & model

Port `quorum/checks.py` (149) and `quorum/composer.py` (175) → `ts/src/quorum/`, build-ahead, tests ported from `tests/quorum/test_checks.py` (302) and `test_composer.py` (152). Do not modify/delete Python.

**Shared type:** `CheckRecord` is defined in `checks.py` and consumed by `composer.py`. In TS, define `CheckRecord` once (export from `checks.ts`) and import it into `composer.ts` — single source of truth.

**Note:** some `test_checks.py` tests shell out to `bin/check-transcript` (→ bun) and are guarded with `requires_bun` on the Python side; the TS port runs under `bun test` so bun is always present. The `bin/` check tools + `check-transcript` shim already exist on this branch.

## File structure
- Create: `ts/src/quorum/checks.ts`, `ts/src/quorum/composer.ts`
- Create: `ts/test/quorum/checks.test.ts`, `ts/test/quorum/composer.test.ts`

---

## Task 1: Port `checks`

**Source:** `quorum/checks.py`. **Tests:** `tests/quorum/test_checks.py` (302 — cover all).

Public API:
- `interface CheckRecord { check: string; args: unknown[]; negated: boolean; passed: boolean; detail?: string | null; phase: Phase }` — mirror the Python `CheckRecord` dataclass fields exactly. `type Phase = "pre" | "post"` (match the Python `Phase`).
- `parseCodingAgentsDirective(checksSh: string): string[] | null` (from `parse_coding_agents_directive`) — regex `^\s*#\s*coding-agents:\s*(.+?)\s*$`, split CSV. Port verbatim.
- `runPhase(opts: { checksSh: string; phase: Phase; workdir: string; quorumBin: string; transcriptPath?: string; runDir?: string }): { records: CheckRecord[]; exitCode: number }` (from `run_phase`).

`runPhase` faithful port (the gnarly bit):
1. Make a temp sink file (`QUORUM_RECORD_SINK`).
2. Build env: inherit `process.env`; `PATH = ${quorumBin}:${process.env.PATH}`; set `QUORUM_RECORD_SINK`; set `QUORUM_TRANSCRIPT_PATH` if given (even if the file is absent — fail-closed); set `QUORUM_RUN_DIR` if given.
3. `Bun.spawn(["bash", "-c", \`source '${checksSh}'; ${phase}\`], { cwd: workdir, env })`; capture exit code; read the sink; parse each non-blank line as JSON → `CheckRecord` (with `phase` set).
4. **Crash-code heuristic (port EXACTLY):** `0` → exitCode 0; `126|127|>=128` → crash, exitCode = returncode; `1..125` → exitCode 0 if any records emitted else returncode. (This distinguishes a tool's intentional fail-exit from a bash crash like a typo'd verb. Keep the comment explaining it.)
5. `finally` unlink the sink.

- [ ] **Step 1: Port tests (RED)** from `test_checks.py` — `parse_coding_agents_directive` cases; `run_phase` with real temp `checks.sh` fixtures (a `post()` that calls `file-exists`/`git-*`/`check-transcript`, asserting the collected records + exitCode); the crash-code cases (typo'd verb → 127 crash; intentional fail-exit with a record → exitCode 0; the `QUORUM_TRANSCRIPT_PATH`/`QUORUM_RUN_DIR` env exposure tests; the `not check-transcript <typo>` regression). Run → RED.
- [ ] **Step 2: Implement `ts/src/quorum/checks.ts`.**
- [ ] **Step 3: Green** + typecheck + full `bun test`.
- [ ] **Step 4: Commit** `feat(ts): port checks (checks.sh runner) to TS (phase D)`.

---

## Task 2: Port `composer`

**Source:** `quorum/composer.py`. **Tests:** `tests/quorum/test_composer.py` (152).

Public API:
- `TRACE_PRIMITIVES` — a `Set<string>` of the 13 transcript verbs (copy the current set exactly; keep it in sync with `check-transcript`).
- `type GauntletStatus`, `RunErrorStage`, `FinalStatus` — match the Python literal types.
- `interface GauntletLayer { status: GauntletStatus; summary?: string; reasoning?: string; runId?: string | null }`
- `interface RunError { stage: RunErrorStage; message: string }`
- `interface FinalVerdict { schema: number; final: FinalStatus; finalReason: string; gauntlet: GauntletLayer | null; checks: CheckRecord[]; error: RunError | null; economics: Record<string,unknown> | null }` + a `toDict(v): object` producing the EXACT `verdict.json` shape the Python `FinalVerdict.to_dict` emits (snake_case keys: `final_reason`, `run_id`, the checks array shape with `check/args/negated/passed/detail/phase`, `error` as `{stage,message}` or null, `economics`). **The serialized shape must match the Python byte-for-byte** — it's the `verdict.json` artifact other tools + `show` read.
- `compose(opts: { gauntlet: GauntletLayer | null; checks: CheckRecord[]; captureEmpty: boolean; error: RunError | null }): FinalVerdict` — port the decision tree EXACTLY:
  1. `error != null` → indeterminate `quorum error (<stage>): <message>`.
  2. failed `pre` checks → indeterminate `pre-check(s) failed: <names>`.
  3. `gauntlet == null` → indeterminate `no Gauntlet-Agent verdict`.
  4. gauntlet status `investigate`/`errored` → indeterminate.
  5. `captureEmpty && anyTraceCheck(checks)` → indeterminate `tool-call capture was empty; trace checks meaningless`.
  6. gauntlet `pass` && no failed `post` → pass (reason counts post-checks).
  7. else → fail (reason from gauntlet status + failed-post count).
- private `anyTraceCheck(checks)` = any check name ∈ `TRACE_PRIMITIVES`.

`compose` is a PURE function — the cleanest port; the 152-LOC test file pins every branch.

- [ ] **Step 1: Port tests (RED)** from `test_composer.py` — every branch of `compose` + `toDict` shape + `anyTraceCheck`. Import `CheckRecord` from `checks.ts`. Run → RED.
- [ ] **Step 2: Implement `ts/src/quorum/composer.ts`.**
- [ ] **Step 3: Green** + typecheck.
- [ ] **Step 4: toDict parity check:** assert `toDict(compose(...))` deep-equals the Python `to_dict` output for a representative verdict (hard-code the expected JSON from the Python, or compare against a captured real `verdict.json`).
- [ ] **Step 5: Commit** `feat(ts): port composer (verdict) to TS (phase D)`.

---

## Final
- [ ] `cd ts && bun test` + `bun run typecheck` green.
- [ ] `uv run pytest tests/ -q` + `uv run ruff check` — Python untouched.
- [ ] Note phase complete in the status doc (build-ahead; Python retained until the spine flip).

## Self-Review
Spec coverage: checks + composer each have a port+tests task. ✓ Shared `CheckRecord` is single-sourced (checks.ts). ✓ The two serialization contracts that MUST match Python byte-for-byte (the record sink format consumed by `runPhase`; `FinalVerdict.toDict` → `verdict.json`) are flagged. ✓ The bash-spawn + crash-code heuristic (the gnarly bit) is specified step-by-step. ✓ No placeholders — source modules + test files are the spec. ✓

## Execution Handoff
Saved to `docs/superpowers/plans/2026-06-14-phase-d-verdict-ts-port.md`. Execute with superpowers:subagent-driven-development. Task 1 (`checks`, defines `CheckRecord`) precedes Task 2 (`composer`, imports it).
