# Eval & Agent-Harness Portfolio Map

*The human "what is each thing, when do I use it, and how do they relate" companion to the auto-generated dependency graph. Written 2026-06-13. Scoped from superpowers-evals' vantage — covers this repo (quorum) and the siblings it touches.*

> **The canonical, machine-generated map** lives in the `scribble-wiki` repo at
> `knowledge/architecture/repo-map.md` and `knowledge/architecture/graphs/` (notably
> `graphs/eval-labs.md`). Those are **generated from each repo's `catalog-info.yaml`** —
> do not hand-edit them. This doc is the prose companion: purpose, when-to-use, and the
> isolation decision. When they disagree, the generated graph wins on *dependencies*; this
> doc owns *intent*.

## Orientation

The eval stack answers **two different questions**, and most confusion is from conflating them:

1. **"Does this *skill / workflow* shape real-agent behavior correctly?"** → **quorum** (this repo) — interactive, compliance-graded.
2. **"Given the same task, which *model* codes best?"** → **prudence** — one-shot, quality-leaderboard.

Everything else is shared plumbing (gauntlet, obol, stockyard) or the cheap-experiment layer that feeds the expensive runs (superpowers-autoresearch).

## Which tool when

| You want to… | Use | Why |
|---|---|---|
| Verify a skill auto-triggers / SDD dispatches subagents / a reviewer catches a planted defect | **quorum** (this repo) | Only harness with an interactive simulated human + deterministic workflow checks |
| Rank models head-to-head on real coding tasks | **prudence** | Blind-judge rubric scoring, disposable-sandbox isolation, built for a leaderboard |
| Answer a guidance/wording question cheaply before spending on full runs | **superpowers-autoresearch** (MICRO) | One API call per sample, ~$1–5, no agent CLI |
| Re-analyze runs you already have | **superpowers-autoresearch** (MINE) | Free; scripts in `mining/` |
| QA a web app / CLI / TUI from story cards (outside superpowers) | **gauntlet** directly | It's the general QA framework; quorum is one consumer |
| Run a benchmark on disposable cloud infra | **harbor-runner** | Ephemeral spot instances, agent-independent |
| Eval assistant security (prompt-injection / exfiltration) | **scenarios** | Model-agnostic declarative security suite |
| Price any run's token usage | **obol** | Shared cost tool both quorum and prudence call |

## Where superpowers-evals sits

- **superpowers-evals** (this repo) = the **quorum** harness/CLI. It's in the **superpowers** repo family and **depends on gauntlet** (eval-labs family).
- **"drill"** is the *predecessor* name — lifted into this repo (see `docs/plans/2026-05-06-lift-drill-into-evals.md`) and is now **quorum**. The name survives only in fixtures/identifiers (`drill@test.local` commit identity, `DRILL_CODEX_HOME`). Read "drill" in old notes as "quorum."

## Components

### quorum — skill/workflow compliance lab (this repo)
Python orchestration that shells out to the **gauntlet** bun binary. Drives **9 real coding-agent CLIs** (claude, claude-haiku, codex, gemini, kimi, opencode, pi, copilot, antigravity) through the Gauntlet QA agent in tmux, then grades against scenario **acceptance criteria** + deterministic `bin/` checks (`pre()`/`post()`) + an LLM judge. **Cost tier:** FULL (~$7–15/run), priced via obol (`quorum/obol_capture.py`). **Isolation:** bespoke per-agent env — leaky (see below); **not yet sandboxed.**

### gauntlet — the shared QA framework (eval-labs)
*"AI-powered QA testing framework that uses LLMs to test web apps, CLI tools, and TUI programs from markdown story cards, returning structured pass/fail verdicts with evidence."* It is **general**, not superpowers-specific: both **superpowers-evals** and **brainstorm-vrfy** depend on it. The interactive simulated-human driver **and** the LLM verifier both live inside the gauntlet binary; quorum reads its `result.json`.

### prudence — model-quality leaderboard (eval-labs)
TS/bun. Runs coding **models** through a harness (pi/claude/codex) **one-shot & headless** (`codex exec`, `claude -p`) in a **disposable sandbox**; scores with a panel of **model-blind** judges → leaderboard. **Already isolated:** fresh disposable sandbox per cell, sterile credential staging, claude `--bare`. Its `Sandbox` interface is backend-swappable: **Docker today, stockyard next.** Worth knowing for the isolation work below — it already solved the substrate.

### superpowers-autoresearch — the cheap-experiment layer (private)
Python micro-harnesses + markdown logs. The **MINE** (free, re-score existing artifacts) and **MICRO** (one API call per sample, ~$1–5) tiers. Pre-registers predictions, runs guidance-variant micros, escalates to **FULL** (quorum) only when cheaper tiers can't answer.

### Shared primitives
- **stockyard** (brooks family) — *"Coding-agent VM orchestrator: runs coding agents in isolated VMs — **Firecracker micro-VMs on Linux** (with ZFS audit-trail snapshots) and **Apple's `container` tool on macOS**."* This is the company's purpose-built coding-agent isolation primitive. It is **macOS-native** (so it sidesteps the Docker-on-Mac "slow Linux VM" tax), has audit snapshots, and is already wired into brooks/toil workflows. **This is the isolation primitive to adopt** — see below.
- **obol** (+ **obol-go**) — token-usage pricing. Called by **both** quorum and prudence. The one piece cleanly shared rather than duplicated.

### The wider eval-labs family (pointer)
Beyond gauntlet/prudence, the eval-labs family also holds **harbor-runner** (disposable AWS infra for harbor benchmark evals on ephemeral spot instances), **harbor-eval-analysis-dashboard** (dashboard for Harbor runs), **scenarios** (model-agnostic prompt-injection/exfiltration security suite), **small-model-evals** (spec-compliance review eval via Pi/OpenRouter), **terminal-bench-analysis** (Terminal Bench 2 leaderboard analysis), and **tommy-tester** (browser scenario testing via LangGraph + Playwright). See `scribble-wiki/knowledge/architecture/graphs/eval-labs.md` for the live dependency graph.

## Cost tiers (the spine connecting autoresearch ↔ quorum)

| Tier | Cost | What | Where |
|---|---|---|---|
| MINE | free | re-score existing run artifacts | autoresearch `mining/` |
| MICRO | ~$1–5 | one API call per sample, guidance variant | autoresearch `harnesses/` |
| FULL | ~$7–15/run | real agent run, full workflow | quorum (this repo) |

Answer at the cheapest tier that can. Manually inspect every automated score at every tier.

## Honest architecture notes

**The real duplication.** quorum (Python + bun gauntlet) and prudence (bun) both: run codex/claude in a sandbox, capture the transcript, normalize it, price via obol, and run an LLM judge. That bottom half is built **twice, in two languages**. The *difference* that justifies two tools is the top half — interactive compliance (quorum) vs one-shot quality leaderboard (prudence). Consolidate the substrate, not the harnesses.

**Convergence opportunity (not yet built).** prudence already owns the clean sandbox substrate; the simplifying move is to make it shared and run quorum's gauntlet on top as the interactive mode — one substrate, two grading modes — rather than building a third isolation scheme. The one genuinely new piece convergence needs: prudence's harness `run()` is one-shot; the gauntlet is interactive (tmux, multi-turn). Everything below that interaction layer is reusable.

## Isolation / sandbox decision (2026-06-13)

- **prudence:** isolated by design (disposable sandbox, sterile creds) — structurally clean.
- **quorum (this repo):** **not** isolated; bespoke per-agent env; **leaky**. Verified seam — codex re-clones the OpenAI plugin marketplace (`github.com/openai/plugins.git`, 173 plugins) into its per-run `CODEX_HOME/.tmp/plugins` at runtime; `CODEX_HOME` changes *where* it writes, not *whether* it fetches. (In the run checked, it did **not** reach the model's context, but it is host-shaped state per-env isolation can't close.) Separately verified: the host's private `~/.claude/CLAUDE.md` does **not** leak into the claude SUT — `CLAUDE_CONFIG_DIR` suppresses it.
- **quorum + codex — the severe seam (verified 2026-06-13):** codex reads behavior-shaping skills from the **host `~/.codex/superpowers` checkout**, not from the per-run `SUPERPOWERS_ROOT`. In two fractals runs, codex did 100+ `sed -n` reads of `~/.codex/superpowers/skills/*/SKILL.md` and **zero** from the isolated `cache/debug/superpowers/local`; a skill section that exists only in the tested branch never appeared. The SessionStart hook injects `using-superpowers` from the correct isolated plugin, but codex's native skill-loading resolves every *other* skill from host `~/.codex/superpowers`, which `CODEX_HOME` does not redirect. **This confounds any codex A/B that varies `SUPERPOWERS_ROOT`** — different roots all execute the same host skills — and means codex evals silently run against whatever happens to be checked out in `~/.codex/superpowers` (a likely "weird codex results" / cross-machine-divergence cause). Container isolation (no host `~/.codex` inside) fixes it by construction.
- **Decision:** move quorum runs into isolated sandboxes; both codex and claude show "weird" behavior worth removing the environment as a variable. **The primitive to adopt is `stockyard`, not hand-rolled Docker** — it's the company coding-agent VM isolation tool, macOS-native, with audit snapshots, and prudence's `Sandbox` interface already targets it. Cleanest path: run quorum's SUT on stockyard, ideally via prudence's `Sandbox` abstraction (gauntlet on top as the interactive mode), rather than bolting Docker into quorum's Python or inventing a third scheme.
- **Load-bearing constraint for ANY out-of-process isolation (VM or container).** Capture reads `coding-agent-config/.../sessions` **host-side after the SUT exits**, and the cwd-filters use realpath equality (plus claude's derived-path rule). The workdir, the config dir, and — for claude/pi only — `SUPERPOWERS_ROOT` must be present at **byte-identical absolute paths**, and the session logs must sync back to a host path capture reads, or every strict-capture agent silently goes `indeterminate`. stockyard's workspace/state sync (and prudence's `syncIn`/`copyOut`) is where this maps — get it right first.

## Confidence

- Component descriptions are pulled from each repo's `catalog-info.yaml` (the same source the scribble-wiki graphs are generated from), as of 2026-06-13.
- "harbor" benchmark internals not read — one-liners only.
- A concrete **codex** contributor to the "weirdness" is now isolated: codex reads skills from the host `~/.codex/superpowers` (above), and its cost is shell-dominated (~700 Bash calls/run — ~53% git introspection, ~24% `sed` file-paging — vs ~18% actual build/test), running ~3–4× Claude's cost on the same task. The **claude**-side "weirdness" is still open. Sandboxing is being adopted both to fix the host-skill-source bug and to remove the environment as a variable.
