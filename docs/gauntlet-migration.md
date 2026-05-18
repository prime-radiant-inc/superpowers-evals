# Gauntlet Migration: Replacing Drill

**Date:** 2026-05-18
**Status:** Spec (draft, v2)
**Author:** Auri@15da9a04 (Opus 4.7)

## Thesis

Drill's purpose — measuring whether superpowers skills reliably fire across coding-agent CLIs — is sound. Drill's implementation duplicates infrastructure Gauntlet already provides: tmux-driven target interaction, agent loop, evidence pipeline, multi-trial aggregation. Once Gauntlet's QA agent gained a bash tool, even the role Drill assigned to a separate verifier LLM (judging the agent-under-test's tool log) collapses into Gauntlet's existing agent — the QA agent can read the log directly.

Replace Drill with **Gauntlet plus a small Python harness.** Gauntlet drives the target, observes both the screen and the agent's session log via bash, and issues the verdict. The harness handles the two things Gauntlet shouldn't know about: per-scenario workdir setup, and post-run deterministic assertions that protect acceptance criteria from LLM-verdict drift.

The boundary is the design. Gauntlet stays a general-purpose QA driver. The harness stays small.

## Why this is worth doing

- Drill's actor loop, tmux engine, sweep, compare, and evidence dir all duplicate Gauntlet features with different file names and a Python accent.
- Drill's separate verifier LLM existed because its actor had no view of the agent-under-test's session log. Gauntlet's QA agent now has bash; the same evidence is available to it directly.
- Drill's per-backend busy-pattern detection existed because its actor was a thin Sonnet call without an agentic loop. Gauntlet's QA agent has the loop and can tail the agent's session log to know when the agent is idle. The deterministic signal beats the visual heuristic.
- Backend variation in Drill is a YAML file selecting a CLI command. In Gauntlet it is `--target claude` vs `--target codex`. The difference is bookkeeping.

What remains genuinely Drill-specific is small enough to keep external.

## What Drill does today

Stripped to essentials, Drill does five things in order:

1. **Mutates a fresh workdir** to a known initial state (clones a template repo, adds a worktree, detaches HEAD, installs plugin hooks).
2. **Drives a coding-agent CLI in tmux.** A Sonnet "actor" reads scenario turn intents, types prompts, and waits for backend-specific idle patterns.
3. **Snapshots evidence:** terminal transcript, post-run filesystem state, and the agent-under-test's own session log (`~/.claude/projects/**/*.jsonl`, `~/.codex/sessions/rollout-*.jsonl`), normalized per-backend into a common `{tool, args, source}` schema.
4. **Judges twice:** Sonnet verifier against semantic criteria; shell assertions (`skill-called`, `tool-called`, `tool-before`, `tool-arg-match`) against the normalized log.
5. **Repeats** N × M for stats (sweep, Wilson CIs).

The load-bearing capability is access to the agent-under-test's own tool log. Distinguishing *the agent claimed to use the skill* from *the agent actually used the skill* is the entire point of a compliance benchmark.

## What Gauntlet provides natively

| Drill concern | Gauntlet today |
|---|---|
| Actor LLM | The Gauntlet QA agent (it *is* the user simulator) |
| Tmux + send-keys + capture-pane | TUI adapter, identical mechanics |
| Verifier evidence (agent tool log) | The QA agent reads it directly via bash |
| Screen-side verdict | `report_result` + `## Acceptance Criteria` |
| Wait-vs-respond decisions | The QA agent tails the agent's session log via bash |
| Sweep × N + stats | `--passes` (1–50) + run-sets (`consistent_pass` / `mixed` / `errored`) |
| Backend variation | `--target claude` vs `--target codex` |
| Naive vs spec-aware posture | Two stories with different prose |
| Per-target invocation knowledge | `.gauntlet/context/` files the QA agent reads |
| Evidence dir per run | `<project-dir>/.gauntlet/results/<runId>/` or `--out <dir>` |

The bash tool is the pivotal change since Drill's design. It collapses three things Drill kept separate (actor, busy-detector, verifier) into one Gauntlet agent with two observation channels: the screen via the TUI adapter, and any file via bash.

## What the harness still owns

Two things:

1. **Per-scenario workdir setup.** Gauntlet has read-only `.gauntlet/context/` fixtures. Drill *mutates* a workdir before the agent launches (clones a template, adds a worktree, plants flawed code, etc). The harness owns this: each scenario provides a `setup.sh` that runs against a fresh temp workdir. Non-zero exit aborts the run with a clear "setup invariant violated" error.

2. **Post-run deterministic assertions for AC regression-testing.** The harness snapshots the agent's session-log directory before launch, diffs after, normalizes per-target into `tool_calls.jsonl`, and runs scenario `assertions/*.sh` against it. These are not a second verifier — the QA agent's verdict over the same evidence is authoritative. The assertions are a frozen check that an acceptance criterion catches what it should catch, independent of any single run's verdict. They surface AC drift when models update.

Per-target normalizers (Python modules, one per agent CLI) lift `drill/normalizer.py` near-verbatim. The `bin/` assertion helpers port unchanged.

## The Agent / Verifier collapse

Drill had two LLMs (actor + verifier) because its actor could not see the agent-under-test's session log. Gauntlet has one agent because bash gives it the same evidence. An acceptance criterion like *"the agent invoked the writing-plans skill before writing any implementation code"* now belongs in the story card, evaluated by the QA agent reading the agent's own log via bash. No second verifier pass; no external LLM with shared context.

The harness's deterministic assertions are not a verifier substitute. They are a regression test for the acceptance criteria themselves — a guard that survives LLM updates, model swaps, and verdict noise. Composition rule:

> A scenario passes iff the Gauntlet verdict is `pass` AND every assertion exits 0.

No per-scenario composition DSL. Investigate verdicts compose as fail (clean signal beats fuzzy state for a benchmark).

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  superpowers-evals (the harness)                            │
│                                                             │
│  scenarios/<name>/                                          │
│    story.md           Gauntlet story (outcome + AC)         │
│    setup.sh           Pre-run workdir mutation              │
│    assertions/*.sh    Post-run regression checks            │
│    target.yaml        Which agent CLI + normalizer to use   │
│                                                             │
│  harness/  (Python)                                         │
│    runner.py          Orchestrate a single scenario run     │
│    normalizers.py     Lifted from drill/normalizer.py       │
│    target_contexts/   Per-target HOWTO docs (5-line files)  │
│    cli.py             uv run harness run <scenario>         │
│                                                             │
│  bin/                 Assertion helpers (unchanged)         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                           │
                           │ subprocess: gauntlet run
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  gauntlet (unchanged)                                       │
│                                                             │
│  TUI adapter ─── tmux ─── bash ─── agent under test         │
│                                       (claude / codex / …)  │
│                                                                          
│  QA agent loop:                                             │
│    - read_screen (TUI adapter)                              │
│    - bash → tail / cat / jq the agent's session log         │
│    - context: target HOWTO + story + assertions             │
│    - report_result → verdict                                │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Per-run flow

```
1. LOAD scenario (story.md, setup.sh, assertions/, target.yaml)
2. CREATE per-run dir at /tmp/harness-run-XXX/
     - this is BOTH the gauntlet --project-dir AND the evidence root
3. POPULATE /tmp/harness-run-XXX/.gauntlet/context/
     - copy harness/target_contexts/<target>/* (invocation, log path, shutdown)
4. CREATE temp workdir at /tmp/harness-wd-XXX/
5. RUN setup.sh in workdir; abort on non-zero
6. SNAPSHOT agent-under-test session-log dir (per target.yaml)
7. INVOKE gauntlet from workdir:
     cd <workdir> && gauntlet run scenarios/<name>/story.md \
       --adapter tui \
       --target <binary from target.yaml> \
       --project-dir /tmp/harness-run-XXX \
       --silent
8. NORMALIZE: diff session-log dir, write tool_calls.jsonl into run dir
9. ASSERT: run assertions/*.sh from run dir (DRILL_WORKDIR=workdir, bin/ on PATH)
10. COMPOSE final verdict (gauntlet AND assertions)
11. WRITE verdict.json; clean up workdir on pass, keep on fail
```

The QA agent in step 7 reads its `.gauntlet/context/`, learns how to invoke the target binary (typing it into bash), and uses bash plus `read_screen` to drive the agent and observe its log. When ready, it calls `report_result`.

## What stays in / out of Gauntlet

**In Gauntlet (no changes):** TUI adapter, agent loop, AC verdict, evidence pipeline, run-sets, batch mode, fanout, `--passes`, bash tool, context-dir reading.

**In the harness (new code in `superpowers-evals/`):** workdir setup, per-target session-log capture and normalization, deterministic assertions, per-target context docs (small), per-scenario target manifests, the lifted `bin/` helpers, the lifted token-usage capture (deferred wiring until first cost-scenario port).

**Not in either (yet):** sweep CLI, cross-target comparison view. Shell loops cover Phase 1; promote when friction warrants.

## Migration phases

### Phase 1 — Build the harness, prove parity on three scenarios

One scenario is not enough. To exercise the surfaces that actually break in migration, Phase 1 covers three:

1. **`triggering-writing-plans`** (Claude, single turn, single assertion). Smallest parity test.
2. **`worktree-already-inside`** (Claude, multi-helper setup, agent starts inside a sibling worktree subdir). Exercises non-trivial setup; the QA agent uses bash + story prose to navigate.
3. **A Codex scenario, e.g., `codex-subagent-wait-mapping`.** Exercises the Codex normalizer's cwd-filtering logic, the place per-target log capture is most likely to break.

Steps:

1. Build the per-run flow as a Python CLI (`harness run <scenario>`).
2. Lift `drill/normalizer.py` and `drill/token_capture.py` near-verbatim with their tests.
3. Port `bin/` helpers verbatim — already framework-agnostic.
4. Convert all three scenarios. Each becomes `scenarios/<name>/{story.md, setup.sh, assertions/*.sh, target.yaml}`.
5. Run both Drill and the harness against the same backends. Document divergence.

Phase 1 passes when: harness verdict matches Drill verdict on all three (or any divergence is explained and accepted in `docs/migration-notes.md`), `tool_calls.jsonl` is byte- or schema-equivalent, and assertion scripts exit identically.

### Phase 2 — Port scenarios incrementally

Order by leverage and risk:

1. Remaining worktree scenarios.
2. Other `triggering-*` scenarios.
3. `code-review-catches-planted-bugs`, `spec-reviewer-catches-planted-flaws`.
4. `cost-*` scenarios (these wire the lifted token-usage module).

Each port: scenario YAML body → `story.md` rewritten per the `writing-gauntlet-stories` skill; setup helpers → `setup.sh`; verify section → AC + `assertions/*.sh`. Where an AC rewrite resists clean translation, the original criterion was probably testing implementation rather than outcome — flag for redesign, not forced translation.

**Forcing function:** every skipped or materially-redesigned scenario goes in `docs/migration-notes.md` with the reason. Reviewed before Phase 3.

### Phase 3 — Decommission

Mark Drill deprecated in `README.md`, point at the harness, eventually delete `drill/` and the Python actor/verifier/sweep code. Keep scenarios, normalizers, harness, `bin/`.

## Non-goals

- Gauntlet does not become an eval-specific tool. The TUI adapter sees a subprocess; whether that subprocess is itself an AI agent is not its concern.
- Live evals stay maintainer-local. Same trust boundary as Drill today.
- No cross-target comparison view in Phase 1. Two invocations and a diff.
- No Docker isolation in Phase 1. Revisit with concurrent runs.
- No Gauntlet changes. If a feature is missing, file separately.

## Risks

- **Per-target normalizer drift.** When Claude Code or Codex changes its session-log format, normalizers break silently. Mitigation: schema test per normalizer against a recorded fixture log.
- **Concurrent-run safety.** Multiple harness runs against the same target share `~/.claude/projects/` — snapshot-and-diff cross-contaminates. Phase 1 is single-run-at-a-time, enforced by a lockfile. Revisit when sweep-N is built.
- **Empty-capture vacuity.** If the agent session crashes before any tool call, `tool_calls.jsonl` is empty and `tool-not-called`-style assertions pass vacuously. Drill guards against this (`drill/engine.py:169–178`); the harness reproduces the guard by injecting a synthetic failed assertion when capture is empty AND the scenario declares any tool-related assertions.
- **PATH inheritance.** Assertions inherit the caller's PATH plus `bin/`. On a developer laptop this is fine; in CI it isn't. Phase 1 is not a CI workload, so this is a Phase 2+ concern, but documented now.
- **QA agent skips the log when AC could be checked from screen alone.** Bash is available but the QA agent decides whether to use it. If a story's AC is screen-checkable AND the QA agent is satisfied by screen evidence, it may not consult the log — leaving "agent actually invoked the skill" unverified. Mitigation: write AC that *requires* log evidence ("evidence: a `Skill` tool invocation with `superpowers:writing-plans` in the agent's session log"). The `writing-gauntlet-stories` skill already encourages evidence-demanding ACs; this just applies it to log evidence.

## Citation / prior art

Drill design: `docs/design.md` (Jesse, 2026-04-07).
Gauntlet docs: `gauntlet/README.md`, `gauntlet/src/agent/prompts/`.
Skill: `gauntlet/.claude/skills/writing-gauntlet-stories/SKILL.md`.
