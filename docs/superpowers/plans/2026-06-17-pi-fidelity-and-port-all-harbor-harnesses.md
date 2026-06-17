# Pi Full-Fidelity + Port All Remaining Harbor Harnesses — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (1) Upgrade the `pi` normalizer to full-fidelity ATIF, and (2) add TS-native ATIF normalizers for **every** coding agent Harbor supports that we don't yet have, by porting Harbor's converters into our conventions — getting us from 8 harnesses to Harbor-complete coverage.

**Architecture:** Two independent efforts. **Pi** has NO Harbor converter, so it's reverse-engineered from pi's own captured log (following the full-fidelity template established by the `feat/full-fidelity-atif` branch). **The rest** ARE in Harbor, so each is a programmatic port per `docs/superpowers/reference/porting-harbor-converters.md`: port Harbor's `installed/<agent>.py` converter + its unit-test fixtures into a TS `src/normalize/<agent>.ts` + `test/normalize.<agent>.test.ts`, translating to OUR conventions, validated with Harbor's own converter as the parity oracle on Harbor's fixtures (we have no real captured logs for agents we can't yet run).

**Tech Stack:** TypeScript/Bun; `src/normalize/`, `src/capture/`, `src/atif/`; Harbor 0.14.0 (pinned commit `5352049de712613e58459cad41afcf0bf8645738`) at `/tmp/harbor-inspect` (source) and `/tmp/harbor-spike/venv` (`harbor==0.14.0`, parity oracle).

**Base:** Execute on top of `feat/full-fidelity-atif` (the full-fidelity template, the `scripts/harbor-parity.ts` harness, and `src/normalize/agent-prompt.ts` live there) — merge it to main first, or branch this work from it. Do NOT start from plain `main` (it lacks the template + harness).

## Global Constraints

- **Port targets OUR conventions, never Harbor's.** DISJOINT token buckets (`prompt`=uncached, `cached`=cache_read, `step.extra.cache_write`=cache_creation, `completion`=output+reasoning where split) — never Harbor's inclusive/summed prompt. SINGLE-SOURCE metrics (per-step OR final_metrics, never both). CANONICAL tool names via a per-agent `*_TOOL_MAP` + `src/normalize/agent-prompt.ts` (subagent dispatch → `Agent`, prompt arg → `prompt`) — never Harbor's native names. Never fabricate cost (obol prices; no LiteLLM). `ATIF_SCHEMA_VERSION` constant (v1.7), never a literal.
- **No ATIF schema change** — `src/atif/types.ts` already models every field.
- **Full-fidelity from the start** for every ported normalizer: `message`, `reasoning_content`, `observation` (with `source_call_id` matching the same step's `tool_call_id`), `model_name`, `session_id`, `agent.version`/`agent.extra` — wherever the source log carries them. Do not fabricate fields the log lacks.
- **Drop Harbor's framework** (BaseInstalledAgent, environments, install/run, LiteLLM pricing) — port only the parse path.
- **Validation:** each ported normalizer must pass (a) ported Harbor unit-test cases translated to TS inline fixtures, and (b) parity vs Harbor's own converter on those fixtures via `scripts/harbor-parity.ts` (extend it per agent). For agents we CAN run later, add real-trace validation then.
- **Attribution:** each ported `src/normalize/<agent>.ts` carries a header crediting Apache-2.0 Harbor + the pinned commit (per the porting guide).
- **Additive, non-breaking:** wire each new normalizer into `src/capture/index.ts`'s registry; `bun run check` + `bun run quorum check` green after every task.
- **Scope boundary:** this plan covers NORMALIZERS only. Each new harness ALSO needs provisioning/auth (`coding-agents/<name>.yaml` + adapter) to actually RUN — that is a SEPARATE effort and the real coverage bottleneck. A ported normalizer with no provisioning is validated against Harbor fixtures but won't have live runs until provisioning lands.

---

## Phase 1 — Pi full-fidelity

### Task 1: pi full-fidelity (reverse-engineered, no Harbor reference)

**Files:** Modify `src/normalize/pi.ts`; Test `test/normalize.pi.test.ts`.

Pi has NO Harbor converter — there is nothing to port. Upgrade it by reading pi's own captured log and following the full-fidelity template (`src/normalize/claude.ts`/`opencode.ts` on the base branch).

- [ ] Read a real pi log: `results/sdd-go-fractals-elicited-pi-*/home/...` (find a pi run with a session log; pi sessions live under its config home). Document the log shape.
- [ ] Identify which content fields pi's log carries: assistant message text, reasoning/thinking, tool results/outputs. Implement extraction ONLY for fields present.
- [ ] Add (per what the log carries): `message` (assistant/user text), `reasoning_content`, tool-result → `observation` (linked by call id), `session_id`, `model_name`/`agent.version` if present.
- [ ] KEEP existing pi behavior: DISJOINT buckets (`input`→prompt, `cacheRead`→cached, `cacheWrite`→`extra.cache_write`, `output`→completion), `cost.total`→`cost_usd` passthrough, `provider`→`extra.provider`, `subagent`→`Agent` aliasing if pi has one (verify against the real log — mirror the kimi finding: check whether pi's orchestrator emits `Agent` natively or a `subagent` tool).
- [ ] TDD: failing tests against pi's real log shape (RED) → implement (GREEN) → real-trace inspect → existing pi tests green → `bun run check` + `bun run quorum check` green → commit.

---

## Phase 2 — Port every other Harbor-supported harness

### Task 2.0: enumerate the to-port set

**Files:** none (produces the task list for 2.1+).

- [ ] List every Harbor agent with a real log→ATIF converter (a class with `SUPPORTS_ATIF` + a `_convert_*`/`convert_*` method) in `/tmp/harbor-inspect/src/harbor/agents/installed/`. Exclude the 8 we already have (claude/codex/gemini/copilot/opencode/kimi/antigravity/pi) and exclude runner-only stubs (no converter). Expected candidates (verify against the pin, don't trust this list): **cursor, qwen, goose, hermes, mimo, trae, rovodev, devin, openhands, cline, openclaw, swe-agent, mini-swe-agent**, plus the **generic ACP** path (`acp.py` — note it covers one ACP agent per registry entry, not many; treat as its own task only if we intend to run an ACP agent).
- [ ] For each candidate, record: the converter entry point, the native log format it expects, and whether Harbor ships unit tests for it (port those). Produce the ordered per-harness task list.

### Tasks 2.1…2.N: one per harness (subagent-driven fan-out)

For EACH harness from Task 2.0, a fresh subagent does (per `docs/superpowers/reference/porting-harbor-converters.md`):

**Files:** Create `src/normalize/<agent>.ts`; Create `test/normalize.<agent>.test.ts`; Modify `src/capture/index.ts` (register `<agent>: normalize<Agent>`). Reference: `/tmp/harbor-inspect/src/harbor/agents/installed/<agent>.py` + `tests/unit/agents/installed/test_<agent>*.py`.

- [ ] Port the parse path to a TS `normalize<Agent>(raw, version): AtifTrajectory` in OUR conventions (disjoint buckets, canonical tool names via a new `<AGENT>_TOOL_MAP` + `agent-prompt.ts`, single-source metrics, full-fidelity content, attribution header). Drop Harbor's framework + LiteLLM pricing.
- [ ] Port Harbor's unit-test fixtures + assertions into `test/normalize.<agent>.test.ts` as TS inline fixtures (RED) → implement (GREEN).
- [ ] Extend `scripts/harbor-parity.ts` to support `<agent>` and validate ours == Harbor's converter (tool-calls + disjoint tokens) on Harbor's fixtures / a synthetic log.
- [ ] Register in `src/capture/index.ts`. `bun run check` + `bun run quorum check` green. Commit.
- [ ] Record the Harbor pin (commit + version) for this converter in the file header / the `harbor-pin` manifest.

**Note:** these run independently per harness — safe to parallelize across git worktrees (each touches a disjoint new file + the shared `capture/index.ts` registry line + `harbor-parity.ts`; coordinate the two shared-file edits or serialize the final registry/harness wiring to avoid races).

---

## Out of scope (tracked separately)
- **Provisioning/auth** for each newly-ported harness (so they actually run) — the real coverage bottleneck.
- **Antigravity token capture** (the prior plan's Task 9) — blocked on #18.
- **Verb overhaul** — the payoff this fidelity unlocks; its own plan once this lands.

## Self-Review notes
- Pi is Phase 1 (reverse-engineered, we have logs); everything else is Phase 2 (ported from Harbor, validated on Harbor fixtures since we lack real logs for un-runnable agents).
- Global Constraints repeat the five regression traps + the port-to-our-conventions rule, because porting Harbor naively reintroduces inclusive buckets / native names / hybrid metrics / LiteLLM cost.
- Task 2.0 enumerates from the pinned Harbor source rather than hardcoding a list that will rot.
- Execution base is `feat/full-fidelity-atif` (has the harness + template + agent-prompt helper), NOT plain main.
