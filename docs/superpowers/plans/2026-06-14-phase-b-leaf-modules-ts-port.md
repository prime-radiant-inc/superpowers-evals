# Phase B — port the pure-leaf quorum modules to TS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the five low-coupling "leaf" modules of the quorum harness from Python to TypeScript/bun, with parity-locked tests, as the next slice of the full Python→TS port.

**Architecture:** Strangler-fig, leaf-first. These modules are **built-ahead as a TS library under `ts/src/quorum/`** and are NOT wired into the live Python harness or deleted yet — the Python versions stay until their callers port (Phases C–G / the spine flip). Parity is locked by porting each module's existing pytest cases to `bun test`. The live harness behavior is unchanged by this phase.

**Tech stack:** TypeScript, bun. One new dep: **`yaml`** (for the agent-config + frontmatter parsing). Everything else stdlib/`Bun.*`. Keep deps minimal.

---

## Scope & integration model

**In scope (port to `ts/src/quorum/`, build-ahead + tests):**
`log_filters`, `story_meta`, `coding_agent_config`, `show`, `scaffold`.

**Explicitly NOT in this phase** (tracked, deferred):
- Wiring `cli.py`/`runner.py`/`capture.py` to call the TS versions, and deleting
  the Python modules. That happens when each caller ports (later phases). The TS
  modules here are consumed by Phases C–E (e.g. capture→`log_filters`) and the
  spine flip (G).
- Any change to the live CLI, CI's `quorum check`, or the runner.

**Parity rule:** for each module, port the assertions from its `tests/quorum/test_*.py`
into a `bun test` file. The Python source + its tests are the authoritative spec —
read them; do not invent behavior. Where a Python test exercises a behavior, the
TS test must exercise the same input→output.

## Dependency

Add `yaml` to `ts/package.json` (`bun add yaml`) — used by `coding_agent_config`
(agent YAML) and `scaffold` (frontmatter). `story_meta` uses regex field
extraction (matching the Python), so it does NOT need `yaml`.

## File structure

- Create: `ts/src/quorum/log-filters.ts`
- Create: `ts/src/quorum/story-meta.ts`
- Create: `ts/src/quorum/coding-agent-config.ts`
- Create: `ts/src/quorum/show.ts`
- Create: `ts/src/quorum/scaffold.ts`
- Create: `ts/test/quorum/log-filters.test.ts`, `story-meta.test.ts`,
  `coding-agent-config.test.ts`, `show.test.ts`, `scaffold.test.ts`
- Modify: `ts/package.json` (add `yaml`)

Each TS module mirrors the Python module's public API (camelCase function names;
keep the same semantics). Filesystem reads use `node:fs`; paths use `node:path`.

---

## Task 1: Add the `yaml` dep + workspace sanity

**Files:** `ts/package.json`, `ts/bun.lock`

- [ ] **Step 1: Add the dep**

Run: `cd ts && bun add yaml`
Expected: `yaml` appears in `dependencies`; `bun.lock` updated.

- [ ] **Step 2: Verify the suite still green**

Run: `cd ts && bun test && bun run typecheck`
Expected: existing 259 tests pass, typecheck clean.

- [ ] **Step 3: Commit**

```bash
git add ts/package.json ts/bun.lock
git commit -m "chore(ts): add yaml dep for quorum-core port (phase B)"
```

---

## Task 2: Port `log_filters`

**Source of truth:** `quorum/log_filters.py` (192 LOC). **Tests to port:** `tests/quorum/test_log_filters.py` (197 LOC).

**Files:**
- Create: `ts/src/quorum/log-filters.ts`
- Create: `ts/test/quorum/log-filters.test.ts`

**Public API to port (preserve semantics exactly):**
- `filterCodexLogsByCwd(paths: string[], targetCwd: string): string[]` (from `filter_codex_logs_by_cwd`)
- `findMisplacedCodexRollouts(...)` (from `find_misplaced_codex_rollouts` — match the Python signature)
- `filterPiLogsByCwd(paths: string[], targetCwd: string): string[]`
- `findMisplacedPiSessions(paths, launchCwd): string[]`
- `findUnusablePiSessions(paths): string[]`
- `filterKimiLogsByCwd(paths, targetCwd): string[]`
- private helpers `_pi_session_header_cwd`, `_kimi_home_for_log` → module-private TS functions.

These read each log file and decide inclusion by the cwd recorded inside it
(codex/pi headers, kimi home). Read `quorum/log_filters.py` for the exact
field/path logic and replicate it (paths are strings here; use `node:fs` to read
file contents).

- [ ] **Step 1: Port the tests (RED).** Translate every test case in
  `tests/quorum/test_log_filters.py` into `ts/test/quorum/log-filters.test.ts`
  (same fixtures: write temp log files with the same header/cwd content, call the
  TS function, assert the same included/excluded paths). Run
  `cd ts && bun test test/quorum/log-filters.test.ts` → FAIL (module missing).
- [ ] **Step 2: Implement `ts/src/quorum/log-filters.ts`** porting each function from the Python.
- [ ] **Step 3: Run → all green.** `cd ts && bun test test/quorum/log-filters.test.ts` + `bun run typecheck`.
- [ ] **Step 4: Commit** `feat(ts): port log_filters to TS (phase B)`.

---

## Task 3: Port `story_meta`

**Source of truth:** `quorum/story_meta.py` (88 LOC). **Tests:** `tests/quorum/test_story_meta.py` (89 LOC).

**Files:**
- Create: `ts/src/quorum/story-meta.ts`
- Create: `ts/test/quorum/story-meta.test.ts`

**Public API:**
- `class StoryMetaError extends Error` (from `StoryMetaError`)
- `readQuorumMaxTime(storyPath: string): string | undefined` (from `read_quorum_max_time`)
- `readQuorumTier(storyPath: string): string` (from `read_quorum_tier`; valid tiers `sentinel|full|adhoc`)
- `readStoryStatus(storyPath: string): string` (from `read_story_status`)
- private `frontmatterField(text, key)` regex helper; reuse the Python regexes
  verbatim: frontmatter `^---\n(.*?)\n---\n` (DOTALL → JS `[\s\S]` + the `s` flag),
  duration `^\d+(ms|s|m|h)?$`. NO `yaml` dep — regex field extraction, matching Python.

- [ ] **Step 1: Port tests (RED)** from `tests/quorum/test_story_meta.py` (valid/invalid duration, tier defaulting + validation, status, malformed frontmatter raising `StoryMetaError`). Run → FAIL.
- [ ] **Step 2: Implement `ts/src/quorum/story-meta.ts`.** Mind regex translation: Python `re.DOTALL` → JS `s` flag; anchors `^`/`$` behavior.
- [ ] **Step 3: Green** (`bun test test/quorum/story-meta.test.ts` + typecheck).
- [ ] **Step 4: Commit** `feat(ts): port story_meta to TS (phase B)`.

---

## Task 4: Port `coding_agent_config`

**Source of truth:** `quorum/coding_agent_config.py` (156 LOC). **Tests:** `tests/quorum/test_coding_agent_config.py` (502 LOC — the biggest test set; cover all of it).

**Files:**
- Create: `ts/src/quorum/coding-agent-config.ts`
- Create: `ts/test/quorum/coding-agent-config.test.ts`

**Public API:**
- `interface CodingAgentConfig { ... }` — mirror the Python `CodingAgentConfig`
  dataclass fields exactly (name, runtime_family, binary, agent_config_env,
  session_log_dir, session_log_glob, normalizer, required_env, max_time,
  project_prompt, model, etc. — read the dataclass for the full field list + types).
- `class CodingAgentConfigError extends Error`
- `KNOWN_RUNTIME_FAMILIES` (frozenset → a `Set<string>`)
- `defaultSuperpowersRoot(evalRepoRoot: string): string | null`
- `ensureSuperpowersRootDefault(evalRepoRoot?: string): void`
- `loadCodingAgentConfig(path: string): CodingAgentConfig` — parse the YAML (use
  `yaml`), validate. **IMPORTANT:** the normalizer-validation was changed during
  the cutover to validate against `ATIF_SUPPORTED_NORMALIZERS` (now all 8 agents)
  — replicate the CURRENT Python behavior (read the current
  `coding_agent_config.py`, which imports the supported set from `quorum/atif.py`).
  In TS, validate against the same canonical set (define/import the 8 supported
  normalizer names; keep it the single source of truth — e.g. a shared constant in
  `ts/src/`). Unknown normalizer / runtime_family → throw `CodingAgentConfigError`
  with the same helpful message shape.

- [ ] **Step 1: Port tests (RED)** — translate the full `test_coding_agent_config.py`
  (valid loads for real agents, every validation error path, the
  superpowers-root defaulting). Use `yaml`-stringified fixtures or temp YAML
  files. Run → FAIL.
- [ ] **Step 2: Implement `ts/src/quorum/coding-agent-config.ts`.**
- [ ] **Step 3: Green** + typecheck.
- [ ] **Step 4: Cross-check parity (extra rigor for the validator):** for the 8
  real `coding-agents/*.yaml`, assert `loadCodingAgentConfig` succeeds and the
  parsed fields match what the Python loader produces (you can hard-code the
  expected parsed values from running the Python loader once, or just assert the
  key fields). Add this as a test over the real configs.
- [ ] **Step 5: Commit** `feat(ts): port coding_agent_config to TS (phase B)`.

---

## Task 5: Port `scaffold`

**Source of truth:** `quorum/scaffold.py` (208 LOC). **Tests:** `tests/quorum/test_scaffold.py` (238 LOC).

**Files:**
- Create: `ts/src/quorum/scaffold.ts`
- Create: `ts/test/quorum/scaffold.test.ts`

**Public API:**
- `class ScaffoldError extends Error`
- `newScenario(scenariosRoot: string, name: string): string` (from `new_scenario` — writes story.md/setup.sh/checks.sh from the templates `_STORY_TEMPLATE`/`_SETUP_TEMPLATE`/`_CHECKS_TEMPLATE`; port the templates verbatim)
- `checkScenario(scenarioDir: string): string[]` (from `check_scenario` — returns the list of problems; empty = ok)
- `fixExecutableBits(scenarioDir: string): string[]` (from `fix_executable_bits`)
- private helpers `_parse_frontmatter`, `_validate_checks_sh`, `_scenario_scripts`.

Read `quorum/scaffold.py` for the exact validation rules (checks.sh structure:
`pre()`/`post()` only; checks.sh must NOT have exec bit; etc.) and the templates.
Use `yaml` for `_parse_frontmatter` if the Python does (check — it may be regex).

- [ ] **Step 1: Port tests (RED)** from `test_scaffold.py` (new-scenario file creation, every check_scenario violation, executable-bit handling). Run → FAIL.
- [ ] **Step 2: Implement `ts/src/quorum/scaffold.ts`** (templates verbatim, same validation rules; use `node:fs` stat for exec bits).
- [ ] **Step 3: Green** + typecheck.
- [ ] **Step 4: Commit** `feat(ts): port scaffold to TS (phase B)`.

---

## Task 6: Port `show`

**Source of truth:** `quorum/show.py` (498 LOC — the largest; an ANSI verdict renderer). **Tests:** `tests/quorum/test_show.py` (709 LOC).

**Files:**
- Create: `ts/src/quorum/show.ts`
- Create: `ts/test/quorum/show.test.ts`

**Public API:**
- `class ShowError extends Error`
- `isBatchDir(path: string): boolean`
- `resolveTarget(target: string | undefined, resultsRoot: string): string`
- `render(verdict: object, runDir: string, opts: {color: boolean, mode: ShowMode}): string`
- `renderBatch(...)` (match the Python signature)
- the formatting helpers (`_fmt_ms`, `_fmt_cost`, `_fmt_tokens`, `_fmt_bytes`,
  `_short_model`, economics pane, header/gauntlet/checks panes, `_wrap_indent`,
  glyphs/colors) → module-private TS functions. Port the ANSI styling and layout
  EXACTLY (the tests assert on rendered strings, including styling/wrapping).

This is the fiddliest port (exact string/ANSI/width parity). The 709-LOC test
file is the spec — port its cases faithfully; they pin the rendered output.

- [ ] **Step 1: Port tests (RED)** from `test_show.py` — every render case (pass/fail/indeterminate, color on/off, economics pane, batch matrix, wrapping, target resolution, `ShowError` paths). Run → FAIL.
- [ ] **Step 2: Implement `ts/src/quorum/show.ts`** — replicate the ANSI codes, glyphs, column widths, and wrapping from `show.py` exactly so the rendered strings match.
- [ ] **Step 3: Green** + typecheck.
- [ ] **Step 4: Commit** `feat(ts): port show to TS (phase B)`.

---

## Final: phase verification

- [ ] Run `cd ts && bun test` — all (existing + ~5 new test files) green.
- [ ] Run `cd ts && bun run typecheck` — clean.
- [ ] Run `uv run pytest tests/ -q` + `uv run ruff check` + `uv run quorum check`
  — confirm the **Python harness is untouched** (this phase only adds TS;
  nothing Python was modified or deleted, so these must be exactly as before).
- [ ] Update `docs/superpowers/plans/2026-06-13-atif-port-status-and-remaining.md`
  (or a Phase-B note): record the 5 modules as ported-to-TS (build-ahead),
  Python retained pending caller migration.

## Self-Review

**Spec coverage:** each of the 5 modules has a port task + a ported-tests task; the
dep + final verification are covered. ✓
**No placeholders:** each task names the exact source module, the public API
signatures, the test file to port, and TDD steps. The "complete code" is the
cited Python source (authoritative for a port) + the ported tests (parity lock). ✓
**Type consistency:** TS function names are the camelCase of the Python names;
`CodingAgentConfig`/`ShowMode` types are defined in their tasks and self-contained.
The 8-normalizer supported-set must be a single shared constant (Task 4) — don't
duplicate it.
**Integration model:** explicitly build-ahead; no live wiring/deletion — stated up
front so reviewers don't expect Python removal in this phase.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-14-phase-b-leaf-modules-ts-port.md`.
Execute with **superpowers:subagent-driven-development** (fresh subagent per task,
two-stage review each). Tasks are independent except Task 1 (dep) which precedes
the rest; Tasks 2–6 can each be a separate implementer.
