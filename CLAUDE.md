# Drill

Superpowers skill compliance benchmark. Python 3.11+, managed with uv.

## Canonical Actors

Keep the actors straight; confusing them is the most common triage error.
These names are used everywhere — docs, CLI output, code, filenames, commit
messages.

| Actor | What it is | Where it lives / its files |
|---|---|---|
| **Gauntlet** | General-purpose QA framework; the `gauntlet` CLI. A black-box tester. | repo `~/Code/prime/gauntlet`; on `PATH` as `gauntlet` |
| **Gauntlet-Agent** | The LLM *inside* Gauntlet that drives the system-under-test and self-grades against the story's ACs. | model e.g. `claude-sonnet-4-6`; event stream → `<run>/gauntlet-agent/results/<runId>/run.jsonl`; verdict → `result.{json,md}` |
| **Coding-Agent** | The agent under test — the SUT. Instances: **Claude**, **Codex**; future **Gemini**, **Pi**. | session log → `<run>/coding-agent-config/…`; the files it writes → `<run>/coding-agent-workdir/` |
| **Harness** | The Python wrapper. Owns setup, Coding-Agent adaptation, the deterministic checks, and the final verdict. | repo `superpowers-evals/harness/`; `<run>/verdict.json` |

A run involves **two** LLMs — the **Gauntlet-Agent** (QA tester) and the
**Coding-Agent** (subject). Separate models, separate logs, separate token costs.
Confusing them is the most common triage error.

## Commands

- **install**: `uv sync --extra dev`
- **test**: `uv run pytest`
- **test single**: `uv run pytest tests/test_engine.py -x -q`
- **lint**: `uv run ruff check`
- **format**: `uv run ruff format`
- **typecheck**: `uv run ty check`
- **run scenario**: `uv run drill run <scenario> -b <backend>`
- **sweep**: `uv run drill run <scenario> --models claude-opus-4-6,claude-opus-4-7 --n 10`
- **compare**: `uv run drill compare <scenario>`
- **list**: `uv run drill list`

## Harness commands

- **run scenario**: `uv run harness run harness/scenarios/<name> --coding-agent <claude|codex>`
- **list**: `uv run harness list`
- **scaffold**: `uv run harness new <name>`
- **validate**: `uv run harness check [<name>]`

Per-coding-agent config: `harness/coding-agents/<name>.yaml`. Per-coding-agent HOWTO:
`harness/coding-agent-contexts/<name>/`. Spec: `docs/superpowers/specs/2026-05-22-harness-model-design.md`.

## Architecture

**Harness (active):**
- `harness/runner.py` — per-run orchestration: setup, pre-checks, Gauntlet drive, capture, post-checks, verdict.
- `harness/checks.py` — sources `checks.sh`, calls `pre()`/`post()` with `HARNESS_RECORD_SINK` set, collects records.
- `harness/composer.py` — three-valued verdict (`pass | fail | indeterminate`) from Gauntlet-Agent layer + checks layer.
- `harness/coding_agent_config.py` — per-coding-agent YAML loader (`CodingAgentConfig`).
- `harness/bin/` — the check-tool vocabulary; `_record` is the shared helper sourced by every tool. Tools: artifact (`file-exists`, `file-contains`, `command-succeeds`), git (`git-repo`, `git-branch`, `git-clean`, `git-count`), trace (`tool-called`, `tool-count`, `tool-before`, `tool-arg-match`, `skill-called`, `skill-before-tool`, and variants), negation (`not`).
- `harness/scenarios/` — one directory per scenario (`story.md`, `setup.sh`, `checks.sh`).
- `setup_helpers/*.py` — Repo fixture creators shared by Drill and the Harness.

**Drill (legacy; unchanged):**
- `drill/engine.py` — Tmux session orchestration. Creates workdir, runs setup helpers, drives actor/agent turns, collects results.
- `drill/actor.py` — Sonnet 4.6 LLM simulating a user. Reads turn intents from scenario YAML and generates realistic prompts.
- `drill/verifier.py` — Sonnet 4.6 LLM evaluating session transcript + filesystem against semantic criteria.
- `drill/sweep.py` — Multi-backend, N-repetition orchestrator.
- `drill/compare.py` — Loads results, computes pass rates and Wilson CIs, formats comparison tables.
- `scenarios/*.yaml` — Drill scenario definitions (setup, turns, limits, verify).
- `backends/*.yaml` — Per-backend CLI config (args, env, idle patterns, shutdown commands).
- `bin/` — Drill assertion helper scripts (frozen; separate from `harness/bin/`).

## Conventions

- Setup helpers take `workdir: Path` and mutate the filesystem. Register in `setup_helpers/__init__.py`.
- Harness scenarios use `user_posture: naive` (no skill names) or `spec-aware` (can name skills) in the story.
- `checks.sh` must contain only `pre()` and `post()` function definitions — no top-level statements, no exec bit.
- Check tools emit one JSON record per invocation via `harness/bin/_record`; exit 0 = pass, non-zero = fail.
- The `# coding-agents: <csv>` magic comment at the top of `checks.sh` restricts which Coding-Agents the scenario runs against.
- `harness/bin/` is forked from the top-level `bin/` and is independent; `bin/` is frozen for Drill.
- Backend YAMLs are fully self-contained — no override/alias system (Drill only).

## Required env

```
ANTHROPIC_API_KEY=sk-...
```

`SUPERPOWERS_ROOT` defaults to the parent of `evals/` (the superpowers repo root). Override only if running drill against a different superpowers checkout.
