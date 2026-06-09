# Superpowers Evals

Behavioral eval lab for superpowers. Python 3.11+, managed with uv.

The active runner is the Gauntlet-backed **Quorum**. Code, CLI, paths, and
inline prose all use lowercase `quorum`; the capitalized form `Quorum` appears
in headings and the actor table.

## Canonical Actors

Keep the actors straight; confusing them is the most common triage error.
These names are used everywhere: docs, CLI output, code, filenames, and commit
messages.

| Actor | What it is | Where it lives / its files |
|---|---|---|
| **Gauntlet** | General-purpose QA framework; the `gauntlet` CLI. A black-box tester. | repo `~/Code/prime/gauntlet`; on `PATH` as `gauntlet` |
| **Gauntlet-Agent** | The LLM inside Gauntlet that drives the Coding-Agent and self-grades against the story's ACs. | model e.g. `claude-sonnet-4-6`; event stream -> `<run>/gauntlet-agent/results/<runId>/run.jsonl`; verdict -> `result.{json,md}` |
| **Coding-Agent** | The agent under test. Instances: **Claude**, **Codex**; future **Gemini**, **Pi**. | session log -> `<run>/coding-agent-config/...`; files it writes -> `<run>/coding-agent-workdir/` |
| **Quorum** | The Python wrapper. Owns setup, Coding-Agent adaptation, deterministic checks, and final verdict composition. | repo `superpowers-evals/quorum/`; `<run>/verdict.json` |

A run involves two LLMs: the **Gauntlet-Agent** (QA tester) and the
**Coding-Agent** (subject). Separate models, logs, and token costs.

## Commands

- **install**: `uv sync --extra dev`
- **test**: `uv run pytest`
- **test single**: `uv run pytest tests/quorum/test_runner.py -x -q`
- **lint**: `uv run ruff check`
- **format**: `uv run ruff format`
- **typecheck**: `uv run ty check`
- **validate scenarios**: `uv run quorum check`
- **run scenario**: `uv run quorum run scenarios/<name> --coding-agent <claude|codex>`
- **list scenarios**: `uv run quorum list`
- **scaffold scenario**: `uv run quorum new <name>`
- **show verdict**: `uv run quorum show [<target>]`
- **run all**: `uv run quorum run-all [--coding-agents X,Y] [--jobs N]`
- **show batch**: `uv run quorum show <batch-id>` (matrix view)

Per-coding-agent config: `coding-agents/<name>.yaml`. Per-coding-agent HOWTO:
`coding-agents/<name>-context/HOWTO.md`. Per-coding-agent home skeleton (seeded
into the per-run `CLAUDE_CONFIG_DIR` / `CODEX_HOME`):
`coding-agents/<name>-home-skeleton/`. Spec:
`docs/superpowers/specs/2026-05-22-harness-model-design.md`.

## Architecture

- `quorum/runner.py` — per-run orchestration: setup, pre-checks, Gauntlet drive, capture, post-checks, verdict.
- `quorum/checks.py` — sources `checks.sh`, runs `pre()`/`post()`, collects structured check records.
- `quorum/composer.py` — composes Gauntlet-Agent verdict + deterministic checks into `pass | fail | indeterminate`.
- `quorum/coding_agent_config.py` — per-Coding-Agent YAML loader and session-log config.
- `quorum/capture.py` — session-log snapshot/diff, normalized tool-call capture, obol-priced token capture.
- `quorum/obol_capture.py` — all obol calls: session-log + gauntlet-sidecar cost estimation, per-file merge.
- `quorum/timing.py` — session-log wall-clock span (`duration_ms`).
- `quorum/normalizers.py` — Coding-Agent session-log normalizers.
- `quorum/scaffold.py` — `quorum new` / `quorum check` implementation.
- `quorum/show.py` — verdict renderer for triage.
- `bin/` — check-tool vocabulary; tools emit one JSON record each.
- `scenarios/` — active scenarios, one directory each.
- `coding-agents/` — per-agent YAML, context HOWTOs, and home skeletons (see "Per-coding-agent" above).
- `setup_helpers/*.py` — fixture creators (shared CLI: `uv run setup-helpers run <helper>`).

## Scenario Conventions

- A quorum scenario is `scenarios/<name>/{story.md,setup.sh,checks.sh}`.
- `story.md` briefs the Gauntlet-Agent and includes evidence-demanding ACs.
- `setup.sh` builds the fixture using `$QUORUM_WORKDIR`; prefer
  `uv run setup-helpers run <helper>`.
- `checks.sh` contains only `pre()` and `post()` function definitions.
- `checks.sh` should not have the executable bit set.
- Check tools run from the fixture workdir with `bin/` on `PATH`.
- Post-checks that need sibling run artifacts can use `$QUORUM_RUN_DIR`.
- Use `# coding-agents: <csv>` to restrict a scenario to specific agents.
- Use `requires-tool <name>` in `pre()` for local toolchain dependencies.

## Triage

Triaging a non-passing quorum run starts with:

```
uv run quorum show [<target>]
```

Then use `docs/superpowers/skills/triaging-a-failing-eval.md` for the
attribution atlas.

## Safe Checks

These are safe for CI and routine PRs:

```
uv run ruff check
uv run ty check
uv run quorum check
uv run pytest
```

Live `quorum run ...` evals are trusted-maintainer operations only. They
launch agent CLIs in permissive modes and can capture sensitive transcripts,
tool calls, filesystem state, and token data. Do not add live evals, API keys,
or dangerous-mode launches to public CI.

## Required Env For Live Evals

```
ANTHROPIC_API_KEY=sk-...
OPENAI_API_KEY=sk-...
```

When this repo is checked out as `superpowers/evals`, quorum defaults
`SUPERPOWERS_ROOT` to the parent `superpowers` checkout. In a standalone
`superpowers-evals` clone, export it explicitly:

```
export SUPERPOWERS_ROOT=/path/to/superpowers
```

## Parent Superpowers Submodule

`superpowers-evals` is consumed by `superpowers` as the `evals` submodule.
After any PR merges to `main` here, open a follow-up PR against the parent
`superpowers` repo targeting `dev` that bumps the `evals` submodule pointer to
the merged `superpowers-evals` commit.

Do not treat a `superpowers-evals` merge as fully propagated until that parent
submodule bump PR exists.
