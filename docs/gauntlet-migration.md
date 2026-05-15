# Gauntlet Migration: Replacing Drill

**Date:** 2026-05-14
**Status:** Spec (draft)
**Author:** Auri@15da9a04 (Opus 4.7)

## Thesis

Drill's purpose — measure whether superpowers skills reliably fire across coding-agent CLIs — is sound. Drill's *implementation* is mostly bespoke infrastructure that duplicates what Gauntlet already does well: drive a tmux-hosted target with an LLM, capture evidence, judge against acceptance criteria, repeat for stats.

Replace Drill with **Gauntlet plus a thin eval harness.** Gauntlet plays the actor and renders the screen-side verdict. The harness owns the eval-lab-specific concerns Gauntlet shouldn't know about: workdir setup, agent-under-test session-log capture, deterministic assertions, and an optional second-pass verifier with access to the captured tool-call log.

The boundary is the design. Gauntlet stays a general-purpose QA driver. The harness stays small enough that someone reading `superpowers-evals/` can see the whole eval pipeline at a glance.

## Why this is worth doing

- **Drill's actor is Gauntlet's agent.** Drill maintains a separate "actor LLM" that takes scenario turn intents and types into the agent CLI. Gauntlet's agent does exactly this — its job is to drive a target through an adapter to satisfy outcome-shaped acceptance criteria. The actor/agent split in Drill is a structural duplication.
- **Drill's tmux engine is Gauntlet's TUI adapter.** `engine.py` + `session.py` ≈ `src/adapters/tui/adapter.ts`. Both spawn detached tmux at fixed dimensions, send keys, capture pane with ANSI preserved. Two tools, identical mechanics.
- **Drill's sweep is Gauntlet's run-set.** `sweep.py` runs N trials × M backends with try/except per run and writes a manifest. Gauntlet's `--passes` × `gauntlet batch` produces a run-set with `consistent_pass` / `mixed` / `errored` aggregation. Same shape, different file.
- **Drill's compare is two `gauntlet run` invocations.** Backend variation in Drill is a YAML file selecting a CLI command. In Gauntlet it's `--target "claude …"` vs `--target "codex …"`. The difference is bookkeeping.

What Drill does that Gauntlet doesn't is narrow — three specific things, each easy to keep external (see "Three real gaps" below).

## What Drill does today (the parts that actually matter)

Stripped to essentials, Drill does five things in order:

1. **Mutate a fresh workdir** to a known initial state (clone template, add a worktree, detach HEAD, install plugin hooks).
2. **Drive a coding-agent CLI in tmux.** Sonnet "actor" reads scenario turn intents, types prompts, waits for backend-specific idle.
3. **Snapshot evidence:** terminal transcript, post-run filesystem state, and — crucially — the agent-under-test's own session log (`~/.claude/projects/**/*.jsonl`, `~/.codex/sessions/rollout-*.jsonl`), normalized per-backend into a common `{tool, args, source}` schema.
4. **Judge twice:** Sonnet verifier against semantic criteria; shell assertions (`skill-called`, `tool-called`, `tool-before`, `tool-arg-match`) against the normalized log + filesystem.
5. **Repeat** N × M for stats (sweep, Wilson CIs).

The load-bearing capability is **(3) + (4) on the agent-under-test's own log.** Without that, the eval can see what tmux rendered but not what skill the agent actually invoked. Distinguishing *the agent claimed to use the skill* from *the agent actually used the skill* is the entire point of a compliance benchmark.

## What Gauntlet provides natively

| Drill concern | Gauntlet today |
|---|---|
| Actor LLM | The Gauntlet agent (it *is* the user simulator) |
| Tmux + send-keys + capture-pane | TUI adapter, identical mechanics |
| Verifier criteria (screen-side) | `report_result` + `## Acceptance Criteria` |
| Sweep × N + stats | `--passes` (1–50) + run-sets (`consistent_pass` / `mixed` / `errored`) |
| Backend variation | `--target "<cli command>"` |
| Naive vs spec-aware posture | Two cards (separately authored) |
| Evidence dir per run | `<.gauntlet>/results/<runId>/` |

Three of Drill's five layers are already there. The actor/agent collapse is a simplification, not a regression — Gauntlet's "the QA agent IS the user" model is cleaner than Drill's separate actor + agent split.

## Three real gaps

Everything else Drill does that Gauntlet doesn't is dressing. Three things matter, and **all three live outside Gauntlet** in this design:

### 1. Per-scenario workdir setup

Gauntlet has read-only `.gauntlet/context/` fixtures. Drill *mutates* a workdir before agent launch. The harness owns this: each scenario provides a `setup.sh` that runs against a temp workdir (cwd = workdir, with whatever env the harness threads in). Non-zero exit aborts the run with "setup invariant violated" — the same fail-fast Drill has. No Gauntlet change.

### 2. Agent-under-test session-log capture and normalization

This is the load-bearing one. The harness:

1. Snapshots the agent's session-log directory (`~/.claude/projects/`, `~/.codex/sessions/`, `~/.gemini/sessions/`) immediately before launching Gauntlet.
2. Runs Gauntlet against the target.
3. Diffs the directory after, identifies files created during the run, runs a per-target normalizer that maps the native log format into a common JSONL schema.
4. Writes `tool_calls.jsonl` into Gauntlet's evidence dir.

Per-target normalizers are small Python modules (one per agent CLI: Claude Code, Codex, Gemini, Pi). They're lifted from `drill/normalizer.py` near-verbatim. The harness — not Gauntlet — selects the normalizer based on the scenario's declared target type.

### 3. Deterministic post-run assertions

After Gauntlet finishes, the harness runs every executable in the scenario's `assertions/` directory from the evidence dir, with `$DRILL_WORKDIR` (or rename — see Open Questions) pointing at the mutated workdir and `bin/` on `PATH`. Each assertion exits 0 = pass, non-zero = fail. The harness composes the final verdict: **pass iff Gauntlet AC pass ∧ every assertion exits 0**.

Drill's `bin/` helpers (`skill-called`, `tool-called`, `tool-before`, `tool-arg-match`, `tool-count`, `skill-before-tool-match`, `tool-match-before-tool-match`, `codex-native-hook-configured`) port verbatim. They operate on `tool_calls.jsonl` and don't care which framework collected it.

## The Agent / Verifier question

Drill has separate Agent and Verifier LLMs. Drill's verifier reads the agent-under-test's session log; Gauntlet's verdict-issuing agent doesn't have this evidence in its context.

Five paths considered:

- **A. Extend Gauntlet** with a tool that reads agent-under-test logs mid-run. Rejected: forces Gauntlet to know about session-log locations, normalizer schemas — exactly the harness-specific knowledge we're keeping out.
- **B. External post-run verifier** that reads `tool_calls.jsonl` + filesystem + Gauntlet verdict + screen transcript. Optional per scenario.
- **C. Assertions only, no LLM verifier.** Most compliance checks reduce to `skill-called` / `tool-before`. The LLM verifier in Drill exists to catch *workflow* claims ("loaded skill before implementation") that hard assertions can express but awkwardly.
- **D. Gauntlet agent reads the live session log** mid-run. Rejected: wild scope expansion of Gauntlet; the QA agent doesn't actually need this — its job is screen-side.
- **E. "Context input" Gauntlet feature** that lets the harness inject log files into the agent's view. Rejected: same as A in different clothes.

**Decision: B as default, C wherever it suffices.**

Reasoning:

1. Honors the Gauntlet-stays-small boundary. Log capture and per-target knowledge live in the harness.
2. Gauntlet's verdict (screen-side) and the external verifier (log-side) **disagreeing is informative**: an "agent bluffed convincingly on screen but didn't actually invoke the skill" finding is exactly the signal a compliance benchmark wants. Drill currently masks this by giving its single verifier both views.
3. Most scenarios will pass on `gauntlet AC ∧ assertions` alone — assertions cover the load-bearing claims. The external LLM verifier is opt-in per scenario (drop a `verifier.md` next to the card) for cases where semantic judgment over the tool log matters and assertions can't express it cleanly.
4. Preserves Drill's confirmation-bias discipline: the external verifier sees evidence (tool log, filesystem, screen) but not the AC prose or scenario narrative.

The combined verdict the harness reports is a tuple, not a flat pass/fail: `{gauntlet: pass|fail|investigate, assertions: pass|fail, verifier: pass|fail|n/a}`. The scenario declares the composition rule (default: all-must-pass; some scenarios may want "gauntlet=pass OR verifier=pass" for cases where the agent's screen-side narration is unreliable). This is a small extension, not a complication.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  superpowers-evals (the harness)                            │
│                                                             │
│  scenarios/<name>/                                          │
│    story.md           Gauntlet card (outcome + AC)          │
│    setup.sh           Pre-run workdir mutation              │
│    assertions/*.sh    Post-run deterministic checks         │
│    verifier.md        (optional) external LLM verifier      │
│    target.yaml        Which agent CLI + normalizer to use   │
│                                                             │
│  harness/  (Python)                                         │
│    runner.py          Orchestrate a single scenario run     │
│    normalizers/       One module per agent CLI              │
│    bin/               skill-called, tool-called, …          │
│    sweep.py           N × M orchestration (or shell wrap?)  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                           │
                           │ subprocess
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  gauntlet (unchanged)                                       │
│                                                             │
│    TUI adapter ─── tmux ─── agent CLI under test            │
│                              (Claude Code / Codex / Gemini) │
│                                                             │
│    Agent loop ── report_result ── result.json + evidence/   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Per-run flow

```
1. LOAD scenario manifest (story.md, setup.sh, assertions/, verifier.md?, target.yaml)
2. CREATE temp workdir
3. RUN setup.sh in workdir; abort on non-zero
4. SNAPSHOT agent-under-test session-log dir (target.yaml says where)
5. INVOKE gauntlet:
     gauntlet run scenarios/<name>/story.md \
       --adapter tui \
       --target "<command from target.yaml>" \
       --out <evidence-dir> \
       --max-time <from scenario or default> \
       --silent
6. NORMALIZE: diff session-log dir, write tool_calls.jsonl into <evidence-dir>
7. ASSERT: run assertions/*.sh from <evidence-dir>, $DRILL_WORKDIR=<workdir>
8. VERIFY (optional): if verifier.md present, run external LLM verifier with
     evidence as context, write verdict to <evidence-dir>/external-verdict.json
9. COMPOSE final verdict per scenario's composition rule
10. WRITE meta.json with everything; cleanup workdir (or keep on failure)
```

### Sweep

Multi-target × multi-trial via `superpowers-evals/harness sweep <scenario> --targets claude,codex --n 10` (or whatever the CLI shape ends up). Or — start with a one-line shell loop and add a real sweep CLI only if the loop gets ugly. (See Open Questions.)

## What stays in / out of Gauntlet

**In Gauntlet (no changes):** TUI adapter, agent loop, AC verdict, evidence pipeline, run-sets, batch mode, fanout, `--passes`.

**In the harness (new code in `superpowers-evals/`):** workdir setup, session-log capture, per-target normalizers, deterministic assertions, optional external LLM verifier, per-scenario target configuration, sweep orchestration, the `bin/` helpers (ported verbatim).

**Not built (yet):** cross-run-set comparison view (Drill's `compare` command). One-off scripts cover this for now; promote if friction warrants.

## Migration phases

### Phase 1 — Build the harness, no Gauntlet changes

Goal: prove end-to-end parity with Drill on one representative scenario.

1. Pick `triggering-writing-plans` (single turn, single assertion `skill-called superpowers:writing-plans`). It's the smallest possible parity test.
2. Build the per-run flow above as a Python CLI (`harness/runner.py`). Use Drill's `normalizer.py` near-verbatim for the Claude Code normalizer.
3. Port the `bin/` assertion helpers verbatim — they're already framework-agnostic.
4. Convert the scenario: `scenarios/triggering-writing-plans.yaml` → `scenarios/triggering-writing-plans/{story.md, setup.sh, assertions/skill-called.sh, target.yaml}`.
5. Run both the old Drill version and the new harness version against the same backend, compare verdicts and tool-call captures. Document any divergence.

### Phase 2 — Port scenarios incrementally

Order by leverage and risk:

1. `worktree-creation-from-main`, `worktree-already-inside`, `worktree-codex-app-detached-head` — Drill's original purpose, well-understood, exercise multi-helper setup.
2. The other `triggering-*` scenarios — exercise the assertion stack.
3. `code-review-catches-planted-bugs`, `spec-reviewer-catches-planted-flaws` — exercise the optional external verifier.
4. The `cost-*` scenarios — these may need external-verifier-only runs if cost can't be derived from tool calls.

Each port is mechanical-ish: scenario YAML body → `story.md` (rewritten per `writing-gauntlet-stories`), setup helper → `setup.sh`, verify section → `assertions/*.sh` and optionally `verifier.md`. Where the AC rewrite resists a clean translation, that's a signal the original criterion was testing implementation rather than outcome — flag those for redesign rather than forced translation.

### Phase 3 — Decommission

When all ported scenarios run green in the harness and CI confirms parity (or accepted divergence is documented), mark `drill/` and Drill's CLI deprecated in `superpowers-evals/README.md`, point at the harness, eventually delete. The repo keeps: scenario sources, normalizers, harness, `bin/`. The Python engine, actor, verifier, sweep, stats — gone.

## Non-goals

- **Gauntlet does not become an eval-specific tool.** The TUI adapter sees a subprocess; whether that subprocess happens to be Claude Code is not its concern.
- **No new Linear/Drill CI on public CI** — same trust boundary as today (live evals stay maintainer-local).
- **No cross-run-set comparison view in Phase 1.** Two `gauntlet run` invocations + a side-by-side script if needed.
- **No Docker isolation in Phase 1** — same as Drill's phase 1 scope decision; revisit later.
- **Not changing Gauntlet at all.** If a feature is genuinely missing (e.g., a way for the harness to pin a specific runId for log correlation), file separately.

## Risks and open questions

See `QUESTIONS.md` for items needing Matt's input. Risks tracked here:

- **Idle detection.** Drill has per-backend `idle.quiescence_seconds` and `ready_pattern`. Gauntlet's QA agent decides "is the target ready" by reading the screen — looser, model-dependent. Empirical risk: the QA agent may type while the target is still rendering, causing input loss. Mitigation: the QA agent's system prompt already instructs it to wait; if this proves flaky, add a per-scenario hint to the prompt (e.g., "the target is Claude Code; wait for the `❯` prompt before typing").
- **Cost control.** Each Gauntlet-driven run uses two LLMs in tandem (Gauntlet's QA agent + the agent under test). Drill is similar (actor + agent + verifier). Net change probably neutral; flag if it spikes.
- **Naive vs spec-aware as separate cards** vs same card with a posture flag: chosen separate cards (the wording difference *is* the test, want it author-controlled). Mild duplication is the cost.
- **Per-target normalizer drift.** When Claude Code or Codex changes its session-log format, normalizers break silently. Mitigation: schema test per normalizer that asserts the common-schema invariants on a recorded fixture log.
- **Evidence-dir layout coupling.** The harness writes `tool_calls.jsonl` into Gauntlet's evidence dir. If Gauntlet renames or relocates that dir, the harness breaks. Mitigation: harness reads the path from Gauntlet's `result.json` rather than computing it.

## Citation / prior art

Drill design: `docs/design.md` (Jesse, 2026-04-07).
Gauntlet docs: `gauntlet/README.md`, `gauntlet/docs/`.
Skill: `gauntlet/.claude/skills/writing-gauntlet-stories/SKILL.md` (calibration framing for AC).
