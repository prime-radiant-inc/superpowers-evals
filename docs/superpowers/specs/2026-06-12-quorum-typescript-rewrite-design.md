# Quorum — TypeScript Rewrite (Umbrella Architecture)

**Date:** 2026-06-12
**Status:** Design approved; umbrella spec. Each sub-project (§9) gets its own
spec → plan → build cycle; this document is the spine they hang from.
**Author:** Scotty@2a8a33ad (Opus 4.8, 1M), with Matt.
**Ticket:** umbrella for the quorum TypeScript rewrite (file under Prime
Radiant). Related: PRI-2203 (scheduler), PRI-2185 (dashboard).

## 1. Purpose

quorum is written in Python, which is not on the house list of approved
languages (TypeScript, Go, Rust). This document records the decision to
rewrite it in **TypeScript on Bun** and the architecture that rewrite follows.

The Python is ~8.9k LOC of production code plus ~16.5k LOC of tests, written
over one-to-two weeks. It is **not precious**: we are attached to its
*function*, not its *form*. The goal is to leave Python cleanly, preserve
behavior, and not write another line of Python that will only be rewritten.

This is a **full clean rewrite**, not a mechanical port. The terminal state is
**parity**: every scenario yields a semantically-identical verdict to the
Python, the scheduler satisfies its spec, and the dashboard matches its specs.

## 2. The decision: TypeScript on Bun

The workload is an **I/O-bound subprocess orchestrator**: it shells out to
`gauntlet` and to coding-agent CLIs, normalizes their heterogeneous session
logs, prices tokens, composes a three-valued verdict, schedules batches, and
serves an htmx dashboard. The hard QA logic lives behind external process
boundaries, so the rewrite is orchestration + parsing + web, not
reimplementing the tester.

**Rust** is rejected: its only real draw here was calling `obol-core`
natively, but the obol TS binding already returns byte-identical results
behind a clean call, so Rust buys nothing while costing the most velocity on
what is fundamentally glue.

**Go** is a strong, legitimate runner-up — it owns the scheduler (goroutines ≈
the jobs-queue/lane model), rates the gauntlet subprocess boundary *trivial*,
and ships a single static binary. It loses to TypeScript on three grounds:

1. **Ecosystem cohesion.** Gauntlet — the thing quorum wraps — is itself a
   Bun-compiled TypeScript CLI. One runtime across the tester and its harness,
   the option to share boundary types, and a team already fluent in Bun.
2. **The messiest subsystem favors structural typing.** The normalizers (8
   dialects, hand-rolled JSON descent, multi-shape argument inference) narrow
   dynamically in TS; Go's strict struct unmarshaling fails *silently* on
   field drift — the exact failure mode you do not want in cost accounting.
3. **obol parity is best-supported and pre-validated in TS.** `npm install
   @primeradianthq/obol` runs on Bun and Node, bundles native libs, exposes
   `setPricingDir`/`clearPricingDir` for hermetic tests, and was validated
   *byte-identical against superpowers-evals itself*.

`bun build --compile` yields a single `quorum` executable, neutralizing most
of Go's distribution edge. Runtime posture: **Bun-primary, Node-compatible
where it is free** (do not gold-plate Node).

## 3. Fixed points (reused, external, or preserved)

These are constraints the rewrite builds around, not work it redoes:

- **obol** — consumed via `@primeradianthq/obol`. Same surface as today:
  `estimate_path(path, dialect)`, `refresh(as_of)`, `version()`, plus
  `setPricingDir` for tests. quorum owns its refresh story.
- **gauntlet** — a pure external subprocess (Bun-compiled TS binary). The
  boundary is language-neutral: spawn `gauntlet run story.md --adapter tui
  --target … --project-dir … --state-dir gauntlet-agent …`, await, then read
  `<project-dir>/gauntlet-agent/results/<runId>/result.json` (+ optional
  `usage.jsonl`). No code import.
- **`bin/`** — the 31 deterministic check tools are language-neutral bash and
  are **reused untouched**. They emit one JSON record each via `_record`.
- **`scenarios/`** — `story.md` / `setup.sh` / `checks.sh` are markdown+bash
  and stay; the only edit is the `setup-helpers` invocation string.
- **`coding-agents/*.yaml`** — the declarative agent config stays; the rewrite
  adds the optional `launch_spacing_seconds` key (PRI-2203).
- **Output contract** — `results/` layout, run-dir naming, `verdict.json`
  shape, and the frozen `economics` keys are preserved **semantically**, not
  byte-for-byte. Differing JSON formatting is fine; same structure and values
  is the bar. `results/` is consumed only by quorum itself, so preservation
  buys the dashboard read-side and the differential oracle (§7) — nothing
  external depends on it.

**Parity rule:** parity is measured against the **Python by default**, and
against an **approved spec wherever one supersedes the Python** (the scheduler
is the first such case — see §6). Scan `docs/superpowers/specs/` per subsystem
before building it.

## 4. Architecture — repo, runtime, layout

### Repo strategy: in-place replacement
`superpowers-evals` remains a standalone repo. The implementation language
changes; the project does not.

- **Rewritten (TS):** `quorum/` → `src/`, `tests/` → `test/`, `setup_helpers/`
  → TS, `pyproject.toml`/`uv` → `package.json`/`bun`.
- **Kept:** `bin/`, `scenarios/`, `coding-agents/`, `docs/`, `CLAUDE.md`.
- **CLI:** `uv run quorum …` → `quorum …` (a `bun build --compile` binary),
  `bun run quorum` in dev. Same seven subcommands and flags.

### Runtime & tooling
- **Bun** primary; Node-compatible where free.
- **Validation:** `zod` at every JSON/YAML boundary (agent YAML, gauntlet
  `result.json`, session-log lines, `verdict.json`). This is how the
  structural-typing win is realized without `any` creep.
- **Tests:** `bun test`. **Lint/format:** Biome (one fast tool, mirrors
  ruff's ergonomics). **Typecheck:** `tsc --noEmit`.

### Module layout — small, single-purpose files
The 2,544-LOC `runner.py` is not reproduced; orchestration becomes a pipeline
of focused phase modules.

```
src/
  contracts/     zod schemas + types: verdict, results-layout,
                 agent-config, gauntlet-boundary (the shared spine)
  obol/          thin wrapper over @primeradianthq/obol
  economics.ts   compose obol blocks -> economics (pure)
  capture/       session-log snapshot/diff, tool-call capture
  normalizers/   one file per dialect (claude, codex, kimi, ...)
  agents/        CodingAgent interface + registry + per-agent adapters
  checks/        bridge: source bash checks.sh, run bin/ as-is, collect records
  composer.ts    three-valued verdict (pure)
  runner/        orchestration as discrete phases
  scheduler/     PRI-2203 engine (dispatcher, clock, eligibility)
  run-all.ts     batch caller (matrix, readout, results.jsonl)
  cli/           run · show · list · new · check · run-all · dashboard
  dashboard/     read-side + SSE + htmx templates (built LAST)
test/
  mock-gauntlet/ stub binary + fixture droppers
  fixtures/      recorded session logs per dialect (mined from results/)
  golden/        frozen Python verdict.json corpus (differential oracle)
```

### The agent plugin model (the spine)
The 8 agents are the most-extended surface, so their boundary is the most
important interface in the system. One `CodingAgent` contract, driven by the
existing YAML, with optional behavior hooks:

```ts
interface CodingAgent {
  readonly config: AgentConfig;            // parsed YAML
  provision(home: RunHome): Promise<void>; // seed isolated config dir
  preflight?(env: Env): Promise<Env>;      // kimi sentinel, agy parse
  normalize(sessionLog: Path): ToolCall[]; // dialect -> canonical
  teardown?(run: RunCtx): Promise<void>;   // agy tmux/creds
}
```

- **Declarative agents** (claude, claude-haiku, claude-sonnet, codex, copilot,
  gemini, pi) → one `DefaultAgent` driven entirely by YAML + a named
  normalizer. Adding such an agent is a YAML file (+ maybe a normalizer), no
  new class.
- **Code-bearing agents** get their own adapter implementing the optional
  hooks: **kimi** (deep auth/sentinel — the one hard one), **antigravity**
  (rate-limit watcher + creds backup + tmux teardown), **opencode** (session
  export). A `name → adapter` registry resolves them; all others fall through
  to `DefaultAgent`.

Each agent is then understandable and testable in isolation: feed it a
recorded session log, assert the canonical tool-calls; mock its provisioning,
assert the seeded home.

## 5. The runner pipeline

A thin orchestrator over small, typed, individually-testable phases:

```
setup -> pre-checks -> preflight? -> drive(gauntlet) -> capture -> post-checks -> compose -> write verdict.json
```

- **setup** — resolve scenario, mint `results/<…>/<run-dir>`,
  `agent.provision()`, run `setup.sh` with `$QUORUM_WORKDIR`, validate
  `required_env` (the "required env vars not set" guard).
- **pre-checks** — checks-bridge runs `pre()`; any failure short-circuits to
  `indeterminate`.
- **preflight?** — `agent.preflight()` when present.
- **drive** — spawn `gauntlet` with the exact contract; the antigravity
  rate-limit watcher runs concurrently and tears down on a 429 marker.
- **capture** — snapshot/diff the agent's session log → normalize →
  obol-price.
- **post-checks** — `post()`, with `$QUORUM_RUN_DIR` exposed.
- **compose** — build `FinalVerdict`, write `verdict.json`.

The orchestrator owns error-stage mapping
(`setup|gauntlet|capture|checks|compose|stopped|…` → `error.stage`). The whole
chain is driven by mock-gauntlet in tests, exercising every path — including
the error stages — for zero tokens.

## 6. Engines

### Capture & normalizers (the long pole)
Each normalizer is a pure `(rawLines) → ToolCall[]` with a per-dialect
`TOOL_MAP` + `NATIVE_TOOLS` set: zod-parse each JSONL line into a permissive
dialect schema, then narrow. The nasty cases get explicit homes —
opencode/copilot argument inference (`file_path` ∈ {filePath, path, file,
patch-extracted}) and antigravity's dual-location (top-level +
`PLANNER_RESPONSE`) descent. Tested against real logs mined from `results/`,
one fixture set per dialect. obol prices each session-log file; the
`_merge_estimates` bucket-summation ports 1:1; the frozen `economics` keys are
preserved exactly.

### Scheduler — implement PRI-2203, not the Python
`docs/superpowers/specs/2026-06-12-quorum-scheduler-design.md` was written for
this rewrite and **supersedes** `quorum/scheduler.py`. A central dispatcher
owns all state (`free_slots`, `inflight[h]`, `next_start[h]`, `latched`,
`stop_requested`); a **single injectable clock** governs both eligibility and
sleeps; dispatch is greedy and unfair. The mandated property — *a cell waiting
on cap/spacing/latch never holds a global slot* — is the Python bug we
explicitly do **not** port. Latch-and-skip is immediate; stop-skip is
immediate; every cell emits exactly one terminal event with `batch_done` last.
Ship the spec's **8 deterministic verification tests** (fake clock, stub
invoke, no real children). New `AgentConfig` key `launch_spacing_seconds`;
`--jobs` default moves 1 → 8.

### Composer — pure, parity-with-Python
The three-valued verdict is a pure function porting the 6-case decision tree
exactly: crash → pre-fail → missing-gauntlet → investigate/errored →
empty-trace → post-fail-or-pass. No superseding spec, so this is straight
differential-parity against golden `verdict.json`. Exit-code semantics are
preserved (exact values pinned from the code in the Spec 1 brainstorm).

## 7. Testing & parity strategy

Three tiers, two of them free:

1. **Replay differential (free, deterministic).** The pure layers — capture,
   normalize, compose, economics — need no live runs. Feed *recorded* inputs
   (session logs + `result.json` from `results/`) through the TS and
   structurally diff against the Python on the same inputs, and against the
   `verdict.json` already frozen in `results/`. Validates the bulk of the
   logic at zero token cost.
2. **mock-gauntlet integration (free, deterministic).** A stub `gauntlet` on
   `PATH` ahead of the real one. Given `MOCK_GAUNTLET_FIXTURE=<case>`, it drops
   that case's `result.json` (+ optional `usage.jsonl`) into
   `<project-dir>/gauntlet-agent/results/<runId>/` and a canned session log
   into the agent's `session_log_dir`, then exits. Drives the **real runner
   pipeline end-to-end** — every phase and every error stage (pass / fail /
   investigate→indeterminate / errored / empty-capture / pre- and post-check
   fail / crash) — and asserts the resulting `verdict.json`. The integration
   backbone.
3. **Live parity smoke (costs tokens, tiny, gated).** A handful of real
   scenarios × claude through *real* gauntlet + real agent, verdict
   structurally diffed vs Python golden. Trusted-maintainer-only per CLAUDE.md
   live-eval rules — the final parity gate, not a routine test.

Scheduler tests stand apart (the PRI-2203 verification contract). The CLAUDE.md
"safe checks" set gets TS equivalents: `biome check`, `tsc --noEmit`, `quorum
check`, `bun test`.

**Parity = done** means: every corpus scenario yields a semantically-identical
`verdict.json` + `economics` to the Python golden (replay + live-smoke); the
scheduler passes its 8-test contract; the dashboard matches its specs; all four
safe checks are green.

## 8. Cutover

Python stays read-only during the build as a golden-output generator (never
edited). Snapshot golden early; build TS to match; when parity certifies,
delete the Python package + `uv`/`pyproject`, flip the CLI entry, and update
CLAUDE.md commands (`uv run …` → `quorum …`). No parent-submodule bump — the
README/CLAUDE.md "evals submodule" claim is not live and is out of scope here.

## 9. Decomposition & build order

Sequence **B (risk-first walking skeleton)**: the thinnest end-to-end slice
first, additive fan-out after, dashboard last. Each sub-project gets its own
brainstorm → spec → plan → build.

| # | Sub-project | Exit criterion (parity) |
|---|-------------|-------------------------|
| **1** | **Foundation + walking skeleton** — skeleton, `contracts/`, obol+economics, checks-bridge, `DefaultAgent` + claude normalizer, full runner pipeline, composer, `run`/`show`, **mock-gauntlet + replay harness** | `quorum run <smoke> --coding-agent claude` gives a parity verdict via mock-gauntlet; replay-differential green on claude fixtures. *Every scary seam proven.* |
| **2** | **Normalizer & agent fan-out** — 7 remaining dialects; `DefaultAgent` for codex/copilot/gemini/pi; custom adapters opencode, antigravity, **kimi** | all agents at capture/normalize parity vs recorded logs |
| **3** | **`list` / `new` / `check` + setup-helpers** — scaffold, frontmatter, `setup_helpers` → TS | `quorum check` green on all scenarios; authoring at parity |
| **4** | **Scheduler + run-all** — PRI-2203 engine + 8-test contract; batch caller | run-all parity + scheduler contract green |
| **5** | **Dashboard** — read-side, orchestrator (launch/stop/SIGINT), SSE, htmx re-templated | dashboard parity |
| **6** | **Cutover & parity gate** — live smoke, delete Python, flip CLI, update docs | Python gone, all green, parity certified |

## 10. Out of scope

- Behavioral changes beyond what an approved spec mandates. The rewrite
  reproduces function; it does not redesign it (the scheduler is the one
  sanctioned divergence, and it is governed by PRI-2203).
- Redesigning the `results/` layout or `verdict.json` shape.
- A parent-`superpowers` submodule bump (not live).
- Per-sub-project implementation detail — each is specified in its own
  document when reached.

## 11. References

- `docs/superpowers/specs/2026-06-12-quorum-scheduler-design.md` — scheduler
  semantics (PRI-2203); supersedes `quorum/scheduler.py`.
- `docs/superpowers/specs/2026-06-11-quorum-dashboard-build-design.md`,
  `…-visual-design.md` — dashboard consumer (PRI-2185).
- `docs/superpowers/specs/2026-05-22-harness-model-design.md` — scenario /
  verdict / check model the Python already implements.
- `~/Code/prime/obol/README.md` — obol surface, bindings, cross-language
  byte-identical validation against superpowers-evals.
- `CLAUDE.md` — actor table, commands, safe-checks, live-eval policy.
